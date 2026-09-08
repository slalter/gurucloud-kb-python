"""Type definitions for the GuruCloud KB SDK.

All types use TypedDict for zero-dependency, static-typing-friendly contracts.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional, TypedDict


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
    event_at: str
    """When the underlying event/observation occurred (e.g. an email's sent
    date), as an ISO-8601 UTC string — distinct from the ingest timestamp.
    Enables event-time range filtering via ``event_after`` / ``event_before``
    at search time. Stored as naive UTC server-side; ``created_at`` remains the
    honest ingest time."""


class EntryResult(TypedDict, total=False):
    """A KB entry returned by the API."""

    id: str
    content: str
    useful_for: str
    relevant_systems: list[str]
    relevant_tasks: list[str]
    relevant_file_paths: list[str]
    # Values of every non-default embedded dimension in the KB's schema,
    # keyed by dimension name (SINGLE → str, MULTI → list[str]). Empty for
    # default-schema KBs; TEXT_ONLY dimension values live in ``metadata``.
    dimensions: dict[str, str | list[str]]
    metadata: dict[str, Any]
    source: str
    combined_score: float
    created_at: str
    updated_at: str
    event_at: str  # caller-supplied event time (ISO-8601), null when unset


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
    timestamps (UTC). ``event_after`` / ``event_before`` filter on the
    caller-supplied ``event_at`` (when the event/observation occurred) instead
    of the ingest time. Each accepts an ISO-8601 string or a ``datetime``
    (serialized for you) and removes out-of-window rows without affecting the
    ranking.

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
    event_after: str | datetime
    event_before: str | datetime


# ── Clustering ──────────────────────────────────────────────────


ClusterMethod = Literal["auto", "vector", "fuzzy"]
"""How to group a field's values. ``"auto"`` picks by field type: a SINGLE
embedding dimension → ``"vector"``; anything else → ``"fuzzy"``."""

ClusterAlgorithm = Literal["auto", "kmeans", "agglomerative", "hdbscan"]
"""Vector-clustering algorithm. ``"auto"`` → HDBSCAN when ``k`` is omitted,
else KMeans."""

ClusterOutlierStrategy = Literal["keep", "reassign", "subcluster"]
"""What to do with outlier/noise entries after vector clustering.
``"keep"`` leaves them uncategorized (default); ``"reassign"`` absorbs each
into its nearest cluster when it lies within that cluster's own spread;
``"subcluster"`` re-clusters the noise into new clusters flagged
``from_noise`` so no catch-all bucket remains."""

ClusterMemberSample = Literal["nearest", "diverse"]
"""How a vector cluster's returned members are sampled past
``max_members_per_cluster``. ``"nearest"`` (default) returns the members
closest to the centroid; ``"diverse"`` returns the nearest-centroid anchor
plus greedy farthest-point picks so fringe sub-themes are represented."""


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
    from_noise: bool  # formed from former noise by outlier_strategy="subcluster"
    low_cohesion: bool  # mean member distance is an outlier vs peers (likely catch-all)
    mean_member_distance: float | None  # vector only; cohesion measure


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


class MCPServerAuth(TypedDict, total=False):
    """How to authenticate against a KB's MCP server.

    The definition is read-scoped: it never mints or returns a token. Use your
    KB API key (``kb_...``) as the Bearer token, or mint a never-expiring PAT
    via ``generate_pat`` / ``generate_pat_for_server``.
    """

    type: str  # always "bearer"
    note: str


class MCPServerDefinition(TypedDict, total=False):
    """Everything needed to inject a KB's MCP server into an agent.

    Returned by ``get_mcp_server_definition``. This is read-scoped *connection
    metadata only* — it deliberately does NOT contain a ``token`` (or any OAuth
    discovery fields); PAT minting moved to the separate admin-scoped
    ``generate_pat`` endpoint. Authenticate via :attr:`auth`.
    """

    server_name: str
    type: str  # always "http"
    url: str
    description: str
    """The KB's own description (falls back to the KB name if unset) — the same
    text agents receive at the MCP handshake as ``initialize.instructions``. Set
    it in place via ``client.update_kb(kb_id, description=...)`` or
    ``kb.update(description=...)``."""
    auth: MCPServerAuth
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
    """Result of a batch entry ingestion.

    ``entry_ids`` is positional: one created entry id per input entry, with
    ``None`` at indexes whose entry errored. Servers older than the
    entry-id-returning API omit the key entirely.
    """

    ingested: int
    errors: list[dict[str, Any]]
    entry_ids: list[Optional[str]]


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


# ── Playbooks ──────────────────────────────────────────────────

PlaybookStatus = Literal["draft", "active", "superseded"]
"""Lifecycle of a playbook. Only ``active`` playbooks are matched and take
part in the overlap guard; ``superseded`` ones are kept for the audit trail."""


class PlaybookStepInput(TypedDict, total=False):
    """One ordered step as written by the caller (positions come from list order)."""

    title: str
    body: str
    kb_entry_id: str
    """Optional entry id whose fact this step relies on; ``get_playbook``
    inlines it under ``linked_entries`` instead of duplicating the fact."""


class PlaybookStep(PlaybookStepInput, total=False):
    """A stored step: the input fields plus its 1-based ``position``."""

    position: int


class PlaybookSummary(TypedDict, total=False):
    """Compact index row returned by ``list_playbooks``."""

    id: str
    slug: str
    title: str
    when_to_use: str
    summary: str
    status: PlaybookStatus
    version: int
    step_count: int
    updated_at: str | None
    score: float | None
    """Cosine similarity to the query when one was given, else ``None``."""


class PlaybookList(TypedDict, total=False):
    playbooks: list[PlaybookSummary]
    total_active: int
    query: str | None


class LinkedEntry(TypedDict, total=False):
    """A KB entry a step cites via ``kb_entry_id``, inlined on read."""

    id: str
    content: str | None
    useful_for: str | None
    missing: bool


class Playbook(TypedDict, total=False):
    """The whole playbook — every step, in order."""

    id: str
    slug: str
    title: str
    when_to_use: str
    summary: str
    status: PlaybookStatus
    version: int
    supersedes_id: str | None
    created_by: str | None
    metadata: dict[str, Any]
    created_at: str | None
    updated_at: str | None
    steps: list[PlaybookStep]
    linked_entries: list[LinkedEntry]


class PlaybookWriteResult(TypedDict, total=False):
    action: Literal["created", "updated"]
    playbook: Playbook


class PlaybookVersion(TypedDict, total=False):
    """One snapshot from the playbook's version history (newest first)."""

    version: int
    change_note: str
    changed_by: str | None
    created_at: str | None
    snapshot: dict[str, Any]


class PlaybookStats(TypedDict, total=False):
    active: int
    draft: int
    superseded: int


class OverlapCandidate(TypedDict, total=False):
    """An existing active playbook that blocked an upsert."""

    id: str
    slug: str
    title: str
    when_to_use: str
    similarity: float
