import * as THREE from 'three/webgpu';
import { Fn, abs, attribute, clamp, cos, exp, float, max, min, mix, normalLocal, pow, positionGeometry, sin, smoothstep, sqrt, step, uniform, uv, vec3 } from 'three/tsl';
import { flowerColour, random } from './jacaranda-carpets.js';

// In November your car starts with jacaranda flowers on its roof, bonnet and boot, as if it had stood under one overnight. They blow off
// as you speed up, more the faster you go, and are gone in about a minute at 60 km/h; stopped under a jacaranda, or creeping through its
// carpet, more settle. Your car only: traffic sheds none.
// - On the car: a few hundred cards in its own frame, one instanced mesh, as many drawn as its load (0-1) says.
// - Off it: each card that leaves is one slot in a ring of flowers drawn on the GPU from where and when it left and how fast it was going
//   (slowed by the air, lifted then falling, turning and fluttering, then lying on the ground a few seconds and fading). Nothing is moved
//   on the CPU: a slot is written once, when its flower leaves.

// Enough to cover about a quarter of its bonnet, roof and boot: fewer can't be seen from the chase camera
const CARDS = { low: 900, medium: 1300, high: 1700 };
const POOL = 640; // flowers in the air or on the ground at once
const SIZE = { length: 0.054, width: 0.023 }; // m, a flower
// The flight, the same here as in the shader: the car's wake and then the air take its speed off a flower in about TAU s, it falls at
// FALL m/s once the lift it had off the roof has gone (in about TAU_Y s), and the breeze carries it
const TAU = 1.0, TAU_Y = 0.3, FALL = 1.1;
const WIND = { x: 0.25, z: 0.12 };
const REST = 5, FADE = 1.5; // s on the ground before it fades, and how long that takes
// Load lost a second for each (m/s)^2 over STILL^2: all of it in about a minute at 60 km/h. Slower than STILL (10 km/h) the dew holds them.
const SHED = 6.2e-5, STILL = 2.8;
// Load gained a second under a jacaranda: stopped, or creeping through its carpet
const SETTLE_STOPPED = 1 / 80, SETTLE_SLOW = 1 / 240, CREEP = 4.2;

/**
 * Where flowers can lie on a car's body (its geometry in the car's own frame): the tops of its panels and roof facing up, from a height
 * field of what's highest at each point. `count` spots, { x, y, z, nx, ny, nz }, in the order they'll leave. A few hundred triangles a step.
 */
function* restingSpotsSteps(geometry, count, seed = 11) {
  const pos = geometry.attributes.position, nor = geometry.attributes.normal, part = geometry.attributes.partId;
  geometry.computeBoundingBox();
  const { min: lo, max: hi } = geometry.boundingBox;
  const CELL = 0.025;
  const nx = Math.ceil((hi.x - lo.x) / CELL), nz = Math.ceil((hi.z - lo.z) / CELL);
  const top = new Float32Array(nx * nz).fill(-Infinity);
  const up = new Float32Array(nx * nz * 3);
  const index = geometry.index;
  const tris = index ? index.count / 3 : pos.count / 3;
  const v = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
  // The car's lamps, mirrors, wheels and taxi light hold none
  const holds = (p) => p === 0 || p === 1 || p === 7 || p === 8;
  for (let t = 0; t < tris; t++) {
    if (t % 400 === 399) yield;
    const a = v(t, 0), b = v(t, 1), c = v(t, 2);
    if (part && !holds(Math.round(part.getX(a)))) continue;
    const ny = (nor.getY(a) + nor.getY(b) + nor.getY(c)) / 3;
    if (ny < 0.3) continue;
    const ax = pos.getX(a), az = pos.getZ(a), bx = pos.getX(b), bz = pos.getZ(b), cx = pos.getX(c), cz = pos.getZ(c);
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-12) continue;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - lo.x) / CELL)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - lo.x) / CELL));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - lo.z) / CELL)), j1 = Math.min(nz - 1, Math.floor((Math.max(az, bz, cz) - lo.z) / CELL));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = lo.x + (i + 0.5) * CELL, z = lo.z + (j + 0.5) * CELL;
        const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        const y = l1 * pos.getY(a) + l2 * pos.getY(b) + l3 * pos.getY(c);
        const k = j * nx + i;
        if (y <= top[k]) continue;
        top[k] = y;
        up[k * 3] = l1 * nor.getX(a) + l2 * nor.getX(b) + l3 * nor.getX(c);
        up[k * 3 + 1] = l1 * nor.getY(a) + l2 * nor.getY(b) + l3 * nor.getY(c);
        up[k * 3 + 2] = l1 * nor.getZ(a) + l2 * nor.getZ(b) + l3 * nor.getZ(c);
      }
    }
  }
  // What's highest where it faces up: the bonnet, the roof and the boot, not the windscreen or the back window
  const level = [];
  for (let k = 0; k < top.length; k++) {
    const l = Math.hypot(up[k * 3], up[k * 3 + 1], up[k * 3 + 2]);
    if (top[k] > -Infinity && l > 0 && up[k * 3 + 1] / l > 0.9 && top[k] > lo.y + (hi.y - lo.y) * 0.4) level.push(k);
  }
  const rnd = random(seed);
  const spots = [];
  for (let n = 0; n < count && level.length; n++) {
    const k = level[Math.floor(rnd() * level.length)];
    const i = k % nx, j = Math.floor(k / nx);
    const l = Math.hypot(up[k * 3], up[k * 3 + 1], up[k * 3 + 2]);
    spots.push({ x: lo.x + (i + rnd()) * CELL, y: top[k], z: lo.z + (j + rnd()) * CELL, nx: up[k * 3] / l, ny: up[k * 3 + 1] / l, nz: up[k * 3 + 2] / l });
  }
  return spots;
}

