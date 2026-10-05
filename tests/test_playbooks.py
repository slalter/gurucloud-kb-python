"""Playbook methods on KnowledgeBank / AsyncKnowledgeBank (respx-mocked HTTP).

Pins the wire contract both clients emit (paths, query params, PUT body) and
the typed error raised on a 409 overlap.
"""
from __future__ import annotations

import json

import httpx
import pytest
import respx

from gurucloud_kb import (
    AsyncGuruCloudClient,
    GuruCloudClient,
    NotFoundError,
    PlaybookOverlapError,
)

BASE_URL = "https://test.gurucloudai.com"
API_PREFIX = f"{BASE_URL}/api/v1/kb"
API_KEY = "kb_test_key_abc123"
KB_INFO = {
    "kb_id": "kb-1",
    "name": "Test KB",
    "description": "d",
    "entry_count": 1,
    "total_queries": 0,
    "embedding_model": "text-embedding-3-small",
    "embedding_dimensions": 1536,
    "created_at": "2026-01-01T00:00:00",
    "last_accessed_at": None,
}
PLAYBOOK = {
    "id": "pid",
    "slug": "pm-sweep",
    "title": "PM sweep",
    "when_to_use": "hourly filing",
    "summary": "",
    "status": "active",
    "version": 2,
    "steps": [
        {"position": 1, "title": "one", "body": "b1", "kb_entry_id": None},
        {"position": 2, "title": "two", "body": "b2", "kb_entry_id": "e-2"},
    ],
    "linked_entries": [{"id": "e-2", "content": "fact", "useful_for": "u", "missing": False}],
}
OVERLAP = {
    "error": {
        "code": "playbook_overlap",
        "message": "'pm-sweep-2' overlaps 1 existing active playbook(s)",
        "details": {
            "error": "playbook_overlap",
            "slug": "pm-sweep-2",
            "threshold": 0.82,
            "candidates": [{"id": "pid", "slug": "pm-sweep", "title": "PM sweep", "when_to_use": "w", "similarity": 0.95}],
        },
    }
}


def _kb_route():
    respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))


@pytest.fixture
def kb():
    with respx.mock:
        _kb_route()
        yield GuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("kb-1")


