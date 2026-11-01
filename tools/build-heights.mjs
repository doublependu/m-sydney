// tools/build-heights.mjs: writes js/height-grid.bin.gz, the ground height of the play area and the land around it, from
// surveyed contours: City of Sydney's 1 m contours, then the NSW 2 m contours for everything north of the harbour and
// beyond the City's boundary. Global DEMs are no use here: they smear the CBD's towers into the ground.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { GRID, Raster, load, toWorld } from './geo-common.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const { x0, z0, x1, z1, cell } = GRID;
const w = Math.round((x1 - x0) / cell) + 1, h = Math.round((z1 - z0) / cell) + 1;

// Contour samples in a coarse hash; each grid point is the inverse-distance mean of the nearest ones
const BUCKET = 40;
const buckets = new Map();
const put = (x, z, y, fine) => {
  const k = Math.floor(x / BUCKET) * 100000 + Math.floor(z / BUCKET);
  let b = buckets.get(k);
  if (!b) buckets.set(k, (b = []));
  b.push(x, z, y, fine ? 1 : 0);
};
function addLines(features, heightOf, fine, step) {
  for (const f of features) {
    const y = heightOf(f.properties);
    const g = f.geometry;
    if (!g || !Number.isFinite(y) || y < -3) continue;
    for (const line of g.type === 'LineString' ? [g.coordinates] : g.coordinates) {
      const pts = line.map(([lon, lat]) => toWorld(lon, lat));
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
        if (Math.max(ax, bx) < x0 - 200 || Math.min(ax, bx) > x1 + 200 || Math.max(az, bz) < z0 - 200 || Math.min(az, bz) > z1 + 200) continue;
        const n = Math.max(1, Math.floor(Math.hypot(bx - ax, bz - az) / step));
        for (let k = 0; k < n; k++) put(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n, y, fine);
      }
    }
  }
}
addLines(load('cos_contours.json'), (p) => p.Contour, true, 10);
addLines(load('nsw_contours.json'), (p) => p.elevation, false, 14);
console.log('[heights] contour buckets', buckets.size);

// Water pulls the height to sea level at the shore
const { GEO } = await import('../js/geodata.js');
const land = new Raster(x0, z0, x1, z1, cell);
for (const rings of GEO.surroundings) rings.forEach((flat, i) => { const ring = []; for (let k = 0; k < flat.length; k += 2) ring.push([flat[k], flat[k + 1]]); land.fillRing(ring, i ? 0 : 1); });
for (const rings of GEO.shores) rings.forEach((flat, i) => { const ring = []; for (let k = 0; k < flat.length; k += 2) ring.push([flat[k], flat[k + 1]]); land.fillRing(ring, i ? 0 : 1); });

const raw = new Float32Array(w * h);
const missing = [];
for (let j = 0; j < h; j++) {
  for (let i = 0; i < w; i++) {
    const x = x0 + i * cell, z = z0 + j * cell;
    let sw = 0, sy = 0, near = Infinity, fineNear = false;
    const reach = 160;
    for (let a = Math.floor((x - reach) / BUCKET); a <= Math.floor((x + reach) / BUCKET); a++) {
      for (let b = Math.floor((z - reach) / BUCKET); b <= Math.floor((z + reach) / BUCKET); b++) {
        const list = buckets.get(a * 100000 + b);
        if (!list) continue;
        for (let k = 0; k < list.length; k += 4) {
          const d2 = (list[k] - x) ** 2 + (list[k + 1] - z) ** 2;
          if (d2 > reach * reach) continue;
          const weight = (list[k + 3] ? 3 : 1) / (d2 * d2 + 16);
          sw += weight;
          sy += weight * list[k + 2];
          if (d2 < near) near = d2;
          if (list[k + 3] && d2 < 3600) fineNear = true;
        }
      }
    }
    void fineNear;
    if (sw > 0) raw[j * w + i] = sy / sw;
    else missing.push(j * w + i);
  }
}
console.log('[heights] grid', w, 'x', h, 'no contour nearby:', missing.length);

// Holes in the contours: spread the nearest heights in. Then a light blur, and the shore eased down to the water.
const known = new Uint8Array(w * h).fill(1);
for (const k of missing) known[k] = 0;
for (let pass = 0; pass < 40; pass++) {
  const next = known.slice();
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (known[k]) continue;
      let s = 0, n = 0;
      for (const [a, b] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const q = (j + b) * w + i + a;
        if (i + a >= 0 && i + a < w && j + b >= 0 && j + b < h && known[q]) { s += raw[q]; n++; }
      }
      if (n) { raw[k] = s / n; next[k] = 1; }
    }
  }
  known.set(next);
}
const toWater = land.edt((v) => v === 0);
const blur = (src) => {
  const out = new Float32Array(src.length);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let s = 0, n = 0;
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
        if (i + a < 0 || i + a >= w || j + b < 0 || j + b >= h) continue;
        const weight = (a ? 1 : 2) * (b ? 1 : 2);
        s += src[(j + b) * w + i + a] * weight;
        n += weight;
      }
      out[j * w + i] = s / n;
    }
  }
  return out;
};
let smooth = blur(raw);
const SEAWALL = 0.2; // the ground at the seawalls: the game's water lies 2.2 m below 0
for (let k = 0; k < smooth.length; k++) {
  const d = Math.sqrt(toWater[Math.floor(k / w) * land.w + (k % w)] || 0) * cell;
  const t = Math.min(1, d / 40);
  const ease = t * t * (3 - 2 * t);
  smooth[k] = SEAWALL + (Math.max(SEAWALL, smooth[k]) - SEAWALL) * ease;
}
smooth = blur(smooth);

// 0.25 m steps, as differences along each row. Two bytes only where a step is too big for one (zigzag varints).
const out = [];
for (let j = 0; j < h; j++) {
  let prev = 0;
  for (let i = 0; i < w; i++) {
    const v = Math.max(0, Math.round(smooth[j * w + i] * 4));
    const d = v - prev;
    let z = d >= 0 ? d * 2 : -d * 2 - 1;
    while (z > 127) { out.push((z & 127) | 128); z >>= 7; }
    out.push(z);
    prev = v;
  }
}
const packed = zlib.gzipSync(Buffer.from(out), { level: 9 });
fs.writeFileSync(path.join(ROOT, 'js/height-grid.bin.gz'), packed);
const probe = (x, z) => smooth[Math.round((z - z0) / cell) * w + Math.round((x - x0) / cell)].toFixed(1);
console.log('[heights]', (packed.length / 1024).toFixed(0), 'KB gzip;', Object.entries({ quay: [174, -1357], townHall: [0, 0], hyde: [520, 100], central: [92, 1118], kingsCross: [1504, 1], taylor: [1200, 700], northSydney: [-502, -3636], milsons: [-60, -2780], obs: [-360, -1600], darling: [-430, 100] }).map(([k, [x, z]]) => `${k} ${probe(x, z)}`).join(', '));
