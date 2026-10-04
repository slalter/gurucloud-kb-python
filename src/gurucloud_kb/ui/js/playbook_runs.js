/* Playbook runs — the read-only "Runs" section under a playbook's steps.
   A run is an agent walking the playbook on a subject; its trail records each
   step it observed and the transition it chose. Runs are created by agents
   through MCP tools, never from the explorer.

   runsSection(ctx, pb) returns a node that loads the runs list itself; a 404
   from the runs endpoint (a server without runs) removes the section. Clicking
   a run swaps the table for its trail inline, with a back control. */

import { h, mount, skeleton, fmtDate, timeAgo } from './dom.js';
import { sortSteps, findStepIndex, describeTransitions } from './playbook_graph.js';

export const RUN_STATES = ['all', 'running', 'completed', 'abandoned'];
export const RUN_STATE_CHIP = { running: 'info', completed: 'success', abandoned: 'danger' };
export const RUNS_LIMIT = 25;
const OUTCOME_CHIP = { completed: ['success', 'Completed'], abandoned: ['danger', 'Abandoned'] };

export function stateChip(state) {
  return h('span', { class: `kbx-chip ${RUN_STATE_CHIP[state] || 'muted'}`, dataset: { role: 'run-state' } }, state || 'unknown');
}

/** The playbook step a trail record or current step names: key first, then position. */
export function resolveStep(steps, key, position) {
  const sorted = sortSteps(steps);
  let i = key != null && key !== '' ? findStepIndex(sorted, key) : -1;
  if (i < 0 && position != null) i = sorted.findIndex((s, j) => (s.position ?? j + 1) === Number(position));
  return i >= 0 ? sorted[i] : null;
}

/** Newest first by last update (the server already orders; this keeps it stable). */
function newestFirst(runs) {
  const t = (r) => Date.parse(r.updated_at || r.created_at || '') || 0;
  return runs.slice().sort((a, b) => t(b) - t(a));
}

export function runsTable(runs, onOpen) {
  if (!runs.length) return h('div', { class: 'kbx-muted', dataset: { role: 'runs-empty' }, style: { padding: '10px 0' } }, 'No runs yet');
  const rows = newestFirst(runs).map((r) => h('tr', { dataset: { role: 'run-row', runId: r.id }, style: { cursor: 'pointer' }, onClick: () => onOpen(r) },
    h('td', {}, r.subject || '—'),
    h('td', {}, stateChip(r.state)),
    h('td', {}, r.version != null ? `v${r.version}` : '—'),
    h('td', {}, String(r.steps_taken ?? 0)),
    h('td', { title: fmtDate(r.updated_at) }, timeAgo(r.updated_at || r.created_at))));
  return h('div', { class: 'kbx-table-wrap' }, h('table', { class: 'kbx-table rows-click', dataset: { role: 'runs-table' } },
    h('thead', {}, h('tr', {}, ...['Subject', 'State', 'Version', 'Steps', 'Updated'].map((c) => h('th', {}, c)))),
    h('tbody', {}, ...rows)));
}

function stepLabel(steps, key, position) {
  const st = resolveStep(steps, key, position);
  const ref = key || (position != null ? `#${position}` : '?');
  return h('span', {},
    h('span', { class: 'kbx-mono', dataset: { role: 'trail-key' }, style: { fontSize: '12px' } }, ref),
    st && st.title ? h('strong', { dataset: { role: 'trail-title' }, style: { marginLeft: '8px' } }, st.title) : null);
}

function trailItem(rec, steps) {
  const chip = OUTCOME_CHIP[rec.outcome];
  return h('li', { class: 'kbx-step', dataset: { role: 'trail-record', outcome: rec.outcome || '' } },
    h('span', { class: 'kbx-step-num' }),
    h('div', { class: 'kbx-step-body' },
      h('div', { class: 'kbx-step-title' }, stepLabel(steps, rec.step_key, rec.step_position),
        chip ? h('span', { class: `kbx-chip ${chip[0]}`, dataset: { role: 'trail-outcome' }, style: { marginLeft: '8px' } }, chip[1]) : null),
      rec.observation ? h('div', { class: 'kbx-step-text', dataset: { role: 'trail-observation' } }, rec.observation) : null,
      rec.outcome === 'advanced' && rec.chosen_next ? h('div', { dataset: { role: 'trail-next' }, style: { fontSize: '13px', marginTop: '4px' } },
        h('i', { class: 'bi bi-arrow-return-right', style: { marginRight: '6px' } }), `→ ${rec.chosen_next}`,
        rec.reason ? h('span', { class: 'kbx-muted' }, ` — ${rec.reason}`) : null) : null,
      rec.outcome !== 'advanced' && rec.reason ? h('div', { class: 'kbx-muted', style: { fontSize: '13px', marginTop: '4px' } }, rec.reason) : null,
      h('div', { class: 'kbx-muted', style: { fontSize: '12px', marginTop: '4px' } }, [fmtDate(rec.created_at), rec.changed_by ? `by ${rec.changed_by}` : null].filter(Boolean).join(' · '))));
}

