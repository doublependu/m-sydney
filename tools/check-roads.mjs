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
// usage: node tools/check-roads.mjs [--json] [--strict] [--list] [--tiles=0_-2,1_-2]
console.info = () => {};
const { heldList, heldTiles } = await import('../js/geodata.js');
const { LINKS, chooseSurface, linkById, onGroundRoad, roadHeight } = await import('../js/surfaces.js');
const { GroundCells, SIDEWALK_TOP, addSurface, groundLinks, wheelContacts } = await import('../js/ground-geometry.js');
const { blockAt } = await import('../js/city-config.js');
const { buildRoadNetworkSteps } = await import('../js/road-network.js');

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
const BODY = [[0.9, 2.2], [-0.9, 2.2], [0.9, -2.2], [-0.9, -2.2], [0, 0]];
const WHEELS = [[0.8, 1.4], [-0.8, 1.4], [0.8, -1.4], [-0.8, -1.4]];
function walk(path, sid0, y0, name, out) {
  if (tiles && !path.some((p) => wanted(p.x, p.z))) return;
  let sid = sid0, y = y0, prevRoll = null;
  const ys = [];
  for (const p of path) {
    if (!wanted(p.x, p.z)) {
      // On its way into the part being looked at, so it gets there on the right level
      const passing = chooseSurface(sid, y, p.x, p.z, 1.0);
      if (passing) { y = passing.y; sid = passing.sid; }
      ys.push(null);
      prevRoll = null;
      continue;
    }
    out.metres++;
    const here = chooseSurface(sid, y, p.x, p.z, 1.0);
    if (!here) { out.stops.add(p.x, p.z, name); ys.push(null); prevRoll = null; continue; }
    y = here.y; sid = here.sid;
    ys.push(y);
    if (sid) { prevRoll = null; continue; }
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
const walker = (rollLimit) => ({ metres: 0, stops: new Places(), step: new Places(), roll: new Places(), rollLimit, buildings: new Places(), kerbs: new Places(), kerbMiddle: 0, touched: new Set() });
const over = (places, limit) => places.all.filter((w) => w[0] > limit).length;
{
  const out = walker(2);
  for (const l of LINKS) {
    const half = l.width / 2;
    const lanes = l.deck ? [-6, -2, 2, 6] : l.width > 7 ? [-(half - 1.8), 0, half - 1.8] : [0];
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
    const half = l.deck ? 12 : l.width / 2 - 0.4;
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
  console.log(`step      ${r.lanes.step.over5cm} m over 5 cm, ${r.lanes.step.over25cm} m over 25 cm, at ${r.lanes.step.places} places, worst ${r.lanes.step.worst} m${where(r.lanes.step)}`);
  console.log(`roll      ${r.lanes.roll.over2} m over 2% a metre, ${r.lanes.roll.over4} m over 4%, at ${r.lanes.roll.places} places, worst ${r.lanes.roll.worst}%${where(r.lanes.roll)}`);
  console.log(`buildings ${r.lanes.buildings.metres} m at ${r.lanes.buildings.places} places, ${r.lanes.buildings.touched} buildings${where(r.lanes.buildings)}`);
  console.log(`kerbs     ${r.lanes.kerbs.metres} m at ${r.lanes.kerbs.places} places, the car's middle on one for ${r.lanes.kerbs.middle} m${where(r.lanes.kerbs)}`);
  console.log(`paving    ${r.paving.areaShare}% of road area, ${r.paving.rampShare}% of ramps and bridges, centre line ${r.paving.centreLine.metres * 2} m at ${r.paving.centreLine.places} places, worst ${r.paving.centreLine.worst} m${where(r.paving.centreLine)}`);
  console.log(`turns     ${r.turns.km} km: stops ${r.turns.stops.metres} m at ${r.turns.stops.places} places, ${r.turns.step.over25cm} m step over 25 cm, ${r.turns.roll.over8} m roll over 8% a metre, worst ${r.turns.roll.worst}%`);
  console.log(`traffic   ${r.traffic.km} lane km: ${r.traffic.offRoad}% off every carriageway, ${r.traffic.overKerb}% over a kerb island`);
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
    [r.lanes.step.over25cm, 320, 'lane metres with a step over 25 cm'],
    [r.lanes.roll.over4, 3900, 'lane metres with the roll changing over 4% a metre'],
    [r.lanes.buildings.metres, 30, 'lane metres with a building under the car'],
    [r.lanes.kerbs.metres, 260, 'lane metres with a wheel on a kerb'],
    [r.paving.centreLine.places, 0, 'places with paving on a road\'s centre line'],
    [r.paving.areaShare, 0.05, 'road area under paving, %'],
    [r.traffic.offRoad, 1.8, 'traffic lanes off the road, %']
  ];
  let failed = false;
  for (const [value, limit, label] of limits) {
    if (value > limit) { console.error(`${label}: ${value}, limit ${limit}`); failed = true; }
  }
  if (failed) process.exit(1);
}
