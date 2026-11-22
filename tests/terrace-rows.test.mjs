import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import zlib from 'node:zlib';

// Rows of terraces the map draws as one footprint, cut into their houses at their street addresses (tools/terrace-rows.mjs), before the
// addresses are matched to the buildings (tools/addresses.mjs) in tools/build-buildings.mjs.
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { cutRows, splitAlong, MIN_HOUSE } = await import('../tools/terrace-rows.mjs');
const { matchAddresses } = await import('../tools/addresses.mjs');
const { numberText, outerWalls, parseNumber } = await import('../js/addresses.js');
const { coplanarWalls } = await import('./helpers/coplanar-walls.mjs');
const { polygonContains } = await import('../js/building-collision.js');
const { unpackTile } = await import('../js/tiles/tile-file.js');
const { tileFile } = await import('../js/tiles/paths.js');

const ROADS = [
  { name: 'A STREET', pts: [[-50, 0], [200, 0]], onGround: true },
  { name: 'C LANE', pts: [[-50, 40], [200, 40]], onGround: true }
];
const box = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x0, z: z1 }, { x: x1, z: z1 }, { x: x1, z: z0 }];
const row = (ring, extra = {}) => ({ outline: [{ outer: ring, holes: [] }], area: 400, height: 7, kind: 1, group: 0, bottom: 0, house: true, terrace: true, ...extra });
const at = (x, z, number, street = 'A STREET', addresses = 1) => ({ x, z, street, number: parseNumber(number), addresses });
const area = (ring) => { let a = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j].x * ring[i].z - ring[i].x * ring[j].z; return a / 2; };
const turned = (p, a, ox = 0, oz = 0) => ({ x: ox + p.x * Math.cos(a) - p.z * Math.sin(a), z: oz + p.x * Math.sin(a) + p.z * Math.cos(a) });
const snap = (p) => ({ x: Math.round(p.x * 2) / 2, z: Math.round(p.z * 2) / 2 });

test('a row of four along its street is cut into four houses halfway between their points, square to its front', () => {
  // 24 m along A St, 5 m back from it, 20 m deep; each house's point in its middle
  const records = [row(box(0, 5, 24, 25))];
  const points = [at(3, 15, '1'), at(9, 15, '3'), at(15, 15, '5'), at(21, 15, '7')];
  const { cuts, stats } = cutRows(records, points, ROADS);
  assert.deepEqual([stats.cut, stats.houses], [1, 4]);
  const west = (p) => Math.min(...p.outer.map((q) => q.x));
  const pieces = cuts.get(0).sort((p, q) => west(p) - west(q));
  assert.deepEqual(pieces.map((p) => p.numbers.join()), ['1', '3', '5', '7']);
  for (const [k, p] of pieces.entries()) {
    const xs = p.outer.map((q) => q.x);
    assert.deepEqual([Math.min(...xs), Math.max(...xs)], [6 * k, 6 * k + 6], `house ${k}`);
    assert.equal(Math.sign(area(p.outer)), Math.sign(area(records[0].outline[0].outer)), 'wound as the row is');
  }
  assert.equal(pieces.reduce((s, p) => s + Math.abs(area(p.outer)), 0), 480);
});

test('a row\'s houses share their walls, back to back, and no wall is drawn twice', () => {
  // Turned 23 degrees off the grid, its corners on the 0.5 m grid as the build keeps them
  const a = (23 * Math.PI) / 180;
  const ring = box(0, 5, 30, 25).map((p) => snap(turned(p, a, 100, 0)));
  const roads = [{ name: 'A STREET', pts: [turned({ x: -50, z: 0 }, a, 100, 0), turned({ x: 200, z: 0 }, a, 100, 0)].map((p) => [p.x, p.z]), onGround: true }];
  const points = [3, 9, 15, 21, 27].map((s, k) => ({ ...turned({ x: s, z: 15 }, a, 100, 0), street: 'A STREET', number: parseNumber(String(2 * k + 1)), addresses: 1 }));
  const { cuts } = cutRows([row(ring)], points, roads);
  const pieces = cuts.get(0);
  assert.equal(pieces.length, 5);
  for (const p of pieces) for (const q of p.outer) assert.ok(Number.isInteger(q.x * 2) && Number.isInteger(q.z * 2), 'on the grid');
  // Each new corner near the row's wall it's on
  const walls = outerWalls([{ outer: ring, holes: [] }]);
  const off = (q) => Math.min(...walls.map((w) => { const dx = w.b.x - w.a.x, dz = w.b.y - w.a.y; return Math.abs((q.x - w.a.x) * dz - (q.z - w.a.y) * dx) / w.width; }));
  for (const p of pieces) for (const q of p.outer) assert.ok(off(q) < 0.3, `(${q.x}, ${q.z}) is ${off(q).toFixed(2)} m off the row's walls`);
  // Neighbours share their wall's two corners
  for (let k = 1; k < pieces.length; k++) {
    const shared = pieces[k].outer.filter((q) => pieces[k - 1].outer.some((r) => r.x === q.x && r.z === q.z));
    assert.equal(shared.length, 2, `houses ${k - 1} and ${k}`);
  }
  const asTiles = pieces.map((p) => ({ height: 7, bottom: 0, polygons: [{ outer: p.outer, holes: [] }] }));
  assert.deepEqual(coplanarWalls(asTiles), []);
  // ...and each house its own number after the match
  const { address } = matchAddresses(pieces.map((p) => row(p.outer)), points, roads);
  assert.equal(address.size, 5);
  assert.deepEqual([...address.values()].map((list) => numberText(list[0].number)).sort(), ['1', '3', '5', '7', '9']);
});

