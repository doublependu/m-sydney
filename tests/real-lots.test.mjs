import assert from 'node:assert/strict';
import test from 'node:test';
import { FENCE_BACK, FOOTPATH, acrossAt, squareLots } from '../js/house-lots.js';
import { STYLE } from '../js/house-styles.js';
import { realLotsFrom } from '../js/real-lots.js';

// Houses on their real lots (js/real-lots.js, as tools/build-lots.mjs fits them; js/house-lots.js), on a street made up for it: A St along
// x at z = 0, 8 m wide, its front line at z = 7.9 (the kerb at 4.4 m and the footpath's 3.5 m). On its north side the real lots' frontage
// is at z = 8.5, 0.6 m behind the front line, and they're 41.5 m deep, to z = 50:
//   P, a house in its lot (x -2 to 12), and G, a granny flat standing in it; Q, a house in its lot beside it (x 12 to 26);
//   RS, a semi drawn as one outline over two lots (x 26 to 33 and 33 to 40);
//   T, a house in a lot of 21.5 m (x 40 to 54); U, a house on the lot set behind it, its handle 4 m wide up T's side (x 54 to 58);
//   V1 and V2, two houses on one lot (x 58 to 80); W, a house the file couldn't fit, between that and X's lot (x 92 to 110).
// Further along, Y on a farm's lot 290 m deep, and up the hill Z, on a lot with no street near.
const KERB = 4.4;
const road = (name, pts) => ({ name, width: 8, cls: 7, kind: 0, pts: pts.map(([x, z]) => ({ x, z })) });
const ROADS = [road('A St', [[-80, 0], [400, 0]])];
const tile = { key: '0_0' };
const box = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
const building = (ring, extra = {}) => {
  const xs = ring.map((p) => p.x), zs = ring.map((p) => p.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  return { kind: 1, houseStyle: STYLE['Post-war fibro'], group: 0, bottom: 0, height: 3, polygons: [{ outer: ring, holes: [] }],
    minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, ...extra };
};
const HOUSES = {
  P: building(box(0, 12, 10, 26)), G: building(box(4, 38, 9, 44)), Q: building(box(14, 12, 24, 26)), RS: building(box(26.5, 12, 39.5, 26)),
  T: building(box(42, 12, 52, 24)), U: building(box(42, 36, 52, 50)), V1: building(box(60, 12, 68, 26)), V2: building(box(71, 12, 79, 26)),
  W: building(box(81, 12, 91, 26)), X: building(box(94, 12, 104, 26)), Y: building(box(300, 12, 312, 26)), Z: building(box(300, 500, 310, 510))
};
// A lot's ring counter-clockwise (as js/tiles/lot-file.js has it) from corners, with each edge's kind from that corner to the next
const ring = (pts, kinds) => ({ rings: [pts.map(([x, z]) => ({ x, z }))], edges: [kinds] });
const rect = (x0, z0, x1, z1, [south, east, north, west]) => ring([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], [south, east, north, west]);
const LOTS = {
  P: rect(-2, 8.5, 12, 50, ['front', 'side', 'bound', 'bound']),
  Q: rect(12, 8.5, 26, 50, ['front', 'side', 'bound', 'side']),
  R1: rect(26, 8.5, 33, 50, ['front', 'wall', 'bound', 'side']),
  R2: rect(33, 8.5, 40, 50, ['front', 'side', 'bound', 'wall']),
  T: rect(40, 8.5, 54, 30, ['front', 'side', 'side', 'side']),
  U: ring([[54, 8.5], [58, 8.5], [58, 60], [40, 60], [40, 30], [54, 30]], ['front', 'side', 'bound', 'side', 'side', 'side']),
  V: rect(58, 8.5, 80, 50, ['front', 'bound', 'bound', 'side']),
  X: rect(92, 8.5, 110, 50, ['front', 'bound', 'bound', 'bound']),
  Y: rect(280, 8.5, 330, 300, ['front', 'bound', 'bound', 'bound']),
  Z: rect(290, 490, 320, 520, ['bound', 'bound', 'bound', 'bound'])
};
// The tile's file: each house's rule, and each lot's houses, its own first
const HOMES = [['P', 'in'], ['G', 'in'], ['Q', 'in'], ['RS', 'wall'], ['T', 'in'], ['U', 'in'], ['V1', 'several'], ['V2', 'several'], ['W', 'fallback'],
  ['X', 'in'], ['Y', 'in'], ['Z', 'in']];
const ON = { P: ['P', 'G'], Q: ['Q'], R1: ['RS'], R2: ['RS'], T: ['T'], U: ['U'], V: ['V1', 'V2'], X: ['X'], Y: ['Y'], Z: ['Z'] };
const FILE = {
  ix: 0, iz: 0,
  homes: HOMES.map(([name, rule]) => ({ x: HOUSES[name].cx, z: HOUSES[name].cz, rule })),
  lots: Object.entries(LOTS).map(([name, l]) => ({ kind: name === 'V' ? 'several' : 'fitted', homes: ON[name].map((h) => HOMES.findIndex(([n]) => n === h)), ...l }))
};
const runAll = (job) => { let step = job.next(); while (!step.done) step = job.next(); return step.value; };
const real = runAll(realLotsFrom([FILE]));

function nearestOn(link, x, z) {
  let best = null;
  for (let i = 1; i < link.pts.length; i++) {
    const p = link.pts[i - 1], q = link.pts[i], L = Math.hypot(q.x - p.x, q.z - p.z), ux = (q.x - p.x) / L, uz = (q.z - p.z) / L;
    const t = Math.max(0, Math.min(L, (x - p.x) * ux + (z - p.z) * uz));
    const px = p.x + ux * t, pz = p.z + uz * t, d = Math.hypot(px - x, pz - z);
    if (!best || d < best.d) best = { link, x: px, z: pz, d, ux, uz };
  }
  return best;
}
const ENV = {
  // The nearest street within 60 m, as js/street-front.js finds it
  streetOf: (w) => ROADS.map((r) => nearestOn(r, w.cx, w.cz)).filter((n) => n.d <= 60).sort((a, b) => a.d - b.d)[0] ?? null,
  roadsNear: (x, z, r) => ROADS.map((l) => nearestOn(l, x, z)).filter((n) => n.d <= r),
  kerbFrom: () => KERB,
  groundAt: () => 0, lawnAt: () => 0, pavingAt: () => 0, roadAt: () => 0,
  onLawn: (x, z) => ROADS.every((l) => nearestOn(l, x, z).d >= KERB + FOOTPATH),
  sites: []
};
const WITH = { ...ENV, realLots: (w) => real.homeAt(w.cx, w.cz), realLotsIn: real.lotsIn, lines: true };
const SQUARE = { x0: -100, z0: -100, x1: 500, z1: 600 };
const FRONT = KERB + FOOTPATH;

const result = runAll(squareLots(Object.values(HOUSES).map((b) => ({ b, tile })), WITH, SQUARE));
const lotOf = (name) => result.lots.find((l) => l.home.pieces.includes(HOUSES[name]));
// The fences before the cut along x = at, from z0 to z1 (within 5 cm)
const linesAtX = (at, list = result.lines) => list.filter((f) => Math.abs(f.a.x - at) < 0.05 && Math.abs(f.b.x - at) < 0.05)
  .map((f) => [Math.min(f.a.z, f.b.z), Math.max(f.a.z, f.b.z)]).sort((a, b) => a[0] - b[0]);
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 0.06, `${what}: ${a}, not ${b}`);

