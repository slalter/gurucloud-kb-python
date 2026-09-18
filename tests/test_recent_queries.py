"""kb.list_recent_queries() on the sync and async clients — wire contract."""
from __future__ import annotations

import httpx
import pytest
import respx

from gurucloud_kb import AsyncGuruCloudClient, GuruCloudClient

BASE_URL = "https://test.gurucloudai.com"
API = f"{BASE_URL}/api/v1/kb"
API_KEY = "kb_test_key_abc123"
KB_INFO = {"kb_id": "kb-1", "name": "Test KB", "description": "d", "entry_count": 1, "total_queries": 0}
QUERIES = {
    "queries": [
        {"query_text": "how do deploys work", "duration_ms": 41.2, "result_count": 5, "filters_used": {}, "query_source": "agent_query", "created_at": "2026-09-17T10:00:00"},
        {"query_text": "invoice window", "duration_ms": 12.0, "result_count": 3, "filters_used": {"type": "gotcha"}, "query_source": None, "created_at": "2026-09-17T09:00:00"},
    ],
    "limit": 2,
}


@respx.mock
def test_sync_list_recent_queries():
    respx.get(f"{API}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
    route = respx.get(f"{API}/banks/kb-1/queries").mock(return_value=httpx.Response(200, json={"data": QUERIES}))
    kb = GuruCloudClient(API_KEY, base_url=BASE_URL).get_kb("kb-1")
    out = kb.list_recent_queries(limit=2)
    assert out == QUERIES
    assert route.calls.last.request.url.params["limit"] == "2"


@respx.mock
def test_sync_default_limit_is_50():
    respx.get(f"{API}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
    route = respx.get(f"{API}/banks/kb-1/queries").mock(return_value=httpx.Response(200, json={"data": {"queries": [], "limit": 50}}))
    GuruCloudClient(API_KEY, base_url=BASE_URL).get_kb("kb-1").list_recent_queries()
    assert route.calls.last.request.url.params["limit"] == "50"


@pytest.mark.asyncio
@respx.mock
async def test_async_list_recent_queries():
    respx.get(f"{API}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
    route = respx.get(f"{API}/banks/kb-1/queries").mock(return_value=httpx.Response(200, json={"data": QUERIES}))
    client = AsyncGuruCloudClient(API_KEY, base_url=BASE_URL)
    kb = await client.get_kb("kb-1")
    out = await kb.list_recent_queries(limit=2)
    assert out["queries"][0]["query_source"] == "agent_query"
    assert route.calls.last.request.url.params["limit"] == "2"
    await client.close()
