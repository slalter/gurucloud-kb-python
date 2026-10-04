"""Request-building helpers shared by the sync and async KnowledgeBank playbook
methods, so both clients send byte-identical wire shapes."""
from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

from gurucloud_kb.types import PlaybookStatus, PlaybookStepInput, RunState


def list_params(
    query: str | None,
    status: PlaybookStatus | str,
    limit: int,
    min_score: float,
) -> dict[str, Any]:
    params: dict[str, Any] = {"status": status, "limit": limit}
    if query:
        params["query"] = query
    if min_score:
        params["min_score"] = min_score
    return params


def upsert_body(
    *,
    title: str,
    when_to_use: str,
    steps: list[PlaybookStepInput] | list[dict[str, Any]],
    summary: str,
    status: PlaybookStatus | None,
    supersedes_slug: str | None,
    metadata: dict[str, Any] | None,
    change_note: str,
    changed_by: str | None,
) -> dict[str, Any]:
    """Wire body for PUT /playbooks/{slug}.

    ``status`` / ``metadata`` are sent ONLY when given: the service keeps the
    stored values for an existing slug when they are absent (and defaults a
    new playbook to ``active`` / ``{}``). Sending ``{}`` clears metadata.
    """
    body: dict[str, Any] = {
        "title": title,
        "when_to_use": when_to_use,
        "steps": [dict(step) for step in steps],
        "summary": summary,
        "change_note": change_note,
    }
    if status is not None:
        body["status"] = status
    if metadata is not None:
        body["metadata"] = dict(metadata)
    if supersedes_slug:
        body["supersedes_slug"] = supersedes_slug
    if changed_by:
        body["changed_by"] = changed_by
    return body


def force_params(force: bool) -> dict[str, Any]:
    return {"force": "true" if force else "false"}


def delete_params(reason: str | None, changed_by: str | None) -> dict[str, Any]:
    params: dict[str, Any] = {}
    if reason:
        params["reason"] = reason
    if changed_by:
        params["changed_by"] = changed_by
    return params


def linked_params(include_linked_entries: bool) -> dict[str, Any]:
    return {"include_linked_entries": "true" if include_linked_entries else "false"}


def start_run_body(
    subject: str | None, started_by: str | None, metadata: dict[str, Any] | None
) -> dict[str, Any]:
    """Wire body for POST /playbooks/{slug}/runs (only what was given)."""
    body: dict[str, Any] = {}
    if subject:
        body["subject"] = subject
    if started_by:
        body["started_by"] = started_by
    if metadata is not None:
        body["metadata"] = dict(metadata)
    return body


def advance_run_body(
    observation: str,
    next_key: str | None,
    reason: str | None,
    abandon: bool,
    abandon_reason: str | None,
    changed_by: str | None,
    verdict: str | None = None,
    evidence: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Wire body for POST /playbook-runs/{run_id}/advance."""
    body: dict[str, Any] = {"observation": observation}
    if verdict:
        body["verdict"] = verdict
    if evidence is not None:
        body["evidence"] = dict(evidence)
    if next_key:
        body["next_key"] = next_key
    if reason:
        body["reason"] = reason
    if abandon:
        body["abandon"] = True
        if abandon_reason:
            body["abandon_reason"] = abandon_reason
    if changed_by:
        body["changed_by"] = changed_by
    return body


def run_list_params(state: RunState | str | None, subject: str | None, limit: int) -> dict[str, Any]:
    params: dict[str, Any] = {"limit": limit}
    if state:
        params["state"] = state
    if subject:
        params["subject"] = subject
    return params


def run_list_path(slug: str | None) -> str:
    """One playbook's runs live under the playbook; without a slug the listing spans the bank."""
    return f"/playbooks/{slug}/runs" if slug else "/playbook-runs"


def qs(params: dict[str, Any]) -> str:
    """Query string (with leading ``?``) for methods whose HTTP verb helper
    takes no ``params`` argument (PUT)."""
    return "?" + urlencode(params) if params else ""
