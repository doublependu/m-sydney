import { ShapeUtils, Vector2 } from 'three/webgpu';
import { GEO, heldTiles, onMap } from './geodata.js';
import { landAt, blockAt } from './city-config.js';
import { LINKS, STEP, groundHeight, groundRoadAt, offsetLine, roadHeight, surfaceHeight } from './surfaces.js';
import { groundMoved } from './terrain.js';

// The ground's geometry as plain arrays: the road deck, kerbs, footpaths, lawns and the base under them all.
// js/city-grid.js turns it into meshes; tools/check-ground.mjs measures it without a browser, so what it reports is
// what the game draws.
//
// Every piece samples one height, groundHeight() (js/surfaces.js), at points close enough together that pieces meeting
// at a kerb agree: the ground is bilinear over 20 m cells, so a straight edge sampled every 8 m strays from it by a few
// centimetres at most, where one sampled every 20 m strayed by up to half a metre on a hill.

const SIDEWALK_TOP = 0.22;
const CAR_FLOOR = 0.2; // m a car's floor stands over the plane its wheels touch
// Surface to surface where one road crosses over another: 5.3 m of headroom and 1.5 m of deck
const STACK_CLEARANCE = 6.8;
const ROAD_STEP = 6; // m between stations down a road
const UNDER_KERB = 1.1; // m past a road's edge that its surface runs on, under the kerbs: they stand 0.4 m past it, give or take (tools/build-geodata.mjs)
const EDGE_STEP = 8; // m between points round a kerb or the edge of a footpath
const BASE_DROP = 0.5; // m the base lies under the lowest ground around it
const { x0: HX0, z0: HZ0, cell: HCELL } = GEO.frame.heights;

// Ground geometry is built in square cells of the city that can be culled on their own
const GROUND_CELL = 700;
class GroundCells {
  // `size`: of its cells. A tile's ground is one cell: the tile is what gets culled
  constructor(size = GROUND_CELL) {
    this.size = size;
    this.cells = new Map();
  }

  cell(x, z) {
    const key = Math.floor(x / this.size) * 100000 + Math.floor(z / this.size);
    let c = this.cells.get(key);
    if (!c) this.cells.set(key, (c = { position: [], normal: [], uv: [], index: [] }));
    return c;
  }

  vertex(c, x, y, z, nx, ny, nz) {
    c.position.push(x, y, z);
    c.normal.push(nx, ny, nz);
    c.uv.push(x, -z);
    return c.position.length / 3 - 1;
  }

  get vertexCount() {
    let n = 0;
    for (const c of this.cells.values()) n += c.position.length / 3;
    return n;
  }
}

function pointInPolygonXZ(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

// A ring with extra points, so no edge is longer than `edge`
function denseRing(ring, edge) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / edge));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  return out;
}

const distanceToRing = (ring, x, z) => {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(a.x + dx * t - x, a.z + dz * t - z));
  }
  return best;
};

// Triangles over a polygon's points. Ear clipping alone isn't enough for ground that isn't flat: it silently drops any
// point on a straight edge and many of the points inside, and makes long thin triangles, up to the width of a park, that
// cut under every rise and leave the surface metres below where things stand on it. So ear clipping does the outline, and
// this adds the points it dropped, keeping to the Delaunay triangulation by Lawson's flips: a point joins its neighbours,
// not whichever far corner the ears ended on. `faces` stay counter-clockwise in (x, y).
const FLAT = 1e-5; // twice the area of a triangle too thin to count: a point this close to an edge is on it
const NEEDLESS = 0.12; // m: a point inside that the triangles already pass this close to isn't worth adding
const BENT = 0.15; // m the ground has been moved to meet a road (tools/tiles/grade-ground.mjs), for it to be worth more points
class SurfaceMesh {
  constructor(points, heights, faces) {
    this.points = points;
    this.heights = heights;
    this.faces = faces;
    this.edges = new Map();
    this.used = new Uint8Array(points.length);
    this.last = 0;
    for (const f of faces) {
      if (this.orient(f[0], f[1], f[2]) < 0) { const t = f[1]; f[1] = f[2]; f[2] = t; }
      for (const v of f) this.used[v] = 1;
    }
    faces.forEach((f, i) => { this.link(f[0], f[1], i); this.link(f[1], f[2], i); this.link(f[2], f[0], i); });
    this.settle(faces.flatMap((f) => [[f[0], f[1]], [f[1], f[2]], [f[2], f[0]]]));
  }

