"""AsyncKnowledgeBank — async interface for working with a single KB."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Mapping, Optional, Sequence

from gurucloud_kb._async_http import AsyncHTTPClient
from gurucloud_kb import _playbooks as _pb
from gurucloud_kb._entries import build_entry_update
from gurucloud_kb._playbooks import qs as _qs
from gurucloud_kb._search import (
    apply_collapse,
    build_expanded_search,
    build_list_params,
    build_string_search,
    normalize_pair_scope,
    normalize_search_request,
    pair_refs,
)
from gurucloud_kb.types import (
    ExpandedSearchResult,
    ExpansionSpeed,
    ReasoningEffort,
    BatchIngestResult,
    ClusterAlgorithm,
    ClusteringResult,
    ClusterLabelSample,
    ClusterMemberSample,
    ClusterMethod,
    ClusterOutlierStrategy,
    DeduplicationEvent,
    DeduplicationEventList,
    RecentQueryList,
    DimensionConfig,
    DimensionSchema,
    EntryEventLogList,
    EntryInput,
    EntryResult,
    AddEdgesResult,
    ApplyProposalResult,
    ConnectionBackfillReport,
    ConnectionList,
    DeleteEdgeResult,
    EdgeInput,
    EdgeSource,
    EdgeStats,
    EdgeRelationConfig,
    EdgeRelationVocabulary,
    EdgeType,
    EntryConnections,
    GraphLayout,
    GraphNeighborhood,
    StartLayout,
    JudgePairsResult,
    MetadataFacets,
    SimilarPairsResult,
    KBInfo,
    MCPServerDefinition,
    SchemaWarning,
    SearchRequest,
    SearchResult,
    Playbook,
    PlaybookGenre,
    PlaybookList,
    PlaybookStats,
    PlaybookStatus,
    PlaybookStepInput,
    PlaybookRun,
    PlaybookVersion,
    PlaybookWriteResult,
    RunList,
    RunState,
)


class AsyncKnowledgeBank:
    """Async interface for a single Knowledge Bank with pre-bound ``kb_id``.

    Do not instantiate directly — use :meth:`AsyncGuruCloudClient.get_kb`
    or :meth:`AsyncGuruCloudClient.create_kb`.

    Example::

        kb = await client.get_kb("my-kb-uuid")
        results = await kb.search("how does auth work?")
    """

    def __init__(self, http: AsyncHTTPClient, info: KBInfo) -> None:
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

    async def refresh(self) -> KBInfo:
        """Re-fetch KB info from the API."""
        self._info = await self._http.get(self._path())
        return self._info

    # ── schema operations ───────────────────────────────────────

    async def get_schema(self) -> DimensionSchema:
        """Get the dimension schema for this KB."""
        return await self._http.get(self._path("/schema"))

    async def update_schema(self, schema: DimensionSchema) -> DimensionSchema:
        """Replace the full dimension schema. Requires ``admin`` scope."""
        return await self._http.put(self._path("/schema"), json=schema)

    async def validate_schema(self, schema: DimensionSchema) -> list[SchemaWarning]:
        """Validate a schema without applying it. Returns warnings."""
        return await self._http.post(self._path("/schema/validate"), json=schema)

    async def add_dimension(self, dimension: DimensionConfig) -> dict[str, Any]:
        """Add a single dimension. Requires ``admin`` scope."""
        return await self._http.post(self._path("/schema/dimensions"), json=dimension)

    async def remove_dimension(self, name: str) -> dict[str, Any]:
        """Remove a dimension by name. Requires ``admin`` scope."""
        return await self._http.delete(self._path(f"/schema/dimensions/{name}"))

    async def set_allow_updates(self, value: bool) -> dict[str, Any]:
        """Enable/disable dedup updates for this KB. Requires ``write`` scope.

        When ``False`` the KB is accumulate-only: the dedup LLM's
        ``update``/``conflict`` verdicts are downgraded to ``new`` so existing
        entries are never overwritten or deleted (a rollup/synthesis lands as
        its own entry). True duplicates are still skipped via ``redundant``.
        """
        return await self._http.patch(self._path(), json={"allow_updates": value})

    async def set_response_fields(self, fields: list[str] | None) -> dict[str, Any]:
        """Set which EXTRA keys this KB's MCP tools return. Requires ``write`` scope.

        ``fields`` is an allowlist of result keys surfaced on each MCP result
        beyond the always-present ``id`` + ``content`` (e.g.
        ``["useful_for", "source"]``). Pass ``None`` or ``[]`` to reset to the
        default ``id`` + ``content`` only shape. Allowed values are the standard
        result fields plus this KB's own dimension names; unknown keys are
        rejected by the API.
        """
        return await self._http.patch(
            self._path(), json={"mcp_response_fields": fields or None}
        )

    async def update(
        self,
        *,
        name: str | None = None,
        description: str | None = None,
    ) -> KBInfo:
        """Update this KB's name and/or description in place. Requires ``write`` scope.

        The **description** is the canonical "what is this / when should I use
        it" text for the KB. Setting it here is the in-place way to refresh every
        agent-facing surface derived from it — the MCP handshake
        ``initialize.instructions`` an agent receives on connect AND the
        ``description`` field returned by :meth:`get_mcp_server_definition`. There
        is no separate setter for those. Pass ``description=""`` to clear it.

        At least one of ``name`` / ``description`` must be given. Refreshes the
        cached :attr:`info` and returns it.

        Example::

            await kb.update(description="Resolved support tickets. Query before triage.")
        """
        updates: dict[str, str] = {}
        if name is not None:
            updates["name"] = name
        if description is not None:
            updates["description"] = description
        if not updates:
            raise ValueError("update() requires name and/or description")
        self._info = await self._http.patch(self._path(), json=updates)
        return self._info

    # ── entry management ────────────────────────────────────────

    async def list_entries(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        metadata_filters: Mapping[str, Any] | None = None,
        source: str | None = None,
        created_after: str | datetime | None = None,
        created_before: str | datetime | None = None,
        updated_after: str | datetime | None = None,
        updated_before: str | datetime | None = None,
        event_after: str | datetime | None = None,
        event_before: str | datetime | None = None,
    ) -> list[EntryResult]:
        """List entries, newest first, optionally narrowed by hard filters.

        The filters are the same non-semantic levers ``search`` has, applied
        SERVER-side before pagination, so a filter-only browse (no query)
        never depends on which page you happened to load::

            kb.list_entries(metadata_filters={"created_by": "alice"})
            kb.list_entries(metadata_filters={"tags": ["billing"]})   # list CONTAINS
            kb.list_entries(source="mcp_tools", created_after="2026-10-01")

        Use :meth:`metadata_facets` to see which keys and values the bank's
        entries actually carry before choosing a filter.

        Args:
            limit, offset: Page (max 200 per page).
            metadata_filters: JSONB containment on entry metadata: a scalar
                matches exactly, a list value matches entries whose list
                contains it.
            source: Exact match on the entry's ``source``.
            created_after, created_before, updated_after, updated_before,
            event_after, event_before: ISO-8601 or ``datetime`` bounds (UTC).
        """
        return await self._http.get(
            self._path("/entries"),
            params=build_list_params(
                limit=limit,
                offset=offset,
                metadata_filters=metadata_filters,
                source=source,
                created_after=created_after,
                created_before=created_before,
                updated_after=updated_after,
                updated_before=updated_before,
                event_after=event_after,
                event_before=event_before,
            ),
        )

    async def metadata_facets(self, *, max_values: int = 25, max_keys: int = 200) -> MetadataFacets:
        """What the bank's entries ACTUALLY carry in ``metadata``, discovered
        from the data: every key with its entry count, distinct-value count
        and most common values (``{value, type, count, in_list}``), plus the
        ``source`` column facet. ``type`` is the JSON type to rebuild the value
        with for a filter (a ``"boolean"`` ``"true"`` is ``True``, not the
        string); ``in_list`` means the value was an element of a list, so the
        filter is ``{key: [value]}``.

        Args:
            max_values: Values returned per key (default 25, max 100).
            max_keys: Keys returned (default 200, max 500); ``truncated_keys``
                says when the bank has more.
        """
        return await self._http.get(
            self._path("/metadata-facets"),
            params={"max_values": max_values, "max_keys": max_keys},
        )

    async def add_entry(self, entry: EntryInput) -> dict[str, Any]:
        """Add a single entry."""
        return await self._http.post(self._path("/entries"), json=entry)

    async def get_entry(self, entry_id: str) -> EntryResult:
        """Get a single entry by ID."""
        return await self._http.get(self._path(f"/entries/{entry_id}"))

    async def update_entry(
        self,
        entry_id: str,
        updates: Optional[Mapping[str, Any]] = None,
        *,
        content: Optional[str] = None,
        useful_for: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        systems: Optional[list[str]] = None,
        tasks: Optional[list[str]] = None,
        add_systems: Optional[list[str]] = None,
        remove_systems: Optional[list[str]] = None,
        add_tasks: Optional[list[str]] = None,
        remove_tasks: Optional[list[str]] = None,
    ) -> EntryResult:
        """Update an entry in place (re-embedding what changed).

        Args:
            entry_id: The entry to change (full id or unique prefix).
            updates: Optional raw body keyed by the server's field names
                (:class:`~gurucloud_kb.types.EntryUpdate`). Unknown keys
                raise ``ValueError`` here; the server rejects them too.
            content: New primary text (``content`` on the default schema,
                the primary dimension on a custom one).
            useful_for: New ``useful_for`` text.
            metadata: Keys to MERGE into the stored metadata (shallow; new
                values override, other keys are kept).
            systems / tasks: Full replacement of ``relevant_systems`` /
                ``relevant_tasks``.
            add_systems / remove_systems / add_tasks / remove_tasks:
                Incremental tag edits.

        Returns:
            The server's result (``{"success": true, ...}``).

        Raises:
            ValueError: unknown key in ``updates``, a field given both ways,
                or nothing to change.
        """
        body = build_entry_update(
            updates,
            content=content,
            useful_for=useful_for,
            metadata=metadata,
            systems=systems,
            tasks=tasks,
            add_systems=add_systems,
            remove_systems=remove_systems,
            add_tasks=add_tasks,
            remove_tasks=remove_tasks,
        )
        return await self._http.patch(self._path(f"/entries/{entry_id}"), json=body)

    async def delete_entry(self, entry_id: str) -> dict[str, Any]:
        """Delete an entry."""
        return await self._http.delete(self._path(f"/entries/{entry_id}"))

    async def ingest(
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
            Summary with counts of ingested/errored entries, plus
            ``entry_ids`` — the created id per input position (``None``
            where that index errored; absent on older servers).
        """
        return await self._http.post(
            self._path("/entries/batch"),
            json={"entries": entries, "deduplicate": deduplicate},
        )

    # ── search ──────────────────────────────────────────────────

    async def search(
        self,
        query: str | SearchRequest,
        *,
        k: int = 10,
        threshold: float = 0.5,
        created_after: str | datetime | None = None,
        created_before: str | datetime | None = None,
        updated_after: str | datetime | None = None,
        updated_before: str | datetime | None = None,
        event_after: str | datetime | None = None,
        event_before: str | datetime | None = None,
        collapse: bool | Mapping[str, Any] | None = None,
    ) -> list[SearchResult]:
        """Semantic search across the KB.

        Pass a **string** for a quick single-dimension search of
        ``content``, or a full :class:`SearchRequest` for multi-dimensional
        weighted search.

        For multi-dimensional search, map each dimension name to a
        :class:`DimensionQuery`. Every dimension is embedded and compared
        independently, then the per-dimension scores are combined using
        ``combination_mode`` and each dimension's ``weight``::

            await kb.search({
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
            event_after, event_before:
                Like the above, but filter on the caller-supplied ``event_at``
                (when the event/observation occurred) instead of ingest time.
            collapse: Fold results that are connected to each other (see
                :meth:`connect`) into one representative each, with
                ``related`` pointers ``{id, relation, direction, via,
                useful_for, score}`` to the folded entries, and refill the
                freed slots with further topics: same ``k``, more distinct
                topics, every folded id one :meth:`get_entry` away. ``True``
                takes the defaults; a dict sets ``pool`` (candidates fetched,
                default 20), ``guard_top_n`` (top hits never folded, 2) and
                ``max_related`` (pointers per result, 6). Applies to both
                string and dict queries.

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
                event_after=event_after,
                event_before=event_before,
                collapse=collapse,
            )
        else:
            request = apply_collapse(normalize_search_request(query), collapse)

        return await self._http.post(self._path("/search"), json=request)

    async def search_expanded(
        self,
        query: str,
        *,
        k: int = 10,
        threshold: float = 0.25,
        metadata_filters: dict[str, Any] | None = None,
        source: str | None = None,
        speed: ExpansionSpeed | None = None,
        content_weight: float | None = None,
        lexical: bool | None = None,
        model: str | None = None,
        reasoning_effort: ReasoningEffort | None = None,
        timeout_seconds: float | None = None,
        context: str | None = None,
        exclude_dimensions: list[str] | None = None,
        expand: bool | None = None,
        use_cache: bool | None = None,
        explain: bool | None = None,
        created_after: str | datetime | None = None,
        created_before: str | datetime | None = None,
        updated_after: str | datetime | None = None,
        updated_before: str | datetime | None = None,
        event_after: str | datetime | None = None,
        event_before: str | datetime | None = None,
        **options: Any,
    ) -> ExpandedSearchResult:
        """Search with a model-written expansion of ``query``.

        A small model reads this bank's dimension DESCRIPTIONS and writes the
        search text each dimension implies for the query, plus short
        descriptors. The platform then searches the raw query + descriptors
        in the primary content dimension (``content_weight``, default 3.0),
        every filled dimension at its schema weight, and the lexical arm on
        the raw words (so titles and identifiers stay findable). Measured on
        a 47-query truth set: nDCG@10 0.60 (raw) -> 0.81.

        Never worse than :meth:`search`: if the model step cannot run (no
        credential, timeout, provider error) the raw search runs instead and
        ``result["expansion"]["status"]`` says why. The model call is paid by
        your stored credential (``client.credentials``) when you have one,
        otherwise by the platform's own key; ``expansion.credential_source``
        reports which.

        Args:
            query: What the user typed.
            k, threshold: Result count / minimum combined score.
            metadata_filters: Exact JSONB-containment filter on entry metadata.
            speed: ``"fast"`` (default: fast model, no reasoning, 2.5 s limit,
                about 0.8 s) or ``"thorough"`` (cheap model, low reasoning,
                6 s limit, about 3 s). Quality measured equal within noise.
            content_weight: Weight of the primary content dimension (default 3.0).
            lexical: Run the lexical arm on the raw query (default True).
            model: Override the expander model (else your credential's
                ``default_model``, else the preset's model).
            reasoning_effort: Override the preset's reasoning level; the
                platform translates it to what the model family accepts.
            timeout_seconds: Override the preset's time limit; on timeout
                the raw search runs.
            context: Extra guidance for the expander about the corpus or the
                searcher (the bank description is always included).
            exclude_dimensions: Dimension names the model must not fill.
            expand: ``False`` runs the raw search through this endpoint
                (A/B against the expanded one).
            use_cache: Reuse a recent expansion of the same query (default True).
            explain: Include the query plan.
            created_after, ..., event_before: Hard time-window filters, as on
                :meth:`search`.
            **options: Forwarded verbatim (``category_filters``,
                ``combination_mode``, ``lexical_options``, ``query_source``).

        Returns:
            ``{"results": [...], "expansion": {...}, "search_request": {...}}``
            — the ranked entries, what the model did, and the effective
            multi-dimensional request that produced the results.
        """
        given: dict[str, Any] = dict(options)
        given.update(
            metadata_filters=metadata_filters,
            source=source,
            speed=speed,
            reasoning_effort=reasoning_effort,
            content_weight=content_weight,
            lexical=lexical,
            model=model,
            timeout_seconds=timeout_seconds,
            context=context,
            exclude_dimensions=exclude_dimensions,
            expand=expand,
            use_cache=use_cache,
            explain=explain,
        )
        request = build_expanded_search(
            query,
            k=k,
            threshold=threshold,
            time_bounds={
                "created_after": created_after,
                "created_before": created_before,
                "updated_after": updated_after,
                "updated_before": updated_before,
                "event_after": event_after,
                "event_before": event_before,
            },
            options=given,
        )
        return await self._http.post(self._path("/search/expanded"), json=request)

    # ── clustering ──────────────────────────────────────────────

    async def cluster(
        self,
        *,
        fields: list[str] | None = None,
        method: ClusterMethod = "auto",
        algorithm: ClusterAlgorithm = "auto",
        k: int | None = None,
        target_cluster_size: int | None = None,
        peel_misfits: bool = False,
        min_cluster_size: int = 5,
        max_cluster_size: int | None = None,
        max_cluster_fraction: float | None = None,
        outlier_strategy: ClusterOutlierStrategy = "keep",
        reassign_percentile: float | None = None,
        metric: str = "cosine",
        similarity_threshold: float = 0.85,
        search: SearchRequest | None = None,
        scope_limit: int = 2000,
        include_members: bool = True,
        max_members_per_cluster: int = 10,
        member_sample: ClusterMemberSample = "nearest",
        label: bool = False,
        label_sample_size: int | None = None,
        label_sample: ClusterLabelSample | None = None,
    ) -> ClusteringResult:
        """Group the KB's entries by one or more fields (async).

        See :meth:`gurucloud_kb.kb.KnowledgeBank.cluster` for full semantics:
        each field is grouped independently — embedding dimensions by vector
        similarity, other fields (metadata keys, ``source``, ``text_only``
        dimensions) by fuzzy string match — and ``search`` scopes which entries
        are clustered. ``max_cluster_size`` / ``max_cluster_fraction`` cap how
        many entries any one cluster may hold (absolute count / share of the
        scope; the stricter wins) — oversized vector clusters are recursively
        split server-side. ``outlier_strategy`` controls noise handling on
        vector fields: ``"keep"`` (default) | ``"reassign"`` (absorb into
        nearby clusters) | ``"subcluster"`` (form new ``from_noise`` clusters
        so no catch-all remains; ``reassign_percentile`` tunes how far outside
        a cluster's core ``"reassign"`` absorbs, server default 99).
        ``member_sample`` controls member sampling
        past ``max_members_per_cluster``: ``"nearest"`` (default) | ``"diverse"``
        (anchor + farthest-point picks so fringe sub-themes are represented).
        """
        body: dict[str, Any] = {
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
        if fields is not None:
            body["fields"] = list(fields)
        if k is not None:
            body["k"] = k
        if max_cluster_size is not None:
            body["max_cluster_size"] = max_cluster_size
        if max_cluster_fraction is not None:
            body["max_cluster_fraction"] = max_cluster_fraction
        if outlier_strategy != "keep":
            # Omitted when default so older servers stay compatible.
            body["outlier_strategy"] = outlier_strategy
        if reassign_percentile is not None:
            body["reassign_percentile"] = reassign_percentile
        if target_cluster_size is not None:
            body["target_cluster_size"] = target_cluster_size
        if peel_misfits:
            body["peel_misfits"] = True
        if label_sample_size is not None:
            body["label_sample_size"] = label_sample_size
        if label_sample is not None:
            body["label_sample"] = label_sample
        if member_sample != "nearest":
            body["member_sample"] = member_sample
        if search is not None:
            body["search"] = normalize_search_request(search)
        return await self._http.post(self._path("/cluster"), json=body)

    # ── similar pairs (beta) ─────────────────────────────────────

    # ------------------------------------------------------------------
    # Entry connections (knowledge graph)
    # ------------------------------------------------------------------

    async def connect(
        self,
        from_entry_id: str,
        to_entry_id: str,
        relation: EdgeType,
        *,
        note: str | None = None,
        evidence: Mapping[str, Any] | None = None,
        source: EdgeSource = "author",
        created_by: str | None = None,
    ) -> AddEdgesResult:
        """Connect two entries with a typed, directed relation.

        Connections are first-class data: ``search(collapse=True)`` folds
        connected results into one representative with pointers, the
        Explorer shows them on the entry, and deleting an entry bridges the
        chains through it (A -> B -> C with B removed becomes A -> C). Write
        one only when you are sure of the relation; similarity alone is not
        a connection::

            kb.connect(detail_id, hub_id, "part_of", note="the runbook step")
            kb.connect(new_id, old_id, "supersedes")

        Returns the stored edge under ``created`` (or ``existing`` when the
        same from/to/relation was already there); an end the bank does not
        hold is an ``errors`` row, never an exception.
        """
        edge: dict[str, Any] = {"from_entry_id": from_entry_id, "to_entry_id": to_entry_id, "edge_type": relation}
        if note:
            edge["note"] = note
        if evidence:
            edge["evidence"] = dict(evidence)
        return await self.add_connections([edge], source=source, created_by=created_by)  # type: ignore[arg-type]

    async def add_connections(
        self, edges: Sequence[EdgeInput], *, source: EdgeSource = "author", created_by: str | None = None,
    ) -> AddEdgesResult:
        """Write several connections in one call (up to 200); see :meth:`connect`."""
        if not edges:
            raise ValueError("edges must not be empty")
        body: dict[str, Any] = {"edges": [dict(e) for e in edges], "source": source}
        if created_by:
            body["created_by"] = created_by
        return await self._http.post(self._path("/edges"), json=body)

    async def connections(self, entry_id: str) -> EntryConnections:
        """An entry's connections, both directions, each with the other
        entry's ``useful_for`` and a content snippet."""
        return await self._http.get(self._path(f"/entries/{entry_id}/edges"))

    async def disconnect(self, edge_id: str, *, reason: str | None = None, actor: str | None = None) -> DeleteEdgeResult:
        """Remove one connection by its id (audited with ``reason``)."""
        params = {k: v for k, v in (("reason", reason), ("actor", actor)) if v}
        return await self._http.delete(self._path(f"/edges/{edge_id}"), params=params or None)

    async def list_connections(
        self, *, edge_type: EdgeType | None = None, source: EdgeSource | None = None, limit: int = 100, offset: int = 0,
    ) -> ConnectionList:
        """The bank's connections, newest first, optionally by type or source."""
        params: dict[str, Any] = {"limit": limit, "offset": offset}
        if edge_type:
            params["edge_type"] = edge_type
        if source:
            params["source"] = source
        return await self._http.get(self._path("/edges"), params=params)

    async def edge_relations(self) -> EdgeRelationVocabulary:
        """The relations this bank's edges may carry (see ``KnowledgeBank.edge_relations``)."""
        return await self._http.get(self._path("/edge-relations"))

    async def set_edge_relations(
        self, relations: Sequence[EdgeRelationConfig], *, replace_defaults: bool = False,
    ) -> EdgeRelationVocabulary:
        """Declare the bank's relations (see ``KnowledgeBank.set_edge_relations``). Requires ``write`` scope."""
        body: dict[str, Any] = {"relations": [dict(r) for r in relations], "replace_defaults": bool(replace_defaults)}
        return await self._http.put(self._path("/edge-relations"), json=body)

    async def connection_stats(self) -> EdgeStats:
        """Counts by type and by source, and how many entries are connected."""
        return await self._http.get(self._path("/edge-stats"))

    async def graph_layout(self, *, space: str = "content") -> GraphLayout:
        """Async ``KnowledgeBank.graph_layout``."""
        return await self._http.get(self._path("/graph/layout"), params={"space": space})

    async def recompute_graph_layout(self, *, space: str = "content") -> StartLayout:
        """Async ``KnowledgeBank.recompute_graph_layout``."""
        return await self._http.post(self._path("/graph/layout/recompute"), params={"space": space})

    async def graph(self, root: str, *, depth: int = 1, limit: int = 150) -> GraphNeighborhood:
        """The neighbourhood of ``root`` up to ``depth`` hops (1-3) in either
        direction, at most ``limit`` nodes, for a graph view::

            g = kb.graph(entry_id, depth=2)
            for e in g["edges"]:
                print(e["from_entry_id"][:8], e["edge_type"], e["to_entry_id"][:8])
        """
        return await self._http.get(self._path("/graph"), params={"root": root, "depth": depth, "limit": limit})

    async def backfill_connections(
        self, *, dry_run: bool = True, max_entries: int = 50000, actor: str | None = None,
    ) -> ConnectionBackfillReport:
        """Write the connections the bank's own entries already imply: in-text
        citations of other entries by id (``cites``) and typed metadata links
        such as ``split_from`` / ``replaces`` / ``recovered_from_entry_id``.
        ``dry_run`` (the default) only plans and reports; re-running is safe,
        existing connections are counted rather than duplicated.
        """
        params: dict[str, Any] = {"dry_run": "true" if dry_run else "false", "max_entries": max_entries}
        if actor:
            params["actor"] = actor
        return await self._http.post(self._path("/edges/backfill"), params=params)

    async def similar_pairs(
        self,
        *,
        field: str | None = None,
        threshold: float = 0.85,
        neighbors: int = 3,
        limit: int = 100,
        max_entries: int = 2000,
        scope: Mapping[str, Any] | None = None,
    ) -> SimilarPairsResult:
        """The bank's most similar entry pairs (beta): duplicate and conflict
        candidates found from the embeddings, best first, with both entries.

        Every entry in scope (the newest ``max_entries``, optionally narrowed
        by the ``scope`` hard filters) probes its ``neighbors`` nearest
        entries in ``field`` (default: the primary content dimension); pairs
        at or above ``threshold`` cosine similarity are returned::

            out = kb.similar_pairs(threshold=0.9, limit=50)
            for p in out["pairs"]:
                print(round(p["similarity"], 3), p["a"]["id"], p["b"]["id"])

        A whole-bank scan of a large bank takes seconds (16 s for 7.8K
        entries); ``out["stats"]`` reports what was scanned and whether more
        pairs cleared the threshold than ``limit`` returned.

        Args:
            field: A SINGLE embedding dimension name.
            threshold: Minimum cosine similarity (default 0.85).
            neighbors: Nearest entries probed per entry (1-10, default 3).
            limit: Pairs returned (1-500, default 100).
            max_entries: Entries scanned, newest first (default 2000).
            scope: Hard filters on the scanned entries, the same keys as
                :meth:`list_entries` (``metadata_filters``, ``source``,
                ``created_after`` ...).
        """
        body: dict[str, Any] = {"threshold": threshold, "neighbors": neighbors, "limit": limit, "max_entries": max_entries}
        if field is not None:
            body["field"] = field
        if scope:
            body["scope"] = normalize_pair_scope(scope)
        return await self._http.post(self._path("/similar-pairs"), json=body)

    async def judge_pairs(
        self,
        pairs: Sequence[tuple[str, str] | Mapping[str, str]],
        *,
        speed: ExpansionSpeed | None = None,
        model: str | None = None,
        reasoning_effort: ReasoningEffort | None = None,
        timeout_seconds: float | None = None,
        context: str | None = None,
        propose: bool = True,
    ) -> JudgePairsResult:
        """Ask a model what each pair IS (beta): ``duplicate`` (same facts
        twice), ``conflicting`` (they disagree on what is true or what to
        do), ``related`` (same topic, both needed) or ``distinct``, each with
        a confidence, a one-line reason and a ``suggested_action`` (``merge``,
        ``keep_both``, ``review_conflict``, ``delete_one``)::

            out = kb.similar_pairs(threshold=0.9, limit=20)
            verdicts = kb.judge_pairs([(p["a"]["id"], p["b"]["id"]) for p in out["pairs"]])
            for j in verdicts["judgements"]:
                print(j["verdict"], j["confidence"], j["reason"])

        One model call per request (at most 25 pairs), paid by your stored
        credential when you have one, otherwise by the platform. Model
        failures are reported in ``status`` (``judged`` | ``unconfigured`` |
        ``timeout`` | ``error``), never raised. Every call is audited on the
        platform.

        Args:
            pairs: ``(a_id, b_id)`` tuples or ``{"a_id", "b_id"}`` dicts.
            speed: ``"fast"`` or ``"thorough"`` (default: the platform's).
            model, reasoning_effort, timeout_seconds: Overrides as on
                :meth:`search_expanded`.
            context: Extra guidance for the judge about the corpus.
            propose: Also return a concrete proposal per pair (``judgement["proposal"]``:
                kind ``merge`` / ``keep_separate`` / ``trim_overlap`` / ``cross_reference`` /
                ``delete_one`` / ``review_conflict``, a rationale and the full proposed text
                of each entry it would change) that :meth:`apply_pair_proposal` can
                execute once a person approves it. Default True; False is faster.
        """
        body: dict[str, Any] = {"pairs": pair_refs(pairs)}
        for key, value in (("speed", speed), ("model", model), ("reasoning_effort", reasoning_effort),
                           ("timeout_seconds", timeout_seconds), ("context", context)):
            if value is not None:
                body[key] = value
        if not propose:
            body["propose"] = False
        return await self._http.post(self._path("/similar-pairs/judge"), json=body)

    async def apply_pair_proposal(
        self,
        judgement_id: str,
        a_id: str,
        b_id: str,
        proposal: Mapping[str, Any],
        *,
        reason: str | None = None,
        approved_by: str | None = None,
    ) -> ApplyProposalResult:
        """Execute a proposal a person approved (beta): the judge's proposal from
        :meth:`judge_pairs` (or an edited copy) for one pair. Updates re-embed
        through the ordinary entry update, deletions go through the ordinary
        delete (protected entries are skipped), every entry is snapshotted
        before it is touched (``changes[].previous``) and the application is
        audited on the platform::

            verdicts = kb.judge_pairs([(a, b)])
            j = verdicts["judgements"][0]
            if j["proposal"]["kind"] == "merge":
                out = kb.apply_pair_proposal(verdicts["judgement_id"], j["a_id"], j["b_id"], j["proposal"],
                                             reason="reviewed, duplicate confirmed")
                out["status"]   # "applied" | "partial" | "failed" | "nothing_to_apply"

        Args:
            judgement_id: ``judgement_id`` of the judge call the proposal came from.
            a_id, b_id: The pair.
            proposal: ``{"kind", "rationale", "changes": [{"entry_id", "action", "content", "useful_for"}]}``.
            reason, approved_by: Recorded on the audit row.
        """
        body: dict[str, Any] = {"judgement_id": judgement_id, "a_id": a_id, "b_id": b_id, "proposal": dict(proposal)}
        if reason is not None:
            body["reason"] = reason
        if approved_by is not None:
            body["approved_by"] = approved_by
        return await self._http.post(self._path("/similar-pairs/apply"), json=body)

    # ── retrieval assertions ────────────────────────────────────

    async def add_assertion(
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
        return await self._http.post(self._path("/assertions"), json=body)

    async def list_assertions(
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
        return await self._http.get(self._path("/assertions"), params=params)

    async def get_assertion(self, assertion_id: str) -> dict[str, Any]:
        """Get a single retrieval assertion by id."""
        return await self._http.get(self._path(f"/assertions/{assertion_id}"))

    async def delete_assertion(self, assertion_id: str) -> dict[str, Any]:
        """Deactivate a retrieval assertion (soft-delete; history preserved)."""
        return await self._http.delete(self._path(f"/assertions/{assertion_id}"))

    # ── retrieval eval ──────────────────────────────────────────

    async def run_retrieval_eval(self) -> dict[str, Any]:
        """Run the retrieval-assertion eval for this KB now (blocking).

        Re-scores every active assertion against live search and returns the
        run summary (hit@k, MRR, mean/median rank, per-verdict counts).
        """
        return await self._http.post(self._path("/retrieval-eval/run"))

    async def list_eval_runs(self, *, limit: int = 25) -> list[dict[str, Any]]:
        """List recent retrieval-eval runs for this KB (newest first)."""
        return await self._http.get(
            self._path("/retrieval-eval/runs"), params={"limit": limit}
        )

    async def get_eval_run(self, run_id: str) -> dict[str, Any]:
        """Get one retrieval-eval run with its per-assertion rows."""
        return await self._http.get(self._path(f"/retrieval-eval/runs/{run_id}"))

    # ── MCP integration ─────────────────────────────────────────

    # ── Playbooks ──────────────────────────────────────────────

    async def list_playbooks(
        self,
        query: str | None = None,
        *,
        status: PlaybookStatus | Literal["all"] = "active",
        limit: int = 25,
        min_score: float = 0.0,
        genre: PlaybookGenre | None = None,
    ) -> PlaybookList:
        """List this bank's playbooks — distinct, named, ordered procedures.

        With ``query`` (describe the task at hand) the rows are ranked by
        cosine similarity of the query to each playbook's ``title`` +
        ``when_to_use`` and carry a ``score``; without it, newest-updated
        first. ``status="all"`` includes drafts and superseded playbooks.
        ``genre="procedure"`` lists agent playbooks only, ``genre="process"``
        the documented client processes only; omitted, both are listed.

        Example::

            hits = await kb.list_playbooks("file kanban cards during the PM sweep")
            slug = hits["playbooks"][0]["slug"]
            playbook = await kb.get_playbook(slug)      # every step, in order
        """
        return await self._http.get(self._path("/playbooks"), params=_pb.list_params(query, status, limit, min_score, genre))

    async def get_playbook_stats(self, *, genre: PlaybookGenre | None = None) -> PlaybookStats:
        """Playbook counts by status (``active`` / ``draft`` / ``superseded``),
        optionally for one ``genre`` only."""
        return await self._http.get(self._path("/playbook-stats"), params=_pb.stats_params(genre))

    async def get_playbook(self, slug: str, *, include_linked_entries: bool = True) -> Playbook:
        """Fetch one playbook whole: every step in order plus the entries its
        steps cite (``linked_entries``). Raises :class:`NotFoundError` for an
        unknown slug."""
        return await self._http.get(self._path(f"/playbooks/{slug}"), params=_pb.linked_params(include_linked_entries))

    async def upsert_playbook(
        self,
        slug: str,
        *,
        title: str,
        when_to_use: str,
        steps: list[PlaybookStepInput] | list[dict[str, Any]],
        summary: str = "",
        status: PlaybookStatus | None = None,
        supersedes_slug: str | None = None,
        metadata: dict[str, Any] | None = None,
        change_note: str = "",
        changed_by: str | None = None,
        force: bool = False,
        genre: PlaybookGenre | None = None,
        metadata_merge: dict[str, Any] | None = None,
    ) -> PlaybookWriteResult:
        """Create or update the playbook at ``slug`` (versioned).

        ``when_to_use`` is what matching runs on — phrase it the way an agent
        would describe its task. ``steps`` are replaced wholesale; positions
        come from list order. ``status`` and ``metadata`` are preserve-on-absent:
        left as ``None`` they keep the stored values on an existing playbook
        (a new one defaults to ``"active"`` / ``{}``); pass ``metadata={}`` to
        clear it. To change one key pass ``metadata_merge`` instead: the
        service sets the given keys on top of the stored metadata and deletes
        a key given as ``None`` (not together with ``metadata``). A
        ``metadata`` replace on an existing playbook keeps the reserved keys
        ``verdicts`` and ``derived_from`` unless you set them to ``None``; the
        result's ``metadata_kept`` names what was kept. Every write snapshots
        the full playbook into its version history.

        The bank keeps one playbook per task: a write that would NEWLY overlap
        another ACTIVE playbook raises :class:`PlaybookOverlapError` with the
        candidates. Editing a playbook whose sibling already overlapped it is
        not refused (the result lists it under ``existing_overlaps``). Pass
        ``supersedes_slug`` to retire the old one in the same write, or
        ``force=True`` when the tasks really are distinct.

        ``genre="process"`` writes business process flow DOCUMENTATION instead
        of an agent procedure: every non-end step then carries
        ``process={"actor": ..., "system": ..., "hands_to": ...}`` (the
        service refuses a step without an actor), ``when_to_use`` is what the
        flow is and what starts it, and the row can never be run. Omitted,
        the service keeps the stored genre (``procedure`` for a new row).
        """
        body = _pb.upsert_body(
            title=title, when_to_use=when_to_use, steps=steps, summary=summary, status=status,
            supersedes_slug=supersedes_slug, metadata=metadata, change_note=change_note, changed_by=changed_by,
            genre=genre, metadata_merge=metadata_merge,
        )
        return await self._http.put(self._path(f"/playbooks/{slug}") + _qs(_pb.force_params(force)), json=body)

    async def delete_playbook(
        self, slug: str, *, reason: str | None = None, changed_by: str | None = None
    ) -> dict[str, Any]:
        """Hard-delete a playbook. Its version snapshots are retained and a
        tombstone version carrying ``reason`` / ``changed_by`` is appended, so
        :meth:`list_playbook_versions` still shows what was removed and why."""
        return await self._http.delete(self._path(f"/playbooks/{slug}") + _pb.qs(_pb.delete_params(reason, changed_by)))

    async def list_playbook_versions(self, slug: str) -> list[PlaybookVersion]:
        """Version history for a playbook, newest first (full snapshots)."""
        return await self._http.get(self._path(f"/playbooks/{slug}/versions"))

    # ── playbook runs ────────────────────────────────────────────────────

    async def start_playbook_run(
        self,
        slug: str,
        *,
        subject: str | None = None,
        started_by: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> PlaybookRun:
        """Start a run of the playbook at ``slug`` on a ``subject`` (a well, a
        ticket, a card). The run pins the playbook version it started on and
        returns the first step with the transitions it may take::

            run = await kb.start_playbook_run("dec-gas-well-review", subject="well 7")
            run["current_step"]["transitions"]   # what the agent may do next
        """
        body = _pb.start_run_body(subject, started_by, metadata)
        return await self._http.post(self._path(f"/playbooks/{slug}/runs"), json=body)

    async def advance_playbook_run(
        self,
        run_id: str,
        observation: str,
        *,
        next_key: str | None = None,
        reason: str | None = None,
        verdict: str | None = None,
        evidence: dict[str, Any] | None = None,
        abandon: bool = False,
        abandon_reason: str | None = None,
        changed_by: str | None = None,
    ) -> PlaybookRun:
        """Record ``observation`` on the current step and move along a legal
        transition. A linear step needs no ``next_key``; a decision step needs
        one; an end step (or the last linear step) completes the run.
        ``abandon=True`` ends the run without finishing it. ``verdict`` (a short
        result such as ``pass`` / ``flagged``) and ``evidence`` (a JSON object:
        tools called, data references, figures) are stored on the trail row.

        An illegal move raises :class:`PlaybookRunError` with ``code`` in
        ``illegal_transition`` / ``loop_limit`` / ``run_not_running`` /
        ``ambiguous_next`` and ``legal`` listing the transitions allowed now.
        """
        body = _pb.advance_run_body(observation, next_key, reason, abandon, abandon_reason, changed_by, verdict, evidence)
        return await self._http.post(self._path(f"/playbook-runs/{run_id}/advance"), json=body)

    async def get_playbook_run(self, run_id: str) -> PlaybookRun:
        """A run: state, current step with its legal transitions, full trail."""
        return await self._http.get(self._path(f"/playbook-runs/{run_id}"))

    async def list_playbook_runs(
        self,
        slug: str | None = None,
        *,
        state: RunState | Literal["all"] | None = None,
        subject: str | None = None,
        limit: int = 25,
    ) -> RunList:
        """Runs, newest first (``state`` defaults to all). With ``slug``: one
        playbook's runs. Without it: runs across the bank's playbooks, usually
        with ``subject`` (every run on one well, ticket or request)."""
        return await self._http.get(self._path(_pb.run_list_path(slug)), params=_pb.run_list_params(state, subject, limit))

    async def get_mcp_config(self) -> dict[str, Any]:
        """Get the ``.mcp.json`` snippet for this KB."""
        return await self._http.get(self._path("/mcp-config"))

    async def get_mcp_tools(self) -> dict[str, Any]:
        """Get MCP tool definitions generated for this KB's schema."""
        return await self._http.get(self._path("/mcp-tools"))

    async def get_mcp_server_definition(self) -> MCPServerDefinition:
        """Get the MCP server definition for agent injection.

        Returns the MCP URL, server name, ``kb_id`` / ``kb_name``, and
        ``available_tools`` — exactly the tools the bank's MCP server serves
        on ``tools/list`` (KB tools plus playbook tools, minus whatever the
        server's own read-only / allow / block config hides). The
        ``description`` field is the KB's own description (falling back to its
        name if unset) — the same text agents receive as
        ``initialize.instructions``. Change it in place with :meth:`update`.

        Use your KB API key as the Bearer token for MCP requests,
        or generate a PAT via :meth:`generate_pat`.
        """
        return await self._http.post(self._path("/mcp-server-definition"))

    async def generate_pat(self, token_name: str = "SDK Token") -> dict:
        """Generate a Personal Access Token for this KB's MCP server.

        Creates a never-expiring PAT for MCP authentication.
        Requires ``admin`` scope on your API key.

        Args:
            token_name: Human-readable label for the token.

        Returns:
            Dict with ``token``, ``server_url``, ``token_name``, ``note``.
        """
        return await self._http.post(
            self._path("/generate-pat"),
            json={"token_name": token_name},
        )

    # ── deduplication events ───────────────────────────────────

    async def list_events(
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
        return await self._http.get(self._path("/events"), params=params)

    async def get_event(self, event_id: str) -> DeduplicationEvent:
        """Get full details of a specific deduplication event.

        Args:
            event_id: Event UUID.

        Returns:
            Full event dict with reasoning, merged content, etc.
        """
        return await self._http.get(self._path(f"/events/{event_id}"))

    # ── entry event logs ───────────────────────────────────────

    async def list_event_logs(
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
        return await self._http.get(self._path("/event-logs"), params=params)

    # ── stats ───────────────────────────────────────────────────

    async def get_stats(self) -> dict[str, Any]:
        """Get performance statistics."""
        return await self._http.get(self._path("/stats"))

    async def list_recent_queries(self, *, limit: int = 50) -> RecentQueryList:
        """The most recent searches run against this bank, newest first
        (see :meth:`gurucloud_kb.KnowledgeBank.list_recent_queries`)."""
        return await self._http.get(self._path("/queries"), params={"limit": limit})

    # ── dunder ──────────────────────────────────────────────────

    def __repr__(self) -> str:
        return f"AsyncKnowledgeBank(id={self.id!r}, name={self.name!r})"
