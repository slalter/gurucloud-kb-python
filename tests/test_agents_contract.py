"""gurucloud_kb.agents.contract: the v1 wire shapes and their validation."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, cast

import pytest

from gurucloud_kb.agents import (
    AgentSpec,
    BankRef,
    Binding,
    BindingOverride,
    BindingOverrideEvent,
    ContractError,
)

AT = datetime(2026, 11, 12, 10, 0, tzinfo=timezone.utc)


def test_bank_round_trips_and_defaults_kind():
    bank = BankRef.from_dict({"bank_id": "ops", "name": "Ops", "mcp_url": "https://kb.example/ops/mcp", "auth_ref": "OPS_TOKEN"})
    assert bank.kind == "domain" and bank.description == ""
    assert BankRef.from_dict(bank.to_dict()) == bank
    assert bank.to_dict()["v"] == 1


@pytest.mark.parametrize(
    "payload, field",
    [
        ({"bank_id": "has space", "name": "x", "mcp_url": "https://a"}, "bank_id"),
        ({"bank_id": "ok", "name": "", "mcp_url": "https://a"}, "name"),
        ({"bank_id": "ok", "name": "x", "mcp_url": "ftp://a"}, "mcp_url"),
        ({"bank_id": "ok", "name": "x", "mcp_url": "https://a", "kind": "secret"}, "kind"),
        ({"v": 2, "bank_id": "ok", "name": "x", "mcp_url": "https://a"}, "v"),
        ("not-an-object", "object"),
    ],
)
def test_bank_rejects_bad_payloads_naming_the_field(payload, field):
    with pytest.raises(ContractError, match=field):
        BankRef.from_dict(payload)


def test_binding_normalises_allowed_tools_and_compares_values():
    # A hand-built list (not the declared tuple) is normalised: the case from_dict never sends.
    b = Binding("a1", "ops", "read", cast(Any, ["search", "search", " get_entry "]))
    assert b.allowed_tools == ("get_entry", "search")
    assert b.same_value(Binding("a1", "ops", "read", ("search", "get_entry"), source="override"))
    assert not b.same_value(Binding("a1", "ops", "read"))
    assert not b.same_value(None)
    assert Binding.from_dict(b.to_dict()) == b


@pytest.mark.parametrize(
    "payload",
    [
        {"agent_id": "a", "bank_id": "b", "access": "admin"},
        {"agent_id": "a", "bank_id": "b", "access": "read", "allowed_tools": "search"},
        {"agent_id": "a", "bank_id": "b", "access": "read", "allowed_tools": [""]},
        {"agent_id": "a", "bank_id": "b", "access": "read", "source": "magic"},
    ],
)
def test_binding_rejects_bad_values(payload):
    with pytest.raises(ContractError):
        Binding.from_dict(payload)


def test_agent_from_dict_fills_agent_id_and_forces_code_source():
    agent = AgentSpec.from_dict(
        {"agent_id": "triage", "name": "Triage", "baseline": [{"bank_id": "ops", "access": "read", "source": "override"}]}
    )
    assert agent.baseline == (Binding("triage", "ops", "read", source="code"),)
    assert AgentSpec.from_dict(agent.to_dict()) == agent


def test_agent_rejects_duplicate_bank_foreign_binding_and_self_parent():
    with pytest.raises(ContractError, match="twice"):
        AgentSpec("a", "A", baseline=(Binding("a", "ops", "read"), Binding("a", "ops", "read_write")))
    with pytest.raises(ContractError, match="binding for agent"):
        AgentSpec("a", "A", baseline=(Binding("b", "ops", "read"),))
    with pytest.raises(ContractError, match="own parent"):
        AgentSpec("a", "A", parent_id="a")
    with pytest.raises(ContractError, match="baseline must be a list"):
        AgentSpec.from_dict({"agent_id": "a", "name": "A", "baseline": {"bank_id": "ops"}})


def test_override_round_trips_with_utc_timestamp():
    ov = BindingOverride("a", "ops", "removed", actor="alice", reason="noisy", updated_at=AT)
    d = ov.to_dict()
    assert d["updated_at"] == "2026-11-12T10:00:00Z"
    assert BindingOverride.from_dict(d) == ov
    assert ov.as_binding() == Binding("a", "ops", "removed", source="override")
    with pytest.raises(ContractError, match="timestamp"):
        BindingOverride.from_dict({**d, "updated_at": "yesterday"})


def test_event_requires_actor_and_consistent_action():
    base: dict[str, Any] = dict(event_id="e1", agent_id="a", bank_id="ops", reason="", at=AT)
    with pytest.raises(ContractError, match="actor"):
        BindingOverrideEvent(action="set", actor="", new_access="read", **base)
    with pytest.raises(ContractError, match="needs new_access"):
        BindingOverrideEvent(action="set", actor="alice", **base)
    with pytest.raises(ContractError, match="cannot carry new_access"):
        BindingOverrideEvent(action="clear", actor="alice", new_access="read", **base)
    ev = BindingOverrideEvent(
        action="set", actor="alice", old_access="read", new_access="read_write",
        new_allowed_tools=("search",), baseline_access="read", **base,
    )
    d = ev.to_dict()
    assert d["old"] == {"access": "read", "allowed_tools": None}
    assert d["new"] == {"access": "read_write", "allowed_tools": ["search"]}
    assert BindingOverrideEvent.from_dict(d) == ev
