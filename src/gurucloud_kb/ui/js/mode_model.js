/* Explorer host modes — pure logic (no DOM), Node-tested in
   tests/test_kb_explorer_mode_model.js.

   The same bundle is mounted by four hosts, told apart by #kbx-root's
   data-mode:

     app         the hosted gurucloudai app (session auth, every tab, back link)
     sdk         `gurucloud-kb ui`, the SDK's local server
     platform    the self-hosted kb-platform image at /ui
     playground  the public /playground/ask page (kanban b93ead39): one demo
                 bank, no account, only the Ask and Graph tabs, no back link.

   main.js asks this module which panels to build and where to start so the
   playground cannot reach tabs whose routes its API does not serve. */

export const ALL_PANEL_IDS = Object.freeze(['entries', 'map', 'graph', 'ask', 'similar', 'playbooks', 'process-search', 'schema', 'quality', 'history', 'connect']);
export const PLAYGROUND_PANEL_IDS = Object.freeze(['ask', 'graph']);
export const MODES = Object.freeze(['app', 'sdk', 'platform', 'playground']);

/** The mode a data-mode value means; anything unknown behaves as the hosted app. */
export function normalizeMode(value) {
  const m = String(value || '').trim().toLowerCase();
  return MODES.includes(m) ? m : 'app';
}

/** Panel ids the host shows, in tab order. */
export function visiblePanelIds(mode) {
  return normalizeMode(mode) === 'playground' ? PLAYGROUND_PANEL_IDS.slice() : ALL_PANEL_IDS.slice();
}

/** The tab to open first: the URL hash when it names a visible panel (a tab may carry
    its own state after '?', e.g. '#process-search?q=Jess'), else the mode's home tab. */
export function initialPanel(mode, hash) {
  const ids = visiblePanelIds(mode);
  const want = String(hash || '').replace(/^#/, '').split('?')[0];
  if (ids.includes(want)) return want;
  return normalizeMode(mode) === 'playground' ? 'ask' : 'entries';
}

/** The small chip beside the bank id that names a non-app host, or null. */
export function modeChip(mode) {
  const m = normalizeMode(mode);
  if (m === 'sdk') return 'gurucloud-kb ui';
  if (m === 'platform') return 'KB platform';
  if (m === 'playground') return 'Public playground';
  return null;
}

/** Only the hosted app has a Knowledge Banks list to go back to. */
export function showsBackLink(mode) {
  return normalizeMode(mode) === 'app';
}

/** The playground page carries its own intro, so the bundle hides the bank's description there. */
export function showsBankDescription(mode) {
  return normalizeMode(mode) !== 'playground';
}

/** The playground page sets its own <title>; the other hosts let the bundle name the tab after the bank. */
export function ownsDocumentTitle(mode) {
  return normalizeMode(mode) !== 'playground';
}

/** Model, thinking and max-steps knobs: hidden on the playground, whose API clamps them anyway. */
export function showsModelKnobs(mode) {
  return normalizeMode(mode) !== 'playground';
}
