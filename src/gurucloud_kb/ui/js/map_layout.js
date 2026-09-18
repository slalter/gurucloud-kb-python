/* Map layout — pure geometry for the KB Map tab. No DOM, no Cytoscape.

   Turns one field's clustering result (the KB service's /cluster response) plus
   any fetched playbooks into a positioned model the renderer draws with a
   preset layout:

     • every cluster is a circle whose radius grows with its member count;
       circles are packed on a spiral so none overlap (deterministic, no
       physics, no randomness);
     • members sit inside their circle on a sunflower (phyllotaxis) spiral,
       nearest-to-centroid first, so the dense core of a cluster is literally at
       its centre and fringe entries drift outward;
     • playbooks are laid out as horizontal step chains in a column to the
       right of the cluster field, with a link from each step to the entry it
       cites when that entry is on the map.

   Exported for the renderer AND for the node test suite
   (tests/test_kb_map_layout.js), which pins the invariants: no cluster
   overlap, every member inside its circle, stable ordering, link resolution. */

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const CLUSTER_GAP = 44;        // min distance between cluster circle edges
const MEMBER_MIN_R = 5;
const MEMBER_MAX_R = 11;
const PLAYBOOK_COL_GAP = 180;  // gap between cluster field and playbook column
const PLAYBOOK_ROW_H = 96;
const STEP_GAP = 118;

export function clusterRadius(memberCount) {
  const n = Math.max(1, memberCount || 1);
  return Math.round(30 + 12.5 * Math.sqrt(n));
}

/** Map a centroid distance onto a node radius: closer = bigger. */
export function memberRadius(distance, maxDistance) {
  if (distance === null || distance === undefined || !isFinite(distance) || !maxDistance) return MEMBER_MAX_R - 2;
  const t = Math.max(0, Math.min(1, distance / maxDistance));
  return Math.round((MEMBER_MAX_R - (MEMBER_MAX_R - MEMBER_MIN_R) * t) * 10) / 10;
}

/** Sunflower positions for n points inside a circle of radius r (centre 0,0),
    index 0 at the centre. */
export function sunflower(n, r) {
  const pts = [];
  if (n <= 0) return pts;
  if (n === 1) return [{ x: 0, y: 0 }];
  const usable = Math.max(6, r - MEMBER_MAX_R - 6);
  for (let i = 0; i < n; i++) {
    const rho = usable * Math.sqrt((i + 0.5) / n);
    const theta = i * GOLDEN_ANGLE;
    pts.push({ x: Math.round(rho * Math.cos(theta) * 100) / 100, y: Math.round(rho * Math.sin(theta) * 100) / 100 });
  }
  return pts;
}

function overlaps(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  return d < a.r + b.r + CLUSTER_GAP;
}

/** Pack circles [{r}] on a spiral around the origin, largest first.
    Returns the same objects with x/y set. Deterministic. */
export function packCircles(circles) {
  const placed = [];
  const order = circles.slice().sort((a, b) => b.r - a.r || String(a.key).localeCompare(String(b.key)));
  order.forEach((c, idx) => {
    if (idx === 0) { c.x = 0; c.y = 0; placed.push(c); return; }
    let t = 0;
    const step = 0.35;
    const a = Math.max(24, c.r * 0.6);
    for (let guard = 0; guard < 20000; guard++) {
      const rho = a * Math.sqrt(t);
      const cand = { x: Math.round(rho * Math.cos(t)), y: Math.round(rho * Math.sin(t)), r: c.r };
      if (!placed.some((p) => overlaps(cand, p))) { c.x = cand.x; c.y = cand.y; placed.push(c); return; }
      t += step;
    }
    // Fallback (unreachable in practice): stack far below.
    c.x = 0; c.y = placed.reduce((m, p) => Math.max(m, p.y + p.r), 0) + c.r + CLUSTER_GAP; placed.push(c);
  });
  return circles;
}

function clusterTitle(c, index) {
  if (c.label) return c.label;
  if (c.key) return c.key;
  if (c.keywords && c.keywords.length) return c.keywords.slice(0, 3).join(' · ');
  return `Cluster ${index + 1}`;
}

/**
 * Build the positioned model.
 * @param {object} response  ClusteringResponse from the API
 * @param {object} opts      { field?: string, playbooks?: Playbook[] }
 */