  key(a, b) { return a < b ? a * 67108864 + b : b * 67108864 + a; }

  orient(a, b, d) {
    const P = this.points;
    return (P[b].x - P[a].x) * (P[d].y - P[a].y) - (P[b].y - P[a].y) * (P[d].x - P[a].x);
  }

  link(a, b, i) {
    const k = this.key(a, b), e = this.edges.get(k);
    if (e) e.push(i);
    else this.edges.set(k, [i]);
  }

  unlink(a, b, i) {
    const e = this.edges.get(this.key(a, b));
    e.splice(e.indexOf(i), 1);
  }

  setFace(i, a, b, d) {
    if (i === this.faces.length) this.faces.push(null);
    this.faces[i] = [a, b, d];
    this.link(a, b, i); this.link(b, d, i); this.link(d, a, i);
  }

  clearFace(i) {
    const [a, b, d] = this.faces[i];
    this.unlink(a, b, i); this.unlink(b, d, i); this.unlink(d, a, i);
  }

  // Flips the edges in `stack`, and those around any that flip, until the triangles are Delaunay. An edge of the polygon
  // or a hole has only one face, so it never flips.
  settle(stack) {
    const P = this.points;
    let budget = stack.length * 40 + 200;
    while (stack.length && budget-- > 0) {
      const [a, b] = stack.pop();
      const pair = this.edges.get(this.key(a, b));
      if (!pair || pair.length !== 2) continue;
      const [i, j] = pair;
      const fi = this.faces[i], fj = this.faces[j];
      const p = fi[0] !== a && fi[0] !== b ? fi[0] : fi[1] !== a && fi[1] !== b ? fi[1] : fi[2];
      const q = fj[0] !== a && fj[0] !== b ? fj[0] : fj[1] !== a && fj[1] !== b ? fj[1] : fj[2];
      if (p === q) continue;
      // The edge the way the first face runs it: u, v, p counter-clockwise
      const forward = (fi[0] === a && fi[1] === b) || (fi[1] === a && fi[2] === b) || (fi[2] === a && fi[0] === b);
      const u = forward ? a : b, v = forward ? b : a;
      // q inside the circle through u, v, p?
      const ax = P[u].x - P[q].x, ay = P[u].y - P[q].y, bx = P[v].x - P[q].x, by = P[v].y - P[q].y, cx = P[p].x - P[q].x, cy = P[p].y - P[q].y;
      if ((ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay) <= 1e-6) continue;
      // Only across a convex quadrilateral, so that both new triangles keep their area
      if (this.orient(p, u, q) <= FLAT || this.orient(q, v, p) <= FLAT) continue;
      this.clearFace(i);
      this.clearFace(j);
      this.setFace(i, p, u, q);
      this.setFace(j, q, v, p);
      stack.push([p, u], [u, q], [q, v], [v, p]);
    }
  }

