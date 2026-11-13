// tools/check-roads.mjs: whether the roads drive well, without a browser: every lane of every road walked by the game's own
// rules in a few seconds. Instead of driving a road to find out if something stops you, this says what would.
//   lean      height across the road, edge to edge. Real streets fall 2-3%
//   grade     change of grade over 10 m + 10 m: crests and dips
//   step      height change in 1 m beyond the road's own grade: lips and ledges
//   roll      how much a car's roll changes in 1 m: side-to-side jolts
//   stops     no surface within reach: the car stops dead, for no reason you can see
//   buildings a building under the car
//   kerbs     a wheel on a kerb island, in a lane
//   paving    footpath or lawn at or over the road
//   turns     step, roll and stops on the curves through junctions
//   traffic   traffic's own lanes off the road, or over a kerb
//   tubes     covered tunnel inside another structure's tube: walls through the road, or one tube's floor in another
//   wet       covered tunnel the sea's sheet passes through, between its road and its ceiling: the game doesn't draw the sea
//             while the camera's in a tube (js/main.js), so this is where to look, not a fault
//   decks     buildings rising into a deck, and trees taller than the room under one
//   walls     a raised road's barrier or wall standing in another road's lane at its level, where the two run side by side
//   joins     roads drawn as one deck or one tunnel, driven across from one's lanes to the other's: where a car drops through to
//             the ground, or is stopped where nothing's drawn; medians, where a car drops through or gets past; and decks' starts,
//             a car driven on from the road on the ground near its kerbs, that never gets on or drops off beside it
//   under     a car driven in from the ground at every deck's sides, every 10 m, the Harbour Bridge's whole cross-section too: where it
//             ends on the ground inside the deck as drawn, with less room under it than a car needs; and a car placed inside one
//             (teleported, or a tile arriving round it), left there
// usage: node tools/check-roads.mjs [--json] [--strict] [--list] [--tiles=0_-2,1_-2]
console.info = () => {};
const { heldList, heldTiles } = await import('../js/geodata.js');
const { DECK_DEPTH, DECK_STRUCTURE, KIND, LINKS, ROOM, TUNNEL_HEIGHT, chooseSurface, clearOfWater, edgeNeighbour, groundHeight, groundRoadAt, laneAt, linkById, linkEdges, moveOver, onGroundRoad, roadHeight, tunnelCovered } = await import('../js/surfaces.js');
const { GroundCells, SIDEWALK_TOP, addSurface, groundLinks, wheelContacts } = await import('../js/ground-geometry.js');
const { CITY_BOUNDS, blockAt } = await import('../js/city-config.js');
const { buildRoadNetworkSteps } = await import('../js/road-network.js');
const { BRIDGE_LENGTH, bridgePoint, deckEdges, deckUndersideAt, onDeckSpan } = await import('../js/bridge.js');

const started = performance.now();
const json = process.argv.includes('--json');
const strict = process.argv.includes('--strict');
const list = process.argv.includes('--list');
const tilesArg = process.argv.find((a) => a.startsWith('--tiles='))?.slice(8).split(',');
const tiles = tilesArg && new Set(tilesArg);
const wanted = (x, z) => !tiles || tiles.has(`${Math.floor(x / 1000)}_${Math.floor(z / 1000)}`);

// Measures of a place: { at: [x, z], name, size }. Only the largest near any one spot is kept, so a list names places.
class Places {
  constructor() { this.all = []; this.metres = 0; }
  add(x, z, name, size = 1) { this.metres++; this.all.push([size, Math.round(x), Math.round(z), name]); }
  distinct(apart = 40) {
    const sorted = [...this.all].sort((a, b) => b[0] - a[0]);
    const cells = new Map(), kept = [];
    for (const w of sorted) {
      const ix = Math.floor(w[1] / apart), iz = Math.floor(w[2] / apart);
      let near = false;
      for (let a = -1; a <= 1 && !near; a++) {
        for (let b = -1; b <= 1 && !near; b++) {
          near = (cells.get((ix + a) * 100000 + iz + b) || []).some((k) => Math.hypot(k[1] - w[1], k[2] - w[2]) < apart);
        }
      }
      if (near) continue;
      const k = ix * 100000 + iz;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(w);
      kept.push(w);
    }
    return kept;
  }
  summary() {
    const places = this.distinct();
    return { metres: this.metres, places: places.length, worst: +(places[0]?.[0] ?? 0).toFixed(2), where: places.slice(0, list ? 25 : 5).map(([size, x, z, name]) => [+size.toFixed(2), x, z, name]) };
  }
}

// Stations along a polyline `step` apart: { x, z, s, ux, uz }
function stations(pts, step) {
  const out = [];
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 0.01) continue;
    const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
    for (let t = out.length ? (step - (s % step)) % step : 0; t < L; t += step) out.push({ x: a.x + ux * t, z: a.z + uz * t, s: s + t, ux, uz });
    s += L;
  }
  return { out, length: s };
}

const report = {};
// Per tile, for --by-tile
const byTile = process.argv.includes('--by-tile');
const TILE_LIMITS = { stops: 15, step: 25, buildings: 5, kerbs: 30 }; // m of lane, in a tile
function tileReport(out) {
  const tally = new Map();
  const count = (places, field, min = 0) => {
    for (const [size, x, z] of places.all) {
      if (size <= min) continue;
      const key = `${Math.floor(x / 1000)}_${Math.floor(z / 1000)}`;
      if (!tally.has(key)) tally.set(key, { stops: 0, step: 0, buildings: 0, kerbs: 0 });
      tally.get(key)[field]++;
    }
  };
  count(out.stops, 'stops');
  count(out.step, 'step', 0.25);
  count(out.buildings, 'buildings');
  count(out.kerbs, 'kerbs');
  const failing = [...tally].filter(([, t]) => Object.keys(TILE_LIMITS).some((k) => t[k] > TILE_LIMITS[k]));
  const all = tiles ? tiles.size : heldTiles().length;
  return { tiles: all, passing: all - failing.length, share: +((1 - failing.length / all) * 100).toFixed(1), failing: failing.map(([key, t]) => ({ key, ...t })) };
}

