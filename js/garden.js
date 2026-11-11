import * as THREE from 'three/webgpu';
import { groundHeight } from './surfaces.js';
import { createGardenBedMaterial, createPondMaterial, createSandstoneWallMaterial } from './tsl-materials.js';
import { CITY_BOUNDS, LAWNS } from './city-config.js';
import { GroundCells, SIDEWALK_TOP, addSurface } from './ground-geometry.js';
import { TILE } from './geodata.js';

// A garden's ground, laid over a tile's lawns (tools/build-garden.mjs): its footpaths, beds, hedges, ponds and the gates on its paths. Only
// a few areas have them yet: the Royal Botanic Garden, the Domain, round the Opera House and Circular Quay.
//   tile.garden: { paths: [[kind, surface, width, x, z, ...]], gates: [[x, z, heading, width]], hedges: [[height, width, x, z, ...]],
//     ponds: [[x, z, ...]], beds: [[kind, x, z, ...]], seawalls: [[side, x, z, ...]] }
// Kinds of path: 0 a footpath, 1 steps, 2 a cycleway. Surfaces: 0 paving, 1 asphalt, 2 gravel, 3 timber, 4 trodden grass (not drawn).
// Beds, by what's planted in them: 0 shrubs, 1 succulents on gravel, 2 flowers and roses, 3 Australian natives.

// Heights over the ground. The lawn is drawn SIDEWALK_TOP + 0.02 up (js/city-grid.js); each of these lies a little over it, on the
// lawn as it's drawn (lawnSurface()).
const LAWN_TOP = SIDEWALK_TOP + 0.02;
const BED_TOP = LAWN_TOP + 0.03;
const POND_TOP = LAWN_TOP + 0.02;
const PATH_TOP = LAWN_TOP + 0.05;
// Paths a centimetre apart by what they're made of, so that where two meet one is always on top: timber lowest, then gravel, paving
// and asphalt, and steps over all of them. At one height, the two fought for every pixel where they crossed.
const PATH_LIFT = [0.02, 0.03, 0.01, 0]; // paving, asphalt, gravel, timber: over PATH_TOP
const STEPS_LIFT = 0.04;
const COPING = { width: 0.32, rise: 0.08 };
const STEP = 2; // m between a path's points, so it follows the lawn's triangles
const WIDE = 2.5; // m: a path wider than this has a row of points along its middle too
const PIECE = 3; // m: a bed's or pond's triangles are cut no longer than this, to follow the lawn
// A sea wall's parapet along the shore, its face from under the water up to its top, so the water's level shows against the stone. It
// stands from a metre out past the shore's line (js/city-grid.js draws the sea wall's own face on it) to `thickness` in: the lawn's
// outline and the shore's are each traced from the land to within a metre, and the lawn can reach out past the shore by that much.
const PARAPET = { height: 0.6, thickness: 0.45, out: 1.0, coping: 0.07, overhang: 0.05, stop: 1.1 };

// One set for every tile, so a new tile compiles nothing; few of them, as a tile draws each once. The paths' surfaces, and the stonework
// and iron, are colours in their vertices; which kind each bed is, too (createGardenBedMaterial()).
let shared = null;
function gardenMaterials() {
  if (shared) return shared;
  const over = (m) => {
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -2;
    return m;
  };
  shared = {
    paths: over(new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.9 })),
    beds: over(createGardenBedMaterial([
      { soil: 0x3a2a1e, speckles: [0x3d5f2a, 0x47692f, 0x2f4a22], cover: 0.45 }, { soil: 0xa39783, speckles: [0x7d9a8a, 0x6f8b7c, 0x8a8f5a], cover: 0.35 },
      { soil: 0x3a2a1e, speckles: [0xb0283a, 0xd8708a, 0xe0b030], cover: 0.5 }, { soil: 0x3f3022, speckles: [0x5f6e48, 0x6b7a52, 0x7a5040], cover: 0.45 }
    ])),
    pond: over(createPondMaterial()),
    wall: createSandstoneWallMaterial({ waterLevel: CITY_BOUNDS.waterLevel }),
    stone: new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.8 }),
    hedge: new THREE.MeshStandardNodeMaterial({ color: 0x35612f, roughness: 0.9 })
  };
  return shared;
}
// The paths' surfaces: paving, asphalt, gravel, timber; and steps, in sandstone
const linear = (hex) => new THREE.Color(hex).toArray();
const SURFACES = [0xa59d8f, 0x56575a, 0xb8a582, 0x7d5f42].map(linear);
const SANDSTONE = linear(0xc4a679), IRON = linear(0x1d1e1f);

