/* Tiny DOM helpers for the KB Explorer — no framework, no build step.
   `h` builds elements; `esc` escapes text; `toast` reports outcomes; small
   formatters keep the view modules terse. */

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function esc(s) {
  const d = document.createElement('div');
  d.textContent = s === null || s === undefined ? '' : String(s);
  return d.innerHTML;
}

export function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }

export function mount(el, ...nodes) {
  clear(el);
  nodes.flat().forEach((n) => n && el.append(n.nodeType ? n : document.createTextNode(String(n))));
  return el;
}

let toastHost = null;
export function toast(message, type = 'info') {
  if (!toastHost) {
    toastHost = document.querySelector('.kbx-toasts') || h('div', { class: 'kbx kbx-toasts' });
    if (!toastHost.parentNode) document.body.append(toastHost);
  }
  const t = h('div', { class: `kbx-toast ${type}` }, message);
  toastHost.append(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, 4200);
}

export function skeleton(label = 'Loading…') {
  return h('div', { class: 'kbx-skeleton' }, h('span', { class: 'kbx-spinner' }), label);
}

export function empty(icon, title, sub) {
  return h('div', { class: 'kbx-empty' },
    h('i', { class: `bi ${icon}` }),
    h('h4', {}, title),
    sub ? h('div', {}, sub) : null);
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const hr = Math.floor(m / 60); if (hr < 24) return `${hr}h ago`;
  const dy = Math.floor(hr / 24); if (dy < 30) return `${dy}d ago`;
  return fmtDate(iso);
}

export function num(n) {
  if (n === null || n === undefined || n === '') return '—';
  return Number(n).toLocaleString();
}

/** Build a score meter node (value 0..1). */
export function meter(value) {
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  const cls = v >= 0.7 ? 'high' : v >= 0.4 ? 'med' : 'low';
  const bar = h('span', { style: { width: `${(v * 100).toFixed(0)}%` } });
  return h('div', { class: `kbx-meter ${cls}` }, bar);
}

/** Comma-split a free-text field into a clean list. */
export function splitList(text) {
  return String(text || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Copy text to clipboard with a graceful fallback + toast. */
export async function copy(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, 'success');
  } catch {
    const ta = h('textarea', {}, text);
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); toast(label, 'success'); }
    catch { toast('Copy failed', 'error'); }
    ta.remove();
  }
}

/** Debounce a function. */
export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
