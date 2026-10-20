/* Multi-select and bulk actions over the Entries list — pure helpers.

   The Entries view keeps a Set of selected entry ids across re-renders
   (a search or filter change keeps the picks that are still on screen);
   the bulk bar acts on that set through the per-entry explorer API:
     • Delete selected          DELETE /entries/{id}      (one call per entry)
     • Set metadata on selected PATCH  /entries/{id}      {update_metadata: {key: value}}
   The service shallow-merges update_metadata, so a bulk edit sets or
   overwrites ONE key and leaves every other key alone; it cannot remove a
   key (UpdateDimensionsRequest has no removal field). Every per-entry call
   is audited exactly as a single edit or delete is.

   No DOM here, so Node tests can import it (tests/test_kb_explorer_bulk_model.js). */

import { coerceFacetValue } from './facet_filters.js';

/** A new selection set holding `ids` (any iterable). */
export function selectionFrom(ids) {
  return new Set(Array.from(ids || []).filter((id) => id !== undefined && id !== null && id !== ''));
}

/** A copy of `selection` with `id` added (on=true) or removed (on=false). */
export function toggleSelected(selection, id, on) {
  const next = new Set(selection || []);
  if (id === undefined || id === null || id === '') return next;
  if (on === undefined ? !next.has(id) : !!on) next.add(id); else next.delete(id);
  return next;
}

/** The selection restricted to ids that are still on screen. */
export function pruneSelection(selection, visibleEntries) {
  const keep = new Set((visibleEntries || []).map((e) => e && e.id));
  return new Set(Array.from(selection || []).filter((id) => keep.has(id)));
}

/** true when every visible entry is selected (false when nothing is visible). */
export function allVisibleSelected(selection, visibleEntries) {
  const list = (visibleEntries || []).filter((e) => e && e.id);
  return list.length > 0 && list.every((e) => (selection || new Set()).has(e.id));
}

/** The selection with every visible entry added (on=true) or removed (on=false). */
export function selectAllVisible(selection, visibleEntries, on = true) {
  const next = new Set(selection || []);
  (visibleEntries || []).forEach((e) => { if (e && e.id) { if (on) next.add(e.id); else next.delete(e.id); } });
  return next;
}

/**
 * The PATCH body that sets one metadata key on an entry, or null when the
 * key is empty. `type` is 'string' | 'number' | 'boolean' (the facet's
 * dominant type, or the person's pick); the value is coerced to it so a
 * bulk "confidence = 0.9" stores a number, "verified = true" a boolean.
 */
export function bulkMetadataPatch(key, valueText, type = 'string') {
  const k = String(key || '').trim();
  if (!k) return null;
  return { update_metadata: { [k]: coerceFacetValue(valueText, type) } };
}

/**
 * Run `fn(id)` for every selected id, a few at a time, never throwing:
 * returns {ok: [ids], failed: [{id, error}]} so the caller can report both.
 * @param {Iterable<string>} ids
 * @param {(id: string) => Promise<any>} fn
 * @param {{concurrency?: number, onProgress?: (done: number, total: number) => void}} [opts]
 */
export async function runBulk(ids, fn, { concurrency = 4, onProgress } = {}) {
  const list = Array.from(ids || []);
  const ok = [];
  const failed = [];
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < list.length) {
      const id = list[next++];
      try { await fn(id); ok.push(id); }
      catch (e) { failed.push({ id, error: (e && e.message) || String(e) }); }
      done++;
      if (onProgress) onProgress(done, list.length);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length || 1)) }, worker));
  return { ok, failed };
}

/** One line for the toast after a bulk run. */
export function bulkSummary(verb, result) {
  const ok = (result && result.ok && result.ok.length) || 0;
  const bad = (result && result.failed && result.failed.length) || 0;
  const n = (c) => `${c} ${c === 1 ? 'entry' : 'entries'}`;
  if (!bad) return `${verb} ${n(ok)}.`;
  const first = result.failed[0];
  return `${verb} ${n(ok)}; ${n(bad)} failed (${first.id.slice(0, 8)}: ${first.error}).`;
}
