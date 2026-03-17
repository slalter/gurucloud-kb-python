"""GuruCloudClient — the top-level entry point for the SDK."""

from __future__ import annotations

from typing import Any

from gurucloud_kb._http import HTTPClient
from gurucloud_kb.kb import KnowledgeBank
from gurucloud_kb.types import (
    APIKeyInfo,
    DimensionSchema,
    KBInfo,
    MCPServerDefinition,
)

_DEFAULT_BASE_URL = "https://www.gurucloudai.com"


class GuruCloudClient:
    """Client for the GuruCloud Knowledge Bank API.

    Authenticate with a KB API key (``kb_...``).

    Example::

        from gurucloud_kb import GuruCloudClient

        client = GuruCloudClient(api_key="kb_abc123...")
        kb = client.get_kb("my-kb-uuid")
        results = kb.search("how does auth work?")
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = _DEFAULT_BASE_URL,
        timeout: float = 30.0,
        allow_insecure: bool = False,
    ) -> None:
        """Initialize the client.

        Args:
            api_key: KB API key (starts with ``kb_``).
            base_url: GuruCloud API base URL (must use HTTPS).
            timeout: Request timeout in seconds.
            allow_insecure: Allow HTTP URLs (for local development only).
        """
        if not api_key.startswith("kb_"):
            raise ValueError("API key must start with 'kb_'")

        self._http = HTTPClient(
            base_url=base_url, api_key=api_key, timeout=timeout,
            allow_insecure=allow_insecure,
        )

    # ── Knowledge Bank operations ───────────────────────────────

    def list_kbs(self) -> list[KBInfo]:
        """List all Knowledge Banks owned by the authenticated user."""
        return self._http.get("/banks")

    def get_kb(self, kb_id: str) -> KnowledgeBank:
        """Get a Knowledge Bank by ID, returning a :class:`KnowledgeBank` object.

        The returned object has methods for schema management, entry
        CRUD, search, and MCP integration — all pre-bound to this KB.

        Args:
            kb_id: Knowledge Bank UUID.

        Returns:
            A :class:`KnowledgeBank` instance.
        """
        info: KBInfo = self._http.get(f"/banks/{kb_id}")
        return KnowledgeBank(self._http, info)

    def create_kb(
        self,
        name: str,
        *,
        description: str = "",
        dimension_schema: DimensionSchema | None = None,
    ) -> KnowledgeBank:
        """Create a new Knowledge Bank.

        Args:
            name: Human-readable KB name.
            description: Optional description.
            dimension_schema: Optional custom schema (uses default if omitted).

        Returns:
            A :class:`KnowledgeBank` instance for the new KB.
        """
        payload: dict[str, Any] = {"name": name, "description": description}
        if dimension_schema is not None:
            payload["dimension_schema"] = dimension_schema

        info: KBInfo = self._http.post("/banks", json=payload)
        return KnowledgeBank(self._http, info)

    def update_kb(
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
        return self._http.patch(f"/banks/{kb_id}", json=updates)

    def delete_kb(self, kb_id: str) -> dict[str, Any]:
        """Delete a Knowledge Bank and all associated resources.

        Requires ``admin`` scope on the API key.
        """
        return self._http.delete(f"/banks/{kb_id}")

    # ── MCP server definition ───────────────────────────────────

    def get_mcp_server_definition(self, kb_id: str) -> MCPServerDefinition:
        """Get the MCP server definition for a KB, including a PAT.

        Convenience method — equivalent to ``client.get_kb(kb_id).get_mcp_server_definition()``,
        but skips the initial GET for KB info.

        Args:
            kb_id: Knowledge Bank UUID.

        Returns:
            Full MCP server definition with token for agent injection.
        """
        return self._http.post(f"/banks/{kb_id}/mcp-server-definition")

    # ── API key management ──────────────────────────────────────

    def create_api_key(
        self,
        name: str,
        *,
        scopes: list[str] | None = None,
        expires_at: str | None = None,
        rate_limit_per_hour: int = 1000,
    ) -> APIKeyInfo:
        """Create a new API key.

        The ``key`` field in the response is the raw API key — it is
        only returned once and cannot be retrieved again.

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
        return self._http.post("/api-keys", json=payload)

    def list_api_keys(self) -> list[APIKeyInfo]:
        """List all API keys (keys are masked)."""
        return self._http.get("/api-keys")

    def delete_api_key(self, key_id: str) -> dict[str, Any]:
        """Delete an API key."""
        return self._http.delete(f"/api-keys/{key_id}")

    # ── lifecycle ───────────────────────────────────────────────

    def close(self) -> None:
        """Close the underlying HTTP connection pool."""
        self._http.close()

    def __enter__(self) -> GuruCloudClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    def __repr__(self) -> str:
        return f"GuruCloudClient(base_url={self._http._base_url!r})"
