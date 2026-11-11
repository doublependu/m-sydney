// tools/check-layers.mjs: roads on more than one level, and what stands in them, without a browser. What tools/check-roads.mjs
// doesn't look at, every lane walked every 2 m at its middle and its outer lanes:
//   stacked   a road with another over it, the two overlapping, with less room between them than a car needs: 1.4 m of deck and
//             a 4.3 m truck under a bridge, 5.6 m under a road crossing a tunnel's open cutting, a tube and a slab (6.4 m) under
//             a road crossing a covered tunnel. Cars on one are drawn in the other's walls, barriers and lanes
//   ground    the ground (js/surfaces.js groundHeight()) drawn away from a road on it, a street or a road sunk into a cutting:
//             1.5-5.7 m over it, in the cars' way, or more than 1.5 m under it, leaving them in the air. Where two roads at
//             different heights overlap, the ground can only be at one of them. Over 5.7 m up it's a street crossing over
//   buildings a building in a lane on a structure or in a cutting: its body over the road and under 4.2 m of it, or its wall where
//             the lane crosses its outline, from the wall's foot (js/wall-foot.js) to its top. And one reaching up into the Harbour
//             Bridge's deck beyond its roads, under its railway, cycleway or footway
//   drawn     the road as js/structures.js draws it against the height a car is held at, along every lane of every tunnel and
//             bridge: a hole (nothing drawn within 1 m), or the road drawn over the wheels or under them by more than 10 cm
//   trees     a tree where the game stands it, in a lane on a structure or in a cutting: its trunk in the road, or its crown
//             across a bridge's height from beside it, or across any of the Harbour Bridge's deck
//   piers     a structure's pier in another road's lane
// usage: node tools/check-layers.mjs [--json] [--strict] [--list] [--tiles=0_-2,1_-2]
import fs from 'node:fs';
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
console.info = () => {};
const started = performance.now();
const THREE = await import('three/webgpu');
const { heldTiles, heldTrees } = await import('../js/geodata.js');
const { DECK_DEPTH, DECK_STRUCTURE, KIND, LINKS, STEP, TUNNEL_HEIGHT, groundHeight, roadHeight, tunnelCovered } = await import('../js/surfaces.js');
const { buildStructures } = await import('../js/structures.js');
const { DECK_REACH, bridgeAt, deckUndersideAt, onDeckSpan } = await import('../js/bridge.js');
const { crownRadius, roomOver, treeClear } = await import('../js/deck-room.js');
const { placeStreetTrees } = await import('../js/tree-placements.js');
// The gardens' plants: how tall each kind is at scale 1 (js/trees.js), and those too small to reach a road's height
const GARDEN_SIZE = { 6: 14, 7: 10, 8: 30, 9: 12, 10: 2, 11: 4, 12: 3, 13: 3, 14: 3, 15: 3, 16: 3, 17: 3 };
const SMALL_SPECIES = new Set([10, 12, 13, 14, 15, 16, 17]);
const { wallFootAt } = await import('../js/wall-foot.js');

const json = process.argv.includes('--json');
const strict = process.argv.includes('--strict');
const list = process.argv.includes('--list');
const tilesArg = process.argv.find((a) => a.startsWith('--tiles='))?.slice(8).split(',');
const tiles = tilesArg && new Set(tilesArg);
const wanted = (x, z) => !tiles || tiles.has(`${Math.floor(x / 1000)}_${Math.floor(z / 1000)}`);

const TRUCK = 4.3; // m: what has to fit under a deck, over a road
const CLEAR = 4.2; // m over a road that a building or a tree mustn't be in: a bus, and a little
const CUT_SAME = 1.5; // m: two roads overlapping on the ground nearer than this in height are one surface (js/surfaces.js)
const DRAWN_OFF = 0.1; // m the drawn road may be over or under the wheels
const GAP = 1; // m: no road drawn nearer than this to a car's height is a hole

