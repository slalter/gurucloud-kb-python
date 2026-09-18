/* Bank picker model — pure functions behind the Knowledge Banks table.

   Two feeds meet here: the host's bank list ({kb_id,name,description,
   entry_count,total_queries,access?}) and, when the host offers one, a stats map keyed
   by kb_id ({entry_count, playbooks_active, playbooks_draft, queries_total,
   queries_24h, queries_7d, queries_30d, queries_zero_result, last_query_at,
   last_entry_at, created_at, error}). Live stats win over the list's cached
   counts. `access` (owner | granted | admin, default owner) says how the
   viewer reaches the bank: a grantee can use it, never clear or delete it.
   No DOM here so the logic is testable in Node. */

export const COLUMNS = [
  { key: 'name', label: 'Knowledge Bank', kind: 'string', align: 'left' },
  { key: 'entries', label: 'Entries', kind: 'number', align: 'right' },
  { key: 'playbooks', label: 'Playbooks', kind: 'number', align: 'right' },
  { key: 'queries', label: 'Queries', kind: 'number', align: 'right', title: 'Lifetime searches + playbook matches' },
  { key: 'q7d', label: '7d', kind: 'number', align: 'right', title: 'Queries in the last 7 days', stats: true },
  { key: 'q24h', label: '24h', kind: 'number', align: 'right', title: 'Queries in the last 24 hours', stats: true },
  { key: 'zeroRate', label: 'No-hit', kind: 'number', align: 'right', title: 'Share of queries that returned nothing', stats: true, optional: true },
  { key: 'lastQueryAt', label: 'Last query', kind: 'date', align: 'left', stats: true },
  { key: 'lastEntryAt', label: 'Last entry', kind: 'date', align: 'left', stats: true, optional: true },
];

export const DEFAULT_SORT = { key: 'entries', dir: 'desc' };

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Join one bank row with its stats (if any) into a flat table row. */
export function toRow(bank, stats) {
  const s = stats || null;
  const known = !!(s && !s.error);
  const entries = known ? numOrNull(s.entry_count) : numOrNull(bank.entry_count);
  const queries = known ? numOrNull(s.queries_total) : numOrNull(bank.total_queries);
  const playbooks = known ? numOrNull(s.playbooks_active) : null;
  const zero = known ? numOrNull(s.queries_zero_result) : null;
  const access = bank.access === 'granted' || bank.access === 'admin' ? bank.access : 'owner';
  return {
    kb_id: String(bank.kb_id || bank.id || ''),
    name: bank.name || bank.kb_id || bank.id || '',
    description: bank.description || '',
    access,
    canManage: access !== 'granted',
    entries,
    playbooks,
    playbooksDraft: known ? numOrNull(s.playbooks_draft) : null,
    queries,
    q24h: known ? numOrNull(s.queries_24h) : null,
    q7d: known ? numOrNull(s.queries_7d) : null,
    q30d: known ? numOrNull(s.queries_30d) : null,
    zeroRate: known && queries ? (zero || 0) / queries : null,
    lastQueryAt: known ? s.last_query_at || null : null,
    lastEntryAt: known ? s.last_entry_at || null : null,
    createdAt: (s && s.created_at) || bank.created_at || null,
    statsKnown: known,
    statsError: !!(s && s.error),
  };
}

/** @param {Array} banks  @param {Object|null} statsMap kb_id → stats */
export function buildRows(banks, statsMap) {
  const map = statsMap || {};
  return (banks || []).map((b) => toRow(b, map[b.kb_id || b.id]));
}

/** Empty = nothing to explore: zero entries and zero (or unknown) playbooks.
    A bank whose counts are unknown is never treated as empty. */
export function isEmptyBank(row) {
  if (row.entries === null) return false;
  if (row.entries > 0) return false;
  return !(row.playbooks > 0);
}

export function filterRows(rows, { query = '', showEmpty = false } = {}) {
  const q = String(query || '').trim().toLowerCase();
  return rows.filter((r) => {
    if (!showEmpty && isEmptyBank(r)) return false;
    if (!q) return true;
    return r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q) || r.kb_id.toLowerCase().startsWith(q);
  });
}

function cmpValues(a, b, kind) {
  const an = a === null || a === undefined || a === '';
  const bn = b === null || b === undefined || b === '';
  if (an && bn) return 0;
  if (an) return 1; // nulls last, whatever the direction
  if (bn) return -1;
  if (kind === 'string') return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
  if (kind === 'date') return new Date(a).getTime() - new Date(b).getTime();
  return Number(a) - Number(b);
}

/** Stable sort; nulls sink to the bottom in both directions; ties fall back to name. */
export function sortRows(rows, key = DEFAULT_SORT.key, dir = DEFAULT_SORT.dir) {
  const col = COLUMNS.find((c) => c.key === key) || COLUMNS[0];
  const sign = dir === 'asc' ? 1 : -1;
  return rows
    .map((r, i) => ({ r, i }))
    .sort((x, y) => {
      const a = x.r[col.key], b = y.r[col.key];
      const an = a === null || a === undefined || a === '';
      const bn = b === null || b === undefined || b === '';
      if (an !== bn) return an ? 1 : -1;
      const c = cmpValues(a, b, col.kind) * sign;
      if (c !== 0) return c;
      const n = cmpValues(x.r.name, y.r.name, 'string');
      return n !== 0 ? n : x.i - y.i;
    })
    .map((x) => x.r);
}

/** Next sort state after clicking a header: numbers/dates open descending,
    strings ascending; a second click flips. */
export function nextSort(current, key) {
  const col = COLUMNS.find((c) => c.key === key) || COLUMNS[0];
  if (current && current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: col.kind === 'string' ? 'asc' : 'desc' };
}

function sumKnown(rows, key) {
  let any = false, total = 0;
  for (const r of rows) { if (r[key] !== null && r[key] !== undefined) { any = true; total += Number(r[key]); } }
  return any ? total : null;
}

export function totals(rows) {
  return {
    banks: rows.length,
    entries: sumKnown(rows, 'entries'),
    playbooks: sumKnown(rows, 'playbooks'),
    queries: sumKnown(rows, 'queries'),
    q7d: sumKnown(rows, 'q7d'),
    q24h: sumKnown(rows, 'q24h'),
  };
}

/** Percent string for a 0..1 rate; '—' when unknown. */
export function fmtRate(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  return `${Math.round(Number(v) * 100)}%`;
}
