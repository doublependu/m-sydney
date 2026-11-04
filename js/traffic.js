import * as THREE from 'three/webgpu';
import { buildRoadNetworkSteps } from './road-network.js';
import { createPedestrianSystem } from './pedestrian-system.js';
import { vehicleContact, resolveVehicleContact, sweptVehicleContact } from './vehicle-physics.js';
import { DRIVE_SIDE } from './city-config.js';
import { assignLights, junctionKey } from './signals.js';
import { ROAD_CLASS, edgeHeight, sameLevel, surfaceHeight } from './surfaces.js';
import { busyAt, placeAt, placesNear } from './places.js';
import { GEO } from './geodata.js';
import { cityUniforms, createContactShadowMaterial } from './tsl-materials.js';
import { HEADLIGHTS, placeVehicleHeadlight } from './vehicle-lights.js';
import { anchorToOrigin, onOriginMove, origin } from './world-origin.js';
import {
  BODY_SPECS,
  buildCarGeometry,
  buildCarProxyGeometry,
  buildSteerableWheelGeo,
  createCarWheelMaterial,
  createLoftedCarMaterial,
  carStyleCode,
  buildLightbarGeometry,
  createLightbarMaterial
} from './cars.js';
import {
  BUS_SPEC,
  buildLoftedBusBodyGeometry,
  buildBusSignGeometry,
  buildBusWheelGeo,
  createBusWheelMaterial,
  createLoftedBusMaterial
} from './bus.js';

// Cars and buses follow the road graph, obey signals, yield at crossings and react to collisions.
// Vehicles replenish around the player; pedestrian-system.js manages the nearby walking population.

const NUM_CARS = 200;
const NUM_BUSES = 12;

// Intelligent Driver Model: max acceleration, comfortable braking, time headway, standstill gap; the sideways
// acceleration drivers accept in bends, which sets how fast they take each turn or lane shift; and how hard they brake
// in an emergency. At the wheel (see steer): the sideways acceleration the tyres grip up to, how far the front wheels
// turn (radians), and how fast the driver turns them at speed (rad/s, ~250°/s at the steering wheel; up to three times
// as fast at walking pace, 2.5 times as fast in a panic).
const CAR_DRIVER = { a: 2.0, b: 3.0, T: 1.2, s0: 2.0, aLat: 3.5, bMax: 8, grip: 8, lock: 0.6, steerRate: 0.3 };
const BUS_DRIVER = { a: 1.1, b: 2.5, T: 1.5, s0: 2.5, aLat: 2.0, bMax: 6, grip: 5, lock: 0.9, steerRate: 0.3 };
const LOOKAHEAD = 70; // metres a driver looks ahead for vehicles, stop lines and signals
const MOVING_ROOM = 2; // seconds ahead a driver reckons the road will be clear, of a car that's moving
// Dodging the player (see react): seconds before the player would hit it that a driver notices, and the least it keeps
// up its manoeuvre once it reacts
const AVOID_NOTICE = 1.8;
const AVOID_HOLD = 1.2;

// Car body kinds (BODY_SPECS keys) in street & highway traffic: half-length for spacing, half-width & axle for the
// path, collision half-length & mass, and the engine voice (audio-sources.js)
const CAR_KINDS = {
  taxi: { half: 2.25, halfWidth: 0.86, axle: 1.38, halfL: 2.18, mass: 1600, engine: 'sedan' },
  sedan: { half: 2.25, halfWidth: 0.86, axle: 1.38, halfL: 2.18, mass: 1600, engine: 'sedan' },
  suv: { half: 2.3, halfWidth: 0.92, axle: 1.4, halfL: 2.22, mass: 2100, engine: 'suv' },
  minivan: { half: 2.6, halfWidth: 0.92, axle: 1.52, halfL: 2.52, mass: 2000, engine: 'sedan' },
  pickup: { half: 2.86, halfWidth: 0.96, axle: 1.92, halfL: 2.78, mass: 2400, engine: 'suv' },
  van: { half: 2.96, halfWidth: 0.95, axle: 1.8, halfL: 2.88, mass: 2700, engine: 'suv' }
};

// Retire distant actors even when looking their way: keeping them indefinitely starves upcoming streets.
// Replacements may enter the far view, but nearby visible roads and sidewalks are protected from pop-in.
const VEHICLE_RADIUS = 380;
// Vehicles are placed around the player, and in the middle of the bridge the deck is all there is around the player:
// without a wider gap there every car in the pool lands on it, one each 26 m of lane, at 34 km/h
const DECK_SPAWN_GAP = 60;
const DECK_PACE = 1.5; // of a street's speed: the bridge is signed 70 km/h
const NEAR_RADIUS = 350;
const LANE_METRES_PER_VEHICLE = 80; // of road near the player, for each vehicle on it, at the most a road holds
// How full a road is, of the most it holds, follows who lives and works around it (js/places.js): motorways carry traffic through
// wherever they are, main roads some of it, and a street of houses only its own cars. Where the map has no grid, every road is full.
const MAIN_ROAD_LEAST = 0.35;
const STREET_LEAST = 0.05;
// People out walking within NEAR_RADIUS: one for each 200 residents and workers there, a crowd at a station, never nobody
const PEOPLE_PER_RESIDENT = 1 / 200;
const PEOPLE_AT_STATION = 30;
const PEOPLE_LEAST = 4;
const STUCK_OUT_OF_VIEW = 45, STUCK_IN_VIEW = 180; // s without moving
const VEHICLE_SPAWN_DISTANCE = 250;

