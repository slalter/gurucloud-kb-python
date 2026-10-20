/* Entry connections — the section on the entry detail that lists an entry's
   typed connections (both directions), lets a person add or remove one, and
   draws the entry's neighbourhood as a graph (kanban c0cab0a7).

   Pure logic lives in connections_model.js; this file is DOM only. */

import { h, clear, toast, skeleton } from './dom.js';
import { openModal, confirmModal } from './modal.js';
import {
  RELATIONS, addResultText, buildAddRequest, connectionRows, graphCaption, graphElements, relationDescriptions, relationLabel, relationNames,
} from './connections_model.js';

const GRAPH_COLORS = { root: '#f2b23a', rootBorder: '#a06a00', node: '#72a6ab', nodeBorder: '#456f73', far: '#b7b3a8', edge: '#8a9a8c', bridged: '#4d3a80', text: '#2b2f2b' };

/** The section element; loads itself. `onOpenEntry(id)` opens another entry's detail. */
export function renderConnectionsSection(ctx, entry, { onOpenEntry, onChanged } = {}) {
  const { api } = ctx;
  const listEl = h('div', { class: 'kbx-conn-list' }, skeleton('Loading connections…'));
  const countEl = h('span', { class: 'kbx-chip muted' }, '…');
  const formHost = h('div', {});
  let rows = [];

  const addBtn = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', onClick: () => toggleForm() }, h('i', { class: 'bi bi-plus-lg' }), 'Connect');
  const graphBtn = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', onClick: () => openGraph(ctx, entry, { onOpenEntry }) }, h('i', { class: 'bi bi-diagram-3' }), 'Graph');
  const head = h('div', { class: 'kbx-conn-head' },
    h('div', { class: 'kbx-row', style: { gap: '8px', alignItems: 'center' } }, h('strong', {}, 'Connections'), countEl),
    h('div', { class: 'kbx-row', style: { gap: '6px' } }, graphBtn, addBtn));
  const section = h('div', { class: 'kbx-conn' }, head, formHost, listEl);

  async function load() {
    try {
      const conns = await api.entryConnections(entry.id);
      rows = connectionRows(conns);
    } catch (e) {
      clear(listEl);
      listEl.append(h('div', { class: 'kbx-alert danger' }, `Could not load connections: ${e.message}`));
      countEl.textContent = '?';
      return;
    }
    render();
  }

  function render() {
    countEl.textContent = String(rows.length);
    clear(listEl);
    if (!rows.length) {
      listEl.append(h('div', { class: 'kbx-hint' }, 'No connections yet. Connect this entry to the hub it details, the entry it supersedes, or a companion a reader of it needs.'));
      return;
    }
    rows.forEach((r) => listEl.append(rowEl(r)));
  }

  function rowEl(r) {
    const open = h('a', { href: '#', class: 'kbx-conn-other', title: r.otherId, onClick: (e) => { e.preventDefault(); if (onOpenEntry) onOpenEntry(r.otherId); } },
      r.otherText || h('span', { class: 'kbx-mono' }, r.otherId.slice(0, 8)));
    const remove = h('button', { class: 'kbx-conn-remove', type: 'button', title: 'Remove this connection', 'aria-label': 'Remove connection', onClick: async () => {
      const ok = await confirmModal({ title: 'Remove connection', message: `Remove "${relationLabel(r.relation, r.direction)}" ${r.otherText || r.otherId.slice(0, 8)}? The removal is audited.`, confirmLabel: 'Remove' });
      if (!ok) return;
      try {
        await api.deleteEdge(r.id, { reason: 'removed in the Explorer' });
        rows = rows.filter((x) => x.id !== r.id);
        render();
        toast('Connection removed', 'success');
        if (onChanged) onChanged('disconnected', r);
      } catch (e) { toast(`Remove failed: ${e.message}`, 'error'); }
    } }, '×');
    return h('div', { class: 'kbx-conn-row' },
      h('span', { class: `kbx-chip ${r.tone}`, title: `${r.relation} (${r.direction}) · ${r.source}` }, r.label),
      h('div', { class: 'kbx-conn-text' }, open, r.note ? h('div', { class: 'kbx-conn-note' }, r.note) : null),
      remove);
  }

  function toggleForm() {
    if (formHost.childNodes.length) { clear(formHost); return; }
    const idInput = h('input', { class: 'kbx-input', type: 'text', placeholder: 'Other entry id (full id or unique prefix)' });
    // The bank's own vocabulary (built-ins + declared, kanban ce8de075); the
    // built-ins until it loads or when the platform predates the route.
    let allowed = RELATIONS.slice();
    const relSel = h('select', { class: 'kbx-select' }, ...allowed.map((r) => h('option', { value: r }, r.replace(/_/g, ' '))));
    if (api.edgeRelations) {
      api.edgeRelations().then((vocab) => {
        allowed = relationNames(vocab);
        const help = relationDescriptions(vocab);
        const current = relSel.value;
        clear(relSel);
        relSel.append(...allowed.map((r) => h('option', { value: r, title: help[r] || '' }, r.replace(/_/g, ' '))));
        if (allowed.includes(current)) relSel.value = current;
        updatePreview();
      }).catch(() => {});
    }
    const dirSel = h('select', { class: 'kbx-select' },
      h('option', { value: 'outgoing' }, 'this entry → other'),
      h('option', { value: 'incoming' }, 'other → this entry'));
    const noteInput = h('input', { class: 'kbx-input', type: 'text', placeholder: 'Why they connect (optional)' });
    const preview = h('div', { class: 'kbx-hint' });
    const updatePreview = () => { preview.textContent = `This entry ${relationLabel(relSel.value, dirSel.value)} the other entry.`; };
    relSel.addEventListener('change', updatePreview);
    dirSel.addEventListener('change', updatePreview);
    updatePreview();
    const saveBtn = h('button', { class: 'kbx-btn kbx-btn-primary kbx-btn-sm', type: 'button' }, 'Save connection');
    const cancelBtn = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', onClick: () => clear(formHost) }, 'Cancel');
    saveBtn.addEventListener('click', async () => {
      let body;
      try { body = buildAddRequest({ entryId: entry.id, otherId: idInput.value, relation: relSel.value, direction: dirSel.value, note: noteInput.value, allowed }); }
      catch (e) { toast(e.message, 'warning'); return; }
      saveBtn.classList.add('is-loading');
      try {
        const out = await api.addEdges(body);
        const text = addResultText(out);
        toast(text, (out && out.errors && out.errors.length) ? 'error' : 'success');
        if (out && out.created && out.created.length) { clear(formHost); await load(); if (onChanged) onChanged('connected', out.created[0]); }
      } catch (e) { toast(`Connect failed: ${e.message}`, 'error'); }
      finally { saveBtn.classList.remove('is-loading'); }
    });
    idInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBtn.click(); });
    formHost.append(h('div', { class: 'kbx-conn-form' },
      h('div', { class: 'kbx-conn-form-row' }, idInput, relSel, dirSel),
      noteInput, preview,
      h('div', { class: 'kbx-row', style: { gap: '6px', justifyContent: 'flex-end' } }, cancelBtn, saveBtn)));
    idInput.focus();
  }

  load();
  return section;
}

