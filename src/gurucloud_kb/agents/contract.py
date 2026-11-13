"""The v1 agent <-> Knowledge Bank binding contract.

Plain frozen dataclasses (the SDK carries no validation library), each with a
``to_dict()`` / ``from_dict()`` pair that speaks the JSON wire shape every host
stores and every UI reads. ``from_dict`` validates and raises
:class:`ContractError` with the offending field named, so a host can turn bad
input into a 400 without its own checks.

Shapes (design: ``docs/planning/agent-kb-bindings/design.md``):

* :class:`BankRef` — one bank an agent may mount: where its MCP server lives and
  the *name* of the secret that authenticates it (never the value).
* :class:`Binding` — one agent's access to one bank: ``read``, ``read_write``,
  ``capture`` (writes held for review by the host) or ``removed``, plus an
  optional tool allowlist.
* :class:`AgentSpec` — an agent, its code baseline bindings and an optional
  parent it inherits bindings from. Prompts, models and schedules are
  deliberately out of v1.
* :class:`BindingOverride` — a stored deviation from the baseline.
* :class:`BindingOverrideEvent` — the audit row every set or clear writes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal, Mapping, Optional, Sequence, cast

CONTRACT_VERSION = 1

Access = Literal["read", "read_write", "capture", "removed"]
BankKind = Literal["domain", "playbook", "business"]
BindingSource = Literal["code", "override"]
EventAction = Literal["set", "clear"]

ACCESS_LEVELS: tuple[Access, ...] = ("read", "read_write", "capture", "removed")
BANK_KINDS: tuple[BankKind, ...] = ("domain", "playbook", "business")
BINDING_SOURCES: tuple[BindingSource, ...] = ("code", "override")
EVENT_ACTIONS: tuple[EventAction, ...] = ("set", "clear")

# Ids become MCP server names (``mcp__<id>__<tool>``) and URL path segments, so
# they stay within the characters both accept.
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


class ContractError(ValueError):
    """A payload does not match the v1 binding contract."""


# ─────────────────────────────────────────────────────────── field checkers


def _require_mapping(data: Any, what: str) -> Mapping[str, Any]:
    if not isinstance(data, Mapping):
        raise ContractError(f"{what} must be an object, got {type(data).__name__}")
    return cast("Mapping[str, Any]", data)


def _check_version(data: Mapping[str, Any], what: str) -> None:
    v = data.get("v", CONTRACT_VERSION)
    if v != CONTRACT_VERSION:
        raise ContractError(f"{what}.v must be {CONTRACT_VERSION}, got {v!r}")


def check_id(value: Any, name: str) -> str:
    """Return ``value`` if it is a valid agent or bank id, else raise."""
    if not isinstance(value, str) or not _ID_RE.match(value):
        raise ContractError(
            f"{name} must be 1-128 characters of letters, digits, '_', '-' or '.', "
            f"starting with a letter or digit; got {value!r}"
        )
    return value


def _req_str(data: Mapping[str, Any], key: str, what: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ContractError(f"{what}.{key} is required and must be a non-empty string")
    return value


def _opt_str(data: Mapping[str, Any], key: str, what: str) -> Optional[str]:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ContractError(f"{what}.{key} must be a string or null")
    return value


def check_access(value: Any, name: str = "access") -> Access:
    if value not in ACCESS_LEVELS:
        raise ContractError(f"{name} must be one of {', '.join(ACCESS_LEVELS)}; got {value!r}")
    return cast(Access, value)


def check_allowed_tools(value: Any, name: str = "allowed_tools") -> Optional[tuple[str, ...]]:
    """``None`` (no allowlist) or a de-duplicated, sorted tuple of tool names."""
    if value is None:
        return None
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise ContractError(f"{name} must be a list of tool names or null")
    tools: set[str] = set()
    for item in cast("Sequence[Any]", value):
        if not isinstance(item, str) or not item.strip():
            raise ContractError(f"{name} entries must be non-empty strings; got {item!r}")
        tools.add(item.strip())
    return tuple(sorted(tools))


def _check_literal(value: Any, allowed: tuple[str, ...], name: str) -> str:
    if value not in allowed:
        raise ContractError(f"{name} must be one of {', '.join(allowed)}; got {value!r}")
    return cast(str, value)


def _parse_time(value: Any, name: str) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str):
        raise ContractError(f"{name} must be an ISO-8601 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ContractError(f"{name} must be an ISO-8601 timestamp; got {value!r}") from exc
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


# ──────────────────────────────────────────────────────────────── the shapes


@dataclass(frozen=True)
class BankRef:
    """A Knowledge Bank an agent can mount.

    ``auth_ref`` names the secret (env var, vault key) that holds the bearer
    token; the host resolves it when it builds headers. ``description`` is what
    the agent is told the bank is for.
    """

    bank_id: str
    name: str
    mcp_url: str
    description: str = ""
    auth_ref: Optional[str] = None
    kind: BankKind = "domain"

    def __post_init__(self) -> None:
        check_id(self.bank_id, "bank_id")
        if not self.name.strip():
            raise ContractError("bank.name must be non-empty")
        if not self.mcp_url.startswith(("http://", "https://")):
            raise ContractError(f"bank.mcp_url must be an http(s) URL; got {self.mcp_url!r}")
        _check_literal(self.kind, BANK_KINDS, "bank.kind")

    def to_dict(self) -> dict[str, Any]:
        return {
            "v": CONTRACT_VERSION,
            "bank_id": self.bank_id,
            "name": self.name,
            "mcp_url": self.mcp_url,
            "description": self.description,
            "auth_ref": self.auth_ref,
            "kind": self.kind,
        }

    @classmethod
    def from_dict(cls, data: Any) -> "BankRef":
        d = _require_mapping(data, "bank")
        _check_version(d, "bank")
        return cls(
            bank_id=check_id(d.get("bank_id"), "bank.bank_id"),
            name=_req_str(d, "name", "bank"),
            mcp_url=_req_str(d, "mcp_url", "bank"),
            description=_opt_str(d, "description", "bank") or "",
            auth_ref=_opt_str(d, "auth_ref", "bank"),
            kind=cast(BankKind, _check_literal(d.get("kind", "domain"), BANK_KINDS, "bank.kind")),
        )


@dataclass(frozen=True)
class Binding:
    """One agent's access to one bank.

    ``allowed_tools`` narrows the bank's tools to a list (``None`` = every tool
    the access level permits). ``source`` says whether the value comes from the
    code baseline or a stored override.
    """

    agent_id: str
    bank_id: str
    access: Access
    allowed_tools: Optional[tuple[str, ...]] = None
    source: BindingSource = "code"

    def __post_init__(self) -> None:
        check_id(self.agent_id, "binding.agent_id")
        check_id(self.bank_id, "binding.bank_id")
        check_access(self.access, "binding.access")
        _check_literal(self.source, BINDING_SOURCES, "binding.source")
        # Normalise a list passed by hand into the sorted tuple from_dict builds.
        object.__setattr__(self, "allowed_tools", check_allowed_tools(self.allowed_tools, "binding.allowed_tools"))

    @property
    def key(self) -> tuple[str, str]:
        return (self.agent_id, self.bank_id)

    def same_value(self, other: Optional["Binding"]) -> bool:
        """True when ``other`` grants exactly the same access and tools."""
        return other is not None and self.access == other.access and self.allowed_tools == other.allowed_tools

    def to_dict(self) -> dict[str, Any]:
        return {
            "v": CONTRACT_VERSION,
            "agent_id": self.agent_id,
            "bank_id": self.bank_id,
            "access": self.access,
            "allowed_tools": list(self.allowed_tools) if self.allowed_tools is not None else None,
            "source": self.source,
        }

    @classmethod
    def from_dict(cls, data: Any) -> "Binding":
        d = _require_mapping(data, "binding")
        _check_version(d, "binding")
        return cls(
            agent_id=check_id(d.get("agent_id"), "binding.agent_id"),
            bank_id=check_id(d.get("bank_id"), "binding.bank_id"),
            access=check_access(d.get("access"), "binding.access"),
            allowed_tools=check_allowed_tools(d.get("allowed_tools"), "binding.allowed_tools"),
            source=cast(BindingSource, _check_literal(d.get("source", "code"), BINDING_SOURCES, "binding.source")),
        )


@dataclass(frozen=True)
class AgentSpec:
    """An agent and its code baseline.

    ``parent_id`` names an agent whose effective bindings this one inherits;
    the agent's own baseline wins per bank.
    """

    agent_id: str
    name: str
    parent_id: Optional[str] = None
    baseline: tuple[Binding, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        check_id(self.agent_id, "agent.agent_id")
        if not self.name.strip():
            raise ContractError("agent.name must be non-empty")
        if self.parent_id is not None:
            check_id(self.parent_id, "agent.parent_id")
            if self.parent_id == self.agent_id:
                raise ContractError(f"agent {self.agent_id!r} cannot be its own parent")
        baseline = tuple(self.baseline)
        seen: set[str] = set()
        for b in baseline:
            if b.agent_id != self.agent_id:
                raise ContractError(
                    f"agent {self.agent_id!r} baseline holds a binding for agent {b.agent_id!r}"
                )
            if b.bank_id in seen:
                raise ContractError(f"agent {self.agent_id!r} binds bank {b.bank_id!r} twice")
            seen.add(b.bank_id)
        object.__setattr__(self, "baseline", baseline)

    def to_dict(self) -> dict[str, Any]:
        return {
            "v": CONTRACT_VERSION,
            "agent_id": self.agent_id,
            "name": self.name,
            "parent_id": self.parent_id,
            "baseline": [b.to_dict() for b in self.baseline],
        }

    @classmethod
    def from_dict(cls, data: Any) -> "AgentSpec":
        d = _require_mapping(data, "agent")
        _check_version(d, "agent")
        agent_id = check_id(d.get("agent_id"), "agent.agent_id")
        raw = d.get("baseline") or []
        if not isinstance(raw, list):
            raise ContractError("agent.baseline must be a list")
        baseline: list[Binding] = []
        for item in cast("list[Any]", raw):
            item_d = dict(_require_mapping(item, "agent.baseline[]"))
            item_d.setdefault("agent_id", agent_id)
            item_d["source"] = "code"
            baseline.append(Binding.from_dict(item_d))
        parent = d.get("parent_id")
        return cls(
            agent_id=agent_id,
            name=_req_str(d, "name", "agent"),
            parent_id=check_id(parent, "agent.parent_id") if parent is not None else None,
            baseline=tuple(baseline),
        )


@dataclass(frozen=True)
class BindingOverride:
    """A stored deviation from an agent's baseline for one bank."""

    agent_id: str
    bank_id: str
    access: Access
    allowed_tools: Optional[tuple[str, ...]] = None
    actor: str = ""
    reason: str = ""
    updated_at: datetime = field(default_factory=utcnow)

    def __post_init__(self) -> None:
        check_id(self.agent_id, "override.agent_id")
        check_id(self.bank_id, "override.bank_id")
        check_access(self.access, "override.access")
        object.__setattr__(self, "allowed_tools", check_allowed_tools(self.allowed_tools, "override.allowed_tools"))

    @property
    def key(self) -> tuple[str, str]:
        return (self.agent_id, self.bank_id)

    def as_binding(self) -> Binding:
        return Binding(self.agent_id, self.bank_id, self.access, self.allowed_tools, source="override")

    def to_dict(self) -> dict[str, Any]:
        return {
            "v": CONTRACT_VERSION,
            "agent_id": self.agent_id,
            "bank_id": self.bank_id,
            "access": self.access,
            "allowed_tools": list(self.allowed_tools) if self.allowed_tools is not None else None,
            "actor": self.actor,
            "reason": self.reason,
            "updated_at": _iso(self.updated_at),
        }

    @classmethod
    def from_dict(cls, data: Any) -> "BindingOverride":
        d = _require_mapping(data, "override")
        _check_version(d, "override")
        return cls(
            agent_id=check_id(d.get("agent_id"), "override.agent_id"),
            bank_id=check_id(d.get("bank_id"), "override.bank_id"),
            access=check_access(d.get("access"), "override.access"),
            allowed_tools=check_allowed_tools(d.get("allowed_tools"), "override.allowed_tools"),
            actor=_opt_str(d, "actor", "override") or "",
            reason=_opt_str(d, "reason", "override") or "",
            updated_at=_parse_time(d.get("updated_at"), "override.updated_at") if d.get("updated_at") else utcnow(),
        )


