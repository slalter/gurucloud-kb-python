"""Tests for client.credentials (sync + async)."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
import respx

from gurucloud_kb import APIError, AsyncGuruCloudClient, GuruCloudClient
from gurucloud_kb._credentials import build_credential_payload

BASE_URL = "https://test.gurucloudai.com"
API_PREFIX = f"{BASE_URL}/api/v1/kb"
API_KEY = "kb_test_key_abc123"

STORED = {
    "id": "c1", "owner_scope": "user:u1", "kb_id": None, "provider": "openai", "label": "prod", "base_url": None,
    "default_model": "gpt-5.4-mini", "key_fingerprint": "0123456789abcdef", "key_hint": "...wxyz",
    "created_at": "2026-09-28T13:00:00", "updated_at": "2026-09-28T13:00:00", "last_used_at": None,
}


class TestPayload:
    def test_only_given_fields_are_sent(self) -> None:
        assert build_credential_payload(" sk-abc ", base_url=None, default_model=None, label=None, kb=None) == {"api_key": "sk-abc"}
        full = build_credential_payload("sk-abc", base_url="https://x/openai/v1", default_model="gpt-5.5", label="l", kb="Games")
        assert full == {"api_key": "sk-abc", "base_url": "https://x/openai/v1", "default_model": "gpt-5.5", "label": "l", "kb": "Games"}

    def test_empty_key_rejected_client_side(self) -> None:
        with pytest.raises(ValueError, match="api_key"):
            build_credential_payload("  ", base_url=None, default_model=None, label=None, kb=None)


class TestSync:
    @respx.mock
    def test_set_list_delete_status(self) -> None:
        put = respx.put(f"{API_PREFIX}/credentials/openai").mock(return_value=httpx.Response(200, json={"data": STORED}))
        listing = respx.get(f"{API_PREFIX}/credentials").mock(
            return_value=httpx.Response(200, json={"data": [STORED], "meta": {"total": 1}}))
        delete = respx.delete(f"{API_PREFIX}/credentials/openai").mock(
            return_value=httpx.Response(200, json={"data": {"deleted": True, "provider": "openai", "kb_id": None}}))
        status = respx.get(f"{API_PREFIX}/credentials/status").mock(
            return_value=httpx.Response(200, json={"data": {"configured": True, "key_fingerprint": "abc"}}))
        with GuruCloudClient(api_key=API_KEY, base_url=BASE_URL) as client:
            info: Any = client.credentials.set("openai", "sk-live-secret-wxyz", default_model="gpt-5.4-mini", label="prod")
            rows: Any = client.credentials.list()
            gone: Any = client.credentials.delete("openai")
            st: Any = client.credentials.status()
        assert info["key_hint"] == "...wxyz" and "api_key" not in info
        assert json.loads(put.calls.last.request.content) == {"api_key": "sk-live-secret-wxyz", "default_model": "gpt-5.4-mini", "label": "prod"}
        assert rows == [STORED] and listing.calls.last.request.url.query == b""
        assert gone["deleted"] is True and delete.calls.last.request.url.query == b""
        assert st["configured"] is True and status.called

    @respx.mock
    def test_bank_scoped_calls_carry_kb(self) -> None:
        put = respx.put(f"{API_PREFIX}/credentials/azure_openai").mock(
            return_value=httpx.Response(200, json={"data": dict(STORED, provider="azure_openai", kb_id="kb-1")}))
        listing = respx.get(f"{API_PREFIX}/credentials").mock(return_value=httpx.Response(200, json={"data": []}))
        delete = respx.delete(f"{API_PREFIX}/credentials/azure_openai").mock(
            return_value=httpx.Response(200, json={"data": {"deleted": True}}))
        with GuruCloudClient(api_key=API_KEY, base_url=BASE_URL) as client:
            client.credentials.set("azure_openai", "az-secret-key-1234", base_url="https://dec.openai.azure.com/openai/v1",
                                   default_model="gpt-5.5", kb="Games")
            client.credentials.list(kb="Games")
            client.credentials.delete("azure_openai", kb="Games")
        sent = json.loads(put.calls.last.request.content)
        assert sent["kb"] == "Games" and sent["base_url"] == "https://dec.openai.azure.com/openai/v1"
        assert listing.calls.last.request.url.params["kb"] == "Games"
        assert delete.calls.last.request.url.params["kb"] == "Games"

    @respx.mock
    def test_unconfigured_store_surfaces_as_api_error(self) -> None:
        respx.put(f"{API_PREFIX}/credentials/openai").mock(return_value=httpx.Response(
            503, json={"error": {"code": "credential_store_unconfigured", "message": "set KB_CREDENTIALS_ENCRYPTION_KEY"}}))
        with GuruCloudClient(api_key=API_KEY, base_url=BASE_URL) as client:
            with pytest.raises(APIError) as exc:
                client.credentials.set("openai", "sk-live-secret-wxyz")
        assert exc.value.status_code == 503 and "KB_CREDENTIALS_ENCRYPTION_KEY" in str(exc.value)


class TestAsync:
    @respx.mock
    @pytest.mark.asyncio
    async def test_async_set_and_list(self) -> None:
        put = respx.put(f"{API_PREFIX}/credentials/openai").mock(return_value=httpx.Response(200, json={"data": STORED}))
        respx.get(f"{API_PREFIX}/credentials").mock(return_value=httpx.Response(200, json={"data": [STORED]}))
        async with AsyncGuruCloudClient(api_key=API_KEY, base_url=BASE_URL) as client:
            info: Any = await client.credentials.set("openai", "sk-live-secret-wxyz", kb="Games")
            rows: Any = await client.credentials.list(kb="Games")
        assert info["id"] == "c1" and rows[0]["provider"] == "openai"
        assert json.loads(put.calls.last.request.content)["kb"] == "Games"
