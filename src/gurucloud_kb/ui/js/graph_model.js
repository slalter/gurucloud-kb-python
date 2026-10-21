/* Graph tab — pure logic (no DOM, no Cytoscape, no fetch).

   Two pictures of the bank's knowledge graph (entry_edges, kanban c0cab0a7):

     • the SEARCH picture: what an agent gets back from query_knowledge_bank
       for a query (the ranked results plus the `related` pointers the
       retrieval collapse attaches, kb_service/result_collapse.py) and, next
       to it, the same answer drawn as a graph: retrieved entries, the entries
       the pointers name, the edges between them, optionally every other
       connection of the results;
     • the BANK picture ("constellation"): every edge in the bank, laid out
       component by component with no overlapping nodes, deterministic.

   Edges can also target a playbook step (to_entry_id null, to_playbook_slug +
   to_step_key); the pictures here are entry-to-entry, so those edges are
   counted and skipped.

   Exported for graph.js (the renderer) and for the Node suite
   tests/test_kb_explorer_graph_model.js. */

import { packCircles } from './map_layout.js';
import { primaryDim } from './schema_utils.js';

export const RELATION_COLORS = {
  cites: '#3f7a80', see_also: '#8fa8ab', clarifies: '#2f8f5b', corrects: '#b3433e', supersedes: '#c47a2c',
  split_from: '#b9b9b9', part_of: '#6b5fb0', requires: '#9b3f7a', derived_from: '#7a6b3f', precedes: '#3f6bb0',
  produces: '#3fb0a8', conflicts_with: '#b03f3f', owned_by: '#555555', connected: '#999999',
};

export const DEFAULTS = Object.freeze({ k: 8, collapse: true, maxNeighbors: 3, threshold: 0, context: false, view: 'bank' });
export const MAX_BANK_EDGES = 3000;
const LABEL_LEN = 64;
const DOT_MIN = 6;
const DOT_MAX = 16;

function short(s, n = LABEL_LEN) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

/** The one-line text an entry-like object is known by: its summary, else useful_for, else content. */
export function labelFor(e) {
  if (!e) return '';
  const md = e.metadata && typeof e.metadata === 'object' ? e.metadata : {};
  return short(md.summary || e.summary || e.useful_for || e.text || e.snippet || e.content || (e.id ? String(e.id).slice(0, 8) : ''));
}

/** Clamp the Graph tab's knobs to what the service accepts. */
export function normalizeOptions(o = {}) {
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d; };
  return {
    view: o.view === 'answer' ? 'answer' : 'bank',
    k: num(o.k, DEFAULTS.k, 1, 20),
    collapse: o.collapse === undefined ? DEFAULTS.collapse : Boolean(o.collapse),
    maxNeighbors: num(o.maxNeighbors, DEFAULTS.maxNeighbors, 0, 6),
    threshold: (() => { const t = Number(o.threshold); return Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : DEFAULTS.threshold; })(),
    context: o.context === undefined ? DEFAULTS.context : Boolean(o.context),
  };
}

/** POST /search body for the Graph tab's query box: the bank's primary
    semantic dimension carries the text; `collapse` is sent only when on
    (null/absent keeps the flat ranking). */
export function searchPayload({ schema, query, ...opts }) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Type a query first');
  const o = normalizeOptions(opts);
  const dim = primaryDim(schema) || 'content';
  const payload = { dimensions: { [dim]: { query_text: q } }, k: o.k, threshold: o.threshold, combination_mode: 'weighted_sum' };
  if (o.collapse) payload.collapse = { max_neighbors: o.maxNeighbors };
  return payload;
}

/** The search response's result list, whatever envelope the host used. */
export function resultsOf(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return data.results || data.entries || [];
  return [];
}

/** One pointer the way the hosted query_knowledge_bank tool prints it:
    `via` only when set, `note` only when present, `kind` only for neighbors,
    score dropped when 0 (mcp_servers/main/tools/knowledge_bank_tools.py). */
export function compactPointer(p) {
  const out = { id: p.id, relation: p.relation || 'connected', direction: p.direction || 'outgoing' };
  if (p.via) out.via = p.via;
  if (p.text) out.text = p.text;
  if (p.score) out.score = Number(p.score);
  if (p.note) out.note = p.note;
  if (p.kind && p.kind !== 'folded') out.kind = p.kind;
  return out;
}

