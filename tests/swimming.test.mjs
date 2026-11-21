// Swimming in a model's pool (js/swimming.js) with the walker's own controller (js/controllers.js): its ways in and out, the water holding
// the swimmer, and the rig's poses. North Sydney Pool's own pools (public/models/north-sydney-pool.json), at a made-up site.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import * as THREE from 'three';

const require = createRequire(import.meta.url);
const { loadModule } = require('./helpers/module.cjs');
const { keyboardHarness } = require('./helpers/controllers.cjs');
const { stillWater } = require('./helpers/still-water.cjs');
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

// The rig, numbers only: its materials are never made
const tsl = new Proxy({}, { get: () => () => ({}) });
const { PersonRig, PERSON_BONES } = loadModule(read('../js/pedestrians.js'), {
  imports: { 'three/webgpu': THREE, 'three/tsl': tsl, 'three/addons/utils/BufferGeometryUtils.js': {}, './surfaces.js': { groundHeight: () => 0 } }
});
const POOLS = JSON.parse(read('../public/models/north-sydney-pool.json')).pools;
const SITE = { x: 100, y: 6.4, z: 50, yaw: 0.4 };
const DT = 1 / 60;

/** The walker beside or in the pool, with its controller: `at` [x, z] and `dir` [x, z] in the pool's frame */
function setup(at = [0, 11.2], dir = [0, -1]) {
  const floors = new Map();
  const swim = loadModule(read('../js/swimming.js'), {
    imports: { 'three/webgpu': THREE, './surfaces.js': { setFloor: (k, f) => floors.set(k, f), clearFloor: (k) => floors.delete(k) } }
  });
  swim.addSwimPools('site', SITE, POOLS);
  const e = swim.poolAt(SITE.x, SITE.z);
  const world = (x, z) => swim.toWorld(e, x, z);
  // The pools are still water to a walker, as js/interiors.js makes them
  const water = stillWater();
  water.addStillWater('site:site', POOLS.map((p) => p.ring.map(([x, z]) => world(x, z))), 'pool');
  const harness = keyboardHarness({ CITY_BOUNDS: { minX: -1e4, maxX: 1e4, minZ: -1e4, maxZ: 1e4, sidewalkHeight: 0.22 }, blockAt: () => null }, {}, {}, water);
  const { controller } = harness;
  const w = world(...at);
  const p = {
    type: 'person', position: { x: w.x, y: 0, z: w.z }, heading: Math.atan2(dir[0], dir[1]) + SITE.yaw, speed: 0, sideSpeed: 0, verticalVel: 0,
    jumping: false, jumpPrep: 0, mesh: { visible: true, position: new THREE.Vector3(), rotation: {} }, rig: new PersonRig({ seed: 4.2 }), crowd: { updates: 0, begin() {}, add() {}, end() {} },
    swim: null, dive: null, swimEvents: []
  };
  p.rig.reset(w.x, w.z, p.heading, () => 0);
  Object.assign(controller, { activeMode: 'person', colliders: [], _colliderCells: null, _walkerCells: new Map(), entities: { person: p }, swim, jumpQueued: 0 });
  const step = (frames = 1, each = null) => {
    for (let i = 0; i < frames; i++) {
      controller.updatePerson(DT);
      controller.poseCharacters(DT);
      each?.();
    }
  };
  const local = () => swim.toLocal(e, p.position.x, p.position.z);
  const face = (x, z) => { p.heading = Math.atan2(x, z) + SITE.yaw; };
  return { controller, swim, e, p, step, local, face, world, floors, harness };
}

test('the water\'s frame: a floor at the deck\'s level over the 50 m pool, and the bottom under it the steps\' treads or the floor', () => {
  const { swim, floors, world } = setup();
  const floor = floors.get('swim:site');
  assert.ok(floor, 'no floor for the water');
  const mid = world(0, 0), deck = world(0, 12), kids = world(34, -4);
  assert.equal(floor.at(mid.x, mid.z), SITE.y, 'over the water, the deck\'s level');
  assert.equal(floor.at(deck.x, deck.z), null, 'none over the deck, which has its own');
  assert.equal(floor.at(kids.x, kids.z), null, 'none over the kids\' pool, which isn\'t swum in');
  const deep = world(-24, 0), steps = world(24.8, 9), shallow = world(20, 0);
  assert.ok(Math.abs(swim.bottomUnder(deep.x, deep.z) + 2.2) < 1e-9, 'the deep end 2 m under the surface');
  assert.ok(Math.abs(swim.bottomUnder(shallow.x, shallow.z) + 1.4) < 1e-9, 'the shallow end 1.2 m');
  assert.ok(Math.abs(swim.bottomUnder(steps.x, steps.z) + 0.25) < 1e-9, 'the top tread');
  assert.equal(swim.bottomUnder(deck.x, deck.z), null);
});

