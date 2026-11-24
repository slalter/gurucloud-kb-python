"""Build the body of an in-place entry update (``PATCH .../entries/{id}``).

Shared by :meth:`KnowledgeBank.update_entry` and
:meth:`AsyncKnowledgeBank.update_entry`. The server's request model
(``UpdateDimensionsRequest`` on the KB service) accepts exactly the keys in
:data:`UPDATE_ENTRY_FIELDS` and, since hosted kanban 2c8a61f5 (kb-platform images
after 1.6.0), REJECTS any other key. Before that it silently ignored unknown keys
and still answered success, so ``kb.update_entry(eid, {"metadata": {...}})``
looked like a no-op for weeks. This module refuses such a body client-side
with a :class:`ValueError` carrying the same wording the server uses.

On top of those fields the server takes the optional stale-edit precondition
keys in :data:`EDIT_PRECONDITION_FIELDS` (hosted kanban 16cb0225): a mismatch
with the live entry is a 412 ``stale_edit``, raised as
:class:`~gurucloud_kb.errors.StaleEditError`.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

from gurucloud_kb.types import EntryUpdate

#: Every key the server accepts in an entry update, in its declaration order.
UPDATE_ENTRY_FIELDS: tuple[str, ...] = (
    "update_content",
    "update_useful_for",
    "add_systems",
    "remove_systems",
    "add_tasks",
    "remove_tasks",
    "replace_systems",
    "replace_tasks",
    "update_metadata",
)

#: Optional stale-edit precondition keys (hosted kanban 16cb0225): the state the
#: caller edited from. The server compares them with the live entry and answers
#: 412 ``stale_edit`` (:class:`~gurucloud_kb.errors.StaleEditError`) on a
#: mismatch, writing nothing. They never count as a change on their own.
EDIT_PRECONDITION_FIELDS: tuple[str, ...] = ("expected_updated_at", "expected_content_sha256")

#: Keyword argument of ``update_entry`` -> server field it maps to.
_KWARG_TO_FIELD: dict[str, str] = {
    "content": "update_content",
    "useful_for": "update_useful_for",
    "metadata": "update_metadata",
    "systems": "replace_systems",
    "tasks": "replace_tasks",
    "add_systems": "add_systems",
    "remove_systems": "remove_systems",
    "add_tasks": "add_tasks",
    "remove_tasks": "remove_tasks",
    "expected_updated_at": "expected_updated_at",
    "expected_content_sha256": "expected_content_sha256",
}


def unknown_update_fields(updates: Mapping[str, Any]) -> list[str]:
    """The keys of ``updates`` the server does not accept."""
    allowed = set(UPDATE_ENTRY_FIELDS) | set(EDIT_PRECONDITION_FIELDS)
    return sorted(str(key) for key in updates if key not in allowed)


def unknown_update_fields_message(unknown: list[str]) -> str:
    """Same wording as the server's rejection."""
    return (
        f"Unknown field(s) for an entry update: {', '.join(unknown)}. "
        f"Allowed fields: {', '.join(UPDATE_ENTRY_FIELDS + EDIT_PRECONDITION_FIELDS)}."
    )


def build_entry_update(
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
    expected_updated_at: Optional[str] = None,
    expected_content_sha256: Optional[str] = None,
) -> EntryUpdate:
    """Map the typed keyword arguments (and/or a raw ``updates`` body) to the
    server's field names, refusing anything the server would reject.

    Raises:
        ValueError: ``updates`` carries a key outside
            :data:`UPDATE_ENTRY_FIELDS` and :data:`EDIT_PRECONDITION_FIELDS`;
            a field is given both as a keyword
            and in ``updates``; or nothing at all was given to change.
    """
    if updates is not None and not isinstance(updates, Mapping):
        raise ValueError("updates must be a mapping of server field name -> value")

    body: dict[str, Any] = {}
    if updates:
        unknown = unknown_update_fields(updates)
        if unknown:
            raise ValueError(unknown_update_fields_message(unknown))
        body.update(updates)

    kwargs: dict[str, Any] = {
        "content": content,
        "useful_for": useful_for,
        "metadata": metadata,
        "systems": systems,
        "tasks": tasks,
        "add_systems": add_systems,
        "remove_systems": remove_systems,
        "add_tasks": add_tasks,
        "remove_tasks": remove_tasks,
        "expected_updated_at": expected_updated_at,
        "expected_content_sha256": expected_content_sha256,
    }
    for name, value in kwargs.items():
        if value is None:
            continue
        field = _KWARG_TO_FIELD[name]
        if field in body:
            raise ValueError(
                f"{name}= and updates[{field!r}] both set the same field; pass one of them"
            )
        body[field] = dict(value) if name == "metadata" else value

    if not any(field not in EDIT_PRECONDITION_FIELDS for field in body):
        raise ValueError(
            "Nothing to update: pass content=, useful_for=, metadata=, systems=, tasks=, "
            "add_/remove_systems=, add_/remove_tasks= or an updates mapping "
            "(expected_updated_at / expected_content_sha256 alone change nothing)."
        )
    return body  # type: ignore[return-value]  # keys validated against the allow-lists above
