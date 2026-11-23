// Bridges side by side need room for their barriers. OSM sometimes draws two carriageways of a viaduct closer, centre line to centre
// line, than they're wide (the Western Distributor's two at Pyrmont, 11.5 m apart where each is 14.7 m wide), and tools/build-heights.mjs
// gives each its own height, as it doesn't stack roads that only run beside each other: then one deck's lanes run under the edge of the
// other's, a metre or three lower, and its barrier stands in them. This moves each deck sideways, away from any deck of another structure
// whose carriageway overlaps its own alongside, more than one surface's 1.5 m and less than a stacked road's room above or below it
// (js/surfaces.js DECK_DEPTH and a truck), till their barriers are a wall's width apart. Each moves half the way, 3 m at most. Two decks
// crossing aren't side by side, and the Harbour Bridge's structure is left as it is. Decks of one structure are moved apart too where
// they aren't joined within JOIN m along the decks (the Western Distributor's ramps beside its viaduct at Darling Harbour, which join it
// further on): nearer their join, a ramp is meant to come together with the road it joins, and is left to the heights.
//
// What moves is every point of a deck inside it: the points along its links, and the nodes where only bridge links meet. A structure's
// ends stay where they are, a node where it meets a road on the ground, and so does the first stretch in from each, so nothing on the
// ground moves; no deck moves nearer a road on the ground beside it that its carriageway already reaches, nor into a building standing
// up into it. Heights stay as they are. Run by tools/build-tiles.mjs on the generated map before it's cut into tiles, after
// tools/tiles/separate-tubes.mjs, which does the same for tunnels.
const KIND_BRIDGE = 1;
const KIND_CUTTING = 3;
const DECK_DEPTH = 1.4; // js/surfaces.js
const TRUCK = 4.3; // m under a deck, over a road (tools/check-layers.mjs)
const WALL = 0.6; // m between two decks' barriers
const SAME = 1.5; // m: two decks closer in height than this are one surface where they overlap (js/surfaces.js, tools/check-layers.mjs)
const EASE = 60; // m over which a move eases in and out
const KEEP_ENDS = 40; // m in from a structure's end that doesn't move
const ALONGSIDE = 0.87; // cos of the angle under which two decks run side by side: about 30 degrees
const MOST = 3; // m a deck moves at most: where one side can't move, the other doesn't go on alone
const JOIN = 80; // m along the decks within which two decks of one structure are joined, and left to come together
const half = (l) => l[3] / 2 + 0.6; // to the barrier: js/surfaces.js linkFromRecord()

/** Each bridge link's structure, as tools/build-tiles.mjs works them out for bridges: bridge links joined where they share a node */
function structureOf(links) {
  const parent = new Map();
  const find = (n) => {
    while (parent.get(n) !== n) n = parent.get(n);
    return n;
  };
  const deck = (l) => l[9] === KIND_BRIDGE && l[12];
  for (const l of links) {
    if (!deck(l)) continue;
    for (const n of [l[0], l[1]]) if (!parent.has(n)) parent.set(n, n);
    parent.set(find(l[0]), find(l[1]));
  }
  return (l) => find(l[0]);
}

/**
 * Moves decks apart in place, in `RG` ({ nodes, links }). `building(x, z, y)`: whether a building stands up into a deck at that height
 * there, which no deck is moved into. Returns { links, before, after }: metres of deck overlapping another alongside
 */
