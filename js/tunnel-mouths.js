import * as THREE from 'three/webgpu';
import { positionWorld, texture, uniform } from 'three/tsl';
import { GEO, onMap } from './geodata.js';
import { landAt } from './city-config.js';
import { baseHeight } from './ground-geometry.js';
import { KIND, PORTALS, TUNNEL_HEIGHT, groundHeight, groundRoadAt, linksAt, roadHeight, tunnelAtPortal } from './surfaces.js';
import { originXZ } from './world-origin.js';

// The ground at a tunnel's mouth. The ground is a lattice of points metres apart (the base under it 20 m apart): between the cutting's
// floor and the ground over the tube it can only slope, and that slope would close the mouth, rising across the tube from its road to its
// ceiling. So the ground's materials leave out whatever of them falls in a corridor at each mouth, along the road's own line and height
// and its width: over the open cutting, all of it between the walls up to a metre over their tops; past the cutting's end along the road
// it opens onto, REACH m of it, from just under the road (where the ground plan, which knows nothing of the tunnel, closes the road off
// with a kerb) up to the ceiling's height; and inside, up to just under the ceiling, as far in as the ground as drawn still climbs there.
// That reach is worked out from the base (js/ground-geometry.js baseHeight()), which lies under every other ground surface: once it has
// climbed out of sight, so has the rest. js/structures.js roofs the tube over the same reach, so from above you don't look into it.
//
// The corridors near the camera are drawn into a texture, half a metre a texel, each texel the heights between which the ground is left
// out there: one look-up a pixel however many mouths there are, and the corridor follows its road whatever its bends.
const REACH = 10; // m: the least a corridor reaches inside, and how far past the open cutting's end
const MAX_REACH = 40; // m inside, at most
const RAMP_TOP = TUNNEL_HEIGHT - 1.6; // m over the road: ground climbed higher is seen only from a camera higher still, which a tube's isn't
const MARGIN = 3; // m past where the ground has climbed out of sight
const OPEN_TOP = 30; // m over the road at most, over the open cutting: a metre over its walls' tops
const SIDE = 0.05; // m past the walls (a road's half width) that a corridor reaches
const CELL = 0.5; // m: a texel
const SIZE = 640; // texels across the texture: 320 m
const RECENTRE = 48; // m the camera moves from the texture's middle before it's drawn again round it
const UNIT = 0.05, BELOW = 200; // m: heights in the texture, in 16 bits from BELOW m under the survey's zero

// --- Each mouth's corridor ---------------------------------------------------------------------------------------------------------
function alongOf(l) {
  if (l.along) return l.along;
  const along = [0];
  for (let i = 1; i < l.pts.length; i++) along.push(along[i - 1] + Math.hypot(l.pts[i].x - l.pts[i - 1].x, l.pts[i].z - l.pts[i - 1].z));
  return (l.along = along);
}
function pointAt(l, along, s) {
  let i = 1;
  while (i < along.length - 1 && along[i] < s) i++;
  const a = l.pts[i - 1], b = l.pts[i], L = along[i] - along[i - 1];
  const t = L > 1e-6 ? Math.max(0, Math.min(1, (s - along[i - 1]) / L)) : 0;
  const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
  // A road on the ground has no heights of its own: its surface's
  const y = Number.isFinite(a.y) && Number.isFinite(b.y) ? a.y + (b.y - a.y) * t : roadHeight(l, x, z);
  return { x, z, y, l };
}
// The road from a point along a link, metre by metre, one way along it and on along the links after it at each node (those `next` accepts,
// the one heading most the same way), straight on past the last: [{ x, z, y, l }]
function walk(link, s, dir, length, next) {
  const out = [];
  let l = link, at = s, d = 0;
  for (let hop = 0; hop < 6 && d <= length; hop++) {
    const along = alongOf(l), total = along[along.length - 1];
    while (d <= length && at >= 0 && at <= total) {
      out.push(pointAt(l, along, at));
      at += dir;
      d++;
    }
    if (d > length || out.length < 2) break;
    const node = dir > 0 ? l.b : l.a;
    const end = out[out.length - 1], before = out[out.length - 2];
    const ux = end.x - before.x, uz = end.z - before.z, L = Math.hypot(ux, uz) || 1;
    let best = null;
    for (const o of linksAt(node)) {
      if (o === l || !next(o)) continue;
      const fromA = o.a === node, p = fromA ? o.pts[0] : o.pts[o.pts.length - 1], q = fromA ? o.pts[1] : o.pts[o.pts.length - 2];
      const M = Math.hypot(q.x - p.x, q.z - p.z) || 1;
      const turn = ((q.x - p.x) * ux + (q.z - p.z) * uz) / (M * L);
      if (turn > 0.5 && (!best || turn > best.turn)) best = { o, fromA, turn };
    }
    if (!best) break;
    const total2 = alongOf(best.o);
    l = best.o;
    dir = best.fromA ? 1 : -1;
    at = best.fromA ? 1 : total2[total2.length - 1] - 1;
  }
  while (out.length >= 2 && out.length <= length) {
    const a = out[out.length - 2], b = out[out.length - 1];
    out.push({ x: 2 * b.x - a.x, z: 2 * b.z - a.z, y: b.y, l: b.l });
  }
  return out;
}

