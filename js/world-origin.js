import * as THREE from 'three/webgpu';
import { positionWorld, uniform } from 'three/tsl';

// The GPU works in 32-bit floats: steps of a millimetre 8 km out, 8 mm at Katoomba 85 km out, and worse once a matrix multiplies them
// together, which shows as shaking. So the scene is drawn near zero. Everything keeps its place in the game's own frame: `scene` is
// moved the other way by whole steps of ORIGIN_STEP as the player goes, so what reaches the GPU stays small. It's the camera and the
// world moving together by a whole number of pattern repeats, which can't be seen.
//   Game frame: what the simulation, the map and every object's own position use. x, z as far out as the map goes.
//   Drawn frame: game frame minus the origin. What shaders see as positionWorld, and what's in any matrixWorld.
// Meshes keep their vertices around their own middle (rebaseMeshes()), and what writes its own instances each frame writes them from
// the origin (anchorToOrigin()), so nothing big gets near a shader.

const ORIGIN_STEP = 4096; // m
const MOVE_PAST = ORIGIN_STEP / 2 + 256; // m from the origin on either axis, so going back and forth over a line doesn't keep moving it
const BASE_STEP = 256; // m: meshes this close to zero, like a ferry waiting to be placed, stay as they are

const origin = { x: 0, z: 0 };
/** The origin, for a shader: game position = positionWorld.xz + originXZ */
const originXZ = uniform(new THREE.Vector2(0, 0));
/**
 * Where a fragment is, for any pattern worked out from it: the same before and after the origin moves, since it wraps at the size of a
 * step. The cost is that a pattern with a hash in it has a seam along lines 4 km apart.
 */
const patternXZ = positionWorld.xz.add(ORIGIN_STEP / 2).mod(ORIGIN_STEP).sub(ORIGIN_STEP / 2);

const anchored = new Set();
const listeners = [];

/** `object` writes what it draws from the origin: it stays put in the drawn frame, whatever the origin does */
function anchorToOrigin(object) {
  anchored.add(object);
  placeAnchor(object);
  return object;
}
function placeAnchor(object) {
  object.position.x = origin.x;
  object.position.z = origin.z;
  object.updateMatrix();
}

function shiftWorldMatrices(object, dx, dz) {
  const e = object.matrixWorld.elements;
  e[12] -= dx;
  e[14] -= dz;
  if (object.isCamera) object.matrixWorldInverse.copy(object.matrixWorld).invert();
  const { children } = object;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (anchored.has(child)) placeAnchor(child);
    else shiftWorldMatrices(child, dx, dz);
  }
}

/** Puts the origin at (x, z), whole steps of ORIGIN_STEP. Everything in `scene` has its matrices moved. */
function setOrigin(scene, x, z) {
  const dx = x - origin.x, dz = z - origin.z;
  origin.x = x;
  origin.z = z;
  originXZ.value.set(x, z);
  scene.position.set(-x, 0, -z);
  scene.updateMatrix();
  shiftWorldMatrices(scene, dx, dz);
  for (const listener of listeners) listener();
}

/** Moves the origin if (x, z) has got far enough from it. True if it did. */
function moveOriginNear(scene, x, z) {
  if (Math.abs(x - origin.x) <= MOVE_PAST && Math.abs(z - origin.z) <= MOVE_PAST) return false;
  setOrigin(scene, Math.round(x / ORIGIN_STEP) * ORIGIN_STEP, Math.round(z / ORIGIN_STEP) * ORIGIN_STEP);
  return true;
}

/** `listener` is told when the origin has moved */
function onOriginMove(listener) {
  listeners.push(listener);
}

// ?originTest=85000: what every vertex and instance goes through out at that distance, rounded to a 32-bit float there. The map itself
// stays where it is, so the check on the real thing comes when the map reaches that far.
const TEST_OFFSET = typeof location === 'undefined' ? 0 : Number(new URLSearchParams(location.search).get('originTest')) || 0;
const fromBase = TEST_OFFSET
  ? (v, base) => Math.fround(v + TEST_OFFSET) - TEST_OFFSET - base
  : (v, base) => v - base;

const baseOf = (min, max) => Math.round((min + max) / 2 / BASE_STEP) * BASE_STEP;

// A geometry written in game coordinates, moved to be around (bx, bz). The same geometry may be on two meshes: it's moved once.
const moved = new WeakMap();
function moveGeometry(geometry, bx, bz) {
  moved.set(geometry, { x: bx, z: bz });
  const { array } = geometry.attributes.position;
  for (let i = 0; i < array.length; i += 3) {
    array[i] = fromBase(array[i], bx);
    array[i + 2] = fromBase(array[i + 2], bz);
  }
  geometry.attributes.position.needsUpdate = true;
  geometry.boundingBox = null;
  geometry.computeBoundingSphere();
}

