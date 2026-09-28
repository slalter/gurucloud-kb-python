"""Tests for kb.search_expanded (sync + async) and the request builder."""

from __future__ import annotations

import json
from typing import Any
from datetime import datetime, timezone

import httpx
import pytest
import respx

from gurucloud_kb import AsyncGuruCloudClient, GuruCloudClient
from gurucloud_kb._search import build_expanded_search

BASE_URL = "https://test.gurucloudai.com"
API_PREFIX = f"{BASE_URL}/api/v1/kb"
API_KEY = "kb_test_key_abc123"
KB_INFO = {"kb_id": "kb-1", "name": "Games", "description": "Browser games", "entry_count": 129, "total_queries": 0}

EXPANDED = {
    "results": [{"id": "e1", "content": "Frostmaw TD", "useful_for": "", "relevant_systems": [], "relevant_tasks": [],
                 "combined_score": 0.91, "useful_for_score": 0.0, "metadata": {"slug": "frostmaw-td"}}],
    "expansion": {"status": "expanded", "model": "gpt-5.5", "credential_source": "owner",
                  "dimensions": {"genre": "tower defense"}, "descriptors": ["place towers"],
                  "content_query": "td. place towers", "content_dimension": "content", "duration_ms": 880.0,
                  "input_tokens": 200, "output_tokens": 25, "error": None, "expansion_id": "x1"},
    "search_request": {"dimensions": {"content": {"query_text": "td. place towers", "weight": 3.0},
                                      "genre": {"query_text": "tower defense"}}, "k": 10, "lexical": {"query_text": "td"}},
}


class TestBuilder:
    def test_minimal_body_sends_only_query_k_threshold(self) -> None:
        body = build_expanded_search("  td ", k=10, threshold=0.25, time_bounds={}, options={})
        assert body == {"query": "td", "k": 10, "threshold": 0.25}

    def test_options_and_bounds_serialize(self) -> None:
        since = datetime(2026, 9, 1, tzinfo=timezone.utc)
        body = build_expanded_search(
            "td", k=5, threshold=0.0,
            time_bounds={"created_after": since, "created_before": None, "event_before": "2026-10-01"},
            options={"content_weight": 2.0, "lexical": False, "model": "gpt-6-luna", "timeout_seconds": 1.5,
                     "context": "an arcade", "exclude_dimensions": ["tags"], "expand": False, "use_cache": None,
                     "metadata_filters": {"published": True}, "lexical_options": {"boost": 0.2}, "bogus": 1},
        )
        assert body["created_after"] == since.isoformat() and "created_before" not in body
        assert body["event_before"] == "2026-10-01"
        assert body["content_weight"] == 2.0 and body["lexical"] is False and body["model"] == "gpt-6-luna"
        assert body["timeout_seconds"] == 1.5 and body["context"] == "an arcade"
        assert body["exclude_dimensions"] == ["tags"] and body["expand"] is False
        assert body["metadata_filters"] == {"published": True} and body["lexical_options"] == {"boost": 0.2}
        assert "use_cache" not in body and "bogus" not in body

    def test_blank_query_rejected(self) -> None:
        with pytest.raises(ValueError, match="blank"):
            build_expanded_search("   ", k=10, threshold=0.25, time_bounds={}, options={})


