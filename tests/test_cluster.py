"""Tests for kb.cluster() / await kb.cluster() (sync + async).

Uses respx to mock the HTTP layer and asserts the request body the SDK builds
(field defaults, k omission, search normalization) plus response passthrough.
"""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from gurucloud_kb import AsyncGuruCloudClient, GuruCloudClient

BASE_URL = "https://test.gurucloudai.com"
API_PREFIX = f"{BASE_URL}/api/v1/kb"
API_KEY = "kb_test_key_abc123"

KB_INFO = {
    "kb_id": "test-kb-uuid",
    "name": "Test KB",
    "description": "A test knowledge bank",
    "entry_count": 42,
    "embedding_model": "text-embedding-3-small",
    "embedding_dimensions": 1536,
}

VECTOR_RESPONSE = {
    "kb_id": "test-kb-uuid",
    "scope": {"source": "all", "entry_count": 42, "truncated": False},
    "results": [
        {
            "field": "content",
            "method": "vector",
            "algorithm": "kmeans",
            "cluster_count": 2,
            "clustered_count": 40,
            "noise_count": 2,
            "silhouette_score": 0.41,
            "clusters": [],
        }
    ],
}


@respx.mock
def test_cluster_sync_sends_params_and_returns_results() -> None:
    respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
        return_value=httpx.Response(200, json={"data": KB_INFO})
    )
    kb = GuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("test-kb-uuid")
    route = respx.post(f"{API_PREFIX}/banks/test-kb-uuid/cluster").mock(
        return_value=httpx.Response(200, json={"data": VECTOR_RESPONSE})
    )

    result = kb.cluster(fields=["content"], algorithm="kmeans", k=2)

    assert result["scope"]["entry_count"] == 42
    assert result["results"][0]["field"] == "content"
    assert result["results"][0]["method"] == "vector"

    sent = json.loads(route.calls[0].request.content)
    assert sent["fields"] == ["content"]
    assert sent["algorithm"] == "kmeans"
    assert sent["k"] == 2
    assert "search" not in sent  # omitted when not provided


@respx.mock
def test_cluster_sync_defaults_and_omits_k() -> None:
    respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
        return_value=httpx.Response(200, json={"data": KB_INFO})
    )
    kb = GuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("test-kb-uuid")
    route = respx.post(f"{API_PREFIX}/banks/test-kb-uuid/cluster").mock(
        return_value=httpx.Response(
            200, json={"data": {"scope": {"source": "all", "entry_count": 0}, "results": []}}
        )
    )

    kb.cluster()

    sent = json.loads(route.calls[0].request.content)
    # No fields sent -> the server picks the KB's primary embedding dimension
    # (schema-aware; a hardcoded "content" is wrong for custom-schema KBs).
    assert "fields" not in sent
    assert sent["method"] == "auto"
    assert sent["label"] is False
    assert sent["label_sample_size"] == 5  # default representative cap
    assert "k" not in sent  # None -> omitted so the service auto-selects


@respx.mock
def test_cluster_sync_forwards_label_sample_size() -> None:
    respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
        return_value=httpx.Response(200, json={"data": KB_INFO})
    )
    kb = GuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("test-kb-uuid")
    route = respx.post(f"{API_PREFIX}/banks/test-kb-uuid/cluster").mock(
        return_value=httpx.Response(
            200, json={"data": {"scope": {"source": "all", "entry_count": 0}, "results": []}}
        )
    )

    kb.cluster(label=True, label_sample_size=3)

    sent = json.loads(route.calls[0].request.content)
    assert sent["label"] is True
    assert sent["label_sample_size"] == 3


@respx.mock
def test_cluster_sync_normalizes_and_includes_search() -> None:
    respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
        return_value=httpx.Response(200, json={"data": KB_INFO})
    )
    kb = GuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("test-kb-uuid")
    route = respx.post(f"{API_PREFIX}/banks/test-kb-uuid/cluster").mock(
        return_value=httpx.Response(
            200, json={"data": {"scope": {"source": "search", "entry_count": 3}, "results": []}}
        )
    )

    kb.cluster(
        fields=["metadata.customer"],
        method="fuzzy",
        similarity_threshold=0.9,
        search={"dimensions": {"content": {"query_text": "billing error"}}},
    )

    sent = json.loads(route.calls[0].request.content)
    assert sent["method"] == "fuzzy"
    assert sent["similarity_threshold"] == 0.9
    assert "search" in sent
    assert sent["search"]["dimensions"]["content"]["query_text"] == "billing error"


@pytest.mark.asyncio
@respx.mock
async def test_cluster_async_multi_field() -> None:
    respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
        return_value=httpx.Response(200, json={"data": KB_INFO})
    )
    client = AsyncGuruCloudClient(api_key=API_KEY, base_url=BASE_URL)
    kb = await client.get_kb("test-kb-uuid")
    route = respx.post(f"{API_PREFIX}/banks/test-kb-uuid/cluster").mock(
        return_value=httpx.Response(
            200, json={"data": {"scope": {"source": "all", "entry_count": 5}, "results": []}}
        )
    )

    result = await kb.cluster(fields=["content", "metadata.customer"])
    await client.close()

    assert result["scope"]["entry_count"] == 5
    sent = json.loads(route.calls[0].request.content)
    assert sent["fields"] == ["content", "metadata.customer"]

