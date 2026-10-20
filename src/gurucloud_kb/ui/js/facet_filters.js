/* Filters built from what a bank's entries ACTUALLY carry — pure helpers.

   The dimension schema declares the embedded and text-only dimensions; it
   says nothing about the metadata keys writers add freely (created_by,
   session_id, tags, type …) nor about the `source` column or the timestamps.
   GET /metadata-facets reports those from the data (kb_service/metadata_facets.py);
   this module turns that report into the Entries tab's filter panel and turns
   the person's choices into the exact wire filters every path takes:
     • browsing:        query params of GET /entries   (listParams)
     • plain search:    body fields of POST /search    (searchFilterFields)
     • LLM search:      body fields of POST /search/expanded (same fields)

   No DOM here, so Node tests can import it (tests/test_kb_explorer_facet_filters.js). */

export const DEFAULT_PRIMARY_KEYS = 6;
export const DEFAULT_MAX_VALUES = 25;

/** Filter state the Entries view keeps. */
export function emptyFilterState() {
  return { metadata: {}, source: '', createdAfter: '', createdBefore: '' };
}

export function hasActiveFilters(state) {
  const s = state || emptyFilterState();
  return Object.keys(s.metadata || {}).length > 0 || !!s.source || !!s.createdAfter || !!s.createdBefore;
}

/** Above this share of distinct values per entry a key is an identifier. */
export const IDENTIFIER_RATIO = 0.95;
/** Above this share (or this mean value length) a key is "noisy": offered under
    "More keys…" but never as an up-front select. Calibrated on the production
    gurucloudai bank: created_by/type/kind sit far below, session ids and
    free-text context (gotcha_context, mean 314 chars) far above. */
export const NOISY_RATIO = 0.3;
export const NOISY_VALUE_LENGTH = 64;

/** Distinct values per carrying entry (0 when unknown). */
export function distinctRatio(facet) {
  const n = (facet && facet.entry_count) || 0;
  return n > 0 ? ((facet.distinct_count || 0) / n) : 0;
}

/** A key whose (almost) every entry has its own value is an identifier, not a facet. */
export function looksLikeIdentifier(facet) {
  if (!facet) return false;
  return (facet.entry_count || 0) >= 5 && distinctRatio(facet) >= IDENTIFIER_RATIO;
}

/** Mean length of the reported top values. */
export function meanValueLength(values) {
  const list = (values || []).filter((v) => v && typeof v.value === 'string');
  if (!list.length) return 0;
  return list.reduce((sum, v) => sum + v.value.length, 0) / list.length;
}

/** High-cardinality or long-text keys: real metadata, poor selects. */
export function looksNoisy(facet) {
  if (!facet) return false;
  if ((facet.entry_count || 0) >= 5 && distinctRatio(facet) > NOISY_RATIO) return true;
  return meanValueLength(facet.values) > NOISY_VALUE_LENGTH;
}

/**
 * Facets a person can filter on, most useful first: keys that carry at least
 * one scalar value, are not a text-only dimension (those already have their
 * own select) and are not per-entry identifiers. Clean keys come first
 * (coverage, then fewest distinct values, then name); noisy keys follow in the
 * same order and are meant for the "More keys…" picker, never the up-front
 * selects.
 * @param {object[]} facets   MetadataFacet[] from /metadata-facets
 * @param {{exclude?: string[]}} opts
 * @returns {object[]} the facets, each with `looksLikeId`, `noisy` and `valueType` added
 */
export function rankFacets(facets, { exclude = [] } = {}) {
  const skip = new Set(exclude || []);
  const byUsefulness = (a, b) => (Number(a.noisy) - Number(b.noisy)) || (b.entry_count - a.entry_count) || (a.distinct_count - b.distinct_count) || a.key.localeCompare(b.key);
  return (Array.isArray(facets) ? facets : [])
    .filter((f) => f && f.key && !skip.has(f.key) && Array.isArray(f.values) && f.values.length)
    .map((f) => ({ ...f, looksLikeId: looksLikeIdentifier(f), noisy: looksNoisy(f), valueType: dominantType(f.values) }))
    .filter((f) => !f.looksLikeId)
    .sort(byUsefulness);
}

/** Split ranked facets into the selects shown up front (clean keys only, at
    most `n`) and the "more keys" list (the rest, noisy keys included). */
