"""gurucloud_kb.agents.resolve: effective bindings and the Agent SDK mount plan."""
from __future__ import annotations

import pytest

from gurucloud_kb.agents import (
    WRITE_TOOLS,
    AgentSpec,
    BankRef,
    Binding,
    BindingOverride,
    ContractError,
    InMemoryBindingStore,
    available_tools_from_definition,
    effective_bindings,
    resolve_mounts,
    resolve_mounts_from_store,
)

OPS = BankRef("ops", "Ops", "https://kb.example/ops/mcp", auth_ref="OPS_TOKEN")
PLAY = BankRef("play", "Playbooks", "https://kb.example/play/mcp", kind="playbook")
BIZ = BankRef("biz", "Business", "https://kb.example/biz/mcp", kind="business")
BANKS = [OPS, PLAY, BIZ]
TOOLS = {
    "ops": ["search", "get_entry", "report_learning", "edit_kb_entry", "delete_kb_entry"],
    "play": ["get_playbook", "list_playbooks", "upsert_playbook"],
    "biz": ["search", "report_learning"],
}

BASE = AgentSpec("base", "Base", baseline=(Binding("base", "ops", "read"), Binding("base", "play", "read_write")))
CHILD = AgentSpec("child", "Child", parent_id="base", baseline=(Binding("child", "ops", "read_write"), Binding("child", "biz", "capture")))
AGENTS = [BASE, CHILD]


def test_child_inherits_parent_and_own_baseline_wins():
    eff = effective_bindings(CHILD, agents=AGENTS)
    assert {k: (b.agent_id, b.access, b.source) for k, b in eff.items()} == {
        "biz": ("child", "capture", "code"),
        "ops": ("child", "read_write", "code"),
        "play": ("child", "read_write", "code"),
    }


def test_override_wins_and_only_for_its_own_agent():
    overrides = [
        BindingOverride("child", "play", "removed", actor="alice"),
        BindingOverride("base", "ops", "removed", actor="alice"),  # parent override does not inherit
    ]
    eff = effective_bindings(CHILD, overrides, agents=AGENTS)
    assert eff["play"] == Binding("child", "play", "removed", source="override")
    assert eff["ops"].access == "read_write"


def test_unknown_parent_and_cycles_are_contract_errors():
    with pytest.raises(ContractError, match="unknown parent"):
        effective_bindings(CHILD)  # parent not passed
    a = AgentSpec("a", "A", parent_id="b")
    b = AgentSpec("b", "B", parent_id="a")
    with pytest.raises(ContractError, match="cycle"):
        effective_bindings(a, agents=[a, b])


def test_mount_plan_with_known_tools():
    plan = resolve_mounts(
        CHILD,
        BANKS,
        [BindingOverride("child", "play", "read", ("get_playbook",), actor="alice")],
        agents=AGENTS,
        available_tools=TOOLS,
        headers_for=lambda bank: {"Authorization": f"Bearer <{bank.auth_ref}>"} if bank.auth_ref else None,
    )
    assert plan.mcp_servers == {
        "biz": {"type": "http", "url": "https://kb.example/biz/mcp"},
        "ops": {"type": "http", "url": "https://kb.example/ops/mcp", "headers": {"Authorization": "Bearer <OPS_TOKEN>"}},
        "play": {"type": "http", "url": "https://kb.example/play/mcp"},
    }
    # biz capture: its one write tool denied; play read + allowlist: everything but get_playbook denied.
    assert plan.disallowed_tools == (
        "mcp__biz__report_learning",
        "mcp__play__list_playbooks",
        "mcp__play__upsert_playbook",
    )
    assert plan.capture_banks == ("biz",)
    assert plan.unenforced_allowlists == () and plan.missing_banks == () and plan.warnings == ()
    assert plan.to_dict()["mcp_servers"]["ops"]["headers"] == {"Authorization": "***"}
    assert plan.to_dict(redact_headers=False)["mcp_servers"]["ops"]["headers"] == {"Authorization": "Bearer <OPS_TOKEN>"}


def test_mount_plan_without_tool_lists_denies_every_write_tool_and_flags_allowlists():
    agent = AgentSpec("r", "Reader", baseline=(Binding("r", "ops", "read"), Binding("r", "play", "read_write", ("get_playbook", "upsert_playbook"))))
    plan = resolve_mounts(agent, BANKS)
    ops_denied = {t.split("__")[2] for t in plan.disallowed_tools if t.startswith("mcp__ops__")}
    play_denied = {t.split("__")[2] for t in plan.disallowed_tools if t.startswith("mcp__play__")}
    assert ops_denied == set(WRITE_TOOLS)
    assert play_denied == set(WRITE_TOOLS) - {"upsert_playbook"}
    assert plan.unenforced_allowlists == ("play",)
    assert any("pass available_tools" in w for w in plan.warnings)


def test_removed_is_not_mounted_and_unknown_bank_fails_closed():
    agent = AgentSpec("x", "X", baseline=(Binding("x", "ops", "removed"), Binding("x", "ghost", "read_write")))
    plan = resolve_mounts(agent, BANKS, available_tools=TOOLS)
    assert plan.mcp_servers == {}
    assert plan.missing_banks == ("ghost",)
    assert [b.bank_id for b in plan.bindings] == ["ghost", "ops"]


def test_store_failure_falls_back_to_baseline():
    class Broken(InMemoryBindingStore):
        def list_overrides(self):
            raise RuntimeError("db down")

    plan = resolve_mounts_from_store(CHILD, BANKS, Broken(), agents=AGENTS, available_tools=TOOLS)
    assert plan.overrides_applied is False and plan.store_error == "RuntimeError: db down"
    assert set(plan.mcp_servers) == {"biz", "ops", "play"}
    assert "baseline mounts used" in plan.warnings[-1]

    store = InMemoryBindingStore([BindingOverride("child", "ops", "removed", actor="a")])
    ok = resolve_mounts_from_store(CHILD, BANKS, store, agents=AGENTS)
    assert ok.overrides_applied and "ops" not in ok.mcp_servers


def test_available_tools_from_definition():
    assert available_tools_from_definition({"available_tools": ["search", "get_entry", "search", ""]}) == ("get_entry", "search")
    assert available_tools_from_definition({}) == ()
