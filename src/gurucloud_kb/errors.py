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


class StaleEditError(APIError):
    """Raised on 412 ``stale_edit``: an entry update carried
    ``expected_updated_at`` and/or ``expected_content_sha256`` and the live
    entry no longer matches them (another write, e.g. a dedup merge, landed
    after you read it). Nothing was written.

    Attributes:
        entry_id: the entry you tried to update.
        mismatched: which preconditions failed (``updated_at``,
            ``content_sha256``).
        expected_updated_at / actual_updated_at: the timestamp you sent and
            the live one.
        expected_content_sha256 / actual_content_sha256: the digest you sent
            and the live one.
        current_state: the live entry (``content``, ``useful_for``,
            ``relevant_systems``, ``relevant_tasks``, ``metadata``,
            ``updated_at``, ``content_sha256``, ...).

    Resolve by re-applying your edit to ``current_state`` and sending it again
    with ``expected_updated_at=current_state["updated_at"]``.
    """

    def __init__(self, message: str, details: dict | None = None) -> None:
        details = details or {}
        self.entry_id: str | None = details.get("entry_id")
        self.mismatched: list[str] = list(details.get("mismatched") or [])
        self.expected_updated_at: str | None = details.get("expected_updated_at")
        self.actual_updated_at: str | None = details.get("actual_updated_at")
        self.expected_content_sha256: str | None = details.get("expected_content_sha256")
        self.actual_content_sha256: str | None = details.get("actual_content_sha256")
        current = details.get("current_state")
        self.current_state: dict = dict(current) if isinstance(current, dict) else {}
        super().__init__(412, "stale_edit", message)


class ConnectionError(GuruCloudError):
    """Raised when the SDK cannot reach the API."""

    def __init__(self, message: str = "Failed to connect to GuruCloud API") -> None:
        super().__init__(message)


RUN_ADVANCE_ERROR_CODES = frozenset(
    {"illegal_transition", "loop_limit", "run_not_running", "ambiguous_next", "verdict_required", "invalid_verdict"}
)


class PlaybookRunError(APIError):
    """Raised on 409 when a playbook run cannot advance as asked.

    Attributes:
        code: ``illegal_transition`` (``next_key`` is not a transition of the
            current step), ``loop_limit`` (that transition's loop budget is
            used up), ``run_not_running`` (the run is completed or abandoned)
            ``ambiguous_next`` (a decision step needs an explicit ``next_key``),
            ``verdict_required`` or ``invalid_verdict`` (the playbook declares
            a verdict vocabulary and the step was recorded without one of them).
        run_id / current_key / state: where the run is.
        legal: the transitions allowed right now (``to``, ``when``, ``limit``).
        allowed_verdicts: the playbook's verdict vocabulary, on the two verdict codes.

    Resolve by choosing one of ``legal`` (or ``abandon=True``), or by passing
    one of ``allowed_verdicts``.
    """

    def __init__(self, message: str, details: dict | None = None) -> None:
        details = details or {}
        code = str(details.get("error") or "illegal_transition")
        self.run_id: str | None = details.get("run_id")
        self.current_key: str | None = details.get("current_key")
        self.state: str | None = details.get("state")
        self.legal: list[dict] = list(details.get("legal") or [])
        self.allowed_verdicts: list[str] = list(details.get("allowed_verdicts") or [])
        super().__init__(409, code, message)


class PlaybookOverlapError(APIError):
    """Raised on 409 ``playbook_overlap``: the playbook you tried to write
    covers the same task as an existing ACTIVE playbook.

    Attributes:
        slug: the slug you tried to write.
        threshold: cosine similarity at or above which the bank refuses.
        candidates: the overlapping playbooks (``slug``, ``title``,
            ``when_to_use``, ``similarity``).

    Resolve by upserting the existing slug with the merged procedure, giving
    yours a genuinely different ``when_to_use``, passing
    ``supersedes_slug=<old>`` to retire the old one, or ``force=True`` if the
    tasks really are distinct.
    """

    def __init__(self, message: str, details: dict | None = None) -> None:
        details = details or {}
        self.slug: str | None = details.get("slug")
        self.threshold: float | None = details.get("threshold")
        self.candidates: list[dict] = list(details.get("candidates") or [])
        super().__init__(409, "playbook_overlap", message)


class PlaybookVersionConflictError(APIError):
    """Raised on 409 ``version_conflict``: you passed ``expected_version`` (or
    a ``base_version`` the bank has no snapshot for) and the stored playbook
    is not at that version. Nothing was written.

    Attributes:
        slug: the slug you tried to write.
        expected_version: the version you said you read.
        live_version: the version the bank holds now (``None`` when the slug
            does not exist).
        changed_keys: step keys changed, added or removed between the two.

    Resolve by reading the playbook again (``playbook_diff(slug,
    expected_version, live_version)`` shows what moved), re-applying your
    edit and writing with ``expected_version=live_version``, or by passing
    ``base_version=<what you read>, merge=True`` with your COMPLETE step list
    so the service keeps the upstream edits to steps you did not touch (an
    omitted step is still a deletion).
    """

    def __init__(self, message: str, details: dict | None = None) -> None:
        details = details or {}
        self.slug: str | None = details.get("slug")
        self.expected_version: int | None = details.get("expected_version")
        self.live_version: int | None = details.get("live_version")
        self.changed_keys: list[str] = list(details.get("changed_keys") or [])
        super().__init__(409, "version_conflict", message)


class PlaybookStepConflictError(APIError):
    """Raised on 409 ``step_conflict``: a ``base_version`` merge found a step
    changed both by you and since ``base_version`` (or the merged list would
    not be a sound playbook). Nothing was written.

    Attributes:
        slug, base_version, live_version.
        conflicts: the step keys changed on both sides (empty when the merged
            graph itself was unsound; see ``message``).

    Resolve by re-deriving your edit from ``live_version`` and writing again
    with ``base_version=live_version, merge=True``.
    """

    def __init__(self, message: str, details: dict | None = None) -> None:
        details = details or {}
        self.slug: str | None = details.get("slug")
        self.base_version: int | None = details.get("base_version")
        self.live_version: int | None = details.get("live_version")
        self.conflicts: list[str] = list(details.get("conflicts") or [])
        super().__init__(409, "step_conflict", message)
