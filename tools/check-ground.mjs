// tools/check-ground.mjs: measures how well the drawn ground holds together, without a browser. It rebuilds the road
// surfaces the way the game draws them and reports:
//   wheels     how far a car's wheels sit under the drawn road, over every lane position in the city
//   kerbs      just outside each kerb: no surface at all (the harbour shows), the road below the kerb's foot (a slit),
//              or the road lying over the footpath
//   crossings  roads that cross with no junction, and how far apart their surfaces are there
//   buildings  whether the ground beside any wall rises over its foot, and how much stone shows under floors
//   grid       steps between neighbouring cells of the height grid on land
// usage: node tools/check-ground.mjs [--json] [--strict] [--tiles=0_-2,1_-2]
import fs from 'node:fs';

// The modules fetch their binary data at import: serve it from disk
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { GEO } = await import('../js/geodata.js');
const { BLOCKS, landAt } = await import('../js/city-config.js');
const ground = await import('../js/ground-geometry.js');
const { groundHeight, structuresAt } = await import('../js/surfaces.js');
const { heldTiles, isHeld, tileKeyAt } = await import('../js/geodata.js');
const REAL_BUILDINGS = heldTiles().flatMap((t) => t.buildings);
const { buildingFloor, eachWall } = await import('../js/building-floor.js');

const RG = GEO.roadGraph;
const json = process.argv.includes('--json');
// --strict: fails if the ground has got worse than the last accepted numbers
const strict = process.argv.includes('--strict');
// --tiles: only samples within these 1 km squares, for a change to one part of the map
const tilesArg = process.argv.find((a) => a.startsWith('--tiles='))?.slice(8).split(',');
const tiles = tilesArg && new Set(tilesArg);
const wanted = (x, z) => !tiles || tiles.has(`${Math.floor(x / 1000)}_${Math.floor(z / 1000)}`);
const report = {};

// --- The drawn road surface, as triangles, indexed by 25 m cell ---------------------------------------------------------
const CELL = 25;
const triIndex = new Map();
const addTri = (A, B, C) => {
  const minX = Math.min(A[0], B[0], C[0]), maxX = Math.max(A[0], B[0], C[0]);
  const minZ = Math.min(A[2], B[2], C[2]), maxZ = Math.max(A[2], B[2], C[2]);
  for (let ix = Math.floor(minX / CELL); ix <= Math.floor(maxX / CELL); ix++) {
    for (let iz = Math.floor(minZ / CELL); iz <= Math.floor(maxZ / CELL); iz++) {
      const k = ix * 100000 + iz;
      if (!triIndex.has(k)) triIndex.set(k, []);
      triIndex.get(k).push([A, B, C]);
    }
  }
};
for (const mesh of ground.roadSurfaceMeshes()) {
  const p = mesh.position;
  for (let i = 0; i < mesh.index.length; i += 3) {
    const v = (k) => [p[mesh.index[i + k] * 3], p[mesh.index[i + k] * 3 + 1], p[mesh.index[i + k] * 3 + 2]];
    addTri(v(0), v(1), v(2));
  }
}
// The highest drawn road surface at (x, z) no more than `below` over height `near` (a surface further up is another
// level overhead, a street along the top of a cutting), or -Infinity where there is none
function drawnRoad(x, z, near = Infinity, below = 1) {
  let top = -Infinity;
  for (const [A, B, C] of triIndex.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || []) {
    const d = (B[2] - C[2]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[2] - C[2]);
    if (Math.abs(d) < 1e-9) continue;
    const l1 = ((B[2] - C[2]) * (x - C[0]) + (C[0] - B[0]) * (z - C[2])) / d;
    const l2 = ((C[2] - A[2]) * (x - C[0]) + (A[0] - C[0]) * (z - C[2])) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    const y = l1 * A[1] + l2 * B[1] + l3 * C[1];
    if (y <= near + below) top = Math.max(top, y);
  }
  return top;
}

