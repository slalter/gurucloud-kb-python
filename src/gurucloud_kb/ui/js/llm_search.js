/* LLM-powered search (expanded search) for the Entries view — pure helpers.

   Off by default. When on, the Entries search sends one query to
   POST /search/expanded: a small model reads this bank's dimension
   descriptions, writes what each dimension should be searched for, and the
   service searches all of them at once (see kb_service/search_expansion.py).
   If the model step cannot run the service falls back to the plain search and
   says why; `expansionSummary` turns that into what the panel shows.

   No DOM here, so Node tests can import it (tests/test_kb_explorer_llm_search.js). */

const STORE_PREFIX = 'kbx-llm-search:';

/** localStorage key for the per-bank on/off choice. */
export function llmSearchStoreKey(kbId) {
  return STORE_PREFIX + String(kbId || '');
}

/** The saved choice for this bank; false (off) when unset or storage is unavailable. */
export function readLlmSearchPref(storage, kbId) {
  try {
    return storage != null && storage.getItem(llmSearchStoreKey(kbId)) === '1';
  } catch {
    return false;
  }
}

/** Remember the choice for this bank; storage failures are ignored (per-viewer convenience only). */
export function writeLlmSearchPref(storage, kbId, on) {
  try {
    if (storage == null) return;
    if (on) storage.setItem(llmSearchStoreKey(kbId), '1');
    else storage.removeItem(llmSearchStoreKey(kbId));
  } catch {
    /* ignore */
  }
}

export const SPEEDS = ['fast', 'thorough'];

/** The saved speed for this bank; 'fast' when unset, unknown or storage is unavailable. */
export function readSpeedPref(storage, kbId) {
  try {
    const v = storage != null ? storage.getItem(llmSearchStoreKey(kbId) + ':speed') : null;
    return SPEEDS.includes(v) ? v : 'fast';
  } catch {
    return 'fast';
  }
}

/** Remember the speed for this bank (the default 'fast' is stored as absence). */
export function writeSpeedPref(storage, kbId, speed) {
  try {
    if (storage == null) return;
    const key = llmSearchStoreKey(kbId) + ':speed';
    if (speed === 'thorough') storage.setItem(key, speed);
    else storage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Body for POST /search/expanded. Returns null for a blank query. */
export function buildExpandedPayload({ query, k, threshold, filters, speed }) {
  const q = String(query || '').trim();
  if (!q) return null;
  const payload = { query: q, k, threshold: Number.isFinite(threshold) ? threshold : 0 };
  if (SPEEDS.includes(speed)) payload.speed = speed;
  if (filters && Object.keys(filters).length) payload.metadata_filters = { ...filters };
  return payload;
}

const PAID_BY = {
  bank: "this bank's own key",
  owner: 'your own key',
  platform: 'the platform-wide client key',
  env: 'the platform',
};

const FALLBACK_REASON = {
  empty: 'The model found nothing to add for this query.',
  disabled: 'The LLM step was switched off for this request.',
  unconfigured: 'No model key is available for this bank.',
  timeout: 'The model took too long to answer.',
  error: 'The model call failed.',
};

/**
 * What the expansion panel shows.
 * @returns {{tone: 'info'|'warn', headline: string, rows: {dimension: string, text: string}[],
 *            descriptors: string[], contentQuery: string, footnote: string}}
 */
export function expansionSummary(expansion) {
  const e = expansion || {};
  const status = e.status || 'error';
  const expanded = status === 'expanded' || status === 'cached';
  const rows = Object.entries(e.dimensions || {})
    .filter(([, text]) => typeof text === 'string' && text.trim())
    .map(([dimension, text]) => ({ dimension, text }));
  const descriptors = Array.isArray(e.descriptors) ? e.descriptors.filter((d) => typeof d === 'string' && d.trim()) : [];
  const parts = [];
  if (e.speed) parts.push(e.speed === 'thorough' ? 'Thorough' : 'Fast');
  if (e.model) parts.push(e.model);
  if (e.credential_source && PAID_BY[e.credential_source]) parts.push(`paid by ${PAID_BY[e.credential_source]}`);
  if (status === 'cached') parts.push('reused a recent expansion');
  else if (Number.isFinite(e.duration_ms) && e.duration_ms > 0) parts.push(`${(e.duration_ms / 1000).toFixed(1)} s`);
  if (expanded) {
    return {
      tone: 'info',
      headline: rows.length ? 'The model searched each dimension for:' : 'The model added these descriptions to your query:',
      rows,
      descriptors,
      contentQuery: e.content_query || '',
      footnote: parts.join(' · '),
    };
  }
  return {
    tone: status === 'empty' ? 'info' : 'warn',
    headline: `${FALLBACK_REASON[status] || FALLBACK_REASON.error} Showing plain search results.`,
    rows: [],
    descriptors: [],
    contentQuery: e.content_query || '',
    footnote: parts.join(' · '),
  };
}
