/* Entries view — browse, multi-dimensional semantic search, exact-match
   filters, detail, add, edit, delete.

   Schema-aware end to end: semantic dimensions become weighted search inputs;
   TEXT_ONLY dimensions (a business bank's `kind`, or any custom exact-match
   field) become selects that go out as metadata_filters and as filter chips
   over the loaded list; cards show the kind badge and custom-dimension chips.
   A default code KB (four dims, no text-only) renders exactly as before.

   Data-aware too: a Filters panel built from GET /metadata-facets (the
   metadata keys the entries REALLY carry, their top values, the `source`
   column) plus a created-date range. Every filter is applied server-side on
   all three paths — browsing (GET /entries), plain search (POST /search) and
   LLM-powered search (POST /search/expanded) — see facet_filters.js.
   The panel also has a key finder (type part of a key name to get its
   select) and a "who acted on it" row for the *_by keys, so a bank with
   100+ metadata keys still answers "show me what X approved" in one pick.

   Multi-select: every card has a checkbox; the bulk bar deletes the selected
   entries or sets one metadata key on all of them through the per-entry API
   (see bulk_model.js). */

import { h, mount, clear, toast, skeleton, empty, meter } from './dom.js';
import { openModal, confirmModal } from './modal.js';
import { actorFacets, collapsedFiltersCaption, findFacetKeys, readFiltersOpenPref, writeFiltersOpenPref } from './facet_filters.js';
import { allVisibleSelected, bulkMetadataPatch, bulkSummary, pruneSelection, runBulk, selectAllVisible, toggleSelected } from './bulk_model.js';
import { openEntryDetail, openAddModal, kindChip, dimensionRow } from './entry_detail.js';
import { semanticDims, textOnlyDims, kindDim, knownValues, observedValues, kindOf, truncate } from './schema_utils.js';
import { entriesCountLabel } from './stats_view.js';
import { buildExpandedPayload, expansionSummary, readLlmSearchPref, readSpeedPref, writeLlmSearchPref, writeSpeedPref } from './llm_search.js';
import {
  DEFAULT_MAX_VALUES, activeFilterChips, emptyFilterState, facetValueLabel, facetsCaption, hasActiveFilters,
  listParams, rankFacets, removeFilter, searchFilterFields, splitPrimary,
} from './facet_filters.js';

