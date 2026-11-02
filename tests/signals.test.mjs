import assert from 'node:assert/strict';
import test from 'node:test';
import { JunctionLights, TIMING, assignLights, clusterSignals, junctionKey } from '../js/signals.js';

const nobody = { demand: () => false, flowing: () => false, people: () => false };
const run = (lights, seconds, ask = nobody, dt = 0.1) => {
  for (let t = 0; t < seconds; t += dt) lights.update(dt, ask);
};

test('with nobody on the other road, a green stays green', () => {
  const lights = new JunctionLights([0, 1]);
  run(lights, 200);
  assert.equal(lights.phaseOf(0), 'green');
  assert.equal(lights.phaseOf(1), 'red');
});

test('someone alone at a red gets a green as soon as the minimum allows', () => {
  const lights = new JunctionLights([0, 1]);
  const ask = { ...nobody, demand: (g) => g === 1 };
  let waited = 0;
  while (lights.phaseOf(1) !== 'green') {
    lights.update(0.1, ask);
    waited += 0.1;
    assert.ok(waited < 60, 'never turned green');
  }
  assert.ok(waited <= TIMING.minGreen + TIMING.amber + TIMING.allRed + 0.3, `waited ${waited.toFixed(1)} s`);
});

test('a road still flowing keeps its green up to the maximum, then gives way', () => {
  const lights = new JunctionLights([0, 1]);
  const ask = { ...nobody, demand: () => true, flowing: () => true };
  run(lights, TIMING.maxGreen - 1, ask);
  assert.equal(lights.phaseOf(0), 'green');
  run(lights, 1.5, ask);
  assert.equal(lights.phaseOf(0), 'amber');
  run(lights, TIMING.amber + 0.2, ask);
  assert.equal(lights.phaseOf(0), 'red');
  assert.equal(lights.phaseOf(1), 'red', 'all red for a moment');
  run(lights, TIMING.allRed + 0.2, ask);
  assert.equal(lights.phaseOf(1), 'green');
});

test('standing cars with nowhere to go do not hold a green', () => {
  const lights = new JunctionLights([0, 1]);
  const ask = { ...nobody, demand: () => true, flowing: () => false };
  run(lights, TIMING.minGreen + 0.2, ask);
  assert.equal(lights.phaseOf(0), 'amber');
});

test('every direction gets its turn at a junction of three', () => {
  const lights = new JunctionLights([0, 1, 2]);
  const ask = { ...nobody, demand: () => true, flowing: () => false };
  const seen = new Set();
  for (let t = 0; t < 60; t += 0.1) {
    lights.update(0.1, ask);
    for (const g of [0, 1, 2]) if (lights.phaseOf(g) === 'green') seen.add(g);
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2]);
});

test('a road with only one direction arriving never holds anyone, until someone needs to cross it', () => {
  const lights = new JunctionLights([0]);
  run(lights, 200);
  assert.equal(lights.phaseOf(0), 'green');
  const ask = { ...nobody, people: (g) => g === 0 };
  run(lights, TIMING.amber + TIMING.allRed, ask);
  assert.equal(lights.phaseOf(0), 'red');
  assert.equal(lights.mayWalk(0), true, 'all red, so they can cross');
  lights.walking(8);
  run(lights, 6, nobody);
  assert.equal(lights.phaseOf(0), 'red', 'held until they are across');
  run(lights, 3, nobody);
  assert.equal(lights.phaseOf(0), 'green');
});

test('people cross with the other road\'s green, and hold it until they are over', () => {
  const lights = new JunctionLights([0, 1]);
  assert.equal(lights.mayWalk(0), false, 'not across the road that has the green');
  assert.equal(lights.mayWalk(1), true);
  assert.equal(lights.mayWalk(-1), true, 'a road with nothing arriving');
  lights.walking(10);
  const ask = { ...nobody, demand: () => true };
  run(lights, TIMING.minGreen + 1, ask);
  assert.equal(lights.phaseOf(0), 'green', 'held for the people crossing');
  run(lights, 3, ask);
  assert.equal(lights.phaseOf(0), 'amber');
});

test('no one sets off who would not get across before someone waiting gets their turn', () => {
  const lights = new JunctionLights([0, 1]);
  const ask = { ...nobody, demand: () => true, flowing: () => true };
  run(lights, TIMING.maxGreen - 5, ask);
  assert.equal(lights.mayWalk(1, 12), false);
  assert.equal(lights.mayWalk(1, 4), true);
});

test('waiting to cross the road with the green is a reason to change', () => {
  const lights = new JunctionLights([0, 1]);
  const ask = { ...nobody, people: (g) => g === 0 };
  run(lights, TIMING.minGreen + TIMING.amber + TIMING.allRed + 0.5, ask);
  assert.equal(lights.phaseOf(1), 'green');
  assert.equal(lights.mayWalk(0), true);
});

const edge = (axisIndex, dx, dz, lanes = 1) => ({ axisIndex, dx, dz, lanes: Array(lanes).fill(0) });
const node = (x, z, approaches, points = []) => ({ x, z, signal: true, in: approaches, approach: approaches, points });

test('junctions close together are one, and far ones are not', () => {
  const groups = clusterSignals([node(0, 0, []), node(30, 0, []), node(60, 0, []), node(500, 0, []), { x: 1, z: 1, signal: false }]);
  assert.deepEqual(groups.map((g) => g.length).sort(), [1, 3]);
});

test('a divided road gets one green, by direction', () => {
  const a = node(0, 0, [edge(0, 0, 1, 3), edge(1, 1, 0)]);
  const b = node(30, 0, [edge(0, 0, -1, 3), edge(1, 1, 0)]);
  const known = new Map();
  const [{ lights }] = assignLights([a, b], known, null, () => 0);
  assert.equal(a.lights, b.lights);
  assert.equal(a.in[0].lightGroup, b.in[0].lightGroup, 'both directions of the divided road');
  assert.equal(a.in[1].lightGroup, b.in[1].lightGroup);
  assert.notEqual(a.in[0].lightGroup, a.in[1].lightGroup);
  assert.deepEqual(lights.groups, [0, 1]);
});

test('lights carry over when the road network is rebuilt', () => {
  const known = new Map(), heads = new Map();
  const first = node(10, 20, [edge(0, 0, 1), edge(1, 1, 0)], [{ x: 11, z: 21 }]);
  assignLights([first], known, heads, () => 0.5);
  first.lights.t = 3.25;
  const second = node(10, 20, [edge(0, 0, 1), edge(1, 1, 0)], [{ x: 11, z: 21 }]);
  assignLights([second], known, heads, () => 0.5);
  assert.equal(second.lights.t, 3.25);
  assert.deepEqual(heads.get(junctionKey(11, 21)), { lights: second.lights, main: 0, side: 1 });
});

test('a road arriving nowhere has no light to wait for', () => {
  const n = node(0, 0, [edge(0, 0, 1)]);
  n.approach = [n.in[0], null];
  assignLights([n], new Map(), null, () => 0);
  assert.deepEqual(n.sideLight, [0, -1]);
});
