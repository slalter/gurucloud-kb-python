/* Ask tab — a small model answers a question about the bank, step by step,
   and the person watches it work (kanban b3cb2a1b).

   Left: the trail. Each step shows the model's own words before it acts
   ("thinking"), the tool it called with its arguments, what came back
   (results and their pointers, an entry and its connections, a walk's nodes
   and edges), and finally the answer with clickable citations. Right: the
   Graph tab's 3D scene with everything the model touched painted on
   (searched, pointed-at, read, walked, cited). Click a step to see the bank
   as it looked at that moment; click any node or row to fly to it.

   Run mode continues automatically after each tool round; Step mode waits
   for "Next step". Stop abandons the run on the service. Past runs (the
   service's audit trail) replay the same way from GET /ask/runs/{id}.

   The service runs ONE model turn per POST /ask/step. The model's tools are
   the bank's MCP mount tools (kanban 38e21d4d): this file asks the host to
   run them (POST /ask/runs/{id}/execute) and posts the outputs on; the three
   pre-mount tools (search / read / walk) it still runs itself against the
   Explorer API, through the pure shapers in ask_model.js (Node-tested). */

import { h, mount, clear, toast, skeleton, esc, timeAgo } from './dom.js';
import { openEntryDetail } from './entry_detail.js';
import { RELATION_COLORS, fitPlan, labelFor, neighbourhood, pointerLine, scene } from './graph_model.js';
import { GRAPH_COLORS, ensureForceGraph3D, fitLit, flyTo, loadBankEdges } from './graph3d.js';
import { showsModelKnobs } from './mode_model.js';
import {
  REASONING, TOOLS, addStep, applyExecuteOutputs, callArgText, callDetail, citationProvenance, citationSegments, continueBody, emptyTrail, entryOutput, executeBody, isEntryId,
  isLegacyTool, matchedPlaybooks, mountLine, mountTools, normalizeAskOptions, outputsOf, pendingStep, playbookRead, readEntry, readRequest,
  searchOutput, searchRequest, searchRows, setCallResult, settingsKey, startBody, stepCaption, stepFailure, toolKind, trailFromRunDetail,
  provenanceLine, traceLine, trailKnownRefs, trailPicture, trailSummary, usageText, walkByDepth, walkOutput, walkRead, walkRequest,
} from './ask_model.js';

const KIND_LABEL = { hit: 'retrieved', folded: 'pointer (folded)', neighbor: 'one hop away', read: 'read in full', walk: 'walked', cited: 'cited in the answer', ctx: 'other connection', bank: '' };
const WALK_NODES_SHOWN = 24; // rows a walk shows before "Show all"
const WALK_EDGES_SHOWN = 40;
const CONTINUE_DELAY_MS = 450; // long enough to see a round of results land before the next turn

