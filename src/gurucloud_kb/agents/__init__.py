"""Agent <-> Knowledge Bank bindings: contract, mount resolver, topology, store.

Hosts describe their agents (:class:`AgentSpec`) and banks (:class:`BankRef`),
keep overrides in a :class:`BindingStore`, and call :func:`resolve_mounts` (or
:meth:`AgentTopologyService.mount_plan`) at turn time to get the Agent SDK
``mcp_servers`` and ``disallowed_tools``. :func:`handle_agent_topology_request`
serves the Agents view in the bundled UI. See the README section "Agent <-> KB
bindings".
"""

from gurucloud_kb.agents.contract import (
    ACCESS_LEVELS,
    BANK_KINDS,
    CONTRACT_VERSION,
    Access,
    AgentSpec,
    BankKind,
    BankRef,
    Binding,
    BindingOverride,
    BindingOverrideEvent,
    BindingSource,
    ContractError,
)
from gurucloud_kb.agents.registry import AgentRegistry, load_registry, parse_registry
from gurucloud_kb.agents.resolve import (
    WRITE_TOOLS,
    MountPlan,
    available_tools_from_definition,
    effective_bindings,
    inherited_baseline,
    mcp_tool_name,
    resolve_mounts,
    resolve_mounts_from_store,
)
from gurucloud_kb.agents.service import (
    AGENT_TOPOLOGY_PATH,
    AgentTopologyService,
    ChangeResult,
    UnknownAgentError,
    UnknownBankError,
    handle_agent_topology_request,
)
from gurucloud_kb.agents.store import BindingStore, InMemoryBindingStore
from gurucloud_kb.agents.topology import build_topology

__all__ = [
    "ACCESS_LEVELS",
    "AGENT_TOPOLOGY_PATH",
    "BANK_KINDS",
    "CONTRACT_VERSION",
    "WRITE_TOOLS",
    "Access",
    "AgentRegistry",
    "AgentSpec",
    "AgentTopologyService",
    "BankKind",
    "BankRef",
    "Binding",
    "BindingOverride",
    "BindingOverrideEvent",
    "BindingSource",
    "BindingStore",
    "ChangeResult",
    "ContractError",
    "InMemoryBindingStore",
    "MountPlan",
    "UnknownAgentError",
    "UnknownBankError",
    "available_tools_from_definition",
    "build_topology",
    "effective_bindings",
    "handle_agent_topology_request",
    "inherited_baseline",
    "load_registry",
    "mcp_tool_name",
    "parse_registry",
    "resolve_mounts",
    "resolve_mounts_from_store",
]