// --- Wheels -------------------------------------------------------------------------------------------------------------
{
  const bins = [0.03, 0.05, 0.15, 0.3, 0.6, Infinity];
  const counts = bins.map(() => 0);
  let n = 0;
  const worst = [];
  for (const link of ground.groundLinks()) {
    const { pts, width } = link;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 1) continue;
      const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
      const heading = Math.atan2(ux, uz);
      for (let t = 3; t < L - 3; t += 6) {
        for (const off of width > 7 ? [-(width / 2 - 1.8), 0, width / 2 - 1.8] : [0]) {
          const x = a.x + ux * t + uz * off, z = a.z + uz * t - ux * off;
          if (!wanted(x, z)) continue;
          // The car rests on the plane through its four contacts; each wheel's bottom is that plane where it touches
          const car = ground.wheelContacts(x, z, heading);
          let sink = -Infinity;
          for (const [k, w] of car.contacts.entries()) {
            const along = k < 2 ? 1.4 : -1.4, side = k % 2 ? 0.8 : -0.8;
            const wheel = car.y + Math.tan(car.pitch) * along + Math.tan(car.roll) * side;
            const road = drawnRoad(w.x, w.z, wheel);
            if (road > -Infinity) sink = Math.max(sink, road - wheel);
          }
          if (sink === -Infinity) continue;
          n++;
          counts[bins.findIndex((limit) => sink < limit)]++;
          if (sink > 0.3 && worst.length < 2000) worst.push([+sink.toFixed(2), link.name, Math.round(x), Math.round(z)]);
        }
      }
    }
  }
  worst.sort((p, q) => q[0] - p[0]);
  report.wheels = {
    samples: n,
    under3cm: counts[0], '3-5cm': counts[1], '5-15cm': counts[2], '15-30cm': counts[3], '30-60cm': counts[4], over60cm: counts[5],
    over3cmShare: +((1 - counts[0] / n) * 100).toFixed(2), over15cmShare: +((counts[3] + counts[4] + counts[5]) / n * 100).toFixed(2),
    worst: worst.slice(0, 8)
  };
}

// --- Kerbs --------------------------------------------------------------------------------------------------------------
{
  const blockCells = new Map();
  for (const b of BLOCKS) {
    for (let ix = Math.floor(b.minX / CELL); ix <= Math.floor(b.maxX / CELL); ix++) {
      for (let iz = Math.floor(b.minZ / CELL); iz <= Math.floor(b.maxZ / CELL); iz++) {
        const k = ix * 100000 + iz;
        if (!blockCells.has(k)) blockCells.set(k, []);
        blockCells.get(k).push(b);
      }
    }
  }
  const inPoly = (P, x, z) => {
    let inside = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      if ((P[i].z > z) !== (P[j].z > z) && x < ((P[j].x - P[i].x) * (z - P[i].z)) / (P[j].z - P[i].z) + P[i].x) inside = !inside;
    }
    return inside;
  };
  const onBlock = (x, z) => (blockCells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || [])
    .some((b) => inPoly(b.poly, x, z) && !b.holes.some((h) => inPoly(h, x, z)));
  let samples = 0, open = 0, slit = 0, over = 0;
  const where = { open: [], slit: [] };
  for (const b of BLOCKS) {
    for (const ring of [b.poly, ...b.holes]) {
      let area = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
      const outward = (ring === b.poly ? -1 : 1) * (area > 0 ? 1 : -1);
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], c = ring[(i + 1) % ring.length];
        const L = Math.hypot(c.x - a.x, c.z - a.z);
        if (L < 0.5) continue;
        const nx = (-(c.z - a.z) / L) * outward, nz = ((c.x - a.x) / L) * outward;
        for (let t = 0.5; t < L; t += 4) {
          const x = a.x + ((c.x - a.x) * t) / L, z = a.z + ((c.z - a.z) * t) / L;
          const ox = x + nx * 0.4, oz = z + nz * 0.4;
          if (!wanted(ox, oz) || !isHeld(tileKeyAt(ox, oz))) continue;
          // Not along the play area's own edge, where the land runs on beyond the city
          const edge = GEO.frame.detail.some((r) => ox > r.x0 - 3 && ox < r.x1 + 3 && oz > r.z0 - 3 && oz < r.z1 + 3
            && Math.min(ox - r.x0, r.x1 - ox, oz - r.z0, r.z1 - oz) < 3) && !GEO.frame.detail.some((r) => ox > r.x0 + 3 && ox < r.x1 - 3 && oz > r.z0 + 3 && oz < r.z1 - 3);
          // ...nor at a seawall, where the land test's coarse shore puts a metre of land past the island's edge
          if (edge || onBlock(ox, oz) || !landAt(ox, oz) || !landAt(x + nx * 2.5, z + nz * 2.5)) continue;
          // ...nor beside a low ramp or viaduct, which the islands stop short of: what's there is its deck, and it's not on the ground
          if (structuresAt(ox, oz, -2.6).length) continue;
          samples++;
          const road = drawnRoad(ox, oz);
          const kerb = ground.kerbFootAt(x, z);
          if (road === -Infinity) {
            open++;
            if (where.open.length < 6 && open % 97 === 1) where.open.push([Math.round(ox), Math.round(oz)]);
          } else if (road < kerb.foot - 0.02) {
            slit++;
            if (where.slit.length < 6 && slit % 197 === 1) where.slit.push([Math.round(ox), Math.round(oz), +(kerb.foot - road).toFixed(2)]);
          } else if (road > kerb.top + 0.02) over++;
        }
      }
    }
  }
  report.kerbs = {
    samples, noSurface: open, slitUnderKerb: slit, roadOverFootpath: over,
    openShare: +((open + slit) / samples * 100).toFixed(2), where
  };
}

