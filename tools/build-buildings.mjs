// tools/build-buildings.mjs: writes js/building-geodata.js and its gzip asset from the Overture snapshot.
// Height comes from the first of: a surveyed height, floors, the hand table below, the median of neighbours of the same
// sort. The City of Sydney's "height in storeys" layer is a planning control, not a measurement, so it only caps guesses.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { DATA, Raster, DETAIL_BOUNDS as B, inDetail, load, rdpRing, ringArea, toWorld } from './geo-common.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = process.argv[2] || path.join(ROOT, 'js/building-geodata.js');
const PRECISION = 0.5;
const SKIP = new Set(['roof', 'carport', 'parking', 'canopy', 'shelter', 'bridge_structure', 'stadium_roof']);
const HOUSE = new Set(['house', 'terrace', 'detached', 'semidetached_house', 'bungalow', 'cabin', 'residential']);
const FLATS = new Set(['apartments', 'dormitory']);
const WORK = new Set(['commercial', 'office', 'retail', 'hotel', 'supermarket', 'kiosk']);
const SHED = new Set(['garage', 'garages', 'shed', 'industrial', 'warehouse', 'service', 'boathouse', 'greenhouse', 'toilets', 'barn', 'hut']);
const CIVIC = new Set(['church', 'cathedral', 'chapel', 'school', 'university', 'college', 'hospital', 'train_station', 'civic', 'government', 'public', 'library', 'museum', 'theatre']);
const KIND = { other: 0, house: 1, flats: 2, work: 3, shed: 4, civic: 5 };

// Large buildings the survey has no height for (roof heights in metres, checked by eye against neighbours)
const HEIGHTS = {
  'International Convention Centre Sydney': 40, 'ICC Sydney Theatre': 40, 'Paddy\'s Markets': 18, 'Market City': 35, 'Sydney Fish Market': 12,
  'Australian Museum': 24, 'Art Gallery of New South Wales': 20, 'State Library of New South Wales': 26, 'Queen Victoria Building': 34,
  'Sydney Town Hall': 42, 'Central Station': 18, 'Sydney Terminal': 18, 'Star City': 38, 'The Star': 38
};

const rows = fs.readFileSync(path.join(DATA, 'overture_syd.json'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(DATA, 'overture_syd.json'))).digest('hex');
const storeys = new Raster(B.x0, B.z0, B.x1, B.z1, 4);
for (const f of load('cos_storeys.json')) {
  const n = parseInt(f.properties.Storeys, 10);
  if (!n || !f.geometry) continue;
  for (const poly of f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates) storeys.fillRing(poly[0].map(([lon, lat]) => toWorld(lon, lat)), n);
}

const quantized = (ring) => {
  const pts = [];
  for (const [x, z] of ring) {
    const p = [Math.round(x / PRECISION), Math.round(z / PRECISION)];
    if (!pts.length || pts[pts.length - 1][0] !== p[0] || pts[pts.length - 1][1] !== p[1]) pts.push(p);
  }
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  return pts;
};
const kindOf = (b) => {
  const c = b.class || '';
  if (HOUSE.has(c)) return KIND.house;
  if (FLATS.has(c)) return KIND.flats;
  if (WORK.has(c)) return KIND.work;
  if (SHED.has(c) || b.subtype === 'outbuilding') return KIND.shed;
  if (CIVIC.has(c) || ['civic', 'education', 'religious', 'medical', 'transportation', 'entertainment'].includes(b.subtype)) return KIND.civic;
  if (b.subtype === 'residential') return KIND.house;
  if (b.subtype === 'commercial') return KIND.work;
  return KIND.other;
};

