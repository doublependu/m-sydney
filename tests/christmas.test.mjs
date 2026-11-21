import assert from 'node:assert/strict';
import test from 'node:test';
import { FOOTPATH, squareLots } from '../js/house-lots.js';
import { houseEntry } from '../js/house-entry.js';
import { STYLE } from '../js/house-styles.js';
import { lotThings } from '../js/lot-things.js';
import { buildingLook } from '../js/building-look.js';
import { roofFrame } from '../js/building-footprints.js';
import { HOUSES, STREETS, anchorsOf, decorationsOf } from '../js/christmas.js';
import { ROOM, houseKit } from '../js/christmas-houses.js';
import { heldTiles, isHeld } from '../js/geodata.js';
import { squareWorkNow, tilesFor } from '../js/lot-details.js';

// Which houses are decorated in December (js/christmas.js) and what's on them (js/christmas-houses.js), on streets made up for it: a
// street along x at z = oz, 8 m wide, and on its north side a house every 16 m, 10 m wide and 12 m deep, its front 12 m from the street's
// middle, its roof pitched; and on the map, where the tiles are held.

const KERB = 4.4;
const STYLES = ['Federation', 'Post-war fibro', 'California bungalow', 'Triple-fronted brick veneer', 'Project home', 'Beach house'];
/** A street of `n` houses named `name`, its link `id`, from (ox, oz) east; its lots worked out as the game does */
function street({ name = 'A St', id = 1, ox = 0, oz = 0, n = 30, both = false, styles = STYLES } = {}) {
  const L = n * 16 + 40;
  const link = { id, name, width: 8, cls: 7, kind: 0, pts: [{ x: ox - 20, z: oz }, { x: ox + L, z: oz }] };
  const tile = { key: '0_0' };
  const houses = [];
  for (const side of both ? [1, -1] : [1]) {
    for (let i = 0; i < n; i++) {
      const x0 = ox + i * 16, x1 = x0 + 10, z0 = oz + side * 12, z1 = oz + side * 24;
      const ring = side > 0 ? [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }]
        : [{ x: x0, z: z1 }, { x: x1, z: z1 }, { x: x1, z: z0 }, { x: x0, z: z0 }];
      houses.push({ kind: 1, houseStyle: STYLE[styles[i % styles.length]], group: 0, bottom: 0, height: 3, floor: 0, pitched: true,
        polygons: [{ outer: ring, holes: [] }], minX: x0, maxX: x1, minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1), cx: x0 + 5, cz: (z0 + z1) / 2,
        frontWall: side > 0 ? { ax: x1, az: z0, bx: x0, bz: z0, reverse: false, width: 10, digits: (i * 137) % 1000 }
          : { ax: x0, az: z0, bx: x1, bz: z0, reverse: false, width: 10, digits: (i * 137) % 1000 } });
    }
  }
  const nearestOn = (x, z) => {
    const t = Math.max(ox - 20, Math.min(ox + L, x));
    return { link, x: t, z: oz, d: Math.hypot(x - t, z - oz), ux: 1, uz: 0 };
  };
  const env = {
    streetOf: (w) => nearestOn(w.cx, w.cz),
    roadsNear: (x, z, r) => [nearestOn(x, z)].filter((p) => p.d <= r),
    kerbFrom: () => KERB,
    groundAt: () => 0, lawnAt: () => 0, pavingAt: () => 0, roadAt: () => 0,
    onLawn: (x, z) => Math.abs(z - oz) >= KERB + FOOTPATH,
    sites: []
  };
  env.lotThings = (lot, near) => lotThings(lot, near, env);
  const square = { x0: ox - 100, z0: oz - 100, x1: ox + L + 100, z1: oz + 100 };
  const job = squareLots(houses.map((b) => ({ b, tile })), env, square);
  let step = job.next();
  while (!step.done) step = job.next();
  return { link, result: step.value };
}
const decorate = (lot) => decorationsOf({ x: lot.home.cx, z: lot.home.cz, pts: lot.pts, units: lot.units ?? null, street: lot.home.street.link });
const kitEnv = (result) => ({
  ground: () => 0.24, look: buildingLook, roofFrame, entry: houseEntry, trees: () => [],
  fronts: (lot) => result.panels.filter((p) => p.kind >= 2 && Math.abs(p.z - lot.home.cz) < 10 && Math.abs(p.x - lot.home.cx) < 8)
    .map((p) => ({ a: { x: p.x - (p.ux * p.length) / 2, z: p.z - (p.uz * p.length) / 2 }, b: { x: p.x + (p.ux * p.length) / 2, z: p.z + (p.uz * p.length) / 2 }, y: p.y + p.height }))
});

