/* Entry detail modal — shared by Entries, Map and playbook step links.
   Schema-aware: shows the kind badge, custom-dimension values and metadata a
   business or custom-schema bank carries, not just the default four fields.
   Actions: Edit · Promote to playbook · Delete. */

import { h, mount, toast, skeleton, splitList, fmtDate } from './dom.js';
import { openModal, confirmModal } from './modal.js';
import { customDims, dimsOf, kindOf, kindDim, knownValues } from './schema_utils.js';
import { entryToPlaybookDraft } from './promote.js';
import { openPlaybookEditor } from './playbook_editor.js';

const HIDDEN_META = new Set(['is_example', 'is_gotcha']);

export function kindChip(kind) {
  if (!kind) return null;
  return h('span', { class: `kbx-chip kind ${String(kind).toLowerCase().replace(/[^a-z0-9_-]/g, '')}` }, kind);
}

/** Chips for an entry's non-default embedded dimensions (stakeholders, scope…). */
export function dimensionRow(entry, schema) {
  const dims = entry && entry.dimensions && typeof entry.dimensions === 'object' ? entry.dimensions : null;
  if (!dims) return null;
  const names = new Map(customDims(schema).map((d) => [d.name, d.display_name || d.name]));
  const parts = [];
  Object.entries(dims).forEach(([name, value]) => {
    if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return;
    const label = names.get(name) || name;
    const vals = Array.isArray(value) ? value : [value];
    parts.push(h('span', {}, h('span', { class: 'kbx-dimname' }, `${label}:`), ...vals.slice(0, 8).map((v) => h('span', { class: 'kbx-tag' }, String(v)))));
  });
  return parts.length ? h('div', { class: 'kbx-dimrow' }, ...parts) : null;
}

export async function openEntryDetail(ctx, entryId, { onChanged } = {}) {
  const { api } = ctx;
  const ref = openModal({ title: 'Entry', body: skeleton('Loading entry…'), wide: true });
  let entry;
  try {
    entry = await api.getEntry(entryId);
  } catch (e) {
    ref.setBody(h('div', { class: 'kbx-alert danger' }, `Could not load entry: ${e.message}`));
    return;
  }
  const schema = ctx.getSchema();
  const meta = entry.metadata || {};
  const kind = kindOf(entry, schema);
  const chips = [kindChip(kind)];
  if (meta.is_example) chips.push(h('span', { class: 'kbx-chip info' }, 'Example'));
  if (meta.is_gotcha) chips.push(h('span', { class: 'kbx-chip warn' }, 'Gotcha'));
  if (meta.supersedes) chips.push(h('span', { class: 'kbx-chip muted' }, 'supersedes another entry'));

  const kv = h('dl', { class: 'kbx-kv' },
    h('dt', {}, 'Content'), h('dd', { style: { whiteSpace: 'pre-wrap' } }, entry.content || '—'),
    h('dt', {}, 'Useful for'), h('dd', { style: { whiteSpace: 'pre-wrap' } }, entry.useful_for || '—'));
  const dimRow = dimensionRow(entry, schema);
  if (dimRow) kv.append(h('dt', {}, 'Dimensions'), h('dd', {}, dimRow));
  kv.append(
    h('dt', {}, 'Systems'), h('dd', {}, (entry.relevant_systems || []).length ? tagWrap(entry.relevant_systems) : '—'),
    h('dt', {}, 'Tasks'), h('dd', {}, (entry.relevant_tasks || []).length ? tagWrap(entry.relevant_tasks) : '—'),
    h('dt', {}, 'Files'), h('dd', {}, (entry.relevant_file_paths || []).length ? h('div', { class: 'kbx-tags' }, ...entry.relevant_file_paths.map((f) => h('span', { class: 'kbx-tag kbx-mono' }, f))) : '—'),
    h('dt', {}, 'Source'), h('dd', {}, entry.source || '—'),
    h('dt', {}, 'Created'), h('dd', {}, fmtDate(entry.created_at)),
    h('dt', {}, 'Updated'), h('dd', {}, fmtDate(entry.updated_at)),
    h('dt', {}, 'Queried'), h('dd', {}, entry.query_count != null ? `${entry.query_count} time${entry.query_count === 1 ? '' : 's'}` : '—'),
    h('dt', {}, 'Entry ID'), h('dd', { class: 'kbx-mono', style: { fontSize: '12px' } }, entry.id));

  const kd = kindDim(schema);
  const extraMeta = Object.entries(meta).filter(([k]) => !HIDDEN_META.has(k) && !(kd && k === kd.name));
  const metaBlock = extraMeta.length
    ? h('details', { class: 'kbx-mt' }, h('summary', { class: 'kbx-muted', style: { cursor: 'pointer', fontSize: '13px' } }, `Metadata (${extraMeta.length})`),
        h('pre', { class: 'kbx-code kbx-mt', style: { whiteSpace: 'pre-wrap' } }, JSON.stringify(Object.fromEntries(extraMeta), null, 2)))
    : null;

  ref.setBody(h('div', {},
    chips.some(Boolean) ? h('div', { class: 'kbx-row', style: { gap: '6px', marginBottom: '12px' } }, ...chips) : null,
    kv, metaBlock));

  const editBtn = h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', onClick: () => { ref.close(); openEditModal(ctx, entry, onChanged); } }, h('i', { class: 'bi bi-pencil' }), 'Edit');
  const promoteBtn = h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', title: 'Turn this entry into an ordered procedure agents retrieve whole', onClick: () => {
    ref.close();
    openPlaybookEditor(ctx, null, {
      prefill: entryToPlaybookDraft(entry),
      onSaved: () => { toast('Playbook created from entry', 'success'); if (ctx.activate) ctx.activate('playbooks'); },
    });
  } }, h('i', { class: 'bi bi-journal-plus' }), 'Promote to playbook');
  const delBtn = h('button', { class: 'kbx-btn kbx-btn-danger', type: 'button', onClick: async () => {
    const ok = await confirmModal({ title: 'Delete entry', message: 'Permanently delete this entry from the Knowledge Bank? This cannot be undone.' });
    if (!ok) return;
    try { await api.deleteEntry(entry.id); toast('Entry deleted', 'success'); ref.close(); if (onChanged) onChanged('deleted', entry); ctx.refreshInfo(); }
    catch (e) { toast(`Delete failed: ${e.message}`, 'error'); }
  } }, h('i', { class: 'bi bi-trash' }), 'Delete');
  ref.setFoot([editBtn, promoteBtn, delBtn]);
}