/** The answer as an agent reads it: compacted results, pointers, and the
    {groups, folded, neighbors} summary the tool appends when collapse is on. */
export function agentView(results, { collapse = true } = {}) {
  const rows = (results || []).map((r, i) => {
    const md = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
    const row = { rank: i + 1, id: r.id, score: Math.round((Number(r.combined_score) || 0) * 10000) / 10000, useful_for: r.useful_for || '', content: r.content || '' };
    if (md.summary) row.summary = md.summary;
    const related = (r.related || []).map(compactPointer);
    if (related.length) row.related = related;
    if (r.related_truncated) row.related_truncated = Number(r.related_truncated);
    return row;
  });
  let summary = null;
  if (collapse) {
    const all = rows.flatMap((r) => r.related || []);
    const neighbors = all.filter((p) => p.kind === 'neighbor');
    const folded = all.length - neighbors.length + rows.reduce((s, r) => s + (r.related_truncated || 0), 0);
    summary = { groups: rows.filter((r) => (r.related || []).some((p) => p.kind !== 'neighbor')).length, folded, neighbors: neighbors.length };
  }
  return { results: rows, collapse: summary };
}

/** "clarifies → · neighbor · <text> — <note>" for a pointer row. */
export function pointerLine(p) {
  const arrow = p.direction === 'incoming' ? '←' : '→';
  const parts = [`${String(p.relation || 'connected').replace(/_/g, ' ')} ${arrow}`, p.kind === 'neighbor' ? 'neighbor' : 'folded'];
  if (p.via) parts.push(`via ${String(p.via).slice(0, 8)}`);
  let s = parts.join(' · ');
  if (p.text) s += ` · ${short(p.text, 120)}`;
  if (p.note) s += ` — ${short(p.note, 160)}`;
  return s;
}

function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

/** Cytoscape elements for a search answer.
    `connectionsById`: {resultId: EntryConnections} (GET /entries/{id}/edges per
    result) or {} when not fetched. With `context` on, every other connection
    of the results is drawn too (class `ctx`); off, only retrieved entries and
    the entries the pointers name. Pointer edges (the ones the agent is told
    about) carry class `pointer`; the rest `ctx`. */
