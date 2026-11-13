"""Turn an agent's bindings into the MCP mounts for one Agent SDK turn.

Resolution order for one agent:

1. the parent chain's code baseline (root first), re-keyed to this agent;
2. the agent's own code baseline, which wins per bank;
3. stored overrides for *this* agent, which win per bank. Overrides never
   inherit: an override on a parent changes the parent only.

:func:`resolve_mounts` then builds the Claude Agent SDK ``mcp_servers`` dict
(one ``http`` server per mounted bank, named by ``bank_id``) and a
``disallowed_tools`` list of fully qualified ``mcp__<bank_id>__<tool>`` names:

* ``read`` and ``capture`` deny every write tool (:data:`WRITE_TOOLS`);
* an ``allowed_tools`` list denies every other tool the bank serves;
* ``removed`` is not mounted at all;
* ``capture`` banks are listed in :attr:`MountPlan.capture_banks` so the host
  can wrap them with its own held-write server.

A binding to a bank the host did not pass is not mounted (fail closed) and is
reported in :attr:`MountPlan.missing_banks`. :func:`resolve_mounts_from_store`
falls back to the baseline when the override store cannot be read.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any, Callable, Iterable, Mapping, Optional, Sequence, Union, cast

from gurucloud_kb.agents.contract import (
    CONTRACT_VERSION,
    AgentSpec,
    BankRef,
    Binding,
    BindingOverride,
    ContractError,
)

WRITE_TOOLS: frozenset[str] = frozenset(
    {
        "report_learning",
        "edit_kb_entry",
        "delete_kb_entry",
        "upsert_playbook",
        "delete_playbook",
        "link_kb_entries",
        "unlink_kb_entries",
        "document_process",
        "retire_process",
    }
)
"""KB MCP tools that change a bank. Denied on ``read`` and ``capture`` mounts."""

AgentsArg = Union[Mapping[str, AgentSpec], Iterable[AgentSpec], None]
BanksArg = Union[Mapping[str, BankRef], Iterable[BankRef]]
HeadersFor = Callable[[BankRef], Optional[Mapping[str, str]]]


def _agents_by_id(agents: AgentsArg) -> dict[str, AgentSpec]:
    if agents is None:
        return {}
    if isinstance(agents, Mapping):
        return dict(cast("Mapping[str, AgentSpec]", agents))
    return {a.agent_id: a for a in agents}


def _banks_by_id(banks: BanksArg) -> dict[str, BankRef]:
    if isinstance(banks, Mapping):
        return dict(cast("Mapping[str, BankRef]", banks))
    return {b.bank_id: b for b in banks}


def available_tools_from_definition(definition: Mapping[str, Any]) -> tuple[str, ...]:
    """The tool names a bank serves, from ``kb.get_mcp_server_definition()``."""
    tools = definition.get("available_tools") or []
    return tuple(sorted({str(t) for t in tools if t}))


def inherited_baseline(agent: AgentSpec, agents: AgentsArg = None) -> dict[str, Binding]:
    """The agent's code baseline per bank, parents first, own bindings winning.

    Raises :class:`ContractError` on an unknown parent or an inheritance cycle.
    """
    by_id = _agents_by_id(agents)
    chain: list[AgentSpec] = [agent]
    seen = {agent.agent_id}
    current = agent
    while current.parent_id is not None:
        parent = by_id.get(current.parent_id)
        if parent is None:
            raise ContractError(f"agent {current.agent_id!r} names unknown parent {current.parent_id!r}")
        if parent.agent_id in seen:
            raise ContractError(f"inheritance cycle through agent {parent.agent_id!r}")
        seen.add(parent.agent_id)
        chain.append(parent)
        current = parent
    result: dict[str, Binding] = {}
    for spec in reversed(chain):  # root first, so the agent's own wins last
        for b in spec.baseline:
            result[b.bank_id] = Binding(agent.agent_id, b.bank_id, b.access, b.allowed_tools, source="code")
    return result


def effective_bindings(
    agent: AgentSpec,
    overrides: Iterable[BindingOverride] = (),
    *,
    agents: AgentsArg = None,
) -> dict[str, Binding]:
    """Every binding of ``agent`` keyed by bank id, ``removed`` ones included."""
    result = inherited_baseline(agent, agents)
    for ov in overrides:
        if ov.agent_id == agent.agent_id:
            result[ov.bank_id] = ov.as_binding()
    return dict(sorted(result.items()))


@dataclass(frozen=True)
class MountPlan:
    """What one agent mounts for one turn.

    ``mcp_servers`` and ``disallowed_tools`` go straight into the Claude Agent
    SDK options. ``bindings`` is every effective binding (``removed`` included),
    for display and audit.
    """

    agent_id: str
    mcp_servers: dict[str, dict[str, Any]]
    disallowed_tools: tuple[str, ...]
    bindings: tuple[Binding, ...]
    capture_banks: tuple[str, ...] = ()
    missing_banks: tuple[str, ...] = ()
    unenforced_allowlists: tuple[str, ...] = ()
    overrides_applied: bool = True
    store_error: Optional[str] = None
    warnings: tuple[str, ...] = field(default_factory=tuple)

    def to_dict(self, *, redact_headers: bool = True) -> dict[str, Any]:
        """JSON shape. Header values are masked unless ``redact_headers=False``."""
        servers: dict[str, dict[str, Any]] = {}
        for name, cfg in self.mcp_servers.items():
            cfg_out = dict(cfg)
            if redact_headers and "headers" in cfg_out:
                cfg_out["headers"] = {k: "***" for k in cfg_out["headers"]}
            servers[name] = cfg_out
        return {
            "v": CONTRACT_VERSION,
            "agent_id": self.agent_id,
            "mcp_servers": servers,
            "disallowed_tools": list(self.disallowed_tools),
            "bindings": [b.to_dict() for b in self.bindings],
            "capture_banks": list(self.capture_banks),
            "missing_banks": list(self.missing_banks),
            "unenforced_allowlists": list(self.unenforced_allowlists),
            "overrides_applied": self.overrides_applied,
            "store_error": self.store_error,
            "warnings": list(self.warnings),
        }


def mcp_tool_name(bank_id: str, tool: str) -> str:
    """The fully qualified tool name the Agent SDK uses for a bank's tool."""
    return f"mcp__{bank_id}__{tool}"