// --- The shape of each road ---------------------------------------------------------------------------------------------
{
  const lean = new Places(), grade = new Places();
  let leanM = 0, over4 = 0, over6 = 0, over10 = 0, gradeM = 0, kink3 = 0, kink6 = 0;
  for (const l of groundLinks()) {
    const half = l.width / 2;
    const trim = half + 6; // the ends belong to the junctions
    const { out: st, length } = stations(l.pts, 2);
    for (const q of st) {
      if (q.s < trim || q.s > length - trim || !wanted(q.x, q.z)) continue;
      const left = roadHeight(l, q.x + q.uz * half, q.z - q.ux * half), right = roadHeight(l, q.x - q.uz * half, q.z + q.ux * half);
      const pct = (Math.abs(left - right) / (2 * half)) * 100;
      leanM += 2;
      if (pct > 4) { over4 += 2; lean.add(q.x, q.z, l.name, pct); }
      if (pct > 6) over6 += 2;
      if (pct > 10) over10 += 2;
    }
    const { out: five } = stations(l.pts, 5);
    const ys = five.map((q) => roadHeight(l, q.x, q.z));
    for (let i = 2; i + 2 < five.length; i++) {
      const q = five[i];
      if (q.s < trim || q.s > length - trim || !wanted(q.x, q.z)) continue;
      const g1 = (ys[i] - ys[i - 2]) / (q.s - five[i - 2].s), g2 = (ys[i + 2] - ys[i]) / (five[i + 2].s - q.s);
      const pct = Math.abs(g2 - g1) * 100;
      gradeM += 5;
      if (pct > 3) { kink3 += 5; grade.add(q.x, q.z, l.name, pct); }
      if (pct > 6) kink6 += 5;
    }
  }
  report.lean = { km: +(leanM / 1000).toFixed(1), over4: +(over4 / leanM * 100).toFixed(2), over6: +(over6 / leanM * 100).toFixed(2), over10: +(over10 / leanM * 100).toFixed(2), ...lean.summary() };
  report.grade = { km: +(gradeM / 1000).toFixed(1), over3: +(kink3 / gradeM * 100).toFixed(2), over6: +(kink6 / gradeM * 100).toFixed(2), ...grade.summary() };
}

// --- Buildings, in 25 m cells ---------------------------------------------------------------------------------------------
const CELL = 25;
const buildingCells = new Map();
const inRing = (ring, x, z) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) c = !c;
  }
  return c;
};
for (const b of heldTiles().flatMap((t) => t.buildings)) {
  if ((b.bottom || 0) > 2) continue; // over the road, not in its way
  for (const p of b.polygons) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const q of p.outer) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); z0 = Math.min(z0, q.z); z1 = Math.max(z1, q.z); }
    for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++) {
      for (let iz = Math.floor(z0 / CELL); iz <= Math.floor(z1 / CELL); iz++) {
        const k = ix * 100000 + iz;
        if (!buildingCells.has(k)) buildingCells.set(k, []);
        buildingCells.get(k).push({ p, b });
      }
    }
  }
}
const buildingAt = (x, z) => (buildingCells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || [])
  .find(({ p }) => inRing(p.outer, x, z) && !(p.holes || []).some((h) => inRing(h, x, z)));

// --- Walking a path by the game's own rules ------------------------------------------------------------------------------
// A car's margin from what holds it, and the room it needs under a deck (js/controllers.js)
const CAR = 1.0, CAR_ROOM = ROOM?.car ?? 2.0;
const BODY = [[0.9, 2.2], [-0.9, 2.2], [0.9, -2.2], [-0.9, -2.2], [0, 0]];
const WHEELS = [[0.8, 1.4], [-0.8, 1.4], [0.8, -1.4], [-0.8, -1.4]];
function walk(path, sid0, y0, name, out) {
  if (tiles && !path.some((p) => wanted(p.x, p.z))) return;
  let sid = sid0, y = y0, prevRoll = null;
  const ys = [];
  for (const p of path) {
    if (!wanted(p.x, p.z)) {
      // On its way into the part being looked at, so it gets there on the right level
      const passing = chooseSurface(sid, y, p.x, p.z, CAR, CAR_ROOM);
      if (passing) { y = passing.y; sid = passing.sid; }
      ys.push(null);
      prevRoll = null;
      continue;
    }
    out.metres++;
    const here = chooseSurface(sid, y, p.x, p.z, CAR, CAR_ROOM);
    if (!here) { out.stops.add(p.x, p.z, name); ys.push(null); prevRoll = null; continue; }
    y = here.y; sid = here.sid;
    ys.push(y);
    if (sid) { prevRoll = null; continue; }
    if (!clearOfWater(p.x, p.z)) out.water.add(p.x, p.z, name);
    if (out.buildings) {
      for (const [a, b] of BODY) {
        const hit = buildingAt(p.x + p.ux * b + p.uz * a, p.z + p.uz * b - p.ux * a);
        if (hit) { out.buildings.add(p.x, p.z, name); out.touched.add(hit.b); break; }
      }
      if (blockAt(p.x, p.z)) out.kerbMiddle++;
      for (const [a, b] of WHEELS) {
        if (blockAt(p.x + p.ux * b + p.uz * a, p.z + p.uz * b - p.ux * a)) { out.kerbs.add(p.x, p.z, name); break; }
      }
    }
    const car = wheelContacts(p.x, p.z, Math.atan2(p.ux, p.uz), 0, y);
    const roll = Math.tan(car.roll) * 100;
    if (prevRoll !== null && Math.abs(roll - prevRoll) > out.rollLimit) out.roll.add(p.x, p.z, name, Math.abs(roll - prevRoll));
    prevRoll = roll;
  }
  // A step is a change in 1 m that the road's grade over the 11 m around it doesn't explain
  for (let i = 6; i + 5 < ys.length; i++) {
    const a = ys[i - 1], b = ys[i], c = ys[i - 6], d = ys[i + 5];
    if (a === null || b === null || c === null || d === null) continue;
    const step = Math.abs(b - a - (d - c) / 11);
    if (step > 0.05) out.step.add(path[i].x, path[i].z, name, step);
  }
}
const walker = (rollLimit) => ({ metres: 0, stops: new Places(), water: new Places(), step: new Places(), roll: new Places(), rollLimit, buildings: new Places(), kerbs: new Places(), kerbMiddle: 0, touched: new Set() });
const over = (places, limit) => places.all.filter((w) => w[0] > limit).length;
{
  const out = walker(2);
  for (const l of LINKS) {
    const half = l.width / 2;
    // The deck's roads by their own lanes: each is its own width now (plan 5), not one 23 m corridor
    const lanes = l.deck && l.lanes > 1 ? Array.from({ length: l.lanes }, (_, i) => -half + ((i + 0.5) * l.width) / l.lanes)
      : l.width > 7 ? [-(half - 1.8), 0, half - 1.8] : [0];
    for (const off of lanes) {
      const path = [];
      const { out: st } = stations(l.pts, 1);
      for (const q of st) path.push({ x: q.x + q.uz * off, z: q.z - q.ux * off, ux: q.ux, uz: q.uz });
      if (!path.length) continue;
      const a = l.pts[0];
      walk(path, l.sid || 0, l.kind ? a.y : roadHeight(l, path[0].x, path[0].z), l.name, out);
    }
  }
  if (byTile) report.byTile = tileReport(out);
  report.lanes = {
    km: +(out.metres / 1000).toFixed(0),
    stops: out.stops.summary(),
    water: out.water.summary(),
    step: { over5cm: over(out.step, 0.05), over25cm: over(out.step, 0.25), ...out.step.summary() },
    roll: { over2: over(out.roll, 2), over4: over(out.roll, 4), ...out.roll.summary() },
    buildings: { touched: out.touched.size, ...out.buildings.summary() },
    kerbs: { middle: out.kerbMiddle, ...out.kerbs.summary() }
  };
}