test('a row with its back in wings and light wells is cut between them, each house in one outline', () => {
  // Three houses of 6 m, each with a 3 m wing at the back on its west side
  const ring = [{ x: 0, z: 5 }, { x: 0, z: 25 }, { x: 3, z: 25 }, { x: 3, z: 15 }, { x: 6, z: 15 }, { x: 6, z: 25 }, { x: 9, z: 25 }, { x: 9, z: 15 },
    { x: 12, z: 15 }, { x: 12, z: 25 }, { x: 15, z: 25 }, { x: 15, z: 15 }, { x: 18, z: 15 }, { x: 18, z: 5 }];
  const { cuts } = cutRows([row(ring)], [at(3, 10, '2'), at(9, 10, '4'), at(15, 10, '6')], ROADS);
  const pieces = cuts.get(0);
  assert.equal(pieces.length, 3);
  assert.deepEqual(pieces.map((p) => Math.abs(area(p.outer))), [90, 90, 90]);
});

test('a cut through a light well: the house on each side of it is one outline, or the row is left whole', () => {
  // A U at the back, the line through its gap: the piece beyond would be two outlines
  const u = [{ x: 0, z: 5 }, { x: 0, z: 25 }, { x: 4, z: 25 }, { x: 4, z: 12 }, { x: 8, z: 12 }, { x: 8, z: 25 }, { x: 12, z: 25 }, { x: 12, z: 5 }];
  assert.equal(splitAlong(u, 0, 1, { x: 0, y: 5 }, [5]).length, 2, 'short of the gap: two simple pieces');
  assert.equal(splitAlong(u, 1, 0, { x: 0, y: 5 }, [6]).length, 2, 'down through the gap: one piece each side');
  assert.equal(splitAlong(u, 0, 1, { x: 0, y: 5 }, [10]), null, 'across both arms: two pieces beyond the line');
});

test('left whole: one number, numbers in one place, a house not of a terrace style, and a terrace in pieces', () => {
  const ring = box(0, 5, 24, 25);
  const two = [at(3, 15, '1'), at(21, 15, '7')];
  assert.equal(cutRows([row(ring)], [at(3, 15, '1'), at(21, 15, '1')], ROADS).cuts.size, 0, 'one number');
  const units = cutRows([row(ring)], [at(10, 15, '1'), at(11.5, 15, '3'), at(12, 16, '3A')], ROADS);
  assert.deepEqual([units.cuts.size, units.stats.onePlace], [0, 1]);
  assert.equal(cutRows([row(ring, { terrace: false })], two, ROADS).cuts.size, 0, 'a Federation pair');
  assert.equal(cutRows([row(ring, { group: 4 })], two, ROADS).cuts.size, 0, 'with parts over it');
  assert.equal(cutRows([row(ring)], two, ROADS).cuts.size, 1);
});

