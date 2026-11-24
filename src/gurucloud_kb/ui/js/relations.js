/* Relations view — the kinds of connection this bank has (kanban 6b4fd3bf).

   One row per relation of the bank's vocabulary (GET /edge-types): its
   colour (the same one the Graph tab draws it in), how it reads from each
   side, what it means, where it came from (built in, declared by a person,
   coined through the judge), and how many connections use it. Selecting a row
   lists the connections of that type (GET /edges?edge_type=&include_ends)
   and offers them in the Graph tab. Editors can let agents coin relations
   (PUT /edge-relations/open), add one themselves through the same judge
   (POST /edge-relations/propose), read the vocabulary's history
   (GET /edge-relations/events), and fold a relation the bank added into
   another or remove an unused one (POST /edge-relations/<name>/merge and
   /retire, kanban 1a2a5590). Pure logic lives in relations_model.js. */

import { h, mount, toast, skeleton, empty, num, timeAgo, fmtDate } from './dom.js';
import { openEntryDetail } from './entry_detail.js';
import { openModal, confirmModal } from './modal.js';
import {
  buildMerge, buildProposal, manageRefusal, mergeOutcome, mergeTargets, proposalOutcome, relationManage, relationRows, relationSummary,
} from './relations_model.js';

const EDGE_PAGE = 25;
const EVENT_LABEL = {
  added: 'added', use_existing: 'mapped to', exists: 'already existed', refused_closed: 'refused (closed)',
  opened: 'opened to agents', closed: 'closed to agents', merged: 'merged into', retired: 'removed',
};

