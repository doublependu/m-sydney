import * as THREE from 'three/webgpu';
import { WALL_KINDS } from './tsl-materials.js';
import { polygonContains } from './building-collision.js';

function partyWallHeight(record, a, b, neighbours) {
  const dx = b.x - a.x, dz = b.y - a.y, length = Math.hypot(dx, dz);
  let height = 0;
  // Sample along the wall so a single touching corner does not blank the entire facade.
  for (const t of [0.15, 0.5, 0.85]) {
    const x = a.x + dx * t - dz / length, z = a.y + dz * t + dx / length;
    let roof = 0;
    for (const n of neighbours) {
      if (n.polygons === record.polygons || n.height <= 0 ||
        x < n.x0 || x > n.x1 || z < n.z0 || z > n.z1) continue;
      if (n.polygons.some(p => polygonContains(p, x, z))) roof = Math.max(roof, n.height);
    }
    if (!roof) return 0;
    height = Math.max(height, roof);
  }
  return height;
}

// One merged facade/roof mesh per 1 km cell. Explicit wall coordinates keep window bays metre-sized on any angle.

// A pitched roof over a simple footprint: hipped, or gabled (js/building-look.js), at its pitch, standing `eaves` past the walls.
// Its planes are laid over the footprint's tightest rectangle: two slopes along it and, for a hip, two across its ends, each where
// it's the lowest. Where a wall stands under the roof rather than at its edge (a gable end, the inside corner of an L) the wall is
// filled up to it (rooflineOf).
const MAX_RISE = 5.5; // m
const MAX_SPAN = 0.6; // of the half-width: a broad roof is lower than its pitch says
const ROOF_LIMITS = { points: 40, least: 25, most: 1500 }; // m²

/** The roof's frame for a ring of { x, y }, or null where it takes a flat roof: { cx, cy, ux, uy, W, L, tan, gabled, eaves } */
function roofFrame(ring, record) {
  const n = ring.length;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
  area = Math.abs(area / 2);
  if (n > ROOF_LIMITS.points || area < ROOF_LIMITS.least || area > ROOF_LIMITS.most) return null;
  // The rectangle of least area along one of its walls
  let best = null;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 1) continue;
    const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of ring) {
      const u = p.x * ux + p.y * uy, v = -p.x * uy + p.y * ux;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const size = (u1 - u0) * (v1 - v0);
    if (!best || size < best.size - 0.01) best = { size, ux, uy, u0, u1, v0, v1 };
  }
  if (!best) return null;
  let { ux, uy, u0, u1, v0, v1 } = best;
  // The ridge runs along the longer side
  if (v1 - v0 > u1 - u0) {
    [ux, uy] = [-uy, ux];
    [u0, u1, v0, v1] = [v0, v1, -u1, -u0];
  }
  const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
  const W = (v1 - v0) / 2, L = (u1 - u0) / 2;
  const tan = Math.min(Math.tan(((record.pitch ?? 28) * Math.PI) / 180), MAX_RISE / W, MAX_SPAN * 2);
  return { cx: uc * ux - vc * uy, cy: uc * uy + vc * ux, ux, uy, W, L, tan, gabled: !!record.gabled, eaves: record.eaves ?? 0.3 };
}

// In the roof's frame: u along the ridge, v across it, from the rectangle's middle
const toFrame = (f, p) => ({ x: (p.x - f.cx) * f.ux + (p.y - f.cy) * f.uy, y: -(p.x - f.cx) * f.uy + (p.y - f.cy) * f.ux });
const fromFrame = (f, u, v) => ({ x: f.cx + u * f.ux - v * f.uy, y: f.cy + u * f.uy + v * f.ux });
// The roof's planes as a * u + b * v + c, heights over the walls' top in units of the pitch; each is the roof where it's the lowest
const planesOf = (f, grow = 0) => {
  const W = f.W + grow, L = f.L + grow;
  const slopes = [[0, -1, W], [0, 1, W]];
  return f.gabled ? slopes : [...slopes, [-1, 0, L], [1, 0, L]];
};
/** How far above the walls' top the roof is at (u, v) of the frame */
const roofRise = (f, u, v) => f.tan * Math.max(0, Math.min(f.W - Math.abs(v), f.gabled ? Infinity : f.L - Math.abs(u)));

// Sutherland-Hodgman: the part of a polygon where a * x + b * y + c <= 0
function clipHalf(poly, a, b, c) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const fp = a * p.x + b * p.y + c, fq = a * q.x + b * q.y + c;
    if (fp <= 0) out.push(p);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
      const t = fp / (fp - fq);
      out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    }
  }
  return out;
}

