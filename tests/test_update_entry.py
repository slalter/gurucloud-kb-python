"""``update_entry``: typed kwargs map to the server's fields; unknown keys are
refused client-side (they used to be silently ignored by the server, which
still answered success)."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
import respx

from gurucloud_kb import AsyncGuruCloudClient, GuruCloudClient, APIError
from gurucloud_kb._entries import UPDATE_ENTRY_FIELDS, build_entry_update

BASE_URL = "https://test.gurucloudai.com"
API_PREFIX = f"{BASE_URL}/api/v1/kb"
ENTRY_URL = f"{API_PREFIX}/banks/kb-1/entries/e1"
KB_INFO = {"kb_id": "kb-1", "name": "Signals", "entry_count": 1, "total_queries": 0}


def _sent(route: respx.Route) -> dict[str, Any]:
    return json.loads(route.calls.last.request.content)


def _mock_bank() -> None:
    respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))


class TestBuildEntryUpdate:
    def test_kwargs_map_to_the_server_fields(self) -> None:
        body = build_entry_update(
            content="c", useful_for="u", metadata={"status": "dismissed"},
            systems=["gateway"], tasks=["triage"],
            add_systems=["a"], remove_systems=["b"], add_tasks=["c"], remove_tasks=["d"],
        )
        assert body == {
            "update_content": "c",
            "update_useful_for": "u",
            "update_metadata": {"status": "dismissed"},
            "replace_systems": ["gateway"],
            "replace_tasks": ["triage"],
            "add_systems": ["a"],
            "remove_systems": ["b"],
            "add_tasks": ["c"],
            "remove_tasks": ["d"],
        }
        assert set(body) == set(UPDATE_ENTRY_FIELDS)

    def test_raw_updates_with_server_keys_pass_through(self) -> None:
        assert build_entry_update({"update_content": "x", "replace_tasks": ["t"]}) == {
            "update_content": "x", "replace_tasks": ["t"],
        }

    def test_raw_updates_and_kwargs_combine(self) -> None:
        assert build_entry_update({"update_content": "x"}, metadata={"k": 1}) == {
            "update_content": "x", "update_metadata": {"k": 1},
        }

    @pytest.mark.parametrize("updates", [
        {"dimensions": {"observation": "x"}},
        {"metadata": {"status": "dismissed"}},
        {"observation": "x"},
        {"replace_relevant_systems": ["a"]},
    ])
    def test_unknown_key_raises_naming_it_and_the_allowed_fields(self, updates: dict[str, Any]) -> None:
        with pytest.raises(ValueError, match="Unknown field\\(s\\) for an entry update") as excinfo:
            build_entry_update(updates)
        assert next(iter(updates)) in str(excinfo.value)
        assert "Allowed fields: update_content, update_useful_for" in str(excinfo.value)

    def test_field_given_both_ways_raises(self) -> None:
        with pytest.raises(ValueError, match="both set the same field"):
            build_entry_update({"update_content": "a"}, content="b")

    def test_nothing_to_update_raises(self) -> None:
        with pytest.raises(ValueError, match="Nothing to update"):
            build_entry_update()
        with pytest.raises(ValueError, match="Nothing to update"):
            build_entry_update({})

    def test_non_mapping_updates_raises(self) -> None:
        with pytest.raises(ValueError, match="must be a mapping"):
            build_entry_update(["update_content"])  # type: ignore[arg-type]

    def test_metadata_is_copied_not_aliased(self) -> None:
        meta = {"k": 1}
        body = build_entry_update(metadata=meta)
        copied = body.get("update_metadata")
        assert isinstance(copied, dict) and copied == {"k": 1} and copied is not meta
        copied["k"] = 2
        assert meta == {"k": 1}


class TestSyncUpdateEntry:
    @respx.mock
    def test_sends_the_mapped_body(self) -> None:
        route = respx.patch(ENTRY_URL).mock(return_value=httpx.Response(200, json={"data": {"success": True}}))
        _mock_bank()
        with GuruCloudClient(api_key="kb_test", base_url=BASE_URL) as client:
            result = client.get_kb("kb-1").update_entry("e1", content="new", metadata={"status": "dismissed"})
        assert result == {"success": True}
        assert _sent(route) == {"update_content": "new", "update_metadata": {"status": "dismissed"}}

    @respx.mock
    def test_unknown_key_never_reaches_the_wire(self) -> None:
        route = respx.patch(ENTRY_URL).mock(return_value=httpx.Response(200, json={"data": {"success": True}}))
        _mock_bank()
        with GuruCloudClient(api_key="kb_test", base_url=BASE_URL) as client:
            with pytest.raises(ValueError, match="dimensions"):
                client.get_kb("kb-1").update_entry("e1", {"dimensions": {"observation": "x"}})
        assert not route.called

    @respx.mock
    def test_server_rejection_surfaces_as_api_error_with_the_message(self) -> None:
        respx.patch(ENTRY_URL).mock(return_value=httpx.Response(400, json={
            "error": {"code": "unknown_field", "message": "Unknown field(s) for an entry update: metadata. Allowed fields: ..."},
        }))
        _mock_bank()
        with GuruCloudClient(api_key="kb_test", base_url=BASE_URL) as client:
            with pytest.raises(APIError) as excinfo:
                # A legal body on the client; an older/newer server may still disagree.
                client.get_kb("kb-1").update_entry("e1", {"update_metadata": {"k": 1}})
        assert excinfo.value.status_code == 400 and excinfo.value.code == "unknown_field"
        assert "Unknown field(s)" in excinfo.value.message


class TestAsyncUpdateEntry:
    @respx.mock
    @pytest.mark.asyncio
    async def test_sends_the_mapped_body(self) -> None:
        route = respx.patch(ENTRY_URL).mock(return_value=httpx.Response(200, json={"data": {"success": True}}))
        _mock_bank()
        async with AsyncGuruCloudClient(api_key="kb_test", base_url=BASE_URL) as client:
            result = await (await client.get_kb("kb-1")).update_entry("e1", systems=["gateway"], remove_tasks=["old"])
        assert result == {"success": True}
        assert _sent(route) == {"replace_systems": ["gateway"], "remove_tasks": ["old"]}

    @respx.mock
    @pytest.mark.asyncio
    async def test_unknown_key_never_reaches_the_wire(self) -> None:
        route = respx.patch(ENTRY_URL).mock(return_value=httpx.Response(200, json={"data": {"success": True}}))
        _mock_bank()
        async with AsyncGuruCloudClient(api_key="kb_test", base_url=BASE_URL) as client:
            with pytest.raises(ValueError, match="metadata"):
                await (await client.get_kb("kb-1")).update_entry("e1", {"metadata": {"status": "x"}})
        assert not route.called
