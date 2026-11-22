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

// A row of six terraces the map draws as one footprint (Victorian terrace, 33 m along A St, 12 m deep, its front 11 m from the street's
// middle, so 3.1 m of front yard): the facade cuts it into houses (js/house-entry.js), and its lot is cut the same way.
test('a row of terraces drawn as one footprint: a lot for each house, its own front fence, gate and letterbox, and fences between their yards', () => {
  const ring = [{ x: 0, z: 11 }, { x: 33, z: 11 }, { x: 33, z: 23 }, { x: 0, z: 23 }];
  const row = { kind: 1, houseStyle: STYLE['Victorian terrace'], group: 0, bottom: 0, height: 6, floor: 0, polygons: [{ outer: ring, holes: [] }],
    minX: 0, maxX: 33, minZ: 11, maxZ: 23, cx: 16.5, cz: 17, frontWall: { ax: 33, az: 11, bx: 0, bz: 11, reverse: true, width: 33, digits: 100 } };
  const job = squareLots([{ b: row, tile }], env, SQUARE);
  let step = job.next();
  while (!step.done) step = job.next();
  const { lots, things, panels, fences, slabs } = step.value;
  assert.equal(lots.length, 1);
  const [lot] = lots, entry = houseEntry(row.frontWall, row.houseStyle);
  assert.equal(entry.row.houses, 6);
  assert.equal(lot.units.length, 6);
  assert.equal(lot.drive, null);
  for (const [k, unit] of lot.units.entries()) {
    // Its own stretch of the row's lot, with its door on its front
    const { door } = entry.row.units[k];
    assert.ok(inRing(unit.pts, door.x, door.z + 1), `house ${k}'s door is in its lot`);
    // The end houses' lots take in what the row's lot has beyond its ends
    const xs = unit.pts.map((p) => p.x);
    if (k > 0 && k < 5) assert.ok(Math.max(...xs) - Math.min(...xs) < 7.5, `house ${k}'s lot is ${Math.max(...xs) - Math.min(...xs)} m wide`);
  }
  // Front fences (a palisade on most), each in one house's lot, with a gate at that house's door
  const front = fences.filter((f) => f.hold === 1.2);
  assert.ok(front.length >= 3, `${front.length} front fences`);
  for (const f of front) {
    const unit = lot.units.find((u) => inRing(u.pts, (f.a.x + f.b.x) / 2, (f.a.z + f.b.z) / 2 + 0.05));
    assert.ok(unit, 'in a house\'s lot');
    const door = entry.row.units[unit.index].door;
    assert.ok(Math.min(f.a.x, f.b.x) >= door.x + 0.4 || Math.max(f.a.x, f.b.x) <= door.x - 0.4, 'clear of its gate');
  }
  // A letterbox in most of their lots, beside the gate
  const boxes = things.filter((b) => b.small && b.h > 0.8 && b.h < 1.3);
  assert.ok(boxes.length >= 4, `${boxes.length} letterboxes`);
  // Timber fences between their back yards: square to the street, behind the row, never through it
  // (the lot's back fence, 25 m behind the row, runs along the street)
  const yards = panels.filter((p) => p.kind === 1 && Math.abs(p.ux) < 1e-6);
  assert.ok(yards.length >= 5 * 4, `${yards.length} panels between yards`);
  for (const p of yards) {
    assert.ok(p.z - p.length / 2 > 23, `behind the row: ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`);
    assert.ok(lot.units.slice(0, -1).some((u, k) => Math.abs(p.x - entry.row.units[k].a1.x) < 0.01), 'where two houses meet');
  }
  assert.ok(!slabs.some((s) => s.kind === 1), 'no crossover: no driveway');
});