/** "when X → Y" lines for the run's current step (server transitions first, else the playbook's). */
function currentTransitions(cur, steps) {
  const sorted = sortSteps(steps);
  const trs = Array.isArray(cur.transitions) ? cur.transitions : [];
  if (trs.length) {
    return trs.map((t) => {
      const target = resolveStep(steps, t.to);
      const label = target && target.title ? target.title : String(t.to);
      const limit = t.limit != null ? ` (${t.taken || 0}/${t.limit} taken)` : '';
      return { type: t.when ? 'when' : 'then', text: `${t.when ? `when ${t.when}` : 'then'} → ${label}${limit}` };
    });
  }
  const st = resolveStep(steps, cur.key, cur.position);
  return st ? describeTransitions(st, sorted) : [];
}

function currentStepBox(cur, steps) {
  const st = resolveStep(steps, cur.key, cur.position);
  const title = cur.title || (st && st.title) || '';
  const lines = currentTransitions(cur, steps);
  return h('div', { class: 'kbx-alert info', dataset: { role: 'run-current' }, style: { marginTop: '12px' } },
    h('i', { class: 'bi bi-geo-alt' }),
    h('div', {},
      h('div', {}, h('strong', {}, 'Current step — '), h('span', { class: 'kbx-mono', dataset: { role: 'current-key' } }, cur.key || `#${cur.position}`), title ? ` ${title}` : ''),
      lines.length ? h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px', fontSize: '13px' } },
        ...lines.map((l) => h('li', { dataset: { transition: l.type } }, l.text))) : null));
}

export function runTrailView(run, steps, onBack) {
  const kv = [
    ['State', stateChip(run.state)], ['Version', run.version != null ? `v${run.version}` : '—'],
    ['Started by', run.started_by || '—'], ['Started', fmtDate(run.created_at)],
    run.completed_at ? ['Completed', fmtDate(run.completed_at)] : null,
    run.abandon_reason ? ['Abandon reason', run.abandon_reason] : null,
  ].filter(Boolean);
  const trail = (run.trail || []).slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return h('div', { dataset: { role: 'run-trail' } },
    h('div', { class: 'kbx-row-between', style: { marginBottom: '8px' } },
      h('strong', { dataset: { role: 'run-subject' } }, run.subject || '(no subject)'),
      h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', onClick: onBack }, h('i', { class: 'bi bi-arrow-left' }), 'Back to runs')),
    h('dl', { class: 'kbx-kv' }, ...kv.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    trail.length ? h('ol', { class: 'kbx-steps', style: { marginTop: '12px' } }, ...trail.map((r) => trailItem(r, steps)))
      : h('div', { class: 'kbx-muted', style: { marginTop: '12px' } }, 'No steps recorded yet'),
    run.state === 'running' && run.current_step ? currentStepBox(run.current_step, steps) : null);
}

/**
 * The Runs section for a playbook. Loads asynchronously; `section.ready`
 * resolves once the first load settles (tests await it).
 */
export function runsSection(ctx, pb) {
  const { api } = ctx;
  const steps = pb.steps || [];
  const filter = h('select', { class: 'kbx-select kbx-btn-sm', dataset: { role: 'runs-filter' }, 'aria-label': 'Filter runs by state' },
    ...RUN_STATES.map((s) => h('option', { value: s }, s[0].toUpperCase() + s.slice(1))));
  const body = h('div', { dataset: { role: 'runs-body' } });
  const head = h('div', { class: 'kbx-row-between', style: { margin: '18px 0 6px' } },
    h('h4', { style: { fontSize: '14px', color: 'var(--kbx-heading)', margin: 0 } }, 'Runs'), filter);
  const section = h('section', { dataset: { role: 'playbook-runs' } }, head, body);
  if (!api || typeof api.listPlaybookRuns !== 'function') { section.style.display = 'none'; section.ready = Promise.resolve(); return section; }

  async function openRun(r) {
    filter.style.display = 'none';
    mount(body, skeleton('Loading run…'));
    try { mount(body, runTrailView(await api.getPlaybookRun(r.id), steps, back)); }
    catch (e) { mount(body, h('div', { class: 'kbx-alert danger' }, `Could not load run: ${e.message}`), h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm kbx-mt', type: 'button', onClick: back }, 'Back to runs')); }
  }
  function back() { filter.style.display = ''; load(); }
  async function load() {
    mount(body, skeleton('Loading runs…'));
    let res;
    try { res = await api.listPlaybookRuns(pb.slug, { state: filter.value || 'all', limit: RUNS_LIMIT }); }
    catch (e) {
      if (e && e.status === 404) { section.remove(); section.style.display = 'none'; return; }
      mount(body, h('div', { class: 'kbx-alert danger' }, `Could not load runs: ${e.message}`)); return;
    }
    const runs = Array.isArray(res) ? res : (res && res.runs) || [];
    mount(body, runsTable(runs.slice(0, RUNS_LIMIT), openRun));
  }
  filter.addEventListener('change', () => { section.ready = load(); });
  section.ready = load();
  return section;
}
