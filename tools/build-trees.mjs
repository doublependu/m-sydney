// tools/build-trees.mjs: writes js/tree-geodata.js and its gzip asset. City of Sydney's tree register south of the
// harbour, with species and height; OSM tree nodes where the register stops; and in the gardens tools/build-garden.mjs has planted (the
// Royal Botanic Garden, the Domain, round the Opera House), every plant it placed, in place of OSM's trees and the seeded ones there.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { dataPath, inDetail, load, pointInRing, toWorld } from './geo-common.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = process.argv[2] || path.join(ROOT, 'tools/data/generated/tree-geodata.js');

// Species classes, one silhouette each in js/trees.js. The garden's own kinds follow (tools/build-garden.mjs).
const CLASS = { broadleaf: 0, small: 1, gum: 2, fig: 3, palm: 4, jacaranda: 5 };
const GARDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/data/generated/garden.json'), 'utf8'));
const gardenRings = GARDEN.areas.map((a) => ({ rings: a.rings.map((f) => f.reduce((out, v, i) => (i % 2 ? out[out.length - 1].push(v) : out.push([v]), out), [])), except: a.except }));
/** In one of the gardens: its plants are build-garden's */
const inGarden = (x, z) => gardenRings.some((a) => a.rings.some((r) => pointInRing(r, x, z)) && !a.except.some((b) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1));
const RULES = [
  [/palm/i, CLASS.palm],
  [/jacaranda/i, CLASS.jacaranda],
  [/\bfig\b/i, CLASS.fig],
  [/gum|box|mahogany|ironbark|bloodwood|tallow wood|turpentine|she oak|swamp oak|stringybark|apple myrtle|banksia/i, CLASS.gum],
  [/plane|elm|oak|ash|poplar|zelkova|magnolia|pistacia|liquid|maple|tulip|robinia|nettle|flame/i, CLASS.broadleaf]
];
const classOf = (name) => RULES.find(([re]) => re.test(name))?.[1] ?? CLASS.small;

const register = load('cos_trees.json');
const digest = crypto.createHash('sha256').update(fs.readFileSync(dataPath('cos_trees.json'))).digest('hex');
const trees = [];
const taken = new Set();
const key = (x, z) => Math.round(x / 2) * 100000 + Math.round(z / 2);
for (const [lon, lat, name, height, status] of register) {
  if (name === 'Not Applicable' || (status && status !== 'Tree')) continue;
  const [x, z] = toWorld(lon, lat);
  if (!inDetail(x, z)) continue;
  taken.add(key(x, z));
  trees.push({ x, z, kind: classOf(name), height: Math.min(40, parseInt(height, 10) || 0) });
}
const fromRegister = trees.length;
// OSM fills in everywhere else: anywhere the City's register has nothing nearby
const surveyed = new Set(trees.map((t) => `${Math.floor(t.x / 200)},${Math.floor(t.z / 200)}`));
const west = Math.min(...trees.map((t) => t.x));
for (const e of load('nodes.json').elements) {
  if (e.tags?.natural !== 'tree') continue;
  const [x, z] = toWorld(e.lon, e.lat);
  if (!inDetail(x, z) || surveyed.has(`${Math.floor(x / 200)},${Math.floor(z / 200)}`) || inGarden(x, z)) continue;
  if (taken.has(key(x, z))) continue;
  taken.add(key(x, z));
  trees.push({ x, z, kind: classOf(e.tags.species || e.tags['species:en'] || e.tags.genus || ''), height: parseInt(e.tags.height, 10) || 0 });
}
void west;
// The gardens' plants, each as build-garden placed it: its small ones closer together than the trees' half-metre key tells apart
let gardenPlants = 0;
for (const [x, z, kind, height] of GARDEN.plants) {
  if (!inDetail(x, z)) continue;
  taken.add(key(x, z));
  trees.push({ x, z, kind, height: Math.min(255, height) });
  gardenPlants++;
}
// Where there's no count of them, seeded by where it is: street trees along the quieter roads, and trees in the parks. Nothing's stored about
// them but this, so it comes out the same every time.
{
  const { GEO } = await import('./data/generated/geodata.js');
  const seeded = (x, z, salt = 0) => {
    const s = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453;
    return s - Math.floor(s);
  };
  const isSurveyed = (x, z) => surveyed.has(`${Math.floor(x / 200)},${Math.floor(z / 200)}`);
  const plant = (x, z) => {
    if (!inDetail(x, z) || isSurveyed(x, z) || taken.has(key(x, z)) || inGarden(x, z)) return;
    taken.add(key(x, z));
    const r = seeded(x, z, 2);
    trees.push({ x, z, kind: r < 0.4 ? CLASS.broadleaf : r < 0.65 ? CLASS.small : r < 0.92 ? CLASS.gum : CLASS.jacaranda, height: 6 + Math.floor(seeded(x, z, 3) * 12) });
  };
  const STREET_EVERY = 35, STREET_SHARE = 0.5, PARK_EVERY = 40, PARK_SHARE = 0.35;
  const RG = GEO.roadGraph, N = RG.nodes;
  for (const link of RG.links) {
    const [a, b, , width, lanes, , inner, major, , kind = 0] = link;
    if (kind || major || lanes > 3) continue;
    const pts = [[N[a * 2], N[a * 2 + 1]]];
    for (let k = 0; k < inner.length; k += 2) pts.push([inner[k], inner[k + 1]]);
    pts.push([N[b * 2], N[b * 2 + 1]]);
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i], L = Math.hypot(bx - ax, bz - az);
      if (L < 1) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      for (let s = STREET_EVERY / 2; s < L; s += STREET_EVERY) {
        for (const side of [-1, 1]) {
          const x = ax + ux * s, z = az + uz * s;
          if (seeded(Math.round(x), Math.round(z), side) > STREET_SHARE) continue;
          const off = width / 2 + 1.8 + seeded(Math.round(x), Math.round(z), 5) * 1.2;
          plant(x + uz * off * side, z - ux * off * side);
        }
      }
    }
  }
  const inRing = (flat, x, z) => {
    let c = false;
    for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) {
      if ((flat[i + 1] > z) !== (flat[j + 1] > z) && x < ((flat[j] - flat[i]) * (z - flat[i + 1])) / (flat[j + 1] - flat[i + 1]) + flat[i]) c = !c;
    }
    return c;
  };
  for (const rings of GEO.lawns) {
    const outer = rings[0];
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < outer.length; i += 2) {
      x0 = Math.min(x0, outer[i]); x1 = Math.max(x1, outer[i]); z0 = Math.min(z0, outer[i + 1]); z1 = Math.max(z1, outer[i + 1]);
    }
    for (let x = Math.ceil(x0 / PARK_EVERY) * PARK_EVERY; x < x1; x += PARK_EVERY) {
      for (let z = Math.ceil(z0 / PARK_EVERY) * PARK_EVERY; z < z1; z += PARK_EVERY) {
        if (seeded(x, z, 7) > PARK_SHARE) continue;
        const px = x + seeded(x, z, 8) * 18, pz = z + seeded(x, z, 9) * 18;
        if (inRing(outer, px, pz) && !rings.slice(1).some((h) => inRing(h, px, pz))) plant(px, pz);
      }
    }
  }
}
trees.sort((p, q) => p.z - q.z || p.x - q.x);

