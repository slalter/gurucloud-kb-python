/* Token gate — for hosts whose API needs a bearer token from the browser (the
   self-hosted KB platform, where the service token is the credential). The
   token lives in sessionStorage only (cleared when the tab closes) and is sent
   by api.js on every call. The hosted app (session cookies) and the SDK local
   server (key held server-side) never load this gate. */

import { h, mount } from './dom.js';

const KEY = 'kbx-token';

export function getToken() {
  try { return sessionStorage.getItem(KEY) || null; } catch { return null; }
}

export function setToken(token) {
  try { sessionStorage.setItem(KEY, token); } catch { /* private mode: token lives for this page only */ }
}

export function clearToken() {
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** Render a token prompt into `root`; call `onReady()` once a token is stored. */
export function tokenGate(root, onReady) {
  const input = h('input', { class: 'kbx-input kbx-mono', type: 'password', placeholder: 'Service token', autocomplete: 'off' });
  const btn = h('button', { class: 'kbx-btn kbx-btn-primary', type: 'button' }, 'Open explorer');
  const submit = () => {
    const v = input.value.trim();
    if (!v) { input.focus(); return; }
    setToken(v);
    onReady();
  };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  mount(root,
    h('div', { class: 'kbx-card kbx-token-gate' },
      h('div', { class: 'kbx-title', style: { marginBottom: '12px' } },
        h('span', { class: 'kbx-mascot', 'aria-hidden': 'true' }, h('i', {}), h('i', {})),
        h('h1', { class: 'kbx-h1', style: { fontSize: '22px' } }, 'Knowledge Bank Explorer')),
      h('p', { class: 'kbx-muted', style: { marginTop: 0 } }, 'This platform authenticates every API call with its service token. Paste it to open the explorer; it is kept in this tab only.'),
      h('div', { class: 'kbx-field' }, h('label', {}, 'KB_SERVICE_AUTH_TOKEN'), input),
      h('div', { class: 'kbx-row', style: { justifyContent: 'flex-end' } }, btn)));
  input.focus();
}
