"""KnowledgeBank object — the main interface for working with a single KB."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from gurucloud_kb._http import HTTPClient
from gurucloud_kb._search import build_string_search, normalize_search_request
from gurucloud_kb.types import (
    BatchIngestResult,
    ClusterAlgorithm,
    ClusteringResult,
    ClusterMethod,
    DeduplicationEvent,
    DeduplicationEventList,
    DimensionConfig,
    DimensionSchema,
    EntryEventLogList,
    EntryInput,
    EntryResult,
    KBInfo,
    MCPServerDefinition,
    SchemaWarning,
    SearchRequest,
    SearchResult,
)


class KnowledgeBank:
    """Represents a single Knowledge Bank with pre-bound ``kb_id``.

    Do not instantiate directly — use :meth:`GuruCloudClient.get_kb`
    or :meth:`GuruCloudClient.create_kb`.

    Example::

        kb = client.get_kb("my-kb-uuid")
        results = kb.search("how does auth work?")
    """

    def __init__(self, http: HTTPClient, info: KBInfo) -> None:
        self._http = http
        self._info = info

    # ── properties ──────────────────────────────────────────────

    @property
    def id(self) -> str:
        """The KB UUID."""
        return self._info["kb_id"]

    @property
    def name(self) -> str:
        return self._info.get("name", "")

    @property
    def description(self) -> str:
        return self._info.get("description", "")

    @property
    def entry_count(self) -> int:
        return self._info.get("entry_count", 0)

    @property
    def total_queries(self) -> int:
        return self._info.get("total_queries", 0)

    @property
    def info(self) -> KBInfo:
        """Full KB metadata dict."""
        return self._info

    def _path(self, suffix: str = "") -> str:
        return f"/banks/{self.id}{suffix}"

    # ── refresh ─────────────────────────────────────────────────

    def refresh(self) -> KBInfo:
        """Re-fetch KB info from the API."""
        self._info = self._http.get(self._path())
        return self._info

    # ── schema operations ───────────────────────────────────────

    def get_schema(self) -> DimensionSchema:
        """Get the dimension schema for this KB."""
        return self._http.get(self._path("/schema"))

    def update_schema(self, schema: DimensionSchema) -> DimensionSchema:
        """Replace the full dimension schema. Requires ``admin`` scope."""
        return self._http.put(self._path("/schema"), json=schema)

    def validate_schema(self, schema: DimensionSchema) -> list[SchemaWarning]:
        """Validate a schema without applying it. Returns warnings."""
        return self._http.post(self._path("/schema/validate"), json=schema)

    def add_dimension(self, dimension: DimensionConfig) -> dict[str, Any]:
        """Add a single dimension. Requires ``admin`` scope."""
        return self._http.post(self._path("/schema/dimensions"), json=dimension)

    def remove_dimension(self, name: str) -> dict[str, Any]:
        """Remove a dimension by name. Requires ``admin`` scope."""
        return self._http.delete(self._path(f"/schema/dimensions/{name}"))

    def set_allow_updates(self, value: bool) -> dict[str, Any]:
        """Enable/disable dedup updates for this KB. Requires ``write`` scope.

        When ``False`` the KB is accumulate-only: the dedup LLM's
        ``update``/``conflict`` verdicts are downgraded to ``new`` so existing
        entries are never overwritten or deleted (a rollup/synthesis lands as
        its own entry). True duplicates are still skipped via ``redundant``.
        """
        return self._http.patch(self._path(), json={"allow_updates": value})

    def set_response_fields(self, fields: list[str] | None) -> dict[str, Any]:
        """Set which EXTRA keys this KB's MCP tools return. Requires ``write`` scope.

        ``fields`` is an allowlist of result keys surfaced on each MCP result
        beyond the always-present ``id`` + ``content`` (e.g.
        ``["useful_for", "source"]``). Pass ``None`` or ``[]`` to reset to the
        default ``id`` + ``content`` only shape. Allowed values are the standard
        result fields plus this KB's own dimension names; unknown keys are
        rejected by the API.
        """
        return self._http.patch(
            self._path(), json={"mcp_response_fields": fields or None}
        )

    # ── entry management ────────────────────────────────────────

    def list_entries(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
    ) -> list[EntryResult]:
        """List entries with pagination."""
        return self._http.get(
            self._path("/entries"),
            params={"limit": limit, "offset": offset},
        )

    def add_entry(self, entry: EntryInput) -> dict[str, Any]:
        """Add a single entry."""
        return self._http.post(self._path("/entries"), json=entry)

    def get_entry(self, entry_id: str) -> EntryResult:
        """Get a single entry by ID."""
        return self._http.get(self._path(f"/entries/{entry_id}"))

    def update_entry(self, entry_id: str, updates: dict[str, Any]) -> EntryResult:
        """Update an entry's dimensions."""
        return self._http.patch(self._path(f"/entries/{entry_id}"), json=updates)

    def delete_entry(self, entry_id: str) -> dict[str, Any]:
        """Delete an entry."""
        return self._http.delete(self._path(f"/entries/{entry_id}"))

    def ingest(
        self,
        entries: list[EntryInput],
        *,
        deduplicate: bool = True,
    ) -> BatchIngestResult:
        """Batch-ingest multiple entries in a single call.

        Args:
            entries: List of entries to add.
            deduplicate: Whether to deduplicate against existing entries.

        Returns:
            Summary with counts of ingested/errored entries.
        """
        return self._http.post(
            self._path("/entries/batch"),
            json={"entries": entries, "deduplicate": deduplicate},
        )

    # ── search ──────────────────────────────────────────────────

    def search(
        self,
        query: str | SearchRequest,
        *,
        k: int = 10,
        threshold: float = 0.5,
        created_after: str | datetime | None = None,
        created_before: str | datetime | None = None,
        updated_after: str | datetime | None = None,
        updated_before: str | datetime | None = None,
    ) -> list[SearchResult]:
        """Semantic search across the KB.

        Pass a **string** for a quick single-dimension search of
        ``content``, or a full :class:`SearchRequest` for multi-dimensional
        weighted search.

        For multi-dimensional search, map each dimension name to a
        :class:`DimensionQuery`. Every dimension is embedded and compared
        independently, then the per-dimension scores are combined using
        ``combination_mode`` and each dimension's ``weight``::

            kb.search({
                "dimensions": {
                    "symptom":  {"query_text": "login loops", "weight": 2.0},
                    "products": {"query_text": "mobile app",  "weight": 0.5},
                },
                "combination_mode": "weighted_sum",
                "metadata_filters": {"status": "resolved"},
                "k": 10,
                "threshold": 0.35,
            })

        The required per-dimension key is ``query_text`` and exact filters
        go under ``metadata_filters``. Legacy ``query`` / ``filters``
        spellings are accepted and normalized for you.

        Args:
            query: A search string, or a full :class:`SearchRequest` dict.
            k: Number of results — applied only to string queries (for a
                dict, set ``k`` inside it).
            threshold: Minimum combined score — applied only to string
                queries (for a dict, set ``threshold`` inside it).
            created_after, created_before, updated_after, updated_before:
                Optional **hard time-window filter** on entry timestamps (UTC).
                Accepts an ISO-8601 string or a ``datetime``. Applied to string
                queries; for a dict query set the same keys inside it. Removes
                out-of-window entries without affecting the ranking.

        Returns:
            List of matching entries with per-dimension and combined scores.
        """
        if isinstance(query, str):
            request = build_string_search(
                query,
                k,
                threshold,
                created_after=created_after,
                created_before=created_before,
                updated_after=updated_after,
                updated_before=updated_before,
            )
        else:
            request = normalize_search_request(query)

        return self._http.post(self._path("/search"), json=request)

    # ── clustering ──────────────────────────────────────────────

    def cluster(
        self,
        *,
        fields: list[str] | None = None,
        method: ClusterMethod = "auto",
        algorithm: ClusterAlgorithm = "auto",
        k: int | None = None,
        min_cluster_size: int = 5,
        metric: str = "cosine",
        similarity_threshold: float = 0.85,
        search: SearchRequest | None = None,
        scope_limit: int = 2000,
        include_members: bool = True,
        max_members_per_cluster: int = 10,
        label: bool = False,
    ) -> ClusteringResult:
        """Group the KB's entries by one or more fields.

        Each field is clustered **independently** and returned keyed by field.
        With ``method="auto"`` the engine is chosen per field: a SINGLE
        embedding dimension (e.g. ``"content"``, ``"useful_for"``) clusters by
        **vector** similarity; any other field (``"metadata.customer"``,
        ``"source"``, a ``text_only`` dimension) clusters by **fuzzy** string
        match so near-duplicate values merge.

        Cluster the whole KB by default, or pass ``search`` (same shape as
        :meth:`search`) to cluster only the matching entries.

        Example::

            result = kb.cluster(
                fields=["content", "metadata.customer"],
                algorithm="auto",           # vector fields
                similarity_threshold=0.85,  # fuzzy fields
            )
            for field_result in result["results"]:
                print(field_result["field"], field_result["method"],
                      len(field_result["clusters"]))

        Args:
            fields: Fields to cluster on (default ``["content"]``).
            method: ``"auto"`` | ``"vector"`` | ``"fuzzy"``.
            algorithm: vector algorithm — ``"auto"`` (HDBSCAN when ``k`` is
                omitted, else KMeans) | ``"kmeans"`` | ``"agglomerative"`` |
                ``"hdbscan"``.
            k: cluster count (required for kmeans/agglomerative).
            min_cluster_size: HDBSCAN minimum cluster size.
            metric: ``"cosine"`` or ``"euclidean"`` (vector).
            similarity_threshold: fuzzy match cutoff 0..1 (1.0 = exact).
            search: optional :class:`SearchRequest` to scope which entries are
                clustered.
            scope_limit: max entries to cluster when no ``search`` is given.
            include_members: include member entries per cluster.
            max_members_per_cluster: cap members returned per cluster.
            label: generate a short label per cluster (LLM when available, else
                keyword-derived). Off by default — free and deterministic.

        Returns:
            A :class:`ClusteringResult` with one :class:`FieldClusterResult` per
            field in ``results``.
        """
        body: dict[str, Any] = {
            "fields": list(fields) if fields is not None else ["content"],
            "method": method,
            "algorithm": algorithm,
            "min_cluster_size": min_cluster_size,
            "metric": metric,
            "similarity_threshold": similarity_threshold,
            "scope_limit": scope_limit,
            "include_members": include_members,
            "max_members_per_cluster": max_members_per_cluster,
            "label": label,
        }
        if k is not None:
            body["k"] = k
        if search is not None:
            body["search"] = normalize_search_request(search)
        return self._http.post(self._path("/cluster"), json=body)

    # ── retrieval assertions ────────────────────────────────────

    def add_assertion(
        self,
        entry_id: str,
        query: str | dict[str, Any],
        *,
        notes: str | None = None,
    ) -> dict[str, Any]:
        """Add a retrieval assertion: a query that SHOULD return ``entry_id``.

        ``query`` is a string (matched against the ``content`` dimension) or a
        dict of dimensions (``content`` / ``useful_for`` / ``relevant_systems``
        / ``relevant_tasks``). The entry's baseline rank against live search is
        captured immediately, then re-checked by the eval over time.
        """
        body: dict[str, Any] = {"entry_id": entry_id, "query": query}
        if notes is not None:
            body["notes"] = notes
        return self._http.post(self._path("/assertions"), json=body)

    def list_assertions(
        self,
        *,
        entry_id: str | None = None,
        active_only: bool = True,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """List retrieval assertions for this KB (optionally one entry)."""
        params: dict[str, Any] = {
            "limit": limit,
            "offset": offset,
            "active_only": "true" if active_only else "false",
        }
        if entry_id is not None:
            params["entry_id"] = entry_id
        return self._http.get(self._path("/assertions"), params=params)

    def get_assertion(self, assertion_id: str) -> dict[str, Any]:
        """Get a single retrieval assertion by id."""
        return self._http.get(self._path(f"/assertions/{assertion_id}"))

    def delete_assertion(self, assertion_id: str) -> dict[str, Any]:
        """Deactivate a retrieval assertion (soft-delete; history preserved)."""
        return self._http.delete(self._path(f"/assertions/{assertion_id}"))

    # ── retrieval eval ──────────────────────────────────────────

    def run_retrieval_eval(self) -> dict[str, Any]:
        """Run the retrieval-assertion eval for this KB now (blocking).

        Re-scores every active assertion against live search and returns the
        run summary (hit@k, MRR, mean/median rank, per-verdict counts).
        """
        return self._http.post(self._path("/retrieval-eval/run"))

    def list_eval_runs(self, *, limit: int = 25) -> list[dict[str, Any]]:
        """List recent retrieval-eval runs for this KB (newest first)."""
        return self._http.get(self._path("/retrieval-eval/runs"), params={"limit": limit})

    def get_eval_run(self, run_id: str) -> dict[str, Any]:
        """Get one retrieval-eval run with its per-assertion rows."""
        return self._http.get(self._path(f"/retrieval-eval/runs/{run_id}"))

    # ── MCP integration ─────────────────────────────────────────

    def get_mcp_config(self) -> dict[str, Any]:
        """Get the ``.mcp.json`` snippet for this KB."""
        return self._http.get(self._path("/mcp-config"))

    def get_mcp_tools(self) -> dict[str, Any]:
        """Get MCP tool definitions generated for this KB's schema."""
        return self._http.get(self._path("/mcp-tools"))

    def get_mcp_server_definition(self) -> MCPServerDefinition:
        """Get the MCP server definition for agent injection.

        Returns the MCP URL, server name, and available tools.
        Use your KB API key as the Bearer token for MCP requests,
        or generate a PAT via :meth:`generate_pat`.

        Example::

            mcp_def = kb.get_mcp_server_definition()
            # Use your API key directly:
            # {
            #   "type": "http",
            #   "url": mcp_def["url"],
            #   "headers": {"Authorization": f"Bearer {api_key}"}
            # }
        """
        return self._http.post(self._path("/mcp-server-definition"))

    def generate_pat(self, token_name: str = "SDK Token") -> dict:
        """Generate a Personal Access Token for this KB's MCP server.

        Creates a never-expiring PAT for MCP authentication.
        Requires ``admin`` scope on your API key.

        Args:
            token_name: Human-readable label for the token.

        Returns:
            Dict with ``token``, ``server_url``, ``token_name``, ``note``.
        """
        return self._http.post(
            self._path("/generate-pat"),
            json={"token_name": token_name},
        )

    # ── deduplication events ───────────────────────────────────

    def list_events(
        self,
        *,
        action: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> DeduplicationEventList:
        """List deduplication events for this KB.

        Args:
            action: Optional filter — ``"new"``, ``"redundant"``,
                ``"update"``, ``"conflict"``, or ``"error"``.
            limit: Max events to return (max 200).
            offset: Pagination offset.

        Returns:
            Dict with ``events``, ``total``, ``action_counts``, etc.
        """
        params: dict[str, str | int] = {"limit": limit, "offset": offset}
        if action is not None:
            params["action"] = action
        return self._http.get(self._path("/events"), params=params)

    def get_event(self, event_id: str) -> DeduplicationEvent:
        """Get full details of a specific deduplication event.

        Args:
            event_id: Event UUID.

        Returns:
            Full event dict with reasoning, merged content, etc.
        """
        return self._http.get(self._path(f"/events/{event_id}"))

    # ── entry event logs ───────────────────────────────────────

    def list_event_logs(
        self,
        *,
        event_type: str | None = None,
        entry_id: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> EntryEventLogList:
        """List entry processing event logs for this KB.

        Args:
            event_type: Optional filter — ``"lifecycle"``, ``"hash_check"``,
                ``"dedup"``, or ``"action"``.
            entry_id: Optional pending entry UUID to filter by.
            limit: Max logs to return (max 200).
            offset: Pagination offset.

        Returns:
            Dict with ``logs``, ``total``, pagination info.
        """
        params: dict[str, str | int] = {"limit": limit, "offset": offset}
        if event_type is not None:
            params["event_type"] = event_type
        if entry_id is not None:
            params["entry_id"] = entry_id
        return self._http.get(self._path("/event-logs"), params=params)

    # ── stats ───────────────────────────────────────────────────

    def get_stats(self) -> dict[str, Any]:
        """Get performance statistics."""
        return self._http.get(self._path("/stats"))

    # ── dunder ──────────────────────────────────────────────────

    def __repr__(self) -> str:
        return f"KnowledgeBank(id={self.id!r}, name={self.name!r})"
