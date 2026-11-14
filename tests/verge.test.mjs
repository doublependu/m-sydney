import assert from 'node:assert/strict';
import test from 'node:test';
import { LEDGE, OUTER, PAVING_TOP, VERGE_LIFT, drape, squareVerge, stretchesOf } from '../js/verge.js';
import { STYLE } from '../js/house-styles.js';
import { ROAD_CLASS } from '../js/surfaces.js';

// The verges along streets of houses (js/verge.js), on streets made up for them:
//   A St along x at z = 0, 8 m wide, from a junction with B St (along z at x = -60) to a dead end at x = 120; C St along x at z = -60.
//   On A St's north side, a row of houses; on its south side, a shop among houses. The paving is a folded surface, so a strip laid flat
//   on it would cut through it somewhere.
const KERB = 4.4; // m from a street's middle: half its 8 m and the kerb's 0.4
let ids = 0;
const road = (name, a, b, pts, cls = ROAD_CLASS.residential) => ({ id: ++ids, name, a, b, width: 8, cls, kind: 0, pts: pts.map(([x, z]) => ({ x, z })) });
const A = road('A St', 1, 2, [[-60, 0], [30, 0], [120, 0]]);
const B = road('B St', 3, 1, [[-60, -80], [-60, 0]]), B2 = road('B St', 1, 4, [[-60, 0], [-60, 80]]);
const LINKS = [A, B, B2];
// The ground's height, folded along a line across the street so that no one plane fits it
const groundY = (x, z) => 0.05 * Math.abs(x - 13.3) + 0.02 * z;
// Paving triangles: a grid 7 m across, each square cut into two, heights from groundY at their corners
const TRIS = [];
for (let x = -70; x < 130; x += 7) {
  for (let z = -20; z < 20; z += 7) {
    const c = [[x, z], [x + 7, z], [x + 7, z + 7], [x, z + 7]].map(([px, pz]) => [px, groundY(px, pz), pz]);
    TRIS.push([c[0], c[1], c[2]], [c[0], c[2], c[3]]);
  }
}
const trianglesIn = (x0, z0, x1, z1) => TRIS.filter((t) => Math.max(...t.map((p) => p[0])) >= x0 && Math.min(...t.map((p) => p[0])) <= x1
  && Math.max(...t.map((p) => p[2])) >= z0 && Math.min(...t.map((p) => p[2])) <= z1);
const planeAt = (x, z) => {
  for (const [a, b, c] of TRIS) {
    const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d, l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
    const l3 = 1 - l1 - l2;
    if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) return l1 * a[1] + l2 * b[1] + l3 * c[1];
  }
  return null;
};
const env = (extra = {}) => ({
  links: LINKS,
  kerbFrom: () => KERB,
  pavingTris: trianglesIn,
  lawnTris: () => [],
  busStops: [],
  trees: { near: () => [], species: () => 2 },
  corner: 5,
  ...extra
});
// A building facing A St: its street point, its frontage along the front line, its lot (with a driveway where given)
const facing = (x0, x1, side, house = STYLE['Post-war fibro'], drive = null) => {
  const cx = (x0 + x1) / 2, front = KERB + 3.5;
  // As js/house-lots.js frames a lot: n from the street towards the house, t = (nz, -nx)
  const frame = { px: cx, pz: 0, tx: side, tz: 0, nx: 0, nz: side };
  const lot = drive ? { frame, kerb: KERB, front, drive: { a: (drive - cx) * side, w: 3, d0: front, d1: front + 8 } } : null;
  return { street: { x: cx, z: 0, link: A }, house, terrace: false, yard: 3.5, frontage: [[x0, front * side], [x1, front * side]], cx, cz: (front + 6) * side, lot };
};
const SQUARE = { x0: -100, z0: -100, x1: 200, z1: 100 };
function run(fronting, extra) {
  const job = squareVerge(fronting, env(extra), SQUARE);
  let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
}
const NORTH = [facing(-40, -28, 1), facing(-24, -12, 1, STYLE['Post-war fibro'], -16), facing(-8, 4, 1), facing(8, 20, 1), facing(24, 36, 1), facing(40, 52, 1)];
const SOUTH = [facing(-40, -28, -1), facing(-24, -12, -1, 0), facing(8, 20, -1)];
const vertices = (chunks) => chunks.flatMap((c) => {
  const out = [];
  for (let i = 0; i < c.pos.length; i += 3) out.push({ x: c.pos[i] + c.x, y: c.pos[i + 1], z: c.pos[i + 2] + c.z });
  return out;
});

