import * as THREE from 'three/webgpu';
import {
  Fn, cameraPosition, cameraViewMatrix, color, dot, float, floor, fract, mix, mod, normalize, positionLocal, positionWorld, sin, smoothstep, step,
  time, uniform, vec2, vec3, vertexColor
} from 'three/tsl';
import { CITY_BOUNDS, blockAt } from './city-config.js';
import { hasFirstShape, showFirstShape } from './first-shapes.js';
import { MODEL_SITES } from './model-sites.js';
import { addStillWater, removeStillWater } from './still-water.js';
import { clearFloor, groundHeight, setFloor } from './surfaces.js';
import { cityUniforms } from './tsl-materials.js';
import {
  DOOR_TIME, doorCollider, doorInReach, exitSpot as findExit, eyeReach, floorAt, leafAt, roomAt, seatInReach, standSpot, toLocal, toWorld,
  visibleRooms, wallCollider
} from './interior-data.js';

// Buildings drawn from models of their own (js/model-sites.js), and the insides of those that have one.
// - The outside comes with its tile, like any building: its walls, the leaves of its doors, the floors in front of them. Nothing about it
//   says whether there's anything behind its front door.
// - At a door, within reach and facing it, F opens it (a hand button on touch, X on a gamepad). If there's an inside, that's when it's
//   fetched: the door swings to a little open while it comes, then all the way. It's let go of RELEASE metres after you leave.
// - A big inside is several files (a gallery's levels): a door inside can name another (`inside`), the door at the head of a stair down
//   to the level below, and that file's fetched when it's opened, as the outside's doors fetch theirs. Its rooms, walls, floors and doors
//   join the others' (rooms are named across files: a stair's room in one, the lobby at its foot in the next). What's held stays till
//   you leave the building.
// - Inside, its own doors are open when it comes in, unless they're locked or lead to a file not fetched yet; F shuts one.
// - Inside, only the rooms you can see are drawn: the one you're in, and those through open doorways from it (interior-data.js).
// - In it or beside it, the camera behind you is kept clear of its walls, floors and ceilings, so it never looks through one.
// - Its door leaves are drawn as one shut piece until you're near (`doors_shut`), and the whole model only within NEAR of the camera
//   (or its site's `near`). Past that, and wherever its tile isn't drawn, its far version is (`<file>-far`), if its site has one.
// - Till then, and wherever neither is drawn, its first shape is (js/first-shapes.js): the map's buildings it replaces, from its tile,
//   and for a landmark the game's own shape (the Opera House's plain podium and glass). One of the three at a time: the model within
//   `near` once it's in, the far version past it once that's in, the first shape otherwise. A site that replaces none of the map's
//   buildings has none, and shows its far version from the first view, as soon as its tile is built.
// - What turns in an outside (Luna Park's wheel), as its JSON's `spin` says, is turned on the game's clock while the model's drawn, and
//   what it carries round (the wheel's gondolas) kept level (spinners()).
// - A pool in an outside (its JSON's `pools`, North Sydney Pool's) is still water while the model's held: walkers stop at its edge
//   (js/still-water.js). One with `sim` has water that moves near it (js/pool-water.js, which js/main.js fetches and places: pools()).
//   One with `swim` is swum in (js/swimming.js, fetched with the first such outside held).
// Every site's model is in its own frame (x across, z along, y up from its ground floor), placed at (x, y, z) and turned by yaw.

const RELEASE = 60; // m from a building that its inside is let go of, unless its site says (`reach`)
const DEBUG_RANGE = 700; // m: a debug site is drawn within this, having no tile of its own
const AJAR = 0.3; // of a door's swing, while what's behind it is fetched
const LIGHTS_REACH = 9; // m: a room's lamp lights you within this
const EYE_EASE = 2.5; // m/s the camera goes back out once a wall's no longer in its way; it comes in at once
const EYE_CLOSE = 0.7; // m from over your head: nearer than this, you aren't drawn, or you'd fill the view
const SEEN_DEPTH = 3; // rooms deep, through open doorways, that the camera sees
const NEAR = 400; // m from the camera that a model is drawn, rather than its far version, unless its site says (`near`)
const DOORS_NEAR = 20; // m from a model, for the player or the camera, that its door leaves are drawn apart, ready to swing
const FAR_KEEP = 1000; // m past the far level's reach before a far version is let go of

// One material of each kind for every model: they compile once. Their colour is in the vertices; inside, a little of it glows, the
// light the model's lamps and windows give, baked into its vertices; three lights are moved round as well.
const ROUGH = { plaster: [0.9, 0], paint: [0.55, 0], timber: [0.45, 0], boards: [0.5, 0], stone: [0.85, 0], tile: [0.3, 0], metal: [0.4, 0.8],
  iron: [0.6, 0.6], fabric: [0.95, 0], ceramic: [0.2, 0], roof: [0.8, 0.1], leaf: [0.8, 0], lamp: [0.4, 0] };