// --- Footpath and lawn over the road, as drawn -----------------------------------------------------------------------------
{
  const surfaces = new Map();
  const addCells = (cells, kind) => {
    for (const c of cells.cells.values()) {
      const P = c.position;
      for (let i = 0; i < c.index.length; i += 3) {
        const v = (k) => [P[c.index[i + k] * 3], P[c.index[i + k] * 3 + 1], P[c.index[i + k] * 3 + 2]];
        const A = v(0), B = v(1), C = v(2);
        for (let ix = Math.floor(Math.min(A[0], B[0], C[0]) / CELL); ix <= Math.floor(Math.max(A[0], B[0], C[0]) / CELL); ix++) {
          for (let iz = Math.floor(Math.min(A[2], B[2], C[2]) / CELL); iz <= Math.floor(Math.max(A[2], B[2], C[2]) / CELL); iz++) {
            const k = ix * 100000 + iz;
            if (!surfaces.has(k)) surfaces.set(k, []);
            surfaces.get(k).push([A, B, C, kind]);
          }
        }
      }
    }
  };
  for (const t of heldTiles()) {
    const pav = new GroundCells(1e6), lawn = new GroundCells(1e6);
    for (const rings of t.placedPavements) addSurface(pav, rings, SIDEWALK_TOP);
    for (const rings of t.placedLawns) addSurface(lawn, rings, SIDEWALK_TOP + 0.02);
    addCells(pav, 'paving');
    addCells(lawn, 'lawn');
  }
  const topAt = (x, z) => {
    let best = -Infinity;
    for (const [A, B, C] of surfaces.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || []) {
      const d = (B[2] - C[2]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[2] - C[2]);
      if (Math.abs(d) < 1e-9) continue;
      const l1 = ((B[2] - C[2]) * (x - C[0]) + (C[0] - B[0]) * (z - C[2])) / d;
      const l2 = ((C[2] - A[2]) * (x - C[0]) + (A[0] - C[0]) * (z - C[2])) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      best = Math.max(best, l1 * A[1] + l2 * B[1] + l3 * C[1]);
    }
    return best;
  };
  const centre = new Places();
  let area = 0, covered = 0, rampArea = 0, rampCovered = 0;
  for (const l of LINKS) {
    if (l.kind === 2) continue; // under the ground, the ground is meant to be over it
    const half = l.width / 2 - 0.4;
    const n = Math.max(1, Math.round((half * 2) / 1.5));
    const cell = 2 * ((2 * half) / (n + 1));
    for (let i = 1; i < l.pts.length; i++) {
      const a = l.pts[i - 1], b = l.pts[i], L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 0.01) continue;
      const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
      for (let s = 1; s < L; s += 2) {
        const cx = a.x + ux * s, cz = a.z + uz * s;
        if (!wanted(cx, cz)) continue;
        for (let k = 0; k <= n; k++) {
          const off = -half + (2 * half * k) / n;
          const x = cx + uz * off, z = cz - ux * off;
          const y = l.kind ? a.y + ((b.y - a.y) * s) / L : roadHeight(l, x, z);
          area += cell;
          if (l.kind) rampArea += cell;
          const gap = topAt(x, z) - y;
          if (gap <= -0.05 || gap >= 6) continue; // under the road, or ground well over a road in a cutting's wall
          covered += cell;
          if (l.kind) rampCovered += cell;
          if (k === Math.round(n / 2)) centre.add(x, z, l.name, gap);
        }
      }
    }
  }
  report.paving = { areaShare: +(covered / area * 100).toFixed(2), rampShare: +(rampCovered / (rampArea || 1) * 100).toFixed(2), centreLine: centre.summary() };
}

