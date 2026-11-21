import assert from 'node:assert/strict';
import test from 'node:test';
import { CITY_TREES, ROOM, clearingOf, colliderOf, createCityTrees, plinthOf, treeKit } from '../js/christmas-trees.js';
import { EFFECT, lookW } from '../js/christmas-materials.js';

// The city's big Christmas trees in December (js/christmas-trees.js): what one is made of, where it stands, and the trees near you as the
// season's work makes and draws them, on flat ground at y = 10 and the sea at -2.2.

const effectOf = (w) => Math.floor(w) % 8;
const sizeOf = (w) => Math.floor(Math.floor(w) / 8);

test('a bulb\'s look packs its effect, size and seed, and the houses\' bulbs are as they were', () => {
  for (const [effect, seed, size] of [[0, 0, 0], [4, 0.999, 0], [2, 0.5, 1], [5, 0, 6], [6, 0.25, 5]]) {
    const w = lookW(effect, seed, size);
    assert.equal(effectOf(w), effect);
    assert.equal(sizeOf(w), size);
    assert.ok(Math.abs((w % 1) - Math.min(seed, 0.999)) < 1e-6);
  }
  // A house's bulb, written effect + seed as before
  assert.equal(lookW(EFFECT.chase, 0.3), EFFECT.chase + 0.3);
});

test('a tree: its boughs, star, plinth and fence in proportion to its height, and its bulbs on it', () => {
  for (const tree of CITY_TREES) {
    const base = 10.4, foot = 9.8;
    const kit = treeKit(tree, { base, foot, water: -2.2 });
    assert.equal(kit.pos.length, kit.v * 3);
    assert.equal(kit.v % 3, 0, `${tree.id}: whole triangles`);
    assert.equal(kit.look.length, kit.n * 4);
    // Its height: the star's top as high as the tree is said to be, give or take
    assert.ok(Math.abs(kit.top - base - tree.h) < 1.2, `${tree.id}: its top ${(kit.top - base).toFixed(2)} m over the plinth, ${tree.h} wanted`);
    let minY = Infinity, maxY = -Infinity, reach = 0;
    for (let i = 0; i < kit.v; i++) {
      const x = kit.pos[i * 3], y = kit.pos[i * 3 + 1], z = kit.pos[i * 3 + 2];
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      reach = Math.max(reach, Math.hypot(x, z));
    }
    assert.ok(Math.abs(maxY - kit.top) < 0.05, `${tree.id}: the star's the top`);
    if (tree.float) {
      // The pontoon's hull down into the water, its deck over it
      assert.ok(minY < -2.2 - 0.4 && minY > -2.2 - 1, `${tree.id}: the hull's foot at ${minY}`);
    } else {
      assert.ok(Math.abs(minY - foot) < 0.01, `${tree.id}: nothing under the plinth's foot (${minY})`);
      assert.ok(reach <= plinthOf(tree) + 0.06, `${tree.id}: nothing past the plinth (${reach.toFixed(2)} m out, the plinth ${plinthOf(tree).toFixed(2)})`);
    }
    // Normals of length one, colours in range
    for (let i = 0; i < kit.v; i += 7) {
      const l = Math.hypot(kit.nor[i * 3], kit.nor[i * 3 + 1], kit.nor[i * 3 + 2]);
      assert.ok(Math.abs(l - 1) < 1e-3, `${tree.id}: a normal ${l}`);
      for (let c = 0; c < 3; c++) assert.ok(kit.col[i * 3 + c] >= 0 && kit.col[i * 3 + c] <= 1.5);
    }
    // The bulbs on the tree, within its cone and over the plinth; one glow for the star and one beacon
    let glows = 0, beacons = 0;
    for (let i = 0; i < kit.n; i++) {
      const x = kit.bulbs[i * 4], y = kit.bulbs[i * 4 + 1], z = kit.bulbs[i * 4 + 2], w = kit.look[i * 4 + 3];
      const e = effectOf(w);
      if (e === EFFECT.glow) glows++;
      else if (e === EFFECT.beacon) beacons++;
      else {
        assert.equal(sizeOf(w), 1, `${tree.id}: a tree's bulb is bigger than a house's`);
        assert.ok(y > base + 0.8 && y < kit.top, `${tree.id}: a bulb at ${y - base} m`);
        assert.ok(Math.hypot(x, z) < 0.36 * tree.h + 0.7, `${tree.id}: a bulb ${Math.hypot(x, z).toFixed(2)} m out`);
      }
    }
    assert.equal(glows, 1);
    assert.equal(beacons, 1);
    assert.ok(kit.n > 300 * tree.h / 11, `${tree.id}: ${kit.n} bulbs`);
  }
});