  // The face over point i: walking towards it from the last one found, or looking through them all where a hole's in the way
  locate(i) {
    const inside = (f) => this.orient(f[0], f[1], i) >= -FLAT && this.orient(f[1], f[2], i) >= -FLAT && this.orient(f[2], f[0], i) >= -FLAT;
    let at = Math.min(this.last, this.faces.length - 1);
    for (let steps = 0; steps < 200; steps++) {
      const f = this.faces[at];
      let a = -1, b = -1;
      if (this.orient(f[0], f[1], i) < -FLAT) { a = f[0]; b = f[1]; }
      else if (this.orient(f[1], f[2], i) < -FLAT) { a = f[1]; b = f[2]; }
      else if (this.orient(f[2], f[0], i) < -FLAT) { a = f[2]; b = f[0]; }
      else return (this.last = at);
      const pair = this.edges.get(this.key(a, b));
      if (pair.length !== 2) break;
      at = pair[0] === at ? pair[1] : pair[0];
    }
    for (let k = 0; k < this.faces.length; k++) if (inside(this.faces[k])) return (this.last = k);
    return -1;
  }

  // Adds point i where it falls; one inside only if the ground there is far enough from the triangle over it
  add(i, always) {
    if (!this.faces.length) return;
    const at = this.locate(i);
    if (at < 0) return;
    const [a, b, d] = this.faces[at];
    const oa = this.orient(b, d, i), ob = this.orient(d, a, i), od = this.orient(a, b, i), whole = oa + ob + od;
    if (!always && whole > 0) {
      const H = this.heights;
      if (Math.abs((H[a] * oa + H[b] * ob + H[d] * od) / whole - H[i]) < NEEDLESS) return;
    }
    this.used[i] = 1;
    // On an edge, it splits the triangles either side of it; otherwise, the one it's in
    const onEdge = od <= FLAT ? [a, b, d] : oa <= FLAT ? [b, d, a] : ob <= FLAT ? [d, a, b] : null;
    if (onEdge) {
      const [u, v, w] = onEdge;
      const pair = this.edges.get(this.key(u, v));
      const other = pair.length === 2 ? (pair[0] === at ? pair[1] : pair[0]) : -1;
      const x = other >= 0 ? this.faces[other].find((n) => n !== u && n !== v) : -1;
      this.clearFace(at);
      if (other >= 0) this.clearFace(other);
      this.setFace(at, u, i, w);
      this.setFace(this.faces.length, i, v, w);
      const stack = [[v, w], [w, u]];
      if (other >= 0) {
        this.setFace(other, v, i, x);
        this.setFace(this.faces.length, i, u, x);
        stack.push([u, x], [x, v]);
      }
      this.settle(stack);
      return;
    }
    this.clearFace(at);
    this.setFace(at, a, b, i);
    this.setFace(this.faces.length, b, d, i);
    this.setFace(this.faces.length, d, a, i);
    this.settle([[a, b], [b, d], [d, a]]);
  }
}

// A polygon laid on the ground, `y` above it: points every EDGE_STEP round its edges, and inside on the height grid's
// own nodes, so the triangles between them hold the ground's shape
function addSurface(cells, rings, y, edge = EDGE_STEP) {
  const [outer, ...holes] = rings;
  const contour = denseRing(outer, edge);
  const denseHoles = holes.map((h) => denseRing(h, edge));
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of contour) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  // Points inside, on the height grid's nodes: and half way between them where the ground has been moved to meet a road, as it bends there
  const inner = [];
  const fine = HCELL / 2;
  for (let x = HX0 + Math.ceil((minX - HX0) / fine) * fine; x < maxX; x += fine) {
    for (let z = HZ0 + Math.ceil((minZ - HZ0) / fine) * fine; z < maxZ; z += fine) {
      const onGrid = (x - HX0) % HCELL === 0 && (z - HZ0) % HCELL === 0;
      if (!onGrid && Math.abs(groundMoved(x, z)) < BENT) continue;
      if (!pointInPolygonXZ(outer, x, z) || holes.some((h) => pointInPolygonXZ(h, x, z))) continue;
      // Not right against an edge, where it would only make slivers
      if (distanceToRing(outer, x, z) < 2 || holes.some((h) => distanceToRing(h, x, z) < 2)) continue;
      inner.push(new Vector2(x, z));
    }
  }
  const v2 = (p) => new Vector2(p.x, p.z);
  const shapeContour = contour.map(v2);
  const shapeHoles = denseHoles.map((h) => h.map(v2));
  const edgePoints = [...shapeContour, ...shapeHoles.flat()];
  const points = [...edgePoints, ...inner];
  const heights = points.map((p) => groundHeight(p.x, p.y));
  const mesh = new SurfaceMesh(points, heights, ShapeUtils.triangulateShape(shapeContour, shapeHoles));
  // Every point on an edge, so that it follows the ground as its neighbour does on the other side of it; inside, where it counts
  for (let i = 0; i < edgePoints.length; i++) if (!mesh.used[i]) mesh.add(i, true);
  for (let i = edgePoints.length; i < points.length; i++) mesh.add(i, false);
  const c = cells.cell((minX + maxX) / 2, (minZ + maxZ) / 2);
  const index = new Int32Array(points.length).fill(-1);
  for (const f of mesh.faces) {
    for (const v of f) if (index[v] < 0) index[v] = cells.vertex(c, points[v].x, y + heights[v], points[v].y, 0, 1, 0);
    // Up: counter-clockwise from above, with z pointing south
    c.index.push(index[f[0]], index[f[2]], index[f[1]]);
  }
}

