import * as THREE from 'three/webgpu';
import { color, mix, smoothstep, step, uniform, vertexColor } from 'three/tsl';
import { CITY_BOUNDS, blockAt } from './city-config.js';
import { MODEL_SITES } from './model-sites.js';
import { clearFloor, groundHeight, setFloor } from './surfaces.js';
import { cityUniforms } from './tsl-materials.js';
import {
  DOOR_TIME, doorCollider, doorInReach, eyeReach, floorAt, leafAt, roomAt, seatInReach, standSpot, toLocal, toWorld, visibleRooms,
  wallCollider
} from './interior-data.js';

// Buildings drawn from models of their own (js/model-sites.js), and the insides of those that have one.
// - The outside comes with its tile, like any building: its walls, the leaves of its doors, the floors in front of them. Nothing about it
//   says whether there's anything behind its front door.
// - At a door, within reach and facing it, F opens it (a hand button on touch, X on a gamepad). If there's an inside, that's when it's
//   fetched: the door swings to a little open while it comes, then all the way. It's let go of RELEASE metres after you leave.
// - Inside, only the rooms you can see are drawn: the one you're in, and those through open doorways from it (interior-data.js).
// - In it or beside it, the camera behind you is kept clear of its walls, floors and ceilings, so it never looks through one.
// Every site's model is in its own frame (x across, z along, y up from its ground floor), placed at (x, y, z) and turned by yaw.

const RELEASE = 60; // m from a building that its inside is let go of
const DEBUG_RANGE = 700; // m: a debug site is drawn within this, having no tile of its own
const AJAR = 0.3; // of a door's swing, while what's behind it is fetched
const LIGHTS_REACH = 9; // m: a room's lamp lights you within this
const EYE_EASE = 2.5; // m/s the camera goes back out once a wall's no longer in its way; it comes in at once
const EYE_CLOSE = 0.7; // m from over your head: nearer than this, you aren't drawn, or you'd fill the view
const SEEN_DEPTH = 3; // rooms deep, through open doorways, that the camera sees

// One material of each kind for every model: they compile once. Their colour is in the vertices; inside, a little of it glows, the
// light the model's lamps and windows give, baked into its vertices; three lights are moved round as well.
const ROUGH = { plaster: [0.9, 0], paint: [0.55, 0], timber: [0.45, 0], boards: [0.5, 0], stone: [0.85, 0], tile: [0.3, 0], metal: [0.4, 0.8],
  iron: [0.6, 0.6], fabric: [0.95, 0], ceramic: [0.2, 0], roof: [0.8, 0.1], leaf: [0.8, 0], lamp: [0.4, 0] };
const indoorLight = uniform(0.1);
const materials = new Map();
function materialFor(name, inside) {
  const key = `${inside ? 'in' : 'out'}:${name}`;
  let m = materials.get(key);
  if (m) return m;
  if (name === 'glass') {
    // From the street a window like the neighbours': dark by day, lit at night. It faces out only, so from inside you see through it.
    m = new THREE.MeshStandardNodeMaterial({ color: 0x232b30, roughness: 0.06, metalness: 0.1, flatShading: true });
    // About half of them lit, as the city's are, each a little warmer or cooler: each pane's vertex colour is two numbers, the same over
    // the pane, that say which (the model scripts' glass_roll); glass has a colour of its own
    const roll = vertexColor();
    const lit = step(roll.r, 0.5);
    const tint = mix(color(0xffc98a), color(0xfff1d6), roll.g);
    m.emissiveNode = tint.mul(smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow)).mul(lit.mul(0.6).add(0.03));
  } else {
    const [roughness, metalness] = ROUGH[name] ?? [0.8, 0];
    // flat: the models carry no normals, every face is flat
    m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness, metalness, flatShading: true });
    if (name === 'lamp') m.emissiveNode = vertexColor().mul(inside ? 1.4 : smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow).mul(1.4));
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
async function loadModel(file) {
  if (!loader) {
    const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
      import('three/addons/loaders/GLTFLoader.js'), import('three/addons/libs/meshopt_decoder.module.js')
    ]);
    loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
  }
  const url = (ext) => new URL(`${file}.${ext}`, document.baseURI).href;
  const [gltf, data] = await Promise.all([loader.loadAsync(url('glb')), fetch(url('json')).then((r) => {
    if (!r.ok) throw new Error(`${file}.json: ${r.status}`);
    return r.json();
  })]);
  return { scene: gltf.scene, data };
}

