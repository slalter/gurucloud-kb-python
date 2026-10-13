"""kb.list_entries filters, kb.metadata_facets and the source filter on search
(sync + async) — gurucloud-kb 0.6.0 (kanban b0d20cff)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import httpx
import pytest
import respx

from gurucloud_kb import AsyncGuruCloudClient, GuruCloudClient
from gurucloud_kb._search import build_expanded_search, build_list_params

BASE_URL = "https://test.gurucloudai.com"
API_PREFIX = f"{BASE_URL}/api/v1/kb"
API_KEY = "kb_test_key_abc123"
KB_INFO = {"kb_id": "kb-1", "name": "Games", "description": "", "entry_count": 1, "total_queries": 0}
FACETS = {
    "total_entries": 812, "max_values": 25, "truncated_keys": False,
    "facets": [{"key": "created_by", "entry_count": 812, "distinct_count": 4, "has_list_values": False, "has_object_values": False,
                "values": [{"value": "alice", "type": "string", "count": 500, "in_list": False}]}],
    "source": {"entry_count": 812, "distinct_count": 1, "values": [{"value": "api", "type": "string", "count": 812, "in_list": False}]},
}


class TestBuilders:
    def test_bare_list_params_are_the_legacy_request(self) -> None:
        assert build_list_params(limit=50, offset=0) == {"limit": 50, "offset": 0}

    def test_filters_serialize(self) -> None:
        since = datetime(2026, 10, 1, tzinfo=timezone.utc)
        params = build_list_params(limit=10, offset=20, metadata_filters={"created_by": "alice", "tags": ["a"]}, source="api",
                                   created_after=since, created_before="2026-10-13T23:59:59Z")
        assert params["limit"] == 10 and params["offset"] == 20
        assert json.loads(params["metadata_filters"]) == {"created_by": "alice", "tags": ["a"]}
        assert params["source"] == "api"
        assert params["created_after"] == since.isoformat() and params["created_before"] == "2026-10-13T23:59:59Z"
        assert "updated_after" not in params

    def test_empty_metadata_filters_not_sent(self) -> None:
        assert "metadata_filters" not in build_list_params(limit=1, offset=0, metadata_filters={})

    def test_expanded_search_carries_source(self) -> None:
        body = build_expanded_search("td", k=5, threshold=0.2, time_bounds={}, options={"source": "api", "metadata_filters": None})
        assert body == {"query": "td", "k": 5, "threshold": 0.2, "source": "api"}


class TestSync:
    @respx.mock
    def test_list_entries_sends_filters(self) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
        route = respx.get(f"{API_PREFIX}/banks/kb-1/entries").mock(return_value=httpx.Response(200, json={"data": [{"id": "e1"}]}))
        kb = GuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("kb-1")
        out = kb.list_entries(limit=5, metadata_filters={"created_by": "alice"}, source="api", created_after="2026-10-01")
        assert out == [{"id": "e1"}]
        params = route.calls[0].request.url.params
        assert json.loads(params["metadata_filters"]) == {"created_by": "alice"}
        assert params["source"] == "api" and params["created_after"] == "2026-10-01" and params["limit"] == "5"

    @respx.mock
    def test_list_entries_without_filters_is_unchanged(self) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
        route = respx.get(f"{API_PREFIX}/banks/kb-1/entries").mock(return_value=httpx.Response(200, json={"data": []}))
        GuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("kb-1").list_entries(limit=25, offset=50)
        assert dict(route.calls[0].request.url.params) == {"limit": "25", "offset": "50"}

    @respx.mock
    def test_metadata_facets(self) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
        route = respx.get(f"{API_PREFIX}/banks/kb-1/metadata-facets").mock(return_value=httpx.Response(200, json={"data": FACETS}))
        # Any: SDK result TypedDicts are total=False and CI pyright flags plain indexing.
        facets: Any = GuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("kb-1").metadata_facets(max_values=10)
        assert facets["facets"][0]["key"] == "created_by" and facets["source"]["values"][0]["value"] == "api"
        assert route.calls[0].request.url.params["max_values"] == "10" and route.calls[0].request.url.params["max_keys"] == "200"

    @respx.mock
    def test_search_expanded_sends_source(self) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
        route = respx.post(f"{API_PREFIX}/banks/kb-1/search/expanded").mock(
            return_value=httpx.Response(200, json={"data": {"results": [], "expansion": {"status": "empty"}, "search_request": {}}})
        )
        GuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("kb-1").search_expanded("td", source="api")
        assert json.loads(route.calls[0].request.content)["source"] == "api"


class TestAsync:
    @pytest.mark.asyncio
    @respx.mock
    async def test_list_entries_and_facets(self) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
        entries = respx.get(f"{API_PREFIX}/banks/kb-1/entries").mock(return_value=httpx.Response(200, json={"data": []}))
        facets = respx.get(f"{API_PREFIX}/banks/kb-1/metadata-facets").mock(return_value=httpx.Response(200, json={"data": FACETS}))
        kb = await AsyncGuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("kb-1")
        await kb.list_entries(metadata_filters={"tags": ["a"]}, updated_before="2026-10-13")
        out: Any = await kb.metadata_facets()
        params = entries.calls[0].request.url.params
        assert json.loads(params["metadata_filters"]) == {"tags": ["a"]} and params["updated_before"] == "2026-10-13"
        assert out["total_entries"] == 812 and facets.calls[0].request.url.params["max_values"] == "25"