/** Where a flower is T s after it left (x0, y0, z0) going (vx, vy, vz), in the air: the same flight as flyingMaterial()'s */
function flight(x0, y0, z0, vx, vy, vz, T) {
  const kx = 1 - Math.exp(-T / TAU), ky = 1 - Math.exp(-T / TAU_Y), drift = T - kx * TAU;
  return { x: x0 + vx * TAU * kx + drift * WIND.x, y: y0 + (vy + FALL) * TAU_Y * ky - T * FALL, z: z0 + vz * TAU * kx + drift * WIND.z };
}

/** When that flower lands, and the height it lands at: `floorAt(x, z)` the ground under it. { T, floor } */
function landing(x0, y0, z0, vx, vy, vz, floorAt) {
  let floor = floorAt(x0, z0), T = 0;
  for (let pass = 0; pass < 2; pass++) {
    if (y0 <= floor) return { T: 0, floor };
    let lo = 0, hi = Math.max(0.5, (y0 - floor + (vy + FALL) * TAU_Y) / FALL + 1);
    for (let k = 0; k < 24; k++) {
      const mid = (lo + hi) / 2;
      if (flight(x0, y0, z0, vx, vy, vz, mid).y > floor) lo = mid;
      else hi = mid;
    }
    T = hi;
    // Where it comes down, the ground may be higher or lower than where it left: once more, for the ground there
    const at = flight(x0, y0, z0, vx, vy, vz, T);
    floor = floorAt(at.x, at.z);
  }
  return { T, floor };
}

/** The car's load after dt s at `speed` (m/s), `under` a jacaranda or not */
function nextLoad(load, speed, dt, under = false) {
  if (speed > STILL) load = Math.max(0, load - SHED * (speed * speed - STILL * STILL) * dt);
  if (under && speed <= CREEP) load = Math.min(1, load + (speed < 0.3 ? SETTLE_STOPPED : SETTLE_SLOW) * dt);
  return load;
}

function restingSpots(geometry, count, seed = 11) {
  const steps = restingSpotsSteps(geometry, count, seed);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** A flower's card: a unit quad lying flat, facing up, its length along x and its width along z */
function cardGeometry() {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  return g;
}

// A fallen flower's outline on its card: narrow at its foot (u = 0), flaring to a rounded mouth (u = 1)
const flowerShape = () => {
  const u = clamp(uv().x, 0.0, 1.0);
  const across = abs(uv().y.sub(0.5)).mul(2.0);
  const cap = sqrt(max(float(1.0).sub(pow(max(u.sub(0.86), 0.0).div(0.14), 2.0)), 0.0));
  const half = pow(u, 0.8).mul(0.68).add(0.32).mul(cap);
  return step(across, half);
};

function flowerMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: 0.7, side: THREE.DoubleSide });
  const flower = attribute('aFlower', 'vec2');
  mat.colorNode = flowerColour(flower.x, flower.y.mul(uv().x.mul(0.22).add(0.78)));
  mat.opacityNode = flowerShape();
  mat.alphaTest = 0.5;
  return mat;
}

/**
 * The flowers in the air and on the ground, worked out in the vertex stage from each slot's aStart (x, y, z from the origin, the time it
 * left), aVel (its velocity, a number of its own) and aLand (when it lands, the height it lands at, its tone and shade). `now`: the game's
 * clock, a uniform.
 */
