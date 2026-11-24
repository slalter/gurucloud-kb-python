/* Relations view model — pure helpers for a bank's relation vocabulary
   (GET /edge-types, kanban 6b4fd3bf): one colour per relation that every
   view agrees on, the rows the Relations tab lists, the Graph tab's
   relation legend and its hide/show filter. No DOM, so Node tests it
   (tests/test_kb_explorer_relations_model.js). */

import { RELATION_COLORS } from './graph_model.js';
import { RELATIONS, relationLabel } from './connections_model.js';

/* Colours for relations the built-in map does not know (declared by a
   person or coined by an agent). Chosen to stay apart from the built-in
   hues and to read on both the light panels and the dark 3D stage. */
export const EXTRA_RELATION_COLORS = Object.freeze([
  '#e0892b', '#2f9bd6', '#a75bc4', '#58a55c', '#e0664a', '#d94f8a',
  '#8fb23a', '#2fa39a', '#c9a227', '#5f6fc9', '#9a7460', '#6f8a99',
]);

/* `coined` = added through the judge (POST /edge-relations/propose), by an agent or by a person in the Explorer. */
const ORIGIN_LABEL = { builtin: 'built in', declared: 'declared', coined: 'coined' };
const ORIGIN_TONE = { builtin: 'muted', declared: 'info', coined: 'success' };

function hash(s) {
  let x = 0;
  for (const ch of String(s)) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return x;
}

/** The bank's own (non built-in) relation names in vocabulary order. A
    relation is only ever appended, so its place, and with it its colour,
    does not move when the vocabulary grows. */
export function ownRelationNames(vocabulary) {
  const rows = vocabulary && Array.isArray(vocabulary.relations) ? vocabulary.relations : [];
  return rows.map((r) => String((r && r.name) || '')).filter((n) => n && !RELATION_COLORS[n]);
}

/** The colour of a relation: the built-in colour when it has one, else the
    extra palette by its place among the bank's own relations, else (no
    vocabulary at hand) a stable pick from the name. */
export function relationColor(name, vocabulary) {
  const key = String(name || '');
  if (RELATION_COLORS[key] && key !== 'connected') return RELATION_COLORS[key];
  const own = ownRelationNames(vocabulary);
  const at = own.indexOf(key);
  const i = at >= 0 ? at : hash(key);
  return EXTRA_RELATION_COLORS[i % EXTRA_RELATION_COLORS.length];
}

/** `{name: colour}` for every relation of the vocabulary. */
export function relationColorMap(vocabulary) {
  const out = {};
  const rows = vocabulary && Array.isArray(vocabulary.relations) ? vocabulary.relations : [];
  for (const r of rows) if (r && r.name) out[r.name] = relationColor(r.name, vocabulary);
  return out;
}

/** How a relation reads from each side, preferring what the bank declared. */
export function relationPhrases(row) {
  const name = String((row && row.name) || '');
  const forward = RELATIONS.includes(name) ? relationLabel(name, 'outgoing') : name.replace(/_/g, ' ');
  const declared = String((row && row.inverse) || '').trim();
  const back = declared || (RELATIONS.includes(name) ? relationLabel(name, 'incoming') : (row && row.symmetric ? forward : `${forward} (reversed)`));
  return { forward, back };
}

function endText(end) {
  if (!end) return '';
  return String(end.summary || end.useful_for || end.snippet || '');
}

/** One row per relation for the Relations tab. `sort`: 'vocabulary' keeps
    the bank's order, 'count' puts the most used first. */
export function relationRows(edgeTypes, { sort = 'vocabulary', query = '' } = {}) {
  const rows = edgeTypes && Array.isArray(edgeTypes.relations) ? edgeTypes.relations : [];
  const needle = String(query || '').trim().toLowerCase();
  const total = Number(edgeTypes && edgeTypes.total_edges) || 0;
  let out = rows.filter((r) => r && r.name).map((r, index) => {
    const phrases = relationPhrases(r);
    const count = Number(r.edge_count) || 0;
    const sample = r.sample && r.sample.edge ? {
      from: endText(r.sample.from_end) || String(r.sample.edge.from_entry_id || '').slice(0, 8),
      to: endText(r.sample.to_end) || String(r.sample.edge.to_entry_id || '').slice(0, 8),
      fromId: r.sample.edge.from_entry_id || null,
      toId: r.sample.edge.to_entry_id || null,
      note: r.sample.edge.note || '',
    } : null;
    return {
      name: r.name, index, color: relationColor(r.name, edgeTypes), description: r.description || '',
      forward: phrases.forward, back: phrases.back, origin: r.origin || 'builtin',
      originLabel: ORIGIN_LABEL[r.origin] || String(r.origin || ''), originTone: ORIGIN_TONE[r.origin] || 'muted',
      coinedBy: r.coined_by || '', coinedAt: r.coined_at || '', system: Boolean(r.system),
      transitive: Boolean(r.transitive), symmetric: Boolean(r.symmetric), representative: r.representative || null,
      count, share: total ? count / total : 0, sample,
    };
  });
  if (needle) out = out.filter((r) => `${r.name} ${r.description} ${r.forward} ${r.back}`.toLowerCase().includes(needle));
  if (sort === 'count') out = out.slice().sort((a, b) => b.count - a.count || a.index - b.index);
  return out;
}