// How far in from a portal the ground as drawn still climbs through the tube: the base's lowest across the tube, metre by metre in,
// under RAMP_TOP over the road, from the portal on with gaps of 3 m at most. Where the base isn't drawn (not on land), nothing is.
function rampReach(inside, half) {
  const corners = new Map(), land = new Map();
  const step = GEO.frame.heights.cell;
  const onLand = (x, z) => {
    const x0 = Math.floor(x / step) * step, z0 = Math.floor(z / step) * step, key = x0 * 1e6 + z0;
    let v = land.get(key);
    if (v === undefined) land.set(key, (v = landAt(x0, z0) && landAt(x0 + step, z0) && landAt(x0, z0 + step) && landAt(x0 + step, z0 + step)));
    return v;
  };
  let end = 0;
  for (let d = 1; d < inside.length - 1 && d <= MAX_REACH; d++) {
    const p = inside[d], q = inside[d + 1], L = Math.hypot(q.x - p.x, q.z - p.z) || 1, nx = -(q.z - p.z) / L, nz = (q.x - p.x) / L;
    let low = Infinity;
    for (let a = -half + 0.5; a <= half - 0.5; a += 1) {
      const x = p.x + nx * a, z = p.z + nz * a;
      if (onLand(x, z)) low = Math.min(low, baseHeight(x, z, corners) - p.y);
    }
    if (low < RAMP_TOP) end = d;
    else if (d - end > 3) break;
  }
  return Math.min(MAX_REACH, Math.max(REACH, end ? end + MARGIN : 0));
}

const q16 = (h, up) => Math.max(1, Math.min(65535, (up ? Math.ceil : Math.floor)((h + BELOW) / UNIT)));
// A corridor laid out on the texel grid: the texels it covers (each its column and row on the world's half-metre grid) and the heights
// between which it leaves the ground out in each, as 16-bit steps. `rows`: its middle line, each point with its half width and heights
function rasterize(rows) {
  const cells = new Map();
  for (let k = 0; k + 1 < rows.length; k++) {
    const a = rows[k], b = rows[k + 1], L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 1e-6) continue;
    const nx = -(b.z - a.z) / L, nz = (b.x - a.x) / L, steps = Math.max(1, Math.ceil(L / 0.35));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t, half = a.half + (b.half - a.half) * t;
      const lo = q16(a.bottom + (b.bottom - a.bottom) * t, false), hi = q16(a.top + (b.top - a.top) * t, true);
      const n = Math.max(1, Math.ceil((2 * half) / 0.35));
      for (let j = 0; j <= n; j++) {
        const off = -half + (2 * half * j) / n;
        const gi = Math.floor((x + nx * off) / CELL), gj = Math.floor((z + nz * off) / CELL), key = gi * 1048576 + gj;
        const c = cells.get(key);
        if (!c) cells.set(key, [gi, gj, lo, hi]);
        else { c[2] = Math.min(c[2], lo); c[3] = Math.max(c[3], hi); }
      }
    }
  }
  return cells;
}

// Whether a street on the ground crosses over an open cutting at its point r (heading (ux, uz)), well over its road: its carriageway at r or
// within 4 m along, anywhere across the cutting's width, and heading across it, not along its top beside it (as js/surfaces.js cutGround()
// tells a portal's top)
function overStreet(r, ux, uz, half) {
  for (const along of [-4, -2, 0, 2, 4]) {
    for (const across of [-half, 0, half]) {
      const x = r.x + ux * along - uz * across, z = r.z + uz * along + ux * across;
      const street = groundRoadAt(x, z);
      if (!street || roadHeight(street, x, z) < r.y + 3) continue;
      let best = Infinity, dot = 1;
      for (let i = 1; i < street.pts.length; i++) {
        const a = street.pts[i - 1], b = street.pts[i], dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2)), d = Math.hypot(a.x + dx * t - x, a.z + dz * t - z);
        if (d < best) { best = d; dot = Math.abs(dx * ux + dz * uz) / Math.sqrt(L2); }
      }
      if (dot < 0.87) return true;
    }
  }
  return false;
}