test('a piece laid on the paving lies exactly on its triangles, all of it, facing up', () => {
  const ring = [{ x: 10, z: 1 }, { x: 17, z: 1 }, { x: 17, z: 3.5 }, { x: 10, z: 3.5 }];
  const out = [];
  const n = drape(ring, trianglesIn(9, 0, 18, 4), 0.01, out, 0, 0);
  assert.ok(n >= 4, `cut where the triangles' edges and the fold cross it: ${n} triangles`);
  let area = 0;
  for (let i = 0; i < out.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = out.slice(i, i + 9);
    for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]]) assert.ok(Math.abs(y - planeAt(x, z) - 0.01) < 1e-6, `on the paving at ${x}, ${z}`);
    // Each triangle's middle on the paving too: it's within one triangle's plane
    assert.ok(Math.abs((ay + by + cy) / 3 - planeAt((ax + bx + cx) / 3, (az + bz + cz) / 3) - 0.01) < 1e-6, 'and between its corners');
    const up = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    assert.ok(up > 0, 'facing up');
    area += up / 2;
  }
  assert.ok(Math.abs(area - 7 * 2.5) < 1e-6, `the whole of it: ${area} m²`);
});

test('streets joined where only two links meet, and broken at junctions and where the class changes', () => {
  const lane = road('Lane', 2, 5, [[120, 0], [160, 0]], ROAD_CLASS.service);
  const stretches = stretchesOf([...LINKS, lane]);
  const a = stretches.find((s) => s.links.has(A));
  assert.equal(a.parts.length, 1);
  assert.equal(stretches.filter((s) => s.links.has(B) || s.links.has(B2)).length, 2, 'B St is broken where A St meets it');
  assert.ok(!stretches.some((s) => s.links.has(lane)), 'a lane has no verge');
});

test('a side of houses gets a strip, a side with a shop keeps its paving', () => {
  const v = run([...NORTH, ...SOUTH]);
  // A St runs from its junction east: its left, side 1, is +z
  const north = v.sides.find((s) => s.name === 'A St' && s.side === 1);
  const south = v.sides.find((s) => s.name === 'A St' && s.side === -1);
  assert.ok(north.strip, 'the north side, all houses, has a strip');
  assert.ok(!south.strip, 'the south side, with a shop, keeps the paving');
  const pts = [...vertices(v.lawn), ...vertices(v.path)];
  assert.ok(pts.length > 0);
  for (const p of pts) {
    assert.ok(p.z > 0, 'all on the north side');
    const d = p.z - KERB;
    assert.ok(d >= LEDGE - 1e-6 && d <= OUTER + 1e-6, `from the kerb's ledge to ${OUTER} m: ${d}`);
    assert.ok(Math.abs(p.y - planeAt(p.x, p.z) - PAVING_TOP - VERGE_LIFT) < 1e-6, 'on the paving as drawn, just over it');
  }
});

test('the strip stops short of the junction, at a dead end, and leaves the crossover\'s paving', () => {
  const v = run(NORTH);
  const xs = [...vertices(v.lawn), ...vertices(v.path)].map((p) => p.x);
  // B St's half width, the kerb, the corner's radius and a metre past A St's start at x = -60
  assert.ok(Math.min(...xs) >= -60 + 4 + 0.4 + 5 + 1 - 1e-6, `stops short of the corner: ${Math.min(...xs)}`);
  assert.ok(Math.max(...xs) <= 120 - 2 + 1e-6, `and of the dead end: ${Math.max(...xs)}`);
  // The driveway at x = -16, 3 m wide, its crossover 0.6 m wider: nothing of the strip over it
  const over = [...vertices(v.lawn), ...vertices(v.path)].filter((p) => p.x > -16 - 1.8 + 0.06 && p.x < -16 + 1.8 - 0.06);
  assert.equal(over.length, 0, 'none over the crossover');
});

test('a tree on each frontage with none, in the lawn, clear of the crossover; none where the map has one', () => {
  const v = run(NORTH);
  assert.ok(v.trees.length >= 5, `${v.trees.length} trees`);
  for (const t of v.trees) {
    assert.ok(t.z > KERB + LEDGE && t.z < KERB + 2.0, `in the strip's lawn: ${t.z}`);
    assert.ok(Math.abs(t.x + 16) > 1.8 + 1.0, `clear of the crossover: ${t.x}`);
  }
  const mapTree = { x: 14, z: KERB + 1, species: 5 };
  const w = run(NORTH, { trees: { near: (x, z, r) => (Math.hypot(mapTree.x - x, mapTree.z - z) <= r ? [mapTree] : []), species: () => 5 } });
  assert.ok(!w.trees.some((t) => t.x > 8 && t.x < 20), 'none added on the frontage with the map\'s tree');
});

test('most streets have a footpath, the post-war ones less often', () => {
  const share = (style) => {
    let withPath = 0;
    for (let i = 0; i < 200; i++) {
      const name = `Street ${i}`;
      A.name = name;
      const v = run(NORTH.map((f) => ({ ...f, house: style })));
      if (v.sides.find((s) => s.name === name && s.side === 1).path) withPath++;
    }
    A.name = 'A St';
    return withPath / 200;
  };
  const project = share(STYLE['Project home']), postWar = share(STYLE['Post-war fibro']);
  assert.ok(project > 0.8, `project homes' streets: ${project}`);
  assert.ok(postWar > 0.35 && postWar < 0.7, `post-war streets: ${postWar}`);
});
