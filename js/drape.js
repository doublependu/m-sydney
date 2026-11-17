import { ShapeUtils, Vector2 } from 'three/webgpu';

// Laying something flat exactly on the ground's triangles as they're drawn (a lawn's or the paving's: js/garden.js lawnSurface()
// .trianglesIn()): the part of it over each triangle, in that triangle's plane, a little over it. Laid through its own points' heights
// instead, a piece cuts into the ground on a slope wherever the ground's triangles bend between its points, or stands off it. The nature
// strips (js/verge.js), and a garden's raised lawn, its paths, beds and tracks (js/garden.js).
// Triangles in: [[x, y, z] x 3], y the surface's own height (without its lift). Out: x, y, z of each corner of each triangle facing up,
// relative to (ox, oz), pushed onto an array; each returns how many it pushed.

/** Twice the signed area of a ring in x, z: positive anticlockwise seen from above as the ground's triangles are wound (y of u x v) */
function areaOf(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += p.z * q.x - p.x * q.z;
  }
  return a;
}

/** A polygon cut to the inside of a convex ring wound as areaOf() counts positive (Sutherland and Hodgman) */
function clipConvex(poly, ring) {
  let out = poly;
  for (let i = 0; i < ring.length && out.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    // Inside: on the side of a -> b that keeps the ring's winding
    const side = (p) => (b.z - a.z) * (p.x - a.x) - (b.x - a.x) * (p.z - a.z);
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t });
      }
    }
  }
  return out;
}

/** Whether a ring is convex, wound as areaOf() counts positive */
function convex(ring) {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], c = ring[(i + 2) % ring.length];
    if ((b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z) < -1e-9) return false;
  }
  return true;
}

/** A surface triangle's plane, its height at (x, z) as a function, or null for one standing on its edge */
function planeOf([a, b, c]) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const den = ux * vz - uz * vx;
  if (Math.abs(den) < 1e-9) return null;
  const gx = (uy * vz - uz * vy) / den, gz = (ux * vy - uy * vx) / den;
  return (x, z) => a[1] + gx * (x - a[0]) + gz * (z - a[2]);
}

/** A convex polygon (x, z) in one surface triangle's plane `y` (plus `lift`), as triangles facing up onto `out` */
function fan(poly, y, lift, out, ox, oz) {
  const up = areaOf(poly) >= 0;
  let n = 0;
  for (let i = 1; i + 1 < poly.length; i++) {
    const tri = up ? [poly[0], poly[i], poly[i + 1]] : [poly[0], poly[i + 1], poly[i]];
    // Slivers left by the clipping add nothing
    if (Math.abs(areaOf(tri)) < 1e-6) continue;
    for (const p of tri) out.push(p.x - ox, y(p.x, p.z) + lift, p.z - oz);
    n++;
  }
  return n;
}

const asRing = (t) => {
  const ring = [{ x: t[0][0], z: t[0][2] }, { x: t[1][0], z: t[1][2] }, { x: t[2][0], z: t[2][2] }];
  return areaOf(ring) < 0 ? ring.reverse() : ring;
};

/**
 * A flat piece (a ring in x, z) laid on triangles, `lift` over them: the part of it over each triangle, in that triangle's plane. A piece
 * that isn't convex is fanned from its first point, so give it as triangles or convex pieces (a quad from its own corners, as a strip's).
 */
function drape(ring, tris, lift, out, ox, oz) {
  let rings = [ring];
  if (areaOf(ring) < 0) rings = [[...ring].reverse()];
  if (!convex(rings[0])) {
    const r = rings[0];
    rings = [];
    for (let i = 1; i + 1 < r.length; i++) rings.push([r[0], r[i], r[i + 1]]);
  }
  let n = 0;
  for (const piece of rings) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of piece) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
    for (const t of tris) {
      const [a, b, c] = t;
      if (Math.max(a[0], b[0], c[0]) < x0 || Math.min(a[0], b[0], c[0]) > x1 || Math.max(a[2], b[2], c[2]) < z0 || Math.min(a[2], b[2], c[2]) > z1) continue;
      const poly = clipConvex(asRing(t), piece);
      if (poly.length < 3) continue;
      const y = planeOf(t);
      if (y) n += fan(poly, y, lift, out, ox, oz);
    }
  }
  return n;
}

