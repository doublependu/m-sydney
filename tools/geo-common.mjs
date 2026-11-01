// Shared by the map generators. Frame: 1 unit = 1 m, x = grid east, z = grid south (north = -z), origin at Town Hall
// (George St & Druitt St), axes turned 8° from true north to match the CBD's streets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA = process.env.GEO_DATA || fileURLToPath(new URL('data/', import.meta.url));
export const load = (file) => JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'));
export const log = (...args) => console.log('[geodata]', ...args);

export const LAT0 = -33.8731;
export const LON0 = 151.2069;
export const BEARING = 8;
const A = 6378137.0;
const E2 = 6.69437999014e-3;
const PHI0 = (LAT0 * Math.PI) / 180;
const SIN0 = Math.sin(PHI0);
const NRAD = A / Math.sqrt(1 - E2 * SIN0 * SIN0);
const MRAD = (A * (1 - E2)) / Math.pow(1 - E2 * SIN0 * SIN0, 1.5);
const KX = (Math.PI / 180) * NRAD * Math.cos(PHI0);
const KY = (Math.PI / 180) * MRAD;
const COS = Math.cos((BEARING * Math.PI) / 180);
const SIN = Math.sin((BEARING * Math.PI) / 180);

export function toWorld(lon, lat) {
  const e = (lon - LON0) * KX;
  const n = (lat - LAT0) * KY;
  return [e * COS - n * SIN, -(e * SIN + n * COS)];
}

// The detailed play area: the CBD side, and Milsons Point to North Sydney across the bridge
export const DETAIL_RECTS = [
  { x0: -2100, x1: 2700, z0: -2350, z1: 2100 },
  { x0: -1500, x1: 1000, z0: -4500, z1: -2350 }
];
export const DETAIL_BOUNDS = { x0: -2100, x1: 2700, z0: -4500, z1: 2100 };
// The ground height grid (js/terrain.js): the play area and the skyline around it
export const GRID = { x0: -6000, x1: 7000, z0: -9000, z1: 6000, cell: 20 };
export const inDetail = (x, z) => DETAIL_RECTS.some((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1);

export const q1 = (v) => Math.round(v * 10) / 10;
export const flat = (pts) => pts.flatMap(([x, z]) => [q1(x), q1(z)]);

export function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}
export function bbox(pts) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { x0, x1, z0, z1 };
}

// Ramer-Douglas-Peucker on an open polyline
export function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, az] = pts[a];
    const [bx, bz] = pts[b];
    const dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz) || 1e-9;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