/** The entry's neighbourhood as a graph in a modal (GET /graph, Cytoscape + dagre). */
export function openGraph(ctx, entry, { onOpenEntry } = {}) {
  const { api } = ctx;
  const depthSel = h('select', { class: 'kbx-select' }, h('option', { value: '1' }, '1 hop'), h('option', { value: '2', selected: true }, '2 hops'), h('option', { value: '3' }, '3 hops'));
  const caption = h('div', { class: 'kbx-hint' }, 'Loading…');
  const canvas = h('div', { class: 'kbx-conn-graph' });
  const ref = openModal({
    title: 'Connections graph',
    body: h('div', {}, h('div', { class: 'kbx-row', style: { gap: '8px', alignItems: 'center', marginBottom: '8px' } }, h('span', { class: 'kbx-muted', style: { fontSize: '13px' } }, 'Depth'), depthSel, caption), canvas),
    wide: true,
  });
  let cy = null;
  depthSel.addEventListener('change', draw);

  async function draw() {
    caption.textContent = 'Loading…';
    let graph;
    try { graph = await api.graph({ root: entry.id, depth: Number(depthSel.value), limit: 150 }); }
    catch (e) { caption.textContent = `Could not load the graph: ${e.message}`; return; }
    caption.textContent = graphCaption(graph);
    if (!window.cytoscape) { caption.textContent += ' · graph library not loaded'; return; }
    if (!ref.dialog.open) return;
    const els = graphElements(graph, entry.id);
    if (cy) { cy.destroy(); cy = null; }
    cy = window.cytoscape({
      container: canvas,
      elements: [...els.nodes, ...els.edges],
      style: [
        { selector: 'node', style: { shape: 'round-rectangle', 'background-color': GRAPH_COLORS.node, 'border-color': GRAPH_COLORS.nodeBorder, 'border-width': 1.5, color: '#fff', label: 'data(label)', 'text-wrap': 'wrap', 'text-max-width': 180, 'font-size': 11, 'font-weight': 600, 'text-valign': 'center', 'text-halign': 'center', width: 'label', height: 'label', padding: '8px' } },
        { selector: 'node.root', style: { 'background-color': GRAPH_COLORS.root, 'border-color': GRAPH_COLORS.rootBorder, color: '#3d2a00' } },
        { selector: 'node.depth-2, node.depth-3', style: { 'background-color': GRAPH_COLORS.far, 'border-color': '#8a8679', color: GRAPH_COLORS.text } },
        { selector: 'edge', style: { 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'line-color': GRAPH_COLORS.edge, 'target-arrow-color': GRAPH_COLORS.edge, width: 2, label: 'data(label)', 'font-size': 9, color: GRAPH_COLORS.text, 'text-background-color': '#fbfaf7', 'text-background-opacity': 1, 'text-background-padding': '2px' } },
        { selector: 'edge.bridged', style: { 'line-style': 'dashed', 'line-color': GRAPH_COLORS.bridged, 'target-arrow-color': GRAPH_COLORS.bridged } },
      ],
      layout: layoutFor(els),
      userZoomingEnabled: true,
      wheelSensitivity: 0.2,
    });
    cy.on('tap', 'node', (ev) => { const id = ev.target.id(); if (id !== entry.id && onOpenEntry) { ref.close(); onOpenEntry(id); } });
  }

  function layoutFor(els) {
    // cytoscape-dagre is bundled; fall back to the built-in tree layout when it is not registered.
    try {
      if (window.cytoscape && els.nodes.length) {
        return { name: 'dagre', rankDir: 'LR', nodeSep: 18, rankSep: 70, padding: 12 };
      }
    } catch { /* fall through */ }
    return { name: 'breadthfirst', roots: `#${CSS.escape(entry.id)}`, directed: true, padding: 12 };
  }

  ref.dialog.addEventListener('close', () => { if (cy) { cy.destroy(); cy = null; } });
  draw();
}