// The kerb's wall at a point of its ring: from under the road up to the footpath's top
function kerbFootAt(x, z) {
  const y = groundHeight(x, z);
  return { foot: y - 0.3, top: y + SIDEWALK_TOP + 0.01 };
}

// The generators cut an island too big for one of their regions along that region's edge, like a national park (tools/geodata/regions.mjs):
// there's no road there, and no kerb
const REGION = 7200;
const nearRegionLine = (v) => Math.abs(v - Math.round(v / REGION) * REGION) < 1.5;
const onSeam = (a, b) => (nearRegionLine(a.x) && nearRegionLine(b.x)) || (nearRegionLine(a.z) && nearRegionLine(b.z));

// The points a kerb is drawn through, round a ring, with straight lines between: tools/check-ground.mjs measures the same. Every
// EDGE_STEP, and closer where the ground bends between two of them, as where a road drops into a cutting: a straight kerb across
// that would leave the ground and stand in the air.
const KERB_FIT = 0.15; // m the ground may stray from a straight kerb
const KERB_MIN = 1; // m: no closer than this
function kerbRing(ring) {
  const pts = denseRing(ring, EDGE_STEP);
  const out = [];
  const between = (a, ya, b, yb, depth) => {
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < KERB_MIN * 2 || depth > 4) return;
    let worst = 0;
    for (const f of [0.25, 0.5, 0.75]) {
      const y = groundHeight(a.x + (b.x - a.x) * f, a.z + (b.z - a.z) * f);
      worst = Math.max(worst, Math.abs(y - (ya + (yb - ya) * f)));
    }
    if (worst <= KERB_FIT) return;
    const m = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const ym = groundHeight(m.x, m.z);
    between(a, ya, m, ym, depth + 1);
    out.push(m);
    between(m, ym, b, yb, depth + 1);
  };
  const ys = pts.map((p) => groundHeight(p.x, p.z));
  for (let i = 0; i < pts.length; i++) {
    out.push(pts[i]);
    const j = (i + 1) % pts.length;
    between(pts[i], ys[i], pts[j], ys[j], 0);
  }
  return out;
}