test('at a pool\'s edge its water holds a walker going along it, and lets one in that pushes straight at it: in, it swims', () => {
  const { controller, p, step, local, face } = setup([-10, 11.2], [1, -0.12]);
  controller.keys.forward = true;
  step(150, () => assert.ok(local().z >= 10.75 && !p.swim, `along the edge at a slant, into the water at z ${local().z.toFixed(2)}`));
  assert.ok(local().x > -8, 'it slid along the edge');
  face(0, -1);
  step(12, () => assert.ok(local().z >= 10.75, 'straight at it, in at once'));
  step(60);
  assert.ok(p.swim, `pushing on, never in: at z ${local().z.toFixed(2)}`);
  assert.ok(local().z < 10.5 - 0.35, 'in, off the wall');
  controller.keys.forward = false;
  const splash = p.swimEvents.find((ev) => ev.sound === 'splash');
  assert.ok(splash && splash.strength < 0, 'a splash going in');
  // It goes under, then floats with its eye just out of the water
  let deepest = Infinity;
  step(240, () => { deepest = Math.min(deepest, p.position.y + 1.68 + 0.2); });
  assert.ok(deepest < -0.1, `never under, going in (its eye ${deepest.toFixed(2)} m from the surface at the deepest)`);
  const eye = p.position.y + 1.68 + 0.2;
  assert.ok(Math.abs(eye - 0.12) < 0.03, `floating with its eye ${eye.toFixed(3)} m over the surface`);
});

test('swimming goes at about 1 m/s, faster with Shift, slower back; the walls hold the swimmer in', () => {
  const { controller, p, swim, step, local, world } = setup();
  const at = world(-10, 0);
  swim.place(p, at.x, at.z, Math.PI / 2 + SITE.yaw);
  controller.keys.forward = true;
  // what it stirs, each frame (js/main.js takes them)
  let strokes = 0;
  const heard = () => {
    strokes += p.swimEvents.filter((ev) => ev.sound === 'stroke').length;
    p.swimEvents.length = 0;
  };
  step(240, heard);
  assert.ok(Math.abs(p.speed - 1.0) < 0.01, `swimming at ${p.speed.toFixed(2)} m/s`);
  assert.ok(p.swim.m > 0.9, 'its freestyle on, moving');
  controller.keys.run = true;
  step(120, heard);
  assert.ok(Math.abs(p.speed - 1.6) < 0.01, `faster at ${p.speed.toFixed(2)} m/s`);
  step(60 * 30, heard);
  assert.ok(Math.abs(local().x - (25 - 0.4)) < 0.01, `held off the end wall at x ${local().x.toFixed(2)}`);
  controller.keys.run = false;
  controller.keys.forward = false;
  controller.keys.backward = true;
  step(180);
  assert.ok(Math.abs(p.speed + 0.45) < 0.01, `back at ${p.speed.toFixed(2)} m/s`);
  controller.keys.backward = false;
  step(240);
  assert.ok(p.swim.m < 0.1, 'treading water, still');
  // the strokes stirred the water: a hand in, each stroke
  assert.ok(strokes > 30, `${strokes} strokes heard in 36 s`);
});

test('out at the edge: the jump key facing the wall climbs out onto the deck; facing away, nothing', () => {
  const { controller, p, swim, step, local, world, face } = setup();
  const at = world(0, 9.95);
  swim.place(p, at.x, at.z, 0);
  face(0, -1);
  controller.jumpQueued = 0.15;
  step(2);
  assert.equal(p.swim?.mode, 'swim', 'climbed out facing away from the wall');
  face(0, 1);
  assert.equal(controller.swimPrompt(), 'Climb out');
  controller.jumpQueued = 0.15;
  step(2);
  assert.equal(p.swim?.mode, 'climb');
  step(80);
  assert.equal(p.swim, null, 'still climbing after 1.4 s');
  assert.ok(Math.abs(local().z - 11.0) < 0.02 && p.position.y === 0, `out at z ${local().z.toFixed(2)}, ${p.position.y} m`);
  // ...and walks on
  controller.keys.forward = true;
  step(30);
  assert.ok(local().z > 11.1 && !p.swim, 'can\'t walk away');
});

