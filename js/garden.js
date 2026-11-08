import * as THREE from 'three/webgpu';
import { groundHeight } from './surfaces.js';
import { createGardenBedMaterial } from './tsl-materials.js';
import { GroundCells, SIDEWALK_TOP, addSurface } from './ground-geometry.js';

// A garden's ground, laid over a tile's lawns (tools/build-garden.mjs): its footpaths, beds, hedges, ponds and the gates on its paths. Only
// a few areas have them yet: the Royal Botanic Garden, the Domain, round the Opera House and Circular Quay.
//   tile.garden: { paths: [[kind, surface, width, x, z, ...]], gates: [[x, z, heading, width]], hedges: [[height, width, x, z, ...]],
//     ponds: [[x, z, ...]], beds: [[kind, x, z, ...]] }
// Kinds of path: 0 a footpath, 1 steps, 2 a cycleway. Surfaces: 0 paving, 1 asphalt, 2 gravel, 3 timber, 4 trodden grass (not drawn).
// Beds, by what's planted in them: 0 shrubs, 1 succulents on gravel, 2 flowers and roses, 3 Australian natives.

// Heights over the ground. The lawn is drawn SIDEWALK_TOP + 0.02 up (js/city-grid.js); each of these lies a little over it.
const LAWN_TOP = SIDEWALK_TOP + 0.02;
const BED_TOP = LAWN_TOP + 0.03;
const POND_TOP = LAWN_TOP + 0.02;
const PATH_TOP = LAWN_TOP + 0.05;
const COPING = { width: 0.32, rise: 0.08 };
const STEP = 4; // m between a path's points, so it follows the ground

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
    pond: over(new THREE.MeshStandardNodeMaterial({ color: 0x1f343a, roughness: 0.1, metalness: 0.15 })),
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

/** A strip `width` across along a polyline, `lift` over the ground */
function addRibbon(cells, pts, width, lift) {
  if (pts.length < 2) return;
  const line = dense(pts);
  const side = across(line);
  const c = cells.cell(line[0].x, line[0].z);
  const h = width / 2;
  let prev = null;
  for (let i = 0; i < line.length; i++) {
    const p = line[i], s = side[i];
    const lx = p.x + s.x * h, lz = p.z + s.z * h, rx = p.x - s.x * h, rz = p.z - s.z * h;
    const l = cells.vertex(c, lx, groundHeight(lx, lz) + lift, lz, 0, 1, 0);
    const r = cells.vertex(c, rx, groundHeight(rx, rz) + lift, rz, 0, 1, 0);
    // Up: counter-clockwise from above, with z pointing south
    if (prev) c.index.push(prev.l, l, prev.r, prev.r, l, r);
    prev = { l, r };
  }
}

/** A box along a polyline, `width` across and `height` up from `base` over the ground: a hedge */
function addWallAlong(cells, pts, width, base, height) {
  if (pts.length < 2) return;
  const line = dense(pts, 3);
  const side = across(line);
  const c = cells.cell(line[0].x, line[0].z);
  const h = width / 2;
  const rows = line.map((p, i) => {
    const s = side[i], y = groundHeight(p.x, p.z) + base;
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
  for (const [kind, ...ring] of g.beds) {
    const pts = pointsOf(ring);
    if (pts.length < 3 || !wanted(pts[0].x, pts[0].z)) continue;
    beds.tint = [Math.min(3, kind) / 3, 0, 0];
    addSurface(beds, [pts], BED_TOP);
  }
  yield;
  stone.tint = SANDSTONE;
  for (const ring of g.ponds) {
    const pts = pointsOf(ring);
    if (pts.length < 3 || !wanted(pts[0].x, pts[0].z)) continue;
    addSurface(pond, [pts], POND_TOP);
    // Sandstone round its edge
    addRibbon(stone, [...pts, pts[0]], COPING.width, POND_TOP + COPING.rise);
  }
  yield;
  for (const [kind, surface, width, ...line] of g.paths) {
    const pts = pointsOf(line);
    if (surface === 4 || !SURFACES[surface] || !wanted(pts[0].x, pts[0].z)) continue;
    // Steps in sandstone, whatever OSM says they're made of
    paths.tint = kind === 1 ? SANDSTONE : SURFACES[surface];
    addRibbon(paths, pts, width, PATH_TOP);
  }
  yield;
  for (const [height, width, ...line] of g.hedges) {
    const pts = pointsOf(line);
    if (wanted(pts[0].x, pts[0].z)) addWallAlong(hedge, pts, width, LAWN_TOP, height);
  }
  // Each gate: two sandstone pillars either side of its path, its iron leaves swung open against them
  for (const [x, z, heading, width] of g.gates) {
    if (!wanted(x, z)) continue;
    const y = groundHeight(x, z) + PATH_TOP - 0.02;
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
  return colliders;
}

export { PATH_TOP, buildTileGarden, gardenMaterials };
