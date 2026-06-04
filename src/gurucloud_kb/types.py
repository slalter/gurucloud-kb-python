"""Type definitions for the GuruCloud KB SDK.

All types use TypedDict for zero-dependency, static-typing-friendly contracts.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict


# ── Enumerated value types (self-documenting) ───────────────────


DimensionType = Literal["single", "multi", "text_only"]
"""How a dimension is stored and searched.

- ``"single"``    — one embedding per entry (e.g. ``content``, ``useful_for``).
- ``"multi"``     — many values per entry, each embedded, aggregated at search
  time (e.g. ``relevant_systems = ["flask", "jwt"]``). Matches ANY value.
- ``"text_only"`` — stored as text, NOT embedded. Reserved for future
  exact-match filters; not searchable today.
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

    Example::

        {
            "dimensions": {
                "content": {"query_text": "login loops", "weight": 2.0},
                "products": {"query_text": "mobile app", "weight": 0.5},
            },
            "combination_mode": "weighted_sum",
            "metadata_filters": {"status": "resolved"},
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


# ── MCP Server Definition ──────────────────────────────────────


class MCPServerDefinition(TypedDict, total=False):
    """Everything needed to inject a KB's MCP server into an agent."""

    server_name: str
    type: str  # always "http"
    url: str
    description: str
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