export function splitPrimary(ranked, n = DEFAULT_PRIMARY_KEYS) {
  const list = Array.isArray(ranked) ? ranked : [];
  const primary = list.filter((f) => !f.noisy).slice(0, n);
  const chosen = new Set(primary.map((f) => f.key));
  return { primary, more: list.filter((f) => !chosen.has(f.key)) };
}

/** The JSON type most of a key's observed values have. */
export function dominantType(values) {
  const counts = {};
  (values || []).forEach((v) => { counts[v.type] = (counts[v.type] || 0) + (v.count || 1); });
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : 'string';
}

/** Rebuild the typed JSON value a facet value stands for. */
export function coerceFacetValue(text, type) {
  const s = String(text == null ? '' : text).trim();
  if (type === 'boolean') return s.toLowerCase() === 'true';
  if (type === 'number') { const n = Number(s); return Number.isFinite(n) ? n : s; }
  return s;
}

/** `value (count)` for a select option; an empty string reads as "(empty)". */
export function facetValueLabel(v) {
  const count = Number.isFinite(v && v.count) ? ` (${v.count.toLocaleString()})` : '';
  const text = v && v.value !== '' && v.value != null ? String(v.value) : '(empty)';
  return `${text}${count}`;
}

/**
 * The metadata_filters object (JSONB containment) for the chosen values.
 * @param {object} metadata  {key: {value, type, in_list}}
 */
export function buildMetadataFilters(metadata) {
  const out = {};
  Object.entries(metadata || {}).forEach(([key, sel]) => {
    if (!sel || sel.value === undefined || sel.value === null || sel.value === '') return;
    const typed = coerceFacetValue(sel.value, sel.type);
    out[key] = sel.in_list ? [typed] : typed;
  });
  return out;
}