export function createRelationsView(ctx) {
  const { api } = ctx;
  const el = h('div', {});
  let loaded = false;
  let data = null;
  let selected = null;
  let sort = 'vocabulary';
  let query = '';

  const tilesHost = h('div', { class: 'kbx-tiles', style: { marginBottom: '16px' }, dataset: { role: 'relations-tiles' } });
  const listHost = h('div', { dataset: { role: 'relations-list' } });
  const detailHost = h('div', { dataset: { role: 'relations-detail' } });
  const openHost = h('div', { dataset: { role: 'relations-open' } });

  const searchInput = h('input', { class: 'kbx-input', type: 'search', placeholder: 'Filter relations…', style: { maxWidth: '260px' }, dataset: { role: 'relations-filter', action: 'relations_filter', recordValue: 'query' } });
  searchInput.addEventListener('input', () => { query = searchInput.value; renderList(); });
  const sortSel = h('select', { class: 'kbx-select', style: { maxWidth: '200px' }, dataset: { role: 'relations-sort', action: 'relations_sort', recordValue: 'sort' } },
    h('option', { value: 'vocabulary' }, 'Vocabulary order'), h('option', { value: 'count' }, 'Most used first'));
  sortSel.addEventListener('change', () => { sort = sortSel.value; renderList(); });
  const addBtn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button', dataset: { role: 'relations-add', action: 'relations_add_open', outcome: 'open' }, onClick: openAdd }, h('i', { class: 'bi bi-plus-lg' }), 'Add relation');
  const historyBtn = h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', dataset: { role: 'relations-history', action: 'relations_history_open', outcome: 'open' }, onClick: () => openHistory(null) }, h('i', { class: 'bi bi-clock-history' }), 'History');

  mount(el,
    h('div', { class: 'kbx-card' },
      h('div', { class: 'kbx-card-head' },
        h('div', {}, h('h3', { class: 'kbx-card-title' }, 'Relations'),
          h('div', { class: 'kbx-card-sub' }, 'The kinds of connection entries in this bank can have. Agents pick from this list when they connect two entries, and each one is drawn in its own colour in the Graph tab.')),
        h('div', { class: 'kbx-row', style: { gap: '6px' } }, historyBtn, addBtn)),
      openHost),
    tilesHost,
    h('div', { class: 'kbx-row', style: { gap: '8px', marginBottom: '10px' } }, searchInput, sortSel),
    h('div', { class: 'kbx-rel-stage' }, listHost, detailHost));

  function tile(label, value, sub) {
    return h('div', { class: 'kbx-tile' }, h('div', { class: 'kbx-tile-label' }, label), h('div', { class: 'kbx-tile-value' }, value, sub ? h('small', {}, ` ${sub}`) : null));
  }

  function swatch(color) { return h('i', { class: 'kbx-rel-swatch', style: { background: color } }); }

  function renderOpen() {
    const s = relationSummary(data);
    const editor = ctx.canEdit ? ctx.canEdit() : true;
    const box = h('input', { type: 'checkbox', checked: s.open, disabled: !editor, dataset: { role: 'relations-open-toggle', action: 'relations_open_toggle', recordValue: 'open' } });
    box.addEventListener('change', () => setOpen(box.checked, box));
    mount(openHost, h('div', { class: `kbx-alert kbx-rel-open ${s.open ? 'info' : ''}` },
      h('label', { class: 'kbx-check' }, box, h('span', { class: 'kbx-strong' }, 'Agents may add relations')),
      h('div', { class: 'kbx-rel-open-state', dataset: { role: 'relations-open-state' } }, s.open
        ? 'Open: an agent that finds no fitting relation proposes one. A judge checks it against this list first, so a relation that already exists under another name is reused instead of added.'
        : 'Closed: agents choose from the list below. Turn this on to let the list grow from what agents actually need to say.')));
    addBtn.style.display = editor ? '' : 'none';
  }

  async function setOpen(open, box) {
    box.disabled = true;
    try {
      await api.setEdgeRelationsOpen({ open });
      toast(open ? 'Agents can now add relations to this bank.' : 'The relation list is closed to agents.', 'success');
      await reload();
    } catch (e) {
      box.checked = !open;
      toast(`Could not change it: ${e.message}`, 'error');
    } finally { box.disabled = false; }
  }

  function renderTiles() {
    const s = relationSummary(data);
    mount(tilesHost,
      tile('Relations', num(s.total), `${num(s.inUse)} in use`),
      tile('Connections', num(s.edges)),
      tile('Coined', num(s.coined), 'added through the judge'),
      tile('Declared', num(s.declared), 'set on the schema'));
  }

  function renderList() {
    const rows = relationRows(data, { sort, query });
    if (!rows.length) { mount(listHost, empty('bi-diagram-3', 'No relation matches', 'Clear the filter to see the whole list.')); return; }
    const max = Math.max(1, ...rows.map((r) => r.count));
    const table = h('table', { class: 'kbx-table kbx-rel-table' },
      h('thead', {}, h('tr', {}, ...['Relation', 'Meaning', 'From', 'Connections'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...rows.map((r) => h('tr', {
        class: selected === r.name ? 'is-selected' : '', tabindex: '0',
        dataset: { role: 'relation-row', relation: r.name, origin: r.origin, action: 'relation_open', targetRelation: r.name, outcome: 'panel' },
        onClick: () => select(r.name), onKeydown: (e) => { if (e.key === 'Enter') select(r.name); },
      },
      h('td', {}, h('div', { class: 'kbx-rel-name' }, swatch(r.color), h('span', { class: 'kbx-mono kbx-strong' }, r.name)),
        h('div', { class: 'kbx-muted kbx-rel-phrase' }, `A ${r.forward} B`, r.back && r.back !== r.forward ? ` · B ${r.back} A` : '')),
      h('td', { class: 'kbx-rel-meaning' }, r.description || h('span', { class: 'kbx-muted' }, 'No description.')),
      h('td', {}, h('span', { class: `kbx-chip ${r.originTone}`, title: r.coinedAt ? `${r.coinedBy || 'agent'} · ${fmtDate(r.coinedAt)}` : '' }, r.originLabel)),
      h('td', { class: 'kbx-num' }, h('div', { class: 'kbx-rel-count' }, num(r.count)),
        h('div', { class: 'kbx-rel-bar' }, h('i', { style: { width: `${Math.round((r.count / max) * 100)}%`, background: r.color } })))))));
    mount(listHost, h('div', { class: 'kbx-table-wrap' }, table));
  }

  function renderDetailHint() {
    mount(detailHost, h('div', { class: 'kbx-side-card' }, h('div', { class: 'kbx-side-title' }, 'Connections of a relation'),
      h('div', { class: 'kbx-hint' }, 'Select a relation to see the connections that use it.')));
  }

  function endLine(ends, id, fallback) {
    const end = ends && ends[id];
    const text = (end && (end.summary || end.useful_for || end.snippet)) || fallback || String(id || '').slice(0, 8);
    return h('a', { href: '#', class: 'kbx-conn-other', dataset: { action: 'entry_open', targetEntryId: id, outcome: 'open' }, onClick: (e) => { e.preventDefault(); openEntryDetail(ctx, id); } }, text);
  }

  async function select(name, offset = 0) {
    selected = name;
    renderList();
    const row = relationRows(data).find((r) => r.name === name);
    if (!row) { renderDetailHint(); return; }
    const head = h('div', {},
      h('div', { class: 'kbx-rel-name', style: { marginBottom: '6px' } }, swatch(row.color), h('span', { class: 'kbx-mono kbx-strong' }, row.name), h('span', { class: `kbx-chip ${row.originTone}` }, row.originLabel)),
      h('div', { style: { fontSize: '13px', lineHeight: 1.5 } }, row.description || 'No description.'),
      h('div', { class: 'kbx-muted', style: { fontSize: '12px', marginTop: '4px' } },
        [row.symmetric ? 'reads the same both ways' : null, row.transitive ? 'carries across a removed entry' : null,
          row.representative ? `the ${row.representative === 'from' ? 'from' : 'to'} side stands for the pair in search` : null,
          row.system ? 'also written by the service' : null,
          row.coinedAt ? `coined ${timeAgo(row.coinedAt)} by ${row.coinedBy || 'an agent'}` : null].filter(Boolean).join(' · ')),
      h('div', { class: 'kbx-row', style: { gap: '6px', marginTop: '10px' } },
        h('button', { class: 'kbx-btn kbx-btn-sm kbx-btn-primary', type: 'button', disabled: !row.count, dataset: { role: 'relation-show-graph', action: 'relation_show_in_graph', targetRelation: row.name, outcome: 'page' }, onClick: () => showInGraph(row.name) }, h('i', { class: 'bi bi-share' }), 'Show in graph'),
        h('button', { class: 'kbx-btn kbx-btn-sm kbx-btn-ghost', type: 'button', dataset: { role: 'relation-history', action: 'relations_history_open', targetRelation: row.name, outcome: 'open' }, onClick: () => openHistory(row.name) }, 'History'),
        ...manageButtons(row)));
    const edgesHost = h('div', { style: { marginTop: '12px' }, dataset: { role: 'relation-edges' } }, row.count ? skeleton('Loading connections…') : h('div', { class: 'kbx-hint' }, 'No connection uses this relation yet.'));
    mount(detailHost, h('div', { class: 'kbx-side-card' }, h('div', { class: 'kbx-side-title' }, `${num(row.count)} connection${row.count === 1 ? '' : 's'}`), head, edgesHost));
    if (!row.count) return;
    let page;
    try { page = await api.listEdges({ edge_type: name, limit: EDGE_PAGE, offset, include_ends: true }); }
    catch (e) { mount(edgesHost, h('div', { class: 'kbx-alert danger' }, `Could not load connections: ${e.message}`)); return; }
    if (selected !== name) return;
    const edges = (page && page.edges) || [];
    const ends = (page && page.ends) || {};
    const pager = h('div', { class: 'kbx-row', style: { gap: '6px', marginTop: '8px', alignItems: 'center' } },
      h('span', { class: 'kbx-muted', style: { fontSize: '12px' } }, edges.length ? `${offset + 1}–${offset + edges.length} of ${num(row.count)}` : ''),
      offset > 0 ? h('button', { class: 'kbx-btn kbx-btn-sm kbx-btn-ghost', type: 'button', dataset: { action: 'relation_edges_page', recordValue: 'direction', targetRelation: name }, value: 'previous', onClick: () => select(name, Math.max(0, offset - EDGE_PAGE)) }, 'Previous') : null,
      offset + edges.length < row.count ? h('button', { class: 'kbx-btn kbx-btn-sm kbx-btn-ghost', type: 'button', dataset: { action: 'relation_edges_page', recordValue: 'direction', targetRelation: name }, value: 'next', onClick: () => select(name, offset + EDGE_PAGE) }, 'Next') : null);
    mount(edgesHost,
      h('div', { class: 'kbx-conn-list' }, ...edges.map((e) => h('div', { class: 'kbx-rel-edge', dataset: { role: 'relation-edge' }, style: { borderLeftColor: row.color } },
        h('div', {}, endLine(ends, e.from_entry_id)),
        h('div', { class: 'kbx-rel-edge-verb' }, row.forward),
        h('div', {}, e.to_entry_id ? endLine(ends, e.to_entry_id) : h('span', { class: 'kbx-muted' }, `step ${e.to_playbook_slug}#${e.to_step_key}`)),
        e.note ? h('div', { class: 'kbx-conn-note' }, e.note) : null))),
      pager);
  }

  function showInGraph(name) {
    ctx.relationFocus = name;
    ctx.activate('graph');
  }

  // ── add a relation (the same judge an agent's proposal goes through) ───────
  function openAdd() {
    const nameIn = h('input', { class: 'kbx-input', placeholder: 'blocks', maxlength: '32', dataset: { role: 'relation-add-name' } });
    const descIn = h('textarea', { class: 'kbx-textarea', placeholder: 'A prevents B from proceeding until A is resolved', maxlength: '500', dataset: { role: 'relation-add-description' } });
    const invIn = h('input', { class: 'kbx-input', placeholder: 'is blocked by', maxlength: '80', dataset: { role: 'relation-add-inverse' } });
    const symIn = h('input', { type: 'checkbox', dataset: { role: 'relation-add-symmetric' } });
    const msg = h('div', { dataset: { role: 'relation-add-message' } });
    const submit = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button', dataset: { role: 'relation-add-submit', action: 'relations_add_submit', outcome: 'request' } }, 'Add relation');
    const modal = openModal({
      title: 'Add a relation',
      body: h('div', {},
        h('div', { class: 'kbx-field' }, h('label', {}, 'Name'), nameIn, h('div', { class: 'kbx-hint' }, 'Lowercase letters, digits and underscores.')),
        h('div', { class: 'kbx-field' }, h('label', {}, 'What it means, from A to B'), descIn),
        h('div', { class: 'kbx-field' }, h('label', {}, 'How it reads from B to A (optional)'), invIn),
        h('div', { class: 'kbx-field' }, h('label', { class: 'kbx-check' }, symIn, 'Reads the same both ways')),
        msg),
      footer: [submit],
    });
    submit.addEventListener('click', async () => {
      let body;
      try { body = buildProposal({ name: nameIn.value, description: descIn.value, inverse: invIn.value, symmetric: symIn.checked }); }
      catch (e) { mount(msg, h('div', { class: 'kbx-alert danger' }, e.message)); return; }
      submit.disabled = true;
      mount(msg, skeleton('Checking it against the relations this bank already has…'));
      try {
        const result = await api.proposeEdgeRelation(body);
        const outcome = proposalOutcome(result);
        if (result.status === 'added') { modal.close(); toast(outcome.text, 'success'); await reload(); select(result.use); return; }
        mount(msg, h('div', { class: 'kbx-alert info', dataset: { role: 'relation-add-outcome', status: result.status } }, outcome.text));
      } catch (e) {
        mount(msg, h('div', { class: 'kbx-alert danger' }, e.status === 403
          ? 'This bank’s relation list is closed. Turn on “Agents may add relations” first.'
          : `Could not add it: ${e.message}`));
      } finally { submit.disabled = false; }
    });
  }

  // ── merge / remove a relation the bank added (kanban 1a2a5590) ─────────────
  function manageButtons(row) {
    const editor = ctx.canEdit ? ctx.canEdit() : true;
    const manage = relationManage(row);
    if (!editor || !manage.canMerge) return [];
    return [
      h('button', { class: 'kbx-btn kbx-btn-sm kbx-btn-ghost', type: 'button', title: 'Move its connections to another relation and take it off the list', dataset: { role: 'relation-merge', action: 'relation_merge_open', targetRelation: row.name, outcome: 'open' }, onClick: () => openMerge(row) }, h('i', { class: 'bi bi-sign-merge-right' }), 'Merge into…'),
      h('button', { class: 'kbx-btn kbx-btn-sm kbx-btn-danger', type: 'button', disabled: !manage.canRetire, title: manage.canRetire ? 'Take this unused relation off the list' : manage.why, dataset: { role: 'relation-retire', action: 'relation_retire_open', targetRelation: row.name, outcome: 'open' }, onClick: () => retire(row) }, h('i', { class: 'bi bi-trash' }), 'Remove'),
    ];
  }

  async function retire(row) {
    const ok = await confirmModal({
      title: `Remove “${row.name}”?`,
      message: 'No connection uses this relation. It leaves the list agents pick from; its history is kept.',
      confirmLabel: 'Remove relation',
    });
    if (!ok) return;
    try {
      await api.retireEdgeRelation(row.name, {});
      toast(`Removed “${row.name}”.`, 'success');
      selected = null;
      renderDetailHint();
      await reload();
    } catch (e) { toast(manageRefusal(e), 'error'); }
  }

  function openMerge(row) {
    const targets = mergeTargets(data, row.name);
    const intoSel = h('select', { class: 'kbx-select', dataset: { role: 'relation-merge-into', action: 'relation_merge_target', recordValue: 'into' } },
      h('option', { value: '' }, 'Choose the relation to keep…'), ...targets.map((t) => h('option', { value: t.name, title: t.description }, t.label)));
    const swapIn = h('input', { type: 'checkbox', dataset: { role: 'relation-merge-swap', action: 'relation_merge_swap', recordValue: 'swap_ends' } });
    const reasonIn = h('input', { class: 'kbx-input', placeholder: 'Why these two mean the same (kept in the history)', maxlength: '1000', dataset: { role: 'relation-merge-reason' } });
    const msg = h('div', { dataset: { role: 'relation-merge-message' } });
    const preview = h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', dataset: { role: 'relation-merge-preview', action: 'relation_merge_preview', targetRelation: row.name, outcome: 'request' } }, 'Preview');
    const submit = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button', disabled: true, dataset: { role: 'relation-merge-submit', action: 'relation_merge_submit', targetRelation: row.name, outcome: 'request' } }, 'Merge');
    const modal = openModal({
      title: `Merge “${row.name}” into another relation`,
      body: h('div', {},
        h('p', { style: { marginTop: 0, lineHeight: 1.5 } }, `Every connection typed “${row.name}” (${num(row.count)}) is retyped to the relation you keep, and “${row.name}” leaves the list. Each connection keeps its note and history.`),
        h('div', { class: 'kbx-field' }, h('label', {}, 'Keep'), intoSel),
        h('div', { class: 'kbx-field' }, h('label', { class: 'kbx-check' }, swapIn, 'It reads from the other end (swap the two entries of each connection)'),
          h('div', { class: 'kbx-hint' }, `Tick this when “A ${row.forward} B” means “B (kept relation) A”.`)),
        h('div', { class: 'kbx-field' }, h('label', {}, 'Reason (optional)'), reasonIn),
        msg),
      footer: [preview, submit],
    });
    // A changed choice needs a fresh preview before it can be confirmed.
    const stale = () => { submit.disabled = true; mount(msg); };
    intoSel.addEventListener('change', stale);
    swapIn.addEventListener('change', stale);

    async function run(dryRun) {
      let body;
      try { body = buildMerge({ name: row.name, into: intoSel.value, swapEnds: swapIn.checked, reason: reasonIn.value, dryRun }); }
      catch (e) { mount(msg, h('div', { class: 'kbx-alert danger' }, e.message)); return null; }
      preview.disabled = true; submit.disabled = true;
      mount(msg, skeleton(dryRun ? 'Counting what would change…' : 'Merging…'));
      try {
        const result = await api.mergeEdgeRelation(row.name, body);
        const outcome = mergeOutcome(result);
        mount(msg, h('div', { class: `kbx-alert ${outcome.tone === 'warn' ? 'warn' : 'info'}`, dataset: { role: 'relation-merge-outcome', dryRun: String(Boolean(result.dry_run)) } }, outcome.text));
        submit.disabled = !dryRun;
        return result;
      } catch (e) {
        mount(msg, h('div', { class: 'kbx-alert danger', dataset: { role: 'relation-merge-error' } }, manageRefusal(e)));
        return null;
      } finally { preview.disabled = false; }
    }
    preview.addEventListener('click', () => run(true));
    submit.addEventListener('click', async () => {
      const result = await run(false);
      if (!result) return;
      modal.close();
      toast(mergeOutcome(result).text, mergeOutcome(result).tone === 'warn' ? 'warning' : 'success');
      await reload();
      select(result.into);
    });
  }

  // ── history ────────────────────────────────────────────────────────────────
  async function openHistory(relation) {
    const body = h('div', {}, skeleton('Loading history…'));
    openModal({ title: relation ? `History of “${relation}”` : 'Relation history', body, wide: true });
    let events;
    try { events = ((await api.edgeRelationEvents(relation ? { relation, limit: 100 } : { limit: 100 })) || {}).events || []; }
    catch (e) { mount(body, h('div', { class: 'kbx-alert danger' }, `Could not load the history: ${e.message}`)); return; }
    if (!events.length) { mount(body, empty('bi-clock-history', 'Nothing yet', 'Proposals, and the list being opened or closed, appear here.')); return; }
    mount(body, h('div', { class: 'kbx-table-wrap' }, h('table', { class: 'kbx-table', dataset: { role: 'relation-events' } },
      h('thead', {}, h('tr', {}, ...['When', 'What', 'Relation', 'By', 'Why'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...events.map((ev) => {
        const judgement = (ev.payload && ev.payload.judgement) || null;
        const why = (judgement && judgement.reason) || ev.reason || (ev.payload && ev.payload.proposal && ev.payload.proposal.description) || '';
        return h('tr', { dataset: { role: 'relation-event', eventAction: ev.action } },
          h('td', { class: 'kbx-muted', style: { whiteSpace: 'nowrap' }, title: fmtDate(ev.created_at) }, timeAgo(ev.created_at)),
          h('td', {}, h('span', { class: `kbx-chip ${ev.action === 'added' || ev.action === 'opened' ? 'success' : ev.action.startsWith('refused') || ev.action === 'merged' || ev.action === 'retired' ? 'warn' : 'muted'}` }, EVENT_LABEL[ev.action] || ev.action)),
          h('td', { class: 'kbx-mono' }, ev.relation || '—', ev.resolved_relation && ev.resolved_relation !== ev.relation ? ` → ${ev.resolved_relation}` : ''),
          h('td', { class: 'kbx-mono', style: { fontSize: '11px', overflowWrap: 'anywhere', maxWidth: '180px' } }, ev.actor || '—'),
          h('td', { style: { fontSize: '12.5px' } }, why,
            ev.action === 'merged' && ev.payload && ev.payload.edges ? h('div', { class: 'kbx-muted' }, `${num(ev.payload.edges.retyped || 0)} retyped, ${num(ev.payload.edges.duplicates_removed || 0)} duplicate${ev.payload.edges.duplicates_removed === 1 ? '' : 's'} removed${ev.payload.request && ev.payload.request.swap_ends ? ', ends swapped' : ''}`) : null,
            judgement && judgement.outcome && judgement.outcome !== 'new' && judgement.outcome !== 'same_as' ? h('div', { class: 'kbx-muted' }, 'added without a duplicate check') : null));
      })))));
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  async function reload() {
    try { data = await api.edgeTypes(); }
    catch (e) {
      mount(listHost, h('div', { class: 'kbx-alert danger' }, e.status === 404
        ? 'This knowledge bank service does not list relation types yet (it predates the Relations tab).'
        : `Could not load relations: ${e.message}`));
      return false;
    }
    ctx.relationVocabulary = data;
    renderOpen(); renderTiles(); renderList();
    return true;
  }

  async function load() {
    if (loaded) return;
    loaded = true;
    mount(listHost, skeleton('Loading relations…'));
    renderDetailHint();
    await reload();
  }
  function onShow() { reload().then((ok) => { if (ok && selected) select(selected); }); }

  return { el, load, onShow };
}
