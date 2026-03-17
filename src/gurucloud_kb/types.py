"""Type definitions for the GuruCloud KB SDK.

All types use TypedDict for zero-dependency, static-typing-friendly contracts.
"""

from __future__ import annotations

from typing import Any, TypedDict


# ── Knowledge Bank ──────────────────────────────────────────────


class KBInfo(TypedDict, total=False):
    """Knowledge Bank metadata returned by the API."""

    kb_id: str
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
    dimension_type: str  # "single" | "multi" | "text_only"
    required: bool
    default_weight: float
    aggregation: str
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
    combination_mode: str  # "weighted_sum" | "weighted_product" | "max" | "min" | "custom"


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
    """Query parameters for a single search dimension."""

    query_text: str
    weight: float


class SearchRequest(TypedDict, total=False):
    """Multi-dimensional semantic search request."""

    dimensions: dict[str, DimensionQuery]
    k: int
    threshold: float
    filters: dict[str, Any]


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
