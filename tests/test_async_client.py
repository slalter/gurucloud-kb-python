"""Tests for AsyncGuruCloudClient and AsyncKnowledgeBank SDK classes.

Uses respx to mock HTTP requests against the API.
"""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from gurucloud_kb import (
    AsyncGuruCloudClient,
    AsyncKnowledgeBank,
    APIError,
    AuthenticationError,
    NotFoundError,
    RateLimitError,
)

BASE_URL = "https://test.gurucloudai.com"
API_PREFIX = f"{BASE_URL}/api/v1/kb"
API_KEY = "kb_test_key_abc123"

KB_INFO = {
    "kb_id": "test-kb-uuid",
    "name": "Test KB",
    "description": "A test knowledge bank",
    "entry_count": 42,
    "total_queries": 100,
    "embedding_model": "text-embedding-3-small",
    "embedding_dimensions": 1536,
    "created_at": "2026-01-01T00:00:00",
    "last_accessed_at": None,
}


@pytest.fixture
def client() -> AsyncGuruCloudClient:
    return AsyncGuruCloudClient(api_key=API_KEY, base_url=BASE_URL)


class TestAsyncClientInit:
    def test_rejects_invalid_api_key(self) -> None:
        with pytest.raises(ValueError, match="kb_"):
            AsyncGuruCloudClient(api_key="invalid_key")

    def test_accepts_valid_api_key(self) -> None:
        c = AsyncGuruCloudClient(api_key="kb_valid")
        assert "AsyncGuruCloudClient" in repr(c)

    @pytest.mark.asyncio
    async def test_async_context_manager(self) -> None:
        async with AsyncGuruCloudClient(api_key=API_KEY, base_url=BASE_URL) as c:
            assert c is not None


class TestAsyncListKBs:
    @respx.mock
    @pytest.mark.asyncio
    async def test_list_kbs_success(self, client: AsyncGuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks").mock(
            return_value=httpx.Response(200, json={"data": [KB_INFO]})
        )
        result = await client.list_kbs()
        assert len(result) == 1
        assert result[0]["kb_id"] == "test-kb-uuid"

    @respx.mock
    @pytest.mark.asyncio
    async def test_list_kbs_auth_error(self, client: AsyncGuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks").mock(
            return_value=httpx.Response(
                401, json={"error": {"code": "invalid_key", "message": "Bad key"}}
            )
        )
        with pytest.raises(AuthenticationError):
            await client.list_kbs()


