/* Similar view (beta) — the bank's most similar entry pairs, side by side.

   POST /similar-pairs scans the newest N entries (each probes its nearest
   neighbours in the chosen embedding dimension) and returns the pairs above a
   threshold, best first. Each pair card shows both entries, their provenance
   and the similarity; "Judge" asks a model what the pair IS (duplicate /
   conflicting / related / distinct, with a reason and a suggested action) one
   pair at a time or for the top of the list. Entries open in the usual detail
   modal, where they can be edited or deleted. Logic that is not DOM lives in
   similar_model.js. */

import { h, mount, clear, toast, skeleton, empty, fmtDate, timeAgo, meter } from './dom.js';
import { openEntryDetail, kindChip } from './entry_detail.js';
import { confirmModal } from './modal.js';
import { dimsOf, kindOf, truncate } from './schema_utils.js';
import {
  ACTION_LABEL, DEFAULT_JUDGE_BATCH, KIND_LABEL, KIND_TONE, SCAN_SIZES, VERDICT_LABEL, VERDICT_TONE, applyResultText, attachJudgements,
  buildApplyRequest, buildJudgeRequest, buildPairsRequest, changeSummary, editLines, filterPairs, judgeFailureText, markPair, nextToJudge, pairKey,
  proposalIsActionable, proposalIsApplicable, readSettings, rememberJudgementIds, similarityTone, speedLabel, statsCaption, summarize, wordDiff, writeSettings,
} from './similar_model.js';

function wordDiffSafe(a, b) { try { return wordDiff(a, b); } catch { return [{ op: 'ins', text: String(b || '') }]; } }

