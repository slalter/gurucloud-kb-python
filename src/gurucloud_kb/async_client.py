"""AsyncGuruCloudClient — async entry point for the SDK."""

from __future__ import annotations

from typing import Any

from gurucloud_kb._async_http import AsyncHTTPClient
from gurucloud_kb.async_kb import AsyncKnowledgeBank
from gurucloud_kb.types import (
    APIKeyInfo,
    DimensionSchema,
    KBInfo,
    MCPServerDefinition,
)

_DEFAULT_BASE_URL = "https://www.gurucloudai.com"


class AsyncGuruCloudClient:
    """Async client for the GuruCloud Knowledge Bank API.

    Authenticate with a KB API key (``kb_...``).

    Example::

        from gurucloud_kb import AsyncGuruCloudClient

        async with AsyncGuruCloudClient(api_key="kb_abc123...") as client:
            kb = await client.get_kb("my-kb-uuid")
            results = await kb.search("how does auth work?")
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = _DEFAULT_BASE_URL,
        timeout: float = 30.0,
        allow_insecure: bool = False,
    ) -> None:
        """Initialize the async client.

        Args:
            api_key: KB API key (starts with ``kb_``).
            base_url: GuruCloud API base URL (must use HTTPS).
            timeout: Request timeout in seconds.
            allow_insecure: Allow HTTP URLs (for local development only).
        """
        if not api_key.startswith("kb_"):
            raise ValueError("API key must start with 'kb_'")

        self._http = AsyncHTTPClient(
            base_url=base_url, api_key=api_key, timeout=timeout,
            allow_insecure=allow_insecure,
        )

    # ── Knowledge Bank operations ───────────────────────────────

    async def list_kbs(self) -> list[KBInfo]:
        """List all Knowledge Banks owned by the authenticated user."""
        return await self._http.get("/banks")

    async def get_kb(self, kb_id: str) -> AsyncKnowledgeBank:
        """Get a Knowledge Bank by ID, returning an :class:`AsyncKnowledgeBank` object.

        Args:
            kb_id: Knowledge Bank UUID.

        Returns:
            An :class:`AsyncKnowledgeBank` instance.
        """
        info: KBInfo = await self._http.get(f"/banks/{kb_id}")
        return AsyncKnowledgeBank(self._http, info)

    async def create_kb(
        self,
        name: str,
        *,
        description: str = "",
        dimension_schema: DimensionSchema | None = None,
    ) -> AsyncKnowledgeBank:
        """Create a new Knowledge Bank.

        Args:
            name: Human-readable KB name.
            description: Optional description.
            dimension_schema: Optional custom schema (uses default if omitted).

        Returns:
            An :class:`AsyncKnowledgeBank` instance for the new KB.
        """
        payload: dict[str, Any] = {"name": name, "description": description}
        if dimension_schema is not None:
            payload["dimension_schema"] = dimension_schema

        info: KBInfo = await self._http.post("/banks", json=payload)
        return AsyncKnowledgeBank(self._http, info)

    async def update_kb(
        self,
        kb_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
    ) -> KBInfo:
        """Update a KB's name and/or description.

        Args:
            kb_id: Knowledge Bank UUID.
            name: New name (optional).
            description: New description (optional).

        Returns:
            Updated KB info.
        """
        updates: dict[str, str] = {}
        if name is not None:
            updates["name"] = name
        if description is not None:
            updates["description"] = description
        return await self._http.patch(f"/banks/{kb_id}", json=updates)

    async def delete_kb(self, kb_id: str) -> dict[str, Any]:
        """Delete a Knowledge Bank and all associated resources.

        Requires ``admin`` scope on the API key.
        """
        return await self._http.delete(f"/banks/{kb_id}")

    # ── MCP server definition ───────────────────────────────────

    async def get_mcp_server_definition(self, kb_id: str) -> MCPServerDefinition:
        """Get the MCP server definition for a KB, including a PAT.

        Args:
            kb_id: Knowledge Bank UUID.

        Returns:
            Full MCP server definition with token for agent injection.
        """
        return await self._http.post(f"/banks/{kb_id}/mcp-server-definition")

    # ── API key management ──────────────────────────────────────

    async def create_api_key(
        self,
        name: str,
        *,
        scopes: list[str] | None = None,
        expires_at: str | None = None,
        rate_limit_per_hour: int = 1000,
    ) -> APIKeyInfo:
        """Create a new API key.

        Args:
            name: Human-readable label.
            scopes: Granted scopes (default: ``["read", "write"]``).
            expires_at: Optional ISO 8601 expiry timestamp.
            rate_limit_per_hour: Rate limit (default: 1000).

        Returns:
            API key info including the raw key.
        """
        payload: dict[str, Any] = {"name": name, "rate_limit_per_hour": rate_limit_per_hour}
        if scopes is not None:
            payload["scopes"] = scopes
        if expires_at is not None:
            payload["expires_at"] = expires_at
        return await self._http.post("/api-keys", json=payload)

    async def list_api_keys(self) -> list[APIKeyInfo]:
        """List all API keys (keys are masked)."""
        return await self._http.get("/api-keys")

    async def delete_api_key(self, key_id: str) -> dict[str, Any]:
        """Delete an API key."""
        return await self._http.delete(f"/api-keys/{key_id}")

    # ── lifecycle ───────────────────────────────────────────────

    async def close(self) -> None:
        """Close the underlying HTTP connection pool."""
        await self._http.close()

    async def __aenter__(self) -> AsyncGuruCloudClient:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()

    def __repr__(self) -> str:
        return f"AsyncGuruCloudClient(base_url={self._http._base_url!r})"
