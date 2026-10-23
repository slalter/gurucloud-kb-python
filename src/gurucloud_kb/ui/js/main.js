/* KB Explorer bootstrap — wires the SDK-mirror panels into one page.

   Host contract (all three hosts render the same element):
     <div id="kbx-root"
          data-kb-id="…"                 required
          data-kb-name="…" data-kb-description="…"   optional, refreshed from /info
          data-api-base="/api/kb-explorer/<id>"      optional, default shown
          data-mode="app|sdk|platform"               optional, default "app"
          data-dash-url="/knowledgebank/dashboard"   optional back link (app)
          data-token-gate="1"                        optional: ask for a bearer token
                                                     (platform mode) and send it on
                                                     every API call
     ></div>
   Panels: Entries · Map · Graph · Ask · Similar · Playbooks · Process search · Schema · Quality · History · Connect. */

import { h, mount, toast } from './dom.js';
import { createApi } from './api.js';
import { createEntriesView } from './entries.js';
import { createMapView } from './map.js';
import { createGraphView } from './graph.js';
import { createAskView } from './ask.js';
import { createSimilarView } from './similar.js';
import { createPlaybooksView } from './playbooks.js';
import { createProcessSearchView } from './process_search.js';
import { createSchemaView } from './schema.js';
import { createQualityView } from './quality.js';
import { createEventsView } from './events.js';
import { createConnectView } from './connect.js';
import { getToken, tokenGate } from './token.js';
import { tileValues } from './stats_view.js';
import { initialPanel, modeChip, normalizeMode, ownsDocumentTitle, showsBackLink, showsBankDescription, visiblePanelIds } from './mode_model.js';

const PANELS = [
  { id: 'entries', label: 'Entries', icon: 'bi-collection', make: createEntriesView },
  { id: 'map', label: 'Map', icon: 'bi-diagram-3', make: createMapView },
  { id: 'graph', label: 'Graph', icon: 'bi-share', make: createGraphView },
  { id: 'ask', label: 'Ask', icon: 'bi-chat-dots', make: createAskView },
  { id: 'similar', label: 'Similar', icon: 'bi-intersect', make: createSimilarView },
  { id: 'playbooks', label: 'Playbooks', icon: 'bi-journal-text', make: createPlaybooksView },
  { id: 'process-search', label: 'Process search', icon: 'bi-signpost-split', make: createProcessSearchView },
  { id: 'schema', label: 'Schema', icon: 'bi-diagram-2', make: createSchemaView },
  { id: 'quality', label: 'Quality', icon: 'bi-bullseye', make: createQualityView },
  { id: 'history', label: 'History', icon: 'bi-clock-history', make: createEventsView },
  { id: 'connect', label: 'Connect (SDK & MCP)', icon: 'bi-plug', make: createConnectView },
];

