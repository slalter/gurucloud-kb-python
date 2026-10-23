/* Ask tab — pure logic (no DOM, no WebGL, no fetch).

   A person asks the bank a question; a small model works it step by step
   over POST /ask/step (kb_service/ask_agent.py). Each step the service
   returns what the model said ("thinking") and which tools it wants run;
   THIS side runs them against the Explorer API, shapes the results the way
   the tool descriptions promise (the same shapes the Python SDK's
   gurucloud_kb/_ask.py builds), posts them back, and paints everything the
   model has touched onto the Graph tab's 3D scene:

     hit       an entry a search returned (#rank of its search)
     folded    a pointer: an entry folded into a result
     neighbor  a pointer or connection one hop off something the model saw
     read      an entry the model read in full (its connections light up too)
     walk      an entry reached by walking the graph
     cited     an entry the final answer cites

   A trail is the whole run as data: the question, every step with its
   thinking, tool calls and their outputs, the answer and its citations. It
   is rebuilt from the service's audit record (GET /ask/runs/{id}) exactly
   the same way, so a past run replays like a live one.

   Exported for ask.js (the renderer) and the Node suite
   tests/test_kb_explorer_ask_model.js. */

import { agentView, labelFor, searchPayload } from './graph_model.js';

export const TOOLS = Object.freeze({ search: 'search_knowledge_bank', read: 'read_entry', walk: 'walk_graph' });
export const KINDS = ['cited', 'read', 'hit', 'walk', 'folded', 'neighbor'];
const KIND_RANK = Object.fromEntries(KINDS.map((k, i) => [k, i]));
export const REASONING = ['none', 'low', 'medium'];
export const FOCUS_MODES = ['shrink', 'only', 'dim'];
export const DEFAULTS = Object.freeze({ reasoning: 'low', maxSteps: 8, autoRun: true, focus: 'shrink', hideBackfill: true, k: 8, maxNeighbors: 3 });
export const WALK_NODE_LIMIT = 80;
export const MAX_WALK_DEPTH = 3;
const CONTENT_MAX = 6000;
export const SEARCH_CONTENT_MAX = 800; // per search row: k=10 must fit the service's search cap (read_entry has the full text)