test('down the steps, a tread at a time, then swimming in the shallow end; back onto them, standing, and up them out', () => {
  const { controller, p, step, local, face } = setup([26.3, 9.2], [-1, 0]);
  controller.keys.forward = true;
  let last = p.position.y, biggest = 0, wading = false;
  step(300, () => {
    biggest = Math.max(biggest, Math.abs(p.position.y - last));
    last = p.position.y;
    if (!p.swim && local().x < 24.6 && local().x > 23.5) wading = true;
  });
  assert.ok(wading, 'never walked on the treads');
  assert.ok(biggest < 0.3, `a step of ${biggest.toFixed(2)} m in a frame going down`);
  assert.ok(p.swim, `not swimming past the steps, at x ${local().x.toFixed(2)}`);
  assert.ok(local().x < 23, 'swimming over the steps');
  assert.equal(controller.canSwitchTo('car'), false, 'the car in the water past the steps');
  // Round, and back: stood up on them, walked up, out
  controller.keys.forward = false;
  step(60);
  face(1, 0);
  controller.keys.forward = true;
  let stood = null;
  step(300, () => { if (!p.swim && stood === null) stood = local().x; });
  assert.ok(stood !== null && stood > 23.3 && stood < 23.9, `stood up at x ${stood}`);
  assert.ok(local().x > 25.2 && p.position.y === 0 && !p.swim, `out on the deck at (${local().x.toFixed(2)}, ${p.position.y.toFixed(2)})`);
});

test('down the steps, stopping the moment it swims: still swimming, on the last tread or past it, and no car', () => {
  const { controller, p, step, local } = setup([26.3, 9.2], [-1, 0]);
  controller.keys.forward = true;
  step(400, () => { if (p.swim) controller.keys.forward = false; });
  assert.ok(p.swim, `standing again at x ${local().x.toFixed(2)}, ${p.position.y.toFixed(2)} m`);
  assert.equal(controller.canSwitchTo('car'), false);
});

test('a ladder: swum into, climbed up onto the deck; walked onto from the deck, climbed down into the water, turned to the pool', () => {
  const { controller, p, swim, step, local, world, face } = setup();
  const at = world(-21.5, 9.7);
  swim.place(p, at.x, at.z, 0);
  face(0, 1);
  controller.keys.forward = true;
  step(2);
  assert.ok(p.swim?.mode === 'climb' && p.swim.climb.kind === 'up', 'not climbing the ladder');
  controller.keys.forward = false;
  step(150);
  assert.equal(p.swim, null);
  assert.ok(Math.abs(local().z - 11.0) < 0.02 && Math.abs(local().x + 21.5) < 0.02 && p.position.y === 0, `out at ${JSON.stringify(local())}`);
  // From its top, back down
  controller.keys.forward = false;
  face(0, -1);
  step(30);
  const top = world(-21.5, 10.95);
  Object.assign(p.position, { x: top.x, z: top.z, y: 0 });
  p.position.landed = { x: top.x, z: top.z };
  assert.equal(controller.swimPrompt(), 'Climb down');
  controller.keys.forward = true;
  step(2);
  assert.ok(p.swim?.climb?.kind === 'down', 'not climbing down');
  controller.keys.forward = false;
  step(170);
  assert.ok(p.swim?.mode === 'swim', 'not swimming at the ladder\'s foot');
  const d = swim.toLocal(p.swim.pool, p.position.x + Math.sin(p.heading), p.position.z + Math.cos(p.heading));
  assert.ok(d.z < local().z - 0.9, 'not turned to face the pool');
  assert.ok(Math.abs(local().z - (10.5 - 0.45)) < 0.05, `at the ladder's foot at z ${local().z.toFixed(2)}`);
});

test('a jump at the edge facing the water is a dive: out over it, in head first with a splash, under a moment, then up', () => {
  const { controller, p, step, local, swim } = setup([0, 11.3], [0, -1]);
  controller.jumpQueued = 0.15;
  let entered = null, deepest = Infinity, dived = false;
  step(150, () => {
    if (p.dive?.launched) dived = true;
    if (p.swim && entered === null) entered = local().z;
    if (p.swim) deepest = Math.min(deepest, p.position.y + 1.68 + 0.2);
  });
  assert.ok(dived, 'no dive');
  assert.ok(entered !== null && entered < 9.6, `in at z ${entered}, too near the edge`);
  assert.ok(deepest < -0.4, `its eye only ${deepest.toFixed(2)} m under, gliding`);
  assert.ok(p.swimEvents.some((ev) => ev.sound === 'splash'), 'no splash');
  step(240);
  assert.ok(Math.abs(swim.state(p).eye - 0.12) < 0.04, 'not back up');
  // A jump away from the water is a jump
  const b = setup([0, 12.5], [0, 1]);
  b.controller.jumpQueued = 0.15;
  b.step(70);
  assert.ok(!b.p.dive && b.p.jumping === false && !b.p.swim, 'a jump away from the water dived');
});

