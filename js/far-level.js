import * as THREE from 'three/webgpu';
import { attribute, positionWorld, texture, vec2 } from 'three/tsl';
import { GEO, TILE, fetchFarFile } from './geodata.js';
import { FACADE_TONES, ROOF_COLOURS } from './buildings.js';
import { outlineMesh } from './building-outlines.js';
import { originXZ } from './world-origin.js';

// The city beyond the tiles held: for each 4 km square, every building as a few points and a height, on plain ground coloured
// by how green it is, with the main roads across it. One mesh of each per square, so it costs a few draws wherever you look.
// A small texture says which tiles are drawn in full: the far level leaves those out (buildings by the tile they belong to,
// ground by where it is), so the two never fight.

const CELL = 100; // m of far ground
const SQUARE = GEO.farFile;
const DROP = 2; // m under the real ground, where the fine and coarse ground both show for a moment
const URBAN = new THREE.Color(0x77756f), GREEN = new THREE.Color(0x4f6c3e), ROAD = new THREE.Color(0x4a4b4e);
const PARK_LEVELS = 9;

// The texture: one texel per tile, over everything the map has
const keys = Object.keys(GEO.tiles).map((k) => k.split('_').map(Number));
const X0 = Math.min(...keys.map(([x]) => x)) - 1, Z0 = Math.min(...keys.map(([, z]) => z)) - 1;
const W = Math.max(...keys.map(([x]) => x)) - X0 + 2, H = Math.max(...keys.map(([, z]) => z)) - Z0 + 2;
let maskTexture = null;
function mask() {
  if (!maskTexture) {
    maskTexture = new THREE.DataTexture(new Uint8Array(W * H * 4), W, H, THREE.RGBAFormat);
    maskTexture.magFilter = maskTexture.minFilter = THREE.NearestFilter;
    maskTexture.generateMipmaps = false;
    maskTexture.needsUpdate = true;
  }
  return maskTexture;
}
const hideWhereShown = (tile) => texture(mask(), tile.sub(vec2(X0, Z0)).add(0.5).div(vec2(W, H))).level(0).r.lessThan(0.5);
/** For the horizon: false where this level has a square of its own, which is drawn instead */
const hideWhereFarLevel = () => texture(mask(), positionWorld.xz.add(originXZ).div(TILE).floor().sub(vec2(X0, Z0)).add(0.5).div(vec2(W, H))).level(0).g.lessThan(0.5);

let groundMaterial = null;
function farGroundMaterial() {
  if (groundMaterial) return groundMaterial;
  groundMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
  groundMaterial.colorNode = attribute('farColor', 'vec3');
  groundMaterial.maskNode = hideWhereShown(positionWorld.xz.add(originXZ).div(TILE).floor());
  return groundMaterial;
}

// A square's own land and heights, from its file
function groundOf(fx, fz, file) {
  const x0 = fx * SQUARE, z0 = fz * SQUARE, ROW = 20, GRID = 80, N = SQUARE / GRID + 1;
  const { land, grid } = file;
  const isLand = (x, z) => {
    if (land === 1) return true;
    if (land === 0) return false;
    const row = land[Math.min(land.length - 1, Math.floor((z - z0) / ROW))];
    const rx = x - x0;
    for (let k = 0; k + 1 < row.length; k += 2) if (rx >= row[k] && rx <= row[k + 1]) return true;
    return false;
  };
  const heightAt = (x, z) => {
    const u = Math.max(0, Math.min(N - 1.001, (x - x0) / GRID)), v = Math.max(0, Math.min(N - 1.001, (z - z0) / GRID));
    const i = u | 0, j = v | 0, tx = u - i, tz = v - j, k = j * N + i;
    const a = grid[k] + (grid[k + 1] - grid[k]) * tx, b = grid[k + N] + (grid[k + N + 1] - grid[k + N]) * tx;
    return (a + (b - a) * tz) * 0.25;
  };
  return { isLand, heightAt };
}

// Where the shore crosses from land to water, between two corners
function crossing(isLand, ax, az, bx, bz) {
  for (let i = 0; i < 6; i++) {
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    if (isLand(mx, mz)) { ax = mx; az = mz; } else { bx = mx; bz = mz; }
  }
  return [ax, az];
}

