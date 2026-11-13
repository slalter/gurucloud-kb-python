"""gurucloud_kb.agents.service + store: the binding rules and the route function."""
from __future__ import annotations

import itertools
from datetime import datetime, timedelta, timezone

import pytest

from gurucloud_kb.agents import (
    AgentSpec,
    AgentTopologyService,
    BankRef,
    Binding,
    BindingStore,
    ContractError,
    InMemoryBindingStore,
    UnknownAgentError,
    UnknownBankError,
    handle_agent_topology_request,
)

BANKS = [BankRef("ops", "Ops", "https://kb.example/ops/mcp"), BankRef("biz", "Biz", "https://kb.example/biz/mcp")]
AGENTS = [
    AgentSpec("base", "Base", baseline=(Binding("base", "ops", "read"),)),
    AgentSpec("child", "Child", parent_id="base"),
]


@pytest.fixture
def svc():
    t0 = datetime(2026, 11, 12, tzinfo=timezone.utc)
    ticks = itertools.count()
    ids = itertools.count(1)
    return AgentTopologyService(
        AGENTS, BANKS, InMemoryBindingStore(),
        clock=lambda: t0 + timedelta(minutes=next(ticks)),
        new_event_id=lambda: f"ev{next(ids)}",
    )


def test_in_memory_store_satisfies_the_protocol():
    assert isinstance(InMemoryBindingStore(), BindingStore)


def test_set_writes_override_and_event(svc):
    res = svc.set_override("child", "ops", "read_write", actor="alice", reason="needs to learn")
    assert res.action == "set"
    assert res.override.access == "read_write" and res.override.actor == "alice"
    ev = res.event
    assert (ev.action, ev.old_access, ev.new_access, ev.baseline_access) == ("set", None, "read_write", "read")
    assert svc.store.get_override("child", "ops") == res.override
    assert svc.mount_plan("child").disallowed_tools == ()


def test_change_then_same_value_is_noop(svc):
    svc.set_override("child", "ops", "read_write", actor="alice")
    again = svc.set_override("child", "ops", "read_write", actor="bob")
    assert again.action == "noop" and again.event is None
    assert len(svc.events()) == 1


def test_setting_baseline_value_clears_the_row(svc):
    svc.set_override("child", "ops", "removed", actor="alice")
    res = svc.set_override("child", "ops", "read", actor="bob")
    assert res.action == "clear" and res.event.reason == "set back to baseline"
    assert res.event.old_access == "removed" and res.event.new_access is None
    assert svc.store.list_overrides() == []
    # baseline value with nothing stored: no row, no event
    assert svc.set_override("child", "ops", "read", actor="bob").action == "noop"
    assert [e.action for e in svc.events()] == ["clear", "set"]  # newest first


def test_removed_on_unbound_bank_is_baseline_and_new_bank_is_an_override(svc):
    assert svc.set_override("child", "biz", "removed", actor="a").action == "noop"
    res = svc.set_override("child", "biz", "capture", actor="a")
    assert res.action == "set" and res.event.baseline_access is None
    assert svc.mount_plan("child").capture_banks == ("biz",)


def test_allowlist_counts_as_a_different_value(svc):
    res = svc.set_override("child", "ops", "read", ["search"], actor="a")
    assert res.action == "set" and res.override.allowed_tools == ("search",)


def test_clear_override(svc):
    assert svc.clear_override("child", "ops", actor="a").action == "noop"
    svc.set_override("child", "ops", "removed", actor="a")
    res = svc.clear_override("child", "ops", actor="b", reason="undo")
    assert res.action == "clear" and res.event.actor == "b" and res.event.baseline_access == "read"
    assert svc.events(agent_id="child", bank_id="ops", limit=1)[0].reason == "undo"


