import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import zlib from 'node:zlib';
import * as THREE from 'three';

// Street addresses (js/addresses.js, tools/addresses.mjs): G-NAF's points matched to the buildings and their streets to the roads, once
// in the build, and kept in the tiles (tools/tiles/pack-buildings.mjs, js/tiles/tile-file.js).
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { looseStreetKey, numberCodes, numberFromCodes, numberSpan, numberText, outerWalls, parseNumber, streetKey } = await import('../js/addresses.js');
const { matchAddresses } = await import('../tools/addresses.mjs');
const { packBuildings } = await import('../tools/tiles/pack-buildings.mjs');
const { unpackBuildings, unpackTile } = await import('../js/tiles/tile-file.js');
const { tileFile } = await import('../js/tiles/paths.js');

test('street numbers as G-NAF writes them, as a plate shows them, and back from the tiles\' codes', () => {
  const cases = { 405: '405', '399A': '399A', '1-3': '1-3', '27-27A': '27-27A', '628-634': '628-634', '17A-19': '17A-19', '4-4': '4', '326GF': '326', '5A-T': '5A' };
  for (const [text, shown] of Object.entries(cases)) {
    const n = parseNumber(text);
    assert.equal(numberText(n), shown, text);
    const codes = numberCodes(n);
    assert.deepEqual(numberFromCodes(() => codes.shift()), n, text);
    assert.equal(codes.length, 0, text);
  }
  assert.equal(parseNumber('LOT 19'), null);
  assert.equal(parseNumber('A26'), null);
  assert.equal(numberText(numberSpan(['1', '3', '5A', null].map(parseNumber))), '1-5A');
  assert.equal(numberText(numberSpan(['399', '399'].map(parseNumber))), '399');
  assert.equal(numberText(numberSpan(['12-14', '10'].map(parseNumber))), '10-14');
  assert.equal(numberSpan([null]), null);
});

test('a street\'s name, as G-NAF and OSM spell it', () => {
  assert.equal(streetKey("St John's Road"), streetKey('ST JOHNS ROAD'));
  assert.equal(streetKey('Bay-Side  Lane'), 'BAY SIDE LANE');
  // Where it isn't found as it's spelt
  for (const [osm, gnaf] of [['Port Hacking Road South', 'PORT HACKING ROAD'], ['Mowbray Road', 'MOWBRAY ROAD WEST'], ['Woodfield Boulevarde', 'WOODFIELD BOULEVARD'],
    ['Saint Charbel Way', 'ST CHARBEL WAY'], ['Broad Arrow Road', 'BROADARROW ROAD']]) assert.equal(looseStreetKey(osm), looseStreetKey(gnaf), osm);
  assert.notEqual(looseStreetKey('North Road'), looseStreetKey('Road'));
});

test('an outline\'s walls, clockwise as the facade builds them, whichever way the tiles wind it', () => {
  const square = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 6 }, { x: 0, z: 6 }];
  for (const ring of [square, [...square].reverse()]) {
    const walls = outerWalls([{ outer: ring, holes: [] }, { outer: [{ x: 20, z: 0 }, { x: 21, z: 0 }], holes: [] }]);
    assert.equal(walls.length, 4, 'a polygon of fewer than three points has none');
    const pts = walls.map((w) => new THREE.Vector2(w.a.x, w.a.y));
    assert.ok(THREE.ShapeUtils.isClockWise(pts));
    walls.forEach((w, j) => assert.deepEqual(w.b, walls[(j + 1) % 4].a));
    assert.deepEqual(walls.map((w) => w.width).sort(), [10, 10, 6, 6]);
  }
});

// Two houses side by side on A St (along x at z = 0), with B St along z at x = 40 past them, and a lane behind at z = 30
const box = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x0, z: z1 }, { x: x1, z: z1 }, { x: x1, z: z0 }];
const house = (ring, extra = {}) => ({ outline: [{ outer: ring, holes: [] }], area: 100, height: 7, kind: 1, group: 0, bottom: 0, house: true, ...extra });
const ROADS = [
  { name: 'A STREET', pts: [[-50, 0], [100, 0]], onGround: true },
  { name: 'B STREET', pts: [[40, -50], [40, 80]], onGround: true },
  { name: 'C LANE', pts: [[-50, 30], [100, 30]], onGround: true }
];
const at = (x, z, street, number) => ({ x, z, street, number: parseNumber(number) });

test('a point goes to the building it\'s in, else to the nearest within 8 m', () => {
  const records = [house(box(0, 8, 10, 22)), house(box(14, 8, 24, 22))];
  const { address, stats } = matchAddresses(records, [at(5, 15, 'A STREET', '1'), at(12.6, 15, 'A STREET', '3'), at(60, 60, 'A STREET', '9')], ROADS);
  assert.deepEqual([...address.keys()].sort(), [0, 1]);
  assert.equal(address.get(0)[0].number.n, 1);
  // 2.6 m from the first, 1.4 m from the second
  assert.equal(address.get(1)[0].number.n, 3);
  assert.deepEqual([stats.inside, stats.near, stats.none], [1, 1, 1]);
});

