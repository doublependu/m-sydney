import assert from 'node:assert/strict';
import test from 'node:test';
import { FENCE_BACK, FOOTPATH, insideSpans, squareLots } from '../js/house-lots.js';
import { houseEntry } from '../js/house-entry.js';
import { STYLE } from '../js/house-styles.js';

// The lots of houses worked out from footprints and streets (js/house-lots.js), on a street made up for it:
//   A St along x at z = 0, 8 m wide; B St along z at x = 60, its corner; C St along x at z = 70, behind.
//   On A St's north side, houses 14 m deep with their fronts 12 m from its middle: Z, A and B 4 m apart, B and C 0.8 m apart, a shed
//   behind the gap between C and D, and D on the corner of B St. Behind A, a house facing C St.
const KERB = 4.4; // m from a street's middle: half its 8 m and the kerb's 0.4
const road = (name, pts) => ({ name, width: 8, cls: 7, kind: 0, pts: pts.map(([x, z]) => ({ x, z })) });
const ROADS = [road('A St', [[-80, 0], [80, 0]]), road('B St', [[60, -80], [60, 120]]), road('C St', [[-80, 70], [56, 70]])];
const tile = { key: '0_0' };
const box = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
const building = (ring, extra = {}) => {
  const xs = ring.map((p) => p.x), zs = ring.map((p) => p.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  return { kind: 1, houseStyle: STYLE['Post-war fibro'], group: 0, bottom: 0, height: 3, polygons: [{ outer: ring, holes: [] }],
    minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, ...extra };
};
const HOUSES = {
  Z: building(box(-20, 12, -10, 26)),
  A: building(box(0, 12, 10, 26)),
  B: building(box(14, 12, 24, 26)),
  C: building(box(24.8, 12, 34.8, 26)),
  D: building(box(37, 12, 45, 24)),
  behind: building(box(0, 44, 10, 58)),
  shed: building(box(34.5, 28, 37.5, 31), { kind: 4, houseStyle: 0 })
};

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
const env = {
  streetOf: (w) => ROADS.map((r) => nearestOn(r, w.cx, w.cz)).sort((a, b) => a.d - b.d)[0],
  roadsNear: (x, z, r) => ROADS.map((l) => nearestOn(l, x, z)).filter((n) => n.d <= r),
  kerbFrom: () => KERB,
  groundAt: () => 0, lawnAt: () => 0, pavingAt: () => 0, roadAt: () => 0,
  // The lawn starts FOOTPATH past each kerb
  onLawn: (x, z) => ROADS.every((l) => nearestOn(l, x, z).d >= KERB + FOOTPATH),
  sites: []
};
const SQUARE = { x0: -100, z0: -100, x1: 100, z1: 100 };

function run(houses = HOUSES) {
  const job = squareLots(Object.values(houses).map((b) => ({ b, tile })), env, SQUARE);
  let yields = 0, step = job.next();
  while (!step.done) { yields++; step = job.next(); }
  return { ...step.value, yields };
}
const lotOf = (result, b) => result.lots.find((l) => l.home.pieces.includes(b));
// The fences along x = at (within 0.05 m), and those along z = at
const fencesAtX = (result, at) => result.fences.filter((f) => Math.abs(f.a.x - at) < 0.05 && Math.abs(f.b.x - at) < 0.05);

test('a fence halfway between two houses, square to their street, from 2 m behind the front line to the line halfway to the house behind', () => {
  const result = run();
  const between = fencesAtX(result, 12);
  assert.equal(between.length, 1, 'one fence between A and B, at x = 12');
  const [f] = between;
  const front = KERB + FOOTPATH;
  assert.ok(Math.abs(Math.min(f.a.z, f.b.z) - (front + FENCE_BACK)) < 0.05, `it starts ${FENCE_BACK} m behind the front line: ${Math.min(f.a.z, f.b.z)}`);
  // A's back line is halfway to the house behind it, at z = 35: the fence between A and B runs at least that far
  assert.ok(Math.max(f.a.z, f.b.z) >= 35 - 0.05, `it runs back to the line behind: ${Math.max(f.a.z, f.b.z)}`);
  const a = lotOf(result, HOUSES.A);
  assert.ok(a.pts.every((p) => p.z <= 35 + 0.01), 'A\'s lot stops halfway to the house behind');
  assert.ok(result.fences.some((g) => Math.abs(g.a.z - 35) < 0.05 && Math.abs(g.b.z - 35) < 0.05), 'and a fence along it');
});

test('no fence between houses less than 1.2 m apart', () => {
  const result = run();
  assert.equal(fencesAtX(result, 24.4).length, 0);
  assert.ok(lotOf(result, HOUSES.B) && lotOf(result, HOUSES.C), 'they have lots all the same');
});

test('a fence is cut where a shed stands on its line, and never goes through a building', () => {
  const result = run();
  const between = fencesAtX(result, 35.9);
  assert.ok(between.length >= 2, 'the fence between C and D is in pieces either side of the shed');
  const rings = Object.values(HOUSES).map((b) => b.polygons[0].outer);
  for (const f of result.fences) {
    const L = Math.hypot(f.b.x - f.a.x, f.b.z - f.a.z);
    const inside = insideSpans(f.a, f.b, rings).reduce((sum, [t0, t1]) => sum + (t1 - t0) * L, 0);
    assert.ok(inside < 0.01, `a fence from (${f.a.x}, ${f.a.z}) goes ${inside} m through a building`);
  }
});

test('a corner lot stops at the side street\'s front line, with a fence along it', () => {
  const result = run();
  const d = lotOf(result, HOUSES.D);
  const side = 60 - KERB - FOOTPATH - 0.3;
  const most = Math.max(...d.pts.map((p) => p.x));
  assert.ok(Math.abs(most - side) < 0.05, `D's lot reaches x = ${most}, the side street's front line less 0.3 m being ${side}`);
  assert.ok(fencesAtX(result, side).length >= 1, 'a fence along B St');
  // None of it on any street's footpath
  for (const f of result.fences) {
    for (const t of [0, 0.5, 1]) {
      const x = f.a.x + (f.b.x - f.a.x) * t, z = f.a.z + (f.b.z - f.a.z) * t;
      assert.ok(env.onLawn(x, z), `a fence point (${x}, ${z}) on a footpath`);
    }
  }
});

test('a driveway up a side gap of 3 m or more, with its crossover and layback; none where there\'s no room', () => {
  const result = run();
  const a = lotOf(result, HOUSES.A);
  assert.ok(a.drive, 'A has 5 m to the line between it and Z');
  assert.equal(a.drive.side, a.frame.tx > 0 ? -1 : 1, 'on its side towards Z');
  const middle = a.frame.px + a.frame.tx * a.drive.a;
  assert.ok(middle > -5 && middle < 0, `in the gap: x = ${middle}`);
  assert.ok(Math.abs(a.drive.d0 - (KERB + FOOTPATH)) < 0.05 && a.drive.d1 > 12 + 3, 'from the front line to past the front wall');
  assert.equal(lotOf(result, HOUSES.B).drive, null, 'B has 2 m one side and 0.4 the other');
  // Each driveway's slabs: up the lot, across the footpath, and the layback over the kerb
  const kinds = new Set(result.slabs.map((s) => s.kind));
  assert.deepEqual([...kinds].sort(), [0, 1, 2]);
});

test('a project home\'s driveway goes to its garage door, where the facade draws it', () => {
  // A project home 12 m across, its front wall facing A St from x = 0 to 12 (its bays counted from x = 0)
  const front = { ax: 0, az: 12, bx: 12, bz: 12, reverse: false, width: 12, digits: 37 };
  const house = building(box(0, 12, 12, 26), { houseStyle: STYLE['Project home'], frontWall: front });
  const result = run({ house, Z: HOUSES.Z, B: building(box(13, 12, 23, 26)) });
  const lot = lotOf(result, house);
  const entry = houseEntry(front, STYLE['Project home']);
  assert.ok(entry.garage, 'it has a garage door');
  assert.equal(lot.drive.side, 0);
  assert.ok(Math.abs(lot.frame.px + lot.frame.tx * lot.drive.a - entry.garage.x) < 0.01, 'in front of the garage door');
  assert.ok(Math.abs(lot.drive.d1 - 12) < 0.01, 'up to the front wall');
});

test('the work yields as it goes, as js/buildings.js addBuildings() does', () => {
  const many = {};
  for (let i = 0; i < 30; i++) many[i] = building(box(-76 + i * 3.8, 12, -73 + i * 3.8, 24));
  const result = run(many);
  assert.ok(result.yields >= 30, `${result.yields} yields for 30 houses`);
  assert.equal(result.lots.length, 30);
});
