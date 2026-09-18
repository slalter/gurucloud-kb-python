/* Pure view-model helpers for the explorer header tiles and the Entries tab
   count label. No DOM: main.js / entries.js render what these return, and the
   Node suite (tests/test_kb_explorer_stats_view.js) pins the semantics.

   Two different query counters feed the page and they must not be confused:
     • info.total_queries  — the bank's LIFETIME query count (app-side counter,
                             incremented on every MCP/API query);
     • stats.total_queries — the KB service's performance window, i.e. queries
                             in the LAST HOUR, alongside avg / p95 latency.
   The "Total queries" tile is lifetime; the latency tiles are last-hour and
   say so, and read "—" when nothing ran in that window. */

import { num } from './dom.js';

function isNum(v) { return v !== null && v !== undefined && Number.isFinite(Number(v)); }

/** Header tiles: [{ label, icon, text, unit? }]. `text` is display-ready. */
export function tileValues(info, stats, schema) {
  const i = info || {};
  const s = stats || null;
  const windowHasQueries = !s || !isNum(s.total_queries) || Number(s.total_queries) > 0;
  const avgSource = s && isNum(s.avg_query_time_ms) ? s.avg_query_time_ms : (isNum(i.avg_query_time_ms) ? i.avg_query_time_ms : null);
  const avg = windowHasQueries && avgSource !== null ? Number(avgSource).toFixed(1) : null;
  const p95 = s && windowHasQueries && isNum(s.p95_query_time_ms) ? Number(s.p95_query_time_ms).toFixed(0) : null;
  const lifetime = isNum(i.total_queries) ? i.total_queries : (s && isNum(s.total_queries) ? s.total_queries : null);
  return [
    { label: 'Entries', icon: 'bi-collection', text: num(i.entry_count) },
    { label: 'Total queries', icon: 'bi-search', text: lifetime === null ? '—' : num(lifetime) },
    { label: 'Avg query (1h)', icon: 'bi-speedometer2', text: avg === null ? '—' : avg, unit: avg === null ? undefined : 'ms' },
    { label: 'P95 query (1h)', icon: 'bi-graph-up', text: p95 === null ? '—' : p95, unit: p95 === null ? undefined : 'ms' },
    { label: 'Dimensions', icon: 'bi-diagram-2', text: schema && Array.isArray(schema.dimensions) ? num(schema.dimensions.length) : '—' },
  ];
}

/** Entries tab caption. `total` is the bank's live entry count (may be unknown). */
export function entriesCountLabel({ shown, loaded, total, showingScores }) {
  if (showingScores) return `${num(shown)} result${shown === 1 ? '' : 's'}`;
  const base = `Showing ${num(shown)} of ${num(loaded)} loaded entr${loaded === 1 ? 'y' : 'ies'}`;
  return isNum(total) && Number(total) > loaded ? `${base} · ${num(total)} in bank` : base;
}
