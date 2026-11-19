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
  // The nearest street, or the one a building's `faces` names
  streetOf: (w) => {
    const named = ROADS.find((r) => r.name === w.pieces[0].faces);
    return named ? nearestOn(named, w.cx, w.cz) : ROADS.map((r) => nearestOn(r, w.cx, w.cz)).sort((a, b) => a.d - b.d)[0];
  },
  roadsNear: (x, z, r) => ROADS.map((l) => nearestOn(l, x, z)).filter((n) => n.d <= r),
  kerbFrom: () => KERB,
  groundAt: () => 0, lawnAt: () => 0, pavingAt: () => 0, roadAt: () => 0,
  // The lawn starts FOOTPATH past each kerb
  onLawn: (x, z) => ROADS.every((l) => nearestOn(l, x, z).d >= KERB + FOOTPATH),
  sites: []
};
const SQUARE = { x0: -100, z0: -100, x1: 100, z1: 100 };

function run(houses = HOUSES, extra = {}) {
  const job = squareLots(Object.values(houses).map((b) => ({ b, tile })), { ...env, ...extra }, SQUARE);
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

// --- Lots that don't overlap: each fence as the lot's edges have it, before the cut, kept off every building -----------------------

const ring = (...pts) => pts.map(([x, z]) => ({ x, z }));
// The part of convex ring `clip` that `subject` covers, and a ring's area
const areaOf = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j].x - r[i].x) * (r[j].z + r[i].z); return s / 2; };
function clipped(subject, clip) {
  let out = subject;
  const s = Math.sign(areaOf(clip));
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const side = (p) => s * ((b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x));
    const inp = out;
    out = [];
    for (let k = 0; k < inp.length; k++) {
      const p = inp[k], q = inp[(k + 1) % inp.length], sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t }); }
    }
  }
  return Math.abs(areaOf(out));
}
// Each line before the cut that runs 0.3 m or more inside a building other than its own house: [{ line, inside, building }]
function intoBuildings(result, houses) {
  const out = [];
  for (const line of result.lines) {
    const L = Math.hypot(line.b.x - line.a.x, line.b.z - line.a.z);
    for (const [name, b] of Object.entries(houses)) {
      if (b.kind === 4 || line.homes.some((h) => h.pieces.includes(b))) continue;
      const inside = insideSpans(line.a, line.b, [b.polygons[0].outer]).reduce((sum, [t0, t1]) => sum + (t1 - t0) * L, 0);
      if (inside >= 0.3) out.push({ line: `${line.kind?.line ? 'pair' : line.kind} (${line.a.x.toFixed(1)}, ${line.a.z.toFixed(1)}) to (${line.b.x.toFixed(1)}, ${line.b.z.toFixed(1)})`, inside: +inside.toFixed(2), building: name });
    }
  }
  return out;
}
const maxZ = (lot) => Math.max(...lot.pts.map((p) => p.z));
const minZ = (lot) => Math.min(...lot.pts.map((p) => p.z));

test('a house behind, too far to one side to be chosen: the lot stops at the line halfway to it, and no line goes into it', () => {
  // P's back neighbour would need 2 m of its width behind it: H has 1.5 m. Q, beside P, chooses H.
  const houses = { Z: building(box(-14, 12, -4, 26)), P: building(box(0, 12, 10, 26)), Q: building(box(14, 12, 24, 26)), H: building(box(8.5, 40, 18.5, 54)) };
  const result = run(houses, { lines: true });
  const p = lotOf(result, houses.P);
  assert.ok(maxZ(p) <= 33 + 0.01, `P's lot reaches z = ${maxZ(p).toFixed(2)}, past the line halfway to H at 33`);
  assert.deepEqual(intoBuildings(result, houses), []);
});

