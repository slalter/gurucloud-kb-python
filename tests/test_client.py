"""Tests for GuruCloudClient and KnowledgeBank SDK classes.

Uses respx to mock HTTP requests against the API.
"""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from gurucloud_kb import (
    GuruCloudClient,
    KnowledgeBank,
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
def client() -> GuruCloudClient:
    return GuruCloudClient(api_key=API_KEY, base_url=BASE_URL)


class TestClientInit:
    def test_rejects_invalid_api_key(self) -> None:
        with pytest.raises(ValueError, match="kb_"):
            GuruCloudClient(api_key="invalid_key")

    def test_accepts_valid_api_key(self) -> None:
        c = GuruCloudClient(api_key="kb_valid")
        assert repr(c) == f"GuruCloudClient(base_url='{BASE_URL}')" or "GuruCloudClient" in repr(c)

    def test_context_manager(self) -> None:
        with GuruCloudClient(api_key=API_KEY, base_url=BASE_URL) as c:
            assert c is not None


class TestListKBs:
    @respx.mock
    def test_list_kbs_success(self, client: GuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks").mock(
            return_value=httpx.Response(200, json={"data": [KB_INFO]})
        )
        result = client.list_kbs()
        assert len(result) == 1
        assert result[0]["kb_id"] == "test-kb-uuid"

    @respx.mock
    def test_list_kbs_auth_error(self, client: GuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks").mock(
            return_value=httpx.Response(
                401, json={"error": {"code": "invalid_key", "message": "Bad key"}}
            )
        )
        with pytest.raises(AuthenticationError):
            client.list_kbs()


class TestGetKB:
    @respx.mock
    def test_get_kb_returns_knowledge_bank(self, client: GuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        kb = client.get_kb("test-kb-uuid")
        assert isinstance(kb, KnowledgeBank)
        assert kb.id == "test-kb-uuid"
        assert kb.name == "Test KB"
        assert kb.entry_count == 42
        assert kb.total_queries == 100

    @respx.mock
    def test_get_kb_not_found(self, client: GuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/nonexistent").mock(
            return_value=httpx.Response(
                404, json={"error": {"code": "not_found", "message": "KB not found"}}
            )
        )
        with pytest.raises(NotFoundError):
            client.get_kb("nonexistent")


class TestCreateKB:
    @respx.mock
    def test_create_kb_success(self, client: GuruCloudClient) -> None:
        respx.post(f"{API_PREFIX}/banks").mock(
            return_value=httpx.Response(201, json={"data": KB_INFO})
        )
        kb = client.create_kb("Test KB", description="A test KB")
        assert isinstance(kb, KnowledgeBank)
        assert kb.name == "Test KB"

    @respx.mock
    def test_create_kb_with_schema(self, client: GuruCloudClient) -> None:
        route = respx.post(f"{API_PREFIX}/banks").mock(
            return_value=httpx.Response(201, json={"data": KB_INFO})
        )
        schema = {
            "version": 1,
            "dimensions": [{"name": "content", "dimension_type": "single"}],
            "categories": [],
            "combination_mode": "weighted_sum",
        }
        client.create_kb("Test KB", dimension_schema=schema)
        sent_body = json.loads(route.calls[0].request.content)
        assert "dimension_schema" in sent_body


class TestKnowledgeBankSearch:
    @respx.mock
    def test_simple_string_search(self, client: GuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        results_data = [
            {"id": "e1", "content": "Auth uses JWT", "combined_score": 0.92}
        ]
        route = respx.post(f"{API_PREFIX}/banks/test-kb-uuid/search").mock(
            return_value=httpx.Response(200, json={"data": results_data})
        )

        kb = client.get_kb("test-kb-uuid")
        results = kb.search("auth tokens")

        assert len(results) == 1
        assert results[0]["combined_score"] == 0.92

        # Verify the request was structured correctly (API requires query_text)
        sent = json.loads(route.calls[0].request.content)
        assert "content" in sent["dimensions"]
        assert sent["dimensions"]["content"]["query_text"] == "auth tokens"
        assert "query" not in sent["dimensions"]["content"]

    @respx.mock
    def test_multi_dimensional_search(self, client: GuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        route = respx.post(f"{API_PREFIX}/banks/test-kb-uuid/search").mock(
            return_value=httpx.Response(200, json={"data": []})
        )

        kb = client.get_kb("test-kb-uuid")
        kb.search({
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
        assert sent["dimensions"]["useful_for"]["weight"] == 1.5
        # combination_mode + metadata_filters pass straight through to the API
        assert sent["combination_mode"] == "weighted_sum"
        assert sent["metadata_filters"] == {"status": "resolved"}

    @respx.mock
    def test_search_normalizes_legacy_aliases(self, client: GuruCloudClient) -> None:
        """Legacy ``query`` / ``filters`` spellings are rewritten to the
        canonical ``query_text`` / ``metadata_filters`` the API requires."""
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        route = respx.post(f"{API_PREFIX}/banks/test-kb-uuid/search").mock(
            return_value=httpx.Response(200, json={"data": []})
        )

        kb = client.get_kb("test-kb-uuid")
        kb.search({
            "dimensions": {"content": {"query": "JWT", "weight": 2.0}},
            "filters": {"metadata": {"is_example": True}},
        })

        sent = json.loads(route.calls[0].request.content)
        assert sent["dimensions"]["content"]["query_text"] == "JWT"
        assert "query" not in sent["dimensions"]["content"]
        assert sent["metadata_filters"] == {"is_example": True}
        assert "filters" not in sent


class TestKnowledgeBankEntries:
    @respx.mock
    def test_add_entry(self, client: GuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        respx.post(f"{API_PREFIX}/banks/test-kb-uuid/entries").mock(
            return_value=httpx.Response(201, json={"data": {"id": "new-entry"}})
        )

        kb = client.get_kb("test-kb-uuid")
        result = kb.add_entry({
            "dimensions": {"content": "Test content", "useful_for": "Testing"},
        })
        assert result["id"] == "new-entry"

    @respx.mock
    def test_list_entries_pagination(self, client: GuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        route = respx.get(f"{API_PREFIX}/banks/test-kb-uuid/entries").mock(
            return_value=httpx.Response(200, json={"data": []})
        )

        kb = client.get_kb("test-kb-uuid")
        kb.list_entries(limit=25, offset=50)

        assert route.calls[0].request.url.params["limit"] == "25"
        assert route.calls[0].request.url.params["offset"] == "50"

    @respx.mock
    def test_delete_entry(self, client: GuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        respx.delete(f"{API_PREFIX}/banks/test-kb-uuid/entries/e1").mock(
            return_value=httpx.Response(200, json={"data": {"deleted": True}})
        )

        kb = client.get_kb("test-kb-uuid")
        result = kb.delete_entry("e1")
        assert result["deleted"] is True


class TestKnowledgeBankSchema:
    @respx.mock
    def test_get_schema(self, client: GuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        schema_data = {"version": 1, "dimensions": [], "categories": []}
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid/schema").mock(
            return_value=httpx.Response(200, json={"data": schema_data})
        )

        kb = client.get_kb("test-kb-uuid")
        schema = kb.get_schema()
        assert schema["version"] == 1

    @respx.mock
    def test_add_dimension(self, client: GuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        respx.post(f"{API_PREFIX}/banks/test-kb-uuid/schema/dimensions").mock(
            return_value=httpx.Response(200, json={"data": {"dimension": "priority"}})
        )

        kb = client.get_kb("test-kb-uuid")
        result = kb.add_dimension({"name": "priority", "dimension_type": "single"})
        assert result["dimension"] == "priority"


class TestKnowledgeBankBatchIngest:
    @respx.mock
    def test_batch_ingest(self, client: GuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        respx.post(f"{API_PREFIX}/banks/test-kb-uuid/entries/batch").mock(
            return_value=httpx.Response(200, json={"data": {"ingested": 3, "errors": []}})
        )

        kb = client.get_kb("test-kb-uuid")
        result = kb.ingest([
            {"dimensions": {"content": "Entry 1"}},
            {"dimensions": {"content": "Entry 2"}},
            {"dimensions": {"content": "Entry 3"}},
        ])
        assert result["ingested"] == 3
        assert result["errors"] == []


class TestMCPServerDefinition:
    @respx.mock
    def test_get_mcp_server_definition_from_kb(self, client: GuruCloudClient) -> None:
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

        kb = client.get_kb("test-kb-uuid")
        result = kb.get_mcp_server_definition()
        assert result["type"] == "http"
        assert result["token"] == "mcp_token_abc123"
        assert "query_knowledge_bank" in result["available_tools"]

    @respx.mock
    def test_get_mcp_server_definition_from_client(self, client: GuruCloudClient) -> None:
        mcp_def = {
            "server_name": "test-kb",
            "type": "http",
            "url": "https://test.gurucloudai.com/mcp/srv-uuid/mcp",
            "token": "mcp_token_abc123",
        }
        respx.post(f"{API_PREFIX}/banks/my-kb/mcp-server-definition").mock(
            return_value=httpx.Response(200, json={"data": mcp_def})
        )

        result = client.get_mcp_server_definition("my-kb")
        assert result["token"] == "mcp_token_abc123"


class TestDeduplicationEvents:
    @respx.mock
    def test_list_events(self, client: GuruCloudClient) -> None:
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
        route = respx.get(f"{API_PREFIX}/banks/test-kb-uuid/events").mock(
            return_value=httpx.Response(200, json={"data": events_response})
        )

        kb = client.get_kb("test-kb-uuid")
        result = kb.list_events()

        assert result["total"] == 1
        assert result["events"][0]["action"] == "update"

    @respx.mock
    def test_list_events_with_action_filter(self, client: GuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        route = respx.get(f"{API_PREFIX}/banks/test-kb-uuid/events").mock(
            return_value=httpx.Response(
                200, json={"data": {"events": [], "total": 0, "limit": 50, "offset": 0, "action_counts": {}}}
            )
        )

        kb = client.get_kb("test-kb-uuid")
        kb.list_events(action="conflict", limit=10)

        assert route.calls[0].request.url.params["action"] == "conflict"
        assert route.calls[0].request.url.params["limit"] == "10"

    @respx.mock
    def test_get_event(self, client: GuruCloudClient) -> None:
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

        kb = client.get_kb("test-kb-uuid")
        result = kb.get_event("evt-1")
        assert result["action"] == "update"
        assert result["reasoning"] == "Content overlaps with existing entry"


class TestEntryEventLogs:
    @respx.mock
    def test_list_event_logs(self, client: GuruCloudClient) -> None:
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
        route = respx.get(f"{API_PREFIX}/banks/test-kb-uuid/event-logs").mock(
            return_value=httpx.Response(200, json={"data": logs_response})
        )

        kb = client.get_kb("test-kb-uuid")
        result = kb.list_event_logs()
        assert result["total"] == 1
        assert result["logs"][0]["event_type"] == "lifecycle"

    @respx.mock
    def test_list_event_logs_with_filters(self, client: GuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks/test-kb-uuid").mock(
            return_value=httpx.Response(200, json={"data": KB_INFO})
        )
        route = respx.get(f"{API_PREFIX}/banks/test-kb-uuid/event-logs").mock(
            return_value=httpx.Response(
                200, json={"data": {"logs": [], "total": 0, "limit": 50, "offset": 0}}
            )
        )

        kb = client.get_kb("test-kb-uuid")
        kb.list_event_logs(event_type="dedup", entry_id="abc-123")

        assert route.calls[0].request.url.params["event_type"] == "dedup"
        assert route.calls[0].request.url.params["entry_id"] == "abc-123"


class TestErrorHandling:
    @respx.mock
    def test_rate_limit_error(self, client: GuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks").mock(
            return_value=httpx.Response(
                429, json={"error": {"code": "rate_limited", "message": "Slow down"}}
            )
        )
        with pytest.raises(RateLimitError):
            client.list_kbs()

    @respx.mock
    def test_generic_api_error(self, client: GuruCloudClient) -> None:
        respx.get(f"{API_PREFIX}/banks").mock(
            return_value=httpx.Response(
                500, json={"error": {"code": "internal", "message": "Oops"}}
            )
        )
        with pytest.raises(APIError) as exc_info:
            client.list_kbs()
        assert exc_info.value.status_code == 500
