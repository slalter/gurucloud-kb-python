/* Process search view — the reverse of the Playbooks list: search for a
   person or role and get every documented process they are part of (and
   which steps are theirs), or describe a situation and get the flows that
   handle it. Each result is a Playbooks-style row; clicking it opens the
   shared process detail with the matching hand-offs highlighted. The search
   lives in the URL hash so Back returns to the previous search.

   Data roles for E2E: psearch-query, psearch-search, psearch-mode,
   psearch-headline, psearch-switch, psearch-person, psearch-result,
   psearch-answer, psearch-cast-name. */

import { h, mount, skeleton, empty, timeAgo } from './dom.js';
import { openPlaybookDetail } from './playbook_detail.js';
import {
  SEARCH_MODES, PLACEHOLDERS, PAGE, PAGE_MAX, roleSentence, matchedTitles, matchSentence, castShown,
  resultHeadline, autoSwitchHint, fitText, hashForSearch, searchStateFromHash,
} from './process_search_model.js';

export function createProcessSearchView(ctx) {
  const { api } = ctx;
  const el = h('div', {});
  let mode = 'auto';   // the active chip; a cast click or the switch link moves it to what they search as
  let seq = 0;         // only the newest search may render
  let current = null;  // { q, mode, limit } of the search on screen, for re-runs after an edit

  const input = h('input', { class: 'kbx-input', type: 'search', dataset: { role: 'psearch-query' }, placeholder: PLACEHOLDERS.auto, 'aria-label': 'Search processes' });
  const modeHost = h('div', { class: 'kbx-filter-chips', role: 'group', 'aria-label': 'Search for' });
  const resultHost = h('div', {});
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(input.value); });
  input.addEventListener('search', () => { if (!input.value.trim()) reset(true); });

  function renderModes() {
    mount(modeHost, ...SEARCH_MODES.map((m) => h('button', {
      class: `kbx-filter-chip${m.value === mode ? ' is-active' : ''}`,
      type: 'button',
      dataset: { role: 'psearch-mode', mode: m.value },
      'aria-pressed': m.value === mode ? 'true' : 'false',
      onClick: () => { setMode(m.value); if (input.value.trim()) run(input.value); },
    }, m.label)));
    input.placeholder = PLACEHOLDERS[mode] || PLACEHOLDERS.auto;
  }
  function setMode(value) { mode = value; renderModes(); }
  renderModes();

  mount(el,
    h('div', { class: 'kbx-card' },
      h('div', { class: 'kbx-card-head' },
        h('div', {}, h('h3', { class: 'kbx-card-title' }, 'Process search'), h('div', { class: 'kbx-card-sub' }, 'Every process a person or role is part of, or how a situation is handled.'))),
      modeHost,
      h('div', { class: 'kbx-searchbar kbx-mt' },
        input,
        h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', dataset: { role: 'psearch-search' }, onClick: () => run(input.value) }, 'Search')),
      h('div', { class: 'kbx-mt-lg' }, resultHost)));

  function reset(updateHash) {
    seq++;
    current = null;
    mount(resultHost, empty('bi-signpost-split', 'Search your processes', 'Who someone is, or what happened.'));
    if (updateHash) history.pushState(null, '', '#process-search');
  }
  reset(false);

  async function run(query, { mode: override, push = true, limit = PAGE, scrollTo = false } = {}) {
    const q = String(query || '').trim();
    if (!q) return;
    if (override && override !== mode) setMode(override);
    const useMode = mode;
    input.value = q;
    const mine = ++seq;
    mount(resultHost, skeleton('Searching processes…'));
    try {
      const data = await api.searchProcesses({ q, mode: useMode, limit });
      if (mine !== seq) return;
      current = { q, mode: useMode, limit };
      if (push) history.pushState(null, '', hashForSearch(q, useMode));
      render(data, useMode, limit);
      if (scrollTo) el.scrollIntoView({ block: 'start' });
    } catch (e) {
      if (mine !== seq) return;
      mount(resultHost, h('div', { class: 'kbx-alert danger' }, `Could not load: ${e.message}`));
    }
  }

  const rerun = () => { if (current) run(current.q, { mode: current.mode, push: false, limit: current.limit }); };

  function render(data, requestedMode, limit) {
    const results = data.results || [];
    const people = data.people || [];
    const head = resultHeadline(data);
    const hint = autoSwitchHint(data, requestedMode);
    const total = data.matched_total != null ? data.matched_total : results.length;
    const rest = total - results.length;
    const canShowMore = rest > 0 && limit < PAGE_MAX;
    const headline = h('p', { class: 'kbx-psearch-head', role: 'status', 'aria-live': 'polite', dataset: { role: 'psearch-headline' } },
      head.strong ? h('strong', {}, head.strong) : null,
      head.rest,
      head.note ? h('span', { class: 'kbx-muted' }, ` · ${head.note}`) : null,
      canShowMore ? h('button', { class: 'kbx-link-btn', type: 'button', dataset: { role: 'psearch-more' }, onClick: () => run(data.query, { push: false, limit: PAGE_MAX }) }, total <= PAGE_MAX ? `show all ${total}` : `show the first ${PAGE_MAX}`) : null,
      hint ? h('button', { class: 'kbx-link-btn', type: 'button', dataset: { role: 'psearch-switch', mode: hint.mode }, onClick: () => run(data.query, { mode: hint.mode }) }, hint.label) : null);
    const pickPerson = data.mode === 'person' && people.length > 1
      ? h('div', { class: 'kbx-filter-chips', role: 'group', 'aria-label': 'People matched' },
          ...people.map((name) => h('button', { class: 'kbx-filter-chip', type: 'button', dataset: { role: 'psearch-person' }, onClick: () => run(name, { mode: 'person', scrollTo: true }) }, name)))
      : null;
    if (!results.length) {
      mount(resultHost, headline, h('p', { class: 'kbx-muted kbx-psearch-hint' }, data.mode === 'person'
        ? 'Try a first name alone, a role word, or search it as a situation.'
        : 'Try other words for what happened, or search for the person who would handle it.'));
      return;
    }
    const list = h('div', { class: 'kbx-list' });
    results.forEach((hit) => list.append(resultRow(hit, data.mode, people)));
    mount(resultHost, headline, pickPerson, list);
  }

  function resultRow(hit, resultMode, people) {
    const open = () => openPlaybookDetail(ctx, hit.slug, { onChanged: rerun, highlight: hit.matched_positions || [] });
    const fit = fitText(hit, resultMode);
    const n = hit.step_count || (hit.steps || []).length;
    return h('div', { class: 'kbx-item', dataset: { role: 'psearch-result', slug: hit.slug }, role: 'button', tabindex: '0', onClick: open, onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } },
      h('div', { class: 'kbx-item-head' },
        h('div', { class: 'kbx-item-title' }, hit.title),
        fit ? h('span', { class: 'kbx-chip', title: 'How closely this process’s description matches your words' }, fit) : null),
      answerLine(hit, resultMode),
      hit.summary || hit.about ? h('div', { class: 'kbx-item-body kbx-muted kbx-clamp-2' }, hit.summary || hit.about) : null,
      h('div', { class: 'kbx-item-meta' },
        h('span', {}, h('i', { class: 'bi bi-arrow-left-right' }), ` ${n} hand-off${n === 1 ? '' : 's'}`),
        castLine(hit, people),
        hit.owner_role ? h('span', {}, h('i', { class: 'bi bi-person-badge' }), ` owner: ${hit.owner_role}`) : null,
        h('span', { class: 'kbx-mono' }, hit.slug),
        hit.updated_at ? h('span', {}, `updated ${timeAgo(hit.updated_at)}`) : null));
  }

  function answerLine(hit, resultMode) {
    if (resultMode === 'person') {
      const { titles, more } = matchedTitles(hit);
      return h('div', { class: 'kbx-psearch-answer', dataset: { role: 'psearch-answer' } },
        h('span', { class: 'kbx-strong' }, roleSentence(hit)),
        titles.length ? h('span', { class: 'kbx-muted' }, ` — ${titles.join(' · ')}${more ? ` +${more} more` : ''}`) : null);
    }
    const sentence = matchSentence(hit);
    return sentence ? h('div', { class: 'kbx-psearch-answer', dataset: { role: 'psearch-answer' } }, h('span', { class: 'kbx-strong' }, sentence)) : null;
  }

  function castLine(hit, people) {
    const { members, more, hidden } = castShown(hit, people);
    if (!members.length) return null;
    const row = h('span', { class: 'kbx-cast', role: 'list', 'aria-label': 'People in this flow' }, h('i', { class: 'bi bi-people', 'aria-hidden': 'true' }));
    members.forEach((m, i) => {
      row.append(h('span', { role: 'listitem' },
        h('button', {
          class: `kbx-cast-name${m.highlight ? ' is-hit' : ''}`,
          type: 'button',
          dataset: { role: 'psearch-cast-name' },
          title: `Every process ${m.name} is part of`,
          onClick: (e) => { e.stopPropagation(); run(m.name, { mode: 'person', scrollTo: true }); },
        }, m.name),
        m.count > 1 ? h('span', { class: 'kbx-cast-count', title: `in ${m.count} steps` }, ` ×${m.count}`) : null,
        i < members.length - 1 || more ? h('span', { class: 'kbx-muted', 'aria-hidden': 'true' }, ' · ') : null));
    });
    if (more) row.append(h('span', { class: 'kbx-muted', title: hidden.join(', ') }, `+${more} more`));
    return row;
  }

  function restoreFromHash() {
    const state = searchStateFromHash(location.hash);
    if (!state) return;
    if (state.q) {
      setMode(state.mode);
      run(state.q, { push: false });
    } else {
      input.value = '';
      reset(false);
    }
  }
  window.addEventListener('popstate', restoreFromHash);

  return {
    el,
    load() {
      // main.js rewrites the hash to the bare tab id right after load(); restore on the next tick so the query survives.
      const state = searchStateFromHash(location.hash);
      setTimeout(() => {
        if (state && state.q) { history.replaceState(null, '', hashForSearch(state.q, state.mode)); restoreFromHash(); }
        input.focus();
      }, 0);
    },
    onShow() { input.focus(); },
  };
}