// RDP on a closed ring, split at the two points farthest apart
export function rdpRing(ring, eps) {
  let far = 0, i1 = 0;
  for (let i = 0; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > far) { far = d; i1 = i; }
  }
  const a = rdp(ring.slice(0, i1 + 1), eps);
  const b = rdp([...ring.slice(i1), ring[0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

// Chain open ways (relation members) into closed rings
export function chainRings(parts) {
  const close = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5;
  const rest = parts.slice();
  const rings = [];
  while (rest.length) {
    let ring = rest.shift();
    for (let guard = 0; guard < 5000 && !close(ring[0], ring[ring.length - 1]); guard++) {
      const i = rest.findIndex((p) => close(p[0], ring[ring.length - 1]) || close(p[p.length - 1], ring[ring.length - 1]));
      if (i < 0) break;
      const p = rest.splice(i, 1)[0];
      ring = ring.concat(close(p[0], ring[ring.length - 1]) ? p.slice(1) : p.reverse().slice(1));
    }
    rings.push(ring);
  }
  return rings;
}
// Rings of an OSM way or multipolygon, in world coordinates
export function elementRings(e) {
  const world = (geometry) => geometry.map((g) => toWorld(g.lon, g.lat));
  if (e.type === 'way') return { outer: e.geometry ? [world(e.geometry)] : [], inner: [] };
  const of = (role) => chainRings((e.members || []).filter((m) => m.role === role && m.geometry).map((m) => world(m.geometry)));
  return { outer: of('outer'), inner: of('inner') };
}

export function pointInRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[j];
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}

export class Raster {
  constructor(x0, z0, x1, z1, res, Type = Uint8Array) {
    this.res = res;
    this.x0 = Math.floor(x0 / res) * res;
    this.z0 = Math.floor(z0 / res) * res;
    this.w = Math.ceil((x1 - this.x0) / res) + 1;
    this.h = Math.ceil((z1 - this.z0) / res) + 1;
    this.d = new Type(this.w * this.h);
  }
  // Even-odd scanline fill of a ring
  fillRing(ring, val = 1) {
    const { res, x0, z0, w, h, d } = this;
    const bb = bbox(ring);
    const j0 = Math.max(0, Math.floor((bb.z0 - z0) / res));
    const j1 = Math.min(h - 1, Math.ceil((bb.z1 - z0) / res));
    const xs = [];
    for (let j = j0; j <= j1; j++) {
      const z = z0 + (j + 0.5) * res;
      xs.length = 0;
      for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
        const [xa, za] = ring[k], [xb, zb] = ring[i];
        if ((za > z) !== (zb > z)) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
      }
      xs.sort((p, q) => p - q);
      for (let n = 0; n + 1 < xs.length; n += 2) {
        const i0 = Math.max(0, Math.ceil((xs[n] - x0) / res - 0.5));
        const i1 = Math.min(w - 1, Math.floor((xs[n + 1] - x0) / res - 0.5));
        for (let i = i0; i <= i1; i++) d[j * w + i] = val;
      }
    }
  }
  // Capsule of radius r along a segment
  stampSegment(ax, az, bx, bz, r, val = 0) {
    const { res, x0, z0, w, h, d } = this;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - x0) / res));
    const i1 = Math.min(w - 1, Math.ceil((Math.max(ax, bx) + r - x0) / res));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - r - z0) / res));
    const j1 = Math.min(h - 1, Math.ceil((Math.max(az, bz) + r - z0) / res));
    const dx = bx - ax, dz = bz - az;
    const L2 = dx * dx + dz * dz || 1e-9;
    const r2 = r * r;
    for (let j = j0; j <= j1; j++) {
      const pz = z0 + (j + 0.5) * res;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * res;
        let t = ((px - ax) * dx + (pz - az) * dz) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + t * dx - px, ez = az + t * dz - pz;
        if (ex * ex + ez * ez <= r2) d[j * w + i] = val;
      }
    }
  }
  at(x, z) {
    const i = Math.floor((x - this.x0) / this.res), j = Math.floor((z - this.z0) / this.res);
    return i >= 0 && j >= 0 && i < this.w && j < this.h ? this.d[j * this.w + i] : 0;
  }
  // Squared distance in cells from every cell to the nearest source cell (Felzenszwalb)
  edt(isSource) {
    const { w, h, d } = this;
    const INF = 1e20;
    const n = Math.max(w, h);
    const f = new Float64Array(n), v = new Int32Array(n), zz = new Float64Array(n + 1);
    const out = new Float32Array(w * h);
    const dt1 = (len, get, set) => {
      for (let q = 0; q < len; q++) f[q] = get(q);
      let k = 0;
      v[0] = 0; zz[0] = -INF; zz[1] = INF;
      for (let q = 1; q < len; q++) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= zz[k]) {
          k--;
          s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++;
        v[k] = q; zz[k] = s; zz[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < len; q++) {
        while (zz[k + 1] < q) k++;
        set(q, (q - v[k]) * (q - v[k]) + f[v[k]]);
      }
    };
    for (let i = 0; i < w * h; i++) out[i] = isSource(d[i]) ? 0 : INF;
    for (let i = 0; i < w; i++) dt1(h, (q) => out[q * w + i], (q, val) => { out[q * w + i] = val; });
    for (let j = 0; j < h; j++) dt1(w, (q) => out[j * w + q], (q, val) => { out[j * w + q] = val; });
    return out;
  }
  // Morphological opening: drops slivers narrower than 2r
  open(r) {
    const rc = (r / this.res) ** 2;
    const toEmpty = this.edt((v) => v === 0);
    const save = this.d;
    this.d = new Uint8Array(save.length);
    for (let i = 0; i < save.length; i++) this.d[i] = toEmpty[i] > rc ? 1 : 0;
    const toCore = this.edt((v) => v === 1);
    this.d = save;
    for (let i = 0; i < save.length; i++) save[i] = save[i] && toCore[i] <= rc + 1e-6 ? 1 : 0;
  }
  // 4-connected labels of the non-zero cells: { labels, comps: [{ id, n, i0, i1, j0, j1 }] }
  label() {
    const { w, h, d } = this;
    const labels = new Int32Array(w * h);
    const comps = [];
    const stack = new Int32Array(w * h);
    for (let s = 0; s < w * h; s++) {
      if (!d[s] || labels[s]) continue;
      const id = comps.length + 1;
      let sp = 0, n = 0, i0 = w, i1 = -1, j0 = h, j1 = -1;
      stack[sp++] = s;
      labels[s] = id;
      while (sp) {
        const p = stack[--sp];
        n++;
        const i = p % w, j = (p - i) / w;
        if (i < i0) i0 = i;
        if (i > i1) i1 = i;
        if (j < j0) j0 = j;
        if (j > j1) j1 = j;
        if (i > 0 && d[p - 1] && !labels[p - 1]) { labels[p - 1] = id; stack[sp++] = p - 1; }
        if (i < w - 1 && d[p + 1] && !labels[p + 1]) { labels[p + 1] = id; stack[sp++] = p + 1; }
        if (j > 0 && d[p - w] && !labels[p - w]) { labels[p - w] = id; stack[sp++] = p - w; }
        if (j < h - 1 && d[p + w] && !labels[p + w]) { labels[p + w] = id; stack[sp++] = p + w; }
      }
      comps.push({ id, n, i0, i1, j0, j1 });
    }
    return { labels, comps };
  }
  // Boundary rings of one labelled component, world coordinates: stairs turned into runs and midpoints, ready to simplify.
  // Directed cell edges keep the component on the right, so outer rings and holes wind opposite ways.
  traceRings(labels, c) {
    const { w, h, res, x0, z0 } = this;
    const at = (i, j) => (i >= 0 && j >= 0 && i < w && j < h && labels[j * w + i] === c.id ? 1 : 0);
    const W = w + 2;
    const key = (i, j) => (j + 1) * W + (i + 1);
    const next = new Map();
    const add = (ai, aj, bi, bj) => {
      const k = key(ai, aj);
      const list = next.get(k);
      if (list) list.push([bi, bj]); else next.set(k, [[bi, bj]]);
    };
    for (let j = c.j0; j <= c.j1; j++) {
      for (let i = c.i0; i <= c.i1; i++) {
        if (!at(i, j)) continue;
        if (!at(i, j - 1)) add(i, j, i + 1, j);
        if (!at(i + 1, j)) add(i + 1, j, i + 1, j + 1);
        if (!at(i, j + 1)) add(i + 1, j + 1, i, j + 1);
        if (!at(i - 1, j)) add(i, j + 1, i, j);
      }
    }
    const rings = [];
    for (const [start, list] of next) {
      while (list.length) {
        const ring = [];
        const si = start % W - 1, sj = Math.floor(start / W) - 1;
        let [pi, pj] = [si, sj];
        let [ci, cj] = list.pop();
        ring.push([si, sj]);
        while (ci !== si || cj !== sj) {
          ring.push([ci, cj]);
          const options = next.get(key(ci, cj));
          // At a diagonal touch take the right turn, so 4-connected regions stay apart
          let pick = 0;
          if (options.length > 1) {
            const dx = ci - pi, dz = cj - pj;
            pick = options.findIndex(([ni, nj]) => dx * (nj - cj) - dz * (ni - ci) > 0);
            if (pick < 0) pick = 0;
          }
          const [ni, nj] = options.splice(pick, 1)[0];
          [pi, pj, ci, cj] = [ci, cj, ni, nj];
        }
        rings.push(ring);
      }
    }
    return rings.map((ring) => {
      const corners = [];
      for (let i = 0; i < ring.length; i++) {
        const p = ring[(i + ring.length - 1) % ring.length], q = ring[i], n = ring[(i + 1) % ring.length];
        if ((q[0] - p[0]) * (n[1] - q[1]) - (q[1] - p[1]) * (n[0] - q[0]) !== 0) corners.push(q);
      }
      const world = corners.map(([i, j]) => [x0 + i * res, z0 + j * res]);
      return world.map((q, i) => {
        const n = world[(i + 1) % world.length];
        return [(q[0] + n[0]) / 2, (q[1] + n[1]) / 2];
      });
    });
  }
}

