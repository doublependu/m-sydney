// Shared by the map generators. Frame: 1 unit = 1 m, x = grid east, z = grid south (north = -z), origin at Town Hall
// (George St & Druitt St), axes turned 8° from true north to match the CBD's streets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA = process.env.GEO_DATA || fileURLToPath(new URL('data/', import.meta.url));
// Which map to make. `today` is the CBD map iterations 1 and 2 ended on, for checking a generator still makes what it made.
const AREAS = {
  today: {
    folder: '',
    rects: [{ x0: -2100, x1: 2700, z0: -2350, z1: 2100 }, { x0: -1500, x1: 1000, z0: -4500, z1: -2350 }],
    bounds: { x0: -2100, x1: 2700, z0: -4500, z1: 2100 },
    grid: { x0: -6000, x1: 7000, z0: -9000, z1: 6000, cell: 20 }
  },
  // Parramatta to the sea, Palm Beach to Cronulla
  east: {
    folder: 'east',
    rects: [{ x0: -23000, x1: 10000, z0: -35000, z1: 25000 }],
    bounds: { x0: -23000, x1: 10000, z0: -35000, z1: 25000 },
    grid: { x0: -27000, x1: 14000, z0: -39000, z1: 29000, cell: 20 }
  },
  // Burwood to Bondi, Manly to the airport
  inner: {
    folder: 'inner',
    rects: [{ x0: -11000, x1: 9000, z0: -11000, z1: 10000 }],
    bounds: { x0: -11000, x1: 9000, z0: -11000, z1: 10000 },
    grid: { x0: -14000, x1: 12000, z0: -15000, z1: 14000, cell: 20 }
  }
};
export const AREA_NAME = process.env.SYDNEY_AREA ?? 'east';
const AREA = AREAS[AREA_NAME];
/** A snapshot of the data: this area's own if it has one, or the one all areas share */
export const dataPath = (file) => {
  const own = path.join(DATA, AREA.folder, file);
  return fs.existsSync(own) ? own : path.join(DATA, file);
};
export const load = (file) => JSON.parse(fs.readFileSync(dataPath(file), 'utf8'));
/** Each line of a file of JSON lines, parsed, however big the file: a string can't hold more than about 512 MB */
export function* jsonLines(file) {
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.alloc(64 * 1048576);
  let tail = '';
  for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0;) {
    const text = tail + chunk.toString('utf8', 0, n);
    const lines = text.split('\n');
    tail = lines.pop();
    for (const line of lines) if (line) yield JSON.parse(line);
  }
  if (tail.trim()) yield JSON.parse(tail);
  fs.closeSync(fd);
}
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

export function fromWorld(x, z) {
  const e = x * COS - z * SIN;
  const n = -x * SIN - z * COS;
  return [LON0 + e / KX, LAT0 + n / KY];
}

// The detailed play area
export const DETAIL_RECTS = AREA.rects;
export const DETAIL_BOUNDS = AREA.bounds;
// The ground height grid (js/terrain.js): the play area and the skyline around it
export const GRID = AREA.grid;
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
// Does a ring cross itself? Simplifying can do that to a thin one, and triangles over it would then cover too much.
function crossesItself(ring) {
  const n = ring.length;
  const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = ring[j], d = ring[(j + 1) % n];
      if (orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0) return true;
    }
  }
  return false;
}

// Do any two of these rings cross?
function ringsCross(rings) {
  const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  for (let u = 0; u < rings.length; u++) {
    for (let v = u + 1; v < rings.length; v++) {
      const A = rings[u], B = rings[v];
      for (let i = 0; i < A.length; i++) {
        const a = A[i], b = A[(i + 1) % A.length];
        for (let j = 0; j < B.length; j++) {
          const c = B[j], d = B[(j + 1) % B.length];
          if (orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0) return true;
        }
      }
    }
  }
  return false;
}

