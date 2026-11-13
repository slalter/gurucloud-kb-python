"""The binding rules, written once, and the host-neutral HTTP route function.

:class:`AgentTopologyService` sits between a host and its
:class:`~gurucloud_kb.agents.store.BindingStore`:

* an override must name a known agent and a known bank;
* every change names its actor; every set or clear writes an audit event;
* setting a value equal to the agent's baseline clears the stored row
  (and is a no-op when there is none), so the store holds deviations only;
* "removed" on a bank the agent is not bound to in code is the baseline too.

:func:`handle_agent_topology_request` maps the fixed route shape onto the
service and returns ``(status, json_body)``, so a host (the SDK's local
server, a FastAPI app, an admin proxy) serves the Agents view in a few lines::

    status, body = handle_agent_topology_request(
        service, request.method, request.url.path,
        query=request.url.query, body=await request.json(), actor=current_user.email,
    )

Routes (relative to the host root):

``GET    /api/agent-topology``                          graph JSON
``GET    /api/agent-topology/events?agent=&bank=&limit=`` audit events, newest first
``GET    /api/agent-topology/agents/<agent>/mounts``    the agent's mount plan
``PUT    /api/agent-topology/overrides``                body ``{agent_id, bank_id, access, allowed_tools?, reason?}``
``DELETE /api/agent-topology/overrides/<agent>/<bank>`` ``?reason=`` (or a JSON body with ``reason``)
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Iterable, Literal, Mapping, Optional, Sequence
from urllib.parse import parse_qs, unquote

from gurucloud_kb.agents.contract import (
    AgentSpec,
    BankRef,
    Binding,
    BindingOverride,
    BindingOverrideEvent,
    ContractError,
    check_access,
    check_allowed_tools,
    check_id,
    utcnow,
)
from gurucloud_kb.agents.resolve import HeadersFor, MountPlan, inherited_baseline, resolve_mounts_from_store
from gurucloud_kb.agents.store import BindingStore
from gurucloud_kb.agents.topology import build_topology

AGENT_TOPOLOGY_PATH = "/api/agent-topology"

ChangeAction = Literal["set", "clear", "noop"]


class UnknownAgentError(LookupError):
    """The agent id is not one the host registered."""


class UnknownBankError(LookupError):
    """The bank id is not one the host registered."""


@dataclass(frozen=True)
class ChangeResult:
    """What a set or clear did. ``event`` is ``None`` for a no-op."""

    action: ChangeAction
    event: Optional[BindingOverrideEvent]
    override: Optional[BindingOverride]

    def to_dict(self) -> dict[str, Any]:
        return {
            "result": self.action,
            "event": self.event.to_dict() if self.event else None,
            "override": self.override.to_dict() if self.override else None,
        }


class AgentTopologyService:
    """Binding rules over one host's agents, banks and override store."""

    def __init__(
        self,
        agents: Iterable[AgentSpec],
        banks: Iterable[BankRef],
        store: BindingStore,
        *,
        available_tools: Optional[Mapping[str, Sequence[str]]] = None,
        clock: Callable[[], datetime] = utcnow,
        new_event_id: Callable[[], str] = lambda: str(uuid.uuid4()),
    ) -> None:
        self.agents: dict[str, AgentSpec] = {a.agent_id: a for a in agents}
        self.banks: dict[str, BankRef] = {b.bank_id: b for b in banks}
        self.store = store
        self.available_tools = available_tools
        self._clock = clock
        self._new_event_id = new_event_id

    # ── reads ──

    def topology(self) -> dict[str, Any]:
        """Graph JSON; falls back to the baseline if the store cannot be read."""
        try:
            overrides = list(self.store.list_overrides())
            store_error = None
        except Exception as exc:  # noqa: BLE001 - shown in the view, never fatal
            overrides, store_error = [], f"{type(exc).__name__}: {exc}"
        return build_topology(
            self.agents.values(),
            self.banks.values(),
            overrides,
            available_tools=self.available_tools,
            store_error=store_error,
        )

    def events(
        self, *, agent_id: Optional[str] = None, bank_id: Optional[str] = None, limit: int = 100
    ) -> list[BindingOverrideEvent]:
        return list(self.store.list_events(agent_id=agent_id, bank_id=bank_id, limit=limit))

    def mount_plan(self, agent_id: str, *, headers_for: Optional[HeadersFor] = None) -> MountPlan:
        """The agent's mounts for a turn, overrides applied (baseline if the store fails)."""
        agent = self._agent(agent_id)
        return resolve_mounts_from_store(
            agent,
            self.banks,
            self.store,
            agents=self.agents,
            available_tools=self.available_tools,
            headers_for=headers_for,
        )

    # ── writes ──

    def set_override(
        self,
        agent_id: str,
        bank_id: str,
        access: str,
        allowed_tools: Optional[Sequence[str]] = None,
        *,
        actor: str,
        reason: str = "",
    ) -> ChangeResult:
        """Set one agent's access to one bank (clears the row when equal to baseline)."""
        agent = self._agent(agent_id)
        self._bank(bank_id)
        actor = self._actor(actor)
        candidate = Binding(agent_id, bank_id, check_access(access), check_allowed_tools(allowed_tools))
        baseline = self._baseline(agent, bank_id)
        existing = self.store.get_override(agent_id, bank_id)
        if self._equals_baseline(candidate, baseline):
            if existing is None:
                return ChangeResult("noop", None, None)
            return self._clear(existing, baseline, actor, reason or "set back to baseline")
        if existing is not None and candidate.same_value(existing.as_binding()):
            return ChangeResult("noop", None, existing)
        now = self._clock()
        override = BindingOverride(
            agent_id, bank_id, candidate.access, candidate.allowed_tools, actor=actor, reason=reason, updated_at=now
        )
        event = BindingOverrideEvent(
            event_id=self._new_event_id(),
            agent_id=agent_id,
            bank_id=bank_id,
            action="set",
            actor=actor,
            reason=reason,
            at=now,
            old_access=existing.access if existing else None,
            old_allowed_tools=existing.allowed_tools if existing else None,
            new_access=override.access,
            new_allowed_tools=override.allowed_tools,
            baseline_access=baseline.access if baseline else None,
            baseline_allowed_tools=baseline.allowed_tools if baseline else None,
        )
        self.store.write_override(override, event)
        return ChangeResult("set", event, override)

    def clear_override(self, agent_id: str, bank_id: str, *, actor: str, reason: str = "") -> ChangeResult:
        """Drop the stored override so the agent goes back to its baseline."""
        agent = self._agent(agent_id)
        self._bank(bank_id)
        actor = self._actor(actor)
        existing = self.store.get_override(agent_id, bank_id)
        if existing is None:
            return ChangeResult("noop", None, None)
        return self._clear(existing, self._baseline(agent, bank_id), actor, reason)

    # ── internals ──

    def _clear(
        self, existing: BindingOverride, baseline: Optional[Binding], actor: str, reason: str
    ) -> ChangeResult:
        event = BindingOverrideEvent(
            event_id=self._new_event_id(),
            agent_id=existing.agent_id,
            bank_id=existing.bank_id,
            action="clear",
            actor=actor,
            reason=reason,
            at=self._clock(),
            old_access=existing.access,
            old_allowed_tools=existing.allowed_tools,
            baseline_access=baseline.access if baseline else None,
            baseline_allowed_tools=baseline.allowed_tools if baseline else None,
        )
        self.store.delete_override(existing.agent_id, existing.bank_id, event)
        return ChangeResult("clear", event, None)

    @staticmethod
    def _equals_baseline(candidate: Binding, baseline: Optional[Binding]) -> bool:
        if baseline is None:
            return candidate.access == "removed" and candidate.allowed_tools is None
        return candidate.same_value(baseline)

    def _baseline(self, agent: AgentSpec, bank_id: str) -> Optional[Binding]:
        return inherited_baseline(agent, self.agents).get(bank_id)

    def _agent(self, agent_id: str) -> AgentSpec:
        check_id(agent_id, "agent_id")
        agent = self.agents.get(agent_id)
        if agent is None:
            raise UnknownAgentError(f"unknown agent {agent_id!r}")
        return agent

    def _bank(self, bank_id: str) -> BankRef:
        check_id(bank_id, "bank_id")
        bank = self.banks.get(bank_id)
        if bank is None:
            raise UnknownBankError(f"unknown bank {bank_id!r}")
        return bank

    @staticmethod
    def _actor(actor: str) -> str:
        if not isinstance(actor, str) or not actor.strip():
            raise ContractError("actor is required: every change names who made it")
        return actor.strip()


