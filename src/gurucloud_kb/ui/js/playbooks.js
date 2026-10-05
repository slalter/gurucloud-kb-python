/* Playbooks view — first-class procedures beside entries, and the documented
   PROCESSES that share their substrate (genre = 'process'; process_view.js).
   Ranked, searchable list with a genre filter, a status filter and stat chips.
   Detail, version history, editor and delete live in playbook_detail.js /
   playbook_editor.js so the Map and entry detail can open the same modals. */

import { h, mount, clear, skeleton, empty, timeAgo } from './dom.js';
import { openPlaybookDetail, STATUS_CHIP } from './playbook_detail.js';
import { openPlaybookEditor } from './playbook_editor.js';
import { GENRE_FILTERS, GENRE_PROCESS, isProcess, genreNoun } from './process_view.js';

export function createPlaybooksView(ctx) {
  const { api } = ctx;
  const el = h('div', {});
  let loaded = false;
  let genre = '';

  const statHost = h('div', { class: 'kbx-row', style: { gap: '8px' } });
  const genreHost = h('div', { class: 'kbx-filter-chips', dataset: { role: 'genre-filter' } });
  const queryInput = h('input', { class: 'kbx-input', type: 'search', placeholder: 'Find a playbook by task, or a process by flow…' });
  const statusSelect = h('select', { class: 'kbx-select', style: { width: 'auto' } },
    h('option', { value: 'active' }, 'Active'),
    h('option', { value: 'draft' }, 'Draft'),
    h('option', { value: 'superseded' }, 'Superseded'),
    h('option', { value: 'all' }, 'All statuses'));
  const listHost = h('div', {});

  queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadList(); });
  statusSelect.addEventListener('change', loadList);

  const reload = () => { loadStats(); loadList(); };
  const newBtn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button', onClick: () => openPlaybookEditor(ctx, null, { onSaved: reload, genre: genre || undefined }) }, h('i', { class: 'bi bi-plus-lg' }), 'New');

  function renderGenreChips() {
    mount(genreHost, ...GENRE_FILTERS.map((g) => h('button', {
      class: `kbx-filter-chip${g.value === genre ? ' is-active' : ''}`,
      type: 'button',
      dataset: { genre: g.value },
      'aria-pressed': g.value === genre ? 'true' : 'false',
      onClick: () => { genre = g.value; renderGenreChips(); reload(); },
    }, g.label)));
  }
  renderGenreChips();

  mount(el,
    h('div', { class: 'kbx-card' },
      h('div', { class: 'kbx-card-head' },
        h('div', {}, h('h3', { class: 'kbx-card-title' }, 'Playbooks & processes'), h('div', { class: 'kbx-card-sub' }, 'Playbooks are agent procedures, matched whole and returned complete (list_playbooks → get_playbook). Processes document how the client operates (list_processes → get_process) and are read, never run.')),
        newBtn),
      h('div', { class: 'kbx-row', style: { gap: '14px', alignItems: 'center', flexWrap: 'wrap' } }, genreHost, statHost),
      h('div', { class: 'kbx-searchbar kbx-mt' },
        queryInput,
        h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, statusSelect),
        h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', onClick: loadList }, 'Search')),
      h('div', { class: 'kbx-mt-lg' }, listHost)));

  async function loadStats() {
    try {
      const s = await api.playbookStats(genre ? { genre } : undefined);
      mount(statHost,
        chip('success', `${s.active ?? 0} active`),
        chip('warn', `${s.draft ?? 0} draft`),
        chip('muted', `${s.superseded ?? 0} superseded`));
    } catch { clear(statHost); }
  }
  function chip(kind, label) { return h('span', { class: `kbx-chip ${kind}` }, label); }

  async function loadList() {
    mount(listHost, skeleton(`Loading ${genreNoun(genre, 2)}…`));
    try {
      const params = { query: queryInput.value.trim() || undefined, status: statusSelect.value, limit: 50 };
      if (genre) params.genre = genre;
      const data = await api.listPlaybooks(params);
      const rows = (data && data.playbooks) || [];
      if (!rows.length) {
        mount(listHost, genre === GENRE_PROCESS
          ? empty('bi-diagram-3', 'No documented processes', 'Document how the client moves an order, request or exception from trigger to outcome — who does each step, in which system, who they hand to.')
          : empty('bi-journal-text', 'No playbooks', 'Create one to capture a repeatable procedure for agents — or open an entry and choose “Promote to playbook”.'));
        return;
      }
      const list = h('div', { class: 'kbx-list' });
      rows.forEach((p) => list.append(playbookRow(p)));
      mount(listHost, list);
    } catch (e) {
      mount(listHost, h('div', { class: 'kbx-alert danger' }, `Could not load: ${e.message}`));
    }
  }

  function playbookRow(p) {
    const process = isProcess(p);
    return h('div', { class: 'kbx-item', dataset: { slug: p.slug, genre: process ? 'process' : 'procedure' }, onClick: () => openPlaybookDetail(ctx, p.slug, { onChanged: reload }) },
      h('div', { class: 'kbx-item-head' },
        h('div', { class: 'kbx-item-title' }, p.title),
        h('div', { class: 'kbx-row', style: { gap: '6px' } },
          p.score ? h('span', { class: 'kbx-chip' }, `${(p.score * 100).toFixed(0)}% fit`) : null,
          h('span', { class: `kbx-chip ${process ? 'info' : ''}`, dataset: { role: 'genre' } }, process ? 'process' : 'playbook'),
          h('span', { class: `kbx-chip ${STATUS_CHIP[p.status] || 'muted'}` }, p.status))),
      h('div', { class: 'kbx-item-body kbx-muted' }, p.when_to_use),
      h('div', { class: 'kbx-item-meta' },
        h('span', {}, h('i', { class: process ? 'bi bi-arrow-left-right' : 'bi bi-list-ol' }), ` ${p.step_count} ${process ? 'hand-off' : 'step'}${p.step_count === 1 ? '' : 's'}`),
        h('span', {}, `v${p.version}`),
        h('span', { class: 'kbx-mono' }, p.slug),
        h('span', {}, `updated ${timeAgo(p.updated_at)}`)));
  }

  return {
    el,
    load() { if (!loaded) { loaded = true; reload(); } },
    reload,
    onShow() { if (loaded) reload(); },
  };
}