/** Ground cells with a colour at each vertex: set `tint` before adding to them */
class TintedCells extends GroundCells {
  constructor() {
    super(1e6);
    this.tint = [1, 1, 1];
  }
  cell(x, z) {
    const c = super.cell(x, z);
    c.color ||= [];
    return c;
  }
  vertex(c, x, y, z, nx, ny, nz) {
    c.color.push(...this.tint);
    return super.vertex(c, x, y, z, nx, ny, nz);
  }
}

/**
 * The lawn's height under (x, z) as js/city-grid.js draws it, or null off the lawns: each lawn is laid with addSurface() on the height
 * grid's nodes, 20 m apart, and its own edges, so its triangles are straight where the ground bends between the nodes, and on a slope
 * the lawn came up through anything laid on the ground's own height. Any held tile's lawn near `tile`: a lawn's 240 m square can reach
 * over a tile's edge, though it's the other tile's. Each lawn's triangles are made again the first time a garden asks for a height on
 * it (the tiles' own were drawn in parts, some before the garden), and kept while the lawn is.
 */
const lawnTriangles = new WeakMap();
function lawnSurface(tile) {
  const BOX = 32, CELL = 4, NEAR = 300;
  const x0 = tile.ix * TILE - NEAR, x1 = (tile.ix + 1) * TILE + NEAR, z0 = tile.iz * TILE - NEAR, z1 = (tile.iz + 1) * TILE + NEAR;
  const index = new Map();
  for (const rings of LAWNS) {
    let lawn = lawnTriangles.get(rings);
    if (!lawn) {
      let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
      for (const p of rings[0]) {
        a = Math.min(a, p.x); b = Math.max(b, p.x); c = Math.min(c, p.z); d = Math.max(d, p.z);
      }
      lawn = { rings, x0: a, x1: b, z0: c, z1: d, tris: null };
      lawnTriangles.set(rings, lawn);
    }
    if (lawn.x1 < x0 || lawn.x0 > x1 || lawn.z1 < z0 || lawn.z0 > z1) continue;
    for (let cx = Math.floor(lawn.x0 / BOX); cx <= Math.floor(lawn.x1 / BOX); cx++) {
      for (let cz = Math.floor(lawn.z0 / BOX); cz <= Math.floor(lawn.z1 / BOX); cz++) {
        const key = cx * 100000 + cz;
        (index.get(key) || index.set(key, []).get(key)).push(lawn);
      }
    }
  }
  const build = (lawn) => {
    const cells = new GroundCells(1e6);
    addSurface(cells, lawn.rings, 0);
    lawn.tris = new Map();
    for (const c of cells.cells.values()) {
      const P = c.position, I = c.index;
      for (let i = 0; i < I.length; i += 3) {
        const t = [I[i], I[i + 1], I[i + 2]].map((v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
        const xs = t.map((v) => v[0]), zs = t.map((v) => v[2]);
        for (let cx = Math.floor(Math.min(...xs) / CELL); cx <= Math.floor(Math.max(...xs) / CELL); cx++) {
          for (let cz = Math.floor(Math.min(...zs) / CELL); cz <= Math.floor(Math.max(...zs) / CELL); cz++) {
            const key = cx * 100000 + cz;
            (lawn.tris.get(key) || lawn.tris.set(key, []).get(key)).push(t);
          }
        }
      }
    }
  };
  return (x, z) => {
    for (const lawn of index.get(Math.floor(x / BOX) * 100000 + Math.floor(z / BOX)) || []) {
      if (x < lawn.x0 || x > lawn.x1 || z < lawn.z0 || z > lawn.z1) continue;
      if (!lawn.tris) build(lawn);
      for (const t of lawn.tris.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || []) {
        const y = heightInTriangle(t, x, z);
        if (y !== null) return y;
      }
    }
    return null;
  };
}

/** The height at (x, z) of the triangle [[x, y, z] x 3] over it, or null if it isn't over it */
function heightInTriangle([a, b, c], x, z) {
  const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
  if (Math.abs(d) < 1e-9) return null;
  const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d;
  const l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
  const l3 = 1 - l1 - l2;
  if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) return null;
  return l1 * a[1] + l2 * b[1] + l3 * c[1];
}

const pointsOf = (flat, from = 0) => {
  const out = [];
  for (let i = from; i + 1 < flat.length; i += 2) out.push({ x: flat[i], z: flat[i + 1] });
  return out;
};

/** A polyline with points no further apart than `step` */
function dense(pts, step = STEP) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  return out;
}