const indoorLight = uniform(0.1);
// ...and their lamps: dimmed with the house's lights for a show (the Concert Hall's concert: setShow())
const lampLight = uniform(1.4);
const materials = new Map();
function materialFor(name, inside) {
  const key = `${inside ? 'in' : 'out'}:${name}`;
  let m = materials.get(key);
  if (m) return m;
  if (name === 'bronze') {
    // The Opera House's glass walls: bronze-tinted, seen through both ways, and lit warm from inside at night
    m = new THREE.MeshStandardNodeMaterial({ color: 0x4a3c2e, roughness: 0.06, metalness: 0.35, transparent: true, opacity: 0.32, depthWrite: false,
      flatShading: true });
    m.emissiveNode = color(0xffc27a).mul(smoothstep(0.55, 1.2, cityUniforms.uInteriorGlow).mul(0.25));
  } else if (name === 'clear') {
    // Glass to walk on, as over a pit with something to see in it: nearly clear, a little of the room's light on it
    m = new THREE.MeshStandardNodeMaterial({ color: 0xd8e6ea, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.16, depthWrite: false,
      flatShading: true });
  } else if (name === 'pool') {
    // A pool's water, tiled or rock-cut under it: its vertex colour is the water's, clear and bright, the sky in it at a glance, and a
    // slow ripple over it
    m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.08, metalness: 0.15, flatShading: false });
    m.normalNode = Fn(() => {
      const p = positionWorld.xz.mul(1.3);
      const w = sin(p.x.add(time.mul(0.9))).mul(sin(p.y.mul(1.3).sub(time.mul(0.7)))).mul(0.04);
      return cameraViewMatrix.transformDirection(normalize(vec3(w, 1.0, w.mul(-0.6))));
    })();
    m.emissiveNode = vertexColor().mul(0.12);
  } else if (name === 'bulb' || name === 'chase') {
    // A bulb, drawn from both sides: by day its colour; at night lit by the night's glow, bright enough for bloom to spread it (medium and
    // high). A `bulb` is lit in its own colour. A `chase` bulb is warm white and runs with its neighbours: its red is its place in the run,
    // 0-1, and the brightest part of each run moves along it (up a tower, out along a wheel's spoke), the rest still lit, dimmer
    // (a `chase` bulb's colour isn't its vertices': they're a number)
    m = new THREE.MeshStandardNodeMaterial({ vertexColors: name === 'bulb', roughness: 0.4, metalness: 0, side: THREE.DoubleSide, flatShading: true });
    const night = smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow);
    if (name === 'chase') {
      const run = fract(vertexColor().r.sub(time.mul(0.55)));
      const on = smoothstep(0.0, 0.08, run).mul(float(1).sub(smoothstep(0.45, 0.55, run))).mul(0.6).add(0.4);
      m.colorNode = color(0xffe6b0);
      m.emissiveNode = color(0xffc56e).mul(night.mul(on).mul(6.0));
    } else {
      m.emissiveNode = vertexColor().mul(night.mul(4.5));
    }
  } else if (name === 'lit') {
    // Painted, and floodlit at night (Luna Park's face and towers, its rides): its own colours, as if lit from in front
    m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6, metalness: 0, flatShading: true });
    m.emissiveNode = vertexColor().mul(smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow).mul(0.42));
  } else if (name === 'glass' || name === 'curtain') {
    // From the street a window like the neighbours': dark by day, lit at night. It faces out only, so from inside you see through it.
    // A curtain wall's (`curtain`, The Ribbon's) is bluer and less of a mirror: its flat panes round a curve would each catch the sky
    // differently.
    m = name === 'glass' ? new THREE.MeshStandardNodeMaterial({ color: 0x232b30, roughness: 0.06, metalness: 0.1, flatShading: true })
      : new THREE.MeshStandardNodeMaterial({ color: 0x35525a, roughness: 0.3, metalness: 0.45, flatShading: true });
    // About half of them lit, as the city's are, each a little warmer or cooler: each pane's vertex colour is two numbers, the same over
    // the pane, that say which (the model scripts' glass_roll); glass has a colour of its own
    const roll = vertexColor();
    // A curtain wall's panes are a storey high and wide open: fewer lit, and dimmer, or it's a lit chequerboard at night
    const curtain = name === 'curtain';
    // ...and their tint is the model's (b, 0.5 the colour above): lighter and bluer below it, as Crown Sydney's; a deep blue-black
    // above it, as Salesforce Tower's
    if (curtain) {
      m.colorNode = mix(mix(color(0x6f9cc0), color(0x35525a), smoothstep(0.0, 0.5, roll.b)), color(0x15233c), smoothstep(0.5, 1.0, roll.b));
    }
    const lit = step(roll.r, curtain ? 0.3 : 0.5);
    const tint = mix(color(0xffc98a), color(0xfff1d6), roll.g);
    m.emissiveNode = tint.mul(smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow)).mul(lit.mul(curtain ? 0.22 : 0.6).add(0.03));
  } else if (name === 'stained') {
    // Stained glass, its colour in its vertices. Inside, the day comes through it: bright by day, nearly dark at night. Outside, dark
    // and a little glossy by day, and at night glowing with the lights inside.
    const daylight = float(1).sub(smoothstep(0.6, 1.3, cityUniforms.uInteriorGlow));
    if (inside) {
      m = new THREE.MeshBasicNodeMaterial({ vertexColors: true });
      m.colorNode = vertexColor().mul(mix(float(0.07), float(1.5), daylight));
    } else {
      m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.25, metalness: 0.1, flatShading: true });
      m.colorNode = vertexColor().mul(0.16);
      m.emissiveNode = vertexColor().mul(smoothstep(0.55, 1.2, cityUniforms.uInteriorGlow).mul(1.1));
    }
  } else if (name === 'floodlit') {
    // Stone floodlit at night from the ground round it: a pale gold, brightest low down and on the front (+z, the site's own frame:
    // its main doors' side), less up its spires and round the back
    m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, flatShading: true });
    const fall = float(1).sub(smoothstep(10.0, 80.0, positionLocal.y).mul(0.5));
    const front = smoothstep(-60.0, 60.0, positionLocal.z).mul(0.45).add(0.4);
    m.emissiveNode = vertexColor().mul(color(0xffe2a8)).mul(smoothstep(0.55, 1.4, cityUniforms.uInteriorGlow)).mul(fall.mul(front));
  } else if (name === 'encaustic' || name === 'mosaic') {
    // Floors laid in a pattern the model's vertices only colour: encaustic tiles in a diagonal chequer of their colour and a grey,
    // grouted; or a mosaic's small tesserae, each a little lighter or darker. Both even out further off, where they'd shimmer.
    m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: name === 'encaustic' ? 0.62 : 0.7, metalness: 0, flatShading: true });
    const p = positionLocal.xz;
    const away = smoothstep(9.0, 40.0, positionWorld.distance(cameraPosition));
    let tile;
    if (name === 'encaustic') {
      const q = vec2(p.x.add(p.y), p.x.sub(p.y)).mul(0.7071 / 0.45);
      const f = fract(q);
      const odd = mix(mod(floor(q.x).add(floor(q.y)), 2.0), float(0.45), away);
      const grout = step(0.035, f.x).mul(step(0.035, f.y)).mul(step(f.x, 0.965)).mul(step(f.y, 0.965));
      tile = mix(vertexColor(), vertexColor().mul(vec3(0.5, 0.5, 0.53)), odd).mul(mix(mix(float(0.72), float(1.0), grout), float(0.93), away));
    } else {
      const q = p.mul(1 / 0.11);
      const h = fract(sin(dot(floor(q), vec2(12.9898, 78.233))).mul(43758.5453));
      const f = fract(q);
      const joint = step(0.08, f.x).mul(step(0.08, f.y));
      tile = vertexColor().mul(mix(h.mul(0.3).add(0.85), float(1.0), away)).mul(mix(mix(float(0.78), float(1.0), joint), float(0.95), away));
    }
    m.colorNode = tile;
    m.emissiveNode = tile.mul(indoorLight);
  } else {
    const [roughness, metalness] = ROUGH[name] ?? [0.8, 0];
    // flat: the models carry no normals, every face is flat
    m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness, metalness, flatShading: true });
    if (name === 'lamp') m.emissiveNode = vertexColor().mul(inside ? lampLight : smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow).mul(1.4));
    else if (inside) m.emissiveNode = vertexColor().mul(indoorLight);
  }
  m.name = key;
  materials.set(key, m);
  return m;
}

