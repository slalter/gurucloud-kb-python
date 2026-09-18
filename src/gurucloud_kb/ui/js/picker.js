/* Bank picker — the Knowledge Banks table every host shows when no bank is
   selected. Sortable columns, a name filter, empty banks hidden behind a
   toggle, a totals row. Base rows come from data-banks-url; when the host also
   offers data-stats-url (the hosted app), the live stats columns fill in from
   it and its entry/query counts replace the list's cached ones. Without it
   (SDK server, platform /ui) the table still stands on the base columns.

   Hosted-app extras, each switched on by a data attribute on #kbx-root:
     data-create-url    "Create bank" header button
     data-api-keys-url  "API keys" header button
     data-tier-url      plan badge (GET → {tier, usage, limits, has_billing,
                        is_past_due}); data-billing-url for the payment link
   Row actions (Connect / Clear / Delete) call `<api-base>/<kb>/clear` and
   `DELETE <api-base>/<kb>`; Clear and Delete show only for banks the viewer
   owns or administers (never for a granted bank). */

import { h, mount, skeleton, empty, num, timeAgo, fmtDate, debounce, toast } from './dom.js';
import { openModal } from './modal.js';
import { COLUMNS, DEFAULT_SORT, buildRows, filterRows, sortRows, nextSort, totals, isEmptyBank, fmtRate } from './picker_model.js';

const PREFS_KEY = 'kbx-picker';

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private mode etc. */ }
}

function apiBaseFor(root, kbId) {
  const base = root.dataset.apiBase || '/api/kb-explorer/{kb}';
  return (base.includes('{kb}') ? base.replace('{kb}', encodeURIComponent(kbId)) : `${base}/${encodeURIComponent(kbId)}`).replace(/\/+$/, '');
}