// The non-zero cells of a raster as polygons no wider than `size`: tiles overlap by a cell, so neighbours can't part.
// Keeps every polygon cheap to triangulate, and lets the game build only those near the player. Returns [[outer, ...holes]].
export function tiledPolygons(raster, size, eps, minCells = 6, minHole = 6) {
  const out = [];
  const step = Math.round(size / raster.res);
  for (let tj = 0; tj < raster.h; tj += step) {
    for (let ti = 0; ti < raster.w; ti += step) {
      const w = Math.min(step + 1, raster.w - ti), h = Math.min(step + 1, raster.h - tj);
      const tile = new Raster(raster.x0 + ti * raster.res, raster.z0 + tj * raster.res, raster.x0 + (ti + w) * raster.res, raster.z0 + (tj + h) * raster.res, raster.res);
      let any = false;
      for (let j = 0; j < h && j < tile.h; j++) {
        for (let i = 0; i < w && i < tile.w; i++) {
          if (raster.d[(tj + j) * raster.w + ti + i]) { tile.d[j * tile.w + i] = 1; any = true; }
        }
      }
      if (!any) continue;
      const { labels, comps } = tile.label();
      for (const c of comps) {
        if (c.n < minCells) continue;
        const rings = tile.traceRings(labels, c).map((r) => rdpRing(r, eps)).filter((r) => r.length >= 3);
        if (!rings.length) continue;
        rings.sort((p, q) => Math.abs(ringArea(q)) - Math.abs(ringArea(p)));
        out.push(rings.filter((r, i) => !i || Math.abs(ringArea(r)) > minHole));
      }
    }
  }
  return out;
}