export function buildMapModel(response, opts = {}) {
  const results = (response && response.results) || [];
  const fr = opts.field ? results.find((r) => r.field === opts.field) || results[0] : results[0];
  const model = {
    field: fr ? fr.field : null,
    method: fr ? fr.method : null,
    algorithm: fr ? fr.algorithm || null : null,
    stats: {
      clusterCount: fr ? fr.cluster_count : 0,
      clustered: fr ? fr.clustered_count : 0,
      noise: fr ? fr.noise_count : 0,
      silhouette: fr && fr.silhouette_score != null ? fr.silhouette_score : null,
      scope: response && response.scope ? response.scope : null,
      note: fr ? fr.note || null : null,
    },
    clusters: [],
    entries: [],
    playbooks: [],
    links: [],
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  };
  if (!fr) return model;

  const circles = (fr.clusters || []).map((c, i) => ({
    key: `c:${c.cluster_id}`,
    clusterId: c.cluster_id,
    title: clusterTitle(c, i),
    description: c.description || null,
    size: c.size,
    keywords: c.keywords || [],
    values: c.values || [],
    representativeIds: c.representative_entry_ids || [],
    fromNoise: !!c.from_noise,
    lowCohesion: !!c.low_cohesion,
    meanDistance: c.mean_member_distance != null ? c.mean_member_distance : null,
    members: (c.members || []).slice(),
    r: clusterRadius((c.members && c.members.length) || c.size),
    x: 0, y: 0,
  }));
  packCircles(circles);

  const entryIndex = new Map();
  circles.forEach((c) => {
    // nearest-to-centroid first; fuzzy members have no distance → keep order
    const members = c.members.slice().sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
    const maxD = members.reduce((m, x) => Math.max(m, x.distance || 0), 0);
    const pts = sunflower(members.length, c.r);
    members.forEach((m, i) => {
      const node = {
        id: m.id,
        clusterKey: c.key,
        x: Math.round((c.x + pts[i].x) * 100) / 100,
        y: Math.round((c.y + pts[i].y) * 100) / 100,
        r: memberRadius(m.distance, maxD),
        distance: m.distance ?? null,
        content: m.content || m.value || '',
        value: m.value || null,
      };
      model.entries.push(node);
      entryIndex.set(String(m.id), node);
    });
    model.clusters.push({
      key: c.key, clusterId: c.clusterId, title: c.title, description: c.description, size: c.size, keywords: c.keywords, values: c.values,
      representativeIds: c.representativeIds, fromNoise: c.fromNoise, lowCohesion: c.lowCohesion,
      meanDistance: c.meanDistance, x: c.x, y: c.y, r: c.r, memberCount: members.length,
    });
  });

  // bounds of the cluster field
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  circles.forEach((c) => { minX = Math.min(minX, c.x - c.r); minY = Math.min(minY, c.y - c.r); maxX = Math.max(maxX, c.x + c.r); maxY = Math.max(maxY, c.y + c.r); });
  if (!circles.length) { minX = minY = maxX = maxY = 0; }

  // playbooks as step chains in a column on the right
  const playbooks = (opts.playbooks || []).filter((p) => p && p.slug);
  if (playbooks.length) {
    const startX = maxX + PLAYBOOK_COL_GAP;
    const totalH = (playbooks.length - 1) * PLAYBOOK_ROW_H;
    const startY = Math.round((minY + maxY) / 2 - totalH / 2);
    playbooks.forEach((p, i) => {
      const y = startY + i * PLAYBOOK_ROW_H;
      const steps = (p.steps || []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      const pb = { slug: p.slug, title: p.title || p.slug, status: p.status || 'active', x: startX, y, steps: [] };
      steps.forEach((s, j) => {
        const sid = `${p.slug}#${s.position ?? j + 1}`;
        const stepNode = { id: sid, slug: p.slug, position: s.position ?? j + 1, title: s.title || `Step ${j + 1}`, x: startX + STEP_GAP * (j + 1), y, kbEntryId: s.kb_entry_id || null, linked: false };
        if (s.kb_entry_id && entryIndex.has(String(s.kb_entry_id))) {
          stepNode.linked = true;
          model.links.push({ stepId: sid, entryId: String(s.kb_entry_id) });
        }
        pb.steps.push(stepNode);
        maxX = Math.max(maxX, stepNode.x + 40);
      });
      maxX = Math.max(maxX, startX + 60);
      minY = Math.min(minY, y - 40); maxY = Math.max(maxY, y + 40);
      model.playbooks.push(pb);
    });
  }

  model.bounds = { minX, minY, maxX, maxY };
  return model;
}

/** Default request the Map tab sends. Exported so the UI and tests agree.
    Every member is requested (max_members_per_cluster = the scope size) so every
    entry can be drawn; cluster count is left to the service, which sizes
    clusters for nameability (target_cluster_size) rather than capping them. */
export function defaultClusterRequest(field, overrides = {}) {
  const req = Object.assign({
    fields: field ? [field] : undefined,
    algorithm: 'auto',
    min_cluster_size: 5,
    outlier_strategy: 'subcluster',
    peel_misfits: true,
    include_members: true,
    member_sample: 'nearest',
    label: false,
    scope_limit: 2000,
  }, overrides);
  if (req.max_members_per_cluster === undefined) req.max_members_per_cluster = req.scope_limit;
  return req;
}