// A curb along a ring: a wall from under the road up to the kerb's top, and a ledge along the footpath's edge
function addCurb(cells, ring, ledge = 0.3) {
  const pts = kerbRing(ring);
  const n = pts.length;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += pts[j].x * pts[i].z - pts[i].x * pts[j].z;
  const side = area > 0 ? 1 : -1; // towards the inside of the ring
  const kerbs = pts.map((p) => kerbFootAt(p.x, p.z));
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    if (onSeam(a, b)) continue;
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
    const ix = (-dz / L) * side, iz = (dx / L) * side; // inward
    const ka = kerbs[i], kb = kerbs[(i + 1) % n];
    const c = cells.cell(a.x, a.z);
    const v0 = cells.vertex(c, a.x, ka.foot, a.z, -ix, 0, -iz);
    const v1 = cells.vertex(c, b.x, kb.foot, b.z, -ix, 0, -iz);
    const v2 = cells.vertex(c, a.x, ka.top, a.z, -ix, 0, -iz);
    const v3 = cells.vertex(c, b.x, kb.top, b.z, -ix, 0, -iz);
    const v4 = cells.vertex(c, a.x, ka.top, a.z, 0, 1, 0);
    const v5 = cells.vertex(c, b.x, kb.top, b.z, 0, 1, 0);
    const v6 = cells.vertex(c, a.x + ix * ledge, ka.top, a.z + iz * ledge, 0, 1, 0);
    const v7 = cells.vertex(c, b.x + ix * ledge, kb.top, b.z + iz * ledge, 0, 1, 0);
    if (side > 0) c.index.push(v0, v2, v1, v1, v2, v3, v4, v6, v5, v5, v6, v7);
    else c.index.push(v0, v1, v2, v1, v3, v2, v4, v5, v6, v5, v7, v6);
  }
}

// Every link of the road graph with a height at each point: { id, a, b, name, width, kind, sid, deck, pts: [{x, z, y}] }
let linksCache = null;
onMap({ addLink() { linksCache = null; }, removeLink() { linksCache = null; } });
function allLinks() {
  if (!linksCache) {
    linksCache = LINKS.map((l) => ({ ...l, pts: l.pts.map((p) => ({ x: p.x, z: p.z, y: Number.isFinite(p.y) ? p.y : groundHeight(p.x, p.z) })) }));
  }
  return linksCache;
}
const groundLinks = () => allLinks().filter((l) => !l.kind);

