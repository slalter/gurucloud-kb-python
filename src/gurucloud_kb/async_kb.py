"""AsyncKnowledgeBank — async interface for working with a single KB."""

from __future__ import annotations

from typing import Any

from gurucloud_kb._async_http import AsyncHTTPClient
from gurucloud_kb.types import (
    BatchIngestResult,
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

    # ── entry management ────────────────────────────────────────

    async def list_entries(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
    ) -> list[EntryResult]:
        """List entries with pagination."""
        return await self._http.get(
            self._path("/entries"),
            params={"limit": limit, "offset": offset},
        )

    async def add_entry(self, entry: EntryInput) -> dict[str, Any]:
        """Add a single entry."""
        return await self._http.post(self._path("/entries"), json=entry)

    async def get_entry(self, entry_id: str) -> EntryResult:
        """Get a single entry by ID."""
        return await self._http.get(self._path(f"/entries/{entry_id}"))

    async def update_entry(self, entry_id: str, updates: dict[str, Any]) -> EntryResult:
        """Update an entry's dimensions."""
        return await self._http.patch(self._path(f"/entries/{entry_id}"), json=updates)

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
            Summary with counts of ingested/errored entries.
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
    ) -> list[SearchResult]:
        """Semantic search across the KB.

        Accepts either a simple string query (searches the ``content``
        dimension) or a full :class:`SearchRequest` dict for
        multi-dimensional search.

        Args:
            query: Search string or full SearchRequest.
            k: Number of results (only used with string queries).
            threshold: Minimum similarity score (only used with string queries).

        Returns:
            List of matching entries with scores.
        """
        if isinstance(query, str):
            request: SearchRequest = {
                "dimensions": {
                    "content": {"query_text": query, "weight": 1.0},
                },
                "k": k,
                "threshold": threshold,
            }
        else:
            request = query

        return await self._http.post(self._path("/search"), json=request)

    # ── MCP integration ─────────────────────────────────────────

    async def get_mcp_config(self) -> dict[str, Any]:
        """Get the ``.mcp.json`` snippet for this KB."""
        return await self._http.get(self._path("/mcp-config"))

    async def get_mcp_tools(self) -> dict[str, Any]:
        """Get MCP tool definitions generated for this KB's schema."""
        return await self._http.get(self._path("/mcp-tools"))

    async def get_mcp_server_definition(self) -> MCPServerDefinition:
        """Get everything needed to inject this KB's MCP server into an agent.

        Returns the MCP URL, a pre-minted Personal Access Token,
        available tools, and OAuth metadata.
        """
        return await self._http.post(self._path("/mcp-server-definition"))

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

    # ── dunder ──────────────────────────────────────────────────

    def __repr__(self) -> str:
        return f"AsyncKnowledgeBank(id={self.id!r}, name={self.name!r})"