test('a street is weighed by its addresses: a number with units outweighs a lane\'s one, which is nearer', () => {
  // 415 Riley Street and its three units, and 76 Little Riley Street, at one point in the last house of the row at Riley St, Surry Hills
  // Its middle 16 m from A St and 14 m from C Lane
  const records = [house(box(4, 10, 14, 22))];
  const one = (street, addresses) => ({ x: 9, z: 18, street, number: parseNumber('1'), addresses });
  assert.equal(matchAddresses(records, [one('C LANE', 1), one('A STREET', 4)], ROADS).address.get(0)[0].z, 0);
  assert.equal(matchAddresses(records, [one('C LANE', 1), one('A STREET', 1)], ROADS).address.get(0)[0].z, 30, 'a tie goes to the nearer');
});

test('a house faces its address street, not the nearer one, and keeps its other streets after it', () => {
  // On the corner: B St is 4 m from its east wall, A St 8 m from its front; its addresses are on A St, and one on B St
  const records = [house(box(26, 8, 36, 22))];
  const { address } = matchAddresses(records, [at(30, 12, 'A STREET', '5'), at(31, 13, 'A STREET', '5'), at(34, 15, 'B STREET', '2')], ROADS);
  const [a, b] = address.get(0);
  assert.deepEqual([a.x, a.z, b.x, b.z], [31, 0, 40, 15]);
  const walls = outerWalls(records[0].outline);
  const facing = (w) => [Math.sign(-(w.b.y - w.a.y)) + 0, Math.sign(w.b.x - w.a.x) + 0];
  assert.deepEqual(facing(walls[a.wall]), [0, -1], 'its front faces A St, north');
  assert.deepEqual(facing(walls[b.wall]), [1, 0], 'its wall on B St faces east');
  assert.equal(numberText(a.number), '5');
  assert.deepEqual(a.at, { x: 30.5, z: 12.5 });
});

test('a house\'s front isn\'t a wall against its neighbour', () => {
  // A row of two: the west one's addresses on B St, east past its neighbour, whose wall it shares
  const records = [house(box(0, 8, 10, 22)), house(box(10, 8, 20, 22))];
  const { address } = matchAddresses(records, [at(5, 15, 'B STREET', '7')], ROADS);
  const walls = outerWalls(records[0].outline), w = walls[address.get(0)[0].wall];
  assert.ok(!(w.a.x === 10 && w.b.x === 10), 'not the party wall');
});

test('a low-rise shop\'s door is the wall facing its street nearest its address, and a tower has none', () => {
  // A shop with its front stepped back halfway along: two walls face A St; its address is at the east end
  const stepped = [{ x: 0, z: 8 }, { x: 0, z: 30 }, { x: 40, z: 30 }, { x: 40, z: 12 }, { x: 20, z: 12 }, { x: 20, z: 8 }];
  const shop = { outline: [{ outer: stepped, holes: [] }], area: 800, height: 8, kind: 3, group: 0, bottom: 0, house: false };
  const tower = { ...shop, outline: [{ outer: box(60, 8, 80, 28), holes: [] }], height: 40 };
  const { address } = matchAddresses([shop, tower], [at(35, 14, 'A STREET', '10'), at(70, 15, 'A STREET', '20')], ROADS);
  const walls = outerWalls(shop.outline), w = walls[address.get(0)[0].wall];
  assert.deepEqual([w.a.y, w.b.y], [12, 12], 'the east part of the front');
  assert.equal(address.get(1)[0].wall, -1);
  assert.equal(numberText(address.get(1)[0].number), '20');
});

test('a street isn\'t looked for past 100 m, and an alias finds one spelt otherwise', () => {
  const records = [house(box(0, 8, 10, 22))];
  assert.equal(matchAddresses(records, [at(5, 15, 'D STREET', '1')], ROADS).address.size, 0);
  const { address, aliased } = matchAddresses(records, [at(5, 15, 'C ROAD', '1')], ROADS, { aliases: new Map([['C ROAD', 'C LANE']]) });
  assert.equal(address.get(0)[0].z, 30);
  assert.equal(aliased.get('C ROAD'), 1);
  // A part of a road OSM names on its own (Port Hacking Road South), or G-NAF does
  const loose = matchAddresses(records, [at(5, 15, 'A STREET SOUTH', '1'), at(6, 15, 'C LANE WEST', '1')], ROADS);
  assert.deepEqual(loose.address.get(0).map((s) => s.z).sort(), [0, 30]);
  assert.equal(loose.stats.loose, 2);
});