test('a house in its real lot: the lot as surveyed, brought forward to the front line; one fence along the line between two lots, from 2 m behind the front', () => {
  const p = lotOf('P');
  assert.ok(p.real, 'P\'s lot is its real one');
  const xs = p.pts.map((v) => v.x), zs = p.pts.map((v) => v.z);
  near(Math.min(...xs), -2, 'its west side'); near(Math.max(...xs), 12, 'its east side');
  near(Math.min(...zs), FRONT, 'its front, the front line'); near(Math.max(...zs), 50, 'its back');
  assert.ok(p.pts.some((v, i) => v.tag === 'front' && Math.abs(v.z - FRONT) < 0.01 && Math.abs(p.pts[(i + 1) % p.pts.length].z - FRONT) < 0.01), 'its front edge on the front line');
  const between = linesAtX(12);
  assert.equal(between.length, 1, `one fence between P and Q: ${JSON.stringify(between)}`);
  near(between[0][0], FRONT + FENCE_BACK, 'from FENCE_BACK behind the front line');
  near(between[0][1], 50, 'to the back line');
  assert.ok(!result.lines.some((f) => Math.abs(f.a.z - FRONT) < 0.1 && Math.abs(f.b.z - FRONT) < 0.1), 'none along the front');
});

test('a granny flat standing in another house\'s lot has no lot of its own', () => {
  assert.equal(lotOf('G'), undefined);
  assert.equal(result.measure.rules.inside, 1);
});

test('a semi drawn as one outline over two lots: one lot, and the line between them fenced only behind the house', () => {
  const rs = lotOf('RS');
  const xs = rs.pts.map((v) => v.x);
  near(Math.min(...xs), 26, 'its west side'); near(Math.max(...xs), 40, 'its east side');
  const wall = linesAtX(33);
  assert.equal(wall.length, 1, `one fence on the shared wall: ${JSON.stringify(wall)}`);
  near(wall[0][0], 26, 'from the back wall'); near(wall[0][1], 50, 'to the back line');
});

