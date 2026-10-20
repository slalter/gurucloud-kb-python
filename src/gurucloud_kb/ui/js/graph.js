/* Graph tab — the bank's knowledge graph, searched the way an agent searches it.

   Two states:
     • no query: the whole bank as constellations (every entry_edges row,
       laid out component by component, no overlap; GET /edges paged);
     • a query: POST /search with the Graph tab's knobs (k, collapse on/off,
       neighbors per result) rendered twice — the ANSWER as the agent reads it
       (ranked results, `related` pointers with relation, kind, text and note,
       the collapse summary, raw JSON on demand) and the same answer as a
       graph. By default the answer is painted onto the whole-bank picture
       (retrieved entries and the entries the pointers name light up with
       their connections, everything else dims, the camera fits the lit set;
       entries with no connections yet are added in a row underneath);
       "Answer only" draws just the answer with dagre.

   Pure logic lives in graph_model.js (Node-tested); this file is DOM only. */

import { h, mount, clear, toast, skeleton, esc, num } from './dom.js';
import { openEntryDetail } from './entry_detail.js';
import {
  DEFAULTS, MAX_BANK_EDGES, RELATION_COLORS, agentView, bankGraph, edgePages, labelFor, normalizeOptions, overlayPlan, pointerLine,
  resultsOf, searchGraph, searchPayload, settingsKey,
} from './graph_model.js';

const COLORS = { hit: '#72a6ab', hitBorder: '#456f73', folded: '#f2b23a', foldedBorder: '#a06a00', neighbor: '#cfd8d9', neighborBorder: '#8a9a9c', ctx: '#e6e3dc', ctxBorder: '#b7b3a8', bank: '#72a6ab', bankBorder: '#456f73', text: '#2b2f2b' };

