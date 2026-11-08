/* Who the explorer page is talking to — pure logic (no DOM), Node-tested in
   tests/test_kb_explorer_viewer_model.js (kanban 39aa973f).

   The hosted app's /info carries `viewer: {access, can_edit}`
   (services/kb_visible_banks.py::explorer_viewer): the owner, an admin or a
   grantee at MANAGE+ edits; a USE grantee (a client reading its Business KB)
   reads. Hosts that do not send `viewer` (the SDK's local server, the KB
   platform image, older APIs) keep the full editor page.

   Presentation only: hiding a button never replaces the server's check. */

/** True unless /info says this viewer only reads the bank. */
export function canEdit(info) {
  const v = info && info.viewer;
  return !(v && typeof v === 'object' && v.can_edit === false);
}

/** Operator chrome (query/latency tiles, the bank id chip) is for editors only. */
export function showsOperatorChrome(info) {
  return canEdit(info);
}

const LEAD_MAX = 200;

/** Split a bank description into a reader-facing lead and the full text.

    A bank's description doubles as its MCP charter: instructions for agents
    ("Set `kind`…", "list_processes / get_process"). The page shows only the
    first sentence (trimmed at a colon when that sentence runs on into a
    list) and keeps the whole charter behind a "for agents" disclosure.
    Returns {lead, full}; `full` is '' when the lead already says everything. */
export function descriptionParts(text) {
  const src = String(text || '').trim();
  if (!src) return { lead: '', full: '' };
  const firstPara = src.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  const m = firstPara.match(/^.+?[.!?](?=\s|$)/);
  let lead = (m ? m[0] : firstPara).trim();
  if (lead.length > LEAD_MAX) {
    const colon = lead.indexOf(': ');
    if (colon > 20 && colon < LEAD_MAX) lead = `${lead.slice(0, colon)}.`;
  }
  if (lead.length > LEAD_MAX) {
    const cut = lead.lastIndexOf(' ', LEAD_MAX - 1);
    lead = `${lead.slice(0, cut > 40 ? cut : LEAD_MAX - 1).replace(/[\s,;:]+$/, '')}…`;
  }
  lead = lead.replace(/`/g, '');
  const whole = src.replace(/\s+/g, ' ').replace(/`/g, '').trim();
  return { lead, full: lead === whole ? '' : src };
}