/** Each point's way across a polyline: the mean of its two segments' normals, with its mitre's stretch (no more than 2) */
function across(pts) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const prev = i > 0 ? norm(p.x - a.x, p.z - a.z) : null, next = i < pts.length - 1 ? norm(b.x - p.x, b.z - p.z) : null;
    const d = prev && next ? norm(prev.x + next.x, prev.z + next.z) : prev || next;
    const stretch = prev && next ? Math.min(2, 1 / Math.max(0.5, d.x * next.x + d.z * next.z)) : 1;
    return { x: -d.z * stretch, z: d.x * stretch };
  });
}
function norm(x, z) {
  const L = Math.hypot(x, z) || 1;
  return { x: x / L, z: z / L };
}

/** A strip `width` across along a polyline, `lift` over the height `heightAt` gives */
function addRibbon(cells, pts, width, lift, heightAt) {
  if (pts.length < 2) return;
  const line = dense(pts);
  const side = across(line);
  const c = cells.cell(line[0].x, line[0].z);
  const h = width / 2;
  // Its left edge, its middle if it's wide, its right edge
  const columns = width > WIDE ? [1, 0, -1] : [1, -1];
  let prev = null;
  for (let i = 0; i < line.length; i++) {
    const p = line[i], s = side[i];
    const row = columns.map((k) => {
      const x = p.x + s.x * h * k, z = p.z + s.z * h * k;
      return cells.vertex(c, x, heightAt(x, z) + lift, z, 0, 1, 0);
    });
    // Up: counter-clockwise from above, with z pointing south
    if (prev) for (let k = 1; k < row.length; k++) c.index.push(prev[k - 1], row[k - 1], prev[k], prev[k], row[k - 1], row[k]);
    prev = row;
  }
}

/**
 * A flat shape (rings: the outer and its holes) laid `lift` over the height `heightAt` gives: triangulated as the lawn is, then cut into
 * pieces no longer than PIECE so that it bends where the lawn under it does
 */
function addDraped(cells, rings, lift, heightAt) {
  const flat = new GroundCells(1e6);
  addSurface(flat, rings, 0);
  const c = cells.cell(rings[0][0].x, rings[0][0].z);
  // Points shared between the pieces, by where they are
  const ids = new Map();
  const point = (x, z) => {
    const key = `${Math.round(x * 1000)},${Math.round(z * 1000)}`;
    let id = ids.get(key);
    if (id === undefined) ids.set(key, (id = cells.vertex(c, x, heightAt(x, z) + lift, z, 0, 1, 0)));
    return id;
  };
  const put = (a, b, d) => {
    // Its longest side halved, until none is longer than PIECE, keeping the way round it faces up
    const sides = [[a, b, d], [b, d, a], [d, a, b]];
    let longest = null, most = PIECE * PIECE;
    for (const t of sides) {
      const l = (t[1][0] - t[0][0]) ** 2 + (t[1][1] - t[0][1]) ** 2;
      if (l > most) { most = l; longest = t; }
    }
    if (longest) {
      const [p, q, r] = longest;
      const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      put(p, m, r);
      put(m, q, r);
      return;
    }
    c.index.push(point(a[0], a[1]), point(b[0], b[1]), point(d[0], d[1]));
  };
  for (const f of flat.cells.values()) {
    const P = f.position, I = f.index;
    for (let i = 0; i < I.length; i += 3) put(...[I[i], I[i + 1], I[i + 2]].map((v) => [P[v * 3], P[v * 3 + 2]]));
  }
}