// The road surface: a ribbon down every street on the ground, capped at each junction by the circle the curbs were cut
// with. Roads off the ground (bridges, tunnels) are built by js/structures.js.
// `links`: the roads to look at, which must take in every road at any junction wanted. A tile's file has them.
function* addRoadDeck(cells, wanted, links = LINKS, fills = heldTiles().flatMap((t) => t.fills)) {
  const RG = GEO.roadGraph;
  const reach = new Map();
  const degree = new Map();
  for (const l of links) {
    if (l.kind) continue;
    const r = l.width / 2 + UNDER_KERB;
    for (const n of [l.a, l.b]) {
      reach.set(n, Math.max(reach.get(n) || 0, r));
      degree.set(n, (degree.get(n) || 0) + 1);
    }
  }
  for (const [n, count] of degree) if (count >= 3) reach.set(n, reach.get(n) + GEO.frame.corner);
  // Junctions down a cutting: their discs keep to the cutting's floor, never climbing faster than a road can. Each point
  // of a disc stands on the nearest of the roads that meet there.
  const inCut = new Set();
  for (const l of links) if (l.cut) inCut.add(l.a).add(l.b);
  const meeting = new Map();
  for (const l of links) {
    if (l.kind) continue;
    for (const n of [l.a, l.b]) {
      if (!meeting.has(n)) meeting.set(n, []);
      meeting.get(n).push(l);
    }
  }
  const junctionHeight = (n, x, z) => {
    let best = null, bd = Infinity;
    for (const l of meeting.get(n) || []) {
      for (let k = 1; k < l.pts.length; k++) {
        const a = l.pts[k - 1], b = l.pts[k];
        const dx = b.x - a.x, dz = b.z - a.z;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
        const d = Math.hypot(a.x + dx * t - x, a.z + dz * t - z);
        if (d < bd) { bd = d; best = l; }
      }
    }
    return best ? roadHeight(best, x, z) : groundHeight(x, z);
  };
  let work = 0;
  for (const l of links) {
    if (l.kind || !wanted(l.pts[0].x, l.pts[0].z)) continue;
    if (++work % 60 === 0) yield;
    const r = l.width / 2 + UNDER_KERB;
    const pts = [];
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const p = l.pts[i], q = l.pts[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / ROAD_STEP));
      for (let k = 0; k < n; k++) pts.push({ x: p.x + ((q.x - p.x) * k) / n, z: p.z + ((q.z - p.z) * k) / n });
    }
    pts.push(l.pts[l.pts.length - 1]);
    const left = offsetLine(pts, r), right = offsetLine(pts, -r);
    const c = cells.cell((pts[0].x + pts[pts.length - 1].x) / 2, (pts[0].z + pts[pts.length - 1].z) / 2);
    let previous = -1;
    for (let i = 0; i < pts.length; i++) {
      // Left edge, centre, right edge: each at the road's own height there, so it leans with the hill as its kerbs do
      const vl = cells.vertex(c, left[i].x, roadHeight(l, left[i].x, left[i].z), left[i].z, 0, 1, 0);
      cells.vertex(c, pts[i].x, roadHeight(l, pts[i].x, pts[i].z), pts[i].z, 0, 1, 0);
      cells.vertex(c, right[i].x, roadHeight(l, right[i].x, right[i].z), right[i].z, 0, 1, 0);
      if (previous >= 0) {
        c.index.push(previous, vl, previous + 1, previous + 1, vl, vl + 1);
        c.index.push(previous + 1, vl + 1, previous + 2, previous + 2, vl + 1, vl + 2);
      }
      previous = vl;
    }
  }
  for (const [i, nodeReach] of reach) {
    const x = RG.nodes[i * 2], z = RG.nodes[i * 2 + 1];
    if (!nodeReach || !wanted(x, z)) continue;
    if (++work % 60 === 0) yield;
    // From the junction's middle out through two rings, so all of it stands on the ground
    const c = cells.cell(x, z);
    const y0 = junctionHeight(i, x, z);
    const centre = cells.vertex(c, x, y0, z, 0, 1, 0);
    const R = 24;
    for (const f of [0.5, 1]) {
      for (let k = 0; k < R; k++) {
        const a = (k / R) * Math.PI * 2;
        const px = x + Math.cos(a) * nodeReach * f, pz = z + Math.sin(a) * nodeReach * f;
        const y = junctionHeight(i, px, pz);
        cells.vertex(c, px, inCut.has(i) ? Math.min(y, y0 + 0.08 * nodeReach * f) : y, pz, 0, 1, 0);
      }
    }
    const inner = centre + 1, outer = centre + 1 + R;
    for (let k = 0; k < R; k++) {
      const k1 = (k + 1) % R;
      c.index.push(centre, inner + k1, inner + k);
      c.index.push(inner + k, inner + k1, outer + k, outer + k, inner + k1, outer + k1);
    }
  }
  for (const flat of fills) {
    if (!wanted(flat[0], flat[1])) continue;
    if (++work % 60 === 0) yield;
    const ring = [];
    for (let i = 0; i < flat.length; i += 2) ring.push({ x: flat[i], z: flat[i + 1] });
    addSurface(cells, [ring], 0);
  }
}