export function searchGraph(results, connectionsById = {}, { context = false } = {}) {
  const nodes = new Map();
  const edges = new Map();
  const pointerPairs = new Set();
  const hits = results || [];
  hits.forEach((r, i) => {
    nodes.set(r.id, { data: { id: r.id, label: `#${i + 1} ${labelFor(r)}`, kind: 'hit', rank: i + 1, score: Number(r.combined_score) || 0, text: labelFor(r), full: r.useful_for || '' }, classes: 'hit' });
  });
  // Pointer targets (and `via` hops) named by the collapse.
  hits.forEach((r) => {
    (r.related || []).forEach((p) => {
      const kind = p.kind === 'neighbor' ? 'neighbor' : 'folded';
      if (!nodes.has(p.id)) nodes.set(p.id, { data: { id: p.id, label: labelFor(p), kind, relation: p.relation, text: labelFor(p), note: p.note || '' }, classes: `pointer ${kind}` });
      const from = p.via || r.id;
      if (p.via && !nodes.has(p.via)) nodes.set(p.via, { data: { id: p.via, label: String(p.via).slice(0, 8), kind: 'folded', text: '' }, classes: 'pointer folded' });
      pointerPairs.add(pairKey(from, p.id));
      const [s, t] = p.direction === 'incoming' ? [p.id, from] : [from, p.id];
      const key = `ptr:${s}:${t}:${p.relation}`;
      edges.set(key, { data: { id: key, source: s, target: t, relation: p.relation || 'connected', label: String(p.relation || 'connected').replace(/_/g, ' '), note: p.note || '', source_kind: 'pointer' }, classes: 'pointer' });
    });
  });
  // Real edges around the results.
  const realPairs = new Set();
  Object.entries(connectionsById || {}).forEach(([rid, conns]) => {
    if (!conns || !nodes.has(rid)) return;
    [...(conns.outgoing || []), ...(conns.incoming || [])].forEach((e) => {
      const other = e.other || {};
      if (other.kind === 'playbook_step' || (!e.to_entry_id && e.to_playbook_slug)) return; // entry-to-step edges are not drawn here
      const otherId = other.id || (e.from_entry_id === rid ? e.to_entry_id : e.from_entry_id);
      if (!otherId) return;
      const isPointer = pointerPairs.has(pairKey(rid, otherId));
      if (!nodes.has(otherId)) {
        if (!context && !isPointer) return;
        nodes.set(otherId, { data: { id: otherId, label: labelFor(other), kind: 'ctx', text: labelFor(other), relation: e.edge_type }, classes: 'ctx' });
      }
      realPairs.add(pairKey(e.from_entry_id, e.to_entry_id));
      const key = e.id || `edge:${e.from_entry_id}:${e.to_entry_id}:${e.edge_type}`;
      edges.set(key, { data: { id: key, source: e.from_entry_id, target: e.to_entry_id, relation: e.edge_type, label: String(e.edge_type || '').replace(/_/g, ' '), note: e.note || '', source_kind: e.source || 'author' }, classes: isPointer ? 'pointer real' : 'ctx' });
    });
  });
  // A synthetic pointer edge is redundant once the real edge for the pair is drawn.
  for (const [key, e] of [...edges]) {
    if (key.startsWith('ptr:') && realPairs.has(pairKey(e.data.source, e.data.target))) edges.delete(key);
  }
  const nodeList = [...nodes.values()];
  const edgeList = [...edges.values()].filter((e) => nodes.has(e.data.source) && nodes.has(e.data.target));
  return {
    nodes: nodeList,
    edges: edgeList,
    stats: {
      hits: hits.length,
      pointers: nodeList.filter((n) => n.data.kind === 'folded' || n.data.kind === 'neighbor').length,
      context: nodeList.filter((n) => n.data.kind === 'ctx').length,
      edges: edgeList.length,
      pointerEdges: edgeList.filter((e) => e.classes.includes('pointer')).length,
    },
  };
}

/** Union-find over edge endpoints: id -> component key (the smallest member id). */
export function componentsOf(nodeIds, edges) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  nodeIds.forEach((id) => parent.set(id, id));
  edges.forEach((e) => {
    const a = e.from_entry_id || e.source, b = e.to_entry_id || e.target;
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  });
  const out = new Map();
  nodeIds.forEach((id) => out.set(id, find(id)));
  return out;
}

/** n points evenly on a ring (first at 12 o'clock), rounded. */
export function ringPositions(n, r, cx = 0, cy = 0) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    pts.push({ x: Math.round((cx + r * Math.cos(a)) * 100) / 100, y: Math.round((cy + r * Math.sin(a)) * 100) / 100 });
  }
  return pts;
}

/** Node diameter from degree: 6px for a leaf, up to 16px for a hub. */
export function dotSize(degree) { return Math.min(DOT_MAX, DOT_MIN + 2 * Math.max(0, (degree || 1) - 1)); }

/** Lay one connected component out: the highest-degree node in the middle,
    the rest on concentric rings of growing capacity, never overlapping.
    `members` are [{id, degree}]. Returns {positions: {id: {x, y}}, r}. */
export function componentLayout(members) {
  const sorted = members.slice().sort((a, b) => (b.degree - a.degree) || String(a.id).localeCompare(String(b.id)));
  const positions = {};
  if (!sorted.length) return { positions, r: 0 };
  const gap = DOT_MAX + 14; // centre-to-centre spacing that keeps labels off each other
  if (sorted.length === 1) { positions[sorted[0].id] = { x: 0, y: 0 }; return { positions, r: gap }; }
  if (sorted.length === 2) { positions[sorted[0].id] = { x: -gap / 2, y: 0 }; positions[sorted[1].id] = { x: gap / 2, y: 0 }; return { positions, r: gap * 1.2 }; }
  positions[sorted[0].id] = { x: 0, y: 0 };
  let placed = 1;
  let ring = 1;
  let radius = 0;
  while (placed < sorted.length) {
    radius = ring * gap * 1.15;
    const capacity = Math.max(6, Math.floor((2 * Math.PI * radius) / gap));
    const take = Math.min(capacity, sorted.length - placed);
    ringPositions(take, radius).forEach((p, i) => { positions[sorted[placed + i].id] = p; });
    placed += take;
    ring += 1;
  }
  return { positions, r: radius + gap };
}

