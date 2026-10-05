/* Playbook editor (create / edit) — shared by the Playbooks list, the playbook
   detail modal and "Promote to playbook" on an entry. Handles the overlap guard
   (409 playbook_overlap) by showing the conflicting playbooks and offering an
   explicit force-save. `prefill` seeds a NEW playbook (slug editable). */

import { h, mount, clear, toast } from './dom.js';
import { openModal } from './modal.js';
import { STEP_KINDS, stepKind, transitionsOf, findStepIndex, cleanStep } from './playbook_graph.js';
import { GENRE_PROCEDURE, GENRE_PROCESS, PROCESS_STEP_FIELDS, genreOf, processDetailOf, nestProcessFields, processStepsProblem, documentationBanner } from './process_view.js';

const KIND_LABEL = { action: 'Action', decision: 'Decision', end: 'End' };
const PROCESS_PLACEHOLDER = {
  actor: 'Actor — who on the client side does this (required)',
  system: 'System or record it happens in (e.g. Sage)',
  needs: 'What the step needs to start',
  hands_to: 'Who or what receives the output',
  exceptions: 'What goes wrong here and how they handle it',
  source: 'Who told us / where we saw it, and when',
};

export function openPlaybookEditor(ctx, existing, { prefill = null, onSaved, genre: genreOpt } = {}) {
  const { api } = ctx;
  const isEdit = !!existing;
  const seed = existing || prefill || {};
  let genre = isEdit ? genreOf(existing) : (genreOpt === GENRE_PROCESS ? GENRE_PROCESS : GENRE_PROCEDURE);
  const genreSel = h('select', { class: 'kbx-select', dataset: { role: 'genre' } },
    h('option', { value: GENRE_PROCEDURE }, 'Playbook — a procedure an agent follows'),
    h('option', { value: GENRE_PROCESS }, 'Process — documentation of how the client operates'));
  genreSel.value = genre;
  if (isEdit) genreSel.setAttribute('disabled', '');
  const isProcessGenre = () => genre === GENRE_PROCESS;
  const slugInput = h('input', { class: 'kbx-input kbx-mono', placeholder: 'lowercase-with-dashes', value: seed.slug || '' });
  if (isEdit) slugInput.setAttribute('readonly', '');
  const titleInput = h('input', { class: 'kbx-input', value: seed.title || '', placeholder: 'Human-readable name (3–200 chars)' });
  const whenInput = h('textarea', { class: 'kbx-textarea', rows: '3', placeholder: 'When should an agent reach for this? (min 10 chars — this is the retrieval key)' }, seed.when_to_use || '');
  const whenLabel = h('label', {}, 'When to use');
  const processNote = h('div', { class: 'kbx-alert warn', dataset: { role: 'process-note' }, style: { marginBottom: '14px' } }, h('i', { class: 'bi bi-info-circle' }), h('div', {}, documentationBanner()));
  function syncGenre() {
    const p = isProcessGenre();
    whenLabel.textContent = p ? 'About' : 'When to use';
    whenInput.placeholder = p ? 'What this flow is and what starts it, in the client\'s terms (min 10 chars — this is the retrieval key)' : 'When should an agent reach for this? (min 10 chars — this is the retrieval key)';
    processNote.style.display = p ? '' : 'none';
    stepRows.forEach((r) => { r.processBlock.style.display = p ? '' : 'none'; r.bodyI.placeholder = p ? 'What happens at this hand-off, in the client\'s terms' : 'What to do in this step'; });
  }
  genreSel.addEventListener('change', () => { genre = genreSel.value === GENRE_PROCESS ? GENRE_PROCESS : GENRE_PROCEDURE; syncGenre(); });
  const summaryInput = h('textarea', { class: 'kbx-textarea', rows: '2', placeholder: 'Optional one-line summary' }, seed.summary || '');
  const statusSel = h('select', { class: 'kbx-select' },
    h('option', { value: 'active' }, 'Active'), h('option', { value: 'draft' }, 'Draft'), h('option', { value: 'superseded' }, 'Superseded'));
  statusSel.value = seed.status || 'active';
  const noteInput = h('input', { class: 'kbx-input', placeholder: 'Change note (optional)', value: prefill && !isEdit ? 'created from entry in the explorer' : '' });

  const stepsHost = h('div', {});
  const noticeHost = h('div', {});
  const stepRows = [];
  let rowSeq = 0;
  function addStep(step) {
    const titleI = h('input', { class: 'kbx-input', placeholder: 'Step title', value: step ? step.title || '' : '' });
    const bodyI = h('textarea', { class: 'kbx-textarea', rows: '3', placeholder: 'What to do in this step' }, step ? step.body || '' : '');
    const entryI = h('input', { class: 'kbx-input kbx-mono', placeholder: 'Linked KB entry id (optional)', value: step && step.kb_entry_id ? step.kb_entry_id : '' });
    const keyI = h('input', { class: 'kbx-input kbx-mono', placeholder: 'Key (optional, e.g. GAS-002)', value: step && step.key ? step.key : '', dataset: { role: 'step-key' } });
    const kindSel = h('select', { class: 'kbx-select', dataset: { role: 'step-kind' } }, ...STEP_KINDS.map((k) => h('option', { value: k }, KIND_LABEL[k])));
    kindSel.value = stepKind(step);
    const transHost = h('div', { dataset: { role: 'transitions' } });
    const detail = processDetailOf(step);
    const processInputs = {};
    PROCESS_STEP_FIELDS.forEach(([field]) => {
      processInputs[field] = h('input', { class: 'kbx-input', dataset: { role: `process-${field}` }, placeholder: PROCESS_PLACEHOLDER[field], value: detail[field] || '' });
    });
    const processBlock = h('div', { class: 'kbx-field', dataset: { role: 'process-fields' }, style: { marginBottom: '8px', display: 'none' } },
      h('div', { class: 'kbx-field-row', style: { marginBottom: '8px' } }, h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, processInputs.actor), h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, processInputs.system)),
      h('div', { class: 'kbx-field-row', style: { marginBottom: '8px' } }, h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, processInputs.needs), h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, processInputs.hands_to)),
      h('div', { class: 'kbx-field-row', style: { marginBottom: 0 } }, h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, processInputs.exceptions), h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, processInputs.source)));
    const row = { id: ++rowSeq, titleI, bodyI, entryI, keyI, kindSel, transHost, processInputs, processBlock, transitions: [], seedNext: transitionsOf(step) };
    stepRows.push(row);
    const addTransBtn = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', dataset: { role: 'add-transition' }, onClick: () => addTransition(row, null, null) }, h('i', { class: 'bi bi-plus-lg' }), 'Add transition');
    row.transBlock = h('div', { class: 'kbx-field', style: { marginTop: '8px', marginBottom: 0 } },
      h('div', { class: 'kbx-row-between' }, h('span', { class: 'kbx-hint' }, 'Transitions (leave empty to continue to the next step)'), addTransBtn), transHost);
    const removeBtn = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', title: 'Remove step', onClick: () => removeStep(row) }, h('i', { class: 'bi bi-x-lg' }));
    const upBtn = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', title: 'Move up', onClick: () => move(row, -1) }, h('i', { class: 'bi bi-arrow-up' }));
    const downBtn = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', title: 'Move down', onClick: () => move(row, 1) }, h('i', { class: 'bi bi-arrow-down' }));
    const node = h('div', { class: 'kbx-card', dataset: { role: 'step-row' }, style: { padding: '12px', marginBottom: '10px', background: 'var(--kbx-surface-2)', boxShadow: 'none' } },
      h('div', { class: 'kbx-row-between', style: { marginBottom: '8px' } }, h('span', { class: 'kbx-chip', dataset: { role: 'stepnum' } }, '#'), h('div', { class: 'kbx-row', style: { gap: '4px' } }, upBtn, downBtn, removeBtn)),
      h('div', { class: 'kbx-field-row', style: { marginBottom: '8px' } }, h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, kindSel), h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, keyI)),
      h('div', { class: 'kbx-field', style: { marginBottom: '8px' } }, titleI),
      processBlock,
      h('div', { class: 'kbx-field', style: { marginBottom: '8px' } }, bodyI),
      h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, entryI),
      row.transBlock);
    row.node = node;
    kindSel.addEventListener('change', () => syncKind(row));
    keyI.addEventListener('input', refreshTargets);
    titleI.addEventListener('input', refreshTargets);
    stepsHost.append(node);
    syncKind(row);
    processBlock.style.display = isProcessGenre() ? '' : 'none';
    if (isProcessGenre()) bodyI.placeholder = 'What happens at this hand-off, in the client\'s terms';
    renumber();
  }
  function syncKind(row) { row.transBlock.style.display = row.kindSel.value === 'end' ? 'none' : ''; }
  function addTransition(row, target, t) {
    const sel = h('select', { class: 'kbx-select', dataset: { role: 'transition-target' }, 'aria-label': 'Go to step' });
    const whenI = h('input', { class: 'kbx-input', dataset: { role: 'transition-when' }, placeholder: 'When… (condition, optional)', value: t && t.when ? t.when : '' });
    const limitI = h('input', { class: 'kbx-input', type: 'number', min: '1', step: '1', dataset: { role: 'transition-limit' }, placeholder: 'Max loops', value: t && t.limit != null ? String(t.limit) : '', style: { maxWidth: '110px' } });
    const tr = { target, sel, whenI, limitI };
    const delBtn = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', title: 'Remove transition', dataset: { role: 'remove-transition' }, onClick: () => dropTransition(row, tr) }, h('i', { class: 'bi bi-x-lg' }));
    tr.node = h('div', { class: 'kbx-row', dataset: { role: 'transition' }, style: { gap: '6px', marginTop: '6px' } }, h('i', { class: 'bi bi-arrow-return-right' }), sel, whenI, limitI, delBtn);
    sel.addEventListener('change', () => { tr.target = stepRows.find((r) => String(r.id) === sel.value) || null; });
    row.transitions.push(tr);
    row.transHost.append(tr.node);
    fillTargets(row, tr);
  }
  function dropTransition(row, tr) { const i = row.transitions.indexOf(tr); if (i >= 0) row.transitions.splice(i, 1); tr.node.remove(); }
  function rowLabel(r) {
    const key = r.keyI.value.trim(); const title = r.titleI.value.trim();
    return [`Step ${stepRows.indexOf(r) + 1}`, key, title.length > 40 ? `${title.slice(0, 39)}…` : title].filter(Boolean).join(' · ');
  }
  function fillTargets(row, tr) {
    clear(tr.sel);
    tr.sel.append(h('option', { value: '' }, 'Go to step…'));
    stepRows.filter((r) => r !== row).forEach((r) => tr.sel.append(h('option', { value: String(r.id) }, rowLabel(r))));
    tr.sel.value = tr.target ? String(tr.target.id) : '';
  }
  function refreshTargets() { stepRows.forEach((r) => r.transitions.forEach((tr) => fillTargets(r, tr))); }
  function removeStep(row) {
    const i = stepRows.indexOf(row); if (i < 0) return;
    const label = row.keyI.value.trim() || `Step ${i + 1}`;
    stepRows.splice(i, 1); row.node.remove();
    let dropped = 0;
    stepRows.forEach((r) => r.transitions.filter((tr) => tr.target === row).forEach((tr) => { dropTransition(r, tr); dropped++; }));
    if (dropped) mount(noticeHost, h('div', { class: 'kbx-alert warn', dataset: { role: 'transition-notice' }, style: { marginBottom: '10px' } }, h('i', { class: 'bi bi-info-circle' }), h('div', {}, `Removed ${dropped} transition${dropped === 1 ? '' : 's'} that pointed to ${label}.`)));
    renumber();
  }
  function renumber() { stepRows.forEach((r, i) => { const b = r.node.querySelector('[data-role="stepnum"]'); if (b) b.textContent = `Step ${i + 1}`; }); refreshTargets(); }
  function move(row, delta) {
    const i = stepRows.indexOf(row); const j = i + delta;
    if (j < 0 || j >= stepRows.length) return;
    stepRows.splice(i, 1); stepRows.splice(j, 0, row);
    stepsHost.insertBefore(row.node, stepRows[j + 1] ? stepRows[j + 1].node : null);
    renumber();
  }
  const seedSteps = seed.steps && seed.steps.length ? seed.steps : [null];
  seedSteps.forEach(addStep);
  seedTransitions(seedSteps);
  function seedTransitions(src) {
    stepRows.forEach((r) => {
      r.seedNext.forEach((t) => { const j = findStepIndex(src.filter(Boolean), t.to); addTransition(r, j >= 0 ? stepRows[j] : null, t); });
      delete r.seedNext;
    });
  }
  /** A transition target must be addressed by key; give a keyless target one. */
  function ensureKey(r, kept) {
    if (r.keyI.value.trim()) return;
    const taken = new Set(stepRows.map((x) => x.keyI.value.trim()));
    let n = kept.indexOf(r) + 1; while (taken.has(`step-${n}`)) n++;
    r.keyI.value = `step-${n}`;
  }
  function collectSteps() {
    const kept = stepRows.filter((r) => r.titleI.value.trim() || r.bodyI.value.trim());
    const live = (r) => r.kindSel.value !== 'end' ? r.transitions.filter((tr) => tr.target && kept.includes(tr.target)) : [];
    kept.forEach((r) => live(r).forEach((tr) => ensureKey(tr.target, kept)));
    return kept.map((r) => {
      const flat = {};
      Object.entries(r.processInputs).forEach(([field, input]) => { flat[field] = input.value; });
      const process = isProcessGenre() ? nestProcessFields(flat) : {};
      return cleanStep({
        title: r.titleI.value.trim(), body: r.bodyI.value.trim(), kb_entry_id: r.entryI.value.trim() || null,
        key: r.keyI.value, kind: r.kindSel.value,
        next: live(r).map((tr) => ({ to: tr.target.keyI.value.trim(), when: tr.whenI.value, limit: tr.limitI.value })),
        process,
      });
    });
  }

  const overlapHost = h('div', {});
  const body = h('div', {},
    prefill && !isEdit ? h('div', { class: 'kbx-alert info', style: { marginBottom: '14px' } }, h('i', { class: 'bi bi-magic' }), h('div', {}, h('strong', {}, 'Draft from an entry. '), 'Steps were split from the entry’s own sentences; merge, reorder and reword before saving. Step 1 links back to the source entry.')) : null,
    h('div', { class: 'kbx-field' }, h('label', {}, 'Kind'), genreSel, h('div', { class: 'kbx-hint' }, isEdit ? 'Kind is fixed once written.' : 'A playbook is the agent\'s own procedure; a process documents the client\'s flow and is never run.')),
    processNote,
    h('div', { class: 'kbx-field-row' },
      h('div', { class: 'kbx-field' }, h('label', {}, 'Slug'), slugInput, h('div', { class: 'kbx-hint' }, isEdit ? 'Slug is fixed for an existing record.' : 'Unique id, e.g. deploy-prod or product-return-processing.')),
      h('div', { class: 'kbx-field' }, h('label', {}, 'Status'), statusSel)),
    h('div', { class: 'kbx-field' }, h('label', {}, 'Title'), titleInput),
    h('div', { class: 'kbx-field' }, whenLabel, whenInput),
    h('div', { class: 'kbx-field' }, h('label', {}, 'Summary'), summaryInput),
    h('div', { class: 'kbx-row-between kbx-mt' }, h('h4', { style: { margin: 0, fontSize: '14px' } }, 'Steps'), h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', onClick: () => addStep(null) }, h('i', { class: 'bi bi-plus-lg' }), 'Add step')),
    h('div', { class: 'kbx-mt' }, noticeHost, stepsHost),
    h('div', { class: 'kbx-field kbx-mt' }, h('label', {}, 'Change note'), noteInput),
    overlapHost);

  syncGenre();
  const saveBtn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button' }, isEdit ? 'Save changes' : 'Create');
  const ref = openModal({ title: isEdit ? `Edit "${existing.title}"` : (prefill ? 'New playbook from entry' : 'New playbook or process'), wide: true, body, footer: [h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', onClick: () => ref.close() }, 'Cancel'), saveBtn] });

  async function doSave(force) {
    const slug = slugInput.value.trim();
    const title = titleInput.value.trim();
    const when = whenInput.value.trim();
    if (!slug) { toast('Slug is required', 'warning'); return; }
    if (title.length < 3) { toast('Title must be at least 3 characters', 'warning'); return; }
    if (when.length < 10) { toast(`“${isProcessGenre() ? 'About' : 'When to use'}” must be at least 10 characters`, 'warning'); return; }
    const steps = collectSteps();
    if (!steps.length) { toast('Add at least one step', 'warning'); return; }
    for (const s of steps) { if (!s.title || !s.body) { toast('Every step needs a title and body', 'warning'); return; } }
    if (isProcessGenre()) { const problem = processStepsProblem(steps); if (problem) { toast(problem, 'warning'); return; } }
    const payload = { title, when_to_use: when, summary: summaryInput.value.trim(), steps, status: statusSel.value, change_note: noteInput.value.trim(), changed_by: 'explorer', genre };
    clear(overlapHost);
    saveBtn.classList.add('is-loading');
    try {
      const result = await api.upsertPlaybook(slug, payload, force ? { force: true } : undefined);
      toast(isEdit ? 'Saved' : (isProcessGenre() ? 'Process documented' : 'Playbook created'), 'success');
      ref.close();
      if (onSaved) onSaved(result, slug);
    } catch (e) {
      saveBtn.classList.remove('is-loading');
      if (e.status === 409 && e.details) renderOverlap(e.details);
      else if (e.status === 422 || e.status === 400) renderInvalid(e);
      else toast(`Save failed: ${e.message}`, 'error');
    }
  }
  saveBtn.addEventListener('click', () => doSave(false));

  function renderInvalid(e) {
    mount(overlapHost, h('div', { class: 'kbx-alert danger kbx-mt', dataset: { role: 'save-error' } },
      h('i', { class: 'bi bi-exclamation-octagon' }),
      h('div', {}, h('div', { style: { fontWeight: '600' } }, 'The playbook was not saved'), h('div', {}, validationMessage(e)))));
    if (overlapHost.scrollIntoView) overlapHost.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderOverlap(details) {
    const cands = details.candidates || [];
    const forceBtn = h('button', { class: 'kbx-btn kbx-btn-danger', type: 'button', onClick: () => doSave(true) }, 'Save anyway (override)');
    mount(overlapHost, h('div', { class: 'kbx-alert warn kbx-mt' },
      h('i', { class: 'bi bi-exclamation-triangle' }),
      h('div', {},
        h('div', { style: { fontWeight: '600' } }, details.message || 'This playbook overlaps an existing one.'),
        h('div', { class: 'kbx-mt', style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          ...cands.map((c) => h('div', { class: 'kbx-row', style: { gap: '8px' } }, h('span', { class: 'kbx-chip danger' }, `${((c.similarity || c.score || 0) * 100).toFixed(0)}%`), h('span', { class: 'kbx-mono' }, c.slug), h('span', {}, c.title)))),
        h('div', { class: 'kbx-mt' }, forceBtn))));
    overlapHost.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

/** A readable message from a 422: the server's own message, or FastAPI's
    validation list ([{loc, msg}]) flattened to "loc: msg" lines. */
export function validationMessage(e) {
  const raw = e && e.message ? String(e.message) : 'Validation failed';
  if (!raw.startsWith('[')) return raw;
  try {
    const items = JSON.parse(raw);
    return items.map((it) => (it && it.msg ? `${(it.loc || []).filter((x) => x !== 'body').join('.')}: ${it.msg}` : JSON.stringify(it))).join('; ');
  } catch { return raw; }
}
