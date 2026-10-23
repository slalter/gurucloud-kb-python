/* Shared 3D-graph plumbing for the Graph and Ask tabs (effectful: script
   loading, fetch). The picture logic stays in graph_model.js / ask_model.js. */

import { MAX_BANK_EDGES, edgePages, flyTarget } from './graph_model.js';

/** Node colour roles shared by both tabs (the Ask tab adds read / walk / cited). */
export const GRAPH_COLORS = Object.freeze({
  hit: '#5ee0c8', folded: '#f2b23a', neighbor: '#b7c4c6', ctx: '#8fa6aa', read: '#c792ea', walk: '#7fb3ff', cited: '#ffd166',
  bank: '#72a6ab', bankDim: '#2d4448', dust: '#3a5054', bg: '#0f1719', selected: '#ffffff',
});

let libPromise = null;

/** Load 3d-force-graph next to this module the first time a 3D tab opens. */
export function ensureForceGraph3D() {
  if (window.ForceGraph3D) return Promise.resolve();
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../vendor/3d-force-graph.min.js', import.meta.url).href;
      s.onload = () => (window.ForceGraph3D ? resolve() : reject(new Error('3d-force-graph did not register')));
      s.onerror = () => reject(new Error('could not load vendor/3d-force-graph.min.js'));
      document.head.appendChild(s);
    });
  }
  return libPromise;
}

/** Every entry-to-entry edge in the bank (GET /edge-stats, then GET /edges
    paged at the service cap), capped at `maxEdges`; the array carries
    `.total` (the bank's real count). */
export async function loadBankEdges(api, maxEdges = MAX_BANK_EDGES) {
  const stats = await api.edgeStats();
  const total = Number(stats && stats.total) || 0;
  const out = [];
  for (const page of edgePages(Math.min(total, maxEdges))) {
    const resp = await api.listEdges(page);
    out.push(...((resp && resp.edges) || []));
  }
  out.total = total;
  return out;
}

/** Fly the camera to a node along the direction it already looks from
    (no-op before the layout has placed it). */
export function flyTo(fg, n, dist = 110) {
  if (!fg || !n || n.x === undefined) return;
  fg.cameraPosition(flyTarget(n, fg.camera().position, dist), n, 700);
}

/** Fit the lit nodes when there are any, else everything. */
export function fitLit(fg) {
  if (!fg) return;
  const lit = fg.graphData().nodes.filter((n) => n.lit);
  if (lit.length) fg.zoomToFit(600, 80, (n) => n.lit); else fg.zoomToFit(600, 40);
}