class TestSyncPlaybooks:
    def test_list_ranked_sends_query_and_returns_rows(self, kb) -> None:
        route = respx.get(f"{API_PREFIX}/banks/kb-1/playbooks").mock(
            return_value=httpx.Response(200, json={"data": {"playbooks": [{"slug": "pm-sweep", "score": 0.8, "step_count": 2}], "total_active": 1, "query": "file cards"}})
        )
        out = kb.list_playbooks("file cards", status="all", limit=7, min_score=0.3)
        assert out["playbooks"][0]["slug"] == "pm-sweep" and out["total_active"] == 1
        params = dict(route.calls.last.request.url.params)
        assert params == {"status": "all", "limit": "7", "query": "file cards", "min_score": "0.3"}

    def test_list_defaults_omit_query_and_min_score(self, kb) -> None:
        route = respx.get(f"{API_PREFIX}/banks/kb-1/playbooks").mock(return_value=httpx.Response(200, json={"data": {"playbooks": [], "total_active": 0}}))
        kb.list_playbooks()
        assert dict(route.calls.last.request.url.params) == {"status": "active", "limit": "25"}

    def test_get_playbook_whole(self, kb) -> None:
        route = respx.get(f"{API_PREFIX}/banks/kb-1/playbooks/pm-sweep").mock(return_value=httpx.Response(200, json={"data": PLAYBOOK}))
        pb = kb.get_playbook("pm-sweep", include_linked_entries=False)
        assert [s["position"] for s in pb["steps"]] == [1, 2]
        assert dict(route.calls.last.request.url.params) == {"include_linked_entries": "false"}

    def test_get_playbook_not_found(self, kb) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1/playbooks/nope").mock(
            return_value=httpx.Response(404, json={"error": {"code": "playbook_not_found", "message": "No playbook"}})
        )
        with pytest.raises(NotFoundError) as exc:
            kb.get_playbook("nope")
        assert exc.value.code == "playbook_not_found"

    def test_upsert_body_and_force(self, kb) -> None:
        route = respx.put(f"{API_PREFIX}/banks/kb-1/playbooks/pm-sweep").mock(
            return_value=httpx.Response(200, json={"data": {"action": "created", "playbook": PLAYBOOK}})
        )
        out = kb.upsert_playbook(
            "pm-sweep",
            title="PM sweep",
            when_to_use="hourly filing of cards",
            steps=[{"title": "one", "body": "b1"}, {"title": "two", "body": "b2", "kb_entry_id": "e-2"}],
            supersedes_slug="old-sweep",
            metadata={"board": "x"},
            change_note="init",
            force=True,
        )
        assert out["action"] == "created"
        req = route.calls.last.request
        assert dict(req.url.params) == {"force": "true"}
        body = json.loads(req.content)
        assert body == {
            "title": "PM sweep",
            "when_to_use": "hourly filing of cards",
            "steps": [{"title": "one", "body": "b1"}, {"title": "two", "body": "b2", "kb_entry_id": "e-2"}],
            "summary": "",
            "change_note": "init",
            "metadata": {"board": "x"},
            "supersedes_slug": "old-sweep",
        }
        assert "status" not in body  # None -> omitted -> service keeps / defaults it

    def test_upsert_omits_status_and_metadata_when_none_and_sends_explicit_values(self, kb) -> None:
        """Preserve-on-absent on the wire: a step-only edit must not carry
        status='active' / metadata={} (that wiped metadata and published
        drafts server-side); explicit values — including {} — are sent."""
        route = respx.put(f"{API_PREFIX}/banks/kb-1/playbooks/pm-sweep").mock(
            return_value=httpx.Response(200, json={"data": {"action": "updated", "playbook": PLAYBOOK}})
        )
        kb.upsert_playbook("pm-sweep", title="PM sweep", when_to_use="hourly filing of cards", steps=[{"title": "a", "body": "b"}])
        body = json.loads(route.calls.last.request.content)
        assert "status" not in body and "metadata" not in body
        kb.upsert_playbook(
            "pm-sweep", title="PM sweep", when_to_use="hourly filing of cards", steps=[{"title": "a", "body": "b"}],
            status="draft", metadata={},
        )
        body = json.loads(route.calls.last.request.content)
        assert body["status"] == "draft" and body["metadata"] == {}

    def test_upsert_sends_metadata_merge_only_when_given(self, kb) -> None:
        route = respx.put(f"{API_PREFIX}/banks/kb-1/playbooks/pm-sweep").mock(
            return_value=httpx.Response(200, json={"data": {
                "action": "updated", "playbook": PLAYBOOK, "metadata_kept": [],
                "existing_overlaps": [{"slug": "gas", "title": "g", "similarity": 0.89, "prior_similarity": 0.89, "already_overlapping": True}],
            }})
        )
        out = kb.upsert_playbook(
            "pm-sweep", title="PM sweep", when_to_use="hourly filing of cards", steps=[{"title": "a", "body": "b"}],
            metadata_merge={"proposal": 195, "seeded_by": None},
        )
        body = json.loads(route.calls.last.request.content)
        assert body["metadata_merge"] == {"proposal": 195, "seeded_by": None} and "metadata" not in body
        assert out.get("existing_overlaps", [])[0].get("slug") == "gas"

    def test_delete_forwards_reason_and_changed_by(self, kb) -> None:
        route = respx.delete(f"{API_PREFIX}/banks/kb-1/playbooks/pm-sweep").mock(
            return_value=httpx.Response(200, json={"data": {"deleted": True, "slug": "pm-sweep", "tombstone_version": 4}})
        )
        out = kb.delete_playbook("pm-sweep", reason="duplicate of pm-hourly", changed_by="user:u1")
        assert out["tombstone_version"] == 4
        assert dict(route.calls.last.request.url.params) == {"reason": "duplicate of pm-hourly", "changed_by": "user:u1"}
        kb.delete_playbook("pm-sweep")
        assert dict(route.calls.last.request.url.params) == {}

    def test_upsert_overlap_raises_typed_error(self, kb) -> None:
        respx.put(f"{API_PREFIX}/banks/kb-1/playbooks/pm-sweep-2").mock(return_value=httpx.Response(409, json=OVERLAP))
        with pytest.raises(PlaybookOverlapError) as exc:
            kb.upsert_playbook("pm-sweep-2", title="t", when_to_use="hourly filing", steps=[{"title": "a", "body": "b"}])
        err = exc.value
        assert err.status_code == 409 and err.code == "playbook_overlap"
        assert err.slug == "pm-sweep-2" and err.threshold == 0.82
        assert err.candidates[0]["slug"] == "pm-sweep" and err.candidates[0]["similarity"] == 0.95

    def test_delete_versions_stats(self, kb) -> None:
        respx.delete(f"{API_PREFIX}/banks/kb-1/playbooks/pm-sweep").mock(return_value=httpx.Response(200, json={"data": {"deleted": True, "slug": "pm-sweep"}}))
        respx.get(f"{API_PREFIX}/banks/kb-1/playbooks/pm-sweep/versions").mock(
            return_value=httpx.Response(200, json={"data": [{"version": 2, "snapshot": {}}, {"version": 1, "snapshot": {}}]})
        )
        respx.get(f"{API_PREFIX}/banks/kb-1/playbook-stats").mock(return_value=httpx.Response(200, json={"data": {"active": 1, "draft": 0, "superseded": 2}}))
        assert kb.delete_playbook("pm-sweep")["deleted"] is True
        assert [v["version"] for v in kb.list_playbook_versions("pm-sweep")] == [2, 1]
        assert kb.get_playbook_stats()["superseded"] == 2