function separateDecks(RG, { iterations = 14, building = () => false } = {}) {
  const N = RG.nodes;
  const structure = structureOf(RG.links);
  const isDeck = (l) => l[9] === KIND_BRIDGE && l[12] && l[12].length === l[6].length / 2 + 2;
  // The Harbour Bridge's structure: its deck's links (l[8]) and every ramp joining it, drawn by js/harbour-bridge.js to its own plan
  const harbourBridge = new Set(RG.links.filter((l) => isDeck(l) && l[8]).map(structure));
  const nodes = new Map();
  const linksAt = new Map();
  for (const l of RG.links) for (const n of [l[0], l[1]]) (linksAt.get(n) || linksAt.set(n, []).get(n)).push(l);
  const decks = [];
  for (const l of RG.links) {
    if (!isDeck(l) || harbourBridge.has(structure(l))) continue;
    const vertex = (n, y) => {
      if (!nodes.has(n)) {
        const at = linksAt.get(n);
        // An end: the structure ends, or meets a road that isn't a bridge
        nodes.set(n, { id: n, x: N[n * 2], z: N[n * 2 + 1], y, end: at.length < 2 || at.some((o) => !isDeck(o)), node: true });
      }
      return nodes.get(n);
    };
    const pts = [vertex(l[0], l[12][0])];
    for (let k = 0; k < l[6].length; k += 2) pts.push({ x: l[6][k], z: l[6][k + 1], y: l[12][k / 2 + 1] });
    pts.push(vertex(l[1], l[12][l[12].length - 1]));
    decks.push({ l, pts, half: half(l), group: structure(l) });
  }
  // How far each vertex is from the nearest end, along the decks
  const lengthOf = (t) => t.pts.reduce((sum, p, i) => (i ? sum + Math.hypot(p.x - t.pts[i - 1].x, p.z - t.pts[i - 1].z) : 0), 0);
  for (const t of decks) t.length = lengthOf(t);
  const fromEnd = new Map([...nodes.values()].map((n) => [n, n.end ? 0 : Infinity]));
  for (let changed = true; changed;) {
    changed = false;
    for (const t of decks) {
      const a = t.pts[0], b = t.pts[t.pts.length - 1];
      if (fromEnd.get(a) + t.length < fromEnd.get(b)) { fromEnd.set(b, fromEnd.get(a) + t.length); changed = true; }
      if (fromEnd.get(b) + t.length < fromEnd.get(a)) { fromEnd.set(a, fromEnd.get(b) + t.length); changed = true; }
    }
  }
  // Each deck's neighbours in its own structure: the decks joined to it within JOIN m along the decks, from either of its ends
  const decksAt = new Map();
  for (const t of decks) for (const p of [t.pts[0], t.pts[t.pts.length - 1]]) (decksAt.get(p) || decksAt.set(p, []).get(p)).push(t);
  for (const t of decks) {
    t.near = new Set([t]);
    const dist = new Map([[t.pts[0], 0], [t.pts[t.pts.length - 1], 0]]);
    const queue = [t.pts[0], t.pts[t.pts.length - 1]];
    while (queue.length) {
      queue.sort((a, b) => dist.get(a) - dist.get(b));
      const n = queue.shift();
      for (const u of decksAt.get(n) || []) {
        if (u.group !== t.group) continue;
        t.near.add(u);
        const other = u.pts[0] === n ? u.pts[u.pts.length - 1] : u.pts[0];
        const d = dist.get(n) + u.length;
        if (d < JOIN && !(dist.get(other) <= d)) {
          dist.set(other, d);
          queue.push(other);
        }
      }
    }
  }
  // Every vertex that can move, with how much it may: none at an end, all of it from KEEP_ENDS + EASE in
  const movable = new Map();
  for (const t of decks) {
    let s = 0;
    t.pts.forEach((p, i) => {
      if (i) s += Math.hypot(p.x - t.pts[i - 1].x, p.z - t.pts[i - 1].z);
      const d = p.node ? fromEnd.get(p) : Math.min(fromEnd.get(t.pts[0]) + s, fromEnd.get(t.pts[t.pts.length - 1]) + t.length - s);
      const share = Math.max(0, Math.min(1, (d - KEEP_ENDS) / EASE));
      if (share > 0) movable.set(p, { share, group: t.group, t });
    });
  }

  const G = 25, key = (x, z) => Math.floor(x / G) * 100000 + Math.floor(z / G);
  function index() {
    const cells = new Map();
    for (const t of decks) {
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
  // The push point p of deck t (running along ux, uz) wants, as a vector: away from the nearest deck of another structure, or of its own
  // not joined to it within JOIN m, crowding it alongside, by half of what's missing
  // Only where their carriageways overlap (`overlap`, the first time round), so decks merely close together stay where they are;
  // then on till their barriers are a wall apart
  const pushAt = (cells, t, p, ux, uz, overlap = false) => {
    let worst = null;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const [u, a, b] of cells.get(key(p.x + i * G, p.z + j * G)) || []) {
          if (t.near.has(u)) continue;
          const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1, L = Math.sqrt(L2);
          if (Math.abs((dx * ux + dz * uz) / L) < ALONGSIDE) continue; // crossing, not alongside
          const f = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / L2));
          const qx = a.x + dx * f, qz = a.z + dz * f, qy = a.y + (b.y - a.y) * f;
          // One over the other with a truck's room, or at one level, drawn as one road (js/surfaces.js SAME_LEVEL): neither is crowded
          if (Math.abs(qy - p.y) >= DECK_DEPTH + TRUCK || Math.abs(qy - p.y) <= SAME) continue;
          const d = Math.hypot(p.x - qx, p.z - qz);
          const into = t.half + u.half + WALL - d;
          if (into <= 0 || (overlap && d >= (t.l[3] + u.l[3]) / 2) || (worst && into <= worst.into)) continue;
          // Right on top of one another: across this deck, one way for one structure and the other way for the other
          let ax = (p.x - qx) / d, az = (p.z - qz) / d;
          if (!(d > 0.01)) {
            const side = t.group < u.group ? 1 : -1;
            ax = (-dz / L) * side;
            az = (dx / L) * side;
          }
          worst = { into, ax, az, same: u.group === t.group };
        }
      }
    }
    return worst && { x: worst.ax * (worst.into / 2 + 0.05), z: worst.az * (worst.into / 2 + 0.05), same: worst.same };
  };
  // A vertex's direction along its deck
  const dirAt = (t, i) => {
    const a = t.pts[Math.max(i - 1, 0)], b = t.pts[Math.min(i + 1, t.pts.length - 1)], L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return [(b.x - a.x) / L, (b.z - a.z) / L];
  };
  const overlapping = () => {
    const cells = index();
    let metres = 0;
    for (const t of decks) {
      for (let i = 1; i < t.pts.length; i++) {
        const a = t.pts[i - 1], b = t.pts[i], L = Math.hypot(b.x - a.x, b.z - a.z);
        if (L < 1e-6) continue;
        // Every 2 m, so a long link's middle counts as much as its points
        for (let d = 1; d < L; d += 2) {
          const p = { x: a.x + ((b.x - a.x) * d) / L, z: a.z + ((b.z - a.z) * d) / L, y: a.y + ((b.y - a.y) * d) / L };
          if (pushAt(cells, t, p, (b.x - a.x) / L, (b.z - a.z) / L, true)) metres += Math.min(2, L - d + 1);
        }
      }
    }
    return Math.round(metres);
  };

  // Roads on the ground (streets and cuttings) beside the decks: a deck never moves nearer one whose carriageway its own reaches, so it
  // isn't pushed out over a street under it (Bank St under the Western Distributor at Pyrmont); the deck beside it moves the rest
  const groundCells = new Map();
  for (const l of RG.links) {
    if (l[9] && l[9] !== KIND_CUTTING) continue;
    const pts = [[N[l[0] * 2], N[l[0] * 2 + 1]]];
    for (let k = 0; k < l[6].length; k += 2) pts.push([l[6][k], l[6][k + 1]]);
    pts.push([N[l[1] * 2], N[l[1] * 2 + 1]]);
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (G / 2)));
      const seen = new Set();
      for (let k = 0; k <= steps; k++) {
        const c = key(ax + ((bx - ax) * k) / steps, az + ((bz - az) * k) / steps);
        if (seen.has(c)) continue;
        seen.add(c);
        (groundCells.get(c) || groundCells.set(c, []).get(c)).push([l[3] / 2, ax, az, bx, bz]);
      }
    }
  }
  const towardGround = (p, half, dx, dz, ux, uz) => {
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const [w, ax, az, bx, bz] of groundCells.get(key(p.x + i * G, p.z + j * G)) || []) {
          const sx = bx - ax, sz = bz - az, L2 = sx * sx + sz * sz || 1;
          if (Math.abs((sx * ux + sz * uz) / Math.sqrt(L2)) < ALONGSIDE) continue;
          const dist = (x, z) => {
            const f = Math.max(0, Math.min(1, ((x - ax) * sx + (z - az) * sz) / L2));
            return Math.hypot(ax + sx * f - x, az + sz * f - z);
          };
          const now = dist(p.x, p.z), then = dist(p.x + dx, p.z + dz);
          if (then < now && then < half + w) return true;
        }
      }
    }
    return false;
  };

  const before = overlapping();
  const moved = new Set();
  const involved = new Set();
  const start = new Map([...movable.keys()].map((p) => [p, [p.x, p.z]]));
  const placeOf = new Map(); // vertex -> [deck, index], for its direction
  for (const t of decks) t.pts.forEach((p, i) => { if (!placeOf.has(p)) placeOf.set(p, [t, i]); });
  for (let it = 0; it < iterations; it++) {
    const cells = index();
    // What each vertex wants, then spread over its neighbours of the same structure so the deck bends gently: away from a deck of its own
    // structure, only along the decks joined to it, as the other is pushed the other way
    const wants = [];
    for (const [p, m] of movable) {
      const [t, i] = placeOf.get(p);
      if (it && !involved.has(p)) continue;
      const v = pushAt(cells, m.t, p, ...dirAt(t, i), !it);
      if (v) wants.push({ p, v, group: m.group, t: m.t });
      if (v && !it) involved.add(p);
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
        if (w.group !== m.group || (w.v.same && !w.t.near.has(placeOf.get(p)[0]))) continue;
        const f = Math.max(0, 1 - Math.hypot(w.p.x - p.x, w.p.z - p.z) / EASE);
        const s = Math.hypot(w.v.x, w.v.z) * f;
        if (s > size) { size = s; best = { x: w.v.x * f, z: w.v.z * f }; }
      }
      if (!best) continue;
      const [t, i] = placeOf.get(p);
      let dx = best.x * m.share, dz = best.z * m.share;
      // No further than MOST from where it was
      const ox = p.x - start.get(p)[0], oz = p.z - start.get(p)[1];
      const far = Math.hypot(ox + dx, oz + dz);
      if (far > MOST) {
        const k = MOST / far;
        dx = (ox + dx) * k - ox;
        dz = (oz + dz) * k - oz;
      }
      const d = Math.hypot(dx, dz) || 1;
      if (d < 0.01) continue;
      if (towardGround(p, m.t.half, dx, dz, ...dirAt(t, i))) continue;
      // Nor into a building: its barrier's side, where it would be
      if (building(p.x + dx + (dx / d) * m.t.half, p.z + dz + (dz / d) * m.t.half, p.y)) continue;
      shifts.push([p, dx, dz, m.t]);
    }
    for (const [p, dx, dz, t] of shifts) {
      p.x += dx;
      p.z += dz;
      moved.add(t);
      if (p.node) for (const u of decks) if (u.pts[0] === p || u.pts[u.pts.length - 1] === p) moved.add(u);
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

export { separateDecks };