/** One leaf of a pair of doors: the first from the hinge, the second from the latch side, turning the other way, each half the doorway */
function half(d, sign) {
  const mid = [(d.hinge[0] + d.latch[0]) / 2, (d.hinge[1] + d.latch[1]) / 2];
  return sign > 0 ? { ...d, latch: mid } : { ...d, hinge: d.latch, latch: mid, turn: -d.turn };
}

let loader = null;
/** A model's glTF, gzipped (the host doesn't compress glTF on the way), and its JSON unless it's a far version, which has none */
async function loadModel(file, json = true) {
  if (!loader) {
    const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
      import('three/addons/loaders/GLTFLoader.js'), import('three/addons/libs/meshopt_decoder.module.js')
    ]);
    loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
  }
  const url = (ext) => new URL(`${file}.${ext}`, document.baseURI).href;
  const glb = fetch(url('glb.gz')).then(async (r) => {
    if (!r.ok) throw new Error(`${file}.glb.gz: ${r.status}`);
    const body = new Uint8Array(await r.arrayBuffer());
    // A server that sends .gz as Content-Encoding: gzip hands over bytes the browser has already inflated
    const bytes = body[0] === 0x1f && body[1] === 0x8b
      ? await new Response(new Response(body).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : body.buffer;
    return loader.parseAsync(bytes, '');
  });
  const [gltf, data] = await Promise.all([glb, json ? fetch(url('json')).then((r) => {
    if (!r.ok) throw new Error(`${file}.json: ${r.status}`);
    return r.json();
  }) : null]);
  return { scene: gltf.scene, data };
}

function dispose(group) {
  group.removeFromParent();
  group.traverse((o) => {
    if (!o.isMesh) return;
    if (o.isInstancedMesh) o.dispose();
    o.dispatchEvent({ type: 'dispose' });
    o.geometry.dispose();
  });
}

// Frames drawn, and the last one each inside's instanced mesh was drawn in: for the scripts, which check that a hall's seats are drawn
let frameCount = 0;
function markDrawn() {
  this.userData.drawnAt = frameCount;
}

/**
 * The things an inside draws many of from one (a hall's seats): each `instances` entry names a node of the model, the room it's in and
 * where each copy stands, [x, y, z, yaw]. The node is drawn as one InstancedMesh for each of its materials, in its room's node, so it's
 * drawn when the room is; the node itself goes. Returns the meshes, and says so if the model has no such node.
 */
function instance(scene, list = []) {
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), at = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const made = [];
  for (const entry of list) {
    const proto = scene.getObjectByName(entry.node);
    const room = scene.getObjectByName(`room_${entry.room}`) ?? scene;
    if (!proto) console.warn('[interiors]', `no node ${entry.node} to draw ${entry.at.length} of`);
    if (!proto || !entry.at.length) continue;
    const parts = [];
    proto.traverse((o) => { if (o.isMesh) parts.push(o); });
    for (const part of parts) {
      part.updateMatrix();
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, entry.at.length);
      entry.at.forEach(([x, y, z, yaw], i) => {
        m.compose(at.set(x, y, z), q.setFromAxisAngle(up, yaw), one).multiply(part.matrix);
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.name = `${entry.node}_${part.material.name}`;
      mesh.userData.lifted = true;
      mesh.userData.node = entry.node;
      mesh.onBeforeRender = markDrawn;
      room.add(mesh);
      made.push(mesh);
    }
    proto.removeFromParent();
  }
  return made;
}

/**
 * What turns in an outside (its JSON's `spin`, a wheel or a clock's hands): each entry a node turning about an axis through a centre, both
 * in the model's frame, `rpm` turns a minute; and what it carries round level (`level`, a wheel's gondolas): one node, drawn at each of
 * its pivots `at` (where they are with the node unturned, the node's own origin on each), carried round with it and turned back the other
 * way, so it hangs as it was. That's one InstancedMesh for each of its materials, however many there are; the node itself goes. The
 * nodes are kept apart from `body` at export (tools/models/build.py). Returns the spinners, turned by turn().
 */
function spinners(scene, list = []) {
  const made = [];
  for (const s of list) {
    const node = scene.getObjectByName(s.node);
    if (!node) {
      console.warn('[interiors]', `no node ${s.node} to turn`);
      continue;
    }
    const spinner = { node, axis: new THREE.Vector3(...s.axis).normalize(), centre: new THREE.Vector3(...s.centre), rpm: s.rpm,
      p0: node.position.clone(), q0: node.quaternion.clone(), at: [], level: [], angle: 0 };
    const proto = s.level && scene.getObjectByName(s.level.node);
    if (s.level && !proto) console.warn('[interiors]', `no node ${s.level.node} to carry round level`);
    if (proto) {
      spinner.at = s.level.at.map((p) => new THREE.Vector3(...p));
      const parts = [];
      proto.traverse((o) => { if (o.isMesh) parts.push(o); });
      for (const part of parts) {
        part.updateMatrix();
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, spinner.at.length);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.name = `${s.level.node}_${part.material.name}`;
        mesh.userData.lifted = true;
        mesh.userData.part = part.matrix.clone();
        mesh.castShadow = part.castShadow;
        mesh.receiveShadow = part.receiveShadow;
        (proto.parent ?? scene).add(mesh);
        spinner.level.push(mesh);
      }
      proto.removeFromParent();
    }
    made.push(spinner);
    turn(spinner, 0);
    // Their bounds as they're carried round: a circle through every pivot, so they're never culled while in view
    for (const mesh of spinner.level) mesh.computeBoundingSphere();
  }
  return made;
}

const turning = new THREE.Quaternion(), carried = new THREE.Vector3(), placed = new THREE.Matrix4();
/** A spinner turned to `angle` (radians) from where the model has it */
function turn(spinner, angle) {
  spinner.angle = angle;
  turning.setFromAxisAngle(spinner.axis, angle);
  const { node, centre } = spinner;
  node.position.copy(spinner.p0).sub(centre).applyQuaternion(turning).add(centre);
  node.quaternion.copy(turning).multiply(spinner.q0);
  node.updateMatrix();
  node.updateMatrixWorld(true); // the scene's world matrices are only ever brought up to date by hand (js/main.js)
  for (const mesh of spinner.level) {
    spinner.at.forEach((p, i) => {
      carried.copy(p).sub(centre).applyQuaternion(turning).add(centre);
      mesh.setMatrixAt(i, placed.makeTranslation(carried.x, carried.y, carried.z).multiply(mesh.userData.part));
    });
    mesh.instanceMatrix.needsUpdate = true;
  }
}