// Measures of a place, as in tools/check-roads.mjs: only the largest near any one spot is kept, so a list names places
class Places {
  constructor() { this.all = []; this.metres = 0; }
  add(x, z, name, size = 1, metres = 1) { this.metres += metres; this.all.push([size, Math.round(x), Math.round(z), name]); }
  distinct(apart = 40) {
    const sorted = [...this.all].sort((a, b) => b[0] - a[0]);
    const cells = new Map(), kept = [];
    for (const w of sorted) {
      const ix = Math.floor(w[1] / apart), iz = Math.floor(w[2] / apart);
      let near = false;
      for (let a = -1; a <= 1 && !near; a++) {
        for (let b = -1; b <= 1 && !near; b++) near = (cells.get((ix + a) * 100000 + iz + b) || []).some((k) => Math.hypot(k[1] - w[1], k[2] - w[2]) < apart);
      }
      if (near) continue;
      const k = ix * 100000 + iz;
      (cells.get(k) || cells.set(k, []).get(k)).push(w);
      kept.push(w);
    }
    return kept;
  }
  summary() {
    const places = this.distinct();
    return { metres: Math.round(this.metres), places: places.length, worst: +(places[0]?.[0] ?? 0).toFixed(2), where: places.slice(0, list ? 25 : 5).map(([size, x, z, name]) => [+size.toFixed(2), x, z, name]) };
  }
}

// --- Every road's segments, by 25 m cell ---------------------------------------------------------------------------------
const C = 25;
const cellKey = (x, z) => Math.floor(x / C) * 100000 + Math.floor(z / C);
const putBox = (cells, x0, z0, x1, z1, v) => {
  for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++) {
    for (let j = Math.floor(z0 / C); j <= Math.floor(z1 / C); j++) {
      const k = i * 100000 + j;
      (cells.get(k) || cells.set(k, []).get(k)).push(v);
    }
  }
};
const roads = LINKS.filter((l) => l.cls !== 11); // not pedestrian streets
const segCells = new Map();
for (const l of roads) {
  let s0 = 0;
  for (let i = 1; i < l.pts.length; i++) {
    const a = l.pts[i - 1], b = l.pts[i], len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.01) continue;
    const seg = { l, a, b, len, s0 };
    putBox(segCells, Math.min(a.x, b.x) - l.half, Math.min(a.z, b.z) - l.half, Math.max(a.x, b.x) + l.half, Math.max(a.z, b.z) + l.half, seg);
    s0 += len;
  }
}
// A road's height where (x, z) is on it, t of the way along the segment: a structure's or a cutting's from its points, a street's by its
// own shape
const heightOn = (seg, t, x, z) => (seg.l.kind || seg.l.cut ? seg.a.y + (seg.b.y - seg.a.y) * t : roadHeight(seg.l, x, z));
// What a road is at s m along it, for the reports
const kindOf = (l, s) => (l.kind === KIND.TUNNEL ? (tunnelCovered(l, s) ? 'tunnel' : 'open tunnel') : l.kind === KIND.BRIDGE ? 'bridge' : l.cut ? 'cutting' : 'street');
const raised = (l) => !!(l.kind || l.cut); // on a structure, or sunk into a cutting

// Each lane of a road, as samples 2 m apart in order: { x, z, y, s }. With `edges`, also 0.3 m in from each edge of its carriageway,
// where a car can drive hard against the kerb or the barrier
function* lanesOf(l, step = 2, edges = false) {
  const off = l.width > 4.8 ? [0, -(l.width / 2 - 1.2), l.width / 2 - 1.2] : [0];
  if (edges) off.push(-(l.width / 2 - 0.3), l.width / 2 - 0.3);
  for (const o of off) {
    const lane = [];
    let s0 = 0;
    for (let i = 1; i < l.pts.length; i++) {
      const a = l.pts[i - 1], b = l.pts[i], len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 0.01) continue;
      const ux = (b.x - a.x) / len, uz = (b.z - a.z) / len;
      for (let d = (step - (s0 % step)) % step; d < len; d += step) {
        const x = a.x + ux * d - uz * o, z = a.z + uz * d + ux * o;
        const y = l.kind || l.cut ? a.y + ((b.y - a.y) * d) / len : roadHeight(l, x, z);
        lane.push({ x, z, y, s: s0 + d });
      }
      s0 += len;
    }
    yield { lane, share: step / off.length };
  }
}