// --- Crossings ----------------------------------------------------------------------------------------------------------
{
  const segs = [];
  for (const link of ground.allLinks()) {
    for (let i = 1; i < link.pts.length; i++) segs.push([link, link.pts[i - 1], link.pts[i]]);
  }
  const grid = new Map();
  for (const s of segs) {
    const [, p, q] = s;
    for (let ix = Math.floor(Math.min(p.x, q.x) / 50); ix <= Math.floor(Math.max(p.x, q.x) / 50); ix++) {
      for (let iz = Math.floor(Math.min(p.z, q.z) / 50); iz <= Math.floor(Math.max(p.z, q.z) / 50); iz++) {
        const k = ix * 100000 + iz;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(s);
      }
    }
  }
  const cross = (p, q, r, s) => {
    const d = (q.x - p.x) * (s.z - r.z) - (q.z - p.z) * (s.x - r.x);
    if (Math.abs(d) < 1e-9) return null;
    const t = ((r.x - p.x) * (s.z - r.z) - (r.z - p.z) * (s.x - r.x)) / d;
    const u = ((r.x - p.x) * (q.z - p.z) - (r.z - p.z) * (q.x - p.x)) / d;
    if (t <= 0.01 || t >= 0.99 || u <= 0.01 || u >= 0.99) return null;
    return { x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t, t, u };
  };
  const seen = new Set();
  const found = [];
  for (const list of grid.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [A, p, q] = list[i], [B, r, s] = list[j];
        if (A === B || A.a === B.a || A.a === B.b || A.b === B.a || A.b === B.b) continue;
        const key = Math.min(A.id, B.id) * 100000 + Math.max(A.id, B.id);
        if (seen.has(key)) continue;
        const X = cross(p, q, r, s);
        if (!X) continue;
        seen.add(key);
        // A road on the ground stands on the ground there; a structure has its own height
        const ya = A.kind ? p.y + (q.y - p.y) * X.t : groundHeight(X.x, X.z);
        const yb = B.kind ? r.y + (s.y - r.y) * X.u : groundHeight(X.x, X.z);
        found.push({ a: A.name || '-', b: B.name || '-', kinds: `${A.kind}${B.kind}`, x: Math.round(X.x), z: Math.round(X.z), apart: +Math.abs(ya - yb).toFixed(1) });
      }
    }
  }
  const tight = found.filter((c) => c.apart < ground.STACK_CLEARANCE - 0.25);
  const byKinds = {};
  for (const c of found) byKinds[c.kinds] = (byKinds[c.kinds] || 0) + 1;
  report.crossings = { total: found.length, byKinds, tooClose: tight.length, examples: tight.slice(0, 10) };
}

// --- Buildings ----------------------------------------------------------------------------------------------------------
// The ground beside each wall against the wall's lowest row of windows, and how much stone shows under the floor
{
  const FLOOR_SILL = 0.22; // the wall starts this far above the floor's ground (js/building-footprints.js)
  let walls = 0, buried = 0, worst = 0, at = null, buildings = 0;
  const stone = [];
  for (const b of REAL_BUILDINGS) {
    if (tiles && !wanted(b.cx, b.cz)) continue;
    buildings++;
    const { floor, low } = buildingFloor(b.polygons, groundHeight);
    stone.push(floor - low);
    eachWall(b.polygons, (p, q) => {
      const L = Math.hypot(q.x - p.x, q.z - p.z);
      for (let t = 0; t <= L; t += 2) {
        const x = p.x + ((q.x - p.x) * t) / (L || 1), z = p.z + ((q.z - p.z) * t) / (L || 1);
        const over = groundHeight(x, z) - (floor + FLOOR_SILL);
        walls++;
        if (over > 0.05) buried++;
        if (over > worst) { worst = over; at = [Math.round(x), Math.round(z)]; }
      }
    });
  }
  stone.sort((p, q) => p - q);
  const q = (f) => +(stone[Math.floor(stone.length * f)] ?? 0).toFixed(1);
  report.buildings = {
    buildings, wallSamples: walls, groundOverWall: buried, worst: +worst.toFixed(2), at,
    stone: { median: q(0.5), p90: q(0.9), p99: q(0.99), max: +(stone.at(-1) ?? 0).toFixed(1), over4m: stone.filter((d) => d > 4).length }
  };
}

