import assert from 'node:assert/strict';
import test from 'node:test';
import { FOOTPATH, squareLots } from '../js/house-lots.js';
import { houseEntry } from '../js/house-entry.js';
import { HOUSE_STYLES, STYLE } from '../js/house-styles.js';
import { FENCE, THING, lotThings } from '../js/lot-things.js';

// What stands in each lot (js/lot-things.js), on a street made up for it: A St along x at z = 0, 8 m wide, and on its north side a house
// every 16 m, 10 m wide and 12 m deep, its front 12 m from the street's middle, each of the house styles in turn. Nothing behind them, so
// each lot runs 25 m back.
const KERB = 4.4;
const A = { name: 'A St', width: 8, cls: 7, kind: 0, pts: [{ x: -300, z: 0 }, { x: 300, z: 0 }] };
const tile = { key: '0_0' };
const STYLES = ['Federation', 'Post-war fibro', 'California bungalow', 'Triple-fronted brick veneer', 'Project home', 'Victorian terrace', 'Beach house'];
const HOUSES = [];
for (let i = 0; i < 35; i++) {
  const x0 = -280 + i * 16, x1 = x0 + 10;
  const ring = [{ x: x0, z: 12 }, { x: x1, z: 12 }, { x: x1, z: 24 }, { x: x0, z: 24 }];
  const style = STYLE[STYLES[i % STYLES.length]];
  HOUSES.push({ kind: 1, houseStyle: style, group: 0, bottom: 0, height: 3, floor: 0, polygons: [{ outer: ring, holes: [] }],
    minX: x0, maxX: x1, minZ: 12, maxZ: 24, cx: x0 + 5, cz: 18,
    frontWall: { ax: x1, az: 12, bx: x0, bz: 12, reverse: false, width: 10, digits: (i * 137) % 1000 } });
}
const nearestOn = (x, z) => {
  const t = Math.max(-300, Math.min(300, x));
  return { link: A, x: t, z: 0, d: Math.hypot(x - t, z), ux: 1, uz: 0 };
};
const env = {
  streetOf: (w) => nearestOn(w.cx, w.cz),
  roadsNear: (x, z, r) => [nearestOn(x, z)].filter((n) => n.d <= r),
  kerbFrom: () => KERB,
  groundAt: () => 0, lawnAt: () => 0, pavingAt: () => 0, roadAt: () => 0,
  onLawn: (x, z) => z >= KERB + FOOTPATH,
  sites: []
};
env.lotThings = (lot, near) => lotThings(lot, near, env);
const SQUARE = { x0: -300, z0: -100, x1: 300, z1: 100 };
function run() {
  const job = squareLots(HOUSES.map((b) => ({ b, tile })), env, SQUARE);
  let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
}
const result = run();
const styleOf = (lot) => HOUSE_STYLES[lot.home.house].name;
const inRing = (ring, x, z) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
};
const lotAt = (x, z) => result.lots.find((l) => inRing(l.pts, x, z));

test('front fences by era along the front line, clear of the driveway, holding the walker; none for project homes and beach houses', () => {
  const front = KERB + FOOTPATH;
  const held = result.fences.filter((f) => f.hold === 1.2 && !f.box);
  assert.ok(held.length > 5, `${held.length} front fences and hedges`);
  for (const f of held) {
    assert.ok(Math.abs(f.a.z - f.b.z) < 1e-6 && f.a.z > front && f.a.z < front + 0.5, `along the front line: ${f.a.z}`);
    const lot = lotAt((f.a.x + f.b.x) / 2, f.a.z + 0.05);
    assert.ok(lot, 'in a lot');
    assert.ok(!['Project home', 'Beach house'].includes(styleOf(lot)) || f.a.z > front + 0.3, 'a hedge only, for a project home or beach house');
    const d = lot.drive;
    if (d) {
      const lo = Math.min(f.a.x, f.b.x), hi = Math.max(f.a.x, f.b.x), mid = lot.frame.px + lot.frame.tx * d.a;
      assert.ok(hi <= mid - d.w / 2 || lo >= mid + d.w / 2, 'not across the driveway');
    }
  }
  const kinds = new Set(result.panels.filter((p) => p.kind >= 2).map((p) => p.kind));
  assert.ok(kinds.has(FENCE.picket) && kinds.has(FENCE.palisade), `pickets and palisades among them: ${[...kinds]}`);
  assert.ok(result.things.some((b) => b.kind === THING.brick && b.h < 1.2), 'and low brick walls');
});

test('a garage behind a Federation house or bungalow, its driveway taken on to it; carports beside the post-war houses', () => {
  const garaged = result.lots.filter((l) => l.drive?.garage);
  assert.ok(garaged.length >= 2, `${garaged.length} garages`);
  for (const lot of garaged) {
    assert.ok(['Federation', 'California bungalow'].includes(styleOf(lot)));
    assert.ok(Math.abs(lot.drive.d1 - (lot.home.ext.d1 + 1)) < 1e-6, 'the driveway runs to the garage behind the house');
    const doors = result.things.filter((b) => b.kind === THING.door && inRing(lot.pts, b.x, b.z));
    assert.equal(doors.length, 1, 'with its door');
    assert.ok(result.fences.some((f) => f.box && inRing(lot.pts, f.box.cx, f.box.cz)), 'its walls hold the walker');
  }
  const roofs = result.things.filter((b) => b.kind === THING.iron && b.h < 0.15 && b.y > 2);
  assert.ok(roofs.some((r) => styleOf(lotAt(r.x, r.z)) === 'Post-war fibro'), 'a carport roof beside a post-war house');
});

test('a path from the front gate, or the driveway, to the door', () => {
  let reached = 0;
  for (const lot of result.lots) {
    const entry = houseEntry(lot.home.frontWall, lot.home.house);
    const door = entry.door;
    const near = result.slabs.filter((s) => s.kind === 0 && Math.hypot(s.x - door.x, s.z - door.z) < 1.6 && inRing(lot.pts, s.x, s.z));
    if (near.some((s) => Math.abs(s.z + Math.abs(s.bz) / 2 - door.z) < 0.6 || Math.abs(s.z + Math.abs(s.az) / 2 - door.z) < 0.6)) reached++;
  }
  assert.ok(reached >= result.lots.length * 0.8, `${reached} of ${result.lots.length} lots have a path to the door`);
});

test('every thing stands in its own lot, and out of the house', () => {
  for (const b of result.things) {
    const lot = lotAt(b.x, b.z);
    assert.ok(lot, `a thing at ${b.x.toFixed(1)}, ${b.z.toFixed(1)} is in a lot`);
    const house = lot.home.box;
    // Verandahs and porches stand against the front wall, outside it
    assert.ok(!(b.x > house.x0 + 0.05 && b.x < house.x1 - 0.05 && b.z > house.z0 + 0.05 && b.z < house.z1 - 0.05), 'not inside the house');
  }
});