const report = {};

// --- Stacked roads, and roads sharing the ground ------------------------------------------------------------------------------
{
  const stacked = new Places();
  const stackedPairs = new Map();
  for (const l of roads) {
    for (const { lane, share } of lanesOf(l)) {
      for (const p of lane) {
        if (!wanted(p.x, p.z) || !Number.isFinite(p.y)) continue;
        const kind = kindOf(l, p.s);
        for (const q of segCells.get(cellKey(p.x, p.z)) || []) {
          if (q.l === l) continue;
          const dx = q.b.x - q.a.x, dz = q.b.z - q.a.z;
          const t = Math.max(0, Math.min(1, ((p.x - q.a.x) * dx + (p.z - q.a.z) * dz) / (q.len * q.len)));
          const d = Math.hypot(q.a.x + dx * t - p.x, q.a.z + dz * t - p.z);
          if (d > q.l.half) continue;
          const y = heightOn(q, t, p.x, p.z);
          if (!Number.isFinite(y)) continue;
          const dy = y - p.y;
          if (dy <= CUT_SAME) continue; // the lower road of the two counts it
          const pair = l.id < q.l.id ? `${l.id}-${q.l.id}` : `${q.l.id}-${l.id}`;
          if (!l.kind && !q.l.kind) continue; // both on the ground: what the ground does there is "ground", below
          if (d > q.l.width / 2) continue; // stacked: the upper road's carriageway itself over this lane
          const need = q.l.kind === KIND.BRIDGE ? DECK_DEPTH + TRUCK : kind === 'tunnel' ? TUNNEL_HEIGHT + 0.8 : TUNNEL_HEIGHT;
          if (dy >= need) continue;
          const upper = kindOf(q.l, q.s0 + t * q.len);
          stacked.add(p.x, p.z, `${l.name || l.id} (${kind}) under ${q.l.name || q.l.id} (${upper})`, need - dy, share);
          const e = stackedPairs.get(pair) || { kinds: `${kind} under ${upper}`, metres: 0 };
          e.metres += share;
          stackedPairs.set(pair, e);
        }
      }
    }
  }
  const byKinds = {};
  for (const e of stackedPairs.values()) byKinds[e.kinds] = (byKinds[e.kinds] || 0) + 1;
  report.stacked = { pairs: stackedPairs.size, byKinds, ...stacked.summary() };
}

// --- The ground against the roads on it --------------------------------------------------------------------------------------
{
  const over = new Places(), under = new Places();
  for (const l of roads) {
    if (l.kind) continue;
    for (const { lane, share } of lanesOf(l, 2, true)) {
      for (const p of lane) {
        if (!wanted(p.x, p.z) || !Number.isFinite(p.y)) continue;
        const dy = groundHeight(p.x, p.z) - p.y;
        const name = `${l.name || l.id} (${l.cut ? 'cutting' : 'street'})`;
        if (dy > CUT_SAME && dy < DECK_DEPTH + TRUCK) over.add(p.x, p.z, name, dy, share);
        else if (dy < -CUT_SAME) under.add(p.x, p.z, name, -dy, share);
      }
    }
  }
  report.ground = { over: over.summary(), under: under.summary() };
}