const buildings = [];
for (const b of rows) {
  if (b.is_underground || SKIP.has(b.class)) continue;
  const g = typeof b.g === 'string' ? JSON.parse(b.g) : b.g;
  const polygons = [];
  let area = 0, sx = 0, sz = 0, n = 0;
  for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.coordinates) {
    const rings = poly.map((ring) => ring.map(([lon, lat]) => toWorld(lon, lat)).slice(0, -1));
    const outer = rdpRing(rings[0], 0.4);
    if (outer.length < 3) continue;
    const a = Math.abs(ringArea(outer));
    area += a;
    for (const [x, z] of outer) { sx += x; sz += z; n++; }
    if (ringArea(outer) < 0) outer.reverse();
    const holes = rings.slice(1).filter((r) => Math.abs(ringArea(r)) > 6).map((r) => {
      const s = rdpRing(r, 0.4);
      if (ringArea(s) > 0) s.reverse();
      return quantized(s);
    }).filter((r) => r.length >= 3);
    const q = quantized(outer);
    if (q.length >= 3) polygons.push([q, ...holes]);
  }
  if (!polygons.length || area < 12 || !n) continue;
  const cx = sx / n, cz = sz / n;
  if (!inDetail(cx, cz)) continue;
  buildings.push({ b, polygons, area, cx, cz, kind: kindOf(b) });
}

// Known heights, then neighbours for the rest
const CELL = 64;
const known = new Map();
const put = (r) => {
  const k = Math.floor(r.cx / CELL) * 100000 + Math.floor(r.cz / CELL);
  if (!known.has(k)) known.set(k, []);
  known.get(k).push(r);
};
const stats = { surveyed: 0, floors: 0, table: 0, neighbours: 0, typical: 0, capped: 0 };
for (const r of buildings) {
  const { height, num_floors: floors, name } = r.b;
  if (height > 1) { r.height = height; stats.surveyed++; put(r); }
  else if (floors > 0) { r.height = floors * (r.kind === KIND.work ? 3.8 : 3.3) + 0.6; stats.floors++; put(r); }
  else if (HEIGHTS[name]) { r.height = HEIGHTS[name]; stats.table++; put(r); }
}
const median = (v) => v.sort((p, q) => p - q)[v.length >> 1];
const missingLarge = [];
for (const r of buildings) {
  if (r.height) continue;
  const near = [];
  const ix = Math.floor(r.cx / CELL), iz = Math.floor(r.cz / CELL);
  for (let i = ix - 2; i <= ix + 2; i++) {
    for (let j = iz - 2; j <= iz + 2; j++) {
      for (const o of known.get(i * 100000 + j) || []) {
        if (Math.hypot(o.cx - r.cx, o.cz - r.cz) < 130 && (o.kind === r.kind || (r.kind === KIND.other && o.kind !== KIND.shed))) near.push(o.height);
      }
    }
  }
  let h;
  if (r.kind === KIND.shed || r.area < 28) h = 3.4;
  else if (near.length >= 3) { h = median(near); stats.neighbours++; }
  else { h = r.kind === KIND.house ? 7.4 : r.area < 180 ? 7.4 : r.area < 1500 ? 12 : 15; stats.typical++; }
  if (r.kind === KIND.house) h = Math.min(h, 11);
  const cap = storeys.at(r.cx, r.cz);
  if (cap && h > cap * 3.6 + 0.6) { h = cap * 3.6 + 0.6; stats.capped++; }
  r.height = h;
  if (r.area > 2500) missingLarge.push(`${Math.round(r.area)} m² ${Math.round(h)} m ${r.b.class || '-'} ${r.b.name || ''} @${Math.round(r.cx)},${Math.round(r.cz)}`);
}