# ───────────────────────────────────────────────────────────── route function


def _query(query: str) -> dict[str, str]:
    return {k: v[-1] for k, v in parse_qs(query or "").items()}


def _reason(body: Any, query: Mapping[str, str]) -> str:
    if isinstance(body, Mapping) and isinstance(body.get("reason"), str):
        return str(body["reason"])
    return query.get("reason", "")


def handle_agent_topology_request(
    service: AgentTopologyService,
    method: str,
    path: str,
    *,
    query: str = "",
    body: Any = None,
    actor: str,
) -> tuple[int, Any]:
    """Serve one ``/api/agent-topology*`` request. Returns ``(status, json_body)``.

    Errors use the Explorer envelope ``{"error": <message>, "details": None}``.
    A write answers with the change and the refreshed graph, so the view
    redraws from one round trip.
    """
    m = method.upper()
    if not path.startswith(AGENT_TOPOLOGY_PATH):
        return 404, {"error": "Not found", "details": None}
    rest = path[len(AGENT_TOPOLOGY_PATH):].strip("/")
    parts = [unquote(p) for p in rest.split("/")] if rest else []
    q = _query(query)
    try:
        if not parts:
            if m != "GET":
                return 405, {"error": f"Method {m} not allowed", "details": None}
            return 200, service.topology()
        if parts == ["events"]:
            if m != "GET":
                return 405, {"error": f"Method {m} not allowed", "details": None}
            try:
                limit = max(1, min(int(q.get("limit", "100")), 1000))
            except ValueError:
                raise ContractError("limit must be an integer") from None
            events = service.events(agent_id=q.get("agent") or None, bank_id=q.get("bank") or None, limit=limit)
            return 200, {"events": [e.to_dict() for e in events]}
        if len(parts) == 3 and parts[0] == "agents" and parts[2] == "mounts":
            if m != "GET":
                return 405, {"error": f"Method {m} not allowed", "details": None}
            return 200, service.mount_plan(parts[1]).to_dict()
        if parts == ["overrides"]:
            if m != "PUT":
                return 405, {"error": f"Method {m} not allowed", "details": None}
            if not isinstance(body, Mapping):
                raise ContractError("body must be a JSON object with agent_id, bank_id and access")
            result = service.set_override(
                str(body.get("agent_id", "")),
                str(body.get("bank_id", "")),
                str(body.get("access", "")),
                check_allowed_tools(body.get("allowed_tools")),
                actor=actor,
                reason=_reason(body, q),
            )
            return 200, {**result.to_dict(), "topology": service.topology()}
        if len(parts) == 3 and parts[0] == "overrides":
            if m != "DELETE":
                return 405, {"error": f"Method {m} not allowed", "details": None}
            result = service.clear_override(parts[1], parts[2], actor=actor, reason=_reason(body, q))
            return 200, {**result.to_dict(), "topology": service.topology()}
        return 404, {"error": "Not found", "details": None}
    except (UnknownAgentError, UnknownBankError) as exc:
        return 404, {"error": str(exc.args[0] if exc.args else exc), "details": None}
    except ContractError as exc:
        return 400, {"error": str(exc), "details": None}
    except Exception as exc:  # noqa: BLE001 - a store failure on a write
        return 503, {"error": f"Binding store error: {type(exc).__name__}: {exc}", "details": None}
