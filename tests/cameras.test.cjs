const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const source = readFileSync(join(__dirname, '../js/cameras.js'), 'utf8');

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { return this.set(v.x, v.y, v.z); }
  add(v) { return this.set(this.x + v.x, this.y + v.y, this.z + v.z); }
  sub(v) { return this.set(this.x - v.x, this.y - v.y, this.z - v.z); }
  subVectors(a, b) { return this.copy(a).sub(b); }
  lerp(v, t) { return this.set(this.x + (v.x - this.x) * t, this.y + (v.y - this.y) * t, this.z + (v.z - this.z) * t); }
  clone() { return new Vector3(this.x, this.y, this.z); }
}

class PerspectiveCamera {
  constructor(fov, aspect) {
    this.fov = fov;
    this.aspect = aspect;
    this.position = new Vector3();
    this.target = new Vector3();
  }
  updateProjectionMatrix() {}
  lookAt(v) { this.target.copy(v); }
}

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    }
  };
}

function cameraHarness(entity = {
  position: new Vector3(0, 0, 100), heading: 0, speed: 0, type: 'car',
  chaseDistance: 6.9, chaseHeight: 2.12, cameraTargetOffset: new Vector3(0, 1, 0)
}) {
  const window = eventTarget();
  const document = { ...eventTarget(), hidden: false };
  const canvas = { ...eventTarget(), style: {} };
  const controls = eventTarget();
  const captured = new Set();
  canvas.setPointerCapture = (id) => captured.add(id);
  canvas.hasPointerCapture = (id) => captured.has(id);
  canvas.releasePointerCapture = (id) => {
    captured.delete(id);
    canvas.dispatch('lostpointercapture', { pointerId: id });
  };
  window.innerWidth = 1600;
  window.innerHeight = 900;
  const { CameraSystem } = loadModule(source, {
    globals: { window, document },
    imports: { 'three/webgpu': { Vector3, PerspectiveCamera } }
  });
  const camera = new CameraSystem(canvas, { getActiveEntity: () => entity });
  return {
    camera, canvas, controls, window, document, captured, entity,
    pointer(target, type, id, x, y = 0, pointerType = 'touch', button = 0) {
      const event = {
        pointerId: id, clientX: x, clientY: y, pointerType, button,
        prevented: false, preventDefault() { this.prevented = true; }
      };
      // Captured pointers keep reaching the canvas after moving over the controls.
      (captured.has(id) ? canvas : target).dispatch(type, event);
      window.dispatch(type, event);
      return event;
    }
  };
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should equal ${expected}`);
}

test('UI touches neither move nor release an active canvas orbit', () => {
  const h = cameraHarness();
  assert.equal(h.canvas.style.touchAction, 'none');
  h.pointer(h.controls, 'pointerdown', 1, 20);
  h.pointer(h.canvas, 'pointerdown', 2, 100);
  assert.equal(h.captured.has(1), false);
  assert.equal(h.captured.has(2), true);

  h.pointer(h.controls, 'pointermove', 1, 300);
  close(h.camera.orbitYawOffset, 0);
  h.pointer(h.controls, 'pointerup', 1, 300);
  assert.equal(h.camera.isDragging, true);
  h.pointer(h.controls, 'pointermove', 2, 110);
  close(h.camera.orbitYawOffset, -0.065);
  h.pointer(h.controls, 'pointerup', 2, 110);
  assert.equal(h.camera.isDragging, false);
});

test('two canvas touches pinch without orbiting and one remaining touch resumes smoothly', () => {
  const h = cameraHarness();
  h.pointer(h.canvas, 'pointerdown', 1, 0);
  h.pointer(h.canvas, 'pointerdown', 2, 100);
  h.pointer(h.canvas, 'pointermove', 2, 200);
  close(h.camera.zoomMultiplier, 0.5);
  close(h.camera.orbitYawOffset, 0);
  close(h.camera.orbitPitchOffset, 0.09);
  h.pointer(h.canvas, 'pointermove', 1, 100);
  close(h.camera.zoomMultiplier, 1);
  h.pointer(h.canvas, 'pointerup', 2, 200);
  h.pointer(h.canvas, 'pointermove', 1, 110);
  close(h.camera.orbitYawOffset, -0.065);
  close(h.camera.zoomMultiplier, 1);
});

test('extra fingers are ignored and coincident pinch points keep zoom finite', () => {
  const h = cameraHarness();
  h.pointer(h.canvas, 'pointerdown', 1, 0);
  h.pointer(h.canvas, 'pointerdown', 2, 100);
  h.pointer(h.canvas, 'pointerdown', 3, 300);
  h.pointer(h.canvas, 'pointermove', 3, 500);
  close(h.camera.zoomMultiplier, 1);
  h.pointer(h.canvas, 'pointermove', 2, 0);
  h.pointer(h.canvas, 'pointermove', 2, 10);
  assert.equal(Number.isFinite(h.camera.zoomMultiplier), true);
  h.pointer(h.canvas, 'pointerup', 3, 500);
  assert.equal(h.camera.isDragging, true);
});

for (const interruption of ['pointercancel', 'lostpointercapture', 'blur', 'hidden']) {
  test(`${interruption} ends capture without a stuck drag or jump on the next gesture`, () => {
    const h = cameraHarness();
    h.pointer(h.canvas, 'pointerdown', 1, 0);
    h.pointer(h.canvas, 'pointermove', 1, 10);
    if (interruption === 'blur' || interruption === 'hidden') h.pointer(h.canvas, 'pointerdown', 3, 100);
    if (interruption === 'blur') h.window.dispatch('blur');
    else if (interruption === 'hidden') {
      h.document.hidden = true;
      h.document.dispatch('visibilitychange');
    } else if (interruption === 'lostpointercapture') h.canvas.releasePointerCapture(1);
    else h.pointer(h.canvas, interruption, 1, 10);
    assert.equal(h.camera.isDragging, false);
    assert.equal(h.captured.size, 0);
    h.pointer(h.canvas, 'pointermove', 1, 500);
    close(h.camera.orbitYawOffset, -0.065);
    h.pointer(h.canvas, 'pointerdown', 2, 600);
    h.pointer(h.canvas, 'pointermove', 2, 610);
    close(h.camera.orbitYawOffset, -0.13);
  });
}

test('cancelling one pinch pointer leaves the other ready for orbit', () => {
  const h = cameraHarness();
  h.pointer(h.canvas, 'pointerdown', 1, 0);
  h.pointer(h.canvas, 'pointerdown', 2, 100);
  h.pointer(h.canvas, 'pointermove', 1, 20);
  h.pointer(h.canvas, 'pointercancel', 2, 100);
  assert.equal(h.camera.isDragging, true);
  h.pointer(h.canvas, 'pointermove', 1, 30);
  close(h.camera.orbitYawOffset, -0.065);
});

test('mouse orbit and wheel zoom retain their behavior and bounds', () => {
  const h = cameraHarness();
  h.pointer(h.canvas, 'pointerdown', 1, 0, 0, 'mouse', 2);
  assert.equal(h.camera.isDragging, false);
  h.pointer(h.canvas, 'pointerdown', 1, 0, 0, 'mouse');
  h.pointer(h.canvas, 'pointermove', 1, 10, 20, 'mouse');
  close(h.camera.orbitYawOffset, -0.065);
  close(h.camera.orbitPitchOffset, 0.19);
  h.pointer(h.canvas, 'pointerup', 1, 10, 20, 'mouse');
  let prevented = false;
  h.canvas.dispatch('wheel', { deltaY: 100, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  close(h.camera.zoomMultiplier, 1.1);
  h.canvas.dispatch('wheel', { deltaY: -10000, preventDefault() {} });
  close(h.camera.zoomMultiplier, 0.45);
  h.canvas.dispatch('wheel', { deltaY: 10000, preventDefault() {} });
  close(h.camera.zoomMultiplier, 2.4);
});

for (const preset of ['chase', 'observatory', 'drone']) {
  test(`teleport after driving, orbiting and ${preset} snaps to a fresh chase view`, () => {
    const h = cameraHarness();
    h.entity.speed = 45;
    for (let i = 0; i < 180; i++) h.camera.update(1 / 60, i / 60);
    assert.ok(h.camera.smoothedSpeed > 44);
    h.pointer(h.canvas, 'pointerdown', 1, 0);
    h.pointer(h.canvas, 'pointermove', 1, 200, 80);
    h.pointer(h.canvas, 'pointerup', 1, 200, 80);
    h.canvas.dispatch('wheel', { deltaY: 1000, preventDefault() {} });
    h.camera.setCameraPreset(preset, true);
    h.camera.update(1 / 60, 4);

    h.entity.position.set(-200, 20, 5300);
    h.entity.heading = -Math.PI / 2;
    h.entity.speed = 0;
    h.camera.resetForTeleport();
    const fresh = cameraHarness(h.entity).camera;
    assert.equal(h.camera.activePresetId, 'chase');
    assert.equal(h.camera.camera.fov, fresh.camera.fov);
    // Compare arrival, follow re-anchoring, and movement after arrival, including a change in height.
    for (let i = 0; i < 3; i++) {
      if (i === 2) h.entity.position.set(-205, 23, 5304);
      h.camera.update(1 / 60, 5 + i / 60);
      fresh.update(1 / 60, 5 + i / 60);
      for (const field of ['currentPos', 'currentLookAt']) {
        for (const axis of ['x', 'y', 'z']) close(h.camera[field][axis], fresh[field][axis]);
      }
      for (const axis of ['x', 'y', 'z']) {
        close(h.camera.camera.position[axis], fresh.camera.position[axis]);
        close(h.camera.camera.target[axis], fresh.camera.target[axis]);
      }
    }
  });
}

test('teleport releases every camera pointer and ignores old gestures before accepting a new drag', () => {
  const h = cameraHarness();
  h.pointer(h.canvas, 'pointerdown', 1, 0);
  h.pointer(h.canvas, 'pointermove', 1, 20, 40);
  h.pointer(h.canvas, 'pointerdown', 2, 100);
  h.pointer(h.canvas, 'pointermove', 2, 200);
  assert.equal(h.captured.size, 2);
  h.camera.resetForTeleport();
  assert.equal(h.captured.size, 0);
  assert.equal(h.camera.isDragging, false);
  assert.equal(h.camera.userOrbitTimer, 0);
  for (const id of [1, 2]) {
    h.pointer(h.canvas, 'pointermove', id, 500, 500);
    h.pointer(h.canvas, 'pointerup', id, 500, 500);
  }
  close(h.camera.orbitYawOffset, 0);
  close(h.camera.orbitPitchOffset, 0.09);
  close(h.camera.zoomMultiplier, 1);
  h.pointer(h.canvas, 'pointerdown', 3, 600);
  h.pointer(h.canvas, 'pointermove', 3, 610);
  close(h.camera.orbitYawOffset, -0.065);
  assert.equal(h.camera.isDragging, true);
});

test('portrait screens widen the view instead of looking through a slot', () => {
  const radians = Math.PI / 180;
  const across = (fov, aspect) => 2 * Math.atan(Math.tan((fov * radians) / 2) * aspect) / radians;
  const h = cameraHarness();
  h.camera.onResize(1600, 900);
  assert.equal(h.camera.camera.fov, 56, 'landscape keeps the preset as authored');

  h.camera.onResize(390, 844);
  assert.ok(Math.abs(across(h.camera.camera.fov, 390 / 844) - 48) < 0.01, 'keeps 48 degrees across in portrait');

  h.camera.setCameraPreset('macquarie', true);
  assert.ok(Math.abs(across(h.camera.camera.fov, 390 / 844) - 48) < 0.01, 'preset changes keep it too');

  h.camera.onResize(1600, 900);
  assert.equal(h.camera.camera.fov, 46, 'rotating back restores the preset');
});

// Where a point falls on the screen: -1..1 across and up, from the camera's position and what it was pointed at
function onScreen(camera, point) {
  const p = camera.camera.position, t = camera.camera.target;
  const f = norm([t.x - p.x, t.y - p.y, t.z - p.z]);
  const r = norm([-f[2], 0, f[0]]); // across: forward × up
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const v = [point.x - p.x, point.y - p.y, point.z - p.z];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const depth = dot(v, f);
  const half = Math.tan((camera.camera.fov * Math.PI) / 360);
  return { depth, x: dot(v, r) / (depth * half * camera.camera.aspect), y: dot(v, u) / (depth * half) };
}
function norm(v) {
  const l = Math.hypot(...v) || 1;
  return v.map((c) => c / l);
}

test('the chase camera keeps you in the middle third of the screen at any orbit, pitch and zoom', () => {
  // Aiming ahead along the heading put a walker off a phone's screen at 90 degrees of orbit, and behind the camera at 180
  const modes = {
    person: { type: 'person', chaseDistance: 4.3, chaseHeight: 1.95, target: 1.55, body: 0.95 },
    cyclist: { type: 'cyclist', chaseDistance: 4.8, chaseHeight: 2.05, target: 1.35, body: 1.0 },
    car: { type: 'car', chaseDistance: 6.9, chaseHeight: 2.12, target: 0.96, body: 0.7 },
    helicopter: { type: 'helicopter', chaseDistance: 11.4, chaseHeight: 3.3, target: 1.55, body: 1.2 }
  };
  for (const [name, m] of Object.entries(modes)) {
    const entity = { position: new Vector3(40, 12, -30), heading: 0.7, speed: 0, type: m.type, chaseDistance: m.chaseDistance, chaseHeight: m.chaseHeight, cameraTargetOffset: new Vector3(0, m.target, 0) };
    const { camera } = cameraHarness(entity);
    for (const aspect of [390 / 844, 1600 / 900]) {
      camera.onResize(aspect * 1000, 1000);
      for (let yaw = -Math.PI; yaw <= Math.PI + 1e-9; yaw += Math.PI / 12) {
        for (const pitch of [-0.32, 0.09, 0.68]) {
          for (const zoom of [0.45, 1, 2.4]) {
            camera.orbitYawOffset = yaw;
            camera.orbitPitchOffset = pitch;
            camera.zoomMultiplier = zoom;
            camera.initialized = false;
            camera.update(1 / 60, 0);
            const at = onScreen(camera, { x: entity.position.x, y: entity.position.y + m.body, z: entity.position.z });
            const where = `${name}, aspect ${aspect.toFixed(2)}, orbit ${(yaw * 180 / Math.PI).toFixed(0)}, pitch ${pitch}, zoom ${zoom}`;
            assert.ok(at.depth > 0.5, `${where}: in front of the camera (${at.depth.toFixed(2)} m)`);
            assert.ok(Math.abs(at.x) < 1 / 3, `${where}: ${at.x.toFixed(2)} across`);
            assert.ok(Math.abs(at.y) < 0.8, `${where}: ${at.y.toFixed(2)} up`);
          }
        }
      }
    }
  }
});

test('turning to the view: the camera turns back by what you turned, and stops swinging behind you meanwhile', () => {
  const entity = { position: new Vector3(0, 0, 0), heading: 0, speed: 10, type: 'car', chaseDistance: 6.9, chaseHeight: 2.12, cameraTargetOffset: new Vector3(0, 0.96, 0) };
  const { camera } = cameraHarness(entity);
  const manager = camera.controllerManager;
  camera.update(1 / 60, 0);
  camera.orbitYawOffset = 1;
  camera.userOrbitTimer = 4; // as if just dragged round
  camera.update(1 / 60, 0);
  assert.ok(Math.abs(manager.viewOffset - 1) < 1e-9, 'the controller is told how far round the camera is');
  const worldYaw = entity.heading + camera.orbitYawOffset;
  for (let i = 0; i < 300; i++) {
    entity.followingView = true;
    entity.heading += 0.01;
    camera.update(1 / 60, i / 60);
  }
  assert.ok(Math.abs(entity.heading + camera.orbitYawOffset - worldYaw) < 1e-9, 'the camera stays where it was put');
  // Not following the view, moving, and no gesture for 4 s: it swings back behind, as before
  entity.followingView = false;
  for (let i = 0; i < 600; i++) camera.update(1 / 60, i / 60);
  assert.ok(Math.abs(camera.orbitYawOffset) < 0.01);
  // A scenic camera doesn't orbit: nothing to steer by
  camera.setCameraPreset('quay');
  camera.update(1 / 60, 0);
  assert.equal(manager.viewOffset, null);
});

// First person on foot: the view looks up and down by its own pitch, and the mouse turns the walker (js/controllers.js look())
function firstPersonHarness() {
  const entity = { position: new Vector3(0, 0, 0), heading: 0, speed: 0, type: 'person', chaseDistance: 4.3, chaseHeight: 1.95, cameraTargetOffset: new Vector3(0, 1.55, 0) };
  const h = cameraHarness(entity);
  const turns = [];
  h.camera.controllerManager.look = (dx) => turns.push(dx);
  h.camera.setCameraPreset('pov', true);
  h.camera.update(1 / 60, 0);
  const pitch = () => {
    const from = h.camera.camera.position, to = h.camera.camera.target;
    return Math.atan2(to.y - from.y, Math.hypot(to.x - from.x, to.z - from.z));
  };
  return { ...h, turns, pitch };
}

test('first person on foot looks up and down by its own pitch, as far as 70 degrees', () => {
  const h = firstPersonHarness();
  close(h.pitch(), 0);
  h.camera.look(0, 1.2);
  h.camera.update(1 / 60, 0);
  assert.ok(Math.abs(h.pitch() - 1.2) < 1e-6, `looks ${h.pitch()} rad up`);
  h.camera.look(0, 1);
  h.camera.update(1 / 60, 0);
  assert.ok(Math.abs(h.pitch() - 70 * Math.PI / 180) < 1e-6, `stops at ${(h.pitch() * 180 / Math.PI).toFixed(2)} degrees`);
  h.camera.look(0, -3);
  h.camera.update(1 / 60, 0);
  assert.ok(Math.abs(h.pitch() + 70 * Math.PI / 180) < 1e-6, `and down: ${(h.pitch() * 180 / Math.PI).toFixed(2)} degrees`);
  // The chase camera's orbit isn't touched, and back in chase the look is level again
  close(h.camera.orbitPitchOffset, 0.09);
  h.camera.setCameraPreset('chase', true);
  close(h.camera.lookPitch, 0);
  // In a car, the cockpit's look is as it was: the orbit, through a point 40 m ahead
  const car = cameraHarness();
  car.camera.setCameraPreset('pov', true);
  car.camera.look(0, 1);
  close(car.camera.lookPitch, 0);
});

test('first person on foot: a drag turns you and looks, the eye is 0.1 m ahead, and it never orbits', () => {
  const h = firstPersonHarness();
  close(h.camera.camera.position.z, 0.1);
  close(h.camera.camera.position.y, 1.68);
  h.pointer(h.canvas, 'pointerdown', 1, 100, 100, 'mouse');
  h.pointer(h.canvas, 'pointermove', 1, 110, 80, 'mouse');
  assert.deepEqual(h.turns.map((t) => +t.toFixed(6)), [0.065]);
  close(h.camera.lookPitch, 0.1);
  close(h.camera.orbitYawOffset, 0);
  h.camera.update(1 / 60, 0);
  assert.equal(h.camera.controllerManager.viewOffset, null, 'nothing to steer by');
});

test('first person on foot, locked: the mouse counts turn you at the speed set, and a spike is cut short', () => {
  const h = firstPersonHarness();
  h.document.pointerLockElement = h.canvas;
  h.canvas.dispatch('pointermove', { pointerId: 1, pointerType: 'mouse', movementX: 100, movementY: 50, clientX: 0, clientY: 0, preventDefault() {} });
  close(h.turns[0], 0.2);
  close(h.camera.lookPitch, -0.1);
  h.camera.mouseSpeed = 2;
  h.canvas.dispatch('pointermove', { pointerId: 1, pointerType: 'mouse', movementX: 5000, movementY: 0, clientX: 0, clientY: 0, preventDefault() {} });
  assert.ok(h.turns[1] > 0 && h.turns[1] < 2.5, `a spike turns ${h.turns[1]} rad`);
  // In a car the locked mouse does nothing (the lock is let go of there)
  const car = cameraHarness();
  car.document.pointerLockElement = car.canvas;
  car.canvas.dispatch('pointermove', { pointerId: 1, pointerType: 'mouse', movementX: 100, movementY: 0, clientX: 0, clientY: 0, preventDefault() {} });
  close(car.camera.orbitYawOffset, 0);
});

test('first person on foot: the eye eases up a kerb and down off one at 1.2 m/s, and follows a jump and a long fall at once', () => {
  const { camera } = cameraHarness();
  const dt = 1 / 60;
  const run = (heights, grounded, vys) => heights.map((y, i) => camera.easeEye(y, grounded[i], vys[i], dt));
  const fastest = (ys) => Math.max(...ys.slice(1).map((y, i) => Math.abs(y - ys[i]) / dt));
  // Up a kerb: the feet snap up 0.22 m
  camera._eyeY = null;
  const kerb = [1.68, 1.68, ...Array(24).fill(1.9)]; // 0.4 s
  const up = run(kerb, kerb.map(() => true), kerb.map(() => 0));
  assert.ok(fastest(up) <= 1.2 + 1e-9, `up a kerb at ${fastest(up).toFixed(2)} m/s`);
  assert.ok(Math.abs(up.at(-1) - 1.9) < 0.005, `there in 0.4 s: ${up.at(-1)}`);
  // Off one: a fall of 0.22 m, at 14.5 m/s/s
  camera._eyeY = null;
  const ys = [1.9, 1.9], grounded = [true, true], vys = [0, 0];
  for (let v = 0, y = 1.9; y > 1.68;) {
    v -= 14.5 * dt;
    y = Math.max(1.68, y + v * dt);
    ys.push(y); grounded.push(y <= 1.68); vys.push(y <= 1.68 ? 0 : v);
  }
  for (let i = 0; i < 20; i++) { ys.push(1.68); grounded.push(true); vys.push(0); }
  const down = run(ys, grounded, vys);
  assert.ok(fastest(down) <= 1.2 + 1e-9, `down off it at ${fastest(down).toFixed(2)} m/s`);
  assert.ok(Math.abs(down.at(-1) - 1.68) < 0.005);
  // A jump: followed exactly
  camera._eyeY = null;
  const jump = [1.68, 1.68];
  for (let v = 5.2, y = 1.68; ; ) {
    v -= 14.5 * dt;
    y += v * dt;
    if (y <= 1.68) break;
    jump.push(y);
  }
  const jumped = run(jump, jump.map((y, i) => i < 2), jump.map((y, i) => (i < 2 ? 0 : 1)));
  assert.deepEqual(jumped, jump);
  // A long fall off an edge: no more than half a metre behind, and caught up soon after
  camera._eyeY = null;
  const fall = [10, 10], fg = [true, true], fv = [0, 0];
  for (let v = 0, y = 10; y > 5;) {
    v -= 14.5 * dt;
    y = Math.max(5, y + v * dt);
    fall.push(y); fg.push(y <= 5); fv.push(y <= 5 ? 0 : v);
  }
  for (let i = 0; i < 30; i++) { fall.push(5); fg.push(true); fv.push(0); }
  const fell = run(fall, fg, fv);
  assert.ok(Math.max(...fell.map((y, i) => y - fall[i])) <= 0.5 + 1e-9, 'the eye trails a long fall by half a metre at most');
  assert.ok(Math.abs(fell.at(-1) - 5) < 0.005);
});

test("first person on foot: the gamepad's right stick turns you and looks up and down, and its recentre levels the look", () => {
  const h = firstPersonHarness();
  h.camera.applyGamepadInput(0.5, -1, 0, 0.1);
  close(h.turns[0], 0.1);
  close(h.camera.lookPitch, 0.125);
  close(h.camera.orbitYawOffset, 0);
  h.camera.resetOrbit();
  close(h.camera.lookPitch, 0);
});

test('into first person on foot from the chase camera: a 0.3 s glide into the eye, facing where the chase camera looked', () => {
  const entity = { position: new Vector3(0, 0, 0), heading: 0, speed: 0, type: 'person', chaseDistance: 4.3, chaseHeight: 1.95, cameraTargetOffset: new Vector3(0, 1.55, 0) };
  const { camera } = cameraHarness(entity);
  camera.controllerManager.look = () => {};
  for (let i = 0; i < 60; i++) camera.update(1 / 60, i / 60);
  camera.orbitYawOffset = 0.4; // dragged round to the left
  for (let i = 0; i < 60; i++) camera.update(1 / 60, i / 60);
  const from = camera.camera.position.clone();
  camera.setCameraPreset('pov', true);
  close(entity.heading, 0.4);
  close(camera.orbitYawOffset, 0);
  camera.update(0.15, 1);
  const half = camera.camera.position.clone();
  const eye = { x: Math.sin(0.4) * 0.1, y: 1.68, z: Math.cos(0.4) * 0.1 };
  const toEye = (p) => Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z);
  assert.ok(toEye(half) > 0.3 * toEye(from) && toEye(half) < 0.7 * toEye(from), `half way: ${toEye(half).toFixed(2)} m from the eye, from ${toEye(from).toFixed(2)}`);
  assert.equal(camera.bodyHidden, false, 'still drawn half way');
  camera.update(0.16, 1.2);
  assert.ok(toEye(camera.camera.position) < 1e-9, 'in the eye at 0.3 s');
  assert.equal(camera.bodyHidden, true);
  // and back to chase: behind you, level
  camera.setCameraPreset('chase', true);
  close(camera.orbitYawOffset, 0);
  close(camera.orbitPitchOffset, 0.09);
});