def denied_tools(
    binding: Binding,
    available: Optional[Sequence[str]],
    write_tools: frozenset[str] = WRITE_TOOLS,
) -> tuple[set[str], bool]:
    """Bare tool names denied on one mount, and whether its allowlist is enforced.

    Without ``available`` (the bank's tool list) an allowlist can only deny the
    write tools it leaves out, so it is reported as not fully enforced.
    """
    known = set(available) if available is not None else None
    deny: set[str] = set()
    if binding.access in ("read", "capture"):
        deny |= (write_tools & known) if known is not None else set(write_tools)
    enforced = True
    if binding.allowed_tools is not None:
        allowed = set(binding.allowed_tools)
        if known is not None:
            deny |= known - allowed
        else:
            deny |= set(write_tools) - allowed
            enforced = False
    return deny, enforced


def resolve_mounts(
    agent: AgentSpec,
    banks: BanksArg,
    overrides: Iterable[BindingOverride] = (),
    *,
    agents: AgentsArg = None,
    available_tools: Optional[Mapping[str, Sequence[str]]] = None,
    headers_for: Optional[HeadersFor] = None,
    write_tools: frozenset[str] = WRITE_TOOLS,
) -> MountPlan:
    """Build the mount plan for ``agent``.

    Args:
        agent: The agent to mount for.
        banks: Every bank the host knows (``BankRef`` list or dict by id).
        overrides: Stored overrides (other agents' rows are ignored).
        agents: Every agent, for parent lookup (needed when ``agent`` has a parent).
        available_tools: Per bank id, the tools its MCP server serves (from
            :func:`available_tools_from_definition`). Without it, allowlists
            are only partly enforced and the plan says so.
        headers_for: Returns the HTTP headers for a bank (resolve its
            ``auth_ref`` to a bearer token here). ``None`` = no headers.
        write_tools: Override the write-tool set (rarely needed).
    """
    bank_map = _banks_by_id(banks)
    bindings = effective_bindings(agent, overrides, agents=agents)
    servers: dict[str, dict[str, Any]] = {}
    deny_all: set[str] = set()
    capture: list[str] = []
    missing: list[str] = []
    unenforced: list[str] = []
    for bank_id, binding in bindings.items():
        if binding.access == "removed":
            continue
        bank = bank_map.get(bank_id)
        if bank is None:
            missing.append(bank_id)
            continue
        cfg: dict[str, Any] = {"type": "http", "url": bank.mcp_url}
        headers = dict(headers_for(bank) or {}) if headers_for else {}
        if headers:
            cfg["headers"] = headers
        servers[bank_id] = cfg
        avail = available_tools.get(bank_id) if available_tools is not None else None
        deny, enforced = denied_tools(binding, avail, write_tools)
        deny_all |= {mcp_tool_name(bank_id, t) for t in deny}
        if not enforced:
            unenforced.append(bank_id)
        if binding.access == "capture":
            capture.append(bank_id)
    warnings = [f"binding to unknown bank {b!r} not mounted" for b in missing]
    warnings += [f"allowlist on {b!r} only denies write tools: pass available_tools to enforce it" for b in unenforced]
    return MountPlan(
        agent_id=agent.agent_id,
        mcp_servers=servers,
        disallowed_tools=tuple(sorted(deny_all)),
        bindings=tuple(bindings.values()),
        capture_banks=tuple(capture),
        missing_banks=tuple(missing),
        unenforced_allowlists=tuple(unenforced),
        warnings=tuple(warnings),
    )


def resolve_mounts_from_store(
    agent: AgentSpec,
    banks: BanksArg,
    store: Any,
    **kwargs: Any,
) -> MountPlan:
    """:func:`resolve_mounts` with overrides read from a :class:`BindingStore`.

    If the store raises, the plan falls back to the code baseline and carries
    ``overrides_applied=False`` and ``store_error`` so the host can log it.
    """
    try:
        overrides = list(store.list_overrides())
    except Exception as exc:  # noqa: BLE001 - any store failure falls back to baseline
        plan = resolve_mounts(agent, banks, (), **kwargs)
        return replace(
            plan,
            overrides_applied=False,
            store_error=f"{type(exc).__name__}: {exc}",
            warnings=plan.warnings + ("override store unreadable: baseline mounts used",),
        )
    return resolve_mounts(agent, banks, overrides, **kwargs)