/** A box along a polyline, `width` across and `height` up from `base` over the height `heightAt` gives: a hedge */
function addWallAlong(cells, pts, width, base, height, heightAt) {
  if (pts.length < 2) return;
  const line = dense(pts, 3);
  const side = across(line);
  const c = cells.cell(line[0].x, line[0].z);
  const h = width / 2;
  const rows = line.map((p, i) => {
    const s = side[i], y = heightAt(p.x, p.z) + base;
    return { l: [p.x + s.x * h, y, p.z + s.z * h], r: [p.x - s.x * h, y, p.z - s.z * h], s };
  });
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    // The two sides, then the top
    for (const [key, sign] of [['l', 1], ['r', -1]]) {
      const n = [a.s.x * sign, 0, a.s.z * sign];
      const v0 = cells.vertex(c, a[key][0], a[key][1] - 0.05, a[key][2], ...n), v1 = cells.vertex(c, b[key][0], b[key][1] - 0.05, b[key][2], ...n);
      const v2 = cells.vertex(c, a[key][0], a[key][1] + height, a[key][2], ...n), v3 = cells.vertex(c, b[key][0], b[key][1] + height, b[key][2], ...n);
      if (sign > 0) c.index.push(v0, v1, v2, v1, v3, v2);
      else c.index.push(v0, v2, v1, v1, v2, v3);
    }
    const t0 = cells.vertex(c, a.l[0], a.l[1] + height, a.l[2], 0, 1, 0), t1 = cells.vertex(c, b.l[0], b.l[1] + height, b.l[2], 0, 1, 0);
    const t2 = cells.vertex(c, a.r[0], a.r[1] + height, a.r[2], 0, 1, 0), t3 = cells.vertex(c, b.r[0], b.r[1] + height, b.r[2], 0, 1, 0);
    c.index.push(t0, t1, t2, t2, t1, t3);
  }
  // Its two ends
  for (const [row, dir] of [[rows[0], -1], [rows[rows.length - 1], 1]]) {
    const n = [row.s.z * dir, 0, -row.s.x * dir];
    const v0 = cells.vertex(c, row.l[0], row.l[1] - 0.05, row.l[2], ...n), v1 = cells.vertex(c, row.r[0], row.r[1] - 0.05, row.r[2], ...n);
    const v2 = cells.vertex(c, row.l[0], row.l[1] + height, row.l[2], ...n), v3 = cells.vertex(c, row.r[0], row.r[1] + height, row.r[2], ...n);
    if (dir > 0) c.index.push(v0, v1, v2, v1, v3, v2);
    else c.index.push(v0, v2, v1, v1, v2, v3);
  }
}

/** A flat four-cornered face ([x, y, z] each, in order round it), turned the way round that faces along `n` */
function addFace(cells, c, corners, n) {
  const ids = corners.map(([x, y, z]) => cells.vertex(c, x, y, z, n[0], n[1], n[2]));
  const [a, b, d] = corners;
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
  const facing = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2];
  if (facing >= 0) c.index.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
  else c.index.push(ids[0], ids[2], ids[1], ids[0], ids[3], ids[2]);
}

/**
 * A sea wall's parapet along the shore `pts`, the land on the side `side` gives (as js/city-grid.js reads a shore's): its sea face from
 * under the water, its land face from the lawn, its top and a coping over both. Returns its colliders, one a
 * straight run, high enough not to be jumped.
 */
