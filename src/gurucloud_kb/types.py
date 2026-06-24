"""Type definitions for the GuruCloud KB SDK.

All types use TypedDict for zero-dependency, static-typing-friendly contracts.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, TypedDict


# ── Enumerated value types (self-documenting) ───────────────────


DimensionType = Literal["single", "multi", "text_only"]
"""How a dimension is stored and searched.

- ``"single"``    — one embedding per entry (e.g. ``content``, ``useful_for``).
- ``"multi"``     — many values per entry, each embedded, aggregated at search
  time (e.g. ``relevant_systems = ["flask", "jwt"]``). Matches ANY value.
- ``"text_only"`` — stored (in entry metadata) but NOT embedded; used for
  non-semantic **exact-match** filtering of IDs / tags / enums. Supplying a
  ``text_only`` dimension in a search applies an exact-match filter
  (equivalent to a ``metadata_filters`` entry) rather than semantic ranking,
  so it never contributes to the score. A search must therefore include at
  least one ``single``/``multi`` dimension as well; a search of only
  ``text_only`` dimensions is rejected. Set ``searchable=False`` to store the
  value without exposing it as a search filter.
"""

Aggregation = Literal["max", "avg", "min", "top_k_avg", "sum", "count"]
"""How multiple matches inside one MULTI dimension collapse to a single
dimension score. ``"top_k_avg"`` averages the best ``top_k`` matches."""

CombinationMode = Literal[
    "weighted_sum", "weighted_product", "max", "min", "custom"
]
"""How per-dimension scores combine into the final ranking score.
``"custom"`` requires a ``custom_formula`` SQL expression that references
each dimension's score as ``<dimension_name>_score``."""


# ── Knowledge Bank ──────────────────────────────────────────────


class _KBInfoBase(TypedDict):
    """Fields always present on a Knowledge Bank."""

    kb_id: str


class KBInfo(_KBInfoBase, total=False):
    """Knowledge Bank metadata returned by the API."""

    name: str
    description: str
    entry_count: int
    total_queries: int
    embedding_model: str
    embedding_dimensions: int
    created_at: str | None
    last_accessed_at: str | None
    is_active: bool
    mcp_url: str
    mcp_config: dict[str, Any]
    explore_url: str


# ── Dimension Schema ────────────────────────────────────────────


class DimensionConfig(TypedDict, total=False):
    """Configuration for a single search dimension."""

    name: str
    display_name: str
    description: str
    dimension_type: DimensionType
    required: bool
    default_weight: float
    aggregation: Aggregation
    top_k: int
    max_items: int
    searchable: bool
    show_in_results: bool
    """DEPRECATED / not enforced. This per-dimension flag does NOT control what
    the MCP tools (``query_knowledge_bank``, ``narrate``) return — nothing reads
    it. Choose the returned keys per-KB with :attr:`DimensionSchema.mcp_response_fields`
    (``id`` + ``content`` are always returned). Kept only for backward
    compatibility of stored schemas."""


class CategoryConfig(TypedDict, total=False):
    """Configuration for a category (e.g. examples, gotchas)."""

    tag: str
    display_name: str
    description: str
    default_count: int
    requires_proof: bool
    proof_field: str
    context_field: str


class DimensionSchema(TypedDict, total=False):
    """Full dimension schema for a Knowledge Bank."""

    version: int
    dimensions: list[DimensionConfig]
    categories: list[CategoryConfig]
    combination_mode: CombinationMode
    allow_updates: bool
    """Dedup policy. When ``False`` the KB never UPDATE/CONFLICT-merges — the
    dedup verdict is downgraded to ``new`` so the KB only accumulates (true
    duplicates are still skipped via ``redundant``). Defaults to ``True``."""
    mcp_response_fields: list[str]
    """Per-KB allowlist of EXTRA keys the MCP tools (``query_knowledge_bank``,
    ``narrate``) return on each result, beyond the always-present ``id`` +
    ``content``. ``None``/empty (the default) returns ``id`` + ``content`` only.
    Allowed values: the standard result fields (``useful_for``,
    ``relevant_systems``, ``relevant_tasks``, ``relevant_file_paths``,
    ``source``, ``metadata``, ``combined_score``, ``created_at``,
    ``updated_at``) plus the KB's own dimension names. Only affects the MCP
    response shape; the REST API and stored data are unchanged."""


