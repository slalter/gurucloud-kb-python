/* Native <dialog> modal helper for the KB Explorer.
   openModal({title, body, footer, wide}) returns { dialog, close }. Closing on
   backdrop click, Escape (native), and the × button. Bodies pass DOM nodes. */

import { h, clear } from './dom.js';

export function openModal({ title, body, footer = [], wide = false }) {
  // `kbx` on the dialog makes the --kbx-*/--mk-* tokens resolve even though the
  // dialog is appended to document.body, outside the page's .kbx container.
  const dialog = h('dialog', { class: `kbx kbx-dialog${wide ? ' wide' : ''}` });

  const close = () => {
    if (dialog.open) dialog.close();
  };

  const head = h('div', { class: 'kbx-dialog-head' },
    h('h3', { class: 'kbx-dialog-title' }, title || ''),
    h('button', { class: 'kbx-dialog-close', 'aria-label': 'Close', type: 'button', onClick: close }, '×'));

  const bodyWrap = h('div', { class: 'kbx-dialog-body' });
  if (body) bodyWrap.append(body.nodeType ? body : document.createTextNode(String(body)));

  const footWrap = h('div', { class: 'kbx-dialog-foot' });
  const setFoot = (nodes) => {
    clear(footWrap);
    (Array.isArray(nodes) ? nodes : [nodes]).forEach((f) => f && footWrap.append(f));
    footWrap.style.display = footWrap.childNodes.length ? '' : 'none';
  };
  setFoot(footer);

  dialog.append(head, bodyWrap, footWrap);

  // Backdrop click closes (click target is the dialog element itself).
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  dialog.addEventListener('close', () => dialog.remove());

  document.body.append(dialog);
  dialog.showModal();
  return {
    dialog, close, body: bodyWrap, foot: footWrap, setFoot,
    setBody: (node) => { clear(bodyWrap); if (node) bodyWrap.append(node); },
  };
}

/** A confirm dialog that resolves true/false. Destructive by default. */
export function confirmModal({ title, message, confirmLabel = 'Delete', danger = true }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (done) return; done = true; resolve(val); ref.close(); };
    const confirmBtn = h('button', {
      class: `kbx-btn ${danger ? 'kbx-btn-danger' : 'kbx-btn-primary'}`,
      type: 'button',
      onClick: () => finish(true),
    }, confirmLabel);
    const cancelBtn = h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', onClick: () => finish(false) }, 'Cancel');
    const ref = openModal({
      title,
      body: h('div', {}, typeof message === 'string' ? h('p', { style: { margin: 0, lineHeight: '1.55' } }, message) : message),
      footer: [cancelBtn, confirmBtn],
    });
    ref.dialog.addEventListener('close', () => finish(false));
  });
}