function addParapet(cells, pts, side, heightAt) {
  const P = PARAPET;
  // Its line is the shore's, straight between its points: a point every few metres only follows the ground along it
  const line = dense(pts, 4);
  const land = across(line).map((s) => ({ x: s.x * side, z: s.z * side }));
  const c = cells.cell(line[0].x, line[0].z);
  const rows = line.map((p, i) => {
    const n = land[i];
    const at = (d) => [p.x + n.x * d, p.z + n.z * d];
    const [ix, iz] = at(P.thickness);
    const lawn = heightAt(ix, iz) + LAWN_TOP;
    const ground = groundHeight(p.x, p.z);
    const top = Math.max(ground + LAWN_TOP, lawn) + P.height;
    return { n, outer: at(-P.out), inner: at(P.thickness), copeOut: at(-P.out - P.overhang), copeIn: at(P.thickness + P.overhang), foot: CITY_BOUNDS.waterLevel - 0.6, lawn: lawn - 0.05, top };
  });
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    const sea = [-a.n.x, 0, -a.n.z], landward = [a.n.x, 0, a.n.z];
    const quad = (pa, ya0, ya1, pb, yb0, yb1, n) => addFace(cells, c, [[pa[0], ya0, pa[1]], [pb[0], yb0, pb[1]], [pb[0], yb1, pb[1]], [pa[0], ya1, pa[1]]], n);
    quad(a.outer, a.foot, a.top, b.outer, b.foot, b.top, sea);
    quad(a.inner, a.lawn, a.top, b.inner, b.lawn, b.top, landward);
    addFace(cells, c, [[a.outer[0], a.top, a.outer[1]], [b.outer[0], b.top, b.outer[1]], [b.inner[0], b.top, b.inner[1]], [a.inner[0], a.top, a.inner[1]]], [0, 1, 0]);
    // The coping, a little proud of both faces
    const ct = P.coping;
    quad(a.copeOut, a.top, a.top + ct, b.copeOut, b.top, b.top + ct, sea);
    quad(a.copeIn, a.top, a.top + ct, b.copeIn, b.top, b.top + ct, landward);
    addFace(cells, c, [[a.copeOut[0], a.top + ct, a.copeOut[1]], [b.copeOut[0], b.top + ct, b.copeOut[1]], [b.copeIn[0], b.top + ct, b.copeIn[1]], [a.copeIn[0], a.top + ct, a.copeIn[1]]], [0, 1, 0]);
  }
  // Its two ends, where steps or a jetty open it
  for (const [r, k] of [[rows[0], 0], [rows[rows.length - 1], rows.length - 1]]) {
    const next = rows[k === 0 ? 1 : k - 1];
    const dx = r.outer[0] - next.outer[0], dz = r.outer[1] - next.outer[1], L = Math.hypot(dx, dz) || 1;
    const n = [dx / L, 0, dz / L];
    addFace(cells, c, [[r.outer[0], r.foot, r.outer[1]], [r.inner[0], r.foot, r.inner[1]], [r.inner[0], r.top + PARAPET.coping, r.inner[1]], [r.outer[0], r.top + PARAPET.coping, r.outer[1]]], n);
  }
  // Colliders along its own straight runs, standing over the ground as every collider does (the simulation is flat)
  const colliders = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 0.05) continue;
    const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
    // The land side, as across() reckons it
    const nx = -uz * side, nz = ux * side;
    const half = (P.thickness + P.out) / 2, mid = (P.thickness - P.out) / 2;
    const cx = (a.x + b.x) / 2 + nx * mid, cz = (a.z + b.z) / 2 + nz * mid;
    const yaw = Math.atan2(ux, uz), hx = half, hz = L / 2 + 0.05;
    const ex = Math.abs(Math.cos(yaw)) * hx + Math.abs(Math.sin(yaw)) * hz, ez = Math.abs(Math.sin(yaw)) * hx + Math.abs(Math.cos(yaw)) * hz;
    colliders.push({ minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez, minY: 0, maxY: P.stop, obb: { cx, cz, hx, hz, cs: Math.cos(yaw), sn: Math.sin(yaw) } });
  }
  return colliders;
}

/** An upright box, `w` by `d` and `h` up from `y`, turned `yaw` about (x, z) */
function addBox(cells, x, z, yaw, w, d, y, h) {
  const c = cells.cell(x, z);
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const at = (u, v) => [x + u * cs + v * sn, z - u * sn + v * cs];
  const corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([u, v]) => at(u, v));
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
    const n = norm(bz - az, -(bx - ax));
    const v0 = cells.vertex(c, ax, y, az, n.x, 0, n.z), v1 = cells.vertex(c, bx, y, bz, n.x, 0, n.z);
    const v2 = cells.vertex(c, ax, y + h, az, n.x, 0, n.z), v3 = cells.vertex(c, bx, y + h, bz, n.x, 0, n.z);
    c.index.push(v0, v2, v1, v1, v2, v3);
  }
  const top = corners.map(([cx, cz]) => cells.vertex(c, cx, y + h, cz, 0, 1, 0));
  c.index.push(top[0], top[2], top[1], top[0], top[3], top[2]);
}

/**
 * A tile's garden, into `target` with `buildCells` (js/city-grid.js). Returns colliders for the gates' pillars, as structures' are.
 */