/** A polygon's triangles in x, z: `rings` its outline and its holes, each [{ x, z }, ...] */
function triangulate(rings) {
  // Without a point repeated (three's triangulator drops a ring's last point where it's its first, in place, which would put every index
  // after it out by one)
  const clean = rings.map((r) => r.filter((p, i) => {
    const q = r[(i + 1) % r.length];
    return Math.abs(p.x - q.x) > 1e-9 || Math.abs(p.z - q.z) > 1e-9;
  })).filter((r, i) => r.length >= 3 || i > 0);
  if (!clean.length || clean[0].length < 3) return [];
  const kept = [clean[0], ...clean.slice(1).filter((r) => r.length >= 3)];
  const pts = kept.flat();
  const v2 = kept.map((r) => r.map((p) => new Vector2(p.x, p.z)));
  return ShapeUtils.triangulateShape(v2[0], v2.slice(1)).map((f) => f.map((i) => pts[i]));
}

const CELL = 4; // m: the cells a polygon's edges and triangles are found by
const cellKey = (cx, cz) => cx * 100000 + cz;
function addToCells(map, x0, z0, x1, z1, item) {
  for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
    for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
      const key = cellKey(cx, cz);
      (map.get(key) || map.set(key, []).get(key)).push(item);
    }
  }
}
function inCells(map, x0, z0, x1, z1) {
  const out = new Set();
  for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
    for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) for (const item of map.get(cellKey(cx, cz)) || []) out.add(item);
  }
  return out;
}

const orient = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
/** Whether the segment p-q touches the triangle ring (wound as areaOf() counts positive, so each of its sides has it on the same side) */
function segmentMeets(p, q, ring) {
  const side = (a, b, s) => (b.z - a.z) * (s.x - a.x) - (b.x - a.x) * (s.z - a.z);
  const inside = (s) => ring.every((a, i) => side(a, ring[(i + 1) % 3], s) >= -1e-9);
  if (inside(p) || inside(q)) return true;
  for (let i = 0; i < 3; i++) {
    const a = ring[i], b = ring[(i + 1) % 3];
    const d1 = orient(p, q, a), d2 = orient(p, q, b), d3 = orient(a, b, p), d4 = orient(a, b, q);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0) || Math.abs(d1) < 1e-9 || Math.abs(d2) < 1e-9)
      && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0) || Math.abs(d3) < 1e-9 || Math.abs(d4) < 1e-9)) return true;
  }
  return false;
}
function insideRings(rings, x, z) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i], b = r[j];
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
    }
  }
  return inside;
}

/**
 * A polygon with holes (`rings`, each [{ x, z }, ...]) laid on triangles, `lift` over them. A surface triangle it covers whole is laid as it
 * is, one triangle; one its edge crosses is cut to it, a piece of each of the polygon's own triangles over it. So a big polygon over a
 * coarse surface (a park's lawn over the map's) costs about the surface's triangles and its own edge's, not the two multiplied.
 */
