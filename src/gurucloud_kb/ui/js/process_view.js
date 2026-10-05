/* Processes — business process flow DOCUMENTATION stored on the playbook
   substrate (genre = 'process'; kb_service/process_tool_defs.py). A playbook
   is the agent's own procedure; a process describes the client (who does what,
   in which system, what they need, who they hand to) and is read, never run.

   Pure helpers (no DOM) shared by the Playbooks list, the detail modal and the
   editor, so Node tests can pin the genre and hand-off semantics. */

export const GENRE_PROCEDURE = 'procedure';
export const GENRE_PROCESS = 'process';

/** Filter chips on the Playbooks tab: '' means no genre filter (all). */
export const GENRE_FILTERS = [
  { value: '', label: 'All' },
  { value: GENRE_PROCEDURE, label: 'Playbooks' },
  { value: GENRE_PROCESS, label: 'Processes' },
];

/** The per-step documentation fields, in display order, with their labels. */
export const PROCESS_STEP_FIELDS = [
  ['actor', 'Actor'],
  ['system', 'System'],
  ['needs', 'Needs'],
  ['hands_to', 'Hands to'],
  ['exceptions', 'Exceptions'],
  ['source', 'Source'],
];

/** Lifted process metadata keys (document_process arguments). */
export const PROCESS_METADATA_KEYS = ['owner_role', 'as_of', 'sources', 'open_gaps'];

export function genreOf(pb) {
  return pb && pb.genre === GENRE_PROCESS ? GENRE_PROCESS : GENRE_PROCEDURE;
}

export function isProcess(pb) {
  return genreOf(pb) === GENRE_PROCESS;
}

/** The stored process detail of a step ({} when none). */
export function processDetailOf(step) {
  return step && step.process && typeof step.process === 'object' ? step.process : {};
}

/** The sentence every process read carries (mirrors documentation_banner). */
export function documentationBanner(who) {
  const label = who || 'the client';
  return `This documents how ${label} does it, written by agents from what the client said and showed. `
    + 'It is not a procedure for you to execute: use it to understand the flow, who is involved and '
    + 'where the data lives. Automating this flow? Write the runbook as a playbook on the code KB and cite this process by slug.';
}

/** Rows for the hand-off table: one per step, in the given (already sorted) order. */
export function handoffRows(steps) {
  return (steps || []).map((st, i) => {
    const d = processDetailOf(st);
    return {
      position: st.position != null ? st.position : i + 1,
      key: st.key || '',
      kind: st.kind || 'action',
      title: st.title || '',
      actor: d.actor || '',
      body: st.body || '',
      system: d.system || '',
      hands_to: d.hands_to || '',
      needs: d.needs || '',
      exceptions: d.exceptions || '',
      source: d.source || '',
    };
  });
}

/** Which optional columns (needs / exceptions / source) any row fills. */
export function optionalColumns(rows) {
  return ['needs', 'exceptions', 'source'].filter((c) => rows.some((r) => r[c]));
}

/** Nest the flat editor fields of one step into `process` (empty values dropped). */
export function nestProcessFields(flat) {
  const out = {};
  PROCESS_STEP_FIELDS.forEach(([field]) => {
    const v = flat && flat[field] != null ? String(flat[field]).trim() : '';
    if (v) out[field] = v;
  });
  return out;
}

/** Error message for a process step list, or null when every non-end step has an actor. */
export function processStepsProblem(steps) {
  for (let i = 0; i < (steps || []).length; i++) {
    const st = steps[i];
    const kind = st.kind || 'action';
    if (kind !== 'end' && !processDetailOf(st).actor) {
      return `Step ${i + 1} needs an actor: who on the client side does it (a person with role, a role or a team)`;
    }
  }
  return null;
}

/** Lifted metadata fields of a process as display pairs [label, text]. */
export function processMetaPairs(metadata) {
  const m = metadata && typeof metadata === 'object' ? metadata : {};
  const pairs = [];
  if (m.owner_role) pairs.push(['Owner', String(m.owner_role)]);
  if (m.as_of) pairs.push(['As of', String(m.as_of)]);
  if (Array.isArray(m.sources) && m.sources.length) pairs.push(['Sources', m.sources.join('; ')]);
  if (Array.isArray(m.open_gaps) && m.open_gaps.length) pairs.push(['Open gaps', m.open_gaps.join('; ')]);
  return pairs;
}

/** Stat-chip labels for a genre filter ('' → the mixed wording). */
export function genreNoun(genre, count) {
  const one = genre === GENRE_PROCESS ? 'process' : genre === GENRE_PROCEDURE ? 'playbook' : 'item';
  const many = genre === GENRE_PROCESS ? 'processes' : genre === GENRE_PROCEDURE ? 'playbooks' : 'items';
  return count === 1 ? one : many;
}
