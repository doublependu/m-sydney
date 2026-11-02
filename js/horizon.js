import * as THREE from 'three/webgpu';
import { attribute } from 'three/tsl';
import { GEO, fileBytes, loadFar, tileKeyAt } from './geodata.js';
import { hideWhereFarLevel } from './far-level.js';

// Everything beyond what's held, out to the whole box: the hills and the coast, how built up each place is, and the tallest towers
// (tools/build-horizon.mjs). A few draws and about a hundred thousand triangles, wherever you are. It's hidden where a square of the far
// level is there to draw instead, and everything nearer stands on that.

const SEA = -32768;
const DROP = 5; // m under the land: nearer ground wins where they overlap
const SEA_FLOOR = -12; // m: the shore is where this mesh meets the water
const CHUNK = 32; // cells to a mesh
const BUSH = new THREE.Color(0x3a5433), SCATTERED = new THREE.Color(0x56703f), SUBURB = new THREE.Color(0x71794f), DENSE = new THREE.Color(0x8a8571); // yards, from afar
const TONES = [BUSH, SCATTERED, SUBURB, DENSE];

let file = null;
async function loadHorizon() {
  if (file) return file;
  const bytes = await fileBytes('horizon.bin.gz');
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const [x0, z0, cell, w, h, towers] = new Int32Array(data, 0, 6);
  const towerData = new Float32Array(data, 24, towers * 5);
  const heightStart = 24 + towers * 20;
  file = { x0, z0, cell, w, h, towers: towerData, heights: new Int16Array(data.slice(heightStart, heightStart + w * h * 2)), use: new Uint8Array(data, heightStart + w * h * 2, w * h) };
  return file;
}

/** Height of the land in the horizon's own coarse grid, for things standing on it */
function horizonHeight(x, z) {
  const H = file;
  if (!H) return 0;
  const fx = (x - H.x0) / H.cell, fz = (z - H.z0) / H.cell;
  const i = Math.max(0, Math.min(H.w - 2, Math.floor(fx))), j = Math.max(0, Math.min(H.h - 2, Math.floor(fz)));
  const at = (a, b) => { const y = H.heights[b * H.w + a]; return y === SEA ? 0 : y; };
  const u = fx - i, v = fz - j;
  return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v;
}

function horizonMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
  material.colorNode = attribute('landTone', 'vec3');
  material.maskNode = hideWhereFarLevel();
  return material;
}

/** Fills `group` with the horizon */
function* buildHorizon(group) {
  yield Promise.all([loadHorizon(), loadFar()]);
  const H = file;
  const material = horizonMaterial();
  const yOf = (i, j) => { const y = H.heights[j * H.w + i]; return y === SEA ? SEA_FLOOR : y - DROP; };
  let first = null;
  const tone = new THREE.Color();
  for (let cz = 0; cz < H.h - 1; cz += CHUNK) {
    yield;
    for (let cx = 0; cx < H.w - 1; cx += CHUNK) {
      const position = [], color = [], index = [];
      const seen = new Map();
      const vertex = (i, j) => {
        const key = j * H.w + i;
        let v = seen.get(key);
        if (v === undefined) {
          v = position.length / 3;
          seen.set(key, v);
          position.push(H.x0 + i * H.cell, yOf(i, j), H.z0 + j * H.cell);
          tone.copy(TONES[H.use[key]]);
          color.push(tone.r, tone.g, tone.b);
        }
        return v;
      };
      for (let j = cz; j < Math.min(cz + CHUNK, H.h - 1); j++) {
        for (let i = cx; i < Math.min(cx + CHUNK, H.w - 1); i++) {
          const a = H.heights[j * H.w + i], b = H.heights[j * H.w + i + 1], c = H.heights[(j + 1) * H.w + i], d = H.heights[(j + 1) * H.w + i + 1];
          if (a === SEA && b === SEA && c === SEA && d === SEA) continue;
          const p = vertex(i, j), q = vertex(i + 1, j), r = vertex(i, j + 1), s = vertex(i + 1, j + 1);
          index.push(p, r, q, q, r, s);
        }
      }
      if (!index.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
      geometry.setAttribute('landTone', new THREE.Float32BufferAttribute(color, 3));
      geometry.setIndex(index);
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = 'Horizon';
      mesh.userData.lifted = true;
      mesh.userData.farAway = true;
      if (first) mesh.userData.sharesPipelineWith = first;
      else first = mesh;
      group.add(mesh);
    }
  }
  // The towers you can see from anywhere
  const towers = [];
  for (let k = 0; k < H.towers.length; k += 5) {
    const x = H.towers[k], z = H.towers[k + 1];
    // On the map, a tower is one of the buildings of its far square
    if (!Object.hasOwn(GEO.tiles, tileKeyAt(x, z))) towers.push([x, z, H.towers[k + 2], H.towers[k + 3], H.towers[k + 4]]);
  }
  if (towers.length) {
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const walls = new THREE.MeshStandardNodeMaterial({ roughness: 0.7, color: 0x8d9096 });
    const mesh = new THREE.InstancedMesh(box, walls, towers.length);
    const m = new THREE.Matrix4();
    towers.forEach(([x, z, w, d, height], i) => {
      m.makeScale(w, height, d).setPosition(x, horizonHeight(x, z) - DROP, z);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.name = 'HorizonTowers';
    mesh.userData.lifted = true;
    mesh.userData.farAway = true;
    group.add(mesh);
  }
}

export { buildHorizon, horizonHeight };