test('the numbers along its front decide the cut: a lane address in its last house doesn\'t, nor a point too near its end', () => {
  const ring = box(0, 5, 24, 30);
  // 76 C Lane at the back of 7 A St, and three units of 5 at one point
  const west = (p) => Math.min(...p.outer.map((q) => q.x));
  const { cuts } = cutRows([row(ring)], [at(3, 15, '1'), at(9, 15, '3'), at(15, 15, '5', 'A STREET', 3), at(21, 15, '7'), at(21, 28, '76', 'C LANE')], ROADS);
  assert.deepEqual(cuts.get(0).sort((p, q) => west(p) - west(q)).map((p) => p.numbers.join()), ['1', '3', '5', '7']);
  // 9 is 1 m from 7, and 1 m from the row's end: one house with 7
  const end = cutRows([row(ring)], [at(3, 15, '1'), at(9, 15, '3'), at(15, 15, '5'), at(21, 15, '7'), at(23, 15, '9')], ROADS);
  assert.deepEqual(end.cuts.get(0).sort((p, q) => west(p) - west(q)).map((p) => p.numbers.sort().join()), ['1', '3', '5', '7,9']);
  for (const p of end.cuts.get(0)) {
    const xs = p.outer.map((q) => q.x);
    assert.ok(Math.max(...xs) - Math.min(...xs) >= MIN_HOUSE);
    assert.ok(p.outer.length === 4 && polygonContains({ outer: p.outer, holes: [] }, (Math.max(...xs) + Math.min(...xs)) / 2, 6), 'a box with its front 5 m back');
  }
});

test('a cut meeting a step in the row\'s back leaves no sliver along it: 108-116 Buckingham St, Surry Hills', () => {
  // The row as the bases have it, its back stepped at each house, and its addresses; the cut between 112 and 114 meets the step at 290,
  // 1778.5 on the grid, and 114 ran out along the cut and back along the step: walls in one plane with 112's
  const ring = [[300.5, 1771.5], [295, 1771.5], [295, 1775], [290.5, 1775], [290, 1778.5], [280, 1778], [280, 1779.5], [290.5, 1779.5], [290.5, 1782.5],
    [283.5, 1782.5], [283.5, 1786], [271, 1785.5], [272, 1766.5], [300.5, 1767.5]].map(([x, z]) => ({ x, z }));
  const roads = [{ name: 'BUCKINGHAM STREET', pts: [[264, 1700], [262, 1850]], onGround: true }];
  const on = (x, z, n, addresses = 1) => at(x, z, n, 'BUCKINGHAM STREET', addresses);
  const { cuts } = cutRows([row(ring)], [on(286.58, 1768.58, '108'), on(287.29, 1772.28, '110', 3), on(286.99, 1776.13, '112'), on(287.18, 1780.14, '114')], roads);
  const pieces = cuts.get(0);
  assert.deepEqual(pieces.map((p) => p.numbers.join()).sort(), ['108', '110', '112', '114']);
  assert.deepEqual(coplanarWalls(pieces.map((p) => ({ height: 6, bottom: 0, polygons: [{ outer: p.outer, holes: [] }] }))), []);
});

test('a row with another building standing in it is left whole', () => {
  // A house traced over the row, holding its own number
  const { cuts, stats } = cutRows([row(box(0, 5, 24, 25)), row(box(12.5, 6, 17.5, 24), { area: 90, terrace: false })],
    [at(3, 15, '1'), at(9, 15, '3'), at(15, 15, '5'), at(21, 15, '7')], ROADS);
  assert.deepEqual([cuts.size, stats.within], [0, 1]);
});

// On tiles built with the cut: Paddington's row of 44 along Windsor St (51-135), drawn by the map as one footprint, as houses
const world = JSON.parse(fs.readFileSync(new URL('../public/tiles/world.json', import.meta.url), 'utf8'));
const tile = (key) => unpackTile(new Uint8Array(zlib.gunzipSync(fs.readFileSync(new URL(`../public/tiles/${tileFile(key, world.tiles[key])}`, import.meta.url)))),
  world.heights.size, world.ground.size);
// Its two tiles; Windsor St from (2587.5, 950) to (2765.2, 1059.2) in front of it
const paddington = [...tile('2_0').buildings, ...tile('2_1').buildings];
const onWindsor = ({ x, z }) => {
  const [ax, az, bx, bz] = [2587.5, 950, 2765.2, 1059.2], t = ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2);
  return t >= 0 && t <= 1 && Math.hypot(ax + (bx - ax) * t - x, az + (bz - az) * t - z) < 1;
};
test('Paddington\'s row of 44 on Windsor St: each house of its own, with its own number', { skip: !paddington.some((b) => b.address) && 'the tiles have no addresses yet' }, () => {
  const row = paddington.filter((b) => b.houseStyle && b.address && b.cx > 2580 && b.cx < 2760 && b.cz > 960 && b.cz < 1090 && onWindsor(b.address[0]));
  const numbers = new Set(row.map((b) => b.address[0].number));
  for (const n of ['51', '75', '101', '119A', '135']) assert.ok(numbers.has(n), `${n} in ${[...numbers].sort().join(' ')}`);
  for (const b of row) {
    const a = b.polygons.reduce((s, p) => s + Math.abs(area(p.outer)), 0);
    assert.ok(a < 200, `${b.address[0].number}: ${a} m²`);
  }
});