// The footprint grown by the eaves, each corner moved out along its walls' normals (at most twice the eaves at a sharp corner)
function grown(ring, by) {
  const n = ring.length, out = [];
  for (let i = 0; i < n; i++) {
    const p = ring[(i + n - 1) % n], q = ring[i], r = ring[(i + 1) % n];
    const l1 = Math.hypot(q.x - p.x, q.y - p.y) || 1, l2 = Math.hypot(r.x - q.x, r.y - q.y) || 1;
    // Outward, as the walls' normals (clockwise rings: createBuildingFootprintsSteps)
    const n1x = -(q.y - p.y) / l1, n1y = (q.x - p.x) / l1, n2x = -(r.y - q.y) / l2, n2y = (r.x - q.x) / l2;
    let mx = n1x + n2x, my = n1y + n2y;
    const m = Math.hypot(mx, my);
    if (m < 1e-6) { mx = n1x; my = n1y; } else { mx /= m; my /= m; }
    const cos = Math.max(0.5, mx * n1x + my * n1y);
    out.push({ x: q.x + (mx * by) / cos, y: q.y + (my * by) / cos });
  }
  return out;
}

/** Adds the roof's triangles, in its colour, to `roofs` ({ positions, colors }) */
function addPitchedRoof(roofs, ring, top, f, colour) {
  const planes = planesOf(f, f.eaves);
  const base = top - f.eaves * f.tan;
  const outline = grown(ring, f.eaves).map((p) => toFrame(f, p));
  for (let k = 0; k < planes.length; k++) {
    let piece = outline;
    for (let j = 0; j < planes.length && piece.length >= 3; j++) {
      if (j === k) continue;
      const [ak, bk, ck] = planes[k], [aj, bj, cj] = planes[j];
      piece = clipHalf(piece, ak - aj, bk - bj, ck - cj);
    }
    if (piece.length < 3) continue;
    const points = piece.map((p) => new THREE.Vector2(p.x, p.y));
    const [a, b, c] = planes[k];
    const height = (p) => base + f.tan * Math.max(0, a * p.x + b * p.y + c);
    for (const tri of THREE.ShapeUtils.triangulateShape(points, [])) {
      const [p, q, r] = tri.map((i) => piece[i]);
      // Facing up
      const flip = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x) > 0;
      for (const v of flip ? [p, r, q] : [p, q, r]) {
        const w = fromFrame(f, v.x, v.y);
        roofs.positions.push(w.x, height(v), w.y);
        roofs.colors.push(colour.r, colour.g, colour.b);
      }
    }
  }
}

/**
 * Where the roof stands over a wall from a to b: [t, rise] at each point along it where its rise changes slope, from 0 to 1.
 * All zero for a wall at the roof's edge.
 */
function rooflineOf(f, a, b) {
  const p = toFrame(f, a), q = toFrame(f, b);
  const cuts = [0, 1];
  const du = q.x - p.x, dv = q.y - p.y;
  // Where it crosses the ridge's line, the middle across, or a hip: |v| - |u| = W - L
  const lines = [[0, 1, 0], [1, 0, 0]];
  if (!f.gabled) for (const su of [1, -1]) for (const sv of [1, -1]) lines.push([-su, sv, f.L - f.W]);
  for (const [a2, b2, c2] of lines) {
    const fp = a2 * p.x + b2 * p.y + c2, d = a2 * du + b2 * dv;
    if (Math.abs(d) > 1e-9) {
      const t = -fp / d;
      if (t > 1e-4 && t < 1 - 1e-4) cuts.push(t);
    }
  }
  cuts.sort((x, y) => x - y);
  return cuts.map((t) => [t, roofRise(f, p.x + du * t, p.y + dv * t)]);
}

const SEAL = 0.3; // how far a wall's foot goes into the ground, so nothing shows between them
const STRIP = 5; // metres: how often a wall's foot follows the ground
const NO_SHOP_ABOVE = 1; // a wall this far above the ground beside it has no shopfront

