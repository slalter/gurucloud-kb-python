/* Promote an entry to a playbook draft — pure helpers, no DOM.

   Business banks capture procedures as prose entries (kind=process). This turns
   such an entry into a playbook draft a person then edits: a slug from the
   opening words, the first sentence as title, `useful_for` as when-to-use, and
   one step per sentence (or per numbered/bulleted line when the text already
   has them). Deterministic on purpose: the reviewer sees exactly the entry's
   own words split up, nothing invented. */

const MAX_TITLE = 120;
const MAX_STEP_TITLE = 72;
const MAX_STEPS = 25;

export function slugify(text, maxLen = 48) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = s.slice(0, maxLen).replace(/-+$/g, '');
  return cut || 'playbook';
}

/** Split prose into sentences. Keeps abbreviations like "e.g." intact
    reasonably well by requiring a following capital/quote/digit. */
export function splitSentences(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const parts = t.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Numbered or bulleted lines ("1. ...", "1) ...", "- ...", "• ...") → steps.
    Returns [] when the text has fewer than two such lines. */
export function splitListLines(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items = [];
  for (const l of lines) {
    const m = l.match(/^(?:\(?\d{1,2}[.)]|[-•*])\s+(.*)$/);
    if (m) items.push(m[1].trim());
  }
  return items.length >= 2 ? items : [];
}

function stepTitle(body) {
  const firstClause = String(body).split(/[:;—–,.]/)[0].trim();
  const base = firstClause.length >= 8 ? firstClause : String(body).trim();
  return base.length > MAX_STEP_TITLE ? base.slice(0, MAX_STEP_TITLE - 1).trimEnd() + '…' : base;
}

/**
 * Build a playbook draft from an entry.
 * @param {object} entry  {id, content, useful_for, metadata}
 * @returns {{slug:string,title:string,when_to_use:string,summary:string,steps:Array<{title:string,body:string,kb_entry_id:string|null}>,status:'draft'}}
 */
export function entryToPlaybookDraft(entry) {
  const content = String((entry && entry.content) || '').trim();
  const usefulFor = String((entry && entry.useful_for) || '').trim();
  const sentences = splitSentences(content);
  const listItems = splitListLines(content);
  const first = sentences[0] || content;

  let title = first.replace(/^(process|procedure|how to|steps?)\s*[:\-–—]\s*/i, '').trim();
  if (title.length > MAX_TITLE) title = title.slice(0, MAX_TITLE - 1).trimEnd() + '…';
  if (title.length < 3) title = 'Untitled procedure';

  const bodies = (listItems.length ? listItems : sentences.length > 1 ? sentences.slice(1) : sentences).slice(0, MAX_STEPS);
  const steps = bodies.map((b, i) => ({
    title: stepTitle(b),
    body: b,
    kb_entry_id: i === 0 && entry && entry.id ? String(entry.id) : null,
  }));
  if (!steps.length) steps.push({ title: stepTitle(content || 'Step 1'), body: content || '', kb_entry_id: entry && entry.id ? String(entry.id) : null });

  const whenToUse = usefulFor.length >= 10 ? usefulFor : `When carrying out: ${title}`;
  return {
    slug: slugify(title),
    title,
    when_to_use: whenToUse,
    summary: sentences.length > 1 ? first : '',
    steps,
    status: 'draft',
  };
}
