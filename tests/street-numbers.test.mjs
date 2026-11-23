import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CELL, GLYPHS, HIGH, PAD, SIZE, glyphCodes, letterboxPlate, numberPlates, plateText, plateWidth } from '../js/street-numbers.js';
import { FOOTPATH, LAWN_TOP, squareLots } from '../js/house-lots.js';
import { STYLE } from '../js/house-styles.js';
import { lotThings } from '../js/lot-things.js';
import { outerWalls } from '../js/addresses.js';

test('a number as a plate shows it: letters and ranges, a range too long its first number, nothing it can\'t show', () => {
  assert.equal(plateText('399A'), '399A');
  assert.equal(plateText('1-3'), '1-3');
  assert.equal(plateText('27-27A'), '27-27A');
  assert.equal(plateText('12345A-12347B'), '12345A');
  assert.equal(plateText('2-102'), '2-102');
  assert.equal(plateText('23-2325'), '23');
  assert.equal(plateText(null), null);
  assert.equal(plateText(''), null);
  assert.equal(plateText('3/5'), null);
  assert.ok(Math.abs(plateWidth(3, 0.1) - (3 * CELL + 2 * PAD) * 0.1) < 1e-12);
});

// The shader's reading of a plate's characters (js/tsl-materials.js createNumberPlateMaterial()), in float32 as the GPU does it: the k-th
// character's number times an exact power of two, floored, less 64 times the next
const fl = Math.fround;
function shaderCode(codes, n, k) {
  const word = k >= 8 ? codes[2] : k >= 4 ? codes[1] : codes[0];
  const j = k % 4;
  const shift = [1, 1 / 64, 1 / 4096, 1 / 262144][j];
  const above = Math.floor(fl(fl(word) * fl(shift)));
  return k < n ? above - Math.floor(fl(above * fl(1 / 64))) * 64 : 0;
}

test('a plate\'s characters read back exactly from their numbers as the shader reads them, for every character in every place', () => {
  const all = [...GLYPHS];
  for (let start = 0; start < all.length; start++) {
    const text = Array.from({ length: 12 }, (_, k) => all[(start + k * 7) % all.length]).join('');
    const codes = glyphCodes(text);
    for (const c of codes) assert.ok(c < 2 ** 24 && Number.isInteger(c) && fl(c) === c, 'whole, and exact in a float');
    for (let k = 0; k < 12; k++) assert.equal(GLYPHS[shaderCode(codes, 12, k) - 1], text[k], `${text}, character ${k}`);
  }
  // The highest each word can be: the last character, 12 times
  const last = GLYPHS.at(-1).repeat(12), codes = glyphCodes(last);
  for (let k = 0; k < 12; k++) assert.equal(shaderCode(codes, 12, k), GLYPHS.length);
});

test('the plates\' sizes and the doors\' and signs\' measures are the facade\'s and the atlas\'s', () => {
  const source = readFileSync(new URL('../js/tsl-materials.js', import.meta.url), 'utf8');
  const numbers = readFileSync(new URL('../js/street-numbers.js', import.meta.url), 'utf8');
  // A house's door: 0.46 either side of its middle and a frame of 0.07; its sidelight 0.36 more
  assert.match(source, /const leafTop = 2\.04, frame = 0\.07, half = 0\.46;/);
  assert.match(source, /const sideWidth = side\.mul\(0\.36\);/);
  assert.match(numbers, /const DOOR_HALF = 0\.53;/);
  assert.match(numbers, /const SIDELIGHT = 0\.36;/);
  // The city's entrance: 2.48 m high with a frame of 0.2; a shopfront's sign 2.96-3.56 over the wall's v of 0.22 at its foot
  assert.match(source, /float\(2\.48\);/);
  assert.match(source, /band\(y, 0, height\.add\(0\.20\), fw\.y\)/);
  assert.match(numbers, /const ENTRANCE_TOP = 2\.68;/);
  assert.match(source, /y\.sub\(2\.96\)\.div\(0\.6\)/);
  assert.match(numbers, /const SIGN_TOP = 3\.36;/);
  // The atlas's cells: 32 by 64, as a plate's character is CELL by HIGH
  assert.equal(CELL / HIGH, 32 / 64);
  assert.match(source, /canvas\.width = 512;\n  canvas\.height = 256;/);
  for (const h of Object.values(SIZE)) assert.ok(h > 0.04 && h < 0.4);
});