// The stretch of a wall below its floor, from the floor down to the ground. Each piece is a strip of the wall with kind
// WALL_KINDS.below + (metres of it clear of the ground), which is how the facade knows whether a storey of windows fits.
function addWallFoot(cell, a, b, width, height, base, seed, reverse, groundAt, storey) {
  const nx = -(b.y - a.y) / width, nz = (b.x - a.x) / width;
  const depthAt = (t) => base - groundAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  // A wall with room for a storey under its floor is split at whole window bays, so a bay either has its window or doesn't
  let pieces = Math.max(1, Math.ceil(width / STRIP));
  if (storey && depthAt(0.5) + 1 > storey.height || storey && Math.max(depthAt(0), depthAt(1)) > storey.height) {
    const bays = Math.max(Math.floor(width / storey.width + 0.5), 1);
    pieces = bays;
  }
  let t0 = 0, d0 = depthAt(0);
  for (let i = 1; i <= pieces; i++) {
    const t1 = i / pieces, d1 = depthAt(t1);
    const clear = Math.max(0, Math.min(d0, d1, depthAt((t0 + t1) / 2)));
    const offset = cell.positions.length / 3;
    const ax = a.x + (b.x - a.x) * t0, az = a.y + (b.y - a.y) * t0, bx = a.x + (b.x - a.x) * t1, bz = a.y + (b.y - a.y) * t1;
    const foot0 = base - d0 - SEAL, foot1 = base - d1 - SEAL;
    cell.positions.push(ax, foot0, az, bx, foot1, bz, ax, base, az, bx, base, bz);
    for (let k = 0; k < 4; k++) {
      cell.normals.push(nx, 0, nz);
      cell.boxes.push(width, height, height, seed);
      const along = k % 2 ? t1 : t0;
      const fromTop = k < 2 ? height + base - (k % 2 ? foot1 : foot0) : height;
      cell.walls.push(reverse ? 1 - along : along, fromTop, WALL_KINDS.below + clear);
    }
    cell.indices.push(offset, offset + 1, offset + 2, offset + 2, offset + 1, offset + 3);
    t0 = t1;
    d0 = d1;
  }
}