/** A date input value (YYYY-MM-DD) as the UTC start or end of that day, else null. */
export function dayBound(dateStr, end = false) {
  const s = String(dateStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return `${s}T${end ? '23:59:59' : '00:00:00'}Z`;
}

/**
 * Hard-filter fields shared by POST /search and POST /search/expanded.
 * @param {object} state   filter state (see emptyFilterState)
 * @param {object} [extraMetadata]  text-only dimension selections, merged first
 *                                  (explicit facet picks win on a key clash)
 */
export function searchFilterFields(state, extraMetadata) {
  const s = state || emptyFilterState();
  const fields = {};
  const metadata = { ...(extraMetadata || {}), ...buildMetadataFilters(s.metadata) };
  if (Object.keys(metadata).length) fields.metadata_filters = metadata;
  if (s.source) fields.source = s.source;
  const after = dayBound(s.createdAfter, false);
  const before = dayBound(s.createdBefore, true);
  if (after) fields.created_after = after;
  if (before) fields.created_before = before;
  return fields;
}

/** Query params of GET /entries (metadata_filters travels as a JSON string). */
export function listParams({ limit, offset = 0, state, extraMetadata }) {
  const params = { limit, offset };
  const fields = searchFilterFields(state, extraMetadata);
  if (fields.metadata_filters) params.metadata_filters = JSON.stringify(fields.metadata_filters);
  if (fields.source) params.source = fields.source;
  if (fields.created_after) params.created_after = fields.created_after;
  if (fields.created_before) params.created_before = fields.created_before;
  return params;
}

/**
 * The removable chips for the active filters.
 * @returns {{kind: 'metadata'|'source'|'createdAfter'|'createdBefore', key?: string, label: string}[]}
 */
export function activeFilterChips(state) {
  const s = state || emptyFilterState();
  const chips = [];
  Object.entries(s.metadata || {}).forEach(([key, sel]) => {
    if (!sel || sel.value === '' || sel.value == null) return;
    chips.push({ kind: 'metadata', key, label: `${key}${sel.in_list ? ' ∋ ' : ' = '}${sel.value}` });
  });
  if (s.source) chips.push({ kind: 'source', label: `source = ${s.source}` });
  if (s.createdAfter) chips.push({ kind: 'createdAfter', label: `created ≥ ${s.createdAfter}` });
  if (s.createdBefore) chips.push({ kind: 'createdBefore', label: `created ≤ ${s.createdBefore}` });
  return chips;
}

/** A copy of the state with one chip's filter removed. */
export function removeFilter(state, chip) {
  const s = { ...(state || emptyFilterState()), metadata: { ...((state && state.metadata) || {}) } };
  if (!chip) return s;
  if (chip.kind === 'metadata') delete s.metadata[chip.key];
  else if (chip.kind === 'source') s.source = '';
  else if (chip.kind === 'createdAfter') s.createdAfter = '';
  else if (chip.kind === 'createdBefore') s.createdBefore = '';
  return s;
}

/** One line describing the facets report for the panel caption. */
export function facetsCaption(facets) {
  if (!facets) return 'Filter by the metadata this bank carries.';
  const keys = Array.isArray(facets.facets) ? facets.facets.length : 0;
  const sources = facets.source && Number.isFinite(facets.source.distinct_count) ? facets.source.distinct_count : 0;
  const total = Number.isFinite(facets.total_entries) ? facets.total_entries.toLocaleString() : '?';
  const parts = [`${keys} metadata key${keys === 1 ? '' : 's'}`];
  if (sources) parts.push(`${sources} source${sources === 1 ? '' : 's'}`);
  return `${parts.join(' · ')} across ${total} entries${facets.truncated_keys ? ' (more keys not shown)' : ''}.`;
}

/* ── key finder ──────────────────────────────────────────────────────────── */

/** Keys that name a person or agent who acted on the entry (`decided_by`,
    `approved_by`, `filed_by`, `swept_by`, `approver`, `reviewer`…). A bank
    with 100+ metadata keys never ranks these into the six up-front selects
    (each covers a handful of entries), yet "who approved this?" is the
    first thing a person asks of a filter panel. */
export const ACTOR_KEY_PATTERN = /(^|_)(by|approver|reviewer|owner|author|decider)$/i;

export function isActorKey(key) {
  return ACTOR_KEY_PATTERN.test(String(key || ''));
}

/** The ranked facets whose key names a person (see ACTOR_KEY_PATTERN), in rank order. */
export function actorFacets(ranked) {
  return (Array.isArray(ranked) ? ranked : []).filter((f) => f && isActorKey(f.key));
}

/**
 * The ranked facets whose key contains `text` (case-insensitive; `_`, `-`
 * and spaces are interchangeable, so "approved by" finds `approved_by`).
 * Exact-prefix matches come first, then the rank order. An empty `text`
 * matches nothing: the finder is additive to the up-front selects.
 * @param {object[]} ranked  rankFacets() output
 * @param {string} text
 * @param {number} [limit]
 */
export function findFacetKeys(ranked, text, limit = 12) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, '_').trim();
  const q = norm(text);
  if (!q) return [];
  const list = (Array.isArray(ranked) ? ranked : []).filter((f) => f && f.key && norm(f.key).includes(q));
  const starts = (f) => (norm(f.key).startsWith(q) ? 0 : 1);
  return list.sort((a, b) => starts(a) - starts(b)).slice(0, Math.max(1, limit));
}

/* ── panel open/closed preference ───────────────────────────────────────── */

/** localStorage key for whether the Filters panel is expanded on a bank. */
export function filtersOpenStoreKey(kbId) {
  return `kbx:filters-open:${kbId || 'kb'}`;
}

/** Whether the person last left the Filters panel expanded on this bank.
    The panel carries up to six selects, the key finder, the who-acted-on-it
    row, source and dates and pushes the entries below the fold, so it starts
    COLLAPSED and opens only when the person expands it (remembered per bank). */
export function readFiltersOpenPref(storage, kbId) {
  try {
    return storage != null && storage.getItem(filtersOpenStoreKey(kbId)) === '1';
  } catch {
    return false;
  }
}

export function writeFiltersOpenPref(storage, kbId, open) {
  try {
    if (storage == null) return;
    if (open) storage.setItem(filtersOpenStoreKey(kbId), '1');
    else storage.removeItem(filtersOpenStoreKey(kbId));
  } catch { /* private mode: not remembered */ }
}

/** The short caption for a collapsed Filters panel: key count and active filters. */
export function collapsedFiltersCaption(facets, state) {
  const keys = facets && Array.isArray(facets.facets) ? facets.facets.length : 0;
  const active = activeFilterChips(state).length;
  const parts = [];
  parts.push(keys ? `${keys} metadata key${keys === 1 ? '' : 's'}` : 'metadata keys from the data');
  parts.push(active ? `${active} filter${active === 1 ? '' : 's'} active` : 'no filters active');
  return parts.join(' · ');
}