// --- Buildings and trees in the lanes of structures and cuttings ----------------------------------------------------------------
const inRing = (ring, x, z) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) c = !c;
  }
  return c;
};
{
  const buildingCells = new Map();
  for (const b of heldTiles().flatMap((t) => t.buildings)) for (const p of b.polygons) putBox(buildingCells, b.minX, b.minZ, b.maxX, b.maxZ, { b, p });
  const insideOf = (x, z) => {
    const out = new Set();
    for (const { b, p } of buildingCells.get(cellKey(x, z)) || []) {
      if (inRing(p.outer, x, z) && !(p.holes || []).some((h) => inRing(h, x, z))) out.add(b);
    }
    return out;
  };
  const bodies = new Places(), walls = new Places();
  const touched = new Set(), byKind = {};
  for (const l of roads) {
    if (!raised(l)) continue;
    for (const { lane, share } of lanesOf(l)) {
      let was = new Set();
      for (const p of lane) {
        const now = insideOf(p.x, p.z);
        if (!wanted(p.x, p.z) || !Number.isFinite(p.y)) { was = now; continue; }
        const kind = kindOf(l, p.s);
        const name = `${l.name || l.id} (${kind})`;
        let hit = null;
        for (const b of now) {
          const bottom = b.floor + (b.bottom || 0), top = b.floor + b.height;
          // Over the road and under its clearance: the building's body is in the lane
          if (bottom < p.y + CLEAR && top > p.y + 0.3) { bodies.add(p.x, p.z, name, p.y + CLEAR - bottom, share); hit = b; break; }
        }
        // Into an outline or out of one: its wall, from its foot to its top
        if (!hit) {
          for (const b of [...now].filter((b) => !was.has(b)).concat([...was].filter((b) => !now.has(b)))) {
            const top = b.floor + b.height;
            const foot = b.bottom ? b.floor + b.bottom : Math.min(b.floor, wallFootAt(p.x, p.z, b.floor));
            if (foot < p.y + CLEAR && top > p.y + 0.3) { walls.add(p.x, p.z, name, p.y + CLEAR - foot, share); hit = b; break; }
          }
        }
        if (hit && !touched.has(hit)) { touched.add(hit); byKind[kind] = (byKind[kind] || 0) + 1; }
        was = now;
      }
    }
  }
  // Under the Harbour Bridge's deck beyond its roads, where its railway, cycleway and footway run: a building reaching up into it
  const deck = new Places();
  for (const b of heldTiles().flatMap((t) => t.buildings)) {
    if (!wanted(b.cx, b.cz) || !bridgeAt(b.cx, b.cz, DECK_REACH + Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ))) continue;
    let worst = null;
    for (let x = b.minX + 0.5; x < b.maxX; x += 1) {
      for (let z = b.minZ + 0.5; z < b.maxZ; z += 1) {
        const under = deckUndersideAt(x, z);
        if (under === null || !b.polygons.some((p) => inRing(p.outer, x, z))) continue;
        const by = b.floor + b.height - under;
        if (by > 0 && (!worst || by > worst.by)) worst = { x, z, by };
      }
    }
    if (worst) deck.add(worst.x, worst.z, 'Sydney Harbour Bridge (its deck)', worst.by);
  }
  report.buildings = { count: touched.size, byKind, body: bodies.summary(), wall: walls.summary(), deck: deck.summary() };

  // Trees where the game stands them (js/tree-placements.js, with js/street-details.js' test of what's over and beside them, but not its
  // street lights to keep clear of, so a few more than it draws): their trunks within a structure's or a cutting's road, or their crowns
  // across its height from beside it, or across the Harbour Bridge's deck, its railway and footway as well as its roads
  const trunks = new Places(), crowns = new Places();
  const tr = heldTrees();
  const sites = placeStreetTrees(tr.points, tr.kinds, tr.heights, [],
    (x, z, small = false, tall = 0) => roomOver(x, z, small ? 1 : 3) >= (small ? 3 : 12) && (small || treeClear(x, z, tall)));
  for (const site of sites) {
    const { x, z } = site;
    if (!wanted(x, z) || SMALL_SPECIES.has(site.species)) continue;
    const tall = (GARDEN_SIZE[site.species] || 13) * site.scale, base = groundHeight(x, z), crown = crownRadius(tall);
    const under = [[0, 0], [crown, 0], [-crown, 0], [0, crown], [0, -crown]].map(([dx, dz]) => deckUndersideAt(x + dx, z + dz)).find((u) => u !== null);
    if (under !== undefined && under + DECK_DEPTH > base + 0.5 && base + tall > under + DECK_DEPTH) {
      crowns.add(x, z, 'Sydney Harbour Bridge (its deck)', base + tall - under - DECK_DEPTH);
      continue;
    }
    for (const q of segCells.get(cellKey(x, z)) || []) {
      if (!raised(q.l)) continue;
      const dx = q.b.x - q.a.x, dz = q.b.z - q.a.z;
      const t = Math.max(0, Math.min(1, ((x - q.a.x) * dx + (z - q.a.z) * dz) / (q.len * q.len)));
      const d = Math.hypot(q.a.x + dx * t - x, q.a.z + dz * t - z);
      if (d > q.l.width / 2 + crown) continue;
      const y = q.a.y + (q.b.y - q.a.y) * t;
      if (q.l.kind === KIND.TUNNEL && tunnelCovered(q.l, q.s0 + t * q.len)) continue; // under the ground, out of reach
      const name = `${q.l.name || q.l.id} (${kindOf(q.l, q.s0 + t * q.len)})`;
      if (d <= q.l.width / 2 - 0.5) {
        if (base < y + CLEAR && base + tall > y + 0.3) { trunks.add(x, z, name, base + tall - y); break; }
      // Beside a bridge, its crown across the deck's height, under a truck's height over it. Beside a street, a tree's crown over it is
      // a street tree's, and so is one high over a deck
      } else if (d > q.l.width / 2 && q.l.kind === KIND.BRIDGE && base + 0.5 < y && base + tall > y && base + tall * 0.35 < y + TRUCK) {
        crowns.add(x, z, name, base + tall - y);
        break;
      }
    }
  }
  report.trees = { trunks: trunks.summary(), crowns: crowns.summary() };
}

