/* Map view — the Knowledge Bank drawn as a graph.

   Runs the KB service's clustering engine (SDK kb.cluster) over one field and
   renders the result with Cytoscape: every cluster is a compound node, every
   entry a dot inside it placed by its distance to the centroid, outliers
   grouped into their own dashed clusters so nothing is hidden. Optional LLM
   labels name the clusters. Playbooks overlay as step chains with dotted links
   to the entries their steps cite.

   Interaction: click an entry → detail modal; click a cluster → members and
   keywords in the side panel; click a playbook or step → playbook detail;
   type a query → matching entries light up, the rest dim. Settings persist per
   bank in localStorage (a per-viewer convenience only). */

import { h, mount, clear, toast, skeleton, num } from './dom.js';
import { buildMapModel, defaultClusterRequest } from './map_layout.js';
import { openEntryDetail } from './entry_detail.js';
import { openPlaybookDetail } from './playbook_detail.js';
import { dimsOf, primaryDim, textOnlyDims, truncate } from './schema_utils.js';

const COLORS = {
  entry: '#72a6ab', entryBorder: '#456f73', hit: '#f2b23a', hitBorder: '#a06a00',
  cluster: 'rgba(114,166,171,0.14)', clusterBorder: '#72a6ab', noise: 'rgba(183,179,168,0.16)', noiseBorder: '#b7b3a8',
  playbook: '#4d3a80', step: '#8f7bc4', link: '#8f7bc4', text: '#3d3d3d',
};

