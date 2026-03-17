"""Low-level HTTP transport for the GuruCloud KB SDK.

Wraps httpx to provide:
- Automatic Bearer token injection
- Response envelope unwrapping  (``{"data": ...}``)
- Typed error raising
"""

from __future__ import annotations

from typing import Any

import httpx

from gurucloud_kb.errors import (
    APIError,
    AuthenticationError,
    ConnectionError,
    NotFoundError,
    PermissionError,
    RateLimitError,
)

_DEFAULT_TIMEOUT = 30.0


class HTTPClient:
    """Thin wrapper around httpx for the KB API."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: float = _DEFAULT_TIMEOUT,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = httpx.Client(
            base_url=f"{self._base_url}/api/v1/kb",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            timeout=timeout,
        )

    # ── public verbs ────────────────────────────────────────────

    def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        return self._request("GET", path, params=params)

    def post(self, path: str, json: Any = None) -> Any:
        return self._request("POST", path, json=json)

    def put(self, path: str, json: Any = None) -> Any:
        return self._request("PUT", path, json=json)

    def patch(self, path: str, json: Any = None) -> Any:
        return self._request("PATCH", path, json=json)

    def delete(self, path: str) -> Any:
        return self._request("DELETE", path)

    def close(self) -> None:
        self._client.close()

    # ── internals ───────────────────────────────────────────────

    def _request(
        self,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        json: Any = None,
    ) -> Any:
        try:
            resp = self._client.request(method, path, params=params, json=json)
        except httpx.ConnectError as exc:
            raise ConnectionError(f"Cannot reach {self._base_url}: {exc}") from exc
        except httpx.TimeoutException as exc:
            raise ConnectionError(f"Request timed out: {exc}") from exc

        if resp.status_code >= 400:
            self._raise_for_status(resp)

        # The API wraps successful responses in {"data": ...}
        body = resp.json()
        if isinstance(body, dict) and "data" in body:
            return body["data"]
        return body

    @staticmethod
    def _raise_for_status(resp: httpx.Response) -> None:
        """Map HTTP error responses to typed SDK exceptions."""
        try:
            body = resp.json()
        except Exception:
            raise APIError(resp.status_code, "unknown", resp.text)

        error = body.get("error", {})
        code = error.get("code", "unknown") if isinstance(error, dict) else "unknown"
        message = error.get("message", resp.text) if isinstance(error, dict) else str(error)

        status = resp.status_code
        if status == 401:
            raise AuthenticationError(code, message)
        if status == 403:
            raise PermissionError(code, message)
        if status == 404:
            raise NotFoundError(code, message)
        if status == 429:
            raise RateLimitError(code, message)
        raise APIError(status, code, message)