function flyingMaterial(now) {
  const mat = flowerMaterial();
  const start = attribute('aStart', 'vec4'), vel = attribute('aVel', 'vec4'), land = attribute('aLand', 'vec4');
  const t = max(now.sub(start.w), 0.0);
  const T = min(t, land.x);
  const landed = step(land.x, t);
  const kx = float(1.0).sub(exp(T.negate().div(TAU)));
  const ky = float(1.0).sub(exp(T.negate().div(TAU_Y)));
  const seed = vel.w;
  const air = float(1.0).sub(landed).mul(smoothstep(0.0, 0.3, T));
  const drift = T.sub(kx.mul(TAU));
  const x = start.x.add(vel.x.mul(TAU).mul(kx)).add(drift.mul(WIND.x)).add(sin(T.mul(seed.mul(3.0).add(5.0)).add(seed.mul(40.0))).mul(0.12).mul(air));
  const z = start.z.add(vel.z.mul(TAU).mul(kx)).add(drift.mul(WIND.z)).add(cos(T.mul(seed.mul(2.0).add(4.0)).add(seed.mul(17.0))).mul(0.12).mul(air));
  const yAir = start.y.add(vel.y.add(FALL).mul(TAU_Y).mul(ky)).sub(T.mul(FALL));
  const y = mix(max(yAir, land.y), land.y.add(0.004), landed);
  // Turning over and over in the air; flat on the ground, faded out after a while
  const pitch = T.mul(seed.mul(7.0).add(5.0)).mul(float(1.0).sub(landed));
  const yaw = seed.mul(6.2832).add(T.mul(seed.mul(9.0).sub(4.0)).mul(float(1.0).sub(landed)));
  const size = float(1.0).sub(smoothstep(land.x.add(REST), land.x.add(REST + FADE), t));
  const turn = (p) => {
    const cp = cos(pitch), sp = sin(pitch), cy = cos(yaw), sy = sin(yaw);
    const q = vec3(p.x, p.y.mul(cp).sub(p.z.mul(sp)), p.y.mul(sp).add(p.z.mul(cp)));
    return vec3(q.x.mul(cy).add(q.z.mul(sy)), q.y, q.z.mul(cy).sub(q.x.mul(sy)));
  };
  // Landed, it lies on the slope it landed on (aLand.zw: the slope's normal's x and z; the ground's is level), sheared onto its plane
  const slope = vec3(land.z, sqrt(max(float(1.0).sub(land.z.mul(land.z)).sub(land.w.mul(land.w)), 0.01)), land.w);
  mat.positionNode = Fn(() => {
    normalLocal.assign(mix(turn(vec3(0.0, 1.0, 0.0)), slope, landed));
    const p = turn(positionGeometry.mul(vec3(SIZE.length, 1.0, SIZE.width)).mul(size)).toVar();
    p.y.addAssign(p.x.mul(slope.x).add(p.z.mul(slope.z)).div(slope.y).negate().mul(landed));
    return p.add(vec3(x, y, z));
  })();
  return mat;
}

/**
 * The car's flowers. `car`: the player's car entity (js/controllers.js), `spots`: where they lie on it (restingSpots()); `heightAt(x, z)`:
 * the top of what's drawn on the ground; `under(x, z)`: whether that's under a jacaranda's crown; `origin`: the world's origin. `group`
 * goes into the scene (anchored to the origin); `cards` rides on the car, put there by the season's start().
 */
