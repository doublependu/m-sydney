// Tunnels side by side need room for a wall between them. OSM often draws the two tubes of a tunnel a few metres apart, centre
// line to centre line, where each road is 8 m wide: then each tube's walls stand in the other's road, and as both are at the
// same height a car can drive from one into the other through them. This moves each tube sideways, away from any tube of
// another structure at about its height, till their roads are a wall's width apart. Each moves half the way.
//
// What moves is every point of a tunnel inside it: the points along its links, and the nodes where only tunnel links meet. A
// tunnel's mouths stay where they are, a node where it meets anything else, and so does the first stretch in from each, so
// nothing at the surface moves. Run by tools/build-tiles.mjs on the generated map before it's cut into tiles.
const KIND_TUNNEL = 2;
const KIND_CUTTING = 3;
const TUNNEL_HEIGHT = 5.6; // js/surfaces.js
const WALL = 0.6; // m between two tubes' roads
const EASE = 60; // m over which a move eases in and out
const KEEP_MOUTHS = 40; // m in from a mouth that doesn't move
const half = (l) => l[3] / 2 + 0.6; // to the wall: js/surfaces.js linkFromRecord()

/** The structure each off-ground link belongs to, as tools/build-tiles.mjs works them out: links joined where they share a node */
function structureOf(links) {
  const parent = new Map();
  const find = (n) => {
    while (parent.get(n) !== n) n = parent.get(n);
    return n;
  };
  const off = (l) => l[9] && l[9] !== KIND_CUTTING && l[12];
  for (const l of links) {
    if (!off(l)) continue;
    for (const n of [l[0], l[1]]) if (!parent.has(n)) parent.set(n, n);
    parent.set(find(l[0]), find(l[1]));
  }
  return (l) => find(l[0]);
}