// --- The height grid ----------------------------------------------------------------------------------------------------
{
  const { x0, z0, cell, w, h } = GEO.frame.heights;
  const { rawTerrainHeight: terrainHeight } = await import('../js/terrain.js');
  let steps4 = 0, steps10 = 0, worst = 0, at = null, cells = 0;
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const x = x0 + i * cell, z = z0 + j * cell;
      if (!landAt(x, z) || !landAt(x + cell, z) || !landAt(x, z + cell)) continue;
      cells++;
      const y = terrainHeight(x, z);
      const d = Math.max(Math.abs(y - terrainHeight(x + cell, z)), Math.abs(y - terrainHeight(x, z + cell)));
      if (d > 4) steps4++;
      if (d > 10) steps10++;
      if (d > worst) { worst = d; at = [x, z]; }
    }
  }
  report.grid = { landCells: cells, stepsOver4m: steps4, stepsOver10m: steps10, worst: +worst.toFixed(1), at };
}

if (json) console.log(JSON.stringify(report, null, 1));
else {
  const r = report;
  console.log(`wheels    ${r.wheels.samples} lane positions: ${r.wheels.over3cmShare}% more than 3 cm under the road, ${r.wheels.over15cmShare}% more than 15 cm`);
  console.log(`          ${JSON.stringify(Object.fromEntries(Object.entries(r.wheels).filter(([k]) => /cm$/.test(k) && !/Share/.test(k))))}`);
  if (r.wheels.worst.length) console.log(`          worst: ${r.wheels.worst.map(([s, n, x, z]) => `${s} m ${n} (${x}, ${z})`).join('; ')}`);
  console.log(`kerbs     ${r.kerbs.samples} samples: ${r.kerbs.noSurface} with no surface, ${r.kerbs.slitUnderKerb} slits, ${r.kerbs.roadOverFootpath} road over the footpath (${r.kerbs.openShare}% open)`);
  if (r.kerbs.where.open.length) console.log(`          open at ${r.kerbs.where.open.map((p) => p.join(',')).join('  ')}`);
  console.log(`crossings ${r.crossings.total} without a junction (${JSON.stringify(r.crossings.byKinds)} by level: 0 ground, 1 bridge, 2 tunnel), ${r.crossings.tooClose} closer than ${ground.STACK_CLEARANCE} m`);
  for (const c of r.crossings.examples.slice(0, 6)) console.log(`          ${c.a} x ${c.b} at (${c.x}, ${c.z}): ${c.apart} m apart`);
  const bs = r.buildings;
  console.log(`buildings ${bs.buildings}: ground over the wall's foot at ${bs.groundOverWall} of ${bs.wallSamples} samples, worst ${bs.worst} m${bs.at ? ` at ${bs.at.join(',')}` : ''}; stone under floors median ${bs.stone.median} m, 99th percentile ${bs.stone.p99} m, ${bs.stone.over4m} over 4 m`);
  console.log(`grid      ${r.grid.landCells} land cells: ${r.grid.stepsOver4m} steps over 4 m, ${r.grid.stepsOver10m} over 10 m, worst ${r.grid.worst} m at ${r.grid.at}`);
}

// What plan 3's road shapes ended on, and a little room. Roads now have shapes of their own, overlapping on hillsides, and wheels sit a few
// centimetres into what's drawn more often than when everything draped over one height grid. Tighten these as the ground improves.
if (strict) {
  const r = report;
  const limits = [
    [r.wheels.over3cmShare, 8.6, 'wheels over 3 cm under the road, %'],
    [r.wheels.over15cmShare, 0.9, 'wheels over 15 cm under the road, %'],
    [r.kerbs.openShare, 0.6, 'kerbs onto nothing or a slit, %'],
    [r.crossings.tooClose, 40, 'crossings too close'],
    [r.grid.stepsOver10m, 2000, 'height grid steps over 10 m'], // real cliffs and quarries: the 5 m model has them where contours smoothed them over
    [r.buildings.groundOverWall, 5, 'wall samples with the ground over the wall']
  ];
  let failed = false;
  for (const [value, limit, label] of limits) {
    if (value > limit) { console.error(`${label}: ${value}, limit ${limit}`); failed = true; }
  }
  if (failed) process.exit(1);
}