function createCarPetals({ car, spots, heightAt, under = () => false, origin }) {
  const rnd = random(5);
  // One material for the flowers on the car and those off it, so one shader to compile (50-70 ms on a phone): on the car each is a flower
  // that has landed there and never fades, laid on its panel's slope, in the car's own frame
  const now = uniform(0);
  const material = flyingMaterial(now);
  const flowers = (n) => {
    const geometry = cardGeometry();
    const attrs = {
      aStart: new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4),
      aVel: new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4),
      aLand: new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4),
      aFlower: new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2)
    };
    for (const [name, attr] of Object.entries(attrs)) geometry.setAttribute(name, attr);
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, n));
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // where each is, is worked out on the GPU
    mesh.userData.lifted = true;
    return { mesh, ...attrs };
  };

  // On the car
  const onCar = flowers(spots.length);
  const cards = onCar.mesh;
  cards.name = 'CarPetals';
  cards.userData.ownVisibility = true; // shown and hidden with the car here, not by js/controllers.js
  spots.forEach((spot, i) => {
    // Left at a time that never comes, it has always just landed
    onCar.aStart.setXYZW(i, spot.x, spot.y, spot.z, 1e9);
    onCar.aVel.setXYZW(i, 0, 0, 0, rnd());
    onCar.aLand.setXYZW(i, 0, spot.y + 0.002, spot.nx, spot.nz);
    // Lighter than the carpets' on average: a few days' sun on a white car
    spot.tone = rnd() < 0.08 ? 0.9 : 0.3 + rnd() * 0.5;
    spot.shade = 0.7 + rnd() * 0.3;
    onCar.aFlower.setXY(i, spot.tone, spot.shade);
  });
  cards.count = 0;

  // Off it: none has left yet
  const off = flowers(POOL);
  const flying = off.mesh;
  flying.name = 'FlyingPetals';
  flying.userData.ownMaterial = true; // let go of with its stage (js/main.js disposeStage())
  const { aStart: startAttr, aVel: velAttr, aLand: landAttr, aFlower: flyLook } = off;
  startAttr.array.fill(-1e5);
  const group = new THREE.Group();
  group.name = 'Petals';
  group.add(flying);

  let load = 1, shown = 0, next = 0, released = 0, lastOrigin = { x: origin.x, z: origin.z };
  let lastLanding = -Infinity; // when the last flower to leave has faded: none drawn after that
  flying.visible = false;
  const written = [];
  const fell = new THREE.Vector3();

  /** The card at `i` leaves the car, from where it is now, at the car's speed */
  function release(i, elapsed, vx, vz, speed) {
    const spot = spots[i];
    fell.set(spot.x, spot.y, spot.z).applyMatrix4(car.chassisPivot.matrixWorld); // the drawn frame: the world less the origin
    const gx = fell.x + origin.x, gz = fell.z + origin.z;
    const fx = vx * (0.85 + rnd() * 0.15) + (rnd() - 0.5) * 1.2, fz = vz * (0.85 + rnd() * 0.15) + (rnd() - 0.5) * 1.2;
    // Lifted off the roof by the air going over it, more the faster it goes
    const fy = 0.6 + speed * 0.09 + (rnd() - 0.5) * 0.6;
    // On a deck or in a tunnel, they fall to the car's own level; on the ground, to what's drawn where they land
    const ground = car.mesh.position.y;
    const floorAt = car.surface ? () => ground : heightAt;
    const { T, floor } = landing(gx, fell.y, gz, fx, fy, fz, floorAt);
    const k = next;
    next = (next + 1) % POOL;
    startAttr.setXYZW(k, fell.x, fell.y, fell.z, elapsed);
    velAttr.setXYZW(k, fx, fy, fz, rnd());
    landAttr.setXYZW(k, T, floor, 0, 0);
    lastLanding = Math.max(lastLanding, elapsed + T + REST + FADE);
    flyLook.setXY(k, spot.tone, spot.shade);
    written.push(k);
    released++;
  }

  const upload = (attr, slots) => {
    attr.clearUpdateRanges();
    for (const k of slots) attr.addUpdateRange(k * attr.itemSize, attr.itemSize);
    attr.needsUpdate = true;
  };

  let underTree = false, checkedAt = -Infinity;
  /** Each frame, after the car has moved and its matrices are written: the load, the cards, and any that leave */
  function update(dt, elapsed) {
    now.value = elapsed;
    // The origin moved: what's in the air is written from it
    if (origin.x !== lastOrigin.x || origin.z !== lastOrigin.z) {
      const dx = origin.x - lastOrigin.x, dz = origin.z - lastOrigin.z;
      for (let k = 0; k < POOL; k++) startAttr.setXYZ(k, startAttr.getX(k) - dx, startAttr.getY(k), startAttr.getZ(k) - dz);
      startAttr.clearUpdateRanges();
      startAttr.needsUpdate = true;
      lastOrigin = { x: origin.x, z: origin.z };
    }
    const speed = Math.abs(car.speed || 0);
    const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
    const vx = sin * (car.speed || 0) + (car.vx || 0), vz = cos * (car.speed || 0) + (car.vz || 0);
    if (elapsed - checkedAt > 0.25) {
      checkedAt = elapsed;
      underTree = under(car.position.x, car.position.z);
    }
    load = nextLoad(load, speed, dt, underTree);
    const want = Math.round(load * spots.length);
    for (let i = shown - 1; i >= want; i--) release(i, elapsed, vx, vz, speed);
    if (want !== shown) {
      shown = want;
      cards.count = shown;
    }
    cards.visible = shown > 0 && car._shown !== false;
    flying.visible = elapsed < lastLanding + 0.5;
    if (written.length) {
      for (const attr of [startAttr, velAttr, landAttr, flyLook]) upload(attr, written);
      written.length = 0;
    }
  }

  return {
    group,
    cards,
    flying,
    update,
    setLoad(value) {
      load = Math.min(1, Math.max(0, value));
      shown = Math.round(load * spots.length);
      cards.count = shown;
    },
    state: () => ({ load: Number(load.toFixed(3)), cards: shown, of: spots.length, released, underTree }),
    clear() {
      cards.removeFromParent();
      cards.dispose();
      cards.geometry.dispose();
      cards.material.dispose();
    }
  };
}

export { CARDS, POOL, createCarPetals, flight, landing, nextLoad, restingSpots, restingSpotsSteps };
