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

   The service runs ONE model turn per POST /ask/step; this file runs the
   tools it asks for against the Explorer API (search, entry + edges, graph)
   through the pure shapers in ask_model.js (Node-tested). */

import { h, mount, clear, toast, skeleton, esc, timeAgo } from './dom.js';
import { openEntryDetail } from './entry_detail.js';
import { RELATION_COLORS, fitPlan, labelFor, neighbourhood, pointerLine, scene } from './graph_model.js';
import { GRAPH_COLORS, ensureForceGraph3D, fitLit, flyTo, loadBankEdges } from './graph3d.js';
import { showsModelKnobs } from './mode_model.js';
import {
  REASONING, TOOLS, addStep, citationSegments, continueBody, emptyTrail, entryOutput, normalizeAskOptions, outputsOf, pendingStep,
  readRequest, searchOutput, searchRequest, setCallResult, settingsKey, startBody, stepCaption, stepFailure, trailFromRunDetail, trailPicture,
  trailSummary, walkOutput, walkRequest,
} from './ask_model.js';

const KIND_LABEL = { hit: 'retrieved', folded: 'pointer (folded)', neighbor: 'one hop away', read: 'read in full', walk: 'walked', cited: 'cited in the answer', ctx: 'other connection', bank: '' };
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
  const questionInput = h('input', { class: 'kbx-input', type: 'text', placeholder: 'Ask the bank a question, e.g. “How does the client quote a rush order?”', dataset: { role: 'ask-question' } });
  const modelSel = h('select', { class: 'kbx-select', dataset: { role: 'ask-model' } });
  const reasoningSel = h('select', { class: 'kbx-select', dataset: { role: 'ask-reasoning' }, title: 'How much the model thinks before each step (gpt-6 family: none / low / medium)' },
    ...REASONING.map((r) => h('option', { value: r }, r)));
  const stepsInput = h('input', { class: 'kbx-input', type: 'number', min: '1', max: '12', value: '8', title: 'Model turns before it must answer', dataset: { role: 'ask-max-steps' } });
  const autoCb = h('input', { type: 'checkbox', checked: true, dataset: { role: 'ask-auto' } });
  const focusSel = h('select', { class: 'kbx-select', dataset: { role: 'ask-focus' }, title: 'What happens to the entries the model has not touched' },
    h('option', { value: 'shrink' }, 'shrink the rest'), h('option', { value: 'only' }, 'touched only'), h('option', { value: 'dim' }, 'dim the rest'));
  const backfillCb = h('input', { type: 'checkbox', checked: true, dataset: { role: 'ask-hide-backfill' } });
  const askBtn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button', dataset: { role: 'ask-run' }, onClick: () => ask() }, h('i', { class: 'bi bi-play-fill' }), 'Ask');
  const stopBtn = h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', dataset: { role: 'ask-stop' }, disabled: true, onClick: () => stop() }, h('i', { class: 'bi bi-stop-fill' }), 'Stop');
  const runsSel = h('select', { class: 'kbx-select', dataset: { role: 'ask-runs' }, title: 'Replay a past run from the audit trail', style: { maxWidth: '260px' } }, h('option', { value: '' }, 'Replay a past run…'));
  const unavailable = h('div', { class: 'kbx-alert warn', dataset: { role: 'ask-unavailable' }, style: { display: 'none' } });
  questionInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
  [modelSel, reasoningSel, stepsInput, autoCb].forEach((i) => i.addEventListener('change', saveSettings));
  [focusSel, backfillCb].forEach((i) => i.addEventListener('change', () => { saveSettings(); paint(); }));
  runsSel.addEventListener('change', () => { if (runsSel.value) replay(runsSel.value); });

  const toolbar = h('div', { class: 'kbx-card' },
    h('div', { class: 'kbx-card-head' },
      h('div', {}, h('h3', { class: 'kbx-card-title' }, 'Ask'), h('div', { class: 'kbx-card-sub' }, 'A small model answers from this bank alone. Watch it search, read, follow pointers and walk the graph; everything it touches lights up on the right.')),
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
    h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', title: 'Fit', dataset: { role: 'ask-fit' }, onClick: () => fitLit(fg) }, h('i', { class: 'bi bi-arrows-fullscreen' })));
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
    for (const c of st.calls) {
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
  }

  async function runTool(call) {
    if (call.known === false) throw new Error(`unknown tool ${call.name}; the agent only has ${Object.values(TOOLS).join(', ')}`);
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
        h('button', { class: 'kbx-btn kbx-btn-primary kbx-btn-sm', type: 'button', dataset: { role: 'ask-next' }, onClick: () => continueRun() }, h('i', { class: 'bi bi-skip-end-fill' }), 'Next step'),
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
    const btn = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', dataset: { role: 'ask-failed-toggle' }, onClick: () => { const on = pre.style.display === 'none'; pre.style.display = on ? 'block' : 'none'; btn.textContent = on ? 'Hide details' : 'Details'; } }, 'Details');
    return h('div', {}, alert, h('div', { class: 'kbx-row', style: { gap: '6px', marginTop: '6px' } }, btn), pre);
  }

  function renderStep(st) {
    const isFocus = focusStep === st.no;
    const head = h('div', { class: 'kbx-ask-step-head', title: 'Show the bank as it looked after this step', onClick: () => { focusStep = isFocus ? null : st.no; renderTimeline(); paint().then(() => fitLit(fg)); } },
      h('span', { class: `kbx-chip ${isFocus ? '' : 'muted'}` }, `Step ${st.no}`), h('span', { class: 'kbx-muted' }, stepCaption(st).replace(/^Step \d+ · ?/, '')));
    const parts = [head];
    st.thinking.forEach((t) => parts.push(h('div', { class: 'kbx-ask-think' }, h('i', { class: 'bi bi-chat-left-dots' }), ' ', t)));
    st.calls.forEach((c) => parts.push(renderCall(c)));
    if (st.answer) {
      const segs = citationSegments(st.answer, trail.citations, Object.keys(bankEnds));
      parts.push(h('div', { class: 'kbx-ask-answer', dataset: { role: 'ask-answer' } }, ...segs.map((s) => (s.cite
        ? h('span', { class: 'kbx-cite', title: s.cite, dataset: { role: 'ask-cite', entryId: s.cite }, onClick: (e) => { e.stopPropagation(); focusId(s.cite); } }, s.label)
        : document.createTextNode(s.text)))));
      if (st.status === 'step_limit') parts.push(h('div', { class: 'kbx-muted', style: { fontSize: '12px', marginTop: '4px' } }, 'The model reached its step limit and was told to answer with what it had.'));
    }
    if (st.error) parts.push(h('div', { class: 'kbx-alert danger', style: { marginTop: '6px' } }, st.error));
    const raw = rawByStep[st.no];
    if (raw) {
      const pre = h('pre', { class: 'kbx-graph-raw', style: { display: 'none' } }, JSON.stringify(raw, null, 2));
      const btn = h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', onClick: (e) => { e.stopPropagation(); const on = pre.style.display === 'none'; pre.style.display = on ? 'block' : 'none'; btn.textContent = on ? 'Hide raw step' : 'Raw step'; } }, 'Raw step');
      parts.push(h('div', { class: 'kbx-row', style: { gap: '6px', marginTop: '6px' } }, btn), pre);
    }
    return h('div', { class: `kbx-ask-step${isFocus ? ' is-focus' : ''}`, dataset: { role: 'ask-step', step: String(st.no) } }, ...parts);
  }

  function renderCall(c) {
    const a = c.call.arguments || {};
    const argText = c.call.name === TOOLS.search ? `“${a.query || ''}”${a.k ? ` · k=${a.k}` : ''}` : c.call.name === TOOLS.read ? String(a.entry_id || a.id || '') : c.call.name === TOOLS.walk ? `${a.root || ''}${a.depth ? ` · depth ${a.depth}` : ''}` : JSON.stringify(a);
    const headParts = [h('span', { class: 'kbx-chip tool' }, c.call.name), h('span', { class: 'kbx-mono', style: { fontSize: '12px' } }, argText)];
    if (c.state === 'running') headParts.push(h('span', { class: 'kbx-spinner' }));
    else if (c.state === 'error') headParts.push(h('span', { class: 'kbx-chip danger' }, 'failed'));
    else if (c.state === 'done' && c.durationMs) headParts.push(h('span', { class: 'kbx-muted', style: { fontSize: '11px' } }, `${Math.round(c.durationMs)} ms`));
    const body = [];
    if (c.state === 'error') body.push(h('div', { class: 'kbx-ask-row error' }, c.error || 'failed'));
    else if (c.state === 'done' && c.output) body.push(...renderOutput(c.call.name, c.output));
    return h('div', { class: `kbx-ask-tool state-${c.state}`, dataset: { role: 'ask-tool', tool: c.call.name, state: c.state } }, h('div', { class: 'kbx-ask-tool-head' }, ...headParts), body.length ? h('div', { class: 'kbx-ask-result' }, ...body) : null);
  }

  function row(id, cls, text, extra) {
    return h('div', { class: `kbx-ask-row ${cls}`, title: id, dataset: { entryId: id, role: 'ask-row' }, onClick: (e) => { e.stopPropagation(); focusId(id); } },
      h('span', { class: 'kbx-mono kbx-muted', style: { fontSize: '11px' } }, `${String(id || '').slice(0, 8)} `), text, extra || null);
  }

  function renderOutput(name, out) {
    if (name === TOOLS.search) {
      const rows = (out.results || []).map((r) => row(r.id, 'hit', `#${r.rank} ${r.summary || r.useful_for || String(r.content || '').slice(0, 140)}`,
        (r.related || []).length ? h('div', { class: 'kbx-graph-ptrs', style: { marginTop: '4px' } }, ...r.related.map((p) => h('div', { class: `kbx-ptr ${p.kind === 'neighbor' ? 'neighbor' : 'folded'}`, title: p.id, dataset: { entryId: p.id }, onClick: (e) => { e.stopPropagation(); focusId(p.id); } }, pointerLine(p)))) : null));
      if (!rows.length) rows.push(h('div', { class: 'kbx-hint' }, 'No results.'));
      else if (out.collapse) rows.push(h('div', { class: 'kbx-muted', style: { fontSize: '11px' } }, `collapse: ${out.collapse.groups} group${out.collapse.groups === 1 ? '' : 's'}, ${out.collapse.folded} folded, ${out.collapse.neighbors} neighbor${out.collapse.neighbors === 1 ? '' : 's'}`));
      return rows;
    }
    if (name === TOOLS.read) {
      const rows = [row(out.id, 'read', out.summary || out.useful_for || String(out.content || '').slice(0, 160))];
      (out.connections || []).forEach((k) => rows.push(h('div', { class: 'kbx-ptr neighbor', title: k.id, dataset: { entryId: k.id }, onClick: (e) => { e.stopPropagation(); if (k.kind !== 'playbook_step') focusId(k.id); } },
        `${String(k.relation || '').replace(/_/g, ' ')} ${k.direction === 'incoming' ? '←' : '→'} ${k.kind === 'playbook_step' ? `step ${k.playbook}/${k.step}` : (k.text || String(k.id || '').slice(0, 8))}${k.note ? ` — ${k.note}` : ''}`)));
      if (!(out.connections || []).length) rows.push(h('div', { class: 'kbx-muted', style: { fontSize: '11px' } }, 'No connections on this entry.'));
      return rows;
    }
    if (name === TOOLS.walk) {
      const nodes = out.nodes || []; const edges = out.edges || [];
      const rows = [h('div', { class: 'kbx-muted', style: { fontSize: '11px' } }, `${nodes.length} entr${nodes.length === 1 ? 'y' : 'ies'} within ${out.depth || 1} hop${(out.depth || 1) === 1 ? '' : 's'} · ${edges.length} edge${edges.length === 1 ? '' : 's'}${out.truncated ? ' · cut short by the node cap' : ''}`)];
      nodes.filter((n) => n.depth > 0 && n.kind !== 'playbook_step').slice(0, 24).forEach((n) => rows.push(row(n.id, 'walk', `${n.depth} hop${n.depth === 1 ? '' : 's'} · ${n.text || ''}`)));
      edges.slice(0, 40).forEach((e) => rows.push(h('div', { class: 'kbx-ptr muted' }, `${String(e.from || '').slice(0, 8)} ${String(e.relation || '').replace(/_/g, ' ')} → ${String(e.to || '').slice(0, 8)}${e.note ? ` — ${e.note}` : ''}`)));
      return rows;
    }
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
    if (n.step) parts.push(`<span style="opacity:.75">step ${n.step}</span>`);
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
    sc.nodes.forEach((n) => { if (!n.text && bankEnds[n.id]) n.text = labelFor(bankEnds[n.id]); });
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
    if (!fg) return;
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
      h('div', { class: 'kbx-graph-selected-text' }, labelFor(entry)),
      entry.useful_for && labelFor(entry) !== entry.useful_for ? h('div', { class: 'kbx-muted', style: { fontSize: '12px', marginTop: '4px' } }, entry.useful_for) : null,
      h('div', { class: 'kbx-row', style: { gap: '6px', marginTop: '8px' } },
        h('button', { class: 'kbx-btn kbx-btn-sm kbx-btn-primary', type: 'button', dataset: { role: 'ask-open-entry' }, onClick: () => openEntryDetail(ctx, n.id) }, 'Open entry')),
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
