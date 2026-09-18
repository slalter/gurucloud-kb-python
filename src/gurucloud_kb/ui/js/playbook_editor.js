/* Playbook editor (create / edit) — shared by the Playbooks list, the playbook
   detail modal and "Promote to playbook" on an entry. Handles the overlap guard
   (409 playbook_overlap) by showing the conflicting playbooks and offering an
   explicit force-save. `prefill` seeds a NEW playbook (slug editable). */

import { h, mount, clear, toast } from './dom.js';
import { openModal } from './modal.js';

export function openPlaybookEditor(ctx, existing, { prefill = null, onSaved } = {}) {
  const { api } = ctx;
  const isEdit = !!existing;
  const seed = existing || prefill || {};
  const slugInput = h('input', { class: 'kbx-input kbx-mono', placeholder: 'lowercase-with-dashes', value: seed.slug || '' });
  if (isEdit) slugInput.setAttribute('readonly', '');
  const titleInput = h('input', { class: 'kbx-input', value: seed.title || '', placeholder: 'Human-readable name (3–200 chars)' });
  const whenInput = h('textarea', { class: 'kbx-textarea', rows: '3', placeholder: 'When should an agent reach for this? (min 10 chars — this is the retrieval key)' }, seed.when_to_use || '');
  const summaryInput = h('textarea', { class: 'kbx-textarea', rows: '2', placeholder: 'Optional one-line summary' }, seed.summary || '');
  const statusSel = h('select', { class: 'kbx-select' },
    h('option', { value: 'active' }, 'Active'), h('option', { value: 'draft' }, 'Draft'), h('option', { value: 'superseded' }, 'Superseded'));
  statusSel.value = seed.status || 'active';
  const noteInput = h('input', { class: 'kbx-input', placeholder: 'Change note (optional)', value: prefill && !isEdit ? 'created from entry in the explorer' : '' });

  const stepsHost = h('div', {});
  const stepRows = [];
  function addStep(step) {
    const titleI = h('input', { class: 'kbx-input', placeholder: 'Step title', value: step ? step.title || '' : '' });
    const bodyI = h('textarea', { class: 'kbx-textarea', rows: '3', placeholder: 'What to do in this step' }, step ? step.body || '' : '');
    const entryI = h('input', { class: 'kbx-input kbx-mono', placeholder: 'Linked KB entry id (optional)', value: step && step.kb_entry_id ? step.kb_entry_id : '' });
    const row = { titleI, bodyI, entryI };
    stepRows.push(row);
    const removeBtn = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', title: 'Remove step', onClick: () => { const i = stepRows.indexOf(row); if (i >= 0) stepRows.splice(i, 1); node.remove(); renumber(); } }, h('i', { class: 'bi bi-x-lg' }));
    const upBtn = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', title: 'Move up', onClick: () => move(row, -1) }, h('i', { class: 'bi bi-arrow-up' }));
    const downBtn = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', title: 'Move down', onClick: () => move(row, 1) }, h('i', { class: 'bi bi-arrow-down' }));
    const node = h('div', { class: 'kbx-card', style: { padding: '12px', marginBottom: '10px', background: 'var(--kbx-surface-2)', boxShadow: 'none' } },
      h('div', { class: 'kbx-row-between', style: { marginBottom: '8px' } }, h('span', { class: 'kbx-chip', dataset: { role: 'stepnum' } }, '#'), h('div', { class: 'kbx-row', style: { gap: '4px' } }, upBtn, downBtn, removeBtn)),
      h('div', { class: 'kbx-field', style: { marginBottom: '8px' } }, titleI),
      h('div', { class: 'kbx-field', style: { marginBottom: '8px' } }, bodyI),
      h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, entryI));
    row.node = node;
    stepsHost.append(node);
    renumber();
  }
  function renumber() { stepRows.forEach((r, i) => { const b = r.node.querySelector('[data-role="stepnum"]'); if (b) b.textContent = `Step ${i + 1}`; }); }
  function move(row, delta) {
    const i = stepRows.indexOf(row); const j = i + delta;
    if (j < 0 || j >= stepRows.length) return;
    stepRows.splice(i, 1); stepRows.splice(j, 0, row);
    stepsHost.insertBefore(row.node, stepRows[j + 1] ? stepRows[j + 1].node : null);
    renumber();
  }
  (seed.steps && seed.steps.length ? seed.steps : [null]).forEach(addStep);

  const overlapHost = h('div', {});
  const body = h('div', {},
    prefill && !isEdit ? h('div', { class: 'kbx-alert info', style: { marginBottom: '14px' } }, h('i', { class: 'bi bi-magic' }), h('div', {}, h('strong', {}, 'Draft from an entry. '), 'Steps were split from the entry’s own sentences; merge, reorder and reword before saving. Step 1 links back to the source entry.')) : null,
    h('div', { class: 'kbx-field-row' },
      h('div', { class: 'kbx-field' }, h('label', {}, 'Slug'), slugInput, h('div', { class: 'kbx-hint' }, isEdit ? 'Slug is fixed for an existing playbook.' : 'Unique id, e.g. deploy-prod.')),
      h('div', { class: 'kbx-field' }, h('label', {}, 'Status'), statusSel)),
    h('div', { class: 'kbx-field' }, h('label', {}, 'Title'), titleInput),
    h('div', { class: 'kbx-field' }, h('label', {}, 'When to use'), whenInput),
    h('div', { class: 'kbx-field' }, h('label', {}, 'Summary'), summaryInput),
    h('div', { class: 'kbx-row-between kbx-mt' }, h('h4', { style: { margin: 0, fontSize: '14px' } }, 'Steps'), h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', onClick: () => addStep(null) }, h('i', { class: 'bi bi-plus-lg' }), 'Add step')),
    h('div', { class: 'kbx-mt' }, stepsHost),
    h('div', { class: 'kbx-field kbx-mt' }, h('label', {}, 'Change note'), noteInput),
    overlapHost);

  const saveBtn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button' }, isEdit ? 'Save changes' : 'Create playbook');
  const ref = openModal({ title: isEdit ? `Edit "${existing.title}"` : (prefill ? 'New playbook from entry' : 'New playbook'), wide: true, body, footer: [h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', onClick: () => ref.close() }, 'Cancel'), saveBtn] });

  async function doSave(force) {
    const slug = slugInput.value.trim();
    const title = titleInput.value.trim();
    const when = whenInput.value.trim();
    if (!slug) { toast('Slug is required', 'warning'); return; }
    if (title.length < 3) { toast('Title must be at least 3 characters', 'warning'); return; }
    if (when.length < 10) { toast('“When to use” must be at least 10 characters', 'warning'); return; }
    const steps = stepRows.map((r) => ({ title: r.titleI.value.trim(), body: r.bodyI.value.trim(), kb_entry_id: r.entryI.value.trim() || null })).filter((s) => s.title || s.body);
    if (!steps.length) { toast('Add at least one step', 'warning'); return; }
    for (const s of steps) { if (!s.title || !s.body) { toast('Every step needs a title and body', 'warning'); return; } }
    const payload = { title, when_to_use: when, summary: summaryInput.value.trim(), steps, status: statusSel.value, change_note: noteInput.value.trim(), changed_by: 'explorer' };
    clear(overlapHost);
    saveBtn.classList.add('is-loading');
    try {
      const result = await api.upsertPlaybook(slug, payload, force ? { force: true } : undefined);
      toast(isEdit ? 'Playbook saved' : 'Playbook created', 'success');
      ref.close();
      if (onSaved) onSaved(result, slug);
    } catch (e) {
      saveBtn.classList.remove('is-loading');
      if (e.status === 409 && e.details) renderOverlap(e.details);
      else toast(`Save failed: ${e.message}`, 'error');
    }
  }
  saveBtn.addEventListener('click', () => doSave(false));

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