def _state_dict(access: Optional[Access], tools: Optional[tuple[str, ...]]) -> Optional[dict[str, Any]]:
    if access is None:
        return None
    return {"access": access, "allowed_tools": list(tools) if tools is not None else None}


def _parse_state(value: Any, name: str) -> tuple[Optional[Access], Optional[tuple[str, ...]]]:
    if value is None:
        return None, None
    d = _require_mapping(value, name)
    return check_access(d.get("access"), f"{name}.access"), check_allowed_tools(d.get("allowed_tools"), f"{name}.allowed_tools")


@dataclass(frozen=True)
class BindingOverrideEvent:
    """Audit row for one set or clear of an override.

    ``old`` is the override before the change (``None`` = none was stored),
    ``new`` the override after it (``None`` = cleared), ``baseline`` what the
    agent inherits from code at that moment (``None`` = not bound in code).
    """

    event_id: str
    agent_id: str
    bank_id: str
    action: EventAction
    actor: str
    reason: str
    at: datetime
    old_access: Optional[Access] = None
    old_allowed_tools: Optional[tuple[str, ...]] = None
    new_access: Optional[Access] = None
    new_allowed_tools: Optional[tuple[str, ...]] = None
    baseline_access: Optional[Access] = None
    baseline_allowed_tools: Optional[tuple[str, ...]] = None

    def __post_init__(self) -> None:
        check_id(self.agent_id, "event.agent_id")
        check_id(self.bank_id, "event.bank_id")
        _check_literal(self.action, EVENT_ACTIONS, "event.action")
        if not self.event_id:
            raise ContractError("event.event_id is required")
        if not self.actor:
            raise ContractError("event.actor is required: every change names who made it")
        if self.action == "set" and self.new_access is None:
            raise ContractError("a 'set' event needs new_access")
        if self.action == "clear" and self.new_access is not None:
            raise ContractError("a 'clear' event cannot carry new_access")

    def to_dict(self) -> dict[str, Any]:
        return {
            "v": CONTRACT_VERSION,
            "event_id": self.event_id,
            "agent_id": self.agent_id,
            "bank_id": self.bank_id,
            "action": self.action,
            "actor": self.actor,
            "reason": self.reason,
            "at": _iso(self.at),
            "old": _state_dict(self.old_access, self.old_allowed_tools),
            "new": _state_dict(self.new_access, self.new_allowed_tools),
            "baseline": _state_dict(self.baseline_access, self.baseline_allowed_tools),
        }

    @classmethod
    def from_dict(cls, data: Any) -> "BindingOverrideEvent":
        d = _require_mapping(data, "event")
        _check_version(d, "event")
        old_a, old_t = _parse_state(d.get("old"), "event.old")
        new_a, new_t = _parse_state(d.get("new"), "event.new")
        base_a, base_t = _parse_state(d.get("baseline"), "event.baseline")
        return cls(
            event_id=_req_str(d, "event_id", "event"),
            agent_id=check_id(d.get("agent_id"), "event.agent_id"),
            bank_id=check_id(d.get("bank_id"), "event.bank_id"),
            action=cast(EventAction, _check_literal(d.get("action"), EVENT_ACTIONS, "event.action")),
            actor=_req_str(d, "actor", "event"),
            reason=_opt_str(d, "reason", "event") or "",
            at=_parse_time(d.get("at"), "event.at"),
            old_access=old_a,
            old_allowed_tools=old_t,
            new_access=new_a,
            new_allowed_tools=new_t,
            baseline_access=base_a,
            baseline_allowed_tools=base_t,
        )