test('in the water: no car or bike; out of it at once wherever it\'s put; saved, it\'s put beside the pool', () => {
  const { controller, p, swim, world } = setup();
  const at = world(-5, 3);
  swim.place(p, at.x, at.z, 0);
  assert.equal(controller.canSwitchTo('car'), false);
  assert.equal(controller.canSwitchTo('cyclist'), false);
  assert.equal(controller.canSwitchTo('helicopter'), true);
  assert.equal(controller.switchMode('car'), null, 'switched to the car in the water');
  const side = controller.poolside();
  const l = swim.toLocal(p.swim.pool, side.x, side.z);
  assert.ok(l.z > 10.5 + 0.5 && Math.abs(l.x + 5) < 1e-6, `beside it at ${JSON.stringify(l)}`);
  controller.teleportActiveTo(0, 0, 0, null, 0, true);
  assert.equal(p.swim, null, 'still swimming after a teleport');
  assert.equal(controller.canSwitchTo('car'), true);
});

// The rig's joints as drawn: a bone's joint, or a point in its bind pose
const joint = (rig, b, point = null) => {
  const o = b * 8, a = rig.pose;
  const q = new THREE.Quaternion(a[o], a[o + 1], a[o + 2], a[o + 3]);
  const v = (point ?? rig.bind[b]).clone().applyQuaternion(q).multiplyScalar(a[o + 7]);
  return new THREE.Vector3(a[o + 4] + v.x, a[o + 5] + v.y, a[o + 6] + v.z);
};

test('the swimmer\'s poses: treading water, its head out and its feet under it; swimming, flat at the surface, its arms going round', () => {
  const { p, swim, world } = setup();
  const at = world(0, 0);
  swim.place(p, at.x, at.z, SITE.yaw);
  const rig = p.rig, B = PERSON_BONES, water = -0.2;
  swim.pose(p, DT);
  const head = joint(rig, B.HEAD), pelvis = joint(rig, B.PELVIS), foot = joint(rig, B.FOOT_L);
  assert.ok(head.y > water - 0.1 && head.y + 0.25 > water + 0.15, `treading, its head at ${head.y.toFixed(2)}`);
  assert.ok(pelvis.y < water - 0.4 && foot.y < pelvis.y - 0.5, 'treading, upright under the water');
  // Flat, swimming: the chest just under the surface, the head ahead and the feet behind along the heading
  p.speed = 1;
  p.swim.m = 1;
  const fwd = new THREE.Vector3(Math.sin(p.heading), 0, Math.cos(p.heading));
  const palm = new THREE.Vector3(0.262, 0.88, -0.015); // the left hand's middle, in its bind pose
  let over = 0, under = 0, along = [Infinity, -Infinity];
  for (let k = 0; k < 120; k++) {
    p.swim.phase = k / 120;
    swim.pose(p, DT);
    const chest = joint(rig, B.CHEST), h = joint(rig, B.HEAD), f = joint(rig, B.FOOT_L), hand = joint(rig, B.FOREARM_L, palm);
    assert.ok(Math.abs(chest.y - water) < 0.15, `swimming, its chest at ${chest.y.toFixed(2)}`);
    assert.ok(h.clone().sub(chest).dot(fwd) > 0.3 && f.clone().sub(chest).dot(fwd) < -0.8, 'not lying along its heading');
    if (hand.y > water + 0.05) over++;
    if (hand.y < water - 0.3) under++;
    const a = hand.clone().sub(chest).dot(fwd);
    along = [Math.min(along[0], a), Math.max(along[1], a)];
  }
  assert.ok(over > 15 && under > 30, `the hand over the water ${over} and deep under it ${under} of 120 frames of its stroke`);
  assert.ok(along[1] - along[0] > 0.9, `its hand only ${(along[1] - along[0]).toFixed(2)} m from front to back`);
  // The body for the water's trace: along it, its middle under the surface
  const body = swim.traceBody(p);
  assert.ok(body.at.y < SITE.y + water && body.at.y > SITE.y + water - 0.3 && Math.abs(body.u[1]) < 0.3, 'its body in the trace');
});