/** The whole bank as Cytoscape elements with preset positions: edges from
    GET /edges (all pages), nodes = their endpoints. Components are laid out
    with componentLayout and packed on a spiral with the Map's packCircles so
    no two constellations touch. `ends` (optional {id: {summary|useful_for}})
    labels the nodes it knows. */
export function bankGraph(edges, { maxEdges = MAX_BANK_EDGES, ends = {} } = {}) {
  const entryEdges = (edges || []).filter((e) => e && e.from_entry_id && e.to_entry_id);
  const stepEdges = (edges || []).length - entryEdges.length;
  const truncated = entryEdges.length > maxEdges;
  const used = truncated ? entryEdges.slice(0, maxEdges) : entryEdges;
  const degree = new Map();
  used.forEach((e) => { degree.set(e.from_entry_id, (degree.get(e.from_entry_id) || 0) + 1); degree.set(e.to_entry_id, (degree.get(e.to_entry_id) || 0) + 1); });
  const ids = [...degree.keys()].sort();
  const comp = componentsOf(ids, used);
  const groups = new Map();
  ids.forEach((id) => { const k = comp.get(id); if (!groups.has(k)) groups.set(k, []); groups.get(k).push({ id, degree: degree.get(id) || 0 }); });
  const circles = [];
  const layouts = new Map();
  groups.forEach((members, key) => { const l = componentLayout(members); layouts.set(key, l); circles.push({ key, r: l.r }); });
  packCircles(circles);
  const centre = new Map(circles.map((c) => [c.key, c]));
  const nodes = ids.map((id) => {
    const key = comp.get(id); const c = centre.get(key); const p = layouts.get(key).positions[id];
    const end = ends[id];
    return { data: { id, kind: 'bank', component: key, degree: degree.get(id) || 0, d: dotSize(degree.get(id)), label: end ? labelFor(end) : '', text: end ? labelFor(end) : '' }, position: { x: c.x + p.x, y: c.y + p.y }, classes: 'bank' };
  });
  const edgeEls = used.map((e) => ({ data: { id: e.id, source: e.from_entry_id, target: e.to_entry_id, relation: e.edge_type, label: '', note: e.note || '', source_kind: e.source || 'author' }, classes: 'bank' }));
  const sizes = [...groups.values()].map((m) => m.length);
  return {
    nodes,
    edges: edgeEls,
    stats: { nodes: nodes.length, edges: edgeEls.length, components: groups.size, largest: sizes.length ? Math.max(...sizes) : 0, truncated, stepEdges },
  };
}

/** How a search answer is painted ONTO the whole-bank picture (the default
    search view): entries already drawn get a class and, for hits, a rank
    label; retrieved or pointed-at entries the bank picture does not contain
    (no edges yet) are added in rows under the constellations; the answer's
    edges that both ends can show are listed; `litIds` is what the camera
    should fit. `bankIds` is the set of node ids on the canvas, `bbox` the
    canvas's model bounding box {x1, y1, x2, y2}. Deterministic. */
export function overlayPlan(answer, bankIds, bbox) {
  const ids = bankIds instanceof Set ? bankIds : new Set(bankIds || []);
  const mark = [];
  const added = [];
  const orphans = [];
  (answer.nodes || []).forEach((n) => {
    const kind = n.data.kind === 'hit' ? 'hit' : n.data.kind; // hit | folded | neighbor | ctx
    if (ids.has(n.data.id)) mark.push({ id: n.data.id, kind, label: n.data.label, text: n.data.text || '', rank: n.data.rank || 0 });
    else orphans.push(n);
  });
  const box = bbox || { x1: 0, y1: 0, x2: 0, y2: 0 };
  const perRow = Math.max(1, Math.floor(Math.max(box.x2 - box.x1, 180) / 180));
  orphans.sort((a, b) => (a.data.rank || 99) - (b.data.rank || 99) || String(a.data.id).localeCompare(String(b.data.id)));
  orphans.forEach((n, i) => {
    const row = Math.floor(i / perRow), col = i % perRow;
    added.push({ data: { ...n.data, d: n.data.kind === 'hit' ? 22 : 14, orphan: true }, position: { x: box.x1 + col * 180 + 90, y: box.y2 + 110 + row * 80 }, classes: `bank ${n.data.kind === 'hit' ? 'hit' : n.data.kind}` });
  });
  const present = new Set([...ids, ...added.map((a) => a.data.id)]);
  const edges = (answer.edges || []).filter((e) => present.has(e.data.source) && present.has(e.data.target));
  const litIds = [...mark.map((m) => m.id), ...added.map((a) => a.data.id)];
  return { mark, added, edges, litIds, orphanCount: orphans.length };
}

