/* Entry connections view model — pure helpers for the Explorer's connection
   section on the entry detail (kanban c0cab0a7). Everything that is not DOM
   lives here so Node can test it (tests/test_kb_explorer_connections_model.js). */

/* The built-in vocabulary every bank speaks. A bank may declare more
   (GET /edge-relations, kanban ce8de075); relationNames() folds that answer
   into the list the connect form offers. */
export const RELATIONS = [
  'cites', 'see_also', 'part_of', 'supersedes', 'split_from', 'derived_from',
  'corrects', 'clarifies', 'conflicts_with', 'precedes', 'requires', 'produces', 'owned_by',
];

/** The relation names a bank allows, from its /edge-relations answer
    (built-ins first, then declared); the built-ins when the answer is missing. */
export function relationNames(vocabulary) {
  const rows = vocabulary && Array.isArray(vocabulary.relations) ? vocabulary.relations : null;
  const names = rows ? rows.map((r) => String((r && r.name) || '').trim()).filter(Boolean) : [];
  return names.length ? names : RELATIONS.slice();
}

/** Each relation's description from the vocabulary, for the picker's tooltip. */
export function relationDescriptions(vocabulary) {
  const out = {};
  const rows = vocabulary && Array.isArray(vocabulary.relations) ? vocabulary.relations : [];
  for (const r of rows) if (r && r.name && r.description) out[r.name] = String(r.description);
  return out;
}

/* How a relation reads from each side: [this -> other, other -> this]. */
const PHRASES = {
  cites: ['cites', 'is cited by'],
  see_also: ['see also', 'see also'],
  part_of: ['is part of', 'has part'],
  supersedes: ['supersedes', 'is superseded by'],
  split_from: ['was split from', 'was split into'],
  derived_from: ['was derived from', 'was the source of'],
  corrects: ['corrects', 'is corrected by'],
  clarifies: ['clarifies', 'is clarified by'],
  conflicts_with: ['conflicts with', 'conflicts with'],
  precedes: ['precedes', 'follows'],
  requires: ['requires', 'is required by'],
  produces: ['produces', 'is produced by'],
  owned_by: ['is owned by', 'owns'],
};

/** The phrase for a relation seen from the entry whose detail is open. */
export function relationLabel(relation, direction) {
  const pair = PHRASES[relation] || [String(relation || '').replace(/_/g, ' '), String(relation || '').replace(/_/g, ' ')];
  return direction === 'incoming' ? pair[1] : pair[0];
}

/** Chip tone per relation family. */
export function relationTone(relation) {
  if (relation === 'conflicts_with') return 'danger';
  if (relation === 'supersedes' || relation === 'corrects' || relation === 'clarifies') return 'warn';
  if (relation === 'part_of' || relation === 'split_from' || relation === 'derived_from') return 'info';
  return 'muted';
}

/** POST /edges body for one connection added from the detail of `entryId`.
    direction 'outgoing' = entryId -> otherId, 'incoming' = otherId -> entryId. */
export function buildAddRequest({ entryId, otherId, relation, direction = 'outgoing', note = '', allowed: allowedList = null }) {
  const other = String(otherId || '').trim();
  if (!entryId || other.length < 4) throw new Error('an entry id (full id or unique prefix, 4+ chars) is required');
  const allowed = Array.isArray(allowedList) && allowedList.length ? allowedList : RELATIONS;
  if (!allowed.includes(relation)) throw new Error(`relation must be one of ${allowed.join(', ')}`);
  if (other === entryId) throw new Error('an entry cannot be connected to itself');
  const incoming = direction === 'incoming';
  const edge = {
    from_entry_id: incoming ? other : entryId,
    to_entry_id: incoming ? entryId : other,
    edge_type: relation,
    evidence: { method: 'explorer' },
  };
  const trimmed = String(note || '').trim();
  if (trimmed) edge.note = trimmed.slice(0, 2000);
  return { edges: [edge] };
}

/** Both directions of GET /entries/{id}/edges as one ordered list of rows. */
export function connectionRows(conns) {
  const rows = [];
  for (const [direction, key] of [['outgoing', 'outgoing'], ['incoming', 'incoming']]) {
    for (const e of (conns && conns[key]) || []) {
      rows.push({
        id: e.id,
        direction,
        relation: e.edge_type,
        label: relationLabel(e.edge_type, direction),
        tone: relationTone(e.edge_type),
        otherId: e.other ? e.other.id : (direction === 'outgoing' ? e.to_entry_id : e.from_entry_id),
        otherText: (e.other && (e.other.useful_for || e.other.snippet)) || '',
        note: e.note || '',
        source: e.source || 'author',
      });
    }
  }
  return rows;
}

/** What the add-edges response did, as a toast line. */
export function addResultText(result) {
  const created = (result && result.created) || [];
  const existing = (result && result.existing) || [];
  const errors = (result && result.errors) || [];
  if (errors.length) return `Could not connect: ${errors[0].error}`;
  if (created.length) return created.length === 1 ? 'Connected' : `${created.length} connections added`;
  if (existing.length) return 'Already connected';
  return 'Nothing to do';
}

function short(text, n = 60) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

/** Cytoscape elements for GET /graph: the root stands out, labels are the
    entries' useful_for (snippet when empty), edges carry their relation. */
export function graphElements(graph, rootId) {
  const nodes = ((graph && graph.nodes) || []).map((n) => ({
    data: { id: n.id, label: short(n.useful_for || n.snippet || n.id.slice(0, 8)), depth: n.depth || 0, full: n.useful_for || n.snippet || '' },
    classes: n.id === rootId ? 'root' : `depth-${Math.min(n.depth || 0, 3)}`,
  }));
  const known = new Set(nodes.map((n) => n.data.id));
  const edges = ((graph && graph.edges) || [])
    .filter((e) => known.has(e.from_entry_id) && known.has(e.to_entry_id))
    .map((e) => ({ data: { id: e.id, source: e.from_entry_id, target: e.to_entry_id, label: e.edge_type.replace(/_/g, ' '), source_kind: e.source || 'author' }, classes: e.source === 'bridged' ? 'bridged' : '' }));
  return { nodes, edges };
}

/** One-line caption for a graph response. */
export function graphCaption(graph) {
  if (!graph) return '';
  const n = (graph.nodes || []).length;
  const m = (graph.edges || []).length;
  const depth = graph.depth || 1;
  return `${n} entr${n === 1 ? 'y' : 'ies'} · ${m} connection${m === 1 ? '' : 's'} · ${depth} hop${depth === 1 ? '' : 's'}${graph.truncated ? ' · cut at the node cap' : ''}`;
}

/** Caption for POST /edges/backfill. */
export function backfillSummary(report) {
  if (!report) return '';
  const planned = Object.values(report.by_type || {}).reduce((a, b) => a + b, 0);
  const types = Object.entries(report.by_type || {}).map(([t, n]) => `${n} ${t.replace(/_/g, ' ')}`).join(', ');
  const head = report.dry_run
    ? `Dry run: ${planned} connection${planned === 1 ? '' : 's'} found in ${report.entries_scanned} entries`
    : `${report.created} connection${report.created === 1 ? '' : 's'} written, ${report.existing} already there`;
  const skipped = [];
  if (report.unresolved) skipped.push(`${report.unresolved} cite entries that no longer exist`);
  if (report.ambiguous) skipped.push(`${report.ambiguous} ambiguous prefixes`);
  if (report.errors) skipped.push(`${report.errors} errors`);
  return [head, types ? `(${types})` : '', skipped.length ? `· skipped ${skipped.join(', ')}` : ''].filter(Boolean).join(' ');
}