const order = (r) => {
  let o = 0;
  const x = Math.floor(r.cx + 8192), z = Math.floor(r.cz + 8192);
  for (let i = 0; i < 14; i++) o += ((x >> i) & 1) * 2 ** (2 * i) + ((z >> i) & 1) * 2 ** (2 * i + 1);
  return o;
};
buildings.sort((p, q) => order(p) - order(q));
const meta = [], xs = [], zs = [];
const uint = (out, v) => { while (v > 127) { out.push((v & 127) | 128); v = Math.floor(v / 128); } out.push(v); };
const sint = (out, v) => uint(out, v >= 0 ? v * 2 : -v * 2 - 1);
let px = 0, pz = 0, vertices = 0;
uint(meta, buildings.length);
for (const r of buildings) {
  const shape = r.b.roof_shape;
  const pitched = shape ? /gabled|hipped|pyramidal|mansard|gambrel|half/.test(shape) : (r.kind === KIND.house && r.height < 13) || (r.kind === KIND.shed && r.area > 30) || (r.height < 10 && r.kind === KIND.civic);
  uint(meta, Math.max(1, Math.round(r.height)));
  uint(meta, r.kind | (pitched ? 8 : 0));
  uint(meta, r.polygons.length);
  for (const polygon of r.polygons) {
    uint(meta, polygon.length);
    for (const ring of polygon) {
      uint(meta, ring.length);
      vertices += ring.length;
      for (const [x, z] of ring) { sint(xs, x - px); sint(zs, z - pz); px = x; pz = z; }
    }
  }
}
const header = Buffer.alloc(12);
header.write('SYB1', 0, 'latin1');
header.writeUInt32LE(meta.length, 4);
header.writeUInt32LE(xs.length, 8);
const packed = zlib.gzipSync(Buffer.concat([header, Buffer.from(meta), Buffer.from(xs), Buffer.from(zs)]), { level: 9 });
const asset = OUT.replace(/\.js$/, '.bin.gz');
fs.writeFileSync(asset, packed);
fs.writeFileSync(OUT, `// Generated by tools/build-buildings.mjs; do not edit.
// Overture Maps buildings (OpenStreetMap and Microsoft ML footprints). Snapshot SHA-256: ${digest}
// ${buildings.length.toLocaleString('en-US')} buildings. Coordinates: 0.5 m; roof heights: 1 m.
const response = await fetch(new URL('./${path.basename(asset)}', import.meta.url));
if (!response.ok) throw new Error(\`Building data request failed: \${response.status}\`);
// Servers that send .gz files as Content-Encoding: gzip hand over bytes the browser has already inflated
const body = new Uint8Array(await response.arrayBuffer());
const data = body[0] === 0x1f && body[1] === 0x8b
  ? new Uint8Array(await new Response(new Response(body).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  : body;
const invalidData = () => new Error('Invalid building data.');
if (data.length < 12) throw invalidData();
const header = new DataView(data.buffer);
const xStart = 12 + header.getUint32(4, true), zStart = xStart + header.getUint32(8, true);
if (header.getUint32(0, true) !== 0x31425953 || zStart > data.length) throw invalidData();

// SYB1 stores separate metadata, X and Z streams; signed coordinate deltas use zigzag varints.
function stream(start, end) {
  let cursor = start;
  return {
    uint() {
      let value = 0, shift = 0, byte;
      do {
        if (cursor >= end || shift >= 28) throw invalidData();
        byte = data[cursor++];
        value |= (byte & 127) << shift;
        shift += 7;
      } while (byte & 128);
      return value;
    },
    done: () => cursor === end
  };
}
const metadata = stream(12, xStart), xs = stream(xStart, zStart), zs = stream(zStart, data.length);
const uint = () => metadata.uint();
const delta = stream => { const value = stream.uint(); return (value >>> 1) ^ -(value & 1); };
const count = uint();
if (count > (xStart - 12) / 5) throw invalidData();
let x = 0, z = 0;

// kind: 0 other, 1 house, 2 flats, 3 shops and offices, 4 shed, 5 civic
export const REAL_BUILDINGS = Array.from({ length: count }, () => {
  const height = uint(), style = uint(), polygons = [];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let n = uint(); n > 0; n--) {
    const rings = [];
    for (let n = uint(); n > 0; n--) {
      const ring = [];
      for (let n = uint(); n > 0; n--) {
        x += delta(xs); z += delta(zs);
        const point = { x: x * 0.5, z: z * 0.5 };
        minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
        ring.push(point);
      }
      rings.push(ring);
    }
    polygons.push({ outer: rings[0], holes: rings.slice(1) });
  }
  return { height, kind: style & 7, pitched: !!(style & 8), polygons,
    minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
});
if (!metadata.done() || !xs.done() || !zs.done()) throw invalidData();
`);
console.log('[buildings]', buildings.length, 'buildings,', vertices, 'vertices,', (packed.length / 1024).toFixed(0), 'KB gzip');
console.log('[buildings]', JSON.stringify(stats));
console.log('[buildings] tallest', buildings.slice().sort((p, q) => q.height - p.height).slice(0, 6).map((r) => `${r.b.name || '?'} ${Math.round(r.height)}`).join(', '));
console.log('[buildings] large guesses:\n  ' + missingLarge.sort((p, q) => parseInt(q, 10) - parseInt(p, 10)).slice(0, 30).join('\n  '));
