/* Standalone host bootstrap (SDK local server and KB platform /ui).

   The page carries no bank id of its own: `?kb=<id>` selects a bank, otherwise
   the picker (picker.js) tables every bank the credential can see (GET
   data-banks-url → {banks:[{kb_id,name,description,entry_count,total_queries}]})
   and, when the host sets data-stats-url, hydrates live per-bank stats from it.
   The hosted app renders #kbx-root with data-kb-id itself and loads main.js
   directly; without a bank id it also loads this module for the picker. */

import { bootExplorer } from './main.js';
import { pickBank } from './picker.js';
import { getToken, tokenGate } from './token.js';

function showPicker(root) {
  const headers = {};
  if (root.dataset.tokenGate) { const t = getToken(); if (t) headers.Authorization = `Bearer ${t}`; }
  return pickBank(root, {
    headers,
    onUnauthorized: root.dataset.tokenGate
      ? () => { try { sessionStorage.removeItem('kbx-token'); } catch { /* ignore */ } tokenGate(root, () => showPicker(root)); }
      : null,
  });
}

function boot() {
  const root = document.getElementById('kbx-root');
  if (!root) return;
  const kb = root.dataset.kbId || new URLSearchParams(location.search).get('kb');
  const start = () => {
    if (kb) {
      root.dataset.kbId = kb;
      if (!root.dataset.dashUrl) root.dataset.dashUrl = location.pathname; // back → picker
      bootExplorer(root);
    } else {
      showPicker(root);
    }
  };
  if (root.dataset.tokenGate && !getToken()) { tokenGate(root, start); return; }
  start();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
