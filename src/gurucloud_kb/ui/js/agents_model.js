/* Agents view, pure view-model (no DOM, no fetch): turns the
   GET /api/agent-topology document (gurucloud_kb.agents.build_topology) into
   Cytoscape elements, side-panel summaries and override requests.
   Imported by agents.js and by tests/test_kb_explorer_agents_model.js. */

export const ACCESS_LEVELS = ['read', 'read_write', 'capture', 'removed'];

export const ACCESS_META = {
  read: { label: 'Read', color: '#33607a', hint: 'Search and read; every write tool is denied.' },
  read_write: { label: 'Read + write', color: '#2e7d44', hint: 'Every tool the bank serves.' },
  capture: { label: 'Capture', color: '#a06a00', hint: 'Writes are held for review by the host; direct write tools are denied.' },
  removed: { label: 'Removed', color: '#8a8679', hint: 'Not mounted for this agent.' },
};

export function accessLabel(access) {
  return (ACCESS_META[access] || { label: String(access || '—') }).label;
}

const nodesOf = (topo) => (topo && Array.isArray(topo.nodes) ? topo.nodes : []);
const edgesOf = (topo) => (topo && Array.isArray(topo.edges) ? topo.edges : []);

export function agentNodes(topo) { return nodesOf(topo).filter((n) => n.type === 'agent'); }
export function bankNodes(topo) { return nodesOf(topo).filter((n) => n.type === 'bank'); }
export function bindingEdges(topo) { return edgesOf(topo).filter((e) => e.type === 'binding'); }

/** "3 agents · 4 banks · 6 bindings · 1 override". */
export function topologyCaption(topo) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const binds = bindingEdges(topo);
  const overrides = binds.filter((e) => e.origin === 'override').length;
  const parts = [plural(agentNodes(topo).length, 'agent'), plural(bankNodes(topo).length, 'bank'), plural(binds.length, 'binding')];
  if (overrides) parts.push(plural(overrides, 'override'));
  return parts.join(' · ');
}

/** Node ids that match `query` (name or id, case-insensitive) plus their direct neighbours.
    Returns null for an empty query (= show everything). */
export function matchIds(topo, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  const hit = new Set(nodesOf(topo)
    .filter((n) => `${n.label || ''} ${n.agent_id || ''} ${n.bank_id || ''}`.toLowerCase().includes(q))
    .map((n) => n.id));
  const keep = new Set(hit);
  for (const e of edgesOf(topo)) {
    if (hit.has(e.source)) keep.add(e.target);
    if (hit.has(e.target)) keep.add(e.source);
  }
  return keep;
}

/** Cytoscape element definitions. `visible` (from matchIds) dims everything else. */
export function toElements(topo, visible = null) {
  const dim = (id) => (visible && !visible.has(id) ? ' dim' : '');
  const nodes = nodesOf(topo).map((n) => ({
    group: 'nodes',
    data: { id: n.id, label: n.label || n.id, type: n.type },
    classes: `${n.type}${n.type === 'bank' ? ` kind-${n.kind || 'domain'}` : ''}${dim(n.id)}`,
  }));
  const edges = edgesOf(topo).map((e) => {
    if (e.type === 'inherits') {
      // Drawn parent -> child so dagre ranks parents left of their children
      // (the document keeps child -> parent, the direction of the relation).
      return { group: 'edges', data: { id: e.id, source: e.target, target: e.source, label: 'inherited by' }, classes: `inherits${dim(e.source)}` };
    }
    return {
      group: 'edges',
      data: { id: e.id, source: e.source, target: e.target, label: accessLabel(e.access), color: (ACCESS_META[e.access] || ACCESS_META.removed).color },
      classes: `binding access-${e.access}${e.origin === 'override' ? ' override' : ''}${dim(e.source) || dim(e.target)}`,
    };
  });
  return { nodes, edges };
}

function nodeById(topo, id) { return nodesOf(topo).find((n) => n.id === id) || null; }

/** Side panel for one agent: its bindings, parent, children and mount plan. */
export function agentSummary(topo, agentId) {
  const node = nodeById(topo, `agent:${agentId}`);
  if (!node) return null;
  const plan = (topo.plans || {})[agentId] || null;
  const error = (topo.errors || []).find((e) => e.agent_id === agentId) || null;
  const bindings = bindingEdges(topo)
    .filter((e) => e.agent_id === agentId)
    .map((e) => {
      const bank = nodeById(topo, e.target);
      const denied = plan ? plan.disallowed_tools.filter((t) => t.startsWith(`mcp__${e.bank_id}__`)).length : 0;
      return {
        edgeId: e.id,
        bankId: e.bank_id,
        bankLabel: bank ? bank.label : e.bank_id,
        access: e.access,
        origin: e.origin,
        mounted: !!(plan && plan.mcp_servers && plan.mcp_servers[e.bank_id]),
        denied,
        bankKnown: e.bank_known !== false,
      };
    });
  const children = agentNodes(topo).filter((n) => n.parent_id === agentId).map((n) => n.agent_id);
  return { agentId, label: node.label, parentId: node.parent_id || null, children, bindings, plan, error };
}