// --- Through the junctions, and traffic's own lanes ---------------------------------------------------------------------------
{
  const job = buildRoadNetworkSteps([], []);
  let step;
  do step = job.next(); while (!step.done);
  const net = step.value;
  const out = { ...walker(4), buildings: null };
  const point = { x: 0, z: 0, dx: 0, dz: 0 };
  let total = 0, off = 0, kerb = 0;
  const offRoad = new Places();
  for (const e of net.edges) {
    for (let i = 0; i < e.lanes.length; i++) {
      if (!e.sid) {
        for (let s = 0; s < e.len; s += 1) {
          const x = e.sx + e.dx * s + e.rx * e.lanes[i], z = e.sz + e.dz * s + e.rz * e.lanes[i];
          if (!wanted(x, z)) continue;
          total++;
          if (!onGroundRoad(x, z)) { off++; offRoad.add(x, z, `link ${e.link}`); }
          if (blockAt(x, z)) kerb++;
        }
      }
      for (const m of e.moves) {
        const j = m.out[i];
        if (!(j >= 0 && j < m.to.lanes.length)) continue;
        const c = net.connector(e, i, m.to, j);
        const path = [];
        for (let s = 0; s < c.len; s += 1) {
          net.curvePoint(c, s, point);
          path.push({ x: point.x, z: point.z, ux: point.dx, uz: point.dz });
        }
        if (path.length < 2) continue;
        const link = linkById.get(e.link);
        if (e.sid || !link) continue; // a structure's own curves are the structure's, and it's solved as one
        walk(path, 0, roadHeight(link, path[0].x, path[0].z), `turn ${e.link}`, out);
      }
    }
  }
  report.turns = { km: +(out.metres / 1000).toFixed(0), stops: out.stops.summary(), step: { over25cm: over(out.step, 0.25), ...out.step.summary() }, roll: { over8: over(out.roll, 8), ...out.roll.summary() } };
  report.traffic = { km: +(total / 1000).toFixed(0), offRoad: +(off / total * 100).toFixed(2), overKerb: +(kerb / total * 100).toFixed(2), places: offRoad.summary().places, where: offRoad.summary().where };
}

// --- Tunnels and decks: what's inside a tube, and what stands under a deck ----------------------------------------------------
{
  const G = 20, key = (x, z) => Math.floor(x / G) * 100000 + Math.floor(z / G);
  const put = (cells, x, z, v) => { const k = key(x, z); (cells.get(k) || cells.set(k, []).get(k)).push(v); };
  // Every 2 m along each structure link: { x, z, y, link, covered }
  const along = (l, fn) => {
    let s0 = 0;
    for (let i = 1; i < l.pts.length; i++) {
      const p = l.pts[i - 1], q = l.pts[i], L = Math.hypot(q.x - p.x, q.z - p.z);
      if (L < 1e-6) continue;
      for (let d = 0; d < L; d += 2) fn(p.x + ((q.x - p.x) * d) / L, p.z + ((q.z - p.z) * d) / L, p.y + ((q.y - p.y) * d) / L, s0 + d, (q.x - p.x) / L, (q.z - p.z) / L);
      s0 += L;
    }
  };
  const tubes = new Places(), wet = new Places();
  const tubeCells = new Map(), tubeSamples = [];
  for (const l of LINKS) {
    if (l.kind !== KIND.TUNNEL) continue;
    along(l, (x, z, y, s) => {
      if (!tunnelCovered(l, s)) return;
      const smp = { x, z, y, l };
      tubeSamples.push(smp);
      put(tubeCells, x, z, smp);
    });
  }
  const water = CITY_BOUNDS.waterLevel;
  for (const a of tubeSamples) {
    if (!wanted(a.x, a.z)) continue;
    if (a.y < water && a.y + TUNNEL_HEIGHT > water) wet.add(a.x, a.z, a.l.name, water - a.y);
    let worst = 0;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const b of tubeCells.get(key(a.x + i * G, a.z + j * G)) || []) {
        if (b.l.sid === a.l.sid || Math.abs(b.y - a.y) > TUNNEL_HEIGHT + 0.8) continue;
        const into = a.l.half + b.l.half + 0.6 - Math.hypot(b.x - a.x, b.z - a.z);
        // Side by side, the walls need room. Stacked, a slab: either is enough
        const clear = Math.abs(b.y - a.y) >= TUNNEL_HEIGHT + 0.8;
        if (into > worst && !clear) worst = into;
      }
    }
    if (worst > 0) tubes.add(a.x, a.z, a.l.name, worst);
  }
  // Decks, but not the Harbour Bridge's own: samples 2 m apart along and across
  const deckCells = new Map();
  for (const l of LINKS) {
    if (l.kind !== KIND.BRIDGE || l.deck) continue;
    along(l, (x0, z0, y, s, ux, uz) => {
      for (let o = -l.half + 0.5; o <= l.half - 0.5; o += 2) put(deckCells, x0 - uz * o, z0 + ux * o, { x: x0 - uz * o, z: z0 + ux * o, y, l });
    });
  }
  const deckOver = (x, z, r) => {
    let low = null;
    for (const d of deckCells.get(key(x, z)) || []) if (Math.abs(d.x - x) < r && Math.abs(d.z - z) < r && (!low || d.y < low.y)) low = d;
    return low;
  };
  const intoDeck = new Places(), treesUnder = new Places();
  let buildingsInto = 0;
  for (const t of heldTiles()) {
    for (const b of t.buildings) {
      let hit = null;
      for (let ix = Math.floor(b.minX / G); ix <= Math.floor(b.maxX / G) && !hit; ix++) {
        for (let iz = Math.floor(b.minZ / G); iz <= Math.floor(b.maxZ / G) && !hit; iz++) {
          for (const d of deckCells.get(ix * 100000 + iz) || []) {
            if (d.x < b.minX || d.x > b.maxX || d.z < b.minZ || d.z > b.maxZ || !wanted(d.x, d.z)) continue;
            if (b.floor + b.height <= d.y - DECK_DEPTH || b.floor + (b.bottom || 0) >= d.y) continue;
            if (b.polygons.some((pg) => inRing(pg.outer, d.x, d.z) && !pg.holes.some((h) => inRing(h, d.x, d.z)))) { hit = d; break; }
          }
        }
      }
      if (hit) { buildingsInto++; intoDeck.add(hit.x, hit.z, hit.l.name, b.floor + b.height - (hit.y - DECK_DEPTH)); }
    }
    const tr = t.trees;
    for (let i = 0; i < tr.kinds.length; i++) {
      const x = tr.points[i * 2], z = tr.points[i * 2 + 1];
      if (!wanted(x, z)) continue;
      const d = deckOver(x, z, 2);
      if (!d) continue;
      const room = d.y - DECK_DEPTH - groundHeight(x, z), tall = tr.heights[i] || 8;
      if (tall > room) treesUnder.add(x, z, d.l.name, tall - room);
    }
  }
  report.tubes = { overlapping: tubes.metres * 2, wet: wet.metres * 2, overlap: tubes.summary(), water: wet.summary() };
  report.decks = { buildings: buildingsInto, trees: treesUnder.metres, into: intoDeck.summary(), under: treesUnder.summary() };
}

