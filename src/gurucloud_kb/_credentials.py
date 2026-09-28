"""Client credential management (``client.credentials``).

Your own model-provider keys, stored encrypted on the platform so features
that call a language model on your behalf — expanded search today — bill
YOUR provider account, not the platform's. The platform never returns a
stored key; listings carry a fingerprint and the last four characters.

Scope: a credential is owner-wide by default and applies to every bank you
search. Pass ``kb`` to store a bank-scoped override (a different key, or an
Azure OpenAI endpoint, for one bank only).

Providers: ``"openai"`` (api.openai.com, ``base_url`` optional) and
``"azure_openai"`` (``base_url`` required, e.g.
``https://<resource>.openai.azure.com/openai/v1``; ``default_model`` is the
deployment name).
"""

from __future__ import annotations

from typing import Any

from gurucloud_kb._async_http import AsyncHTTPClient
from gurucloud_kb._http import HTTPClient
from gurucloud_kb.types import ClientCredentialInfo, CredentialProvider, CredentialStoreStatus


def build_credential_payload(
    api_key: str,
    *,
    base_url: str | None,
    default_model: str | None,
    label: str | None,
    kb: str | None,
) -> dict[str, Any]:
    """The ``PUT /credentials/{provider}`` body (only the keys that are set)."""
    if not api_key or not api_key.strip():
        raise ValueError("api_key is required")
    payload: dict[str, Any] = {"api_key": api_key.strip()}
    if base_url is not None:
        payload["base_url"] = base_url
    if default_model is not None:
        payload["default_model"] = default_model
    if label is not None:
        payload["label"] = label
    if kb is not None:
        payload["kb"] = kb
    return payload


def _params(kb: str | None) -> dict[str, Any] | None:
    return {"kb": kb} if kb is not None else None


class ClientCredentials:
    """Sync credential operations, reached as ``client.credentials``."""

    def __init__(self, http: HTTPClient) -> None:
        self._http = http

    def set(
        self,
        provider: CredentialProvider,
        api_key: str,
        *,
        base_url: str | None = None,
        default_model: str | None = None,
        label: str | None = None,
        kb: str | None = None,
    ) -> ClientCredentialInfo:
        """Store (or replace / rotate) your key for ``provider``.

        Args:
            provider: ``"openai"`` or ``"azure_openai"``.
            api_key: The provider secret. Sent once over TLS, stored
                encrypted, never returned.
            base_url: OpenAI-compatible base URL. Required for
                ``azure_openai``; leave unset for api.openai.com.
            default_model: Model (Azure: deployment name) used when a search
                names none.
            label: Free-text label shown in listings.
            kb: Bank name or id to scope this credential to; unset = every
                bank you search.

        Returns:
            The stored credential's metadata (``key_fingerprint``,
            ``key_hint``, timestamps) — not the key.
        """
        payload = build_credential_payload(api_key, base_url=base_url, default_model=default_model, label=label, kb=kb)
        return self._http.put(f"/credentials/{provider}", json=payload)

    def list(self, *, kb: str | None = None) -> list[ClientCredentialInfo]:
        """Your stored credentials (keys masked). With ``kb``, the rows that
        apply to that bank: its bank-scoped rows plus your owner-wide rows."""
        return self._http.get("/credentials", params=_params(kb))

    def delete(self, provider: CredentialProvider, *, kb: str | None = None) -> dict[str, Any]:
        """Remove your ``provider`` credential (the owner-wide one, or the
        ``kb``-scoped one when ``kb`` is given)."""
        return self._http.delete(f"/credentials/{provider}", params=_params(kb))

    def status(self) -> CredentialStoreStatus:
        """Whether the platform can store credentials (an encryption key is configured)."""
        return self._http.get("/credentials/status")


class AsyncClientCredentials:
    """Async twin of :class:`ClientCredentials`."""

    def __init__(self, http: AsyncHTTPClient) -> None:
        self._http = http

    async def set(
        self,
        provider: CredentialProvider,
        api_key: str,
        *,
        base_url: str | None = None,
        default_model: str | None = None,
        label: str | None = None,
        kb: str | None = None,
    ) -> ClientCredentialInfo:
        """See :meth:`ClientCredentials.set`."""
        payload = build_credential_payload(api_key, base_url=base_url, default_model=default_model, label=label, kb=kb)
        return await self._http.put(f"/credentials/{provider}", json=payload)

    async def list(self, *, kb: str | None = None) -> list[ClientCredentialInfo]:
        """See :meth:`ClientCredentials.list`."""
        return await self._http.get("/credentials", params=_params(kb))

    async def delete(self, provider: CredentialProvider, *, kb: str | None = None) -> dict[str, Any]:
        """See :meth:`ClientCredentials.delete`."""
        return await self._http.delete(f"/credentials/{provider}", params=_params(kb))

    async def status(self) -> CredentialStoreStatus:
        """See :meth:`ClientCredentials.status`."""
        return await self._http.get("/credentials/status")