export const FOCUS_MODES = ['shrink', 'only', 'dim'];
export const LAYOUT_MODES = ['force', 'content', 'useful_for', 'both'];

/** Normalise the two picture knobs (defaults: shrink the rest, force layout). */
export function pictureOptions(o = {}) {
  return {
    focus: FOCUS_MODES.includes(o.focus) ? o.focus : 'shrink',
    layout: LAYOUT_MODES.includes(o.layout) ? o.layout : 'force',
    hideBackfill: o.hideBackfill === undefined ? true : Boolean(o.hideBackfill),
  };
}

/** The 3D scene for the Graph tab: the bank's entry-to-entry edges (optionally
    without the note-less backfill_metadata siblings) with the answer painted
    on. Every node carries `kind` (hit | folded | neighbor | ctx | bank), `lit`,
    `rank`, `val` (sphere volume) and the colour role; every link `lit` and
    `relation`. `focus`: 'dim' keeps everything, 'shrink' makes unlit nodes
    dust and drops unlit links, 'only' removes them. Retrieved or pointed-at
    entries the bank has no edges for are added so the answer is complete. */
export function scene(bankEdges, answer, { focus = 'shrink', hideBackfill = true } = {}) {
  const edges = (bankEdges || []).filter((e) => e && e.from_entry_id && e.to_entry_id && !(hideBackfill && e.source === 'backfill_metadata'));
  const degree = new Map();
  edges.forEach((e) => { degree.set(e.from_entry_id, (degree.get(e.from_entry_id) || 0) + 1); degree.set(e.to_entry_id, (degree.get(e.to_entry_id) || 0) + 1); });
  const nodes = new Map();
  [...degree.keys()].sort().forEach((id) => nodes.set(id, { id, kind: 'bank', lit: false, rank: 0, degree: degree.get(id) || 0, label: '', text: '' }));
  const links = edges.map((e) => ({ id: e.id, source: e.from_entry_id, target: e.to_entry_id, relation: e.edge_type, source_kind: e.source || 'author', note: e.note || '', lit: false }));
  const litIds = new Set();
  if (answer) {
    (answer.nodes || []).forEach((n) => {
      const kind = n.data.kind === 'hit' ? 'hit' : n.data.kind;
      const cur = nodes.get(n.data.id) || { id: n.data.id, degree: 0 };
      nodes.set(n.data.id, { ...cur, kind, lit: kind !== 'ctx', rank: n.data.rank || 0, label: n.data.label || '', text: n.data.text || '', note: n.data.note || '', added: !degree.has(n.data.id) });
      if (kind !== 'ctx') litIds.add(n.data.id);
    });
    const have = new Set(links.map((l) => l.id));
    (answer.edges || []).forEach((e) => {
      if (!nodes.has(e.data.source) || !nodes.has(e.data.target)) return;
      const existing = links.find((l) => l.id === e.data.id) || links.find((l) => (l.source === e.data.source && l.target === e.data.target) || (l.source === e.data.target && l.target === e.data.source));
      if (existing) { existing.lit = litIds.has(existing.source) && litIds.has(existing.target); existing.pointer = e.classes.includes('pointer'); return; }
      if (have.has(e.data.id)) return;
      have.add(e.data.id);
      links.push({ id: e.data.id, source: e.data.source, target: e.data.target, relation: e.data.relation, source_kind: e.data.source_kind || 'pointer', note: e.data.note || '', lit: litIds.has(e.data.source) && litIds.has(e.data.target), pointer: e.classes.includes('pointer') });
    });
    links.forEach((l) => { if (litIds.has(l.source) && litIds.has(l.target)) l.lit = true; });
  }
  let nodeList = [...nodes.values()];
  let linkList = links;
  if (answer && focus === 'only') {
    nodeList = nodeList.filter((n) => n.lit);
    const keep = new Set(nodeList.map((n) => n.id));
    linkList = links.filter((l) => keep.has(l.source) && keep.has(l.target));
  } else if (answer && focus === 'shrink') {
    linkList = links.filter((l) => l.lit);
  }
  nodeList.forEach((n) => {
    const base = 1 + Math.sqrt(n.degree || 0);
    n.val = answer && !n.lit ? (focus === 'shrink' ? 0.15 : Math.max(0.4, base * 0.5)) : (n.kind === 'hit' ? base * 2.6 + 4 : n.lit ? base * 1.6 + 2 : base);
  });
  return {
    nodes: nodeList,
    links: linkList,
    stats: { nodes: nodeList.length, links: linkList.length, lit: litIds.size, hits: nodeList.filter((n) => n.kind === 'hit').length, added: nodeList.filter((n) => n.added).length, hiddenBackfill: (bankEdges || []).filter((e) => e && e.source === 'backfill_metadata').length },
  };
}