class SchemaWarning(TypedDict, total=False):
    """Warning returned by schema validation."""

    code: str
    level: str  # "info" | "warning" | "error"
    message: str
    suggestion: str
    affected_dimensions: list[str]


# ── Entries ─────────────────────────────────────────────────────


class EntryInput(TypedDict, total=False):
    """Input for adding a KB entry."""

    dimensions: dict[str, str | list[str]]
    metadata: dict[str, Any]
    source: str
    relevant_file_paths: list[str]


class EntryResult(TypedDict, total=False):
    """A KB entry returned by the API."""

    id: str
    content: str
    useful_for: str
    relevant_systems: list[str]
    relevant_tasks: list[str]
    relevant_file_paths: list[str]
    metadata: dict[str, Any]
    source: str
    combined_score: float
    created_at: str
    updated_at: str


# Search results have the same shape as entries (with scores populated)
SearchResult = EntryResult


# ── Search ──────────────────────────────────────────────────────


class DimensionQuery(TypedDict, total=False):
    """Query parameters for a single search dimension.

    ``query_text`` is the text embedded and compared (cosine) against this
    dimension's vectors — this is the field the API requires, **not**
    ``query``. ``weight`` scales this dimension's contribution to the
    combined score (falls back to the dimension's schema weight when
    omitted). The remaining fields override the dimension's defaults for
    this one query.
    """

    query_text: str
    weight: float
    aggregation: Aggregation
    top_k: int
    min_threshold: float


class CategoryFilter(TypedDict, total=False):
    """Bucket results by a metadata tag, each with its own cap/threshold."""

    tag: str
    max_results: int
    min_score: float


class SearchRequest(TypedDict, total=False):
    """Multi-dimensional weighted semantic search request.

    Map each dimension name to a :class:`DimensionQuery`; their scores are
    combined per ``combination_mode`` using each dimension's ``weight``.
    ``metadata_filters`` is an exact JSONB-containment filter on entry
    metadata (e.g. ``{"status": "resolved"}``) — note the field name is
    ``metadata_filters``, not ``filters``.

    The ``created_after`` / ``created_before`` / ``updated_after`` /
    ``updated_before`` keys add a **hard time-window filter** on entry
    timestamps (UTC). Accepts an ISO-8601 string or a ``datetime`` (serialized
    for you). It removes out-of-window rows without affecting the ranking.

    Example::

        {
            "dimensions": {
                "content": {"query_text": "login loops", "weight": 2.0},
                "products": {"query_text": "mobile app", "weight": 0.5},
            },
            "combination_mode": "weighted_sum",
            "metadata_filters": {"status": "resolved"},
            "created_after": "2026-05-01T00:00:00Z",
            "k": 10,
            "threshold": 0.35,
        }
    """

    dimensions: dict[str, DimensionQuery]
    k: int
    threshold: float
    combination_mode: CombinationMode
    custom_formula: str
    metadata_filters: dict[str, Any]
    category_filters: list[CategoryFilter]
    created_after: str | datetime
    created_before: str | datetime
    updated_after: str | datetime
    updated_before: str | datetime


# ── Clustering ──────────────────────────────────────────────────


ClusterMethod = Literal["auto", "vector", "fuzzy"]
"""How to group a field's values. ``"auto"`` picks by field type: a SINGLE
embedding dimension → ``"vector"``; anything else → ``"fuzzy"``."""

ClusterAlgorithm = Literal["auto", "kmeans", "agglomerative", "hdbscan"]
"""Vector-clustering algorithm. ``"auto"`` → HDBSCAN when ``k`` is omitted,
else KMeans."""


class ClusterMember(TypedDict, total=False):
    """One entry within a cluster."""

    id: str
    value: str | None  # the field value (fuzzy)
    content: str | None  # short content snippet (vector)
    distance: float | None  # distance to centroid (vector)


class ClusterGroup(TypedDict, total=False):
    """A single cluster of entries."""

    cluster_id: int
    size: int
    label: str | None
    key: str | None  # representative value (fuzzy)
    keywords: list[str]
    representative_entry_ids: list[str]
    values: list[str]  # distinct values in the group (fuzzy)
    members: list[ClusterMember]