const xs = [], zs = [], kinds = [], heights = [];
const uint = (out, v) => { while (v > 127) { out.push((v & 127) | 128); v = Math.floor(v / 128); } out.push(v); };
const sint = (out, v) => uint(out, v >= 0 ? v * 2 : -v * 2 - 1);
let px = 0, pz = 0;
for (const t of trees) {
  const x = Math.round(t.x * 2), z = Math.round(t.z * 2);
  sint(xs, x - px); sint(zs, z - pz);
  px = x; pz = z;
  kinds.push(t.kind);
  heights.push(t.height);
}
const header = Buffer.alloc(12);
header.write('SYT1', 0, 'latin1');
header.writeUInt32LE(trees.length, 4);
header.writeUInt32LE(xs.length, 8);
const packed = zlib.gzipSync(Buffer.concat([header, Buffer.from(xs), Buffer.from(zs), Buffer.from(kinds), Buffer.from(heights)]), { level: 9 });
const asset = OUT.replace(/\.js$/, '.bin.gz');
fs.writeFileSync(asset, packed);
fs.writeFileSync(OUT, `// Generated by tools/build-trees.mjs; do not edit.
// City of Sydney tree register (CC BY 4.0) and OpenStreetMap trees. Snapshot SHA-256: ${digest}
// ${trees.length.toLocaleString('en-US')} tree locations, quantized to 0.5 m.
const response = await fetch(new URL('./${path.basename(asset)}', import.meta.url));
if (!response.ok) throw new Error(\`Tree data request failed: \${response.status}\`);
// Servers that send .gz files as Content-Encoding: gzip hand over bytes the browser has already inflated
const body = new Uint8Array(await response.arrayBuffer());
const data = body[0] === 0x1f && body[1] === 0x8b
  ? new Uint8Array(await new Response(new Response(body).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  : body;
const invalidData = () => new Error('Invalid tree data.');
if (data.length < 12) throw invalidData();
const header = new DataView(data.buffer);
const count = header.getUint32(4, true), xBytes = header.getUint32(8, true);
if (header.getUint32(0, true) !== 0x31545953 || count === 0) throw invalidData();

// SYT1 stores X and Z streams of signed deltas on a 0.5 m grid, then one species class and one height per tree.
function stream(start) {
  let cursor = start;
  return {
    next() {
      let value = 0, shift = 0, byte;
      do {
        if (cursor >= data.length || shift >= 28) throw invalidData();
        byte = data[cursor++];
        value |= (byte & 127) << shift;
        shift += 7;
      } while (byte & 128);
      return (value >>> 1) ^ -(value & 1);
    },
    end: () => cursor
  };
}
const xs = stream(12);
export const REAL_TREES = new Float32Array(count * 2);
let x = 0, z = 0;
for (let i = 0; i < count; i++) { x += xs.next(); REAL_TREES[i * 2] = x * 0.5; }
if (xs.end() !== 12 + xBytes) throw invalidData();
const zs = stream(12 + xBytes);
for (let i = 0; i < count; i++) { z += zs.next(); REAL_TREES[i * 2 + 1] = z * 0.5; }
// 0 broadleaf, 1 small, 2 gum, 3 fig, 4 palm, 5 jacaranda; the gardens' 6 bangalow palm, 7 date palm, 8 araucaria, 9 Wollemi pine,
// 10 cycad, 11 tree fern, 12 shrub, 13 native shrub, 14 flowers, 15 roses, 16 succulent, 17 grasses and lilies. Heights in metres,
// but for the small ones (10 and 12-17, js/tree-placements.js) in tenths of a metre.
export const TREE_KINDS = data.subarray(zs.end(), zs.end() + count);
export const TREE_HEIGHTS = data.subarray(zs.end() + count, zs.end() + count * 2);
`);
const by = Object.fromEntries(Object.keys(CLASS).map((k) => [k, trees.filter((t) => t.kind === CLASS[k]).length]));
console.log('[trees]', trees.length, 'trees,', fromRegister, 'from the register,', gardenPlants, 'in the gardens,', (packed.length / 1024).toFixed(0), 'KB gzip', JSON.stringify(by));
