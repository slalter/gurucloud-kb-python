/* Agents view: which agents mount which Knowledge Banks, and how.

   Host contract (#kbx-agents-root data attributes):
     data-topology-url  base of the /api/agent-topology routes (GET graph,
                        GET /events, PUT /overrides, DELETE /overrides/<a>/<b>)
     data-explorer-url  where a bank opens (?kb=<bank_id> is appended)
     data-token-gate    send a bearer token from the token gate (platform host)
   Served by gurucloud-kb's local server at /agents; any host serving the same
   routes (gurucloud_kb.agents.handle_agent_topology_request) can mount it. */

import { h, mount, clear, toast, skeleton, empty, fmtDate, timeAgo } from './dom.js';
import { getToken, tokenGate } from './token.js';
import { recordAction } from './record.js';
import {
  ACCESS_LEVELS, ACCESS_META, accessLabel, topologyCaption, matchIds, toElements,
  agentSummary, bankSummary, bindingDetail, selectionFor, overrideRequest, resetRequest,
  describeEvent, resultMessage, historyEmptyText, afterWriteSelection,
} from './agents_model.js';

function client(root) {
  const base = (root.dataset.topologyUrl || '/api/agent-topology').replace(/\/$/, '');
  async function call(method, path = '', body = null) {
    const headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (root.dataset.tokenGate) { const t = getToken(); if (t) headers.Authorization = `Bearer ${t}`; }
    const resp = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await resp.json(); } catch { /* empty body */ }
    if (!resp.ok) {
      const err = new Error((data && data.error) || `HTTP ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return data;
  }
  return { call };
}

function accessChip(access, extra = '') {
  const meta = ACCESS_META[access] || ACCESS_META.removed;
  return h('span', { class: `kbx-chip kbx-agents-access ${extra}`.trim(), style: { color: meta.color, borderColor: meta.color }, title: meta.hint }, accessLabel(access));
}

function originChip(origin) {
  if (origin === 'override') return h('span', { class: 'kbx-chip warn', title: 'Stored override; differs from the code baseline' }, 'override');
  if (origin === 'inherited') return h('span', { class: 'kbx-chip', title: 'Inherited from the parent agent' }, 'inherited');
  return null;
}

export function bootAgents(root) {
  const api = client(root);
  const explorerUrl = root.dataset.explorerUrl || '/';
  let topo = null;
  let selection = null; // {kind, id}
  let cy = null;
  let busy = false;

  const caption = h('p', { class: 'kbx-sub' }, '');
  const search = h('input', { class: 'kbx-input', type: 'search', placeholder: 'Find an agent or bank…', 'aria-label': 'Find an agent or bank', dataset: { action: 'agents_search' } });
  const refreshBtn = h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', dataset: { action: 'agents_refresh' } }, h('i', { class: 'bi bi-arrow-clockwise' }), 'Refresh');
  const fitBtn = h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', dataset: { action: 'agents_fit' } }, h('i', { class: 'bi bi-arrows-fullscreen' }), 'Fit');
  const alerts = h('div', { class: 'kbx-agents-alerts' });
  const canvas = h('div', { class: 'kbx-agents-canvas', role: 'img', 'aria-label': 'Agent and bank graph' });
  const legend = h('div', { class: 'kbx-graph-legend kbx-agents-legend' },
    ...ACCESS_LEVELS.map((a) => h('span', { title: ACCESS_META[a].hint }, h('i', { class: 'kbx-agents-swatch', style: { background: ACCESS_META[a].color } }), accessLabel(a))),
    h('span', {}, h('i', { class: 'kbx-agents-swatch dashed' }), 'inherited by'));
  const side = h('aside', { class: 'kbx-side kbx-agents-side', 'aria-live': 'polite' });

  const header = h('div', { class: 'kbx-header' },
    h('div', { class: 'kbx-title' },
      h('span', { class: 'kbx-mascot', 'aria-hidden': 'true' }, h('i', {}), h('i', {})),
      h('div', {}, h('h1', { class: 'kbx-h1' }, 'Agents'), caption)),
    h('div', { class: 'kbx-header-actions' },
      h('a', { class: 'kbx-btn kbx-btn-ghost', href: explorerUrl, dataset: { action: 'agents_banks_open' } }, h('i', { class: 'bi bi-database' }), 'Banks')));

  mount(root,
    header,
    h('div', { class: 'kbx-row kbx-agents-toolbar' }, search, fitBtn, refreshBtn),
    alerts,
    h('div', { class: 'kbx-agents-split' },
      h('div', { class: 'kbx-card kbx-agents-graph' }, canvas, legend),
      side));

  function renderAlerts() {
    clear(alerts);
    if (!topo) return;
    if (topo.store_error) alerts.appendChild(h('div', { class: 'kbx-alert warn' }, `Override store unreadable, showing code baselines only: ${topo.store_error}`));
    for (const e of topo.errors || []) alerts.appendChild(h('div', { class: 'kbx-alert danger' }, `${e.agent_id}: ${e.error}`));
  }

  function draw() {
    if (!topo) return;
    caption.textContent = topologyCaption(topo);
    if (!window.cytoscape) { mount(canvas, h('div', { class: 'kbx-alert warn' }, 'Graph library not loaded.')); return; }
    if (!topo.nodes.length) { mount(canvas, empty('bi-diagram-3', 'No agents or banks', 'The host has not registered any agents yet.')); return; }
    const els = toElements(topo, matchIds(topo, search.value));
    if (cy) { cy.destroy(); cy = null; }
    clear(canvas);
    let layout = { name: 'breadthfirst', directed: true, padding: 16 };
    try { if (window.cytoscapeDagre || (window.cytoscape && window.dagre)) layout = { name: 'dagre', rankDir: 'LR', nodeSep: 22, rankSep: 110, padding: 16 }; } catch { /* keep fallback */ }
    cy = window.cytoscape({
      container: canvas,
      elements: [...els.nodes, ...els.edges],
      style: [
        { selector: 'node', style: { label: 'data(label)', 'font-size': 12, 'font-weight': 600, 'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap', 'text-max-width': 150, width: 'label', height: 'label', padding: '10px', 'border-width': 1.5 } },
        { selector: 'node.agent', style: { shape: 'round-rectangle', 'background-color': '#72a6ab', 'border-color': '#4f8287', color: '#fff' } },
        { selector: 'node.bank', style: { shape: 'barrel', 'background-color': '#f3f1ea', 'border-color': '#8a8679', color: '#2b2a26' } },
        { selector: 'node.kind-playbook', style: { 'border-style': 'dashed' } },
        { selector: 'node.kind-business', style: { 'background-color': '#eef3f6' } },
        { selector: 'edge', style: { 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', width: 2, 'font-size': 10, label: 'data(label)', color: '#2b2a26', 'text-background-color': '#fbfaf7', 'text-background-opacity': 1, 'text-background-padding': '2px' } },
        { selector: 'edge.binding', style: { 'line-color': 'data(color)', 'target-arrow-color': 'data(color)' } },
        { selector: 'edge.override', style: { width: 3.5 } },
        { selector: 'edge.access-removed', style: { 'line-style': 'dotted' } },
        { selector: 'edge.inherits', style: { 'line-style': 'dashed', 'line-color': '#b8b4a8', 'target-arrow-color': '#b8b4a8', 'font-size': 9 } },
        { selector: '.dim', style: { opacity: 0.18 } },
        { selector: ':selected', style: { 'overlay-color': '#72a6ab', 'overlay-opacity': 0.18, 'overlay-padding': 6 } },
      ],
      layout,
      wheelSensitivity: 0.2,
    });
    cy.on('tap', 'node, edge', (ev) => {
      const sel = selectionFor(ev.target.id());
      if (!sel || (sel.kind === 'binding' && ev.target.hasClass('inherits'))) return;
      select(sel, `agents_${sel.kind}_open`);
    });
    if (selection) { const el = cy.getElementById(elementIdFor(selection)); if (el && el.length) el.select(); }
  }

  function elementIdFor(sel) {
    if (sel.kind === 'agent') return `agent:${sel.id}`;
    if (sel.kind === 'bank') return `bank:${sel.id}`;
    return sel.id;
  }

  function select(sel, actionName) {
    selection = sel;
    if (actionName) recordAction(actionName, { target_ids: [sel.id], outcome: 'panel_opened' });
    renderSide();
  }

  function sideLink(label, sel, action) {
    return h('button', { class: 'kbx-link-btn', type: 'button', dataset: { action }, onClick: () => select(sel) }, label);
  }

  function renderSide() {
    if (!topo) return;
    if (!selection) {
      mount(side, h('div', { class: 'kbx-side-card' },
        h('div', { class: 'kbx-side-title' }, 'Pick something'),
        h('p', { class: 'kbx-muted' }, 'Click an agent to see what it mounts, a bank to see who uses it, or an arrow to change that agent’s access to that bank.')));
      return;
    }
    if (selection.kind === 'agent') return renderAgent(agentSummary(topo, selection.id));
    if (selection.kind === 'bank') return renderBank(bankSummary(topo, selection.id));
    return renderBinding(bindingDetail(topo, selection.id));
  }

  function gone() { selection = null; renderSide(); }

  function renderAgent(s) {
    if (!s) return gone();
    const plan = s.plan;
    mount(side,
      h('div', { class: 'kbx-side-card' },
        h('div', { class: 'kbx-side-title' }, h('i', { class: 'bi bi-robot' }), ` ${s.label}`),
        h('div', { class: 'kbx-mono kbx-muted' }, s.agentId),
        s.error ? h('div', { class: 'kbx-alert danger' }, s.error.error) : null,
        s.parentId ? h('div', { class: 'kbx-side-row' }, h('span', { class: 'kbx-side-k' }, 'Inherits from'), sideLink(s.parentId, { kind: 'agent', id: s.parentId }, 'agents_parent_open')) : null,
        s.children.length ? h('div', { class: 'kbx-side-row' }, h('span', { class: 'kbx-side-k' }, 'Inherited by'), h('span', {}, ...s.children.map((c, i) => [i ? ', ' : '', sideLink(c, { kind: 'agent', id: c }, 'agents_child_open')]).flat())) : null),
      h('div', { class: 'kbx-side-card' },
        h('div', { class: 'kbx-side-title' }, `Bindings (${s.bindings.length})`),
        s.bindings.length
          ? h('ul', { class: 'kbx-agents-list' }, ...s.bindings.map((b) => h('li', {},
            h('button', { class: 'kbx-link-btn', type: 'button', dataset: { action: 'agents_binding_open' }, onClick: () => select({ kind: 'binding', id: b.edgeId }) }, b.bankLabel),
            ' ', accessChip(b.access), ' ', originChip(b.origin),
            !b.bankKnown ? h('span', { class: 'kbx-chip danger', title: 'The host has no bank with this id' }, 'unknown bank') : null,
            b.denied ? h('small', { class: 'kbx-muted' }, ` ${b.denied} tool${b.denied === 1 ? '' : 's'} denied`) : null)))
          : h('p', { class: 'kbx-muted' }, 'No bindings.')),
      plan ? h('div', { class: 'kbx-side-card' },
        h('div', { class: 'kbx-side-title' }, 'Mount plan'),
        h('div', { class: 'kbx-side-row' }, h('span', { class: 'kbx-side-k' }, 'MCP servers'), h('span', { class: 'kbx-side-v kbx-mono' }, Object.keys(plan.mcp_servers).join(', ') || 'none')),
        plan.capture_banks.length ? h('div', { class: 'kbx-side-row' }, h('span', { class: 'kbx-side-k' }, 'Capture'), h('span', { class: 'kbx-side-v kbx-mono' }, plan.capture_banks.join(', '))) : null,
        h('details', { class: 'kbx-agents-denied' },
          h('summary', { dataset: { action: 'agents_denied_toggle' } }, `Denied tools (${plan.disallowed_tools.length})`),
          plan.disallowed_tools.length ? h('ul', { class: 'kbx-agents-list kbx-mono' }, ...plan.disallowed_tools.map((t) => h('li', {}, t))) : h('p', { class: 'kbx-muted' }, 'None.')),
        ...plan.warnings.map((w) => h('div', { class: 'kbx-alert warn' }, w))) : null);
  }

  function renderBank(s) {
    if (!s) return gone();
    mount(side,
      h('div', { class: 'kbx-side-card' },
        h('div', { class: 'kbx-side-title' }, h('i', { class: 'bi bi-database' }), ` ${s.label}`),
        h('div', { class: 'kbx-mono kbx-muted' }, s.bankId),
        s.description ? h('p', {}, s.description) : null,
        h('div', { class: 'kbx-side-row' }, h('span', { class: 'kbx-side-k' }, 'Kind'), h('span', { class: 'kbx-side-v' }, s.kind)),
        h('div', { class: 'kbx-side-row' }, h('span', { class: 'kbx-side-k' }, 'MCP URL'), h('span', { class: 'kbx-side-v kbx-mono kbx-agents-wrap' }, s.mcpUrl)),
        s.authRef ? h('div', { class: 'kbx-side-row' }, h('span', { class: 'kbx-side-k' }, 'Token from'), h('span', { class: 'kbx-side-v kbx-mono' }, s.authRef)) : null,
        h('a', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', href: `${explorerUrl}${explorerUrl.includes('?') ? '&' : '?'}kb=${encodeURIComponent(s.bankId)}`, dataset: { action: 'agents_bank_explore' } }, h('i', { class: 'bi bi-box-arrow-up-right' }), 'Open in Explorer')),
      h('div', { class: 'kbx-side-card' },
        h('div', { class: 'kbx-side-title' }, `Agents (${s.agents.length})`),
        s.agents.length
          ? h('ul', { class: 'kbx-agents-list' }, ...s.agents.map((a) => h('li', {},
            h('button', { class: 'kbx-link-btn', type: 'button', dataset: { action: 'agents_binding_open' }, onClick: () => select({ kind: 'binding', id: a.edgeId }) }, a.agentLabel),
            ' ', accessChip(a.access), ' ', originChip(a.origin))))
          : h('p', { class: 'kbx-muted' }, 'No agent mounts this bank.')));
  }

  function renderBinding(d) {
    if (!d) return gone();
    const accessSel = h('select', { class: 'kbx-select', 'aria-label': 'Access level', dataset: { action: 'agents_access_select' } },
      ...ACCESS_LEVELS.map((a) => h('option', { value: a }, accessLabel(a))));
    accessSel.value = d.access;
    const reason = h('input', { class: 'kbx-input', type: 'text', placeholder: 'Why (kept in the history)', 'aria-label': 'Reason for the change', maxlength: '500' });
    const hint = h('small', { class: 'kbx-muted' }, ACCESS_META[d.access].hint);
    accessSel.addEventListener('change', () => { hint.textContent = (ACCESS_META[accessSel.value] || {}).hint || ''; });
    const saveBtn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button', dataset: { action: 'agents_override_save' } }, 'Save');
    const resetBtn = d.hasOverride ? h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', dataset: { action: 'agents_override_reset' } }, 'Reset to baseline') : null;
    const history = h('div', {}, skeleton('Loading history…'));
    saveBtn.addEventListener('click', () => write(overrideRequest(d, accessSel.value, reason.value), [saveBtn, resetBtn]));
    if (resetBtn) resetBtn.addEventListener('click', () => write(resetRequest(d, reason.value), [saveBtn, resetBtn]));
    const base = d.baseline ? accessLabel(d.baseline.access) : 'not bound in code';
    mount(side,
      h('div', { class: 'kbx-side-card' },
        h('div', { class: 'kbx-side-title' }, `${d.agentLabel} → ${d.bankLabel}`),
        h('div', { class: 'kbx-side-row' }, h('span', { class: 'kbx-side-k' }, 'Effective'), h('span', { class: 'kbx-side-v' }, accessChip(d.access), ' ', originChip(d.origin))),
        h('div', { class: 'kbx-side-row' }, h('span', { class: 'kbx-side-k' }, 'Baseline'), h('span', { class: 'kbx-side-v' }, base)),
        d.override ? h('div', { class: 'kbx-side-row' }, h('span', { class: 'kbx-side-k' }, 'Override by'), h('span', { class: 'kbx-side-v' }, `${d.override.actor}, ${timeAgo(d.override.updated_at)}`)) : null,
        d.allowedTools ? h('div', { class: 'kbx-side-row' }, h('span', { class: 'kbx-side-k' }, 'Allowed tools'), h('span', { class: 'kbx-side-v kbx-mono kbx-agents-wrap' }, d.allowedTools.join(', '))) : null,
        h('div', { class: 'kbx-row' }, sideLink('Agent', { kind: 'agent', id: d.agentId }, 'agents_agent_open'), h('span', { class: 'kbx-muted' }, '·'), sideLink('Bank', { kind: 'bank', id: d.bankId }, 'agents_bank_open'))),
      h('div', { class: 'kbx-side-card' },
        h('div', { class: 'kbx-side-title' }, 'Change access'),
        h('div', { class: 'kbx-field' }, h('label', {}, 'Access'), accessSel, hint),
        h('div', { class: 'kbx-field' }, h('label', {}, 'Reason'), reason),
        h('div', { class: 'kbx-row kbx-agents-actions' }, saveBtn, resetBtn)),
      h('div', { class: 'kbx-side-card' }, h('div', { class: 'kbx-side-title' }, 'History'), history));
    loadHistory(d, history);
  }

  async function loadHistory(d, host) {
    try {
      const data = await api.call('GET', `/events?agent=${encodeURIComponent(d.agentId)}&bank=${encodeURIComponent(d.bankId)}&limit=20`);
      const events = (data && data.events) || [];
      if (!host.isConnected) return;
      mount(host, events.length
        ? h('ul', { class: 'kbx-agents-list' }, ...events.map((ev) => h('li', { title: fmtDate(ev.at) }, h('small', { class: 'kbx-muted' }, `${timeAgo(ev.at)} · `), describeEvent(ev))))
        : h('p', { class: 'kbx-muted' }, historyEmptyText(d)));
    } catch (e) {
      if (host.isConnected) mount(host, h('div', { class: 'kbx-alert warn' }, `History unavailable: ${e.message}`));
    }
  }

  async function write(req, buttons) {
    if (req.error) { toast(req.error, 'info'); return; }
    if (busy) return;
    busy = true;
    buttons.forEach((b) => { if (b) b.disabled = true; });
    try {
      const res = await api.call(req.method, req.path, req.body);
      topo = res.topology || topo;
      selection = afterWriteSelection(topo, selection);
      toast(resultMessage(res), 'success');
      recordAction(req.method === 'PUT' ? 'agents_override_saved' : 'agents_override_reset_done', { target_ids: [selection && selection.id].filter(Boolean), outcome: 'request_sent' });
      renderAlerts();
      draw();
      renderSide();
    } catch (e) {
      toast(`Could not save: ${e.message}`, 'error');
    } finally {
      busy = false;
      buttons.forEach((b) => { if (b && b.isConnected) b.disabled = false; });
    }
  }

  async function load() {
    mount(canvas, skeleton('Loading agents…'));
    try {
      topo = await api.call('GET');
    } catch (e) {
      if (e.status === 401 && root.dataset.tokenGate) {
        try { sessionStorage.removeItem('kbx-token'); } catch { /* ignore */ }
        tokenGate(root, () => bootAgents(root));
        return;
      }
      mount(canvas, h('div', { class: 'kbx-alert danger' }, `Could not load agents: ${e.message}`));
      return;
    }
    renderAlerts();
    draw();
    renderSide();
  }

  let searchTimer = null;
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(draw, 200); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchTimer); draw(); recordAction('agents_search', { outcome: 'nothing' }); } });
  refreshBtn.addEventListener('click', load);
  fitBtn.addEventListener('click', () => { if (cy) cy.fit(undefined, 16); });
  load();
}

function boot() {
  const root = document.getElementById('kbx-agents-root');
  if (!root) return;
  if (root.dataset.tokenGate && !getToken()) { tokenGate(root, () => bootAgents(root)); return; }
  bootAgents(root);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
