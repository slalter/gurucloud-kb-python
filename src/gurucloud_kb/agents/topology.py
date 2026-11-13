"""The agent / bank graph the Agents view draws.

:func:`build_topology` is pure: agents, banks and overrides in, one JSON
document out. Nodes are agents and banks; edges are bindings (agent -> bank,
with effective access, where it comes from and the baseline under it) and
inheritance (child -> parent). Each agent also carries its resolved mount plan
(headers never included), so the view can show what the agent really mounts.

An agent whose inheritance is broken (unknown parent, cycle) is listed in
``errors`` instead of failing the whole graph.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, Optional, Sequence

from gurucloud_kb.agents.contract import (
    ACCESS_LEVELS,
    CONTRACT_VERSION,
    AgentSpec,
    BankRef,
    Binding,
    BindingOverride,
    ContractError,
)
from gurucloud_kb.agents.resolve import inherited_baseline, resolve_mounts


def _state(binding: Optional[Binding]) -> Optional[dict[str, Any]]:
    if binding is None:
        return None
    return {
        "access": binding.access,
        "allowed_tools": list(binding.allowed_tools) if binding.allowed_tools is not None else None,
    }


def agent_node_id(agent_id: str) -> str:
    return f"agent:{agent_id}"


def bank_node_id(bank_id: str) -> str:
    return f"bank:{bank_id}"


def build_topology(
    agents: Iterable[AgentSpec],
    banks: Iterable[BankRef],
    overrides: Iterable[BindingOverride] = (),
    *,
    available_tools: Optional[Mapping[str, Sequence[str]]] = None,
    store_error: Optional[str] = None,
) -> dict[str, Any]:
    """Graph JSON for the Agents view (``GET /api/agent-topology``)."""
    agent_list = sorted(agents, key=lambda a: a.agent_id)
    bank_list = sorted(banks, key=lambda b: b.bank_id)
    by_agent = {a.agent_id: a for a in agent_list}
    bank_ids = {b.bank_id for b in bank_list}
    override_list = list(overrides)
    ov_by_key = {o.key: o for o in override_list}

    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    plans: dict[str, Any] = {}
    errors: list[dict[str, str]] = []

    for bank in bank_list:
        nodes.append(
            {
                "id": bank_node_id(bank.bank_id),
                "type": "bank",
                "bank_id": bank.bank_id,
                "label": bank.name,
                "kind": bank.kind,
                "description": bank.description,
                "mcp_url": bank.mcp_url,
                "auth_ref": bank.auth_ref,
            }
        )

    for agent in agent_list:
        nodes.append(
            {
                "id": agent_node_id(agent.agent_id),
                "type": "agent",
                "agent_id": agent.agent_id,
                "label": agent.name,
                "parent_id": agent.parent_id,
            }
        )
        if agent.parent_id is not None and agent.parent_id in by_agent:
            edges.append(
                {
                    "id": f"inherits:{agent.agent_id}:{agent.parent_id}",
                    "type": "inherits",
                    "source": agent_node_id(agent.agent_id),
                    "target": agent_node_id(agent.parent_id),
                }
            )
        try:
            baseline = inherited_baseline(agent, by_agent)
        except ContractError as exc:
            errors.append({"agent_id": agent.agent_id, "error": str(exc)})
            continue
        own = {b.bank_id for b in agent.baseline}
        bank_keys = set(baseline) | {bank for (aid, bank) in ov_by_key if aid == agent.agent_id}
        for bank_id in sorted(bank_keys):
            base = baseline.get(bank_id)
            ov = ov_by_key.get((agent.agent_id, bank_id))
            effective = ov.as_binding() if ov is not None else base
            if effective is None:  # pragma: no cover - bank_keys only holds bound banks
                continue
            edges.append(
                {
                    "id": f"bind:{agent.agent_id}:{bank_id}",
                    "type": "binding",
                    "source": agent_node_id(agent.agent_id),
                    "target": bank_node_id(bank_id),
                    "agent_id": agent.agent_id,
                    "bank_id": bank_id,
                    "access": effective.access,
                    "allowed_tools": list(effective.allowed_tools) if effective.allowed_tools is not None else None,
                    "origin": "override" if ov is not None else ("own" if bank_id in own else "inherited"),
                    "baseline": _state(base),
                    "override": ov.to_dict() if ov is not None else None,
                    "bank_known": bank_id in bank_ids,
                }
            )
        plans[agent.agent_id] = resolve_mounts(
            agent, bank_list, override_list, agents=by_agent, available_tools=available_tools
        ).to_dict()

    return {
        "v": CONTRACT_VERSION,
        "access_levels": list(ACCESS_LEVELS),
        "nodes": nodes,
        "edges": edges,
        "plans": plans,
        "errors": errors,
        "overrides_applied": store_error is None,
        "store_error": store_error,
    }