// Steps up to a door its floor left over the ground (its cut into the slope stopped at MAX_CUT: js/building-floor.js doorFloor()): only
// where the tiles give its street address, so on tiles without them every lot is as it was
test('steps up to a door its floor left over the ground: risers of 0.18 m at most, a landing at the door, the path to their foot; none over 3 m', () => {
  const raised = (floor, address) => HOUSES.map((b) => ({ b: { ...b, floor, address: address ? [{ x: b.cx, z: 0, wall: 0, number: '7' }] : undefined }, tile }));
  const runWith = (entries) => {
    const job = squareLots(entries, env, SQUARE);
    let step = job.next();
    while (!step.done) step = job.next();
    return step.value;
  };
  // No address: as before, whatever the floor
  assert.equal(runWith(raised(1.5, false)).treads.length, 0);
  // 1.5 m up: steps for every house with a door
  const up = runWith(raised(1.5, true));
  let flights = 0;
  for (const lot of up.lots) {
    const things = lotThings(lot, [{ rings: lot.home.rings, whole: lot.home }], env);
    if (!things.steps) continue;
    flights++;
    assert.ok(things.steps.kind === 'straight' || things.steps.kind === 'along', `${styleOf(lot)}: ${things.steps.kind}`);
    const sill = 1.5 + 0.22;
    const tops = things.treads.map((t) => t.y).sort((a, b) => a - b);
    // The landing at the door's sill, and every riser 0.18 m at most, from the lawn (0.24 over the ground, 0 here) up
    assert.ok(Math.abs(tops.at(-1) - (sill - 0.02)) < 1e-6);
    const rises = [tops[0] - 0.24, ...tops.slice(1).map((y, i) => y - tops[i])];
    assert.ok(rises.every((r) => r <= 0.18 + 1e-6), `${styleOf(lot)}: risers ${rises.map((r) => r.toFixed(3))}`);
    // The landing's at the door, outside the house
    const entry = houseEntry(lot.home.frontWall, lot.home.house);
    const landing = things.treads.find((t) => Math.abs(t.y - (sill - 0.02)) < 1e-6);
    assert.ok(Math.hypot(landing.x - entry.door.x, landing.z - entry.door.z) < 1.0 && landing.z < 12, `${styleOf(lot)}: the landing at ${landing.x.toFixed(1)}, ${landing.z.toFixed(1)}`);
    // Each tread a block from the ground up, among the things drawn
    assert.ok(things.treads.every((t) => things.boxes.some((b) => Math.abs(b.x - t.x) < 1e-9 && Math.abs(b.z - t.z) < 1e-9 && Math.abs(b.y + b.h - t.y) < 1e-6)));
  }
  assert.ok(flights >= up.lots.length * 0.8, `${flights} of ${up.lots.length} lots have steps`);
  // ...and the square's treads are in its result, for the ground's lookup (js/lot-details.js groundOf())
  assert.ok(up.treads.length >= flights * 9);
  // A door more than 3 m up has none
  const high = runWith(raised(3.2, true));
  assert.equal(high.treads.length, 0);
  assert.ok(high.lots.every((lot) => lotThings(lot, [{ rings: lot.home.rings, whole: lot.home }], env).steps?.kind !== 'straight'));
});

test('steps down a front that falls away to the street, along the wall where the yard is short: none over 0.18 m', () => {
  // The ground 1.2 m under the floor at the front wall (z = 12), falling 0.25 m a metre towards the street
  const fall = (x, z) => Math.min(0, (z - 12) * 0.25) - 1.2;
  const sloped = { ...env, groundAt: fall, lawnAt: fall };
  sloped.lotThings = (lot, near) => lotThings(lot, near, sloped);
  const job = squareLots(HOUSES.map((b) => ({ b: { ...b, address: [{ x: b.cx, z: 0, wall: 0, number: '7' }] }, tile })), sloped, SQUARE);
  let step = job.next();
  while (!step.done) step = job.next();
  let flights = 0;
  const kinds = {};
  for (const lot of step.value.lots) {
    const things = lotThings(lot, [{ rings: lot.home.rings, whole: lot.home }], sloped);
    kinds[things.steps?.kind ?? 'no'] = (kinds[things.steps?.kind ?? 'no'] || 0) + 1;
    if (!things.treads.length) continue;
    flights++;
    const tops = things.treads.map((t) => ({ y: t.y, z: t.z })).sort((a, b) => a.y - b.y);
    // The lowest tread over the lawn at its foot (straight out, 0.15 m past it; along the wall, beside it, as level as the wall is
    // here), every riser after, 0.18 m at most
    const foot = (things.steps.kind === 'straight' ? fall(0, tops[0].z - 0.14 - 0.15) : fall(0, tops[0].z)) + 0.24;
    const rises = [tops[0].y - foot, ...tops.slice(1).map((t, i) => t.y - tops[i].y)];
    assert.ok(rises.every((r) => r <= 0.18 + 1e-6), `${styleOf(lot)}, ${things.steps.kind}: risers ${rises.map((r) => r.toFixed(3))}`);
  }
  assert.ok(flights > 0, JSON.stringify(kinds));
});
