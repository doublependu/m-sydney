// The horizon: the whole box out to Katoomba as one small file, for what's beyond the map's tiles. Hills and the coast from a 100 m
// elevation download (tools/fetch-elevation.mjs --cell=100), how built up each place is and the tallest towers from Overture
// (tools/fetch-data.mjs overture_density). Written to public/tiles/horizon.bin.gz; js/horizon.js reads it.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { fromWorld, toWorld } from './geo-common.mjs';
import { WHOLE_BOX, heightSampler } from './fetch-elevation.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'tools/data');
const CELL = 400;
const SEA = -32768;

const corners = [[WHOLE_BOX.west, WHOLE_BOX.north], [WHOLE_BOX.east, WHOLE_BOX.north], [WHOLE_BOX.west, WHOLE_BOX.south], [WHOLE_BOX.east, WHOLE_BOX.south]].map(([lon, lat]) => toWorld(lon, lat));
const x0 = Math.floor(Math.min(...corners.map((c) => c[0])) / CELL) * CELL, x1 = Math.ceil(Math.max(...corners.map((c) => c[0])) / CELL) * CELL;
const z0 = Math.floor(Math.min(...corners.map((c) => c[1])) / CELL) * CELL, z1 = Math.ceil(Math.max(...corners.map((c) => c[1])) / CELL) * CELL;
const w = (x1 - x0) / CELL + 1, h = (z1 - z0) / CELL + 1;

const heightAt = heightSampler(100);
const heights = new Int16Array(w * h);
// A little around each point, so a thin headland or bay at this size neither vanishes nor grows
const OFFSETS = [[0, 0], [-120, 0], [120, 0], [0, -120], [0, 120]];
let land = 0;
for (let j = 0; j < h; j++) {
  for (let i = 0; i < w; i++) {
    const x = x0 + i * CELL, z = z0 + j * CELL;
    let sum = 0, count = 0;
    for (const [dx, dz] of OFFSETS) {
      const [lon, lat] = fromWorld(x + dx, z + dz);
      const y = heightAt(lon, lat);
      if (y !== null && y > 0.2) { sum += y; count++; }
    }
    if (count >= 3) { heights[j * w + i] = Math.round(sum / count); land++; } else heights[j * w + i] = SEA;
  }
}

// How built up: 0 bush, 1 scattered, 2 suburb, 3 dense
const use = new Uint8Array(w * h);
const counts = new Float32Array(w * h);
for (const { lon, lat, n } of JSON.parse(fs.readFileSync(path.join(DATA, 'overture_density.json'), 'utf8'))) {
  const [x, z] = toWorld((lon + 0.5) * 0.004, (lat + 0.5) * 0.004);
  const i = Math.round((x - x0) / CELL), j = Math.round((z - z0) / CELL);
  if (i >= 0 && i < w && j >= 0 && j < h) counts[j * w + i] += n;
}
for (let k = 0; k < w * h; k++) use[k] = counts[k] < 3 ? 0 : counts[k] < 25 ? 1 : counts[k] < 110 ? 2 : 3;

const tall = JSON.parse(fs.readFileSync(path.join(DATA, 'overture_tall.json'), 'utf8'))
  .map((t) => { const [x, z] = toWorld(t.lon, t.lat); return { x, z, w: Math.max(12, Math.min(90, t.w)), d: Math.max(12, Math.min(90, t.d)), h: t.h }; })
  .sort((a, b) => b.h - a.h).slice(0, 400);

const head = new Int32Array([x0, z0, CELL, w, h, tall.length]);
const towers = Float32Array.from(tall.flatMap((t) => [t.x, t.z, t.w, t.d, t.h]));
const body = Buffer.concat([Buffer.from(head.buffer), Buffer.from(towers.buffer), Buffer.from(heights.buffer), Buffer.from(use.buffer)]);
const packed = zlib.gzipSync(body, { level: 9 });
fs.writeFileSync(path.join(ROOT, 'public/tiles/horizon.bin.gz'), packed);
console.log(`[horizon] ${w} x ${h} at ${CELL} m, ${Math.round((land / (w * h)) * 100)}% land, ${tall.length} towers: ${Math.round(packed.length / 1024)} KB`);