const shapes = new Map(); // `${link id}:${way in}` -> its corridor, once worked out (null: its tunnel isn't held)
const shapeKey = (p) => {
  const at = tunnelAtPortal(p);
  return at ? `${at.link.id}:${at.dir}` : null;
};
/**
 * A mouth's corridor, from a portal (a PORTALS entry, or one made the same way from its link): how far it reaches inside, and the texels
 * it covers. null if its tunnel isn't held.
 */
function mouthShape(p) {
  const at = tunnelAtPortal(p);
  if (!at) return null;
  const key = `${at.link.id}:${at.dir}`;
  let shape = shapes.get(key);
  if (shape) return shape;
  const half = at.link.half + SIDE;
  const inside = walk(at.link, at.s, at.dir, MAX_REACH + 2, (o) => o.kind === KIND.TUNNEL);
  const reach = rampReach(inside, at.link.half + 0.3);
  const outside = walk(at.link, at.s, -at.dir, p.open + REACH, () => true);
  // Inside, to the reach; over the open cutting, a metre over its walls' tops; past its end, along the road it opens onto
  const rows = [];
  for (let d = Math.min(reach + 1, inside.length - 1); d > 0; d--) {
    const r = inside[d];
    rows.push({ x: r.x, z: r.z, half, bottom: r.y - 2, top: r.y + TUNNEL_HEIGHT - 0.1 });
  }
  for (let d = 0; d < outside.length; d++) {
    const r = outside[d];
    if (d <= p.open + 1) {
      const n = outside[Math.min(outside.length - 1, d + 1)], m = outside[Math.max(0, d - 1)], L = Math.hypot(n.x - m.x, n.z - m.z) || 1;
      const ux = (n.x - m.x) / L, uz = (n.z - m.z) / L, out = at.link.half + 1.5;
      const wall = Math.max(groundHeight(r.x - uz * out, r.z + ux * out), groundHeight(r.x + uz * out, r.z - ux * out));
      // ...but under a street that crosses over it (at the portal, its top), only up to the ceiling's height: the street's footpaths stay
      const top = overStreet(r, ux, uz, half) ? TUNNEL_HEIGHT - 0.1 : Math.min(OPEN_TOP, Math.max(TUNNEL_HEIGHT - 0.1, wall - r.y + 1));
      rows.push({ x: r.x, z: r.z, half, bottom: r.y - 2, top: r.y + top });
    } else {
      rows.push({ x: r.x, z: r.z, half: (r.l?.half ?? at.link.half) + SIDE, bottom: r.y - 0.4, top: r.y + TUNNEL_HEIGHT - 0.1 });
    }
  }
  const cells = rasterize(rows);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const r of rows) { x0 = Math.min(x0, r.x); x1 = Math.max(x1, r.x); z0 = Math.min(z0, r.z); z1 = Math.max(z1, r.z); }
  shape = { reach, cells, box: { x0: x0 - 10, x1: x1 + 10, z0: z0 - 10, z1: z1 + 10 } };
  shapes.set(key, shape);
  return shape;
}
/** How far the corridor at a mouth reaches inside the tube: js/structures.js roofs the tube that far */
const mouthReach = (p) => mouthShape(p)?.reach ?? REACH;

/** A tunnel link's portal at its a end (or its b end), as the tiles' PORTALS have it (js/surfaces.js deriveTunnels()); null if it has none */
function portalOf(l, fromA) {
  const open = fromA ? l.openA : l.openB;
  if (!open || l.openA + l.openB >= l.length) return null;
  const pts = fromA ? l.pts : [...l.pts].reverse();
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i], L = Math.hypot(q.x - p.x, q.z - p.z);
    if (L < 1e-6) continue;
    if (s + L >= open) {
      const t = (open - s) / L, y = p.y + (q.y - p.y) * t;
      return { x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t, y, ux: (q.x - p.x) / L, uz: (q.z - p.z) / L, half: l.half + 0.3, open, rise: (y - pts[0].y) / open };
    }
    s += L;
  }
  return null;
}

