"""Typed error classes for the GuruCloud KB SDK."""

from __future__ import annotations


class GuruCloudError(Exception):
    """Base error for all GuruCloud SDK errors."""

    def __init__(self, message: str) -> None:
        self.message = message
        super().__init__(message)


class APIError(GuruCloudError):
    """Error returned by the GuruCloud API.

    Attributes:
        status_code: HTTP status code.
        code: Machine-readable error code from the API (e.g. "not_found").
        message: Human-readable error description.
    """

    def __init__(self, status_code: int, code: str, message: str) -> None:
        self.status_code = status_code
        self.code = code
        super().__init__(f"[{status_code}] {code}: {message}")


class AuthenticationError(APIError):
    """Raised on 401 responses (invalid or missing API key)."""

    def __init__(self, code: str = "invalid_key", message: str = "Authentication failed") -> None:
        super().__init__(401, code, message)


class PermissionError(APIError):
    """Raised on 403 responses (insufficient scope)."""

    def __init__(self, code: str = "insufficient_scope", message: str = "Permission denied") -> None:
        super().__init__(403, code, message)


class NotFoundError(APIError):
    """Raised on 404 responses."""

    def __init__(self, code: str = "not_found", message: str = "Resource not found") -> None:
        super().__init__(404, code, message)


class RateLimitError(APIError):
    """Raised on 429 responses."""

    def __init__(self, code: str = "rate_limited", message: str = "Rate limit exceeded") -> None:
        super().__init__(429, code, message)


class ConnectionError(GuruCloudError):
    """Raised when the SDK cannot reach the API."""

    def __init__(self, message: str = "Failed to connect to GuruCloud API") -> None:
        super().__init__(message)
