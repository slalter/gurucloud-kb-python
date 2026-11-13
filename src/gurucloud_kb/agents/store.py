"""Where binding overrides live: a storage protocol and an in-memory store.

A host implements :class:`BindingStore` over its own database (a Postgres
table plus an events table, an append-only config log, ...). The store is
storage only: the rules (unknown agent or bank refused, a value equal to the
baseline clears the row, every change writes an event) live once in
:class:`gurucloud_kb.agents.service.AgentTopologyService`.

``write_override`` and ``delete_override`` receive the audit event with the
change and must persist both together (one transaction), so no override ever
changes without its event row.
"""

from __future__ import annotations

import threading
from typing import Optional, Protocol, Sequence, runtime_checkable

from gurucloud_kb.agents.contract import BindingOverride, BindingOverrideEvent


@runtime_checkable
class BindingStore(Protocol):
    """Persistence for overrides and their audit events."""

    def list_overrides(self) -> Sequence[BindingOverride]:
        """Every stored override."""
        ...

    def get_override(self, agent_id: str, bank_id: str) -> Optional[BindingOverride]:
        """The override for one agent-bank pair, or ``None``."""
        ...

    def write_override(self, override: BindingOverride, event: BindingOverrideEvent) -> None:
        """Insert or replace the pair's override and append ``event``, atomically."""
        ...

    def delete_override(self, agent_id: str, bank_id: str, event: BindingOverrideEvent) -> None:
        """Remove the pair's override and append ``event``, atomically."""
        ...

    def list_events(
        self,
        *,
        agent_id: Optional[str] = None,
        bank_id: Optional[str] = None,
        limit: int = 100,
    ) -> Sequence[BindingOverrideEvent]:
        """Audit events, newest first, optionally for one agent and/or bank."""
        ...


class InMemoryBindingStore:
    """A thread-safe :class:`BindingStore` held in process memory.

    For tests and the local ``gurucloud-kb ui`` mode. Nothing survives a
    restart.
    """

    def __init__(self, overrides: Sequence[BindingOverride] = ()) -> None:
        self._lock = threading.Lock()
        self._overrides: dict[tuple[str, str], BindingOverride] = {o.key: o for o in overrides}
        self._events: list[BindingOverrideEvent] = []

    def list_overrides(self) -> Sequence[BindingOverride]:
        with self._lock:
            return [self._overrides[k] for k in sorted(self._overrides)]

    def get_override(self, agent_id: str, bank_id: str) -> Optional[BindingOverride]:
        with self._lock:
            return self._overrides.get((agent_id, bank_id))

    def write_override(self, override: BindingOverride, event: BindingOverrideEvent) -> None:
        with self._lock:
            self._overrides[override.key] = override
            self._events.append(event)

    def delete_override(self, agent_id: str, bank_id: str, event: BindingOverrideEvent) -> None:
        with self._lock:
            self._overrides.pop((agent_id, bank_id), None)
            self._events.append(event)

    def list_events(
        self,
        *,
        agent_id: Optional[str] = None,
        bank_id: Optional[str] = None,
        limit: int = 100,
    ) -> Sequence[BindingOverrideEvent]:
        with self._lock:
            rows = [
                e
                for e in reversed(self._events)
                if (agent_id is None or e.agent_id == agent_id) and (bank_id is None or e.bank_id == bank_id)
            ]
        return rows[: max(0, limit)]