/** Moves tubes apart in place, in `RG` ({ nodes, links }). Returns { links, before, after }: metres of tunnel overlapping another tube */
function separateTubes(RG, { iterations = 14 } = {}) {
  const N = RG.nodes;
  const structure = structureOf(RG.links);
  const isTube = (l) => l[9] === KIND_TUNNEL && l[12] && l[12].length === l[6].length / 2 + 2;
  // Each tunnel node, shared by every link through it: { id, x, z, y, links, mouth }
  const nodes = new Map();
  const linksAt = new Map();
  for (const l of RG.links) for (const n of [l[0], l[1]]) (linksAt.get(n) || linksAt.set(n, []).get(n)).push(l);
  const tubes = [];
  for (const l of RG.links) {
    if (!isTube(l)) continue;
    const vertex = (n, y) => {
      if (!nodes.has(n)) {
        const at = linksAt.get(n);
        // A mouth: the tunnel ends, or meets a road that isn't one
        nodes.set(n, { id: n, x: N[n * 2], z: N[n * 2 + 1], y, mouth: at.length < 2 || at.some((o) => !isTube(o)), node: true });
      }
      return nodes.get(n);
    };
    const pts = [vertex(l[0], l[12][0])];
    for (let k = 0; k < l[6].length; k += 2) pts.push({ x: l[6][k], z: l[6][k + 1], y: l[12][k / 2 + 1] });
    pts.push(vertex(l[1], l[12][l[12].length - 1]));
    tubes.push({ l, pts, half: half(l), group: structure(l) });
  }
  // How far each vertex is from the nearest mouth, along the tunnels
  const lengthOf = (t) => t.pts.reduce((sum, p, i) => (i ? sum + Math.hypot(p.x - t.pts[i - 1].x, p.z - t.pts[i - 1].z) : 0), 0);
  for (const t of tubes) t.length = lengthOf(t);
  const fromMouth = new Map([...nodes.values()].map((n) => [n, n.mouth ? 0 : Infinity]));
  for (let changed = true; changed;) {
    changed = false;
    for (const t of tubes) {
      const a = t.pts[0], b = t.pts[t.pts.length - 1];
      if (fromMouth.get(a) + t.length < fromMouth.get(b)) { fromMouth.set(b, fromMouth.get(a) + t.length); changed = true; }
      if (fromMouth.get(b) + t.length < fromMouth.get(a)) { fromMouth.set(a, fromMouth.get(b) + t.length); changed = true; }
    }
  }
  // Every vertex that can move, with how much it may: none at a mouth, all of it from KEEP_MOUTHS + EASE in
  const movable = new Map();
  for (const t of tubes) {
    let s = 0;
    t.pts.forEach((p, i) => {
      if (i) s += Math.hypot(p.x - t.pts[i - 1].x, p.z - t.pts[i - 1].z);
      const d = p.node ? fromMouth.get(p) : Math.min(fromMouth.get(t.pts[0]) + s, fromMouth.get(t.pts[t.pts.length - 1]) + t.length - s);
      const share = Math.max(0, Math.min(1, (d - KEEP_MOUTHS) / EASE));
      if (share > 0) movable.set(p, { share, group: t.group, t });
    });
  }

  const G = 25, key = (x, z) => Math.floor(x / G) * 100000 + Math.floor(z / G);
  function index() {
    const cells = new Map();
    for (const t of tubes) {
      for (let i = 1; i < t.pts.length; i++) {
        const a = t.pts[i - 1], b = t.pts[i];
        const seen = new Set();
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (G / 2)));
        for (let k = 0; k <= steps; k++) {
          const c = key(a.x + ((b.x - a.x) * k) / steps, a.z + ((b.z - a.z) * k) / steps);
          if (seen.has(c)) continue;
          seen.add(c);
          (cells.get(c) || cells.set(c, []).get(c)).push([t, a, b]);
        }
      }
    }
    return cells;
  }
  // The push point p of tube t wants, as a vector: away from the nearest tube of another structure crowding it, by half of what's missing
  const pushAt = (cells, t, p) => {
    let worst = null;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const [u, a, b] of cells.get(key(p.x + i * G, p.z + j * G)) || []) {
          if (u.group === t.group) continue;
          const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1;
          const f = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / L2));
          const qx = a.x + dx * f, qz = a.z + dz * f, qy = a.y + (b.y - a.y) * f;
          if (Math.abs(qy - p.y) >= TUNNEL_HEIGHT + 0.8) continue; // one over the other with a slab's room
          const d = Math.hypot(p.x - qx, p.z - qz);
          const into = t.half + u.half + WALL - d;
          if (into <= 0 || (worst && into <= worst.into)) continue;
          // Right on top of one another: across this tube, one way for one structure and the other way for the other
          let ax = (p.x - qx) / d, az = (p.z - qz) / d;
          if (!(d > 0.01)) {
            const L = Math.sqrt(L2);
            const side = t.group < u.group ? 1 : -1;
            ax = (-dz / L) * side;
            az = (dx / L) * side;
          }
          worst = { into, ax, az };
        }
      }
    }
    return worst && { x: worst.ax * (worst.into / 2 + 0.05), z: worst.az * (worst.into / 2 + 0.05) };
  };
  const overlapping = () => {
    const cells = index();
    let metres = 0;
    for (const t of tubes) {
      for (let i = 1; i < t.pts.length; i++) {
        const a = t.pts[i - 1], b = t.pts[i], L = Math.hypot(b.x - a.x, b.z - a.z);
        // Every 2 m, so a long link's middle counts as much as its points
        for (let d = 1; d < L; d += 2) if (pushAt(cells, t, { x: a.x + ((b.x - a.x) * d) / L, z: a.z + ((b.z - a.z) * d) / L, y: a.y + ((b.y - a.y) * d) / L })) metres += Math.min(2, L - d + 1);
      }
    }
    return Math.round(metres);
  };

  const before = overlapping();
  const moved = new Set();
  for (let it = 0; it < iterations; it++) {
    const cells = index();
    // What each vertex wants, then spread over its neighbours of the same structure so the tube bends gently
    const wants = [];
    for (const [p, m] of movable) {
      const v = pushAt(cells, m.t, p);
      if (v) wants.push({ p, v, group: m.group });
    }
    if (!wants.length) break;
    const near = new Map();
    for (const w of wants) {
      for (let i = -3; i <= 3; i++) {
        for (let j = -3; j <= 3; j++) {
          const k = key(w.p.x + i * G, w.p.z + j * G);
          (near.get(k) || near.set(k, []).get(k)).push(w);
        }
      }
    }
    const shifts = [];
    for (const [p, m] of movable) {
      let best = null, size = 0;
      for (const w of near.get(key(p.x, p.z)) || []) {
        if (w.group !== m.group) continue;
        const f = Math.max(0, 1 - Math.hypot(w.p.x - p.x, w.p.z - p.z) / EASE);
        const s = Math.hypot(w.v.x, w.v.z) * f;
        if (s > size) { size = s; best = { x: w.v.x * f, z: w.v.z * f }; }
      }
      if (best) shifts.push([p, best.x * m.share, best.z * m.share, m.t]);
    }
    for (const [p, dx, dz, t] of shifts) {
      p.x += dx;
      p.z += dz;
      moved.add(t);
      if (p.node) for (const u of tubes) if (u.pts[0] === p || u.pts[u.pts.length - 1] === p) moved.add(u);
    }
  }
  // Back into the records, at the generated map's tenth of a metre
  for (const n of nodes.values()) {
    N[n.id * 2] = Math.round(n.x * 10) / 10;
    N[n.id * 2 + 1] = Math.round(n.z * 10) / 10;
  }
  for (const t of moved) {
    const inner = [];
    for (let i = 1; i < t.pts.length - 1; i++) inner.push(Math.round(t.pts[i].x * 10) / 10, Math.round(t.pts[i].z * 10) / 10);
    t.l[6] = inner;
  }
  return { links: moved.size, before, after: overlapping() };
}

export { separateTubes };