class TestAsyncPlaybooks:
    @pytest.mark.asyncio
    async def test_async_mirror(self) -> None:
        async with respx.mock:
            _kb_route()
            list_route = respx.get(f"{API_PREFIX}/banks/kb-1/playbooks").mock(
                return_value=httpx.Response(200, json={"data": {"playbooks": [{"slug": "pm-sweep"}], "total_active": 1}})
            )
            respx.get(f"{API_PREFIX}/banks/kb-1/playbooks/pm-sweep").mock(return_value=httpx.Response(200, json={"data": PLAYBOOK}))
            put_route = respx.put(f"{API_PREFIX}/banks/kb-1/playbooks/pm-sweep").mock(
                return_value=httpx.Response(200, json={"data": {"action": "updated", "playbook": PLAYBOOK}})
            )
            respx.put(f"{API_PREFIX}/banks/kb-1/playbooks/dup").mock(return_value=httpx.Response(409, json=OVERLAP))
            async with AsyncGuruCloudClient(api_key=API_KEY, base_url=BASE_URL) as client:
                kb = await client.get_kb("kb-1")
                out = await kb.list_playbooks("file cards")
                assert (out.get("playbooks") or [])[0].get("slug") == "pm-sweep"
                assert dict(list_route.calls.last.request.url.params) == {"status": "active", "limit": "25", "query": "file cards"}
                pb = await kb.get_playbook("pm-sweep")
                assert len(pb.get("steps") or []) == 2
                res = await kb.upsert_playbook("pm-sweep", title="PM sweep", when_to_use="hourly filing of cards", steps=[{"title": "a", "body": "b"}])
                assert res.get("action") == "updated"
                put_body = json.loads(put_route.calls.last.request.content)
                assert put_body["steps"] == [{"title": "a", "body": "b"}]
                assert "status" not in put_body and "metadata" not in put_body and "metadata_merge" not in put_body
                assert dict(put_route.calls.last.request.url.params) == {"force": "false"}
                await kb.upsert_playbook("pm-sweep", title="PM sweep", when_to_use="hourly filing of cards", steps=[{"title": "a", "body": "b"}], metadata_merge={"n": 1})
                assert json.loads(put_route.calls.last.request.content)["metadata_merge"] == {"n": 1}
                del_route = respx.delete(f"{API_PREFIX}/banks/kb-1/playbooks/pm-sweep").mock(
                    return_value=httpx.Response(200, json={"data": {"deleted": True, "slug": "pm-sweep", "tombstone_version": 3}})
                )
                assert (await kb.delete_playbook("pm-sweep", reason="duplicate of pm-hourly"))["tombstone_version"] == 3
                assert dict(del_route.calls.last.request.url.params) == {"reason": "duplicate of pm-hourly"}
                with pytest.raises(PlaybookOverlapError) as exc:
                    await kb.upsert_playbook("dup", title="t", when_to_use="hourly filing", steps=[{"title": "a", "body": "b"}])
                assert exc.value.candidates[0]["slug"] == "pm-sweep"


PROCESS = {
    **PLAYBOOK,
    "slug": "product-return-processing",
    "title": "How a product return moves through ChemMasters",
    "when_to_use": "A sales rep asks for product back; the return runs from CS entry to disposition",
    "genre": "process",
    "steps": [
        {"position": 1, "title": "Rep asks for the return", "body": "The rep brings it to CS", "kb_entry_id": None,
         "process": {"actor": "sales rep", "hands_to": "customer service"}},
        {"position": 2, "title": "CS logs it", "body": "R-number from the purple book, then Sage", "kb_entry_id": "e-2",
         "process": {"actor": "Emily Adams (customer service)", "system": "purple book, Sage", "hands_to": "warehouse"}},
    ],
}