test('lots that meet along a line at different corners: each stretch of it fenced once', () => {
  // x = 40: R2 and T from 8.5 to 30, R2 and U from 30 to 50, U alone from 50 to 60
  const at40 = linesAtX(40);
  const metres = at40.reduce((s, [z0, z1]) => s + z1 - z0, 0);
  near(metres, 60 - (FRONT + FENCE_BACK), `the fence along x = 40, once (${JSON.stringify(at40)})`);
  for (let i = 1; i < at40.length; i++) assert.ok(at40[i][0] >= at40[i - 1][1] - 0.01, `no two along each other: ${JSON.stringify(at40)}`);
});

test('a lot set behind another: its driveway up its handle, and the lot isn\'t taken as convex', () => {
  const u = lotOf('U');
  assert.ok(u.drive?.handle, `U's driveway is up its handle: ${JSON.stringify(u.drive)}`);
  // Its frame runs along A St from U's middle (x = 47): the handle is 7 to 11 m along
  near(u.drive.a, 9, 'up the handle\'s middle');
  assert.ok(u.drive.w <= 3 && u.drive.w >= 2.4, `its width ${u.drive.w}`);
  near(u.drive.d0, FRONT, 'from the front line');
  assert.ok(u.drive.d1 > 30 && u.drive.d1 < 36, `to where the handle opens, short of the house: ${u.drive.d1}`);
  const [lo, hi] = acrossAt(u, 20);
  near(lo, 7, 'the handle\'s west side at 20 m'); near(hi, 11, 'and its east side');
  // T in front keeps its own driveway up the side away from the handle, or none
  const t = lotOf('T');
  assert.ok(!t.drive || t.drive.a < 0, `T's driveway, if any, is on its west side: ${JSON.stringify(t.drive)}`);
});

test('two houses on one real lot: each a lot within it as the map gives it, a fence between them, and none outside it', () => {
  const v1 = lotOf('V1'), v2 = lotOf('V2');
  for (const [name, lot] of [['V1', v1], ['V2', v2]]) {
    assert.ok(lot.pts.every((v) => v.x >= 58 - 0.01 && v.x <= 80 + 0.01 && v.z <= 50 + 0.01), `${name}'s lot within the real lot`);
  }
  const between = linesAtX(69.5);
  assert.equal(between.length, 1, `one fence between them: ${JSON.stringify(linesAtX(69.5))}`);
  const west = linesAtX(58);
  near(west.reduce((s, [z0, z1]) => s + z1 - z0, 0), 60 - (FRONT + FENCE_BACK), 'the fence along U\'s side and V\'s, once');
});

test('a house the file couldn\'t fit: its lot from the map, kept off the real lots either side, their fences its own', () => {
  const w = lotOf('W');
  assert.ok(w && !w.real, 'W has a lot worked out from the map');
  const xs = w.pts.map((v) => v.x);
  near(Math.min(...xs), 80, 'kept off V\'s lot'); near(Math.max(...xs), 92, 'and off X\'s');
  assert.equal(linesAtX(80).length, 1, 'one fence along V\'s east side');
  assert.equal(linesAtX(92).length, 1, 'one along X\'s west side');
});

test('a farm\'s lot: its fences only within 60 m of the house', () => {
  for (const at of [280, 330]) {
    const side = linesAtX(at);
    assert.equal(side.length, 1, `a fence along x = ${at}`);
    near(side[0][1], 26 + 60, 'to 60 m behind the house');
  }
  assert.ok(!result.lines.some((f) => f.a.z > 100 && f.b.z > 100 && f.a.x < 400 && f.a.z < 400), 'none at its back');
});

test('a house with no street near: its real lot\'s fences, and no lot to put a front, driveway or things on', () => {
  assert.equal(lotOf('Z'), undefined);
  assert.equal(result.measure.rules.bare, 1);
  const fenced = result.lines.filter((f) => f.a.z >= 489 && f.b.z >= 489);
  assert.equal(fenced.length, 4, `its lot's four sides: ${fenced.length}`);
});

test('with no real lot for any house, the lots are as the map alone gives them', () => {
  const plain = runAll(squareLots(Object.values(HOUSES).map((b) => ({ b, tile })), ENV, SQUARE));
  const none = runAll(squareLots(Object.values(HOUSES).map((b) => ({ b, tile })), { ...ENV, realLots: () => null, realLotsIn: () => [] }, SQUARE));
  const shape = (r) => JSON.stringify({ lots: r.lots.map((l) => ({ pts: l.pts.map((p) => [p.x, p.z]), drive: l.drive })), fences: r.fences, panels: r.panels, slabs: r.slabs });
  assert.equal(shape(none), shape(plain));
});
