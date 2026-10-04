"""Playbook run methods on KnowledgeBank / AsyncKnowledgeBank (respx-mocked HTTP).

Pins the wire contract both clients emit (paths, bodies, query params) and the
typed PlaybookRunError raised on a 409 from advance.
"""
from __future__ import annotations

import json

import httpx
import pytest
import respx

from gurucloud_kb import AsyncGuruCloudClient, GuruCloudClient, NotFoundError, PlaybookRunError
from gurucloud_kb._playbooks import advance_run_body, run_list_params, start_run_body

BASE_URL = "https://test.gurucloudai.com"
API_PREFIX = f"{BASE_URL}/api/v1/kb"
API_KEY = "kb_test_key_abc123"
KB_INFO = {"kb_id": "kb-1", "name": "Test KB", "description": "d", "entry_count": 1, "total_queries": 0,
           "embedding_model": "text-embedding-3-small", "embedding_dimensions": 1536,
           "created_at": "2026-01-01T00:00:00", "last_accessed_at": None}
RUN = {
    "id": "run-1", "playbook_id": "pid", "slug": "gas", "version": 2, "subject": "well 7", "state": "running",
    "current_key": "GAS-002",
    "current_step": {"key": "GAS-002", "position": 2, "kind": "decision", "title": "WT or meter?", "body": "b",
                     "transitions": [{"to": "GAS-WT", "when": "well test"}, {"to": "GAS-MTR", "when": "metered"}]},
    "trail": [{"seq": 1, "step_key": "GAS-001", "observation": "flagged", "chosen_next": "GAS-002", "outcome": "advanced"}],
}
CONFLICT = {
    "error": {
        "code": "illegal_transition",
        "message": "'GAS-END' is not a transition of GAS-002",
        "details": {"error": "illegal_transition", "run_id": "run-1", "current_key": "GAS-002", "state": "running",
                    "message": "'GAS-END' is not a transition of GAS-002",
                    "legal": [{"to": "GAS-WT", "when": "well test", "limit": None}]},
    }
}


def _kb_route():
    respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))


@pytest.fixture
def kb():
    with respx.mock:
        _kb_route()
        yield GuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("kb-1")


class TestWireHelpers:
    def test_start_body_only_carries_what_was_given(self) -> None:
        assert start_run_body(None, None, None) == {}
        assert start_run_body("well 7", "analyst", {"desk": "tx"}) == {"subject": "well 7", "started_by": "analyst", "metadata": {"desk": "tx"}}

    def test_advance_body_shapes(self) -> None:
        assert advance_run_body("seen", None, None, False, "ignored", None) == {"observation": "seen"}
        assert advance_run_body("seen", "GAS-MTR", "metered", False, None, "u") == {
            "observation": "seen", "next_key": "GAS-MTR", "reason": "metered", "changed_by": "u"}
        assert advance_run_body("sold", None, None, True, "well sold", None) == {
            "observation": "sold", "abandon": True, "abandon_reason": "well sold"}

    def test_list_params(self) -> None:
        assert run_list_params(None, None, 25) == {"limit": 25}
        assert run_list_params("running", "well 7", 5) == {"limit": 5, "state": "running", "subject": "well 7"}


class TestSyncRuns:
    def test_start_posts_body(self, kb) -> None:
        route = respx.post(f"{API_PREFIX}/banks/kb-1/playbooks/gas/runs").mock(return_value=httpx.Response(201, json={"data": RUN}))
        run = kb.start_playbook_run("gas", subject="well 7", metadata={"desk": "tx"})
        assert run["id"] == "run-1" and run["current_step"]["transitions"][0]["to"] == "GAS-WT"
        assert json.loads(route.calls.last.request.content) == {"subject": "well 7", "metadata": {"desk": "tx"}}

    def test_advance_posts_choice(self, kb) -> None:
        route = respx.post(f"{API_PREFIX}/banks/kb-1/playbook-runs/run-1/advance").mock(
            return_value=httpx.Response(200, json={"data": {**RUN, "current_key": "GAS-MTR"}}))
        run = kb.advance_playbook_run("run-1", "it is metered", next_key="GAS-MTR", reason="meter on site")
        assert run["current_key"] == "GAS-MTR"
        assert json.loads(route.calls.last.request.content) == {"observation": "it is metered", "next_key": "GAS-MTR", "reason": "meter on site"}

    def test_advance_409_raises_typed_error_with_legal_transitions(self, kb) -> None:
        respx.post(f"{API_PREFIX}/banks/kb-1/playbook-runs/run-1/advance").mock(return_value=httpx.Response(409, json=CONFLICT))
        with pytest.raises(PlaybookRunError) as exc:
            kb.advance_playbook_run("run-1", "x", next_key="GAS-END")
        err = exc.value
        assert err.code == "illegal_transition" and err.status_code == 409
        assert err.run_id == "run-1" and err.current_key == "GAS-002" and err.state == "running"
        assert [t["to"] for t in err.legal] == ["GAS-WT"]

    def test_get_and_list(self, kb) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1/playbook-runs/run-1").mock(return_value=httpx.Response(200, json={"data": RUN}))
        assert kb.get_playbook_run("run-1")["trail"][0]["step_key"] == "GAS-001"
        route = respx.get(f"{API_PREFIX}/banks/kb-1/playbooks/gas/runs").mock(
            return_value=httpx.Response(200, json={"data": {"runs": [{"id": "run-1", "state": "running"}], "total": 1}}))
        out = kb.list_playbook_runs("gas", state="running", subject="well 7", limit=5)
        assert out["total"] == 1
        assert dict(route.calls.last.request.url.params) == {"limit": "5", "state": "running", "subject": "well 7"}

    def test_get_not_found(self, kb) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1/playbook-runs/nope").mock(
            return_value=httpx.Response(404, json={"error": {"code": "playbook_run_error", "message": "No run"}}))
        with pytest.raises(NotFoundError):
            kb.get_playbook_run("nope")


class TestAsyncRuns:
    @pytest.mark.asyncio
    async def test_async_start_advance_and_409(self) -> None:
        async with respx.mock:
            _kb_route()
            kb = await AsyncGuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("kb-1")
            start = respx.post(f"{API_PREFIX}/banks/kb-1/playbooks/gas/runs").mock(return_value=httpx.Response(201, json={"data": RUN}))
            run = await kb.start_playbook_run("gas", subject="well 7")
            assert run.get("id") == "run-1" and json.loads(start.calls.last.request.content) == {"subject": "well 7"}
            adv = respx.post(f"{API_PREFIX}/banks/kb-1/playbook-runs/run-1/advance")
            adv.mock(return_value=httpx.Response(200, json={"data": {**RUN, "state": "abandoned"}}))
            run = await kb.advance_playbook_run("run-1", "sold", abandon=True, abandon_reason="well sold")
            assert run.get("state") == "abandoned"
            assert json.loads(adv.calls.last.request.content) == {"observation": "sold", "abandon": True, "abandon_reason": "well sold"}
            adv.mock(return_value=httpx.Response(409, json=CONFLICT))
            with pytest.raises(PlaybookRunError) as exc:
                await kb.advance_playbook_run("run-1", "x", next_key="GAS-END")
            assert exc.value.legal[0]["to"] == "GAS-WT"
            lst = respx.get(f"{API_PREFIX}/banks/kb-1/playbooks/gas/runs").mock(
                return_value=httpx.Response(200, json={"data": {"runs": [], "total": 0}}))
            assert (await kb.list_playbook_runs("gas")).get("total") == 0
            assert dict(lst.calls.last.request.url.params) == {"limit": "25"}