export function createSimilarView(ctx) {
  const { api } = ctx;
  const el = h('div', {});
  let loaded = false;
  let result = null;      // last /similar-pairs response
  let pairs = [];         // result.pairs with judgements folded in
  let verdictFilter = 'all';
  let scanning = false;
  let judging = false;
  let applying = false;
  let judgementIds = new Map(); // pair key -> judgement_id the proposal came from
  function storage() { try { return window.localStorage; } catch { return null; } }
  const settings = readSettings(storage(), api.kbId);

  // ── controls ───────────────────────────────────────────────────────────────
  const fieldSelect = h('select', { class: 'kbx-select', dataset: { role: 'similar-field' } });
  const thresholdInput = h('input', { class: 'kbx-input', type: 'number', min: '0.5', max: '1', step: '0.01', value: String(settings.threshold), dataset: { role: 'similar-threshold' } });
  const scanSelect = h('select', { class: 'kbx-select', dataset: { role: 'similar-scan' } },
    ...SCAN_SIZES.map((n) => h('option', { value: String(n) }, n >= 20000 ? 'Whole bank (slow)' : `Newest ${n.toLocaleString()}`)));
  scanSelect.value = String(settings.maxEntries);
  const speedSelect = h('select', { class: 'kbx-select', dataset: { role: 'similar-speed' }, title: 'Which model judges. Thorough reasons a little; Fast answers in about a second. The scan names the platform defaults; a stored credential with a default model overrides them.' },
    h('option', { value: 'thorough' }, 'Thorough'), h('option', { value: 'fast' }, 'Fast'));
  function labelSpeeds(models) {
    [...speedSelect.options].forEach((o) => { o.textContent = speedLabel(o.value, models); });
  }
  const scanBtn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button', onClick: runScan }, h('i', { class: 'bi bi-intersect' }), 'Find similar pairs');
  const judgeTopBtn = h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', dataset: { role: 'judge-top' }, onClick: () => judge(nextToJudge(pairs, DEFAULT_JUDGE_BATCH)) },
    h('i', { class: 'bi bi-stars' }), `Judge next ${DEFAULT_JUDGE_BATCH}`);
  const judgeStatus = h('div', { class: 'kbx-muted', style: { fontSize: '12px' } });

  function buildFieldOptions() {
    clear(fieldSelect);
    const singles = dimsOf(ctx.getSchema()).filter((d) => d.dimension_type === 'single' || (!d.dimension_type && d.name === 'content'));
    singles.forEach((d) => fieldSelect.append(h('option', { value: d.name }, d.display_name || d.name)));
    if (!singles.length) fieldSelect.append(h('option', { value: '' }, 'content'));
  }

  const controls = h('div', { class: 'kbx-card' },
    h('div', { class: 'kbx-card-head' },
      h('div', {}, h('h3', { class: 'kbx-card-title' }, 'Similar pairs', h('span', { class: 'kbx-chip warn', style: { marginLeft: '8px' } }, 'beta')),
        h('p', { class: 'kbx-card-sub' }, 'Every entry probes its nearest neighbours in the embedding index; pairs above the threshold are duplicate or conflict candidates. "Judge" asks a model what each pair is.')),
      h('div', { class: 'kbx-row' },
        h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, h('label', {}, 'Dimension'), fieldSelect),
        h('div', { class: 'kbx-field', style: { marginBottom: 0, width: '110px' } }, h('label', {}, 'Min similarity'), thresholdInput),
        h('div', { class: 'kbx-field', style: { marginBottom: 0 } }, h('label', {}, 'Scan'), scanSelect),
        h('div', { class: 'kbx-field', style: { marginBottom: 0, width: '120px' } }, h('label', {}, 'Judge speed'), speedSelect))),
    h('div', { class: 'kbx-row' }, scanBtn, judgeTopBtn, judgeStatus));

  const statsLine = h('div', { class: 'kbx-muted', style: { fontSize: '13px' } });
  const filterChips = h('div', { class: 'kbx-filter-chips' });
  const listHost = h('div', {});
  const listCard = h('div', { class: 'kbx-card' },
    h('div', { class: 'kbx-card-head' }, statsLine, filterChips),
    listHost);
  mount(el, controls, listCard);
  mount(listHost, empty('bi-intersect', 'No scan yet', 'Choose a threshold and scan size, then find similar pairs.'));

  function currentSettings() {
    const threshold = parseFloat(thresholdInput.value);
    const maxEntries = parseInt(scanSelect.value, 10);
    const s = { threshold: Number.isFinite(threshold) ? threshold : settings.threshold, maxEntries };
    writeSettings(storage(), api.kbId, s);
    return s;
  }

  // ── scan ───────────────────────────────────────────────────────────────────
  async function runScan() {
    if (scanning) return;
    const s = currentSettings();
    scanning = true; scanBtn.classList.add('is-loading');
    mount(listHost, skeleton(s.maxEntries >= 20000 ? 'Scanning the whole bank, this takes a while…' : 'Scanning for similar pairs…'));
    try {
      result = await api.similarPairs(buildPairsRequest({ threshold: s.threshold, maxEntries: s.maxEntries, field: fieldSelect.value || undefined }));
      pairs = Array.isArray(result && result.pairs) ? result.pairs : [];
      labelSpeeds(result && result.judge_models);
      verdictFilter = 'all';
      render();
    } catch (e) {
      mount(listHost, h('div', { class: 'kbx-alert danger' }, `Scan failed: ${e.message}`));
    } finally {
      scanning = false; scanBtn.classList.remove('is-loading');
    }
  }

  // ── judge ──────────────────────────────────────────────────────────────────
  async function judge(targets) {
    if (judging || !targets.length) return;
    const body = buildJudgeRequest(targets, { speed: speedSelect.value });
    if (!body) return;
    judging = true; judgeTopBtn.classList.add('is-loading');
    judgeStatus.textContent = `Asking the model about ${targets.length} pair${targets.length === 1 ? '' : 's'}…`;
    targets.forEach((p) => { const card = listHost.querySelector(`[data-pair-key="${CSS.escape(p.a.id + '|' + p.b.id)}"] [data-role="judge-one"]`); if (card) card.classList.add('is-loading'); });
    try {
      const out = await api.judgePairs(body);
      if (out && out.status === 'judged') {
        pairs = attachJudgements(pairs, out.judgements);
        judgementIds = rememberJudgementIds(judgementIds, out.judgements, out.judgement_id);
        const parts = [`${(out.judgements || []).length} judged`];
        if (out.model) parts.push(out.model);
        if (out.credential_source) parts.push(`paid by ${out.credential_source === 'env' || out.credential_source === 'platform' ? 'the platform' : 'your key'}`);
        if (Number.isFinite(out.duration_ms)) parts.push(`${(out.duration_ms / 1000).toFixed(1)} s`);
        judgeStatus.textContent = parts.join(' · ');
      } else {
        judgeStatus.textContent = judgeFailureText(out && out.status, out && out.error);
        toast(judgeFailureText(out && out.status), 'error');
      }
      render();
    } catch (e) {
      judgeStatus.textContent = `Judge failed: ${e.message}`;
      toast(`Judge failed: ${e.message}`, 'error');
      render();
    } finally {
      judging = false; judgeTopBtn.classList.remove('is-loading');
    }
  }

  // ── apply ──────────────────────────────────────────────────────────────────
  async function applyPair(p) {
    if (applying) return;
    const key = pairKey(p.a.id, p.b.id);
    const body = buildApplyRequest(p, judgementIds.get(key));
    if (!body) { toast('Nothing to apply for this pair.', 'error'); return; }
    const deletes = body.proposal.changes.filter((c) => c.action === 'delete').length;
    const updates = body.proposal.changes.length - deletes;
    const ok = await confirmModal({
      title: `${KIND_LABEL[body.proposal.kind] || body.proposal.kind}?`,
      message: `This rewrites ${updates} and deletes ${deletes} entr${updates + deletes === 1 ? 'y' : 'ies'} in this bank. Rewrites re-embed; deletions keep a snapshot in the audit row.`,
      confirmLabel: 'Approve & apply', danger: deletes > 0,
    });
    if (!ok) return;
    applying = true;
    try {
      const out = await api.applyProposal(body);
      pairs = markPair(pairs, key, { kind: 'applied', status: out && out.status, text: applyResultText(out) });
      toast(`${KIND_LABEL[body.proposal.kind] || 'Proposal'}: ${out && out.status}`, out && out.status === 'applied' ? 'success' : 'error');
      render();
    } catch (e) {
      toast(`Apply failed: ${e.message}`, 'error');
    } finally {
      applying = false;
    }
  }

  function dismissPair(p) {
    pairs = markPair(pairs, pairKey(p.a.id, p.b.id), { kind: 'dismissed' });
    render();
  }

  // ── render ─────────────────────────────────────────────────────────────────
  function render() {
    statsLine.textContent = statsCaption(result);
    renderFilterChips();
    const shown = filterPairs(pairs, verdictFilter);
    judgeTopBtn.disabled = !nextToJudge(pairs, 1).length;
    if (!pairs.length) { mount(listHost, empty('bi-check2-circle', 'No pairs at this threshold', 'Lower the minimum similarity or scan more entries.')); return; }
    if (!shown.length) { mount(listHost, empty('bi-funnel', 'Nothing with that verdict', 'Pick another verdict above.')); return; }
    const list = h('div', { class: 'kbx-list' });
    shown.forEach((p) => list.append(pairCard(p)));
    mount(listHost, list);
  }

  function renderFilterChips() {
    clear(filterChips);
    if (!pairs.length) { filterChips.style.display = 'none'; return; }
    filterChips.style.display = '';
    const sum = summarize(pairs);
    const chip = (id, label, count) => h('button', {
      class: `kbx-filter-chip${verdictFilter === id ? ' is-active' : ''}`, type: 'button', dataset: { verdictFilter: id },
      onClick: () => { verdictFilter = id; render(); },
    }, label, h('span', { class: 'kbx-count' }, String(count)));
    filterChips.append(chip('all', 'All', sum.total));
    ['duplicate', 'conflicting', 'related', 'distinct'].forEach((v) => { if (sum.byVerdict[v]) filterChips.append(chip(v, VERDICT_LABEL[v], sum.byVerdict[v])); });
    if (sum.unjudged && sum.judged) filterChips.append(chip('unjudged', 'Unjudged', sum.unjudged));
  }

  function entrySide(entry, label) {
    const schema = ctx.getSchema();
    const meta = entry.metadata || {};
    const chips = [h('span', { class: 'kbx-chip muted' }, label), kindChip(kindOf(entry, schema))];
    if (meta.is_gotcha) chips.push(h('span', { class: 'kbx-chip warn' }, 'Gotcha'));
    if (meta.type && !kindOf(entry, schema)) chips.push(h('span', { class: 'kbx-chip muted' }, String(meta.type)));
    return h('div', { class: 'kbx-pair-side' },
      h('div', { class: 'kbx-row', style: { gap: '6px', alignItems: 'center', justifyContent: 'space-between' } },
        h('div', { class: 'kbx-row', style: { gap: '6px' } }, ...chips),
        h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', dataset: { role: 'open-entry', entryId: entry.id },
          onClick: () => openEntryDetail(ctx, entry.id, { onChanged: () => runScan() }) }, 'Open')),
      h('div', { class: 'kbx-item-body', style: { marginTop: '6px' } }, truncate(entry.content, 600)),
      entry.useful_for ? h('div', { class: 'kbx-item-body kbx-muted', style: { fontSize: '12px', marginTop: '4px' } }, h('strong', {}, 'Useful for: '), truncate(entry.useful_for, 160)) : null,
      h('div', { class: 'kbx-mono kbx-muted', style: { fontSize: '11px', marginTop: '6px' }, title: fmtDate(entry.created_at) },
        `${String(entry.id || '').slice(0, 8)} · ${entry.source || 'no source'} · ${entry.created_at ? timeAgo(entry.created_at) : ''}`));
  }

  function pairCard(p) {
    const sim = Number(p.similarity) || 0;
    const j = p.judgement;
    const head = h('div', { class: 'kbx-item-head' },
      h('div', { class: 'kbx-row', style: { gap: '8px', alignItems: 'center' } },
        h('span', { class: `kbx-chip ${similarityTone(sim)}` }, `${(sim * 100).toFixed(1)}% similar`),
        h('div', { style: { width: '120px' } }, meter(sim)),
        j ? h('span', { class: `kbx-chip ${VERDICT_TONE[j.verdict] || 'muted'}`, dataset: { role: 'verdict' } }, `${VERDICT_LABEL[j.verdict] || j.verdict} · ${Math.round((j.confidence || 0) * 100)}%`) : null),
      j ? null : h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', dataset: { role: 'judge-one' }, onClick: () => judge([p]) }, h('i', { class: 'bi bi-stars' }), 'Judge'));
    const sides = h('div', { class: 'kbx-pair' }, entrySide(p.a, 'A'), entrySide(p.b, 'B'));
    const verdict = j ? h('div', { class: `kbx-alert ${VERDICT_TONE[j.verdict] === 'danger' ? 'warn' : (VERDICT_TONE[j.verdict] || 'info')}`, style: { marginTop: '10px', display: 'block' } },
      h('strong', {}, `${VERDICT_LABEL[j.verdict] || j.verdict}: `), j.reason || '',
      j.proposal ? null : h('div', { class: 'kbx-muted', style: { fontSize: '12px', marginTop: '4px' } }, `Suggested: ${ACTION_LABEL[j.suggested_action] || j.suggested_action}`)) : null;
    return h('div', { class: 'kbx-item kbx-pair-card', dataset: { pairKey: `${p.a.id}|${p.b.id}` } }, head, sides, verdict, j && j.proposal ? proposalPanel(p) : null);
  }

  function entryOf(p, id) { return p.a.id === id ? p.a : p.b.id === id ? p.b : null; }

  function diffNode(parts) {
    return h('div', { class: 'kbx-diff' }, ...parts.map((t) => (t.op === 'del' ? h('del', {}, t.text) : t.op === 'ins' ? h('ins', {}, t.text) : h('span', {}, t.text))));
  }

  function proposalPanel(p) {
    const prop = p.judgement.proposal;
    const actionable = proposalIsActionable(prop);
    const applicable = proposalIsApplicable(prop);
    const outcome = p.outcome;
    const headRight = outcome
      ? h('span', { class: `kbx-chip ${outcome.kind === 'applied' ? (outcome.status === 'applied' ? 'success' : 'warn') : 'muted'}`, dataset: { role: 'outcome' } },
        outcome.kind === 'applied' ? `Applied: ${outcome.status}` : 'Dismissed')
      : h('div', { class: 'kbx-row', style: { gap: '6px' } },
        actionable ? h('button', { class: 'kbx-btn kbx-btn-primary kbx-btn-sm', type: 'button', dataset: { role: 'apply' }, disabled: !applicable || !judgementIds.get(pairKey(p.a.id, p.b.id)),
          title: applicable ? '' : 'An edit no longer matches the current text; judge this pair again.', onClick: () => applyPair(p) }, h('i', { class: 'bi bi-check2' }), 'Approve & apply') : null,
        h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', dataset: { role: 'dismiss' }, onClick: () => dismissPair(p) }, 'Dismiss'));
    const panel = h('div', { class: 'kbx-proposal', dataset: { role: 'proposal', kind: prop.kind } },
      h('div', { class: 'kbx-proposal-head' },
        h('div', { class: 'kbx-row', style: { gap: '8px', alignItems: 'center' } },
          h('span', { class: `kbx-chip ${KIND_TONE[prop.kind] || 'muted'}` }, KIND_LABEL[prop.kind] || prop.kind),
          h('span', { style: { fontSize: '13px' } }, prop.rationale || '')),
        headRight));
    if (outcome && outcome.text) panel.append(h('div', { class: 'kbx-muted', style: { fontSize: '12px', marginTop: '6px' } }, outcome.text));
    (prop.changes || []).filter((c) => c.action !== 'none').forEach((c) => {
      const entry = entryOf(p, c.entry_id);
      panel.append(h('div', { class: 'kbx-proposal-label' }, changeSummary(c, p), entry ? ` · ${String(c.entry_id).slice(0, 8)}` : ''));
      if (c.action === 'update') {
        // Compact: one line per edit (removed text struck, added text highlighted), never the whole entry.
        const lines = editLines(c);
        lines.forEach((line) => {
          if (line.kind === 'append') panel.append(h('div', { class: 'kbx-edit', dataset: { role: 'edit-append' } }, h('span', { class: 'kbx-edit-tag' }, 'add'), diffNode([{ op: 'ins', text: line.text }])));
          else if (line.kind === 'replace') panel.append(h('div', { class: 'kbx-edit', dataset: { role: 'edit-replace' } }, h('span', { class: 'kbx-edit-tag' }, 'change'), diffNode(line.diff)));
          else if (line.kind === 'useful_for') panel.append(h('div', { class: 'kbx-edit', dataset: { role: 'edit-useful-for' } }, h('span', { class: 'kbx-edit-tag' }, 'useful for'), diffNode(wordDiffSafe(entry ? entry.useful_for : '', line.text))));
        });
        if (c.edits_apply_cleanly === false) panel.append(h('div', { class: 'kbx-alert warn', style: { display: 'block', marginTop: '6px' }, dataset: { role: 'edit-stale' } },
          'This edit no longer matches the current text (', (c.edit_errors || []).join('; '), '). Judge the pair again.'));
        if (c.content) {
          const full = h('div', { class: 'kbx-pair', style: { display: 'none' }, dataset: { role: 'full-text' } },
            h('div', {}, h('div', { class: 'kbx-proposal-label' }, 'Current content'), h('div', { class: 'kbx-proposal-text' }, entry ? entry.content : '')),
            h('div', {}, h('div', { class: 'kbx-proposal-label' }, 'Resulting content'), h('div', { class: 'kbx-proposal-text is-proposed', dataset: { role: 'proposed-content' } }, c.content)));
          const toggle = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', dataset: { role: 'toggle-full' }, onClick: () => { const show = full.style.display === 'none'; full.style.display = show ? '' : 'none'; toggle.textContent = show ? 'Hide full text' : 'Show full text'; } }, 'Show full text');
          panel.append(h('div', { style: { marginTop: '6px' } }, toggle), full);
        }
      } else if (c.action === 'delete' && entry) {
        panel.append(h('div', { class: 'kbx-proposal-text' }, truncate(entry.content, 300)));
      }
    });
    if (!actionable) panel.append(h('div', { class: 'kbx-muted', style: { fontSize: '12px', marginTop: '6px' } }, 'No change proposed.'));
    return panel;
  }

  return {
    el,
    load() {
      buildFieldOptions();
      if (!loaded) { loaded = true; }
    },
    reload() { buildFieldOptions(); if (result) runScan(); },
  };
}