function short(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
function num(v, d, lo, hi) { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d; }

/** Per-bank localStorage key for the tab's knobs. */
export function settingsKey(kbId) { return `kbx-ask:${kbId}`; }

/** Clamp the tab's knobs; `config` (GET /ask/config) bounds the model and max steps. */
export function normalizeAskOptions(o = {}, config = null) {
  const models = config && Array.isArray(config.models) && config.models.length ? config.models : null;
  const model = models ? (models.includes(o.model) ? o.model : (config.default_model || models[0])) : (o.model || null);
  const maxMax = config && Number.isFinite(Number(config.max_steps_max)) ? Number(config.max_steps_max) : 12;
  const maxDefault = config && Number.isFinite(Number(config.max_steps_default)) ? Number(config.max_steps_default) : DEFAULTS.maxSteps;
  const efforts = config && Array.isArray(config.reasoning_efforts) && config.reasoning_efforts.length ? config.reasoning_efforts : REASONING;
  return {
    model,
    reasoning: efforts.includes(o.reasoning) ? o.reasoning : (config && efforts.includes(config.default_reasoning_effort) ? config.default_reasoning_effort : DEFAULTS.reasoning),
    maxSteps: num(o.maxSteps, maxDefault, 1, maxMax),
    autoRun: o.autoRun === undefined ? DEFAULTS.autoRun : Boolean(o.autoRun),
    focus: FOCUS_MODES.includes(o.focus) ? o.focus : DEFAULTS.focus,
    hideBackfill: o.hideBackfill === undefined ? DEFAULTS.hideBackfill : Boolean(o.hideBackfill),
  };
}

// ── request bodies ──────────────────────────────────────────────────────────

/** POST /ask/step body for the first turn. */
export function startBody({ question, model, reasoning, maxSteps }) {
  const q = String(question || '').trim();
  if (!q) throw new Error('Ask a question first');
  const body = { question: q };
  if (model) body.model = model;
  if (REASONING.includes(reasoning)) body.reasoning_effort = reasoning;
  if (Number.isFinite(Number(maxSteps))) body.max_steps = num(maxSteps, DEFAULTS.maxSteps, 1, 12);
  return body;
}

/** POST /ask/step body for every later turn: the previous turn's tool outputs. */
export function continueBody({ runId, responseId, outputs }) {
  if (!runId || !responseId) throw new Error('No run to continue');
  return { run_id: runId, previous_response_id: responseId, tool_outputs: outputs || [] };
}

/** One entry of `tool_outputs`. */
export function toolOutputItem(call, output, { error = null, durationMs = null } = {}) {
  const item = { call_id: call.call_id, name: call.name, output: error ? null : output };
  if (error) item.error = String(error).slice(0, 2000);
  if (durationMs !== null && durationMs !== undefined) item.duration_ms = Math.round(durationMs);
  return item;
}

// ── tool arguments -> Explorer API requests ─────────────────────────────────

/** POST /search body for a search_knowledge_bank call (collapse on, the bank's primary dimension). */
export function searchRequest(args, schema) {
  const query = String((args || {}).query || '').trim();
  if (!query) throw new Error('search_knowledge_bank needs a query');
  return searchPayload({ schema, query, k: num((args || {}).k, DEFAULTS.k, 1, 20), collapse: true, maxNeighbors: DEFAULTS.maxNeighbors, threshold: 0 });
}

/** The entry id of a read_entry call (full id or prefix, 4+ chars). */
export function readRequest(args) {
  const id = String((args || {}).entry_id || (args || {}).id || '').trim();
  if (id.length < 4) throw new Error('read_entry needs an entry id (4+ characters)');
  return { entryId: id };
}

/** GET /graph params for a walk_graph call. */
export function walkRequest(args) {
  const root = String((args || {}).root || '').trim();
  if (root.length < 4) throw new Error('walk_graph needs a root entry id (4+ characters)');
  return { root, depth: num((args || {}).depth, 1, 1, MAX_WALK_DEPTH), limit: WALK_NODE_LIMIT };
}

// ── API responses -> what the model reads ───────────────────────────────────

/** search_knowledge_bank output: the ranked rows with compact pointers and the collapse summary. */
export function searchOutput(data) {
  const results = Array.isArray(data) ? data : ((data && (data.results || data.entries)) || []);
  const view = agentView(results.map((r) => ({ ...r, content: short(r.content, SEARCH_CONTENT_MAX) })), { collapse: true });
  return { results: view.results, collapse: view.collapse };
}

function connectionRow(e, direction) {
  const other = e.other || {};
  const row = { id: other.id || (direction === 'outgoing' ? e.to_entry_id : e.from_entry_id), relation: e.edge_type || 'connected', direction, text: labelFor(other) };
  if (e.note) row.note = e.note;
  if (other.kind === 'playbook_step') { row.kind = 'playbook_step'; row.playbook = other.playbook_slug; row.step = other.step_key; }
  return row;
}

/** read_entry output: the entry in full plus its typed connections (other end's text, the note). */
export function entryOutput(entry, connections) {
  const md = entry && entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {};
  const meta = {};
  Object.entries(md).forEach(([k, v]) => { if (['string', 'number', 'boolean'].includes(typeof v) || (Array.isArray(v) && v.length <= 20)) meta[k] = v; });
  const conns = [];
  ['outgoing', 'incoming'].forEach((dir) => ((connections && connections[dir]) || []).forEach((e) => conns.push(connectionRow(e, dir))));
  return {
    id: entry.id, content: short(entry.content, CONTENT_MAX), useful_for: entry.useful_for || '', summary: md.summary || '',
    relevant_systems: entry.relevant_systems || [], relevant_tasks: entry.relevant_tasks || [], metadata: meta, created_at: entry.created_at || null,
    connections: conns,
  };
}

/** walk_graph output: nodes with depth and text, edges with relation and note. */
export function walkOutput(graph) {
  const nodes = ((graph && graph.nodes) || []).map((n) => {
    const node = { id: n.id, depth: n.depth || 0, text: labelFor(n) };
    if (n.kind === 'playbook_step') { node.kind = 'playbook_step'; node.text = `step ${n.playbook_slug}/${n.step_key}`; }
    return node;
  });
  const edges = ((graph && graph.edges) || []).map((e) => {
    const edge = { from: e.from_entry_id, to: e.to_entry_id || e.to_step_key, relation: e.edge_type };
    if (e.note) edge.note = e.note;
    return edge;
  });
  return { root: graph && graph.root, depth: graph && graph.depth, truncated: Boolean(graph && graph.truncated), nodes, edges };
}

/** "search “rush order quote” · k=5" / "read 8d04f97e" / "walk 2 hops from 1c4aaa2c". */
export function stepLabel(call) {
  const a = (call && call.arguments) || {};
  if (call.name === TOOLS.search) return `search “${short(a.query, 80)}”${a.k ? ` · k=${a.k}` : ''}`;
  if (call.name === TOOLS.read) return `read ${String(a.entry_id || a.id || '?').slice(0, 8)}`;
  if (call.name === TOOLS.walk) return `walk ${a.depth && Number(a.depth) > 1 ? `${a.depth} hops` : '1 hop'} from ${String(a.root || '?').slice(0, 8)}`;
  return `${call.name || 'tool'}(${short(JSON.stringify(a), 60)})`;
}

// ── the trail ───────────────────────────────────────────────────────────────

/** A fresh trail for a question. */
export function emptyTrail(question) {
  return { question: String(question || '').trim(), runId: null, status: 'idle', steps: [], answer: null, citations: [], usage: null, model: null, error: null };
}

/** Fold one POST /ask/step response into the trail (new object). */
export function addStep(trail, resp) {
  const step = {
    no: resp.step, status: resp.status, responseId: resp.response_id || null, thinking: resp.thinking || [],
    calls: (resp.tool_calls || []).map((c) => ({ call: c, state: 'pending', output: null, error: null, durationMs: null })),
    answer: resp.answer || null, citations: resp.citations || [], usage: resp.usage || null, durationMs: resp.duration_ms || 0, error: resp.error || null,
  };
  return {
    ...trail, runId: resp.run_id || trail.runId, model: resp.model || trail.model, status: resp.run_status || trail.status,
    steps: [...trail.steps.filter((s) => s.no !== step.no), step].sort((a, b) => a.no - b.no),
    answer: resp.answer || trail.answer, citations: resp.citations && resp.citations.length ? resp.citations : trail.citations,
    usage: resp.run_usage || trail.usage, error: resp.error || null,
  };
}

/**
 * A failed POST /ask/step as the person reads it: the status the service
 * answered (when the message does not already carry it) and the upstream
 * body snippet the platform kept for a non-JSON error page, for a Details toggle.
 */
export function stepFailure(err) {
  const message = String((err && err.message) || err || 'unknown error');
  const status = err && Number.isInteger(err.status) && err.status > 0 ? err.status : null;
  const details = err && err.details && typeof err.details === 'object' ? err.details : null;
  const detail = details && typeof details.body === 'string' && details.body.trim() ? details.body.trim() : null;
  return { message: status && !message.includes(String(status)) ? `KB service returned ${status}: ${message}` : message, detail };
}

/** Record a tool call's outcome on its step (new object). `state`: running | done | error. */
export function setCallResult(trail, stepNo, callId, { state, output = null, error = null, durationMs = null }) {
  return {
    ...trail,
    steps: trail.steps.map((s) => (s.no !== stepNo ? s : {
      ...s, calls: s.calls.map((c) => (c.call.call_id !== callId ? c : { ...c, state, output: output === null ? c.output : output, error, durationMs: durationMs === null ? c.durationMs : durationMs })),
    })),
  };
}

/** The tool_outputs for a step, in call order (only when every call has settled). */
export function outputsOf(step) {
  if (!step || step.calls.some((c) => c.state === 'pending' || c.state === 'running')) return null;
  return step.calls.map((c) => toolOutputItem(c.call, c.output, { error: c.error, durationMs: c.durationMs }));
}

/** The latest step, and whether the run is waiting for the browser to continue it. */
export function pendingStep(trail) {
  const last = trail.steps[trail.steps.length - 1];
  if (!last || last.status !== 'tool_calls' || trail.status !== 'running') return null;
  return outputsOf(last) ? last : null;
}

function paintNode(nodes, id, kind, extra = {}) {
  if (!id) return;
  const cur = nodes.get(id);
  const roles = new Set(cur ? cur.roles : []);
  roles.add(kind);
  if (!cur || KIND_RANK[kind] < KIND_RANK[cur.kind]) nodes.set(id, { ...(cur || {}), ...extra, id, kind, roles, text: extra.text || (cur && cur.text) || '', note: extra.note || (cur && cur.note) || '', rank: kind === 'hit' ? (extra.rank || 0) : (cur && cur.kind === 'hit' ? cur.rank : (cur && cur.rank) || 0), step: Math.min(extra.step || Infinity, cur && cur.step ? cur.step : Infinity) });
  else { cur.roles = roles; if (extra.text && !cur.text) cur.text = extra.text; if (extra.note && !cur.note) cur.note = extra.note; }
}

function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

/** Everything the model touched up to `uptoStep` (default: all), in the
    `answer` shape graph_model.scene() paints: nodes {data:{id, kind, rank,
    label, text, note, step}}, edges {data:{id, source, target, relation, note,
    source_kind}, classes}. Citations only count once the answer step is
    included. `ends` maps id -> the best text seen for it. */
export function trailPicture(trail, { uptoStep = Infinity } = {}) {
  const nodes = new Map();
  const edges = new Map();
  const steps = trail.steps.filter((s) => s.no <= uptoStep);
  const addEdge = (s, t, relation, note, classes, stepNo) => {
    if (!s || !t || s === t) return;
    const key = `ask:${pairKey(s, t)}:${relation || 'connected'}`;
    if (!edges.has(key)) edges.set(key, { data: { id: key, source: s, target: t, relation: relation || 'connected', label: String(relation || 'connected').replace(/_/g, ' '), note: note || '', source_kind: 'ask', step: stepNo }, classes });
  };
  steps.forEach((step) => {
    step.calls.forEach((c) => {
      const out = c.output;
      if (!out || c.state !== 'done') return;
      if (c.call.name === TOOLS.search) {
        (out.results || []).forEach((r) => {
          paintNode(nodes, r.id, 'hit', { rank: r.rank, text: r.summary || r.useful_for || short(r.content, 120), step: step.no });
          (r.related || []).forEach((p) => {
            const kind = p.kind === 'neighbor' ? 'neighbor' : 'folded';
            paintNode(nodes, p.id, kind, { text: p.text || '', note: p.note || '', step: step.no });
            const from = p.via || r.id;
            const [s, t] = p.direction === 'incoming' ? [p.id, from] : [from, p.id];
            addEdge(s, t, p.relation, p.note, 'pointer', step.no);
          });
        });
      } else if (c.call.name === TOOLS.read) {
        paintNode(nodes, out.id, 'read', { text: out.summary || out.useful_for || short(out.content, 120), step: step.no });
        (out.connections || []).forEach((k) => {
          if (k.kind === 'playbook_step') return;
          paintNode(nodes, k.id, 'neighbor', { text: k.text || '', note: k.note || '', step: step.no });
          const [s, t] = k.direction === 'incoming' ? [k.id, out.id] : [out.id, k.id];
          addEdge(s, t, k.relation, k.note, 'pointer real', step.no);
        });
      } else if (c.call.name === TOOLS.walk) {
        (out.nodes || []).forEach((n) => { if (n.kind !== 'playbook_step') paintNode(nodes, n.id, n.depth === 0 ? 'read' : 'walk', { text: n.text || '', step: step.no }); });
        (out.edges || []).forEach((e) => addEdge(e.from, e.to, e.relation, e.note, 'walk', step.no));
      }
    });
  });
  const answerStep = steps.find((s) => s.status === 'answered' || s.status === 'step_limit');
  const cited = answerStep ? (trail.citations || []) : [];
  cited.forEach((id) => paintNode(nodes, id, 'cited', { step: answerStep.no }));
  const nodeList = [...nodes.values()].map((n) => ({ data: { id: n.id, kind: n.kind, rank: n.rank || 0, label: n.kind === 'hit' && n.rank ? `#${n.rank} ${n.text}` : n.text, text: n.text, note: n.note, step: n.step === Infinity ? 0 : n.step } }));
  const edgeList = [...edges.values()].filter((e) => nodes.has(e.data.source) && nodes.has(e.data.target));
  const ends = {};
  nodes.forEach((n) => { if (n.text) ends[n.id] = { id: n.id, summary: n.text }; });
  // counts are by ROLE, not by the colour that won: an entry that was searched,
  // then read, then cited counts once under each, so the caption describes the trail.
  const counts = {};
  nodes.forEach((n) => n.roles.forEach((r) => { counts[r] = (counts[r] || 0) + 1; }));
  return { nodes: nodeList, edges: edgeList, ends, cited, stats: { nodes: nodeList.length, edges: edgeList.length, counts } };
}

/** Split an answer into text and citation segments: `[8-char prefix]`, bare
    8+-hex prefixes and full UUIDs that resolve to one of `citations` (or one
    of `known` ids) become {cite: id, label}. */
export function citationSegments(answer, citations = [], known = []) {
  const text = String(answer || '');
  if (!text) return [];
  const ids = [...new Set([...(citations || []), ...(known || [])])];
  const re = /\[([0-9a-f][0-9a-f-]{7,35})\]|\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b|\b([0-9a-f]{8,32})\b/gi;
  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const token = (m[1] || m[2] || m[3] || '').toLowerCase();
    const bare = Boolean(m[3]) && !m[1];
    if (bare && !/\d/.test(token)) continue; // "deadbeef" as a word
    const hits = ids.filter((id) => String(id).toLowerCase().startsWith(token));
    const id = hits.length === 1 ? hits[0] : (m[2] ? m[2] : null);
    if (!id) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ cite: id, label: String(id).slice(0, 8) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** "Step 2 · read 8d04f97e · 1.2 s" */
export function stepCaption(step) {
  const parts = [`Step ${step.no}`];
  if (step.calls.length) parts.push(step.calls.map((c) => stepLabel(c.call)).join(' + '));
  else if (step.status === 'answered') parts.push('answer');
  else if (step.status === 'step_limit') parts.push('answer (step limit)');
  else if (step.status === 'failed') parts.push('failed');
  if (step.durationMs) parts.push(`${(step.durationMs / 1000).toFixed(1)} s`);
  return parts.join(' · ');
}

/** "3 searches · 2 entries read · 1 walk · 1,234 in / 456 out tokens" */
export function trailSummary(trail) {
  const counts = { [TOOLS.search]: 0, [TOOLS.read]: 0, [TOOLS.walk]: 0 };
  trail.steps.forEach((s) => s.calls.forEach((c) => { if (c.call.name in counts) counts[c.call.name] += 1; }));
  const parts = [];
  if (counts[TOOLS.search]) parts.push(`${counts[TOOLS.search]} search${counts[TOOLS.search] === 1 ? '' : 'es'}`);
  if (counts[TOOLS.read]) parts.push(`${counts[TOOLS.read]} ${counts[TOOLS.read] === 1 ? 'entry' : 'entries'} read`);
  if (counts[TOOLS.walk]) parts.push(`${counts[TOOLS.walk]} walk${counts[TOOLS.walk] === 1 ? '' : 's'}`);
  if (trail.usage && (trail.usage.input_tokens || trail.usage.output_tokens)) parts.push(`${Number(trail.usage.input_tokens || 0).toLocaleString()} in / ${Number(trail.usage.output_tokens || 0).toLocaleString()} out tokens`);
  return parts.join(' · ');
}

function parseOutput(text) {
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text.replace(/\n\[truncated: \d+ more characters\]$/, '')); } catch { return { raw: text }; }
}

