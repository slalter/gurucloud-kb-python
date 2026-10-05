/* Playbook detail, version history and delete — shared by the Playbooks list
   and the Map (playbook nodes). */

import { h, toast, skeleton, empty, fmtDate } from './dom.js';
import { openModal, confirmModal } from './modal.js';
import { openPlaybookEditor } from './playbook_editor.js';
import { openEntryDetail } from './entry_detail.js';
import { truncate } from './schema_utils.js';
import { sortSteps, stepKind, describeTransitions, isBranching, cleanStep } from './playbook_graph.js';
import { runsSection } from './playbook_runs.js';
import { isProcess, handoffRows, optionalColumns, documentationBanner, processMetaPairs } from './process_view.js';

export const STATUS_CHIP = { active: 'success', draft: 'warn', superseded: 'muted' };
const MIN_DELETE_REASON = 20;

export async function openPlaybookDetail(ctx, slug, { onChanged } = {}) {
  const { api } = ctx;
  const ref = openModal({ title: 'Playbook', body: skeleton('Loading…'), wide: true });
  let pb;
  try { pb = await api.getPlaybook(slug, { include_linked_entries: true }); }
  catch (e) { ref.setBody(h('div', { class: 'kbx-alert danger' }, `Could not load: ${e.message}`)); return; }
  const process = isProcess(pb);
  if (process && ref.setTitle) ref.setTitle('Process');

  const linkedById = {};
  (pb.linked_entries || []).forEach((le) => { linkedById[le.id] = le; });

  const steps = h('ol', { class: 'kbx-steps' });
  const allSteps = pb.steps || [];
  const ordered = isBranching(allSteps) ? sortSteps(allSteps) : allSteps;
  ordered.forEach((st) => {
    const linked = st.kb_entry_id ? linkedById[st.kb_entry_id] : null;
    steps.append(h('li', { class: 'kbx-step' },
      h('span', { class: 'kbx-step-num' }),
      h('div', { class: 'kbx-step-body' },
        h('div', { class: 'kbx-step-title' }, st.title, stepBadges(st)),
        process && st.process && st.process.actor ? h('div', { class: 'kbx-muted', dataset: { role: 'step-actor' }, style: { fontSize: '12px', marginBottom: '2px' } }, h('i', { class: 'bi bi-person' }), ` ${st.process.actor}`, st.process.system ? ` · ${st.process.system}` : '') : null,
        h('div', { class: 'kbx-step-text' }, st.body),
        transitionList(st, ordered),
        st.kb_entry_id ? h('div', { class: 'kbx-step-link' },
          linked && !linked.missing
            ? h('div', { class: 'kbx-alert info', style: { padding: '8px 11px', cursor: 'pointer' }, onClick: () => { ref.close(); openEntryDetail(ctx, st.kb_entry_id); } },
                h('i', { class: 'bi bi-link-45deg' }),
                h('div', {}, h('div', { style: { fontWeight: '600' } }, 'Linked entry'), h('div', { class: 'kbx-muted', style: { fontSize: '12px' } }, truncate(linked.content, 180))))
            : h('span', { class: 'kbx-chip danger' }, `Linked entry missing: ${String(st.kb_entry_id).slice(0, 8)}`)) : null)));
  });

  const n = (pb.steps || []).length;
  ref.setBody(h('div', {},
    h('div', { class: 'kbx-row-between', style: { marginBottom: '12px' } },
      h('div', {}, h('h3', { style: { margin: '0 0 4px' } }, pb.title), h('span', { class: `kbx-chip ${process ? 'info' : ''}`, dataset: { role: 'genre' } }, process ? 'process' : 'playbook'), h('span', { class: `kbx-chip ${STATUS_CHIP[pb.status] || 'muted'}`, style: { marginLeft: '6px' } }, pb.status), h('span', { class: 'kbx-chip muted', style: { marginLeft: '6px' } }, `v${pb.version}`), h('span', { class: 'kbx-mono kbx-muted', style: { marginLeft: '8px', fontSize: '12px' } }, pb.slug))),
    process ? h('div', { class: 'kbx-alert warn', dataset: { role: 'documentation-banner' }, style: { marginBottom: '14px' } }, h('i', { class: 'bi bi-info-circle' }), h('div', {}, documentationBanner())) : null,
    h('div', { class: 'kbx-alert info', style: { marginBottom: '14px' } }, h('i', { class: process ? 'bi bi-diagram-3' : 'bi bi-signpost-2' }), h('div', {}, h('strong', {}, process ? 'About — ' : 'When to use — '), pb.when_to_use)),
    pb.summary ? h('p', { style: { color: 'var(--kbx-body)', marginTop: 0 } }, pb.summary) : null,
    process ? processMeta(pb.metadata) : null,
    process ? handoffTable(ordered) : null,
    h('h4', { style: { fontSize: '14px', color: 'var(--kbx-heading)', margin: '10px 0 4px' } }, process ? `${n} hand-off${n === 1 ? '' : 's'} in detail` : `${n} step${n === 1 ? '' : 's'}`),
    steps,
    process ? null : runsSection(ctx, pb),
    h('dl', { class: 'kbx-kv kbx-mt-lg' },
      h('dt', {}, 'Created'), h('dd', {}, fmtDate(pb.created_at)),
      h('dt', {}, 'Updated'), h('dd', {}, fmtDate(pb.updated_at)),
      h('dt', {}, 'Created by'), h('dd', {}, pb.created_by || '—'))));

  const changed = () => { if (onChanged) onChanged(); };
  const versionsBtn = h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', onClick: () => { ref.close(); openPlaybookVersions(ctx, slug, { onChanged }); } }, h('i', { class: 'bi bi-clock-history' }), 'Versions');
  const editBtn = h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', onClick: () => { ref.close(); openPlaybookEditor(ctx, pb, { onSaved: changed }); } }, h('i', { class: 'bi bi-pencil' }), 'Edit');
  const delBtn = h('button', { class: 'kbx-btn kbx-btn-danger', type: 'button', onClick: () => { ref.close(); confirmDeletePlaybook(ctx, pb.slug, pb.title, { onChanged, process }); } }, h('i', { class: 'bi bi-trash' }), 'Delete');
  ref.setFoot([versionsBtn, editBtn, delBtn]);
}