class TestSync:
    @respx.mock
    def test_search_expanded_posts_body_and_unwraps_envelope(self) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
        route = respx.post(f"{API_PREFIX}/banks/kb-1/search/expanded").mock(
            return_value=httpx.Response(200, json={"data": EXPANDED}))
        with GuruCloudClient(api_key=API_KEY, base_url=BASE_URL) as client:
            kb = client.get_kb("kb-1")
            out: Any = kb.search_expanded("td", k=5, metadata_filters={"published": True}, context="an arcade",
                                     model="gpt-5.5", timeout_seconds=1.5, category_filters=[{"tag": "gotcha"}])
        assert out["results"][0]["metadata"]["slug"] == "frostmaw-td"
        assert out["expansion"]["status"] == "expanded" and out["expansion"]["credential_source"] == "owner"
        assert out["search_request"]["dimensions"]["genre"]["query_text"] == "tower defense"
        sent = json.loads(route.calls.last.request.content)
        assert sent == {"query": "td", "k": 5, "threshold": 0.25, "metadata_filters": {"published": True},
                        "context": "an arcade", "model": "gpt-5.5", "timeout_seconds": 1.5,
                        "category_filters": [{"tag": "gotcha"}]}
        assert route.calls.last.request.headers["Authorization"] == f"Bearer {API_KEY}"

    @respx.mock
    def test_raw_fallback_is_reported_not_raised(self) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
        fallback = dict(EXPANDED, expansion=dict(EXPANDED["expansion"], status="timeout", error="expander exceeded 1.0s"))
        respx.post(f"{API_PREFIX}/banks/kb-1/search/expanded").mock(return_value=httpx.Response(200, json={"data": fallback}))
        with GuruCloudClient(api_key=API_KEY, base_url=BASE_URL) as client:
            out: Any = client.get_kb("kb-1").search_expanded("td", timeout_seconds=1.0)
        assert out["expansion"]["status"] == "timeout" and out["results"]

    @respx.mock
    def test_self_hosted_platform_path(self) -> None:
        platform = "https://kb-platform.internal"
        respx.get(f"{platform}/api/v1/kb/banks/Games").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
        route = respx.post(f"{platform}/api/v1/kb/banks/kb-1/search/expanded").mock(
            return_value=httpx.Response(200, json={"data": EXPANDED}))
        with GuruCloudClient(api_key="dec-service-token", base_url=platform) as client:
            client.get_kb("Games").search_expanded("td", expand=False)
        assert json.loads(route.calls.last.request.content)["expand"] is False


class TestAsync:
    @respx.mock
    @pytest.mark.asyncio
    async def test_async_search_expanded(self) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
        route = respx.post(f"{API_PREFIX}/banks/kb-1/search/expanded").mock(
            return_value=httpx.Response(200, json={"data": EXPANDED}))
        async with AsyncGuruCloudClient(api_key=API_KEY, base_url=BASE_URL) as client:
            kb = await client.get_kb("kb-1")
            out: Any = await kb.search_expanded("td", lexical=False, exclude_dimensions=["tags"],
                                           created_after=datetime(2026, 9, 1, tzinfo=timezone.utc))
        assert out["expansion"]["content_query"] == "td. place towers"
        sent = json.loads(route.calls.last.request.content)
        assert sent["lexical"] is False and sent["exclude_dimensions"] == ["tags"]
        assert sent["created_after"] == "2026-09-01T00:00:00+00:00"



class TestSpeed:
    def test_speed_and_reasoning_go_on_the_wire_only_when_given(self) -> None:
        body = build_expanded_search("td", k=10, threshold=0.25, time_bounds={}, options={"speed": "thorough", "reasoning_effort": "low", "timeout_seconds": None})
        assert body["speed"] == "thorough" and body["reasoning_effort"] == "low" and "timeout_seconds" not in body
        assert "speed" not in build_expanded_search("td", k=10, threshold=0.25, time_bounds={}, options={})

    @respx.mock
    def test_search_expanded_sends_speed(self) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
        route = respx.post(f"{API_PREFIX}/banks/kb-1/search/expanded").mock(return_value=httpx.Response(200, json={"data": EXPANDED}))
        with GuruCloudClient(api_key=API_KEY, base_url=BASE_URL) as client:
            client.get_kb("kb-1").search_expanded("td", speed="fast", reasoning_effort="none")
        sent = json.loads(route.calls.last.request.content)
        assert sent["speed"] == "fast" and sent["reasoning_effort"] == "none"