class TestAsyncGetKB:
    @respx.mock
    @pytest.mark.asyncio
    async def test_get_kb_returns_async_knowledge_bank(self, client: AsyncGuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        kb = await client.get_kb("test-kb-uuid")
        assert isinstance(kb, AsyncKnowledgeBank)
        assert kb.id == "test-kb-uuid"
        assert kb.name == "Test KB"
        assert kb.entry_count == 42

    @respx.mock
    @pytest.mark.asyncio
    async def test_get_kb_not_found(self, client: AsyncGuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/nonexistent").mock(
            return_value=httpx.Response(
                404, json={"error": {"code": "not_found", "message": "KB not found"}}
            )
        )
        with pytest.raises(NotFoundError):
            await client.get_kb("nonexistent")


class TestAsyncCreateKB:
    @respx.mock
    @pytest.mark.asyncio
    async def test_create_kb_success(self, client: AsyncGuruCloudClient) -> None:
        respx.post(f"{API_PREFIX}/banks").mock(
            return_value=httpx.Response(201, json={"data": KB_INFO})
        )
        kb = await client.create_kb("Test KB", description="A test KB")
        assert isinstance(kb, AsyncKnowledgeBank)
        assert kb.name == "Test KB"

    @respx.mock
    @pytest.mark.asyncio
    async def test_create_kb_with_schema(self, client: AsyncGuruCloudClient) -> None:
        route = respx.post(f"{API_PREFIX}/banks").mock(
            return_value=httpx.Response(201, json={"data": KB_INFO})
        )
        schema = {
            "version": 1,
            "dimensions": [{"name": "content", "dimension_type": "single"}],
            "categories": [],
            "combination_mode": "weighted_sum",
        }
        await client.create_kb("Test KB", dimension_schema=schema)
        sent_body = json.loads(route.calls[0].request.content)
        assert "dimension_schema" in sent_body


class TestAsyncKnowledgeBankSearch:
    @respx.mock
    @pytest.mark.asyncio
    async def test_simple_string_search(self, client: AsyncGuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        results_data = [
            {"id": "e1", "content": "Auth uses JWT", "combined_score": 0.92}
        ]
        route = respx.post(f"{API_PREFIX}/banks/test-kb-uuid/search").mock(
            return_value=httpx.Response(200, json={"data": results_data})
        )

        kb = await client.get_kb("test-kb-uuid")
        results = await kb.search("auth tokens")

        assert len(results) == 1
        assert results[0]["combined_score"] == 0.92

        sent = json.loads(route.calls[0].request.content)
        assert "content" in sent["dimensions"]
        assert sent["dimensions"]["content"]["query_text"] == "auth tokens"
        assert "query" not in sent["dimensions"]["content"]

    @respx.mock
    @pytest.mark.asyncio
    async def test_multi_dimensional_search(self, client: AsyncGuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        route = respx.post(f"{API_PREFIX}/banks/test-kb-uuid/search").mock(
            return_value=httpx.Response(200, json={"data": []})
        )

        kb = await client.get_kb("test-kb-uuid")
        await kb.search({
            "dimensions": {
                "content": {"query_text": "JWT", "weight": 1.0},
                "useful_for": {"query_text": "debugging", "weight": 1.5},
            },
            "combination_mode": "weighted_sum",
            "metadata_filters": {"status": "resolved"},
            "k": 5,
            "threshold": 0.6,
        })

        sent = json.loads(route.calls[0].request.content)
        assert sent["dimensions"]["content"]["query_text"] == "JWT"
        assert sent["combination_mode"] == "weighted_sum"
        assert sent["metadata_filters"] == {"status": "resolved"}

    @respx.mock
    @pytest.mark.asyncio
    async def test_search_normalizes_legacy_aliases(
        self, client: AsyncGuruCloudClient
    ) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        route = respx.post(f"{API_PREFIX}/banks/test-kb-uuid/search").mock(
            return_value=httpx.Response(200, json={"data": []})
        )

        kb = await client.get_kb("test-kb-uuid")
        await kb.search({
            "dimensions": {"content": {"query": "JWT", "weight": 2.0}},
            "filters": {"metadata": {"is_example": True}},
        })

        sent = json.loads(route.calls[0].request.content)
        assert sent["dimensions"]["content"]["query_text"] == "JWT"
        assert sent["metadata_filters"] == {"is_example": True}
        assert "filters" not in sent


class TestAsyncKnowledgeBankEntries:
    @respx.mock
    @pytest.mark.asyncio
    async def test_add_entry(self, client: AsyncGuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        respx.post(f"{API_PREFIX}/banks/test-kb-uuid/entries").mock(
            return_value=httpx.Response(201, json={"data": {"id": "new-entry"}})
        )

        kb = await client.get_kb("test-kb-uuid")
        result = await kb.add_entry({
            "dimensions": {"content": "Test content", "useful_for": "Testing"},
        })
        assert result["id"] == "new-entry"

    @respx.mock
    @pytest.mark.asyncio
    async def test_list_entries_pagination(self, client: AsyncGuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        route = respx.get(f"{API_PREFIX}/banks/test-kb-uuid/entries").mock(
            return_value=httpx.Response(200, json={"data": []})
        )

        kb = await client.get_kb("test-kb-uuid")
        await kb.list_entries(limit=25, offset=50)

        assert route.calls[0].request.url.params["limit"] == "25"
        assert route.calls[0].request.url.params["offset"] == "50"

    @respx.mock
    @pytest.mark.asyncio
    async def test_delete_entry(self, client: AsyncGuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        respx.delete(f"{API_PREFIX}/banks/test-kb-uuid/entries/e1").mock(
            return_value=httpx.Response(200, json={"data": {"deleted": True}})
        )

        kb = await client.get_kb("test-kb-uuid")
        result = await kb.delete_entry("e1")
        assert result["deleted"] is True


class TestAsyncKnowledgeBankSchema:
    @respx.mock
    @pytest.mark.asyncio
    async def test_get_schema(self, client: AsyncGuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        schema_data = {"version": 1, "dimensions": [], "categories": []}
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid/schema").mock(
            return_value=httpx.Response(200, json={"data": schema_data})
        )

        kb = await client.get_kb("test-kb-uuid")
        schema = await kb.get_schema()
        assert schema["version"] == 1

    @respx.mock
    @pytest.mark.asyncio
    async def test_add_dimension(self, client: AsyncGuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        respx.post(f"{API_PREFIX}/banks/test-kb-uuid/schema/dimensions").mock(
            return_value=httpx.Response(200, json={"data": {"dimension": "priority"}})
        )

        kb = await client.get_kb("test-kb-uuid")
        result = await kb.add_dimension({"name": "priority", "dimension_type": "single"})
        assert result["dimension"] == "priority"


class TestAsyncBatchIngest:
    @respx.mock
    @pytest.mark.asyncio
    async def test_batch_ingest(self, client: AsyncGuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        respx.post(f"{API_PREFIX}/banks/test-kb-uuid/entries/batch").mock(
            return_value=httpx.Response(200, json={"data": {"ingested": 3, "errors": []}})
        )

        kb = await client.get_kb("test-kb-uuid")
        result = await kb.ingest([
            {"dimensions": {"content": "Entry 1"}},
            {"dimensions": {"content": "Entry 2"}},
            {"dimensions": {"content": "Entry 3"}},
        ])
        assert result["ingested"] == 3
        assert result["errors"] == []


class TestAsyncMCPServerDefinition:
    @respx.mock
    @pytest.mark.asyncio
    async def test_get_mcp_server_definition_from_kb(self, client: AsyncGuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        mcp_def = {
            "server_name": "test-kb",
            "type": "http",
            "url": "https://test.gurucloudai.com/mcp/srv-uuid/mcp",
            "description": "Test KB",
            "token": "mcp_token_abc123",
            "available_tools": ["query_knowledge_bank", "report_learning"],
        }
        respx.post(f"{API_PREFIX}/banks/test-kb-uuid/mcp-server-definition").mock(
            return_value=httpx.Response(200, json={"data": mcp_def})
        )

        kb = await client.get_kb("test-kb-uuid")
        result = await kb.get_mcp_server_definition()
        assert result["type"] == "http"
        assert result["token"] == "mcp_token_abc123"
        assert "query_knowledge_bank" in result["available_tools"]

    @respx.mock
    @pytest.mark.asyncio
    async def test_get_mcp_server_definition_from_client(self, client: AsyncGuruCloudClient) -> None:
        mcp_def = {
            "server_name": "test-kb",
            "type": "http",
            "url": "https://test.gurucloudai.com/mcp/srv-uuid/mcp",
            "token": "mcp_token_abc123",
        }
        respx.post(f"{API_PREFIX}/banks/my-kb/mcp-server-definition").mock(
            return_value=httpx.Response(200, json={"data": mcp_def})
        )

        result = await client.get_mcp_server_definition("my-kb")
        assert result["token"] == "mcp_token_abc123"


class TestAsyncDeduplicationEvents:
    @respx.mock
    @pytest.mark.asyncio
    async def test_list_events(self, client: AsyncGuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        events_response = {
            "events": [
                {
                    "id": "evt-1",
                    "kb_id": "test-kb-uuid",
                    "source": "mcp_tools",
                    "content_preview": "Auth uses JWT...",
                    "max_similarity_score": 0.95,
                    "llm_invoked": True,
                    "action": "update",
                    "created_at": "2026-03-01T00:00:00",
                }
            ],
            "total": 1,
            "limit": 50,
            "offset": 0,
            "action_counts": {"update": 1},
        }
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid/events").mock(
            return_value=httpx.Response(200, json={"data": events_response})
        )

        kb = await client.get_kb("test-kb-uuid")
        result = await kb.list_events()

        assert result["total"] == 1
        assert result["events"][0]["action"] == "update"

    @respx.mock
    @pytest.mark.asyncio
    async def test_list_events_with_action_filter(self, client: AsyncGuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        route = respx.get(f"{API_PREFIX}/banks/test-kb-uuid/events").mock(
            return_value=httpx.Response(
                200, json={"data": {"events": [], "total": 0, "limit": 50, "offset": 0, "action_counts": {}}}
            )
        )

        kb = await client.get_kb("test-kb-uuid")
        await kb.list_events(action="conflict", limit=10)

        assert route.calls[0].request.url.params["action"] == "conflict"
        assert route.calls[0].request.url.params["limit"] == "10"

    @respx.mock
    @pytest.mark.asyncio
    async def test_get_event(self, client: AsyncGuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        event_data = {
            "id": "evt-1",
            "kb_id": "test-kb-uuid",
            "source": "mcp_tools",
            "new_entry_content": "Auth uses JWT tokens",
            "action": "update",
            "reasoning": "Content overlaps with existing entry",
            "merged_content": "Combined auth content",
            "llm_invoked": True,
            "max_similarity_score": 0.95,
        }
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid/events/evt-1").mock(
            return_value=httpx.Response(200, json={"data": event_data})
        )

        kb = await client.get_kb("test-kb-uuid")
        result = await kb.get_event("evt-1")
        assert result["action"] == "update"
        assert result["reasoning"] == "Content overlaps with existing entry"


class TestAsyncEntryEventLogs:
    @respx.mock
    @pytest.mark.asyncio
    async def test_list_event_logs(self, client: AsyncGuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        logs_response = {
            "logs": [
                {
                    "id": "log-1",
                    "kb_id": "test-kb-uuid",
                    "event_type": "lifecycle",
                    "event_name": "processing_started",
                    "success": True,
                    "duration_ms": 42,
                }
            ],
            "total": 1,
            "limit": 50,
            "offset": 0,
        }
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid/event-logs").mock(
            return_value=httpx.Response(200, json={"data": logs_response})
        )

        kb = await client.get_kb("test-kb-uuid")
        result = await kb.list_event_logs()
        assert result["total"] == 1
        assert result["logs"][0]["event_type"] == "lifecycle"

    @respx.mock
    @pytest.mark.asyncio
    async def test_list_event_logs_with_filters(self, client: AsyncGuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        route = respx.get(f"{API_PREFIX}/banks/test-kb-uuid/event-logs").mock(
            return_value=httpx.Response(
                200, json={"data": {"logs": [], "total": 0, "limit": 50, "offset": 0}}
            )
        )

        kb = await client.get_kb("test-kb-uuid")
        await kb.list_event_logs(event_type="dedup", entry_id="abc-123")

        assert route.calls[0].request.url.params["event_type"] == "dedup"
        assert route.calls[0].request.url.params["entry_id"] == "abc-123"


class TestAsyncErrorHandling:
    @respx.mock
    @pytest.mark.asyncio
    async def test_rate_limit_error(self, client: AsyncGuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks").mock(
            return_value=httpx.Response(
                429, json={"error": {"code": "rate_limited", "message": "Slow down"}}
            )
        )
        with pytest.raises(RateLimitError):
            await client.list_kbs()

    @respx.mock
    @pytest.mark.asyncio
    async def test_generic_api_error(self, client: AsyncGuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks").mock(
            return_value=httpx.Response(
                500, json={"error": {"code": "internal", "message": "Oops"}}
            )
        )
        with pytest.raises(APIError) as exc_info:
            await client.list_kbs()
        assert exc_info.value.status_code == 500