test('an ordinary street: one or two of its houses, the same ones every time, in whatever order its lots come', () => {
  const { result } = street({ name: 'Quiet Street', id: 4242, n: 30, both: true });
  assert.ok(result.lots.length >= 55, `${result.lots.length} lots`);
  const picked = (lots) => lots.flatMap((lot) => decorate(lot).map((d) => `${lot.home.cx},${lot.home.cz},${d.unit},${d.heavy}`)).sort();
  const once = picked(result.lots), again = picked([...result.lots].reverse());
  assert.ok(once.length >= 1 && once.length <= 4, `${once.length} of ${result.lots.length} houses on a 520 m street`);
  assert.deepEqual(again, once);
  // Over many streets of a few blocks (300 m, both sides): most have one or two, a few none, few more than three
  const counts = [];
  for (let id = 1; id <= 300; id++) {
    const link = { id: 10000 + id, name: `Street ${id}`, width: 8, pts: [{ x: 0, z: 0 }, { x: 300, z: 0 }] };
    counts.push(anchorsOf(link).length);
  }
  const share = (f) => counts.filter(f).length / counts.length;
  const mean = counts.reduce((s, c) => s + c, 0) / counts.length;
  assert.ok(mean > 1 && mean < 2, `${mean.toFixed(2)} a street on average`);
  assert.ok(share((c) => c === 1 || c === 2) > 0.85, `${share((c) => c === 1 || c === 2)} of streets with one or two`);
});

test('a suburb that decorates more: more houses to a street, and more of them heavily', () => {
  let here = 0, concord = 0, heavyHere = 0, heavyConcord = 0;
  for (let id = 1; id <= 300; id++) {
    const plain = anchorsOf({ id: 20000 + id, name: `Road ${id}`, width: 8, pts: [{ x: 0, z: 0 }, { x: 300, z: 0 }] });
    const more = anchorsOf({ id: 30000 + id, name: `Road ${id}`, width: 8, pts: [{ x: -9600, z: -600 }, { x: -9300, z: -600 }] });
    here += plain.length;
    concord += more.length;
    heavyHere += plain.filter((s) => s.heavy).length;
    heavyConcord += more.filter((s) => s.heavy).length;
  }
  assert.ok(concord > here * 2, `${concord} in Concord against ${here}`);
  assert.ok(heavyConcord / concord > (heavyHere / here) * 1.5, `${heavyConcord} of ${concord} heavy in Concord against ${heavyHere} of ${here}`);
});

test('a known street: nine houses in ten, most of them heavily', () => {
  const known = STREETS.find((s) => s.name === 'Prince Albert Street');
  const { result } = street({ name: known.name, id: 77, ox: known.x - 150, oz: known.z, n: 20, both: true });
  const decos = result.lots.flatMap(decorate);
  assert.ok(decos.length >= result.lots.length * 0.8, `${decos.length} of ${result.lots.length}`);
  assert.ok(decos.filter((d) => d.heavy).length >= decos.length * 0.6, `${decos.filter((d) => d.heavy).length} of ${decos.length} heavily`);
  assert.ok(decos.every((d) => d.why === 'street'));
  // The same name elsewhere is an ordinary street
  const far = street({ name: known.name, id: 78, ox: 0, oz: 0, n: 20, both: true }).result.lots.flatMap(decorate);
  assert.ok(far.length <= 4 && far.every((d) => d.why === 'pick'), `${far.length} far from Mosman`);
});

