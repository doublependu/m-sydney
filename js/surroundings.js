import * as THREE from 'three/webgpu';
import { color, float, mix, positionWorld, smoothstep, texture, vec2 } from 'three/tsl';
import { GEO, loadFar } from './geodata.js';
import { CITY_BOUNDS } from './city-config.js';
import { terrainHeight } from './terrain.js';

// Everything beyond the play area: the land around the harbour on its real hills, suburbs and bush, out to the fog.

await loadFar();
const LU = GEO.landuse;
const useGrid = (() => {
  const d = new Uint8Array(LU.w * LU.h);
  let at = 0;
  for (let i = 0; i < LU.runs.length; i += 2) {
    d.fill(LU.runs[i], at, at + LU.runs[i + 1]);
    at += LU.runs[i + 1];
  }
  return d;
})();

function createLandMaterial() {
  // Land use as a small texture: red housing, green bush, blue offices
  const data = new Uint8Array(LU.w * LU.h * 4);
  for (let i = 0; i < useGrid.length; i++) {
    const v = useGrid[i];
    data[i * 4] = v === 1 ? 255 : 0;
    data[i * 4 + 1] = v === 2 ? 255 : 0;
    data[i * 4 + 2] = v === 3 ? 255 : 0;
    data[i * 4 + 3] = 255;
  }
  const map = new THREE.DataTexture(data, LU.w, LU.h, THREE.RGBAFormat);
  map.magFilter = map.minFilter = THREE.LinearFilter;
  map.needsUpdate = true;
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
  const at = vec2(positionWorld.x.sub(LU.x0).div(LU.w * LU.cell), positionWorld.z.sub(LU.z0).div(LU.h * LU.cell));
  const use = texture(map, at);
  const ground = color(0x6d7a58);
  const suburb = mix(ground, color(0x8d8672), smoothstep(0.2, 0.8, use.r));
  const bush = mix(suburb, color(0x35502f), smoothstep(0.2, 0.8, use.g));
  mat.colorNode = mix(bush, color(0x8f8a80), smoothstep(0.2, 0.8, use.b).mul(float(0.9)));
  return mat;
}

function* buildLand(group) {
  const material = createLandMaterial();
  const positions = [], normals = [], index = [];
  let chunks = 0;
  const flush = () => {
    if (!index.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    g.setIndex(index);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, material);
    mesh.receiveShadow = true;
    mesh.userData.lifted = true;
    if (chunks) mesh.userData.sharesPipelineWith = group.children[0];
    group.add(mesh);
    chunks++;
    positions.length = normals.length = index.length = 0;
  };
  const EDGE = 70, INNER = 90;
  for (const [i, rings] of GEO.surroundings.entries()) {
    const toPoints = (flat) => {
      const pts = [];
      for (let k = 0; k < flat.length; k += 2) {
        const a = [flat[k], flat[k + 1]], b = [flat[(k + 2) % flat.length], flat[(k + 3) % flat.length]];
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / EDGE));
        for (let m = 0; m < n; m++) pts.push(new THREE.Vector2(a[0] + ((b[0] - a[0]) * m) / n, a[1] + ((b[1] - a[1]) * m) / n));
      }
      return pts;
    };
    const contour = toPoints(rings[0]);
    const holes = rings.slice(1).map(toPoints);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of contour) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.y); z1 = Math.max(z1, p.y); }
    // Inner points carry the hills across the middle of each tile
    const inside = (x, z, ring) => {
      let hit = false;
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const p = ring[a], q = ring[b];
        if ((p.y > z) !== (q.y > z) && x < ((q.x - p.x) * (z - p.y)) / (q.y - p.y) + p.x) hit = !hit;
      }
      return hit;
    };
    if (x1 - x0 > INNER && z1 - z0 > INNER && x0 < 7000 && x1 > -6000 && z0 < 6000 && z1 > -9000) {
      for (let x = Math.ceil(x0 / INNER) * INNER; x < x1; x += INNER) {
        for (let z = Math.ceil(z0 / INNER) * INNER; z < z1; z += INNER) {
          if (inside(x, z, contour) && !holes.some((h) => inside(x, z, h))) holes.push([new THREE.Vector2(x, z)]);
        }
      }
    }
    const faces = THREE.ShapeUtils.triangulateShape(contour, holes);
    const points = [...contour, ...holes.flat()];
    const first = positions.length / 3;
    for (const p of points) {
      positions.push(p.x, terrainHeight(p.x, p.y) - 0.12, p.y);
      normals.push(0, 1, 0);
    }
    for (const [a, b, c] of faces) {
      const up = (points[b].x - points[a].x) * (points[c].y - points[a].y) - (points[b].y - points[a].y) * (points[c].x - points[a].x) < 0;
      if (up) index.push(first + a, first + b, first + c);
      else index.push(first + a, first + c, first + b);
    }
    if (positions.length > 90000) flush();
    if (i % 2 === 0) yield;
  }
  flush();
}

// Houses and towers as instanced boxes on the land-use grid, nearest the play area first and thinning with distance
function* buildSuburbs(group) {
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const walls = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
  const ROOFS = [0xa8583a, 0xb46a48, 0x8c8f92, 0x6d7276, 0xc9b8a0, 0x98503a].map((c) => new THREE.Color(c));
  const CELL = 2400;
  const cells = new Map();
  const c = CITY_BOUNDS;
  const hash = (a, b) => {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  for (let j = 0; j < LU.h; j++) {
    if (j % 40 === 0) yield;
    for (let i = 0; i < LU.w; i++) {
      const v = useGrid[j * LU.w + i];
      if (v !== 1 && v !== 3) continue;
      const x = LU.x0 + (i + hash(i, j) * 0.7) * LU.cell, z = LU.z0 + (j + hash(j, i) * 0.7) * LU.cell;
      if (x > c.minX - 30 && x < c.maxX + 30 && z > c.minZ - 30 && z < c.maxZ + 30) continue;
      const far = Math.hypot(x - 300, z + 1500);
      if (far > 15000 || hash(i + 3, j) < Math.min(0.72, 0.12 + far / 22000)) continue;
      const key = Math.floor(x / CELL) * 1000 + Math.floor(z / CELL);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push({ x, z, v, r: hash(i * 3, j * 7) });
    }
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  let first = null;
  for (const list of cells.values()) {
    yield;
    const mesh = new THREE.InstancedMesh(box, walls, list.length);
    list.forEach((b, i) => {
      const tower = b.v === 3;
      const h = tower ? 14 + b.r * b.r * 70 : 6 + b.r * 5;
      s.set(tower ? 22 + b.r * 18 : 22 + b.r * 22, h, tower ? 22 + b.r * 14 : 14 + b.r * 16);
      p.set(b.x, terrainHeight(b.x, b.z) - 0.4, b.z);
      mesh.setMatrixAt(i, m.compose(p, q.setFromAxisAngle(up, b.r * 3), s));
      mesh.setColorAt(i, ROOFS[Math.floor(b.r * 37) % ROOFS.length]);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.userData.lifted = true;
    mesh.receiveShadow = true;
    if (first) mesh.userData.sharesPipelineWith = first;
    else first = mesh;
    group.add(mesh);
  }
}

function* buildSurroundings(scene) {
  const group = new THREE.Group();
  group.name = 'Surroundings';
  yield* buildLand(group);
  yield* buildSuburbs(group);
  scene.add(group);
  return { group, colliders: [], update: null };
}

export { buildSurroundings };