test('back-to-back houses in two streets, staggered so none chooses another: no two lots overlap, and one fence runs between them', () => {
  // A St's houses 10 m wide; C St's 6 m wide in line with A St's gaps, so each has 1 m of another's width behind it
  const houses = {
    F1: building(box(0, 12, 10, 26)), F2: building(box(14, 12, 24, 26)), F3: building(box(28, 12, 38, 26)),
    B0: building(box(-5, 44, 1, 58)), B1: building(box(9, 44, 15, 58)), B2: building(box(23, 44, 29, 58))
  };
  const result = run(houses, { lines: true });
  for (let i = 0; i < result.lots.length; i++) {
    for (let j = i + 1; j < result.lots.length; j++) {
      const a = result.lots[i], b = result.lots[j], area = clipped(a.pts, b.pts);
      assert.ok(area < 1, `the lots of (${a.home.cx}, ${a.home.cz}) and (${b.home.cx}, ${b.home.cz}) overlap by ${area.toFixed(1)} m²`);
    }
  }
  // Halfway between the backs of the two rows, z = 35
  for (const k of ['F1', 'F2', 'F3']) assert.ok(maxZ(lotOf(result, houses[k])) <= 35.01, `${k}'s lot reaches z = ${maxZ(lotOf(result, houses[k])).toFixed(2)}`);
  for (const k of ['B0', 'B1', 'B2']) assert.ok(minZ(lotOf(result, houses[k])) >= 34.99, `${k}'s lot reaches z = ${minZ(lotOf(result, houses[k])).toFixed(2)}`);
  const along = result.fences.filter((f) => Math.abs(f.a.z - 35) < 0.05 && Math.abs(f.b.z - 35) < 0.05);
  const metres = along.reduce((sum, f) => sum + Math.abs(f.b.x - f.a.x), 0);
  assert.ok(metres >= 36, `${metres.toFixed(1)} m of fence along z = 35, from behind F1 to behind F3`);
  assert.deepEqual(intoBuildings(result, houses), []);
});

test('a pair where one lot runs further back than the other\'s line with the house behind it: no line goes into that house', () => {
  // P chooses H, behind it; Q, beside P, doesn't (H is beside Q's width, not behind it), but H reaches 1 m past P and Q's line
  const houses = { P: building(box(0, 12, 10, 26)), Q: building(box(14, 12, 24, 26)), H: building(box(2, 36, 13, 50)) };
  const result = run(houses, { lines: true });
  assert.ok(maxZ(lotOf(result, houses.Q)) <= 31.01, `Q's lot reaches z = ${maxZ(lotOf(result, houses.Q)).toFixed(2)}, past H`);
  assert.deepEqual(intoBuildings(result, houses), []);
});

test('a corner house over its side street\'s line: its side fence runs only behind it, from its back wall', () => {
  // K faces A St and stands 2.2 m over B St's front line (less 0.3 m, x = 51.8)
  const houses = { J: building(box(30, 12, 40, 26)), K: building(box(44, 12, 54, 24), { faces: 'A St' }) };
  const result = run(houses, { lines: true });
  const side = 60 - KERB - FOOTPATH - 0.3;
  const onSide = (f) => Math.abs(f.a.x - side) < 0.05 && Math.abs(f.b.x - side) < 0.05;
  const lines = result.lines.filter(onSide), fences = result.fences.filter(onSide);
  assert.ok(lines.length >= 1 && fences.length >= 1, 'a fence along B St');
  for (const f of [...lines, ...fences]) {
    assert.ok(Math.min(f.a.z, f.b.z) >= 24 - 0.01, `a fence along B St from z = ${Math.min(f.a.z, f.b.z).toFixed(2)}, in front of K's back wall at 24`);
  }
  assert.ok(Math.max(...fences.map((f) => Math.max(f.a.z, f.b.z))) > 40, 'on to the back of the lot');
});

test('an L-shaped neighbour that no straight line separates from a house: neither lot is clipped by it, and it\'s listed', () => {
  // L wraps round A0's back and its right side, 2 m off it
  const L = building(ring([12, 12], [22, 12], [22, 36], [0, 36], [0, 30], [12, 30]));
  const houses = { Z0: building(box(-14, 12, -4, 26)), A0: building(box(0, 12, 10, 26)), L };
  const result = run(houses, { lines: true });
  const a = lotOf(result, houses.A0);
  assert.ok(maxZ(a) > 50, `A0's lot reaches its full depth behind it, z = ${maxZ(a).toFixed(1)}`);
  assert.ok(Math.max(...a.pts.map((p) => p.x)) > 22, 'and past L to its right');
  const listed = result.measure.unseparated.some((u) => [u.home, u.other].some((w) => w.pieces.includes(houses.A0)) && [u.home, u.other].some((w) => w.pieces.includes(L)));
  assert.ok(listed, 'A0 and L are listed as a pair no straight line separates');
  assert.ok(result.measure.rounds <= 4, `${result.measure.rounds} rounds`);
});