// Houses along A St, as tests/lot-things.test.mjs has them, each with a street address on its front
const KERB = 4.4;
const A = { name: 'A St', width: 8, cls: 7, kind: 0, pts: [{ x: -300, z: 0 }, { x: 300, z: 0 }] };
const tile = { key: '0_0' };
const STYLES = ['Federation', 'Post-war fibro', 'California bungalow', 'Triple-fronted brick veneer', 'Project home', 'Victorian terrace', 'Beach house'];
const HOUSES = [];
for (let i = 0; i < 14; i++) {
  const x0 = -280 + i * 16, x1 = x0 + 10;
  const ring = [{ x: x0, z: 12 }, { x: x1, z: 12 }, { x: x1, z: 24 }, { x: x0, z: 24 }];
  HOUSES.push({ kind: 1, houseStyle: STYLE[STYLES[i % STYLES.length]], group: 0, bottom: 0, height: 3, floor: 0, polygons: [{ outer: ring, holes: [] }],
    minX: x0, maxX: x1, minZ: 12, maxZ: 24, cx: x0 + 5, cz: 18, address: [{ x: x0 + 5, z: 0, wall: 0, number: `${2 * i + 1}` }],
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
const lotsOf = (houses) => {
  const job = squareLots(houses.map((b) => ({ b, tile })), env, { x0: -300, z0: -100, x1: 300, z1: 100 });
  let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
};

test('a house\'s number on its letterbox, on its face to the street, the same colours as by its door; none without a number', () => {
  const result = lotsOf(HOUSES);
  assert.ok(result.plates.length >= 6, `${result.plates.length} letterboxes with numbers`);
  for (const p of result.plates) {
    assert.equal(p.kind, 'letterbox');
    assert.ok(Math.abs(p.nz + 1) < 1e-9, 'facing the street');
    assert.ok(p.z > KERB + FOOTPATH && p.z < 12, `in the front yard: ${p.z}`);
    assert.ok(p.y - LAWN_TOP > 0.6 && p.y - LAWN_TOP < 1.1, `on the letterbox: ${p.y} over the lawn's ${LAWN_TOP}`);
    const house = HOUSES.reduce((best, b) => (Math.abs(b.cx - p.x) < Math.abs(best.cx - p.x) ? b : best));
    assert.equal(p.text, house.address[0].number);
    // The door's plate picks its colours by the same point
    const [door] = numberPlates({ address: house.address, house: house.houseStyle, frontWall: house.frontWall }, outerWalls(house.polygons), { base: 0.22 });
    assert.equal(door.kind, 'house');
    assert.equal(p.palette, door.palette);
  }
  const none = lotsOf(HOUSES.map((b) => ({ ...b, address: [{ ...b.address[0], number: null }] })));
  assert.equal(none.plates.length, 0);
  assert.equal(letterboxPlate({ x: 0, y: 1, z: 0, nx: 0, nz: -1 }, null), null);
});

test('on tiles with addresses, every building with a number has its plates, on its walls\' faces and over the ground', async (t) => {
  globalThis.fetch ??= async (url) => new Response(readFileSync(new URL(url)));
  const { heldTiles } = await import('../js/geodata.js');
  const tiles = heldTiles().filter((tl) => tl.buildings.some((b) => b.address));
  if (!tiles.length) return t.skip('the tiles have no street addresses');
  const { wallFootAt } = await import('../js/wall-foot.js');
  const { groundHeight } = await import('../js/surfaces.js');
  const { createBuildingFootprints } = await import('../js/building-footprints.js');
  const { buildingLook } = await import('../js/building-look.js');
  const { HOUSE_STYLES } = await import('../js/house-styles.js');
  let numbered = 0, plated = 0, plates = 0;
  for (const b of tiles[0].buildings) {
    if (!b.address?.some((a) => a.number) || b.group) continue;
    numbered++;
    const look = HOUSE_STYLES[b.houseStyle || 0]?.look;
    const item = { ...b, base: b.floor, storefronts: b.kind === 3 && b.height >= 6,
      ...(look ? { house: b.houseStyle, front: { x: b.address[0].x, z: b.address[0].z }, seed: buildingLook(b, b).seed } : {}) };
    createBuildingFootprints({}, [item], undefined, null, { groundAt: wallFootAt, groundTop: groundHeight, storey: { width: 3, height: 3, pier: 1.2 } });
    if (item.plates?.length) plated++;
    for (const p of item.plates || []) {
      plates++;
      assert.ok(p.y - (HIGH * p.h) / 2 > groundHeight(p.x + p.nx * 0.5, p.z + p.nz * 0.5) - 0.05, `${p.text} at (${p.x}, ${p.z}) over the ground`);
      // On one of its outline's edges, just off it
      const near = b.polygons.flatMap((poly) => poly.outer.map((a, i) => [a, poly.outer[(i + 1) % poly.outer.length]])).some(([a, c]) => {
        const dx = c.x - a.x, dz = c.z - a.z, L2 = dx * dx + dz * dz || 1;
        const s = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / L2));
        return Math.hypot(a.x + dx * s - p.x, a.z + dz * s - p.z) < 0.05;
      });
      assert.ok(near, `${p.text} at (${p.x}, ${p.z}) on its wall`);
    }
  }
  assert.ok(plated >= numbered * 0.98, `${plated} of ${numbered} with a plate (${plates} plates)`);
});
