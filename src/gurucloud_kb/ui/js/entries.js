/* Entries view — browse, multi-dimensional semantic search, exact-match
   filters, detail, add, edit, delete.

   Schema-aware end to end: semantic dimensions become weighted search inputs;
   TEXT_ONLY dimensions (a business bank's `kind`, or any custom exact-match
   field) become selects that go out as metadata_filters and as filter chips
   over the loaded list; cards show the kind badge and custom-dimension chips.
   A default code KB (four dims, no text-only) renders exactly as before. */

import { h, mount, clear, toast, skeleton, empty, meter } from './dom.js';
import { openEntryDetail, openAddModal, kindChip, dimensionRow } from './entry_detail.js';
import { semanticDims, textOnlyDims, kindDim, knownValues, observedValues, kindOf, truncate } from './schema_utils.js';
import { entriesCountLabel } from './stats_view.js';

export function createEntriesView(ctx) {
  const { api } = ctx;
  const el = h('div', {});
  let loaded = false;
  let lastResults = [];
  let showingScores = false;
  let searching = false;
  let activeChip = null; // { dim, value } | { category } | null

  const resultsHost = h('div', {});
  const countLabel = h('div', { class: 'kbx-muted', style: { fontSize: '13px' } }, '');
  const chipsHost = h('div', { class: 'kbx-filter-chips', style: { marginBottom: '12px' } });

  // ── search card ──────────────────────────────────────────────────────────
  const searchInputs = h('div', { class: 'kbx-grid cols-2' });
  const filterInputs = h('div', { class: 'kbx-grid cols-3', style: { marginTop: '10px' } });
  const modeSelect = h('select', { class: 'kbx-select' },
    h('option', { value: 'weighted_sum' }, 'Weighted sum'),
    h('option', { value: 'max' }, 'Best single match'),
    h('option', { value: 'min' }, 'All must match'));
  const limitInput = h('input', { class: 'kbx-input', type: 'number', min: '1', max: '200', value: '20' });
  const thresholdInput = h('input', { class: 'kbx-input', type: 'number', min: '0', max: '1', step: '0.05', value: '0' });

  function buildSearchInputs() {
    const schema = ctx.getSchema();
    clear(searchInputs);
    semanticDims(schema).forEach((d) => {
      const input = h('input', { class: 'kbx-input', type: 'text', placeholder: `Search ${d.display_name || d.name}…`, dataset: { dim: d.name } });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
      searchInputs.append(h('div', { class: 'kbx-field', style: { marginBottom: 0 } },
        h('label', {}, d.display_name || d.name,
          d.dimension_type === 'multi' ? h('span', { class: 'kbx-chip muted', style: { marginLeft: '6px' } }, 'multi') : null,
          d.default_weight != null && d.default_weight !== 1 ? h('span', { class: 'kbx-chip muted', style: { marginLeft: '6px' } }, `w ${d.default_weight}`) : null),
        input));
    });
    clear(filterInputs);
    const tos = textOnlyDims(schema);
    tos.forEach((d) => {
      const sel = h('select', { class: 'kbx-select', dataset: { filterDim: d.name } }, h('option', { value: '' }, `Any ${d.display_name || d.name}`));
      knownValues(lastResults, d).forEach((v) => sel.append(h('option', { value: v }, v)));
      sel.addEventListener('change', runSearch);
      filterInputs.append(h('div', { class: 'kbx-field', style: { marginBottom: 0 } },
        h('label', {}, d.display_name || d.name, h('span', { class: 'kbx-chip muted', style: { marginLeft: '6px' } }, 'exact match')), sel));
    });
    filterInputs.style.display = tos.length ? '' : 'none';
  }

  const searchBtn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button', onClick: runSearch }, h('i', { class: 'bi bi-search' }), 'Search');
  const clearBtn = h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', onClick: () => {
    searchInputs.querySelectorAll('input').forEach((i) => (i.value = ''));
    filterInputs.querySelectorAll('select').forEach((s) => (s.value = ''));
    activeChip = null; loadEntries();
  } }, 'Clear');
  const addBtn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button', onClick: () => openAddModal(ctx, lastResults, loadEntries) }, h('i', { class: 'bi bi-plus-lg' }), 'Add entry');

  const searchCard = h('div', { class: 'kbx-card' },
    h('div', { class: 'kbx-card-head' }, h('h3', { class: 'kbx-card-title' }, 'Semantic search'),
      h('div', { class: 'kbx-row' },
        h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, h('label', {}, 'Mode'), modeSelect),
        h('div', { class: 'kbx-field', style: { marginBottom: 0, width: '80px' } }, h('label', {}, 'Limit'), limitInput),
        h('div', { class: 'kbx-field', style: { marginBottom: 0, width: '90px' } }, h('label', {}, 'Min score'), thresholdInput))),
    searchInputs,
    filterInputs,
    h('div', { class: 'kbx-row kbx-mt' }, searchBtn, clearBtn));

  const listCard = h('div', { class: 'kbx-card' },
    h('div', { class: 'kbx-card-head' }, countLabel, addBtn),
    chipsHost,
    resultsHost);

  mount(el, searchCard, listCard);

  // ── loading ──────────────────────────────────────────────────────────────
  function limitVal(max) { return Math.max(1, Math.min(parseInt(limitInput.value, 10) || 20, max)); }

  async function loadEntries() {
    mount(resultsHost, skeleton('Loading entries…'));
    try {
      const data = await api.listEntries({ limit: limitVal(200), offset: 0 });
      lastResults = Array.isArray(data) ? data : (data.entries || data.data || []);
      showingScores = false;
      refreshFilterOptions();
      render();
    } catch (e) {
      mount(resultsHost, h('div', { class: 'kbx-alert danger' }, `Could not load entries: ${e.message}`));
      countLabel.textContent = '';
    }
  }

  function currentFilters() {
    const filters = {};
    filterInputs.querySelectorAll('select[data-filter-dim]').forEach((s) => { if (s.value) filters[s.dataset.filterDim] = s.value; });
    return filters;
  }

  async function runSearch() {
    const dimensions = {};
    searchInputs.querySelectorAll('input[data-dim]').forEach((i) => {
      const val = i.value.trim();
      if (val) dimensions[i.dataset.dim] = { query_text: val };
    });
    const filters = currentFilters();
    if (!Object.keys(dimensions).length) {
      // Exact-match filters alone: the service needs a semantic dimension, so
      // list and filter client-side instead of hitting its ValueError path.
      if (Object.keys(filters).length) {
        mount(resultsHost, skeleton('Filtering…'));
        try {
          const data = await api.listEntries({ limit: 200, offset: 0 });
          const all = Array.isArray(data) ? data : (data.entries || data.data || []);
          lastResults = all.filter((e) => Object.entries(filters).every(([k, v]) => e.metadata && String(e.metadata[k]) === v));
          showingScores = false; activeChip = null; render();
        } catch (e) { mount(resultsHost, h('div', { class: 'kbx-alert danger' }, `Filter failed: ${e.message}`)); }
        return;
      }
      loadEntries(); return;
    }
    if (searching) return;
    searching = true; searchBtn.classList.add('is-loading');
    mount(resultsHost, skeleton('Searching…'));
    try {
      const payload = { dimensions, k: limitVal(100), threshold: parseFloat(thresholdInput.value) || 0, combination_mode: modeSelect.value };
      if (Object.keys(filters).length) payload.metadata_filters = filters;
      const data = await api.search(payload);
      lastResults = Array.isArray(data) ? data : (data.results || data.entries || []);
      showingScores = true; activeChip = null;
      render();
    } catch (e) {
      mount(resultsHost, h('div', { class: 'kbx-alert danger' }, `Search failed: ${e.message}`));
    } finally {
      searching = false; searchBtn.classList.remove('is-loading');
    }
  }

  function refreshFilterOptions() {
    filterInputs.querySelectorAll('select[data-filter-dim]').forEach((sel) => {
      const dim = textOnlyDims(ctx.getSchema()).find((d) => d.name === sel.dataset.filterDim);
      const keep = sel.value;
      while (sel.options.length > 1) sel.remove(1);
      knownValues(lastResults, dim).forEach((v) => sel.append(h('option', { value: v }, v)));
      sel.value = keep;
    });
  }

  // ── rendering ──────────────────────────────────────────────────────────────
  function visible() {
    if (!activeChip) return lastResults;
    if (activeChip.category) return lastResults.filter((e) => e.metadata && e.metadata[`is_${activeChip.category}`]);
    return lastResults.filter((e) => e.metadata && String(e.metadata[activeChip.dim]) === activeChip.value);
  }

  function render() {
    renderChips();
    const entries = visible();
    const schema = ctx.getSchema();
    const info = ctx.getInfo ? ctx.getInfo() : null;
    countLabel.textContent = entriesCountLabel({
      shown: entries.length, loaded: lastResults.length, showingScores,
      total: info ? info.entry_count : null,
    });
    if (!entries.length) {
      mount(resultsHost, empty('bi-inbox', showingScores ? 'No matches' : 'No entries', showingScores ? 'Try broadening your query or lowering the min score.' : (activeChip ? 'Nothing in the loaded set matches this filter.' : 'Add the first entry to this Knowledge Bank.')));
      return;
    }
    const list = h('div', { class: 'kbx-list' });
    entries.forEach((entry) => list.append(entryCard(entry, schema)));
    mount(resultsHost, list);
  }

  function renderChips() {
    clear(chipsHost);
    const schema = ctx.getSchema();
    const kd = kindDim(schema);
    const chips = [];
    if (kd) {
      observedValues(lastResults, kd.name).forEach(({ value, count }) => chips.push(chip(value, count, { dim: kd.name, value })));
    }
    ((schema && schema.categories) || []).forEach((c) => {
      const n = lastResults.filter((e) => e.metadata && e.metadata[`is_${c.tag}`]).length;
      if (n) chips.push(chip(c.display_name || c.tag, n, { category: c.tag }));
    });
    if (!chips.length) { chipsHost.style.display = 'none'; return; }
    chipsHost.style.display = '';
    chipsHost.append(chip('All', lastResults.length, null), ...chips);
  }
  function chip(label, count, target) {
    const active = target === null ? !activeChip : (activeChip && ((target.dim && activeChip.dim === target.dim && activeChip.value === target.value) || (target.category && activeChip.category === target.category)));
    return h('button', { class: `kbx-filter-chip${active ? ' is-active' : ''}`, type: 'button', onClick: () => { activeChip = target; render(); } }, label, h('span', { class: 'kbx-count' }, String(count)));
  }

  function entryCard(entry, schema) {
    const meta = entry.metadata || {};
    const chips = [kindChip(kindOf(entry, schema))];
    if (meta.is_example) chips.push(h('span', { class: 'kbx-chip info' }, 'Example'));
    if (meta.is_gotcha) chips.push(h('span', { class: 'kbx-chip warn' }, 'Gotcha'));
    if (showingScores && entry.combined_score !== undefined) chips.push(h('span', { class: 'kbx-chip' }, `${(entry.combined_score * 100).toFixed(0)}%`));
    const tags = [];
    (entry.relevant_systems || []).slice(0, 6).forEach((s) => tags.push(h('span', { class: 'kbx-tag' }, s)));
    (entry.relevant_tasks || []).slice(0, 6).forEach((t) => tags.push(h('span', { class: 'kbx-tag' }, t)));

    return h('div', { class: 'kbx-item', dataset: { entryId: entry.id }, onClick: () => openEntryDetail(ctx, entry.id, { onChanged: () => (showingScores ? runSearch() : loadEntries()) }) },
      h('div', { class: 'kbx-item-head' },
        h('div', { class: 'kbx-row', style: { gap: '6px' } }, ...chips),
        h('span', { class: 'kbx-mono kbx-muted', style: { fontSize: '11px' } }, String(entry.id || '').slice(0, 8))),
      h('div', { class: 'kbx-item-body' }, truncate(entry.content, 320)),
      entry.useful_for ? h('div', { class: 'kbx-item-body kbx-muted kbx-mt', style: { fontSize: '13px' } }, h('strong', {}, 'Useful for: '), truncate(entry.useful_for, 200)) : null,
      dimensionRow(entry, schema),
      showingScores ? scoreBlock(entry) : null,
      tags.length ? h('div', { class: 'kbx-tags kbx-mt' }, ...tags) : null);
  }

  function scoreBlock(entry) {
    const rows = [];
    const dm = entry.dimension_scores || {};
    Object.keys(dm).forEach((k) => { if (dm[k] > 0) rows.push(scoreRow(k, dm[k])); });
    if (!rows.length) {
      if (entry.content_score) rows.push(scoreRow('content', entry.content_score));
      if (entry.useful_for_score) rows.push(scoreRow('useful_for', entry.useful_for_score));
    }
    if (entry.combined_score !== undefined) rows.push(scoreRow('combined', entry.combined_score, true));
    if (!rows.length) return null;
    return h('div', { class: 'kbx-mt', style: { paddingTop: '8px', borderTop: '1px dashed var(--kbx-border)' } }, ...rows);
  }
  function scoreRow(name, val, strong) {
    return h('div', { class: 'kbx-score-row' },
      h('span', { class: 'kbx-score-name', style: strong ? { fontWeight: '600', color: 'var(--kbx-heading)' } : {} }, name),
      meter(val),
      h('span', { class: 'kbx-score-val' }, (val * 100).toFixed(0) + '%'));
  }

  return {
    el,
    load() {
      buildSearchInputs();
      if (!loaded) { loaded = true; loadEntries(); }
    },
    reload() { buildSearchInputs(); loadEntries(); },
  };
}
