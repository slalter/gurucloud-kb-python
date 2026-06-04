"""Build & normalize Knowledge Bank search request bodies.

Centralizes the search wire contract so the sync (:mod:`gurucloud_kb.kb`)
and async (:mod:`gurucloud_kb.async_kb`) ``search()`` methods stay in
lock-step.

The KB search endpoint expects each dimension as
``{"query_text": ..., "weight": ...}`` and exact filters under
``metadata_filters``. For ergonomics (and to stay compatible with older
example code) these helpers also accept the friendlier spellings ``query``
(per dimension) and ``filters`` (top level) and rewrite them to the
canonical names before they go on the wire.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def build_string_search(query: str, k: int, threshold: float) -> dict[str, Any]:
    """Build a request body for a simple single-string query.

    Searches the ``content`` dimension, which is present in every default
    Knowledge Bank.
    """
    return {
        "dimensions": {"content": {"query_text": query, "weight": 1.0}},
        "k": k,
        "threshold": threshold,
    }


def normalize_search_request(request: Mapping[str, Any]) -> dict[str, Any]:
    """Return a copy of ``request`` in the exact shape the API expects.

    Rewrites convenience/legacy spellings:

    - a bare string for a dimension -> ``{"query_text": <str>}``
    - a per-dimension ``query`` key  -> ``query_text``
    - a top-level ``filters`` key (including the legacy nested
      ``{"metadata": {...}}`` form) -> ``metadata_filters``

    Anything already using the canonical names is passed through untouched.
    """
    req: dict[str, Any] = dict(request)

    dims = req.get("dimensions")
    if isinstance(dims, Mapping):
        normalized: dict[str, Any] = {}
        for name, cfg in dims.items():
            if isinstance(cfg, str):
                normalized[name] = {"query_text": cfg}
            elif isinstance(cfg, Mapping):
                cfg_copy: dict[str, Any] = dict(cfg)
                if "query" in cfg_copy and "query_text" not in cfg_copy:
                    cfg_copy["query_text"] = cfg_copy.pop("query")
                normalized[name] = cfg_copy
            else:
                normalized[name] = cfg
        req["dimensions"] = normalized

    if "filters" in req:
        legacy = req.pop("filters")
        # Canonical metadata_filters always wins; a stray legacy "filters"
        # key is dropped so it never reaches the wire (the API ignores it).
        if "metadata_filters" not in req:
            if (
                isinstance(legacy, Mapping)
                and list(legacy.keys()) == ["metadata"]
                and isinstance(legacy["metadata"], Mapping)
            ):
                req["metadata_filters"] = dict(legacy["metadata"])
            elif isinstance(legacy, Mapping):
                req["metadata_filters"] = dict(legacy)

    return req