test('fewer bulbs and baubles on a lower level, and each level\'s room holds the city\'s four', () => {
  const city = CITY_TREES.filter((t) => ['martin-place', 'darling-harbour', 'barangaroo', 'the-rocks'].includes(t.id));
  for (const [level, density] of [['low', 0.45], ['medium', 0.75], ['high', 1]]) {
    const kits = city.map((t) => treeKit(t, { base: 0, foot: -0.4, density }));
    const v = kits.reduce((s, k) => s + k.v, 0), n = kits.reduce((s, k) => s + k.n, 0);
    assert.ok(v <= ROOM[level].vertices && n <= ROOM[level].bulbs, `${level}: ${v} vertices, ${n} bulbs against ${JSON.stringify(ROOM[level])}`);
  }
  const low = treeKit(CITY_TREES[0], { density: 0.45 }), high = treeKit(CITY_TREES[0], { density: 1 });
  assert.ok(low.n < high.n * 0.6 && low.v < high.v);
  // The same tree every time
  const again = treeKit(CITY_TREES[0], { density: 1 });
  assert.deepEqual([...again.pos.slice(0, 300)], [...high.pos.slice(0, 300)]);
  assert.deepEqual([...again.bulbs.slice(-40)], [...high.bulbs.slice(-40)]);
});

test('where they stand: their clearings and colliders, and the floating one has neither', () => {
  assert.equal(CITY_TREES.length, 7);
  for (const tree of CITY_TREES) {
    const c = clearingOf(tree), box = colliderOf(tree);
    if (tree.float) {
      assert.equal(c, null);
      assert.equal(box, null);
      continue;
    }
    assert.ok(c.r > plinthOf(tree) + 3);
    assert.equal(box.polygon.outer.length, 16);
    for (const p of box.polygon.outer) assert.ok(Math.abs(Math.hypot(p.x - tree.x, p.z - tree.z) - plinthOf(tree) - 0.05) < 1e-6);
    assert.ok(box.minX < tree.x && box.maxX > tree.x && box.maxY > 2 && box.maxY <= 2.5, 'not a roof to land on (js/controllers.js roofsNear())');
  }
});

/** The trees near (x, z) as the season makes them: its work run to the end, the meshes made without a renderer */
function runTrees({ level = 'high', x, z, reach = 2000, far = 8000, indoor = () => [] }) {
  const origin = { x: 0, z: 0 };
  const cleared = [], held = [];
  const trees = createCityTrees({
    level, reach: () => reach, far: () => far,
    env: { ground: () => 10, prepare: () => false, glow: { value: 0 }, water: -2.2 },
    origin, reveal: async () => {}, anchor: () => {},
    clear: (circles) => { cleared.push(...circles); return () => cleared.splice(0); },
    colliders: { add: (list) => held.push(...list), remove: (list) => list.forEach((c) => held.splice(held.indexOf(c), 1)) },
    indoor
  });
  for (let i = 0; i < 400; i++) {
    const job = trees.work(x, z);
    let step = job.next();
    while (!step.done) step = job.next();
    if (!step.value) break;
  }
  return { trees, cleared, held, origin };
}

test('near the CBD: its four trees made and drawn whole, the others a glow if within reach, and room made for them', () => {
  const { trees, cleared, held } = runTrees({ x: 397, z: -1000 });
  const state = trees.state(397, -1000);
  assert.deepEqual(state.made.sort(), ['barangaroo', 'darling-harbour', 'martin-place', 'the-rocks']);
  assert.equal(state.pending, 0);
  assert.equal(state.drawn.trees, 4);
  // Chatswood, Manly and Parramatta are 8-20 km off: past even high's farRange
  assert.equal(state.drawn.beacons, 0);
  assert.equal(cleared.length, 6);
  assert.equal(held.length, 6);
  const list = trees.list(397, -1000);
  assert.equal(list.find((t) => t.id === 'martin-place').base, 10.25);
  assert.equal(list.find((t) => t.id === 'darling-harbour').base, -2.2 + 0.45 + 0.3);
  const bulbs = trees.group.children.find((m) => m.name === 'ChristmasTreeBulbs');
  assert.equal(bulbs.geometry.instanceCount, state.drawn.bulbs);
  trees.stop();
  assert.equal(held.length, 0);
  assert.equal(cleared.length, 0);
});