function tagWrap(list) { return h('div', { class: 'kbx-tags' }, ...list.map((s) => h('span', { class: 'kbx-tag' }, s))); }

export function openEditModal(ctx, entry, onChanged) {
  const { api } = ctx;
  const schema = ctx.getSchema();
  const contentTa = h('textarea', { class: 'kbx-textarea', rows: '5' }, entry.content || '');
  const usefulTa = h('textarea', { class: 'kbx-textarea', rows: '2' }, entry.useful_for || '');
  const systemsInput = h('input', { class: 'kbx-input', value: (entry.relevant_systems || []).join(', ') });
  const tasksInput = h('input', { class: 'kbx-input', value: (entry.relevant_tasks || []).join(', ') });
  const names = dimsOf(schema).map((d) => d.name);
  const hasSystems = names.includes('relevant_systems');
  const hasTasks = names.includes('relevant_tasks');
  const body = h('div', {},
    h('div', { class: 'kbx-field' }, h('label', {}, 'Content'), contentTa),
    h('div', { class: 'kbx-field' }, h('label', {}, 'Useful for'), usefulTa),
    hasSystems ? h('div', { class: 'kbx-field' }, h('label', {}, 'Systems'), systemsInput) : null,
    hasTasks ? h('div', { class: 'kbx-field' }, h('label', {}, 'Tasks'), tasksInput) : null,
    h('div', { class: 'kbx-hint' }, 'Content and useful-for are re-embedded on save. Systems/tasks are replaced with the values above.'));
  const saveBtn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button' }, 'Save changes');
  const ref = openModal({ title: 'Edit entry', body, footer: [h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', onClick: () => ref.close() }, 'Cancel'), saveBtn] });
  saveBtn.addEventListener('click', async () => {
    const updates = { update_content: contentTa.value.trim(), update_useful_for: usefulTa.value.trim() };
    if (hasSystems) updates.replace_systems = splitList(systemsInput.value);
    if (hasTasks) updates.replace_tasks = splitList(tasksInput.value);
    saveBtn.classList.add('is-loading');
    try { await api.updateEntry(entry.id, updates); toast('Entry updated', 'success'); ref.close(); if (onChanged) onChanged('updated', entry); }
    catch (e) { toast(`Update failed: ${e.message}`, 'error'); saveBtn.classList.remove('is-loading'); }
  });
}

/** Add-entry modal built from the schema: single → textarea, multi → comma
    list, text_only → input with the known values as suggestions. */
export function openAddModal(ctx, knownEntries, onAdded) {
  const { api } = ctx;
  const schema = ctx.getSchema();
  const fields = {};
  const body = h('div', {});
  dimsOf(schema).forEach((d) => {
    let input;
    if (d.dimension_type === 'multi') {
      input = h('input', { class: 'kbx-input', type: 'text', placeholder: 'comma, separated, values' });
    } else if (d.dimension_type === 'text_only') {
      const listId = `kbx-dl-${d.name}`;
      input = h('input', { class: 'kbx-input', type: 'text', list: listId, placeholder: d.name === 'kind' ? 'decision, commitment, constraint, process, preference, gap' : 'exact-match value' });
      body.append(h('datalist', { id: listId }, ...knownValues(knownEntries, d).map((v) => h('option', { value: v }))));
    } else {
      input = h('textarea', { class: 'kbx-textarea', rows: d.name === 'content' ? '4' : '2' });
    }
    fields[d.name] = { input, dim: d };
    body.append(h('div', { class: 'kbx-field' },
      h('label', {}, d.display_name || d.name, d.required ? h('span', { style: { color: 'var(--kbx-danger)' } }, ' *') : null,
        d.dimension_type === 'text_only' ? h('span', { class: 'kbx-chip muted', style: { marginLeft: '6px' } }, 'exact match') : d.dimension_type === 'multi' ? h('span', { class: 'kbx-chip muted', style: { marginLeft: '6px' } }, 'multi') : null),
      input,
      d.description ? h('div', { class: 'kbx-hint' }, d.description) : null));
  });
  const filesInput = h('input', { class: 'kbx-input', type: 'text', placeholder: 'path/one.py, path/two.py' });
  body.append(h('div', { class: 'kbx-field' }, h('label', {}, 'Related files'), filesInput));
  const cats = (schema && schema.categories) || [];
  const catChecks = {};
  if (cats.length) {
    const row = h('div', { class: 'kbx-row' });
    cats.forEach((c) => {
      const cb = h('input', { type: 'checkbox' });
      catChecks[c.tag] = cb;
      row.append(h('label', { class: 'kbx-check' }, cb, c.display_name || c.tag));
    });
    body.append(h('div', { class: 'kbx-field' }, h('label', {}, 'Categories'), row));
  }
  const saveBtn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button' }, 'Add entry');
  const ref = openModal({ title: 'Add entry', body, footer: [h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', onClick: () => ref.close() }, 'Cancel'), saveBtn] });
  saveBtn.addEventListener('click', async () => {
    const dimensions = {};
    for (const [name, { input, dim }] of Object.entries(fields)) {
      const raw = input.value.trim();
      if (!raw) continue;
      dimensions[name] = dim.dimension_type === 'multi' ? splitList(raw) : raw;
    }
    const required = dimsOf(schema).filter((d) => d.required).map((d) => d.name);
    const missing = (required.length ? required : ['content']).filter((n) => !dimensions[n]);
    if (missing.length) { toast(`${missing.join(', ')} required`, 'warning'); return; }
    const metadata = {};
    Object.entries(catChecks).forEach(([tag, cb]) => { if (cb.checked) metadata[`is_${tag}`] = true; });
    const payload = { dimensions, relevant_file_paths: splitList(filesInput.value), metadata, source: 'explorer' };
    saveBtn.classList.add('is-loading');
    try { await api.addEntry(payload); toast('Entry added', 'success'); ref.close(); if (onAdded) onAdded(); ctx.refreshInfo(); }
    catch (e) { toast(`Add failed: ${e.message}`, 'error'); saveBtn.classList.remove('is-loading'); }
  });
}