/** Side panel for one bank: which agents mount it and how. */
export function bankSummary(topo, bankId) {
  const node = nodeById(topo, `bank:${bankId}`);
  if (!node) return null;
  const agents = bindingEdges(topo)
    .filter((e) => e.bank_id === bankId)
    .map((e) => ({ edgeId: e.id, agentId: e.agent_id, agentLabel: (nodeById(topo, e.source) || {}).label || e.agent_id, access: e.access, origin: e.origin }));
  return { bankId, label: node.label, kind: node.kind, description: node.description || '', mcpUrl: node.mcp_url, authRef: node.auth_ref || null, agents };
}

/** Side panel for one binding edge. */
export function bindingDetail(topo, edgeId) {
  const e = bindingEdges(topo).find((x) => x.id === edgeId);
  if (!e) return null;
  const agent = nodeById(topo, e.source);
  const bank = nodeById(topo, e.target);
  return {
    edgeId: e.id,
    agentId: e.agent_id,
    bankId: e.bank_id,
    agentLabel: agent ? agent.label : e.agent_id,
    bankLabel: bank ? bank.label : e.bank_id,
    access: e.access,
    allowedTools: e.allowed_tools || null,
    origin: e.origin,
    baseline: e.baseline || null,
    override: e.override || null,
    hasOverride: e.origin === 'override',
  };
}

/** Where a click on a graph element leads: {kind:'agent'|'bank'|'binding', id} or null. */
export function selectionFor(elementId) {
  const s = String(elementId || '');
  if (s.startsWith('agent:')) return { kind: 'agent', id: s.slice(6) };
  if (s.startsWith('bank:')) return { kind: 'bank', id: s.slice(5) };
  if (s.startsWith('bind:')) return { kind: 'binding', id: s };
  return null;
}

/** The PUT that sets an override, or {error} when the input is not sendable.
    Keeps the edge's current allowlist: v1 edits access only. */
export function overrideRequest(detail, access, reason) {
  if (!detail) return { error: 'Pick a binding first.' };
  if (!ACCESS_LEVELS.includes(access)) return { error: `Unknown access level "${access}".` };
  if (access === detail.access && detail.hasOverride) return { error: 'That is already the stored value.' };
  if (access === detail.access && !detail.hasOverride) return { error: 'That is already the baseline value.' };
  return {
    method: 'PUT',
    path: '/overrides',
    body: { agent_id: detail.agentId, bank_id: detail.bankId, access, allowed_tools: detail.allowedTools, reason: String(reason || '').trim() },
  };
}

/** The DELETE that drops an override (back to the code baseline). */
export function resetRequest(detail, reason) {
  if (!detail || !detail.hasOverride) return { error: 'This binding has no override to reset.' };
  const q = String(reason || '').trim();
  return {
    method: 'DELETE',
    path: `/overrides/${encodeURIComponent(detail.agentId)}/${encodeURIComponent(detail.bankId)}${q ? `?reason=${encodeURIComponent(q)}` : ''}`,
    body: null,
  };
}

/** One line for an audit event. */
export function describeEvent(ev) {
  if (!ev) return '';
  const was = ev.old ? accessLabel(ev.old.access) : 'baseline';
  const base = ev.baseline ? accessLabel(ev.baseline.access) : 'not bound';
  const what = ev.action === 'clear' ? `reset to baseline (${base})` : `set ${accessLabel(ev.new && ev.new.access)}`;
  const reason = ev.reason ? ` — “${ev.reason}”` : '';
  return `${ev.actor} ${what}, was ${was}${reason}`;
}

/** Message for a write result ({result:'set'|'clear'|'noop'}). */
export function resultMessage(res) {
  if (!res) return '';
  if (res.result === 'set') return `Saved: ${accessLabel(res.override && res.override.access)}.`;
  if (res.result === 'clear') return 'Back to the baseline.';
  return 'Nothing changed.';
}

/** History panel text when the store returned no events for a binding. */
export function historyEmptyText(detail) {
  return detail && detail.hasOverride
    ? 'The override predates the recorded history (seeded or imported).'
    : 'No changes recorded; this is the code baseline.';
}

/** Selection to keep after a write: a binding the write removed from the
    graph (an override cleared back to "not bound") falls back to its agent. */
export function afterWriteSelection(topo, selection) {
  if (!selection || selection.kind !== 'binding' || bindingDetail(topo, selection.id)) return selection;
  const parts = String(selection.id).split(':');
  return parts.length >= 3 && agentSummary(topo, parts[1]) ? { kind: 'agent', id: parts[1] } : null;
}