class TestProcessGenre:
    """genre (procedure | process) on the wire, and a process step's detail round trip."""

    def test_list_and_stats_pass_genre_only_when_given(self, kb) -> None:
        list_route = respx.get(f"{API_PREFIX}/banks/kb-1/playbooks").mock(
            return_value=httpx.Response(200, json={"data": {"playbooks": [PROCESS], "total_active": 1}})
        )
        stats_route = respx.get(f"{API_PREFIX}/banks/kb-1/playbook-stats").mock(
            return_value=httpx.Response(200, json={"data": {"active": 1, "draft": 0, "superseded": 0}})
        )
        out = kb.list_playbooks(genre="process")
        assert dict(list_route.calls.last.request.url.params) == {"status": "active", "limit": "25", "genre": "process"}
        assert out["playbooks"][0]["genre"] == "process"
        kb.list_playbooks()
        assert "genre" not in dict(list_route.calls.last.request.url.params)
        kb.get_playbook_stats(genre="procedure")
        assert dict(stats_route.calls.last.request.url.params) == {"genre": "procedure"}
        kb.get_playbook_stats()
        assert dict(stats_route.calls.last.request.url.params) == {}

    def test_upsert_process_sends_genre_and_step_detail(self, kb) -> None:
        route = respx.put(f"{API_PREFIX}/banks/kb-1/playbooks/product-return-processing").mock(
            return_value=httpx.Response(200, json={"data": {"action": "created", "playbook": PROCESS}})
        )
        steps = [
            {"title": "Rep asks for the return", "body": "The rep brings it to CS", "process": {"actor": "sales rep", "hands_to": "customer service"}},
            {"title": "CS logs it", "body": "R-number, then Sage", "kb_entry_id": "e-2", "process": {"actor": "Emily Adams (customer service)", "system": "purple book, Sage"}},
        ]
        out = kb.upsert_playbook(
            "product-return-processing", title=PROCESS["title"], when_to_use=PROCESS["when_to_use"], steps=steps, genre="process",
        )
        body = json.loads(route.calls.last.request.content)
        assert body["genre"] == "process"
        assert body["steps"] == steps  # the process detail travels inside each step, untouched
        assert out["playbook"]["genre"] == "process"
        assert out["playbook"]["steps"][1]["process"]["actor"] == "Emily Adams (customer service)"

    def test_upsert_without_genre_keeps_the_old_wire_shape(self, kb) -> None:
        route = respx.put(f"{API_PREFIX}/banks/kb-1/playbooks/pm-sweep").mock(
            return_value=httpx.Response(200, json={"data": {"action": "updated", "playbook": PLAYBOOK}})
        )
        kb.upsert_playbook("pm-sweep", title="PM sweep", when_to_use="hourly filing of cards", steps=[{"title": "a", "body": "b"}])
        assert "genre" not in json.loads(route.calls.last.request.content)

    @pytest.mark.asyncio
    async def test_async_mirror_passes_genre(self) -> None:
        async with respx.mock:
            _kb_route()
            list_route = respx.get(f"{API_PREFIX}/banks/kb-1/playbooks").mock(
                return_value=httpx.Response(200, json={"data": {"playbooks": [PROCESS], "total_active": 1}})
            )
            stats_route = respx.get(f"{API_PREFIX}/banks/kb-1/playbook-stats").mock(
                return_value=httpx.Response(200, json={"data": {"active": 1, "draft": 0, "superseded": 0}})
            )
            put_route = respx.put(f"{API_PREFIX}/banks/kb-1/playbooks/product-return-processing").mock(
                return_value=httpx.Response(200, json={"data": {"action": "created", "playbook": PROCESS}})
            )
            async with AsyncGuruCloudClient(api_key=API_KEY, base_url=BASE_URL) as client:
                kb = await client.get_kb("kb-1")
                await kb.list_playbooks("returns", genre="process")
                assert dict(list_route.calls.last.request.url.params)["genre"] == "process"
                await kb.get_playbook_stats(genre="process")
                assert dict(stats_route.calls.last.request.url.params) == {"genre": "process"}
                res = await kb.upsert_playbook(
                    "product-return-processing", title="t", when_to_use="a flow and its trigger",
                    steps=[{"title": "a", "body": "b", "process": {"actor": "CS"}}], genre="process",
                )
                assert json.loads(put_route.calls.last.request.content)["genre"] == "process"
                assert (res.get("playbook") or {}).get("genre") == "process"