function drapePolygon(rings, tris, lift, out, ox, oz) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of rings[0]) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  const edges = new Map();
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      addToCells(edges, Math.min(p.x, q.x), Math.min(p.z, q.z), Math.max(p.x, q.x), Math.max(p.z, q.z), [p, q]);
    }
  }
  let own = null; // its triangles, found by cell, made the first time a surface triangle is cut
  let n = 0;
  for (const t of tris) {
    const [a, b, c] = t;
    const tx0 = Math.min(a[0], b[0], c[0]), tx1 = Math.max(a[0], b[0], c[0]), tz0 = Math.min(a[2], b[2], c[2]), tz1 = Math.max(a[2], b[2], c[2]);
    if (tx1 < x0 || tx0 > x1 || tz1 < z0 || tz0 > z1) continue;
    const y = planeOf(t);
    if (!y) continue;
    const ring = asRing(t);
    let crossed = false;
    for (const [p, q] of inCells(edges, tx0, tz0, tx1, tz1)) {
      if (Math.max(p.x, q.x) < tx0 || Math.min(p.x, q.x) > tx1 || Math.max(p.z, q.z) < tz0 || Math.min(p.z, q.z) > tz1) continue;
      if (segmentMeets(p, q, ring)) { crossed = true; break; }
    }
    if (!crossed) {
      // Wholly in it or wholly out of it
      if (insideRings(rings, (ring[0].x + ring[1].x + ring[2].x) / 3, (ring[0].z + ring[1].z + ring[2].z) / 3)) n += fan(ring, y, lift, out, ox, oz);
      continue;
    }
    // Its outline cut to the triangle and laid there in one piece, its holes with it: as many triangles as it has corners in the
    // triangle and crossings of it, about
    const cut = cutTo(rings, ring);
    if (cut) {
      for (const f of cut) n += fan(f, y, lift, out, ox, oz);
      continue;
    }
    // ...or where that doesn't come out whole (a hole across the triangle's edge, or a cut its triangulation got wrong): a piece of each of
    // its own triangles over it
    if (!own) {
      own = new Map();
      for (const f of triangulate(rings)) {
        addToCells(own, Math.min(f[0].x, f[1].x, f[2].x), Math.min(f[0].z, f[1].z, f[2].z), Math.max(f[0].x, f[1].x, f[2].x), Math.max(f[0].z, f[1].z, f[2].z), areaOf(f) < 0 ? f.reverse() : f);
      }
    }
    for (const f of inCells(own, tx0, tz0, tx1, tz1)) {
      const poly = clipConvex(f, ring);
      if (poly.length >= 3) n += fan(poly, y, lift, out, ox, oz);
    }
  }
  return n;
}

/**
 * The part of a polygon with holes (`rings`) in a convex triangle (`tri`, wound as areaOf() counts positive), as triangles: its outline cut
 * to the triangle, with the holes wholly in it. Null if a hole crosses the triangle's edge, or the triangles don't come to the cut's area.
 */
function cutTo(rings, tri) {
  const holes = [];
  for (const h of rings.slice(1)) {
    const inside = h.map((p) => tri.every((a, i) => { const b = tri[(i + 1) % 3]; return (b.z - a.z) * (p.x - a.x) - (b.x - a.x) * (p.z - a.z) >= 0; }));
    if (inside.every(Boolean)) holes.push(h);
    else if (h.some((p, i) => segmentMeets(p, h[(i + 1) % h.length], tri))) return null;
    // Wholly outside the triangle, or round it
    else if (insideRings([h], (tri[0].x + tri[1].x + tri[2].x) / 3, (tri[0].z + tri[1].z + tri[2].z) / 3)) return [];
  }
  const outline = clipConvex(rings[0], tri).filter((p, i, a) => { const q = a[(i + 1) % a.length]; return Math.abs(p.x - q.x) > 1e-7 || Math.abs(p.z - q.z) > 1e-7; });
  if (outline.length < 3) return [];
  const want = Math.abs(areaOf(outline)) - holes.reduce((t, h) => t + Math.abs(areaOf(h)), 0);
  if (want < 1e-6) return [];
  const faces = triangulate([outline, ...holes]).filter((f) => Math.abs(areaOf(f)) > 1e-6);
  const got = faces.reduce((t, f) => t + Math.abs(areaOf(f)), 0);
  return Math.abs(got - want) <= Math.max(1e-4, want * 0.002) ? faces : null;
}

export { areaOf, clipConvex, convex, cutTo, drape, drapePolygon, planeOf, triangulate };