/** Plan badge for the header (hosted app, non-admins). Best-effort. */
async function planBadge(tierUrl, billingUrl, headers) {
  try {
    const r = await fetch(tierUrl, { headers });
    if (!r.ok) return null;
    const t = await r.json();
    const tier = String(t.tier || 'free');
    const label = tier.charAt(0).toUpperCase() + tier.slice(1);
    const kbs = t.usage && t.limits && t.limits.max_kbs != null ? ` · ${num(t.usage.kb_count ?? t.usage.kbs ?? 0)} / ${num(t.limits.max_kbs)} banks` : '';
    const nodes = [h('span', { class: `kbx-chip ${tier === 'free' ? 'muted' : 'info'}` }, h('i', { class: 'bi bi-star' }), `${label} plan${kbs}`)];
    if (t.is_past_due) nodes.push(h('a', { class: 'kbx-chip danger', href: billingUrl || '#', title: 'Payment is past due' }, 'Past due'));
    else if ((tier === 'pro' || tier === 'enterprise') && t.has_billing === false && billingUrl) nodes.push(h('a', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', href: `${billingUrl}${billingUrl.includes('?') ? '&' : '?'}plan=${encodeURIComponent(tier)}` }, h('i', { class: 'bi bi-credit-card' }), 'Add payment method'));
    return h('span', { class: 'kbx-plan' }, ...nodes);
  } catch { return null; }
}

/**
 * @param {HTMLElement} root  the #kbx-root mount
 * @param {object} feeds  { banks, stats, statsState: 'ok'|'none'|'error', statsMessage?, generatedAt?, loadMs? }
 * @param {object} [opts]  { hrefFor, createUrl, apiKeysUrl, tierUrl, billingUrl, headers, reload }
 */
export function renderPicker(root, feeds, opts = {}) {
  const hrefFor = opts.hrefFor || ((id) => `?kb=${encodeURIComponent(id)}`);
  const connectHref = (id) => `${hrefFor(id)}#connect`;
  const headers = { Accept: 'application/json', ...(opts.headers || {}) };
  const prefs = loadPrefs();
  let sort = prefs.sort && COLUMNS.some((c) => c.key === prefs.sort.key) ? prefs.sort : { ...DEFAULT_SORT };
  let showEmpty = !!prefs.showEmpty;
  let query = '';

  const rows = buildRows(feeds.banks, feeds.stats);
  const emptyCount = rows.filter(isEmptyBank).length;
  const hasStats = feeds.statsState === 'ok';
  const hasActions = !!opts.createUrl; // hosted app: row actions ride with the header actions

  // ── header (title, plan badge, actions) ────────────────────────────────────
  const subEl = h('p', { class: 'kbx-sub' }, '');
  const planHost = h('span', {});
  const actions = h('div', { class: 'kbx-header-actions' },
    planHost,
    opts.apiKeysUrl ? h('a', { class: 'kbx-btn kbx-btn-ghost', href: opts.apiKeysUrl }, h('i', { class: 'bi bi-key' }), 'API keys') : null,
    opts.createUrl ? h('a', { class: 'kbx-btn kbx-btn-primary', href: opts.createUrl }, h('i', { class: 'bi bi-plus-lg' }), 'Create bank') : null);
  const header = h('div', { class: 'kbx-header' },
    h('div', { class: 'kbx-title' },
      h('span', { class: 'kbx-mascot', 'aria-hidden': 'true' }, h('i', {}), h('i', {})),
      h('div', {}, h('h1', { class: 'kbx-h1' }, 'Knowledge Banks'), subEl)),
    actions);
  if (opts.tierUrl) planBadge(opts.tierUrl, opts.billingUrl, headers).then((n) => { if (n) mount(planHost, n); });

  if (!rows.length) {
    mount(root, header, empty('bi-database', 'No knowledge banks yet',
      opts.createUrl ? h('a', { class: 'kbx-btn kbx-btn-primary', href: opts.createUrl, style: { marginTop: '12px' } }, h('i', { class: 'bi bi-plus-lg' }), 'Create your first bank') : 'Create one with the SDK (client.create_kb) and reload.'));
    subEl.textContent = '0 banks visible to this credential';
    return;
  }

  // ── toolbar ────────────────────────────────────────────────────────────────
  const searchInput = h('input', { class: 'kbx-input', type: 'search', placeholder: 'Filter by name, description or id…', 'aria-label': 'Filter knowledge banks' });
  const emptyToggle = h('input', { type: 'checkbox', id: 'kbx-show-empty' });
  emptyToggle.checked = showEmpty;
  const emptyLabel = h('label', { class: 'kbx-check', for: 'kbx-show-empty' }, emptyToggle, h('span', {}, ''));
  const countLabel = h('div', { class: 'kbx-muted kbx-picker-count' }, '');
  const statsChip = hasStats
    ? h('span', { class: 'kbx-chip success', title: feeds.generatedAt ? `Live stats as of ${fmtDate(feeds.generatedAt)}` : 'Live stats from the KB service' }, h('i', { class: 'bi bi-activity' }), 'Live stats')
    : feeds.statsState === 'error'
      ? h('span', { class: 'kbx-chip warn', title: feeds.statsMessage || 'Live stats unavailable' }, h('i', { class: 'bi bi-exclamation-triangle' }), 'Live stats unavailable')
      : null;
  const toolbar = h('div', { class: 'kbx-picker-toolbar' },
    h('div', { class: 'kbx-searchbar', style: { flex: '1 1 320px' } }, searchInput),
    h('div', { class: 'kbx-row' }, emptyLabel, statsChip, countLabel));

  // ── table ──────────────────────────────────────────────────────────────────
  const visibleCols = COLUMNS.filter((c) => hasStats || !c.stats);
  const thead = h('thead', {}, h('tr', {}, ...visibleCols.map((c) => {
    const th = h('th', { class: `${c.align === 'right' ? 'kbx-num' : ''} sortable ${c.optional ? 'kbx-col-opt' : ''}`.trim(), scope: 'col', title: c.title || `Sort by ${c.label}`, dataset: { key: c.key }, tabindex: '0', role: 'button' },
      h('span', { class: 'kbx-th-label' }, c.label), h('i', { class: 'bi kbx-sort-icon', 'aria-hidden': 'true' }));
    const go = () => { sort = nextSort(sort, c.key); savePrefs({ ...loadPrefs(), sort }); draw(); };
    th.addEventListener('click', go);
    th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    return th;
  }), hasActions ? h('th', { class: 'kbx-col-actions', scope: 'col' }, h('span', { class: 'kbx-sr' }, 'Actions')) : null));
  const tbody = h('tbody', {});
  const tfoot = h('tfoot', {});
  const table = h('table', { class: 'kbx-table kbx-picker-table rows-click' }, thead, tbody, tfoot);
  const wrap = h('div', { class: 'kbx-table-wrap' }, table);
  const noMatch = h('div', { class: 'kbx-picker-nomatch kbx-hidden' });

  function accessChip(r) {
    // Only a grant is worth a chip: an admin sees every bank, so labelling
    // each one "admin" would be noise (the row still carries data-access).
    if (r.access === 'granted') return h('span', { class: 'kbx-chip info access', title: 'Shared with you: you can search and add entries; the owner manages the bank' }, 'granted');
    return null;
  }

  function cell(c, r) {
    switch (c.key) {
      case 'name':
        return h('td', { class: 'kbx-cell-name' },
          h('a', { class: 'kbx-strong kbx-bank-link', href: hrefFor(r.kb_id) }, r.name), accessChip(r),
          r.description ? h('div', { class: 'kbx-muted kbx-cell-desc' }, r.description.length > 140 ? `${r.description.slice(0, 140)}…` : r.description) : null,
          h('div', { class: 'kbx-mono kbx-cell-id' }, r.kb_id.slice(0, 8), r.statsError ? h('span', { class: 'kbx-chip danger', style: { marginLeft: '8px' }, title: 'The KB service could not read this bank’s schema' }, 'unreadable') : null));
      case 'playbooks':
        return h('td', { class: 'kbx-num' }, num(r.playbooks), r.playbooksDraft ? h('small', { class: 'kbx-muted', title: 'draft playbooks' }, ` +${r.playbooksDraft}`) : null);
      case 'zeroRate':
        return h('td', { class: 'kbx-num kbx-col-opt' }, fmtRate(r.zeroRate));
      case 'lastQueryAt':
      case 'lastEntryAt': {
        const v = r[c.key];
        return h('td', { class: c.optional ? 'kbx-col-opt' : '', title: v ? fmtDate(v) : '' }, v ? timeAgo(v) : (r.statsKnown ? 'Never' : '—'));
      }
      default:
        return h('td', { class: `${c.align === 'right' ? 'kbx-num' : ''} ${c.optional ? 'kbx-col-opt' : ''}`.trim() }, num(r[c.key]));
    }
  }

  function actionsCell(r) {
    const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
    const btns = [
      h('a', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm kbx-btn-icon', href: connectHref(r.kb_id), title: 'Connect (MCP config, SDK, tools)', 'aria-label': `Connect ${r.name}`, onClick: (e) => e.stopPropagation() }, h('i', { class: 'bi bi-plug' })),
    ];
    if (r.canManage) {
      btns.push(h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm kbx-btn-icon', type: 'button', title: 'Clear all entries', 'aria-label': `Clear ${r.name}`, onClick: stop(() => confirmClear(r)) }, h('i', { class: 'bi bi-eraser' })));
      btns.push(h('button', { class: 'kbx-btn kbx-btn-danger kbx-btn-sm kbx-btn-icon', type: 'button', title: 'Delete bank', 'aria-label': `Delete ${r.name}`, onClick: stop(() => confirmDelete(r)) }, h('i', { class: 'bi bi-trash' })));
    }
    return h('td', { class: 'kbx-cell-actions' }, ...btns);
  }

  async function act(method, url, okMsg) {
    const r = await fetch(url, { method, headers });
    let body = {};
    try { body = await r.json(); } catch { /* no body */ }
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    toast(typeof okMsg === 'function' ? okMsg(body) : okMsg, 'success');
    if (opts.reload) opts.reload();
  }

  function confirmClear(r) {
    const btn = h('button', { class: 'kbx-btn kbx-btn-danger', type: 'button' }, 'Clear all entries');
    const m = openModal({
      title: `Clear “${r.name}”?`,
      body: h('div', {}, h('p', {}, `Every entry (${num(r.entries)}) is removed from the bank. The bank, its MCP server and API keys stay.`), h('div', { class: 'kbx-alert warn' }, 'This cannot be undone.')),
      footer: [h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', onClick: () => m.close() }, 'Cancel'), btn],
    });
    btn.addEventListener('click', async () => {
      btn.classList.add('is-loading'); btn.disabled = true;
      try { await act('POST', `${apiBaseFor(root, r.kb_id)}/clear`, (b) => `Cleared ${num(b.cleared_count)} entries`); m.close(); }
      catch (e) { toast(e.message, 'error'); btn.classList.remove('is-loading'); btn.disabled = false; }
    });
  }

  function confirmDelete(r) {
    const input = h('input', { class: 'kbx-input', placeholder: r.name, 'aria-label': 'Type the bank name to confirm' });
    const btn = h('button', { class: 'kbx-btn kbx-btn-danger', type: 'button', disabled: true }, 'Delete bank');
    input.addEventListener('input', () => { btn.disabled = input.value.trim() !== r.name; });
    const m = openModal({
      title: `Delete “${r.name}”?`,
      body: h('div', {}, h('p', {}, 'The bank, all its entries and playbooks, and its MCP server are deleted. Agents pointed at it lose access.'), h('div', { class: 'kbx-alert danger' }, 'This cannot be undone.'), h('div', { class: 'kbx-field kbx-mt' }, h('label', {}, 'Type the bank name to confirm'), input)),
      footer: [h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', onClick: () => m.close() }, 'Cancel'), btn],
    });
    btn.addEventListener('click', async () => {
      btn.classList.add('is-loading'); btn.disabled = true;
      try { await act('DELETE', apiBaseFor(root, r.kb_id), 'Knowledge Bank deleted'); m.close(); }
      catch (e) { toast(e.message, 'error'); btn.classList.remove('is-loading'); btn.disabled = false; }
    });
  }

  function draw() {
    const shown = sortRows(filterRows(rows, { query, showEmpty }), sort.key, sort.dir);
    thead.querySelectorAll('th.sortable').forEach((th) => {
      const active = th.dataset.key === sort.key;
      th.classList.toggle('is-sorted', active);
      th.setAttribute('aria-sort', active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      const icon = th.querySelector('.kbx-sort-icon');
      icon.className = `bi kbx-sort-icon ${active ? (sort.dir === 'asc' ? 'bi-caret-up-fill' : 'bi-caret-down-fill') : 'bi-arrow-down-up'}`;
    });
    mount(tbody, ...shown.map((r) => {
      const tr = h('tr', { class: isEmptyBank(r) ? 'is-empty' : '', dataset: { kbId: r.kb_id, access: r.access } }, ...visibleCols.map((c) => cell(c, r)), hasActions ? actionsCell(r) : null);
      tr.addEventListener('click', (e) => { if (e.target.closest('a, button, dialog')) return; location.href = hrefFor(r.kb_id); });
      return tr;
    }));
    const t = totals(shown);
    mount(tfoot, h('tr', {}, ...visibleCols.map((c) => {
      if (c.key === 'name') return h('td', {}, `${t.banks} bank${t.banks === 1 ? '' : 's'}`);
      if (c.key in t) return h('td', { class: 'kbx-num' }, num(t[c.key]));
      return h('td', { class: c.optional ? 'kbx-col-opt' : '' }, '');
    }), hasActions ? h('td', {}) : null));
    wrap.classList.toggle('kbx-hidden', shown.length === 0);
    noMatch.classList.toggle('kbx-hidden', shown.length !== 0);
    if (!shown.length) mount(noMatch, empty('bi-search', 'No banks match', query ? `Nothing matches “${query}”.` : 'Every bank is empty — turn on "Show empty banks".'));
    const hidden = rows.length - filterRows(rows, { query, showEmpty: true }).length; // hidden by the search only
    const emptyHidden = showEmpty ? 0 : filterRows(rows, { query, showEmpty: true }).length - shown.length;
    countLabel.textContent = `${shown.length} of ${rows.length} bank${rows.length === 1 ? '' : 's'}` + (emptyHidden ? ` · ${emptyHidden} empty hidden` : '') + (hidden ? ` · ${hidden} filtered out` : '');
    emptyLabel.querySelector('span').textContent = `Show empty banks (${emptyCount})`;
    const granted = rows.filter((r) => r.access === 'granted').length;
    subEl.textContent = `${rows.length} bank${rows.length === 1 ? '' : 's'} visible to this credential` + (granted ? ` · ${granted} shared with you` : '') + (hasStats ? '' : ' · counts from the bank list') + (feeds.loadMs ? ` · loaded in ${(feeds.loadMs / 1000).toFixed(1)}s` : '');
  }

  searchInput.addEventListener('input', debounce(() => { query = searchInput.value; draw(); }, 120));
  emptyToggle.addEventListener('change', () => { showEmpty = emptyToggle.checked; savePrefs({ ...loadPrefs(), showEmpty }); draw(); });

  mount(root, header, h('div', { class: 'kbx-card kbx-picker-card' }, toolbar, h('div', { class: 'kbx-mt' }, wrap, noMatch)));
  draw();
}

/** Fetch both feeds IN PARALLEL (stats best-effort) and render once. */
export async function pickBank(root, { headers = {}, onUnauthorized = null } = {}) {
  const banksUrl = root.dataset.banksUrl || '/api/kb-explorer-banks';
  const statsUrl = root.dataset.statsUrl || null;
  mount(root, skeleton('Loading knowledge banks…'));
  const hdrs = { Accept: 'application/json', ...headers };
  const t0 = performance.now();

  const banksP = fetch(banksUrl, { headers: hdrs }).then(async (resp) => {
    if (resp.status === 401) return { unauthorized: true };
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return { banks: Array.isArray(data) ? data : (data.banks || data.data || []) };
  });
  const statsP = statsUrl
    ? fetch(statsUrl, { headers: hdrs }).then(async (resp) => {
      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try { const err = await resp.json(); msg = err.error || msg; } catch { /* keep status */ }
        throw new Error(msg);
      }
      return resp.json();
    })
    : Promise.resolve(null);

  let banks;
  try {
    const r = await banksP;
    if (r.unauthorized) { if (onUnauthorized) onUnauthorized(); else mount(root, h('div', { class: 'kbx-alert danger' }, 'Could not list knowledge banks: HTTP 401')); return; }
    banks = r.banks;
  } catch (e) {
    mount(root, h('div', { class: 'kbx-alert danger' }, `Could not list knowledge banks: ${e.message}`));
    return;
  }

  const feeds = { banks, stats: null, statsState: 'none', statsMessage: '', generatedAt: null };
  if (statsUrl) {
    try {
      const body = await statsP;
      const data = body && body.data && typeof body.data === 'object' && 'stats' in body.data ? body.data : body; // platform host wraps in {data}
      feeds.stats = data.stats || {};
      feeds.generatedAt = data.generated_at || null;
      feeds.statsState = 'ok';
    } catch (e) {
      feeds.statsState = 'error';
      feeds.statsMessage = e.message;
    }
  }
  feeds.loadMs = Math.round(performance.now() - t0);
  const d = root.dataset;
  renderPicker(root, feeds, {
    headers,
    createUrl: d.createUrl || null,
    apiKeysUrl: d.apiKeysUrl || null,
    tierUrl: d.tierUrl || null,
    billingUrl: d.billingUrl || null,
    reload: () => pickBank(root, { headers, onUnauthorized }),
  });
}