function dispose(group) {
  group.removeFromParent();
  group.traverse((o) => {
    if (!o.isMesh) return;
    o.dispatchEvent({ type: 'dispose' });
    o.geometry.dispose();
  });
}

/**
 * `reveal(group)` puts a group in the scene with its shaders ready. `colliders` is { add, remove }. `lights` are PointLights kept for
 * this. `tileBuilt(x, z)` says whether the tile at (x, z) is drawn, so a site can be. `debug`: the debug sites too.
 */
function createInteriors({ reveal, colliders, lights, tileBuilt, debug = false }) {
  const sites = MODEL_SITES.filter((s) => debug || !s.debug).map((s) => ({
    ...s, y: s.y ?? null, out: null, inside: null, loading: false, failed: false, ref: null
  }));
  let here = null; // { site, room } the player is in
  let prompt = null; // { kind: 'door' | 'seat', site, door | seat, label }
  let seated = null;
  let held = Infinity; // m from over your head the camera can be, eased back out (holdEye())
  const lightsOn = [];

  // --- Floors and walls ------------------------------------------------------------------------------------------------------
  function allFloors(site) {
    return [...(site.out?.data.floors ?? []), ...(site.inside?.data?.floors ?? [])];
  }
  function allWalls(site) {
    const walls = [...(site.out?.data.walls ?? []), ...(site.inside?.data?.walls ?? [])];
    for (const door of doorsOf(site)) if (door.angle < 0.05) walls.push({ a: door.d.hinge, b: door.d.latch, t: 0.08, y0: door.d.y0, y1: door.d.y1 });
    return walls;
  }
  /** What the camera keeps clear of: the walls, and every door's leaf where it's swung to */
  function eyeWalls(site) {
    const walls = [...(site.out?.data.walls ?? []), ...(site.inside?.data?.walls ?? [])];
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
    return [...(site.out?.doors.values() ?? []), ...(site.inside?.doors?.values() ?? [])];
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
      const group = groupFor(site, scene, `Model_${site.id}`);
      await reveal(group);
      const walls = data.walls.map((w) => wallCollider(site, w));
      colliders.add(walls);
      // Where the camera's kept clear of its walls: over it, and a little round it (holdEye())
      const ends = data.walls.flatMap((w) => [w.a, w.b]);
      const xs = ends.map((p) => p[0]), zs = ends.map((p) => p[1]);
      const bounds = { minX: Math.min(...xs) - 1, maxX: Math.max(...xs) + 1, minZ: Math.min(...zs) - 1, maxZ: Math.max(...zs) + 1 };
      site.out = { group, data, walls, bounds, doors: addDoors(site, data.doors, scene, 'out', data.walls) };
      placeFloors(site);
    } catch (e) {
      console.warn('[interiors]', site.id, e);
      site.failed = true; // what can't be had isn't asked for again
    } finally {
      site.loading = false;
    }
  }

  function dropOutside(site) {
    if (site.inside) letGoInside(site);
    const out = site.out;
    site.out = null;
    colliders.remove(out.walls);
    removeDoors(out.doors);
    dispose(out.group);
    clearFloor(site.id);
  }

  async function fetchInside(site, file) {
    site.inside = { file, state: 'loading', doors: new Map() };
    const record = site.inside;
    try {
      const { scene, data } = await loadModel(file);
      if (site.inside !== record) return;
      prepare(scene, true);
      const group = groupFor(site, scene, `Inside_${site.id}`);
      for (const r of data.rooms) {
        const node = scene.getObjectByName(r.node);
        if (node) node.visible = false;
      }
      await reveal(group);
      if (site.inside !== record) {
        dispose(group);
        return;
      }
      record.group = group;
      record.data = data;
      record.walls = data.walls.map((w) => wallCollider(site, w));
      colliders.add(record.walls);
      record.doors = addDoors(site, data.doors, scene, 'in', [...data.walls, ...site.out.data.walls]);
      record.rooms = new Map(data.rooms.map((r) => [r.id, scene.getObjectByName(r.node)]));
      record.state = 'ready';
      placeFloors(site);
      // Doors held ajar while it came open the rest of the way
      for (const door of site.out.doors.values()) if (door.target > 0) door.target = Math.abs(door.d.turn);
    } catch (e) {
      console.warn('[interiors]', file, e);
      site.inside = null;
      for (const door of site.out?.doors.values() ?? []) if (door.d.inside === file) door.target = 0;
    }
  }

  function letGoInside(site) {
    const inside = site.inside;
    site.inside = null;
    if (inside.state === 'ready') {
      colliders.remove(inside.walls);
      removeDoors(inside.doors);
      dispose(inside.group);
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
   * is moved in, if a wall's in its way. Returns whether the player's inside a building, what F would do, whether the camera was kept
   * clear of a building (`kept`), and whether that brought it so near that the player shouldn't be drawn (`close`).
   */
  function update(dt, player, mode, eye, look, head = null) {
    const { x, z } = player.position;
    for (const site of sites) {
      const wanted = site.debug ? tileBuilt(x, z) && Math.hypot(site.x - x, site.z - z) < DEBUG_RANGE : tileBuilt(site.x, site.z);
      if (wanted && !site.out && !site.loading && !site.failed) loadOutside(site);
      else if (!wanted && site.out) dropOutside(site);
      if (!site.out) continue;
      // Which floor counts, where there are floors over floors: the one under the player's feet now
      if (mode === 'person' && !player.surface && Math.hypot(site.x - x, site.z - z) < 60) site.ref = player.surfaceY ?? site.ref;
      if (site.inside && Math.hypot(site.x - x, site.z - z) > RELEASE && here?.site !== site) letGoInside(site);
      for (const door of doorsOf(site)) swing(door, dt);
    }

    // Where the player is
    here = null;
    if (mode === 'person') {
      for (const site of sites) {
        if (site.inside?.state !== 'ready') continue;
        const p = toLocal(site, x, z);
        const room = roomAt(site.inside.data.rooms, p.x, (site.ref ?? site.y) - site.y + 0.1, p.z);
        if (room) here = { site, room };
      }
    }

    const kept = head ? holdEye(dt, player, eye, head) : (held = Infinity, false);

    // What's drawn of each inside: the rooms seen from the camera, where it's been kept to, and from the player
    for (const site of sites) {
      const inside = site.inside;
      if (inside?.state !== 'ready') continue;
      const open = (id) => {
        const door = inside.doors.get(id) ?? site.out.doors.get(id);
        return !door || door.angle > 0.05;
      };
      const e = toLocal(site, eye.x, eye.z);
      const eyeRoom = roomAt(inside.data.rooms, e.x, eye.y - site.y, e.z)?.id ?? 'out';
      const seen = visibleRooms(inside.data.links, eyeRoom, open, SEEN_DEPTH);
      if (here?.site === site) for (const r of visibleRooms(inside.data.links, here.room.id, open, 1)) seen.add(r);
      for (const [id, node] of inside.rooms) if (node) node.visible = seen.has(id);
      for (const door of inside.doors.values()) {
        const shown = door.d.rooms.some((r) => seen.has(r));
        if (door.node) door.node.visible = shown;
        if (door.pair) door.pair.visible = shown;
      }
    }

    placeLights(x, z);
    findPrompt(player, mode, look);
    return { indoors: here !== null, prompt: prompt && prompt.label, kept, close: kept && held < EYE_CLOSE };
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
    const roof = here ? Math.max(...site.inside.data.rooms.map((r) => r.y1)) - 0.7 : Infinity;
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

  function placeLights(x, z) {
    const wanted = [];
    if (here) {
      const { site } = here;
      const p = toLocal(site, x, z);
      const feet = (site.ref ?? site.y) - site.y;
      for (const l of site.inside.data.lights) {
        const d = Math.hypot(l[0] - p.x, l[2] - p.z) + Math.abs(l[1] - feet - 2) * 2;
        if (d < LIGHTS_REACH) wanted.push({ l, d, site });
      }
      wanted.sort((a, b) => a.d - b.d);
    }
    lights.forEach((light, i) => {
      const w = wanted[i];
      if (!w) {
        light.intensity = 0;
        light.position.set(0, -1000, 0);
        return;
      }
      const at = toWorld(w.site, w.l[0], w.l[2]);
      light.position.set(at.x, w.site.y + w.l[1], at.z);
      light.intensity = 5;
      light.distance = 9;
      light.color.setHex(0xffe6c4);
    });
    lightsOn.length = 0;
    lightsOn.push(...wanted.slice(0, lights.length).map((w) => w.l));
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
      if (!site.out || Math.hypot(site.x - x, site.z - z) > 40) continue;
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
      if (site.inside?.state === 'ready' && here?.site === site) {
        const sr = seatInReach(site.inside.data.seats, p.x, feet, p.z);
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
      else if (door.d.inside && site.inside?.state !== 'ready') {
        door.target = Math.abs(door.d.turn) * AJAR;
        if (!site.inside) fetchInside(site, `models/${door.d.inside}`);
      } else door.target = Math.abs(door.d.turn);
      return true;
    }
    if (prompt.kind === 'seat') {
      const { seat: s, site } = prompt;
      const at = toWorld(site, s.at[0], s.at[2]);
      const heading = s.facing + site.yaw;
      const floor = (site.ref ?? site.y);
      // Up again where there's room: in front, unless there's a desk there, then round it
      const spot = standSpot(allWalls(site), site.inside.data.rooms, s);
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

  /** Where to put the player back on a reload, if they were inside: outside the door they'd have come in by */
  function returnSpot() {
    if (!here) return null;
    const { site } = here;
    const door = [...site.out.doors.values()].find((dd) => dd.d.inside) ?? [...site.out.doors.values()][0];
    if (!door) return null;
    const { hinge, latch } = door.d;
    const cx = (hinge[0] + latch[0]) / 2, cz = (hinge[1] + latch[1]) / 2;
    const L = Math.hypot(latch[0] - hinge[0], latch[1] - hinge[1]);
    const nx = -(latch[1] - hinge[1]) / L, nz = (latch[0] - hinge[0]) / L;
    for (const side of [1, -1]) {
      const px = cx + nx * side * 1.4, pz = cz + nz * side * 1.4;
      if (!roomAt(site.inside.data.rooms, px, door.d.y0 + 0.1, pz)) {
        const at = toWorld(site, px, pz);
        return { x: at.x, z: at.z, heading: Math.atan2(-nx * side, -nz * side) + site.yaw };
      }
    }
    return null;
  }

  function state() {
    return {
      sites: sites.map((s) => ({ id: s.id, y: s.y, out: !!s.out, inside: s.inside?.state ?? null, failed: s.failed })),
      held: sites.filter((s) => s.inside?.state === 'ready').map((s) => s.id),
      inside: here?.site.id ?? null,
      room: here?.room.id ?? null,
      floor: here ? here.site.ref : null,
      seated: !!seated,
      prompt: prompt?.label ?? null,
      eye: Number.isFinite(held) ? +held.toFixed(2) : null, // m from over your head the camera's kept to, beside a building
      doors: sites.flatMap((s) => doorsOf(s).map((dd) => ({ site: s.id, id: dd.d.id, angle: +dd.angle.toFixed(3), target: +dd.target.toFixed(3) }))),
      drawn: sites.flatMap((s) => (s.inside?.state === 'ready' ? [...s.inside.rooms].filter(([, n]) => n?.visible).map(([id]) => id) : [])),
      lights: lightsOn.length
    };
  }

  return { update, use, stood, returnSpot, state, indoorLight };
}

export { createInteriors };