// --- Walls in the road: every 2 m along each side of each raised road, where js/structures.js draws its barrier or wall -----------
{
  const walls = new Places();
  let before = 0;
  for (const l of LINKS) {
    if (!l.kind || l.deck) continue;
    let s0 = 0;
    for (let i = 1; i < l.pts.length; i++) {
      const p = l.pts[i - 1], q = l.pts[i], L = Math.hypot(q.x - p.x, q.z - p.z);
      if (L < 1e-6) continue;
      const ux = (q.x - p.x) / L, uz = (q.z - p.z) / L;
      for (let d = 1; d < L; d += 2) {
        const x = p.x + ux * d, z = p.z + uz * d, y = p.y + ((q.y - p.y) * d) / L;
        // A covered tunnel's walls are its tube's: those are "tubes"
        if (!wanted(x, z) || (l.kind === KIND.TUNNEL && tunnelCovered(l, s0 + d))) continue;
        for (const side of [1, -1]) {
          const nx = -uz * side, nz = ux * side;
          const ex = x + nx * l.half, ez = z + nz * l.half;
          // The barrier's face, a little in from the deck's edge
          if (!laneAt(ex - nx * 0.3, ez - nz * 0.3, y, l)) continue;
          before++;
          const next = edgeNeighbour(l, ex, ez, nx, nz, y, ux, uz);
          if (!next) walls.add(ex, ez, l.name);
          // A median barrier, between roads carrying traffic opposite ways: in a lane only where the two overlap
          else if (next.opposite && next.gap < 0.5 && (!next.link.kind || l.id < next.link.id)) walls.add(ex, ez, `${l.name} (median)`);
        }
      }
      s0 += L;
    }
  }
  report.walls = { ...walls.summary(), metres: walls.metres * 2, everyEdge: before * 2 };
}
// --- Roads drawn as one, medians and decks' starts, driven by the game's own step (js/surfaces.js moveOver()) ------------------
{
  // The nearest point on a link's centre line to (x, z)
  const nearestOn = (link, x, z) => {
    let best = null;
    for (let i = 1; i < link.pts.length; i++) {
      const a = link.pts[i - 1], b = link.pts[i], dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
      const px = a.x + dx * t, pz = a.z + dz * t, d = Math.hypot(px - x, pz - z);
      if (!best || d < best.d) best = { x: px, z: pz, d };
    }
    return best;
  };
  // A car on `sid` at height y at (x, z), driven straight at (tx, tz) 0.1 m a step: where it ends, and the lowest it was on the ground
  // `past(x, z)`: whether the ground there counts
  const driveAt = (sid, y, x, z, tx, tz, limit = 400, past = () => true) => {
    let ground = Infinity, stopped = false;
    for (let i = 0; i < limit; i++) {
      const dx = tx - x, dz = tz - z, L = Math.hypot(dx, dz);
      if (L < 0.05) break;
      const m = moveOver(sid, y, x, z, x + (dx / L) * Math.min(0.1, L), z + (dz / L) * Math.min(0.1, L), CAR, CAR_ROOM);
      if (Math.hypot(m.x - x, m.z - z) < 0.002) { stopped = true; break; }
      ({ x, z, sid, y } = m);
      if (!sid && past(x, z)) ground = Math.min(ground, y);
    }
    return { x, z, sid, y, ground, stopped, left: Math.hypot(tx - x, tz - z) };
  };
  const drops = new Places(), stops = new Places(), medianDrops = new Places(), medianPast = new Places();
  let held = 0, medians = 0;
  // Every 2 m of each stretch between stations js/structures.js draws open to the road beside (js/surfaces.js linkEdges()), from the
  // road that draws what's between them: the gap filled across to a road going the same way, or a median
  for (const l of LINKS) {
    if (!l.kind || l.deck || !l.pts.some((p) => wanted(p.x, p.z))) continue;
    const E = linkEdges(l);
    for (const side of [1, -1]) {
      const one = E.sides.get(side);
      for (let j = 0; j + 1 < E.st.length; j++) {
        const a = one.open[j], b = one.open[j + 1];
        if (!a || !b) continue;
        const median = a.opposite && b.opposite;
        if ((!median && (a.opposite || b.opposite)) || !one.owns[j] || !one.owns[j + 1]) continue;
        const p = E.st[j], q = E.st[j + 1], L = q.s - p.s;
        if (L < 1e-6) continue;
        const ux = (q.x - p.x) / L, uz = (q.z - p.z) / L, nx = -uz * side, nz = ux * side;
        // Not where a nose at either end holds a car back
        const noses = [one.nose[j - 1]?.i === j ? 0 : null, one.nose[j + 1]?.i === j + 1 ? L : null].filter((v) => v !== null);
        for (let d = 1; d < L; d += 2) {
          if (noses.some((at) => Math.abs(d - at) < 1.3)) continue;
          const x = p.x + ux * d, z = p.z + uz * d, y = p.y + ((q.y - p.y) * d) / L;
          // Not on the Harbour Bridge's deck, which js/harbour-bridge.js draws
          if (!wanted(x, z) || (l.sid === DECK_STRUCTURE && onDeckSpan(x, z))) continue;
          const other = (d < L / 2 ? a : b).link;
          // From the middle of this one's nearer lanes to the other's centre line: not where the other takes in this one's edge,
          // with nothing to cross to
          const o = nearestOn(other, x + nx * l.half, z + nz * l.half), out = (o.x - x) * nx + (o.z - z) * nz;
          if (out < l.half) continue;
          // A median holds a car its margin from its face: none where that leaves this road no lane on its own side
          const face = median ? one.line[j][0] + ((one.line[j][1] - one.line[j][0]) * d) / L : Infinity;
          const from = Math.min(l.half * 0.5, 2, face - CAR - 0.2), to = Math.max(l.half + 0.5, out);
          if (from < 0) continue;
          const r = driveAt(l.sid, y, x + nx * from, z + nz * from, x + nx * to, z + nz * to);
          const name = `${l.name || '-'} | ${other.name || '-'}`;
          const low = Math.min(y, other.kind ? y : roadHeight(other, x + nx * to, z + nz * to)) - 0.3;
          if (median) {
            medians++;
            if (r.ground < low) medianDrops.add(x, z, name, y - r.ground);
            else if (r.left < 0.3) medianPast.add(x, z, name);
          } else if (r.ground < low) drops.add(x, z, name, y - r.ground);
          else if (r.left > 0.3) stops.add(x, z, name, r.left);
          else held++;
        }
      }
    }
  }
  // Decks' starts: where a road on the ground runs on onto a bridge, a car driven on near its kerbs and on its centre line
  const byNode = new Map();
  for (const l of LINKS) for (const n of [l.a, l.b]) (byNode.get(n) || byNode.set(n, []).get(n)).push(l);
  const along = (l, n) => { const P = l.a === n ? l.pts : [...l.pts].reverse(); const L = Math.hypot(P[1].x - P[0].x, P[1].z - P[0].z) || 1; return { x: P[0].x, z: P[0].z, y: P[0].y, ux: (P[1].x - P[0].x) / L, uz: (P[1].z - P[0].z) / L, L }; };
  const missed = new Places(), fell = new Places();
  let starts = 0;
  for (const l of LINKS) {
    if (l.kind !== KIND.BRIDGE || l.sid === DECK_STRUCTURE) continue;
    for (const n of [l.a, l.b]) {
      const on = byNode.get(n) || [];
      if (on.some((o) => o !== l && o.kind)) continue; // carries on from another of its structure
      const deck = along(l, n);
      if (!wanted(deck.x, deck.z) || deck.L < 6) continue;
      const road = on.filter((o) => !o.kind).map((o) => ({ o, a: along(o, n) })).find(({ a }) => -(a.ux * deck.ux + a.uz * deck.uz) > 0.9);
      if (!road) continue;
      starts++;
      const w = Math.min(road.o.width, l.width);
      for (const off of [0, w / 2 - 0.3, -(w / 2 - 0.3)]) {
        // 12 m back along the road on the ground to 6 m on along the deck, `off` m to the left
        const sx = deck.x - deck.ux * 12 - deck.uz * off, sz = deck.z - deck.uz * 12 + deck.ux * off;
        const ex = deck.x + deck.ux * 6 - deck.uz * off, ez = deck.z + deck.uz * 6 + deck.ux * off;
        // On the road that runs on onto it: not another road beside it, where it starts
        const g = roadHeight(road.o, sx, sz);
        const start = chooseSurface(0, g, sx, sz, CAR, CAR_ROOM);
        if (!start || start.sid || groundRoadAt(sx, sz, g) !== road.o) continue;
        // On the ground past the deck's start, more than a step down from it: dropped off beside it. Ending on the ground: never got on.
        // On another structure at its level, drawn as one with it, it got on
        const r = driveAt(start.sid, start.y, sx, sz, ex, ez, 300, (x, z) => (x - deck.x) * deck.ux + (z - deck.z) * deck.uz > 0);
        const name = `${road.o.name || '-'} -> ${l.name || '-'} (${off.toFixed(1)})`;
        if (r.ground < deck.y - 0.6) fell.add(deck.x, deck.z, name, deck.y - r.ground);
        else if (!r.sid) missed.add(deck.x, deck.z, name);
      }
    }
  }
  report.joins = {
    held: held * 2, drops: drops.summary(), stops: stops.summary(),
    medians: medians * 2, medianDrops: medianDrops.summary(), medianPast: medianPast.summary(),
    starts, startsMissed: missed.summary(), startsFell: fell.summary()
  };
}
// --- Under decks: a car driven in from the ground at their sides, and placed inside them ---------------------------------------------
{
  const SWITCH = 0.6; // m: within this of a deck's top, the ground meets it (js/surfaces.js)
  // On the ground at height y at (x, z), inside a deck as drawn whose top there is `top`: more than SWITCH under its top, with less room
  // under its underside than a car needs. A street on the ground under a deck too low for it is the map's data, not this: its carriageway
  // and kerbs, at its own level (js/surfaces.js groundRoadAt())
  const insideAt = (top, x, z, y) => top !== null && top - y > SWITCH && top - DECK_DEPTH - y < CAR_ROOM && !groundRoadAt(x, z, y);
  const inside = new Places(), stuck = new Places();
  let drives = 0, on = 0, held = 0, under = 0, skipped = 0, placed = 0;
  // From (x0, z0) 3 m outside a deck's side, straight in along (ux, uz) for `len` m. `topAt(x, z)`: the deck's top there, or null
  const driveIn = (x0, z0, ux, uz, len, topAt, name) => {
    let x = x0, z = z0, sid = 0, y = groundHeight(x0, z0);
    // Only from ground a car could be on: not on another structure, or inside one
    const start = chooseSurface(0, y, x, z, CAR, CAR_ROOM);
    if (!start || start.sid || start.x !== undefined) { skipped++; return; }
    y = start.y;
    drives++;
    const tx = x0 + ux * len, tz = z0 + uz * len;
    for (let i = 0; i < len * 10 + 20; i++) {
      const dx = tx - x, dz = tz - z, L = Math.hypot(dx, dz);
      if (L < 0.05) break;
      const m = moveOver(sid, y, x, z, x + (dx / L) * Math.min(0.1, L), z + (dz / L) * Math.min(0.1, L), CAR, CAR_ROOM);
      if (Math.hypot(m.x - x, m.z - z) < 0.002) { held++; return; }
      ({ x, z, sid, y } = m);
      if (sid) { on++; return; }
      if (insideAt(topAt(x, z), x, z, y)) { inside.add(x, z, name, topAt(x, z) - y); return; }
    }
    under++; // on under it with room, or beside it
  };
  // A car left on the ground inside a deck as drawn: the game's step from where it is to where it is, as each frame does, takes it out.
  // Not over the water, where nothing's ever on the ground (js/controllers.js keeps everything off it)
  const placeIn = (x, z, topAt, name) => {
    const y = groundHeight(x, z);
    if (!insideAt(topAt(x, z), x, z, y) || !clearOfWater(x, z)) return;
    placed++;
    const m = moveOver(0, y, x, z, x, z, CAR, CAR_ROOM);
    if (!m.sid && insideAt(topAt(m.x, m.z), m.x, m.z, m.y)) stuck.add(x, z, name, topAt(x, z) - y);
  };
  for (const l of LINKS) {
    if (l.kind !== KIND.BRIDGE || l.deck || !l.pts.some((p) => wanted(p.x, p.z))) continue;
    const P = l.pts;
    let acc = 0;
    for (let i = 1; i < P.length; i++) {
      const a = P[i - 1], b = P[i], L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 1e-6) continue;
      const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
      for (let s = (10 - (acc % 10)) % 10; s < L; s += 10) {
        const t = s / L, cx = a.x + (b.x - a.x) * t, cz = a.z + (b.z - a.z) * t, top = a.y + (b.y - a.y) * t;
        if (!wanted(cx, cz)) continue;
        // This stretch of the deck as drawn, its width a metre either way along but not past its segment's ends, and its height there
        const topAt = (x, z) => {
          const along = (x - cx) * ux + (z - cz) * uz;
          return Math.abs(-(x - cx) * uz + (z - cz) * ux) <= l.half && Math.abs(along) < 1 && s + along >= 0 && s + along <= L ? top + ((b.y - a.y) * along) / L : null;
        };
        for (const side of [1, -1]) {
          const nx = -uz * side, nz = ux * side;
          driveIn(cx + nx * (l.half + 3), cz + nz * (l.half + 3), -nx, -nz, l.half * 2 + 3, topAt, l.name || `link ${l.id}`);
          placeIn(cx + nx * l.half * 0.5, cz + nz * l.half * 0.5, topAt, l.name || `link ${l.id}`);
        }
      }
      acc += L;
    }
  }
  // The Harbour Bridge's whole cross-section: its railway, cycleway and footway as well as its roads
  const bridgeTop = (x, z) => { const u = deckUndersideAt(x, z); return u === null ? null : u + DECK_DEPTH; };
  for (let s = 5; s < BRIDGE_LENGTH; s += 10) {
    const p = bridgePoint(s), q = bridgePoint(s + 1), L = Math.hypot(q.x - p.x, q.z - p.z) || 1, ux = (q.x - p.x) / L, uz = (q.z - p.z) / L;
    if (!wanted(p.x, p.z)) continue;
    const e = deckEdges(s);
    // East is to the right of travel north: (-uz, ux)
    driveIn(p.x - uz * (e.west - 3), p.z + ux * (e.west - 3), -uz, ux, e.east - e.west + 3, bridgeTop, `Harbour Bridge ${s} m, west side`);
    driveIn(p.x - uz * (e.east + 3), p.z + ux * (e.east + 3), uz, -ux, e.east - e.west + 3, bridgeTop, `Harbour Bridge ${s} m, east side`);
    for (const off of [e.west + 2, (e.west + e.east) / 2, e.east - 2]) placeIn(p.x - uz * off, p.z + ux * off, bridgeTop, `Harbour Bridge ${s} m`);
  }
  report.under = { drives, on, held, under, skipped, inside: inside.summary(), placed, stuck: stuck.summary() };
}
report.seconds = +((performance.now() - started) / 1000).toFixed(1);

