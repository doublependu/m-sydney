import * as THREE from 'three/webgpu';
import { CITY_BOUNDS, SPAWN, isTypingInField, blockAt } from './city-config.js';
import { cityUniforms, createBlobShadowMaterial, createCarPaintMaterial, createContactShadowMaterial } from './tsl-materials.js';
import {
  BODY_SPECS,
  buildCarGeometry,
  buildCarSidePatch,
  buildSteerableWheelGeo,
  carTipZ,
  createCarWheelMaterial,
  createLoftedCarMaterial
} from './cars.js';
import {
  buildHelicopterBodyGeometry,
  buildHelicopterMainRotorGeometry,
  buildHelicopterTailRotorGeometry,
  createLoftedHelicopterMaterial
} from './helicopter.js';
import { PersonCrowd, PersonRig } from './pedestrians.js';
import { HEADLIGHTS, createVehicleHeadlight, placeVehicleHeadlight } from './vehicle-lights.js';
import { anchorToOrigin } from './world-origin.js';
import { polygonContact, polygonContains } from './building-collision.js';
import { DECK_SID } from './bridge.js';
import { BIKE_SIDES, CAR_DOORS, FLY, arrivalFor, besideVehicle, holdOnFootway } from './arrivals.js';
import { ROOM, STRUCTURES, clearOfWater, floorBelow, floorFlow, freeFromDeck, groundHeight, moveOver, onFloor, structureAt, structuresAt, surfaceHeight } from './surfaces.js';
import { inStillWater, modelWaterNear, shoreAlong, stillWaterDepth } from './still-water.js';
import { WALKER } from './interior-data.js';
import { MODEL_SITES } from './model-sites.js';
import { buildNear, drawnOver } from './drawn-ground.js';

// On the Harbour Bridge's deck: any of its roads' structures, the corridor's and those of the carriageways east of it (plan 5)
const onDeck = (sid) => !!sid && !!STRUCTURES[sid]?.deck;

// Player models, animation and movement for walking, driving, cycling and flying.

const groundCollider = { type: 'ground' };
// On foot: a walk at the pace of the people in the street (js/pedestrian-system.js), or a run with Shift or a stick pushed nearly all
// the way out. Inside (js/interiors.js sets `indoors`) slower, and turning slower: rooms are a few steps across, and at a walk you
// turn in under a metre, from a hall through a door at its side.
const ON_FOOT = {
  outside: { walk: 1.5, run: 6, turn: 2.6 },
  inside: { walk: 1.2, run: 2.4, turn: 1.6 }
};
const STICK_WALK = 0.6; // of a stick's travel that gives a full walk
const ASIDE = 0.65; // of the pace, walking back or stepping aside

// What each key does. The arrows turn you. A and D turn you too, except in first person on foot (`firstPerson`), where they step you
// aside, as the touch stick's sideways and the gamepad's left stick do there.
const BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  backward: ['KeyS', 'ArrowDown'],
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  sideLeft: ['KeyA'],
  sideRight: ['KeyD'],
  up: ['Space', 'KeyE'],
  down: ['KeyQ', 'KeyC'],
  run: ['ShiftLeft', 'ShiftRight']
};
const SIDES = { left: 'left', sideLeft: 'left', right: 'right', sideRight: 'right' };
// The strongest of several inputs for one action: a key or a button held (true) wins, or the furthest a stick is pushed
const strongest = (...values) => (values.includes(true) ? true : Math.max(0, ...values.map((v) => Number(v) || 0)) || false);

const CAR_DRIVE = {
  speed: 36, reverseSpeed: 10.5, acceleration: 4.5,
  powerSpeed: 14.5, // Above 52 km/h, engine power limits acceleration.
  rolling: 0.18, drag: 0.0012, coast: 0.6, brake: 9,
  wheelbase: 2.76, grip: 9.5, cornering: 10.5 // Wheelbase (m), tire and steering acceleration limits (m/s²).
};
const BICYCLE_DRIVE = {
  speed: 19, reverseSpeed: 4.5, acceleration: 6.5,
  powerSpeed: 10.5, // Above 38 km/h, rider power limits acceleration.
  rolling: 0.1, drag: 0.004, coast: 0.45, brake: 10.5
};
const BRAKE_HOLD = 0.25; // s at a standstill after braking with S before it backs the bike up

function driveSpeed(speed, throttle, dt, drive) {
  // Turning can project tiny sideways motion back into speed after braking to zero.
  // Treat a crawl as stopped when changing direction, so this cannot hold the brakes forever.
  if (speed * throttle < 0 && Math.abs(speed) < 0.05) speed = 0;
  const braking = speed * throttle < 0;
  const magnitude = Math.abs(speed);
  // Extra resistance on release gives a stronger slowdown while coasting.
  const deceleration = drive.rolling + (!throttle ? drive.coast : braking ? Math.abs(throttle) * drive.brake : 0);
  // Constant rolling resistance and quadratic air drag, without crossing zero or large-dt instability.
  const coasting = Math.max(0, magnitude - deceleration * dt) / (1 + drive.drag * magnitude * dt);
  if (!throttle || braking) return Math.sign(speed) * coasting;

  const limit = throttle < 0 ? drive.reverseSpeed : drive.speed;
  let acceleration = drive.acceleration;
  if (drive.powerSpeed) acceleration *= drive.powerSpeed / Math.max(drive.powerSpeed, magnitude);
  // Collision momentum above the powered limit decays naturally instead of being clamped.
  return Math.sign(throttle) * Math.min(Math.max(limit, coasting), coasting + Math.abs(throttle) * acceleration * dt);
}

// Steering where you look. js/cameras.js says how far round the camera has been turned (viewOffset). With forward held and no
// steering of your own, each mode turns that way through its own steering, and the camera turns back by as much, so it stays
// where it was put: GAIN is how much steering per radian still to go, DONE where it counts as there. A car only does it
// within CAR_REACH: further round is a look, not somewhere to drive, and the camera swings back behind it as before.
const VIEW = { gain: 3, carGain: 4, carDamping: 0.2, done: 0.02, settled: 0.03, carReach: Math.PI / 2 };

// A car or bicycle you left: how close you have to be to get back in it where it is, to still see it, and how long it stands there (s of
// the game's time, which stops while it's paused or hidden) before it's gone
const RESUME_PARKED = 30, SHOW_PARKED = 200, PARKED_FOR = 10;
const NEAR_TRAFFIC = 1.5; // m from a passing car's body that's too close to get out
// The car you left, in the way on the ground as the cars parked at the kerbs are (js/traffic.js): its box, as high as theirs
const PARKED_BOX = { hx: 0.86, hz: 2.18, top: 1.55 };
// A bike left standing leans onto its kickstand, on its left: its lean (js/controllers.js leanPivot, - to the left)
const STAND_LEAN = -10 * Math.PI / 180;
// Who you are, walking or riding: one person, the same face, build, hair and clothes (js/pedestrians.js PersonRig)
const PLAYER_LOOK = { seed: 4.2, scale: 1.0, girth: 1.02, hair: 0.18 };
const FLY_AREA = FLY.AREA;
const FOOTWAY_RISE = 0.18; // the Harbour Bridge's footway stands this far above its road (js/harbour-bridge.js)

// Walking surface for the player's pedestrian (its rig samples it around its feet)
const personGround = (controllers, x, z) => controllers.getGroundHeight(x, z, 'person');

function collisionBody(mode, radius, heading, margin = 0) {
  const car = mode === 'car';
  const sin = Math.sin(heading), cos = Math.cos(heading);
  const hx = 0.86 + margin, hz = 2.18 + margin;
  return {
    car, sin, cos, hx, hz, radius: radius + margin,
    extX: car ? Math.abs(cos) * hx + Math.abs(sin) * hz : radius + margin,
    extZ: car ? Math.abs(sin) * hx + Math.abs(cos) * hz : radius + margin,
    bottom: mode === 'helicopter' ? -0.25 : 0,
    top: mode === 'helicopter' ? 3.2 : car ? 1.8 : 1.9
  };
}

// Movement and teleports share exact footprint checks after rejecting distant bounds.
// Walking/cycling/flying use circles; cars use oriented rectangles.
// Colliders are flat, in metres above the ground at (x, z). A building's roof is level and the ground under it isn't, so
// where the flat height of its roof is depends on where you are over it.
const colliderTop = (c, x, z) => (c.baseY === undefined ? c.maxY : c.maxY + c.baseY - groundHeight(x, z));
// ...and a wall inside a building with floors of its own (js/interiors.js) has both its heights in the world's frame, so a wall upstairs
// is over your head downstairs
const colliderBottom = (c, x, z) => (c.level ? c.minY - groundHeight(x, z) : c.minY ?? 0);

function buildingContact(c, x, y, z, body, contact) {
  if (y + body.top <= colliderBottom(c, x, z) || y + body.bottom >= colliderTop(c, x, z)) return false;
  if (x + body.extX <= c.minX || x - body.extX >= c.maxX || z + body.extZ <= c.minZ || z - body.extZ >= c.maxZ) return false;
  if (c.polygon) return polygonContact(c.polygon, x, z, body, contact);
  const o = c.obb;
  const cs = o ? o.cs : 1, sn = o ? o.sn : 0;
  const hx = o ? o.hx : (c.maxX - c.minX) * 0.5;
  const hz = o ? o.hz : (c.maxZ - c.minZ) * 0.5;
  const dx = x - (o ? o.cx : (c.minX + c.maxX) * 0.5);
  const dz = z - (o ? o.cz : (c.minZ + c.maxZ) * 0.5);
  const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
  let nx = 0, nz = 0, depth = Infinity;
  if (body.car) {
    const ls = body.sin * cs - body.cos * sn, lc = body.sin * sn + body.cos * cs;
    for (let axis = 0; axis < 4; axis++) {
      const ax = axis === 0 ? 1 : axis === 1 ? 0 : axis === 2 ? lc : ls;
      const az = axis === 0 ? 0 : axis === 1 ? 1 : axis === 2 ? -ls : lc;
      const distance = lx * ax + lz * az;
      const overlap = hx * Math.abs(ax) + hz * Math.abs(az)
        + body.hx * Math.abs(ax * lc - az * ls) + body.hz * Math.abs(ax * ls + az * lc) - Math.abs(distance);
      if (overlap <= 0) return false;
      if (overlap < depth) {
        depth = overlap;
        const sign = distance <= 0 ? -1 : 1;
        nx = ax * sign; nz = az * sign;
      }
    }
  } else {
    const qx = lx - Math.max(-hx, Math.min(hx, lx));
    const qz = lz - Math.max(-hz, Math.min(hz, lz));
    const distance = Math.hypot(qx, qz);
    if (distance >= body.radius) return false;
    if (distance > 0) {
      nx = qx / distance; nz = qz / distance;
      depth = body.radius - distance;
    } else if (hx - Math.abs(lx) <= hz - Math.abs(lz)) {
      nx = lx <= 0 ? -1 : 1;
      depth = hx - Math.abs(lx) + body.radius;
    } else {
      nz = lz <= 0 ? -1 : 1;
      depth = hz - Math.abs(lz) + body.radius;
    }
  }
  if (contact) {
    contact.nx = nx * cs + nz * sn;
    contact.nz = -nx * sn + nz * cs;
    contact.depth = depth;
  }
  return true;
}

function createTaxiDoorDecalTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffbe14';
  ctx.fillRect(0, 0, 256, 128);
  // Black T&LC circle emblem
  ctx.fillStyle = '#111317';
  ctx.beginPath();
  ctx.arc(58, 64, 42, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffbe14';
  ctx.font = '900 32px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('T', 58, 66);
  // Taxi typography & fare rate
  ctx.fillStyle = '#111317';
  ctx.textAlign = 'left';
  ctx.font = '900 26px Inter, Arial, sans-serif';
  ctx.fillText('SYDNEY TAXI', 112, 42);
  ctx.font = '700 15px JetBrains Mono, monospace';
  ctx.fillText('TX 7482 · NSW', 112, 68);
  ctx.font = '600 13px Inter, Arial, sans-serif';
  ctx.fillText('$3.60 FLAGFALL', 112, 90);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // The decals are mostly seen at grazing angles from the chase camera
  tex.anisotropy = 16;
  return tex;
}

function createNYLicensePlateTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffb81c';
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = '#0d2244';
  ctx.fillRect(6, 6, 244, 24);
  ctx.fillStyle = '#ffb81c';
  ctx.font = '800 15px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('SYDNEY', 128, 23);
  ctx.fillStyle = '#0d2244';
  ctx.font = '900 48px JetBrains Mono, monospace';
  ctx.fillText('T1274', 128, 82);
  ctx.font = '700 13px Inter, Arial, sans-serif';
  ctx.fillText('TAXI', 128, 114);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

const COLLIDER_CELL = 48;
const colliderKey = (ix, iz) => (ix + 4096) * 8192 + (iz + 4096);

const JUMP_QUEUE = 0.15; // s a jump press stays good for
const JUMP_CROUCH = 0.085; // s crouched before taking off: the press, or one held over by the queue, starts it
const KERB_EASE = 18; // /s the body eases at, up or down a kerb or onto the footway, which the feet step over
const FALLING = 0.3; // m over the ground (in the flat simulation) that's a fall, not a kerb
const BIKE_AXLE = 0.58; // m along the bike from its middle to each wheel's hub
const HEAD_ON = 0.02; // cosine of the turn a wall makes in a walker's move (89 degrees), past which it's held square on, not sliding along

