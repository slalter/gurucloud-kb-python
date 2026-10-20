"""kb.similar_pairs / kb.judge_pairs (sync + async) and their request helpers,
gurucloud-kb 0.7.0 beta (kanban 11af8632)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import httpx
import pytest
import respx

from gurucloud_kb import AsyncGuruCloudClient, GuruCloudClient
from gurucloud_kb._search import normalize_pair_scope, pair_refs

BASE_URL = "https://test.gurucloudai.com"
API_PREFIX = f"{BASE_URL}/api/v1/kb"
API_KEY = "kb_test_key_abc123"
KB_INFO = {"kb_id": "kb-1", "name": "Games", "description": "", "entry_count": 1, "total_queries": 0}
PAIRS = {"kb_id": "kb-1", "field": "content", "threshold": 0.9,
         "pairs": [{"a": {"id": "a", "content": "x"}, "b": {"id": "b", "content": "y"}, "similarity": 0.97}],
         "stats": {"entries_scanned": 10, "neighbors": 3, "pairs_above_threshold": 1, "truncated": False, "duration_ms": 12.0}}
JUDGED = {"status": "judged", "judgements": [{"a_id": "a", "b_id": "b", "verdict": "duplicate", "confidence": 0.9, "reason": "same", "suggested_action": "merge"}],
          "model": "gpt-test", "credential_source": "owner", "duration_ms": 900.0, "input_tokens": 10, "output_tokens": 5, "error": None, "judgement_id": "j1"}


class TestHelpers:
    def test_pair_refs_accepts_tuples_and_dicts(self) -> None:
        assert pair_refs([("a", "b"), {"a_id": "c", "b_id": "d"}]) == [{"a_id": "a", "b_id": "b"}, {"a_id": "c", "b_id": "d"}]

    def test_pair_refs_rejects_empty_and_incomplete(self) -> None:
        with pytest.raises(ValueError, match="must not be empty"):
            pair_refs([])
        with pytest.raises(ValueError, match="two entry ids"):
            pair_refs([("a", "")])

    def test_scope_serializes_time_bounds(self) -> None:
        since = datetime(2026, 10, 1, tzinfo=timezone.utc)
        assert normalize_pair_scope({"metadata_filters": {"kind": "rule"}, "created_after": since, "source": None}) == {
            "metadata_filters": {"kind": "rule"}, "created_after": since.isoformat()}


class TestSync:
    @respx.mock
    def test_similar_pairs_body(self) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
        route = respx.post(f"{API_PREFIX}/banks/kb-1/similar-pairs").mock(return_value=httpx.Response(200, json={"data": PAIRS}))
        kb = GuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("kb-1")
        out: Any = kb.similar_pairs(threshold=0.9, limit=50, max_entries=500, field="content", scope={"source": "api"})
        assert out["pairs"][0]["similarity"] == 0.97
        body = json.loads(route.calls[0].request.content)
        assert body == {"threshold": 0.9, "neighbors": 3, "limit": 50, "max_entries": 500, "field": "content", "scope": {"source": "api"}}

    @respx.mock
    def test_similar_pairs_defaults_omit_field_and_scope(self) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
        route = respx.post(f"{API_PREFIX}/banks/kb-1/similar-pairs").mock(return_value=httpx.Response(200, json={"data": PAIRS}))
        GuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("kb-1").similar_pairs()
        assert json.loads(route.calls[0].request.content) == {"threshold": 0.85, "neighbors": 3, "limit": 100, "max_entries": 2000}

    @respx.mock
    def test_judge_pairs_body_and_result(self) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
        route = respx.post(f"{API_PREFIX}/banks/kb-1/similar-pairs/judge").mock(return_value=httpx.Response(200, json={"data": JUDGED}))
        out: Any = GuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("kb-1").judge_pairs([("a", "b")], speed="thorough", context="ctx")
        assert out["status"] == "judged" and out["judgements"][0]["verdict"] == "duplicate"
        assert json.loads(route.calls[0].request.content) == {"pairs": [{"a_id": "a", "b_id": "b"}], "speed": "thorough", "context": "ctx"}


class TestAsync:
    @pytest.mark.asyncio
    @respx.mock
    async def test_async_pair_of_calls(self) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
        pairs = respx.post(f"{API_PREFIX}/banks/kb-1/similar-pairs").mock(return_value=httpx.Response(200, json={"data": PAIRS}))
        judge = respx.post(f"{API_PREFIX}/banks/kb-1/similar-pairs/judge").mock(return_value=httpx.Response(200, json={"data": JUDGED}))
        kb = await AsyncGuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("kb-1")
        found: Any = await kb.similar_pairs(threshold=0.95)
        verdicts: Any = await kb.judge_pairs([(p["a"]["id"], p["b"]["id"]) for p in found["pairs"]])
        assert json.loads(pairs.calls[0].request.content)["threshold"] == 0.95
        assert json.loads(judge.calls[0].request.content) == {"pairs": [{"a_id": "a", "b_id": "b"}]}
        assert verdicts["judgement_id"] == "j1"


class TestApply:
    @respx.mock
    def test_apply_pair_proposal_body_and_propose_flag(self) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
        judge = respx.post(f"{API_PREFIX}/banks/kb-1/similar-pairs/judge").mock(return_value=httpx.Response(200, json={"data": JUDGED}))
        apply = respx.post(f"{API_PREFIX}/banks/kb-1/similar-pairs/apply").mock(
            return_value=httpx.Response(200, json={"data": {"status": "applied", "kind": "merge", "changes": [{"entry_id": "a", "action": "update", "status": "applied"}], "application_id": "app-1"}})
        )
        kb = GuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("kb-1")
        kb.judge_pairs([("a", "b")], propose=False)
        assert json.loads(judge.calls[0].request.content)["propose"] is False
        proposal = {"kind": "merge", "rationale": "same", "changes": [{"entry_id": "a", "action": "update", "content": "union"}, {"entry_id": "b", "action": "delete"}]}
        out: Any = kb.apply_pair_proposal("j1", "a", "b", proposal, reason="confirmed", approved_by="me")
        assert out["status"] == "applied" and out["application_id"] == "app-1"
        assert json.loads(apply.calls[0].request.content) == {"judgement_id": "j1", "a_id": "a", "b_id": "b", "proposal": proposal, "reason": "confirmed", "approved_by": "me"}

    @pytest.mark.asyncio
    @respx.mock
    async def test_async_apply(self) -> None:
        respx.get(f"{API_PREFIX}/banks/kb-1").mock(return_value=httpx.Response(200, json={"data": KB_INFO}))
        apply = respx.post(f"{API_PREFIX}/banks/kb-1/similar-pairs/apply").mock(return_value=httpx.Response(200, json={"data": {"status": "nothing_to_apply", "kind": "keep_separate", "changes": []}}))
        kb = await AsyncGuruCloudClient(api_key=API_KEY, base_url=BASE_URL).get_kb("kb-1")
        out: Any = await kb.apply_pair_proposal("j1", "a", "b", {"kind": "keep_separate", "rationale": "r", "changes": []})
        assert out["status"] == "nothing_to_apply" and "reason" not in json.loads(apply.calls[0].request.content)
