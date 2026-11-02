// The one plain test building (plan 3, Phase 14): a hall with a door, a reception desk and a few columns, as a binary glTF. It proves the
// path for real models, and it's meant to be replaced. See "Building models" in the README for what a model has to be.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_SITES } from '../js/model-sites.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = MODEL_SITES[0];
const W = site.width / 2, L = site.length / 2, H = site.height, T = 0.3;
const { along, width: doorWidth, height: doorHeight } = site.door;

const parts = { wall: [], floor: [], roof: [], wood: [], lamp: [], frame: [] };
function box(part, x0, y0, z0, x1, y1, z1) {
  const faces = [
    [[1, 0, 0], [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]]],
    [[-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]],
    [[0, 1, 0], [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]]],
    [[0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
    [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
    [[0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]]
  ];
  for (const [normal, corners] of faces) {
    const first = part.length ? part.at(-1).v + 1 : 0;
    corners.forEach((p, k) => part.push({ p, n: normal, v: first + k }));
    part.push({ tri: [first, first + 1, first + 2, first, first + 2, first + 3], v: first + 3 });
  }
}

// The door's in the wall at x = -W
const dz0 = along - doorWidth / 2, dz1 = along + doorWidth / 2;
box(parts.wall, -W, 0, -L, -W + T, H, dz0);
box(parts.wall, -W, 0, dz1, -W + T, H, L);
box(parts.wall, -W, doorHeight, dz0, -W + T, H, dz1);
box(parts.wall, W - T, 0, -L, W, H, L);
box(parts.wall, -W, 0, -L, W, H, -L + T);
box(parts.wall, -W, 0, L - T, W, H, L);
box(parts.floor, -W, -0.3, -L, W, 0, L);
box(parts.roof, -W - 0.2, H, -L - 0.2, W + 0.2, H + 0.25, L + 0.2);
box(parts.wall, -W + T, H - 0.3, -L + T, W - T, H, L - T); // ceiling
box(parts.wood, W - 5, 0, along - 3, W - 4, 1.1, along + 3);
for (const z of [-L / 2, L / 2]) for (const x of [-W / 2, W / 2]) box(parts.frame, x - 0.3, 0, z - 0.3, x + 0.3, H - 0.3, z + 0.3);
for (const z of [-L / 2, 0, L / 2]) box(parts.lamp, -3, H - 0.36, z - 0.6, 3, H - 0.3, z + 0.6);
box(parts.frame, -W - 0.06, 0, dz0 - 0.12, -W + T + 0.06, doorHeight + 0.12, dz0); // door frame
box(parts.frame, -W - 0.06, 0, dz1, -W + T + 0.06, doorHeight + 0.12, dz1 + 0.12);
box(parts.frame, -W - 0.06, doorHeight, dz0, -W + T + 0.06, doorHeight + 0.12, dz1);

const COLOURS = {
  wall: { pbrMetallicRoughness: { baseColorFactor: [0.72, 0.68, 0.6, 1], roughnessFactor: 0.85, metallicFactor: 0 } },
  floor: { pbrMetallicRoughness: { baseColorFactor: [0.35, 0.34, 0.33, 1], roughnessFactor: 0.45, metallicFactor: 0 } },
  roof: { pbrMetallicRoughness: { baseColorFactor: [0.2, 0.2, 0.21, 1], roughnessFactor: 0.9, metallicFactor: 0 } },
  wood: { pbrMetallicRoughness: { baseColorFactor: [0.33, 0.2, 0.11, 1], roughnessFactor: 0.5, metallicFactor: 0 } },
  frame: { pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.52, 1], roughnessFactor: 0.6, metallicFactor: 0 } },
  lamp: { pbrMetallicRoughness: { baseColorFactor: [1, 0.97, 0.9, 1], roughnessFactor: 0.4, metallicFactor: 0 }, emissiveFactor: [1, 0.96, 0.86] }
};

// Packed into one binary glTF
const chunks = [], bufferViews = [], accessors = [], primitives = [], materials = [];
let offset = 0;
const push = (bytes, target) => {
  const pad = (4 - (bytes.length % 4)) % 4;
  chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), Buffer.alloc(pad));
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target });
  offset += bytes.byteLength + pad;
  return bufferViews.length - 1;
};
for (const [name, list] of Object.entries(parts)) {
  const positions = [], normals = [], indices = [];
  for (const item of list) {
    if (item.tri) indices.push(...item.tri);
    else { positions.push(...item.p); normals.push(...item.n); }
  }
  const P = Float32Array.from(positions), N = Float32Array.from(normals), I = Uint16Array.from(indices);
  const min = [0, 1, 2].map((a) => Math.min(...positions.filter((_, k) => k % 3 === a)));
  const max = [0, 1, 2].map((a) => Math.max(...positions.filter((_, k) => k % 3 === a)));
  accessors.push({ bufferView: push(P, 34962), componentType: 5126, count: P.length / 3, type: 'VEC3', min, max });
  accessors.push({ bufferView: push(N, 34962), componentType: 5126, count: N.length / 3, type: 'VEC3' });
  accessors.push({ bufferView: push(I, 34963), componentType: 5123, count: I.length, type: 'SCALAR' });
  materials.push({ name, ...COLOURS[name] });
  primitives.push({ attributes: { POSITION: accessors.length - 3, NORMAL: accessors.length - 2 }, indices: accessors.length - 1, material: materials.length - 1 });
}
const json = JSON.stringify({
  asset: { version: '2.0', generator: 'tools/build-test-building.mjs' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: site.id }],
  meshes: [{ primitives }], materials, accessors, bufferViews, buffers: [{ byteLength: offset }]
});
const jsonBytes = Buffer.from(json + ' '.repeat((4 - (json.length % 4)) % 4));
const bin = Buffer.concat(chunks);
const header = Buffer.alloc(12 + 8);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + bin.length, 8);
header.writeUInt32LE(jsonBytes.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
const binHead = Buffer.alloc(8);
binHead.writeUInt32LE(bin.length, 0); binHead.writeUInt32LE(0x004e4942, 4);
const file = path.join(ROOT, 'public', site.file);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, Buffer.concat([header, jsonBytes, binHead, bin]));
console.log(`[test building] ${site.file}: ${Math.round((12 + 8 + jsonBytes.length + 8 + bin.length) / 1024)} KB`);