def test_writes_refuse_unknown_ids_and_missing_actor(svc):
    with pytest.raises(UnknownAgentError):
        svc.set_override("ghost", "ops", "read", actor="a")
    with pytest.raises(UnknownBankError):
        svc.set_override("child", "ghost", "read", actor="a")
    with pytest.raises(ContractError, match="actor"):
        svc.set_override("child", "ops", "read_write", actor="  ")
    with pytest.raises(ContractError, match="access"):
        svc.set_override("child", "ops", "owner", actor="a")


def test_topology_survives_a_broken_store(svc):
    class Broken(InMemoryBindingStore):
        def list_overrides(self):
            raise OSError("disk")

    svc.store = Broken()
    topo = svc.topology()
    assert topo["overrides_applied"] is False and "disk" in topo["store_error"]
    assert any(e["type"] == "binding" for e in topo["edges"])


# ─────────────────────────────────────────────────────────────── routes


def call(svc, method, path, *, query="", body=None, actor="alice"):
    return handle_agent_topology_request(svc, method, path, query=query, body=body, actor=actor)


def test_route_get_topology_and_mounts(svc):
    status, body = call(svc, "GET", "/api/agent-topology")
    assert status == 200 and body["v"] == 1 and "child" in body["plans"]
    status, plan = call(svc, "GET", "/api/agent-topology/agents/child/mounts")
    assert status == 200 and plan["agent_id"] == "child" and "ops" in plan["mcp_servers"]
    assert call(svc, "GET", "/api/agent-topology/agents/ghost/mounts")[0] == 404


def test_route_put_and_delete_round_trip(svc):
    status, body = call(svc, "PUT", "/api/agent-topology/overrides",
                        body={"agent_id": "child", "bank_id": "ops", "access": "removed", "reason": "noisy"})
    assert status == 200 and body["result"] == "set" and body["event"]["actor"] == "alice"
    edge = next(e for e in body["topology"]["edges"] if e["id"] == "bind:child:ops")
    assert edge["access"] == "removed" and edge["origin"] == "override"

    status, body = call(svc, "DELETE", "/api/agent-topology/overrides/child/ops", query="reason=back", actor="bob")
    assert status == 200 and body["result"] == "clear" and body["event"]["reason"] == "back"
    status, body = call(svc, "GET", "/api/agent-topology/events", query="agent=child&bank=ops")
    assert [e["action"] for e in body["events"]] == ["clear", "set"]


@pytest.mark.parametrize(
    "method, path, query, body, status",
    [
        ("POST", "/api/agent-topology", "", None, 405),
        ("GET", "/api/agent-topology/overrides", "", None, 405),
        ("PUT", "/api/agent-topology/overrides", "", ["not", "an", "object"], 400),
        ("PUT", "/api/agent-topology/overrides", "", {"agent_id": "child", "bank_id": "ops"}, 400),
        ("PUT", "/api/agent-topology/overrides", "", {"agent_id": "child", "bank_id": "ops", "access": "read", "allowed_tools": "x"}, 400),
        ("PUT", "/api/agent-topology/overrides", "", {"agent_id": "nobody", "bank_id": "ops", "access": "read"}, 404),
        ("DELETE", "/api/agent-topology/overrides/child/ghost", "", None, 404),
        ("GET", "/api/agent-topology/events", "limit=lots", None, 400),
        ("GET", "/api/agent-topology/nope", "", None, 404),
        ("GET", "/api/other", "", None, 404),
    ],
)
def test_route_errors(svc, method, path, query, body, status):
    got, payload = call(svc, method, path, query=query, body=body)
    assert got == status and payload["error"]


def test_route_maps_store_write_failure_to_503(svc):
    class ReadOnly(InMemoryBindingStore):
        def write_override(self, override, event):
            raise RuntimeError("read-only replica")

    svc.store = ReadOnly()
    status, body = call(svc, "PUT", "/api/agent-topology/overrides", body={"agent_id": "child", "bank_id": "ops", "access": "removed"})
    assert status == 503 and "read-only replica" in body["error"]