// A soft shadow on the ground, `width` across and `length` along its owner, `peak` dark in the middle (js/tsl-materials.js)
function groundBlob(width, length, peak) {
  const geometry = new THREE.PlaneGeometry(width, length);
  geometry.rotateX(-Math.PI * 0.5);
  const blob = new THREE.Mesh(geometry, createBlobShadowMaterial(peak));
  blob.position.y = 0.02;
  blob.renderOrder = 998;
  return blob;
}

class ThirdPersonControllerManager {
  /**
   * `sunShadows`: whether the sun casts shadows on this graphics level (js/quality.js). Where it does, the walker's and the bike's shadows
   * are the sun's, as the crowd's are; where it doesn't, each has a soft one of its own under it.
   */
  constructor(scene, colliders = [], { sunShadows = true } = {}) {
    this.scene = scene;
    this.colliders = colliders;
    this.sunShadows = sunShadows;
    this._colliderCells = null; // built on first use, see nearColliders()
    // What holds the walker and nothing else, the fences between houses' lots (js/lot-details.js): cars keep to the roads, and the street
    // furniture, traffic and sounds never see these
    this._walkerCells = new Map();
    this.activeMode = 'car'; // 'person' | 'car' | 'cyclist' | 'helicopter'

    this.jumpQueued = 0;
    this.viewOffset = null; // how far round the camera's been turned from your heading (rad, + to the left), or null
    this.firstPerson = false; // on foot in the first-person camera (js/main.js says): A and D step aside, and the mouse turns you
    this.lookTurn = 0; // rad to the right that the mouse, a drag or a stick has turned you since the last step, in first person
    this.keys = Object.fromEntries(Object.keys(BINDINGS).map((action) => [action, false]));
    this.swim = null; // js/swimming.js, once a model with a pool to swim in is held (js/interiors.js)

    this.entities = {
      person: this.createPersonEntity(),
      car: this.createCarEntity(),
      cyclist: this.createCyclistEntity(),
      helicopter: this.createHelicopterEntity()
    };

    Object.values(this.entities).forEach((ent) => {
      if (ent.mesh) {
        ent.mesh.traverse((child) => {
          if (
            child.isMesh &&
            !child.material?.isMeshBasicNodeMaterial &&
            child.material?.type !== 'MeshBasicNodeMaterial' &&
            !child.material?.transparent
          ) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
      }
    });

    this.bindKeyboard();
  }

  setCollisionListener(listener) {
    this._collisionListener = typeof listener === 'function' ? listener : null;
    this._collisionEvent ??= { a: null, b: null, kind: '', x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, speed: 0 };
  }

  // Reuse one synchronous event; consumers must copy retained fields. Normal points from b toward a.
  reportCollision(a, b, kind, x, y, z, nx, ny, nz, speed) {
    if (!this._collisionListener || speed <= 0.5) return;
    const event = this._collisionEvent;
    event.a = a; event.b = b; event.kind = kind;
    event.x = x; event.y = y; event.z = z;
    event.nx = nx; event.ny = ny; event.nz = nz; event.speed = speed;
    this._collisionListener(event);
  }

  bindKeyboard() {
    const actionsByCode = new Map(Object.entries(BINDINGS).flatMap(([action, codes]) => codes.map((code) => [code, action])));
    this._pressedCodes = new Set();
    this._keyboardKeys = {};
    this._touchKeys = {};
    this._gamepadKeys = {};

    const onKey = (e, isDown) => {
      // F: open the door or take the seat in front of you (js/interiors.js)
      if (e.code === 'KeyF' && isDown && !e.repeat && !isTypingInField(e)) this.onUse?.();
      const action = actionsByCode.get(e.code);
      if (!action || (isDown && isTypingInField(e))) return;
      if (isDown) this._pressedCodes.add(e.code);
      else this._pressedCodes.delete(e.code);
      // Releasing one binding must not cancel another key held for the same action.
      this._keyboardKeys[action] = BINDINGS[action].some((code) => this._pressedCodes.has(code));
      this._blendInput(action);
    };

    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));
    window.addEventListener('blur', () => this.resetInput());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.resetInput();
    });
  }

  _blendInput(action) {
    if (SIDES[action]) {
      this._blendSide(SIDES[action]);
      return;
    }
    const wasUp = this.keys.up;
    const keyboard = this._keyboardKeys[action] || false;
    const touch = this._touchKeys[action] || false;
    const gamepad = this._gamepadKeys[action] || false;
    const strength = Math.max(keyboard, touch, gamepad);
    // Preserve digital button values while allowing either analog source to be strongest.
    this.keys[action] = keyboard === true || touch === true || gamepad === true ? true : strength || false;
    // A press can start and end between two frames, or land just as the feet leave a kerb: it counts for a moment
    if (action === 'up' && this.keys.up && !wasUp) this.jumpQueued = JUMP_QUEUE;
  }

  // Left or right: the arrows turn you; A or D, the touch stick and the gamepad's stick turn you too, or in first person on foot step
  // you aside. The touch stick and the gamepad say `left` and `right` for their sideways, whichever it does.
  _blendSide(side) {
    const aside = side === 'left' ? 'sideLeft' : 'sideRight';
    const keyboard = this._keyboardKeys ?? {};
    const sideways = [keyboard[aside], this._touchKeys?.[side], this._gamepadKeys?.[side]];
    this.keys[side] = this.firstPerson ? strongest(keyboard[side]) : strongest(keyboard[side], ...sideways);
    this.keys[aside] = this.firstPerson ? strongest(...sideways) : false;
  }

  /** On foot in the first-person camera, or not: what A, D and the sticks' sideways do changes, even while held */
  setFirstPerson(on) {
    on = !!on;
    if (on === this.firstPerson) return;
    this.firstPerson = on;
    this.lookTurn = 0;
    this._blendSide('left');
    this._blendSide('right');
  }

  /** Turns you `dx` rad to the right at the next step, in first person on foot (js/cameras.js look()): the mouse, a drag or a stick */
  look(dx) {
    if (this.firstPerson && Number.isFinite(dx)) this.lookTurn += dx;
  }

  _setAnalogInput(source, action, value) {
    if (!Object.hasOwn(this.keys, action)) return;
    const strength = Number(value);
    source[action] = typeof value === 'boolean' ? value : Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0;
    this._blendInput(action);
  }

  setTouchInput(action, value) {
    this._setAnalogInput(this._touchKeys, action, value);
  }

  setGamepadInput(action, value) {
    this._setAnalogInput(this._gamepadKeys, action, value);
  }

  clearTouchInput() {
    this._touchKeys = {};
    for (const action of Object.keys(this.keys)) this._blendInput(action);
  }

  clearGamepadInput() {
    this._gamepadKeys = {};
    for (const action of Object.keys(this.keys)) this._blendInput(action);
  }

  resetInput() {
    this._pressedCodes.clear();
    this._keyboardKeys = {};
    this._touchKeys = {};
    this._gamepadKeys = {};
    for (const action of Object.keys(this.keys)) this.keys[action] = false;
    this.jumpQueued = 0;
    this.lookTurn = 0;
  }

  setMode(mode) {
    if (!this.entities[mode]) return;
    this.jumpQueued = 0; // Space does something else in the other modes
    this.activeMode = mode;
    if (this.entities.person) this.entities.person.seat = null; // whatever you get into, you're up off the seat first
    const active = this.entities[mode];
    if (active.mesh) active.mesh.visible = true;
    if (active.helmet) active.helmet.visible = true;
    if (mode === 'person') active._charHidden = false;
    else if (mode === 'cyclist') active._riderHidden = false;
    const car = this.entities.car;
    if (mode !== 'car' && car?.carState) car.carState.value.x = car.carState.value.w = 0;
  }

  getActiveEntity() {
    return this.entities[this.activeMode];
  }

  // Whether (x, z) has room for this mode's body among the buildings: its surface says whether anything of the ground matters. `except`: a
  // collider not to count
  spotClear(mode, x, z, heading, except = null) {
    const body = collisionBody(mode, mode === 'helicopter' ? 4.5 : mode === 'person' ? 0.48 : 0.65, heading, 0.1);
    const baseY = mode === 'helicopter' ? 0 : this.getGroundHeight(x, z, mode);
    for (const c of this.nearColliders(x, z, Math.max(body.extX, body.extZ))) {
      if (c !== except && buildingContact(c, x, baseY, z, body)) return false;
    }
    if (mode === 'person') for (const c of this.nearWalkerColliders(x, z, body.radius)) if (buildingContact(c, x, baseY, z, body)) return false;
    return true;
  }

  // The fences, made and dropped as they're drawn near you
  addWalkerColliders(list) {
    this._walkerCells ??= new Map();
    for (const c of list) this._eachWalkerCell(c, (key) => (this._walkerCells.get(key) || this._walkerCells.set(key, []).get(key)).push(c));
  }

  removeWalkerColliders(list) {
    if (!list.length || !this._walkerCells) return;
    const gone = new Set(list);
    for (const c of list) {
      this._eachWalkerCell(c, (key) => {
        const kept = (this._walkerCells.get(key) || []).filter((o) => !gone.has(o));
        if (kept.length) this._walkerCells.set(key, kept);
        else this._walkerCells.delete(key);
      });
    }
  }

  _eachWalkerCell(c, fn) {
    for (let ix = Math.floor(c.minX / COLLIDER_CELL); ix <= Math.floor(c.maxX / COLLIDER_CELL); ix++) {
      for (let iz = Math.floor(c.minZ / COLLIDER_CELL); iz <= Math.floor(c.maxZ / COLLIDER_CELL); iz++) fn(colliderKey(ix, iz));
    }
  }

  nearWalkerColliders(x, z, r) {
    if (!this._walkerCells?.size) return [];
    const out = new Set();
    for (let ix = Math.floor((x - r) / COLLIDER_CELL); ix <= Math.floor((x + r) / COLLIDER_CELL); ix++) {
      for (let iz = Math.floor((z - r) / COLLIDER_CELL); iz <= Math.floor((z + r) / COLLIDER_CELL); iz++) {
        for (const c of this._walkerCells.get(colliderKey(ix, iz)) || []) out.add(c);
      }
    }
    return [...out];
  }

  // The roofs around (x, z), as high above sea level as they're drawn, and how far away each is
  roofsNear(x, z, radius = FLY_AREA) {
    const out = [];
    for (const c of this.nearColliders(x, z, radius)) {
      const dx = x < c.minX ? c.minX - x : x > c.maxX ? x - c.maxX : 0;
      const dz = z < c.minZ ? c.minZ - z : z > c.maxZ ? z - c.maxZ : 0;
      const away = Math.hypot(dx, dz);
      if (away > radius || !(c.maxY > 2.5)) continue;
      const base = c.baseY ?? groundHeight((c.minX + c.maxX) / 2, (c.minZ + c.maxZ) / 2);
      out.push({ top: base + c.maxY, away });
    }
    // The towers drawn from models of their own, loaded or not yet (they come once the city round you is in): their sites say how high
    for (const s of MODEL_SITES) {
      if (!s.top) continue;
      const away = Math.max(0, Math.hypot(x - s.x, z - s.z) - (s.radius ?? 0));
      if (away <= radius) out.push({ top: s.y + s.top, away });
    }
    return out;
  }

  // Changing travel mode: the new one starts from where this one is (js/arrivals.js). Out of the car or off the bike you stand beside it;
  // from the car the bike's where the car was, and from your feet where you stand. A car or bike you leave stands where you left it for
  // PARKED_FOR, unless you leave one for the other, when it's gone at once. `start` ({ x, z, heading, y }): somewhere else to start from,
  // the way out of a building you're in (js/main.js). `vehicleAt(x, z, y, reach)`, if set, says when traffic is there. Returns how far
  // the player moved.
  switchMode(mode, start = null) {
    if (!this.canSwitchTo(mode)) return null;
    if (!this.entities[mode]) return 0;
    if (mode === this.activeMode) {
      this.setMode(mode);
      return 0;
    }
    const was = this.getActiveEntity();
    const flying = this.activeMode === 'helicopter';
    const y = flying ? was.position.y + groundHeight(was.position.x, was.position.z)
      : was.surfaceY ?? surfaceHeight(was.surface || 0, was.position.x, was.position.z);
    let from = { x: was.position.x, z: was.position.z, heading: was.heading, y, surface: was.surface || 0, flying };
    let onFootway = !!was.onFootway;
    if (start) {
      // Out of the building first: the Pylon Lookout's way out is onto the footway
      const held = holdOnFootway(start.x, start.z);
      onFootway = !!held && Math.abs(held.y - start.y) < 1;
      from = { x: start.x, z: start.z, heading: start.heading, y: start.y, surface: onFootway ? DECK_SID : 0, flying: false };
    }
    const next = this.entities[mode];
    const vehicle = (e) => e.type === 'car' || e.type === 'cyclist';
    // Nothing of the ground is in the way up on a structure; on the ground, its body clear of still water (js/still-water.js) too
    const clearFor = (m, except = null) => (x, z) => (!!from.surface || (this.spotClear(m, x, z, from.heading, except) && !inStillWater(m, x, z, from.heading)))
      && !this.vehicleAt?.(x, z, y, NEAR_TRAFFIC);

    // A vehicle left nearby is still there: get back in it where it is. Out of its way first, so it doesn't stand in its own way
    let arrival = null;
    if (next._parked && Math.hypot(next.position.x - from.x, next.position.z - from.z) <= RESUME_PARKED
      && Math.abs((next.surfaceY ?? 0) - (flying ? floorBelow(from.x, from.z, y) : y)) < 3) {
      arrival = { x: next.position.x, z: next.position.z, heading: next.heading, surface: next.surface || 0 };
    }
    if (vehicle(next)) this.removeParked(next);
    if (!arrival && vehicle(was) && mode === 'person') arrival = besideVehicle(from, was.type === 'car' ? CAR_DOORS : BIKE_SIDES, { isClear: clearFor('person') });
    // The bike where the car was, or where you stand: not on the Harbour Bridge's footway, which holds only a walker. Beside the car you've
    // just got out of, its box is a few centimetres into the bike's round: it eases the bike off as it moves, rather than send it elsewhere
    if (!arrival && mode === 'cyclist' && (was.type === 'car' || (was.type === 'person' && !onFootway))
      && clearFor('cyclist', this.entities.car?._collider ?? null)(from.x, from.z)) {
      arrival = { x: from.x, z: from.z, heading: from.heading, surface: from.surface };
    }
    // A lane on the ground is dry over still water, and one on a deck or in a tunnel over it or under it isn't held by it
    arrival ??= arrivalFor(mode, from, {
      isClear: (x, z) => this.spotClear(mode, x, z, from.heading) && !this.vehicleAt?.(x, z, y)
        && (!inStillWater(mode, x, z, from.heading) || structuresAt(x, z).length > 0),
      roofs: (x, z) => this.roofsNear(x, z)
    });

    // Stays where it was left, if it's the kind of thing you can leave somewhere, and you didn't take the other
    if (vehicle(was)) {
      if (vehicle(next)) this.removeParked(was);
      else this.park(was);
    }
    this.setMode(mode);
    if (arrival) {
      this.teleportActiveTo(arrival.x, arrival.z, arrival.heading, arrival.altitude ?? null, arrival.surface || 0, true);
      next.onFootway = !!arrival.footway;
      if (arrival.footway) next.position.y = this.getGroundHeight(arrival.x, arrival.z, mode);
    } else {
      // Nowhere suitable in reach: straight down or across, as a teleport would
      this.teleportActiveTo(from.x, from.z, from.heading);
    }
    return Math.hypot(next.position.x - from.x, next.position.z - from.z);
  }

  /** Whether you can change to `mode` now: not to the car or the bike in a pool's water (js/swimming.js) */
  canSwitchTo(mode) {
    const p = this.entities.person;
    return !(this.activeMode === 'person' && (p?.swim || p?.dive) && (mode === 'car' || mode === 'cyclist'));
  }

  /** The use key's label in a pool's water or at a ladder's top (js/swimming.js prompt()), or null */
  swimPrompt() {
    return this.activeMode === 'person' && this.swim ? this.swim.prompt(this, this.entities.person) : null;
  }

  /** The use key in a pool's water or at a ladder's top: true if it climbed */
  swimUse() {
    return this.activeMode === 'person' && !!this.swim?.use(this, this.entities.person);
  }

  /** Where to put you back on a reload, if you're in a pool's water: beside it ({ x, z, heading }), or null */
  poolside() {
    const p = this.entities.person;
    return this.activeMode === 'person' && p?.swim && this.swim ? this.swim.poolside(p) : null;
  }

  // A car or bike left where it is, stopped, for PARKED_FOR. The car on the ground is in the way, as the cars at the kerbs are; on a deck or
  // in a tunnel nothing of the ground counts, so it isn't
  park(e) {
    e._parked = true;
    e._parkedFor = 0;
    e.speed = 0;
    e.vx = e.vz = 0;
    // The bike stands empty, leaning onto its stand (updateVisibility() shows it)
    if (e.type === 'cyclist' && e.leanPivot) e.leanAngle = e.leanPivot.rotation.z = STAND_LEAN;
    if (e.type === 'car' && !e.surface) {
      const cs = Math.cos(e.heading), sn = Math.sin(e.heading), { hx, hz } = PARKED_BOX;
      const ex = Math.abs(cs) * hx + Math.abs(sn) * hz, ez = Math.abs(sn) * hx + Math.abs(cs) * hz;
      const { x, z } = e.position;
      e._collider = { minX: x - ex, maxX: x + ex, minZ: z - ez, maxZ: z + ez, minY: 0, maxY: PARKED_BOX.top, obb: { cx: x, cz: z, hx, hz, cs, sn }, parked: true, player: true };
      this.addColliders([e._collider]);
    }
  }

  // ...and gone: not drawn, out of traffic's way and nobody's
  removeParked(e) {
    e._parked = false;
    e._parkedFor = 0;
    if (e._collider) {
      this.removeColliders([e._collider]);
      e._collider = null;
    }
  }

  // Everything you left, gone: a teleport
  clearParked() {
    for (const e of Object.values(this.entities)) if (e._parked) this.removeParked(e);
  }

  // The car and bike left, for scripts: where each stands and the seconds it has left
  parkedList() {
    return Object.entries(this.entities).filter(([, e]) => e._parked).map(([mode, e]) => ({
      mode, x: e.position.x, z: e.position.z, heading: e.heading, surface: e.surface || 0, left: Math.max(0, PARKED_FOR - (e._parkedFor || 0)), collider: !!e._collider
    }));
  }

  // Each frame: what you left stands there for PARKED_FOR of the game's time
  tickParked(dt) {
    for (const e of Object.values(this.entities)) {
      if (!e._parked) continue;
      e._parkedFor = (e._parkedFor || 0) + dt;
      if (e._parkedFor >= PARKED_FOR) this.removeParked(e);
    }
  }

  /**
   * The walker put at (x, z), facing `heading`, just as it is: a spot found clear for it (js/interior-data.js exitSpot()), out of a
   * building. On the Harbour Bridge's footway if that's there at about height y, as getting out of a car on the bridge puts you, and the
   * ground otherwise. Returns { x, z, footway }, or null off your feet.
   */
  placeWalker(x, z, heading, y) {
    if (this.activeMode !== 'person') return null;
    const held = holdOnFootway(x, z);
    const footway = !!held && Math.abs(held.y - y) < 1;
    this.teleportActiveTo(footway ? held.x : x, footway ? held.z : z, heading, null, footway ? DECK_SID : 0, true);
    const p = this.entities.person;
    if (footway) {
      p.onFootway = true;
      p.position.y = this.getGroundHeight(p.position.x, p.position.z, 'person');
    }
    return { x: p.position.x, z: p.position.z, footway };
  }

  // The car, if it's parked and showing: traffic goes round it
  parkedCar() {
    const car = this.entities.car;
    return car._parked && car._shown ? car : null;
  }

  // Only the mode in use is drawn, and a car or bicycle left nearby. Only their meshes hide: a hidden light drops out of the
  // scene's lights, and that recompiles every material in it.
  updateVisibility() {
    const active = this.getActiveEntity();
    const show = (e, shown) => {
      if (e._shown === shown) return;
      e._shown = shown;
      if (!e._body) {
        e._body = [];
        const holdsLight = (o) => {
          let found = false;
          o.traverse((child) => { if (child.isLight) found = true; });
          return found;
        };
        e.mesh.traverse?.((o) => { if (o.isMesh && !o.userData?.ownVisibility && !holdsLight(o)) e._body.push(o); });
      }
      for (const mesh of e._body) mesh.visible = shown;
    };
    for (const e of Object.values(this.entities)) {
      if (e.type === 'person') continue; // poseCharacters() has it, with the crowd it's drawn by
      const near = Math.hypot(e.position.x - active.position.x, e.position.z - active.position.z) <= SHOW_PARKED;
      show(e, e === active || ((e.type === 'car' || e.type === 'cyclist') && !!e._parked && near));
    }
    // The bike's stand, while it stands
    const bike = this.entities.cyclist;
    if (bike?.stand) bike.stand.visible = bike !== active && !!bike._parked && bike._shown !== false;
  }

  // `surface`: the structure to arrive on (js/surfaces.js), or 0 for the ground under (x, z)
  teleportActiveTo(x, z, heading = Math.PI, savedAltitude = null, surface = 0, exact = false) {
    const person = this.entities.person;
    if (person) {
      person.seat = null;
      // Out of the water, wherever it is you're put
      if (person.swim || person.dive) {
        if (this.swim) this.swim.stop(person);
        else person.swim = person.dive = null;
      }
    }
    const ent = this.getActiveEntity();
    this.resetInput();
    if (!Number.isFinite(heading)) heading = ent.heading;
    const heli = this.activeMode === 'helicopter';
    const altitude = heli ? Math.max(0.25, Math.min(380, savedAltitude ?? Math.max(92, ent.position.y))) : 0;
    const onStructure = !heli && surface && (exact || structureAt(surface, x, z)?.inside);
    // Nothing of the ground is in the way up on a structure; on the ground, a clear spot near (x, z)
    const destination = onStructure || exact ? { x, z } : this.findTeleportPosition(x, z, heading, altitude);
    if (destination) {
      ent.surface = onStructure ? surface : 0;
      ent.surfaceY = surfaceHeight(ent.surface, destination.x, destination.z);
      // On the ground inside a deck too low to be under (js/surfaces.js freeFromDeck()): onto it, or out beside it. The margin is the
      // player's step's (resolveHorizontalCollision())
      const car = this.activeMode === 'car';
      const out = !heli && !ent.surface ? freeFromDeck(ent.surfaceY, destination.x, destination.z, car ? 1.0 : (this.activeMode === 'person' ? 0.48 : 0.65) * 0.6, car ? ROOM.car : ROOM.foot) : null;
      if (out) {
        destination.x = out.x;
        destination.z = out.z;
        ent.surface = out.sid;
        ent.surfaceY = out.y;
      }
      ent.position.x = destination.x;
      ent.position.z = destination.z;
      ent.heading = heading;
      ent.onFootway = false;
      ent.deck = !!ent.surface && onDeck(ent.surface);
      ent.position.landed = { x: destination.x, z: destination.z };
      // What's drawn where it arrives, its triangles made now (js/drawn-ground.js): the walker's feet are planted on it, and what's ridden
      // stands on it. Not while the first view loads (a saved place's arrival): that waits for the world's jobs, as the rest of it does
      if (!heli && this.groundAhead) while (buildNear(destination.x, destination.z, 4));
      ent.position.y = heli ? altitude : this.getGroundHeight(destination.x, destination.z, this.activeMode);
    }
    ent.speed = 0;
    if (this.activeMode === 'person') {
      ent.verticalVel = 0;
      ent.jumping = false;
      ent.jumpPrep = 0;
      ent.heldBack = null;
      if (ent.shadow) {
        ent.shadow.position.y = 0.02;
        ent.shadow.scale.set(1, 1, 1);
      }
      ent._charHidden = false;
      if (ent.mesh) ent.mesh.visible = true;
      ent.rig.reset(ent.position.x, ent.position.z, ent.heading, personGround, this);
      ent.crowd.begin();
      ent.crowd.add(ent.rig, 0);
      ent.crowd.end();
    } else if (this.activeMode === 'car') {
      ent.prevX = ent.position.x;
      ent.prevZ = ent.position.z;
      ent.vx = ent.vz = ent.angularVel = ent.steerAngle = 0;
      ent.pitchVel = ent.rollVel = ent.heaveY = ent.heaveVel = 0;
      ent.chassisPivot.rotation.x = ent.chassisPivot.rotation.z = 0;
      ent.chassisPivot.position.y = 0;
      ent.lastCollisionSpark = null;
      for (const wheel of ent.wheels) if (wheel.isFront) wheel.steerPivot.rotation.y = 0;
      if (ent.carState) ent.carState.value.x = ent.carState.value.w = 0;
    } else if (this.activeMode === 'cyclist') {
      ent.leanAngle = ent.leanPivot.rotation.z = 0;
      ent._brakeHold = 0;
      ent.wheelOver = null;
      this.standBike(ent);
      ent._riderHidden = false;
      if (ent.helmet) ent.helmet.visible = true;
    } else if (heli) {
      ent.verticalSpeed = ent.pitchAngle = ent.rollAngle = 0;
      ent.tiltPivot.rotation.x = ent.tiltPivot.rotation.z = 0;
      ent.tiltPivot.position.y = 0;
    }
    ent.mesh.position.copy(ent.position);
    ent.mesh.rotation.y = ent.heading;
    return { x: ent.position.x, z: ent.position.z };
  }

  // Find a fully clear arrival before moving the player. Sequential collision pushes can leave a player trapped
  // between overlapping buildings, so test whole candidate footprints instead; retain the old position if none fits.
  findTeleportPosition(x, z, heading, altitude) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const heli = this.activeMode === 'helicopter';
    const radius = heli ? 4.5 : this.activeMode === 'person' ? 0.48 : 0.65;
    const sinH = Math.sin(heading), cosH = Math.cos(heading);
    const shape = collisionBody(this.activeMode, radius, heading, 0.1);
    const reach = Math.max(shape.extX, shape.extZ);
    const margin = heli ? 6000 : 0;
    const entity = this.getActiveEntity();
    // Conservative body cylinders, including the taxi's corners, bicycle wheels and helicopter tail/rotor.
    const body = { person: [0.48, 1.9], car: [2.4, 1.9], cyclist: [1.0, 1.9], helicopter: [6.2, 3.2] };
    // The walker is only ever where you are, and a car or bike gone isn't anywhere
    const others = Object.values(this.entities).filter(e => e !== entity && e.type !== 'person' && e._shown !== false && e._parked !== false).map(e => ({
      x: e.position.x, z: e.position.z, radius: body[e.type][0],
      bottom: e.position.y - (e.type === 'helicopter' ? 0.7 : 0), top: e.position.y + body[e.type][1]
    }));
    const cameraBack = Math.cos(0.09) * entity.chaseDistance;
    const cameraUp = entity.chaseHeight + Math.sin(0.09) * entity.chaseDistance * 0.85;
    const clampPoint = (px, pz) => {
      pz = Math.max(CITY_BOUNDS.minZ + (heli ? -6000 : 30), Math.min(CITY_BOUNDS.maxZ + margin, pz));
      px = Math.max(CITY_BOUNDS.minX - margin, Math.min(CITY_BOUNDS.maxX + margin, px));
      if (!heli && (!clearOfWater(px, pz) || inStillWater(this.activeMode, px, pz, heading))) return null;
      return { x: px, z: pz };
    };
    const clear = (p) => {
      if (!p) return false;
      const baseY = heli ? altitude : this.getGroundHeight(p.x, p.z, this.activeMode);
      // Keep other player models out of both the arrival and its default chase view. A corridor also prevents a
      // parked car between camera and character from hiding the character even when the camera itself is outside it.
      const viewTop = baseY + Math.max(body[entity.type][1], cameraUp);
      for (const other of others) {
        if (other.bottom > viewTop + 0.3 || other.top < baseY - (heli ? 0.7 : 0) - 0.3) continue;
        const dx = other.x - p.x, dz = other.z - p.z;
        const back = Math.max(0, Math.min(cameraBack, -dx * sinH - dz * cosH));
        if (Math.hypot(dx + sinH * back, dz + cosH * back) < other.radius + Math.max(body[entity.type][0], 0.5) + 0.1) return false;
      }
      for (const c of this.nearColliders(p.x, p.z, reach)) {
        if (buildingContact(c, p.x, baseY, p.z, shape)) return false;
      }
      return true;
    };
    const origin = clampPoint(x, z);
    if (clear(origin)) return origin;
    // Four-metre rings cover nearby streets and courtyards, with bounded work even for a click inside a large block.
    const cx = origin ? origin.x : Math.max(CITY_BOUNDS.minX, Math.min(CITY_BOUNDS.maxX, x));
    const cz = origin ? origin.z : Math.max(CITY_BOUNDS.minZ + 30, Math.min(CITY_BOUNDS.maxZ, z));
    for (let distance = 4; distance <= 256; distance += 4) {
      for (let i = 0; i < 32; i++) {
        const angle = i * Math.PI / 16;
        const p = clampPoint(cx + Math.cos(angle) * distance, cz + Math.sin(angle) * distance);
        if (clear(p)) return p;
      }
    }
    return null;
  }

  // =========================================================================
  // 1. PERSON (SKINNED PEDESTRIAN WITH PLANTED-FOOTSTEP IK GAIT, see pedestrians.js)
  // =========================================================================
  createPersonEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerPerson';

    // One skinned person, posed in world space every frame by its rig (walk, run, turn, jump)
    const crowd = new PersonCrowd(1, { farDistance: Infinity });
    crowd.meshes.forEach((m) => this.scene.add(anchorToOrigin(m)));
    const rig = new PersonRig({ ...PLAYER_LOOK, armSwing: 1.0 });

    // Without the sun's shadows, a soft disc under the feet
    const pedShadow = this.sunShadows ? null : groundBlob(0.8, 0.8, 0.7);
    if (pedShadow) root.add(pedShadow);

    this.scene.add(root);

    return {
      type: 'person',
      label: 'Pedestrian',
      mesh: root,
      shadow: pedShadow,
      crowd,
      rig,
      position: new THREE.Vector3(SPAWN.x + 12, CITY_BOUNDS.sidewalkHeight, SPAWN.z),
      heading: SPAWN.heading,
      speed: 0,
      verticalVel: 0,
      jumping: false, // in the air, from a jump or a fall
      jumpPrep: 0, // s of the crouch before taking off still to go
      heldBack: null, // what a wall left of the last step's move, forward and aside (m/s), or null
      swim: null, // in a pool's water (js/swimming.js): how it's swimming, or climbing in or out
      dive: null, // diving in off a pool's edge: its flight
      swimEvents: [], // the drops and splashes the swimmer made since the last frame, for the water and the sound (js/main.js)
      cameraTargetOffset: new THREE.Vector3(0, 1.55, 0),
      chaseDistance: 4.3,
      chaseHeight: 1.95
    };
  }

  // =========================================================================
  // 2. CAR (3D LOFTED TAXI SEDAN)
  // =========================================================================
  createCarEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerTaxiCar';

    const chassisPivot = new THREE.Group();
    root.add(chassisPivot);

    const spec = BODY_SPECS.taxi;
    const taxiLoftMat = createLoftedCarMaterial(spec, 0xe6e6e0); // Sydney's cabs are white, silver or black, with a small roof light

    // 1. 3D Lofted Taxi Body + Curved Windscreens + Crowned Roof + Side Mirrors + Roof Sign
    const carBodyGeo = buildCarGeometry(spec, false);
    const carBodyMesh = new THREE.Mesh(carBodyGeo, taxiLoftMat);
    carBodyMesh.castShadow = true;
    carBodyMesh.receiveShadow = true;
    chassisPivot.add(carBodyMesh);

    // 2. Taxi side door and fare tariff decals, hugging the curved front doors
    const doorDecalTex = createTaxiDoorDecalTexture();
    const doorDecalMat = new THREE.MeshStandardNodeMaterial({
      map: doorDecalTex,
      roughness: 0.24,
      metalness: 0.34,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    });
    const doorMid = (spec.doors[0] + spec.doors[1]) / 2;
    for (const side of [-1, 1]) {
      const decal = new THREE.Mesh(buildCarSidePatch(spec, side, doorMid - 0.36, doorMid + 0.36, 0.53, 0.81, 0.003), doorDecalMat);
      chassisPivot.add(decal);
    }

    // 3. License plates on the raked bumpers, tilted to follow the fascias
    const nyPlateTex = createNYLicensePlateTexture();
    const nyPlateMat = new THREE.MeshStandardNodeMaterial({ map: nyPlateTex, roughness: 0.28 });
    for (const front of [true, false]) {
      const y = spec.plates[front ? 0 : 1];
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.14, 0.008), nyPlateMat);
      plate.position.set(0, y, carTipZ(spec, y, front) + (front ? 0.003 : -0.003));
      plate.rotation.x = Math.atan((carTipZ(spec, y + 0.07, front) - carTipZ(spec, y - 0.07, front)) / 0.14);
      chassisPivot.add(plate);
    }

    // 3b. Brake, reverse & turn lights are lit by the taxi material from its carState uniform (see updateCar)
    const carState = taxiLoftMat.userData.carState;

    // 4. Steerable & Spinning 3D LatheGeometry Tyres + Recessed 5-Spoke Alloy Wheels
    const leftWheelGeo = buildSteerableWheelGeo(spec, -1);
    const rightWheelGeo = buildSteerableWheelGeo(spec, 1);
    const taxiWheelMat = createCarWheelMaterial({ wheelRadius: spec.wheelRadius });

    const wheels = [];
    const wheelCoords = [
      { side: -1, z: spec.wheelZ, isFront: true },
      { side: 1, z: spec.wheelZ, isFront: true },
      { side: -1, z: -spec.wheelZ, isFront: false },
      { side: 1, z: -spec.wheelZ, isFront: false }
    ];
    for (const wc of wheelCoords) {
      const steerPivot = new THREE.Group();
      steerPivot.position.set(wc.side * spec.wheelX, spec.wheelRadius, wc.z);
      const tire = new THREE.Mesh(wc.side < 0 ? leftWheelGeo : rightWheelGeo, taxiWheelMat);
      tire.castShadow = true;
      tire.receiveShadow = true;
      steerPivot.add(tire);
      root.add(steerPivot);
      wheels.push({ steerPivot, tire, isFront: wc.isFront });
    }

    // 5. Ground contact shadow and paired headlight spotlights
    const carShadowGeo = new THREE.PlaneGeometry(2.22, 5.05);
    carShadowGeo.rotateX(-Math.PI * 0.5);
    const carShadow = new THREE.Mesh(carShadowGeo, createContactShadowMaterial());
    carShadow.position.set(0, 0.02, 0.0);
    carShadow.renderOrder = 998;
    root.add(carShadow);

    const headLights = [];
    for (const side of [-1, 1]) {
      const spot = createVehicleHeadlight();
      placeVehicleHeadlight(spot, spec, side);
      chassisPivot.add(spot, spot.target);
      headLights.push(spot);
    }

    this.scene.add(root);

    return {
      type: 'car',
      label: 'Sydney Taxi',
      mesh: root,
      chassisPivot,
      carState,
      headLights,
      wheels,
      position: new THREE.Vector3(SPAWN.x, 0.0, SPAWN.z),
      prevX: SPAWN.x,
      prevZ: SPAWN.z,
      heading: SPAWN.heading,
      speed: 0,
      vx: 0,
      vz: 0,
      angularVel: 0,
      pitchVel: 0,
      rollVel: 0,
      heaveY: 0,
      heaveVel: 0,
      lastCollisionSpark: null,
      steerAngle: 0,
      wheelSpin: 0,
      cameraTargetOffset: new THREE.Vector3(0, 0.96, 0),
      chaseDistance: 6.9,
      chaseHeight: 2.12
    };
  }

  // =========================================================================
  // 3. CYCLIST (3D LOFTED RIDER + ROAD/CITI BICYCLE)
  // =========================================================================
  createCyclistEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerCyclist';

    const leanPivot = new THREE.Group();
    root.add(leanPivot);

    const frameMat = createCarPaintMaterial(0x0078e8);
    const tireMat = new THREE.MeshStandardNodeMaterial({
      color: 0x181a1e,
      roughness: 0.60
    });
    const chromeMat = new THREE.MeshStandardNodeMaterial({
      color: 0xe0e8f0,
      roughness: 0.16,
      metalness: 0.78
    });
    const shortsMat = new THREE.MeshStandardNodeMaterial({
      color: 0x1c2028,
      roughness: 0.55
    });
    const helmetMat = new THREE.MeshStandardNodeMaterial({
      color: 0xf4f7fb,
      emissive: 0x181c22,
      roughness: 0.22,
      metalness: 0.25
    });

    const wheelTorusGeo = new THREE.TorusGeometry(0.35, 0.038, 12, 24);
    wheelTorusGeo.rotateY(Math.PI * 0.5);
    const rimTorusGeo = new THREE.TorusGeometry(0.31, 0.018, 8, 24);
    rimTorusGeo.rotateY(Math.PI * 0.5);

    const frontWheel = new THREE.Mesh(wheelTorusGeo, tireMat);
    frontWheel.add(new THREE.Mesh(rimTorusGeo, chromeMat));
    frontWheel.position.set(0, 0.38, 0.58);
    leanPivot.add(frontWheel);

    const rearWheel = new THREE.Mesh(wheelTorusGeo, tireMat);
    rearWheel.add(new THREE.Mesh(rimTorusGeo, chromeMat));
    rearWheel.position.set(0, 0.38, -0.58);
    leanPivot.add(rearWheel);

    // Rear red LED safety strobe on seatpost
    const tailLed = new THREE.Mesh(
      new THREE.SphereGeometry(0.032, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff1e26 })
    );
    tailLed.position.set(0, 0.86, -0.32);
    leanPivot.add(tailLed);

    const topTube = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.72, 10), frameMat);
    topTube.rotation.x = Math.PI * 0.46;
    topTube.position.set(0, 0.78, 0.04);
    leanPivot.add(topTube);

    const downTube = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.78, 10), frameMat);
    downTube.rotation.x = Math.PI * 0.28;
    downTube.position.set(0, 0.58, 0.16);
    leanPivot.add(downTube);

    const seatTube = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.64, 10), frameMat);
    seatTube.rotation.x = -0.22;
    seatTube.position.set(0, 0.66, -0.22);
    leanPivot.add(seatTube);

    const saddle = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.16, 8, 10), shortsMat);
    saddle.rotation.x = Math.PI * 0.5;
    saddle.scale.set(1.15, 1.0, 0.55);
    saddle.position.set(0, 0.96, -0.28);
    leanPivot.add(saddle);

    const fork = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.016, 0.68, 10), chromeMat);
    fork.rotation.x = -0.24;
    fork.position.set(0, 0.68, 0.48);
    leanPivot.add(fork);

    const handlebar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.48, 10), chromeMat);
    handlebar.rotation.z = Math.PI * 0.5;
    handlebar.position.set(0, 0.98, 0.40);
    leanPivot.add(handlebar);

    // Pedal cranks at the bottom bracket (they turn with the pedal phase, the pedals stay level)
    const bikeFrame = {
      seat: new THREE.Vector3(0, 0.98, -0.28),
      bars: new THREE.Vector3(0, 0.98, 0.4),
      gripHalf: 0.22,
      bracket: new THREE.Vector3(0, 0.34, -0.145),
      crankLength: 0.17
    };
    const crankPivot = new THREE.Group();
    crankPivot.position.copy(bikeFrame.bracket);
    const crankGeo = new THREE.BoxGeometry(0.016, bikeFrame.crankLength, 0.03).translate(0, -bikeFrame.crankLength / 2, 0);
    const pedalGeo = new THREE.BoxGeometry(0.09, 0.018, 0.07);
    const pedals = [];
    for (const side of [1, -1]) {
      const arm = new THREE.Group();
      arm.rotation.x = side > 0 ? 0 : Math.PI;
      const crank = new THREE.Mesh(crankGeo, chromeMat);
      crank.position.x = side * 0.065;
      const pedal = new THREE.Mesh(pedalGeo, tireMat);
      pedal.position.set(side * 0.1, -bikeFrame.crankLength, 0);
      arm.add(crank, pedal);
      crankPivot.add(arm);
      pedals.push(pedal);
    }
    leanPivot.add(crankPivot);

    // A kickstand under the left chainstay, behind the bottom bracket, down to the ground at the bike's lean while it stands parked
    // (STAND_LEAN), its foot 0.2 m out to the left, as low as the tyres touch the ground (0.008 m under the frame's 0, where the lean
    // turns round) less half its thickness. Shown only then (updateVisibility())
    const standTop = new THREE.Vector3(0.045, 0.3, -0.26);
    const standFoot = new THREE.Vector3(0.2, (-0.003 - 0.2 * Math.sin(STAND_LEAN)) / Math.cos(STAND_LEAN), -0.4);
    const standAlong = standFoot.clone().sub(standTop);
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.011, standAlong.length(), 6), frameMat);
    stand.position.copy(standTop).add(standFoot).multiplyScalar(0.5);
    stand.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), standAlong.normalize());
    stand.visible = false;
    stand.userData.ownVisibility = true;
    leanPivot.add(stand);

    // Skinned rider (see pedestrians.js), posed every frame with its hands on the grips and feet on the pedals; the
    // helmet rides on its head. It's you: the walker's look. A bike left standing has nobody on it
    const riderCrowd = new PersonCrowd(1, { farDistance: Infinity });
    riderCrowd.meshes.forEach((m) => this.scene.add(anchorToOrigin(m)));
    const riderRig = new PersonRig({ ...PLAYER_LOOK });
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 12), helmetMat);
    helmet.scale.set(0.95, 0.68, 1.28);
    this.scene.add(helmet);

    // Without the sun's shadows, a soft oval along the bike, from tyre to tyre
    const bikeShadow = this.sunShadows ? null : groundBlob(0.7, 2.1, 0.8);
    if (bikeShadow) root.add(bikeShadow);

    const headLight = new THREE.SpotLight(0xf2f7ff, 0, 20, 0.34, 0.76, 1.25);
    headLight.position.set(0, 1.32, 0.62);
    headLight.target.position.set(0, 0.0, 7.6);
    leanPivot.add(headLight, headLight.target);

    this.scene.add(root);

    return {
      type: 'cyclist',
      label: 'Cyclist',
      mesh: root,
      leanPivot,
      frontWheel,
      rearWheel,
      crankPivot,
      pedals,
      bikeFrame,
      riderCrowd,
      riderRig,
      helmet,
      stand,
      headLight,
      shadow: bikeShadow,
      position: new THREE.Vector3(SPAWN.x + 2, 0.0, SPAWN.z + 20),
      heading: SPAWN.heading,
      speed: 0,
      leanAngle: 0,
      pedalPhase: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.35, 0),
      chaseDistance: 4.8,
      chaseHeight: 2.05
    };
  }

  // =========================================================================
  // 4. HELICOPTER (3D LOFTED SIGHTSEEING TWIN-TURBINE CHOPPER)
  // =========================================================================
  createHelicopterEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerHelicopter';

    const tiltPivot = new THREE.Group();
    root.add(tiltPivot);

    const heliLoftMat = createLoftedHelicopterMaterial();
    const blurDiscMat = new THREE.MeshBasicNodeMaterial({
      color: 0xc8d8e8,
      transparent: true,
      opacity: 0.13,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    // 1. 3D Lofted Monocoque Fuselage + Tailboom + Twin-Turbine Cowling + Swept Fin + Stabilizers + Tubular Skids
    const heliBodyGeo = buildHelicopterBodyGeometry();
    const heliBodyMesh = new THREE.Mesh(heliBodyGeo, heliLoftMat);
    heliBodyMesh.castShadow = true;
    heliBodyMesh.receiveShadow = true;
    tiltPivot.add(heliBodyMesh);

    // 2. 4-Blade Main Rotor Assembly with Swashplate, Hub Dome & Yellow Safety Blade Tips
    const mainRotorPivot = new THREE.Group();
    mainRotorPivot.position.set(0, 2.66, -0.35);
    const mainRotorGeo = buildHelicopterMainRotorGeometry();
    const mainRotorMesh = new THREE.Mesh(mainRotorGeo, heliLoftMat);
    mainRotorMesh.castShadow = true;
    mainRotorPivot.add(mainRotorMesh);

    const blurDisc = new THREE.Mesh(new THREE.CylinderGeometry(4.85, 4.85, 0.015, 32), blurDiscMat);
    mainRotorPivot.add(blurDisc);
    tiltPivot.add(mainRotorPivot);

    // 3. 4-Blade Tail Rotor Assembly on Swept Vertical Fin
    const tailRotorPivot = new THREE.Group();
    tailRotorPivot.position.set(0.18, 2.02, -5.62);
    const tailRotorGeo = buildHelicopterTailRotorGeometry();
    const tailRotorMesh = new THREE.Mesh(tailRotorGeo, heliLoftMat);
    tailRotorPivot.add(tailRotorMesh);
    tiltPivot.add(tailRotorPivot);

    // 4. FAA Port (Red), Starboard (Green) & Anti-Collision Fin Beacon (Red) Navigation Strobes
    const navRed = new THREE.Mesh(
      new THREE.SphereGeometry(0.036, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff2b2b })
    );
    navRed.position.set(-1.09, 1.54, -4.35);
    const navGreen = new THREE.Mesh(
      new THREE.SphereGeometry(0.036, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0x22ff66 })
    );
    navGreen.position.set(1.09, 1.54, -4.35);
    const navTail = new THREE.Mesh(
      new THREE.SphereGeometry(0.042, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff3b2b })
    );
    navTail.position.set(0, 2.84, -6.04);
    tiltPivot.add(navRed, navGreen, navTail);

    this.scene.add(root);

    return {
      type: 'helicopter',
      label: 'Sightseeing Helicopter',
      mesh: root,
      tiltPivot,
      mainRotorPivot,
      tailRotorPivot,
      position: new THREE.Vector3(SPAWN.x - 110, 96, SPAWN.z - 60),
      heading: 0.62,
      speed: 0,
      verticalSpeed: 0,
      pitchAngle: 0,
      rollAngle: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.55, 0),
      chaseDistance: 11.4,
      chaseHeight: 3.3
    };
  }

  // On a raised curb island (city-config.js BLOCKS): footpath or park
  isPointOnSidewalk(x, z) {
    return !!blockAt(x, z);
  }

  // How far over the ground (the flat simulation's height) something stands at (x, z), off a deck: on foot, or a bike's middle (its wheels
  // stand on their own, standBike()). A car's wheels are js/ground-geometry.js wheelContacts()'s.
  getGroundHeight(x, z, mode = 'person') {
    const active = this.getActiveEntity();
    if (mode === 'person' && active?.onFootway) return FOOTWAY_RISE;
    // In a pool's water (js/swimming.js), its own bottom: the steps' treads, or its floor, under the deck's level
    if (mode === 'person' && this.swim) {
      const bottom = this.swim.bottomUnder(x, z);
      if (bottom !== null) return bottom;
    }
    if ((mode === 'person' || mode === 'cyclist') && !active?.surface) return this.standingOver(x, z);
    return 0.0;
  }

  /**
   * The top of what's drawn on the ground at (x, z), over the ground there (js/drawn-ground.js): the paving, a lawn, a garden's path, a
   * strip's footpath, a driveway, the sand. Where it isn't known yet, the paving's height on a kerb's island and the road's off it; on a
   * model's floor, the floor's own (the ground's, js/surfaces.js).
   */
  standingOver(x, z) {
    if (onFloor(x, z)) return 0.0;
    const over = drawnOver(x, z);
    if (over !== null) return over;
    return this.isPointOnSidewalk(x, z) ? CITY_BOUNDS.sidewalkHeight : 0.0;
  }

  /**
   * The bike stood on what's drawn under its two wheels, off a deck: each wheel's height over the ground eased towards the top of what's
   * under it, as the walker's step is (KERB_EASE), so it climbs a kerb front wheel first and then the rear; its middle between the two,
   * pitched to them. `dt` 0 puts it there at once. On a deck it's the deck's (js/main.js standOnSurfaces()).
   */
  standBike(b, dt = 0) {
    if (b.surface) {
      b.wheelOver = null;
      b.pitch = null;
      b.position.y = 0.0;
      return;
    }
    const sin = Math.sin(b.heading), cos = Math.cos(b.heading);
    const ease = dt > 0 && b.wheelOver ? 1 - Math.exp(-dt * KERB_EASE) : 1;
    b.wheelOver ||= [0, 0];
    const tops = [0, 0];
    for (let i = 0; i < 2; i++) {
      const along = i === 0 ? BIKE_AXLE : -BIKE_AXLE;
      const x = b.position.x + sin * along, z = b.position.z + cos * along;
      const want = this.standingOver(x, z);
      b.wheelOver[i] += (want - b.wheelOver[i]) * ease;
      if (Math.abs(want - b.wheelOver[i]) < 1e-3) b.wheelOver[i] = want;
      tops[i] = groundHeight(x, z) + b.wheelOver[i];
    }
    b.pitch = Math.atan2(tops[0] - tops[1], BIKE_AXLE * 2);
    b.position.y = (tops[0] + tops[1]) / 2 - groundHeight(b.position.x, b.position.z);
    // Pitched now, for the rider posed from its frame this frame (poseCharacters())
    if (b.mesh) {
      b.mesh.rotation.order = 'YXZ';
      b.mesh.rotation.x = -b.pitch;
    }
  }

  /** Sits the person down on a seat: { x, z, heading, seatY (over the floor), stand: { x, z } } in the world's frame */
  sitAt(seat) {
    const p = this.entities.person;
    if (this.activeMode !== 'person') return false;
    p.seat = seat;
    p.position.set(seat.x, 0, seat.z);
    p.position.landed = { x: seat.x, z: seat.z };
    p.heading = seat.heading;
    p.speed = 0;
    p.verticalVel = 0;
    p.jumping = false;
    p.jumpPrep = 0;
    p.heldBack = null;
    return true;
  }

  /** Up off a seat, onto the floor in front of it */
  standUp() {
    const p = this.entities.person;
    const seat = p.seat;
    if (!seat) return false;
    p.seat = null;
    p.position.set(seat.stand.x, 0, seat.stand.z);
    p.position.landed = { x: seat.stand.x, z: seat.stand.z };
    return true;
  }

  // Collision arrives with each stage of the city
  addColliders(colliders) {
    for (const c of colliders) {
      this.colliders.push(c);
      if (this._colliderCells) this._indexCollider(c, this._nextOrder++);
    }
  }

  // ...and goes with it. `colliders` keeps its order, so a building's place among them doesn't change what it hits first.
  removeColliders(colliders) {
    if (!colliders.length) return;
    const gone = new Set(colliders);
    let n = 0;
    for (const c of this.colliders) if (!gone.has(c)) this.colliders[n++] = c;
    this.colliders.length = n;
    if (!this._colliderCells) return;
    for (const c of colliders) {
      for (let ix = Math.floor(c.minX / COLLIDER_CELL); ix <= Math.floor(c.maxX / COLLIDER_CELL); ix++) {
        for (let iz = Math.floor(c.minZ / COLLIDER_CELL); iz <= Math.floor(c.maxZ / COLLIDER_CELL); iz++) {
          const k = colliderKey(ix, iz);
          const list = this._colliderCells.get(k);
          if (!list) continue;
          const kept = list.filter((o) => !gone.has(o));
          if (kept.length) this._colliderCells.set(k, kept);
          else this._colliderCells.delete(k);
        }
      }
    }
  }

  _indexCollider(c, order) {
    c._order = order;
    for (let ix = Math.floor(c.minX / COLLIDER_CELL); ix <= Math.floor(c.maxX / COLLIDER_CELL); ix++) {
      for (let iz = Math.floor(c.minZ / COLLIDER_CELL); iz <= Math.floor(c.maxZ / COLLIDER_CELL); iz++) {
        const k = colliderKey(ix, iz);
        let list = this._colliderCells.get(k);
        if (!list) this._colliderCells.set(k, (list = []));
        list.push(c);
      }
    }
  }

  // Static colliders within `r` of (x, z), kept in their original order and indexed once into 48 m cells.
  nearColliders(x, z, r) {
    const CELL = COLLIDER_CELL;
    const key = colliderKey;
    if (!this._colliderCells) {
      this._colliderCells = new Map();
      this.colliders.forEach((c, i) => this._indexCollider(c, i));
      this._nextOrder = this.colliders.length;
      this._nearList = [];
      this._nearStamp = 0;
    }
    const out = this._nearList;
    out.length = 0;
    const stamp = ++this._nearStamp;
    for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) {
      for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
        const list = this._colliderCells.get(key(ix, iz));
        if (!list) continue;
        for (const c of list) {
          if (c._seen === stamp) continue;
          c._seen = stamp;
          out.push(c);
        }
      }
    }
    if (out.length > 1) out.sort((a, b) => a._order - b._order);
    return out;
  }

  // The top of the highest roof directly below altitude y, or 0 over open ground. Without this, sinking onto a building
  // reads as flying into its side: the horizontal collision throws the helicopter off the edge.
  roofHeightAt(x, z, y) {
    let top = 0;
    if (!this.colliders?.length) return top;
    for (const c of this.nearColliders(x, z, 1)) {
      if (x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) continue;
      const roof = colliderTop(c, x, z);
      if (!(roof <= y + 0.5) || roof <= top) continue;
      if (c.polygon && !polygonContains(c.polygon, x, z)) continue;
      if (c.obb) {
        const dx = x - c.obb.cx, dz = z - c.obb.cz;
        if (Math.abs(dx * c.obb.cs - dz * c.obb.sn) > c.obb.hx || Math.abs(dx * c.obb.sn + dz * c.obb.cs) > c.obb.hz) continue;
      }
      top = roof;
    }
    return top;
  }

  resolveHorizontalCollision(pos, radius, carEntity = null, entity = carEntity) {
    // The detailed land (the helicopter may roam out over the harbour and the suburbs)
    const heli = this.activeMode === 'helicopter';
    const m = heli ? 6000 : 0;
    pos.x = Math.max(CITY_BOUNDS.minX - m, Math.min(CITY_BOUNDS.maxX + m, pos.x));
    pos.z = Math.max(CITY_BOUNDS.minZ - m, Math.min(CITY_BOUNDS.maxZ + m, pos.z));
    if (!heli) {
      // Which surface is under the player now (js/surfaces.js moveOver()): the nearest road within a step of where they were.
      // Where every surface is out of reach (over a deck's edge, into a tunnel's wall), the move stops at the edge, and
      // slides along it as it would along a wall; pressed into a barrier, it's held back to its line.
      const active = this.getActiveEntity();
      const last = (pos.landed ??= { x: pos.x, z: pos.z });
      // Through a door off the footway (the Pylon Lookout's, js/model-sites.js): pressing on past the footway's edge onto a model's
      // floor puts you on that floor, the ground there (js/surfaces.js groundHeight()), where its walls and its door stop you; off the
      // floor again over the footway, you're back on the footway
      if (this.activeMode === 'person') {
        if (active.onFootway && onFloor(pos.x, pos.z)) {
          const held = holdOnFootway(pos.x, pos.z);
          if (held && Math.hypot(held.x - pos.x, held.z - pos.z) > 0.005) {
            active.onFootway = false;
            active.surface = 0;
            active.surfaceY = groundHeight(pos.x, pos.z);
          }
        } else if (!active.onFootway && !active.surface && onFloor(last.x, last.z) && !onFloor(pos.x, pos.z)) {
          const held = holdOnFootway(pos.x, pos.z);
          if (held && Math.abs(held.y - groundHeight(last.x, last.z)) < 1) active.onFootway = true;
        }
      }
      // Walking the Harbour Bridge's footway, between its railing and the barrier, from one railing across it to the other (its ends,
      // where it goes down stairs the game doesn't have). Put somewhere away from it, you're on the deck's nearest road.
      if (active.onFootway) {
        const held = holdOnFootway(pos.x, pos.z);
        if (held) {
          pos.x = last.x = held.x;
          pos.z = last.z = held.z;
          active.surface = DECK_SID;
          active.surfaceY = held.y;
          active.deck = true;
          return;
        }
        active.onFootway = false;
        const edge = structureAt(DECK_SID, last.x, last.z, 8);
        if (edge) {
          pos.x = last.x = edge.px;
          pos.z = last.z = edge.pz;
        }
      }
      const sid = active.surface || 0;
      const y = active.surfaceY ?? surfaceHeight(sid, last.x, last.z);
      // Kept its margin in from what holds it, and on the ground under a deck only where it fits under it
      const margin = carEntity ? 1.0 : radius * 0.6, room = carEntity ? ROOM.car : ROOM.foot;
      // A car driven into what holds it loses speed as squarely as it hit
      const here = moveOver(sid, y, last.x, last.z, pos.x, pos.z, margin, room);
      if (here.held && carEntity && carEntity.speed) {
        const moved = Math.hypot(pos.x - last.x, pos.z - last.z) || 1;
        // Not more for being moved out of a deck it was left inside (js/surfaces.js freeFromDeck()), further than it was going
        carEntity.speed *= 0.5 + 0.5 * Math.min(1, Math.hypot(here.x - last.x, here.z - last.z) / moved);
      }
      pos.x = here.x;
      pos.z = here.z;
      active.surface = here.sid;
      active.surfaceY = here.y;
      active.deck = onDeck(here.sid); // the Harbour Bridge, for the scripts that ask
      if (here.sid) {
        // On a structure nothing of the ground is in the way: not the water, not the buildings under it
        last.x = pos.x;
        last.z = pos.z;
        last.wet = false;
        return;
      }
      // ...nor on a model's floor (js/surfaces.js onFloor()), which its own walls bound: a jetty out over the water (js/model-sites.js),
      // but for its own pools (js/still-water.js modelWaterNear()), at whose edge its floor ends. Still water on land (js/still-water.js: ponds, fountains, lakes) holds the whole body at its shore, as the sea does: no move takes
      // it further in than it is where it was, turned as it is now, which is nowhere unless it turned there (a car steering while it's
      // held), so it can't get deeper by turning and moving in turn. One put in the water (`wet`: there before the water's tile was held)
      // isn't held by it till it's out, so it can walk or drive out.
      const mode = this.activeMode, heading = entity ? entity.heading : 0;
      last.wet ??= stillWaterDepth(mode, last.x, last.z, heading) > 0;
      const allowed = last.wet ? Infinity : stillWaterDepth(mode, last.x, last.z, heading);
      const dry = (x, z) => clearOfWater(x, z) && (last.wet || stillWaterDepth(mode, x, z, heading) <= allowed);
      // A pool to swim in (js/swimming.js letsIn()) lets a walker in: in the air over it, wading in it, or pushing straight at its edge
      if ((mode === 'person' && onFloor(pos.x, pos.z) && !modelWaterNear(pos.x, pos.z)) || dry(pos.x, pos.z)
        || (mode === 'person' && this.swim?.letsIn(active, last, pos))) {
        last.x = pos.x;
        last.z = pos.z;
      } else {
        // Slide along the shore where only one axis would reach the water; at still water whose shore runs at a slant to both axes, along
        // the shore itself (the part of the move along its nearest edge). Where it slid to is clear: the next step starts from there
        const along = shoreAlong(mode, last.x, last.z, heading);
        const k = along ? (pos.x - last.x) * along.x + (pos.z - last.z) * along.z : 0;
        if (dry(pos.x, last.z)) pos.z = last.z;
        else if (dry(last.x, pos.z)) pos.x = last.x;
        else if (along && dry(last.x + along.x * k, last.z + along.z * k)) {
          pos.x = last.x + along.x * k;
          pos.z = last.z + along.z * k;
        } else { pos.x = last.x; pos.z = last.z; }
        last.x = pos.x;
        last.z = pos.z;
        if (carEntity && carEntity.speed) carEntity.speed *= 0.4;
      }
      if (last.wet) last.wet = stillWaterDepth(mode, last.x, last.z, heading) > 0;
    }

    const body = collisionBody(this.activeMode, radius, carEntity ? carEntity.heading : 0);
    const { sin: sinH, cos: cosH, extX, extZ } = body;
    const contact = this._buildingContact ??= { nx: 0, nz: 0, depth: 0 };

    const reach = Math.max(extX, extZ) + 6;
    let gx = pos.x;
    let gz = pos.z;
    let near = this.nearColliders(gx, gz, reach);
    for (let i = 0; i < near.length; i++) {
      const c = near[i];
      if (buildingContact(c, pos.x, pos.y, pos.z, body, contact)) {
        const { nx, nz, depth } = contact;
        pos.x += nx * depth;
        pos.z += nz * depth;

        if (this._collisionListener && entity && entity.type !== 'person') {
          const sin = carEntity ? sinH : Math.sin(entity.heading);
          const cos = carEntity ? cosH : Math.cos(entity.heading);
          const approachSpeed = -((sin * entity.speed + (entity.vx || 0)) * nx + (cos * entity.speed + (entity.vz || 0)) * nz);
          const support = carEntity ? Math.abs(nx * cos - nz * sin) * 0.86 + Math.abs(nx * sin + nz * cos) * 2.18 : radius;
          this.reportCollision(entity, c, 'building', pos.x - nx * support, pos.y + (heli ? 1.1 : 0.56), pos.z - nz * support,
            nx, 0, nz, approachSpeed);
        }

        if (carEntity) {
          const totalVx = sinH * carEntity.speed + (carEntity.vx || 0);
          const totalVz = cosH * carEntity.speed + (carEntity.vz || 0);
          const vn = -(totalVx * nx + totalVz * nz);
          if (vn > 0.5) {
            const headOn = Math.abs(sinH * nx + cosH * nz);
            const sideDot = cosH * nx - sinH * nz;
            carEntity.vx = (carEntity.vx || 0) + nx * vn * 0.42;
            carEntity.vz = (carEntity.vz || 0) + nz * vn * 0.42;
            if (headOn > 0.72) {
              carEntity.speed = -carEntity.speed * 0.25;
            } else {
              carEntity.speed *= (1.0 - 0.62 * headOn);
              carEntity.angularVel = (carEntity.angularVel || 0) + sideDot * (sinH * nx + cosH * nz >= 0 ? -1 : 1) * Math.min(3.2, vn * 0.22);
            }
            carEntity.pitchVel = (carEntity.pitchVel || 0) + (sinH * nx + cosH * nz) * Math.min(14.0, vn) * 0.16;
            carEntity.rollVel = (carEntity.rollVel || 0) - sideDot * Math.min(14.0, vn) * 0.22;
            carEntity.heaveVel = (carEntity.heaveVel || 0) + Math.min(1.4, vn * 0.11);
            if (vn > 2.2) {
              carEntity.lastCollisionSpark = {
                x: pos.x - nx * extX * 0.92,
                y: 0.56,
                z: pos.z - nz * extZ * 0.92,
                nx,
                nz,
                speed: vn
              };
            }
          }
        }

        // A push that carried it far from where the candidates were gathered (dropped inside a building): gather
        // them again around where it is now, carrying on in the same order
        if (Math.abs(pos.x - gx) > 5 || Math.abs(pos.z - gz) > 5) {
          gx = pos.x;
          gz = pos.z;
          const order = c._order;
          near = this.nearColliders(gx, gz, reach);
          i = -1;
          while (i + 1 < near.length && near[i + 1]._order <= order) i++;
        }
      }
    }
    // The walker against the fences: twice, for a corner where two meet
    if (this.activeMode === 'person' && !entity) {
      const fences = this.nearWalkerColliders(pos.x, pos.z, reach);
      for (let pass = 0; pass < 2 && fences.length; pass++) {
        for (const c of fences) {
          if (!buildingContact(c, pos.x, pos.y, pos.z, body, contact)) continue;
          pos.x += contact.nx * contact.depth;
          pos.z += contact.nz * contact.depth;
        }
      }
    }
  }

  // Pose the skinned characters once every entity has moved: the pedestrian's rig walks (or runs, turns, jumps) it to
  // where it now is, planting its feet on the ground; the cyclist sits on the bike, hands on the grips, feet on the
  // pedals, helmet on its head. Only the one you are is drawn: a bike left standing is empty
  poseCharacters(dt) {
    const p = this.entities.person;
    if (p) {
      if (this.activeMode === 'person') {
        p._charHidden = false;
        if (p.mesh) p.mesh.visible = true;
        const groundY = this.getGroundHeight(p.position.x, p.position.z, 'person');
        const air = p.position.y - groundY;
        // The rig is told of the crouch before a jump (as a negative share of it, -1 at take-off), the height in a jump or a fall, and
        // nothing stepping up or down a kerb, which its feet step over
        const rigAir = p.jumping ? Math.max(0.006, air) : p.jumpPrep > 0 ? -(1 - p.jumpPrep / JUMP_CROUCH) : air > FALLING ? air : 0;
        // The shadow stays on what you stand on, smaller the higher you are
        if (p.shadow) {
          p.shadow.position.y = groundY - p.position.y + 0.02;
          const size = Math.max(0.45, 1 - Math.max(0, rigAir) * 0.35);
          p.shadow.scale.set(size, 1, size);
        }
        // In the water or diving into it, the swimmer's poses (js/swimming.js); out of it, eased back into the walk
        const sw = this.swim;
        if (p.shadow) p.shadow.visible = !p.swim && !p.dive?.launched;
        if (sw && p.swim) sw.pose(p, dt);
        else if (sw && p.dive?.launched) sw.poseDive(p, dt);
        else if (p.seat) p.rig.sit(p.seat.x, p.seat.z, p.seat.heading, p.seat.seatY);
        else {
          // Carried by a floor that moves (an escalator), the rig goes with it, feet and all: it walks only as you do. (Its heights are
          // over the ground, the floor here, which carries them up or down with it)
          const c = p.carriedStep;
          if (c && p.rig.carry) p.rig.carry(c.x, 0, c.z);
          p.rig.update(dt, p.position.x, p.position.z, p.heading, personGround, this, rigAir);
          sw?.applyBlend(p, dt);
        }
        p.crowd.begin();
        // On whatever it stands on: the ground, or a deck (the simulation is flat, js/surfaces.js)
        p.crowd.add(p.rig, 0, surfaceHeight(p.surface || 0, p.position.x, p.position.z, p.surfaceY ?? null));
        p.crowd.end();
      } else if (!p._charHidden) {
        p.rig.placed = false;
        p.crowd.begin();
        p.crowd.end();
        if (p.crowd.updates > 2) {
          if (p.mesh) p.mesh.visible = false;
          p._charHidden = true;
        }
      }
    }

    const b = this.entities.cyclist;
    if (b) {
      if (this.activeMode === 'cyclist') {
        if (b.helmet) b.helmet.visible = true;
        b._riderHidden = false;
        // Posed from the bike as the simulation has it, flat, then stood on the bike's surface as the bike itself is drawn.
        // Before, the crowd stood the rider on the ground at (0, 0), 22.5 m whatever the bike was on.
        const base = surfaceHeight(b.surface || 0, b.position.x, b.position.z, b.surfaceY ?? null);
        b.riderRig.ride(b.leanPivot, b.pedalPhase, b.bikeFrame);
        b.riderCrowd.begin();
        b.riderCrowd.add(b.riderRig, 0, base);
        b.riderCrowd.end();
        b.helmet.quaternion.copy(b.riderRig.headQuaternion);
        b.helmet.position.set(0, 0.175, -0.012).applyQuaternion(b.helmet.quaternion).add(b.riderRig.headPosition);
        b.helmet.position.y += base;
      } else if (!b._riderHidden) {
        b.riderCrowd.begin();
        b.riderCrowd.end();
        if (b.riderCrowd.updates > 2) {
          if (b.helmet) b.helmet.visible = false;
          b._riderHidden = true;
        }
      }
    }
  }

  update(dt, elapsed) {
    const heli = this.entities.helicopter;
    heli.mainRotorPivot.rotation.y += dt * 24.0;
    heli.tailRotorPivot.rotation.x += dt * 32.0;

    if (this.activeMode === 'person') this.updatePerson(dt, elapsed);

    if (this.activeMode === 'car') {
      this.updateCar(dt, elapsed);
    } else if (this.activeMode === 'cyclist') {
      this.updateCyclist(dt, elapsed);
    } else if (this.activeMode === 'helicopter') {
      this.updateHelicopter(dt, elapsed);
    }
    this.tickParked(dt);
    // A bike left somewhere stands on what's drawn there, which can come in after it was left (a nature strip near you)
    const parkedBike = this.entities.cyclist;
    if (parkedBike?._parked && parkedBike._shown !== false && this.activeMode !== 'cyclist') this.standBike(parkedBike);

    for (const key of Object.keys(this.entities)) {
      const e = this.entities[key];
      e.mesh.position.copy(e.position);
      e.mesh.rotation.y = e.heading;
    }

    // Modulate clustered vehicle & bike lights by time of day (off during Midday & Golden Hour; fade in at Dusk & Night)
    const glow = cityUniforms && cityUniforms.uInteriorGlow ? cityUniforms.uInteriorGlow.value : 0.48;
    const beamScale = Math.min(1.28, Math.max(0.0, (glow - 0.60) * 1.45));
    const car = this.entities.car;
    if (car.headLights) {
      for (const spot of car.headLights) {
        // Accelerating does not change the headlamp output or range.
        spot.intensity = this.activeMode === 'car' ? HEADLIGHTS.intensity * beamScale : 0;
      }
    }
    const bike = this.entities.cyclist;
    if (bike.headLight) {
      const bikeActive = this.activeMode === 'cyclist';
      bike.headLight.intensity = bikeActive ? 115 * beamScale : 0;
    }

    this.updateVisibility();
    this.poseCharacters(dt);
  }

  /**
   * Steering towards the view, from -1 (right) to 1 (left), or 0 when it doesn't apply: forward held, no steering or reversing
   * of your own, and the camera turned round further than DONE (and no further than `reach`). `rate` is how fast the entity is
   * already turning (rad/s), for a car whose yaw lags its wheels. Marks the entity as following the view, for the camera.
   */
  steerToView(entity, gain = VIEW.gain, reach = Infinity, rate = 0, damping = 0) {
    entity.followingView = false;
    const off = this.viewOffset;
    const k = this.keys;
    if (off === null || off === undefined || !(k.forward > 0.1) || k.backward || k.left > 0.05 || k.right > 0.05) return 0;
    // There, and no longer turning: a car's yaw runs on after its wheels straighten
    if ((Math.abs(off) < VIEW.done && Math.abs(rate) < VIEW.settled) || Math.abs(off) > reach) return 0;
    entity.followingView = true;
    return Math.max(-1, Math.min(1, off * gain - rate * damping));
  }

  updatePerson(dt) {
    const p = this.entities.person;
    p.carried = p.carriedStep = null; // a floor that moves under you: worked out with your step below
    const pace = this.indoors ? ON_FOOT.inside : ON_FOOT.outside;
    const turnRate = pace.turn;
    const k = this.keys;
    // In first person, where you look is where you face: the mouse's turn since the last step (seated too: you look round from the seat)
    if (this.firstPerson) p.heading -= this.lookTurn;
    this.lookTurn = 0;
    if (p.seat) {
      // Seated: where the seat is, until you move, or jump
      if (!(k.forward || k.backward || k.left || k.right || k.sideLeft || k.sideRight || this.jumpQueued > 0)) {
        p.speed = 0;
        p.sideSpeed = 0;
        this.jumpQueued = 0;
        return;
      }
      this.jumpQueued = 0;
      this.standUp();
      this.onStand?.();
    }
    // In a pool's water, or diving into it (js/swimming.js): its own step. Beside one: down a ladder, or a jump at its edge to dive
    const sw = this.swim;
    if (p.swim || p.dive?.launched) {
      if (!sw) p.swim = p.dive = null;
      else if (p.swim) sw.swimStep(this, p, dt);
      else sw.diveStep(this, p, dt);
      return;
    }
    const pool = sw?.beforeWalk(this, p);
    if (pool?.done) return;

    // A key held is a walk, or a run with Shift; a stick walks slower short of STICK_WALK, and runs pushed nearly all the way out.
    // Back, or aside, at ASIDE of that; forward and aside together no faster than the faster of the two.
    const paceOf = (held) => (k.run ? pace.run : pace.walk * (held === true ? 1 : Math.min(1, held / STICK_WALK)));
    let targetSpeed = 0;
    if (k.forward) targetSpeed = paceOf(k.forward);
    else if (k.backward) targetSpeed = -paceOf(k.backward) * ASIDE;
    let targetSide = 0;
    if (k.sideLeft) targetSide += paceOf(k.sideLeft) * ASIDE;
    if (k.sideRight) targetSide -= paceOf(k.sideRight) * ASIDE;
    const both = Math.hypot(targetSpeed, targetSide), cap = Math.max(Math.abs(targetSpeed), Math.abs(targetSide));
    if (both > cap) {
      targetSpeed *= cap / both;
      targetSide *= cap / both;
    }
    // Wading, slower
    if (pool?.pace) {
      targetSpeed *= pool.pace;
      targetSide *= pool.pace;
    }

    if (k.left) p.heading += turnRate * dt * k.left;
    if (k.right) p.heading -= turnRate * dt * k.right;
    // Turning to a camera that's been dragged round: not in first person, where the view is your heading
    if (this.firstPerson) p.followingView = false;
    else p.heading += turnRate * dt * this.steerToView(p);

    // Up to a walk in about half a second, to a run in a second
    const towards = (speed, target) => {
      const accelerating = Math.abs(target) > Math.abs(speed) && speed * target >= 0;
      const acceleration = accelerating ? 2 + 3.5 * Math.abs(target) / pace.run : 12;
      return speed + Math.max(-acceleration * dt, Math.min(acceleration * dt, target - speed));
    };
    // Held back by a wall last step, you keep your pace while you push on, and slide along it as before; let go or turn back, and you
    // start from what you actually moved, not the pace you were pushing at, so you come away from it at once
    const held = p.heldBack;
    p.heldBack = null;
    if (held) {
      const pushing = (speed, target) => target * speed > 0 && Math.abs(target) >= Math.abs(speed);
      const moved = (speed, actual) => (speed > 0 ? Math.min(speed, Math.max(0, actual)) : Math.max(speed, Math.min(0, actual)));
      if (!pushing(p.speed, targetSpeed)) p.speed = moved(p.speed, held.forward);
      if (!pushing(p.sideSpeed || 0, targetSide)) p.sideSpeed = moved(p.sideSpeed || 0, held.aside);
    }
    p.speed = towards(p.speed, targetSpeed);
    p.sideSpeed = towards(p.sideSpeed || 0, targetSide);

    // Forward along the heading, and aside to its left (+) or right; and carried by a floor that moves under your feet (an escalator's
    // steps: a model's floor with a `flow`), standing or walking on it
    const sin = Math.sin(p.heading), cos = Math.cos(p.heading);
    const fromX = p.position.x, fromZ = p.position.z;
    const flow = p.jumping || p.surface ? null : floorFlow(fromX, fromZ);
    p.carried = flow;
    p.carriedStep = flow ? { x: flow.x * dt, z: flow.z * dt } : null;
    const toX = fromX + (sin * p.speed + cos * p.sideSpeed) * dt + (flow ? flow.x * dt : 0);
    const toZ = fromZ + (cos * p.speed - sin * p.sideSpeed) * dt + (flow ? flow.z * dt : 0);
    p.position.x = toX;
    p.position.z = toZ;
    // Through a house's doorways, between its furniture and up its stair: inside, or on a model's floors, the walker is narrower
    this.resolveHorizontalCollision(p.position, this.indoors || onFloor(p.position.x, p.position.z) ? WALKER : 0.48);
    // Wading on a pool's steps, its walls hold you in but where it's a step up out of it
    sw?.holdWader(p, fromX, fromZ);
    // Held back by a wall, a fence, the shore or a railing: what you moved, forward and aside, for the next step (above). Held square on,
    // where nothing moves, the speed comes down to it now. Further round you slide along at your pace: a cut every frame there (cos² of the
    // speed at a slant) would leave you crawling along a wall you used to slide along, or steer round
    const wantX = toX - fromX, wantZ = toZ - fromZ, want = Math.hypot(wantX, wantZ);
    if (want > 1e-9 && (Math.abs(p.position.x - toX) > 1e-6 || Math.abs(p.position.z - toZ) > 1e-6)) {
      const movedX = p.position.x - fromX, movedZ = p.position.z - fromZ, moved = Math.hypot(movedX, movedZ);
      p.heldBack = { forward: (movedX * sin + movedZ * cos) / dt, aside: (movedX * cos - movedZ * sin) / dt };
      // The cosine of the turn the wall made in the move, from where you meant to go
      const along = moved > 1e-9 ? (movedX * wantX + movedZ * wantZ) / (moved * want) : 0;
      if (along < HEAD_ON) {
        const kept = along <= 0 ? 0 : moved / (want * HEAD_ON);
        p.speed *= kept;
        p.sideSpeed *= kept;
      }
    }

    const groundY = this.getGroundHeight(p.position.x, p.position.z, 'person');
    const ease = 1 - Math.exp(-dt * KERB_EASE);
    // A press, or one the queue's held over, crouches first, and takes off from the crouch
    if ((this.keys.up || this.jumpQueued > 0) && p.position.y <= groundY + 0.02 && !p.jumping && !(p.jumpPrep > 0)) {
      p.jumpPrep = JUMP_CROUCH;
      this.jumpQueued = 0;
    }
    this.jumpQueued = Math.max(0, this.jumpQueued - dt); // game time, so a hitch can't use it up
    if (p.jumpPrep > 0) {
      p.jumpPrep = Math.max(0, p.jumpPrep - dt);
      p.position.y += (groundY - p.position.y) * ease;
      if (Math.abs(groundY - p.position.y) < 1e-3) p.position.y = groundY;
      if (p.jumpPrep === 0) {
        p.verticalVel = 5.2;
        p.jumping = true;
      }
    }
    if (p.jumping || p.position.y > groundY + FALLING) {
      // In the air, from a jump or off something higher than a kerb
      if (p.position.y > groundY + FALLING) {
        p.jumping = true;
        p.jumpPrep = 0;
      }
      p.verticalVel -= 14.5 * dt;
      p.position.y += p.verticalVel * dt;
      if (p.position.y <= groundY) {
        p.position.y = groundY;
        p.verticalVel = 0;
        p.jumping = false;
      }
    } else if (!(p.jumpPrep > 0)) {
      // Up or down a kerb, or onto the footway: eased, as the feet step it, rather than a fall onto the road
      p.position.y += (groundY - p.position.y) * ease;
      if (Math.abs(groundY - p.position.y) < 1e-3) p.position.y = groundY;
      p.verticalVel = 0;
      p.jumping = false;
    }
    // A dive taking off, and into a pool's water once in it deep enough to swim
    sw?.afterWalk(this, p, dt);
  }

  updateCar(dt) {
    if (dt <= 0) return;
    const c = this.entities.car;

    let throttle = 0;
    if (this.keys.forward) throttle = this.keys.forward;
    else if (this.keys.backward) throttle = -this.keys.backward;

    const braking = c.speed * throttle < 0;

    let steerInput = 0;
    if (this.keys.left) steerInput = this.keys.left;
    if (this.keys.right) steerInput = -this.keys.right;
    if (!steerInput && c.speed > 0) steerInput = this.steerToView(c, VIEW.carGain, VIEW.carReach, c.angularVel, VIEW.carDamping);
    else c.followingView = false;

    const prevX = c.position.x;
    const prevZ = c.position.z;
    c.prevX = prevX;
    c.prevZ = prevZ;
    // Short steps keep grip, impacts and suspension consistent at different display rates.
    const steps = Math.ceil(dt * 120);
    const step = dt / steps;
    const steerResponse = 1 - Math.exp(-10 * step);
    const yawResponse = 1 - Math.exp(-5 * step);
    const tireResponse = 1 - Math.exp(-4 * step);
    for (let i = 0; i < steps; i++) {
      const sin = Math.sin(c.heading), cos = Math.cos(c.heading);
      const vx = sin * c.speed + c.vx, vz = cos * c.speed + c.vz;
      const forward = vx * sin + vz * cos;
      const sideways = vx * cos - vz * sin;
      const speed = driveSpeed(forward, throttle, step, CAR_DRIVE);
      const acceleration = (speed - forward) / step;
      // Braking and cornering share tire grip; air resistance does not use it.
      const tireAcceleration = acceleration + CAR_DRIVE.drag * forward * Math.abs(forward);
      const grip = Math.sqrt(Math.max(0, CAR_DRIVE.grip ** 2 - tireAcceleration ** 2));
      // A handbrake slide preserves steering while reducing lateral grip; fade it out at low speed.
      const handbrake = forward * throttle < 0 ? Math.abs(throttle) * Math.min(1, Math.abs(forward) / 5) : 0;
      const lateralGrip = grip * (1 - 0.7 * handbrake);
      const steeringGrip = grip + (CAR_DRIVE.grip - grip) * handbrake;

      // Full lock at parking speeds, progressively less steering at road speeds.
      const turn = CAR_DRIVE.wheelbase * CAR_DRIVE.cornering;
      const maxSteer = Math.atan(turn / Math.max(speed * speed, turn / Math.tan(0.60)));
      c.steerAngle += (steerInput * maxSteer - c.steerAngle) * steerResponse;
      const yawLimit = steeringGrip / Math.max(2, Math.abs(speed));
      const targetYaw = Math.max(-yawLimit, Math.min(yawLimit, speed * Math.tan(c.steerAngle) / CAR_DRIVE.wheelbase));
      // Collision spin remains part of the yaw velocity; the tires gradually regain control.
      const yawStep = steeringGrip * 0.65 * step;
      c.angularVel += Math.max(-yawStep, Math.min(yawStep, (targetYaw - c.angularVel) * yawResponse));
      c.heading += c.angularVel * step;

      // Turning the chassis must not instantly rotate its momentum. Tires remove sideways slip
      // with a bounded force; longitudinal momentum, including impacts, stays in speed.
      const nextSin = Math.sin(c.heading), nextCos = Math.cos(c.heading);
      const worldX = sin * speed + cos * sideways;
      const worldZ = cos * speed - sin * sideways;
      c.speed = worldX * nextSin + worldZ * nextCos;
      const slip = worldX * nextCos - worldZ * nextSin;
      const correction = Math.max(-lateralGrip * step, Math.min(lateralGrip * step, -slip * tireResponse));
      c.vx = nextCos * (slip + correction);
      c.vz = -nextSin * (slip + correction);
      c.position.x += (nextSin * c.speed + c.vx) * step;
      c.position.z += (nextCos * c.speed + c.vz) * step;
      this.resolveHorizontalCollision(c.position, 1.35, c);

      const targetPitch = -Math.max(-1, Math.min(1, acceleration / CAR_DRIVE.acceleration)) * 0.026;
      const targetRoll = Math.max(-0.09, Math.min(0.09, correction / step * 0.012));
      c.pitchVel += ((targetPitch - c.chassisPivot.rotation.x) * 68 - c.pitchVel * 11.2) * step;
      c.rollVel += ((targetRoll - c.chassisPivot.rotation.z) * 68 - c.rollVel * 11.2) * step;
      c.chassisPivot.rotation.x = Math.max(-0.22, Math.min(0.22, c.chassisPivot.rotation.x + c.pitchVel * step));
      c.chassisPivot.rotation.z = Math.max(-0.26, Math.min(0.26, c.chassisPivot.rotation.z + c.rollVel * step));
      c.heaveVel += (-c.heaveY * 85 - c.heaveVel * 12) * step;
      c.heaveY = Math.max(-0.08, Math.min(0.14, c.heaveY + c.heaveVel * step));
    }
    c.position.y = this.getGroundHeight(c.position.x, c.position.z, 'car');
    c.chassisPivot.position.y = c.heaveY;

    if (c.carState) {
      c.carState.value.x = braking ? 1 : 0;
      c.carState.value.w = c.speed < -0.2 ? 1 : 0;
    }

    const forwardDist = (c.position.x - prevX) * Math.sin(c.heading) + (c.position.z - prevZ) * Math.cos(c.heading);
    const rawWheelStep = forwardDist / 0.35;
    const wheelStep = Math.sign(rawWheelStep) * Math.min(Math.abs(rawWheelStep), 0.48);
    c.wheelSpin = (c.wheelSpin + wheelStep) % (Math.PI * 2);
    for (const w of c.wheels) {
      w.tire.rotation.x = c.wheelSpin + (w.isFront ? 0.0 : 0.55);
      if (w.isFront) {
        w.steerPivot.rotation.y = c.steerAngle;
      }
    }
  }

  updateCyclist(dt) {
    if (dt <= 0) return;
    const b = this.entities.cyclist;

    // Space (up) brakes while moving forward, and never backs the bike up. S brakes as hard while moving forward, and backs up
    // gently (0.6 of its strength) from a standstill.
    const handbrake = b.speed > 0 ? +this.keys.up : 0;
    let throttle = 0;
    if (handbrake) throttle = -handbrake;
    else if (this.keys.forward) throttle = +this.keys.forward;
    else if (this.keys.backward) throttle = b.speed > 0 ? -this.keys.backward : -0.6 * this.keys.backward;

    // Braked to a stop with S, it waits a moment at zero, so holding S stops cleanly before it backs up
    if (b.speed > 0 && throttle < 0) {
      b.speed = driveSpeed(b.speed, throttle, dt, BICYCLE_DRIVE);
      if (b.speed < 0.05) {
        b.speed = 0;
        if (!handbrake) b._brakeHold = BRAKE_HOLD;
      }
    } else if (!handbrake && b._brakeHold > 0 && throttle < 0) {
      b._brakeHold = Math.max(0, b._brakeHold - dt);
      b.speed = 0;
    } else {
      b._brakeHold = 0;
      b.speed = driveSpeed(b.speed, throttle, dt, BICYCLE_DRIVE);
    }

    let turnInput = 0;
    if (this.keys.left) turnInput = this.keys.left;
    if (this.keys.right) turnInput = -this.keys.right;
    if (!turnInput) turnInput = this.steerToView(b);

    if (Math.abs(b.speed) > 0.15) {
      const dirSign = b.speed >= 0 ? 1 : -1;
      b.heading += turnInput * 2.15 * dirSign * dt;
    }

    const prevX = b.position.x, prevZ = b.position.z;
    const sinH = Math.sin(b.heading), cosH = Math.cos(b.heading);
    const nextX = prevX + sinH * b.speed * dt, nextZ = prevZ + cosH * b.speed * dt;
    b.position.x = nextX;
    b.position.z = nextZ;
    this.resolveHorizontalCollision(b.position, 0.65, null, b);
    // Held back (a wall, the shore, a deck's edge): its speed comes down to what it actually moved, so it doesn't build up
    // against the wall and braking or backing away works at once
    if (Math.abs(b.position.x - nextX) > 1e-6 || Math.abs(b.position.z - nextZ) > 1e-6) {
      const moved = ((b.position.x - prevX) * sinH + (b.position.z - prevZ) * cosH) / dt;
      if (b.speed > 0 && moved < b.speed) b.speed = Math.max(0, moved);
      else if (b.speed < 0 && moved > b.speed) b.speed = Math.min(0, moved);
    }
    this.standBike(b, dt);

    const targetLean = -turnInput * Math.min(1.0, Math.abs(b.speed) / 9.0) * 0.34;
    b.leanAngle += (targetLean - b.leanAngle) * Math.min(1, dt * 9);
    b.leanPivot.rotation.z = b.leanAngle;

    const wheelDelta = (b.speed / 0.35) * dt;
    b.frontWheel.rotation.x += wheelDelta;
    b.rearWheel.rotation.x += wheelDelta;

    // The cranks turn with the rear wheel through the gears while pedalling (~110 rpm at cruising speed) and
    // freewheel otherwise; the rider's feet follow the pedals (see poseCharacters)
    if (throttle > 0 && wheelDelta > 0) b.pedalPhase += wheelDelta / 3.2;
    b.crankPivot.rotation.x = b.pedalPhase;
    for (const pedal of b.pedals) pedal.rotation.x = -b.pedalPhase;
  }

  updateHelicopter(dt, elapsed) {
    const h = this.entities.helicopter;
    const maxHorizSpeed = 52.0;
    const maxVertSpeed = 16.0;

    let fwdInput = 0;
    if (this.keys.forward) fwdInput = this.keys.forward;
    else if (this.keys.backward) fwdInput = -this.keys.backward;

    let yawInput = 0;
    if (this.keys.left) yawInput = this.keys.left;
    if (this.keys.right) yawInput = -this.keys.right;
    if (!yawInput) yawInput = this.steerToView(h);

    let vertInput = 0;
    if (this.keys.up) vertInput = this.keys.up;
    else if (this.keys.down) vertInput = -this.keys.down;

    if (fwdInput !== 0) {
      h.speed += fwdInput * 24.0 * dt;
      h.speed = Math.max(-maxHorizSpeed * 0.6, Math.min(maxHorizSpeed, h.speed));
    } else {
      h.speed *= Math.max(0, 1 - dt * 1.8);
    }

    if (vertInput !== 0) {
      h.verticalSpeed += vertInput * 22.0 * dt;
      h.verticalSpeed = Math.max(-maxVertSpeed, Math.min(maxVertSpeed, h.verticalSpeed));
    } else {
      h.verticalSpeed *= Math.max(0, 1 - dt * 3.5);
    }

    h.heading += yawInput * 1.45 * dt;

    h.position.x += Math.sin(h.heading) * h.speed * dt;
    h.position.z += Math.cos(h.heading) * h.speed * dt;
    const floor = this.roofHeightAt(h.position.x, h.position.z, h.position.y) + 0.25; // its skids rest on the roof
    h.position.y += h.verticalSpeed * dt;

    if (h.position.y < floor) {
      this.reportCollision(h, groundCollider, 'ground', h.position.x, floor, h.position.z, 0, 1, 0, -h.verticalSpeed);
      h.verticalSpeed = Math.max(0, h.verticalSpeed);
    }
    h.position.y = Math.max(floor, Math.min(380, h.position.y));
    this.resolveHorizontalCollision(h.position, 4.5, null, h);

    const targetPitch = (h.speed / maxHorizSpeed) * 0.24;
    const targetRoll = -yawInput * 0.28;
    h.pitchAngle += (targetPitch - h.pitchAngle) * Math.min(1, dt * 5);
    h.rollAngle += (targetRoll - h.rollAngle) * Math.min(1, dt * 5);

    h.tiltPivot.rotation.x = h.pitchAngle;
    h.tiltPivot.rotation.z = h.rollAngle;
    h.tiltPivot.position.y = Math.sin(elapsed * 2.6) * 0.18;
  }
}

export { ThirdPersonControllerManager };
