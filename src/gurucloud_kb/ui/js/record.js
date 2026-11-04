/* Bridge to the host page's user-action recorder (static/js/guru-recorder.js
   on the hosted app, kanban 812c0da2). Controls name themselves with
   data-action and the recorder's delegated listeners record their clicks and
   changes; this is for the one action the DOM cannot see — a search run from
   the keyboard (Enter) — so it lands with the same shape as a clicked one.
   The SDK server and the platform /ui host load no recorder: a no-op there. */

export function recordAction(name, opts) {
  const rec = typeof window !== 'undefined' ? window.GuruRecorder : null;
  if (!rec || typeof rec.record !== 'function') return null;
  if (typeof rec.current === 'function' && !rec.current()) return null;
  return rec.record(name, opts || {});
}