class FieldClusterResult(TypedDict, total=False):
    """Clustering result for one field."""

    field: str
    method: ClusterMethod
    algorithm: ClusterAlgorithm | None  # vector only (resolved)
    similarity_threshold: float | None  # fuzzy only
    cluster_count: int
    clustered_count: int
    noise_count: int
    silhouette_score: float | None  # vector only
    clusters: list[ClusterGroup]


class ClusterScope(TypedDict, total=False):
    """Which entries were clustered."""

    source: str  # "all" | "search"
    entry_count: int
    truncated: bool


class ClusteringResult(TypedDict, total=False):
    """Per-field clustering of a KB's entries (returned by :meth:`cluster`)."""

    kb_id: str | None
    scope: ClusterScope
    results: list[FieldClusterResult]


# ── MCP Server Definition ──────────────────────────────────────


class MCPServerDefinition(TypedDict, total=False):
    """Everything needed to inject a KB's MCP server into an agent."""

    server_name: str
    type: str  # always "http"
    url: str
    description: str
    """The KB's own description (falls back to the KB name if unset) — the same
    text agents receive at the MCP handshake as ``initialize.instructions``. Set
    it in place via ``client.update_kb(kb_id, description=...)`` or
    ``kb.update(description=...)``."""
    token: str
    oauth_discovery_url: str
    oauth_client_id: str
    available_tools: list[str]


# ── API Keys ────────────────────────────────────────────────────


class APIKeyInfo(TypedDict, total=False):
    """API key metadata (key value is only returned at creation)."""

    id: str
    name: str
    key: str  # only present on creation
    key_prefix: str
    scopes: list[str]
    is_active: bool
    expires_at: str | None
    rate_limit_per_hour: int
    last_used_at: str | None
    total_requests: int
    created_at: str | None


# ── Batch Ingestion ─────────────────────────────────────────────


class BatchIngestResult(TypedDict, total=False):
    """Result of a batch entry ingestion."""

    ingested: int
    errors: list[dict[str, Any]]


# ── Deduplication Events ───────────────────────────────────────


class DeduplicationEventSummary(TypedDict, total=False):
    """Summary of a deduplication event (list view)."""

    id: str
    kb_id: str
    source: str
    content_preview: str
    max_similarity_score: float
    llm_invoked: bool
    action: str  # "new" | "redundant" | "update" | "conflict" | "error"
    created_at: str | None


class DeduplicationEvent(TypedDict, total=False):
    """Full deduplication event details."""

    id: str
    kb_id: str
    source: str
    new_entry_content: str
    new_entry_useful_for: str
    new_entry_metadata: dict[str, Any] | None
    similar_entries: list[dict[str, Any]]
    max_similarity_score: float
    llm_invoked: bool
    action: str  # "new" | "redundant" | "update" | "conflict" | "error"
    reasoning: str | None
    merged_content: str | None
    merged_useful_for: str | None
    merged_additional_dimensions: dict[str, Any] | None
    execution_status: str | None
    execution_error: str | None
    result_entry_id: str | None
    target_entry_id: str | None
    deleted_entry_ids: list[str]
    content_hash: str | None
    created_at: str | None


class DeduplicationEventList(TypedDict, total=False):
    """Paginated list of deduplication events."""

    events: list[DeduplicationEventSummary]
    total: int
    limit: int
    offset: int
    action_counts: dict[str, int]


# ── Entry Event Logs ───────────────────────────────────────────


class EntryEventLog(TypedDict, total=False):
    """A single event in entry processing lifecycle."""

    id: str
    pending_entry_id: str | None
    kb_id: str
    result_entry_id: str | None
    event_type: str  # "lifecycle" | "hash_check" | "dedup" | "action"
    event_name: str
    success: bool | None
    duration_ms: int | None
    detail: str | None
    detail_json: dict[str, Any] | None
    error_message: str | None
    created_at: str | None


class EntryEventLogList(TypedDict, total=False):
    """Paginated list of entry event logs."""

    logs: list[EntryEventLog]
    total: int
    limit: int
    offset: int