@respx.mock
def test_cluster_sync_forwards_size_caps_and_omits_when_unset() -> None:
    respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
        return_value=httpx.Response(200, json={"data": KB_INFO})
    )
    kb = GuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("test-kb-uuid")
    route = respx.post(f"{API_PREFIX}/banks/test-kb-uuid/cluster").mock(
        return_value=httpx.Response(
            200, json={"data": {"scope": {"source": "all", "entry_count": 0}, "results": []}}
        )
    )

    kb.cluster(max_cluster_size=50, max_cluster_fraction=0.25)
    kb.cluster()

    capped = json.loads(route.calls[0].request.content)
    assert capped["max_cluster_size"] == 50
    assert capped["max_cluster_fraction"] == 0.25
    uncapped = json.loads(route.calls[1].request.content)
    assert "max_cluster_size" not in uncapped
    assert "max_cluster_fraction" not in uncapped


@pytest.mark.asyncio
@respx.mock
async def test_cluster_async_forwards_size_caps() -> None:
    respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
        return_value=httpx.Response(200, json={"data": KB_INFO})
    )
    client = AsyncGuruCloudClient(api_key=API_KEY, base_url=BASE_URL)
    kb = await client.get_kb("test-kb-uuid")
    route = respx.post(f"{API_PREFIX}/banks/test-kb-uuid/cluster").mock(
        return_value=httpx.Response(
            200, json={"data": {"scope": {"source": "all", "entry_count": 0}, "results": []}}
        )
    )

    await kb.cluster(max_cluster_size=10, max_cluster_fraction=0.1)
    await client.close()

    sent = json.loads(route.calls[0].request.content)
    assert sent["max_cluster_size"] == 10
    assert sent["max_cluster_fraction"] == 0.1


@respx.mock
def test_cluster_sync_forwards_outlier_strategy_and_omits_default() -> None:
    respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
        return_value=httpx.Response(200, json={"data": KB_INFO})
    )
    kb = GuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("test-kb-uuid")
    route = respx.post(f"{API_PREFIX}/banks/test-kb-uuid/cluster").mock(
        return_value=httpx.Response(
            200, json={"data": {"scope": {"source": "all", "entry_count": 0}, "results": []}}
        )
    )

    kb.cluster(outlier_strategy="subcluster")
    kb.cluster()

    sent = json.loads(route.calls[0].request.content)
    assert sent["outlier_strategy"] == "subcluster"
    default = json.loads(route.calls[1].request.content)
    assert "outlier_strategy" not in default  # older servers stay compatible


@pytest.mark.asyncio
@respx.mock
async def test_cluster_async_forwards_outlier_strategy() -> None:
    respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
        return_value=httpx.Response(200, json={"data": KB_INFO})
    )
    client = AsyncGuruCloudClient(api_key=API_KEY, base_url=BASE_URL)
    kb = await client.get_kb("test-kb-uuid")
    route = respx.post(f"{API_PREFIX}/banks/test-kb-uuid/cluster").mock(
        return_value=httpx.Response(
            200, json={"data": {"scope": {"source": "all", "entry_count": 0}, "results": []}}
        )
    )

    await kb.cluster(outlier_strategy="reassign")
    await client.close()

    sent = json.loads(route.calls[0].request.content)
    assert sent["outlier_strategy"] == "reassign"


@respx.mock
def test_cluster_sync_forwards_member_sample_and_omits_default() -> None:
    respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
        return_value=httpx.Response(200, json={"data": KB_INFO})
    )
    kb = GuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("test-kb-uuid")
    route = respx.post(f"{API_PREFIX}/banks/test-kb-uuid/cluster").mock(
        return_value=httpx.Response(
            200, json={"data": {"scope": {"source": "all", "entry_count": 0}, "results": []}}
        )
    )

    kb.cluster(member_sample="diverse")
    kb.cluster()

    sent = json.loads(route.calls[0].request.content)
    assert sent["member_sample"] == "diverse"
    default = json.loads(route.calls[1].request.content)
    assert "member_sample" not in default  # older servers stay compatible


@pytest.mark.asyncio
@respx.mock
async def test_cluster_async_forwards_member_sample() -> None:
    respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
        return_value=httpx.Response(200, json={"data": KB_INFO})
    )
    client = AsyncGuruCloudClient(api_key=API_KEY, base_url=BASE_URL)
    kb = await client.get_kb("test-kb-uuid")
    route = respx.post(f"{API_PREFIX}/banks/test-kb-uuid/cluster").mock(
        return_value=httpx.Response(
            200, json={"data": {"scope": {"source": "all", "entry_count": 0}, "results": []}}
        )
    )

    await kb.cluster(member_sample="diverse")
    await client.close()

    sent = json.loads(route.calls[0].request.content)
    assert sent["member_sample"] == "diverse"