export function bootExplorer(root) {
  const kbId = root.dataset.kbId;
  const mode = normalizeMode(root.dataset.mode);
  const dashUrl = showsBackLink(mode) ? (root.dataset.dashUrl || '/knowledgebank/dashboard') : null;
  const visibleIds = visiblePanelIds(mode);
  const panels = visibleIds.map((id) => PANELS.find((p) => p.id === id)).filter(Boolean);
  const api = createApi(kbId, root.dataset.apiBase, { token: root.dataset.tokenGate ? getToken : null });

  let schema = null;
  let info = null;
  const ctx = {
    api,
    mode,
    getSchema: () => schema,
    setSchema: (s) => { schema = s; },
    getInfo: () => info,
    refreshInfo: () => refreshInfo(),
    activate: (id) => activate(id),
  };

  // ── header + stats ─────────────────────────────────────────────────────────
  const titleEl = h('h1', { class: 'kbx-h1' }, root.dataset.kbName || 'Knowledge Bank');
  const subEl = h('p', { class: 'kbx-sub' }, showsBankDescription(mode) ? (root.dataset.kbDescription || '') : '');
  if (!showsBankDescription(mode)) subEl.style.display = 'none';
  const tilesEl = h('div', { class: 'kbx-tiles', style: { marginBottom: '20px' } });

  const header = h('div', { class: 'kbx-header' },
    h('div', { class: 'kbx-title' },
      h('span', { class: 'kbx-mascot', 'aria-hidden': 'true' }, h('i', {}), h('i', {})),
      h('div', { style: { minWidth: 0 } },
        dashUrl ? h('a', { class: 'kbx-back', href: dashUrl }, h('i', { class: 'bi bi-arrow-left' }), 'Knowledge Banks') : null,
        titleEl, subEl)),
    h('div', { class: 'kbx-header-actions' },
      h('span', { class: 'kbx-chip muted kbx-mono', title: 'KB id' }, String(kbId).slice(0, 8)),
      modeChip(mode) ? h('span', { class: 'kbx-chip muted' }, modeChip(mode)) : null,
      h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', onClick: () => location.reload() }, h('i', { class: 'bi bi-arrow-clockwise' }), 'Refresh')));

  // ── tabs + panels ──────────────────────────────────────────────────────────
  const tabsEl = h('div', { class: 'kbx-tabs', role: 'tablist' });
  const panelHost = h('div', {});
  const views = {};
  const panelEls = {};

  panels.forEach((p) => {
    const tab = h('button', { class: 'kbx-tab', type: 'button', role: 'tab', dataset: { panel: p.id }, onClick: () => activate(p.id) }, h('i', { class: `bi ${p.icon}` }), p.label);
    tabsEl.append(tab);
    const panel = h('div', { class: 'kbx-panel', dataset: { panel: p.id } });
    panelHost.append(panel);
    panelEls[p.id] = panel;
  });

  function activate(id) {
    tabsEl.querySelectorAll('.kbx-tab').forEach((t) => t.classList.toggle('is-active', t.dataset.panel === id));
    Object.entries(panelEls).forEach(([pid, el]) => el.classList.toggle('is-active', pid === id));
    if (!views[id]) {
      const def = panels.find((p) => p.id === id);
      if (!def) return;
      const view = def.make(ctx);
      views[id] = view;
      mount(panelEls[id], view.el);
      view.load();
    } else if (views[id].onShow) {
      views[id].onShow();
    }
    history.replaceState(null, '', `#${id}`);
  }

  mount(root, header, tilesEl, tabsEl, panelHost);

  // ── data ───────────────────────────────────────────────────────────────────
  async function refreshInfo() {
    try {
      info = await api.info();
      if (info.name) titleEl.textContent = info.name;
      if (info.description !== undefined && showsBankDescription(mode)) subEl.textContent = info.description || '';
      if (info.dimension_schema) schema = info.dimension_schema;
      else if (info.dimension_schema === undefined) schema = await api.getSchema().catch(() => null);
      if (info.name && ownsDocumentTitle(mode)) document.title = `${info.name} · KB Explorer`;
      renderTiles(info, null);
      api.stats().then((s) => renderTiles(info, s)).catch(() => {});
    } catch (e) {
      renderTiles({}, null);
      toast(`Could not load KB info: ${e.message}`, 'error');
    }
  }

  function renderTiles(i, stats) {
    // Lifetime "Total queries" from /info; latency tiles are the KB service's
    // last-hour window (see stats_view.js).
    mount(tilesEl, ...tileValues(i, stats, schema).map((t) =>
      tile(t.label, t.unit ? h('span', {}, t.text, h('small', {}, ` ${t.unit}`)) : t.text, t.icon)));
  }
  function tile(label, value, icon) {
    return h('div', { class: 'kbx-tile accent' },
      h('div', { class: 'kbx-tile-label' }, h('i', { class: `bi ${icon}` }), label),
      h('div', { class: 'kbx-tile-value' }, value));
  }

  // ── go ─────────────────────────────────────────────────────────────────────
  renderTiles({}, null);
  const initial = (location.hash || '').replace('#', '').split('?')[0];
  // Open the first tab only once the bank's schema is known: views build their
  // inputs from ctx.getSchema() on first load, and a custom-schema bank would
  // otherwise render the default dimensions (refreshInfo never rejects).
  refreshInfo().then(() => activate(initialPanel(mode, initial)));
  return ctx;
}

function boot() {
  const root = document.getElementById('kbx-root');
  if (!root) return;
  if (!root.dataset.kbId) {
    // Bank picker hosts (SDK / platform) render their own list; nothing to do.
    return;
  }
  if (root.dataset.tokenGate && !getToken()) {
    tokenGate(root, () => bootExplorer(root));
    return;
  }
  bootExplorer(root);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
