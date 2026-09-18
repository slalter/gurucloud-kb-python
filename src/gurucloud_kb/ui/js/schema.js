/* Schema view — the KB's dimension schema: dimensions table (with add/remove),
   categories, combination mode, and the dedup/MCP-return flags. Mirrors the
   SDK's get_schema / add_dimension / remove_dimension / validate_schema. */

import { h, mount, clear, toast, skeleton, empty } from './dom.js';
import { openModal, confirmModal } from './modal.js';

const TYPE_LABEL = { single: 'Single', multi: 'Multi', text_only: 'Text only' };
const MODE_LABEL = { weighted_sum: 'Weighted sum', weighted_product: 'Weighted product', max: 'Max', min: 'Min', custom: 'Custom SQL' };

export function createSchemaView(ctx) {
  const { api } = ctx;
  const el = h('div', {});
  let loaded = false;
  const host = h('div', {});
  mount(el, host);

  async function load() {
    mount(host, skeleton('Loading schema…'));
    let schema;
    try { schema = await api.getSchema(); }
    catch (e) { mount(host, h('div', { class: 'kbx-alert danger' }, `Could not load schema: ${e.message}`)); return; }
    ctx.setSchema(schema);
    render(schema);
  }

  function render(schema) {
    const dims = schema.dimensions || [];
    const table = h('table', { class: 'kbx-table' },
      h('thead', {}, h('tr', {},
        ...['Name', 'Display', 'Type', 'Required', 'Weight', 'Searchable', 'Aggregation', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...dims.map((d) => h('tr', {},
        h('td', {}, h('span', { class: 'kbx-mono kbx-strong' }, d.name)),
        h('td', {}, d.display_name || '—'),
        h('td', {}, h('span', { class: 'kbx-chip muted' }, TYPE_LABEL[d.dimension_type] || d.dimension_type)),
        h('td', {}, d.required ? h('span', { class: 'kbx-chip success' }, 'yes') : h('span', { class: 'kbx-muted' }, 'no')),
        h('td', { class: 'kbx-num' }, d.default_weight ?? '—'),
        h('td', {}, d.searchable !== false ? h('i', { class: 'bi bi-check-lg', style: { color: 'var(--kbx-success)' } }) : h('span', { class: 'kbx-muted' }, '—')),
        h('td', {}, d.dimension_type === 'multi' ? (d.aggregation || 'top_k_avg') : '—'),
        h('td', {}, h('button', { class: 'kbx-btn kbx-btn-danger kbx-btn-sm', type: 'button', title: 'Remove dimension', onClick: () => removeDim(d.name) }, h('i', { class: 'bi bi-trash' })))))));

    const cats = schema.categories || [];
    const catCard = h('div', { class: 'kbx-card' },
      h('div', { class: 'kbx-card-head' }, h('h3', { class: 'kbx-card-title' }, 'Categories')),
      cats.length ? h('div', { class: 'kbx-tags' }, ...cats.map((c) => h('span', { class: 'kbx-chip' }, c.display_name || c.tag, c.requires_proof ? ' · proof' : ''))) : h('div', { class: 'kbx-muted' }, 'No categories defined.'));

    const flags = h('div', { class: 'kbx-tiles' },
      tile('Combination mode', MODE_LABEL[schema.combination_mode] || schema.combination_mode || '—'),
      tile('Dedup updates', schema.allow_updates === false ? 'Disabled (accumulate)' : 'Enabled'),
      tile('File paths', schema.supports_file_paths ? 'Supported' : 'No'),
      tile('MCP return fields', (schema.mcp_response_fields && schema.mcp_response_fields.length) ? schema.mcp_response_fields.join(', ') : 'id + content'));

    mount(host,
      h('div', { class: 'kbx-card' },
        h('div', { class: 'kbx-card-head' },
          h('div', {}, h('h3', { class: 'kbx-card-title' }, 'Dimensions'), h('div', { class: 'kbx-card-sub' }, `${dims.length} dimension${dims.length === 1 ? '' : 's'} · schema v${schema.version ?? '?'}`)),
          h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button', onClick: () => openAddDim(schema) }, h('i', { class: 'bi bi-plus-lg' }), 'Add dimension')),
        h('div', { class: 'kbx-table-wrap' }, table)),
      catCard,
      h('div', { class: 'kbx-card' }, h('div', { class: 'kbx-card-head' }, h('h3', { class: 'kbx-card-title' }, 'Configuration')), flags));
  }

  function tile(label, value) {
    return h('div', { class: 'kbx-tile' }, h('div', { class: 'kbx-tile-label' }, label), h('div', { class: 'kbx-tile-value', style: { fontSize: '16px' } }, value));
  }

  async function removeDim(name) {
    const ok = await confirmModal({ title: 'Remove dimension', message: `Remove the "${name}" dimension from this KB's schema? Existing values for it are dropped. This cannot be undone.` });
    if (!ok) return;
    try { await api.removeDimension(name); toast(`Removed "${name}"`, 'success'); load(); }
    catch (e) { toast(`Remove failed: ${e.message}`, 'error'); }
  }

  function openAddDim() {
    const nameI = h('input', { class: 'kbx-input kbx-mono', placeholder: 'lower_snake_case' });
    const displayI = h('input', { class: 'kbx-input', placeholder: 'Display name' });
    const typeSel = h('select', { class: 'kbx-select' }, h('option', { value: 'single' }, 'Single'), h('option', { value: 'multi' }, 'Multi'), h('option', { value: 'text_only' }, 'Text only'));
    const descI = h('textarea', { class: 'kbx-textarea', rows: '2', placeholder: 'What this dimension holds' });
    const weightI = h('input', { class: 'kbx-input', type: 'number', step: '0.1', value: '1.0' });
    const maxItemsI = h('input', { class: 'kbx-input', type: 'number', value: '10' });
    const maxItemsField = h('div', { class: 'kbx-field kbx-hidden' }, h('label', {}, 'Max items'), maxItemsI);
    const requiredCb = h('input', { type: 'checkbox' });
    const searchableCb = h('input', { type: 'checkbox', checked: true });
    typeSel.addEventListener('change', () => maxItemsField.classList.toggle('kbx-hidden', typeSel.value !== 'multi'));

    const body = h('div', {},
      h('div', { class: 'kbx-field-row' },
        h('div', { class: 'kbx-field' }, h('label', {}, 'Name'), nameI, h('div', { class: 'kbx-hint' }, 'lowercase, starts with a letter')),
        h('div', { class: 'kbx-field' }, h('label', {}, 'Display name'), displayI)),
      h('div', { class: 'kbx-field-row' },
        h('div', { class: 'kbx-field' }, h('label', {}, 'Type'), typeSel),
        h('div', { class: 'kbx-field' }, h('label', {}, 'Default weight'), weightI)),
      maxItemsField,
      h('div', { class: 'kbx-field' }, h('label', {}, 'Description'), descI),
      h('div', { class: 'kbx-row' }, h('label', { class: 'kbx-check' }, requiredCb, 'Required'), h('label', { class: 'kbx-check' }, searchableCb, 'Searchable')));

    const saveBtn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button' }, 'Add dimension');
    const ref = openModal({ title: 'Add dimension', body, footer: [h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', onClick: () => ref.close() }, 'Cancel'), saveBtn] });
    saveBtn.addEventListener('click', async () => {
      const name = nameI.value.trim();
      if (!/^[a-z][a-z0-9_]*$/.test(name)) { toast('Name must be lower_snake_case, starting with a letter', 'warning'); return; }
      const payload = { name, display_name: displayI.value.trim() || name, description: descI.value.trim(), dimension_type: typeSel.value, default_weight: parseFloat(weightI.value) || 1.0, required: requiredCb.checked, searchable: searchableCb.checked };
      if (typeSel.value === 'multi') payload.max_items = parseInt(maxItemsI.value, 10) || 10;
      saveBtn.classList.add('is-loading');
      try { await api.addDimension(payload); toast(`Added "${name}"`, 'success'); ref.close(); load(); }
      catch (e) { toast(`Add failed: ${e.message}`, 'error'); saveBtn.classList.remove('is-loading'); }
    });
  }

  return {
    el,
    load() { if (!loaded) { loaded = true; load(); } },
    reload: load,
  };
}