// 8-row LED destination sign atlas (route badge + destination) aligned with the 4-slot bus livery cycle
// (slots 0/2 = white and blue, slot 1 = express, slot 3 = plain)
function createBusDestinationTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#090b10';
  ctx.fillRect(0, 0, 512, 512);
  const routes = [
    ['333', 'BONDI BEACH', '#0058b8', '#ff9d1c'],
    ['B1', 'MONA VALE', '#d8a400', '#ffe066'],
    ['389', 'BONDI JUNCTION', '#0058b8', '#ff9d1c'],
    ['431', 'GLEBE POINT', '#0058b8', '#ff9d1c'],
    ['373', 'COOGEE', '#0058b8', '#ff9d1c'],
    ['L90', 'PALM BEACH', '#d8a400', '#ffe066'],
    ['200', 'CHATSWOOD', '#0058b8', '#ff9d1c'],
    ['461', 'BURWOOD', '#0058b8', '#ff9d1c']
  ];
  routes.forEach(([route, dest, badgeBg, textCol], idx) => {
    const y0 = idx * 64;
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(6, y0 + 8, 500, 48);
    ctx.fillStyle = badgeBg;
    ctx.fillRect(12, y0 + 11, 126, 42);
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 32px Inter, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(route, 75, y0 + 33);
    ctx.fillStyle = textCol;
    ctx.font = '800 25px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(dest, 152, y0 + 33);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// kerbsideChanged(old, now): the colliders of the cars parked along the kerbs, as they change (js/main.js gives them to the player's)
function* createTrafficSystem(scene, obstacles, signalIntersections, { numCars = NUM_CARS, numBuses = NUM_BUSES, numPeds, lightPools, firstNetwork = null, kerbsideChanged = null } = {}) {
  const group = new THREE.Group();
  group.name = 'CityTrafficAndPedestrians';
  let collisionListener = null;
  const collisionEvent = { a: null, b: null, kind: 'vehicle', x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, speed: 0 };

  function setCollisionListener(listener) {
    collisionListener = typeof listener === 'function' ? listener : null;
  }

  // Synchronous notification: listeners must copy any fields they retain. Normal points from b toward a.
  function reportCollision(a, b, x, y, z, nx, nz, speed) {
    if (!collisionListener || speed <= 0.5) return;
    collisionEvent.a = a; collisionEvent.b = b;
    collisionEvent.x = x; collisionEvent.y = y; collisionEvent.z = z;
    collisionEvent.nx = nx; collisionEvent.nz = nz; collisionEvent.speed = speed;
    collisionListener(collisionEvent);
  }

  const dummy = new THREE.Object3D();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const unitPlane = new THREE.PlaneGeometry(1, 1);
  unitPlane.rotateX(-Math.PI * 0.5);
  const contactShadowMat = createContactShadowMaterial();

  // =========================================================================
  // 0. ROAD NETWORK
  // =========================================================================
  let network = firstNetwork || (yield* buildRoadNetworkSteps(obstacles, signalIntersections));
  yield;
  let { nodes, edges, connector, curvePoint } = network;

  // Sides of an intersection (road-network.js step 9): a grid intersection's are 0 east, 1 west, 2 south, 3 north;
  // centreline junctions number their arms from 4. Where lane i of edge e meets a crosswalk, measured along the
  // crosswalk: along its road's lateral axis (x across north-south roads, z across east-west ones)
  const laneCoord = (e, i) => (e.sx + e.rx * e.lanes[i]) * e.clx + (e.sz + e.rz * e.lanes[i]) * e.clz;

  function prepareNetwork() {
  for (const n of nodes) {
    n.box = new Array(n.groupCount).fill(0); // vehicles crossing it from each road (group: on the grid avenue 0, street 1)
    n.crossing = new Array(n.sideCount).fill(0); // vehicles crossing (or about to cross) the crosswalk on each side
    n.approach = new Array(n.sideCount).fill(null); // the edge arriving over each side's crosswalk
    n.road = new Array(n.sideCount).fill(null); // an edge arriving or leaving over each side's crosswalk: the road it spans
    n.sideGroup = new Array(n.sideCount).fill(1); // the right-of-way group of the road on each side
  }
  // A joint between two pieces of road is no junction: nobody crosses it, and no two lanes lead into one. A road parting in two is
  // the same. Over a third of all nodes are this, and drivers treating each as a junction kept stopping for no reason you could see.
  for (const n of nodes) {
    const opposite = n.in.length === 2 && n.in[0].dx * n.in[1].dx + n.in[0].dz * n.in[1].dz < -0.5;
    const targets = new Set();
    n.joint = !n.signal && n.in.length > 0 && (n.in.length === 1 || opposite) && n.in.every((e) => e.moves.every((m) => {
      if (m.turn === 'U' || m.to === e) return true;
      const lanes = m.out.filter((j) => j >= 0);
      if (targets.has(m.to) || new Set(lanes).size !== lanes.length) return false;
      targets.add(m.to);
      return true;
    }));
  }
  for (const e of edges) {
    e.occ = e.lanes.map(() => []); // vehicles in each lane, sorted by position
    // e.inSide / e.outSide: the crosswalks crossed on the way into e.to / out of e.from; e.axisIndex: its group at e.to;
    // e.opposite: the oncoming edge of its road there (road-network.js)
    e.to.approach[e.inSide] = e;
    e.to.road[e.inSide] = e.from.road[e.outSide] = e;
    e.to.sideGroup[e.inSide] = e.inArm.group;
    e.from.sideGroup[e.outSide] = e.outArm.group;
    e.through = 0; // vehicles from e crossing e.to straight on or to the right
    e.lefts = 0; // and to the left
  }
  }
  prepareNetwork();
  // Is the intersection box held by vehicles of any road but group g's?
  const boxBusy = (n, g) => {
    for (let k = 0; k < n.box.length; k++) if (k !== g && n.box[k] > 0) return true;
    return false;
  };

  // =========================================================================
  // 1. 3D LOFTED TAXIS, SEDANS, SUVS & POLICE CARS (200 VEHICLES)
  // =========================================================================
  function createVehicle(bus, half, halfWidth, axle, driver, v0) {
    return {
      bus, half, halfWidth, axle, driver, v0,
      edge: null, lane: 0, s: 0, speed: 0, acc: 0, gap: Infinity, leaderSpeed: 0,
      move: null, out: 0, conn: null, cs: 0, trail: null, commit: null, claimed: false, yielding: false, yieldAt: 0,
      wait: 0, laneTimer: Math.random() * 0.5,
      dl: 0, dlv: 0, blink: 0, blinkPhase: Math.random() * 0.8,
      evade: 0, alarm: 0, panicUntil: 0, panicAcc: 0, reaction: 0.6 + Math.random() * 0.4,
      x: 0, z: 0, prevX: 0, prevZ: 0, tx: 0, tz: 1, nose: 0, yaw: 0, yawRate: 0, steer: 0, delta: 0,
      pitch: 0, roll: 0, pitchVel: 0, rollVel: 0, vx: 0, vz: 0, yawOffset: 0, yawVel: 0, impactTime: 0,
      pAhead: Infinity, pRight: 0, pSpeed: 0, wheelSpin: Math.random() * Math.PI * 2
    };
  }

  // Every body kind shares one 3D wheel model, instanced separately and scaled to the kind's wheel radius
  const carWheelLeftGeo = buildSteerableWheelGeo(BODY_SPECS.sedan, -1);
  const carWheelRightGeo = buildSteerableWheelGeo(BODY_SPECS.sedan, 1);
  const carWheelStyles = new THREE.InstancedBufferAttribute(new Float32Array(numCars * 2), 1);
  carWheelLeftGeo.setAttribute('wheelStyle', carWheelStyles);
  carWheelRightGeo.setAttribute('wheelStyle', carWheelStyles);
  const carWheelMat = createCarWheelMaterial({ instanced: true });

  const taxiYellow = new THREE.Color(0xe8e8e2); // Sydney's cabs are white, silver or black: no yellow fleet here
  const boroGreen = new THREE.Color(0x5cae3e);
  const policeWhite = new THREE.Color(0xf6f9fc);
  // Street fleet palettes: white/black/grey/silver dominate with black hire cars, blue/red/green accents,
  // metallic vs solid clearcoat, chrome/blackout trim & multi-spoke wheel styles encoded in carState.w.
  const fleetStyles = {
    sedan: [
      { col: new THREE.Color(0x12151a), style: carStyleCode({ livery: 3, metallic: 0, trim: 1, wheel: 1 }) }, // TLC / Uber Black Car
      { col: new THREE.Color(0x161a20), style: carStyleCode({ livery: 3, metallic: 1, trim: 2, wheel: 2 }) }, // TLC Obsidian Blackout
      { col: new THREE.Color(0xf2f4f7), style: carStyleCode({ livery: 0, metallic: 0, trim: 0, wheel: 0 }) }, // Alpine White Sedan
      { col: new THREE.Color(0xe6eaef), style: carStyleCode({ livery: 4, metallic: 1, trim: 2, wheel: 2 }) }, // Pearl White Sport (black roof)
      { col: new THREE.Color(0xc8d0d8), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) }, // Liquid Silver Metallic
      { col: new THREE.Color(0x9aa2ac), style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 1 }) }, // Tungsten Silver Metallic
      { col: new THREE.Color(0x52575e), style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 2 }) }, // Graphite Grey Metallic
      { col: new THREE.Color(0x363b42), style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 3 }) }, // Charcoal Dark Grey
      { col: new THREE.Color(0x1c2026), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) }, // Jet Black Metallic
      { col: new THREE.Color(0x1d3b6c), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) }, // Deep Navy Metallic
      { col: new THREE.Color(0x285086), style: carStyleCode({ livery: 4, metallic: 1, trim: 2, wheel: 2 }) }, // Atlantic Blue Sport (black roof)
      { col: new THREE.Color(0x741d22), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) }  // Crimson Red Metallic
    ],
    suv: [
      { col: new THREE.Color(0x101318), style: carStyleCode({ livery: 3, metallic: 0, trim: 1, wheel: 1 }) }, // Executive Black Escalade / Suburban TLC
      { col: new THREE.Color(0x171b22), style: carStyleCode({ livery: 3, metallic: 1, trim: 2, wheel: 3 }) }, // Uber Black SUV (blackout)
      { col: new THREE.Color(0xf0f3f7), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) }, // Pearl White Luxury SUV
      { col: new THREE.Color(0xe4e8ed), style: carStyleCode({ livery: 4, metallic: 0, trim: 2, wheel: 2 }) }, // Glacier White SUV (black roof)
      { col: new THREE.Color(0x3a434d), style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 2 }) }, // Slate Grey Metallic SUV
      { col: new THREE.Color(0x5c636b), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) }, // Gunmetal Grey SUV
      { col: new THREE.Color(0xbec6cf), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) }, // Silver Metallic Crossover
      { col: new THREE.Color(0x181c22), style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 3 }) }, // Onyx Black SUV
      { col: new THREE.Color(0x20385c), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) }, // Midnight Blue SUV
      { col: new THREE.Color(0x28382e), style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 0 }) }, // Forest Green Metallic SUV
      { col: new THREE.Color(0x682024), style: carStyleCode({ livery: 4, metallic: 1, trim: 2, wheel: 2 }) }, // Burgundy Crossover (black roof)
      { col: new THREE.Color(0x787670), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 3 }) }  // Urban Putty Grey Crossover
    ],
    // Minivans: family colours plus hire-car black
    minivan: [
      { col: new THREE.Color(0x111419), style: carStyleCode({ livery: 3, metallic: 1, trim: 1, wheel: 1 }) }, // TLC / Uber XL Black
      { col: new THREE.Color(0xf0f2f5), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) }, // Blizzard Pearl
      { col: new THREE.Color(0xaab2bb), style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 1 }) }, // Celestial Silver
      { col: new THREE.Color(0x4a5058), style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 2 }) }, // Modern Steel Grey
      { col: new THREE.Color(0x1a1d22), style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 3 }) }, // Midnight Black
      { col: new THREE.Color(0x26354f), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) }, // Obsidian Blue
      { col: new THREE.Color(0xe9ecef), style: carStyleCode({ livery: 0, metallic: 0, trim: 0, wheel: 1 }) }, // Super White
      { col: new THREE.Color(0x5a1f24), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) }  // Velvet Red
    ],
    // Pickups: black, white & silver with chrome or blackout grilles
    pickup: [
      { col: new THREE.Color(0x14171b), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) }, // Agate Black (chrome)
      { col: new THREE.Color(0xf2f3f5), style: carStyleCode({ livery: 0, metallic: 0, trim: 1, wheel: 0 }) }, // Oxford White (chrome)
      { col: new THREE.Color(0x9da4ab), style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 2 }) }, // Iconic Silver
      { col: new THREE.Color(0x3d434a), style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 3 }) }, // Carbonized Grey (blackout)
      { col: new THREE.Color(0x1e2f4f), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) }, // Antimatter Blue
      { col: new THREE.Color(0x8f1a1d), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 3 }) }, // Race Red (blackout)
      { col: new THREE.Color(0xf2f3f5), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 3 }) }, // Oxford White (blackout)
      { col: new THREE.Color(0x2c3a30), style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 0 }) }  // Forest Green
    ],
    // Delivery vans: mostly fleet white, black plastic trim; never two-tone, whose black roof would cover the van's
    // cargo box (part of its glasshouse loft)
    van: [
      { col: new THREE.Color(0xf4f5f6), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 0 }) }, // Fleet White
      { col: new THREE.Color(0xeef0f2), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 3 }) }, // Arctic White (dark wheels)
      { col: new THREE.Color(0xb9c0c7), style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 0 }) }, // Brilliant Silver
      { col: new THREE.Color(0xf4f5f6), style: carStyleCode({ livery: 0, metallic: 0, trim: 0, wheel: 1 }) }, // Fleet White
      { col: new THREE.Color(0x8e959c), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 3 }) }, // Pebble Grey
      { col: new THREE.Color(0xf0f1f2), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 3 }) }, // Fleet White (dark wheels)
      { col: new THREE.Color(0x15181c), style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 3 }) }, // Obsidian Black
      { col: new THREE.Color(0xf4f5f6), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 0 }) }, // Fleet White
      { col: new THREE.Color(0x1f3354), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 0 }) }, // Navy Blue
      { col: new THREE.Color(0xf4f5f6), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 1 }) }, // Fleet White
      { col: new THREE.Color(0x9b1c1f), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 0 }) }  // Flame Red
    ]
  };
  // Of every 20 cars: 4 yellow cabs, 5 sedans, 6 SUVs, 2 delivery vans, 2 minivans & a pickup. police cruisers are sedans
  // or Interceptor SUVs, green Boro cabs sedans or SUVs.
  const FLEET_MIX = ['taxi', 'sedan', 'van', 'sedan', 'suv', 'taxi', 'suv', 'minivan', 'suv', 'pickup',
    'taxi', 'sedan', 'suv', 'van', 'suv', 'taxi', 'minivan', 'sedan', 'suv', 'sedan'];

  const cars = [];
  const counts = Object.fromEntries(Object.keys(CAR_KINDS).map((kind) => [kind, 0]));
  const policeCounts = { sedan: 0, suv: 0 };

  for (let i = 0; i < numCars; i++) {
    const isPolice = (i % 50) === 6 || (i % 100) === 56;
    const isBoroTaxi = !isPolice && (i % 25) === 3;
    let bodyType = FLEET_MIX[i % FLEET_MIX.length];
    if (isPolice) bodyType = (i % 100) === 56 ? 'suv' : 'sedan';
    else if (isBoroTaxi) bodyType = i % 2 === 0 ? 'suv' : 'sedan';

    let col;
    let style;
    if (bodyType === 'taxi') {
      col = taxiYellow;
      style = carStyleCode({ livery: 0, metallic: 0, trim: 0, wheel: i % 2 });
    } else if (isPolice) {
      col = policeWhite;
      style = carStyleCode({ livery: 1, metallic: 0, trim: 2, wheel: 3 });
      policeCounts[bodyType]++;
    } else if (isBoroTaxi) {
      col = boroGreen;
      style = carStyleCode({ livery: 2, metallic: 0, trim: 0, wheel: 0 });
    } else {
      const palette = fleetStyles[bodyType];
      ({ col, style } = palette[counts[bodyType] % palette.length]);
    }
    counts[bodyType]++;

    const kind = CAR_KINDS[bodyType];
    const car = createVehicle(false, kind.half, kind.halfWidth, kind.axle, CAR_DRIVER, 10 + (i % 5) * 0.9);
    // paint as float32 values, so renderCar() can tell whether an instance slot's paint changes by comparing
    const paint = [Math.fround(col.r), Math.fround(col.g), Math.fround(col.b)];
    Object.assign(car, { isPolice, bodyType, paint, style, halfL: kind.halfL, mass: kind.mass, engine: kind.engine });
    cars.push(car);
  }

  // Per body kind: the full model (with separately instanced spinning wheels near the camera) and, beyond
  // CAR_PROXY_DISTANCE, the ~250-triangle stand-in, plus the contact shadow's footprint (width, length, centre z).
  // Instance slots are handed out every frame to the cars the camera can see (or whose shadow it may see), see
  // renderCar(). Per-instance paint & lamp / livery state the car material reads: brake lights, left (+x) & right (-x)
  // turn signals, livery (1 = police).
  const bodies = {};
  for (const kind of Object.keys(CAR_KINDS)) {
    const spec = BODY_SPECS[kind];
    const n = Math.max(1, counts[kind]);
    const mat = createLoftedCarMaterial(spec);
    const lodMesh = (g) => {
      g.setAttribute('paintColor', new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
      g.setAttribute('carState', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
      return new THREE.InstancedMesh(g, mat, n);
    };
    const halfWidth = Math.max(...spec.halfWidth.map((p) => p[1])) + spec.archFlare;
    bodies[kind] = {
      near: lodMesh(buildCarGeometry(spec, false)),
      far: lodMesh(buildCarProxyGeometry(spec)),
      shadow: [2 * halfWidth + 0.33, spec.zFront - spec.zRear + 0.55, (spec.zFront + spec.zRear) / 2]
    };
  }
  const bodyMeshes = Object.values(bodies).flatMap((b) => [b.near, b.far]);

  const carWheelLeftInst = new THREE.InstancedMesh(carWheelLeftGeo, carWheelMat, numCars * 2);
  const carWheelRightInst = new THREE.InstancedMesh(carWheelRightGeo, carWheelMat, numCars * 2);
  carWheelRightInst.userData.sharesPipelineWith = carWheelLeftInst;

  // 3D Collision Spark & Debris Particle Pool
  const MAX_SPARKS = 120;
  const sparkGeo = new THREE.BoxGeometry(0.038, 0.038, 0.26);
  const sparkMat = new THREE.MeshBasicNodeMaterial({ color: 0xffc438 });
  const sparkInst = new THREE.InstancedMesh(sparkGeo, sparkMat, MAX_SPARKS);
  const sparks = [];
  let sparkCursor = 0;
  for (let s = 0; s < MAX_SPARKS; s++) {
    sparks.push({ x: 0, y: -10, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 0.4 });
  }
  function spawnCollisionSparks(x, y, z, nx, nz, impactSpeed) {
    const count = Math.min(24, Math.max(8, Math.floor(impactSpeed * 1.4)));
    const tx = -nz;
    const tz = nx;
    for (let k = 0; k < count; k++) {
      const sp = sparks[sparkCursor];
      sparkCursor = (sparkCursor + 1) % MAX_SPARKS;
      const spread = (Math.random() - 0.5) * 2.2;
      const outBoost = (0.3 + Math.random() * 0.9) * Math.min(14.0, impactSpeed * 0.65);
      const tanBoost = spread * Math.min(12.0, impactSpeed * 0.55);
      sp.x = x + (Math.random() - 0.5) * 0.35;
      sp.y = y + (Math.random() - 0.5) * 0.18;
      sp.z = z + (Math.random() - 0.5) * 0.35;
      sp.vx = nx * outBoost + tx * tanBoost;
      sp.vy = 2.4 + Math.random() * 5.4;
      sp.vz = nz * outBoost + tz * tanBoost;
      sp.maxLife = 0.28 + Math.random() * 0.24;
      sp.life = sp.maxLife;
    }
  }

  // Police roof light bars per police-capable body kind (sedan & Interceptor SUV have different roof heights)
  const lightbarMat = createLightbarMaterial();
  const policeLightbars = {
    sedan: new THREE.InstancedMesh(buildLightbarGeometry(BODY_SPECS.sedan), lightbarMat, Math.max(1, policeCounts.sedan)),
    suv: new THREE.InstancedMesh(buildLightbarGeometry(BODY_SPECS.suv), lightbarMat, Math.max(1, policeCounts.suv))
  };
  const policeLightbarMeshes = [policeLightbars.sedan, policeLightbars.suv];
  const carShadowInst = new THREE.InstancedMesh(unitPlane, contactShadowMat, numCars);
  carShadowInst.renderOrder = 998;

  for (const m of bodyMeshes) m.castShadow = m.receiveShadow = true;
  for (const m of policeLightbarMeshes) m.castShadow = true;
  carWheelLeftInst.castShadow = carWheelLeftInst.receiveShadow = true;
  carWheelRightInst.castShadow = carWheelRightInst.receiveShadow = true;

  group.add(
    ...bodyMeshes,
    carWheelLeftInst,
    carWheelRightInst,
    sparkInst,
    ...policeLightbarMeshes
  );

  // =========================================================================
  // 2. CITY BUSES
  // =========================================================================
  const busBodyGeo = buildLoftedBusBodyGeometry();
  // Per-instance lamp & variant state the bus material and sign atlas read: brake, left (+x) & right (-x) turn, variant+1
  const busStates = new THREE.InstancedBufferAttribute(new Float32Array(numBuses * 4), 4);
  busBodyGeo.setAttribute('busState', busStates);
  // Destination signs above the windshield, by the front door & on the upper-right rear cap
  const busHeaderGeo = buildBusSignGeometry();
  busHeaderGeo.setAttribute('busState', busStates);

  const busBodyMat = createLoftedBusMaterial();
  const busDestTex = createBusDestinationTexture();
  const busDestMat = new THREE.MeshBasicNodeMaterial();
  {
    const { attribute, float, floor, max, mod, texture, uv, varying, vec2, vertexStage } = THREE.TSL;
    const state = attribute('busState', 'vec4');
    const vRow = varying(vertexStage(mod(floor(max(float(0.0), state.w.sub(1.0)).add(0.5)), 8.0)));
    const signUV = vec2(uv().x, uv().y.mul(0.095).add(0.015).add(float(7.0).sub(vRow).mul(0.125)));
    busDestMat.colorNode = texture(busDestTex, signUV).rgb.mul(1.25);
  }

  const busWheelMat = createBusWheelMaterial();
  const busBodyInst = new THREE.InstancedMesh(busBodyGeo, busBodyMat, numBuses);
  const busHeaderInst = new THREE.InstancedMesh(busHeaderGeo, busDestMat, numBuses);
  const busWheelLeftInst = new THREE.InstancedMesh(buildBusWheelGeo(-1), busWheelMat, numBuses * 2);
  const busWheelRightInst = new THREE.InstancedMesh(buildBusWheelGeo(1), busWheelMat, numBuses * 2);
  const busShadowInst = new THREE.InstancedMesh(unitPlane, contactShadowMat, numBuses);
  busShadowInst.renderOrder = 998;

  busBodyInst.castShadow = busBodyInst.receiveShadow = true;
  busWheelLeftInst.castShadow = busWheelLeftInst.receiveShadow = true;
  busWheelRightInst.castShadow = busWheelRightInst.receiveShadow = true;

  const buses = [];
  for (let i = 0; i < numBuses; i++) {
    const b = createVehicle(true, 6.1, 1.3, 3.6, BUS_DRIVER, 8 + (i % 3));
    Object.assign(b, { variant: i, halfL: 5.72, mass: 12000 });
    buses.push(b);
  }
  const vehicles = [...cars, ...buses];
  group.add(busBodyInst, busHeaderInst, busWheelLeftInst, busWheelRightInst);

  // =========================================================================
  // 3. PEDESTRIAN SYSTEM
  // =========================================================================
  const player = { active: false, entity: null, x: 0, y: 0, z: 0, vx: 0, vz: 0, fx: 0, fz: 1,
    halfW: 0.86, halfL: 2.18 };
  const nearEdges = [];
  const nearSignals = [];
  let nearLaneMetres = Infinity;
  let peopleWanted = Infinity;
  yield;
  const pedestrianSystem = createPedestrianSystem(network, {
    player, nearEdges, nearSignals, mayCross, walkOn, visible, nearView, numPeds, wanted: () => peopleWanted
  });
  group.add(...pedestrianSystem.meshes);
  yield;

  // Add vehicle contact shadows last + pre-allocated Clustered SpotLight / PointLight pools
  group.add(carShadowInst, busShadowInst);

  const MAX_LIGHT_DIST = 115;
  const MAX_LIGHT_DIST_SQ = MAX_LIGHT_DIST * MAX_LIGHT_DIST;
  const { headlights: headlightPool, policeLights: policeLightPool } = lightPools;
  const HEADLIGHT_POOL_SIZE = headlightPool.length;
  const POLICE_LIGHT_POOL_SIZE = policeLightPool.length;

  // Nothing shows until it has been placed
  const carInstances = [...bodyMeshes, carWheelLeftInst, carWheelRightInst, ...policeLightbarMeshes, carShadowInst];
  const busInstances = [busBodyInst, busHeaderInst, busWheelLeftInst, busWheelRightInst, busShadowInst];
  for (const inst of [...carInstances, ...busInstances, sparkInst]) {
    inst.frustumCulled = false;
    for (let i = 0; i < inst.count; i++) inst.setMatrixAt(i, zero);
  }

  anchorToOrigin(group); // writes its own transforms every frame, from the origin
  scene.add(group);

  // =========================================================================
  // 4. WHO IS WHERE: LANE OCCUPANCY, INTERSECTIONS, VIEW, PLAYER
  // =========================================================================
  let clock = 0;
  // Each signalled junction runs its own lights (js/signals.js). They carry on when the road network is rebuilt.
  const phaseOf = (e) => e.to.lights.phaseOf(e.lightGroup);
  const lightsKnown = new Map();
  const headLights = new Map();
  let signalSets = [];
  let signalTimer = 0;
  const DETECT = 45, STILL_COMING = 30, SIGNAL_STEP = 0.2, WALK_SECONDS = 12;
  let lightNodes = null;
  // Who the lights at the junction in hand can see, on the road of group g
  const lightAsk = {
    demand(g) {
      for (const n of lightNodes) {
        for (const a of n.in) {
          if (a.lightGroup !== g) continue;
          if (clock - (a.playerAt ?? -9) < 1) return true;
          for (const list of a.occ) {
            const o = leadOf(list);
            if (o && a.len - o.s - o.v.half < DETECT) return true;
          }
        }
      }
      return false;
    },
    flowing(g) {
      for (const n of lightNodes) {
        for (const a of n.in) {
          if (a.lightGroup !== g) continue;
          if (clock - (a.playerAt ?? -9) < 1 && Math.hypot(player.vx, player.vz) > 0.5) return true;
          for (const list of a.occ) {
            const o = leadOf(list);
            if (o && o.v.speed > 0.5 && a.len - o.s - o.v.half < STILL_COMING) return true;
          }
        }
      }
      return false;
    },
    people(g) {
      for (const n of lightNodes) {
        for (let side = 0; side < n.sideLight.length; side++) {
          if (n.sideLight[side] === g && clock - n.askedAt[side] < 1) return true;
        }
      }
      return false;
    }
  };
  // The player, driving towards a junction, counts as someone waiting: nothing else would turn a light green for them
  function playerAtLights() {
    if (!player.active) return;
    const level = player.entity?.surface || 0;
    for (const n of nearSignals) {
      if (Math.abs(n.x - player.x) > DETECT + 20 || Math.abs(n.z - player.z) > DETECT + 20) continue;
      for (const a of n.in) {
        if ((a.sid || 0) !== level) continue;
        const px = player.x - a.sx, pz = player.z - a.sz;
        const along = px * a.dx + pz * a.dz, off = px * a.rx + pz * a.rz;
        if (along < -5 || a.len - along > DETECT || Math.abs(off) > a.half + 2) continue;
        if (player.fx * a.dx + player.fz * a.dz > 0.3) a.playerAt = clock;
      }
    }
  }
  signalSets = assignLights(nodes, lightsKnown, headLights);
  function updateSignals(dt) {
    signalTimer += dt;
    if (signalTimer < SIGNAL_STEP) return;
    playerAtLights();
    for (const set of signalSets) {
      lightNodes = set.nodes;
      set.lights.update(signalTimer, lightAsk);
    }
    signalTimer = 0;
  }
  let focusX = 0;
  let focusZ = 140;

  // Lane lists hold pooled { v, s } entries sorted by position s along the lane, rebuilt every frame
  const pool = [];
  let poolUsed = 0;
  const filled = [];
  function occupy(list, v, s) {
    let o = pool[poolUsed++];
    if (!o) pool.push((o = { v: null, s: 0 }));
    o.v = v;
    o.s = s;
    if (!list.length) filled.push(list);
    list.push(o);
    for (let k = list.length - 1; k > 0 && list[k - 1].s > s; k--) {
      list[k] = list[k - 1];
      list[k - 1] = o;
    }
  }

  // Half way through a lane change a vehicle still occupies the lane it is leaving (-1 towards the centre, 1 the kerb)
  function straddle(v) {
    if (v.conn) return 0;
    const towardsKerb = v.dl * DRIVE_SIDE;
    if (towardsKerb > 0.5 && v.lane + 1 < v.edge.lanes.length) return 1;
    if (towardsKerb < -0.5 && v.lane > 0) return -1;
    return 0;
  }

  // A vehicle crossing an intersection, or committed to crossing it, holds it against crossing traffic and
  // pedestrians on the crosswalks it passes, and its place in the lane it heads for. The counters it raises are reset
  // next frame for just the nodes and edges touched (a few hundred out of thousands)
  const touchedNodes = [];
  const touchedEdges = [];
  const touchNode = (n) => {
    if (!n.touched) {
      n.touched = true;
      touchedNodes.push(n);
    }
    return n;
  };
  const touchEdge = (e) => {
    if (!e.touched) {
      e.touched = true;
      touchedEdges.push(e);
    }
    return e;
  };
  function claim(v) {
    if (v.claimed) return;
    v.claimed = true;
    const e = v.edge;
    const f = v.move.to;
    touchNode(e.to).box[e.axisIndex]++;
    if (!v.conn || v.cs < v.half + 2.5) e.to.crossing[e.inSide]++; // until its tail is past the crosswalk on its way in
    if (v.move.turn !== 'L') touchEdge(e).through++;
    if (!v.yielding) cross(v);
    occupy(f.occ[v.out], v, v.conn ? v.cs - v.conn.len : v.s - e.len - connector(e, v.lane, f, v.out).len);
  }

  // ...and, unless still waiting inside to turn left, the oncoming lanes and the crosswalk on its way out
  function cross(v) {
    const e = v.edge;
    if (v.move.turn === 'L') touchEdge(e).lefts++;
    touchNode(e.to).crossing[v.move.to.outSide]++;
    v.yielding = false;
  }

  function buildOccupancy() {
    for (const list of filled) list.length = 0;
    filled.length = 0;
    poolUsed = 0;
    for (const n of touchedNodes) {
      n.box.fill(0);
      n.crossing.fill(0);
      n.touched = false;
    }
    touchedNodes.length = 0;
    for (const e of touchedEdges) {
      e.through = e.lefts = 0;
      e.touched = false;
    }
    touchedEdges.length = 0;
    for (const v of vehicles) v.claimed = false;
    for (const v of vehicles) {
      const e = v.edge;
      if (!e) continue;
      if (!v.conn) {
        occupy(e.occ[v.lane], v, v.s);
        const side = straddle(v);
        if (side) occupy(e.occ[v.lane + side], v, v.s);
        if (v.commit === e.to) claim(v);
        if (v.s < v.half) touchNode(e.from).crossing[e.outSide]++; // its tail still over the crosswalk behind it
      } else {
        claim(v);
        occupy(e.occ[v.lane], v, e.len + v.cs); // until it is out of the intersection, still ahead of those behind it
      }
    }
  }

  // The camera's view, for drawing and protecting nearby spawn locations
  const frustum = new THREE.Frustum();
  const viewProjection = new THREE.Matrix4();
  let hasView = false;
  let camX = 0;
  let camY = 10;
  let camZ = 140;
  let camFwdX = 0;
  let camFwdZ = 1;
  function updateView(camera) {
    hasView = !!camera;
    if (!camera) return;
    camera.updateMatrixWorld();
    camX = camera.position.x;
    camY = camera.position.y;
    camZ = camera.position.z;
    const me = camera.matrixWorld.elements;
    camFwdX = -me[8];
    camFwdZ = -me[10];
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection);
  }
  // Could the camera see a sphere of radius r around ground point (x, z)? Side planes only: the near and far
  // planes depend on depth conventions, and the side planes alone already rule out everything behind the camera.
  function visible(x, z, r) {
    if (!hasView) return false;
    for (let k = 0; k < 4; k++) {
      const { normal, constant } = frustum.planes[k];
      if (normal.x * (x - origin.x) + normal.y + normal.z * (z - origin.z) + constant < -r) return false;
    }
    return true;
  }

  function nearView(x, z, radius, distance) {
    return hasView && Math.hypot(x - camX, camY, z - camZ) < distance && visible(x, z, radius);
  }

  // Edges and signalized intersections around the focus, to place vehicles and pedestrians on
  let nearX = Infinity;
  let nearZ = Infinity;
  function refreshNear() {
    if (Math.hypot(focusX - nearX, focusZ - nearZ) < 40) return;
    nearX = focusX;
    nearZ = focusZ;
    nearEdges.length = 0;
    nearSignals.length = 0;
    nearLaneMetres = 0;
    for (const e of edges) {
      const s = clamp((focusX - e.sx) * e.dx + (focusZ - e.sz) * e.dz, 0, e.len);
      const dx = e.sx + e.dx * s - focusX, dz = e.sz + e.dz * s - focusZ;
      if (dx * dx + dz * dz < NEAR_RADIUS * NEAR_RADIUS) {
        nearEdges.push(e);
        if (!e.shareKnown) e.share = roadShare(e);
        nearLaneMetres += Math.min(e.len, NEAR_RADIUS * 2) * e.lanes.length * e.share;
      }
    }
    peopleWanted = peopleAround(focusX, focusZ);
    for (const n of nodes) {
      const dx = n.x - focusX, dz = n.z - focusZ;
      if (n.signal && dx * dx + dz * dz < NEAR_RADIUS * NEAR_RADIUS) nearSignals.push(n);
    }
  }

  /** How full of traffic a road is, of the most it can hold (see MAIN_ROAD_LEAST) */
  function roadShare(e) {
    const busy = busyAt(e.sx + (e.dx * e.len) / 2, e.sz + (e.dz * e.len) / 2);
    // Asked again until the tile with its grid is held
    e.shareKnown = busy !== null;
    if (busy === null || e.cls === ROAD_CLASS.motorway || e.cls === ROAD_CLASS.trunk) return 1;
    if (e.axis === 'ave' || e.cls === ROAD_CLASS.link) return MAIN_ROAD_LEAST + (1 - MAIN_ROAD_LEAST) * busy;
    return Math.max(STREET_LEAST, busy);
  }
  /** How many people the place around (x, z) has out walking: the level's numPeds is the most there are (js/pedestrian-system.js) */
  function peopleAround(x, z) {
    const near = placesNear(x, z, NEAR_RADIUS);
    if (!near.known) return Infinity;
    let stations = 0;
    for (const [, sx, sz] of GEO.stations || []) if ((sx - x) * (sx - x) + (sz - z) * (sz - z) < NEAR_RADIUS * NEAR_RADIUS) stations++;
    const people = ((near.res + near.jobs) * near.cells) / near.known;
    return Math.round(Math.max(PEOPLE_LEAST, people * PEOPLE_PER_RESIDENT + stations * PEOPLE_AT_STATION));
  }

  // Where the player is relative to v: metres ahead, metres to the right, and how fast it moves v's way
  function relateToPlayer(v) {
    v.pAhead = Infinity;
    if (!player.active || !onPlayersLevel(v)) return;
    const dx = player.x - v.x;
    const dz = player.z - v.z;
    if (Math.abs(dx) > LOOKAHEAD + 10 || Math.abs(dz) > LOOKAHEAD + 10) return;
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    v.pAhead = dx * fx + dz * fz;
    v.pRight = dz * fx - dx * fz;
    v.pSpeed = Math.max(0, player.vx * fx + player.vz * fz);
  }

  // Gap to the player if it is ahead in the lane whose centre is `off` metres to the right of v
  function playerGap(v, off) {
    let gap = Infinity;
    if (v.pAhead >= 0 && v.pAhead <= LOOKAHEAD && Math.abs(v.pRight - off) <= v.halfWidth + player.halfW + 0.4) {
      gap = v.pAhead - v.half - player.halfL;
    }
    return Math.min(gap, parkedGap(v, off));
  }

  // The player's car, left at the side of the road or in the middle of it: treated like anything stopped in a lane
  let parkedCar = null;
  function parkedGap(v, off) {
    if (!parkedCar) return Infinity;
    const dx = parkedCar.position.x - v.x, dz = parkedCar.position.z - v.z;
    if (Math.abs(dx) > LOOKAHEAD + 10 || Math.abs(dz) > LOOKAHEAD + 10) return Infinity;
    if (!sameLevel(heightOf(v), parkedCar.surfaceY ?? 0)) return Infinity;
    const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
    const ahead = dx * fx + dz * fz, right = dz * fx - dx * fz;
    if (ahead < 0 || ahead > LOOKAHEAD || Math.abs(right - off) > v.halfWidth + 1.3) return Infinity;
    return ahead - v.half - 2.18;
  }

  // =========================================================================
  // 5. DRIVING
  // =========================================================================
  // The lane nearest to `lane` that move m can be made from (m.out[i] is the lane lane i leads to, or -1)
  function nearestLane(m, lane) {
    let best = -1;
    for (let i = 0; i < m.out.length; i++) {
      if (m.out[i] >= 0 && (best < 0 || Math.abs(i - lane) < Math.abs(best - lane))) best = i;
    }
    return best;
  }

  // First vehicle ahead of position s in a lane list
  function ahead(list, s, v) {
    for (const o of list) if (o.s > s && o.v !== v) return o;
    return null;
  }

  // The front-most vehicle still approaching the end of a lane: not crossing at its end yet, though maybe still coming
  // out of the intersection at its start (at s < 0)
  function leadOf(list) {
    for (let k = list.length - 1; k >= 0; k--) if (!list[k].v.conn || list[k].s < 0) return list[k];
    return null;
  }

  // Intelligent Driver Model: acceleration on a free road, and the braking term for an obstacle `gap` metres
  // (bumper to bumper) ahead moving at `speed`
  const freeAcc = (v) => v.driver.a * (1 - (v.speed / (v.edge?.deck ? v.v0 * DECK_PACE : v.v0)) ** 4);
  function brake(v, gap, speed, s0 = v.driver.s0, T = v.driver.T) {
    const { a, b } = v.driver;
    const desired = s0 + Math.max(0, v.speed * T + (v.speed * (v.speed - speed)) / (2 * Math.sqrt(a * b)));
    return -a * (desired / Math.max(gap, 0.1)) ** 2;
  }
  // ...and for a line d metres ahead to stop s0 short of: no time gap to keep to a line
  const stopAt = (v, d, s0 = 1) => brake(v, d, 0, s0, 0);

  // Braking for the vehicle ahead of position s in a lane list; remembers the nearest one
  function follow(v, list, s) {
    const o = ahead(list, s, v);
    if (!o) return 0;
    const gap = o.s - o.v.half - s - v.half;
    if (gap > LOOKAHEAD) return 0;
    if (gap < v.gap) {
      v.gap = gap;
      v.leaderSpeed = o.v.speed;
    }
    return brake(v, gap, o.v.speed);
  }

  // Can v, d metres before a line, still stop at it braking no harder than its driver comfortably does?
  const canStopBefore = (v, d) => freeAcc(v) + stopAt(v, d) > -v.driver.b;

  // Braking for a red (or an amber with room to stop) at the end of edge f, `d` metres ahead
  function signalAhead(v, f, d) {
    if (v.isPolice || !f.to.signal || d > LOOKAHEAD) return 0;
    const phase = phaseOf(f);
    if (phase === 'green' || (phase === 'amber' && !canStopBefore(v, d))) return 0;
    return stopAt(v, d);
  }

  // Mostly straight on, sometimes a turn (buses keep to wide roads). Routes don't follow the camera;
  // distant vehicles are recycled instead. With `fromLane`, only moves the current lane allows.
  const weights = [];
  function chooseMove(v, fromLane) {
    const e = v.edge;
    let total = 0;
    for (let k = 0; k < e.moves.length; k++) {
      const m = e.moves[k];
      let w = m.turn === 'S' ? (v.bus ? 8 : 3) : 1;
      if (v.bus && m.turn !== 'S' && m.to.lanes.length < 2) w *= 0.05;
      if (fromLane) {
        if (m.out[v.lane] < 0) w = 0;
      } else if (Math.abs(nearestLane(m, v.lane) - v.lane) * 22 > e.len - v.s) {
        w *= 0.02; // too little road left to change lanes for it
      }
      weights[k] = w;
      total += w;
    }
    let r = Math.random() * total;
    let pick = null;
    for (let k = 0; k < e.moves.length; k++) {
      if (weights[k] <= 0) continue;
      pick = e.moves[k];
      r -= weights[k];
      if (r < 0) break;
    }
    // No move from this lane (a lane the road graph couldn't lead anywhere): take any move, changing lanes for it
    if (!pick && fromLane) return chooseMove(v, false);
    return pick || e.moves[0] || null;
  }

  // Could the vehicle of lane entry o, approaching the end of edge a, still stop easily before its line? Vehicles
  // already standing can; drivers who have been waiting a while accept any gap it can still stop for comfortably.
  function canStop(o, a, impatient) {
    const sp = o.v.speed;
    if (sp < 0.5) return true;
    const d = a.len - o.s - o.v.half;
    return impatient ? canStopBefore(o.v, d) : d > (sp * sp) / 5 + sp + 3;
  }

  // A left turn waits for oncoming traffic going straight or right (approach o); vehicles not on o yet haven't picked
  // their way on, and at a red, only police and those already committed to crossing still come. Waiting at the line, v
  // also takes turns with those waiting at theirs: whoever has waited longer goes first, if it has room to go.
  function yieldOncoming(o, impatient, v = null) {
    if (!o) return false;
    if (o.through > 0) return true;
    const red = o.to.signal && phaseOf(o) === 'red';
    for (const list of o.occ) {
      const lead = leadOf(list);
      if (!lead || (lead.v.edge === o && lead.v.move.turn === 'L')) continue;
      if (red && !lead.v.isPolice) continue;
      if (!canStop(lead, o, impatient)) return true;
      const u = lead.v;
      const j = u.edge === o ? u.move.out[u.lane] : -1;
      if (v && v.wait > 0 && u.wait > v.wait && j >= 0 && o.len - lead.s - u.half < 2 && room(u.move.to, j, u)) return true;
    }
    return false;
  }

  // How far along curve c, out of two-way edge e, v can pull forward before its front corner reaches the
  // oncoming lanes (left of the centre line): where it waits for a gap to turn left
  const corner = { x: 0, z: 0, dx: 0, dz: 1 };
  function yieldPoint(v, c, e) {
    let cs = 0;
    for (; cs < c.len; cs += 0.5) {
      curvePoint(c, cs + v.half, corner);
      const x = corner.x + corner.dz * v.halfWidth;
      const z = corner.z - corner.dx * v.halfWidth;
      if ((x - e.x0) * e.rx + (z - e.z0) * e.rz < 0.3) break;
    }
    return cs - 0.5;
  }

  // At unsignalized corners, give way to the main road. Police passing a non-green signal yield to approaching
  // cross traffic as well as vehicles already in the intersection, instead of treating the light as a clear road.
  function yieldToCrossTraffic(v, n) {
    for (const a of n.in) {
      if (n.signal ? a.axisIndex === v.edge.axisIndex : a.axisIndex !== 0) continue;
      for (const list of a.occ) {
        const lead = leadOf(list);
        if (lead && !canStop(lead, a, !n.signal && v.wait > 8)) return true;
      }
    }
    return false;
  }

  // Seconds v takes to cover dist metres from now, speeding up from rest if it has to
  const timeTo = (v, dist) => dist / Math.max(v.speed, Math.sqrt((v.driver.a * dist) / 2), 0.1);

  // Do people on crosswalk `side` of n have the WALK? Across the main road with the side road's traffic, across a side
  // road with the main road's.
  function walkOn(n, side) {
    if (!n.lights) return true; // no signals here
    n.askedAt[side] = clock; // asking is what brings the light round
    return n.lights.mayWalk(n.sideLight[side], WALK_SECONDS);
  }

  // May p step off the curb onto its crosswalk? On the WALK (early in the parallel traffic's green, so red for the
  // traffic arriving over it), once no vehicle is crossing it or committed to, and none is too close to stop
  function mayCross(p) {
    const n = p.node;
    if (!walkOn(n, p.side) || n.crossing[p.side] > 0) return false;
    const e = n.approach[p.side];
    if (e) {
      for (const list of e.occ) {
        const lead = leadOf(list);
        if (lead && !canStop(lead, e, true)) return false;
      }
    }
    n.lights?.walking(WALK_SECONDS); // the light waits for them to get across
    return true;
  }

  // Will anyone on crosswalk `side` of n be within reach of the lane meeting it at `coord` between t0 and t1
  // seconds from now? Unless `onIt`, so is anyone waiting at the curb to step off, however far away: on the WALK, they
  // only wait for the vehicles already holding the crosswalk.
  function pedestrianOn(n, side, coord, t0, t1, onIt = false) {
    for (const p of n.walkers) {
      if (p.side !== side || (onIt && p.waiting)) continue;
      const toGo = (coord - p.coord) * p.dir; // metres p still has to walk to get there
      const avoiding = clock < p.avoidUntil;
      // Runners may enter a lane sooner, then slow or stop before clearing it.
      const fast = Math.max(p.speed, p.v, avoiding ? p.avoidSpeed : 0);
      const slow = Math.max(0.1, avoiding ? Math.min(p.speed, p.v, p.avoidSpeed) : p.speed);
      if (p.waiting || ((toGo + 2.6) / slow > t0 && (toGo - 2.6) / fast < t1)) return true;
    }
    return false;
  }

  // ...on the crosswalk v leaves the intersection over, while v, its front bumper d metres before it, passes? Once v
  // holds that crosswalk (it isn't waiting inside to turn), people at the curb wait for it.
  const pedsOut = (v, d) => d > 0 && pedestrianOn(v.edge.to, v.move.to.outSide, laneCoord(v.move.to, v.out), timeTo(v, d), timeTo(v, d + 3 + 2 * v.half), !v.yielding);

  // Must v, pulled into the intersection to turn, wait there: for people crossing its way out (`peds`) or, turning
  // left, for oncoming traffic?
  const holdsOn = (v, peds) => peds || (v.move.turn === 'L' && yieldOncoming(v.edge.opposite, false));

  // Of two vehicles on the same road headed for the same lane, the one whose front is nearer the line goes first (by
  // the front: a bus waiting at the line goes before the cars that pull up beside it)
  const precedence = (u, s) => s + u.half;

  // Would there be room for v in lane j of edge f if everyone headed there queued bumper to bumper behind its far
  // stop line? (An empty lane always has room, however short.) Vehicles take turns for it: whoever has waited longer
  // to go there from another side, or goes first from v's own road, counts as already in.
  // Whose turn it is, of vehicles after the same place: whoever has waited longest, then whoever's nearest. One order for all of
  // them. With position deciding within a road and waiting across roads, three cars could each yield to the next for ever
  // (the off-ramp at the north end of the Harbour Bridge did, and held up North Sydney and the deck behind it).
  function goesFirst(o, os, v, vs) {
    if (o.wait !== v.wait) return o.wait > v.wait;
    return precedence(o, os) > precedence(v, vs);
  }

  function room(f, j, v) {
    let free = f.len - 1;
    // A car driving away takes up less of the road than one standing: by the time v gets there, it's further on
    for (const o of f.occ[j]) if (o.v !== v && o.s - o.v.half < f.len) free -= Math.max(0, 2 * o.v.half + o.v.driver.s0 - o.v.speed * MOVING_ROOM);
    for (const a of f.from.in) {
      for (const list of a.occ) {
        const o = leadOf(list);
        if (!o || o.v.claimed || !o.v.move || o.v.move.to !== f || o.v.move.out[o.v.lane] !== j) continue;
        if (goesFirst(o.v, o.s, v, v.s)) free -= 2 * o.v.half + o.v.driver.s0;
      }
    }
    return free >= Math.min(2 * v.half + 0.5, f.len - 1);
  }

  // Would v, crossing into lane j of f to arrive at position vs, come alongside another vehicle headed there, cut in
  // ahead of one closing in on it, or close in on one ahead in a lane beside (which it doesn't follow)? Turning buses
  // swing wide, so where a bus turns, the lanes either side count too, and for one turning beside v from v's road, so
  // does how far apart they start turning (the outer one has further to go: side by side on f may be one behind the
  // other at the line, and the other way round).
  function alongside(f, j, v, vs, turn) {
    for (let k = Math.max(0, j - 1); k <= Math.min(f.lanes.length - 1, j + 1); k++) {
      for (const o of f.occ[k]) {
        const swing = turn && (v.bus || o.v.bus);
        if (o.v === v || (k !== j && !swing)) continue;
        let lo = o.s - vs; // how far ahead of v o is
        let hi = lo;
        if (swing && o.v.edge === v.edge) {
          const atLine = (o.v.conn ? v.edge.len + o.v.cs : o.v.s) - v.s;
          lo = Math.min(lo, atLine);
          hi = Math.max(hi, atLine);
        }
        const closing = hi < 0 ? o.v.speed - v.speed : lo > 0 && k !== j ? v.speed - o.v.speed : 0;
        const w = o.v.half + v.half + 1 + 2 * Math.max(0, closing);
        if (lo < w && hi > -w) return true;
      }
    }
    return false;
  }

  // Is a bus at the line in the lane on the outside of v's turn? A bus starting to turn swings its tail out over it.
  function besideTail(v) {
    const e = v.edge;
    const k = v.lane + (v.move.turn === 'R' ? -1 : 1);
    const o = v.move.turn !== 'S' && k >= 0 && k < e.lanes.length ? leadOf(e.occ[k]) : null;
    return !!o && o.v.bus && o.v !== v && e.len - o.s - o.v.half < 2;
  }

  // The lead of another of v's lanes that goes first into lane j of f or, turning where a bus is involved, into a lane
  // beside it (turning buses swing wide): v falls in behind it. As an entry { v, s } of f's lane: where it would be on
  // f now.
  const merger = { v: null, s: 0 };
  function mergingAhead(v, f, j) {
    const e = v.edge;
    merger.v = null;
    for (let i = 0; i < e.lanes.length; i++) {
      const o = i === v.lane ? null : leadOf(e.occ[i]);
      if (!o || o.v === v || o.v.claimed || o.v.move.to !== f || !goesFirst(o.v, o.s, v, v.s)) continue;
      if (o.v.bus && besideTail(o.v)) continue; // it waits for the bus beside its tail
      const oj = o.v.move.out[o.v.lane];
      if (oj < 0 || (oj !== j && !(Math.abs(oj - j) === 1 && v.move.turn !== 'S' && (v.bus || o.v.bus)))) continue;
      const s = o.s - e.len - connector(e, o.v.lane, f, oj).len;
      if (!merger.v || s < merger.s) {
        merger.v = o.v;
        merger.s = s;
      }
    }
    return merger.v ? merger : null;
  }

  // May v, its front bumper d metres before the stop line, enter the intersection now? Sets the exit lane.
  // Once too close to stop, v is committed: it goes, and holds the intersection from then on.
  function mayEnter(v, d) {
    const e = v.edge;
    const n = e.to;
    const phase = n.signal ? phaseOf(e) : 'green';
    // Could it still stop? For a light that isn't green, also by crawling up to it, closer than it stops for lines
    const stoppable = canStopBefore(v, d) || (phase !== 'green' && v.speed * v.speed < 2 * v.driver.b * d);
    if (stoppable) v.commit = null; // could stop after all: decide afresh
    if (v.commit === n) return true;
    if (v.move.out[v.lane] < 0) {
      // missed the lane for the planned move: go wherever this lane goes instead
      if (d > 12) return false;
      v.move = chooseMove(v, true);
    }
    const m = v.move;
    const f = m.to;
    const j = m.out[v.lane];
    if (!(j >= 0 && j < f.lanes.length)) {
      if (!mayEnter.warned) {
        mayEnter.warned = true;
        console.warn('[traffic] lane leads nowhere', { lane: v.lane, lanes: e.lanes.length, out: m.out.slice(), moves: e.moves.length, x: Math.round(v.x), z: Math.round(v.z) });
      }
      return false;
    }
    if (!v.isPolice && (phase === 'red' || (phase === 'amber' && stoppable))) return false;
    if (n.joint) {
      // Nothing to wait for: only the car ahead, which it follows through
      v.out = j;
      v.yielding = false;
      if (!stoppable) {
        v.commit = n;
        claim(v);
      }
      return true;
    }
    if (boxBusy(n, e.axisIndex)) return false; // crossing traffic inside
    const lead = ahead(e.occ[v.lane], v.s, v);
    if (lead && lead.v.yielding) return false; // the vehicle ahead waits inside to turn: wait behind the line
    if (v.bus && besideTail(v)) return false; // its tail would swing out over that bus as it starts to turn
    // At a signal, the first in line to turn pulls into the intersection to wait there for the people crossing the
    // road it turns into (they walk on the same green): short of their crosswalk or, turning left across oncoming
    // traffic, short of the oncoming lanes until there is a gap. The light changing stops both for it at the latest.
    const c = connector(e, v.lane, f, j);
    const first = n.signal && (!v.isPolice || phase === 'green') && m.turn !== 'S' && !lead;
    const across = m.turn === 'L' && !!e.opposite;
    const wait = first ? (across ? yieldPoint(v, c, e) : c.len - 3 - v.half) : -1; // < 0: no room inside to wait
    if (m.turn === 'L' ? across && wait < 0 && yieldOncoming(e.opposite, v.wait > 8, v) : e.opposite && e.opposite.lefts > 0) return false;
    if ((n.signal ? v.isPolice && phase !== 'green' : e.axisIndex !== 0) && yieldToCrossTraffic(v, n)) return false;
    // nobody on the crosswalks while it passes over them, on the way in and on the way out, and a free place to
    // clear the intersection to, taking turns with lanes merging into it
    if (pedestrianOn(n, e.inSide, laneCoord(e, v.lane), 0, timeTo(v, d + 2.5 + 2 * v.half))) return false;
    if (wait < 0 && pedestrianOn(n, f.outSide, laneCoord(f, j), timeTo(v, d + c.len - 3), timeTo(v, d + c.len + 2 * v.half))) return false;
    const vs = v.s - e.len - c.len; // where on f it would be now
    if (!room(f, j, v) || alongside(f, j, v, vs, m.turn !== 'S') || mergingAhead(v, f, j)) return false;
    v.out = j;
    v.yielding = wait >= 0;
    v.yieldAt = wait;
    if (!stoppable) {
      v.commit = n;
      claim(v); // at once, so vehicles and pedestrians deciding later this frame know
    }
    return true;
  }

  // Overtake into an adjacent lane when it is clearly quicker (MOBIL), or work towards a lane the planned turn
  // can be made from; either only if neither v nor its new follower has to brake hard for it. Not while still
  // pulling out of an intersection or dodging the player, nor in the last 12 m before the next.
  function changeLanes(v) {
    const e = v.edge;
    if (v.conn || v.commit || clock < v.panicUntil) return;
    if (Math.abs(v.dl) > 0.5 || v.s < v.half || e.len - v.s - v.half < 12) return;
    let target = -1;
    if (v.move.out[v.lane] < 0) {
      const t = v.lane + Math.sign(nearestLane(v.move, v.lane) - v.lane);
      if (laneSafe(v, t, -4)) target = t;
    } else if (v.speed > 2) {
      let best = laneAcc(v, v.lane) + 0.6;
      for (let t = v.lane - 1; t <= v.lane + 1; t += 2) {
        if (t < 0 || t >= e.lanes.length || v.move.out[t] < 0 || !laneSafe(v, t, -3)) continue;
        const acc = laneAcc(v, t);
        if (acc > best) {
          best = acc;
          target = t;
        }
      }
    }
    if (target < 0) return;
    v.dl += (e.lanes[v.lane] - e.lanes[target]) * DRIVE_SIDE; // same spot, now measured from the new lane's centre
    v.lane = target;
    v.trail = null;
  }

  // Can v move into lane t leaving itself and its new follower at least bSafe (negative) acceleration?
  function laneSafe(v, t, bSafe) {
    let lead = null;
    let back = null;
    for (const o of v.edge.occ[t]) {
      if (o.v === v) continue;
      if (o.s > v.s) {
        lead = o;
        break;
      }
      back = o;
    }
    if (lead) {
      const gap = lead.s - lead.v.half - v.s - v.half;
      if (gap < 1.5 || freeAcc(v) + brake(v, gap, lead.v.speed) < bSafe) return false;
    }
    if (back) {
      const f = back.v;
      const gap = v.s - v.half - back.s - f.half;
      if (gap < 1.5 || freeAcc(f) + brake(f, gap, v.speed) < bSafe) return false;
    }
    const off = (v.edge.lanes[t] - v.edge.lanes[v.lane]) * DRIVE_SIDE - v.dl;
    const reach = v.half + player.halfL + 6;
    return !(Math.abs(v.pRight - off) < v.halfWidth + player.halfW + 0.4 && v.pAhead > -reach && v.pAhead < reach);
  }

  // Acceleration v would have in lane t behind the vehicle (or player) ahead there
  function laneAcc(v, t) {
    const o = ahead(v.edge.occ[t], v.s, v);
    let worst = o ? brake(v, o.s - o.v.half - v.s - v.half, o.v.speed) : 0;
    const pg = playerGap(v, (v.edge.lanes[t] - v.edge.lanes[v.lane]) * DRIVE_SIDE - v.dl);
    if (pg < LOOKAHEAD) worst = Math.min(worst, brake(v, pg, v.pSpeed));
    return freeAcc(v) + worst;
  }

  // Fastest v can take curve c at without exceeding the sideways acceleration its driver accepts
  // (no tighter than a car turns, 3 m: a curve's sharpest point, where it's tighter, isn't what a driver slows to)
  const bendSpeed = (v, c) => Math.sqrt(v.driver.aLat / Math.min(Math.max(c.curv, 1e-3), 1 / 3));

  // IDM acceleration for vehicles ahead in the lane (and, through the intersection, in the lane it leads to),
  // the stop line while v may not go, a red beyond, the player, and slowing down for turns and give-way lines
  function accelerate(v) {
    const e = v.edge;
    let worst = 0;
    let cap = Infinity;
    v.gap = Infinity;
    if (!v.conn) {
      worst = follow(v, e.occ[v.lane], v.s);
      const side = straddle(v);
      if (side) worst = Math.min(worst, follow(v, e.occ[v.lane + side], v.s));
      const d = e.len - v.s - v.half;
      if (d < LOOKAHEAD) {
        const go = mayEnter(v, d);
        const f = v.move.to;
        const j = v.move.out[v.lane];
        const c = j < 0 ? null : connector(e, v.lane, f, j);
        const vs = c ? v.s - e.len - c.len : 0; // position on f, measured from its start
        if (!go) {
          worst = Math.min(worst, stopAt(v, d));
        } else {
          worst = Math.min(worst, follow(v, f.occ[j], vs), signalAhead(v, f, f.len - vs - v.half));
          // pulling in to wait inside: slow down for that spot already if it will have to wait there
          if (v.yielding && holdsOn(v, pedsOut(v, d + c.len - 3))) worst = Math.min(worst, stopAt(v, d + v.half + v.yieldAt, 0.5));
        }
        // easing off to fall in behind a vehicle from another lane merging ahead into the same lane (unless committed:
        // then the others wait for v)
        const o = c && !v.claimed && mergingAhead(v, f, j);
        if (o) worst = Math.min(worst, Math.max(-v.driver.b, brake(v, o.s - o.v.half - vs - v.half, o.v.speed)));
        let vt = c ? bendSpeed(v, c) : Infinity;
        const cautious = e.to.signal ? v.isPolice && phaseOf(e) !== 'green' : !e.to.joint && e.axisIndex !== 0;
        if (cautious) vt = Math.min(vt, 5);
        cap = Math.sqrt(vt * vt + 5 * Math.max(0, d));
      }
    } else {
      const f = v.move.to;
      const vs = v.cs - v.conn.len;
      worst = Math.min(follow(v, f.occ[v.out], vs), follow(v, e.occ[v.lane], e.len + v.cs), signalAhead(v, f, f.len - vs - v.half));
      // someone crossing the way out: wait for them inside the intersection, short of the 2.5 m crosswalk
      const d = v.conn.len - 3 - v.cs - v.half;
      const peds = pedsOut(v, d);
      if (v.yielding && v.cs < v.yieldAt && holdsOn(v, peds)) {
        worst = Math.min(worst, stopAt(v, v.yieldAt - v.cs, 0.5)); // waiting inside to turn
      } else {
        if (v.yielding) cross(v);
        if (peds) worst = Math.min(worst, stopAt(v, d, 0.5));
      }
      cap = bendSpeed(v, v.conn);
    }
    const pg = playerGap(v, 0);
    if (pg > 0 && pg < LOOKAHEAD) { // (a player alongside, not yet clear ahead, isn't one to follow)
      worst = Math.min(worst, brake(v, pg, v.pSpeed));
      if (pg < v.gap) {
        v.gap = pg;
        v.leaderSpeed = v.pSpeed;
      }
    }
    const acc = Math.min(freeAcc(v) + worst, (cap - v.speed) * 2);
    v.acc = clamp(acc, -9, v.driver.a);
    // dodging the player: braking (as hard as it can, unless that would stop it before it has swerved out of the way),
    // or flooring it (unless it must brake for something ahead)
    if (clock < v.panicUntil) {
      if (v.panicAcc < 0) v.acc = Math.min(v.acc, v.evade ? -v.driver.b : -v.driver.bMax);
      else if (v.acc > -v.driver.b && v.speed < 1.5 * v.v0) v.acc = Math.max(v.acc, 1.5 * v.driver.a);
    }
  }

  // Dodging the player, as people do: late, and without second thoughts. A driver who sees the player about to hit it
  // (within AVOID_NOTICE seconds, both keeping on as they go) reacts only once that has lasted its reaction time, by
  // when it is almost too late. Then it commits to one manoeuvre: braking if the player would hit its front half (hard,
  // unless it swerves too: a car that stops can't get out of the way), flooring it if its rear half (braking would only
  // make that worse), and swerving to one side if the road is clear
  // there: away from the player (behind a player crossing its way, to the right if the player comes straight at it),
  // unless there is more room the other way.
  // It keeps that up for AVOID_HOLD seconds at least, and for as long as the player is still about to hit it.
  function react(v, dt) {
    const t = player.active && v.impactTime === 0 && onPlayersLevel(v) ? threatTime(v) : Infinity;
    if (v.impactTime > 0 || (v.panicUntil && clock >= v.panicUntil)) {
      v.evade = v.panicUntil = v.panicAcc = v.alarm = 0; // hit after all, or over
    }
    if (v.panicUntil) {
      if (t < AVOID_NOTICE) v.panicUntil = Math.max(v.panicUntil, clock + 0.5);
      return;
    }
    if (t >= AVOID_NOTICE) {
      v.alarm = 0;
      return;
    }
    v.alarm += dt;
    if (v.alarm < v.reaction) return;
    v.panicUntil = clock + AVOID_HOLD;
    v.panicAcc = threat.ahead < 0 ? 1 : -1;
    if (v.speed < 2) return;
    // where the player will be across v's way a moment after it would hit: v swerves away from there, or the other way
    // if there is more room on that side
    const later = threat.aside + threat.across * 0.5;
    const side = Math.abs(later) < 0.3 ? 1 : -Math.sign(later);
    const room = swerveRoom(v, side);
    const other = swerveRoom(v, -side);
    v.evade = other > room ? -side * other : side * room;
  }

  // Seconds until the player would hit v (with a little margin), both keeping on straight as they go; Infinity if not
  // within AVOID_NOTICE. Where it would hit goes in `threat`: the player's position ahead of v and to its right then,
  // and its speed across v's heading.
  const threat = { ahead: 0, aside: 0, across: 0 };
  function threatTime(v) {
    const dx = player.x - v.x;
    const dz = player.z - v.z;
    if (Math.abs(dx) > 90 || Math.abs(dz) > 90) return Infinity;
    const hx = Math.sin(v.yaw);
    const hz = Math.cos(v.yaw);
    const ahead = dx * hx + dz * hz;
    const aside = dz * hx - dx * hz;
    const along = player.vx * hx + player.vz * hz - v.speed;
    const across = player.vz * hx - player.vx * hz;
    // the player's half extents along and across v's heading, as it is turned
    const c = Math.abs(player.fx * hx + player.fz * hz);
    const s = Math.abs(player.fz * hx - player.fx * hz);
    const reachAhead = v.halfL + player.halfL * c + player.halfW * s + 0.3;
    const reachAside = v.halfWidth + player.halfL * s + player.halfW * c + 0.3;
    let enter = 0;
    let exit = AVOID_NOTICE;
    for (let k = 0; k < 2; k++) {
      const p = k ? aside : ahead;
      const m = k ? across : along;
      const r = k ? reachAside : reachAhead;
      if (Math.abs(m) < 1e-6) {
        if (Math.abs(p) >= r) return Infinity;
        continue;
      }
      const t0 = (-r - p) / m;
      const t1 = (r - p) / m;
      enter = Math.max(enter, Math.min(t0, t1));
      exit = Math.min(exit, Math.max(t0, t1));
    }
    if (enter >= exit) return Infinity;
    threat.ahead = ahead + along * enter;
    threat.aside = aside + across * enter;
    threat.across = across;
    return enter;
  }

  // How far right (side 1) or left (-1) of its lane centre v can swerve: well over, a little, or not at all, as far as
  // the road is clear beside it there and a little way ahead
  function swerveRoom(v, side) {
    const rx = -v.tz;
    const rz = v.tx;
    for (const r of [2.2, 1.2]) {
      const off = side * (r + v.halfWidth) - v.dl;
      let clear = true;
      for (const a of [0, v.half + v.speed * 0.6]) {
        if (!network.isRoadClear(v.x + rx * off + v.tx * a, v.z + rz * off + v.tz * a, 0.2)) clear = false;
      }
      if (clear) return r;
    }
    return 0;
  }

  // Front bumper at the stop line: cross if allowed, or if going too fast to stop; otherwise wait there
  function enter(v) {
    const e = v.edge;
    if (!mayEnter(v, 0)) {
      const j = v.move.out[v.lane];
      if (v.speed < 4 || j < 0) {
        v.s = e.len - v.half;
        v.speed = 0;
        return;
      }
      v.out = j;
      v.yielding = false;
    }
    v.cs = v.s - e.len;
    v.conn = connector(e, v.lane, v.move.to, v.out);
    claim(v); // at once, so vehicles deciding later this frame know
  }

  function leave(v) {
    v.s = v.cs - v.conn.len;
    v.edge = v.move.to;
    v.lane = v.out;
    v.trail = v.conn; // the rear axle is still on it
    v.conn = null;
    v.commit = null;
    v.move = chooseMove(v, false);
  }

  function drive(v, dt) {
    v.laneTimer -= dt;
    if (v.laneTimer <= 0) {
      v.laneTimer = 0.4 + Math.random() * 0.3;
      changeLanes(v);
    }
    accelerate(v);
    // Give the driver a moment to recover after an impact before accelerating again.
    v.impactTime = Math.max(0, v.impactTime - dt);
    if (v.impactTime > 0) v.acc = Math.min(0, v.acc);
    const speed = v.speed;
    v.speed = Math.max(0, v.speed + v.acc * dt);
    let ds = v.speed * Math.cos(v.nose) * dt; // (along its path, heading off it as it may be)
    if (v.impactTime === 0 && ds > v.gap - 0.3) {
      // never into the vehicle ahead
      ds = Math.max(0, v.gap - 0.3);
      v.speed = Math.min(v.speed, v.leaderSpeed);
    }
    v.acc = Math.max(-9, (v.speed - speed) / dt); // as driven, for the body to pitch with: none standing still
    v.wait = v.speed < 0.5 ? v.wait + dt : 0;
    if (!v.conn) {
      v.s += ds;
      if (v.s + v.half >= v.edge.len) enter(v);
    } else {
      v.cs += ds;
      if (v.cs >= v.conn.len) leave(v);
    }
    steer(v, dt);
  }

  // The driver at the wheel. It steers for the bend in its path a moment ahead (on through the intersection ahead the
  // way it plans to cross it), to head along its path, and back onto it: onto its lane centre after lane changes and
  // knocks, or right of it by however far it swerves out of the player's way (Stanley steering). It turns the front
  // wheels no faster than a person does and no further than it is comfortable with (or, in a panic, than the tyres
  // grip). The car turns only as fast as its front wheels turn it, the tyres sliding at their grip; a knock's spin
  // turns it too, the tyres scrubbing that off. Heading off its path, it drifts across it.
  const bendA = { x: 0, z: 0, dx: 0, dz: 1 };
  const bendB = { x: 0, z: 0, dx: 0, dz: 1 };
  function steer(v, dt) {
    const panic = !!v.evade;
    const wheelbase = 2 * v.axle;
    const c = v.conn ? v.cs : v.s;
    // the bend a moment ahead, as the wheel takes a while to turn: its curvature (to the left) over 2 m
    const ahead = v.axle + 0.5 * v.speed;
    previewPoint(v, c + ahead, bendA);
    previewPoint(v, c + ahead + 2, bendB);
    let bend = Math.atan2(bendB.dx, bendB.dz) - Math.atan2(bendA.dx, bendA.dz);
    bend -= Math.round(bend / (Math.PI * 2)) * Math.PI * 2;
    // ...plus how far right of its path it heads, and how far right of where it should be it is (nose and dl - evade)
    const off = v.dl - (v.evade || 0);
    const want = Math.atan((wheelbase * bend) / 2) + v.nose + Math.atan(((panic ? 3 : 1.2) * off) / (1 + v.speed));
    const lateral = panic ? v.driver.grip : 1.3 * v.driver.aLat; // the sideways acceleration it steers up to
    const most = Math.min(v.driver.lock, Math.atan((lateral * wheelbase) / Math.max(v.speed * v.speed, 1e-3)));
    const rate = v.driver.steerRate * (panic ? 2.5 : clamp(8 / Math.max(v.speed, 1), 1, 3)) * dt;
    v.delta += clamp(clamp(want, -most, most) - v.delta, -rate, rate);
    const slide = v.driver.grip / Math.max(v.speed, 0.1);
    v.yawRate = clamp((v.speed * Math.tan(v.delta)) / wheelbase, -slide, slide);
    v.yaw += (v.yawRate + v.yawVel) * dt;
    v.yaw -= Math.round(v.yaw / (Math.PI * 2)) * Math.PI * 2;
    v.yawVel *= Math.exp(-4 * dt);
    if (Math.abs(v.yawVel) < 1e-3) v.yawVel = 0;
    // across its path, heading off it (nose: how far right of its path it heads)
    let nose = Math.atan2(v.tx, v.tz) - v.yaw;
    nose -= Math.round(nose / (Math.PI * 2)) * Math.PI * 2;
    v.dlv = v.speed * Math.sin(nose);
    v.dl += v.dlv * dt;
  }

  // Point and direction c metres along v's path, as pathPoint, but on through the intersection ahead the way v plans
  // to cross it
  function previewPoint(v, c, out) {
    const e = v.edge;
    const j = v.conn || c <= e.len ? -1 : v.move.out[v.lane];
    if (!(j >= 0)) return pathPoint(v, c, out);
    const k = connector(e, v.lane, v.move.to, j);
    if (c - e.len <= k.len) return curvePoint(k, c - e.len, out);
    return lanePoint(v.move.to, j, c - e.len - k.len, out);
  }

  // Point and direction at distance c along v's path: its lane, the curve through the intersection, and the
  // lane after it (or, just out of an intersection, the curve it came along)
  function lanePoint(e, i, s, out) {
    out.x = e.sx + e.dx * s + e.rx * e.lanes[i];
    out.z = e.sz + e.dz * s + e.rz * e.lanes[i];
    out.dx = e.dx;
    out.dz = e.dz;
    return out;
  }
  function pathPoint(v, c, out) {
    const e = v.edge;
    if (v.conn) {
      if (c < 0) return lanePoint(e, v.lane, e.len + c, out);
      if (c > v.conn.len) return lanePoint(v.move.to, v.out, c - v.conn.len, out);
      return curvePoint(v.conn, c, out);
    }
    if (c < 0 && v.trail) return curvePoint(v.trail, v.trail.len + c, out);
    return lanePoint(e, v.lane, c, out);
  }

  // World position from where v is along its path (dl to the right of it), the path's direction there, and how far
  // right of it v heads (nose)
  const at = { x: 0, z: 0, dx: 0, dz: 0 };
  function locate(v) {
    pathPoint(v, v.conn ? v.cs : v.s, at);
    v.tx = at.dx;
    v.tz = at.dz;
    v.x = at.x - at.dz * v.dl;
    v.z = at.z + at.dx * v.dl;
    const nose = Math.atan2(at.dx, at.dz) - v.yaw;
    v.nose = nose - Math.round(nose / (Math.PI * 2)) * Math.PI * 2;
  }

  // Move v along and across its path by (dx, dz), as far as the road allows
  function shove(v, dx, dz) {
    const along = dx * v.tx + dz * v.tz;
    if (v.conn) v.cs = clamp(v.cs + along, -v.half, v.conn.len - 0.01);
    else v.s = clamp(v.s + along, 0, v.edge.len - v.half);
    v.dl = clamp(v.dl + dz * v.tx - dx * v.tz, -2.5, 2.5);
    locate(v);
  }

  // Steering shown on the front wheels, turn signals, and body pitch & roll from acceleration & turning (the heading
  // itself is the driver's doing, see steer)
  function pose(v, dt) {
    v.steer = v.delta;

    const turn = v.move.turn;
    if (v.evade) v.blink = 0; // no time to signal a swerve
    else if (Math.abs(v.dl) > 0.3 && Math.abs(v.dlv) > 0.05) v.blink = v.dl > 0 ? -1 : 1;
    else if (turn !== 'S' && (v.conn || v.edge.len - v.s < 35)) v.blink = (turn === 'R' ? 1 : -1) * DRIVE_SIDE;
    else v.blink = 0;

    v.pitchVel += ((-0.008 * v.acc - v.pitch) * 68.0 - v.pitchVel * 10.8) * dt;
    v.pitch = clamp(v.pitch + v.pitchVel * dt, -0.22, 0.22);
    v.rollVel += ((0.01 * v.speed * v.yawRate - v.roll) * 68.0 - v.rollVel * 10.8) * dt;
    v.roll = clamp(v.roll + v.rollVel * dt, -0.26, 0.26);
  }

  // Knock velocity from collisions carries v along and across its path, and dies down
  function knock(v, dt) {
    if (v.vx === 0 && v.vz === 0) return;
    shove(v, v.vx * dt, v.vz * dt);
    const damp = Math.exp(-3.5 * dt);
    v.vx *= damp;
    v.vz *= damp;
    if (v.vx * v.vx + v.vz * v.vz < 1e-4) v.vx = v.vz = 0;
  }

  const contactA = {}, contactB = {}, vehicleHit = {};
  const impacted = [];
  let collisionStep = 0;

  function readTrafficBody(v, body) {
    const heading = v.yaw + v.yawOffset;
    body.x = v.x; body.z = v.z;
    body.prevX = v.prevX; body.prevZ = v.prevZ;
    body.sin = Math.sin(heading); body.cos = Math.cos(heading);
    body.halfW = v.halfWidth;
    // Vehicles without their own collision size & mass count as sedans
    body.halfL = v.halfL ?? 2.18;
    body.mass = v.mass ?? 1600;
    body.vx = body.sin * v.speed + v.vx;
    body.vz = body.cos * v.speed + v.vz;
    body.angularVel = v.yawRate + v.yawVel;
  }

  function writeTrafficVelocity(v, body) {
    // Keep longitudinal momentum in the driving speed, so it does not disappear
    // with the short-lived tire slip. Traffic can be knocked backwards too.
    const hx = Math.sin(v.yaw + v.yawOffset);
    const hz = Math.cos(v.yaw + v.yawOffset);
    v.speed = Math.max(0, body.vx * hx + body.vz * hz);
    v.vx = body.vx - hx * v.speed;
    v.vz = body.vz - hz * v.speed;
    // the spin turns its heading (see steer)
    v.yawVel = body.angularVel - v.yawRate;
  }

  function impactSuspension(v, nx, nz, speed) {
    const along = nx * v.tx + nz * v.tz;
    const across = nx * v.tz - nz * v.tx;
    const kick = Math.min(10, speed);
    v.pitchVel += along * kick * 0.12;
    v.rollVel -= across * kick * 0.16;
    v.impactTime = Math.max(v.impactTime, 0.8);
  }

  function collideWithPlayer(v) {
    const pe = player.entity;
    const reach = v.half + player.halfL + player.halfW;
    const prevX = pe.prevX ?? pe.position.x, prevZ = pe.prevZ ?? pe.position.z;
    const dx = pe.position.x - prevX - v.x + v.prevX;
    const dz = pe.position.z - prevZ - v.z + v.prevZ;
    if (Math.abs(pe.position.x - v.x) > reach + Math.abs(dx)
      || Math.abs(pe.position.z - v.z) > reach + Math.abs(dz)) return;
    const a = contactA, b = contactB, hit = vehicleHit;
    const heading = pe.heading || 0;
    a.x = pe.position.x; a.z = pe.position.z;
    a.prevX = prevX; a.prevZ = prevZ;
    a.sin = Math.sin(heading); a.cos = Math.cos(heading);
    a.halfW = player.halfW; a.halfL = player.halfL;
    a.mass = pe.type === 'car' ? 1700 : pe.type === 'cyclist' ? 95 : 80;
    a.vx = a.sin * (pe.speed || 0) + (pe.vx || 0);
    a.vz = a.cos * (pe.speed || 0) + (pe.vz || 0);
    a.angularVel = pe.type === 'car' ? pe.angularVel || 0 : 0;
    readTrafficBody(v, b);
    if (!sweptVehicleContact(a, b, hit) && !vehicleContact(a, b, hit)) return;
    const speed = resolveVehicleContact(a, b, hit);
    const pShare = b.mass / (a.mass + b.mass);
    pe.position.x = hit.ax + hit.nx * hit.depth * pShare;
    pe.position.z = hit.az + hit.nz * hit.depth * pShare;
    shove(v, hit.bx - v.x - hit.nx * hit.depth * (1 - pShare), hit.bz - v.z - hit.nz * hit.depth * (1 - pShare));
    // A route boundary can prevent traffic taking its full share of the correction.
    const remainder = Math.max(0, hit.depth * (1 - pShare) + (v.x - hit.bx) * hit.nx + (v.z - hit.bz) * hit.nz);
    pe.position.x += hit.nx * remainder;
    pe.position.z += hit.nz * remainder;
    if (pe.mesh) pe.mesh.position.copy(pe.position);
    if (speed <= 0) return;

    writeTrafficVelocity(v, b);
    pe.speed = a.vx * a.sin + a.vz * a.cos;
    if (pe.type === 'car') {
      pe.vx = a.vx - a.sin * pe.speed;
      pe.vz = a.vz - a.cos * pe.speed;
      pe.angularVel = a.angularVel;
      const kick = Math.min(12, hit.impulse / a.mass);
      pe.pitchVel += (hit.nx * a.sin + hit.nz * a.cos) * kick * 0.16;
      pe.rollVel -= (hit.nx * a.cos - hit.nz * a.sin) * kick * 0.2;
      pe.heaveVel += Math.min(0.7, kick * 0.06);
    }
    impactSuspension(v, -hit.nx, -hit.nz, hit.impulse / b.mass);
    if (pe.type !== 'person') reportCollision(pe, v, hit.x, 0.58, hit.z, hit.nx, hit.nz, speed);
    if (speed > 2.2) spawnCollisionSparks(hit.x, 0.58, hit.z, hit.nx, hit.nz, speed);
  }

  // Only disturbed traffic needs pair contacts. Newly struck cars join the same
  // queue, and each pair is visited once before any instance matrices are written.
  function collideTraffic() {
    collisionStep++;
    impacted.length = 0;
    for (const v of vehicles) {
      if (v.edge && (v.impactTime > 0 || Math.abs(v.yawVel) > 0.05 || v.vx * v.vx + v.vz * v.vz > 0.04)) {
        v.contactStep = collisionStep;
        impacted.push(v);
      }
    }
    for (let i = 0; i < impacted.length; i++) {
      const v = impacted[i];
      for (const o of vehicles) {
        if (o === v || !o.edge || o.contactDone === collisionStep || !sameLevel(heightOf(o), heightOf(v))) continue;
        const reach = v.half + o.half + 0.5;
        const dx = v.x - o.x, dz = v.z - o.z;
        if (Math.abs(dx) > reach + Math.abs(dx - v.prevX + o.prevX)
          || Math.abs(dz) > reach + Math.abs(dz - v.prevZ + o.prevZ)) continue;
        readTrafficBody(v, contactA);
        readTrafficBody(o, contactB);
        const hit = vehicleHit;
        if (!sweptVehicleContact(contactA, contactB, hit) && !vehicleContact(contactA, contactB, hit)) continue;
        const speed = resolveVehicleContact(contactA, contactB, hit);
        const share = contactB.mass / (contactA.mass + contactB.mass);
        shove(v, hit.ax - v.x + hit.nx * hit.depth * share, hit.az - v.z + hit.nz * hit.depth * share);
        shove(o, hit.bx - o.x - hit.nx * hit.depth * (1 - share), hit.bz - o.z - hit.nz * hit.depth * (1 - share));
        if (speed <= 0) continue;
        writeTrafficVelocity(v, contactA);
        writeTrafficVelocity(o, contactB);
        impactSuspension(v, hit.nx, hit.nz, hit.impulse / contactA.mass);
        impactSuspension(o, -hit.nx, -hit.nz, hit.impulse / contactB.mass);
        reportCollision(v, o, hit.x, 0.56, hit.z, hit.nx, hit.nz, speed);
        if (speed > 2.2) spawnCollisionSparks(hit.x, 0.56, hit.z, hit.nx, hit.nz, speed);
        if (o.contactStep !== collisionStep) {
          o.contactStep = collisionStep;
          impacted.push(o);
        }
      }
      v.contactDone = collisionStep;
    }
  }

  // =========================================================================
  // 6. PLACING VEHICLES
  // =========================================================================
  // Room at s in a lane list: margin metres to the vehicles either side, and two seconds more for the one behind
  function laneClear(list, s, margin) {
    for (const o of list) if (Math.abs(o.s - s) < o.v.half + margin + (o.s < s ? 2 * o.v.speed : 0)) return false;
    return true;
  }

  function place(v, e, lane, s) {
    v.edge = e;
    v.lane = lane;
    v.s = s;
    v.conn = null;
    v.trail = null;
    v.commit = null;
    v.yielding = false;
    v.wait = 0;
    v.speed = v.v0 * 0.5;
    v.acc = 0;
    v.impactTime = 0;
    v.dl = v.dlv = 0;
    v.evade = v.alarm = v.panicUntil = v.panicAcc = 0;
    v.vx = v.vz = v.yawOffset = v.yawVel = v.pitch = v.pitchVel = v.roll = v.rollVel = 0;
    locate(v);
    v.prevX = v.x;
    v.prevZ = v.z;
    v.yaw = Math.atan2(v.tx, v.tz); // (placed heading down its lane)
    v.nose = v.yawRate = v.steer = v.delta = 0;
    v.move = chooseMove(v, false);
    occupy(e.occ[lane], v, s);
  }

  // Put v in a free lane around the focus. Normal replenishment protects the near view; teleports can fill it.
  function spawnVehicle(v, rMin, rMax, protectView) {
    for (let attempt = 0, draws = 0; attempt < 12 && draws < 60; draws++) {
      const e = nearEdges[Math.floor(Math.random() * nearEdges.length)];
      // A quiet street is picked as often as it's full (roadShare): what isn't taken doesn't count as a try
      if (e && e.share < 1 && Math.random() >= e.share) continue;
      attempt++;
      if (!e || (v.bus && e.axis !== 'ave') || e.len < 2 * v.half + 10) continue;
      const lane = Math.floor(Math.random() * e.lanes.length);
      const along = (focusX - e.sx) * e.dx + (focusZ - e.sz) * e.dz;
      const minS = Math.max(v.half + 5, along - rMax);
      const maxS = Math.min(e.len - v.half - 5, along + rMax);
      if (minS > maxS) continue;
      const s = minS + Math.random() * (maxS - minS);
      const x = e.sx + e.dx * s + e.rx * e.lanes[lane];
      const z = e.sz + e.dz * s + e.rz * e.lanes[lane];
      const d = Math.hypot(x - focusX, z - focusZ);
      if (d < rMin || d > rMax || (protectView && nearView(x, z, v.half + 4, VEHICLE_SPAWN_DISTANCE))) continue;
      if (player.active && Math.hypot(x - player.x, z - player.z) < 25) continue;
      if (!laneClear(e.occ[lane], s, v.half + (e.deck ? DECK_SPAWN_GAP : 8))) continue;
      place(v, e, lane, s);
      return true;
    }
    return false;
  }

  // =========================================================================
  // 7. RENDERING
  // =========================================================================
  // Beyond CAR_PROXY_DISTANCE, cars use the ~250-triangle stand-in with built-in wheels instead of the full lofted
  // body + 4 separate wheel instances; vehicles outside the view frustum (with a margin for cast shadows and headlight
  // cones) are skipped altogether.
  const CAR_PROXY_DISTANCE = 90;
  const dirtyPaint = new Set();
  const dirtyState = new Set();
  let dirtyWheelStyles = false;
  const litVehicles = [];
  let litVehicleCount = 0;
  let wheelCars = 0;
  let visibleCars = 0;
  const policeDrawn = { sedan: 0, suv: 0 };
  let visibleBuses = 0;
  let updates = 0;

  function flagRange(attr, n) {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, n * attr.itemSize);
    attr.needsUpdate = true;
  }

  // Vehicles live on the flat simulation, each on the surface of the road it's on (js/surfaces.js): the ground, or a
  // structure. Roads stacked over each other share x and z, so two vehicles meet only when they're on one level.
  let dummyEdge = null;
  // The edge a vehicle's height comes from: its own, or the one it's turning into across a junction
  const levelOf = (v) => (v.edge?.sid || !(v.conn && v.move?.to?.sid) ? v.edge : v.move.to);
  const heightOf = (v) => (v.ry ??= edgeHeight(levelOf(v), v.x, v.z));
  const onPlayersLevel = (v) => sameLevel(heightOf(v), player.y);
  const slopeOn = (edge, x, z, sin, cos) => (edgeHeight(edge, x + sin * 2.5, z + cos * 2.5) - edgeHeight(edge, x - sin * 2.5, z - cos * 2.5)) / 5;
  function placeDummy() {
    const y = dummy.position.y;
    const { x, z } = dummy.position;
    dummy.position.set(x - origin.x, y + edgeHeight(dummyEdge, x, z), z - origin.z);
    dummy.updateMatrix();
    dummy.position.set(x, y, z);
  }

  // 3D spinning alloy wheels & tires (left & right, front & rear), exact 1:1 ground rolling, steering front wheels.
  // The wheel geometry is modelled at baseRadius (the sedan's 0.35 m car wheel), scaled to the vehicle's radius
  function placeWheels(v, i, rotY, roll, radius, halfTrack, halfBase, leftInst, rightInst, baseRadius = 0.35) {
    const sinY = Math.sin(rotY);
    const cosY = Math.cos(rotY);
    const scale = radius / baseRadius;
    dummy.scale.set(scale, scale, scale);
    for (let w = 0; w < 2; w++) {
      const wz = w === 0 ? halfBase : -halfBase;
      dummy.rotation.set(v.wheelSpin + w * 0.55, rotY + (w === 0 ? v.steer : 0), roll, 'YXZ');
      dummy.position.set(v.x - halfTrack * cosY + wz * sinY, radius, v.z + halfTrack * sinY + wz * cosY);
      placeDummy();
      leftInst.setMatrixAt(i * 2 + w, dummy.matrix);

      dummy.position.set(v.x + halfTrack * cosY + wz * sinY, radius, v.z - halfTrack * sinY + wz * cosY);
      placeDummy();
      rightInst.setMatrixAt(i * 2 + w, dummy.matrix);
    }
  }

  // Lamp state for the car & bus materials: brake lights while slowing down or standing, the turn signal on the side
  // v is heading for (left = +x)
  function writeLampState(v, array, o) {
    const blinkOn = v.blink !== 0 && (clock + v.blinkPhase) % 0.8 <= 0.4;
    array[o] = v.acc < -0.8 || v.speed < 0.3 ? 1 : 0;
    array[o + 1] = blinkOn && v.blink < 0 ? 1 : 0;
    array[o + 2] = blinkOn && v.blink > 0 ? 1 : 0;
  }

  function renderCar(c) {
    const rotY = c.yaw + c.yawOffset;
    const sinY = Math.sin(rotY);
    const cosY = Math.cos(rotY);
    const spec = BODY_SPECS[c.bodyType];
    const forwardDist = (c.x - c.prevX) * sinY + (c.z - c.prevZ) * cosY;
    const rawStep = forwardDist / spec.wheelRadius;
    c.wheelSpin = (c.wheelSpin + Math.sign(rawStep) * Math.min(Math.abs(rawStep), 0.48)) % (Math.PI * 2);
    if (hasView && !visible(c.x, c.z, 18)) return;

    const near = Math.hypot(c.x - focusX, c.z - focusZ) < CAR_PROXY_DISTANCE;
    const bodyInst = near ? bodies[c.bodyType].near : bodies[c.bodyType].far;
    const slot = bodyInst.count++;

    dummyEdge = levelOf(c);
    c.ry = edgeHeight(dummyEdge, c.x, c.z);
    const slope = slopeOn(dummyEdge, c.x, c.z, sinY, cosY);
    dummy.position.set(c.x, 0.0, c.z);
    dummy.rotation.set(c.pitch - Math.atan(slope), rotY, c.roll, 'YXZ');
    dummy.scale.set(1, 1, 1);
    placeDummy();
    bodyInst.setMatrixAt(slot, dummy.matrix);
    if (c.isPolice) {
      const lb = policeLightbars[c.bodyType];
      if (lb) lb.setMatrixAt(policeDrawn[c.bodyType]++, dummy.matrix);
    }

    const attrs = bodyInst.geometry.attributes;
    const paint = attrs.paintColor.array;
    const o3 = slot * 3;
    if (paint[o3] !== c.paint[0] || paint[o3 + 1] !== c.paint[1] || paint[o3 + 2] !== c.paint[2]) {
      paint[o3] = c.paint[0];
      paint[o3 + 1] = c.paint[1];
      paint[o3 + 2] = c.paint[2];
      dirtyPaint.add(bodyInst);
    }
    const state = attrs.carState.array;
    const o4 = slot * 4;
    const blinkOn = c.blink !== 0 && (clock + c.blinkPhase) % 0.8 <= 0.4;
    const b0 = c.acc < -0.8 || c.speed < 0.3 ? 1 : 0;
    const b1 = blinkOn && c.blink < 0 ? 1 : 0;
    const b2 = blinkOn && c.blink > 0 ? 1 : 0;
    const b3 = c.style;
    if (state[o4] !== b0 || state[o4 + 1] !== b1 || state[o4 + 2] !== b2 || state[o4 + 3] !== b3) {
      state[o4] = b0;
      state[o4 + 1] = b1;
      state[o4 + 2] = b2;
      state[o4 + 3] = b3;
      dirtyState.add(bodyInst);
    }

    // Soft Under-Car Contact Shadow (AO) stays flat on the asphalt, sized to the body kind
    const visIdx = visibleCars++;
    const [shadowW, shadowL, shadowZ] = bodies[c.bodyType].shadow;
    dummy.rotation.set(0, rotY, 0, 'YXZ');
    dummy.position.set(c.x + sinY * shadowZ, 0.018, c.z + cosY * shadowZ);
    dummy.scale.set(shadowW, 1.0, shadowL);
    placeDummy();
    carShadowInst.setMatrixAt(visIdx, dummy.matrix);

    const dxCam = c.x - camX;
    const dzCam = c.z - camZ;
    const distSq = dxCam * dxCam + dzCam * dzCam + camY * camY;
    if (distSq < MAX_LIGHT_DIST_SQ) {
      const d = Math.sqrt(distSq);
      const forwardDot = dxCam * camFwdX + dzCam * camFwdZ;
      const effDist = d + Math.max(0, 5.0 - forwardDot) * 3.2;
      if (effDist < MAX_LIGHT_DIST) {
        c._camDistSq = distSq;
        c._effDist = effDist;
        c._sinY = sinY;
        c._cosY = cosY;
        c._braking = b0;
        litVehicles[litVehicleCount++] = c;
      }
    }

    if (near) {
      const wi = wheelCars * 2;
      const ws = carWheelStyles.array;
      if (ws[wi] !== c.style || ws[wi + 1] !== c.style) {
        ws[wi] = ws[wi + 1] = c.style;
        dirtyWheelStyles = true;
      }
      placeWheels(c, wheelCars++, rotY, c.roll, spec.wheelRadius, spec.wheelX, spec.wheelZ, carWheelLeftInst, carWheelRightInst);
    }
  }

  function renderBus(b) {
    const rotY = b.yaw + b.yawOffset;
    const sinY = Math.sin(rotY);
    const cosY = Math.cos(rotY);
    const forwardDist = (b.x - b.prevX) * sinY + (b.z - b.prevZ) * cosY;
    const rawStep = forwardDist / BUS_SPEC.wheelRadius;
    b.wheelSpin = (b.wheelSpin + Math.sign(rawStep) * Math.min(Math.abs(rawStep), 0.48)) % (Math.PI * 2);
    if (hasView && !visible(b.x, b.z, 22)) return;

    const i = visibleBuses++;
    dummyEdge = levelOf(b);
    b.ry = edgeHeight(dummyEdge, b.x, b.z);
    dummy.position.set(b.x, 0.018, b.z);
    dummy.rotation.set(0, rotY, 0, 'YXZ');
    dummy.scale.set(2.92, 1.0, 12.4);
    placeDummy();
    busShadowInst.setMatrixAt(i, dummy.matrix);

    // Lofted Bus Body is defined in ground-relative Y (0.35m skirt to 3.23m roof fairing crown)
    dummy.position.set(b.x, 0.0, b.z);
    dummy.rotation.set(b.pitch - Math.atan(slopeOn(dummyEdge, b.x, b.z, sinY, cosY)), rotY, b.roll, 'YXZ');
    dummy.scale.set(1, 1, 1);
    placeDummy();
    busBodyInst.setMatrixAt(i, dummy.matrix);
    busHeaderInst.setMatrixAt(i, dummy.matrix);
    writeLampState(b, busStates.array, i * 4);
    busStates.array[i * 4 + 3] = (b.variant ?? i) + 1;

    const dxCam = b.x - camX;
    const dzCam = b.z - camZ;
    const distSq = dxCam * dxCam + dzCam * dzCam + camY * camY;
    if (distSq < MAX_LIGHT_DIST_SQ) {
      const d = Math.sqrt(distSq);
      const forwardDot = dxCam * camFwdX + dzCam * camFwdZ;
      const effDist = d + Math.max(0, 5.0 - forwardDot) * 3.2;
      if (effDist < MAX_LIGHT_DIST) {
        b._camDistSq = distSq;
        b._effDist = effDist;
        b._sinY = sinY;
        b._cosY = cosY;
        b._braking = b.acc < -0.8 || b.speed < 0.3 ? 1 : 0;
        litVehicles[litVehicleCount++] = b;
      }
    }

    placeWheels(b, i, rotY, 0, BUS_SPEC.wheelRadius, BUS_SPEC.wheelX, BUS_SPEC.wheelZ, busWheelLeftInst, busWheelRightInst, BUS_SPEC.wheelRadius);
  }

  function smoothDistFade(d, start, end) {
    const t = clamp((end - d) / (end - start), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function updateTrafficLights() {
    litVehicles.length = litVehicleCount;
    if (litVehicleCount > 1) {
      litVehicles.sort((a, b) => a._effDist - b._effDist);
    }

    const glow = cityUniforms && cityUniforms.uInteriorGlow ? cityUniforms.uInteriorGlow.value : 0.48;
    // Front headlights are off during Midday (0.24) & Golden Hour (0.48); fade in smoothly for Dusk (1.25) & Night (1.55)
    const beamScale = clamp((glow - 0.60) * 1.45, 0.0, 1.28);
    const tailScale = clamp(0.18 + glow * 0.66, 0.24, 1.22);

    const maxDualVehicles = HEADLIGHT_POOL_SIZE >> 1;
    const vehCutoff = litVehicleCount > maxDualVehicles
      ? Math.min(MAX_LIGHT_DIST, litVehicles[maxDualVehicles]._effDist)
      : MAX_LIGHT_DIST;
    let spotUsed = 0;
    if (beamScale > 0.001) {
      for (let i = 0; i < litVehicleCount && spotUsed + 2 <= HEADLIGHT_POOL_SIZE; i++) {
        const v = litVehicles[i];
        const fade = smoothDistFade(v._effDist, vehCutoff * 0.62, vehCutoff);
        if (fade <= 0.001) continue;
        const spec = v.bus ? BUS_SPEC : BODY_SPECS[v.bodyType];
        const fullReach = HEADLIGHTS.distance;
        let maxReach = fullReach;
        if (player.active && v.pAhead > 0 && v.pAhead < 30) {
          const latWeight = smoothDistFade(Math.abs(v.pRight), 2.2, 5.5);
          const clampedReach = Math.max(4.5, v.pAhead - player.halfL - 1.5);
          maxReach = fullReach + (clampedReach - fullReach) * latWeight;
        }

        const baseInt = (v.bus ? HEADLIGHTS.busIntensity : HEADLIGHTS.intensity) * beamScale * fade;
        // Match the body instance, including suspension and impact rotation.
        dummy.position.set(v.x, 0, v.z);
        dummy.rotation.set(v.pitch, v.yaw + v.yawOffset, v.roll, 'YXZ');
        dummy.scale.set(1, 1, 1);
        placeDummy();
        for (let side = -1; side <= 1; side += 2) {
          const spot = headlightPool[spotUsed++];
          placeVehicleHeadlight(spot, spec, side, dummy.matrix);
          // Worked out from the origin, as the cars are drawn. The pool of lights is in the game's frame.
          spot.position.x += origin.x;
          spot.position.z += origin.z;
          spot.target.position.x += origin.x;
          spot.target.position.z += origin.z;
          spot.distance = maxReach;
          spot.intensity = baseInt;
        }
      }
    }
    for (let i = spotUsed; i < HEADLIGHT_POOL_SIZE; i++) {
      const spot = headlightPool[i];
      spot.intensity = 0;
      spot.position.set(0, -1000, 0);
    }

    // 1. Police emergency roof lightbar flashes (smoothly pulsing red/blue 360° PointLights on nearby patrol cruisers)
    let policeLightsUsed = 0;
    for (let i = 0; i < litVehicleCount && policeLightsUsed < POLICE_LIGHT_POOL_SIZE; i++) {
      const v = litVehicles[i];
      if (!v.isPolice || v._effDist >= 88) continue;
      const fade = smoothDistFade(v._effDist, 52, 88);
      if (fade <= 0.001) continue;
      const wave = Math.sin((clock + v.blinkPhase) * Math.PI * 6.0);
      const redPhase = wave >= 0;
      const pulse = 0.35 + 0.65 * Math.abs(wave);
      const side = redPhase ? -0.36 : 0.36;
      const pt = policeLightPool[policeLightsUsed++];
      pt.color.setHex(redPhase ? 0xff1828 : 0x1868ff);
      pt.position.set(v.x + side * v._cosY - 0.25 * v._sinY, v.bodyType === 'suv' ? 2.05 : 1.85, v.z - side * v._sinY - 0.25 * v._cosY);
      pt.distance = 12.0;
      pt.intensity = 42.0 * tailScale * fade * pulse;
    }
    for (let i = policeLightsUsed; i < POLICE_LIGHT_POOL_SIZE; i++) {
      const pt = policeLightPool[i];
      pt.intensity = 0;
      pt.position.set(0, -1000, 0);
    }
  }

  function updateSparks(dt) {
    let count = 0;
    for (let s = 0; s < MAX_SPARKS; s++) {
      const sp = sparks[s];
      if (sp.life > 0) {
        sp.life -= dt;
        sp.vy -= 22.0 * dt;
        sp.x += sp.vx * dt;
        sp.y += sp.vy * dt;
        sp.z += sp.vz * dt;
        if (sp.y < 0.03) {
          sp.y = 0.03;
          sp.vy = Math.abs(sp.vy) * 0.45;
          sp.vx *= 0.78;
          sp.vz *= 0.78;
        }
        const tLife = Math.max(0, sp.life / sp.maxLife);
        const spdXZ = Math.hypot(sp.vx, sp.vz) || 0.001;
        const yawSp = Math.atan2(sp.vx, sp.vz);
        const pitchSp = -Math.atan2(sp.vy, spdXZ);
        dummy.position.set(sp.x, sp.y, sp.z);
        dummy.rotation.set(pitchSp, yawSp, 0, 'YXZ');
        dummy.scale.set(tLife, tLife, Math.max(0.4, Math.min(2.2, spdXZ * 0.16)) * tLife);
        placeDummy();
        sparkInst.setMatrixAt(count++, dummy.matrix);
      }
    }
    // Keep one degenerate instance for shader warm-up, then hide the empty pool and stop uploading it.
    sparkInst.visible = count > 0 || updates <= 2;
    if (count === 0 && updates <= 2) sparkInst.setMatrixAt(count++, zero);
    sparkInst.count = count;
    if (count > 0) flagRange(sparkInst.instanceMatrix, count);
  }

  // =========================================================================
  // 7b. CARS PARKED ALONG THE KERB
  // =========================================================================
  // A street of houses has cars outside them, even when nobody's driving. They're drawn as the far cars are, sharing their
  // material, and simulate nothing: the player hits them (their colliders go to js/main.js), traffic keeps to its lanes past them.
  // Each kerb's slots are filled the same way every time, by who lives there (js/places.js), so a car stays where it was parked as
  // the network around the player is rebuilt.
  const KERB_REACH = 260; // m around the player
  const KERB_SLOT = 7.5; // m of kerb a parked car takes, a driveway's gap included
  const KERB_CLEAR = 10; // m clear of a junction
  const KERB_STREETS = new Set([ROAD_CLASS.residential, ROAD_CLASS.unclassified, ROAD_CLASS.living_street, ROAD_CLASS.tertiary]);
  const KERB_KINDS = ['sedan', 'suv'];
  const KERB_MAX = Math.round(numCars * 1.5);
  const kerbMeshes = KERB_KINDS.map((kind) => {
    const source = bodies[kind].far;
    const g = source.geometry.clone();
    g.setAttribute('paintColor', new THREE.InstancedBufferAttribute(new Float32Array(KERB_MAX * 3), 3));
    g.setAttribute('carState', new THREE.InstancedBufferAttribute(new Float32Array(KERB_MAX * 4), 4));
    const mesh = new THREE.InstancedMesh(g, source.material, KERB_MAX);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.sharesPipelineWith = source;
    mesh.name = 'ParkedCars';
    return mesh;
  });
  group.add(...kerbMeshes);
  const kerbPaints = Object.values(fleetStyles).flat();
  let kerbCars = [], kerbColliders = [], kerbAt = { x: Infinity, z: Infinity }, kerbDirty = false;
  onOriginMove(() => { kerbDirty = true; });
  const slotHash = (a, b, c) => {
    let h = Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663) ^ Math.imul(c | 0, 83492791);
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
  };
  /** Fills the kerbs within KERB_REACH of (x, z) */
  function parkAlongKerbs(x, z) {
    kerbAt = { x, z };
    const cars = [];
    for (const e of edges) {
      if (cars.length >= KERB_MAX) break;
      if (!KERB_STREETS.has(e.cls) || e.half < 4.2 || e.len < KERB_CLEAR * 2 + KERB_SLOT || e.sid || e.deck) continue;
      const s0 = clamp((x - e.sx) * e.dx + (z - e.sz) * e.dz, 0, e.len);
      if (Math.hypot(e.sx + e.dx * s0 - x, e.sz + e.dz * s0 - z) > KERB_REACH) continue;
      const mid = placeAt(e.sx + (e.dx * e.len) / 2, e.sz + (e.dz * e.len) / 2);
      // Where the map knows nobody lives, no one parks; a main street's shops get a few
      if (!mid || (!mid.dw && mid.zone !== 'centre')) continue;
      const share = clamp(mid.dw / 50, 0.12, 0.55) * (e.cls === ROAD_CLASS.tertiary ? 0.5 : 1);
      // Slots counted from the junction the edge leaves, so the same ones come back
      const sx = Math.round(e.sx), sz = Math.round(e.sz);
      for (let s = KERB_CLEAR; s + KERB_SLOT <= e.len - KERB_CLEAR && cars.length < KERB_MAX; s += KERB_SLOT) {
        const h = slotHash(sx * 7 + sz, Math.round(s), e.link || 0);
        if (h > share) continue;
        const along = s + KERB_SLOT / 2 + (h / share - 0.5) * 1.2;
        const off = e.half - 0.95;
        const px = e.sx + e.dx * along + e.rx * off, pz = e.sz + e.dz * along + e.rz * off;
        if (Math.hypot(px - x, pz - z) > KERB_REACH) continue;
        // Never on top of the player, who'd be caught in it
        if (player.active && Math.hypot(px - player.x, pz - player.z) < 6) continue;
        const kind = KERB_KINDS[Math.floor(h * 977) % KERB_KINDS.length];
        const { col, style } = kerbPaints[Math.floor(h * 7919) % kerbPaints.length];
        cars.push({ x: px, z: pz, yaw: Math.atan2(e.dx, e.dz), edge: e, kind, paint: [col.r, col.g, col.b], style });
      }
    }
    kerbCars = cars;
    const old = kerbColliders;
    kerbColliders = cars.map((c) => {
      const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw), hx = 0.92, hz = 2.3;
      const ex = Math.abs(cs) * hx + Math.abs(sn) * hz, ez = Math.abs(sn) * hx + Math.abs(cs) * hz;
      return { minX: c.x - ex, maxX: c.x + ex, minZ: c.z - ez, maxZ: c.z + ez, minY: 0, maxY: 1.55, obb: { cx: c.x, cz: c.z, hx, hz, cs, sn }, parked: true };
    });
    kerbsideChanged?.(old, kerbColliders);
    kerbDirty = true;
  }
  function drawKerbside() {
    if (!kerbDirty) return;
    kerbDirty = false;
    for (const m of kerbMeshes) m.count = 0;
    for (const c of kerbCars) {
      const mesh = kerbMeshes[KERB_KINDS.indexOf(c.kind)];
      const slot = mesh.count++;
      dummyEdge = c.edge;
      dummy.position.set(c.x, 0, c.z);
      dummy.rotation.set(-Math.atan(slopeOn(c.edge, c.x, c.z, Math.sin(c.yaw), Math.cos(c.yaw))), c.yaw, 0, 'YXZ');
      dummy.scale.set(1, 1, 1);
      placeDummy();
      mesh.setMatrixAt(slot, dummy.matrix);
      mesh.geometry.attributes.paintColor.array.set(c.paint, slot * 3);
      mesh.geometry.attributes.carState.array.set([0, 0, 0, c.style], slot * 4);
    }
    for (const m of kerbMeshes) {
      m.instanceMatrix.needsUpdate = true;
      m.geometry.attributes.paintColor.needsUpdate = true;
      m.geometry.attributes.carState.needsUpdate = true;
    }
  }

  // =========================================================================
  // 8. UPDATE
  // =========================================================================
  let lastFocusX = Infinity;
  let lastFocusZ = Infinity;
  let vehicleCursor = 0;

  // The first placement of everyone, spread over frames (a teleport does the same in one go, in update())
  function* populate(focusPos) {
    focusX = lastFocusX = focusPos.x;
    focusZ = lastFocusZ = focusPos.z;
    refreshNear();
    // As many as the roads here hold (roadShare)
    let active = vehicles.filter((v) => v.edge).length;
    for (const v of vehicles) {
      if (!v.edge && active < nearLaneMetres / LANE_METRES_PER_VEHICLE && spawnVehicle(v, 0, NEAR_RADIUS, false)) active++;
      yield;
    }
    yield* pedestrianSystem.populate(focusX, focusZ);
  }

  /**
   * The network around the player is rebuilt as they travel. Everyone on a road both networks have stays where they are; the
   * near part of the map is the same in both, so what's lost is far from the player, and comes back with the usual recycling.
   */
  // Debug only: which of mayEnter()'s rules is holding a vehicle at its line
  function holdingBack(v) {
    const e = v.edge, n = e.to, m = v.move;
    if (!m || v.conn) return v.conn ? 'crossing' : 'no move';
    const f = m.to, j = m.out[v.lane], d = e.len - v.s - v.half;
    if (!(j >= 0 && j < f.lanes.length)) return `lane leads nowhere (out ${j} of ${f.lanes.length})`;
    const why = [];
    const phase = n.signal ? phaseOf(e) : 'green';
    if (n.joint) {
      // Nothing at a joint holds it but whoever is ahead, on this road or the next
      if (Math.abs(v.dl) > 0.5) why.push(`changing lane ${v.dl.toFixed(2)}`);
      why.push('following', `d ${d.toFixed(1)}`);
      return why.join('; ');
    }
    if (phase !== 'green') why.push(`light ${phase}`);
    if (boxBusy(n, e.axisIndex)) why.push(`box busy ${n.box.join()} (mine ${e.axisIndex})`);
    const lead = ahead(e.occ[v.lane], v.s, v);
    if (lead) why.push(`lead ${(lead.s - v.s).toFixed(1)} m ahead${lead.v.yielding ? ', yielding' : ''}`);
    if (v.bus && besideTail(v)) why.push('bus tail');
    if (e.opposite && m.turn === 'L' && yieldOncoming(e.opposite, v.wait > 8, v)) why.push('oncoming');
    if (e.opposite && m.turn !== 'L' && e.opposite.lefts > 0) why.push('oncoming lefts');
    if (e.axisIndex !== 0 && !n.signal && yieldToCrossTraffic(v, n)) why.push('cross traffic');
    if (pedestrianOn(n, e.inSide, laneCoord(e, v.lane), 0, timeTo(v, d + 2.5 + 2 * v.half))) why.push('people on the way in');
    const c = connector(e, v.lane, f, j);
    if (pedestrianOn(n, f.outSide, laneCoord(f, j), timeTo(v, d + c.len - 3), timeTo(v, d + c.len + 2 * v.half))) why.push('people on the way out');
    const vs = v.s - e.len - c.len;
    if (!room(f, j, v)) why.push(`no room on ${f.id}:${j} (len ${f.len.toFixed(0)}, ${f.occ[j].length} in it)`);
    if (alongside(f, j, v, vs, m.turn !== 'S')) why.push('alongside');
    const merging = mergingAhead(v, f, j);
    if (merging) why.push(`merging ${merging.v.lane}, wait ${merging.v.wait.toFixed(0)}`);
    if (Math.abs(v.dl) > 0.5) why.push(`changing lane ${v.dl.toFixed(2)}`);
    if (!why.length) why.push('following');
    why.push(`d ${d.toFixed(1)}`);
    return why.join('; ');
  }

  let recycled = 0;
  const handover = { count: 0, kept: 0, lost: 0 };
  function setNetwork(next) {
    const keyOf = (e) => `${e.link}:${Math.round(e.from.x * 2)},${Math.round(e.from.z * 2)}>${Math.round(e.to.x * 2)},${Math.round(e.to.z * 2)}`;
    const byKey = new Map(next.edges.map((e) => [keyOf(e), e]));
    network = next;
    ({ nodes, edges, connector, curvePoint } = next);
    prepareNetwork();
    headLights.clear();
    signalSets = assignLights(nodes, lightsKnown, headLights);
    touchedNodes.length = 0;
    touchedEdges.length = 0;
    let kept = 0, lost = 0;
    for (const v of vehicles) {
      if (!v.edge) continue;
      const e = byKey.get(keyOf(v.edge));
      const toKey = v.move ? keyOf(v.move.to) : null;
      const lane = v.edge.lanes[v.lane];
      if (!e || e.lanes[v.lane] !== lane) {
        v.edge = null;
        lost++;
        continue;
      }
      v.edge = e;
      v.commit = null;
      v.claimed = false;
      const move = toKey ? e.moves.find((m) => keyOf(m.to) === toKey) : null;
      if (move) v.move = move;
      else {
        v.conn = null;
        v.move = chooseMove(v, false);
      }
      if (v.conn) {
        if (v.out < 0 || !v.move.to.lanes[v.out]) { v.conn = null; v.edge = null; lost++; continue; }
        v.conn = connector(e, v.lane, v.move.to, v.out);
      }
      kept++;
    }
    pedestrianSystem.setNetwork(next, keyOf);
    nearX = nearZ = Infinity;
    refreshNear();
    parkAlongKerbs(focusX, focusZ);
    handover.count++;
    handover.kept = kept;
    handover.lost = lost;
  }

  function update(dt, elapsed, focusPos = null, playerEntity = null, activeMode = 'car', camera = null) {
    clock = elapsed;
    updateSignals(dt);
    focusX = focusPos ? focusPos.x : 0;
    focusZ = focusPos ? focusPos.z : 140;
    // a jump of the camera (teleport, first frame): everything far away can be placed anywhere around it
    const jump = Math.hypot(focusX - lastFocusX, focusZ - lastFocusZ) > 140;
    lastFocusX = focusX;
    lastFocusZ = focusZ;
    refreshNear();
    updateView(camera);
    if (Math.hypot(focusX - kerbAt.x, focusZ - kerbAt.z) > KERB_REACH * 0.4) parkAlongKerbs(focusX, focusZ);
    drawKerbside();

    player.active = Boolean(playerEntity && activeMode !== 'helicopter' && playerEntity.position.y < 2.6);
    if (playerEntity) {
      const heading = playerEntity.heading || 0;
      const speed = playerEntity.speed || 0;
      player.entity = playerEntity;
      player.x = playerEntity.position.x;
      player.z = playerEntity.position.z;
      // The height of the surface the player is on (js/controllers.js keeps it), for telling levels apart
      player.y = playerEntity.surfaceY ?? surfaceHeight(playerEntity.surface || 0, player.x, player.z);
      player.fx = Math.sin(heading);
      player.fz = Math.cos(heading);
      player.vx = player.fx * speed + (playerEntity.vx || 0);
      player.vz = player.fz * speed + (playerEntity.vz || 0);
    }
    player.halfW = activeMode === 'cyclist' ? 0.35 : activeMode === 'person' ? 0.32 : 0.86;
    player.halfL = activeMode === 'cyclist' ? 0.85 : activeMode === 'person' ? 0.32 : 2.18;

    // 1. Cars & buses
    // Limit attempted placements, not just successes, and rotate through the pool so an awkward location
    // cannot monopolize a frame. Previous-frame lane lists protect spawn spacing; rebuild before driving.
    let budget = jump ? vehicles.length : 4;
    // As many as the roads around can carry: the same number of cars on the few roads of a bridge or a freeway as on all the
    // streets of the CBD is a traffic jam that never clears
    const room = nearLaneMetres / LANE_METRES_PER_VEHICLE;
    let active = 0;
    for (const v of vehicles) if (v.edge) active++;
    for (let scanned = 0; scanned < vehicles.length && budget > 0; scanned++) {
      const v = vehicles[vehicleCursor];
      vehicleCursor = (vehicleCursor + 1) % vehicles.length;
      const d = v.edge ? Math.hypot(v.x - focusX, v.z - focusZ) : Infinity;
      // Traffic can still hold itself up at a merge. Someone stuck that long goes, out of sight if at all possible, which lets
      // the queue behind them move. (A cause is still open: see ai/next_2.md.)
      const stuck = v.edge && v.wait > (nearView(v.x, v.z, v.half + 4, VEHICLE_SPAWN_DISTANCE) ? STUCK_IN_VIEW : STUCK_OUT_OF_VIEW);
      if (stuck) {
        v.edge = null;
        active--;
        recycled++;
      } else if (d <= (jump ? NEAR_RADIUS : VEHICLE_RADIUS)) {
        // More than the roads here want, coming from somewhere busier: one out of sight goes
        if (active > room + 1 && !v.isPolice && !nearView(v.x, v.z, v.half + 4, VEHICLE_SPAWN_DISTANCE)) {
          v.edge = null;
          active--;
        }
        continue;
      }
      if (active >= room) {
        // Out of sight and not needed here
        if (v.edge) {
          v.edge = null;
          active--;
        }
        continue;
      }
      budget--;
      const had = !!v.edge;
      if (spawnVehicle(v, jump ? 0 : 100, NEAR_RADIUS, !jump) && !had) active++;
    }
    buildOccupancy();
    for (const m of bodyMeshes) m.count = 0;
    dirtyWheelStyles = false;
    litVehicleCount = 0;
    wheelCars = 0;
    visibleCars = 0;
    policeDrawn.sedan = 0;
    policeDrawn.suv = 0;
    visibleBuses = 0;
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (!v.edge) continue;

      v.prevX = v.x;
      v.prevZ = v.z;
      relateToPlayer(v);
      react(v, dt);
      drive(v, dt);
      locate(v);
      v.ry = edgeHeight(levelOf(v), v.x, v.z); // seen or not, it has to know which level it's on
      knock(v, dt);
      pose(v, dt);
    }
    if (player.active) {
      for (const v of vehicles) if (v.edge && onPlayersLevel(v)) collideWithPlayer(v);
    }
    collideTraffic();
    for (const v of vehicles) {
      if (!v.edge) continue;
      if (v.bus) renderBus(v);
      else renderCar(v);
      dummyEdge = null;
    }
    const hideEmpty = ++updates > 2;
    for (const m of bodyMeshes) {
      const n = m.count;
      m.visible = n > 0 || !hideEmpty;
      if (n === 0) {
        if (!hideEmpty) {
          m.setMatrixAt(0, zero);
          m.count = 1;
          flagRange(m.instanceMatrix, 1);
        }
        continue;
      }
      flagRange(m.instanceMatrix, n);
      if (dirtyPaint.has(m)) flagRange(m.geometry.attributes.paintColor, n);
      if (dirtyState.has(m)) flagRange(m.geometry.attributes.carState, n);
    }
    dirtyPaint.clear();
    dirtyState.clear();
    const syncInst = (inst, n) => {
      inst.visible = n > 0 || !hideEmpty;
      if (n === 0) {
        if (!hideEmpty) {
          inst.setMatrixAt(0, zero);
          inst.count = 1;
          flagRange(inst.instanceMatrix, 1);
        } else {
          inst.count = 0;
        }
        return;
      }
      inst.count = n;
      flagRange(inst.instanceMatrix, n);
    };
    syncInst(carWheelLeftInst, wheelCars * 2);
    syncInst(carWheelRightInst, wheelCars * 2);
    if (dirtyWheelStyles && wheelCars > 0) flagRange(carWheelStyles, wheelCars * 2);
    syncInst(policeLightbars.sedan, policeDrawn.sedan);
    syncInst(policeLightbars.suv, policeDrawn.suv);
    syncInst(carShadowInst, visibleCars);
    syncInst(busBodyInst, visibleBuses);
    syncInst(busHeaderInst, visibleBuses);
    syncInst(busWheelLeftInst, visibleBuses * 2);
    syncInst(busWheelRightInst, visibleBuses * 2);
    syncInst(busShadowInst, visibleBuses);
    if (visibleBuses > 0) flagRange(busStates, visibleBuses);
    updateTrafficLights();

    // 2. Pedestrians
    pedestrianSystem.update(dt, elapsed, focusX, focusZ, jump, hasView, activeMode);

    // 3. Collision sparks, including the player's own impacts against buildings
    if (playerEntity && playerEntity.lastCollisionSpark) {
      const bs = playerEntity.lastCollisionSpark;
      spawnCollisionSparks(bs.x, bs.y, bs.z, bs.nx, bs.nz, bs.speed);
      playerEntity.lastCollisionSpark = null;
    }
    updateSparks(dt);
  }

  return {
    setParked(entity) { parkedCar = entity; },
    group,
    update,
    populate,
    setNetwork,
    handover,
    holdingBack,
    roadRoom: () => nearLaneMetres / LANE_METRES_PER_VEHICLE,
    peopleWanted: () => peopleWanted,
    parkedAlongKerbs: () => kerbCars.length,
    recycled: () => recycled,
    get network() { return network; },
    phaseOf,
    /** What a junction's heads should show, by where its signal point is; undefined where traffic doesn't reach */
    headsAt: (x, z) => headLights.get(junctionKey(x, z)),
    setCollisionListener,
    cars,
    buses,
    peds: pedestrianSystem.peds
  };
}

export { createTrafficSystem };