function isUnmoved(o) {
  if (!o.matrixAutoUpdate) return o.matrix.equals(IDENTITY);
  return o.position.x === 0 && o.position.y === 0 && o.position.z === 0 && o.scale.x === 1 && o.scale.y === 1 && o.scale.z === 1
    && o.quaternion.x === 0 && o.quaternion.y === 0 && o.quaternion.z === 0;
}
const IDENTITY = new THREE.Matrix4();

function rebaseGeometryOf(mesh) {
  const { geometry } = mesh;
  const position = geometry?.attributes?.position;
  if (!position || position.isInterleavedBufferAttribute || !(position.array instanceof Float32Array) || position.itemSize !== 3 || !position.count) return;
  let base = moved.get(geometry);
  if (!base) {
    const { array } = position;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < array.length; i += 3) {
      if (array[i] < minX) minX = array[i];
      if (array[i] > maxX) maxX = array[i];
      if (array[i + 2] < minZ) minZ = array[i + 2];
      if (array[i + 2] > maxZ) maxZ = array[i + 2];
    }
    base = { x: baseOf(minX, maxX), z: baseOf(minZ, maxZ) };
    if (!base.x && !base.z) return;
    moveGeometry(geometry, base.x, base.z);
    // What casts its shadow instead, in the same coordinates
    const standIn = mesh.userData.shadowStandIn;
    if (standIn?.isBufferGeometry && !moved.has(standIn)) moveGeometry(standIn, base.x, base.z);
  }
  mesh.position.set(base.x, 0, base.z);
  mesh.updateMatrix();
}

function rebaseInstances(mesh) {
  const { count } = mesh;
  if (!count) return;
  const { array } = mesh.instanceMatrix;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = array[i * 16 + 12], z = array[i * 16 + 14];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const bx = baseOf(minX, maxX), bz = baseOf(minZ, maxZ);
  if (!bx && !bz) return;
  for (let i = 0; i < count; i++) {
    array[i * 16 + 12] = fromBase(array[i * 16 + 12], bx);
    array[i * 16 + 14] = fromBase(array[i * 16 + 14], bz);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.position.set(bx, 0, bz);
  mesh.updateMatrix();
  mesh.boundingSphere = null;
  mesh.computeBoundingSphere();
}

/**
 * Everything under `root` that was written in game coordinates goes around its own middle, with the mesh placed there to make up for it.
 * Anything already placed by its own transform is left alone: that's carried in the JavaScript's 64-bit matrices, and comes to the GPU small.
 */
function rebaseMeshes(root) {
  if (anchored.has(root)) return;
  if (root.isMesh && isUnmoved(root)) {
    if (root.isInstancedMesh) rebaseInstances(root);
    else rebaseGeometryOf(root);
  } else if (!isUnmoved(root)) return;
  for (const child of root.children) rebaseMeshes(child);
}

/**
 * What's biggest among the numbers the GPU is working with for what's drawn, for checking that nothing stays far out. Per mesh, in m:
 * { vertex, instance, model }, and the name of the mesh with the worst of each.
 */
function auditPrecision(scene) {
  const worst = { vertex: 0, vertexIn: '', instance: 0, instanceIn: '', model: 0, modelIn: '', meshes: 0 };
  scene.traverseVisible((o) => {
    if (!o.isMesh || o.userData.farAway) return;
    worst.meshes++;
    const e = o.matrixWorld.elements;
    const model = Math.max(Math.abs(e[12]), Math.abs(e[14]));
    if (model > worst.model) { worst.model = model; worst.modelIn = o.name; }
    const sphere = o.geometry?.boundingSphere;
    if (sphere && !o.isInstancedMesh) {
      const vertex = Math.max(Math.abs(sphere.center.x), Math.abs(sphere.center.z)) + sphere.radius;
      if (vertex > worst.vertex && Number.isFinite(vertex)) { worst.vertex = vertex; worst.vertexIn = o.name; }
    }
    if (o.isInstancedMesh) {
      const { array } = o.instanceMatrix;
      for (let i = 0; i < o.count; i++) {
        const instance = Math.max(Math.abs(array[i * 16 + 12]), Math.abs(array[i * 16 + 14]));
        if (instance > worst.instance) { worst.instance = instance; worst.instanceIn = o.name; }
      }
    }
  });
  return worst;
}

export { ORIGIN_STEP, anchorToOrigin, auditPrecision, moveOriginNear, onOriginMove, origin, originXZ, patternXZ, rebaseMeshes, setOrigin };