function* buildTileGarden(tile, target, buildCells, wanted = () => true) {
  const g = tile.garden;
  if (!g) return [];
  const mats = gardenMaterials();
  const paths = new TintedCells(), beds = new TintedCells(), stone = new TintedCells(), pond = new GroundCells(1e6), hedge = new GroundCells(1e6);
  const colliders = [];
  const lawnAt = lawnSurface(tile);
  const heightAt = (x, z) => lawnAt(x, z) ?? groundHeight(x, z);
  for (const [kind, ...ring] of g.beds) {
    const pts = pointsOf(ring);
    if (pts.length < 3 || !wanted(pts[0].x, pts[0].z)) continue;
    beds.tint = [Math.min(3, kind) / 3, 0, 0];
    addDraped(beds, [pts], BED_TOP, heightAt);
  }
  yield;
  stone.tint = SANDSTONE;
  for (const ring of g.ponds) {
    const pts = pointsOf(ring);
    if (pts.length < 3 || !wanted(pts[0].x, pts[0].z)) continue;
    addDraped(pond, [pts], POND_TOP, heightAt);
    // Sandstone round its edge
    addRibbon(stone, [...pts, pts[0]], COPING.width, POND_TOP + COPING.rise, heightAt);
  }
  yield;
  for (const [kind, surface, width, ...line] of g.paths) {
    const pts = pointsOf(line);
    if (surface === 4 || !SURFACES[surface] || !wanted(pts[0].x, pts[0].z)) continue;
    // Steps in sandstone, whatever OSM says they're made of
    paths.tint = kind === 1 ? SANDSTONE : SURFACES[surface];
    addRibbon(paths, pts, width, PATH_TOP + (kind === 1 ? STEPS_LIFT : PATH_LIFT[surface]), heightAt);
  }
  yield;
  for (const [height, width, ...line] of g.hedges) {
    const pts = pointsOf(line);
    if (wanted(pts[0].x, pts[0].z)) addWallAlong(hedge, pts, width, LAWN_TOP, height, heightAt);
  }
  const walls = new GroundCells(1e6);
  for (const [side, ...line] of g.seawalls ?? []) {
    const pts = pointsOf(line);
    if (pts.length > 1 && wanted(pts[0].x, pts[0].z)) colliders.push(...addParapet(walls, pts, side, heightAt));
  }
  // Each gate: two sandstone pillars either side of its path, its iron leaves swung open against them
  for (const [x, z, heading, width] of g.gates) {
    if (!wanted(x, z)) continue;
    const y = heightAt(x, z) + PATH_TOP - 0.02;
    const rx = Math.cos(heading), rz = -Math.sin(heading); // across the path
    for (const side of [-1, 1]) {
      const px = x + rx * side * (width / 2 + 0.28), pz = z + rz * side * (width / 2 + 0.28);
      stone.tint = SANDSTONE;
      addBox(stone, px, pz, heading, 0.55, 0.55, y - 0.1, 2.1);
      addBox(stone, px, pz, heading, 0.68, 0.68, y + 2, 0.14);
      // The leaf, folded back along the path's edge from the pillar
      const leaf = width / 2;
      const fx = Math.sin(heading), fz = Math.cos(heading);
      const lx = x + rx * side * (width / 2 - 0.06) + fx * (leaf / 2 + 0.3), lz = z + rz * side * (width / 2 - 0.06) + fz * (leaf / 2 + 0.3);
      stone.tint = IRON;
      addBox(stone, lx, lz, heading, 0.05, leaf, y + 0.08, 1.6);
      // Heights over the ground, as every collider's (the simulation is flat)
      colliders.push({ minX: px - 0.36, maxX: px + 0.36, minZ: pz - 0.36, maxZ: pz + 0.36, minY: 0, maxY: 2.4 });
    }
  }
  yield;
  buildCells(paths, target, mats.paths, { cullDistance: 900 });
  buildCells(beds, target, mats.beds, { cullDistance: 900 });
  buildCells(pond, target, mats.pond, { cullDistance: 1200 });
  buildCells(stone, target, mats.stone, { cullDistance: 600 });
  buildCells(hedge, target, mats.hedge, { cast: true, cullDistance: 900 });
  buildCells(walls, target, mats.wall, { cast: true, cullDistance: 900 });
  return colliders;
}

export { PATH_TOP, buildTileGarden, gardenMaterials };