/** Headline numbers for the tab. */
export function relationSummary(edgeTypes) {
  const rows = edgeTypes && Array.isArray(edgeTypes.relations) ? edgeTypes.relations : [];
  return {
    total: rows.length,
    inUse: rows.filter((r) => Number(r.edge_count) > 0).length,
    coined: rows.filter((r) => r.origin === 'coined').length,
    declared: rows.filter((r) => r.origin === 'declared').length,
    edges: Number(edgeTypes && edgeTypes.total_edges) || 0,
    open: Boolean(edgeTypes && edgeTypes.open),
  };
}

/** The Graph tab's relation legend: every relation that has at least one
    drawn edge, most used first, with its colour and whether it is hidden. */
export function relationLegend(edges, vocabulary, hidden = []) {
  const counts = new Map();
  (edges || []).forEach((e) => { if (e && e.edge_type) counts.set(e.edge_type, (counts.get(e.edge_type) || 0) + 1); });
  const off = new Set(hidden);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([name, count]) => ({ name, count, color: relationColor(name, vocabulary), label: name.replace(/_/g, ' '), hidden: off.has(name) }));
}

/** The edges whose relation is not hidden. */
export function visibleEdges(edges, hidden = []) {
  const off = new Set(hidden);
  return off.size ? (edges || []).filter((e) => !off.has(e && e.edge_type)) : (edges || []);
}

/** Legend click: plain click shows only that relation (or everything again
    when it already is the only one shown); `additive` toggles just it. */
export function toggleHidden(hidden, name, allNames, { additive = false } = {}) {
  const off = new Set(hidden);
  if (additive) {
    if (off.has(name)) off.delete(name); else off.add(name);
    return [...off];
  }
  const shown = allNames.filter((n) => !off.has(n));
  if (shown.length === 1 && shown[0] === name) return [];
  return allNames.filter((n) => n !== name);
}

/** The proposal form's body, or throws a message the form shows. */
export function buildProposal({ name, description, inverse = '', symmetric = false, reason = '' }) {
  const slug = String(name || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(slug)) throw new Error('name: 2-32 lowercase letters, digits or underscores, starting with a letter');
  const text = String(description || '').trim();
  if (text.length < 12) throw new Error('say what it means, read from the first entry to the second (12+ characters)');
  const body = { name: slug, description: text, symmetric: Boolean(symmetric) };
  if (String(inverse).trim()) body.inverse = String(inverse).trim();
  if (String(reason).trim()) body.reason = String(reason).trim();
  return body;
}

/** Whether the bank can merge a relation away or remove it (kanban
    1a2a5590): only one the bank itself added, never a built-in or a relation
    the service writes. `canRetire` also needs it to be unused. The service
    has the last word (it also refuses a pointer-only relation). */
export function relationManage(row) {
  const name = String((row && row.name) || '');
  const own = Boolean(name) && !RELATIONS.includes(name) && !(row && row.system) && ['coined', 'declared'].includes(row && row.origin);
  const count = Number(row && row.count) || 0;
  return {
    canMerge: own, canRetire: own && count === 0,
    why: own ? (count ? 'Connections still use it: merge it into another relation instead.' : '') : 'Built-in relations stay.',
  };
}

/** The relations `name` can be merged into: every other one, vocabulary order. */
export function mergeTargets(edgeTypes, name) {
  return relationRows(edgeTypes).filter((r) => r.name !== name)
    .map((r) => ({ name: r.name, label: `${r.name} — A ${r.forward} B`, description: r.description, count: r.count }));
}

/** The merge request body, or throws a message the dialog shows. */
export function buildMerge({ name, into, swapEnds = false, reason = '', dryRun = false }) {
  const target = String(into || '').trim();
  if (!target) throw new Error('choose the relation to keep');
  if (target === name) throw new Error('a relation cannot be merged into itself');
  const body = { into: target, swap_ends: Boolean(swapEnds), dry_run: Boolean(dryRun) };
  if (String(reason).trim()) body.reason = String(reason).trim();
  return body;
}

/** What a merge preview (dry run) or a finished merge tells the person. */
export function mergeOutcome(result) {
  const r = result || {};
  const n = Number(r.edges) || 0;
  const dups = Number(r.duplicates_removed) || 0;
  const left = Array.isArray(r.left_behind) ? r.left_behind.length : 0;
  const fallback = r.dry_run
    ? `${Number(r.retyped) || 0} of ${n} connection${n === 1 ? '' : 's'} would become “${r.into}”${dups ? `, ${dups} already exist there and would be removed` : ''}.`
    : `Merged “${r.relation}” into “${r.into}”.`;
  return { tone: left ? 'warn' : (r.dry_run ? 'info' : 'success'), text: r.message || fallback, edges: n, retyped: Number(r.retyped) || 0, duplicates: dups };
}

/** Why a merge or removal was refused, in the person's terms. */
export function manageRefusal(error) {
  const status = error && error.status;
  const message = String((error && error.message) || '');
  if (status === 403) return 'You need manage rights on this bank to change its relation list.';
  if (status === 404) return 'This knowledge bank service cannot merge or remove relations yet (it predates this control), or the relation is already gone.';
  return message || 'The relation list was not changed.';
}

/** What to tell the person after POST /edge-relations/propose. */
export function proposalOutcome(result) {
  const status = result && result.status;
  if (status === 'added') return { tone: 'success', text: result.judged ? `Added “${result.use}”.` : `Added “${result.use}” (no duplicate check was available).` };
  if (status === 'use_existing') return { tone: 'info', text: result.message || `Automatically mapped to “${result.use}”${result.reversed ? ', read from the other end' : ''}.` };
  if (status === 'exists') return { tone: 'info', text: `“${result.use}” is already a relation of this bank.` };
  return { tone: 'error', text: 'The relation was not added.' };
}
