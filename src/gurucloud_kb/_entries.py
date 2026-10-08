"""Build the body of an in-place entry update (``PATCH .../entries/{id}``).

Shared by :meth:`KnowledgeBank.update_entry` and
:meth:`AsyncKnowledgeBank.update_entry`. The server's request model
(``UpdateDimensionsRequest`` on the KB service) accepts exactly the keys in
:data:`UPDATE_ENTRY_FIELDS` and, since hosted kanban 2c8a61f5 (kb-platform images
after 1.6.0), REJECTS any other key. Before that it silently ignored unknown keys
and still answered success, so ``kb.update_entry(eid, {"metadata": {...}})``
looked like a no-op for weeks. This module refuses such a body client-side
with a :class:`ValueError` carrying the same wording the server uses.
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
}


def unknown_update_fields(updates: Mapping[str, Any]) -> list[str]:
    """The keys of ``updates`` the server does not accept."""
    allowed = set(UPDATE_ENTRY_FIELDS)
    return sorted(str(key) for key in updates if key not in allowed)


def unknown_update_fields_message(unknown: list[str]) -> str:
    """Same wording as the server's rejection."""
    return (
        f"Unknown field(s) for an entry update: {', '.join(unknown)}. "
        f"Allowed fields: {', '.join(UPDATE_ENTRY_FIELDS)}."
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
) -> EntryUpdate:
    """Map the typed keyword arguments (and/or a raw ``updates`` body) to the
    server's field names, refusing anything the server would reject.

    Raises:
        ValueError: ``updates`` carries a key outside
            :data:`UPDATE_ENTRY_FIELDS`; a field is given both as a keyword
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

    if not body:
        raise ValueError(
            "Nothing to update: pass content=, useful_for=, metadata=, systems=, tasks=, "
            "add_/remove_systems=, add_/remove_tasks= or an updates mapping."
        )
    return body  # type: ignore[return-value]  # keys validated against UPDATE_ENTRY_FIELDS above
