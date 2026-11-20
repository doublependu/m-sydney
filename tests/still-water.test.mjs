import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// Still water on land (js/still-water.js): a garden's ponds, rock-edged ponds and fountains, and the lakes, as pieces a body is tested
// against, on made-up tiles here and on the map's own below. Who it holds, and where they arrive, is tests/controllers.test.cjs'.

const require = createRequire(import.meta.url);
const { box, stillWater } = require('./helpers/still-water.cjs');

const near = (actual, expected, what, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${what}: ${actual} against ${expected}`);
const EAST = Math.PI / 2, WEST = -Math.PI / 2; // facing +x and -x (forward is sin, cos of the heading)

test('a pond holds a walker 0.3 m off its water all round, and its island is land', () => {
  const water = stillWater([{ key: '0_0', garden: { ponds: [box(0, 0, 20, 20)], islands: [box(8, 8, 12, 12)] } }]);
  assert.deepEqual({ ...water.waterAt(5, 5) }, { kind: 'pond', dry: false });
  assert.equal(water.waterAt(-1, 5), null, 'the lawn');
  assert.equal(water.waterAt(10, 10), null, 'the island');
  assert.equal(water.stillWaterDepth('person', -0.31, 10), 0, 'just over 0.3 m off it');
  near(water.stillWaterDepth('person', -0.25, 10), 0.05, 'within 0.3 m: in by what its round reaches over');
  near(water.stillWaterDepth('person', 10, 20.2), 0.1, 'off its other side');
  assert.equal(water.stillWaterDepth('person', 10, 10), 0, 'in the island\'s middle, 2 m from its shore');
  near(water.stillWaterDepth('person', 8.2, 10), 0.1, 'on the island, 0.2 m from its shore');
  // In the water already, how far in grows inward, up to 2 m past its round
  const depths = [0.1, 0.5, 1, 3].map((d) => water.stillWaterDepth('person', d, 10));
  assert.ok(depths[0] < depths[1] && depths[1] < depths[2] && depths[2] < depths[3], `deeper, the further in: ${depths}`);
  near(depths[3], 2.3, 'counted no deeper than 2 m in');
});

test('a lake in pieces along a seam: a body over the seam is in it, and no strip along the seam is dry', () => {
  const water = stillWater([{ key: '0_0', lakes: [[1.2, box(200, 0, 240, 20)], [1.2, box(240, 0, 280, 20)]] }]);
  assert.equal(water.waterAt(239, 10).kind, 'lake');
  assert.equal(water.waterAt(241, 10).kind, 'lake');
  for (const x of [239.8, 240, 240.2]) {
    assert.ok(water.stillWaterDepth('person', x, 10) > 0, `a walker at ${x}`);
    assert.ok(water.stillWaterDepth('car', x, 10, 0) > 0, `a car along the seam at ${x}`);
  }
  assert.ok(water.stillWaterDepth('car', 240, 10, EAST) > 0, 'a car across it');
});

test('a pond under 1 m across: a bike\'s or a car\'s ends over it hold them, though their middles are on land, and a walker can\'t step over it', () => {
  const water = stillWater([{ key: '0_0', garden: { ponds: [box(0, 0, 0.8, 30)] } }]);
  assert.equal(water.waterAt(-1.5, 15), null, 'the car\'s middle is on land');
  assert.ok(water.stillWaterDepth('car', -1.5, 15, EAST) > 0, 'its front over the water');
  assert.equal(water.stillWaterDepth('car', -1, 15, 0), 0, 'alongside it, 0.14 m off');
  assert.ok(water.stillWaterDepth('cyclist', -0.9, 15, EAST) > 0, 'a bike\'s front tyre over it');
  assert.equal(water.stillWaterDepth('cyclist', -1, 15, EAST), 0, 'and 0.03 m short of it');
  assert.ok(water.stillWaterDepth('person', 0.4, 15) > 0, 'a walker in its middle');
});

test('a garden\'s path across a pond, and a road on the ground, are dry across their width and only there', () => {
  // A 2 m path across the pond along z = 10, and a road over its west end along x = 3 (its carriageway 2 m each side)
  const water = stillWater([{ key: '0_0', garden: { ponds: [box(0, 0, 20, 20)], paths: [[0, 0, 2, -5, 10, 25, 10]] } }], (x) => Math.abs(x - 3) < 2);
  assert.deepEqual({ ...water.waterAt(10, 10) }, { kind: 'pond', dry: true });
  assert.equal(water.stillWaterDepth('person', 10, 10), 0, 'on the path');
  assert.equal(water.stillWaterDepth('person', 10, 10.95), 0, 'at its edge');
  assert.ok(water.stillWaterDepth('person', 10, 11.2) > 0, 'off it');
  assert.equal(water.stillWaterDepth('car', 10, 10, 0), 0, 'a car with its middle on it, its ends over the water');
  assert.equal(water.stillWaterDepth('car', 3, 15, 0), 0, 'on the road');
  assert.ok(water.stillWaterDepth('car', 6, 15, 0) > 0, 'off it');
  assert.equal(water.dryAt(3, 15), true);
  assert.equal(water.dryAt(10, 15), false);
});

test('a fountain holds everyone at its rim\'s outer face, 0.275 m further out than a pond\'s edge', () => {
  // Its basin, and a pond with no fountain beside it
  const water = stillWater([{ key: '0_0', garden: { ponds: [box(0, 0, 10, 10), box(100, 0, 110, 10)], fountains: [[5, 5, 5]] } }]);
  assert.equal(water.FOUNTAIN_RIM, 0.275);
  assert.equal(water.waterAt(5, 5).kind, 'fountain');
  assert.equal(water.waterAt(105, 5).kind, 'pond');
  assert.equal(water.waterAt(-0.1, 5), null, 'its rim isn\'t water');
  assert.ok(water.stillWaterDepth('person', -0.5, 5) > 0, 'a walker 0.5 m off it');
  assert.equal(water.stillWaterDepth('person', -0.6, 5), 0, 'and 0.6 m off');
  assert.equal(water.stillWaterDepth('person', 99.5, 5), 0, 'beside the pond, 0.5 m off');
  // Facing it, their fronts at the rim's face: the bike's middle 0.72 + 0.25 + 0.275 m off, the car's 1.32 + 0.86 + 0.275
  assert.ok(water.stillWaterDepth('cyclist', -1.2, 5, EAST) > 0 && water.stillWaterDepth('cyclist', -1.3, 5, EAST) === 0, 'the bike');
  assert.ok(water.stillWaterDepth('car', -2.4, 5, EAST) > 0 && water.stillWaterDepth('car', -2.5, 5, EAST) === 0, 'the car');
});

test('a pond edged with rocks, and its island', () => {
  const water = stillWater([{ key: '0_0', garden: { rockPonds: [box(0, 0, 20, 20)], islands: [box(8, 8, 12, 12)] } }]);
  assert.equal(water.waterAt(5, 5).kind, 'rock');
  assert.equal(water.waterAt(10, 10), null);
  assert.ok(water.stillWaterDepth('person', -0.2, 5) > 0);
});

test('a tile let go takes its water with it, and leaves the next tile\'s', () => {
  const a = { key: '0_0', garden: { ponds: [box(0, 0, 20, 20)], paths: [[0, 0, 2, -5, 10, 25, 10]] } };
  const b = { key: '1_0', lakes: [[0.5, box(1000, 0, 1020, 20)]] };
  const water = stillWater([a, b]);
  water.remove(a);
  assert.equal(water.waterAt(5, 5), null);
  assert.equal(water.stillWaterDepth('car', 5, 5, 0), 0);
  assert.equal(water.dryAt(10, 10), false, 'its paths gone too');
  assert.equal(water.waterAt(1010, 10).kind, 'lake');
  water.add(a);
  assert.equal(water.waterAt(5, 5).kind, 'pond', 'and held again');
});

test('a path asked about before the water beside it came in is dry over it once it has', () => {
  // The path's tile first, its paths indexed with no water near them (none are kept); then the pond's tile
  const paths = { key: '0_0', garden: { paths: [[0, 0, 2, -5, 10, 25, 10]] } };
  const water = stillWater([paths]);
  assert.equal(water.dryAt(10, 10), false, 'no water near it yet');
  water.add({ key: '0_1', garden: { ponds: [box(0, 0, 20, 20)] } });
  assert.deepEqual({ ...water.waterAt(10, 10) }, { kind: 'pond', dry: true });
  assert.equal(water.stillWaterDepth('person', 10, 10), 0, 'on the path');
  assert.ok(water.stillWaterDepth('person', 10, 12) > 0, 'off it');
  water.remove(paths);
  assert.ok(water.stillWaterDepth('person', 10, 10) > 0, 'its tile let go, the pond under it is water');
});

test('the helicopter isn\'t held by still water', () => {
  const water = stillWater([{ key: '0_0', garden: { ponds: [box(0, 0, 20, 20)] } }]);
  assert.equal(water.stillWaterDepth('helicopter', 10, 10), 0);
});

// On the map's own tiles, each in a process holding only the tiles round it (the other tests may hold another part of the map)
function onTiles(tiles, code) {
  const out = execFileSync('node', ['--input-type=module', '-e', `await import('./js/geodata.js'); const W = await import('./js/still-water.js');
    const at = (x, z, mode, heading) => (mode ? W.stillWaterDepth(mode, x, z, heading) : W.waterAt(x, z));
    process.stdout.write(JSON.stringify(await (async () => { ${code} })()));`], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, SYDNEY_TILES: tiles }
  });
  return JSON.parse(out.toString());
}

test('on the map: Centennial Park\'s ponds, and the path and steps that cross them dry', () => {
  const got = onTiles('2,2,3,3', 'return { busbys: at(2653, 2526), cycleway: at(2308, 3143), steps: at(2965, 2775), walker: [at(2308, 3143, "person"), at(2965, 2775, "person")] };');
  assert.deepEqual(got.busbys, { kind: 'pond', dry: false }, 'Busbys Pond');
  assert.deepEqual(got.cycleway, { kind: 'pond', dry: true }, 'the cycleway at (2308, 3143), 1 m into a pond');
  assert.deepEqual(got.steps, { kind: 'pond', dry: true }, 'the steps at (2965, 2775)');
  assert.deepEqual(got.walker, [0, 0], 'a walker on either isn\'t held');
});

test('on the map: the Botanic Garden\'s pond, and the Archibald Fountain held at its rim', () => {
  const got = onTiles('0,-2,0,-1', `const { FOUNTAIN } = await import('./js/garden.js');
    return { rim: [W.FOUNTAIN_RIM, FOUNTAIN.rimWidth / 2], pond: at(825, -1142), fountain: at(415.7, -297.1),
      walker: [at(428.5, -297.1, 'person'), at(428.6, -297.1, 'person')], bike: [at(429.2, -297.1, 'cyclist', ${WEST}), at(429.3, -297.1, 'cyclist', ${WEST})],
      car: [at(430.4, -297.1, 'car', ${WEST}), at(430.5, -297.1, 'car', ${WEST})] };`);
  assert.equal(got.rim[0], got.rim[1], 'the rim\'s half width is js/garden.js\' FOUNTAIN\'s');
  assert.equal(got.pond?.kind, 'pond', 'the Botanic Garden\'s largest pond (825, -1142)');
  assert.deepEqual(got.fountain, { kind: 'fountain', dry: false }, 'the Archibald Fountain\'s middle');
  // Its basin's corner on z = -297.1 is at x = 428.0: the walker's held 0.575 m off it, the bike's and the car's fronts at the rim's face
  for (const what of ['walker', 'bike', 'car']) assert.ok(got[what][0] > 0 && got[what][1] === 0, `${what}: ${got[what]}`);
});

test('on the map: Holker St\'s carriageway, 0.3 m into a lake at Sydney Olympic Park, is dry', () => {
  const got = onTiles('-14,-3,-14,-3', 'return { water: at(-13623, -2400.1), car: [0, 1, 2, 3].map((k) => at(-13623, -2400.1, "car", k * Math.PI / 2)) };');
  assert.deepEqual(got.water, { kind: 'lake', dry: true });
  assert.deepEqual(got.car, [0, 0, 0, 0], 'a car on it, whichever way it faces');
});
