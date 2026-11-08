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
   Panels: Entries · Map · Graph · Ask · Similar · Playbooks · Process search · Schema · Quality · History · Connect.

   User-action recording (kanban 812c0da2): every control carries a stable
   data-action name (tab_<panel>, <panel>_<verb>[_<object>]) plus data-target-*
   ids and data-record-value keys, so a host that loads guru-recorder.js records
   one row per action; hosts without it ignore the attributes. */

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
import { canEdit, descriptionParts, showsOperatorChrome } from './viewer_model.js';
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
    // kanban 39aa973f: write controls show only to editors (viewer_model.js).
    canEdit: () => canEdit(info),
  };

  // ── header + stats ─────────────────────────────────────────────────────────
  const titleEl = h('h1', { class: 'kbx-h1' }, root.dataset.kbName || 'Knowledge Bank');
  // The description is the bank's MCP charter, written for agents: a reader gets
  // its first sentence, the full text sits behind a disclosure (kanban 39aa973f).
  const subEl = h('p', { class: 'kbx-sub', dataset: { role: 'bank-lead' } });
  const charterBody = h('div', { class: 'kbx-charter-body' });
  const charterEl = h('details', { class: 'kbx-charter', dataset: { role: 'bank-charter' } },
    h('summary', { dataset: { action: 'explorer_charter_toggle' } }, 'For agents: full bank description'), charterBody);
  function setDescription(text) {
    const parts = showsBankDescription(mode) ? descriptionParts(text) : { lead: '', full: '' };
    subEl.textContent = parts.lead;
    subEl.style.display = parts.lead ? '' : 'none';
    charterBody.textContent = parts.full;
    charterEl.style.display = parts.full ? '' : 'none';
  }
  setDescription(root.dataset.kbDescription || '');
  // Tiles and the id chip are operator chrome: hidden until /info says who is looking.
  const tilesEl = h('div', { class: 'kbx-tiles', style: { marginBottom: '20px', display: 'none' } });
  const idChip = h('span', { class: 'kbx-chip muted kbx-mono', title: 'Bank id (used by the SDK and MCP)', style: { display: 'none' } }, String(kbId).slice(0, 8));

  const header = h('div', { class: 'kbx-header' },
    h('div', { class: 'kbx-title' },
      h('span', { class: 'kbx-mascot', 'aria-hidden': 'true' }, h('i', {}), h('i', {})),
      h('div', { style: { minWidth: 0 } },
        dashUrl ? h('a', { class: 'kbx-back', href: dashUrl, dataset: { action: 'nav_knowledge_banks' } }, h('i', { class: 'bi bi-arrow-left' }), 'Knowledge Banks') : null,
        titleEl, subEl, charterEl)),
    h('div', { class: 'kbx-header-actions' },
      idChip,
      modeChip(mode) ? h('span', { class: 'kbx-chip muted' }, modeChip(mode)) : null,
      h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', dataset: { action: 'explorer_refresh' }, onClick: () => location.reload() }, h('i', { class: 'bi bi-arrow-clockwise' }), 'Refresh')));

  // ── tabs + panels ──────────────────────────────────────────────────────────
  const tabsEl = h('div', { class: 'kbx-tabs', role: 'tablist' });
  const panelHost = h('div', {});
  const views = {};
  const panelEls = {};

  panels.forEach((p) => {
    const tab = h('button', { class: 'kbx-tab', type: 'button', role: 'tab', dataset: { panel: p.id, action: `tab_${p.id.replace(/-/g, '_')}` }, onClick: () => activate(p.id) }, h('i', { class: `bi ${p.icon}` }), p.label);
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
      if (info.description !== undefined) setDescription(info.description || '');
      if (info.dimension_schema) schema = info.dimension_schema;
      else if (info.dimension_schema === undefined) schema = await api.getSchema().catch(() => null);
      if (info.name && ownsDocumentTitle(mode)) document.title = `${info.name} · KB Explorer`;
      const operator = showsOperatorChrome(info);
      tilesEl.style.display = operator ? '' : 'none';
      idChip.style.display = operator ? '' : 'none';
      if (operator) {
        renderTiles(info, null);
        api.stats().then((s) => renderTiles(info, s)).catch(() => {});
      }
    } catch (e) {
      tilesEl.style.display = '';
      idChip.style.display = '';
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