/** Whether the corridor at mouth `p` leaves out ground at (x, y, z), as the texture does there (for tests and measures) */
function mouthHides(p, x, y, z) {
  const c = mouthShape(p)?.cells.get(Math.floor(x / CELL) * 1048576 + Math.floor(z / CELL));
  return !!c && y > c[2] * UNIT - BELOW && y < c[3] * UNIT - BELOW;
}

// --- In the ground's materials -------------------------------------------------------------------------------------------------------
// Each texel: the bottom and top heights in two bytes each (RGBA). 0 is no corridor: nothing is under BELOW m
const data = new Uint8Array(SIZE * SIZE * 4);
const corridors = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
corridors.magFilter = corridors.minFilter = THREE.NearestFilter;
corridors.generateMipmaps = false;
corridors.needsUpdate = true;
const corner = uniform(new THREE.Vector2(-1e7, -1e7)); // where the texture's first texel is, in the game's frame

/** True where a ground fragment is clear of every tunnel mouth's corridor: for a material's maskNode */
function outsideTunnelMouths() {
  const uv = positionWorld.xz.add(originXZ).sub(corner).div(SIZE * CELL);
  const t = texture(corridors, uv).level(0).mul(255).round();
  const bottom = t.x.mul(256).add(t.y).mul(UNIT).sub(BELOW), top = t.z.mul(256).add(t.w).mul(UNIT).sub(BELOW);
  const inside = uv.x.greaterThan(0).and(uv.x.lessThan(1)).and(uv.y.greaterThan(0)).and(uv.y.lessThan(1));
  return inside.and(positionWorld.y.greaterThan(bottom)).and(positionWorld.y.lessThan(top)).not();
}

/**
 * The corridors drawn round (x, z): again once it's moved RECENTRE m from the middle, or as tiles bring mouths or take them away. A
 * mouth's corridor is worked out the first time it's wanted, a few milliseconds' worth a frame (BUDGET), and the texture drawn again once
 * every one round it is ready
 */
const BUDGET = 3; // ms a frame
let midX = Infinity, midZ = Infinity, stale = true;
onMap({
  addTile(tile) { if (tile.portals?.length) stale = true; },
  removeTile(tile) { if (tile.portals?.length) stale = true; }
});
function updateTunnelMouths(x, z) {
  if (!stale && Math.abs(x - midX) < RECENTRE && Math.abs(z - midZ) < RECENTRE) return;
  const cx = Math.round(x / 16) * 16, cz = Math.round(z / 16) * 16;
  const gi0 = Math.round(cx / CELL) - SIZE / 2, gj0 = Math.round(cz / CELL) - SIZE / 2;
  const x0 = gi0 * CELL, z0 = gj0 * CELL, x1 = x0 + SIZE * CELL, z1 = z0 + SIZE * CELL;
  const near = PORTALS.filter((p) => p.x > x0 - 200 && p.x < x1 + 200 && p.z > z0 - 200 && p.z < z1 + 200);
  const started = performance.now();
  for (const p of near) {
    if (shapes.has(shapeKey(p))) continue;
    if (performance.now() - started > BUDGET) return; // the rest next frame
    mouthShape(p);
  }
  stale = false;
  midX = cx;
  midZ = cz;
  data.fill(0);
  for (const p of near) {
    const shape = mouthShape(p);
    if (!shape || shape.box.x1 < x0 || shape.box.x0 > x1 || shape.box.z1 < z0 || shape.box.z0 > z1) continue;
    for (const [gi, gj, lo, hi] of shape.cells.values()) {
      const i = gi - gi0, j = gj - gj0;
      if (i < 0 || j < 0 || i >= SIZE || j >= SIZE) continue;
      const k = (j * SIZE + i) * 4;
      const was = data[k] * 256 + data[k + 1];
      const bottom = was ? Math.min(was, lo) : lo, top = Math.max(data[k + 2] * 256 + data[k + 3], hi);
      data[k] = bottom >> 8; data[k + 1] = bottom & 255; data[k + 2] = top >> 8; data[k + 3] = top & 255;
    }
  }
  corner.value.set(x0, z0);
  corridors.needsUpdate = true;
}

export { mouthHides, mouthReach, mouthShape, outsideTunnelMouths, portalOf, updateTunnelMouths };
