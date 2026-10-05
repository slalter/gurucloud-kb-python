/* Playbook graph helpers — pure, no DOM. Shared by the playbook detail view,
   the editor and the Map layout.

   A step may carry three optional branching fields (server contract):
     key   stable id unique within the playbook, e.g. "GAS-002"
     kind  "action" (default) | "decision" | "end"
     next  [{ to: <key>, when?: <condition>, limit?: <int, loop-backs only> }]
   A step with no `next` flows to the following position; an end step stops.
   A step without a key is addressed by its position as a string ("3"), which
   matches get_playbook's graph.edges {from, to}.

   A playbook with no `next` anywhere is LINEAR and every consumer must treat it
   exactly as before branching existed (chain on the map, plain list in the
   detail view, {title, body, kb_entry_id} in a save payload). */

export const STEP_KINDS = ['action', 'decision', 'end'];

/** Steps sorted by position (stable for missing positions). */
export function sortSteps(steps) {
  return (steps || []).map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.position ?? a.i + 1) - (b.s.position ?? b.i + 1) || a.i - b.i)
    .map((x) => x.s);
}

/** The reference a transition or graph edge uses for a step. */
export function stepRef(step, index) {
  if (step && step.key) return String(step.key);
  return String(step && step.position != null ? step.position : index + 1);
}

export function stepKind(step) {
  return step && STEP_KINDS.includes(step.kind) ? step.kind : 'action';
}

export function transitionsOf(step) {
  return step && Array.isArray(step.next) ? step.next.filter((t) => t && t.to != null && t.to !== '') : [];
}

/** True when any step carries an explicit transition. */
export function isBranching(steps) {
  return (steps || []).some((s) => transitionsOf(s).length > 0);
}

/** Index of the step a ref points at (key first, then position), or -1. */
export function findStepIndex(steps, ref) {
  const r = String(ref);
  const byKey = steps.findIndex((s) => s && s.key && String(s.key) === r);
  if (byKey >= 0) return byKey;
  return steps.findIndex((s, i) => !(s && s.key) && stepRef(s, i) === r);
}

/** Human label for a target step: its title, else its key, else "Step N". */
export function targetLabel(steps, ref) {
  const i = findStepIndex(steps, ref);
  if (i < 0) return String(ref);
  const s = steps[i];
  return s.title || s.key || `Step ${i + 1}`;
}

/**
 * Edges between steps (sorted steps in, refs out): explicit transitions where a
 * step has them, otherwise an implicit edge to the following step unless the
 * step is an end. `loop` marks a transition back to the same or an earlier step.
 * @returns {Array<{from:string,to:string,when:string|null,limit:number|null,loop:boolean,fromIndex:number,toIndex:number}>}
 */
export function deriveEdges(sortedSteps) {
  const edges = [];
  sortedSteps.forEach((s, i) => {
    const next = transitionsOf(s);
    if (next.length) {
      next.forEach((t) => {
        const j = findStepIndex(sortedSteps, t.to);
        edges.push({ from: stepRef(s, i), to: j >= 0 ? stepRef(sortedSteps[j], j) : String(t.to), when: t.when || null, limit: t.limit ?? null, loop: j >= 0 && j <= i, fromIndex: i, toIndex: j });
      });
    } else if (stepKind(s) !== 'end' && i + 1 < sortedSteps.length) {
      edges.push({ from: stepRef(s, i), to: stepRef(sortedSteps[i + 1], i + 1), when: null, limit: null, loop: false, fromIndex: i, toIndex: i + 1 });
    }
  });
  return edges;
}

/**
 * The lines the detail view shows under a step. Empty for a plain linear step,
 * an end step, and an action whose only transition is simply the next step.
 * @returns {Array<{type:'when'|'then'|'loop', when:string|null, target:string, limit:number|null, text:string}>}
 */
export function describeTransitions(step, sortedSteps) {
  if (stepKind(step) === 'end') return [];
  const i = sortedSteps.indexOf(step);
  const next = transitionsOf(step);
  if (stepKind(step) !== 'decision' && next.length === 1 && !next[0].when && next[0].limit == null
      && findStepIndex(sortedSteps, next[0].to) === i + 1) return [];
  return next.map((t) => {
    const j = findStepIndex(sortedSteps, t.to);
    const target = targetLabel(sortedSteps, t.to);
    const limit = t.limit ?? null;
    const prefix = t.when ? `when ${t.when}: ` : '';
    if (j >= 0 && i >= 0 && j <= i) {
      return { type: 'loop', when: t.when || null, target, limit, text: `${prefix}back to ${target}${limit != null ? `, at most ${limit} time${limit === 1 ? '' : 's'}` : ''}` };
    }
    if (t.when) return { type: 'when', when: t.when, target, limit, text: `when ${t.when} → ${target}` };
    return { type: 'then', when: null, target, limit, text: `then → ${target}` };
  });
}

/** Clean one transition for a payload: {to, when?, limit?}. */
export function cleanTransition(t) {
  const out = { to: String(t.to) };
  const when = t.when == null ? '' : String(t.when).trim();
  if (when) out.when = when;
  const limit = t.limit === '' || t.limit == null ? null : Number(t.limit);
  if (limit != null && Number.isInteger(limit) && limit > 0) out.limit = limit;
  return out;
}

/** A step for an upsert payload. key / kind / next appear only when set, so a
    linear step stays exactly {title, body, kb_entry_id}. kind "action" is the
    server default and is omitted. */
export function cleanStep(step) {
  const out = { title: step.title, body: step.body, kb_entry_id: step.kb_entry_id || null };
  const key = step.key == null ? '' : String(step.key).trim();
  if (key) out.key = key;
  if (stepKind(step) !== 'action') out.kind = stepKind(step);
  const next = transitionsOf(step).map(cleanTransition);
  if (next.length && stepKind(step) !== 'end') out.next = next;
  if (step.process && typeof step.process === 'object' && Object.keys(step.process).length) out.process = { ...step.process };
  return out;
}