const KIND_CHIP = { decision: ['info', 'Decision'], end: ['muted', 'End'] };

/** Owner / as-of / sources / open gaps of a documented process. */
function processMeta(metadata) {
  const pairs = processMetaPairs(metadata);
  if (!pairs.length) return null;
  return h('dl', { class: 'kbx-kv', dataset: { role: 'process-meta' }, style: { marginBottom: '12px' } },
    ...pairs.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

/** The hand-off table of a documented process: step, actor, what happens, system, hands to (+ needs / exceptions / source when filled). */
export function handoffTable(orderedSteps) {
  const rows = handoffRows(orderedSteps);
  const extra = optionalColumns(rows);
  const EXTRA_LABEL = { needs: 'Needs', exceptions: 'Exceptions', source: 'Source' };
  const head = ['#', 'Actor', 'What happens', 'System', 'Hands to', ...extra.map((c) => EXTRA_LABEL[c])];
  return h('div', { class: 'kbx-table-wrap', style: { marginBottom: '14px' } },
    h('table', { class: 'kbx-table', dataset: { role: 'handoff-table' } },
      h('thead', {}, h('tr', {}, ...head.map((c) => h('th', {}, c)))),
      h('tbody', {}, ...rows.map((r) => h('tr', { dataset: { role: 'handoff-row', key: r.key || '' } },
        h('td', { class: 'kbx-mono' }, r.key || String(r.position)),
        h('td', {}, r.actor ? h('span', { class: 'kbx-strong' }, r.actor) : h('span', { class: 'kbx-muted' }, r.kind === 'end' ? '—' : '(no actor)')),
        h('td', {}, h('div', { class: 'kbx-strong' }, r.title), h('div', { class: 'kbx-muted', style: { fontSize: '12px' } }, r.body)),
        h('td', {}, r.system || '—'),
        h('td', {}, r.hands_to || '—'),
        ...extra.map((c) => h('td', {}, r[c] || '—')))))));
}

/** Kind badge (Decision / End; nothing for an action) and the step key. */
function stepBadges(st) {
  const chip = KIND_CHIP[stepKind(st)];
  if (!chip && !st.key) return null;
  return h('span', { style: { marginLeft: '8px', fontWeight: '400' } },
    chip ? h('span', { class: `kbx-chip ${chip[0]}`, dataset: { role: 'step-kind' } }, chip[1]) : null,
    st.key ? h('span', { class: 'kbx-mono kbx-muted', dataset: { role: 'step-key' }, style: { marginLeft: chip ? '6px' : '0', fontSize: '12px' } }, st.key) : null);
}

/** "when X → Y" / "then → Y" / "back to Y, at most N times" under a step. */
function transitionList(st, ordered) {
  const lines = describeTransitions(st, ordered);
  if (!lines.length) return null;
  return h('ul', { class: 'kbx-step-next', style: { margin: '6px 0 0', paddingLeft: '18px', fontSize: '13px', color: 'var(--kbx-body)' } },
    ...lines.map((l) => h('li', { dataset: { transition: l.type } },
      h('i', { class: `bi ${l.type === 'loop' ? 'bi-arrow-repeat' : 'bi-arrow-return-right'}`, style: { marginRight: '6px' } }), l.text)));
}

export async function openPlaybookVersions(ctx, slug, { onChanged } = {}) {
  const { api } = ctx;
  const ref = openModal({ title: `Version history — ${slug}`, body: skeleton('Loading versions…'), wide: true });
  let versions;
  try { versions = await api.listPlaybookVersions(slug); }
  catch (e) { ref.setBody(h('div', { class: 'kbx-alert danger' }, `Could not load versions: ${e.message}`)); return; }
  const rows = Array.isArray(versions) ? versions : (versions && versions.versions) || [];
  if (!rows.length) { ref.setBody(empty('bi-clock-history', 'No versions')); return; }
  const list = h('div', { class: 'kbx-list' });
  rows.forEach((v) => {
    const snap = v.snapshot || {};
    const tombstone = snap.deleted === true;
    list.append(h('div', { class: 'kbx-item', style: { cursor: 'default' } },
      h('div', { class: 'kbx-item-head' },
        h('div', { class: 'kbx-row', style: { gap: '8px' } }, h('span', { class: 'kbx-chip' }, `v${v.version}`), tombstone ? h('span', { class: 'kbx-chip danger' }, 'deleted') : h('span', { class: 'kbx-chip muted' }, snap.status || 'active')),
        h('span', { class: 'kbx-muted', style: { fontSize: '12px' } }, fmtDate(v.created_at))),
      h('div', { class: 'kbx-item-body' }, v.change_note || (tombstone ? snap.delete_reason : '(no note)')),
      h('div', { class: 'kbx-item-meta' },
        h('span', {}, snap.title || ''),
        v.changed_by ? h('span', {}, `by ${v.changed_by}`) : null,
        snap.steps ? h('span', {}, `${snap.steps.length} steps`) : null),
      h('div', { class: 'kbx-row kbx-mt' },
        !tombstone ? h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', onClick: () => restore(slug, snap, v.version) }, h('i', { class: 'bi bi-arrow-counterclockwise' }), `Restore v${v.version}`) : null)));
  });
  ref.setBody(list);

  async function restore(slugToRestore, snap, version) {
    const ok = await confirmModal({ title: `Restore v${version}?`, message: `This writes a new version of "${slugToRestore}" from the v${version} snapshot (title, steps, status and metadata).`, confirmLabel: 'Restore', danger: false });
    if (!ok) return;
    const body = {
      title: snap.title, when_to_use: snap.when_to_use, summary: snap.summary || '',
      steps: (snap.steps || []).map(cleanStep),
      status: snap.status, metadata: snap.metadata || null,
      change_note: `restore of v${version}`, changed_by: 'explorer',
    };
    if (snap.genre) body.genre = snap.genre;
    try { await api.upsertPlaybook(slugToRestore, body, { force: true }); toast(`Restored v${version}`, 'success'); ref.close(); if (onChanged) onChanged(); }
    catch (e) { toast(`Restore failed: ${e.message}`, 'error'); }
  }
}

export function confirmDeletePlaybook(ctx, slug, title, { onChanged, process = false } = {}) {
  const { api } = ctx;
  const noun = process ? 'process' : 'playbook';
  const reason = h('textarea', { class: 'kbx-textarea', rows: '3', placeholder: `Why is "${title}" being deleted? (min ${MIN_DELETE_REASON} characters — kept as a tombstone)` });
  const delBtn = h('button', { class: 'kbx-btn kbx-btn-danger', type: 'button' }, `Delete ${noun}`);
  const ref = openModal({ title: `Delete "${title}"`, body: h('div', {}, h('p', { style: { marginTop: 0 } }, `The ${noun} row is removed but a tombstone version preserves its last state and your reason.`), h('div', { class: 'kbx-field' }, h('label', {}, 'Reason'), reason)), footer: [h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', onClick: () => ref.close() }, 'Cancel'), delBtn] });
  delBtn.addEventListener('click', async () => {
    const r = reason.value.trim();
    if (r.length < MIN_DELETE_REASON) { toast(`Reason must be at least ${MIN_DELETE_REASON} characters`, 'warning'); return; }
    delBtn.classList.add('is-loading');
    try { await api.deletePlaybook(slug, { reason: r, changed_by: 'explorer' }); toast(`${process ? 'Process' : 'Playbook'} deleted`, 'success'); ref.close(); if (onChanged) onChanged(); }
    catch (e) { toast(`Delete failed: ${e.message}`, 'error'); delBtn.classList.remove('is-loading'); }
  });
}