if (json) console.log(JSON.stringify(report, null, 1));
else {
  const r = report;
  const where = (o) => (o.where?.length ? `  ${o.where.map(([size, x, z, name]) => `${size} ${name || '-'} (${x}, ${z})`).join('; ')}` : '');
  console.log(`lean      ${r.lean.km} km: ${r.lean.over4}% over 4%, ${r.lean.over6}% over 6%, ${r.lean.over10}% over 10%, worst ${r.lean.worst}%`);
  console.log(`          ${where(r.lean)}`);
  console.log(`grade     ${r.grade.km} km: ${r.grade.over3}% change over 3%, ${r.grade.over6}% over 6%, worst ${r.grade.worst}%`);
  console.log(`          ${where(r.grade)}`);
  console.log(`stops     ${r.lanes.km} lane km: ${r.lanes.stops.metres} m at ${r.lanes.stops.places} places${where(r.lanes.stops)}`);
  console.log(`water     ${r.lanes.water.metres} m of lane the water test would stop a car on, at ${r.lanes.water.places} places${where(r.lanes.water)}`);
  console.log(`step      ${r.lanes.step.over5cm} m over 5 cm, ${r.lanes.step.over25cm} m over 25 cm, at ${r.lanes.step.places} places, worst ${r.lanes.step.worst} m${where(r.lanes.step)}`);
  console.log(`roll      ${r.lanes.roll.over2} m over 2% a metre, ${r.lanes.roll.over4} m over 4%, at ${r.lanes.roll.places} places, worst ${r.lanes.roll.worst}%${where(r.lanes.roll)}`);
  console.log(`buildings ${r.lanes.buildings.metres} m at ${r.lanes.buildings.places} places, ${r.lanes.buildings.touched} buildings${where(r.lanes.buildings)}`);
  console.log(`kerbs     ${r.lanes.kerbs.metres} m at ${r.lanes.kerbs.places} places, the car's middle on one for ${r.lanes.kerbs.middle} m${where(r.lanes.kerbs)}`);
  console.log(`paving    ${r.paving.areaShare}% of road area, ${r.paving.rampShare}% of ramps and bridges, centre line ${r.paving.centreLine.metres * 2} m at ${r.paving.centreLine.places} places, worst ${r.paving.centreLine.worst} m${where(r.paving.centreLine)}`);
  console.log(`turns     ${r.turns.km} km: stops ${r.turns.stops.metres} m at ${r.turns.stops.places} places, ${r.turns.step.over25cm} m step over 25 cm, ${r.turns.roll.over8} m roll over 8% a metre, worst ${r.turns.roll.worst}%`);
  console.log(`traffic   ${r.traffic.km} lane km: ${r.traffic.offRoad}% off every carriageway, ${r.traffic.overKerb}% over a kerb island`);
  console.log(`tubes     ${r.tubes.overlapping} m of covered tunnel inside another tube${where(r.tubes.overlap)}`);
  console.log(`wet       ${r.tubes.wet} m of covered tunnel with the sea's sheet inside${where(r.tubes.water)}`);
  console.log(`decks     ${r.decks.buildings} buildings rising into a deck${where(r.decks.into)}`);
  console.log(`          ${r.decks.trees} trees taller than the room under a deck${where(r.decks.under)}`);
  console.log(`walls     ${r.walls.metres} m of barrier or wall in another road's lane at its level (${r.walls.everyEdge} m if every edge had one)${where(r.walls)}`);
  const j = r.joins;
  console.log(`joins     roads drawn as one, ${j.held + j.drops.metres * 2 + j.stops.metres * 2} m: a car drops through ${j.drops.metres * 2} m at ${j.drops.places} places${where(j.drops)}`);
  console.log(`          stopped where nothing's drawn ${j.stops.metres * 2} m at ${j.stops.places} places${where(j.stops)}`);
  console.log(`          medians, ${j.medians} m: dropped through ${j.medianDrops.metres * 2} m${where(j.medianDrops)}; got past ${j.medianPast.metres * 2} m${where(j.medianPast)}`);
  console.log(`          decks' starts, ${j.starts}: a car near a kerb never gets on at ${j.startsMissed.metres}${where(j.startsMissed)}; drops off beside it at ${j.startsFell.metres}${where(j.startsFell)}`);
  const u = r.under;
  console.log(`under     driven in from the ground at decks' sides, ${u.drives}: on ${u.on}, held at the side ${u.held}, on under or beside ${u.under}; ended inside a deck ${u.inside.metres}${where(u.inside)}`);
  console.log(`          placed inside a deck, ${u.placed}: left inside ${u.stuck.metres}${where(u.stuck)}`);
  console.log(`          in ${r.seconds} s`);
  if (r.byTile) {
    console.log(`by tile   ${r.byTile.passing} of ${r.byTile.tiles} pass, ${r.byTile.share}% (limits, in metres of lane: ${JSON.stringify(TILE_LIMITS)})`);
    for (const t of r.byTile.failing) console.log(`          ${t.key}: stops ${t.stops}, steps ${t.step}, buildings ${t.buildings}, kerbs ${t.kerbs}`);
  }
}

