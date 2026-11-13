"""Load a host's agents and banks from one JSON document.

The shape (``v: 1``) is what ``gurucloud-kb ui --agents FILE`` reads, and a
convenient way for any host to keep its registry as data::

    {
      "v": 1,
      "banks":  [{"bank_id": "ops", "name": "Ops KB", "mcp_url": "https://.../mcp", "auth_ref": "OPS_KB_TOKEN"}],
      "agents": [{"agent_id": "triage", "name": "Triage", "baseline": [{"bank_id": "ops", "access": "read"}]}],
      "overrides": []
    }

Every agent id and bank id must be unique; overrides may only name agents and
banks the document declares.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Union, cast

from gurucloud_kb.agents.contract import (
    CONTRACT_VERSION,
    AgentSpec,
    BankRef,
    BindingOverride,
    ContractError,
)


@dataclass(frozen=True)
class AgentRegistry:
    """Agents, banks and seed overrides parsed from one document."""

    agents: tuple[AgentSpec, ...]
    banks: tuple[BankRef, ...]
    overrides: tuple[BindingOverride, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "v": CONTRACT_VERSION,
            "banks": [b.to_dict() for b in self.banks],
            "agents": [a.to_dict() for a in self.agents],
            "overrides": [o.to_dict() for o in self.overrides],
        }


def _list(data: Mapping[str, Any], key: str) -> list[Any]:
    value = data.get(key) or []
    if not isinstance(value, list):
        raise ContractError(f"registry.{key} must be a list")
    return cast("list[Any]", value)


def parse_registry(data: Any) -> AgentRegistry:
    """Validate a registry document (already decoded from JSON)."""
    if not isinstance(data, Mapping):
        raise ContractError("registry must be a JSON object")
    doc = cast("Mapping[str, Any]", data)
    if doc.get("v", CONTRACT_VERSION) != CONTRACT_VERSION:
        raise ContractError(f"registry.v must be {CONTRACT_VERSION}")
    banks = [BankRef.from_dict(b) for b in _list(doc, "banks")]
    agents = [AgentSpec.from_dict(a) for a in _list(doc, "agents")]
    overrides = [BindingOverride.from_dict(o) for o in _list(doc, "overrides")]
    bank_ids = [b.bank_id for b in banks]
    agent_ids = [a.agent_id for a in agents]
    for kind, ids in (("bank", bank_ids), ("agent", agent_ids)):
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        if dupes:
            raise ContractError(f"duplicate {kind} id(s): {', '.join(dupes)}")
    known_agents, known_banks = set(agent_ids), set(bank_ids)
    for a in agents:
        if a.parent_id is not None and a.parent_id not in known_agents:
            raise ContractError(f"agent {a.agent_id!r} names unknown parent {a.parent_id!r}")
    for o in overrides:
        if o.agent_id not in known_agents or o.bank_id not in known_banks:
            raise ContractError(f"override {o.agent_id!r} -> {o.bank_id!r} names an unknown agent or bank")
    return AgentRegistry(tuple(agents), tuple(banks), tuple(overrides))


def load_registry(source: Union[str, Path]) -> AgentRegistry:
    """Read and validate a registry JSON file."""
    try:
        data = json.loads(Path(source).read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ContractError(f"registry file is not valid JSON: {exc}") from exc
    return parse_registry(data)