export function createEntriesView(ctx) {
  const { api } = ctx;
  const el = h('div', {});
  let loaded = false;
  let lastResults = [];
  let showingScores = false;
  let searching = false;
  let activeChip = null; // { dim, value } | { category } | null
  let facets = null;      // /metadata-facets payload, null until loaded or when unavailable
  let filterState = emptyFilterState();
  const openKeys = new Set(); // facet keys shown as selects beyond the primary ones
  let keyQuery = '';          // the key finder's text
  let selection = new Set();  // selected entry ids (bulk actions)

  const resultsHost = h('div', {});
  const expansionHost = h('div', {});
  const countLabel = h('div', { class: 'kbx-muted', style: { fontSize: '13px' } }, '');
  const chipsHost = h('div', { class: 'kbx-filter-chips', style: { marginBottom: '12px' } });
  const activeHost = h('div', { class: 'kbx-filter-chips', style: { marginBottom: '12px' } });

  // ── search card ──────────────────────────────────────────────────────────
  const searchInputs = h('div', { class: 'kbx-grid cols-2' });
  const filterInputs = h('div', { class: 'kbx-grid cols-3', style: { marginTop: '10px' } });
  const modeSelect = h('select', { class: 'kbx-select' },
    h('option', { value: 'weighted_sum' }, 'Weighted sum'),
    h('option', { value: 'max' }, 'Best single match'),
    h('option', { value: 'min' }, 'All must match'));
  const limitInput = h('input', { class: 'kbx-input', type: 'number', min: '1', max: '200', value: '20' });
  const thresholdInput = h('input', { class: 'kbx-input', type: 'number', min: '0', max: '1', step: '0.05', value: '0' });

  // LLM-powered search (expanded search): off by default, remembered per bank.
  function storage() { try { return window.localStorage; } catch { return null; } }
  const llmCb = h('input', { type: 'checkbox' });
  llmCb.checked = readLlmSearchPref(storage(), api.kbId);
  const llmInput = h('input', { class: 'kbx-input', type: 'text', placeholder: 'Describe what you are looking for…' });
  llmInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  const speedSelect = h('select', { class: 'kbx-select', title: 'Fast: about 1 second. Thorough: about 3 seconds, a larger model that reasons first. Quality measured equal within noise.' },
    h('option', { value: 'fast' }, 'Fast'),
    h('option', { value: 'thorough' }, 'Thorough'));
  speedSelect.value = readSpeedPref(storage(), api.kbId);
  speedSelect.addEventListener('change', () => writeSpeedPref(storage(), api.kbId, speedSelect.value));
  const llmField = h('div', { class: 'kbx-row', style: { alignItems: 'flex-end', gap: '10px' } },
    h('div', { class: 'kbx-field', style: { marginBottom: 0, flex: '1 1 auto' } },
      h('label', {}, 'Query', h('span', { class: 'kbx-chip muted', style: { marginLeft: '6px' } }, 'LLM fills every dimension')),
      llmInput),
    h('div', { class: 'kbx-field', style: { marginBottom: 0, width: '130px' } }, h('label', {}, 'Speed'), speedSelect));
  const modeField = h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, h('label', {}, 'Mode'), modeSelect);
  function applyLlmMode() {
    const on = llmCb.checked;
    searchInputs.style.display = on ? 'none' : '';
    llmField.style.display = on ? '' : 'none';
    modeField.style.display = on ? 'none' : '';
    if (!on) clear(expansionHost);
  }
  llmCb.addEventListener('change', () => { writeLlmSearchPref(storage(), api.kbId, llmCb.checked); applyLlmMode(); });

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
    llmInput.value = ''; clear(expansionHost);
    filterState = emptyFilterState(); openKeys.clear(); keyQuery = ''; buildFilterPanel();
    activeChip = null; loadEntries();
  } }, 'Clear');
  const addBtn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button', onClick: () => openAddModal(ctx, lastResults, loadEntries) }, h('i', { class: 'bi bi-plus-lg' }), 'Add entry');

  // ── filters panel (from /metadata-facets) ────────────────────────────────
  // Collapsible: the panel is tall, so it starts closed (remembered per bank)
  // and the header line says how many keys there are and how many filters
  // are active; the removable chips stay visible above the list either way.
  const facetInputs = h('div', { class: 'kbx-grid cols-3' });
  const facetCaption = h('p', { class: 'kbx-card-sub' }, facetsCaption(null));
  const facetActiveBadge = h('span', { class: 'kbx-chip', dataset: { role: 'filters-active-count' }, style: { marginLeft: '8px', display: 'none' } }, '');
  const facetChevron = h('i', { class: 'bi bi-chevron-down', dataset: { role: 'filters-chevron' }, style: { transition: 'transform .15s' } });
  const facetToggle = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', dataset: { role: 'filters-toggle' }, 'aria-expanded': 'false' }, 'Show filters');
  let filtersOpen = readFiltersOpenPref(storage(), api.kbId);
  const facetHead = h('div', { class: 'kbx-card-head kbx-card-head-toggle', title: 'Show or hide the filters', dataset: { role: 'filters-head' } },
    h('div', {}, h('h3', { class: 'kbx-card-title' }, 'Filters', h('span', { class: 'kbx-chip muted', style: { marginLeft: '8px' } }, 'from the data'), facetActiveBadge), facetCaption),
    h('div', { class: 'kbx-row', style: { gap: '8px', alignItems: 'center' } }, facetToggle, facetChevron));
  const facetCard = h('div', { class: 'kbx-card', dataset: { role: 'facet-filters' } }, facetHead, facetInputs);
  function applyFiltersOpen() {
    facetCard.classList.toggle('is-collapsed', !filtersOpen);
    facetInputs.style.display = filtersOpen ? '' : 'none';
    facetToggle.textContent = filtersOpen ? 'Hide filters' : 'Show filters';
    facetToggle.setAttribute('aria-expanded', filtersOpen ? 'true' : 'false');
    facetChevron.style.transform = filtersOpen ? 'rotate(180deg)' : '';
    const active = activeFilterChips(filterState).length;
    facetActiveBadge.textContent = active ? `${active} active` : '';
    facetActiveBadge.style.display = active ? '' : 'none';
    facetCaption.textContent = filtersOpen ? facetsCaption(facets) : collapsedFiltersCaption(facets, filterState);
  }
  function setFiltersOpen(open) { filtersOpen = !!open; writeFiltersOpenPref(storage(), api.kbId, filtersOpen); applyFiltersOpen(); }
  facetHead.addEventListener('click', (e) => { if (e.target.closest('select, input')) return; setFiltersOpen(!filtersOpen); });

  function textOnlyNames() { return textOnlyDims(ctx.getSchema()).map((d) => d.name); }

  function setMetadataFilter(key, sel) {
    const cur = filterState.metadata[key];
    const same = sel && sel.value !== ''
      ? !!cur && cur.value === sel.value && cur.type === sel.type && !!cur.in_list === !!sel.in_list
      : !cur;
    if (same) return; // the free-text input fires keydown(Enter) and change for one pick
    const next = { ...filterState, metadata: { ...filterState.metadata } };
    if (sel && sel.value !== '') next.metadata[key] = sel; else delete next.metadata[key];
    filterState = next;
    runSearch();
  }

  function facetSelect(facet) {
    const current = filterState.metadata[facet.key];
    const sel = h('select', { class: 'kbx-select', dataset: { facetKey: facet.key } }, h('option', { value: '' }, `Any ${facet.key}`));
    facet.values.forEach((v, i) => sel.append(h('option', { value: String(i) }, facetValueLabel(v))));
    sel.append(h('option', { value: '__other__' }, 'Other value…'));
    if (current) {
      const idx = facet.values.findIndex((v) => v.value === current.value && v.type === current.type && !!v.in_list === !!current.in_list);
      sel.value = idx >= 0 ? String(idx) : '__other__';
    }
    const other = h('input', { class: 'kbx-input', type: 'text', placeholder: `Exact ${facet.key} value`, style: { marginTop: '6px', display: current && sel.value === '__other__' ? '' : 'none' } });
    if (current && sel.value === '__other__') other.value = String(current.value);
    other.addEventListener('keydown', (e) => { if (e.key === 'Enter') setMetadataFilter(facet.key, other.value.trim() ? { value: other.value.trim(), type: facet.valueType, in_list: facet.has_list_values && !facet.values.some((v) => !v.in_list) } : null); });
    other.addEventListener('change', () => setMetadataFilter(facet.key, other.value.trim() ? { value: other.value.trim(), type: facet.valueType, in_list: facet.has_list_values && !facet.values.some((v) => !v.in_list) } : null));
    sel.addEventListener('change', () => {
      if (sel.value === '__other__') { other.style.display = ''; other.focus(); return; }
      other.style.display = 'none';
      const v = sel.value === '' ? null : facet.values[Number(sel.value)];
      setMetadataFilter(facet.key, v ? { value: v.value, type: v.type, in_list: !!v.in_list } : null);
    });
    return h('div', { class: 'kbx-field', style: { marginBottom: 0 } },
      h('label', {}, facet.key,
        h('span', { class: 'kbx-chip muted', style: { marginLeft: '6px' }, title: `${facet.entry_count} entries carry this key, ${facet.distinct_count} distinct values` }, `${facet.entry_count.toLocaleString()} · ${facet.distinct_count.toLocaleString()} values`)),
      sel, other);
  }

  function buildFilterPanel() {
    clear(facetInputs);
    applyFiltersOpen();
    const ranked = facets ? rankFacets(facets.facets, { exclude: textOnlyNames() }) : [];
    const { primary, more } = splitPrimary(ranked);
    const found = new Set(findFacetKeys(ranked, keyQuery).map((f) => f.key));
    const shown = primary.concat(more.filter((f) => openKeys.has(f.key) || found.has(f.key) || filterState.metadata[f.key]));
    shown.forEach((f) => facetInputs.append(facetSelect(f)));
    const rest = more.filter((f) => !shown.includes(f));
    // key finder: any key, by typing part of its name
    if (ranked.length) {
      const finder = h('input', { class: 'kbx-input', type: 'text', value: keyQuery, dataset: { role: 'key-finder' }, placeholder: 'Type part of a key: approved, by, status…', autocomplete: 'off' });
      finder.addEventListener('input', () => {
        keyQuery = finder.value;
        const pos = finder.selectionStart;
        buildFilterPanel();
        const again = facetInputs.querySelector('input[data-role="key-finder"]');
        if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch { /* not a text input */ } }
      });
      const n = findFacetKeys(ranked, keyQuery).length;
      facetInputs.append(h('div', { class: 'kbx-field', style: { marginBottom: 0 } },
        h('label', {}, 'Find a key', h('span', { class: 'kbx-chip muted', style: { marginLeft: '6px' } }, keyQuery ? `${n} match${n === 1 ? '' : 'es'}` : `${ranked.length} keys`)), finder));
    }
    // who acted on it: the *_by keys, one click each
    const actors = actorFacets(ranked).filter((f) => !shown.includes(f));
    if (actors.length) {
      const row = h('div', { class: 'kbx-filter-chips', dataset: { role: 'actor-keys' } });
      actors.forEach((f) => row.append(h('button', { class: 'kbx-filter-chip', type: 'button', title: `${f.entry_count} entries carry ${f.key}`, dataset: { actorKey: f.key },
        onClick: () => { openKeys.add(f.key); buildFilterPanel(); const s = facetInputs.querySelector(`select[data-facet-key="${CSS.escape(f.key)}"]`); if (s) s.focus(); } },
      f.key, h('span', { class: 'kbx-count' }, f.entry_count.toLocaleString()))));
      facetInputs.append(h('div', { class: 'kbx-field', style: { marginBottom: 0, gridColumn: '1 / -1' } },
        h('label', {}, 'Who acted on it', h('span', { class: 'kbx-chip muted', style: { marginLeft: '6px' } }, 'click a key to filter by person')), row));
    }
    if (rest.length) {
      const moreSel = h('select', { class: 'kbx-select', dataset: { role: 'more-keys' } }, h('option', { value: '' }, `More keys… (${rest.length})`));
      rest.forEach((f) => moreSel.append(h('option', { value: f.key }, `${f.key} (${f.entry_count.toLocaleString()})`)));
      moreSel.addEventListener('change', () => { if (moreSel.value) { openKeys.add(moreSel.value); buildFilterPanel(); const s = facetInputs.querySelector(`select[data-facet-key="${CSS.escape(moreSel.value)}"]`); if (s) s.focus(); } });
      facetInputs.append(h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, h('label', {}, 'Other metadata keys'), moreSel));
    }
    // source column
    const sources = facets && facets.source && Array.isArray(facets.source.values) ? facets.source.values : [];
    if (sources.length) {
      const srcSel = h('select', { class: 'kbx-select', dataset: { role: 'source' } }, h('option', { value: '' }, 'Any source'));
      sources.forEach((v) => srcSel.append(h('option', { value: v.value }, facetValueLabel(v))));
      srcSel.value = filterState.source || '';
      srcSel.addEventListener('change', () => { filterState = { ...filterState, source: srcSel.value }; runSearch(); });
      facetInputs.append(h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, h('label', {}, 'Source', h('span', { class: 'kbx-chip muted', style: { marginLeft: '6px' } }, 'who wrote it')), srcSel));
    }
    // created date range
    const after = h('input', { class: 'kbx-input', type: 'date', value: filterState.createdAfter || '', dataset: { role: 'created-after' } });
    const before = h('input', { class: 'kbx-input', type: 'date', value: filterState.createdBefore || '', dataset: { role: 'created-before' } });
    after.addEventListener('change', () => { filterState = { ...filterState, createdAfter: after.value }; runSearch(); });
    before.addEventListener('change', () => { filterState = { ...filterState, createdBefore: before.value }; runSearch(); });
    facetInputs.append(
      h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, h('label', {}, 'Created on or after'), after),
      h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, h('label', {}, 'Created on or before'), before));
  }

  async function loadFacets() {
    try {
      facets = await api.metadataFacets({ max_values: DEFAULT_MAX_VALUES });
    } catch (e) {
      facets = null;
      if (e && e.status && e.status !== 404) toast(`Metadata facets unavailable: ${e.message}`, 'error');
    }
    buildFilterPanel();
  }

  function renderActiveFilters() {
    clear(activeHost);
    const chips = activeFilterChips(filterState);
    if (!chips.length) { activeHost.style.display = 'none'; return; }
    activeHost.style.display = '';
    activeHost.append(h('span', { class: 'kbx-muted', style: { fontSize: '12px', alignSelf: 'center' } }, 'Filtered by:'));
    chips.forEach((c) => activeHost.append(h('button', {
      class: 'kbx-filter-chip is-active', type: 'button', title: 'Remove this filter', dataset: { filterKind: c.kind, filterKey: c.key || '' },
      onClick: () => { filterState = removeFilter(filterState, c); buildFilterPanel(); runSearch(); },
    }, c.label, h('i', { class: 'bi bi-x', style: { marginLeft: '4px' } }))));
  }

  const searchCard = h('div', { class: 'kbx-card' },
    h('div', { class: 'kbx-card-head' }, h('h3', { class: 'kbx-card-title' }, 'Semantic search'),
      h('div', { class: 'kbx-row' },
        h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, h('label', {}, ' '),
          h('label', { class: 'kbx-check', title: 'A small language model reads what each dimension of this bank is for, writes a search for each one from your query, and searches them together. Costs one model call per new query; falls back to the plain search if the model is unavailable.' }, llmCb, 'LLM-powered search')),
        modeField,
        h('div', { class: 'kbx-field', style: { marginBottom: 0, width: '80px' } }, h('label', {}, 'Limit'), limitInput),
        h('div', { class: 'kbx-field', style: { marginBottom: 0, width: '90px' } }, h('label', {}, 'Min score'), thresholdInput))),
    searchInputs,
    llmField,
    filterInputs,
    h('div', { class: 'kbx-row kbx-mt' }, searchBtn, clearBtn));

  // ── bulk actions over the selected entries ──────────────────────────────
  const bulkHost = h('div', { class: 'kbx-bulk-bar', dataset: { role: 'bulk-bar' } });

  async function afterBulk(verb, result) {
    toast(bulkSummary(verb, result), result.failed.length ? 'error' : 'success');
    selection = new Set(result.failed.map((f) => f.id));
    if (ctx.refreshInfo) ctx.refreshInfo();
    loadFacets();
    if (showingScores) await runSearch(); else await loadEntries();
  }

  async function bulkDelete() {
    const ids = Array.from(selection);
    if (!ids.length) return;
    const ok = await confirmModal({ title: `Delete ${ids.length} ${ids.length === 1 ? 'entry' : 'entries'}?`, message: 'Each selected entry is deleted through the same audited call as a single delete. This cannot be undone.', confirmLabel: `Delete ${ids.length}` });
    if (!ok) return;
    renderBulkBar('Deleting…');
    const result = await runBulk(ids, (id) => api.deleteEntry(id), { onProgress: (d, t) => renderBulkBar(`Deleting ${d} of ${t}…`) });
    await afterBulk('Deleted', result);
  }

  function bulkSetMetadata() {
    const ids = Array.from(selection);
    if (!ids.length) return;
    const keys = facets && Array.isArray(facets.facets) ? facets.facets : [];
    const listId = `kbx-bulk-keys-${api.kbId || 'kb'}`;
    const keyInput = h('input', { class: 'kbx-input', type: 'text', list: listId, placeholder: 'approved_by, status, reviewed…', autocomplete: 'off' });
    const dataList = h('datalist', { id: listId });
    keys.forEach((f) => dataList.append(h('option', { value: f.key }, `${f.entry_count.toLocaleString()} entries`)));
    const typeSel = h('select', { class: 'kbx-select' },
      h('option', { value: 'string' }, 'Text'), h('option', { value: 'number' }, 'Number'), h('option', { value: 'boolean' }, 'True / false'));
    keyInput.addEventListener('change', () => {
      const f = keys.find((x) => x.key === keyInput.value.trim());
      if (f && f.values && f.values.length) { const t = f.values[0].type; if (['string', 'number', 'boolean'].includes(t)) typeSel.value = t; }
    });
    const valueInput = h('input', { class: 'kbx-input', type: 'text', placeholder: 'the value every selected entry gets' });
    const body = h('div', {},
      h('div', { class: 'kbx-field' }, h('label', {}, 'Metadata key'), keyInput, dataList),
      h('div', { class: 'kbx-grid cols-2' },
        h('div', { class: 'kbx-field' }, h('label', {}, 'Value'), valueInput),
        h('div', { class: 'kbx-field' }, h('label', {}, 'Stored as'), typeSel)),
      h('div', { class: 'kbx-hint' }, `Sets this one key on ${ids.length} ${ids.length === 1 ? 'entry' : 'entries'} and leaves their other metadata alone. Nothing is re-embedded. Every update is audited like a single edit.`));
    const applyBtn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button' }, `Apply to ${ids.length}`);
    const ref = openModal({ title: 'Set metadata on selected entries', body, footer: [h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', onClick: () => ref.close() }, 'Cancel'), applyBtn] });
    setTimeout(() => keyInput.focus(), 0);
    applyBtn.addEventListener('click', async () => {
      const patch = bulkMetadataPatch(keyInput.value, valueInput.value, typeSel.value);
      if (!patch) { toast('Give the metadata key a name.', 'error'); keyInput.focus(); return; }
      applyBtn.classList.add('is-loading');
      ref.close();
      renderBulkBar('Updating…');
      const result = await runBulk(ids, (id) => api.updateEntry(id, patch), { onProgress: (d, t) => renderBulkBar(`Updating ${d} of ${t}…`) });
      await afterBulk('Updated', result);
    });
  }

  function renderBulkBar(busy) {
    clear(bulkHost);
    const shownEntries = visible();
    if (!shownEntries.length && !selection.size) { bulkHost.style.display = 'none'; return; }
    bulkHost.style.display = '';
    const n = selection.size;
    const allCb = h('input', { type: 'checkbox', dataset: { role: 'select-all' } });
    allCb.checked = allVisibleSelected(selection, shownEntries);
    allCb.addEventListener('change', () => { selection = selectAllVisible(selection, shownEntries, allCb.checked); render(); });
    const disabled = !n || !!busy;
    // DOM append() renders a null child as the text "null"; h() skips it, so build through h().
    bulkHost.append(...h('div', {},
      h('label', { class: 'kbx-check' }, allCb, `Select all shown (${shownEntries.length})`),
      h('span', { class: 'kbx-muted', dataset: { role: 'selected-count' }, style: { fontSize: '13px' } }, busy || (n ? `${n} selected` : 'Tick entries to act on several at once')),
      h('span', { style: { flex: '1 1 auto' } }),
      h('button', { class: 'kbx-btn kbx-btn-sm', type: 'button', disabled: disabled || undefined, dataset: { role: 'bulk-set-metadata' }, onClick: bulkSetMetadata }, h('i', { class: 'bi bi-tags' }), 'Set metadata…'),
      h('button', { class: 'kbx-btn kbx-btn-sm kbx-btn-danger', type: 'button', disabled: disabled || undefined, dataset: { role: 'bulk-delete' }, onClick: bulkDelete }, h('i', { class: 'bi bi-trash' }), 'Delete…'),
      n ? h('button', { class: 'kbx-btn kbx-btn-sm kbx-btn-ghost', type: 'button', disabled: busy || undefined, dataset: { role: 'bulk-clear' }, onClick: () => { selection = new Set(); render(); } }, 'Clear') : null).childNodes);
  }

  const listCard = h('div', { class: 'kbx-card' },
    h('div', { class: 'kbx-card-head' }, countLabel, addBtn),
    expansionHost,
    bulkHost,
    activeHost,
    chipsHost,
    resultsHost);

  mount(el, searchCard, facetCard, listCard);
  applyLlmMode();
  buildFilterPanel();

  // ── loading ──────────────────────────────────────────────────────────────
  function limitVal(max) { return Math.max(1, Math.min(parseInt(limitInput.value, 10) || 20, max)); }

  /** Text-only dimension selections (exact match), as a metadata_filters object. */
  function textOnlySelections() {
    const filters = {};
    filterInputs.querySelectorAll('select[data-filter-dim]').forEach((s) => { if (s.value) filters[s.dataset.filterDim] = s.value; });
    return filters;
  }

  /** Every hard filter for the search bodies: text-only dims + facet panel. */
  function hardFilters() { return searchFilterFields(filterState, textOnlySelections()); }

  async function loadEntries() {
    const filtered = hasActiveFilters(filterState) || Object.keys(textOnlySelections()).length > 0;
    mount(resultsHost, skeleton(filtered ? 'Filtering…' : 'Loading entries…'));
    try {
      const data = await api.listEntries(listParams({ limit: limitVal(200), offset: 0, state: filterState, extraMetadata: textOnlySelections() }));
      lastResults = Array.isArray(data) ? data : (data.entries || data.data || []);
      showingScores = false;
      refreshFilterOptions();
      render();
    } catch (e) {
      mount(resultsHost, h('div', { class: 'kbx-alert danger' }, `Could not load entries: ${e.message}`));
      countLabel.textContent = '';
    }
  }

  async function runLlmSearch() {
    const hard = hardFilters();
    const payload = buildExpandedPayload({ query: llmInput.value, k: limitVal(100), threshold: parseFloat(thresholdInput.value) || 0, filters: hard.metadata_filters || {}, speed: speedSelect.value, hardFilters: hard });
    if (!payload) { clear(expansionHost); loadEntries(); return; }
    if (searching) return;
    searching = true; searchBtn.classList.add('is-loading');
    clear(expansionHost);
    mount(resultsHost, skeleton('Asking the model, then searching…'));
    try {
      const data = await api.searchExpanded(payload);
      lastResults = (data && Array.isArray(data.results)) ? data.results : [];
      renderExpansion(data ? data.expansion : null);
      showingScores = true; activeChip = null;
      render();
    } catch (e) {
      mount(resultsHost, h('div', { class: 'kbx-alert danger' }, `Search failed: ${e.message}`));
    } finally {
      searching = false; searchBtn.classList.remove('is-loading');
    }
  }

  function renderExpansion(expansion) {
    const sum = expansionSummary(expansion);
    const box = h('div', { class: `kbx-alert ${sum.tone}`, style: { marginBottom: '12px', display: 'block' } },
      h('div', { style: { fontWeight: '600', marginBottom: sum.rows.length || sum.descriptors.length ? '6px' : '0' } }, sum.headline));
    if (sum.rows.length) {
      const list = h('div', { class: 'kbx-grid cols-2', style: { gap: '4px 16px' } });
      sum.rows.forEach((r) => list.append(h('div', {}, h('span', { class: 'kbx-chip muted', style: { marginRight: '6px' } }, r.dimension), r.text)));
      box.append(list);
    }
    if (sum.descriptors.length) {
      box.append(h('div', { style: { marginTop: '6px' } }, h('span', { class: 'kbx-muted' }, 'Also: '), sum.descriptors.join(', ')));
    }
    if (sum.footnote) box.append(h('div', { class: 'kbx-muted', style: { fontSize: '12px', marginTop: '6px' } }, sum.footnote));
    mount(expansionHost, box);
  }

  async function runSearch() {
    if (llmCb.checked) { await runLlmSearch(); return; }
    clear(expansionHost);
    const dimensions = {};
    searchInputs.querySelectorAll('input[data-dim]').forEach((i) => {
      const val = i.value.trim();
      if (val) dimensions[i.dataset.dim] = { query_text: val };
    });
    if (!Object.keys(dimensions).length) {
      // No semantic query: the filters alone drive a server-side listing
      // (the service rejects a search with no semantic dimension by design).
      activeChip = null;
      loadEntries(); return;
    }
    if (searching) return;
    searching = true; searchBtn.classList.add('is-loading');
    mount(resultsHost, skeleton('Searching…'));
    try {
      const payload = { dimensions, k: limitVal(100), threshold: parseFloat(thresholdInput.value) || 0, combination_mode: modeSelect.value, ...hardFilters() };
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
    renderActiveFilters();
    renderChips();
    selection = pruneSelection(selection, lastResults);
    renderBulkBar();
    const entries = visible();
    const schema = ctx.getSchema();
    const info = ctx.getInfo ? ctx.getInfo() : null;
    const filtered = hasActiveFilters(filterState) || Object.keys(textOnlySelections()).length > 0;
    countLabel.textContent = entriesCountLabel({
      shown: entries.length, loaded: lastResults.length, showingScores,
      total: info && !filtered ? info.entry_count : null,
    });
    if (!entries.length) {
      const sub = showingScores ? 'Try broadening your query or lowering the min score.'
        : (activeChip ? 'Nothing in the loaded set matches this filter.'
          : (filtered ? 'No entry carries every active filter. Remove one above.' : 'Add the first entry to this Knowledge Bank.'));
      mount(resultsHost, empty('bi-inbox', showingScores ? 'No matches' : 'No entries', sub));
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

    const picked = selection.has(entry.id);
    const check = h('input', { type: 'checkbox', class: 'kbx-item-check', title: 'Select for a bulk action', dataset: { role: 'select-entry' }, checked: picked || undefined });
    check.addEventListener('click', (e) => e.stopPropagation());
    check.addEventListener('change', () => { selection = toggleSelected(selection, entry.id, check.checked); check.closest('.kbx-item').classList.toggle('is-selected', check.checked); renderBulkBar(); });
    return h('div', { class: `kbx-item${picked ? ' is-selected' : ''}`, dataset: { entryId: entry.id }, onClick: () => openEntryDetail(ctx, entry.id, { onChanged: () => (showingScores ? runSearch() : loadEntries()) }) },
      h('div', { class: 'kbx-item-head' },
        h('div', { class: 'kbx-row', style: { gap: '6px' } }, check, ...chips),
        h('span', { class: 'kbx-mono kbx-muted', style: { fontSize: '11px' } },
          entry.source ? h('span', { title: 'source', style: { marginRight: '8px' } }, String(entry.source)) : null,
          String(entry.id || '').slice(0, 8))),
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
      if (!loaded) { loaded = true; loadEntries(); loadFacets(); }
    },
    reload() { buildSearchInputs(); loadEntries(); loadFacets(); },
  };
}
