"""gurucloud_kb.agents.topology + registry: the graph document and the registry file."""
from __future__ import annotations

import json

import pytest

from gurucloud_kb.agents import (
    AgentSpec,
    BankRef,
    Binding,
    BindingOverride,
    ContractError,
    build_topology,
    load_registry,
    parse_registry,
)

BANKS = [BankRef("ops", "Ops", "https://kb.example/ops/mcp", auth_ref="OPS_TOKEN"), BankRef("play", "Play", "https://kb.example/play/mcp", kind="playbook")]
AGENTS = [
    AgentSpec("base", "Base", baseline=(Binding("base", "ops", "read"), Binding("base", "play", "read_write"))),
    AgentSpec("child", "Child", parent_id="base", baseline=(Binding("child", "ops", "read_write"),)),
    AgentSpec("orphan", "Orphan", parent_id="missing"),
]


def _edges(topo, kind):
    return {e["id"]: e for e in topo["edges"] if e["type"] == kind}


def test_nodes_edges_origins_and_plans():
    topo = build_topology(AGENTS, BANKS, [BindingOverride("child", "play", "removed", actor="alice", reason="noisy")])
    ids = {n["id"]: n for n in topo["nodes"]}
    assert ids["bank:ops"]["auth_ref"] == "OPS_TOKEN" and ids["agent:child"]["parent_id"] == "base"

    binds = _edges(topo, "binding")
    assert binds["bind:child:ops"]["origin"] == "own" and binds["bind:child:ops"]["baseline"] == {"access": "read_write", "allowed_tools": None}
    play = binds["bind:child:play"]
    assert play["origin"] == "override" and play["access"] == "removed"
    assert play["baseline"]["access"] == "read_write" and play["override"]["actor"] == "alice"
    assert binds["bind:base:ops"]["origin"] == "own"
    assert list(_edges(topo, "inherits")) == ["inherits:child:base"]

    assert set(topo["plans"]) == {"base", "child"}
    assert set(topo["plans"]["child"]["mcp_servers"]) == {"ops"}
    assert topo["overrides_applied"] is True and topo["store_error"] is None


def test_broken_inheritance_is_reported_not_fatal():
    topo = build_topology(AGENTS, BANKS)
    assert topo["errors"] == [{"agent_id": "orphan", "error": "agent 'orphan' names unknown parent 'missing'"}]
    assert "agent:orphan" in {n["id"] for n in topo["nodes"]}
    assert "orphan" not in topo["plans"]


def test_inherited_binding_and_override_on_unknown_bank():
    agents = [AgentSpec("p", "P", baseline=(Binding("p", "ghost", "read"),)), AgentSpec("c", "C", parent_id="p")]
    topo = build_topology(agents, BANKS, [BindingOverride("c", "ops", "capture", actor="a")])
    binds = _edges(topo, "binding")
    assert binds["bind:c:ghost"]["origin"] == "inherited" and binds["bind:c:ghost"]["bank_known"] is False
    assert binds["bind:c:ops"]["origin"] == "override" and binds["bind:c:ops"]["baseline"] is None
    assert topo["plans"]["c"]["missing_banks"] == ["ghost"]


REG = {
    "v": 1,
    "banks": [b.to_dict() for b in BANKS],
    "agents": [{"agent_id": "a", "name": "A", "baseline": [{"bank_id": "ops", "access": "read"}]}],
    "overrides": [{"agent_id": "a", "bank_id": "play", "access": "read", "actor": "seed"}],
}


def test_registry_round_trip_and_file_load(tmp_path):
    reg = parse_registry(REG)
    assert [a.agent_id for a in reg.agents] == ["a"] and len(reg.banks) == 2 and reg.overrides[0].actor == "seed"
    path = tmp_path / "r.json"
    path.write_text(json.dumps(reg.to_dict()))
    assert load_registry(path) == reg
    path.write_text("{nope")
    with pytest.raises(ContractError, match="not valid JSON"):
        load_registry(path)


@pytest.mark.parametrize(
    "mutate, msg",
    [
        (lambda r: r.update(v=9), "registry.v"),
        (lambda r: r.update(banks=r["banks"] * 2), "duplicate bank"),
        (lambda r: r.update(agents=r["agents"] * 2), "duplicate agent"),
        (lambda r: r.update(agents=[{"agent_id": "a", "name": "A", "parent_id": "zz"}]), "unknown parent"),
        (lambda r: r.update(overrides=[{"agent_id": "zz", "bank_id": "ops", "access": "read"}]), "unknown agent or bank"),
        (lambda r: r.update(banks={"x": 1}), "must be a list"),
    ],
)
def test_registry_rejects_inconsistent_documents(mutate, msg):
    doc = json.loads(json.dumps(REG))
    mutate(doc)
    with pytest.raises(ContractError, match=msg):
        parse_registry(doc)
    with pytest.raises(ContractError, match="JSON object"):
        parse_registry([])