export function rdpRing(ring, eps) {
  let far = 0, i1 = 0;
  for (let i = 0; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > far) { far = d; i1 = i; }
  }
  const a = rdp(ring.slice(0, i1 + 1), eps);
  const b = rdp([...ring.slice(i1), ring[0]], eps);
  const simple = [...a.slice(0, -1), ...b.slice(0, -1)];
  if (eps > 0.1 && simple.length < 2000 && crossesItself(simple)) return rdpRing(ring, eps / 2);
  return simple;
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
  // Even-odd scanline fill of a ring. Goes through its edges once, however many rows it spans.
  fillRing(ring, val = 1) {
    const { res, x0, z0, w, h, d } = this;
    const rows = new Map();
    for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
      const [xa, za] = ring[k], [xb, zb] = ring[i];
      if (za === zb) continue;
      const j0 = Math.max(0, Math.ceil((Math.min(za, zb) - z0) / res - 0.5));
      const j1 = Math.min(h - 1, Math.floor((Math.max(za, zb) - z0) / res - 0.5));
      for (let j = j0; j <= j1; j++) {
        const z = z0 + (j + 0.5) * res;
        if ((za > z) === (zb > z)) continue;
        let xs = rows.get(j);
        if (!xs) rows.set(j, (xs = []));
        xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
      }
    }
    for (const [j, xs] of rows) {
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
    // Stairs become slopes through the middle of each step. A real corner, long and straight on both sides, stays where
    // it is: cutting it from midpoint to midpoint took a triangle half each side long, which lost 0.8 km² of North Sydney
    // at the play area's top corners and opened gaps in footpaths and lawns at every tile corner. (A shallow stair has a
    // long side and a short one, and still becomes a slope.)
    const LONG = 4; // cells
    return rings.map((ring) => {
      const corners = [];
      for (let i = 0; i < ring.length; i++) {
        const p = ring[(i + ring.length - 1) % ring.length], q = ring[i], n = ring[(i + 1) % ring.length];
        if ((q[0] - p[0]) * (n[1] - q[1]) - (q[1] - p[1]) * (n[0] - q[0]) !== 0) corners.push(q);
      }
      const m = corners.length;
      const out = [];
      for (let i = 0; i < m; i++) {
        const p = corners[(i + m - 1) % m], q = corners[i], n = corners[(i + 1) % m];
        if (Math.min(Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]), Math.abs(n[0] - q[0]) + Math.abs(n[1] - q[1])) >= LONG) {
          out.push([x0 + q[0] * res, z0 + q[1] * res]);
        }
        out.push([x0 + ((q[0] + n[0]) / 2) * res, z0 + ((q[1] + n[1]) / 2) * res]);
      }
      return out;
    });
  }
}