/** Rebuild a trail from the service's audit record (GET /ask/runs/{id}): each
    step's thinking and tool calls, and the outputs the browser posted, which
    the record keeps on the NEXT step's request: `tool_outputs` whole, `input`
    as the model saw them (capped; runs recorded before the split have only that). */
export function trailFromRunDetail(detail) {
  const run = detail.run || {};
  let trail = { ...emptyTrail(run.question), runId: run.id, status: run.status, model: run.model, usage: run.usage || null, answer: run.answer || null, citations: run.citations || [], error: run.error || null };
  const steps = (detail.steps || []).slice().sort((a, b) => a.step_no - b.step_no);
  steps.forEach((rec) => {
    trail = addStep(trail, { step: rec.step_no, status: rec.status, response_id: rec.response_id, thinking: rec.thinking || [], tool_calls: rec.tool_calls || [],
      answer: rec.status === 'answered' || rec.status === 'step_limit' ? run.answer : null, citations: rec.status === 'answered' || rec.status === 'step_limit' ? run.citations : [],
      usage: rec.usage || null, duration_ms: rec.duration_ms || 0, error: rec.error || null, run_id: run.id, run_status: run.status, model: run.model, run_usage: run.usage || null });
  });
  steps.forEach((rec, i) => {
    const next = steps[i + 1];
    const req = (next && next.request) || {};
    const posted = Array.isArray(req.tool_outputs) ? req.tool_outputs : [];
    const items = Array.isArray(req.input) ? req.input.filter((it) => it && it.type === 'function_call_output') : [];
    (rec.tool_calls || []).forEach((call) => {
      const full = posted.find((it) => it && it.call_id === call.call_id);
      const item = items.find((it) => it.call_id === call.call_id);
      if (!full && !item) { trail = setCallResult(trail, rec.step_no, call.call_id, { state: trail.status === 'running' ? 'pending' : 'error', error: trail.status === 'running' ? null : 'no output recorded' }); return; }
      // The posted output is whole; the input item is what the model saw, possibly cut (older runs only have that).
      const out = full ? (full.error ? { error: full.error } : parseOutput(full.output)) : parseOutput(item.output);
      const err = out && typeof out === 'object' && !Array.isArray(out) && Object.keys(out).length === 1 && 'error' in out ? String(out.error) : null;
      trail = setCallResult(trail, rec.step_no, call.call_id, err ? { state: 'error', error: err } : { state: 'done', output: out });
    });
  });
  return trail;
}
