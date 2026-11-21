// Floors that move (a model's floor with a `flow`: an escalator's steps): the floor under a walker is the one js/interior-data.js picks,
// js/surfaces.js says how fast it carries, and the walker's own step (js/controllers.js updatePerson()) adds it, standing or walking.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import * as THREE from 'three';

const require = createRequire(import.meta.url);
const { keyboardHarness } = require('./helpers/controllers.cjs');
const { loadModule } = require('./helpers/module.cjs');
// The walker's rig, numbers only: its materials are never made
const tsl = new Proxy({}, { get: () => () => ({}) });
const { PersonRig } = loadModule(readFileSync(new URL('../js/pedestrians.js', import.meta.url), 'utf8'), {
  imports: { 'three/webgpu': THREE, 'three/tsl': tsl, 'three/addons/utils/BufferGeometryUtils.js': {}, './surfaces.js': { groundHeight: () => 0 } }
});
const { floorAt, floorUnder } = await import('../js/interior-data.js');
const DT = 1 / 60;

// A level floor at 0, a slope up along +x from x 0 to 13 (to 7.5 m) that carries at 0.65 m/s, a landing at its head
const FLOORS = [
  { poly: [[-5, 0], [0, 0], [0, 1.4], [-5, 1.4]], y: 0 },
  { poly: [[0, 0], [13, 0], [13, 1.4], [0, 1.4]], plane: [0, 7.5 / 13, 0], flow: [0.65, 0] },
  { poly: [[13, 0], [18, 0], [18, 1.4], [13, 1.4]], y: 7.5 }
];

test('the floor under you is the one you stand on: on a slope that moves, that slope, and its flow with it', () => {
  assert.equal(floorUnder(FLOORS, -1, 0.7, 0).floor, FLOORS[0]);
  const on = floorUnder(FLOORS, 6.5, 0.7, 3.6);
  assert.equal(on.floor.flow[0], 0.65);
  assert.ok(Math.abs(on.y - 3.75) < 1e-9);
  assert.equal(floorAt(FLOORS, 6.5, 0.7, 3.6), on.y, 'floorAt is floorUnder\'s height');
  assert.equal(floorUnder(FLOORS, 30, 0.7, 0), null);
});

/** A walker on the escalator above, with its floors as js/interiors.js hands them to js/surfaces.js (`at`, `flow`) */
function setup(x) {
  let ref = 0;
  const floor = {
    at: (wx, wz) => floorAt(FLOORS, wx, wz, ref),
    flow: (wx, wz) => {
      const f = floorUnder(FLOORS, wx, wz, ref)?.floor.flow;
      return f ? { x: f[0], z: f[1] } : null;
    }
  };
  const surfaces = {
    onFloor: (wx, wz) => floor.at(wx, wz) !== null,
    floorFlow: (wx, wz) => (floor.at(wx, wz) === null ? null : floor.flow(wx, wz)),
    groundHeight: (wx, wz) => floor.at(wx, wz) ?? 0
  };
  const { controller } = keyboardHarness({ CITY_BOUNDS: { minX: -1e4, maxX: 1e4, minZ: -1e4, maxZ: 1e4, sidewalkHeight: 0.22 } }, {}, {}, undefined, surfaces);
  const p = {
    type: 'person', position: { x, y: 0, z: 0.7 }, heading: Math.PI / 2, speed: 0, sideSpeed: 0, verticalVel: 0, jumping: false, jumpPrep: 0,
    mesh: { visible: true, position: new THREE.Vector3(), rotation: {} }, crowd: { updates: 0, begin() {}, add() {}, end() {} }, swim: null,
    dive: null, rig: new PersonRig({ seed: 2.5 })
  };
  // the rig's heights are over the ground, which a model's floor is (js/controllers.js personGround)
  p.rig.reset(x, 0.7, p.heading, () => 0);
  Object.assign(controller, { activeMode: 'person', colliders: [], _colliderCells: null, _walkerCells: new Map(), entities: { person: p }, jumpQueued: 0 });
  const step = (frames) => {
    for (let i = 0; i < frames; i++) {
      controller.updatePerson(DT);
      ref = floor.at(p.position.x, p.position.z) ?? ref;
      controller.poseCharacters(DT);
    }
  };
  return { controller, p, step, height: () => floor.at(p.position.x, p.position.z) };
}

test('standing on an escalator, it carries you up it, and leaves you on its head\'s landing', () => {
  const { p, step, height } = setup(1.0);
  step(60);
  assert.ok(Math.abs(p.position.x - 1.65) < 0.01, `carried 1 s to x ${p.position.x.toFixed(3)}`);
  assert.equal(p.speed, 0, 'standing: your own pace is nothing');
  assert.ok(Math.abs(p.carried.x - 0.65) < 1e-9);
  step(60 * 20);
  assert.ok(p.position.x > 13 && p.position.x < 13.05, `off its slope at x ${p.position.x.toFixed(3)}, carried no further`);
  assert.equal(height(), 7.5);
  assert.equal(p.carried, null);
});

test('walking up an escalator, its flow and your step add; walking down it, you go slower than on a stair', () => {
  const up = setup(1.0);
  up.controller.keys.forward = true;
  up.step(120);
  const walked = up.p.position.x - 1.0;
  const still = setup(1.0);
  still.step(120);
  assert.ok(walked > still.p.position.x - 1.0 + 1.0, `walking up went ${walked.toFixed(2)} m in 2 s, standing ${(still.p.position.x - 1).toFixed(2)}`);
  const down = setup(12.0);
  down.p.heading = -Math.PI / 2;
  down.controller.keys.forward = true;
  down.step(120);
  const plain = setup(-1.0);
  plain.p.heading = -Math.PI / 2;
  plain.controller.keys.forward = true;
  plain.step(120);
  assert.ok(12.0 - down.p.position.x < -1.0 - plain.p.position.x - 1.0, 'walking down it against its flow');
  assert.ok(12.0 - down.p.position.x > 0.5, 'but still down it');
});

test('standing on it, you stand: the rig is carried with its feet on the step, and doesn\'t walk', () => {
  const { p, step } = setup(1.0);
  step(60 * 4);
  const rig = p.rig;
  assert.ok(rig.gait < 0.05, `its gait ${rig.gait.toFixed(3)} while carried`);
  assert.ok(Math.abs(rig.x - p.position.x) < 1e-6, 'the rig where the walker is');
  for (const f of rig.feet) {
    assert.ok(!f.swing, 'a foot stepping');
    assert.ok(Math.hypot(f.px - p.position.x, f.pz - p.position.z) < 0.4, `a foot left behind ${Math.hypot(f.px - p.position.x, f.pz - p.position.z).toFixed(2)} m`);
    assert.ok(Math.abs(f.py) < 0.05, `a foot ${f.py.toFixed(2)} m off the step`);
  }
});

test('in the air, a floor carries nothing', () => {
  const { p, step } = setup(1.0);
  p.jumping = true;
  p.position.y = 0.5;
  p.verticalVel = 2;
  const x = p.position.x;
  step(1);
  assert.equal(p.position.x, x);
});