// What plan 3's Phase F reached, on the part of the map npm run check holds (the CBD and around it, 80 km²), with a little room. Where it
// fell short of the plan's limits, that's in ai/next_3.md. Tighten these as the roads improve.
if (strict) {
  const r = report;
  const limits = [
    [r.lean.over4, 3.7, 'road leaning over 4%, %'],
    [r.lean.over10, 0.5, 'road leaning over 10%, %'],
    [r.grade.over3, 2.3, 'grade changing over 3%, %'],
    [r.grade.over6, 0.45, 'grade changing over 6%, %'],
    [r.lanes.stops.metres, 700, 'lane metres with no surface to stop on'],
    [r.lanes.water.metres, 0, 'lane metres the water test would stop a car on'],
    [r.lanes.step.over25cm, 320, 'lane metres with a step over 25 cm'],
    [r.lanes.roll.over4, 3900, 'lane metres with the roll changing over 4% a metre'],
    [r.lanes.buildings.metres, 30, 'lane metres with a building under the car'],
    [r.lanes.kerbs.metres, 260, 'lane metres with a wheel on a kerb'],
    [r.paving.centreLine.places, 0, 'places with paving on a road\'s centre line'],
    [r.paving.areaShare, 0.05, 'road area under paving, %'],
    [r.traffic.offRoad, 1.8, 'traffic lanes off the road, %'],
    // What tools/tiles/separate-tubes.mjs can't move: near mouths, in short underpasses. js/surfaces.js keeps their walls solid
    [r.tubes.overlapping, 2000, 'metres of covered tunnel inside another tube'],
    // Buildings with measured heights, which derive lists rather than cuts, and trees by a deck's edge
    [r.decks.buildings, 7, 'buildings rising into a deck'],
    [r.decks.trees, 6, 'trees taller than the room under a deck'],
    // Plan 5, Phase B: 4,070 m before roads side by side shared a deck. What's left is in the data: opposite carriageways drawn
    // overlapping, so their median stands in a lane, and roads meeting 0.35-0.5 m apart in height
    [r.walls.metres, 1260, 'metres of barrier or wall in another road\'s lane'],
    // What's drawn as one deck is one deck, a median holds, and a deck's start takes a car on across its width. What's left is where
    // three roads meet at a node and the gap's filled towards one of them, not the other (Fig St, -409, 157; the Cahill's on-ramp from
    // Sir John Young Crescent), roads on the ground beside a deck's start at its level (Darling Dr, Pier St), and Dalgety Rd's start,
    // where the ground beside its road falls 0.6 m
    [r.joins.drops.metres * 2, 0, 'metres of roads drawn as one where a car drops through'],
    [r.joins.stops.metres * 2, 6, 'metres of roads drawn as one where a car is stopped by nothing drawn'],
    [r.joins.medianDrops.metres * 2, 0, 'metres of median a car drops through'],
    [r.joins.medianPast.metres * 2, 0, 'metres of median a car gets past'],
    [r.joins.startsMissed.metres, 2, 'decks\' starts a car near a kerb never gets on'],
    [r.joins.startsFell.metres, 1, 'decks\' starts a car drops off beside'],
    // No room under a deck is solid from the ground: a car stops at its side, or gets on where the two meet; one left inside is moved out
    [r.under.inside.metres, 0, 'drives in from the ground that end inside a deck'],
    [r.under.stuck.metres, 0, 'cars placed inside a deck and left there']
  ];
  let failed = false;
  for (const [value, limit, label] of limits) {
    if (value > limit) { console.error(`${label}: ${value}, limit ${limit}`); failed = true; }
  }
  if (failed) process.exit(1);
}