export function createAskView(ctx) {
  const { api } = ctx;
  const el = h('div', {});
  let config = null;
  let fg = null;
  let loaded = false;
  let bankEdges = null;
  const bankEnds = {};
  let trail = emptyTrail('');
  const rawByStep = {};
  let focusStep = null;      // show the picture as it was through this step (null = everything)
  let busy = false;
  let stopped = false;
  let selectedId = null;
  let pendingFit = null;         // what the next engine stop frames (fitPlan); consumed once
  let userMoved = false;         // the user rotated/zoomed since the last picture change

  // ── controls ───────────────────────────────────────────────────────────────
  const questionInput = h('input', { class: 'kbx-input', type: 'text', placeholder: 'Ask the bank a question, e.g. “How does the client quote a rush order?”', dataset: { role: 'ask-question', action: 'ask_question', recordValue: 'question' } });
  const modelSel = h('select', { class: 'kbx-select', dataset: { role: 'ask-model', action: 'ask_model', recordValue: 'model' } });
  const reasoningSel = h('select', { class: 'kbx-select', dataset: { role: 'ask-reasoning', action: 'ask_reasoning', recordValue: 'reasoning' }, title: 'How much the model thinks before each step (gpt-6 family: none / low / medium)' },
    ...REASONING.map((r) => h('option', { value: r }, r)));
  const stepsInput = h('input', { class: 'kbx-input', type: 'number', min: '1', max: '12', value: '8', title: 'Model turns before it must answer', dataset: { role: 'ask-max-steps' } });
  const autoCb = h('input', { type: 'checkbox', checked: true, dataset: { role: 'ask-auto', action: 'ask_auto_toggle', recordValue: 'auto' } });
  const focusSel = h('select', { class: 'kbx-select', dataset: { role: 'ask-focus', action: 'ask_focus', recordValue: 'focus' }, title: 'What happens to the entries the model has not touched' },
    h('option', { value: 'shrink' }, 'shrink the rest'), h('option', { value: 'only' }, 'touched only'), h('option', { value: 'dim' }, 'dim the rest'));
  const backfillCb = h('input', { type: 'checkbox', checked: true, dataset: { role: 'ask-hide-backfill', action: 'ask_hide_backfill_toggle', recordValue: 'hide_backfill' } });
  const askBtn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button', dataset: { role: 'ask-run', action: 'ask_run', outcome: 'request' }, onClick: () => ask() }, h('i', { class: 'bi bi-play-fill' }), 'Ask');
  const stopBtn = h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', dataset: { role: 'ask-stop', action: 'ask_stop' }, disabled: true, onClick: () => stop() }, h('i', { class: 'bi bi-stop-fill' }), 'Stop');
  const runsSel = h('select', { class: 'kbx-select', dataset: { role: 'ask-runs', action: 'ask_replay_run', recordValue: 'run_id' }, title: 'Replay a past run from the audit trail', style: { maxWidth: '260px' } }, h('option', { value: '' }, 'Replay a past run…'));
  const unavailable = h('div', { class: 'kbx-alert warn', dataset: { role: 'ask-unavailable' }, style: { display: 'none' } });
  const toolsLine = h('div', { class: 'kbx-muted', style: { fontSize: '12px', display: 'none' }, dataset: { role: 'ask-tools' } });
  questionInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
  [modelSel, reasoningSel, stepsInput, autoCb].forEach((i) => i.addEventListener('change', saveSettings));
  [focusSel, backfillCb].forEach((i) => i.addEventListener('change', () => { saveSettings(); paint(); }));
  runsSel.addEventListener('change', () => { if (runsSel.value) replay(runsSel.value); });

  const toolbar = h('div', { class: 'kbx-card' },
    h('div', { class: 'kbx-card-head' },
      h('div', {}, h('h3', { class: 'kbx-card-title' }, 'Ask'), h('div', { class: 'kbx-card-sub' }, 'A small model answers from this bank alone, with the same tools an agent on the bank\u2019s MCP mount has. Watch it query, read entries and playbooks and follow connections; everything it touches lights up on the right.'), toolsLine),
      h('div', { class: 'kbx-row', style: { gap: '6px' } }, runsSel, stopBtn, askBtn)),
    unavailable,
    h('div', { class: 'kbx-map-toolbar' },
      h('div', { class: 'kbx-field', style: { flex: '1 1 420px' } }, h('label', {}, 'Question'), questionInput),
      field('Model', modelSel),
      field('Thinking', reasoningSel),
      field('Max steps', stepsInput),
      h('div', { class: 'kbx-field' }, h('label', {}, ' '), h('label', { class: 'kbx-check', title: 'Continue after each round of tools; off = wait for “Next step”' }, autoCb, 'Run without stopping')),
      field('Rest of the bank', focusSel),
      h('div', { class: 'kbx-field' }, h('label', {}, ' '), h('label', { class: 'kbx-check', title: 'Hide the note-less split_from edges the metadata backfill wrote' }, backfillCb, 'Hide backfill siblings'))));
  function field(label, input) {
    const el = h('div', { class: 'kbx-field' }, h('label', {}, label), input);
    if ([modelSel, reasoningSel, stepsInput].includes(input) && !showsModelKnobs(ctx.mode)) el.style.display = 'none';
    return el;
  }

  // ── stage ──────────────────────────────────────────────────────────────────
  const canvas = h('div', { class: 'kbx-map-canvas kbx-graph3d', dataset: { role: 'ask-canvas' } });
  const overlay = h('div', { class: 'kbx-map-overlay', style: { display: 'none' } });
  const caption = h('span', { class: 'kbx-chip muted', dataset: { role: 'ask-caption' } }, '…');
  const hud = h('div', { class: 'kbx-map-hud' }, caption,
    h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', title: 'Fit', dataset: { role: 'ask-fit', action: 'ask_graph_fit' }, onClick: () => fitLit(fg) }, h('i', { class: 'bi bi-arrows-fullscreen' })));
  const legend = h('div', { class: 'kbx-map-legend kbx-graph-legend' },
    h('span', {}, h('i', { class: 'g-hit' }), 'searched (#rank)'),
    h('span', {}, h('i', { class: 'g-folded' }), 'pointer: folded'),
    h('span', {}, h('i', { class: 'g-neighbor' }), 'one hop away'),
    h('span', {}, h('i', { class: 'g-read' }), 'read in full'),
    h('span', {}, h('i', { class: 'g-walk' }), 'walked'),
    h('span', {}, h('i', { class: 'g-cited' }), 'cited in the answer'));
  const canvasWrap = h('div', { class: 'kbx-map-canvas-wrap kbx-graph3d-wrap' }, canvas, hud, legend, overlay);

  const summaryEl = h('div', { class: 'kbx-muted', style: { fontSize: '12px', marginBottom: '8px' }, dataset: { role: 'ask-summary' } });
  const timeline = h('div', { class: 'kbx-ask-timeline', dataset: { role: 'ask-timeline' } });
  const selectedHost = h('div', { dataset: { role: 'ask-selected' } }, h('div', { class: 'kbx-hint' }, 'Click a node, a result or a citation to see the entry.'));
  const side = h('div', { class: 'kbx-map-side kbx-ask-side' },
    h('div', { class: 'kbx-side-card' }, h('div', { class: 'kbx-side-title' }, 'What the agent did'), summaryEl, timeline),
    h('div', { class: 'kbx-side-card' }, h('div', { class: 'kbx-side-title' }, 'Selected'), selectedHost));
  mount(el, toolbar, h('div', { class: 'kbx-map-stage kbx-ask-stage' }, side, canvasWrap));

  function showOverlay(node) { mount(overlay, node); overlay.style.display = 'flex'; }
  function hideOverlay() { overlay.style.display = 'none'; }

  // ── settings (per bank, per viewer) ───────────────────────────────────────
  const storeKey = settingsKey(api.kbId);
  function options() { return normalizeAskOptions({ model: modelSel.value, reasoning: reasoningSel.value, maxSteps: stepsInput.value, autoRun: autoCb.checked, focus: focusSel.value, hideBackfill: backfillCb.checked }, config); }
  function saveSettings() { try { localStorage.setItem(storeKey, JSON.stringify(options())); } catch { /* ignore */ } }
  function applySettings(o) {
    if (o.model) modelSel.value = o.model;
    reasoningSel.value = o.reasoning; stepsInput.value = String(o.maxSteps); autoCb.checked = o.autoRun; focusSel.value = o.focus; backfillCb.checked = o.hideBackfill;
  }
  function loadSettings() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(storeKey) || 'null'); } catch { s = null; }
    applySettings(normalizeAskOptions(s || {}, config));
  }

  function setBusy(on) {
    busy = on;
    askBtn.disabled = on || !(config && config.available);
    askBtn.classList.toggle('is-loading', on);
    stopBtn.disabled = !on && trail.status !== 'running';
  }

  // ── the loop ───────────────────────────────────────────────────────────────
  async function ask() {
    if (busy) return;
    let body;
    try { body = startBody({ question: questionInput.value, ...options() }); }
    catch (e) { toast(e.message, 'warning'); questionInput.focus(); return; }
    trail = emptyTrail(questionInput.value);
    Object.keys(rawByStep).forEach((k) => delete rawByStep[k]);
    stopped = false; focusStep = null; selectedId = null;
    setBusy(true);
    renderTimeline();
    await paint();
    await step(body);
  }

  async function step(body) {
    renderTimeline({ live: 'thinking' });
    let resp;
    try { resp = await api.askStep(body); }
    catch (e) {
      const failure = stepFailure(e);
      trail = { ...trail, status: 'failed', error: failure.message, errorDetail: failure.detail };
      renderTimeline(); setBusy(false);
      toast(`Ask failed: ${failure.message}`, 'error');
      return;
    }
    if (stopped) return;
    trail = addStep(trail, resp);
    rawByStep[resp.step] = resp;
    renderTimeline();
    await paint('auto');
    if (resp.status === 'tool_calls') {
      await executeTools(resp.step);
      if (stopped) return;
      if (options().autoRun) { await new Promise((r) => setTimeout(r, CONTINUE_DELAY_MS)); if (!stopped) await continueRun(); }
      else { setBusy(false); stopBtn.disabled = false; renderTimeline({ live: 'next' }); }
    } else {
      setBusy(false);
      renderTimeline();
      await paint('auto');
      fitLit(fg);
      refreshRuns();
    }
  }

  async function executeTools(stepNo) {
    const st = trail.steps.find((s) => s.no === stepNo);
    if (!st) return;
    const mine = st.calls.filter((c) => isLegacyTool(c.call.name) || c.call.known === false);
    const mount = st.calls.filter((c) => !mine.includes(c));
    for (const c of mine) {
      if (stopped) return;
      trail = setCallResult(trail, stepNo, c.call.call_id, { state: 'running' });
      renderTimeline();
      const t0 = performance.now();
      try {
        const out = await runTool(c.call);
        trail = setCallResult(trail, stepNo, c.call.call_id, { state: 'done', output: out, durationMs: performance.now() - t0 });
      } catch (e) {
        trail = setCallResult(trail, stepNo, c.call.call_id, { state: 'error', error: e.message || String(e), durationMs: performance.now() - t0 });
      }
      renderTimeline();
      await paint('auto');
    }
    if (!mount.length || stopped) return;
    // The mount's tools run on the host (the bank's MCP server), all of this step's at once.
    const ids = mount.map((c) => c.call.call_id);
    ids.forEach((id) => { trail = setCallResult(trail, stepNo, id, { state: 'running' }); });
    renderTimeline();
    const t0 = performance.now();
    try {
      const res = await api.askExecute(trail.runId, executeBody(ids));
      trail = applyExecuteOutputs(trail, stepNo, res && res.outputs, ids);
    } catch (e) {
      const failure = stepFailure(e);
      ids.forEach((id) => { trail = setCallResult(trail, stepNo, id, { state: 'error', error: `the mount did not run this call: ${failure.message}`, durationMs: performance.now() - t0 }); });
    }
    renderTimeline();
    await paint('auto');
  }

  function knownToolNames() { return mountTools(config).map((t) => t.name); }

  async function runTool(call) {
    if (call.known === false) throw new Error(`unknown tool ${call.name}; the agent only has ${(knownToolNames().length ? knownToolNames() : Object.values(TOOLS)).join(', ')}`);
    if (call.name === TOOLS.search) return searchOutput(await api.search(searchRequest(call.arguments, ctx.getSchema())));
    if (call.name === TOOLS.read) {
      const { entryId } = readRequest(call.arguments);
      const entry = await api.getEntry(entryId);
      const conns = await api.entryConnections(entry.id || entryId).catch(() => null);
      bankEnds[entry.id] = entry;
      return entryOutput(entry, conns);
    }
    if (call.name === TOOLS.walk) return walkOutput(await api.graph(walkRequest(call.arguments)));
    throw new Error(`unknown tool ${call.name}`);
  }

  async function continueRun() {
    const pend = pendingStep(trail);
    if (!pend) { setBusy(false); return; }
    setBusy(true);
    await step(continueBody({ runId: trail.runId, responseId: pend.responseId, outputs: outputsOf(pend) }));
  }

  function stop() {
    stopped = true;
    const runId = trail.runId;
    if (runId && trail.status === 'running') {
      api.abandonAskRun(runId).then(() => { trail = { ...trail, status: 'abandoned' }; renderTimeline(); refreshRuns(); }).catch(() => { trail = { ...trail, status: 'abandoned' }; renderTimeline(); });
    }
    setBusy(false);
    stopBtn.disabled = true;
    renderTimeline();
  }

  async function replay(runId) {
    if (busy) { toast('Wait for the current run to finish (or stop it) before replaying another.', 'info'); runsSel.value = ''; return; }
    mount(timeline, skeleton('Loading the run…'));
    try {
      const detail = await api.getAskRun(runId);
      trail = trailFromRunDetail(detail);
      Object.keys(rawByStep).forEach((k) => delete rawByStep[k]);
      (detail.steps || []).forEach((s) => { rawByStep[s.step_no] = s; });
      questionInput.value = trail.question;
      focusStep = null; selectedId = null;
      stopBtn.disabled = trail.status !== 'running'; // a replayed run that is still open can be abandoned from here
      renderTimeline();
      await paint();
      fitLit(fg);
    } catch (e) {
      toast(`Could not load the run: ${e.message}`, 'error');
      renderTimeline();
    }
  }

  async function refreshRuns() {
    try {
      const page = await api.listAskRuns({ limit: 15 });
      const keep = runsSel.value;
      clear(runsSel);
      runsSel.append(h('option', { value: '' }, 'Replay a past run…'));
      (page.runs || []).forEach((r) => runsSel.append(h('option', { value: r.id }, `${timeAgo(r.started_at)} · ${r.status} · ${String(r.question || '').slice(0, 60)}`)));
      runsSel.value = (page.runs || []).some((r) => r.id === keep) ? keep : '';
    } catch { /* the picker is a convenience */ }
  }

  // ── timeline ───────────────────────────────────────────────────────────────
  function renderTimeline({ live = null } = {}) {
    summaryEl.textContent = trail.steps.length ? [trail.model, trailSummary(trail), trail.status !== 'running' ? trail.status.replace('_', ' ') : null].filter(Boolean).join(' · ') : '';
    const items = [];
    if (!trail.question && !trail.steps.length) items.push(h('div', { class: 'kbx-hint' }, 'Ask a question to watch the model work it, one step at a time.'));
    if (trail.question) items.push(h('div', { class: 'kbx-ask-question' }, h('i', { class: 'bi bi-question-circle' }), ' ', trail.question));
    trail.steps.forEach((st) => items.push(renderStep(st)));
    if (live === 'thinking' || (busy && !pendingStep(trail) && trail.status === 'running' && trail.steps.every((s) => s.calls.every((c) => c.state === 'done' || c.state === 'error')))) {
      items.push(h('div', { class: 'kbx-ask-live', dataset: { role: 'ask-live' } }, h('span', { class: 'kbx-spinner' }), trail.steps.length ? 'The model is reading the results…' : 'The model is reading the question…'));
    } else if ((live === 'next' || !busy) && pendingStep(trail) && !stopped) {
      items.push(h('div', { class: 'kbx-ask-live' },
        h('button', { class: 'kbx-btn kbx-btn-primary kbx-btn-sm', type: 'button', dataset: { role: 'ask-next', action: 'ask_next_step', outcome: 'request' }, onClick: () => continueRun() }, h('i', { class: 'bi bi-skip-end-fill' }), 'Next step'),
        h('span', {}, 'Tool results are in; continue when ready.')));
    }
    if (trail.status === 'abandoned') items.push(h('div', { class: 'kbx-alert', dataset: { role: 'ask-abandoned' } }, 'Stopped. The run is recorded as abandoned.'));
    if (trail.error && trail.status === 'failed') items.push(failureAlert(trail));
    mount(timeline, ...items);
  }

  function failureAlert(t) {
    const alert = h('div', { class: 'kbx-alert danger', dataset: { role: 'ask-failed' } }, `The run failed: ${t.error}`);
    if (!t.errorDetail) return alert;
    const pre = h('pre', { class: 'kbx-graph-raw', style: { display: 'none' }, dataset: { role: 'ask-failed-detail' } }, t.errorDetail);
    const btn = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', dataset: { role: 'ask-failed-toggle', action: 'ask_failed_details_toggle' }, onClick: () => { const on = pre.style.display === 'none'; pre.style.display = on ? 'block' : 'none'; btn.textContent = on ? 'Hide details' : 'Details'; } }, 'Details');
    return h('div', {}, alert, h('div', { class: 'kbx-row', style: { gap: '6px', marginTop: '6px' } }, btn), pre);
  }

  function renderStep(st) {
    const isFocus = focusStep === st.no;
    const head = h('div', { class: 'kbx-ask-step-head', title: 'Show the bank as it looked after this step', onClick: () => { focusStep = isFocus ? null : st.no; renderTimeline(); paint().then(() => fitLit(fg)); } },
      h('span', { class: `kbx-chip ${isFocus ? '' : 'muted'}` }, `Step ${st.no}`), h('span', { class: 'kbx-muted' }, stepCaption(st).replace(/^Step \d+ · ?/, '')),
      usageText(st.usage) ? h('span', { class: 'kbx-muted kbx-ask-usage', dataset: { role: 'ask-step-usage' } }, usageText(st.usage)) : null);
    const parts = [head];
    st.thinking.forEach((t) => parts.push(h('div', { class: 'kbx-ask-think' }, h('i', { class: 'bi bi-chat-left-dots' }), ' ', t)));
    st.calls.forEach((c) => parts.push(renderCall(c)));
    if (st.answer) {
      const refs = trailKnownRefs(trail);
      const segs = citationSegments(st.answer, trail.citations, [...Object.keys(bankEnds), ...refs.ids], refs.slugs);
      // How the model reached each cited entry (searched / walked / read), from the trail itself (kanban 3f60a3d3).
      const prov = citationProvenance(trail);
      const provBy = new Map(prov.rows.map((r) => [r.id, r]));
      parts.push(h('div', { class: 'kbx-ask-answer', dataset: { role: 'ask-answer' } }, ...segs.map((s) => {
        if (!s.cite) return document.createTextNode(s.text);
        if (s.slug) return h('span', { class: 'kbx-cite', title: `playbook ${s.cite} (see the Playbooks tab)`, dataset: { role: 'ask-cite', slug: s.cite, action: 'ask_cite_playbook', targetSlug: s.cite }, onClick: (e) => { e.stopPropagation(); toast(`Playbook ${s.cite}: open it on the Playbooks tab.`, 'info'); } }, s.label);
        const p = provBy.get(s.cite);
        return h('span', { class: `kbx-cite${p && p.walkedOnly ? ' is-walked' : ''}`, title: `${s.cite}\n${p ? p.title : 'cited'}`, dataset: { role: 'ask-cite', entryId: s.cite, action: 'ask_cite_open', targetEntryId: s.cite, via: p ? p.how : 'unseen', walkedOnly: p && p.walkedOnly ? 'true' : 'false' }, onClick: (e) => { e.stopPropagation(); focusId(s.cite); } },
          s.label, h('span', { class: 'kbx-cite-via' }, ` · ${p ? p.how : 'unseen'}`));
      })));
      const line = provenanceLine(prov);
      if (line) parts.push(h('div', { class: 'kbx-muted kbx-ask-provenance', dataset: { role: 'ask-provenance' }, title: prov.rows.map((r) => `${String(r.id).slice(0, 8)}: ${r.title}`).join('\n') }, line));
      if (st.status === 'step_limit') parts.push(h('div', { class: 'kbx-muted', style: { fontSize: '12px', marginTop: '4px' } }, 'The model reached its step limit and was told to answer with what it had.'));
    }
    if (st.error) parts.push(h('div', { class: 'kbx-alert danger', style: { marginTop: '6px' } }, st.error));
    const raw = rawByStep[st.no];
    if (raw) {
      const pre = h('pre', { class: 'kbx-graph-raw', style: { display: 'none' } }, JSON.stringify(raw, null, 2));
      const btn = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', dataset: { action: 'ask_raw_step_toggle' }, onClick: (e) => { e.stopPropagation(); const on = pre.style.display === 'none'; pre.style.display = on ? 'block' : 'none'; btn.textContent = on ? 'Hide raw step' : 'Raw step'; } }, 'Raw step');
      parts.push(h('div', { class: 'kbx-row', style: { gap: '6px', marginTop: '6px' } }, btn), pre);
    }
    return h('div', { class: `kbx-ask-step${isFocus ? ' is-focus' : ''}`, dataset: { role: 'ask-step', step: String(st.no) } }, ...parts);
  }

  function renderCall(c) {
    const headParts = [h('span', { class: 'kbx-chip tool' }, c.call.name), h('span', { class: 'kbx-mono', style: { fontSize: '12px' } }, callArgText(c.call))];
    if (c.state === 'running') headParts.push(h('span', { class: 'kbx-spinner' }));
    else if (c.state === 'error') headParts.push(h('span', { class: 'kbx-chip danger' }, 'failed'));
    else if (c.state === 'done' && c.durationMs) headParts.push(h('span', { class: 'kbx-muted', style: { fontSize: '11px' } }, `${Math.round(c.durationMs)} ms`));
    const body = [];
    if (c.state === 'error') body.push(h('div', { class: 'kbx-ask-row error' }, c.error || 'failed'));
    else if (c.state === 'done' && c.output) body.push(...renderOutput(c.call.name, c.output));
    if (c.state === 'done' || c.state === 'error') body.push(callDetailToggle(c));
    return h('div', { class: `kbx-ask-tool state-${c.state}`, dataset: { role: 'ask-tool', tool: c.call.name, state: c.state } }, h('div', { class: 'kbx-ask-tool-head' }, ...headParts), body.length ? h('div', { class: 'kbx-ask-result' }, ...body) : null);
  }

  /** One call in full: the arguments as sent, timing, what came back, and the raw JSON both ways. */
  function callDetailToggle(c) {
    const d = callDetail(c);
    const argRows = Object.entries(d.args).map(([k, v]) => h('div', { class: 'kbx-ask-kv' }, h('span', { class: 'kbx-mono kbx-muted' }, k), h('span', { class: 'kbx-mono' }, typeof v === 'string' ? v : JSON.stringify(v))));
    const rawIn = h('pre', { class: 'kbx-graph-raw', dataset: { role: 'ask-call-raw-in' } }, d.rawIn);
    const rawOut = h('pre', { class: 'kbx-graph-raw', dataset: { role: 'ask-call-raw-out' } }, d.rawOut || '(no output)');
    const panel = h('div', { class: 'kbx-ask-detail', style: { display: 'none' }, dataset: { role: 'ask-call-detail' } },
      h('div', { class: 'kbx-ask-kv' }, h('span', { class: 'kbx-muted' }, 'tool'), h('span', { class: 'kbx-mono' }, d.tool)),
      h('div', { class: 'kbx-ask-kv' }, h('span', { class: 'kbx-muted' }, 'call id'), h('span', { class: 'kbx-mono' }, d.callId || '?')),
      d.durationMs !== null ? h('div', { class: 'kbx-ask-kv' }, h('span', { class: 'kbx-muted' }, 'took'), h('span', {}, `${d.durationMs} ms`)) : null,
      d.counts ? h('div', { class: 'kbx-ask-kv' }, h('span', { class: 'kbx-muted' }, 'returned'), h('span', { dataset: { role: 'ask-call-counts' } }, d.counts)) : null,
      h('div', { class: 'kbx-side-title', style: { marginTop: '6px' } }, 'Arguments as sent'),
      argRows.length ? h('div', {}, ...argRows) : h('div', { class: 'kbx-muted', style: { fontSize: '11px' } }, 'none'),
      h('div', { class: 'kbx-side-title', style: { marginTop: '6px' } }, 'Raw in'), rawIn,
      h('div', { class: 'kbx-side-title', style: { marginTop: '6px' } }, 'Raw out'), rawOut);
    const btn = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', dataset: { role: 'ask-call-detail-toggle', action: 'ask_call_detail_toggle', targetCallId: d.callId }, onClick: (e) => { e.stopPropagation(); const on = panel.style.display === 'none'; panel.style.display = on ? 'block' : 'none'; btn.textContent = on ? 'Hide call details' : 'Call details'; } }, 'Call details');
    return h('div', {}, btn, panel);
  }

  /** A list that shows `n` rows and a "Show all" button for the rest. */
  function capped(rowsEl, n, label) {
    if (rowsEl.length <= n) return rowsEl;
    const rest = rowsEl.slice(n);
    rest.forEach((r) => { r.style.display = 'none'; });
    const btn = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', dataset: { role: 'ask-show-all', action: 'ask_show_all' }, onClick: (e) => { e.stopPropagation(); rest.forEach((r) => { r.style.display = ''; }); btn.remove(); } }, `Show all ${rowsEl.length} ${label}`);
    return [...rowsEl, btn];
  }

  function row(id, cls, text, extra) {
    return h('div', { class: `kbx-ask-row ${cls}`, title: id, dataset: { entryId: id, role: 'ask-row' }, onClick: (e) => { e.stopPropagation(); focusId(id); } },
      h('span', { class: 'kbx-mono kbx-muted', style: { fontSize: '11px' } }, `${String(id || '').slice(0, 8)} `), text, extra || null);
  }

  function playbookChip(p) {
    return h('div', { class: 'kbx-ptr folded', title: p.hint || p.slug, dataset: { role: 'ask-playbook', slug: p.slug } }, `playbook ${p.slug}${p.title && p.title !== p.slug ? ` — ${p.title}` : ''}`);
  }

  function renderOutput(name, out) {
    const kind = toolKind(name);
    if (kind === 'search') {
      const rows = searchRows(out).map((r) => row(r.id, 'hit', `#${r.rank}${r.score !== null ? ` (${r.score.toFixed(3)})` : ''} ${r.text || String(r.id).slice(0, 8)}`,
        r.related.length ? h('div', { class: 'kbx-graph-ptrs', style: { marginTop: '4px' } }, ...r.related.filter((p) => p && p.id).map((p) => h('div', { class: `kbx-ptr ${p.kind === 'neighbor' ? 'neighbor' : 'folded'}`, title: p.id, dataset: { entryId: p.id }, onClick: (e) => { e.stopPropagation(); focusId(p.id); } }, pointerLine(p)))) : null));
      const playbooks = matchedPlaybooks(out);
      if (!rows.length && !playbooks.length) rows.push(h('div', { class: 'kbx-hint' }, 'No results.'));
      else if (out.collapse) rows.push(h('div', { class: 'kbx-muted', style: { fontSize: '11px' } }, `collapse: ${out.collapse.groups} group${out.collapse.groups === 1 ? '' : 's'}, ${out.collapse.folded} folded, ${out.collapse.neighbors} neighbor${out.collapse.neighbors === 1 ? '' : 's'}`));
      if (playbooks.length) rows.push(h('div', { class: 'kbx-graph-ptrs', style: { marginTop: '4px' }, dataset: { role: 'ask-matched-playbooks' } }, ...playbooks.map(playbookChip)));
      return rows;
    }
    if (kind === 'read') {
      const e = readEntry(out);
      if (!e) return [h('pre', { class: 'kbx-graph-raw' }, JSON.stringify(out, null, 2))];
      const rows = [row(e.id, 'read', e.text || String(e.id).slice(0, 8))];
      e.connections.forEach((k) => rows.push(h('div', { class: 'kbx-ptr neighbor', title: k.id, dataset: { entryId: k.id }, onClick: (ev) => { ev.stopPropagation(); if (k.kind !== 'playbook_step') focusId(k.id); } },
        `${String(k.relation || '').replace(/_/g, ' ')} ${k.direction === 'incoming' ? '←' : '→'} ${k.kind === 'playbook_step' ? `step ${k.playbook}/${k.step}` : (k.text || String(k.id || '').slice(0, 8))}${k.note ? ` — ${k.note}` : ''}`)));
      if (!e.connections.length) rows.push(h('div', { class: 'kbx-muted', style: { fontSize: '11px' } }, 'No connections on this entry.'));
      return rows;
    }
    if (kind === 'playbook') {
      const pb = playbookRead(out);
      if (!pb) return [h('pre', { class: 'kbx-graph-raw' }, JSON.stringify(out, null, 2))];
      const rows = [h('div', { class: 'kbx-ask-row read', dataset: { role: 'ask-playbook-read', slug: pb.slug } }, h('b', {}, pb.title), h('span', { class: 'kbx-mono kbx-muted', style: { fontSize: '11px' } }, ` ${pb.slug}`))];
      pb.steps.slice(0, 30).forEach((st) => rows.push(h('div', { class: 'kbx-ptr muted', dataset: { role: 'ask-playbook-step' } }, `${st.key}${st.kind && st.kind !== 'action' ? ` (${st.kind})` : ''} · ${st.title}`)));
      pb.entries.forEach((e) => rows.push(row(e.id, 'read', `${e.step ? `step ${e.step} cites · ` : ''}${e.text || String(e.id).slice(0, 8)}${e.note ? ` — ${e.note}` : ''}`)));
      if (!pb.steps.length) rows.push(h('div', { class: 'kbx-muted', style: { fontSize: '11px' } }, 'No steps on this playbook.'));
      return rows;
    }
    if (kind === 'walk') {
      const w = walkRead(out);
      const rows = [h('div', { class: 'kbx-muted', style: { fontSize: '11px' } }, `${w.nodes.length} entr${w.nodes.length === 1 ? 'y' : 'ies'} within ${w.depth} hop${w.depth === 1 ? '' : 's'} · ${w.edges.length} edge${w.edges.length === 1 ? '' : 's'}${w.truncated ? ' · cut short by the node cap' : ''}`)];
      const nodeRows = [];
      walkByDepth(w).filter((g) => g.depth > 0).forEach((g) => g.nodes.forEach((n) => nodeRows.push(row(n.id, 'walk', `${n.depth} hop${n.depth === 1 ? '' : 's'} · ${n.text || ''}`))));
      rows.push(...capped(nodeRows, WALK_NODES_SHOWN, 'entries'));
      const edgeRows = w.edges.map((e) => h('div', { class: 'kbx-ptr muted', dataset: { role: 'ask-walk-edge' } }, `${String(e.from || '').slice(0, 8)} ${String(e.relation || '').replace(/_/g, ' ')} → ${String(e.to || '').slice(0, 8)}${e.note ? ` — ${e.note}` : ''}`));
      rows.push(...capped(edgeRows, WALK_EDGES_SHOWN, 'edges'));
      return rows;
    }
    const playbooks = matchedPlaybooks(out);
    if (playbooks.length) return [h('div', { class: 'kbx-graph-ptrs' }, ...playbooks.map(playbookChip))];
    return [h('pre', { class: 'kbx-graph-raw' }, JSON.stringify(out, null, 2))];
  }

  // ── drawing ────────────────────────────────────────────────────────────────
  function nodeColor(n) {
    if (n.id === selectedId) return GRAPH_COLORS.selected;
    if (GRAPH_COLORS[n.kind] && n.kind !== 'bank') return GRAPH_COLORS[n.kind];
    return trail.steps.length ? (options().focus === 'shrink' ? GRAPH_COLORS.dust : GRAPH_COLORS.bankDim) : GRAPH_COLORS.bank;
  }
  function nodeTip(n) {
    const parts = [];
    if (n.kind === 'hit') parts.push(`<b>retrieved #${n.rank}</b>`);
    else if (KIND_LABEL[n.kind]) parts.push(`<b>${KIND_LABEL[n.kind]}</b>`);
    // every role the entry played, with the step it first played it (not only the colour that won)
    if (n.trace && n.trace.length) n.trace.forEach((t) => parts.push(`<span style="opacity:.8">${esc(traceLine(t))}</span>`));
    else if (n.step) parts.push(`<span style="opacity:.75">step ${n.step}</span>`);
    parts.push(esc(n.text || labelFor(bankEnds[n.id]) || String(n.id).slice(0, 8)));
    if (n.note) parts.push(`<i>${esc(n.note)}</i>`);
    return `<div class="kbx kbx-graph-tip">${parts.join('<br>')}</div>`;
  }
  function linkColor(l) { return l.pointer ? GRAPH_COLORS.folded : (RELATION_COLORS[l.relation] || RELATION_COLORS.connected); }

  /** Redraw; `fit` is the camera intent once the engine settles (see fitPlan):
      'picture' for what the user asked to see, 'auto' for a step landing mid-run. */
  async function paint(fit = 'picture') {
    if (!bankEdges || !fg) return;
    if (fit !== 'auto') userMoved = false;
    pendingFit = fit;
    const o = options();
    const pic = trail.steps.length ? trailPicture(trail, { uptoStep: focusStep === null ? Infinity : focusStep }) : null;
    if (pic) Object.entries(pic.ends).forEach(([id, end]) => { if (!bankEnds[id]) bankEnds[id] = end; });
    const sc = scene(bankEdges, pic && pic.nodes.length ? pic : null, { focus: o.focus, hideBackfill: o.hideBackfill });
    sc.nodes.forEach((n) => {
      if (!n.text && bankEnds[n.id]) n.text = labelFor(bankEnds[n.id]);
      // a focused step: what it brought in for the first time is drawn larger than what earlier steps had already lit
      if (focusStep !== null && n.lit && n.trace && n.trace.length && Math.min(...n.trace.map((t) => t.step || Infinity)) === focusStep) n.val *= 1.8;
    });
    if (!sc.nodes.length) {
      fg.graphData({ nodes: [], links: [] });
      caption.textContent = 'nothing to draw yet';
      showOverlay(h('div', { class: 'kbx-empty' }, h('i', { class: 'bi bi-chat-dots' }), h('h4', {}, pic ? 'Nothing touched yet' : 'No connections yet'), h('div', {}, pic ? 'The first search will light entries up here.' : 'Entries appear here as the model touches them.')));
      return;
    }
    hideOverlay();
    fg.cooldownTicks(160).warmupTicks(30);
    fg.graphData({ nodes: sc.nodes, links: sc.links });
    const c = pic ? pic.stats.counts : {};
    caption.textContent = pic
      ? [`${c.hit || 0} searched`, `${(c.folded || 0) + (c.neighbor || 0)} pointed at`, `${c.read || 0} read`, `${c.walk || 0} walked`, c.cited ? `${c.cited} cited` : null, focusStep !== null ? `through step ${focusStep}` : null].filter(Boolean).join(' · ')
      : `${sc.stats.nodes.toLocaleString()} entries · ${sc.stats.links.toLocaleString()} connections`;
  }

  function focusId(id) {
    if (!fg || !isEntryId(id)) return;
    const n = fg.graphData().nodes.find((x) => x.id === id);
    if (n) selectNode(n); else openEntryDetail(ctx, id);
  }

  async function selectNode(n) {
    selectedId = n.id;
    pendingFit = null; // the user took the camera: a paint still settling must not pull it back out
    if (fg) fg.nodeColor(nodeColor);
    flyTo(fg, n);
    let entry = bankEnds[n.id];
    if (!entry || !(entry.content || entry.summary || entry.useful_for || entry.text)) {
      mount(selectedHost, skeleton('Loading entry…'));
      try { entry = await api.getEntry(n.id); bankEnds[n.id] = entry; n.text = labelFor(entry); }
      catch (e) { mount(selectedHost, h('div', { class: 'kbx-alert danger' }, `Could not load the entry: ${e.message}`)); return; }
    }
    const links = fg ? fg.graphData().links.filter((l) => (l.source.id || l.source) === n.id || (l.target.id || l.target) === n.id) : [];
    mount(selectedHost,
      h('div', { class: 'kbx-row', style: { gap: '6px', alignItems: 'center' } }, h('span', { class: `kbx-chip ${n.kind === 'bank' ? 'muted' : ''}` }, n.kind === 'hit' ? `retrieved #${n.rank}` : KIND_LABEL[n.kind] || 'in the bank'), h('span', { class: 'kbx-mono kbx-muted', style: { fontSize: '11px' } }, String(n.id).slice(0, 8))),
      n.trace && n.trace.length ? h('div', { class: 'kbx-graph-ptrs', style: { marginTop: '6px' }, dataset: { role: 'ask-selected-trace' } }, ...n.trace.map((t) => h('div', { class: `kbx-ptr ${t.role === 'walk' ? 'walk' : 'muted'}`, dataset: { role: t.role } }, traceLine(t)))) : null,
      h('div', { class: 'kbx-graph-selected-text' }, labelFor(entry)),
      entry.useful_for && labelFor(entry) !== entry.useful_for ? h('div', { class: 'kbx-muted', style: { fontSize: '12px', marginTop: '4px' } }, entry.useful_for) : null,
      h('div', { class: 'kbx-row', style: { gap: '6px', marginTop: '8px' } },
        h('button', { class: 'kbx-btn kbx-btn-sm kbx-btn-primary', type: 'button', dataset: { role: 'ask-open-entry', action: 'entry_open', targetEntryId: n.id, outcome: 'open' }, onClick: () => openEntryDetail(ctx, n.id) }, 'Open entry')),
      links.length ? h('div', { class: 'kbx-graph-ptrs', style: { marginTop: '8px' } }, ...links.slice(0, 30).map((l) => {
        const src = l.source.id || l.source; const tgt = l.target.id || l.target; const other = src === n.id ? tgt : src;
        return h('div', { class: `kbx-ptr ${l.pointer ? 'folded' : 'muted'}` }, `${String(l.relation || '').replace(/_/g, ' ')} ${src === n.id ? '→' : '←'} ${labelFor(bankEnds[other]) || String(other).slice(0, 8)}${l.note ? ` — ${l.note}` : ''}`);
      })) : h('div', { class: 'kbx-hint', style: { marginTop: '8px' } }, 'No drawn connections.'));
  }

  async function initGraph() {
    try { await ensureForceGraph3D(); }
    catch (e) { showOverlay(h('div', { class: 'kbx-alert danger' }, `3D graph library not available: ${e.message}`)); return false; }
    try {
      fg = window.ForceGraph3D()(canvas)
        .width(canvas.clientWidth || 800).height(canvas.clientHeight || 560)
        .backgroundColor(GRAPH_COLORS.bg)
        .nodeVal((n) => n.val || 1).nodeColor(nodeColor).nodeOpacity(0.95)
        .nodeLabel(nodeTip)
        .linkColor(linkColor).linkOpacity(0.6).linkWidth((l) => (l.lit ? 1.4 : 0))
        .linkDirectionalParticles((l) => (l.pointer ? 3 : 0)).linkDirectionalParticleWidth(1.8).linkDirectionalParticleColor(() => GRAPH_COLORS.folded)
        .onNodeClick((n) => selectNode(n))
        .onNodeHover((n) => { canvas.style.cursor = n ? 'pointer' : 'default'; })
        .onEngineStop(() => onSettled())
        .enableNodeDrag(false);
    } catch (e) {
      showOverlay(h('div', { class: 'kbx-alert danger' }, `WebGL is needed for the 3D graph: ${e.message}`));
      fg = null;
      return false;
    }
    const controls = fg.controls();
    if (controls && controls.addEventListener) controls.addEventListener('start', () => { userMoved = true; });
    if (window.ResizeObserver) new ResizeObserver(() => { if (fg && canvas.clientWidth) fg.width(canvas.clientWidth).height(canvas.clientHeight); }).observe(canvas);
    return true;
  }

  /** Engine settled. A selection recolour restarts the engine without new data,
      so only a pending paint intent moves the camera. */
  function onSettled() {
    if (!fg) return;
    const { nodes, links } = fg.graphData();
    const plan = fitPlan({ pending: pendingFit, userMoved, selectedPresent: nodes.some((n) => n.id === selectedId), litCount: nodes.filter((n) => n.lit).length });
    pendingFit = null;
    if (plan === 'selection') { const ids = neighbourhood(selectedId, links); fg.zoomToFit(600, 80, (n) => ids.has(n.id)); }
    else if (plan !== 'none') fitLit(fg);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  async function load() {
    if (loaded) return;
    loaded = true;
    renderTimeline();
    try {
      config = await api.askConfig();
      clear(modelSel);
      (config.models || []).forEach((m) => modelSel.append(h('option', { value: m }, m)));
      const line = mountLine(config);
      toolsLine.textContent = line;
      toolsLine.title = mountTools(config).map((t) => `${t.name}: ${t.description}`).join('\n');
      toolsLine.style.display = line ? '' : 'none';
      if (!config.available) { unavailable.textContent = `Ask is not available on this bank: ${config.unavailable_reason || 'no model credential'}`; unavailable.style.display = ''; }
      else unavailable.style.display = 'none';
    } catch (e) {
      config = null;
      unavailable.textContent = `Ask is not available: ${e.message}`;
      unavailable.style.display = '';
    }
    loadSettings();
    setBusy(false);
    refreshRuns();
    showOverlay(skeleton('Loading the bank’s connections…'));
    const ok = await initGraph();
    try { bankEdges = await loadBankEdges(api); }
    catch (e) { showOverlay(h('div', { class: 'kbx-alert danger' }, `Could not load connections: ${e.message}`)); return; }
    if (!ok) return;
    await paint();
  }
  function onShow() { if (fg && canvas.clientWidth) fg.width(canvas.clientWidth).height(canvas.clientHeight); }

  return { el, load, onShow };
}
