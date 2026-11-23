import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';

// Houses fitted to their real lots on NSW's cadastre (tools/lots/fit.mjs, tools/build-lots.mjs), on a made-up block: a street along z = -8,
// lots 15 m wide and 30 m deep behind it, and a house in each, 0.5 m from its side lines, so a shift of the lots more than that puts
// their lines in the houses. The lot files read back as written (tools/lots/pack.mjs, js/tiles/lot-file.js).
const { fitLots, shiftAt } = await import('../tools/lots/fit.mjs');
const { packLots } = await import('../tools/lots/pack.mjs');
const { homeKey, unpackLots } = await import('../js/tiles/lot-file.js');

const rect = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
const house = (ring) => {
  const xs = ring.map((p) => p.x), zs = ring.map((p) => p.z);
  const box = { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
  return { rings: [ring], box, cx: (box.x0 + box.x1) / 2, cz: (box.z0 + box.z1) / 2, area: Math.abs(a / 2) };
};
const lot = (id, ring, plan = 'DP') => ({ id, plan, cls: 1, stratum: 1, rings: [ring] });
const roads = [{ pts: [{ x: -100, z: -8 }, { x: 400, z: -8 }], width: 8 }];

/** The block: `special` lots by number take other lots and houses; the rest a 15 m lot each with a house 0.5 m in from its sides */
function block(special = {}, dx = 0, dz = 0) {
  const lots = [], houses = [];
  for (let k = 0; k < 24; k++) {
    if (special[k] === null) continue;
    if (special[k]) {
      lots.push(...special[k].lots);
      houses.push(...special[k].houses);
      continue;
    }
    lots.push(lot(k, rect(15 * k, 0, 15 * k + 15, 30)));
    houses.push(house(rect(15 * k + 0.5, 6, 15 * k + 14.5, 18)));
  }
  for (const l of lots) l.rings = l.rings.map((r) => r.map((p) => ({ x: p.x + dx, z: p.z + dz })));
  return { lots, houses, roads };
}
const homeOf = (r, h) => r.homes.find((x) => x.house === h);
const lotOf = (r, id) => r.lots.find((l) => l.lot.id === id);

test('a block shifted 2 m: the shift is found, and every house is in its lot', () => {
  const b = block({}, 2, 0);
  const r = fitLots(b);
  const s = shiftAt(r.shifts, 150, 15);
  assert.ok(Math.abs(s.dx + 2) < 0.3 && Math.abs(s.dz) < 0.3, `shift ${s.dx}, ${s.dz}`);
  for (const h of b.houses) assert.equal(homeOf(r, h).rule, 'in');
  assert.equal(r.lots.length, 24);
  // Each lot's line along the street is its frontage, its sides shared with the lots beside it, its back with nothing beyond
  const middle = lotOf(r, 10);
  const kinds = middle.rings[0].map((a, i) => [a, middle.rings[0][(i + 1) % 4], middle.edges[0][i]]);
  for (const [a, c, kind] of kinds) {
    const expect = Math.abs(a.z - c.z) < 0.01 ? (a.z < 10 ? 'front' : 'bound') : 'side';
    assert.equal(kind, expect, `edge ${a.x},${a.z} - ${c.x},${c.z}`);
  }
});

test('a house 1 m over its side line: the line is moved into the gap, straight, the lots either side following', () => {
  const b = block({
    3: { lots: [lot(3, rect(45, 0, 60, 30))], houses: [house(rect(48, 6, 61, 18))] },
    4: { lots: [lot(4, rect(60, 0, 75, 30))], houses: [house(rect(64, 6, 74.5, 18))] }
  });
  const r = fitLots(b);
  const [h3, h4] = [b.houses[3], b.houses[4]];
  assert.equal(homeOf(r, h3).rule, 'moved');
  assert.equal(homeOf(r, h4).rule, 'in');
  assert.ok(homeOf(r, h3).over <= 0.3, `still over by ${homeOf(r, h3).over}`);
  // The line between them is 2 m along (halfway into the 3 m gap would be 2.5, but no line moves more than 2 m), the same in both lots
  for (const id of [3, 4]) {
    const l = lotOf(r, id), ring = l.rings[0];
    const shared = ring.filter((p) => Math.abs(p.x - 62) < 0.05);
    assert.equal(shared.length, 2, `lot ${id}: ${JSON.stringify(ring)}`);
    const i = ring.findIndex((p, k) => Math.abs(p.x - 62) < 0.05 && Math.abs(ring[(k + 1) % ring.length].x - 62) < 0.05);
    assert.equal(l.edges[0][i], 'moved');
  }
  // Its ends slid along the frontage and the back line, which stay straight
  for (const p of lotOf(r, 3).rings[0]) assert.ok(Math.abs(p.z) < 0.01 || Math.abs(p.z - 30) < 0.01);
});

test('a semi drawn as one outline across two lots: both lots are its own, the line between them a shared wall', () => {
  const semi = house(rect(108, 6, 132, 18));
  const b = block({ 7: { lots: [lot(7, rect(105, 0, 120, 30))], houses: [semi] }, 8: { lots: [lot(8, rect(120, 0, 135, 30))], houses: [] } });
  const r = fitLots(b);
  const home = homeOf(r, semi);
  assert.equal(home.rule, 'wall');
  assert.deepEqual(home.lots.map((l) => l.id).sort(), [7, 8]);
  for (const id of [7, 8]) {
    const l = lotOf(r, id), ring = l.rings[0];
    const i = ring.findIndex((p, k) => Math.abs(p.x - 120) < 0.05 && Math.abs(ring[(k + 1) % ring.length].x - 120) < 0.05);
    assert.equal(l.edges[0][i], 'wall');
    assert.deepEqual(l.homes, [home]);
  }
});

test('a row of six drawn as one outline: each of its lots holds under a fifth of it, and it still stands on their lines', () => {
  const row = house(rect(150.5, 6, 239.5, 18));
  const special = { 10: { lots: [], houses: [row] } };
  for (let k = 10; k < 16; k++) special[k] = { lots: [lot(k, rect(15 * k, 0, 15 * k + 15, 30))], houses: k === 10 ? [row] : [] };
  const r = fitLots(block(special));
  assert.equal(homeOf(r, row).rule, 'wall');
  assert.equal(homeOf(r, row).lots.length, 6);
});

test('a house 2.5 m over: a fallback, with no lot of its own', () => {
  const b = block({
    11: { lots: [lot(11, rect(165, 0, 180, 30))], houses: [house(rect(168.5, 6, 182.5, 18))] },
    12: { lots: [lot(12, rect(180, 0, 195, 30))], houses: [house(rect(184, 6, 194.5, 18))] }
  });
  const r = fitLots(b);
  const home = homeOf(r, b.houses[11]);
  assert.equal(home.rule, 'fallback');
  assert.deepEqual(home.lots, []);
  assert.ok(!lotOf(r, 11), 'its lot isn\'t kept');
  assert.equal(homeOf(r, b.houses[12]).rule, 'in');
});

test('a lot set behind another, with its handle to the street: kept for its house, its handle\'s end its frontage', () => {
  const behind = house(rect(227, 36, 238, 48)), front = house(rect(229.5, 6, 239.5, 18));
  const b = block({
    15: { lots: [lot(15, rect(229, 0, 240, 30)),
      lot(115, [{ x: 225, z: 0 }, { x: 229, z: 0 }, { x: 229, z: 30 }, { x: 240, z: 30 }, { x: 240, z: 55 }, { x: 225, z: 55 }])], houses: [front, behind] },
    14: { lots: [lot(14, rect(210, 0, 225, 30))], houses: [house(rect(210.5, 6, 224.5, 18))] }
  });
  const r = fitLots(b);
  assert.equal(homeOf(r, behind).rule, 'in');
  const l = lotOf(r, 115), ring = l.rings[0];
  assert.equal(ring.length, 6);
  const i = ring.findIndex((p, k) => Math.abs(p.z) < 0.05 && Math.abs(ring[(k + 1) % ring.length].z) < 0.05);
  assert.equal(l.edges[0][i], 'front');
  // Along the front lot's side and back: shared
  assert.ok(l.edges[0].filter((e) => e === 'side').length >= 2);
});

test('a strata lot with three houses: several houses\' lot, which the game divides; a shed-sized house on a house\'s lot stands in it', () => {
  const three = [house(rect(271, 8, 279, 17)), house(rect(281, 8, 289, 17)), house(rect(291, 8, 299, 17))];
  const main = house(rect(300.5, 6, 314.5, 18)), flat = house(rect(304, 22, 310, 28));
  const b = block({
    18: { lots: [lot(18, rect(270, 0, 300, 30), 'SP')], houses: three }, 19: null,
    20: { lots: [lot(20, rect(300, 0, 315, 30))], houses: [main, flat] }
  });
  const r = fitLots(b);
  for (const h of three) assert.equal(homeOf(r, h).rule, 'several');
  assert.equal(lotOf(r, 18).kind, 'several');
  assert.equal(lotOf(r, 18).homes.length, 3);
  assert.equal(homeOf(r, flat).rule, 'in');
  assert.equal(lotOf(r, 20).kind, 'fitted');
  assert.equal(lotOf(r, 20).homes[0].house, main, 'the lot\'s own house first');
});

test('a tile\'s lot file reads back as it was written, its houses found by their middles', () => {
  const b = block({ 7: { lots: [lot(7, rect(105, 0, 120, 30))], houses: [house(rect(108, 6, 132, 18))] }, 8: { lots: [lot(8, rect(120, 0, 135, 30))], houses: [] } });
  const r = fitLots(b);
  // As tools/build-lots.mjs writes it, for tile (0, 0)
  const homes = [...r.homes].sort((a, c) => a.house.cz - c.house.cz || a.house.cx - c.house.cx);
  const at = new Map(homes.map((h, i) => [h, i]));
  const file = { homes: homes.map((h) => ({ x: h.house.cx, z: h.house.cz, rule: h.rule })),
    lots: r.lots.map((l) => ({ kind: l.kind, homes: l.homes.map((h) => at.get(h)), rings: l.rings, edges: l.edges })) };
  const back = unpackLots(zlib.gunzipSync(zlib.gzipSync(packLots(file, 0, 0))), 0, 0);
  assert.equal(back.homes.length, file.homes.length);
  file.homes.forEach((h, i) => {
    assert.equal(back.homes[i].rule, h.rule);
    assert.equal(back.homes[i].key, homeKey(0, 0, h.x, h.z));
  });
  assert.equal(back.lots.length, file.lots.length);
  file.lots.forEach((l, i) => {
    const m = back.lots[i];
    assert.equal(m.kind, l.kind);
    assert.deepEqual(m.homes, l.homes);
    assert.deepEqual(m.edges, l.edges);
    l.rings.forEach((ring, k) => ring.forEach((p, j) => assert.ok(Math.hypot(p.x - m.rings[k][j].x, p.z - m.rings[k][j].z) <= 0.071)));
    // Outer rings counter-clockwise
    let a = 0;
    const ring = m.rings[0];
    for (let q = 0, j = ring.length - 1; q < ring.length; j = q++) a += ring[j].x * ring[q].z - ring[q].x * ring[j].z;
    assert.ok(a > 0);
  });
  // The semi's two lots both list it
  const semi = back.homes.findIndex((h) => h.rule === 'wall');
  assert.equal(back.homes[semi].lots.length, 2);
  // Homes in another tile's corner: the same keys, the points as far off as they are
  const far = unpackLots(packLots(file, -3, 2), -3, 2);
  file.homes.forEach((h, i) => assert.equal(far.homes[i].key, homeKey(-3, 2, h.x, h.z)));
});