export function createMapView(ctx) {
  const { api } = ctx;
  const el = h('div', {});
  let loaded = false;
  let cy = null;
  let model = null;
  let playbooks = null; // fetched full playbooks, or null
  let lastResponse = null;

  // ── controls ───────────────────────────────────────────────────────────────
  const fieldSel = h('select', { class: 'kbx-select' });
  const algoSel = h('select', { class: 'kbx-select' },
    h('option', { value: 'auto' }, 'Auto (HDBSCAN)'),
    h('option', { value: 'hdbscan' }, 'HDBSCAN'),
    h('option', { value: 'kmeans' }, 'K-means (fixed k)'),
    h('option', { value: 'agglomerative' }, 'Agglomerative (fixed k)'));
  const kInput = h('input', { class: 'kbx-input', type: 'number', min: '2', value: '8', disabled: true });
  const minSizeInput = h('input', { class: 'kbx-input', type: 'number', min: '2', value: '5' });
  const targetInput = h('input', { class: 'kbx-input', type: 'number', min: '2', placeholder: '35', title: 'Entries per cluster the automatic cluster count aims for. Smaller = more, tighter clusters with names that fit better.' });
  const outlierSel = h('select', { class: 'kbx-select' },
    h('option', { value: 'subcluster' }, 'Group outliers separately'),
    h('option', { value: 'reassign' }, 'Absorb outliers into nearest'),
    h('option', { value: 'keep' }, 'Leave outliers off the map'));
  const labelCb = h('input', { type: 'checkbox' });
  const scopeInput = h('input', { class: 'kbx-input', type: 'text', placeholder: 'Optional: only entries matching…' });
  const playbooksCb = h('input', { type: 'checkbox', checked: true });
  const peelCb = h('input', { type: 'checkbox', checked: true });
  const runBtn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button', onClick: run }, h('i', { class: 'bi bi-diagram-3' }), 'Build map');

  algoSel.addEventListener('change', () => { kInput.disabled = !(algoSel.value === 'kmeans' || algoSel.value === 'agglomerative'); });
  scopeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

  const toolbar = h('div', { class: 'kbx-card' },
    h('div', { class: 'kbx-card-head' },
      h('div', {}, h('h3', { class: 'kbx-card-title' }, 'Map'), h('div', { class: 'kbx-card-sub' }, 'Cluster the bank’s embeddings and see every entry placed by similarity. Playbooks overlay as step chains linked to the entries they cite.')),
      runBtn),
    h('div', { class: 'kbx-map-toolbar' },
      field('Cluster by', fieldSel),
      field('Algorithm', algoSel),
      field('k', kInput),
      field('Entries per cluster', targetInput),
      field('Min cluster size', minSizeInput),
      field('Outliers', outlierSel),
      field('Scope (semantic)', scopeInput),
      h('div', { class: 'kbx-field' }, h('label', {}, ' '), h('label', { class: 'kbx-check' }, labelCb, 'Name clusters (LLM)')),
      h('div', { class: 'kbx-field' }, h('label', {}, ' '), h('label', { class: 'kbx-check' }, playbooksCb, 'Show playbooks'))));

  function field(label, input) { return h('div', { class: 'kbx-field' }, h('label', {}, label), input); }

  // ── stage ──────────────────────────────────────────────────────────────────
  const canvas = h('div', { class: 'kbx-map-canvas', id: 'kbx-map-canvas' });
  const overlay = h('div', { class: 'kbx-map-overlay' }, h('div', { class: 'kbx-empty' }, h('i', { class: 'bi bi-diagram-3' }), h('h4', {}, 'No map yet'), h('div', {}, 'Choose a field and press Build map.')));
  const tip = h('div', { class: 'kbx-map-tip' });
  const hlInput = h('input', { class: 'kbx-input', type: 'search', placeholder: 'Highlight entries matching…', style: { width: '220px', background: 'rgba(255,255,255,.95)' } });
  hlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') highlight(); if (e.key === 'Escape') clearHighlight(); });
  const hud = h('div', { class: 'kbx-map-hud' },
    hlInput,
    h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', title: 'Highlight', onClick: highlight }, h('i', { class: 'bi bi-lightbulb' })),
    h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', title: 'Clear highlight', onClick: clearHighlight }, h('i', { class: 'bi bi-x-lg' })),
    h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', title: 'Fit', onClick: () => cy && cy.animate({ fit: { padding: 30 } }, { duration: 250 }) }, h('i', { class: 'bi bi-arrows-fullscreen' })),
    h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', title: 'Zoom in', onClick: () => cy && cy.zoom({ level: cy.zoom() * 1.3, renderedPosition: { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 } }) }, h('i', { class: 'bi bi-zoom-in' })),
    h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', title: 'Zoom out', onClick: () => cy && cy.zoom({ level: cy.zoom() / 1.3, renderedPosition: { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 } }) }, h('i', { class: 'bi bi-zoom-out' })));
  const legend = h('div', { class: 'kbx-map-legend' },
    h('span', {}, h('i', { class: 'entry' }), 'entry (bigger = nearer centroid)'),
    h('span', {}, h('i', { class: 'cluster' }), 'cluster'),
    h('span', {}, h('i', { class: 'noise' }), 'outlier group'),
    h('span', {}, h('i', { class: 'playbook' }), 'playbook'),
    h('span', {}, h('i', { class: 'step' }), 'step → cited entry'),
    h('span', {}, h('i', { class: 'hit' }), 'highlighted'));
  const canvasWrap = h('div', { class: 'kbx-map-canvas-wrap' }, canvas, hud, legend, tip, overlay);

  const statsHost = h('div', { class: 'kbx-map-stats' });
  const sideHost = h('div', {});
  const side = h('div', { class: 'kbx-map-side' },
    h('div', { class: 'kbx-side-card' }, h('div', { class: 'kbx-side-title' }, 'Summary'), statsHost),
    h('div', { class: 'kbx-side-card' }, sideHost));
  const stage = h('div', { class: 'kbx-map-stage' }, canvasWrap, side);

  mount(el, toolbar, stage);

  // ── settings persistence ──────────────────────────────────────────────────
  const storeKey = `kbx-map:${api.kbId}`;
  function saveSettings() {
    try { localStorage.setItem(storeKey, JSON.stringify({ field: fieldSel.value, algo: algoSel.value, k: kInput.value, minSize: minSizeInput.value, target: targetInput.value, outliers: outlierSel.value, label: labelCb.checked, playbooks: playbooksCb.checked, peel: peelCb.checked })); } catch { /* ignore */ }
  }
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(storeKey) || 'null');
      if (!s) return;
      if (s.field && Array.from(fieldSel.options).some((o) => o.value === s.field)) fieldSel.value = s.field;
      if (s.algo) { algoSel.value = s.algo; algoSel.dispatchEvent(new Event('change')); }
      if (s.k) kInput.value = s.k;
      if (s.minSize) minSizeInput.value = s.minSize;
      if (s.target) targetInput.value = s.target;
      if (s.outliers) outlierSel.value = s.outliers;
      labelCb.checked = !!s.label;
      playbooksCb.checked = s.playbooks !== false;
      peelCb.checked = s.peel !== false;
    } catch { /* ignore */ }
  }

  /** The dimension a free-text scope/highlight query runs against for the chosen cluster field. */
  function semanticFieldFor(fieldName) {
    const opt = fieldSel.selectedOptions[0];
    return opt && opt.textContent.includes('(semantic)') ? fieldName : primaryDim(ctx.getSchema());
  }

  function buildFieldOptions() {
    const schema = ctx.getSchema();
    clear(fieldSel);
    const dims = dimsOf(schema);
    const embedded = dims.filter((d) => d.dimension_type !== 'text_only' && d.searchable !== false);
    if (embedded.length > 1) fieldSel.append(h('option', { value: '*' }, 'All dimensions (as search sees them)'));
    dims.filter((d) => d.dimension_type === 'single' || (!d.dimension_type && (d.name === 'content' || d.name === 'useful_for'))).forEach((d) => fieldSel.append(h('option', { value: d.name }, `${d.display_name || d.name} (semantic)`)));
    dims.filter((d) => d.dimension_type === 'multi').forEach((d) => fieldSel.append(h('option', { value: d.name }, `${d.display_name || d.name} (by value)`)));
    textOnlyDims(schema).forEach((d) => fieldSel.append(h('option', { value: d.name }, `${d.display_name || d.name} (exact groups)`)));
    fieldSel.append(h('option', { value: 'source' }, 'source (exact groups)'));
    fieldSel.value = embedded.length > 1 ? '*' : primaryDim(schema);
  }

  // ── run ────────────────────────────────────────────────────────────────────
  async function run() {
    if (!window.cytoscape) { toast('Graph library failed to load (vendor/cytoscape.min.js).', 'error'); return; }
    saveSettings();
    runBtn.classList.add('is-loading');
    mount(overlay, skeleton(labelCb.checked ? 'Clustering and naming clusters…' : 'Clustering…'));
    overlay.style.display = '';
    try {
      const fieldName = fieldSel.value;
      const req = defaultClusterRequest(fieldName, {
        algorithm: algoSel.value,
        min_cluster_size: Math.max(2, parseInt(minSizeInput.value, 10) || 5),
        outlier_strategy: outlierSel.value,
        label: labelCb.checked,
        peel_misfits: peelCb.checked,
      });
      if (!kInput.disabled) req.k = Math.max(2, parseInt(kInput.value, 10) || 8);
      const target = parseInt(targetInput.value, 10);
      if (target >= 2) req.target_cluster_size = target;
      const scope = scopeInput.value.trim();
      if (scope) {
        const semField = semanticFieldFor(fieldName);
        req.search = { dimensions: { [semField]: { query_text: scope } }, k: req.scope_limit, threshold: 0 };
      }
      const [resp, pbs] = await Promise.all([api.cluster(req), playbooksCb.checked ? fetchPlaybooks() : Promise.resolve(null)]);
      lastResponse = resp; playbooks = pbs;
      model = buildMapModel(resp, { field: fieldName, playbooks: pbs || [] });
      draw();
      renderStats();
      renderClusterList();
      overlay.style.display = 'none';
    } catch (e) {
      mount(overlay, h('div', { class: 'kbx-alert danger', style: { maxWidth: '520px' } }, `Clustering failed: ${e.message}`));
    } finally {
      runBtn.classList.remove('is-loading');
    }
  }

  async function fetchPlaybooks() {
    try {
      const list = await api.listPlaybooks({ status: 'active', limit: 50 });
      const rows = (list && list.playbooks) || [];
      const full = await Promise.all(rows.map((p) => api.getPlaybook(p.slug, { include_linked_entries: false }).catch(() => null)));
      return full.filter(Boolean);
    } catch { return []; }
  }

  // ── draw ───────────────────────────────────────────────────────────────────
  function draw() {
    const elements = toElements(model);
    if (cy) { cy.destroy(); cy = null; }
    cy = window.cytoscape({
      container: canvas,
      elements,
      layout: { name: 'preset', fit: true, padding: 30 },
      minZoom: 0.05, maxZoom: 6, wheelSensitivity: 0.25,
      boxSelectionEnabled: false, autounselectify: true,
      style: [
        { selector: 'node.cluster', style: {
          shape: 'round-rectangle', 'background-color': COLORS.cluster, 'background-opacity': 1, 'border-width': 1.5, 'border-color': COLORS.clusterBorder,
          'corner-radius': 40, padding: '18px', label: 'data(label)', 'text-valign': 'top', 'text-halign': 'center', 'text-margin-y': -6,
          'font-size': 13, 'font-weight': 600, color: COLORS.text, 'text-wrap': 'wrap', 'text-max-width': 220, 'font-family': 'Aspekta, -apple-system, Segoe UI, Roboto, sans-serif',
        } },
        { selector: 'node.cluster.noise', style: { 'background-color': COLORS.noise, 'border-color': COLORS.noiseBorder, 'border-style': 'dashed', color: '#6b6b6b' } },
        { selector: 'node.cluster.low', style: { 'border-style': 'dotted' } },
        { selector: 'node.entry', style: {
          shape: 'ellipse', width: 'data(d)', height: 'data(d)', 'background-color': COLORS.entry, 'border-width': 1, 'border-color': COLORS.entryBorder, label: '',
        } },
        { selector: 'node.entry.hit', style: { 'background-color': COLORS.hit, 'border-color': COLORS.hitBorder, 'z-index': 10, width: 'data(dh)', height: 'data(dh)' } },
        { selector: 'node.entry.dim', style: { opacity: 0.18 } },
        { selector: 'node.playbook', style: {
          shape: 'diamond', width: 30, height: 30, 'background-color': COLORS.playbook, label: 'data(label)', 'text-valign': 'bottom', 'text-margin-y': 6,
          'font-size': 12, 'font-weight': 600, color: COLORS.text, 'text-wrap': 'wrap', 'text-max-width': 150,
        } },
        { selector: 'node.step', style: {
          shape: 'round-rectangle', width: 26, height: 20, 'background-color': COLORS.step, label: 'data(label)', 'text-valign': 'bottom', 'text-margin-y': 5,
          'font-size': 10, color: '#525252', 'text-wrap': 'wrap', 'text-max-width': 100,
        } },
        { selector: 'node.step.unlinked', style: { 'background-opacity': 0.55 } },
        { selector: 'edge.precedes', style: { width: 2, 'line-color': COLORS.step, 'target-arrow-color': COLORS.step, 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', 'arrow-scale': 0.8 } },
        { selector: 'edge.cites', style: { width: 1.2, 'line-color': COLORS.link, 'line-style': 'dotted', 'curve-style': 'unbundled-bezier', 'target-arrow-shape': 'circle', 'target-arrow-color': COLORS.link, 'arrow-scale': 0.6, opacity: 0.8 } },
      ],
    });

    cy.on('tap', 'node.entry', (evt) => { openEntryDetail(ctx, evt.target.data('entryId')); });
    cy.on('tap', 'node.cluster', (evt) => { selectCluster(evt.target.data('key')); });
    cy.on('tap', 'node.playbook, node.step', (evt) => { openPlaybookDetail(ctx, evt.target.data('slug')); });
    cy.on('mouseover', 'node', (evt) => showTip(evt));
    cy.on('mouseout', 'node', () => { tip.style.display = 'none'; });
    cy.on('tap', (evt) => { if (evt.target === cy) { renderClusterList(); } });
  }

  function showTip(evt) {
    const n = evt.target; const d = n.data();
    let html = '';
    if (n.hasClass('entry')) html = `<div>${escapeHtml(truncate(d.content || '', 220))}</div><div style="margin-top:5px"><span class="kbx-tip-k">cluster</span>${escapeHtml(d.clusterTitle || '')}${d.distance != null ? ` · <span class="kbx-tip-k">dist</span>${Number(d.distance).toFixed(3)}` : ''}</div>`;
    else if (n.hasClass('cluster')) html = `<div style="font-weight:600">${escapeHtml(d.label)}</div>${d.description ? `<div style="margin-top:3px">${escapeHtml(d.description)}</div>` : ''}<div style="margin-top:4px"><span class="kbx-tip-k">${d.size} entries</span>${d.keywords ? escapeHtml(d.keywords) : ''}</div>`;
    else if (n.hasClass('playbook')) html = `<div style="font-weight:600">Playbook · ${escapeHtml(d.label)}</div><div>${d.steps} steps · ${escapeHtml(d.status)}</div>`;
    else if (n.hasClass('step')) html = `<div style="font-weight:600">Step ${d.position} · ${escapeHtml(d.fullTitle)}</div><div>${d.linked ? 'cites an entry on this map' : (d.kbEntryId ? 'cites an entry not on this map' : 'no cited entry')}</div>`;
    tip.innerHTML = html;
    const p = evt.renderedPosition || (evt.target.renderedPosition && evt.target.renderedPosition());
    tip.style.left = `${Math.min(p.x, canvas.clientWidth - 320)}px`; tip.style.top = `${p.y}px`; tip.style.display = 'block';
  }

  // ── side panel ─────────────────────────────────────────────────────────────
  function renderStats() {
    const s = model.stats;
    mount(statsHost,
      h('div', {}, h('b', {}, num(s.clusterCount)), ' clusters'),
      h('div', {}, h('b', {}, num(s.clustered)), ' entries placed'),
      h('div', { title: 'Entries that fit no group and are not drawn' }, h('b', {}, num(s.noise)), s.noise === 1 ? ' entry fits no group' : ' entries fit no group'),
      s.silhouette != null ? h('div', { title: 'Silhouette: -1 (overlapping) to 1 (well separated)' }, h('b', {}, Number(s.silhouette).toFixed(2)), ' silhouette') : null,
      s.scope ? h('div', {}, h('b', {}, num(s.scope.entry_count)), s.scope.source === 'search' ? ' in scope' : ' in bank', s.scope.truncated ? ' (capped)' : '') : null,
      model.playbooks.length ? h('div', {}, h('b', {}, num(model.playbooks.length)), ' playbooks, ', h('b', {}, num(model.links.length)), ' step→entry links') : null,
      s.note ? h('div', { class: 'kbx-alert info', style: { padding: '6px 9px', width: '100%' } }, s.note) : null);
  }

  function renderClusterList() {
    const rows = model.clusters.slice().sort((a, b) => b.memberCount - a.memberCount);
    mount(sideHost,
      h('div', { class: 'kbx-side-title' }, `Clusters (${rows.length})`),
      rows.length ? h('div', {}, ...rows.map((c) => h('div', { class: 'kbx-member-row', onClick: () => selectCluster(c.key) },
        h('span', { class: 'kbx-dot', style: c.fromNoise ? { background: COLORS.noiseBorder } : {} }),
        h('div', { style: { minWidth: 0 } }, h('div', { style: { fontWeight: 600, color: 'var(--kbx-heading)' } }, c.title), c.description ? h('div', { style: { fontSize: '12px', lineHeight: '1.4', margin: '2px 0' } }, c.description) : null, h('div', { class: 'kbx-muted', style: { fontSize: '12px' } }, `${c.memberCount} entries${c.fromNoise ? ' · outliers' : ''}${c.lowCohesion ? ' · low cohesion' : ''}`)))))
        : h('div', { class: 'kbx-muted' }, 'No clusters. Lower the minimum cluster size or pick another field.'));
  }

  function selectCluster(key) {
    const c = model.clusters.find((x) => x.key === key);
    if (!c) return;
    if (cy) { const n = cy.getElementById(key); if (n.length) cy.animate({ fit: { eles: n, padding: 40 } }, { duration: 300 }); }
    const members = model.entries.filter((e) => e.clusterKey === key);
    mount(sideHost,
      h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', onClick: renderClusterList, style: { marginBottom: '8px' } }, h('i', { class: 'bi bi-arrow-left' }), 'All clusters'),
      h('div', { class: 'kbx-side-title' }, c.title),
      c.description ? h('p', { style: { margin: '0 0 10px', fontSize: '13px', lineHeight: '1.5', color: 'var(--kbx-body)' } }, c.description) : null,
      h('div', { class: 'kbx-row', style: { gap: '6px', marginBottom: '8px' } },
        h('span', { class: 'kbx-chip' }, `${c.memberCount} entries`),
        c.fromNoise ? h('span', { class: 'kbx-chip muted' }, 'outlier group') : null,
        c.lowCohesion ? h('span', { class: 'kbx-chip warn' }, 'low cohesion') : null,
        c.meanDistance != null ? h('span', { class: 'kbx-chip muted' }, `mean dist ${Number(c.meanDistance).toFixed(3)}`) : null),
      c.keywords && c.keywords.length ? h('div', { class: 'kbx-tags', style: { marginBottom: '10px' } }, ...c.keywords.slice(0, 12).map((k) => h('span', { class: 'kbx-tag' }, k))) : null,
      c.values && c.values.length ? h('div', { class: 'kbx-tags', style: { marginBottom: '10px' } }, ...c.values.slice(0, 12).map((k) => h('span', { class: 'kbx-tag' }, k))) : null,
      h('div', {}, ...members.map((m) => h('div', { class: 'kbx-member-row', onClick: () => openEntryDetail(ctx, m.id) },
        h('span', { class: 'kbx-dot', style: { width: `${m.r}px`, height: `${m.r}px` } }),
        h('div', {}, truncate(m.content || m.id, 140))))));
  }

  // ── highlight ──────────────────────────────────────────────────────────────
  async function highlight() {
    const q = hlInput.value.trim();
    if (!q || !cy) return;
    const semField = semanticFieldFor(fieldSel.value);
    try {
      const data = await api.search({ dimensions: { [semField]: { query_text: q } }, k: 50, threshold: 0 });
      const rows = Array.isArray(data) ? data : (data.results || []);
      const ids = new Set(rows.map((r) => String(r.id)));
      let hits = 0;
      cy.batch(() => {
        cy.nodes('.entry').forEach((n) => { const hit = ids.has(String(n.data('entryId'))); n.toggleClass('hit', hit); n.toggleClass('dim', !hit); if (hit) hits++; });
      });
      toast(hits ? `${hits} entr${hits === 1 ? 'y' : 'ies'} highlighted` : 'No matching entries on this map', hits ? 'success' : 'warning');
    } catch (e) { toast(`Highlight failed: ${e.message}`, 'error'); }
  }
  function clearHighlight() { hlInput.value = ''; if (cy) cy.batch(() => cy.nodes('.entry').removeClass('hit dim')); }

  return {
    el,
    load() {
      if (!loaded) { loaded = true; buildFieldOptions(); loadSettings(); }
    },
    onShow() { if (cy) cy.resize(); },
    run,
  };
}

/** Cytoscape element JSON from a positioned model. Exported for tests. */
export function toElements(model) {
  const els = [];
  const titleByKey = new Map(model.clusters.map((c) => [c.key, c.title]));
  model.clusters.forEach((c) => els.push({ data: { id: c.key, key: c.key, label: c.title, description: c.description || '', size: c.memberCount, keywords: (c.keywords || []).slice(0, 6).join(', ') }, classes: `cluster${c.fromNoise ? ' noise' : ''}${c.lowCohesion ? ' low' : ''}` }));
  model.entries.forEach((e) => els.push({ data: { id: `e:${e.id}`, entryId: e.id, parent: e.clusterKey, d: e.r * 2, dh: e.r * 2 + 6, content: e.content, distance: e.distance, clusterTitle: titleByKey.get(e.clusterKey) || '' }, position: { x: e.x, y: e.y }, classes: 'entry' }));
  model.playbooks.forEach((p) => {
    els.push({ data: { id: `p:${p.slug}`, slug: p.slug, label: p.title, steps: p.steps.length, status: p.status }, position: { x: p.x, y: p.y }, classes: 'playbook' });
    let prev = `p:${p.slug}`;
    p.steps.forEach((s) => {
      const id = `s:${s.id}`;
      els.push({ data: { id, slug: p.slug, position: s.position, label: truncate(s.title, 28), fullTitle: s.title, linked: s.linked, kbEntryId: s.kbEntryId }, position: { x: s.x, y: s.y }, classes: `step${s.linked ? '' : ' unlinked'}` });
      els.push({ data: { id: `pe:${prev}->${id}`, source: prev, target: id }, classes: 'precedes' });
      prev = id;
    });
  });
  model.links.forEach((l) => els.push({ data: { id: `l:${l.stepId}->${l.entryId}`, source: `s:${l.stepId}`, target: `e:${l.entryId}` }, classes: 'cites' }));
  return els;
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
