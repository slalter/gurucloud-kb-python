/* Glossary — a business bank's client abbreviations and in-house words
   (entries of kind `term`, kb_defaults.BUSINESS_KB_TERM_KIND; owner ruling
   2026-11-24, review 5e21b241, kanban 5adfa9fa). A process view underlines each
   term it uses and lists them under "Terms on this page", so a reader learns
   what POD or COA means without leaving the modal.

   Pure helpers (no DOM) so Node tests can pin the matching rules. */

import { markdownToText } from './markdown_model.js';

export const TERM_KIND = 'term';
export const TERM_METADATA_KEY = 'term';
/** One page of term entries; a bank with more terms than this shows the first page. */
export const TERM_PAGE_LIMIT = 200;
const MEANING_MAX = 280;

/** The list-entries params that fetch a bank's term entries. */
export function termListParams() {
  return { limit: TERM_PAGE_LIMIT, offset: 0, metadata_filters: JSON.stringify({ kind: TERM_KIND }) };
}

/** The term an entry defines: metadata `term`, else the bold lead of its content ("**POD** (proof…" → POD). */
export function termOf(entry) {
  const meta = (entry && entry.metadata) || {};
  const given = meta[TERM_METADATA_KEY] != null ? String(meta[TERM_METADATA_KEY]).trim() : '';
  if (given) return given;
  const m = /^\s*\*\*([^*\n]+?)\*\*/.exec((entry && entry.content) || '');
  if (!m) return '';
  return m[1].split(/\s*[(:—–-]\s*/)[0].trim();
}

/** The reader-facing meaning: the content as plain text, cut at a sentence end near MEANING_MAX. */
export function meaningOf(entry) {
  const text = markdownToText((entry && entry.content) || '').replace(/\s+/g, ' ').trim();
  if (text.length <= MEANING_MAX) return text;
  const cut = text.slice(0, MEANING_MAX);
  const end = cut.lastIndexOf('. ');
  return end > 80 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

/**
 * The glossary of a list of entries: [{term, meaning, entryId}] for every
 * `kind=term` entry with a usable term, one per term (first wins), sorted by term.
 */
export function glossaryFromEntries(entries) {
  const byTerm = new Map();
  (entries || []).forEach((e) => {
    const kind = e && e.metadata ? e.metadata.kind : undefined;
    if (kind !== TERM_KIND) return;
    const term = termOf(e);
    if (!term || byTerm.has(term)) return;
    byTerm.set(term, { term, meaning: meaningOf(e), entryId: e.id || '' });
  });
  return Array.from(byTerm.values()).sort((a, b) => a.term.localeCompare(b.term));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A regex matching any glossary term as a whole word (a plural "s" allowed: PODs),
 * longest first, case-sensitive (an abbreviation is written the way the client
 * writes it: "SO" must not match "so"). Group 1 is the term. null when there are no terms.
 */
export function termPattern(glossary) {
  const terms = (glossary || []).map((g) => g.term).filter(Boolean);
  if (!terms.length) return null;
  const alts = Array.from(new Set(terms)).sort((a, b) => b.length - a.length).map(escapeRe);
  return new RegExp(`(?<![\\p{L}\\p{N}_])(${alts.join('|')})s?(?![\\p{L}\\p{N}_])`, 'gu');
}

/**
 * Split text into segments [{text}, {text, term}] where `term` is the glossary
 * row a matched span stands for. Text with no match comes back as one plain segment.
 */
export function segmentText(text, glossary) {
  const s = text == null ? '' : String(text);
  const re = termPattern(glossary);
  if (!re || !s) return s ? [{ text: s }] : [];
  const byTerm = new Map((glossary || []).map((g) => [g.term, g]));
  const out = [];
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    out.push({ text: m[0], term: byTerm.get(m[1]) });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}

/** The glossary rows any of `texts` uses, in glossary (alphabetical) order. */
export function termsUsed(texts, glossary) {
  const re = termPattern(glossary);
  if (!re) return [];
  const seen = new Set();
  (texts || []).forEach((t) => {
    if (t == null || t === '') return;
    for (const m of String(t).matchAll(re)) seen.add(m[1]);
  });
  return (glossary || []).filter((g) => seen.has(g.term));
}
