"""Unit tests for gurucloud_kb._search request builders/normalizers."""

from __future__ import annotations

from gurucloud_kb._search import build_string_search, normalize_search_request


def test_build_string_search_uses_query_text() -> None:
    req = build_string_search("auth tokens", k=7, threshold=0.4)
    assert req["dimensions"]["content"]["query_text"] == "auth tokens"
    assert req["dimensions"]["content"]["weight"] == 1.0
    assert req["k"] == 7
    assert req["threshold"] == 0.4


def test_normalize_rewrites_per_dimension_query_alias() -> None:
    out = normalize_search_request(
        {"dimensions": {"content": {"query": "JWT", "weight": 2.0}}}
    )
    assert out["dimensions"]["content"]["query_text"] == "JWT"
    assert out["dimensions"]["content"]["weight"] == 2.0
    assert "query" not in out["dimensions"]["content"]


def test_normalize_accepts_bare_string_dimension() -> None:
    out = normalize_search_request({"dimensions": {"content": "hello"}})
    assert out["dimensions"]["content"] == {"query_text": "hello"}


def test_normalize_keeps_canonical_query_text_and_extras() -> None:
    out = normalize_search_request(
        {"dimensions": {"content": {"query_text": "x", "aggregation": "max"}}}
    )
    assert out["dimensions"]["content"]["query_text"] == "x"
    assert out["dimensions"]["content"]["aggregation"] == "max"


def test_normalize_nested_filters_to_metadata_filters() -> None:
    out = normalize_search_request(
        {
            "dimensions": {"content": {"query_text": "x"}},
            "filters": {"metadata": {"is_example": True}},
        }
    )
    assert out["metadata_filters"] == {"is_example": True}
    assert "filters" not in out


def test_normalize_flat_filters_to_metadata_filters() -> None:
    out = normalize_search_request(
        {
            "dimensions": {"content": {"query_text": "x"}},
            "filters": {"status": "resolved"},
        }
    )
    assert out["metadata_filters"] == {"status": "resolved"}
    assert "filters" not in out


def test_normalize_prefers_explicit_metadata_filters() -> None:
    out = normalize_search_request(
        {
            "dimensions": {"content": {"query_text": "x"}},
            "metadata_filters": {"a": 1},
            "filters": {"b": 2},
        }
    )
    assert out["metadata_filters"] == {"a": 1}
    assert "filters" not in out


def test_normalize_does_not_mutate_input() -> None:
    original = {"dimensions": {"content": {"query": "x"}}, "filters": {"a": 1}}
    normalize_search_request(original)
    assert original == {"dimensions": {"content": {"query": "x"}}, "filters": {"a": 1}}