test('a building\'s streets come back from the tiles as they went in', () => {
  const polygons = [{ outer: [{ x: 100.5, z: 200 }, { x: 110, z: 200 }, { x: 110, z: 214.5 }, { x: 100.5, z: 214.5 }], holes: [] }];
  const b = { height: 7, kind: 1, pitched: true, group: 0, bottom: 0, realAwning: false, houseStyle: 3, polygons, minX: 100.5, maxX: 110, minZ: 200,
    maxZ: 214.5, cx: 105.25, cz: 207.25 };
  const withAddress = { ...b, address: [{ x: 105.5, z: 190, wall: 2, number: parseNumber('399A'), at: { x: 105, z: 207 } },
    { x: 130, z: 207.5, wall: -1, number: null, at: { x: 109, z: 207 } }, { x: 60, z: 300, wall: 0, number: parseNumber('27-27A'), at: { x: 0, z: 0 } }] };
  const data = new Uint8Array(packBuildings([{ b: withAddress, i: 0 }, { b, i: 1 }], [[123, 101], [5, -3]]));
  const [one, two] = unpackBuildings(data, 0, data.length);
  assert.deepEqual(one.address, [{ x: 105.5, z: 190, wall: 2, number: '399A' }, { x: 130, z: 207.5, wall: -1, number: null }, { x: 60, z: 300, wall: 0, number: '27-27A' }]);
  assert.equal(two.address, null);
  for (const [got, was, floor] of [[one, b, [12.3, 10.1]], [two, b, [0.5, -0.3]]]) {
    assert.deepEqual([got.height, got.kind, got.pitched, got.houseStyle, got.cx, got.cz, got.floor, got.low], [was.height, was.kind, was.pitched, was.houseStyle, was.cx, was.cz, ...floor]);
    assert.deepEqual(got.polygons, was.polygons);
  }
});

// The row at Riley St, Surry Hills, behind Little Riley St: 399-415 Riley Street, each house its own
const world = JSON.parse(fs.readFileSync(new URL('../public/tiles/world.json', import.meta.url), 'utf8'));
const tile = (() => {
  const key = '0_1';
  const bytes = zlib.gunzipSync(fs.readFileSync(new URL(`../public/tiles/${tileFile(key, world.tiles[key])}`, import.meta.url)));
  return unpackTile(new Uint8Array(bytes), world.heights.size, world.ground.size);
})();
const inRing = (ring, x, z) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) c = !c;
  }
  return c;
};
const nodes = new Map();
for (let i = 0; i < tile.nodes.length; i += 3) nodes.set(tile.nodes[i], [tile.nodes[i + 1], tile.nodes[i + 2]]);
// Every road's name within 0.5 m of (x, z): a point at a junction is on each
const namesAt = (x, z) => {
  const out = new Set();
  for (const r of tile.links) {
    const pts = [nodes.get(r[1]), ...Array.from({ length: r[7].length / 2 }, (_, k) => [r[7][2 * k], r[7][2 * k + 1]]), nodes.get(r[2])];
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
      if (Math.hypot(ax + dx * t - x, az + dz * t - z) < 0.5) out.add(r[3]);
    }
  }
  return out;
};

test('the row at Riley St, Surry Hills: 399-415 Riley Street, 405 at (690, 1320)', { skip: !tile.buildings.some((b) => b.address) && 'the tiles have no addresses yet' }, () => {
  const b = tile.buildings.find((o) => !o.bottom && o.polygons.some((p) => inRing(p.outer, 690, 1320)));
  assert.equal(b.address[0].number, '405');
  assert.ok(namesAt(b.address[0].x, b.address[0].z).has('Riley Street'));
  // Its door on the wall facing Riley St, to the east, not the lane's
  const w = outerWalls(b.polygons)[b.address[0].wall];
  assert.ok(-(w.b.y - w.a.y) / w.width > 0.9, `its front faces east: ${JSON.stringify(w)}`);
  const row = tile.buildings.filter((o) => o.cx > 676 && o.cx < 703 && o.cz > 1295 && o.cz < 1350 && o.address && namesAt(o.address[0].x, o.address[0].z).has('Riley Street'));
  const numbers = row.map((o) => o.address[0].number).sort();
  for (const n of ['399', '399A', '401', '403', '405', '407', '409', '411', '413', '415']) assert.ok(numbers.includes(n), `${n} in ${numbers.join(' ')}`);
  // 415 has a lane address too, 76 Little Riley Street, after its own
  const last = row.find((o) => o.address[0].number === '415');
  assert.ok(namesAt(last.address[1].x, last.address[1].z).has('Little Riley Street'));
  assert.equal(last.address[1].number, '76');
});