test('from North Sydney the CBD\'s trees are past reach: a glow each, nothing made', () => {
  const { trees } = runTrees({ x: -541, z: -3570, reach: 1500 });
  const state = trees.state(-541, -3570);
  assert.equal(state.made.length, 0);
  assert.equal(state.drawn.trees, 0);
  assert.equal(state.drawn.vertices, 0);
  assert.ok(state.drawn.beacons >= 4);
});

test('the origin moving writes the trees from it again', () => {
  const { trees, origin } = runTrees({ x: -6, z: -640, reach: 300 });
  const bulbs = trees.group.children.find((m) => m.name === 'ChristmasTreeBulbs').geometry.attributes.aBulb;
  const before = bulbs.array[0];
  origin.x = 4096;
  const job = trees.work(-6, -640);
  let step = job.next();
  while (!step.done) step = job.next();
  assert.equal(step.value, true);
  assert.ok(Math.abs(bulbs.array[0] - (before - 4096)) < 1e-3);
});

// The QVB's tree, under its dome: where its model's inside keeps a spot for it (js/interiors.js spots()), made while that's held
test('a tree indoors: made where an inside held keeps its spot, on its floor, slim, no glow far off, and gone when the inside is', () => {
  // the QVB's spot as js/interiors.js gives it: its ground floor 21.5 m up, the map's ground round it 10 m in this test
  const spot = { kind: 'christmas-tree', id: 'qvb', site: 'qvb', x: -39.9, y: 21.5, z: -143.4, h: 19, r: 3.4 };
  let spots = [spot];
  const run = runTrees({ x: -40, z: -150, reach: 300, indoor: () => spots });
  const { trees, held } = run;
  let state = trees.state(-40, -150);
  assert.ok(state.made.includes('qvb:qvb'), `made: ${state.made}`);
  assert.deepEqual(state.indoor, ['qvb:qvb']);
  const it = trees.list(-40, -150).find((t) => t.id === 'qvb:qvb');
  assert.equal(it.base, 21.75, 'its plinth on the floor');
  assert.ok(it.indoor);
  // slimmer than a street's of its height: its plinth from the spot's reach, and its fence a collider at the floor's height
  const collider = held.find((c) => c.level && Math.abs(c.minX + c.maxX - 2 * spot.x) < 1e-6);
  assert.ok(collider, 'no collider round its plinth');
  assert.equal(collider.minY, 21.5);
  assert.equal(collider.baseY, 21.5);
  assert.ok(Math.abs((collider.maxX - collider.minX) / 2 - (plinthOf({ h: 19, r: 3.4 }) + 0.05)) < 1e-6);
  assert.ok(plinthOf({ h: 19, r: 3.4 }) < plinthOf({ h: 19 }) - 2);
  // its kit up to the star, from its floor
  const kit = treeKit({ id: 'qvb:qvb', h: 19, r: 3.4, lights: 'warm', baubles: 'silver' }, { base: 21.75, foot: 21.5 });
  assert.ok(Math.abs(kit.top - (21.75 + 19)) < 1.0, `its star's top at ${kit.top}`);
  // no beacon of its own far off: from 2 km it's nothing (the CBD's trees are glows)
  const away = runTrees({ x: 1800, z: -1000, reach: 300, indoor: () => spots });
  assert.ok(!away.trees.state(1800, -1000).made.includes('qvb:qvb'));
  // the inside let go of: its tree and its fence go with it
  spots = [];
  const job = trees.work(-40, -150);
  let step = job.next();
  while (!step.done) step = job.next();
  state = trees.state(-40, -150);
  assert.ok(!state.made.includes('qvb:qvb') && !state.indoor.length);
  assert.ok(!held.includes(collider));
});