export function createGraphView(ctx) {
  const { api } = ctx;
  const el = h('div', {});
  let cy = null;
  let loaded = false;
  let bankEdges = null;     // every edge in the bank, once fetched
  let bankEnds = {};        // id -> entry-like (labels learnt from searches and clicks)
  let lastAnswer = null;    // { payload, data, results, view, graph }
  let busy = false;

  // ── controls ───────────────────────────────────────────────────────────────
  const queryInput = h('input', { class: 'kbx-input', type: 'search', placeholder: 'Ask the bank the way an agent would…', dataset: { role: 'graph-query' } });
  const kInput = h('input', { class: 'kbx-input', type: 'number', min: '1', max: '20', value: String(DEFAULTS.k), title: 'Results returned (top-K)', dataset: { role: 'graph-k' } });
  const collapseCb = h('input', { type: 'checkbox', checked: DEFAULTS.collapse, dataset: { role: 'graph-collapse' } });
  const neighborsSel = h('select', { class: 'kbx-select', dataset: { role: 'graph-neighbors' } }, ...[0, 1, 2, 3, 4, 5, 6].map((n) => h('option', { value: String(n), selected: n === DEFAULTS.maxNeighbors ? true : undefined }, `${n} per result`)));
  const contextCb = h('input', { type: 'checkbox', checked: DEFAULTS.context ? true : undefined, dataset: { role: 'graph-context' } });
  const viewSel = h('select', { class: 'kbx-select', dataset: { role: 'graph-view' }, title: 'In the bank: the answer lit up inside the whole-bank picture. Answer only: just the retrieved entries and their pointers.' }, h('option', { value: 'bank' }, 'In the bank'), h('option', { value: 'answer' }, 'Answer only'));
  const searchBtn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button', dataset: { role: 'graph-search' }, onClick: runSearch }, h('i', { class: 'bi bi-search' }), 'Search');
  const clearBtn = h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', dataset: { role: 'graph-clear' }, onClick: () => { queryInput.value = ''; lastAnswer = null; drawBank(); } }, 'Whole bank');
  queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  [kInput, collapseCb, neighborsSel, contextCb, viewSel].forEach((i) => i.addEventListener('change', () => { saveSettings(); if (lastAnswer && (i === contextCb || i === viewSel)) redrawAnswer(); }));
  collapseCb.addEventListener('change', () => { neighborsSel.disabled = !collapseCb.checked; });

  const toolbar = h('div', { class: 'kbx-card' },
    h('div', { class: 'kbx-card-head' },
      h('div', {}, h('h3', { class: 'kbx-card-title' }, 'Graph'), h('div', { class: 'kbx-card-sub' }, 'Search the bank the way an agent does and see both what comes back and how it hangs together. No query shows every connection in the bank.')),
      h('div', { class: 'kbx-row', style: { gap: '6px' } }, clearBtn, searchBtn)),
    h('div', { class: 'kbx-map-toolbar' },
      h('div', { class: 'kbx-field', style: { flex: '1 1 320px' } }, h('label', {}, 'Query (what the agent asks)'), queryInput),
      field('Top-K', kInput),
      h('div', { class: 'kbx-field' }, h('label', {}, ' '), h('label', { class: 'kbx-check', title: 'Fold connected results into one representative with related pointers (the default every agent gets)' }, collapseCb, 'Collapse (pointers)')),
      field('Neighbors', neighborsSel),
      h('div', { class: 'kbx-field' }, h('label', {}, ' '), h('label', { class: 'kbx-check', title: 'Also draw every other connection of the retrieved entries, not only the ones the agent is told about' }, contextCb, 'Show other connections')),
      field('Picture', viewSel)));
  function field(label, input) { return h('div', { class: 'kbx-field' }, h('label', {}, label), input); }

  // ── stage ──────────────────────────────────────────────────────────────────
  const canvas = h('div', { class: 'kbx-map-canvas', dataset: { role: 'graph-canvas' } });
  const overlay = h('div', { class: 'kbx-map-overlay', style: { display: 'none' } });
  const tip = h('div', { class: 'kbx-map-tip' });
  const caption = h('span', { class: 'kbx-chip muted', dataset: { role: 'graph-caption' } }, '…');
  const hud = h('div', { class: 'kbx-map-hud' },
    caption,
    h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', title: 'Fit', onClick: () => cy && cy.animate({ fit: { padding: 30 } }, { duration: 250 }) }, h('i', { class: 'bi bi-arrows-fullscreen' })),
    h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', title: 'Zoom in', onClick: () => zoomBy(1.3) }, h('i', { class: 'bi bi-zoom-in' })),
    h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', title: 'Zoom out', onClick: () => zoomBy(1 / 1.3) }, h('i', { class: 'bi bi-zoom-out' })));
  const legend = h('div', { class: 'kbx-map-legend kbx-graph-legend' },
    h('span', {}, h('i', { class: 'g-hit' }), 'retrieved (#rank)'),
    h('span', {}, h('i', { class: 'g-folded' }), 'pointer: folded into a result'),
    h('span', {}, h('i', { class: 'g-neighbor' }), 'pointer: one hop off the results'),
    h('span', {}, h('i', { class: 'g-ctx' }), 'other connection'),
    h('span', {}, h('i', { class: 'g-edge' }), 'edge the agent is told about'));
  const canvasWrap = h('div', { class: 'kbx-map-canvas-wrap' }, canvas, hud, legend, tip, overlay);

  const answerHost = h('div', { dataset: { role: 'graph-answer' } });
  const selectedHost = h('div', { dataset: { role: 'graph-selected' } }, h('div', { class: 'kbx-hint' }, 'Click a node to see the entry and its connections.'));
  const side = h('div', { class: 'kbx-map-side' },
    h('div', { class: 'kbx-side-card' }, h('div', { class: 'kbx-side-title' }, 'What the agent gets back'), answerHost),
    h('div', { class: 'kbx-side-card' }, h('div', { class: 'kbx-side-title' }, 'Selected'), selectedHost));
  const stage = h('div', { class: 'kbx-map-stage' }, canvasWrap, side);
  mount(el, toolbar, stage);

  function zoomBy(f) { if (cy) cy.zoom({ level: cy.zoom() * f, renderedPosition: { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 } }); }
  function showOverlay(node) { mount(overlay, node); overlay.style.display = 'flex'; }
  function hideOverlay() { overlay.style.display = 'none'; }

  // ── settings (per bank, per viewer) ───────────────────────────────────────
  const storeKey = settingsKey(api.kbId);
  function saveSettings() { try { localStorage.setItem(storeKey, JSON.stringify(options())); } catch { /* ignore */ } }
  function loadSettings() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(storeKey) || 'null'); } catch { s = null; }
    if (!s) return;
    const o = normalizeOptions(s);
    kInput.value = String(o.k); collapseCb.checked = o.collapse; neighborsSel.value = String(o.maxNeighbors); contextCb.checked = o.context; viewSel.value = o.view;
    neighborsSel.disabled = !o.collapse;
  }
  function options() { return normalizeOptions({ k: kInput.value, collapse: collapseCb.checked, maxNeighbors: neighborsSel.value, context: contextCb.checked, view: viewSel.value }); }

  // ── drawing ────────────────────────────────────────────────────────────────
  function baseStyle() {
    const relColor = (e) => RELATION_COLORS[e.data('relation')] || RELATION_COLORS.connected;
    return [
      { selector: 'node', style: { shape: 'round-rectangle', 'background-color': COLORS.hit, 'border-color': COLORS.hitBorder, 'border-width': 1.5, color: '#fff', label: 'data(label)', 'text-wrap': 'wrap', 'text-max-width': 170, 'font-size': 11, 'font-weight': 600, 'text-valign': 'center', 'text-halign': 'center', width: 'label', height: 'label', padding: '8px', 'font-family': 'Aspekta, -apple-system, Segoe UI, Roboto, sans-serif' } },
      { selector: 'node.hit', style: { 'z-index': 10 } },
      { selector: 'node.folded', style: { 'background-color': COLORS.folded, 'border-color': COLORS.foldedBorder, color: '#3d2a00', 'font-weight': 500 } },
      { selector: 'node.neighbor', style: { 'background-color': COLORS.neighbor, 'border-color': COLORS.neighborBorder, color: COLORS.text, 'font-weight': 500 } },
      { selector: 'node.ctx', style: { 'background-color': COLORS.ctx, 'border-color': COLORS.ctxBorder, color: '#5b5b5b', 'font-weight': 400, 'font-size': 10 } },
      // Constellation dots carry no label until selected: at the zoom a small bank fits to, every label
      // would be poster-sized and two neighbours' labels would print over each other.
      { selector: 'node.bank', style: { shape: 'ellipse', width: 'data(d)', height: 'data(d)', padding: '0px', 'background-color': COLORS.bank, 'border-color': COLORS.bankBorder, 'border-width': 1, label: '' } },
      { selector: 'node.bank.hit', style: { width: 22, height: 22, 'background-color': COLORS.hit, 'border-color': '#2e3538', 'border-width': 2.5, label: 'data(label)', 'font-size': 10, 'font-weight': 600, color: COLORS.text, 'text-valign': 'bottom', 'text-margin-y': 5, 'text-wrap': 'wrap', 'text-max-width': 150, 'text-background-color': '#fbfaf7', 'text-background-opacity': 0.9, 'text-background-padding': '2px', 'z-index': 11 } },
      // Pointer targets in the bank picture stay unlabelled (hover or select for the text): their labels sat on top of the hits' labels in a tight constellation.
      { selector: 'node.bank.folded', style: { width: 14, height: 14, 'background-color': COLORS.folded, 'border-color': COLORS.foldedBorder, 'border-width': 1.5, 'z-index': 10 } },
      { selector: 'node.bank.neighbor', style: { width: 14, height: 14, 'background-color': COLORS.neighbor, 'border-color': COLORS.neighborBorder, 'border-width': 1.5, 'z-index': 10 } },
      { selector: 'node.bank.ctx', style: { 'background-color': COLORS.ctx, 'border-color': COLORS.ctxBorder } },
      { selector: 'node.dim', style: { opacity: 0.14 } },
      { selector: 'edge.dim', style: { opacity: 0.08 } },
      { selector: 'node.bank:selected', style: { label: 'data(label)', 'font-size': 10, 'font-weight': 500, color: COLORS.text, 'text-valign': 'bottom', 'text-margin-y': 5, 'text-wrap': 'wrap', 'text-max-width': 150, 'text-background-color': '#fbfaf7', 'text-background-opacity': 0.9, 'text-background-padding': '2px', 'background-color': COLORS.folded, 'border-color': COLORS.foldedBorder, 'z-index': 10 } },
      { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#2e3538' } },
      { selector: 'edge', style: { 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'arrow-scale': 0.8, width: 1.4, 'line-color': relColor, 'target-arrow-color': relColor, opacity: 0.85, label: 'data(label)', 'font-size': 9, color: COLORS.text, 'text-background-color': '#fbfaf7', 'text-background-opacity': 1, 'text-background-padding': '2px', 'text-rotation': 'autorotate' } },
      { selector: 'edge.pointer', style: { width: 2.6, opacity: 1 } },
      { selector: 'edge.ctx', style: { opacity: 0.45, 'line-style': 'dashed', label: '' } },
      { selector: 'edge.bank', style: { label: '', width: 1, opacity: 0.6, 'arrow-scale': 0.5 } },
      { selector: 'edge[source_kind = "backfill_metadata"]', style: { 'line-style': 'dotted' } },
      { selector: 'edge.lit', style: { width: 2.8, opacity: 1, 'z-index': 9 } },
    ];
  }

  function makeCy(elements, layout, { maxZoom = 6 } = {}) {
    if (cy) { cy.destroy(); cy = null; }
    if (!window.cytoscape) { showOverlay(h('div', { class: 'kbx-alert danger' }, 'Graph library not loaded.')); return null; }
    cy = window.cytoscape({ container: canvas, elements, layout, style: baseStyle(), minZoom: 0.05, maxZoom, wheelSensitivity: 0.25, boxSelectionEnabled: false });
    cy.on('tap', 'node', (evt) => selectNode(evt.target));
    cy.on('mouseover', 'node', (evt) => showTip(evt));
    cy.on('mouseover', 'edge', (evt) => showEdgeTip(evt));
    cy.on('mouseout', 'node, edge', () => { tip.style.display = 'none'; });
    return cy;
  }

  function layoutFor(graph) {
    const n = graph.nodes.length;
    if (window.cytoscape && n) {
      try { return { name: 'dagre', rankDir: n > 24 ? 'TB' : 'LR', nodeSep: 22, rankSep: 90, edgeSep: 16, padding: 20, fit: true }; } catch { /* fall through */ }
    }
    return { name: 'cose', animate: false, fit: true, padding: 20 };
  }

  function showTip(evt) {
    const d = evt.target.data();
    const parts = [];
    if (d.kind === 'hit') parts.push(`<span class="kbx-tip-k">#${d.rank}</span>score ${Number(d.score).toFixed(3)}`);
    else if (d.kind === 'folded' || d.kind === 'neighbor') parts.push(`<span class="kbx-tip-k">${d.kind}</span>${esc(String(d.relation || '').replace(/_/g, ' '))}`);
    else if (d.kind === 'bank') parts.push(`<span class="kbx-tip-k">${d.degree} connection${d.degree === 1 ? '' : 's'}</span>`);
    if (d.text) parts.push(esc(d.text));
    if (d.note) parts.push(`<i>${esc(d.note)}</i>`);
    if (!d.text && d.kind === 'bank') parts.push(`<span class="kbx-mono">${esc(String(d.id).slice(0, 8))}</span> · click to load`);
    placeTip(evt, parts.map((p) => `<div>${p}</div>`).join(''));
  }
  function showEdgeTip(evt) {
    const d = evt.target.data();
    placeTip(evt, `<div><span class="kbx-tip-k">${esc(String(d.relation || '').replace(/_/g, ' '))}</span>${esc(d.source_kind || '')}</div>${d.note ? `<div><i>${esc(d.note)}</i></div>` : '<div class="kbx-muted">no note</div>'}`);
  }
  function placeTip(evt, html) {
    tip.innerHTML = html;
    const p = evt.renderedPosition || (evt.target.renderedPosition && evt.target.renderedPosition());
    if (!p) return;
    tip.style.left = `${Math.min(p.x, canvas.clientWidth - 320)}px`; tip.style.top = `${p.y}px`; tip.style.display = 'block';
  }

  // ── whole bank ─────────────────────────────────────────────────────────────
  async function fetchBankEdges() {
    if (bankEdges) return bankEdges;
    const stats = await api.edgeStats();
    const total = Number(stats && stats.total) || 0;
    const pages = edgePages(Math.min(total, MAX_BANK_EDGES));
    const out = [];
    for (const page of pages) { // sequential: the service lists newest first; order within is stable
      const resp = await api.listEdges(page);
      out.push(...((resp && resp.edges) || []));
    }
    bankEdges = out;
    bankEdges.total = total;
    return out;
  }

  async function drawBank() {
    clear(answerHost);
    answerHost.append(h('div', { class: 'kbx-hint' }, 'Type a query and press Search to see what an agent would get back for it.'));
    showOverlay(skeleton('Loading the bank’s connections…'));
    let edges;
    try { edges = await fetchBankEdges(); }
    catch (e) { showOverlay(h('div', { class: 'kbx-alert danger' }, `Could not load connections: ${e.message}`)); return; }
    if (!edges.length) {
      hideOverlay();
      if (cy) { cy.destroy(); cy = null; }
      caption.textContent = 'no connections yet';
      showOverlay(h('div', { class: 'kbx-empty' }, h('i', { class: 'bi bi-share' }), h('h4', {}, 'No connections yet'), h('div', {}, 'Agents add them with report_learning connections; the backfill reads citations and typed metadata.')));
      return;
    }
    const graph = bankGraph(edges, { ends: bankEnds });
    hideOverlay();
    // A small bank fits at a high zoom; cap it so dots stay dots.
    makeCy([...graph.nodes, ...graph.edges], { name: 'preset', fit: true, padding: 40 }, { maxZoom: 2.5 });
    caption.textContent = `${num(graph.stats.nodes)} entries · ${num(graph.stats.edges)} connections · ${num(graph.stats.components)} constellations${graph.stats.truncated ? ` · first ${num(MAX_BANK_EDGES)} of ${num(edges.total)} edges` : ''}`;
  }

  // ── search ─────────────────────────────────────────────────────────────────
  async function runSearch() {
    if (busy) return;
    let payload;
    try { payload = searchPayload({ schema: ctx.getSchema(), query: queryInput.value, ...options() }); }
    catch (e) { toast(e.message, 'warning'); queryInput.focus(); return; }
    busy = true; searchBtn.classList.add('is-loading');
    mount(answerHost, skeleton('Searching…'));
    try {
      const data = await api.search(payload);
      const results = resultsOf(data);
      results.forEach((r) => { bankEnds[r.id] = r; (r.related || []).forEach((p) => { if (!bankEnds[p.id]) bankEnds[p.id] = p; }); });
      // The results' real connections (one call per result, four at a time).
      const connections = {};
      const queue = results.map((r) => r.id);
      const worker = async () => { while (queue.length) { const id = queue.shift(); try { connections[id] = await api.entryConnections(id); } catch { connections[id] = null; } } };
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
      Object.values(connections).forEach((c) => { if (!c) return; [...(c.outgoing || []), ...(c.incoming || [])].forEach((e) => { if (e.other && e.other.id && !bankEnds[e.other.id]) bankEnds[e.other.id] = e.other; }); });
      lastAnswer = { payload, data, results, connections };
      redrawAnswer();
    } catch (e) {
      mount(answerHost, h('div', { class: 'kbx-alert danger' }, `Search failed: ${e.message}`));
    } finally {
      busy = false; searchBtn.classList.remove('is-loading');
    }
  }

  function redrawAnswer() {
    if (!lastAnswer) return;
    const o = options();
    const view = agentView(lastAnswer.results, { collapse: Boolean(lastAnswer.payload.collapse) });
    const graph = searchGraph(lastAnswer.results, lastAnswer.connections, { context: o.context });
    lastAnswer.view = view; lastAnswer.graph = graph;
    renderAnswer(view, lastAnswer.payload, lastAnswer.data, graph.stats);
    hideOverlay();
    if (!graph.nodes.length) {
      if (cy) { cy.destroy(); cy = null; }
      caption.textContent = 'no results';
      showOverlay(h('div', { class: 'kbx-empty' }, h('i', { class: 'bi bi-search' }), h('h4', {}, 'Nothing above the threshold'), h('div', {}, 'Try another wording or a lower threshold.')));
      return;
    }
    if (o.view === 'bank' && bankEdges && bankEdges.length) {
      paintOnBank(graph);
    } else {
      makeCy([...graph.nodes, ...graph.edges], layoutFor(graph));
    }
    caption.textContent = `${graph.stats.hits} retrieved · ${graph.stats.pointers} pointed at · ${graph.stats.context} other · ${graph.stats.edges} edges`;
  }

  /** The answer lit up inside the whole-bank picture: the constellation is
      redrawn from the cached edges, hits and pointer targets get their classes
      and labels, entries with no connections are added underneath, the rest
      dims and the camera fits the lit set. */
  function paintOnBank(graph) {
    const bank = bankGraph(bankEdges, { ends: bankEnds });
    makeCy([...bank.nodes, ...bank.edges], { name: 'preset', fit: false }, { maxZoom: 2.5 });
    if (!cy) return;
    const bb = cy.nodes().length ? cy.nodes().boundingBox() : { x1: 0, y1: 0, x2: 0, y2: 0 };
    const plan = overlayPlan(graph, new Set(cy.nodes().map((n) => n.id())), bb);
    cy.batch(() => {
      cy.elements().addClass('dim');
      plan.mark.forEach((m) => { const n = cy.$id(m.id); n.removeClass('dim'); n.addClass(m.kind); n.data('kind', m.kind); if (m.kind === 'hit') n.data('rank', m.rank); n.data('label', m.label); if (m.text) n.data('text', m.text); });
      if (plan.added.length) cy.add(plan.added);
      plan.edges.forEach((e) => {
        const existing = cy.$id(e.data.id);
        if (existing.length) { existing.removeClass('dim'); existing.addClass(e.classes || ''); existing.addClass('lit'); return; }
        if (cy.$id(e.data.source).length && cy.$id(e.data.target).length) cy.add({ data: e.data, classes: `${e.classes || ''} lit` });
      });
      // Connections between lit entries that the answer itself did not name still read as context.
      cy.edges('.dim').forEach((e) => { if (!e.source().hasClass('dim') && !e.target().hasClass('dim')) e.removeClass('dim'); });
    });
    const lit = cy.nodes().filter((n) => !n.hasClass('dim'));
    if (lit.length) cy.fit(lit.closedNeighborhood(), 70); else cy.fit(undefined, 40);
    if (plan.orphanCount) toast(`${plan.orphanCount} retrieved entr${plan.orphanCount === 1 ? 'y has' : 'ies have'} no connections yet; shown under the constellations`, 'info');
  }

  function renderAnswer(view, payload, raw, stats) {
    const o = options();
    const head = h('div', { class: 'kbx-graph-answer-head' },
      h('div', {}, h('b', {}, 'query_knowledge_bank'), ` · k=${payload.k} · collapse ${payload.collapse ? 'on' : 'off'}${payload.collapse ? ` · ${payload.collapse.max_neighbors} neighbors/result` : ''}`),
      view.collapse ? h('div', { class: 'kbx-muted', dataset: { role: 'graph-collapse-summary' } }, `collapse: ${view.collapse.groups} group${view.collapse.groups === 1 ? '' : 's'}, ${view.collapse.folded} folded, ${view.collapse.neighbors} neighbor${view.collapse.neighbors === 1 ? '' : 's'}`) : h('div', { class: 'kbx-muted' }, 'flat ranking (no pointers)'));
    const list = h('div', { class: 'kbx-graph-answer', dataset: { role: 'graph-results' } });
    if (!view.results.length) list.append(h('div', { class: 'kbx-hint' }, 'No results.'));
    view.results.forEach((r) => {
      const ptrs = (r.related || []).map((p) => h('div', { class: `kbx-ptr ${p.kind === 'neighbor' ? 'neighbor' : 'folded'}`, dataset: { entryId: p.id }, title: p.id, onClick: (e) => { e.stopPropagation(); focusNode(p.id); } }, pointerLine(p)));
      if (r.related_truncated) ptrs.push(h('div', { class: 'kbx-ptr muted' }, `+${r.related_truncated} more connected entries not listed`));
      list.append(h('div', { class: 'kbx-graph-result', dataset: { entryId: r.id, role: 'graph-result' }, onClick: () => focusNode(r.id) },
        h('div', { class: 'kbx-row', style: { gap: '6px', alignItems: 'baseline' } }, h('span', { class: 'kbx-chip' }, `#${r.rank}`), h('span', { class: 'kbx-mono kbx-muted', style: { fontSize: '11px' } }, r.id.slice(0, 8)), h('span', { class: 'kbx-muted', style: { fontSize: '11px' } }, `score ${r.score}`)),
        h('div', { class: 'kbx-graph-result-text' }, r.summary || r.useful_for || r.content.slice(0, 200)),
        ptrs.length ? h('div', { class: 'kbx-graph-ptrs' }, ...ptrs) : null));
    });
    const rawPre = h('pre', { class: 'kbx-graph-raw', style: { display: 'none' }, dataset: { role: 'graph-raw' } }, JSON.stringify({ request: payload, response: raw }, null, 2));
    const rawBtn = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', dataset: { role: 'graph-raw-toggle' }, onClick: () => { const on = rawPre.style.display === 'none'; rawPre.style.display = on ? 'block' : 'none'; rawBtn.textContent = on ? 'Hide raw JSON' : 'Raw JSON'; } }, 'Raw JSON');
    mount(answerHost, head, list, h('div', { class: 'kbx-row', style: { gap: '6px', marginTop: '6px' } }, rawBtn, h('span', { class: 'kbx-muted', style: { fontSize: '12px' } }, `${o.view === 'bank' ? 'lit up in the bank' : 'answer only'} · ${o.context ? `${stats.context} other connections drawn` : 'other connections hidden'}`)), rawPre);
  }

  function focusNode(id) {
    if (!cy) return;
    const n = cy.$id(id);
    if (!n.length) return;
    cy.nodes().unselect(); n.select();
    cy.animate({ center: { eles: n }, zoom: Math.max(cy.zoom(), 1) }, { duration: 250 });
    selectNode(n);
  }

  async function selectNode(n) {
    const d = n.data();
    cy.nodes().unselect(); n.select();
    cy.edges().removeClass('lit'); n.connectedEdges().addClass('lit');
    let entry = bankEnds[d.id];
    if (!entry || !(entry.content || entry.summary || entry.useful_for || entry.text)) {
      mount(selectedHost, skeleton('Loading entry…'));
      try { entry = await api.getEntry(d.id); bankEnds[d.id] = entry; n.data('label', d.kind === 'bank' ? labelFor(entry) : n.data('label')); n.data('text', labelFor(entry)); }
      catch (e) { mount(selectedHost, h('div', { class: 'kbx-alert danger' }, `Could not load the entry: ${e.message}`)); return; }
    }
    const conns = n.connectedEdges().map((e) => e.data());
    mount(selectedHost,
      h('div', { class: 'kbx-row', style: { gap: '6px', alignItems: 'center' } }, h('span', { class: `kbx-chip ${d.kind === 'hit' ? '' : 'muted'}` }, d.kind === 'hit' ? `retrieved #${d.rank}` : d.kind === 'bank' ? `${d.degree} connections` : d.kind), h('span', { class: 'kbx-mono kbx-muted', style: { fontSize: '11px' } }, String(d.id).slice(0, 8))),
      h('div', { class: 'kbx-graph-selected-text' }, labelFor(entry)),
      entry.useful_for && labelFor(entry) !== entry.useful_for ? h('div', { class: 'kbx-muted', style: { fontSize: '12px', marginTop: '4px' } }, entry.useful_for) : null,
      h('div', { class: 'kbx-row', style: { gap: '6px', marginTop: '8px' } },
        h('button', { class: 'kbx-btn kbx-btn-sm kbx-btn-primary', type: 'button', dataset: { role: 'graph-open-entry' }, onClick: () => openEntryDetail(ctx, d.id) }, 'Open entry'),
        h('button', { class: 'kbx-btn kbx-btn-sm kbx-btn-ghost', type: 'button', dataset: { role: 'graph-expand' }, onClick: () => expandNode(d.id) }, 'Show its connections')),
      conns.length ? h('div', { class: 'kbx-graph-ptrs', style: { marginTop: '8px' } }, ...conns.map((e) => h('div', { class: `kbx-ptr ${e.source_kind === 'pointer' || String(e.id).startsWith('ptr:') ? 'folded' : 'muted'}` }, `${String(e.relation || '').replace(/_/g, ' ')} ${e.source === d.id ? '→' : '←'} ${labelFor(bankEnds[e.source === d.id ? e.target : e.source]) || String(e.source === d.id ? e.target : e.source).slice(0, 8)}${e.note ? ` — ${e.note}` : ''}`))) : h('div', { class: 'kbx-hint', style: { marginTop: '8px' } }, 'No drawn connections.'));
  }

  /** Add one node's full neighbourhood to the current picture (one hop). */
  async function expandNode(id) {
    if (!cy) return;
    let conns;
    try { conns = await api.entryConnections(id); } catch (e) { toast(`Could not load connections: ${e.message}`, 'error'); return; }
    const added = [];
    [...(conns.outgoing || []), ...(conns.incoming || [])].forEach((e) => {
      const other = e.other || {};
      if (other.id && !bankEnds[other.id]) bankEnds[other.id] = other;
      if (other.id && !cy.$id(other.id).length) {
        added.push({ data: { id: other.id, label: labelFor(other), kind: 'ctx', text: labelFor(other), relation: e.edge_type }, classes: 'ctx' });
      }
      if (!cy.$id(e.id).length && e.from_entry_id && e.to_entry_id) {
        added.push({ data: { id: e.id, source: e.from_entry_id, target: e.to_entry_id, relation: e.edge_type, label: String(e.edge_type || '').replace(/_/g, ' '), note: e.note || '', source_kind: e.source || 'author' }, classes: 'ctx' });
      }
    });
    if (!added.length) { toast('Every connection of this entry is already drawn', 'info'); return; }
    const inBank = cy.nodes('.bank').length > 0;
    const els = cy.add(added.filter((a) => !a.data.source || (cy.$id(a.data.source).length || added.some((b) => b.data.id === a.data.source)) && (cy.$id(a.data.target).length || added.some((b) => b.data.id === a.data.target))));
    if (inBank) {
      // Keep the constellation still: place new nodes on a small ring around the expanded one.
      const c = cy.$id(id).position();
      const newNodes = els.nodes();
      newNodes.forEach((n, i) => { const a = (2 * Math.PI * i) / newNodes.length; n.position({ x: c.x + 46 * Math.cos(a), y: c.y + 46 * Math.sin(a) }); });
      newNodes.addClass('bank');
    } else {
      cy.layout(layoutFor({ nodes: cy.nodes().toArray() })).run();
    }
    toast(`${els.nodes().length} entr${els.nodes().length === 1 ? 'y' : 'ies'} added`, 'success');
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  async function load() {
    if (loaded) return;
    loaded = true;
    loadSettings();
    await drawBank();
  }
  function onShow() { if (cy) cy.resize(); }

  return { el, load, onShow };
}