// groundAt: the ground's height under a wall, to stand it on. storey: { width, height } of the facade's window bays.
function* createBuildingFootprintsSteps(material, records, getNeighbours, roofMaterials = null, { groundAt = null, storey = null } = {}) {
  const cells = new Map();
  for (const [index, record] of records.entries()) {
    yield;
    if (!(record.height > 0)) continue;
    const key = Math.floor(record.cx / 1000) + ',' + Math.floor(record.cz / 1000);
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { key, positions: [], normals: [], indices: [], boxes: [], walls: [], roofs: { positions: [], colors: [] } }));
    const height = record.height, base = (record.base ?? 0) + 0.22, top = height + base;
    // A piece standing on another starts this far up. Its floors count from the building's floor all the same.
    const bottom = record.bottom || 0;
    const seed = Math.floor(record.seed ?? index * 29) % 1000 + 0.1 + 0.8 * (record.tone ?? 0.5);
    const neighbours = getNeighbours && height <= 60 && !record.group ? getNeighbours(record) : [];

    for (const polygon of record.polygons) {
      const rings = [polygon.outer, ...(polygon.holes || [])].map((ring, i) => {
        const points = ring.map(p => new THREE.Vector2(p.x, p.z));
        if (points.length > 1 && points[0].equals(points[points.length - 1])) points.pop();
        // Clockwise outer walls face away from the building; courtyard walls face into their holes.
        if (THREE.ShapeUtils.isClockWise(points) !== (i === 0)) points.reverse();
        return points;
      });
      if (rings[0].length < 3) continue;
      // A pitched roof over a footprint with no courtyard, simple enough for one
      const frame = record.pitched && roofMaterials && rings.length === 1 && !bottom ? roofFrame(rings[0], record) : null;
      rings.forEach((ring, i) => {
        for (let j = 0; j < ring.length; j++) {
          const a = ring[j], b = ring[(j + 1) % ring.length];
          const dx = b.x - a.x, dz = b.y - a.y, width = Math.hypot(dx, dz);
          if (width === 0) continue;
          const offset = cell.positions.length / 3;
          const adjacentHeight = !i && neighbours.length ? partyWallHeight(record, a, b, neighbours) : 0;
          // A shopfront only where the wall meets the pavement
          const meetsGround = !bottom && (!groundAt || base - groundAt((a.x + b.x) / 2, (a.y + b.y) / 2) <= NO_SHOP_ABOVE);
          const kind = i ? WALL_KINDS.rear : adjacentHeight ? WALL_KINDS.lotLine
            : record.storefronts && meetsGround ? WALL_KINDS.shop : WALL_KINDS.front;
          const exposedHeight = adjacentHeight ? Math.max(0, height + 0.22 - adjacentHeight) : height;
          // Match the positive-world-axis tangent used by the shared interior-map view ray.
          const reverse = (Math.abs(dz) >= Math.abs(dx) ? dz : dx) < 0;
          cell.positions.push(a.x, base + bottom, a.y, b.x, base + bottom, b.y, a.x, top, a.y, b.x, top, b.y);
          for (let k = 0; k < 4; k++) {
            cell.normals.push(-dz / width, 0, dx / width);
            // Footprint walls use the box's unused depth for the exposed height above adjoining roofs.
            cell.boxes.push(width, height, exposedHeight, seed);
            cell.walls.push(reverse ? 1 - k % 2 : k % 2, k < 2 ? height - bottom : 0, kind);
          }
          cell.indices.push(offset, offset + 1, offset + 2, offset + 2, offset + 1, offset + 3);
          if (groundAt && !bottom) addWallFoot(cell, a, b, width, height, base, seed, reverse, groundAt, storey);
          // Up to the roof, where the wall stands under it: a gable end, the inside corner of an L. The wall's own, with no windows:
          // above the wall's top, no storey of windows fits (js/tsl-materials.js facadeCell)
          if (frame) {
            const line = rooflineOf(frame, a, b);
            for (let k = 1; k < line.length; k++) {
              const [t0, r0] = line[k - 1], [t1, r1] = line[k];
              if (r0 < 0.01 && r1 < 0.01) continue;
              const o = cell.positions.length / 3;
              const ax = a.x + dx * t0, az = a.y + dz * t0, bx = a.x + dx * t1, bz = a.y + dz * t1;
              cell.positions.push(ax, top, az, bx, top, bz, ax, top + r0, az, bx, top + r1, bz);
              for (let v = 0; v < 4; v++) {
                const along = v % 2 ? t1 : t0;
                cell.normals.push(-dz / width, 0, dx / width);
                cell.boxes.push(width, height, exposedHeight, seed);
                cell.walls.push(reverse ? 1 - along : along, v < 2 ? 0 : -(v % 2 ? r1 : r0), kind);
              }
              cell.indices.push(o, o + 1, o + 2, o + 2, o + 1, o + 3);
            }
          }
        }
      });
      if (frame) {
        addPitchedRoof(cell.roofs, rings[0], top, frame, roofMaterials.colours[record.roof ?? 4] || roofMaterials.colours[4]);
        continue;
      }
      const triangles = THREE.ShapeUtils.triangulateShape(rings[0], rings.slice(1));
      const points = rings.flat(), offset = cell.positions.length / 3;
      for (const p of points) {
        cell.positions.push(p.x, top, p.y);
        cell.normals.push(0, 1, 0);
        cell.boxes.push(1, height, height, seed);
        cell.walls.push(0, 0, WALL_KINDS.front);
      }
      for (const [a, b, c] of triangles) cell.indices.push(offset + a, offset + c, offset + b);
    }
  }

  const group = new THREE.Group();
  group.name = 'SurveyedBuildings';
  let first;
  for (const cell of cells.values()) {
    yield;
    if (cell.indices.length === 0) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(cell.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(cell.normals, 3));
    geometry.setAttribute('box', new THREE.Float32BufferAttribute(cell.boxes, 4));
    geometry.setAttribute('facadeWall', new THREE.Float32BufferAttribute(cell.walls, 3));
    geometry.setIndex(cell.indices);
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'SurveyedBuildingChunk';
    mesh.userData.lifted = true;
    mesh.userData.cell = cell.key;
    mesh.castShadow = mesh.receiveShadow = true;
    // Most cells are too small for scene-culling.js to pick them as big casters on its own: opt in to its stand-ins.
    mesh.userData.shadowStandIn = true;
    if (first) mesh.userData.sharesPipelineWith = first;
    else first = mesh;
    group.add(mesh);
  }
  for (const cell of roofMaterials ? cells.values() : []) {
    if (!cell.roofs.positions.length) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(cell.roofs.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(cell.roofs.colors, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, roofMaterials.material);
    mesh.name = 'PitchedRoofs';
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.lifted = true;
    mesh.userData.cell = cell.key;
    group.add(mesh);
  }
  return group;
}

function createBuildingFootprints(material, records, getNeighbours, roofMaterials = null, options = {}) {
  const job = createBuildingFootprintsSteps(material, records, getNeighbours, roofMaterials, options);
  let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
}

export { createBuildingFootprints, createBuildingFootprintsSteps, roofFrame, roofRise, rooflineOf };
