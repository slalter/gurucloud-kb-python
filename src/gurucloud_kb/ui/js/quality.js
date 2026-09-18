/* Quality view — retrieval assertions, retrieval-eval runs, and clustering.
   Mirrors the SDK's list_assertions / create_assertion / delete_assertion,
   run_retrieval_eval / list_eval_runs / get_eval_run, and cluster. */

import { h, mount, clear, toast, skeleton, empty, timeAgo, fmtDate } from './dom.js';
import { openModal, confirmModal } from './modal.js';

export function createQualityView(ctx) {
  const { api } = ctx;
  const el = h('div', {});
  let loaded = false;

  const assertHost = h('div', {});
  const evalHost = h('div', {});
  const clusterHost = h('div', {});

  mount(el,
    h('div', { class: 'kbx-card' },
      h('div', { class: 'kbx-card-head' },
        h('div', {}, h('h3', { class: 'kbx-card-title' }, 'Retrieval assertions'), h('div', { class: 'kbx-card-sub' }, 'Queries that should return a specific entry — the truth set for retrieval-eval.')),
        h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button', onClick: openAddAssertion }, h('i', { class: 'bi bi-plus-lg' }), 'Add assertion')),
      assertHost),
    h('div', { class: 'kbx-card' },
      h('div', { class: 'kbx-card-head' },
        h('div', {}, h('h3', { class: 'kbx-card-title' }, 'Retrieval-eval runs'), h('div', { class: 'kbx-card-sub' }, 'Re-checks every assertion and reports hit-rate + rank movement.')),
        h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', onClick: runEval }, h('i', { class: 'bi bi-play-circle' }), 'Run eval now')),
      evalHost),
    h('div', { class: 'kbx-card' },
      h('div', { class: 'kbx-card-head' }, h('h3', { class: 'kbx-card-title' }, 'Clustering'), h('div', { class: 'kbx-card-sub' }, 'Group entries by a field to find themes and near-duplicates.')),
      clusterHost));

  // ── assertions ─────────────────────────────────────────────────────────────
  async function loadAssertions() {
    mount(assertHost, skeleton('Loading assertions…'));
    try {
      const rows = await api.listAssertions({ active_only: true, limit: 100 });
      const list = Array.isArray(rows) ? rows : (rows.assertions || rows.data || []);
      if (!list.length) { mount(assertHost, empty('bi-bullseye', 'No assertions', 'Add one to start tracking retrieval quality for a key entry.')); return; }
      const table = h('table', { class: 'kbx-table' },
        h('thead', {}, h('tr', {}, ...['Entry', 'Query', 'Baseline rank', 'Source', 'Added', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, ...list.map((a) => h('tr', {},
          h('td', {}, h('span', { class: 'kbx-mono' }, String(a.entry_id || '').slice(0, 8))),
          h('td', {}, queryText(a)),
          h('td', { class: 'kbx-num' }, a.baseline_rank != null ? `#${a.baseline_rank}` : '—'),
          h('td', {}, a.source || '—'),
          h('td', { class: 'kbx-muted', style: { whiteSpace: 'nowrap' } }, timeAgo(a.created_at)),
          h('td', {}, h('button', { class: 'kbx-btn kbx-btn-danger kbx-btn-sm', type: 'button', onClick: () => removeAssertion(a.id) }, h('i', { class: 'bi bi-trash' })))))));
      mount(assertHost, h('div', { class: 'kbx-table-wrap' }, table));
    } catch (e) {
      mount(assertHost, h('div', { class: 'kbx-alert danger' }, `Could not load assertions: ${e.message}`));
    }
  }
  function queryText(a) {
    if (a.query && typeof a.query === 'string') return a.query;
    const dims = a.query_dimensions || a.query || {};
    if (typeof dims === 'object') return Object.values(dims).map((v) => (typeof v === 'object' ? v.query_text || '' : v)).filter(Boolean).join(' · ') || '—';
    return String(dims);
  }
  function openAddAssertion() {
    const entryI = h('input', { class: 'kbx-input kbx-mono', placeholder: 'Entry id this query should retrieve' });
    const queryI = h('textarea', { class: 'kbx-textarea', rows: '2', placeholder: 'The query text that should return that entry' });
    const notesI = h('input', { class: 'kbx-input', placeholder: 'Notes (optional)' });
    const saveBtn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button' }, 'Add assertion');
    const ref = openModal({ title: 'Add retrieval assertion', body: h('div', {},
      h('div', { class: 'kbx-field' }, h('label', {}, 'Entry id'), entryI),
      h('div', { class: 'kbx-field' }, h('label', {}, 'Query'), queryI),
      h('div', { class: 'kbx-field' }, h('label', {}, 'Notes'), notesI)), footer: [h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', onClick: () => ref.close() }, 'Cancel'), saveBtn] });
    saveBtn.addEventListener('click', async () => {
      const entry_id = entryI.value.trim(); const query = queryI.value.trim();
      if (!entry_id || !query) { toast('Entry id and query are required', 'warning'); return; }
      saveBtn.classList.add('is-loading');
      try { await api.createAssertion({ entry_id, query, notes: notesI.value.trim() || undefined }); toast('Assertion added', 'success'); ref.close(); loadAssertions(); }
      catch (e) { toast(`Add failed: ${e.message}`, 'error'); saveBtn.classList.remove('is-loading'); }
    });
  }
  async function removeAssertion(id) {
    const ok = await confirmModal({ title: 'Remove assertion', message: 'Deactivate this assertion? History is preserved.', confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    try { await api.deleteAssertion(id); toast('Assertion removed', 'success'); loadAssertions(); }
    catch (e) { toast(`Remove failed: ${e.message}`, 'error'); }
  }

  // ── eval runs ──────────────────────────────────────────────────────────────
  async function loadEvalRuns() {
    mount(evalHost, skeleton('Loading eval runs…'));
    try {
      const runs = await api.listEvalRuns({ limit: 15 });
      if (!runs.length) { mount(evalHost, empty('bi-graph-up', 'No eval runs yet', 'Run the eval once you have a few assertions.')); return; }
      const latest = runs[0];
      const tiles = latest.summary ? h('div', { class: 'kbx-tiles', style: { marginBottom: '14px' } },
        tile('Hit@1', pct(latest.summary.hit_at_1)),
        tile('Hit@3', pct(latest.summary.hit_at_3)),
        tile('Hit@10', pct(latest.summary.hit_at_10)),
        tile('MRR', latest.summary.mrr != null ? Number(latest.summary.mrr).toFixed(3) : '—'),
        tile('Evaluated', latest.assertions_evaluated ?? '—')) : null;
      const table = h('table', { class: 'kbx-table rows-click' },
        h('thead', {}, h('tr', {}, ...['When', 'Trigger', 'Assertions', 'Hit@1', 'MRR', 'Duration', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, ...runs.map((r) => h('tr', { onClick: () => openEvalRun(r.id) },
          h('td', { style: { whiteSpace: 'nowrap' } }, fmtDate(r.created_at)),
          h('td', {}, r.triggered_by || '—'),
          h('td', { class: 'kbx-num' }, r.assertions_evaluated ?? '—'),
          h('td', { class: 'kbx-num' }, r.summary ? pct(r.summary.hit_at_1) : '—'),
          h('td', { class: 'kbx-num' }, r.summary && r.summary.mrr != null ? Number(r.summary.mrr).toFixed(3) : '—'),
          h('td', { class: 'kbx-num' }, r.duration_seconds != null ? `${Number(r.duration_seconds).toFixed(1)}s` : '—'),
          h('td', {}, r.error ? h('span', { class: 'kbx-chip danger' }, 'error') : h('span', { class: 'kbx-chip success' }, 'ok'))))));
      mount(evalHost, tiles, h('div', { class: 'kbx-table-wrap' }, table));
    } catch (e) {
      mount(evalHost, h('div', { class: 'kbx-alert danger' }, `Could not load eval runs: ${e.message}`));
    }
  }
  async function runEval() {
    toast('Running retrieval-eval…', 'info');
    try { await api.runEval(); toast('Eval complete', 'success'); loadEvalRuns(); }
    catch (e) { toast(`Eval failed: ${e.message}`, 'error'); }
  }
  async function openEvalRun(id) {
    const ref = openModal({ title: 'Eval run', body: skeleton('Loading run…'), wide: true });
    let run;
    try { run = await api.getEvalRun(id); }
    catch (e) { ref.setBody(h('div', { class: 'kbx-alert danger' }, e.message)); return; }
    const rows = run.rows || [];
    const table = rows.length ? h('div', { class: 'kbx-table-wrap' }, h('table', { class: 'kbx-table' },
      h('thead', {}, h('tr', {}, ...['Entry', 'Query', 'Baseline', 'Current', 'Δ', 'Verdict'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...rows.map((row) => h('tr', {},
        h('td', {}, h('span', { class: 'kbx-mono' }, String(row.entry_id || '').slice(0, 8))),
        h('td', {}, Object.values(row.query_dimensions || {}).join(' · ') || '—'),
        h('td', { class: 'kbx-num' }, row.baseline_rank != null ? `#${row.baseline_rank}` : 'miss'),
        h('td', { class: 'kbx-num' }, row.current_rank != null ? `#${row.current_rank}` : 'miss'),
        h('td', { class: 'kbx-num' }, row.delta_rank ?? '—'),
        h('td', {}, verdictChip(row.verdict)))))) ) : h('div', { class: 'kbx-muted' }, 'No per-assertion rows.');
    ref.setBody(h('div', {},
      run.error ? h('div', { class: 'kbx-alert danger', style: { marginBottom: '12px' } }, run.error) : null,
      run.summary ? h('div', { class: 'kbx-tiles', style: { marginBottom: '14px' } },
        tile('Hit@1', pct(run.summary.hit_at_1)), tile('Hit@3', pct(run.summary.hit_at_3)), tile('Hit@10', pct(run.summary.hit_at_10)), tile('MRR', run.summary.mrr != null ? Number(run.summary.mrr).toFixed(3) : '—')) : null,
      table));
  }
  function verdictChip(v) {
    if (!v) return h('span', { class: 'kbx-muted' }, '—');
    const good = ['IMPROVED', 'GAINED'].includes(v);
    const bad = ['REGRESSED', 'LOST'].includes(v);
    return h('span', { class: `kbx-chip ${good ? 'success' : bad ? 'danger' : 'muted'}` }, v);
  }
  function pct(v) { return v == null ? '—' : `${(v * 100).toFixed(0)}%`; }
  function tile(label, value) { return h('div', { class: 'kbx-tile accent' }, h('div', { class: 'kbx-tile-label' }, label), h('div', { class: 'kbx-tile-value' }, value)); }

  // ── clustering ─────────────────────────────────────────────────────────────
  function renderClusterControls() {
    const schema = ctx.getSchema();
    const dimOpts = (schema && schema.dimensions ? schema.dimensions : []).map((d) => h('option', { value: d.name }, d.display_name || d.name));
    const fieldSel = h('select', { class: 'kbx-select', style: { width: 'auto' } }, h('option', { value: '' }, 'Auto (all fields)'), ...dimOpts);
    const runBtn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button' }, h('i', { class: 'bi bi-diagram-3' }), 'Run clustering');
    const out = h('div', { class: 'kbx-mt' });
    runBtn.addEventListener('click', async () => {
      runBtn.classList.add('is-loading'); mount(out, skeleton('Clustering… this can take a moment.'));
      try {
        const payload = { include_members: true, max_members_per_cluster: 6, label: false };
        if (fieldSel.value) payload.fields = [fieldSel.value];
        const res = await api.cluster(payload);
        renderClusters(out, res);
      } catch (e) { mount(out, h('div', { class: 'kbx-alert danger' }, `Clustering failed: ${e.message}`)); }
      finally { runBtn.classList.remove('is-loading'); }
    });
    mount(clusterHost, h('div', { class: 'kbx-row' }, h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, h('label', {}, 'Field'), fieldSel), runBtn), out);
  }
  function renderClusters(out, res) {
    const results = (res && res.results) || [];
    if (!results.length) { mount(out, empty('bi-diagram-3', 'No clusters', 'Not enough entries to cluster on this field.')); return; }
    const blocks = [];
    results.forEach((fr) => {
      blocks.push(h('h4', { style: { fontSize: '14px', margin: '10px 0 6px' } }, `${fr.field} — ${fr.cluster_count} cluster${fr.cluster_count === 1 ? '' : 's'}`, fr.silhouette_score != null ? h('span', { class: 'kbx-chip muted', style: { marginLeft: '8px' } }, `silhouette ${Number(fr.silhouette_score).toFixed(2)}`) : null));
      (fr.clusters || []).forEach((c) => {
        blocks.push(h('div', { class: 'kbx-item', style: { cursor: 'default' } },
          h('div', { class: 'kbx-row-between' },
            h('div', { class: 'kbx-strong' }, c.label || c.key || `Cluster ${c.cluster_id}`),
            h('span', { class: 'kbx-chip' }, `${c.size} member${c.size === 1 ? '' : 's'}`)),
          (c.keywords && c.keywords.length) ? h('div', { class: 'kbx-tags kbx-mt' }, ...c.keywords.slice(0, 8).map((k) => h('span', { class: 'kbx-tag' }, k))) : null,
          (c.members && c.members.length) ? h('ul', { class: 'kbx-mt', style: { margin: '8px 0 0', paddingLeft: '18px', color: 'var(--kbx-muted)', fontSize: '13px' } }, ...c.members.slice(0, 6).map((m) => h('li', {}, truncate(m.value || m.content || '', 120)))) : null));
      });
    });
    mount(out, ...blocks);
  }
  function truncate(s, n) { s = s || ''; return s.length > n ? s.slice(0, n) + '…' : s; }

  return {
    el,
    load() {
      if (loaded) return;
      loaded = true;
      loadAssertions(); loadEvalRuns(); renderClusterControls();
    },
    reload() { loadAssertions(); loadEvalRuns(); renderClusterControls(); },
  };
}
