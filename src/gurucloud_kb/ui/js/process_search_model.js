/* Process search — pure view-model for the reverse search over documented
   processes (GET /process-search; kb_service/process_search.py).

   A person or role query ("Jess") returns every process the person is part
   of; the card says WHERE in one line ("Does steps 1–3, 6 · receives 4").
   A situation query ("a delivery arrives warm") returns the flows that
   describe it with the matching steps named. No DOM here so Node tests can
   pin the wording. */

export const SEARCH_MODES = [
  { value: 'auto', label: 'Anything' },
  { value: 'person', label: 'A person or role' },
  { value: 'how', label: 'A situation' },
];

/** The strongest way a person appears in a step, in display order. */
export const ROLE_ORDER = ['does', 'receives', 'mentioned'];
export const ROLE_LABELS = { does: 'Does', receives: 'Receives', mentioned: 'Named in' };

export const CAST_SHOWN = 5;
export const TITLES_SHOWN = 3;
export const PAGE = 25;      // first page of results
export const PAGE_MAX = 50;  // the service's cap

export const PLACEHOLDERS = {
  auto: 'A name, a role, or what happened: Jess · the controller · a delivery arrives warm',
  person: 'A name or a role: Jess · the controller · warehouse',
  how: 'What happened: a delivery arrives warm · the inspector is here · a truck broke down',
};

/** Lowercase with accents stripped, so Tomás and Tomas are one name. */
export function foldName(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** [1,2,3,6,9,10,11] -> "1–3, 6, 9–11" */
export function ranges(nums) {
  const sorted = [...new Set((nums || []).map(Number))].filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  const out = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(j > i + 1 ? `${sorted[i]}–${sorted[j]}` : j === i + 1 ? `${sorted[i]}, ${sorted[j]}` : `${sorted[i]}`);
    i = j + 1;
  }
  return out.join(', ');
}

/** Primary role per matched step, grouped: [{ role, positions }] in ROLE_ORDER, empties dropped. */
export function roleSummary(hit) {
  const groups = {};
  (hit.steps || []).forEach((s) => {
    if (!s.matched) return;
    const role = (s.roles && s.roles[0]) || 'mentioned';
    (groups[role] = groups[role] || []).push(s.position);
  });
  return ROLE_ORDER.filter((r) => groups[r]).map((r) => ({ role: r, positions: groups[r] }));
}

/** "Does steps 1–3, 6 · receives 4, 12 · named in 7" — the person-mode answer line. */
export function roleSentence(hit) {
  const parts = roleSummary(hit).map((g, i) => {
    const label = i === 0 ? ROLE_LABELS[g.role] : ROLE_LABELS[g.role].toLowerCase();
    const noun = i === 0 && g.role === 'does' ? (g.positions.length === 1 ? 'step ' : 'steps ') : '';
    return `${label} ${noun}${ranges(g.positions)}`;
  });
  return parts.join(' · ');
}

/** The first `n` matched step titles and how many more there are. */
export function matchedTitles(hit, n = TITLES_SHOWN) {
  const all = (hit.steps || []).filter((s) => s.matched).map((s) => s.title || '');
  return { titles: all.slice(0, n), more: Math.max(0, all.length - n) };
}

/** "Matches step 3, Check the temperature log, and step 5, Issue a credit" — the how-mode answer line. */
export function matchSentence(hit, n = 2) {
  const matched = (hit.steps || []).filter((s) => s.matched);
  if (!matched.length) return '';
  const named = matched.slice(0, n).map((s) => `step ${s.position}, ${s.title}`);
  const more = matched.length - named.length;
  return `Matches ${named.join(' and ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/** Distinct people of the flow with counts, matched ones flagged; capped for the card.
    A flagged person is always among the shown ones (the cap drops unflagged names first). */
export function castShown(hit, people, max = CAST_SHOWN) {
  const wanted = new Set((people || []).map(foldName));
  let members = hit.cast && hit.cast.length
    ? hit.cast.map((c) => ({ name: c.name, count: c.count || 1 }))
    : distinctChain(hit.chain || []);
  members = members.map((m) => ({ ...m, highlight: wanted.has(foldName(m.name)) }));
  if (members.length <= max) return { members, more: 0, hidden: [] };
  const shown = members.slice(0, max);
  const hiddenHits = members.slice(max).filter((m) => m.highlight);
  hiddenHits.forEach((m) => {
    const drop = shown.map((x, i) => (x.highlight ? -1 : i)).filter((i) => i >= 0).pop();
    if (drop !== undefined) shown.splice(drop, 1, m);
  });
  const shownNames = new Set(shown.map((m) => foldName(m.name)));
  const hidden = members.filter((m) => !shownNames.has(foldName(m.name)));
  return { members: shown, more: hidden.length, hidden: hidden.map((m) => m.name) };
}

/** Fallback for older responses without `cast`: fold the chain to distinct names with counts. */
export function distinctChain(chain) {
  const out = [];
  const idx = {};
  (chain || []).forEach((name) => {
    const key = foldName(name);
    if (key in idx) out[idx[key]].count += 1;
    else { idx[key] = out.length; out.push({ name, count: 1 }); }
  });
  return out;
}

/** The one-line results header: { strong, rest, note }. */
export function resultHeadline(data) {
  const n = (data.results || []).length;
  const total = data.matched_total != null ? data.matched_total : n;
  const documented = data.total_processes != null ? ` of ${data.total_processes}` : '';
  const note = total > n ? `showing the first ${n}` : '';
  // (the view adds a "show the rest" control beside the note when the service cap allows it)
  if (data.mode === 'person') {
    const people = data.people || [];
    if (!n) return { strong: `“${data.query}”`, rest: ' is not named in any documented process', note: '' };
    if (people.length > 1) return { strong: `“${data.query}”`, rest: ` matches ${people.length} people`, note: '' };
    const who = people[0] || `“${data.query}”`;
    return { strong: who, rest: ` is in ${total}${documented} processes`, note };
  }
  if (!n) return { strong: '', rest: 'No documented process describes this', note: '' };
  const plural = documented ? data.total_processes !== 1 : total !== 1;
  return { strong: `${total}`, rest: `${documented} process${plural ? 'es' : ''} describe${total === 1 ? 's' : ''} this`, note };
}

/** When the user let the search decide, offer the other reading. */
export function autoSwitchHint(data, requestedMode) {
  if (requestedMode !== 'auto') return null;
  return data.mode === 'person'
    ? { mode: 'how', label: 'Search it as a situation instead' }
    : { mode: 'person', label: 'Search it as a person or role instead' };
}

/** Fit chip for a situation result (the same "NN% fit" the Playbooks tab shows); none for a person result. */
export function fitText(hit, mode) {
  if (mode === 'person') return null;
  return `${Math.round((hit.score || 0) * 100)}% fit`;
}

/** "#process-search?q=…&mode=…" <-> { q, mode }, so Back returns to the previous search. */
export function hashForSearch(q, mode) {
  const p = new URLSearchParams();
  p.set('q', q);
  if (mode && mode !== 'auto') p.set('mode', mode);
  return `#process-search?${p.toString()}`;
}

export function searchStateFromHash(hash) {
  const h = String(hash || '').replace(/^#/, '');
  if (!h.startsWith('process-search')) return null;
  const qs = h.includes('?') ? h.slice(h.indexOf('?') + 1) : '';
  const p = new URLSearchParams(qs);
  const q = (p.get('q') || '').trim();
  const mode = p.get('mode') || 'auto';
  return q ? { q, mode: SEARCH_MODES.some((m) => m.value === mode) ? mode : 'auto' } : { q: '', mode: 'auto' };
}
