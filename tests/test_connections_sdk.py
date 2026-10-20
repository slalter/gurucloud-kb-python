"""kb.connect / add_connections / connections / disconnect / list_connections /
connection_stats / graph / backfill_connections and search(collapse=...)
(sync + async), gurucloud-kb 0.8.0 (kanban c0cab0a7)."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
import respx

from gurucloud_kb import AsyncGuruCloudClient, GuruCloudClient
from gurucloud_kb._search import apply_collapse, build_string_search

BASE_URL = "https://test.gurucloudai.com"
API_PREFIX = f"{BASE_URL}/api/v1/kb"
API_KEY = "kb_test_key_abc123"
KB_INFO = {"kb_id": "kb-1", "name": "Games", "description": "", "entry_count": 1, "total_queries": 0}
A = "aaaaaaaa-0000-4000-8000-000000000001"
B = "bbbbbbbb-0000-4000-8000-000000000002"
EDGE = {"id": "e1", "from_entry_id": A, "to_entry_id": B, "edge_type": "part_of", "source": "author", "note": None, "evidence": {}}


def _kb():
    respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
    return GuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("kb-1")


class TestCollapseBuilders:
    def test_string_search_carries_collapse(self) -> None:
        assert "collapse" not in build_string_search("q", 5, 0.5)
        assert build_string_search("q", 5, 0.5, collapse=True)["collapse"] == {}
        assert build_string_search("q", 5, 0.5, collapse={"pool": 30})["collapse"] == {"pool": 30}

    def test_apply_collapse_on_a_dict_query(self) -> None:
        assert apply_collapse({"k": 3}, None) == {"k": 3}
        assert apply_collapse({"k": 3, "collapse": {}}, False) == {"k": 3}
        assert apply_collapse({"k": 3}, True) == {"k": 3, "collapse": {}}
        assert apply_collapse({"k": 3}, {"max_related": 2}) == {"k": 3, "collapse": {"max_related": 2}}


class TestSync:
    @respx.mock
    def test_connect_and_add_connections_body(self) -> None:
        route = respx.post(f"{API_PREFIX}/banks/kb-1/edges").mock(return_value=httpx.Response(201, json={"data": {"created": [EDGE], "existing": [], "errors": []}}))
        out: Any = _kb().connect(A, B, "part_of", note="detail of the hub", evidence={"why": "runbook"}, created_by="me")
        assert out["created"][0]["id"] == "e1"
        assert json.loads(route.calls[0].request.content) == {
            "edges": [{"from_entry_id": A, "to_entry_id": B, "edge_type": "part_of", "note": "detail of the hub", "evidence": {"why": "runbook"}}],
            "source": "author", "created_by": "me",
        }
        _kb().add_connections([{"from_entry_id": B, "to_entry_id": A, "edge_type": "see_also"}], source="import")
        assert json.loads(route.calls[1].request.content) == {"edges": [{"from_entry_id": B, "to_entry_id": A, "edge_type": "see_also"}], "source": "import"}
        with pytest.raises(ValueError, match="must not be empty"):
            _kb().add_connections([])

    @respx.mock
    def test_reads_and_delete(self) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1/entries/{A}/edges").mock(return_value=httpx.Response(200, json={"data": {"entry_id": A, "outgoing": [], "incoming": []}}))
        graph = respx.get(f"{API_PREFIX}/banks/kb-1/graph").mock(return_value=httpx.Response(200, json={"data": {"root": A, "depth": 2, "nodes": [], "edges": [], "truncated": False}}))
        listed = respx.get(f"{API_PREFIX}/banks/kb-1/edges").mock(return_value=httpx.Response(200, json={"data": {"edges": [EDGE], "limit": 5, "offset": 0}}))
        respx.get(f"{API_PREFIX}/banks/kb-1/edge-stats").mock(return_value=httpx.Response(200, json={"data": {"total": 1, "by_type": {"part_of": 1}, "by_source": {"author": 1}, "entries_with_edges": 2}}))
        deleted = respx.delete(f"{API_PREFIX}/banks/kb-1/edges/e1").mock(return_value=httpx.Response(200, json={"data": {"deleted": True, "edge": EDGE}}))
        kb = _kb()
        conns: Any = kb.connections(A)
        assert conns["entry_id"] == A
        g: Any = kb.graph(A, depth=2, limit=40)
        assert g["root"] == A and dict(graph.calls[0].request.url.params) == {"root": A, "depth": "2", "limit": "40"}
        lst: Any = kb.list_connections(edge_type="part_of", limit=5)
        assert lst["edges"][0]["id"] == "e1"
        assert dict(listed.calls[0].request.url.params) == {"limit": "5", "offset": "0", "edge_type": "part_of"}
        stats: Any = kb.connection_stats()
        assert stats["total"] == 1
        gone: Any = kb.disconnect("e1", reason="wrong")
        assert gone["deleted"] is True and dict(deleted.calls[0].request.url.params) == {"reason": "wrong"}

    @respx.mock
    def test_backfill_params(self) -> None:
        route = respx.post(f"{API_PREFIX}/banks/kb-1/edges/backfill").mock(return_value=httpx.Response(200, json={"data": {"dry_run": False, "created": 374}}))
        out: Any = _kb().backfill_connections(dry_run=False, actor="me")
        assert out["created"] == 374
        assert dict(route.calls[0].request.url.params) == {"dry_run": "false", "max_entries": "50000", "actor": "me"}
        _kb().backfill_connections()
        assert dict(route.calls[1].request.url.params) == {"dry_run": "true", "max_entries": "50000"}

    @respx.mock
    def test_search_collapse_for_string_and_dict_queries(self) -> None:
        route = respx.post(f"{API_PREFIX}/banks/kb-1/search").mock(return_value=httpx.Response(200, json={"data": [{"id": A, "content": "c", "related": [{"id": B, "relation": "part_of"}]}]}))
        out: Any = _kb().search("run locally", k=8, collapse=True)
        assert out[0]["related"][0]["id"] == B
        assert json.loads(route.calls[0].request.content)["collapse"] == {}
        _kb().search({"dimensions": {"content": {"query_text": "x"}}, "k": 3}, collapse={"pool": 30, "max_related": 2})
        assert json.loads(route.calls[1].request.content)["collapse"] == {"pool": 30, "max_related": 2}
        _kb().search("plain")
        assert "collapse" not in json.loads(route.calls[2].request.content)


class TestAsync:
    @pytest.mark.asyncio
    @respx.mock
    async def test_async_round_trip(self) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
        add = respx.post(f"{API_PREFIX}/banks/kb-1/edges").mock(return_value=httpx.Response(201, json={"data": {"created": [EDGE], "existing": [], "errors": []}}))
        respx.get(f"{API_PREFIX}/banks/kb-1/entries/{A}/edges").mock(return_value=httpx.Response(200, json={"data": {"entry_id": A, "outgoing": [EDGE], "incoming": []}}))
        respx.get(f"{API_PREFIX}/banks/kb-1/graph").mock(return_value=httpx.Response(200, json={"data": {"root": A, "nodes": [], "edges": []}}))
        respx.delete(f"{API_PREFIX}/banks/kb-1/edges/e1").mock(return_value=httpx.Response(200, json={"data": {"deleted": True}}))
        search = respx.post(f"{API_PREFIX}/banks/kb-1/search").mock(return_value=httpx.Response(200, json={"data": []}))
        backfill = respx.post(f"{API_PREFIX}/banks/kb-1/edges/backfill").mock(return_value=httpx.Response(200, json={"data": {"dry_run": True}}))
        kb = await AsyncGuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("kb-1")
        created: Any = await kb.connect(A, B, "part_of")
        assert created["created"][0]["id"] == "e1" and json.loads(add.calls[0].request.content)["source"] == "author"
        conns: Any = await kb.connections(A)
        assert conns["outgoing"][0]["id"] == "e1"
        g: Any = await kb.graph(A)
        assert g["root"] == A
        gone: Any = await kb.disconnect("e1")
        assert gone["deleted"] is True
        await kb.search("q", collapse=True)
        assert json.loads(search.calls[0].request.content)["collapse"] == {}
        report: Any = await kb.backfill_connections()
        assert report["dry_run"] is True and dict(backfill.calls[0].request.url.params)["dry_run"] == "true"
        respx.get(f"{API_PREFIX}/banks/kb-1/edge-stats").mock(return_value=httpx.Response(200, json={"data": {"total": 2}}))
        stats: Any = await kb.connection_stats()
        assert stats["total"] == 2


class TestEdgeRelations:
    """kb.edge_relations / set_edge_relations, gurucloud-kb 0.10.0 (kanban ce8de075)."""

    VOCAB = {"relations": [{"name": "cites", "origin": "builtin"}, {"name": "applies_at", "origin": "declared"}],
             "declared": [{"name": "applies_at"}], "replace_defaults": False, "system_relations": ["see_also", "cites"]}

    @respx.mock
    def test_get_and_set_sync(self) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1/edge-relations").mock(return_value=httpx.Response(200, json={"data": self.VOCAB}))
        put = respx.put(f"{API_PREFIX}/banks/kb-1/edge-relations").mock(return_value=httpx.Response(200, json={"data": self.VOCAB}))
        kb = _kb()
        vocab: Any = kb.edge_relations()
        assert [r["name"] for r in vocab["relations"]] == ["cites", "applies_at"]
        out: Any = kb.set_edge_relations([{"name": "applies_at", "description": "from applies at step to", "transitive": False}])
        assert out["declared"] == [{"name": "applies_at"}]
        assert json.loads(put.calls[0].request.content) == {
            "relations": [{"name": "applies_at", "description": "from applies at step to", "transitive": False}], "replace_defaults": False,
        }
        kb.set_edge_relations([{"name": "see_also"}, {"name": "cites"}], replace_defaults=True)
        assert json.loads(put.calls[1].request.content)["replace_defaults"] is True

    @respx.mock
    def test_conflict_surfaces_as_an_error(self) -> None:
        from gurucloud_kb import GuruCloudError

        respx.put(f"{API_PREFIX}/banks/kb-1/edge-relations").mock(return_value=httpx.Response(
            409, json={"error": {"code": "edge_types_in_use", "message": "stored connections carry applies_at (2)"}}))
        with pytest.raises(GuruCloudError, match="applies_at"):
            _kb().set_edge_relations([])

    @respx.mock
    @pytest.mark.asyncio
    async def test_async_mirror(self) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
        respx.get(f"{API_PREFIX}/banks/kb-1/edge-relations").mock(return_value=httpx.Response(200, json={"data": self.VOCAB}))
        put = respx.put(f"{API_PREFIX}/banks/kb-1/edge-relations").mock(return_value=httpx.Response(200, json={"data": self.VOCAB}))
        async with AsyncGuruCloudClient(api_key=API_KEY, base_url=BASE_URL) as client:
            kb = await client.get_kb("kb-1")
            vocab: Any = await kb.edge_relations()
            assert vocab["relations"][1]["name"] == "applies_at"
            await kb.set_edge_relations([{"name": "applies_at"}])
        assert json.loads(put.calls[0].request.content) == {"relations": [{"name": "applies_at"}], "replace_defaults": False}

    def test_builtin_constant_matches_the_literal(self) -> None:
        from typing import get_args

        from gurucloud_kb import BUILTIN_EDGE_TYPES, BuiltinEdgeType

        assert BUILTIN_EDGE_TYPES == get_args(BuiltinEdgeType)