// --- The structures as drawn: their road surfaces against the cars' height, and their piers -----------------------------------
{
  const roadMat = new THREE.MeshStandardNodeMaterial();
  const group = new THREE.Group();
  const job = buildStructures(group, roadMat);
  let step;
  do step = job.next(); while (!step.done);
  group.updateMatrixWorld(true);
  const T = 5, triCells = new Map(), piers = [];
  const v = new THREE.Vector3(), m = new THREE.Matrix4();
  for (const mesh of group.children) {
    if (mesh.isInstancedMesh) {
      // The piers: a unit cylinder scaled to each, from its foot up
      if (!mesh.geometry.parameters?.radiusTop) continue;
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        const e = m.elements;
        piers.push({ x: e[12], z: e[14], y0: e[13], y1: e[13] + e[5], r: e[0] });
      }
      continue;
    }
    if (!mesh.userData.road) continue; // the road's surface, open or under a tunnel's roof
    const P = mesh.geometry.attributes.position, I = mesh.geometry.index;
    const at = (k) => v.fromBufferAttribute(P, k).applyMatrix4(mesh.matrixWorld).toArray();
    for (let i = 0; i < I.count; i += 3) {
      const tri = [at(I.getX(i)), at(I.getX(i + 1)), at(I.getX(i + 2))];
      const x0 = Math.min(tri[0][0], tri[1][0], tri[2][0]), x1 = Math.max(tri[0][0], tri[1][0], tri[2][0]);
      const z0 = Math.min(tri[0][2], tri[1][2], tri[2][2]), z1 = Math.max(tri[0][2], tri[1][2], tri[2][2]);
      for (let ix = Math.floor(x0 / T); ix <= Math.floor(x1 / T); ix++) {
        for (let iz = Math.floor(z0 / T); iz <= Math.floor(z1 / T); iz++) {
          const k = ix * 100000 + iz;
          (triCells.get(k) || triCells.set(k, []).get(k)).push(tri);
        }
      }
    }
  }
  // Every height the drawn road has at (x, z)
  const drawnAt = (x, z) => {
    const out = [];
    for (const [A, B, Cc] of triCells.get(Math.floor(x / T) * 100000 + Math.floor(z / T)) || []) {
      const det = (B[2] - Cc[2]) * (A[0] - Cc[0]) + (Cc[0] - B[0]) * (A[2] - Cc[2]);
      if (Math.abs(det) < 1e-9) continue;
      const l1 = ((B[2] - Cc[2]) * (x - Cc[0]) + (Cc[0] - B[0]) * (z - Cc[2])) / det;
      const l2 = ((Cc[2] - A[2]) * (x - Cc[0]) + (A[0] - Cc[0]) * (z - Cc[2])) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      out.push(l1 * A[1] + l2 * B[1] + l3 * Cc[1]);
    }
    return out;
  };
  const holes = new Places(), over = new Places(), under = new Places();
  let walked = 0;
  for (const l of roads) {
    // The Harbour Bridge's own roads are drawn by js/harbour-bridge.js, and so is its deck where a ramp meets it
    if (!l.kind || l.deck) continue;
    // Not the last few metres at each end, where it meets the next road's surface
    const length = l.pts.reduce((s, p, i) => (i ? s + Math.hypot(p.x - l.pts[i - 1].x, p.z - l.pts[i - 1].z) : 0), 0);
    for (const { lane } of lanesOf(l, 1)) {
      for (const p of lane) {
        if (!wanted(p.x, p.z) || p.s < 3 || p.s > length - 3 || (l.sid === DECK_STRUCTURE || l.kind === KIND.BRIDGE) && onDeckSpan(p.x, p.z, 1)) continue;
        walked++;
        const name = `${l.name || l.id} (${kindOf(l, p.s)})`;
        const ys = drawnAt(p.x, p.z);
        let near = null;
        for (const y of ys) if (near === null || Math.abs(y - p.y) < Math.abs(near - p.y)) near = y;
        if (near === null || Math.abs(near - p.y) > GAP) holes.add(p.x, p.z, name);
        else if (near - p.y > DRAWN_OFF) over.add(p.x, p.z, name, near - p.y);
        else if (p.y - near > DRAWN_OFF) under.add(p.x, p.z, name, p.y - near);
      }
    }
  }
  report.drawn = { lanes: walked, holes: holes.summary(), over: over.summary(), under: under.summary() };

  // Piers in another road's lane, at that road's height
  const inLanes = new Places();
  for (const pier of piers) {
    if (!wanted(pier.x, pier.z)) continue;
    for (const q of segCells.get(cellKey(pier.x, pier.z)) || []) {
      const dx = q.b.x - q.a.x, dz = q.b.z - q.a.z;
      const t = Math.max(0, Math.min(1, ((pier.x - q.a.x) * dx + (pier.z - q.a.z) * dz) / (q.len * q.len)));
      const d = Math.hypot(q.a.x + dx * t - pier.x, q.a.z + dz * t - pier.z);
      if (d > q.l.width / 2 + pier.r) continue;
      const y = heightOn(q, t, pier.x, pier.z);
      // Its own deck is on top of it: a road whose lanes it stands in runs between its foot and its top
      if (!(y > pier.y0 + 0.5 && y + 0.3 < pier.y1 - 0.5)) continue;
      inLanes.add(pier.x, pier.z, q.l.name || `${q.l.id}`, q.l.width / 2 + pier.r - d);
      break;
    }
  }
  report.piers = { count: piers.length, ...inLanes.summary() };
}
report.seconds = +((performance.now() - started) / 1000).toFixed(1);