// A plain dark ground under everything on land, so a seam anywhere above it shows ground and never the harbour. Each
// point lies BASE_DROP under the lowest ground around it, so it can't come up through the road.
// `box`: stay within it, to save looking at the whole map
function* addBase(cells, wanted, step = HCELL, box = null, under = null) {
  const { detail } = GEO.frame;
  let work = 0;
  // Each corner once: four cells share it, and these nine samples are most of what the base costs to build
  const lows = new Map();
  const low = (x, z) => {
    const key = x * 1e6 + z;
    let y = lows.get(key);
    if (y === undefined) {
      y = Infinity;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) y = Math.min(y, groundHeight(x + a * step * 0.5, z + b * step * 0.5));
      if (under) y = Math.min(y, under(x, z));
      y -= BASE_DROP;
      lows.set(key, y);
    }
    return y;
  };
  for (const whole of detail) {
    const r = box ? { x0: Math.max(whole.x0, box.x0), x1: Math.min(whole.x1, box.x1), z0: Math.max(whole.z0, box.z0), z1: Math.min(whole.z1, box.z1) } : whole;
    for (let x = Math.floor(r.x0 / step) * step; x < r.x1; x += step) {
      if (++work % 4 === 0) yield;
      for (let z = Math.floor(r.z0 / step) * step; z < r.z1; z += step) {
        if (!wanted(x + step / 2, z + step / 2)) continue;
        const corners = [[x, z], [x + step, z], [x + step, z + step], [x, z + step]];
        if (!corners.every(([px, pz]) => landAt(px, pz))) continue;
        const c = cells.cell(x, z);
        const v = corners.map(([px, pz]) => cells.vertex(c, px, low(px, pz), pz, 0, 1, 0));
        c.index.push(v[0], v[3], v[1], v[1], v[3], v[2]);
      }
    }
  }
}

// The road surface over the whole city, for measuring
function roadSurfaceMeshes() {
  const cells = new GroundCells();
  const job = addRoadDeck(cells, () => true);
  while (!job.next().done);
  return [...cells.cells.values()];
}

// Height under a wheel at (x, z) on surface `sid`: on the ground, the car's own road (`road`, where its middle is) or,
// off it, the ground, and a footpath's top on a kerb's island
function wheelGround(sid, x, z, road = null, near = null) {
  if (sid) return surfaceHeight(sid, x, z, near);
  if (blockAt(x, z)) return groundHeight(x, z) + SIDEWALK_TOP;
  return road ? roadHeight(road, x, z) : groundHeight(x, z);
}

// Where a car's four wheels touch, and the body's height, pitch and roll that put all four on the surface:
// { contacts: [{ x, z, y }], y, pitch, roll }. `near`: the height of the level it's on, where its structure has two
function wheelContacts(x, z, heading, sid = 0, near = null, track = 0.8, axle = 1.4) {
  const sin = Math.sin(heading), cos = Math.cos(heading);
  const road = sid ? null : groundRoadAt(x, z, near);
  const contacts = [];
  for (const [side, along] of [[-track, axle], [track, axle], [-track, -axle], [track, -axle]]) {
    const px = x + sin * along + cos * side, pz = z + cos * along - sin * side;
    const y = wheelGround(sid, px, pz, road, near);
    // A wheel over a drop too big to drive off, or against a rise too big to climb, is held at the car's level: the edge of
    // a cutting, a deck's parapet
    contacts.push({ x: px, z: pz, y: near !== null && Math.abs(y - near) >= STEP ? near : y });
  }
  const [fl, fr, rl, rr] = contacts.map((c) => c.y);
  // The body rests on the plane through the four, as near as a rigid car can: its middle at their mean. But not through the ground
  // under its middle: over a crest too sharp for its wheels (the top of a cutting's bank, where a tunnel's mouth meets it) it rests
  // on its floor there, beached, a wheel or two in the air. On a road's steepest change of grade the middle stands 0.14 m over the mean
  let y = (fl + fr + rl + rr) / 4;
  const middle = wheelGround(sid, x, z, road, near);
  if (middle - y > CAR_FLOOR && (near === null || Math.abs(middle - near) < STEP)) y = middle - CAR_FLOOR;
  const pitch = Math.atan2((fl + fr - rl - rr) / 2, axle * 2);
  const roll = Math.atan2((fr + rr - fl - rl) / 2, track * 2);
  return { contacts, y, pitch, roll };
}

export {
  GroundCells, SIDEWALK_TOP, STACK_CLEARANCE, addBase, addCurb, addRoadDeck, addSurface, allLinks, denseRing, kerbRing,
  groundLinks, kerbFootAt, offsetLine, pointInPolygonXZ, roadSurfaceMeshes, wheelContacts, wheelGround
};