test('a known house: that house heavily, and some of its neighbours along its street', () => {
  const known = HOUSES.find((s) => s.name === 'Burwood Road' && s.number === 191);
  // Its point in the middle of the 11th lot's front yard
  const { result } = street({ name: known.name, id: 191, ox: known.x - 10 * 16 - 5, oz: known.z - 10, n: 20 });
  const all = result.lots.map((lot) => ({ lot, decos: decorate(lot) }));
  const house = all.filter(({ decos }) => decos.some((d) => d.why === 'house'));
  assert.equal(house.length, 1, `${house.length} houses taken for no. 191`);
  assert.ok(house[0].decos[0].heavy);
  assert.ok(Math.abs(house[0].lot.home.cx - known.x) < 8, `no. 191 at ${house[0].lot.home.cx} against ${known.x}`);
  const near = all.filter(({ decos }) => decos.some((d) => d.why === 'near'));
  assert.ok(near.length >= 1 && near.length <= 7, `${near.length} neighbours join in`);
  for (const { lot } of near) assert.ok(Math.abs(lot.home.cx - known.x) < 75, `a neighbour ${Math.round(lot.home.cx - known.x)} m along`);
});

test('a row of terraces on a known street: each of its houses decorated by itself', () => {
  const known = STREETS.find((s) => s.name === 'Elizabeth Street');
  const units = (n) => Array.from({ length: n }, (_, k) => ({ pts: [{ x: k * 5.5, z: 10 }, { x: (k + 1) * 5.5, z: 10 }, { x: (k + 1) * 5.5, z: 30 },
    { x: k * 5.5, z: 30 }].map((p) => ({ x: p.x + known.x, z: p.z + known.z })) }));
  const lot = { x: known.x + 22, z: known.z + 20, pts: [{ x: 0, z: 10 }, { x: 44, z: 10 }, { x: 44, z: 30 }, { x: 0, z: 30 }].map((p) => ({ x: p.x + known.x, z: p.z + known.z })),
    units: units(8), street: { id: 9, name: known.name, width: 8, pts: [{ x: known.x - 50, z: known.z }, { x: known.x + 100, z: known.z }] } };
  const decos = decorationsOf(lot);
  assert.ok(decos.length >= 6, `${decos.length} of 8 houses in the row`);
  assert.equal(new Set(decos.map((d) => d.unit)).size, decos.length);
  assert.ok(decos.every((d) => d.unit >= 0 && d.unit < 8));
});

test("a heavy house's kit: the eaves all round at the roof's edge, shapes on it; a light one's eaves along its front and a wreath", () => {
  const { result } = street({ name: 'Kit Street', id: 5, n: 12 });
  const env = kitEnv(result);
  const lot = result.lots.find((l) => Math.abs(l.home.cx - (6 * 16 + 5)) < 1);
  const b = lot.home.pieces[0];
  const look = buildingLook(b, b);
  const frame = roofFrame(b.polygons[0].outer.map((p) => ({ x: p.x, y: p.z })), look);
  const top = 0.22 + 3, low = top - frame.eaves * frame.tan, ridge = top + frame.tan * frame.W;
  const heavy = houseKit(lot, [{ unit: -1, heavy: true, multi: true, seed: 0.3, why: 'street' }], env);
  const n = heavy.bulbs.length / 4;
  assert.ok(n > 120, `${n} bulbs on a heavy house`);
  let north = 0, south = 0, wallsIn = 0;
  for (let i = 0; i < n; i++) {
    const x = heavy.bulbs[i * 4], y = heavy.bulbs[i * 4 + 1], z = heavy.bulbs[i * 4 + 2];
    assert.ok(y > 0 && y < ridge + 1.2, `a bulb at ${y.toFixed(2)} m`);
    if (z > 23) north++;
    if (z < 12 && y > low - 0.6) south++;
    // None inside the walls under the roof
    if (x > b.minX + 0.05 && x < b.maxX - 0.05 && z > b.minZ + 0.05 && z < b.maxZ - 0.05 && y < top) wallsIn++;
  }
  assert.ok(north > 20 && south > 20, `${south} along the front's eaves, ${north} along the back's`);
  assert.equal(wallsIn, 0, `${wallsIn} bulbs inside the house`);
  assert.ok(heavy.shapes.shapes >= 2 && heavy.shapes.v > 0, `${heavy.shapes.shapes} shapes`);
  const light = houseKit(lot, [{ unit: -1, heavy: false, multi: false, seed: 0.3, why: 'pick' }], env);
  const m = light.bulbs.length / 4;
  assert.ok(m > 20 && m < n / 3, `${m} bulbs on a light house`);
  for (let i = 0; i < m; i++) assert.ok(light.bulbs[i * 4 + 2] < 12.5, `a light house's bulb at z = ${light.bulbs[i * 4 + 2].toFixed(2)}, off its front`);
  assert.equal(light.shapes.shapes, 1, 'a wreath and nothing else');
  for (const kit of [heavy, light]) assert.ok(kit.bulbs.every(Number.isFinite) && kit.shapes.pos.every(Number.isFinite));
  // Room for a known street's heavy houses on every level
  for (const level of Object.values(ROOM)) assert.ok(level.bulbs >= n * 8, `${level.bulbs} bulbs' room`);
});