if (json) console.log(JSON.stringify(report, null, 1));
else {
  const r = report;
  const where = (o) => (o.where?.length ? `  ${o.where.map(([size, x, z, name]) => `${size} ${name || '-'} (${x}, ${z})`).join('; ')}` : '');
  console.log(`stacked   ${r.stacked.metres} m of lane under another road with too little room, ${r.stacked.pairs} pairs ${JSON.stringify(r.stacked.byKinds)}, worst ${r.stacked.worst} m short${where(r.stacked)}`);
  console.log(`ground    ${r.ground.over.metres} m of lane with the ground drawn 1.5-5.7 m over it${where(r.ground.over)}`);
  console.log(`          ${r.ground.under.metres} m with it drawn more than 1.5 m under it${where(r.ground.under)}`);
  console.log(`buildings ${r.buildings.count} in lanes on structures or in cuttings ${JSON.stringify(r.buildings.byKind)}`);
  console.log(`  body    ${r.buildings.body.metres} m of lane${where(r.buildings.body)}`);
  console.log(`  wall    ${r.buildings.wall.metres} m of lane${where(r.buildings.wall)}`);
  console.log(`  deck    ${r.buildings.deck.metres} up into the Harbour Bridge's deck beyond its roads${where(r.buildings.deck)}`);
  console.log(`drawn     ${r.drawn.lanes} m of tunnel and bridge lane walked`);
  console.log(`  holes   ${r.drawn.holes.metres} m with no road drawn within ${GAP} m of the wheels${where(r.drawn.holes)}`);
  console.log(`  over    ${r.drawn.over.metres} m with the road drawn over the wheels by more than ${DRAWN_OFF * 100} cm${where(r.drawn.over)}`);
  console.log(`  under   ${r.drawn.under.metres} m with the road drawn under the wheels by more than ${DRAWN_OFF * 100} cm${where(r.drawn.under)}`);
  console.log(`trees     ${r.trees.trunks.metres} in the road of a structure or a cutting${where(r.trees.trunks)}`);
  console.log(`          ${r.trees.crowns.metres} with their crown across one's height from beside it${where(r.trees.crowns)}`);
  console.log(`piers     ${r.piers.metres} of ${r.piers.count} in another road's lane${where(r.piers)}`);
  console.log(`          in ${r.seconds} s`);
}