/**
 * `reveal(group)` puts a group in the scene with its shaders ready. `colliders` is { add, remove }. `lights` are PointLights kept for
 * this. `tileBuilt(x, z)` says whether the tile at (x, z) is drawn, so a site can be. `tileReady(x, z)` says the same of the tile alone,
 * before the city round you is complete: the far version of a site that replaces none of the map's buildings stands in from then, till
 * the model comes (a site that does replaces them shows them, js/first-shapes.js). `farReach()`: m from the camera that far versions
 * are wanted, 0 while the city round you is still coming. `debug`: the debug sites too.
 */
/**
 * `footpath(x, z, y, heading)`: the footpath in front of a door's step there, out from it along `heading` (js/arrivals.js footpathFrom()),
 * with what's clear for a walker, for the way out (exitSpot()).
 */
/**
 * `artDetail()`: how finely a gallery's paintings are painted, 1 on medium and high, less on low (js/art.js).
 */
function createInteriors({ reveal, colliders, lights, tileBuilt, tileReady = () => false, farReach = () => 0, footpath = null, debug = false,
  artDetail = () => 1, onSwim = null }) {
  const sites = MODEL_SITES.filter((s) => debug || !s.debug).map((s) => ({
    ...s, y: s.y ?? null, reach: s.reach ?? RELEASE, near: s.near ?? NEAR, out: null, loading: false, failed: false, ref: null,
    drawn: false, shape: 'first', far: s.far ? { group: null, loading: false, failed: false } : null, insides: new Map()
  }));
  let here = null; // { site, room, inside } the player is in, and the inside's file it's in
  let prompt = null; // { kind: 'door' | 'seat', site, door | seat, label }
  let seated = null;
  let exit = null; // { site, spot }: the way out of the inside you're in, worked out once a visit
  let held = Infinity; // m from over your head the camera can be, eased back out (holdEye())
  const lightsOn = [];
  // A show in a room (the concert on the Concert Hall's stage): { site, room, house (its lights' share, 0-1), lights: [{ at: [x, y, z],
  // intensity, distance, color }] over the stage }, or null
  let show = null;
  let spinTime = 0; // s of the game's clock that what turns in the models has turned for
  let swimming = null; // js/swimming.js, fetched with the first outside that has a pool to swim in

  // --- The insides a site holds ---------------------------------------------------------------------------------------------
  /** Its inside's files that are in: { file, state, group, data, doors, rooms, ... } */
  const ready = (site) => [...site.insides.values()].filter((r) => r.state === 'ready');
  const isHeld = (site, file) => site.insides.get(file)?.state === 'ready';
  /** A list from each file that's in (floors, walls, rooms, links, seats, lights) */
  const joined = (site, key) => ready(site).flatMap((r) => r.data[key] ?? []);

  // --- Floors and walls ------------------------------------------------------------------------------------------------------
  function allFloors(site) {
    return [...(site.out?.data.floors ?? []), ...joined(site, 'floors')];
  }
  function allWalls(site) {
    const walls = [...(site.out?.data.walls ?? []), ...joined(site, 'walls')];
    for (const door of doorsOf(site)) if (door.angle < 0.05) walls.push({ a: door.d.hinge, b: door.d.latch, t: 0.08, y0: door.d.y0, y1: door.d.y1 });
    return walls;
  }
  /** What the camera keeps clear of: the walls, and every door's leaf where it's swung to */
  function eyeWalls(site) {
    const walls = [...(site.out?.data.walls ?? []), ...joined(site, 'walls')];
    for (const door of doorsOf(site)) {
      for (const sign of door.d.leaves === 2 ? [1, -1] : [1]) {
        // a pair: two leaves, each half the doorway, the second hung from the latch side and turning the other way
        const d = door.d.leaves === 2 ? half(door.d, sign) : door.d;
        const leaf = leafAt(d, door.angle * Math.sign(d.turn));
        walls.push({ a: leaf.hinge, b: leaf.latch, t: 0.06, y0: d.y0, y1: d.y1 });
      }
    }
    return walls;
  }
  function placeFloors(site) {
    const floors = allFloors(site);
    if (!floors.length) {
      clearFloor(site.id);
      return;
    }
    const pts = floors.flatMap((f) => f.poly).map(([x, z]) => toWorld(site, x, z));
    setFloor(site.id, {
      minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
      minZ: Math.min(...pts.map((p) => p.z)), maxZ: Math.max(...pts.map((p) => p.z)),
      at(x, z) {
        const p = toLocal(site, x, z);
        const y = floorAt(floors, p.x, p.z, (site.ref ?? site.y) - site.y);
        return y === null ? null : y + site.y;
      }
    });
  }

  // --- Doors -------------------------------------------------------------------------------------------------------------------
  function doorsOf(site) {
    return [...(site.out?.doors.values() ?? []), ...ready(site).flatMap((r) => [...r.doors.values()])];
  }
  function addDoors(site, list, group, part, walls) {
    const doors = new Map();
    for (const d of list) {
      // a pair of doors is two leaves, the second hung from the other jamb (`<node>_b`), turning the other way
      const door = { d, site, part, angle: 0, target: 0, node: group.getObjectByName(d.node) ?? null, collider: doorCollider(site, d, walls),
        pair: d.leaves === 2 ? group.getObjectByName(`${d.node}_b`) ?? null : null };
      colliders.add([door.collider]);
      doors.set(d.id, door);
    }
    return doors;
  }
  // Open from the start, as a lived-in building's inner doors are: the swing done and the doorway clear
  function openNow(door) {
    door.angle = door.target = Math.abs(door.d.turn);
    colliders.remove([door.collider]);
    for (const [node, sign] of [[door.node, 1], [door.pair, -1]]) {
      if (!node) continue;
      node.rotation.y = door.angle * Math.sign(door.d.turn) * sign;
      node.updateMatrixWorld(true);
    }
  }
  function removeDoors(doors) {
    for (const door of doors.values()) if (door.angle < 0.05) colliders.remove([door.collider]);
  }
  function swing(door, dt) {
    if (door.angle === door.target) return;
    const step = Math.abs(door.d.turn) / DOOR_TIME * dt * Math.sign(door.target - door.angle);
    const was = door.angle;
    door.angle = Math.abs(door.target - door.angle) <= Math.abs(step) ? door.target : door.angle + step;
    // A shut door is a wall. Once it opens it isn't: it swings into the room, out of the doorway.
    if (was < 0.05 && door.angle >= 0.05) colliders.remove([door.collider]);
    else if (was >= 0.05 && door.angle < 0.05) colliders.add([door.collider]);
    for (const [node, sign] of [[door.node, 1], [door.pair, -1]]) {
      if (!node) continue;
      node.rotation.y = door.angle * Math.sign(door.d.turn) * sign;
      node.updateMatrixWorld(true); // the scene's world matrices are only ever brought up to date by hand (js/main.js)
    }
  }

  // --- Loading -----------------------------------------------------------------------------------------------------------------
  function prepare(scene, inside) {
    scene.traverse((o) => {
      o.userData.lifted = true;
      if (!o.isMesh) return;
      const old = o.material;
      o.material = materialFor(old.name, inside);
      old.dispose();
      // Outside, a building like the others: in the sun's shadows. Inside, the sun hardly reaches.
      o.castShadow = !inside;
      o.receiveShadow = !inside;
    });
  }
  function groupFor(site, scene, name) {
    const group = new THREE.Group();
    group.name = name;
    group.position.set(site.x, site.y, site.z);
    group.rotation.y = site.yaw;
    group.add(scene);
    group.userData.lifted = true;
    return group;
  }

  async function loadOutside(site) {
    site.loading = true;
    try {
      const { scene, data } = await loadModel(site.file);
      if (site.y === null) {
        // On the ground: as high as the ground is anywhere under it, kerbs and lawns too (drawn a kerb's height up), so no wall
        // stands in the air and nothing shows through its floor
        const pts = data.walls.flatMap((w) => [w.a, w.b]);
        const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
        let top = -Infinity;
        for (let x = Math.min(...xs); x <= Math.max(...xs) + 0.01; x += 1) {
          for (let z = Math.min(...zs); z <= Math.max(...zs) + 0.01; z += 1) {
            const at = toWorld(site, x, z);
            top = Math.max(top, groundHeight(at.x, at.z) + (blockAt(at.x, at.z) ? CITY_BOUNDS.sidewalkHeight : 0));
          }
        }
        site.y = top + 0.25; // the ground as drawn is a mesh between the heights it was made from, and can stand a little over them
      }
      site.ref ??= site.y;
      prepare(scene, false);
      const spins = spinners(scene, data.spin);
      const group = groupFor(site, scene, `Model_${site.id}`);
      await reveal(group);
      // Drawn once update() finds it near; till then its far version, or what it takes the place of, stays
      group.visible = false;
      site.drawn = false;
      const walls = data.walls.map((w) => wallCollider(site, w));
      colliders.add(walls);
      // Where the camera's kept clear of its walls: over it, and a little round it (holdEye())
      const ends = data.walls.flatMap((w) => [w.a, w.b]);
      const xs = ends.map((p) => p[0]), zs = ends.map((p) => p[1]);
      const bounds = { minX: Math.min(...xs) - 1, maxX: Math.max(...xs) + 1, minZ: Math.min(...zs) - 1, maxZ: Math.max(...zs) + 1 };
      site.out = { group, data, walls, bounds, doors: addDoors(site, data.doors, scene, 'out', data.walls), shut: scene.getObjectByName('doors_shut') ?? null,
        leaves: true, spins };
      showLeaves(site, false);
      placeFloors(site);
      holdPools(site);
      if (site.far?.group) site.far.group.position.y = site.y;
    } catch (e) {
      console.warn('[interiors]', site.id, e);
      site.failed = true; // what can't be had isn't asked for again
    } finally {
      site.loading = false;
    }
  }

  function dropOutside(site) {
    if (site.insides.size) letGoInside(site);
    const out = site.out;
    site.out = null;
    colliders.remove(out.walls);
    removeDoors(out.doors);
    dispose(out.group);
    clearFloor(site.id);
    removeStillWater(`site:${site.id}`);
    swimming?.removeSwimPools(site.id);
    // what's drawn in its place is worked out again straight after (update())
    site.drawn = false;
  }

  /**
   * Its pools' water, as still water in the world's frame; and those it marks `swim` to swim in (js/swimming.js, fetched for the first,
   * and given to `onSwim`)
   */
  function holdPools(site) {
    const pools = site.out.data.pools ?? [];
    if (pools.length) addStillWater(`site:${site.id}`, pools.map((p) => p.ring.map(([x, z]) => toWorld(site, x, z))), 'pool');
    if (!pools.some((p) => p.swim)) return;
    const out = site.out;
    import('./swimming.js').then((module) => {
      if (site.out !== out) return; // let go of meanwhile
      swimming = module;
      module.addSwimPools(site.id, { x: site.x, y: site.y, z: site.z, yaw: site.yaw }, pools);
      onSwim?.(module);
    }).catch((error) => console.warn('[interiors] swimming', error));
  }

  /** The outside's door leaves apart, each to swing on its own, or (from further off) the one shut piece in their place */
  function showLeaves(site, on) {
    const out = site.out;
    if (!out.shut) return;
    out.leaves = on;
    out.shut.visible = !on;
    for (const door of out.doors.values()) {
      if (door.node) door.node.visible = on;
      if (door.pair) door.pair.visible = on;
    }
  }

  /** Whether (x, z) is within m of a site's outside */
  function within(site, x, z, m) {
    const p = toLocal(site, x, z), b = site.out.bounds;
    return p.x > b.minX - m && p.x < b.maxX + m && p.z > b.minZ - m && p.z < b.maxZ + m;
  }

  // --- Far versions ----------------------------------------------------------------------------------------------------------
  async function loadFar(site) {
    const far = site.far;
    far.loading = true;
    try {
      const { scene } = await loadModel(`${site.file}-far`, false);
      prepare(scene, false);
      const group = groupFor({ ...site, y: site.y ?? groundHeight(site.x, site.z) }, scene, `Far_${site.id}`);
      await reveal(group);
      group.visible = false;
      far.group = group;
    } catch (e) {
      console.warn('[interiors]', `${site.file}-far`, e);
      far.failed = true;
    } finally {
      far.loading = false;
    }
  }
  function dropFar(site) {
    dispose(site.far.group);
    site.far.group = null;
  }

  /** One of a site's inside's files, `file` as a door names it, fetched into the others it holds */
  async function fetchInside(site, file) {
    const record = { file, state: 'loading', doors: new Map() };
    site.insides.set(file, record);
    try {
      const { scene, data } = await loadModel(`models/${file}`);
      if (site.insides.get(file) !== record) return;
      prepare(scene, true);
      const instanced = instance(scene, data.instances);
      // The sun's coloured light through its stained glass, for an inside whose JSON has its windows' pictures (js/stained-light.js)
      let sunlight = null;
      if (data.windows) {
        const { createSunlight } = await import('./stained-light.js');
        sunlight = createSunlight(data, site.yaw, cityUniforms);
        sunlight.update();
        scene.add(sunlight.mesh);
      }
      // Its art, for a gallery's (js/art.js, the works in js/artworks.js): made here, its paintings painted in a worker as it comes
      let art = null;
      if (data.hangs?.length || data.plinths?.length) {
        try {
          const { createArt } = await import('./art.js');
          art = createArt({ site: site.id, data, scene, materialFor: (name) => materialFor(name, true), glow: indoorLight, detail: artDetail() });
        } catch (e) {
          console.warn('[interiors]', `${file}: its art`, e);
        }
      }
      const group = groupFor(site, scene, `Inside_${site.id}_${file}`);
      for (const r of data.rooms) {
        const node = scene.getObjectByName(r.node);
        if (node) node.visible = false;
      }
      await reveal(group);
      if (site.insides.get(file) !== record) {
        dispose(group);
        sunlight?.dispose();
        art?.dispose();
        return;
      }
      record.group = group;
      record.data = data;
      record.instanced = instanced;
      record.sunlight = sunlight;
      record.art = art;
      record.walls = data.walls.map((w) => wallCollider(site, w));
      colliders.add(record.walls);
      record.doors = addDoors(site, data.doors, scene, 'in', [...data.walls, ...site.out.data.walls]);
      record.rooms = new Map(data.rooms.map((r) => [r.id, scene.getObjectByName(r.node)]));
      record.state = 'ready';
      // Its own doors, between its rooms, are open unless locked, or they lead to another of its files not here yet (the head of a
      // stair down); those in the outside, to the street and the house's terraces, as they were left
      for (const door of record.doors.values()) if (!door.d.locked && !(door.d.inside && !isHeld(site, door.d.inside))) openNow(door);
      placeFloors(site);
      // Doors held ajar while it came open the rest of the way
      for (const door of doorsOf(site)) if (door.d.inside === file && door.target > 0) door.target = Math.abs(door.d.turn);
    } catch (e) {
      console.warn('[interiors]', file, e);
      if (site.insides.get(file) === record) site.insides.delete(file);
      for (const door of doorsOf(site)) if (door.d.inside === file) door.target = 0;
    }
  }

  function letGoInside(site) {
    const records = [...site.insides.values()];
    site.insides.clear();
    for (const inside of records) {
      if (inside.state !== 'ready') continue;
      colliders.remove(inside.walls);
      removeDoors(inside.doors);
      dispose(inside.group);
      inside.sunlight?.dispose();
      inside.art?.dispose();
    }
    // The ways in shut behind you
    for (const door of site.out?.doors.values() ?? []) {
      if (door.d.inside) {
        if (door.angle >= 0.05) colliders.add([door.collider]);
        door.angle = door.target = 0;
        for (const node of [door.node, door.pair]) if (node) node.rotation.y = 0;
      }
    }
    placeFloors(site);
    if (here?.site === site) here = null;
  }

  // --- Each frame --------------------------------------------------------------------------------------------------------------
  /**
   * `player`: the active entity, `mode` the controllers' mode, `eye` the camera's position and `look` its direction (the game's
   * frame), and `head` the point over the player's head a following camera looks on from, or null for one that doesn't follow. The eye
   * is moved in, if a wall's in its way. Returns whether the player's in a room of an inside (`indoors`), and in one under a roof
   * (`building`: not a courtyard, a terrace or a balcony, which are `outdoor`), what F would do, whether the camera was kept clear of a
   * building (`kept`), and whether that brought it so near that the player shouldn't be drawn (`close`); and which site and room (`site`,
   * `room`) and the room of the seat you're in (`seat`), for what happens there (the concert in the Opera House's hall).
   */
  function update(dt, player, mode, eye, look, head = null) {
    frameCount++;
    spinTime += dt;
    const { x, z } = player.position;
    const reach = farReach();
    for (const site of sites) {
      const wanted = site.debug ? tileBuilt(x, z) && Math.hypot(site.x - x, site.z - z) < DEBUG_RANGE : tileBuilt(site.x, site.z);
      if (wanted && !site.out && !site.loading && !site.failed) loadOutside(site);
      else if (!wanted && site.out) dropOutside(site);
      // One of its three shapes (js/first-shapes.js): the model within its `near` of the camera once it's in; its far version past
      // that once it's in; its first shape otherwise, and within `near` while the model comes, if it has one there to show. The line
      // is a little further out for what's drawn on the near side of it, so it doesn't flicker there.
      const seen = Math.hypot(site.x - eye.x, (site.y ?? eye.y) - eye.y, site.z - eye.z);
      const near = seen < site.near * (site.shape === 'far' ? 1 : 1.1);
      const drawn = !!site.out && (near || here?.site === site);
      const shape = drawn ? 'model' : site.far?.group && (!near || !hasFirstShape(site.id)) ? 'far' : 'first';
      if (drawn !== site.drawn) {
        site.drawn = drawn;
        site.out.group.visible = drawn;
      }
      if (shape !== site.shape) {
        site.shape = shape;
        showFirstShape(site.id, shape);
      }
      // ...and its inside with it, or it would stand there alone
      for (const r of site.insides.values()) if (r.group) r.group.visible = drawn;
      if (site.far) {
        const away = Math.hypot(site.x - eye.x, site.z - eye.z);
        // From the first view only for a site with no first shape of the map's: one that replaces none of the map's buildings
        const wantFar = (reach > 0 && away < reach) || (!site.debug && !site.replaces.length && tileReady(site.x, site.z));
        if (wantFar && !site.far.group && !site.far.loading && !site.far.failed) loadFar(site);
        else if (!wantFar && site.far.group && away > reach + FAR_KEEP) dropFar(site);
        if (site.far.group) site.far.group.visible = shape === 'far';
      }
      if (!site.out) continue;
      // What turns in it (a wheel), while it's drawn
      if (drawn) for (const s of site.out.spins) turn(s, (spinTime * s.rpm * 2 * Math.PI / 60) % (2 * Math.PI));
      const doorsNear = within(site, x, z, DOORS_NEAR) || within(site, eye.x, eye.z, DOORS_NEAR)
        || [...site.out.doors.values()].some((door) => door.angle > 0 || door.target > 0);
      if (doorsNear !== site.out.leaves) showLeaves(site, doorsNear);
      // Which floor counts, where there are floors over floors: the one under the player's feet now
      const away = Math.hypot(site.x - x, site.z - z);
      if (mode === 'person' && !player.surface && away < site.reach) site.ref = player.surfaceY ?? site.ref;
      if (site.insides.size && away > site.reach && here?.site !== site) letGoInside(site);
      for (const door of doorsOf(site)) swing(door, dt);
    }

    // Where the player is
    here = null;
    if (exit && !exit.site.insides.size) exit = null;
    if (mode === 'person') {
      for (const site of sites) {
        const p = toLocal(site, x, z);
        for (const inside of ready(site)) {
          const room = roomAt(inside.data.rooms, p.x, (site.ref ?? site.y) - site.y + 0.1, p.z);
          if (room) here = { site, room, inside };
        }
      }
    }

    const kept = head ? holdEye(dt, player, eye, head) : (held = Infinity, false);

    // What's drawn of each inside: the rooms seen from the camera, where it's been kept to, and from the player
    for (const site of sites) {
      const insides = ready(site);
      if (!insides.length) continue;
      // across its files: a stair's room is in one, the lobby at its foot in the next
      const doors = new Map(doorsOf(site).map((door) => [door.d.id, door]));
      const open = (id) => {
        const door = doors.get(id);
        return !door || door.angle > 0.05;
      };
      const links = joined(site, 'links'), rooms = joined(site, 'rooms');
      const e = toLocal(site, eye.x, eye.z);
      const eyeRoom = roomAt(rooms, e.x, eye.y - site.y, e.z)?.id ?? 'out';
      const seen = visibleRooms(links, eyeRoom, open, SEEN_DEPTH);
      if (here?.site === site) for (const r of visibleRooms(links, here.room.id, open, 1)) seen.add(r);
      for (const inside of insides) {
        for (const [id, node] of inside.rooms) if (node) node.visible = seen.has(id);
        for (const door of inside.doors.values()) {
          const shown = door.d.rooms.some((r) => seen.has(r));
          if (door.node) door.node.visible = shown;
          if (door.pair) door.pair.visible = shown;
        }
        // the sun through its glass, thrown again if the time of day has moved it
        inside.sunlight?.update();
      }
    }

    const showing = show && here?.site.id === show.site && here.room.id === show.room ? show : null;
    placeLights(x, z, showing);
    findPrompt(player, mode, look);
    // How much the inside's own colours glow (its room's `glow`, or its own, a house's 0.1 unless they say), and how sheltered from the
    // sky its room is; less, and its lamps dimmer, while a show's house lights are down
    indoorLight.value = (here?.room.glow ?? here?.inside.data.glow ?? 0.1) * (showing ? showing.house : 1);
    lampLight.value = 1.4 * (showing ? 0.2 + 0.8 * showing.house : 1);
    return { indoors: here !== null, building: here !== null && !here.room.outdoor, prompt: prompt && prompt.label, kept, close: kept && held < EYE_CLOSE,
      shelter: here?.room.shelter ?? null, site: here?.site.id ?? null, room: here?.room.id ?? null, seat: seated?.room ?? null };
  }

  /**
   * The camera stays clear of the building you're in or beside: moved in along the line from over your head to it, short of the first
   * wall, door leaf, floor or ceiling, as if it were a ball EYE_PAD round. In at once, back out at EYE_EASE. True if it's beside one.
   */
  function holdEye(dt, player, eye, head) {
    const { x, z } = player.position;
    let site = here?.site ?? null;
    if (!site) {
      for (const s of sites) {
        if (!s.out) continue;
        const p = toLocal(s, x, z), b = s.out.bounds;
        if (p.x > b.minX && p.x < b.maxX && p.z > b.minZ && p.z < b.maxZ) site = s;
      }
    }
    if (!site) {
      held = Infinity;
      return false;
    }
    const a = toLocal(site, head.x, head.z), b = toLocal(site, eye.x, eye.z);
    const from = { x: a.x, y: head.y - site.y, z: a.z }, to = { x: b.x, y: eye.y - site.y, z: b.z };
    // where there's no floor over it, no higher than the top floor's ceiling: over a stairwell too, which is open up to that
    const roof = here ? Math.max(...joined(site, 'rooms').map((r) => r.y1)) - 0.7 : Infinity;
    const reach = eyeReach(eyeWalls(site), allFloors(site), from, to, roof);
    const length = Math.hypot(to.x - from.x, reach.y - from.y, to.z - from.z);
    const want = reach.t * length;
    held = want < held ? want : Math.min(want, held + EYE_EASE * dt);
    const k = length > 1e-6 ? held / length : 0;
    eye.x = head.x + (eye.x - head.x) * k;
    eye.z = head.z + (eye.z - head.z) * k;
    eye.y = head.y + (site.y + reach.y - head.y) * k;
    return true;
  }

  function placeLights(x, z, showing = null) {
    const wanted = [];
    // a show's lights over its stage first, then the room's lamps nearest you, as dim as its house lights
    const staged = (showing?.lights ?? []).filter((l) => l.intensity > 0.01).slice(0, lights.length - 1);
    if (here) {
      const { site } = here;
      const p = toLocal(site, x, z);
      const feet = (site.ref ?? site.y) - site.y;
      for (const l of joined(site, 'lights')) {
        const d = Math.hypot(l[0] - p.x, l[2] - p.z) + Math.abs(l[1] - feet - 2) * 2;
        if (d < LIGHTS_REACH) wanted.push({ l, d, site });
      }
      wanted.sort((a, b) => a.d - b.d);
    }
    lights.forEach((light, i) => {
      if (i < staged.length) {
        const l = staged[i];
        light.position.set(...l.at);
        light.intensity = l.intensity;
        light.distance = l.distance;
        light.color.setHex(l.color);
        return;
      }
      const w = wanted[i - staged.length];
      if (!w) {
        light.intensity = 0;
        light.position.set(0, -1000, 0);
        return;
      }
      const at = toWorld(w.site, w.l[0], w.l[2]);
      light.position.set(at.x, w.site.y + w.l[1], at.z);
      light.intensity = 5 * (showing ? showing.house : 1);
      light.distance = 9;
      light.color.setHex(0xffe6c4);
    });
    lightsOn.length = 0;
    lightsOn.push(...wanted.slice(0, lights.length - staged.length).map((w) => w.l));
  }

  function findPrompt(player, mode, look) {
    prompt = null;
    if (mode !== 'person') return;
    if (seated) {
      prompt = { kind: 'stand', label: 'Stand up' };
      return;
    }
    const { x, z } = player.position;
    let best = null;
    for (const site of sites) {
      if (!site.out || Math.hypot(site.x - x, site.z - z) > site.reach) continue;
      const p = toLocal(site, x, z);
      const feet = (player.surfaceY ?? site.y) - site.y;
      const heading = player.heading - site.yaw;
      const c = Math.cos(site.yaw), s = Math.sin(site.yaw);
      const lookLocal = look && { x: look.x * c - look.z * s, z: look.x * s + look.z * c };
      const doors = doorsOf(site).filter((door) => Math.abs(door.d.y0 - feet) < 1.0);
      const reach = doorInReach(doors.map((door) => door.d), p.x, p.z, heading, lookLocal);
      if (reach && (!best || reach.d < best.d)) {
        const door = doors.find((dd) => dd.d === reach.door);
        if (!door.d.locked) best = { kind: 'door', site, door, d: reach.d, label: door.target > 0 ? 'Close' : 'Open' };
      }
      if (here?.site === site) {
        const sr = seatInReach(joined(site, 'seats'), p.x, feet, p.z);
        if (sr && (!best || sr.d < best.d)) best = { kind: 'seat', site, seat: sr.seat, d: sr.d, label: 'Sit' };
      }
    }
    prompt = best;
  }

  /** F, the hand button, or X: whatever the prompt says. `sit(seat)` and `stand()` are the controllers'. True if it did something. */
  function use({ sit, stand }) {
    if (seated) {
      stand();
      seated = null;
      return true;
    }
    if (!prompt) return false;
    if (prompt.kind === 'door') {
      const { door, site } = prompt;
      if (door.target > 0) door.target = 0;
      else if (door.d.inside && !isHeld(site, door.d.inside)) {
        door.target = Math.abs(door.d.turn) * AJAR;
        if (!site.insides.has(door.d.inside)) fetchInside(site, door.d.inside);
      } else door.target = Math.abs(door.d.turn);
      return true;
    }
    if (prompt.kind === 'seat') {
      const { seat: s, site } = prompt;
      const at = toWorld(site, s.at[0], s.at[2]);
      const heading = s.facing + site.yaw;
      const floor = (site.ref ?? site.y);
      // Up again where there's room: in front, unless there's a desk there, then round it
      const spot = standSpot(allWalls(site), joined(site, 'rooms'), s);
      const stand = spot && toWorld(site, spot.x, spot.z);
      if (stand && sit({ x: at.x, z: at.z, heading, seatY: site.y + s.at[1] - floor, stand })) seated = s;
      return true;
    }
    return false;
  }

  /** Stood up some other way (moving, or into a car) */
  function stood() {
    seated = null;
  }

  /**
   * The way out of the inside you're in (X, js/main.js): the footpath in front of its front door, facing it, or its site's own (js/interior-data.js
   * exitSpot()). { x, z, heading, y, via, door } in the world's frame, or null when you aren't in one.
   */
  function exitSpot() {
    if (!here) return null;
    const { site } = here;
    if (exit?.site !== site) exit = { site, spot: findExit(site, [...site.out.doors.values()].map((dd) => dd.d), joined(site, 'rooms'), footpath) };
    return exit.spot;
  }

  /** Where to put the player back on a reload, if they were inside: where the way out goes */
  function returnSpot() {
    return exitSpot();
  }

  /** A site's inside as one: 'ready' once any of its files is in, 'loading' while the first comes, or null */
  function insideState(site) {
    const states = [...site.insides.values()].map((r) => r.state);
    return states.includes('ready') ? 'ready' : states.length ? 'loading' : null;
  }

  function state() {
    return {
      sites: sites.map((s) => ({ id: s.id, y: s.y, out: !!s.out, inside: insideState(s), failed: s.failed, drawn: s.drawn, shape: s.shape,
        leaves: s.out?.leaves ?? null, far: s.far ? (s.far.group ? (s.far.group.visible ? 'drawn' : 'held') : s.far.failed ? 'failed' : null) : undefined })),
      held: sites.filter((s) => ready(s).length).map((s) => s.id),
      // each inside's file a site holds, and whether it's in
      files: sites.flatMap((s) => [...s.insides.values()].map((r) => ({ site: s.id, file: r.file, state: r.state }))),
      inside: here?.site.id ?? null,
      room: here?.room.id ?? null,
      floor: here ? here.site.ref : null,
      exit: here ? exitSpot() : null,
      seated: !!seated,
      prompt: prompt?.label ?? null,
      eye: Number.isFinite(held) ? +held.toFixed(2) : null, // m from over your head the camera's kept to, beside a building
      doors: sites.flatMap((s) => doorsOf(s).map((dd) => ({ site: s.id, id: dd.d.id, angle: +dd.angle.toFixed(3), target: +dd.target.toFixed(3) }))),
      drawn: sites.flatMap((s) => ready(s).flatMap((r) => [...r.rooms].filter(([, n]) => n?.visible).map(([id]) => id))),
      // what a held inside draws many of from one (a hall's seats): how many of the JSON's it draws, whether it and all it's in are shown
      // and in the scene, and how many frames ago it was last drawn (null: never)
      instances: sites.flatMap((s) => ready(s).flatMap((r) => r.instanced.map((mesh) => {
        let shown = true, o = mesh;
        for (; o.parent; o = o.parent) shown &&= o.visible;
        const want = r.data.instances.find((i) => i.node === mesh.userData.node).at.length;
        return { site: s.id, node: mesh.userData.node, name: mesh.name, count: mesh.count, want, shown: shown && o.isScene === true,
          drawn: mesh.userData.drawnAt === undefined ? null : frameCount - mesh.userData.drawnAt };
      }))),
      // the sun through a held inside's stained glass: how many windows throw it, in how many triangles, how strong
      sunlight: sites.flatMap((s) => ready(s).filter((r) => r.sunlight).map((r) => ({ site: s.id, ...r.sunlight.state() }))),
      // a gallery's art in each file held: its paintings and sculptures, whether their pictures are painted yet, how many are drawn
      art: sites.flatMap((s) => ready(s).filter((r) => r.art).map((r) => ({ site: s.id, file: r.file, ...r.art.state() }))),
      lights: lightsOn.length,
      // what turns in each model drawn (a wheel): its node, the angle it's turned to, and how many it carries round level
      spins: sites.flatMap((s) => (s.out?.spins ?? []).map((sp) => ({ site: s.id, node: sp.node.name, angle: +sp.angle.toFixed(4), level: sp.at.length,
        drawn: s.drawn })))
    };
  }

  /**
   * The pools of the outsides held whose water moves (`sim` in their JSON's `pools`): { id, site: { x, y, z, yaw }, pool, drawn, model }:
   * `model` the model's group, `drawn` whether it's drawn now
   */
  function pools() {
    const out = [];
    for (const site of sites) {
      for (const pool of site.out?.data.pools ?? []) {
        if (pool.sim) out.push({ id: `${site.id}:${pool.id}`, site: { x: site.x, y: site.y, z: site.z, yaw: site.yaw }, pool, drawn: site.drawn, model: site.out.group });
      }
    }
    return out;
  }

  /** A show's lights in a room, or null (see `show` above) */
  function setShow(spec) {
    show = spec;
  }

  return { update, use, stood, exitSpot, returnSpot, state, indoorLight, setShow, pools };
}

export { createInteriors, loadModel, materialFor };
