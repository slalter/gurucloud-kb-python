/* History view — recent queries, deduplication events and the entry event
   log. Read-only audit surface mirroring the SDK's list_recent_queries /
   list_events / get_event / list_event_logs. */

import { h, mount, clear, toast, skeleton, empty, timeAgo, fmtDate, meter } from './dom.js';
import { openModal } from './modal.js';

const ACTION_CHIP = { new: 'success', redundant: 'muted', update: 'info', conflict: 'warn', error: 'danger' };

export function createEventsView(ctx) {
  const { api } = ctx;
  const el = h('div', {});
  let loaded = false;
  let mode = 'queries';

  const seg = h('div', { class: 'kbx-tabs', style: { marginBottom: '16px' } },
    segBtn('queries', 'bi-search', 'Recent queries'),
    segBtn('dedup', 'bi-shuffle', 'Deduplication'),
    segBtn('log', 'bi-list-columns-reverse', 'Entry event log'));
  const host = h('div', {});
  mount(el, seg, host);

  function segBtn(id, icon, label) {
    return h('button', { class: `kbx-tab${mode === id ? ' is-active' : ''}`, type: 'button', dataset: { seg: id }, onClick: () => { mode = id; seg.querySelectorAll('.kbx-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.seg === id)); render(); } }, h('i', { class: `bi ${icon}` }), label);
  }

  function render() { mode === 'queries' ? loadQueries() : mode === 'dedup' ? loadDedup() : loadLog(); }

  // ── recent queries ─────────────────────────────────────────────────────────
  async function loadQueries() {
    mount(host, skeleton('Loading recent queries…'));
    try {
      const data = await api.recentQueries({ limit: 100 });
      const rows = Array.isArray(data) ? data : (data && data.queries) || [];
      if (!rows.length) { mount(host, empty('bi-search', 'No queries yet', 'Queries made by agents and this explorer appear here.')); return; }
      const table = h('table', { class: 'kbx-table' },
        h('thead', {}, h('tr', {}, ...['Query', 'Results', 'Duration', 'Source', 'Filters', 'When'].map((t) => h('th', {}, t)))),
        h('tbody', {}, ...rows.map((q) => h('tr', {},
          h('td', {}, h('span', { class: 'kbx-strong' }, q.query_text || '(empty)')),
          h('td', { class: 'kbx-num' }, q.result_count != null ? String(q.result_count) : '—'),
          h('td', { class: 'kbx-num' }, q.duration_ms != null ? `${Number(q.duration_ms).toFixed(0)}ms` : '—'),
          h('td', {}, q.query_source ? h('span', { class: 'kbx-chip muted' }, q.query_source) : h('span', { class: 'kbx-muted' }, '·')),
          h('td', { class: 'kbx-mono', style: { fontSize: '11px', maxWidth: '260px', overflowWrap: 'anywhere' } }, q.filters_used && Object.keys(q.filters_used).length ? JSON.stringify(q.filters_used) : h('span', { class: 'kbx-muted' }, '—')),
          h('td', { class: 'kbx-muted', style: { whiteSpace: 'nowrap' }, title: fmtDate(q.created_at) }, timeAgo(q.created_at))))));
      mount(host,
        h('div', { class: 'kbx-muted', style: { fontSize: '13px', marginBottom: '8px' } }, `Last ${rows.length} queries, newest first. Search this bank from the Entries tab to see yours appear.`),
        h('div', { class: 'kbx-table-wrap' }, table));
    } catch (e) {
      mount(host, h('div', { class: 'kbx-alert danger' }, `Could not load recent queries: ${e.message}`));
    }
  }

  // ── dedup ──────────────────────────────────────────────────────────────────
  async function loadDedup(action) {
    mount(host, skeleton('Loading deduplication events…'));
    try {
      const data = await api.listEvents({ action, limit: 100 });
      const counts = data.action_counts || {};
      const filters = h('div', { class: 'kbx-row', style: { marginBottom: '14px' } },
        filterPill('All', !action, () => loadDedup()),
        ...['new', 'redundant', 'update', 'conflict', 'error'].map((a) => filterPill(`${a} (${counts[a] || 0})`, action === a, () => loadDedup(a))));
      if (!data.events.length) { mount(host, filters, empty('bi-shuffle', 'No deduplication events', 'Events appear as entries are ingested.')); return; }
      const list = h('div', { class: 'kbx-list' });
      data.events.forEach((ev) => list.append(dedupCard(ev)));
      mount(host, filters, h('div', { class: 'kbx-muted', style: { fontSize: '13px', marginBottom: '8px' } }, `Showing ${data.events.length} of ${data.total}`), list);
    } catch (e) {
      mount(host, h('div', { class: 'kbx-alert danger' }, `Could not load events: ${e.message}`));
    }
  }
  function filterPill(label, active, onClick) {
    return h('button', { class: `kbx-btn ${active ? 'kbx-btn-primary' : 'kbx-btn-ghost'} kbx-btn-sm`, type: 'button', onClick }, label);
  }
  function dedupCard(ev) {
    return h('div', { class: 'kbx-item', onClick: () => openDedupDetail(ev.id) },
      h('div', { class: 'kbx-item-head' },
        h('div', { class: 'kbx-row', style: { gap: '6px' } },
          h('span', { class: `kbx-chip ${ACTION_CHIP[ev.action] || 'muted'}` }, ev.action),
          h('span', { class: `kbx-chip ${ev.llm_invoked ? 'info' : 'muted'}` }, ev.llm_invoked ? 'LLM' : 'auto')),
        h('span', { class: 'kbx-muted', style: { fontSize: '12px' } }, timeAgo(ev.created_at))),
      h('div', { class: 'kbx-item-body' }, ev.content_preview || '(no preview)'),
      h('div', { class: 'kbx-item-meta' },
        ev.max_similarity_score != null ? h('span', {}, `score ${(ev.max_similarity_score * 100).toFixed(0)}%`) : null,
        ev.source ? h('span', {}, ev.source) : null));
  }
  async function openDedupDetail(id) {
    const ref = openModal({ title: 'Deduplication event', body: skeleton('Loading…'), wide: true });
    let ev;
    try { ev = await api.getEvent(id); }
    catch (e) { ref.setBody(h('div', { class: 'kbx-alert danger' }, e.message)); return; }
    const similar = ev.similar_entries || [];
    const body = h('div', {},
      h('div', { class: 'kbx-row', style: { gap: '6px', marginBottom: '12px' } },
        h('span', { class: `kbx-chip ${ACTION_CHIP[ev.action] || 'muted'}` }, ev.action),
        h('span', { class: `kbx-chip ${ev.llm_invoked ? 'info' : 'muted'}` }, ev.llm_invoked ? 'LLM invoked' : 'auto'),
        ev.execution_status ? h('span', { class: 'kbx-chip muted' }, ev.execution_status) : null),
      ev.reasoning ? h('div', { class: 'kbx-alert info', style: { marginBottom: '12px' } }, h('i', { class: 'bi bi-chat-quote' }), h('div', {}, h('strong', {}, 'Reasoning — '), ev.reasoning)) : null,
      section('New entry content', ev.new_entry_content),
      section('New entry useful-for', ev.new_entry_useful_for),
      similar.length ? h('div', { class: 'kbx-mt' }, h('h4', { style: { fontSize: '14px', margin: '0 0 8px' } }, `Similar entries compared (${similar.length})`),
        h('div', { class: 'kbx-list' }, ...similar.map((s) => h('div', { class: 'kbx-item', style: { cursor: 'default' } },
          h('div', { class: 'kbx-row-between' }, h('span', { class: 'kbx-mono kbx-muted', style: { fontSize: '11px' } }, String(s.id || '').slice(0, 8)), h('span', { class: 'kbx-chip' }, `${((s.score || 0) * 100).toFixed(0)}%`)),
          h('div', { class: 'kbx-item-body kbx-mt' }, s.content_preview || ''))))) : null,
      ev.merged_content ? section('Merged content', ev.merged_content) : null,
      ev.execution_error ? h('div', { class: 'kbx-alert danger kbx-mt' }, ev.execution_error) : null,
      h('dl', { class: 'kbx-kv kbx-mt-lg' },
        h('dt', {}, 'Result entry'), h('dd', { class: 'kbx-mono', style: { fontSize: '12px' } }, ev.result_entry_id || ev.target_entry_id || '—'),
        h('dt', {}, 'Source'), h('dd', {}, ev.source || '—'),
        h('dt', {}, 'Created'), h('dd', {}, fmtDate(ev.created_at))));
    ref.setBody(body);
  }
  function section(title, text) {
    if (!text) return null;
    return h('div', { class: 'kbx-field' }, h('label', {}, title), h('div', { class: 'kbx-code', style: { whiteSpace: 'pre-wrap' } }, text));
  }

  // ── entry event log ────────────────────────────────────────────────────────
  async function loadLog(eventType) {
    mount(host, skeleton('Loading event log…'));
    try {
      const data = await api.listEventLogs({ event_type: eventType, limit: 100 });
      const types = ['lifecycle', 'hash_check', 'dedup', 'action'];
      const filters = h('div', { class: 'kbx-row', style: { marginBottom: '14px' } },
        filterPill('All', !eventType, () => loadLog()),
        ...types.map((t) => filterPill(t, eventType === t, () => loadLog(t))));
      if (!data.logs.length) { mount(host, filters, empty('bi-list-columns-reverse', 'No event log rows')); return; }
      const rows = data.logs.map((lg) => h('tr', {},
        h('td', {}, h('span', { class: `kbx-chip ${lg.success === true ? 'success' : lg.success === false ? 'danger' : 'muted'}` }, lg.event_type || '—')),
        h('td', {}, h('span', { class: 'kbx-strong' }, lg.event_name || '—')),
        h('td', {}, lg.success === true ? h('i', { class: 'bi bi-check-lg', style: { color: 'var(--kbx-success)' } }) : lg.success === false ? h('i', { class: 'bi bi-x-lg', style: { color: 'var(--kbx-danger)' } }) : h('span', { class: 'kbx-muted' }, '·')),
        h('td', { class: 'kbx-num' }, lg.duration_ms != null ? `${lg.duration_ms}ms` : '—'),
        h('td', {}, h('div', {}, lg.detail || lg.error_message || '—')),
        h('td', { class: 'kbx-muted', style: { whiteSpace: 'nowrap' } }, timeAgo(lg.created_at))));
      mount(host, filters,
        h('div', { class: 'kbx-muted', style: { fontSize: '13px', marginBottom: '8px' } }, `Showing ${data.logs.length} of ${data.total}`),
        h('div', { class: 'kbx-table-wrap' }, h('table', { class: 'kbx-table' },
          h('thead', {}, h('tr', {}, ...['Type', 'Event', 'OK', 'Duration', 'Detail', 'When'].map((t) => h('th', {}, t)))),
          h('tbody', {}, ...rows))));
    } catch (e) {
      mount(host, h('div', { class: 'kbx-alert danger' }, `Could not load event log: ${e.message}`));
    }
  }

  return {
    el,
    load() { if (!loaded) { loaded = true; render(); } },
    reload: render,
  };
}