/** Pin nodes to semantic positions (the service's GET /graph/layout
    `positions`, each in [-1, 1]) scaled by `scale`; nodes without a position
    sit beside the centroid of the lit ones (or the origin). Returns how many
    were pinned and how many had no position. Clears pins when `positions`
    is null (force layout). */
export function pinPositions(nodes, positions, scale = 420) {
  if (!positions) { nodes.forEach((n) => { delete n.fx; delete n.fy; delete n.fz; }); return { pinned: 0, missing: 0 }; }
  const placed = [];
  const missing = [];
  nodes.forEach((n) => {
    const p = positions[n.id];
    if (p && p.length >= 3) { n.fx = p[0] * scale; n.fy = p[1] * scale; n.fz = p[2] * scale; n.x = n.fx; n.y = n.fy; n.z = n.fz; if (n.lit) placed.push(n); }
    else missing.push(n);
  });
  const c = placed.length ? { x: placed.reduce((a, n) => a + n.fx, 0) / placed.length, y: placed.reduce((a, n) => a + n.fy, 0) / placed.length, z: placed.reduce((a, n) => a + n.fz, 0) / placed.length } : { x: 0, y: 0, z: 0 };
  missing.forEach((n, i) => { const a = i * 2.4; n.fx = c.x + 28 * Math.cos(a); n.fy = c.y + 28 * Math.sin(a); n.fz = c.z + (i % 2 ? 18 : -18); n.x = n.fx; n.y = n.fy; n.z = n.fz; });
  return { pinned: placed.length + (nodes.length - missing.length - placed.length), missing: missing.length };
}

/** What the layout chip says for a GET /graph/layout body. */
export function layoutCaption(body) {
  if (!body) return 'layout: force';
  const names = { umap: 'UMAP', tsne: 't-SNE', pca: 'PCA' };
  if (body.status === 'ready') {
    const m = body.run && names[body.run.method] ? names[body.run.method] : 'projection';
    return `semantic (${m} of ${body.space} embeddings, ${body.run ? body.run.entry_count : 0} entries${body.stale ? ', refreshing' : ''})`;
  }
  if (body.status === 'computing') return 'semantic layout: computing…';
  if (body.status === 'empty') return 'semantic layout: no connections yet';
  if (body.status === 'failed') return `semantic layout failed: ${body.reason || 'see run'}`;
  return `semantic layout unavailable${body.reason ? `: ${body.reason}` : ''}`;
}

/** Pages for GET /edges: the service caps limit at 500 (MAX_LIST_LIMIT). */
export function edgePages(total, pageSize = 500) {
  const n = Math.max(0, Math.ceil((Number(total) || 0) / pageSize));
  return Array.from({ length: n }, (_, i) => ({ limit: pageSize, offset: i * pageSize }));
}

/** Per-bank localStorage key for the tab's knobs. */
export function settingsKey(kbId) { return `kbx-graph:${kbId}`; }
