import * as THREE from 'three/webgpu';
import { MODEL_SITES } from './model-sites.js';
import { clearFloor, groundHeight, setFloor } from './surfaces.js';

// A building with a model of its own. Within NEAR metres the model is fetched and takes over from the normal building, the one its site is
// matched to: its walls become colliders, with a gap where the door is, and its floor a surface. Past FAR it all goes again. Nothing here
// is downloaded until then, and the loader only comes with the first one.

const NEAR = 200, FAR = 260; // m
const WALL = 0.3;

function toWorld(site, x, z) {
  const c = Math.cos(site.yaw), s = Math.sin(site.yaw);
  return { x: site.x + x * c + z * s, z: site.z - x * s + z * c };
}
function toLocal(site, x, z) {
  const c = Math.cos(site.yaw), s = Math.sin(site.yaw), dx = x - site.x, dz = z - site.z;
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

function wallCollider(site, x0, z0, x1, z1, base, top) {
  const outer = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([x, z]) => toWorld(site, x, z));
  return {
    minX: Math.min(...outer.map((p) => p.x)), maxX: Math.max(...outer.map((p) => p.x)),
    minZ: Math.min(...outer.map((p) => p.z)), maxZ: Math.max(...outer.map((p) => p.z)),
    minY: 0, maxY: top, baseY: base, polygon: { outer, holes: [] }
  };
}

function collidersOf(site, base) {
  const W = site.width / 2, L = site.length / 2, top = site.height + 0.3;
  const { along, width } = site.door;
  return [
    wallCollider(site, -W, -L, -W + WALL, along - width / 2, base, top),
    wallCollider(site, -W, along + width / 2, -W + WALL, L, base, top),
    wallCollider(site, W - WALL, -L, W, L, base, top),
    wallCollider(site, -W, -L, W, -L + WALL, base, top),
    wallCollider(site, -W, L - WALL, W, L, base, top),
    wallCollider(site, W - 5, along - 3, W - 4, along + 3, base, top)
  ];
}

/**
 * `reveal(group)` puts a group in the scene with its shaders ready. `standIn(id)` is { meshes, colliders, floor } for the normal building, once
 * its tile is built. `lights` are PointLights kept for this, `colliders` { add, remove }.
 */
function createInteriors({ reveal, standIn, lights, colliders }) {
  const held = new Map(); // site -> { group, colliders, floor }
  const loading = new Set();
  const failed = new Set();
  let loader = null;
  let inside = null;

  async function bring(site) {
    loading.add(site);
    try {
      if (!loader) {
        const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
        loader = new GLTFLoader();
      }
      const gltf = await loader.loadAsync(new URL(site.file, document.baseURI).href);
      const normal = standIn(site.id);
      if (!normal) return; // its tile is gone again
      // Above whatever ground is inside its walls, which was drawn for the normal building's own rough floor
      let floor = normal.floor;
      for (let x = -site.width / 2; x <= site.width / 2; x += 2) {
        for (let z = -site.length / 2; z <= site.length / 2; z += 2) {
          const at = toWorld(site, x, z);
          floor = Math.max(floor, groundHeight(at.x, at.z));
        }
      }
      floor += 0.08;
      const group = new THREE.Group();
      group.name = `Model_${site.id}`;
      group.position.set(site.x, floor, site.z);
      group.rotation.y = site.yaw;
      group.add(gltf.scene);
      group.traverse((o) => {
        o.userData.lifted = true;
        if (o.isMesh) o.castShadow = o.receiveShadow = true;
      });
      await reveal(group);
      for (const mesh of normal.meshes) mesh.visible = false;
      colliders.remove(normal.colliders);
      const walls = collidersOf(site, floor);
      colliders.add(walls);
      setFloor(site.id, { x: site.x, z: site.z, cos: Math.cos(site.yaw), sin: Math.sin(site.yaw), halfW: site.width / 2, halfL: site.length / 2, y: floor });
      held.set(site, { group, walls, floor, normal });
    } catch (e) {
      console.warn('[interiors]', e);
      failed.add(site); // a model that can't be had isn't asked for again
    } finally {
      loading.delete(site);
    }
  }

  function letGo(site, record) {
    held.delete(site);
    clearFloor(site.id);
    colliders.remove(record.walls);
    colliders.add(record.normal.colliders);
    for (const mesh of record.normal.meshes) mesh.visible = true;
    record.group.removeFromParent();
    record.group.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      for (const m of [o.material].flat()) m.dispose();
    });
    if (inside === site) inside = null;
    for (const light of lights) { light.intensity = 0; light.position.set(0, -1000, 0); }
  }

  /** Each frame: what's near (x, z). True if whoever's at (x, z) is inside a building. */
  function update(x, z) {
    for (const site of MODEL_SITES) {
      const away = Math.hypot(x - site.x, z - site.z);
      const record = held.get(site);
      if (record && away > FAR) letGo(site, record);
      else if (!record && away < NEAR && !loading.has(site) && !failed.has(site) && standIn(site.id)) bring(site);
    }
    let now = null;
    for (const site of held.keys()) {
      const p = toLocal(site, x, z);
      if (Math.abs(p.x) < site.width / 2 && Math.abs(p.z) < site.length / 2) now = site;
    }
    if (now !== inside) {
      inside = now;
      lights.forEach((light, i) => {
        const spot = inside?.lights[i];
        if (!spot) { light.intensity = 0; light.position.set(0, -1000, 0); return; }
        const at = toWorld(inside, spot[0], spot[2]);
        light.position.set(at.x, held.get(inside).floor + spot[1], at.z);
        light.intensity = 22;
        light.distance = 26;
        light.color.setHex(0xfff0dc);
      });
    }
    return inside !== null;
  }

  /** The camera stays in the room with you: back inside the walls if it's outside them. True if it was moved. */
  function keepEyeInside(eye, floorMargin = 0.5) {
    if (!inside) return false;
    const p = toLocal(inside, eye.x, eye.z);
    const W = inside.width / 2 - floorMargin, L = inside.length / 2 - floorMargin;
    const x = Math.max(-W, Math.min(W, p.x)), z = Math.max(-L, Math.min(L, p.z));
    const top = held.get(inside).floor + inside.height - 0.6;
    const moved = x !== p.x || z !== p.z || eye.y > top;
    const at = toWorld(inside, x, z);
    eye.x = at.x;
    eye.z = at.z;
    if (eye.y > top) eye.y = top;
    return moved;
  }

  return { update, keepEyeInside, state: () => ({ held: [...held.keys()].map((s) => s.id), loading: loading.size, inside: inside?.id ?? null, floor: inside ? held.get(inside).floor : null }) };
}

export { createInteriors };
