/* Schema helpers shared by the Entries, Map and detail views. Pure. */

export const DEFAULT_DIMS = [
  { name: 'content', display_name: 'Content', dimension_type: 'single', searchable: true, default_weight: 1, required: true },
  { name: 'useful_for', display_name: 'Useful For', dimension_type: 'single', searchable: true, default_weight: 1 },
  { name: 'relevant_systems', display_name: 'Systems', dimension_type: 'multi', searchable: true, default_weight: 1 },
  { name: 'relevant_tasks', display_name: 'Tasks', dimension_type: 'multi', searchable: true, default_weight: 1 },
];

/** The business-bank `kind` vocabulary (kb_defaults.BUSINESS_KB_KINDS). */
export const BUSINESS_KINDS = ['decision', 'commitment', 'constraint', 'process', 'preference', 'gap'];

const DEFAULT_NAMES = new Set(DEFAULT_DIMS.map((d) => d.name));

export function dimsOf(schema) {
  return schema && Array.isArray(schema.dimensions) && schema.dimensions.length ? schema.dimensions : DEFAULT_DIMS;
}

export function semanticDims(schema) {
  return dimsOf(schema).filter((d) => d.dimension_type !== 'text_only' && d.searchable !== false);
}

export function textOnlyDims(schema) {
  return dimsOf(schema).filter((d) => d.dimension_type === 'text_only');
}

/** Non-default embedded dimensions (e.g. stakeholders, scope, products). */
export function customDims(schema) {
  return dimsOf(schema).filter((d) => d.dimension_type !== 'text_only' && !DEFAULT_NAMES.has(d.name));
}

/** The dimension that labels an entry's kind: a text-only dim called `kind`,
    else the first text-only dim, else null. */
export function kindDim(schema) {
  const tos = textOnlyDims(schema);
  return tos.find((d) => d.name === 'kind') || tos[0] || null;
}

/** The primary vector dimension for clustering: first required SINGLE, else
    first SINGLE, else 'content'. Mirrors the KB service's default. */
export function primaryDim(schema) {
  const singles = dimsOf(schema).filter((d) => d.dimension_type === 'single' || (!d.dimension_type && d.name === 'content'));
  return (singles.find((d) => d.required) || singles[0] || { name: 'content' }).name;
}

/** Distinct observed values of a text-only dimension across entries, with counts. */
export function observedValues(entries, dimName) {
  const counts = new Map();
  (entries || []).forEach((e) => {
    const v = e && e.metadata ? e.metadata[dimName] : undefined;
    if (v === undefined || v === null || v === '') return;
    const key = String(v);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }));
}

/** Known values for a text-only dim: business kinds (when the dim is `kind`) ∪ observed. */
export function knownValues(entries, dim) {
  const seen = new Set();
  const out = [];
  if (dim && dim.name === 'kind') BUSINESS_KINDS.forEach((k) => { seen.add(k); out.push(k); });
  observedValues(entries, dim && dim.name).forEach(({ value }) => { if (!seen.has(value)) { seen.add(value); out.push(value); } });
  return out;
}

export function kindOf(entry, schema) {
  const d = kindDim(schema);
  if (!d || !entry || !entry.metadata) return null;
  const v = entry.metadata[d.name];
  return v === undefined || v === null || v === '' ? null : String(v);
}

export function truncate(s, n) { s = s || ''; return s.length > n ? s.slice(0, n) + '…' : s; }