// What's there now, on the part of the map npm run check holds (the CBD and around it, 80 km²), with a little room, so nothing gets worse.
// Before these faults were looked at: 3,194 m stacked, 100 m and 162 m of ground over and under, 14 buildings. Lower them as they're fixed.
// What's left stacked is mostly tunnels near their mouths at Woolloomooloo, and ramps beside each other where OSM draws them overlapping.
if (strict) {
  const r = report;
  const limits = [
    [r.stacked.metres, 2500, 'metres of lane under another road with too little room'],
    [r.ground.over.metres, 90, 'metres of lane with the ground drawn over it'],
    [r.ground.under.metres, 100, 'metres of lane with the ground drawn under it'],
    [r.buildings.count, 0, 'buildings in lanes on structures or in cuttings'],
    [r.buildings.deck.metres, 0, 'buildings up into the Harbour Bridge\'s deck'],
    [r.drawn.holes.metres, 20, 'metres of tunnel or bridge lane with no road drawn'],
    [r.drawn.over.metres, 10, 'metres of tunnel or bridge lane drawn over the wheels'],
    [r.trees.trunks.metres, 2, 'trees in a structure\'s or a cutting\'s road'],
    [r.trees.crowns.metres, 2, 'trees with their crown across a deck\'s height'],
    [r.piers.metres, 3, 'piers in another road\'s lane']
  ];
  let failed = false;
  for (const [value, limit, label] of limits) {
    if (value > limit) { console.error(`${label}: ${value}, limit ${limit}`); failed = true; }
  }
  if (failed) process.exit(1);
}
