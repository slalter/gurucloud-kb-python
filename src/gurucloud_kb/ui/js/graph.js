/* Graph tab — the bank's knowledge graph in 3D, searched the way an agent searches it.

   One three.js force graph (3d-force-graph, loaded on first use from the
   bundle's vendor/) shows every entry-to-entry connection in the bank. A
   query runs the bank's real search with the agent's knobs (top-K, collapse
   on/off, neighbors per result) and paints the answer onto that picture:
   retrieved entries and the entries the pointers name light up, particles
   travel along the edges the agent was told about, and everything else
   shrinks to dust (default), hides, or merely dims. The right-hand panel
   shows the answer as the agent reads it (ranked results, `related`
   pointers with relation, kind, text and note, the collapse summary, raw
   request + response JSON).

   Layout is the graph's own forces, or semantic: the service's
   GET /graph/layout projects the connected entries' embeddings to three
   axes (kb_service/graph_layout.py) so distance means meaning and the edges
   show where the graph cuts across it. The first request starts the
   projection in the background; the tab polls until it is ready.

   Pure logic lives in graph_model.js (Node-tested); this file is DOM/WebGL. */

import { h, mount, clear, toast, skeleton, esc, num } from './dom.js';
import { openEntryDetail } from './entry_detail.js';
import {
  DEFAULTS, MAX_BANK_EDGES, RELATION_COLORS, agentView, fitPlan, flyTarget, labelFor, layoutCaption, neighbourhood, normalizeOptions,
  pictureOptions, pinPositions, pointerLine, resultsOf, scene, searchGraph, searchPayload, settingsKey,
} from './graph_model.js';
import { ensureForceGraph3D as ensureLib, loadBankEdges } from './graph3d.js';

const COLORS = { hit: '#5ee0c8', folded: '#f2b23a', neighbor: '#b7c4c6', ctx: '#8fa6aa', bank: '#72a6ab', bankDim: '#2d4448', dust: '#3a5054', bg: '#0f1719', selected: '#ffffff' };
const SEM_SCALE = 420;
const POLL_MS = 4000;
const POLL_MAX = 40;


