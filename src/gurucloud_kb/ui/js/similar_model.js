/* Similar-pairs view model — pure helpers for the Explorer's Similar tab.

   The tab shows the bank's most similar entry pairs (POST /similar-pairs) and
   lets a person ask a model what each pair is (POST /similar-pairs/judge).
   Everything that is not DOM lives here so Node can test it
   (tests/test_kb_explorer_similar_model.js). */

export const DEFAULTS = { threshold: 0.88, neighbors: 3, limit: 100, maxEntries: 2000 };
export const SCAN_SIZES = [500, 2000, 5000, 20000];
export const MAX_JUDGE_BATCH = 25;
export const DEFAULT_JUDGE_BATCH = 5;

const STORE_PREFIX = 'kbx-similar:';

/** localStorage key for the per-bank settings. */
export function settingsKey(kbId) { return STORE_PREFIX + String(kbId || ''); }

/** Saved settings merged over the defaults; storage failures give the defaults. */
export function readSettings(storage, kbId) {
  try {
    const raw = storage != null ? storage.getItem(settingsKey(kbId)) : null;
    const saved = raw ? JSON.parse(raw) : {};
    const out = { ...DEFAULTS };
    if (Number.isFinite(saved.threshold) && saved.threshold >= 0 && saved.threshold <= 1) out.threshold = saved.threshold;
    if (SCAN_SIZES.includes(saved.maxEntries)) out.maxEntries = saved.maxEntries;
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSettings(storage, kbId, settings) {
  try {
    if (storage == null) return;
    storage.setItem(settingsKey(kbId), JSON.stringify({ threshold: settings.threshold, maxEntries: settings.maxEntries }));
  } catch { /* per-viewer convenience only */ }
}

/** Body for POST /similar-pairs. */
export function buildPairsRequest({ threshold, maxEntries, field, scope }) {
  const body = {
    threshold: Number.isFinite(threshold) ? Math.max(0, Math.min(1, threshold)) : DEFAULTS.threshold,
    neighbors: DEFAULTS.neighbors,
    limit: DEFAULTS.limit,
    max_entries: SCAN_SIZES.includes(maxEntries) ? maxEntries : DEFAULTS.maxEntries,
  };
  if (field) body.field = field;
  if (scope && Object.keys(scope).length) body.scope = scope;
  return body;
}

/** A stable key for a pair, independent of a/b order. */
export function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

/** Body for POST /similar-pairs/judge over the given pairs (capped). */
export function buildJudgeRequest(pairs, { speed, context, propose } = {}) {
  const refs = (pairs || []).slice(0, MAX_JUDGE_BATCH).map((p) => ({ a_id: p.a.id, b_id: p.b.id }));
  if (!refs.length) return null;
  const body = { pairs: refs };
  if (speed === 'fast' || speed === 'thorough') body.speed = speed;
  if (context && String(context).trim()) body.context = String(context).trim();
  if (propose === false) body.propose = false;
  return body;
}

export const KIND_LABEL = {
  merge: 'Merge into one', keep_separate: 'Keep separate', trim_overlap: 'Remove the overlap',
  cross_reference: 'Cross-reference', delete_one: 'Delete the subset', review_conflict: 'Review the conflict',
};
export const KIND_TONE = { merge: 'danger', delete_one: 'danger', trim_overlap: 'warn', review_conflict: 'warn', cross_reference: 'info', keep_separate: 'muted' };

/** Whether a proposal changes anything (and so can be applied). */
export function proposalIsActionable(proposal) {
  return !!proposal && Array.isArray(proposal.changes) && proposal.changes.some((c) => c && c.action && c.action !== 'none');
}

/** Body for POST /similar-pairs/apply from a judged pair. */
export function buildApplyRequest(pair, judgementId, { reason } = {}) {
  const j = pair && pair.judgement;
  if (!j || !judgementId || !proposalIsActionable(j.proposal)) return null;
  const body = {
    judgement_id: judgementId, a_id: pair.a.id, b_id: pair.b.id,
    proposal: { kind: j.proposal.kind, rationale: j.proposal.rationale || '', changes: j.proposal.changes.filter((c) => c.action !== 'none').map((c) => {
      const out = { entry_id: c.entry_id, action: c.action };
      if (c.action === 'update') { if (c.content) out.content = c.content; if (c.useful_for) out.useful_for = c.useful_for; }
      return out;
    }) },
  };
  if (reason && String(reason).trim()) body.reason = String(reason).trim();
  return body;
}

/** The judgement_id each pair was judged in, by pair key. */
export function rememberJudgementIds(index, judgements, judgementId) {
  const out = new Map(index || []);
  if (judgementId) (judgements || []).forEach((j) => { if (j && j.a_id && j.b_id) out.set(pairKey(j.a_id, j.b_id), judgementId); });
  return out;
}

/** A one-line description of what a change does to an entry, for the proposal panel. */
export function changeSummary(change, pair) {
  if (!change) return '';
  const side = pair && pair.a && change.entry_id === pair.a.id ? 'A' : pair && pair.b && change.entry_id === pair.b.id ? 'B' : change.entry_id.slice(0, 8);
  if (change.action === 'delete') return `Delete ${side}`;
  if (change.action === 'update') {
    const parts = [];
    if (change.content) parts.push('content');
    if (change.useful_for) parts.push('useful_for');
    return `Rewrite ${side} (${parts.join(' + ')})`;
  }
  return `No change to ${side}`;
}

/** Mark pairs as applied/dismissed; applied pairs drop out of "next to judge". */
export function markPair(pairs, key, outcome) {
  return (pairs || []).map((p) => (pairKey(p.a.id, p.b.id) === key ? { ...p, outcome } : p));
}

/** What the apply result says. */
export function applyResultText(result) {
  if (!result) return 'Nothing came back.';
  const n = (result.changes || []).length;
  const applied = (result.changes || []).filter((c) => c.status === 'applied').length;
  const skipped = (result.changes || []).filter((c) => c.status === 'skipped');
  const failed = (result.changes || []).filter((c) => c.status === 'failed');
  const parts = [`${applied} of ${n} change${n === 1 ? '' : 's'} applied`];
  if (skipped.length) parts.push(`${skipped.length} skipped (${skipped.map((c) => c.error || 'skipped').join('; ')})`);
  if (failed.length) parts.push(`${failed.length} failed (${failed.map((c) => c.error || 'failed').join('; ')})`);
  return parts.join(' · ');
}

/** Judgements folded onto the pairs they belong to (by id pair). */
export function attachJudgements(pairs, judgements) {
  const byKey = new Map();
  (judgements || []).forEach((j) => { if (j && j.a_id && j.b_id) byKey.set(pairKey(j.a_id, j.b_id), j); });
  return (pairs || []).map((p) => {
    const j = byKey.get(pairKey(p.a.id, p.b.id));
    return j ? { ...p, judgement: j } : p;
  });
}

/** The next pairs to judge: unjudged and not yet applied/dismissed, best first, at most `n`. */
export function nextToJudge(pairs, n = DEFAULT_JUDGE_BATCH) {
  return (pairs || []).filter((p) => !p.judgement && !p.outcome).slice(0, Math.max(0, Math.min(n, MAX_JUDGE_BATCH)));
}

export const VERDICT_TONE = { duplicate: 'danger', conflicting: 'warn', related: 'info', distinct: 'muted' };
export const VERDICT_LABEL = { duplicate: 'Duplicate', conflicting: 'Conflicting', related: 'Related', distinct: 'Distinct' };
export const ACTION_LABEL = { merge: 'merge', keep_both: 'keep both', review_conflict: 'review the conflict', delete_one: 'delete one' };

/** Chip tone for a raw similarity: very close pairs stand out. */
export function similarityTone(sim) {
  if (sim >= 0.95) return 'danger';
  if (sim >= 0.9) return 'warn';
  return 'muted';
}

/** Counts shown in the header: pairs, by verdict, and how many are unjudged. */
export function summarize(pairs) {
  const out = { total: 0, judged: 0, unjudged: 0, byVerdict: { duplicate: 0, conflicting: 0, related: 0, distinct: 0 } };
  (pairs || []).forEach((p) => {
    out.total += 1;
    if (p.judgement) { out.judged += 1; out.byVerdict[p.judgement.verdict] = (out.byVerdict[p.judgement.verdict] || 0) + 1; }
    else out.unjudged += 1;
  });
  return out;
}

/** Which pairs the verdict filter shows ('all' | a verdict | 'unjudged'). */
export function filterPairs(pairs, verdictFilter) {
  if (!verdictFilter || verdictFilter === 'all') return pairs || [];
  if (verdictFilter === 'unjudged') return (pairs || []).filter((p) => !p.judgement);
  return (pairs || []).filter((p) => p.judgement && p.judgement.verdict === verdictFilter);
}

/** One line for the stats strip. */
export function statsCaption(result) {
  if (!result || !result.stats) return '';
  const s = result.stats;
  const parts = [`${(s.entries_scanned || 0).toLocaleString()} entries scanned`,
    `${s.neighbors} neighbours each`,
    `${(result.pairs || []).length} pair${(result.pairs || []).length === 1 ? '' : 's'} at or above ${Math.round((result.threshold || 0) * 100)}%`];
  if (s.truncated) parts.push('more exist, raise the threshold or narrow the scope');
  if (Number.isFinite(s.duration_ms)) parts.push(`${(s.duration_ms / 1000).toFixed(1)} s`);
  return parts.join(' · ');
}

/** What the judge status strip says when a call did not judge. */
export function judgeFailureText(status, error) {
  const base = {
    unconfigured: 'No model key is available for this bank, so pairs cannot be judged.',
    timeout: 'The model took too long to answer; try fewer pairs or the fast speed.',
    error: 'The model call failed.',
  }[status] || 'The model call failed.';
  return error ? `${base} (${error})` : base;
}

/** Word-level diff of two strings: [{op: 'equal'|'del'|'ins', text}] (LCS on
    whitespace-split tokens; inputs are capped so a pathological pair cannot
    freeze the tab). */
export function wordDiff(a, b, maxTokens = 600) {
  const ta = String(a || '').split(/(\s+)/).filter((t) => t.length).slice(0, maxTokens);
  const tb = String(b || '').split(/(\s+)/).filter((t) => t.length).slice(0, maxTokens);
  const n = ta.length; const m = tb.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  const push = (op, text) => { const last = out[out.length - 1]; if (last && last.op === op) last.text += text; else out.push({ op, text }); };
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) { push('equal', ta[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', ta[i]); i++; }
    else { push('ins', tb[j]); j++; }
  }
  while (i < n) push('del', ta[i++]);
  while (j < m) push('ins', tb[j++]);
  return out;
}

/** What to draw for one change: compact lines, never the whole entry. */
export function editLines(change) {
  const lines = [];
  (change && change.edits ? change.edits : []).forEach((e) => {
    if (!e) return;
    if (!e.find) lines.push({ kind: 'append', text: e.replace || '' });
    else if (e.find === e.replace) return;
    else lines.push({ kind: 'replace', find: e.find, replace: e.replace || '', diff: wordDiff(e.find, e.replace || '') });
  });
  if (change && change.useful_for) lines.push({ kind: 'useful_for', text: change.useful_for });
  return lines;
}

/** Whether every change in a proposal can be applied (edits still match the entries). */
export function proposalIsApplicable(proposal) {
  return proposalIsActionable(proposal) && (proposal.changes || []).every((c) => c.action !== 'update' || c.edits_apply_cleanly !== false);
}

/** Option label for the judge speed select, naming the model when known. */
export function speedLabel(speed, judgeModels) {
  const base = speed === 'fast' ? 'Fast' : 'Thorough';
  const model = judgeModels && judgeModels[speed];
  return model ? `${base} (${model})` : base;
}
