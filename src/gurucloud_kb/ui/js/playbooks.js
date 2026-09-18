/* Playbooks view — first-class procedures beside entries.
   Ranked, searchable list with a status filter and stat chips. Detail, version
   history, editor and delete live in playbook_detail.js / playbook_editor.js so
   the Map and entry detail can open the same modals. */

import { h, mount, clear, skeleton, empty, timeAgo } from './dom.js';
import { openPlaybookDetail, STATUS_CHIP } from './playbook_detail.js';
import { openPlaybookEditor } from './playbook_editor.js';

export function createPlaybooksView(ctx) {
  const { api } = ctx;
  const el = h('div', {});
  let loaded = false;

  const statHost = h('div', { class: 'kbx-row', style: { gap: '8px' } });
  const queryInput = h('input', { class: 'kbx-input', type: 'search', placeholder: 'Find a playbook by task…' });
  const statusSelect = h('select', { class: 'kbx-select', style: { width: 'auto' } },
    h('option', { value: 'active' }, 'Active'),
    h('option', { value: 'draft' }, 'Draft'),
    h('option', { value: 'superseded' }, 'Superseded'),
    h('option', { value: 'all' }, 'All statuses'));
  const listHost = h('div', {});

  queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadList(); });
  statusSelect.addEventListener('change', loadList);

  const reload = () => { loadStats(); loadList(); };
  const newBtn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button', onClick: () => openPlaybookEditor(ctx, null, { onSaved: reload }) }, h('i', { class: 'bi bi-plus-lg' }), 'New playbook');

  mount(el,
    h('div', { class: 'kbx-card' },
      h('div', { class: 'kbx-card-head' },
        h('div', {}, h('h3', { class: 'kbx-card-title' }, 'Playbooks'), h('div', { class: 'kbx-card-sub' }, 'Named, ordered procedures — matched whole and returned complete. Agents call list_playbooks → get_playbook.')),
        newBtn),
      statHost,
      h('div', { class: 'kbx-searchbar kbx-mt' },
        queryInput,
        h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, statusSelect),
        h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', onClick: loadList }, 'Search')),
      h('div', { class: 'kbx-mt-lg' }, listHost)));

  async function loadStats() {
    try {
      const s = await api.playbookStats();
      mount(statHost,
        chip('success', `${s.active ?? 0} active`),
        chip('warn', `${s.draft ?? 0} draft`),
        chip('muted', `${s.superseded ?? 0} superseded`));
    } catch { clear(statHost); }
  }
  function chip(kind, label) { return h('span', { class: `kbx-chip ${kind}` }, label); }

  async function loadList() {
    mount(listHost, skeleton('Loading playbooks…'));
    try {
      const data = await api.listPlaybooks({ query: queryInput.value.trim() || undefined, status: statusSelect.value, limit: 50 });
      const rows = (data && data.playbooks) || [];
      if (!rows.length) {
        mount(listHost, empty('bi-journal-text', 'No playbooks', 'Create one to capture a repeatable procedure for agents — or open an entry and choose “Promote to playbook”.'));
        return;
      }
      const list = h('div', { class: 'kbx-list' });
      rows.forEach((p) => list.append(playbookRow(p)));
      mount(listHost, list);
    } catch (e) {
      mount(listHost, h('div', { class: 'kbx-alert danger' }, `Could not load playbooks: ${e.message}`));
    }
  }

  function playbookRow(p) {
    return h('div', { class: 'kbx-item', dataset: { slug: p.slug }, onClick: () => openPlaybookDetail(ctx, p.slug, { onChanged: reload }) },
      h('div', { class: 'kbx-item-head' },
        h('div', { class: 'kbx-item-title' }, p.title),
        h('div', { class: 'kbx-row', style: { gap: '6px' } },
          p.score ? h('span', { class: 'kbx-chip' }, `${(p.score * 100).toFixed(0)}% fit`) : null,
          h('span', { class: `kbx-chip ${STATUS_CHIP[p.status] || 'muted'}` }, p.status))),
      h('div', { class: 'kbx-item-body kbx-muted' }, p.when_to_use),
      h('div', { class: 'kbx-item-meta' },
        h('span', {}, h('i', { class: 'bi bi-list-ol' }), ` ${p.step_count} step${p.step_count === 1 ? '' : 's'}`),
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