// Prince Albert Street, Mosman, on the map: almost every house on it, one to a few on the streets round it; the CBD has none
const SQUARE = { x0: 2500, z0: -4500, x1: 3000, z1: -4000 };
test('Prince Albert Street and its neighbours on the map, the same every time', { skip: !tilesFor(SQUARE).every(isHeld) && 'its tiles aren\'t held' }, () => {
  const tiles = new Map(heldTiles().map((t) => [t.key, t]));
  const { entries, env } = squareWorkNow(SQUARE, tiles);
  const job = squareLots(entries, env, SQUARE);
  let step = job.next();
  while (!step.done) step = job.next();
  const streets = new Map();
  for (const lot of step.value.lots) {
    const name = lot.home.street?.link?.name ?? '';
    const s = streets.get(name) || streets.set(name, { lots: 0, decorated: 0, keys: [] }).get(name);
    s.lots += lot.units?.length || 1;
    for (const d of decorate(lot)) {
      s.decorated++;
      s.keys.push(`${lot.home.cx}:${d.unit}:${d.heavy}`);
    }
  }
  const pa = streets.get('Prince Albert Street');
  assert.ok(pa && pa.lots > 20 && pa.decorated >= pa.lots * 0.8, `Prince Albert Street: ${pa?.decorated} of ${pa?.lots}`);
  for (const [name, s] of streets) {
    if (name === 'Prince Albert Street') continue;
    assert.ok(s.decorated <= Math.max(5, s.lots * 0.2), `${name}: ${s.decorated} of ${s.lots}`);
  }
  // Again, from scratch: the same houses
  const again = squareWorkNow(SQUARE, tiles);
  const job2 = squareLots(again.entries, again.env, SQUARE);
  let step2 = job2.next();
  while (!step2.done) step2 = job2.next();
  const keys = step2.value.lots.filter((l) => l.home.street?.link?.name === 'Prince Albert Street')
    .flatMap((lot) => decorate(lot).map((d) => `${lot.home.cx}:${d.unit}:${d.heavy}`));
  assert.deepEqual(keys, pa.keys);
});

const CBD = { x0: 0, z0: -1000, x1: 500, z1: -500 };
test('a street with no houses has none: the CBD', { skip: !tilesFor(CBD).every(isHeld) && 'its tiles aren\'t held' }, () => {
  const tiles = new Map(heldTiles().map((t) => [t.key, t]));
  const { entries, env } = squareWorkNow(CBD, tiles);
  const job = squareLots(entries, env, CBD);
  let step = job.next();
  while (!step.done) step = job.next();
  assert.equal(step.value.lots.flatMap(decorate).length, 0);
});
