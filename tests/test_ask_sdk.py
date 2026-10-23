"""kb.ask / ask_step / ask_config / list_ask_runs / get_ask_run / abandon_ask_run
(sync + async) over the SDK contract, and the pure shapers in gurucloud_kb._ask
(gurucloud-kb 0.13.0, kanban b3cb2a1b)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
import respx

from gurucloud_kb import AsyncGuruCloudClient, GuruCloudClient
from gurucloud_kb import _ask

BASE_URL = "https://test.gurucloudai.com"
API_PREFIX = f"{BASE_URL}/api/v1/kb"
API_KEY = "kb_test_key_abc123"
KB_INFO = {"kb_id": "kb-1", "name": "ChemMasters", "description": "", "entry_count": 3, "total_queries": 0}
A = "aaaaaaaa-0000-4000-8000-000000000001"
B = "bbbbbbbb-0000-4000-8000-000000000002"
C = "cccccccc-0000-4000-8000-000000000003"

SEARCH_RESP = {"results": [
    {"id": A, "combined_score": 0.91234, "useful_for": "rush quoting", "content": "Rush orders add 20%.", "metadata": {"summary": "Rush adds 20%"},
     "related": [{"id": B, "relation": "requires", "direction": "outgoing", "text": "approval rule", "note": "needs sign-off", "kind": "neighbor", "score": 0},
                 {"id": C, "relation": "see_also", "direction": "incoming", "kind": "folded"}]},
    {"id": "dddddddd-0000-4000-8000-000000000004", "combined_score": 0.5, "content": "x" * 7000},
]}
ENTRY = {"id": B, "content": "Approvals before rush.", "useful_for": "approval rule", "metadata": {"summary": "Approve first", "embedding": [0.1] * 25, "tags": ["ops"], "nested": {"x": 1}},
         "relevant_systems": ["quotes"], "created_at": "2026-10-01T00:00:00"}
CONNS = {"entry_id": B, "outgoing": [{"id": "e1", "edge_type": "precedes", "note": "then invoice", "to_entry_id": C, "other": {"id": C, "useful_for": "invoicing"}}],
         "incoming": [{"id": "e2", "edge_type": "cites", "from_entry_id": A, "other": {"id": A, "summary": "Rush adds 20%"}},
                      {"id": "e3", "edge_type": "cites", "other": {"id": "s1", "kind": "playbook_step", "playbook_slug": "quote", "step_key": "Q-2"}}]}
GRAPH = {"root": C, "depth": 1, "truncated": True, "nodes": [{"id": C, "depth": 0, "useful_for": "invoicing"}, {"id": B, "depth": 1, "snippet": "b"}, {"id": "s1", "depth": 1, "kind": "playbook_step", "playbook_slug": "quote", "step_key": "Q-2"}],
         "edges": [{"from_entry_id": B, "to_entry_id": C, "edge_type": "precedes", "note": "n"}, {"from_entry_id": C, "to_entry_id": None, "to_step_key": "Q-2", "edge_type": "cites"}]}


def _kb():
    respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
    return GuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("kb-1")


def _step(step: int, status: str, **extra: Any) -> dict[str, Any]:
    body = {"run_id": "run-1", "step": step, "max_steps": 8, "status": status, "run_status": "running" if status == "tool_calls" else status,
            "response_id": f"resp_{step}", "model": "gpt-6-luna", "thinking": [], "tool_calls": [], "citations": [], "usage": {}, "run_usage": {}, "duration_ms": 10.0}
    body.update(extra)
    return body


class TestShapers:
    def test_start_and_continue_bodies(self) -> None:
        assert _ask.start_body("  rush? ", model="gpt-6-luna", reasoning_effort="low", max_steps=4) == {"question": "rush?", "model": "gpt-6-luna", "reasoning_effort": "low", "max_steps": 4}
        assert _ask.start_body("q") == {"question": "q"}
        with pytest.raises(ValueError, match="empty"):
            _ask.start_body("   ")
        assert _ask.continue_body("r", "resp", [{"call_id": "c"}]) == {"run_id": "r", "previous_response_id": "resp", "tool_outputs": [{"call_id": "c"}]}
        with pytest.raises(ValueError):
            _ask.continue_body("r", "", [])

    def test_argument_helpers(self) -> None:
        assert _ask.search_k({}) == 8 and _ask.search_k({"k": 50}) == 20 and _ask.search_k({"k": "x"}) == 8
        assert _ask.walk_params({"root": A, "depth": 9}) == {"root": A, "depth": 3, "limit": 80} and _ask.walk_params({"root": A})["depth"] == 1
        with pytest.raises(ValueError):
            _ask.walk_params({"root": "ab"})
        assert _ask.entry_id_of({"entry_id": " aaaaaaaa "}) == "aaaaaaaa" and _ask.entry_id_of({"id": A}) == A
        with pytest.raises(ValueError):
            _ask.entry_id_of({})

    def test_search_output_matches_the_explorer_shape(self) -> None:
        out = _ask.search_output(SEARCH_RESP)
        row = out["results"][0]
        assert row["rank"] == 1 and row["score"] == 0.9123 and row["summary"] == "Rush adds 20%" and row["useful_for"] == "rush quoting"
        assert row["related"][0] == {"id": B, "relation": "requires", "direction": "outgoing", "text": "approval rule", "note": "needs sign-off", "kind": "neighbor"}
        assert row["related"][1] == {"id": C, "relation": "see_also", "direction": "incoming"}
        assert len(out["results"][1]["content"]) <= _ask.SEARCH_CONTENT_MAX_CHARS and out["collapse"] == {"groups": 1, "folded": 1, "neighbors": 1}
        assert _ask.search_output([{"id": A, "content": "c"}])["results"][0]["id"] == A and _ask.search_output(None)["results"] == []

    def test_a_ten_row_search_of_long_entries_fits_the_service_search_cap(self) -> None:
        # 24000 = kb_service.ask_agent.SEARCH_OUTPUT_MAX_CHARS: past it the model sees only the first rows.
        rows = [{"id": f"{i:08x}-0000-4000-8000-000000000000", "combined_score": 0.5, "useful_for": "u" * 200, "content": "x" * 6000,
                 "metadata": {"summary": "s" * 200},
                 "related": [{"id": f"{i:08x}-1111-4000-8000-00000000000{j}", "relation": "see_also", "direction": "outgoing", "text": "t" * 200,
                              "kind": "neighbor"} for j in range(3)]} for i in range(10)]
        out = _ask.search_output(rows)
        assert len(out["results"]) == 10 and len(json.dumps(out)) < 24000

    def test_entry_and_walk_outputs(self) -> None:
        out = _ask.entry_output(ENTRY, CONNS)
        assert out["id"] == B and out["summary"] == "Approve first" and out["metadata"] == {"summary": "Approve first", "tags": ["ops"]} and out["relevant_systems"] == ["quotes"]
        assert out["connections"][0] == {"id": C, "relation": "precedes", "direction": "outgoing", "text": "invoicing", "note": "then invoice"}
        assert out["connections"][1] == {"id": A, "relation": "cites", "direction": "incoming", "text": "Rush adds 20%"}
        assert out["connections"][2]["kind"] == "playbook_step" and out["connections"][2]["playbook"] == "quote" and out["connections"][2]["step"] == "Q-2"
        assert _ask.entry_output({"id": A, "content": "c"}, None)["connections"] == []
        walk = _ask.walk_output(GRAPH)
        assert walk["root"] == C and walk["truncated"] is True and walk["nodes"][1] == {"id": B, "depth": 1, "text": "b"} and walk["nodes"][2]["text"] == "step quote/Q-2"
        assert walk["edges"] == [{"from": B, "to": C, "relation": "precedes", "note": "n"}, {"from": C, "to": "Q-2", "relation": "cites"}]

    def test_execute_tool_routes_to_the_right_reader(self) -> None:
        calls: list[Any] = []
        out = _ask.execute_tool(_ask.TOOL_SEARCH, {"query": "rush", "k": 3}, search=lambda q, **kw: calls.append(("search", q, kw)) or SEARCH_RESP,
                                get_entry=lambda i: ENTRY, connections=lambda i: CONNS, graph=lambda r, **kw: GRAPH)
        assert out["results"][0]["id"] == A and calls == [("search", "rush", {"k": 3, "threshold": 0.0, "collapse": True})]
        out = _ask.execute_tool(_ask.TOOL_READ, {"entry_id": "bbbbbbbb"}, search=lambda q, **kw: None, get_entry=lambda i: ENTRY,
                                connections=lambda i: (_ for _ in ()).throw(RuntimeError("down")), graph=lambda r, **kw: GRAPH)
        assert out["id"] == B and out["connections"] == [], "a failing connections read still returns the entry"
        out = _ask.execute_tool(_ask.TOOL_WALK, {"root": C, "depth": 2}, search=lambda q, **kw: None, get_entry=lambda i: ENTRY, connections=lambda i: CONNS,
                                graph=lambda r, **kw: calls.append(("graph", r, kw)) or GRAPH)
        assert out["root"] == C and calls[-1] == ("graph", C, {"depth": 2, "limit": 80})
        with pytest.raises(ValueError, match="unknown tool"):
            _ask.execute_tool("delete_everything", {}, search=lambda q, **kw: None, get_entry=lambda i: ENTRY, connections=lambda i: CONNS, graph=lambda r, **kw: GRAPH)
        with pytest.raises(ValueError, match="needs a query"):
            _ask.execute_tool(_ask.TOOL_SEARCH, {}, search=lambda q, **kw: None, get_entry=lambda i: ENTRY, connections=lambda i: CONNS, graph=lambda r, **kw: GRAPH)
        item = _ask.tool_output_item({"call_id": "c1", "name": _ask.TOOL_READ}, {"id": A}, duration_ms=12.5)
        assert item == {"call_id": "c1", "name": _ask.TOOL_READ, "output": {"id": A}, "duration_ms": 12.5}
        assert _ask.tool_output_item({"call_id": "c1", "name": "x"}, error="boom")["output"] is None


class TestSync:
    @respx.mock
    def test_ask_runs_the_loop_and_posts_tool_outputs(self) -> None:
        steps = iter([
            _step(1, "tool_calls", thinking=["Looking for the rush rule."], tool_calls=[
                {"call_id": "c1", "name": _ask.TOOL_SEARCH, "arguments": {"query": "rush order", "k": 3}},
                {"call_id": "c2", "name": _ask.TOOL_READ, "arguments": {"entry_id": "bbbbbbbb"}},
                {"call_id": "c3", "name": _ask.TOOL_WALK, "arguments": {"root": C}},
                {"call_id": "c4", "name": "zap", "arguments": {}, "known": False},
            ]),
            _step(2, "answered", answer=f"Add 20% [{A[:8]}] after approval [{B[:8]}].", citations=[A, B], run_usage={"input_tokens": 300, "output_tokens": 80}),
        ])
        step_route = respx.post(f"{API_PREFIX}/banks/kb-1/ask/step").mock(side_effect=lambda req: httpx.Response(200, json={"data": next(steps)}))
        search_route = respx.post(f"{API_PREFIX}/banks/kb-1/search").mock(return_value=httpx.Response(200, json={"data": SEARCH_RESP}))
        respx.get(f"{API_PREFIX}/banks/kb-1/entries/bbbbbbbb").mock(return_value=httpx.Response(200, json={"data": ENTRY}))
        respx.get(f"{API_PREFIX}/banks/kb-1/entries/{B}/edges").mock(return_value=httpx.Response(200, json={"data": CONNS}))
        graph_route = respx.get(f"{API_PREFIX}/banks/kb-1/graph").mock(return_value=httpx.Response(200, json={"data": GRAPH}))
        seen: list[Any] = []
        final: Any = _kb().ask("How are rush orders quoted?", model="gpt-6-luna", reasoning_effort="low", max_steps=6, on_step=seen.append)
        assert final["status"] == "answered" and final["citations"] == [A, B] and [s["step"] for s in seen] == [1, 2]
        first = json.loads(step_route.calls[0].request.content)
        assert first == {"question": "How are rush orders quoted?", "model": "gpt-6-luna", "reasoning_effort": "low", "max_steps": 6}
        second = json.loads(step_route.calls[1].request.content)
        assert second["run_id"] == "run-1" and second["previous_response_id"] == "resp_1"
        outputs = second["tool_outputs"]
        assert [o["call_id"] for o in outputs] == ["c1", "c2", "c3", "c4"]
        assert outputs[0]["output"]["results"][0]["id"] == A and outputs[0]["output"]["collapse"]["neighbors"] == 1 and outputs[0]["duration_ms"] >= 0
        assert outputs[1]["output"]["id"] == B and outputs[1]["output"]["connections"][0]["relation"] == "precedes"
        assert outputs[2]["output"]["root"] == C and outputs[2]["output"]["edges"][0]["relation"] == "precedes"
        assert outputs[3]["output"] is None and "unknown tool" in outputs[3]["error"]
        search_body = json.loads(search_route.calls[0].request.content)
        assert search_body["k"] == 3 and "collapse" in search_body
        assert graph_route.calls[0].request.url.params["depth"] == "1" and graph_route.calls[0].request.url.params["limit"] == "80"

    @respx.mock
    def test_ask_stops_on_failed_and_step_limit(self) -> None:
        respx.post(f"{API_PREFIX}/banks/kb-1/ask/step").mock(return_value=httpx.Response(200, json={"data": _step(1, "failed", error="RuntimeError: upstream")}))
        final: Any = _kb().ask("q")
        assert final["status"] == "failed" and "upstream" in final["error"]

    @respx.mock
    def test_ask_step_bodies_and_the_audit_reads(self) -> None:
        route = respx.post(f"{API_PREFIX}/banks/kb-1/ask/step").mock(return_value=httpx.Response(200, json={"data": _step(2, "answered", answer="done")}))
        kb = _kb()
        out: Any = kb.ask_step(run_id="run-1", previous_response_id="resp_1", tool_outputs=[{"call_id": "c1", "name": _ask.TOOL_SEARCH, "output": {"results": []}}])
        assert out["answer"] == "done"
        assert json.loads(route.calls[0].request.content) == {"run_id": "run-1", "previous_response_id": "resp_1", "tool_outputs": [{"call_id": "c1", "name": _ask.TOOL_SEARCH, "output": {"results": []}}]}
        with pytest.raises(ValueError):
            kb.ask_step(run_id="run-1", tool_outputs=[])
        cfg_route = respx.get(f"{API_PREFIX}/banks/kb-1/ask/config").mock(return_value=httpx.Response(200, json={"data": {"available": True, "models": ["gpt-6-luna"], "default_model": "gpt-6-luna"}}))
        assert kb.ask_config()["models"] == ["gpt-6-luna"] and cfg_route.called  # type: ignore[index]
        runs_route = respx.get(f"{API_PREFIX}/banks/kb-1/ask/runs").mock(return_value=httpx.Response(200, json={"data": {"runs": [{"id": "run-1", "status": "answered"}], "limit": 5, "offset": 10}}))
        page: Any = kb.list_ask_runs(limit=5, offset=10)
        assert page["runs"][0]["id"] == "run-1" and runs_route.calls[0].request.url.params["limit"] == "5" and runs_route.calls[0].request.url.params["offset"] == "10"
        respx.get(f"{API_PREFIX}/banks/kb-1/ask/runs/run-1").mock(return_value=httpx.Response(200, json={"data": {"run": {"id": "run-1"}, "steps": [{"step_no": 1}]}}))
        detail: Any = kb.get_ask_run("run-1")
        assert detail["steps"][0]["step_no"] == 1
        respx.post(f"{API_PREFIX}/banks/kb-1/ask/runs/run-1/abandon").mock(return_value=httpx.Response(200, json={"data": {"id": "run-1", "status": "abandoned"}}))
        assert kb.abandon_ask_run("run-1")["status"] == "abandoned"  # type: ignore[index]


class TestAsync:
    @respx.mock
    def test_async_ask_runs_the_loop(self) -> None:
        steps = iter([
            _step(1, "tool_calls", tool_calls=[{"call_id": "c1", "name": _ask.TOOL_SEARCH, "arguments": {"query": "rush"}}, {"call_id": "c2", "name": _ask.TOOL_READ, "arguments": {"entry_id": B}}]),
            _step(2, "answered", answer="ok", citations=[A]),
        ])
        step_route = respx.post(f"{API_PREFIX}/banks/kb-1/ask/step").mock(side_effect=lambda req: httpx.Response(200, json={"data": next(steps)}))
        respx.post(f"{API_PREFIX}/banks/kb-1/search").mock(return_value=httpx.Response(200, json={"data": SEARCH_RESP}))
        respx.get(f"{API_PREFIX}/banks/kb-1/entries/{B}").mock(return_value=httpx.Response(200, json={"data": ENTRY}))
        respx.get(f"{API_PREFIX}/banks/kb-1/entries/{B}/edges").mock(return_value=httpx.Response(500, json={"error": {"code": "boom", "message": "down"}}))
        respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))

        async def go() -> Any:
            client = AsyncGuruCloudClient(api_key=API_KEY, base_url=BASE_URL)
            kb = await client.get_kb("kb-1")
            seen: list[Any] = []
            final = await kb.ask("rush?", on_step=seen.append)
            return final, seen

        final, seen = asyncio.run(go())
        assert final["status"] == "answered" and final["citations"] == [A] and len(seen) == 2
        outputs = json.loads(step_route.calls[1].request.content)["tool_outputs"]
        assert outputs[0]["output"]["results"][0]["id"] == A
        assert outputs[1]["output"]["id"] == B and outputs[1]["output"]["connections"] == [], "a failing edges read still returns the entry"