function* farGround(fx, fz, file) {
  const { parks, roads } = file;
  const { isLand, heightAt } = groundOf(fx, fz, file);
  const position = [], colors = [], normal = [], index = [];
  const vertex = (x, z, c, lift = 0) => {
    position.push(x, heightAt(x, z) - DROP + lift, z);
    normal.push(0, 1, 0);
    colors.push(c.r, c.g, c.b);
    return position.length / 3 - 1;
  };
  const tint = new THREE.Color();
  for (let j = 0; j < SQUARE / CELL; j++) {
    yield;
    for (let i = 0; i < SQUARE / CELL; i++) {
      const x0 = fx * SQUARE + i * CELL, z0 = fz * SQUARE + j * CELL;
      const corners = [[x0, z0], [x0, z0 + CELL], [x0 + CELL, z0 + CELL], [x0 + CELL, z0]];
      const land = corners.map(([x, z]) => isLand(x, z));
      if (!land.some(Boolean)) continue;
      // Round the cell, with the shore where it crosses an edge
      const ring = [];
      for (let k = 0; k < 4; k++) {
        const a = corners[k], b = corners[(k + 1) % 4];
        if (land[k]) ring.push(a);
        if (land[k] !== land[(k + 1) % 4]) ring.push(land[k] ? crossing(isLand, a[0], a[1], b[0], b[1]) : crossing(isLand, b[0], b[1], a[0], a[1]));
      }
      if (ring.length < 3) continue;
      tint.copy(URBAN).lerp(GREEN, (Number(parks[j * (SQUARE / CELL) + i]) || 0) / PARK_LEVELS);
      const first = position.length / 3;
      for (const [x, z] of ring) vertex(x, z, tint);
      for (let k = 1; k + 1 < ring.length; k++) index.push(first, first + k, first + k + 1);
    }
  }
  // The main roads, as a plain ribbon
  for (const [width, flat] of roads) {
    yield;
    const half = Math.max(width, 10) / 2;
    let previous = null;
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const ax = flat[i], az = flat[i + 1];
      const bx = flat[i + 2] ?? ax, bz = flat[i + 3] ?? az, px = flat[i - 2] ?? ax, pz = flat[i - 1] ?? az;
      const dx = bx - px, dz = bz - pz, L = Math.hypot(dx, dz) || 1;
      const nx = -dz / L * half, nz = dx / L * half;
      const v = [vertex(ax + nx, az + nz, ROAD, 1.2), vertex(ax - nx, az - nz, ROAD, 1.2)];
      if (previous) index.push(previous[0], v[0], previous[1], previous[1], v[0], v[1]);
      previous = v;
    }
  }
  if (!index.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute('farColor', new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(index);
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, farGroundMaterial());
  mesh.name = 'FarGround';
  mesh.userData.lifted = true;
  return mesh;
}

/** What's far away: squares join `stage`, and tiles drawn in full stop being drawn here */
function createFarLevel() {
  const squares = new Map(); // key -> { meshes, footprints }
  const footprints = [];
  let footprintVersion = 0;

  /** Fetches and builds one square, returning its meshes for the caller to add to the scene */
  function* addSquare(key, { forMap = false } = {}) {
    if (squares.has(key)) return [];
    const record = { meshes: [] };
    squares.set(key, record);
    let file = null, failed = false;
    yield fetchFarFile(key).then((f) => { file = f; }).catch(() => { failed = true; });
    if (failed) {
      squares.delete(key);
      return [];
    }
    const [fx, fz] = key.split('_').map(Number);
    const ground = yield* farGround(fx, fz, file);
    if (ground) record.meshes.push(ground);
    for (const b of file.buildings) {
      b.wall = FACADE_TONES[b.mat];
      b.roof = ROOF_COLOURS[b.roof];
    }
    const buildings = yield* outlineMesh(file.buildings, hideWhereShown);
    if (buildings) record.meshes.push(buildings);
    // The map screen draws the first few too
    if (forMap) {
      for (const b of file.buildings) {
        footprints.push({ footprints: b.rings.map((pts) => ({ h: b.height + 0.22, pts, holes: [] })) });
      }
      footprintVersion++;
    }
    return record.meshes;
  }

  /** The horizon gives way to this square's tiles, once it's there, and takes over again when it's gone */
  function setSquareHeld(key, held) {
    const [fx, fz] = key.split('_').map(Number);
    const texture = mask();
    const cells = SQUARE / TILE;
    for (let iz = fz * cells; iz < (fz + 1) * cells; iz++) {
      for (let ix = fx * cells; ix < (fx + 1) * cells; ix++) {
        const i = (iz - Z0) * W + (ix - X0);
        if (iz < Z0 || iz >= Z0 + H || ix < X0 || ix >= X0 + W) continue;
        // Only where the map has this tile: past the map's edge, in a square it only half fills, the horizon goes on
        texture.image.data[i * 4 + 1] = held && Object.hasOwn(GEO.tiles, `${ix}_${iz}`) ? 255 : 0;
      }
    }
    texture.needsUpdate = true;
  }

  /** Lets go of a square's meshes. The caller takes them out of the scene. */
  function dropSquare(key) {
    squares.delete(key);
    setSquareHeld(key, false);
  }

  function setShown(ix, iz, shown) {
    const i = (iz - Z0) * W + (ix - X0);
    if (i < 0 || i >= W * H) return;
    const texture = mask();
    texture.image.data[i * 4] = shown ? 255 : 0;
    texture.needsUpdate = true;
  }

  return { addSquare, dropSquare, setSquareHeld, setShown, footprints, footprintsVersion: () => footprintVersion };
}

/** The far squares there are, nearest (x, z) first */
function farSquaresNear(x, z, radius) {
  return Object.keys(GEO.farFiles)
    .map((key) => {
      const [fx, fz] = key.split('_').map(Number);
      const dx = Math.max(fx * SQUARE - x, 0, x - (fx + 1) * SQUARE), dz = Math.max(fz * SQUARE - z, 0, z - (fz + 1) * SQUARE);
      return { key, d: Math.hypot(dx, dz) };
    })
    .filter((s) => s.d <= radius)
    .sort((a, b) => a.d - b.d)
    .map((s) => s.key);
}

export { createFarLevel, farSquaresNear, hideWhereFarLevel };