export function createGraphView(ctx) {
  const { api } = ctx;
  const el = h('div', {});
  let fg = null;
  let loaded = false;
  let bankEdges = null;          // every entry-to-entry edge in the bank (paged GET /edges)
  let extraEdges = [];           // edges revealed by "Show its connections"
  const bankEnds = {};           // id -> entry-like, for labels
  let lastAnswer = null;         // { payload, data, results, connections }
  const layouts = {};            // space -> GET /graph/layout body
  let pollTimer = null;
  let pollCount = 0;
  let busy = false;
  let selectedId = null;
  let pendingFit = null;         // what the next engine stop frames (fitPlan); consumed once
  let userMoved = false;         // the user rotated/zoomed since the last picture change

  // ── controls ───────────────────────────────────────────────────────────────
  const queryInput = h('input', { class: 'kbx-input', type: 'search', placeholder: 'Ask the bank the way an agent would…', dataset: { role: 'graph-query' } });
  const kInput = h('input', { class: 'kbx-input', type: 'number', min: '1', max: '20', value: String(DEFAULTS.k), title: 'Results returned (top-K)', dataset: { role: 'graph-k' } });
  const collapseCb = h('input', { type: 'checkbox', checked: DEFAULTS.collapse, dataset: { role: 'graph-collapse' } });
  const neighborsSel = h('select', { class: 'kbx-select', dataset: { role: 'graph-neighbors' } }, ...[0, 1, 2, 3, 4, 5, 6].map((n) => h('option', { value: String(n), selected: n === DEFAULTS.maxNeighbors ? true : undefined }, `${n} per result`)));
  const contextCb = h('input', { type: 'checkbox', dataset: { role: 'graph-context' } });
  const focusSel = h('select', { class: 'kbx-select', dataset: { role: 'graph-focus' }, title: 'What happens to everything that is not part of the answer' },
    h('option', { value: 'shrink' }, 'shrink the rest'), h('option', { value: 'only' }, 'answer only'), h('option', { value: 'dim' }, 'dim the rest'));
  const layoutSel = h('select', { class: 'kbx-select', dataset: { role: 'graph-layout' }, title: 'Where entries sit: pulled by their connections, or placed by a projection of their embeddings so distance means meaning' },
    h('option', { value: 'force' }, 'by connections (force)'), h('option', { value: 'content' }, 'by meaning: content'), h('option', { value: 'useful_for' }, 'by meaning: useful_for'), h('option', { value: 'both' }, 'by meaning: both'));
  const backfillCb = h('input', { type: 'checkbox', checked: true, dataset: { role: 'graph-hide-backfill' } });
  const searchBtn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button', dataset: { role: 'graph-search' }, onClick: runSearch }, h('i', { class: 'bi bi-search' }), 'Search');
  const clearBtn = h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', dataset: { role: 'graph-clear' }, onClick: () => { queryInput.value = ''; lastAnswer = null; render('picture'); } }, 'Whole bank');
  queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  collapseCb.addEventListener('change', () => { neighborsSel.disabled = !collapseCb.checked; });
  [kInput, collapseCb, neighborsSel].forEach((i) => i.addEventListener('change', saveSettings));
  [contextCb, focusSel, backfillCb].forEach((i) => i.addEventListener('change', () => { saveSettings(); render('picture'); }));
  layoutSel.addEventListener('change', () => { saveSettings(); render('picture'); });

  const toolbar = h('div', { class: 'kbx-card' },
    h('div', { class: 'kbx-card-head' },
      h('div', {}, h('h3', { class: 'kbx-card-title' }, 'Graph'), h('div', { class: 'kbx-card-sub' }, 'Search the bank the way an agent does and see both what comes back and how it hangs together. Drag to rotate, wheel to zoom, click a node to fly to it.')),
      h('div', { class: 'kbx-row', style: { gap: '6px' } }, clearBtn, searchBtn)),
    h('div', { class: 'kbx-map-toolbar' },
      h('div', { class: 'kbx-field', style: { flex: '1 1 320px' } }, h('label', {}, 'Query (what the agent asks)'), queryInput),
      field('Top-K', kInput),
      h('div', { class: 'kbx-field' }, h('label', {}, ' '), h('label', { class: 'kbx-check', title: 'Fold connected results into one representative with related pointers (the default every agent gets)' }, collapseCb, 'Collapse (pointers)')),
      field('Neighbors', neighborsSel),
      h('div', { class: 'kbx-field' }, h('label', {}, ' '), h('label', { class: 'kbx-check', title: 'Also light up every other connection of the retrieved entries, not only the ones the agent is told about' }, contextCb, 'Other connections')),
      field('Rest of the bank', focusSel),
      field('Layout', layoutSel),
      h('div', { class: 'kbx-field' }, h('label', {}, ' '), h('label', { class: 'kbx-check', title: 'Hide the note-less split_from edges the metadata backfill wrote; they turn every picture into a hairball' }, backfillCb, 'Hide backfill siblings'))));
  function field(label, input) { return h('div', { class: 'kbx-field' }, h('label', {}, label), input); }

  // ── stage ──────────────────────────────────────────────────────────────────
  const canvas = h('div', { class: 'kbx-map-canvas kbx-graph3d', dataset: { role: 'graph-canvas' } });
  const overlay = h('div', { class: 'kbx-map-overlay', style: { display: 'none' } });
  const caption = h('span', { class: 'kbx-chip muted', dataset: { role: 'graph-caption' } }, '…');
  const layoutChip = h('span', { class: 'kbx-chip muted', dataset: { role: 'graph-layout-chip' }, style: { display: 'none' } }, '');
  const recomputeBtn = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', title: 'Recompute the semantic layout now', dataset: { role: 'graph-recompute' }, style: { display: 'none' }, onClick: recompute }, h('i', { class: 'bi bi-arrow-repeat' }));
  const hud = h('div', { class: 'kbx-map-hud' },
    caption, layoutChip, recomputeBtn,
    h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', title: 'Fit', dataset: { role: 'graph-fit' }, onClick: () => fitView() }, h('i', { class: 'bi bi-arrows-fullscreen' })));
  const legend = h('div', { class: 'kbx-map-legend kbx-graph-legend' },
    h('span', {}, h('i', { class: 'g-hit' }), 'retrieved (#rank)'),
    h('span', {}, h('i', { class: 'g-folded' }), 'pointer: folded into a result'),
    h('span', {}, h('i', { class: 'g-neighbor' }), 'pointer: one hop off the results'),
    h('span', {}, h('i', { class: 'g-ctx' }), 'other connection'),
    h('span', {}, h('i', { class: 'g-edge' }), 'edge the agent is told about (particles)'));
  const canvasWrap = h('div', { class: 'kbx-map-canvas-wrap kbx-graph3d-wrap' }, canvas, hud, legend, overlay);

  const answerHost = h('div', { dataset: { role: 'graph-answer' } });
  const selectedHost = h('div', { dataset: { role: 'graph-selected' } }, h('div', { class: 'kbx-hint' }, 'Click a node to see the entry and its connections.'));
  const side = h('div', { class: 'kbx-map-side' },
    h('div', { class: 'kbx-side-card' }, h('div', { class: 'kbx-side-title' }, 'What the agent gets back'), answerHost),
    h('div', { class: 'kbx-side-card' }, h('div', { class: 'kbx-side-title' }, 'Selected'), selectedHost));
  mount(el, toolbar, h('div', { class: 'kbx-map-stage' }, canvasWrap, side));

  function showOverlay(node) { mount(overlay, node); overlay.style.display = 'flex'; }
  function hideOverlay() { overlay.style.display = 'none'; }

  // ── settings (per bank, per viewer) ───────────────────────────────────────
  const storeKey = settingsKey(api.kbId);
  function options() { return normalizeOptions({ k: kInput.value, collapse: collapseCb.checked, maxNeighbors: neighborsSel.value, context: contextCb.checked }); }
  function picture() { return pictureOptions({ focus: focusSel.value, layout: layoutSel.value, hideBackfill: backfillCb.checked }); }
  function saveSettings() { try { localStorage.setItem(storeKey, JSON.stringify({ ...options(), ...picture() })); } catch { /* ignore */ } }
  function loadSettings() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(storeKey) || 'null'); } catch { s = null; }
    if (!s) return;
    const o = normalizeOptions(s); const p = pictureOptions(s);
    kInput.value = String(o.k); collapseCb.checked = o.collapse; neighborsSel.value = String(o.maxNeighbors); contextCb.checked = o.context;
    neighborsSel.disabled = !o.collapse; focusSel.value = p.focus; layoutSel.value = p.layout; backfillCb.checked = p.hideBackfill;
  }

  // ── data ───────────────────────────────────────────────────────────────────
  async function fetchBankEdges() {
    if (bankEdges) return bankEdges;
    bankEdges = await loadBankEdges(api, MAX_BANK_EDGES);
    return bankEdges;
  }

  async function fetchLayout(space) {
    try { layouts[space] = await api.graphLayout({ space }); }
    catch (e) { layouts[space] = { space, status: 'unavailable', reason: e.message }; }
    return layouts[space];
  }

  function stopPolling() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } pollCount = 0; }
  function pollLayout(space) {
    stopPolling();
    const tick = async () => {
      pollCount += 1;
      const body = await fetchLayout(space);
      if (body.status === 'computing' && pollCount < POLL_MAX && picture().layout === space) { pollTimer = setTimeout(tick, POLL_MS); return; }
      pollTimer = null;
      if (picture().layout === space) render('auto');
    };
    pollTimer = setTimeout(tick, POLL_MS);
  }

  async function recompute() {
    const space = picture().layout;
    if (space === 'force') return;
    try { await api.recomputeGraphLayout({ space }); toast('Recomputing the semantic layout…', 'info'); layouts[space] = { ...(layouts[space] || { space }), status: layouts[space] && layouts[space].status === 'ready' ? 'ready' : 'computing', stale: true }; pollLayout(space); updateLayoutChip(); }
    catch (e) { toast(`Could not start the layout: ${e.message}`, e.status === 409 ? 'info' : 'error'); }
  }

  // ── drawing ────────────────────────────────────────────────────────────────
  function nodeColor(n) {
    if (n.id === selectedId) return COLORS.selected;
    if (n.kind === 'hit') return COLORS.hit;
    if (n.kind === 'folded') return COLORS.folded;
    if (n.kind === 'neighbor') return COLORS.neighbor;
    if (n.kind === 'ctx') return COLORS.ctx;
    return lastAnswer ? (picture().focus === 'shrink' ? COLORS.dust : COLORS.bankDim) : COLORS.bank;
  }
  function nodeTip(n) {
    const parts = [];
    if (n.kind === 'hit') parts.push(`<b>retrieved #${n.rank}</b>`);
    else if (n.kind === 'folded' || n.kind === 'neighbor') parts.push(`<b>${n.kind} pointer</b>`);
    else if (n.kind === 'ctx') parts.push('<b>other connection</b>');
    const text = n.text || labelFor(bankEnds[n.id]) || String(n.id).slice(0, 8);
    parts.push(esc(text));
    if (n.note) parts.push(`<i>${esc(n.note)}</i>`);
    parts.push(`<span style="opacity:.7">${n.degree || 0} connection${n.degree === 1 ? '' : 's'}</span>`);
    return `<div class="kbx kbx-graph-tip">${parts.join('<br>')}</div>`;
  }
  function linkColor(l) { return l.pointer ? COLORS.folded : (RELATION_COLORS[l.relation] || RELATION_COLORS.connected); }

  /** Redraw; `fit` is the camera intent once the engine settles (see fitPlan). */
  async function render(fit = 'picture') {
    if (!bankEdges) return;
    if (fit !== 'auto') userMoved = false;
    pendingFit = fit;
    const o = options(); const p = picture();
    const answer = lastAnswer ? searchGraph(lastAnswer.results, lastAnswer.connections, { context: o.context }) : null;
    const sc = scene([...bankEdges, ...extraEdges], answer, { focus: p.focus, hideBackfill: p.hideBackfill });
    sc.nodes.forEach((n) => { if (!n.text && bankEnds[n.id]) n.text = labelFor(bankEnds[n.id]); });
    // semantic layout: pin to the service's positions when ready, poll while computing
    let pinned = null;
    if (p.layout !== 'force') {
      const body = layouts[p.layout] || await fetchLayout(p.layout);
      if (body.status === 'ready') pinned = pinPositions(sc.nodes, body.positions, SEM_SCALE);
      else pinPositions(sc.nodes, null);
      if (body.status === 'computing' && !pollTimer) pollLayout(p.layout);
      if (body.status === 'ready' && body.stale && !pollTimer) pollLayout(p.layout);
    } else {
      pinPositions(sc.nodes, null);
      stopPolling();
    }
    updateLayoutChip(pinned);
    if (!sc.nodes.length) {
      if (fg) fg.graphData({ nodes: [], links: [] });
      caption.textContent = lastAnswer ? 'no results' : 'no connections yet';
      showOverlay(h('div', { class: 'kbx-empty' }, h('i', { class: 'bi bi-share' }), h('h4', {}, lastAnswer ? 'Nothing above the threshold' : 'No connections yet'),
        h('div', {}, lastAnswer ? 'Try another wording or a lower threshold.' : 'Agents add them with report_learning connections; the backfill reads citations and typed metadata.')));
      return;
    }
    hideOverlay();
    if (!fg) return;
    const sem = p.layout !== 'force' && pinned;
    fg.cooldownTicks(sem ? 20 : 160).warmupTicks(sem ? 0 : 30);
    fg.d3Force('charge').strength(sem ? -3 : -40);
    fg.graphData({ nodes: sc.nodes, links: sc.links });
    caption.textContent = lastAnswer
      ? `${sc.stats.hits} retrieved · ${Math.max(0, sc.stats.lit - sc.stats.hits)} pointed at · ${sc.stats.links} edges shown${sc.stats.added ? ` · ${sc.stats.added} without connections yet` : ''}`
      : `${num(sc.stats.nodes)} entries · ${num(sc.stats.links)} connections${p.hideBackfill && sc.stats.hiddenBackfill ? ` · ${num(sc.stats.hiddenBackfill)} backfill siblings hidden` : ''}${bankEdges.total > MAX_BANK_EDGES ? ` · first ${num(MAX_BANK_EDGES)} of ${num(bankEdges.total)} edges` : ''}`;
  }

  function updateLayoutChip(pinned) {
    const p = picture();
    if (p.layout === 'force') { layoutChip.style.display = 'none'; recomputeBtn.style.display = 'none'; return; }
    const body = layouts[p.layout];
    layoutChip.textContent = layoutCaption(body) + (pinned && pinned.missing ? ` · ${pinned.missing} placed beside the answer` : '');
    layoutChip.style.display = '';
    recomputeBtn.style.display = body && (body.status === 'ready' || body.status === 'failed') ? '' : 'none';
  }

  /** Frame the picture: the lit answer when there is one, else everything. */
  function fitView() {
    if (!fg) return;
    const lit = lastAnswer ? fg.graphData().nodes.filter((n) => n.lit) : [];
    if (lit.length) fg.zoomToFit(600, 80, (n) => n.lit); else fg.zoomToFit(600, 40);
  }

  /** Engine settled. Any accessor change (a selection recolour) restarts the
      engine without new data, so only a pending render intent moves the camera. */
  function onSettled() {
    if (!fg) return;
    const { nodes, links } = fg.graphData();
    const plan = fitPlan({ pending: pendingFit, userMoved, selectedPresent: nodes.some((n) => n.id === selectedId), litCount: lastAnswer ? nodes.filter((n) => n.lit).length : 0 });
    pendingFit = null;
    if (plan === 'selection') { const ids = neighbourhood(selectedId, links); fg.zoomToFit(600, 80, (n) => ids.has(n.id)); }
    else if (plan !== 'none') fitView();
  }

  function flyTo(n) {
    if (!fg || n.x === undefined) return;
    fg.cameraPosition(flyTarget(n, fg.camera().position, 110), n, 700);
  }

  async function initGraph() {
    try { await ensureLib(); }
    catch (e) { showOverlay(h('div', { class: 'kbx-alert danger' }, `3D graph library not available: ${e.message}`)); return false; }
    try {
      fg = window.ForceGraph3D()(canvas)
        .width(canvas.clientWidth || 800).height(canvas.clientHeight || 560)
        .backgroundColor(COLORS.bg)
        .nodeVal((n) => n.val || 1).nodeColor(nodeColor).nodeOpacity(0.95)
        .nodeLabel(nodeTip)
        .linkColor(linkColor).linkOpacity(0.6).linkWidth((l) => (l.lit ? 1.4 : 0))
        .linkDirectionalParticles((l) => (l.pointer ? 3 : 0)).linkDirectionalParticleWidth(1.8).linkDirectionalParticleColor(() => COLORS.folded)
        .onNodeClick((n) => selectNode(n))
        .onNodeHover((n) => { canvas.style.cursor = n ? 'pointer' : 'default'; })
        .onEngineStop(() => onSettled())
        .enableNodeDrag(false);
    } catch (e) {
      showOverlay(h('div', { class: 'kbx-alert danger' }, `WebGL is needed for the 3D graph: ${e.message}`));
      fg = null;
      return false;
    }
    const controls = fg.controls();
    if (controls && controls.addEventListener) controls.addEventListener('start', () => { userMoved = true; });
    if (window.ResizeObserver) new ResizeObserver(() => { if (fg && canvas.clientWidth) fg.width(canvas.clientWidth).height(canvas.clientHeight); }).observe(canvas);
    return true;
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
      results.forEach((r) => { bankEnds[r.id] = r; (r.related || []).forEach((pt) => { if (!bankEnds[pt.id]) bankEnds[pt.id] = pt; }); });
      const connections = {};
      const queue = results.map((r) => r.id);
      const worker = async () => { while (queue.length) { const id = queue.shift(); try { connections[id] = await api.entryConnections(id); } catch { connections[id] = null; } } };
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
      Object.values(connections).forEach((c) => { if (!c) return; [...(c.outgoing || []), ...(c.incoming || [])].forEach((e) => { if (e.other && e.other.id && e.other.kind !== 'playbook_step' && !bankEnds[e.other.id]) bankEnds[e.other.id] = e.other; }); });
      lastAnswer = { payload, data, results, connections };
      renderAnswer(agentView(results, { collapse: Boolean(payload.collapse) }), payload, data);
      await render();
    } catch (e) {
      mount(answerHost, h('div', { class: 'kbx-alert danger' }, `Search failed: ${e.message}`));
    } finally {
      busy = false; searchBtn.classList.remove('is-loading');
    }
  }

  function renderAnswer(view, payload, raw) {
    const head = h('div', { class: 'kbx-graph-answer-head' },
      h('div', {}, h('b', {}, 'query_knowledge_bank'), ` · k=${payload.k} · collapse ${payload.collapse ? 'on' : 'off'}${payload.collapse ? ` · ${payload.collapse.max_neighbors} neighbors/result` : ''}`),
      view.collapse ? h('div', { class: 'kbx-muted', dataset: { role: 'graph-collapse-summary' } }, `collapse: ${view.collapse.groups} group${view.collapse.groups === 1 ? '' : 's'}, ${view.collapse.folded} folded, ${view.collapse.neighbors} neighbor${view.collapse.neighbors === 1 ? '' : 's'}`) : h('div', { class: 'kbx-muted' }, 'flat ranking (no pointers)'));
    const list = h('div', { class: 'kbx-graph-answer', dataset: { role: 'graph-results' } });
    if (!view.results.length) list.append(h('div', { class: 'kbx-hint' }, 'No results.'));
    view.results.forEach((r) => {
      const ptrs = (r.related || []).map((pt) => h('div', { class: `kbx-ptr ${pt.kind === 'neighbor' ? 'neighbor' : 'folded'}`, dataset: { entryId: pt.id }, title: pt.id, onClick: (e) => { e.stopPropagation(); focusId(pt.id); } }, pointerLine(pt)));
      if (r.related_truncated) ptrs.push(h('div', { class: 'kbx-ptr muted' }, `+${r.related_truncated} more connected entries not listed`));
      list.append(h('div', { class: 'kbx-graph-result', dataset: { entryId: r.id, role: 'graph-result' }, onClick: () => focusId(r.id) },
        h('div', { class: 'kbx-row', style: { gap: '6px', alignItems: 'baseline' } }, h('span', { class: 'kbx-chip' }, `#${r.rank}`), h('span', { class: 'kbx-mono kbx-muted', style: { fontSize: '11px' } }, r.id.slice(0, 8)), h('span', { class: 'kbx-muted', style: { fontSize: '11px' } }, `score ${r.score}`)),
        h('div', { class: 'kbx-graph-result-text' }, r.summary || r.useful_for || r.content.slice(0, 200)),
        ptrs.length ? h('div', { class: 'kbx-graph-ptrs' }, ...ptrs) : null));
    });
    const rawPre = h('pre', { class: 'kbx-graph-raw', style: { display: 'none' }, dataset: { role: 'graph-raw' } }, JSON.stringify({ request: payload, response: raw }, null, 2));
    const rawBtn = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', dataset: { role: 'graph-raw-toggle' }, onClick: () => { const on = rawPre.style.display === 'none'; rawPre.style.display = on ? 'block' : 'none'; rawBtn.textContent = on ? 'Hide raw JSON' : 'Raw JSON'; } }, 'Raw JSON');
    mount(answerHost, head, list, h('div', { class: 'kbx-row', style: { gap: '6px', marginTop: '6px' } }, rawBtn), rawPre);
  }

  function focusId(id) {
    if (!fg) return;
    const n = fg.graphData().nodes.find((x) => x.id === id);
    if (n) selectNode(n);
  }

  async function selectNode(n) {
    selectedId = n.id;
    pendingFit = null; // the user took the camera: a render still settling must not pull it back out
    if (fg) fg.nodeColor(nodeColor); // re-evaluate colours (selected ring)
    flyTo(n);
    let entry = bankEnds[n.id];
    if (!entry || !(entry.content || entry.summary || entry.useful_for || entry.text)) {
      mount(selectedHost, skeleton('Loading entry…'));
      try { entry = await api.getEntry(n.id); bankEnds[n.id] = entry; n.text = labelFor(entry); }
      catch (e) { mount(selectedHost, h('div', { class: 'kbx-alert danger' }, `Could not load the entry: ${e.message}`)); return; }
    }
    const links = fg ? fg.graphData().links.filter((l) => (l.source.id || l.source) === n.id || (l.target.id || l.target) === n.id) : [];
    const chip = n.kind === 'hit' ? `retrieved #${n.rank}` : n.kind === 'bank' ? `${n.degree} connection${n.degree === 1 ? '' : 's'}` : n.kind === 'ctx' ? 'other connection' : `${n.kind} pointer`;
    mount(selectedHost,
      h('div', { class: 'kbx-row', style: { gap: '6px', alignItems: 'center' } }, h('span', { class: `kbx-chip ${n.kind === 'hit' ? '' : 'muted'}` }, chip), h('span', { class: 'kbx-mono kbx-muted', style: { fontSize: '11px' } }, String(n.id).slice(0, 8))),
      h('div', { class: 'kbx-graph-selected-text' }, labelFor(entry)),
      entry.useful_for && labelFor(entry) !== entry.useful_for ? h('div', { class: 'kbx-muted', style: { fontSize: '12px', marginTop: '4px' } }, entry.useful_for) : null,
      h('div', { class: 'kbx-row', style: { gap: '6px', marginTop: '8px' } },
        h('button', { class: 'kbx-btn kbx-btn-sm kbx-btn-primary', type: 'button', dataset: { role: 'graph-open-entry' }, onClick: () => openEntryDetail(ctx, n.id) }, 'Open entry'),
        h('button', { class: 'kbx-btn kbx-btn-sm kbx-btn-ghost', type: 'button', dataset: { role: 'graph-expand' }, onClick: () => expandNode(n.id) }, 'Show its connections')),
      links.length ? h('div', { class: 'kbx-graph-ptrs', style: { marginTop: '8px' } }, ...links.map((l) => {
        const src = l.source.id || l.source; const tgt = l.target.id || l.target; const other = src === n.id ? tgt : src;
        return h('div', { class: `kbx-ptr ${l.pointer ? 'folded' : 'muted'}` }, `${String(l.relation || '').replace(/_/g, ' ')} ${src === n.id ? '→' : '←'} ${labelFor(bankEnds[other]) || String(other).slice(0, 8)}${l.note ? ` — ${l.note}` : ''}`);
      })) : h('div', { class: 'kbx-hint', style: { marginTop: '8px' } }, 'No drawn connections.'));
  }

  /** Reveal one entry's whole neighbourhood (one hop), whatever the focus mode hides. */
  async function expandNode(id) {
    let conns;
    try { conns = await api.entryConnections(id); } catch (e) { toast(`Could not load connections: ${e.message}`, 'error'); return; }
    const known = new Set([...(bankEdges || []), ...extraEdges].map((e) => e.id));
    let added = 0;
    [...(conns.outgoing || []), ...(conns.incoming || [])].forEach((e) => {
      if (!e.to_entry_id || (e.other && e.other.kind === 'playbook_step')) return;
      if (e.other && e.other.id && !bankEnds[e.other.id]) bankEnds[e.other.id] = e.other;
      if (!known.has(e.id)) { extraEdges.push({ ...e, source: e.source === 'pointer' ? 'author' : e.source }); known.add(e.id); added += 1; }
    });
    // mark the neighbourhood as lit so a shrink/only focus shows it
    if (lastAnswer) {
      const extra = [...(conns.outgoing || []), ...(conns.incoming || [])].map((e) => e.other && e.other.id).filter(Boolean);
      lastAnswer.results = lastAnswer.results.map((r) => (r.id === id ? { ...r, related: [...(r.related || []), ...extra.filter((x) => !(r.related || []).some((pt) => pt.id === x)).map((x) => ({ id: x, relation: 'connected', direction: 'outgoing', kind: 'neighbor', text: labelFor(bankEnds[x]) }))] } : r));
      if (!lastAnswer.results.some((r) => r.id === id)) lastAnswer.results = [...lastAnswer.results, { id, content: '', useful_for: labelFor(bankEnds[id]), combined_score: 0, metadata: {}, related: extra.map((x) => ({ id: x, relation: 'connected', direction: 'outgoing', kind: 'neighbor', text: labelFor(bankEnds[x]) })) }];
    }
    await render('selection');
    toast(added ? `${added} connection${added === 1 ? '' : 's'} revealed` : 'Every connection of this entry is already drawn', 'info');
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  async function load() {
    if (loaded) return;
    loaded = true;
    loadSettings();
    clear(answerHost);
    answerHost.append(h('div', { class: 'kbx-hint' }, 'Type a query and press Search to see what an agent would get back for it, lit up inside the bank.'));
    showOverlay(skeleton('Loading the bank’s connections…'));
    const ok = await initGraph();
    try { await fetchBankEdges(); }
    catch (e) { showOverlay(h('div', { class: 'kbx-alert danger' }, `Could not load connections: ${e.message}`)); return; }
    if (!ok) return;
    await render();
  }
  function onShow() { if (fg && canvas.clientWidth) fg.width(canvas.clientWidth).height(canvas.clientHeight); }

  return { el, load, onShow };
}