// One bit a cell, for what has to reach across the whole map: land and building walls. Over a shared buffer, regions can write to it side by
// side, as long as they start and end on whole bytes.
export class BitRaster {
  constructor(x0, z0, x1, z1, res = 1, buffer = null) {
    this.res = res;
    this.x0 = x0;
    this.z0 = z0;
    this.x1 = x1;
    this.z1 = z1;
    this.w = Math.ceil((x1 - x0) / res);
    this.h = Math.ceil((z1 - z0) / res);
    this.rowBytes = Math.ceil(this.w / 8);
    this.bits = new Uint8Array(buffer ?? new SharedArrayBuffer(this.rowBytes * this.h));
  }
  at(x, z) {
    const i = Math.floor((x - this.x0) / this.res), j = Math.floor((z - this.z0) / this.res);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return 0;
    return (this.bits[j * this.rowBytes + (i >> 3)] >> (i & 7)) & 1;
  }
  /** Sets each cell of a ring, for what's small: a building */
  fillRing(ring) {
    const { res, x0, z0, w, h, bits, rowBytes } = this;
    let lo = Infinity, hi = -Infinity;
    for (const p of ring) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; }
    const j0 = Math.max(0, Math.ceil((lo - z0) / res - 0.5)), j1 = Math.min(h - 1, Math.floor((hi - z0) / res - 0.5));
    for (let j = j0; j <= j1; j++) {
      const z = z0 + (j + 0.5) * res;
      const xs = [];
      for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
        const [xa, za] = ring[k], [xb, zb] = ring[i];
        if ((za > z) !== (zb > z)) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
      }
      xs.sort((p, q) => p - q);
      for (let n = 0; n + 1 < xs.length; n += 2) {
        const i0 = Math.max(0, Math.ceil((xs[n] - x0) / res - 0.5)), i1 = Math.min(w - 1, Math.floor((xs[n + 1] - x0) / res - 0.5));
        for (let i = i0; i <= i1; i++) bits[j * rowBytes + (i >> 3)] |= 1 << (i & 7);
      }
    }
  }
  /** Copies the part of a byte-a-cell raster that's in `core` */
  setFrom(raster, core) {
    const { res, bits, rowBytes } = this;
    const oi = Math.round((core.x0 - raster.x0) / res), oj = Math.round((core.z0 - raster.z0) / res);
    const ti = Math.round((core.x0 - this.x0) / res), tj = Math.round((core.z0 - this.z0) / res);
    const cw = Math.round((core.x1 - core.x0) / res), ch = Math.round((core.z1 - core.z0) / res);
    for (let j = 0; j < ch; j++) {
      if (tj + j < 0 || tj + j >= this.h) continue;
      for (let i = 0; i < cw; i++) {
        if (ti + i < 0 || ti + i >= this.w) continue;
        const at = (tj + j) * rowBytes + ((ti + i) >> 3);
        if (raster.d[(j + oj) * raster.w + i + oi]) bits[at] |= 1 << ((ti + i) & 7);
      }
    }
  }
  /** A byte-a-cell copy of a part of it */
  window({ x0, z0, x1, z1 }) {
    const { res, bits, rowBytes } = this;
    const out = new Raster(x0, z0, x1, z1, res);
    const ti = Math.round((out.x0 - this.x0) / res), tj = Math.round((out.z0 - this.z0) / res);
    for (let j = 0; j < out.h; j++) {
      if (tj + j < 0 || tj + j >= this.h) continue;
      const row = (tj + j) * rowBytes;
      for (let i = 0; i < out.w; i++) {
        const c = ti + i;
        if (c < 0 || c >= this.w) continue;
        if ((bits[row + (c >> 3)] >> (c & 7)) & 1) out.d[j * out.w + i] = 1;
      }
    }
    return out;
  }
  save(file) {
    const head = Buffer.from(new Int32Array([this.x0, this.z0, this.x1, this.z1, this.res]).buffer);
    const fd = fs.openSync(file, 'w');
    fs.writeSync(fd, head);
    fs.writeSync(fd, this.bits);
    fs.closeSync(fd);
  }
  static load(file) {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(20);
    fs.readSync(fd, head, 0, 20, 0);
    const [x0, z0, x1, z1, res] = new Int32Array(head.buffer, head.byteOffset, 5);
    const out = new BitRaster(x0, z0, x1, z1, res);
    fs.readSync(fd, out.bits, 0, out.bits.length, 20);
    fs.closeSync(fd);
    return out;
  }
}

// The non-zero cells of a raster as polygons no wider than `size`: tiles overlap by a cell, so neighbours can't part.
// Keeps every polygon cheap to triangulate, and lets the game build only those near the player. Returns [[outer, ...holes]].
const TILE_OVERLAP = 3; // cells
export function tiledPolygons(raster, size, eps, minCells = 6, minHole = 6, within = null) {
  const out = [];
  const step = Math.round(size / raster.res);
  for (let tj = 0; tj < raster.h; tj += step) {
    for (let ti = 0; ti < raster.w; ti += step) {
      // Only the squares starting in `within`: a neighbouring region has the rest
      if (within) {
        const sx = raster.x0 + ti * raster.res, sz = raster.z0 + tj * raster.res;
        if (sx < within.x0 || sx >= within.x1 || sz < within.z0 || sz >= within.z1) continue;
      }
      // A little past its own square: tracing a raster's edge takes half a cell off it, and simplifying can take more, which would leave
      // a gap along the seam for the ground under it to show through
      const w = Math.min(step + TILE_OVERLAP, raster.w - ti), h = Math.min(step + TILE_OVERLAP, raster.h - tj);
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
        const traced = tile.traceRings(labels, c);
        let rings = traced.map((r) => rdpRing(r, eps)).filter((r) => r.length >= 3);
        // Simplified apart, a hole can come to cross the outline around it
        for (let tighter = eps / 2; tighter > 0.1 && ringsCross(rings); tighter /= 2) rings = traced.map((r) => rdpRing(r, tighter)).filter((r) => r.length >= 3);
        if (!rings.length) continue;
        rings.sort((p, q) => Math.abs(ringArea(q)) - Math.abs(ringArea(p)));
        out.push(rings.filter((r, i) => !i || Math.abs(ringArea(r)) > minHole));
      }
    }
  }
  return out;
}
