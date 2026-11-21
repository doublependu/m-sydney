import * as THREE from 'three/webgpu';
import { decorationsOf, hashAt } from './christmas.js';
import { BULB, EFFECT, SPACING, christmasMaterials, lin } from './christmas-materials.js';

// The houses' Christmas decorations in December (js/season-december.js), on the lots near you (js/lot-details.js), which ones by
// js/christmas.js:
// - Bulbs: strings along the roof's eaves (the footprint grown by the eaves, at the roof's edge: up a gable's rake, along a flat roof's
//   parapet), icicles hanging off the front, along the front fence, wound round a tree in the yard, up the ridge and the hips; and the
//   outlines of wire reindeer on the lawn. Warm white or multicoloured by house; they twinkle, chase along a string or fade slowly, in
//   the shader. All of them are one mesh of small sprites added to what's behind them: a bulb, as big as one near and never less than a
//   pixel and a half far, and at night a halo round it, so a street far off reads as lines of light.
// - Shapes: a star on the roof, Santa in his sleigh on the ridge, an inflatable snowman or Santa on the lawn, a lit tree in the front
//   window, a wreath on the door: a few dozen triangles each, all in one mesh.
// - A light house has the eaves along its front and a wreath; a heavy one every string, three to six shapes, the yard full.
// - At night the bulbs glow with the night's glow (uInteriorGlow), as the windows do, and bloom spreads them; nothing casts light. By day
//   they're small coloured points and the shapes are what they are.
// - Drawn within the graphics level's houseDetail of you, nearest first, as many as the level has ROOM for, refilled as you move.
// - Their two materials are shared with the city's big trees (js/christmas-materials.js).

const DROP = 0.11; // m between an icicle's bulbs
const REFILL = 15; // m moved before what's drawn is chosen again
// Bulbs, and shapes' vertices (a few hundred a heavy house), each level has room for
const ROOM = { low: { bulbs: 6000, vertices: 12000 }, medium: { bulbs: 16000, vertices: 30000 }, high: { bulbs: 26000, vertices: 48000 } };
const WARM = [1.0, 0.7, 0.36];
const COOL = [0.75, 0.86, 1.0];
const MULTI = [[1.0, 0.09, 0.05], [0.1, 0.85, 0.18], [0.12, 0.3, 1.0], [1.0, 0.52, 0.06], [0.95, 0.16, 0.62]];
const YARD = 2.5; // m of front yard, at least, for anything to stand on it

// --- Shapes ------------------------------------------------------------------------------------------------------------------------
// Each made once, in its own frame: x to its right, y up, z towards whoever it faces. Triangles, each vertex its position, normal, colour
// and glow (how much it's lit from inside at night). `bulbs`: points on it that carry bulbs, in strings.

function shapeBuilder() {
  const pos = [], nor = [], col = [], glow = [];
  const push = (p, n, c, g) => { pos.push(...p); nor.push(...n); col.push(...c); glow.push(g); };
  const flat = (a, b, c, colour, g) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (const p of [a, b, c]) push(p, [nx, ny, nz], colour, g);
  };
  const quad = (a, b, c, d, colour, g) => { flat(a, b, c, colour, g); flat(a, c, d, colour, g); };
  return {
    flat,
    quad,
    /** A box from its middle and size */
    box(cx, cy, cz, sx, sy, sz, colour, g = 0) {
      const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
      quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], colour, g);
      quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], colour, g);
      quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], colour, g);
      quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], colour, g);
      quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], colour, g);
      quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], colour, g);
    },
    /** A ball of `sides` round and `rings` up, its normals smooth */
    ball(cx, cy, cz, r, colour, g = 0, sides = 7, rings = 4, sy = 1) {
      const at = (i, j) => {
        const th = (i / sides) * Math.PI * 2, ph = (j / rings) * Math.PI;
        const n = [Math.sin(ph) * Math.cos(th), -Math.cos(ph), Math.sin(ph) * Math.sin(th)];
        return { p: [cx + n[0] * r, cy + n[1] * r * sy, cz + n[2] * r], n };
      };
      for (let j = 0; j < rings; j++) {
        for (let i = 0; i < sides; i++) {
          const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
          if (j > 0) { push(a.p, a.n, colour, g); push(c.p, c.n, colour, g); push(b.p, b.n, colour, g); }
          if (j < rings - 1) { push(a.p, a.n, colour, g); push(d.p, d.n, colour, g); push(c.p, c.n, colour, g); }
        }
      }
    },
    /** A cone standing on (cx, cy, cz) */
    cone(cx, cy, cz, r, h, colour, g = 0, sides = 6) {
      for (let i = 0; i < sides; i++) {
        const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
        flat([cx + Math.cos(a0) * r, cy, cz + Math.sin(a0) * r], [cx, cy + h, cz], [cx + Math.cos(a1) * r, cy, cz + Math.sin(a1) * r], colour, g);
      }
    },
    /** A cylinder standing on (cx, cy, cz), with its top */
    cylinder(cx, cy, cz, r, h, colour, g = 0, sides = 6) {
      for (let i = 0; i < sides; i++) {
        const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
        const p0 = [cx + Math.cos(a0) * r, cy, cz + Math.sin(a0) * r], p1 = [cx + Math.cos(a1) * r, cy, cz + Math.sin(a1) * r];
        quad(p0, [p0[0], cy + h, p0[2]], [p1[0], cy + h, p1[2]], p1, colour, g);
        flat([p0[0], cy + h, p0[2]], [cx, cy + h, cz], [p1[0], cy + h, p1[2]], colour, g);
      }
    },
    /** A ring facing z: `segs` round, its tube `sides` round */
    torus(cx, cy, cz, R, r, colour, g = 0, segs = 8, sides = 3) {
      const at = (i, j) => {
        const a = (i / segs) * Math.PI * 2, b = (j / sides) * Math.PI * 2;
        const ring = [Math.cos(a), Math.sin(a)];
        const n = [ring[0] * Math.cos(b), ring[1] * Math.cos(b), Math.sin(b)];
        return { p: [cx + ring[0] * (R + r * Math.cos(b)), cy + ring[1] * (R + r * Math.cos(b)), cz + r * Math.sin(b)], n };
      };
      for (let i = 0; i < segs; i++) {
        for (let j = 0; j < sides; j++) {
          const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
          for (const v of [a, b, c, a, c, d]) push(v.p, v.n, colour, g);
        }
      }
    },
    done: (bulbs = []) => ({ pos: new Float32Array(pos), nor: new Float32Array(nor), col: new Float32Array(col), glow: new Float32Array(glow),
      vertices: pos.length / 3, bulbs })
  };
}

/** A polyline's points every `step` m, as [x, y, z] */
function along(points, step) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const n = Math.max(1, Math.round(L / step));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, a[2] + ((b[2] - a[2]) * k) / n]);
  }
  return out;
}

let shapes = null;
function makeShapes() {
  if (shapes) return shapes;
  const gold = lin(0xffcf4a), red = lin(0xc8241c), white = lin(0xf4f4f0), green = lin(0x1f6a2c), dark = lin(0x2a2a2c), skin = lin(0xe8b89a);
  // A star on a pole, its foot at the origin
  const star = shapeBuilder();
  {
    const pts = Array.from({ length: 10 }, (_, k) => {
      const a = Math.PI / 2 + (k * Math.PI) / 5, r = k % 2 ? 0.2 : 0.5;
      return [Math.cos(a) * r, 1.1 + Math.sin(a) * r];
    });
    for (let k = 0; k < 10; k++) {
      const p = pts[k], q = pts[(k + 1) % 10];
      star.flat([0, 1.1, 0.04], [p[0], p[1], 0.03], [q[0], q[1], 0.03], gold, 1);
      star.flat([0, 1.1, -0.04], [q[0], q[1], -0.03], [p[0], p[1], -0.03], gold, 1);
      star.quad([p[0], p[1], -0.03], [q[0], q[1], -0.03], [q[0], q[1], 0.03], [p[0], p[1], 0.03], gold, 1);
    }
    star.box(0, 0.3, 0, 0.05, 0.6, 0.05, dark);
  }
  // Santa in his sleigh, its runners on the origin, going along x
  const sleigh = shapeBuilder();
  {
    sleigh.box(0, 0.62, 0, 1.6, 0.5, 0.8, red, 0.08);
    sleigh.box(0.82, 0.78, 0, 0.16, 0.82, 0.8, red, 0.08);
    sleigh.box(-0.82, 0.92, 0, 0.12, 0.3, 0.8, red, 0.08);
    for (const z of [-0.36, 0.36]) {
      sleigh.box(0.05, 0.2, z, 1.9, 0.06, 0.06, gold);
      sleigh.box(-0.4, 0.31, z, 0.05, 0.2, 0.05, gold);
      sleigh.box(0.5, 0.31, z, 0.05, 0.2, 0.05, gold);
    }
    sleigh.box(-0.15, 1.15, 0, 0.5, 0.55, 0.5, red, 0.05);
    sleigh.ball(0, 1.58, 0, 0.17, skin, 0, 6, 4);
    sleigh.box(0.13, 1.5, 0, 0.12, 0.2, 0.24, white);
    sleigh.cone(-0.02, 1.68, 0, 0.17, 0.32, red, 0.05);
    sleigh.ball(-0.55, 1.05, 0, 0.3, lin(0x6b4a2a), 0, 6, 4);
    const rim = along([[-0.8, 0.88, -0.41], [0.8, 0.88, -0.41], [0.9, 1.2, -0.41]], 0.13)
      .concat(along([[-0.8, 0.88, 0.41], [0.8, 0.88, 0.41], [0.9, 1.2, 0.41]], 0.13));
    sleigh.rim = rim;
  }
  // An inflatable snowman, on the origin, lit from inside
  const snowman = shapeBuilder();
  {
    snowman.ball(0, 0.55, 0, 0.55, white, 0.22, 8, 5);
    snowman.ball(0, 1.32, 0, 0.4, white, 0.22, 8, 5);
    snowman.ball(0, 1.9, 0, 0.28, white, 0.22, 8, 4);
    snowman.box(0, 1.66, 0, 0.5, 0.1, 0.5, red, 0.3);
    snowman.cylinder(0, 2.12, 0, 0.21, 0.04, dark, 0, 7);
    snowman.cylinder(0, 2.15, 0, 0.14, 0.26, dark, 0, 7);
    snowman.cone(0, 1.92, 0.24, 0.04, 0.0001, lin(0xff7a1a), 0.3, 4);
    snowman.box(0, 1.93, 0.27, 0.05, 0.05, 0.14, lin(0xff7a1a), 0.3);
  }
  // An inflatable Santa, on the origin, lit from inside
  const santa = shapeBuilder();
  {
    santa.ball(0, 0.62, 0, 0.62, red, 0.4, 8, 5, 1.05);
    santa.box(0, 0.68, 0, 1.18, 0.14, 1.18, dark, 0.1);
    santa.ball(0, 1.52, 0, 0.32, skin, 0.25, 8, 4);
    santa.ball(0, 1.38, 0.16, 0.24, white, 0.22, 7, 4);
    santa.cone(0, 1.7, 0, 0.3, 0.5, red, 0.4, 7);
    santa.ball(0.05, 2.2, 0, 0.09, white, 0.22, 5, 3);
  }
  // A lit tree in a window, flat against the glass: its foot at the origin
  const tree = shapeBuilder();
  {
    for (const [y, w, h] of [[0.15, 0.9, 0.5], [0.45, 0.7, 0.45], [0.75, 0.48, 0.42]]) {
      tree.flat([-w / 2, y, 0], [w / 2, y, 0], [0, y + h, 0], green, 0.7);
    }
    tree.quad([-0.06, 0, 0], [0.06, 0, 0], [0.06, 0.15, 0], [-0.06, 0.15, 0], lin(0x5a3a1e), 0.4);
    tree.flat([-0.08, 1.12, 0.002], [0.08, 1.12, 0.002], [0, 1.26, 0.002], gold, 1);
    const dots = [];
    for (let k = 0; k < 22; k++) {
      const y = 0.22 + (k / 22) * 0.85, w = 0.42 * (1 - (y - 0.15) / 1.05);
      dots.push([Math.sin(k * 2.4) * w, y, 0.012]);
    }
    tree.dots = dots;
  }
  // A wreath on a door, facing out: its middle at the origin
  const wreath = shapeBuilder();
  {
    wreath.torus(0, 0, 0, 0.21, 0.065, lin(0x1d4d22), 0.12, 9, 3);
    wreath.flat([-0.1, -0.16, 0.07], [0, -0.21, 0.07], [-0.06, -0.3, 0.07], red, 0.2);
    wreath.flat([0.1, -0.16, 0.07], [0.06, -0.3, 0.07], [0, -0.21, 0.07], red, 0.2);
  }
  // A reindeer of wire and bulbs, head to +x, on the origin: only its bulbs
  const deer = [
    [[-0.45, 0, 0], [-0.47, 0.6, 0]], [[-0.33, 0, 0.06], [-0.36, 0.6, 0.06]], [[0.34, 0, 0], [0.36, 0.6, 0]], [[0.46, 0, 0.06], [0.44, 0.62, 0.06]],
    [[-0.56, 0.62, 0], [-0.5, 0.86, 0], [0, 0.92, 0], [0.46, 0.86, 0], [0.56, 0.66, 0], [0, 0.56, 0], [-0.56, 0.62, 0]],
    [[0.46, 0.86, 0], [0.62, 1.22, 0], [0.88, 1.16, 0], [0.82, 1.06, 0], [0.62, 1.1, 0]],
    [[0.62, 1.26, 0], [0.55, 1.58, 0], [0.66, 1.7, 0]], [[0.58, 1.42, 0], [0.43, 1.52, 0]], [[-0.56, 0.76, 0], [-0.66, 0.86, 0]]
  ].map((line) => along(line, 0.12));
  shapes = { star: star.done(), sleigh: { ...sleigh.done(), rim: sleigh.rim }, snowman: snowman.done(), santa: santa.done(),
    tree: { ...tree.done(), dots: tree.dots }, wreath: wreath.done(), deer };
  return shapes;
}

// --- One house's kit -------------------------------------------------------------------------------------------------------------

function inRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** A footprint's outer ring, clockwise in (x, z) as js/building-footprints.js has its walls, without a closing point */
function ringOf(polygon) {
  const ring = polygon.outer.map((p) => ({ x: p.x, z: p.z }));
  if (ring.length > 1 && ring[0].x === ring[ring.length - 1].x && ring[0].z === ring[ring.length - 1].z) ring.pop();
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
  if (area > 0) ring.reverse(); // THREE.ShapeUtils.isClockWise(): area < 0
  return ring;
}

/** The ring grown by `by`, each corner moved out along its walls' normals (js/building-footprints.js grown()) */
function grown(ring, by) {
  const n = ring.length, out = [];
  for (let i = 0; i < n; i++) {
    const p = ring[(i + n - 1) % n], q = ring[i], r = ring[(i + 1) % n];
    const l1 = Math.hypot(q.x - p.x, q.z - p.z) || 1, l2 = Math.hypot(r.x - q.x, r.z - q.z) || 1;
    const n1x = -(q.z - p.z) / l1, n1z = (q.x - p.x) / l1, n2x = -(r.z - q.z) / l2, n2z = (r.x - q.x) / l2;
    let mx = n1x + n2x, mz = n1z + n2z;
    const m = Math.hypot(mx, mz);
    if (m < 1e-6) { mx = n1x; mz = n1z; } else { mx /= m; mz /= m; }
    const cos = Math.max(0.5, mx * n1x + mz * n1z);
    out.push({ x: q.x + (mx * by) / cos, z: q.z + (mz * by) / cos });
  }
  return out;
}

/** A shape put down: (x, y, z) its origin, `yaw` turning its z to (sin yaw, cos yaw), `scale` */
function placed(shape, x, y, z, yaw, scale, out) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const { pos, nor } = shape;
  const at = out.v;
  out.pos.length = out.nor.length = (at + shape.vertices) * 3;
  for (let i = 0; i < shape.vertices; i++) {
    const lx = pos[i * 3] * scale, ly = pos[i * 3 + 1] * scale, lz = pos[i * 3 + 2] * scale;
    out.pos[(at + i) * 3] = x + lx * c + lz * s;
    out.pos[(at + i) * 3 + 1] = y + ly;
    out.pos[(at + i) * 3 + 2] = z - lx * s + lz * c;
    const nx = nor[i * 3], ny = nor[i * 3 + 1], nz = nor[i * 3 + 2];
    out.nor[(at + i) * 3] = nx * c + nz * s;
    out.nor[(at + i) * 3 + 1] = ny;
    out.nor[(at + i) * 3 + 2] = -nx * s + nz * c;
  }
  out.col.push(...shape.col);
  out.glow.push(...shape.glow);
  out.v += shape.vertices;
  out.shapes++;
}
const pointAt = (p, x, y, z, yaw, scale) => {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [x + (p[0] * c + p[2] * s) * scale, y + p[1] * scale, z + (-p[0] * s + p[2] * c) * scale];
};

/**
 * What one lot's decorated houses carry (`decos` from js/christmas.js decorationsOf()): { x, z, bulbs (x, y, z, s and r, g, b, look for
 * each), shapes (their vertices), n (bulbs), v (vertices), shapes count }, in the world. `env`:
 *   ground(x, z)          the top of what's drawn there
 *   look(b, whole)        js/building-look.js buildingLook(): a house's pitch, gabled, eaves
 *   roofFrame(ring, rec)  js/building-footprints.js roofFrame()
 *   entry(front, style)   js/house-entry.js houseEntry(): its door and bays
 *   trees(x, z, r)        the tree field's trees there, every kind: { x, y, z, crown, tall, small }
 *   fronts(lot)           its front fence's tops: [{ a: { x, z }, b: { x, z }, y }]
 */
function houseKit(lot, decos, env) {
  const kit = { x: lot.home.cx, z: lot.home.cz, bulbs: [], look: [], shapes: { pos: [], nor: [], col: [], glow: [], v: 0, shapes: 0 }, heavy: 0, light: 0 };
  const h = lot.home, f = lot.frame;
  const piece = h.pieces.find((b) => b.frontWall) || h.pieces.find((b) => !b.bottom) || h.pieces[0];
  if (!piece?.polygons?.length) return kit;
  const S = makeShapes();
  const ring = ringOf(piece.polygons[0]);
  if (ring.length < 3) return kit;
  const base = h.wallBase ?? (piece.floor ?? 0) + 0.22;
  const top = base + (h.wallHeight ?? piece.height ?? 3);
  let roof = null;
  if (piece.pitched && piece.polygons.length === 1 && !piece.polygons[0].holes?.length && !piece.bottom) {
    const whole = piece.group ? (h.tile?.wholes?.get?.(piece.group) ?? { cx: h.cx, cz: h.cz, height: piece.height }) : piece;
    const look = env.look(piece, whole);
    roof = env.roofFrame(ring.map((p) => ({ x: p.x, y: p.z })), { pitch: look.pitch, gabled: look.gabled, eaves: look.eaves });
  }
  const toStreet = { x: -f.nx, z: -f.nz };
  const facing = Math.atan2(toStreet.x, toStreet.z);
  const alongOf = (x, z) => (x - f.px) * f.tx + (z - f.pz) * f.tz;
  const depthOf = (x, z) => (x - f.px) * f.nx + (z - f.pz) * f.nz;
  const at = (a, d) => ({ x: f.px + f.tx * a + f.nx * d, z: f.pz + f.tz * a + f.nz * d });

  // The roof's edge: the footprint grown by its eaves, at the height its planes come down to there
  const eaves = roof ? roof.eaves : 0.04;
  const edge = grown(ring, eaves);
  const toRoof = (x, z) => ({ u: (x - roof.cx) * roof.ux + (z - roof.cy) * roof.uy, v: -(x - roof.cx) * roof.uy + (z - roof.cy) * roof.ux });
  const fromRoof = (u, v) => ({ x: roof.cx + u * roof.ux - v * roof.uy, z: roof.cy + u * roof.uy + v * roof.ux });
  const edgeAt = (x, z) => {
    if (!roof) return top + 0.03;
    const { u, v } = toRoof(x, z);
    const W = roof.W + roof.eaves, L = roof.L + roof.eaves;
    return top - roof.eaves * roof.tan + roof.tan * Math.max(0, Math.min(W - Math.abs(v), roof.gabled ? Infinity : L - Math.abs(u)));
  };
  // Each edge of the footprint, and whether it faces the street
  const edges = ring.map((p, i) => {
    const q = ring[(i + 1) % ring.length], L = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    const nx = -(q.z - p.z) / L, nz = (q.x - p.x) / L; // outward, the ring being clockwise
    return { a: edge[i], b: edge[(i + 1) % ring.length], front: nx * toStreet.x + nz * toStreet.z > 0.45, L };
  });

  for (const deco of decos) {
    const unit = deco.unit >= 0 ? lot.units?.[deco.unit] : null;
    const span = unit ? [Math.min(alongOf(unit.wall.ax, unit.wall.az), alongOf(unit.wall.bx, unit.wall.bz)),
      Math.max(alongOf(unit.wall.ax, unit.wall.az), alongOf(unit.wall.bx, unit.wall.bz))] : null;
    const inSpan = (x, z) => !span || (alongOf(x, z) >= span[0] - 0.05 && alongOf(x, z) <= span[1] + 0.05);
    // A house known for its lights has everything, and a net of them over its front wall
    const show = deco.why === 'house';
    const roll = (k) => hashAt(h.cx + deco.unit * 7.7, h.cz, 100 + k);
    const chance = (k, p) => show || roll(k) < p;
    const heavy = deco.heavy;
    if (heavy) kit.heavy++; else kit.light++;
    const multi = deco.multi;
    const effect = multi ? (deco.seed < 0.5 ? EFFECT.chase : deco.seed < 0.8 ? EFFECT.twinkle : EFFECT.alternate)
      : deco.seed < 0.6 ? EFFECT.steady : EFFECT.fade;
    const seed = Math.min(0.999, roll(0));
    const bulb = (p, s, rgb, fx = effect) => {
      kit.bulbs.push(p[0], p[1], p[2], s);
      kit.look.push(rgb[0], rgb[1], rgb[2], fx + seed);
    };
    const colourOf = (k) => (multi ? MULTI[k % MULTI.length] : WARM);
    /** Bulbs along a line of [x, y, z], the ones in this house's stretch */
    const string = (points, step = SPACING, fx = effect, colours = colourOf) => {
      let s = 0, k = 0, last = null;
      for (const p of along(points, step)) {
        if (last) s += Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]);
        last = p;
        if (!inSpan(p[0], p[2])) continue;
        bulb(p, s, colours(k++), fx);
      }
    };

    // The eaves: all round on a heavy house, along the front on a light one
    for (const e of edges) {
      if (!heavy && !e.front) continue;
      if (unit && !e.front) continue;
      const n = Math.max(1, Math.round(Math.hypot(e.b.x - e.a.x, e.b.z - e.a.z) / 1.5));
      const pts = [];
      for (let k = 0; k <= n; k++) {
        const x = e.a.x + ((e.b.x - e.a.x) * k) / n, z = e.a.z + ((e.b.z - e.a.z) * k) / n;
        pts.push([x, edgeAt(x, z) - 0.05, z]);
      }
      string(pts);
      // Icicles off the front's edge
      if (heavy && e.front && chance(1, 0.55)) {
        const L = Math.hypot(e.b.x - e.a.x, e.b.z - e.a.z), drops = Math.floor(L / 0.42);
        for (let k = 1; k < drops; k++) {
          const x = e.a.x + ((e.b.x - e.a.x) * k) / drops, z = e.a.z + ((e.b.z - e.a.z) * k) / drops;
          if (!inSpan(x, z)) continue;
          const y0 = edgeAt(x, z) - 0.1, n2 = 2 + Math.floor(hashAt(x, z, 5) * 4);
          for (let j = 0; j < n2; j++) bulb([x, y0 - j * DROP, z], j * DROP, multi ? COOL : WARM, EFFECT.twinkle);
        }
      }
    }

    // The ridge and the hips, on a heavy house's pitched roof
    const ridgeY = roof ? top + roof.tan * roof.W : 0;
    const ridgeHalf = roof ? (roof.gabled ? roof.L + roof.eaves : Math.max(0, roof.L - roof.W)) : 0;
    const roofCovers = (x, z) => inRing(edge, x, z);
    if (heavy && roof && !unit) {
      if (ridgeHalf > 0.4) {
        const a = fromRoof(-ridgeHalf, 0), b = fromRoof(ridgeHalf, 0);
        const pts = along([[a.x, ridgeY + 0.05, a.z], [b.x, ridgeY + 0.05, b.z]], SPACING).filter((p) => roofCovers(p[0], p[2]));
        if (pts.length > 1) string(pts);
      }
      if (!roof.gabled && ring.length === 4) {
        const W = roof.W + roof.eaves, L = roof.L + roof.eaves, low = top - roof.eaves * roof.tan;
        for (const su of [-1, 1]) {
          for (const sv of [-1, 1]) {
            const r0 = fromRoof(su * ridgeHalf, 0), c = fromRoof(su * L, sv * W);
            string([[r0.x, ridgeY + 0.05, r0.z], [c.x, low + 0.02, c.z]]);
          }
        }
      }
    }

    // The front fence
    if (heavy) {
      for (const seg of env.fronts(lot)) string([[seg.a.x, seg.y, seg.a.z], [seg.b.x, seg.y, seg.b.z]]);
    }

    // A tree in the yard, wound round
    if (heavy && !unit) {
      const trees = env.trees(h.cx, h.cz, 40).filter((t) => !t.small && t.tall > 3 && inRing(lot.pts, t.x, t.z) && !h.rings.some((r) => inRing(r, t.x, t.z)))
        .sort((p, q) => depthOf(p.x, p.z) - depthOf(q.x, q.z));
      const t = trees[0];
      if (t) {
        const yc = t.y + t.tall * 0.6, rv = t.tall * 0.38, rh = Math.max(0.6, t.crown * 0.85);
        const y0 = yc - rv * 0.85, y1 = yc + rv * 0.9, turns = Math.min(9, Math.max(3, (y1 - y0) / 0.7));
        const pts = [];
        for (let k = 0; k <= 300; k++) {
          const u = k / 300, y = y0 + (y1 - y0) * u, r = rh * Math.sqrt(Math.max(0.05, 1 - ((y - yc) / rv) ** 2)) + 0.12;
          const th = u * turns * Math.PI * 2 + seed * 6;
          pts.push([t.x + Math.cos(th) * r, y, t.z + Math.sin(th) * r]);
        }
        string(pts, 0.3, multi ? EFFECT.twinkle : effect);
      }
    }

    // A net of lights over the front wall, round its door
    const front0 = unit ? null : h.frontWall;
    if (show && front0) {
      const L = Math.hypot(front0.bx - front0.ax, front0.bz - front0.az) || 1;
      let nx = -(front0.bz - front0.az) / L, nz = (front0.bx - front0.ax) / L;
      if (nx * toStreet.x + nz * toStreet.z < 0) { nx = -nx; nz = -nz; }
      const doorAt = env.entry(front0, h.house)?.door;
      const rows = Math.floor((top - 0.35 - (base + 0.5)) / 0.3);
      const cols = Math.floor((L - 0.4) / 0.3);
      for (let j = 0; j <= rows; j++) {
        const y = top - 0.35 - j * 0.3;
        for (let i = 0; i <= cols; i++) {
          const t = (0.2 + i * 0.3) / L, x = front0.ax + (front0.bx - front0.ax) * t, z = front0.az + (front0.bz - front0.az) * t;
          if (doorAt && Math.hypot(x - doorAt.x, z - doorAt.z) < 0.75 && y < base + 2.4) continue;
          bulb([x + nx * 0.05, y, z + nz * 0.05], i * 0.3 + j * 0.15, multi ? MULTI[(i + j) % MULTI.length] : WARM, EFFECT.twinkle);
        }
      }
    }

    // --- Shapes ---
    const out = kit.shapes;
    // The wreath on the door
    const front = unit ? unit.wall : h.frontWall;
    const entry = !unit && h.frontWall ? env.entry(h.frontWall, h.house) : null;
    const door = unit ? unit.door : entry?.door;
    // Out from the front wall: whichever way faces the street
    let wallOut = null;
    if (front) {
      const L = Math.hypot(front.bx - front.ax, front.bz - front.az) || 1;
      let nx = -(front.bz - front.az) / L, nz = (front.bx - front.ax) / L;
      if (nx * toStreet.x + nz * toStreet.z < 0) { nx = -nx; nz = -nz; }
      wallOut = { x: nx, z: nz, yaw: Math.atan2(nx, nz) };
    }
    if (door && wallOut) placed(S.wreath, door.x + wallOut.x * 0.07, base + 1.62, door.z + wallOut.z * 0.07, wallOut.yaw, 1, out);
    if (!heavy) {
      continue;
    }
    // A lit tree in the front window
    if (wallOut && front && chance(2, 0.65)) {
      let w = null;
      if (unit && door) {
        // The other half of its stretch of the wall from its door
        const mx = (front.ax + front.bx) / 2, mz = (front.az + front.bz) / 2;
        const ux = (front.bx - front.ax) / front.width, uz = (front.bz - front.az) / front.width;
        const side = (door.x - mx) * ux + (door.z - mz) * uz > 0 ? -1 : 1;
        w = { x: mx + ux * side * front.width * 0.25, z: mz + uz * side * front.width * 0.25, width: front.width * 0.4 };
      } else if (entry && entry.bays >= 2) {
        // A bay with a window: not the door's, nor a garage's
        const pier = entry.door.s - (entry.doorBay + 0.5) * entry.bay;
        const free = [];
        for (let k = 0; k < entry.bays; k++) if (k !== entry.doorBay && k !== entry.garageBay && k !== entry.garageBay + 1) free.push(k);
        if (free.length) {
          const k = free[Math.floor(roll(3) * free.length) % free.length];
          const x0 = front.reverse ? front.bx : front.ax, z0 = front.reverse ? front.bz : front.az;
          const ux = ((front.reverse ? front.ax : front.bx) - x0) / front.width, uz = ((front.reverse ? front.az : front.bz) - z0) / front.width;
          const s = pier + (k + 0.5) * entry.bay;
          w = { x: x0 + ux * s, z: z0 + uz * s, width: entry.bay };
        }
      }
      if (w) {
        const scale = Math.min(1, Math.max(0.6, w.width / 1.3));
        const x = w.x + wallOut.x * 0.035, z = w.z + wallOut.z * 0.035, y = base + 0.78;
        placed(S.tree, x, y, z, wallOut.yaw, scale, out);
        S.tree.dots.forEach((p, k) => bulb(pointAt(p, x, y, z, wallOut.yaw, scale), k * 0.2, MULTI[k % MULTI.length], EFFECT.twinkle));
      }
    }
    if (unit) continue;
    // On the roof: a star over the ridge's middle; Santa and his sleigh along the ridge
    if (roof) {
      const mid = fromRoof(0, 0);
      if (roofCovers(mid.x, mid.z) && chance(4, 0.7)) placed(S.star, mid.x, ridgeY - 0.02, mid.z, facing, 1, out);
      if (ridgeHalf * 2 > 2.6 && chance(5, 0.45)) {
        const u = ridgeHalf * 0.5 * (roll(6) < 0.5 ? -1 : 1), p = fromRoof(u, 0);
        if (roofCovers(p.x, p.z)) {
          const yaw = Math.atan2(-roof.uy, roof.ux) + (roll(7) < 0.5 ? Math.PI : 0);
          const y = ridgeY - 0.18;
          placed(S.sleigh, p.x, y, p.z, yaw, 1, out);
          S.sleigh.rim.forEach((q, k) => bulb(pointAt(q, p.x, y, p.z, yaw, 1), k * 0.13, colourOf(k)));
        }
      }
    }
    // On the lawn: reindeer, and an inflatable
    const yard = (h.ext?.d0 ?? 0) - lot.front;
    if (yard >= YARD) {
      const d = lot.front + Math.min(yard * 0.55, yard - 1.2);
      const doorA = door ? alongOf(door.x, door.z) : null;
      const drive = lot.drive;
      const free = (a, half) => {
        if (drive && Math.abs(a - drive.a) < drive.w / 2 + half + 0.4) return false;
        if (doorA !== null && Math.abs(a - doorA) < half + 0.7) return false;
        const p = at(a, d);
        for (const o of [-half, 0, half]) {
          const q = at(a + o, d);
          if (!inRing(lot.pts, q.x, q.z) || h.rings.some((r) => inRing(r, q.x, q.z))) return false;
        }
        return !!p;
      };
      const a0 = (h.ext?.a0 ?? -4) + 0.6, a1 = (h.ext?.a1 ?? 4) - 0.6;
      const taken = [];
      const spot = (half) => {
        const tries = [];
        for (let a = a0 + half; a <= a1 - half; a += 0.5) tries.push(a);
        tries.sort((p, q) => hashAt(p, h.cz, 11) - hashAt(q, h.cz, 11));
        const a = tries.find((t) => free(t, half) && taken.every(([b, hb]) => Math.abs(t - b) > half + hb + 0.3));
        if (a === undefined) return null;
        taken.push([a, half]);
        return a;
      };
      if (chance(8, 0.55)) {
        const a = spot(0.75);
        if (a !== null) {
          const p = at(a, d), y = env.ground(p.x, p.z) - 0.03;
          placed(roll(9) < 0.5 ? S.snowman : S.santa, p.x, y, p.z, facing + (roll(10) - 0.5) * 0.6, 0.9 + roll(12) * 0.25, out);
        }
      }
      if (chance(13, 0.6)) {
        const herd = show ? 3 : 1 + Math.floor(roll(14) * 3);
        const a = spot(0.55 + (herd - 1) * 0.8);
        if (a !== null) {
          const yaw = Math.atan2(-f.tz, f.tx) + (roll(15) < 0.5 ? Math.PI : 0);
          for (let k = 0; k < herd; k++) {
            const p = at(a + (k - (herd - 1) / 2) * 1.6, d), y = env.ground(p.x, p.z);
            const scale = k === 0 ? 1 : 0.8;
            let s = 0;
            for (const line of S.deer) for (const q of line) bulb(pointAt(q, p.x, y, p.z, yaw, scale), (s += 0.12), roll(16) < 0.7 ? WARM : COOL, EFFECT.steady);
          }
        }
      }
    }
  }
  return kit;
}

/** A kit's arrays, typed, its positions written from (ox, oz) */
function bake(kit, ox, oz) {
  const n = kit.bulbs.length / 4, v = kit.shapes.v;
  const bulbs = new Float32Array(kit.bulbs), look = new Float32Array(kit.look);
  for (let i = 0; i < n; i++) { bulbs[i * 4] -= ox; bulbs[i * 4 + 2] -= oz; }
  const pos = new Float32Array(kit.shapes.pos);
  for (let i = 0; i < v; i++) { pos[i * 3] -= ox; pos[i * 3 + 2] -= oz; }
  return { x: kit.x, z: kit.z, n, v, ox, oz, bulbs, look, pos, nor: new Float32Array(kit.shapes.nor), col: new Float32Array(kit.shapes.col),
    glow: new Float32Array(kit.shapes.glow), shapes: kit.shapes.shapes, heavy: kit.heavy, light: kit.light };
}
/** Its positions written from the origin as it is now */
function rebase(baked, ox, oz) {
  const dx = baked.ox - ox, dz = baked.oz - oz;
  if (!dx && !dz) return;
  for (let i = 0; i < baked.n; i++) { baked.bulbs[i * 4] += dx; baked.bulbs[i * 4 + 2] += dz; }
  for (let i = 0; i < baked.v; i++) { baked.pos[i * 3] += dx; baked.pos[i * 3 + 2] += dz; }
  baked.ox = ox;
  baked.oz = oz;
}

// --- The houses near you ------------------------------------------------------------------------------------------------------------

/**
 * The decorations on the houses near you. `level`: the graphics level's name; `reach()`: m round you (houseDetail); `squares()`: the lots'
 * squares held (js/lot-details.js squares: [{ square, result }]); `lotsPending()`: whether the lots near you are still being worked out;
 * `env`: what houseKit() needs but fronts(), and `glow`, the night's glow
 * uniform; `prepare(x, z, r)`: one of the map's surfaces' triangles made there, true if it did one; `origin`, `anchor(object)` and
 * `reveal(group)` (a promise) as the season's ctx has them. `group` is revealed once there's a decorated house near to draw.
 */
function createChristmasHouses({ level = 'high', reach = () => 260, squares = () => [], lotsPending = () => false, env, prepare = () => false, origin, reveal,
  anchor }) {
  const room = ROOM[level] || ROOM.high;
  const group = new THREE.Group();
  group.name = 'ChristmasHouses';
  let bulbMesh = null, shapeMesh = null, materials = null;

  // Per square's result: its decorated lots, worked out a few at a time; and each lot's kit
  const done = new WeakMap(); // result -> { lots: [lot], next: index, kits: [baked], counted }
  let filledAt = null, changed = false, lastOrigin = { x: origin.x, z: origin.z };
  let drawn = { houses: 0, heavy: 0, bulbs: 0, vertices: 0, shapes: 0 };
  let decorated = 0;

  // The front fences of a square's lots: panels of a front kind (picket, palisade, wire) and the low walls and hedges, in cells
  const frontCells = new WeakMap();
  function frontsOf(result) {
    let cells = frontCells.get(result);
    if (cells) return cells;
    cells = new Map();
    const put = (seg) => {
      const k = Math.floor((seg.a.x + seg.b.x) / 40) * 100000 + Math.floor((seg.a.z + seg.b.z) / 40);
      (cells.get(k) || cells.set(k, []).get(k)).push(seg);
    };
    for (const p of result.panels) {
      if (p.kind < 2) continue;
      const hx = (p.ux * p.length) / 2, hz = (p.uz * p.length) / 2;
      put({ a: { x: p.x - hx, z: p.z - hz }, b: { x: p.x + hx, z: p.z + hz }, y: p.y + p.height + 0.03, ux: p.ux, uz: p.uz, mx: p.x, mz: p.z });
    }
    for (const b of result.things) {
      if (b.kind !== 1 && b.kind !== 2) continue;
      const L = Math.hypot(b.ax, b.az);
      if (L < 0.8 || b.small) continue;
      put({ a: { x: b.x - b.ax / 2, z: b.z - b.az / 2 }, b: { x: b.x + b.ax / 2, z: b.z + b.az / 2 }, y: b.y + b.h + 0.03, ux: b.ax / L, uz: b.az / L,
        mx: b.x, mz: b.z });
    }
    frontCells.set(result, cells);
    return cells;
  }
  const frontsFor = (result) => (lot) => {
    const cells = frontsOf(result), f = lot.frame, out = [];
    const cx = Math.floor(lot.home.cx / 20), cz = Math.floor(lot.home.cz / 20);
    for (let i = cx - 2; i <= cx + 2; i++) {
      for (let j = cz - 2; j <= cz + 2; j++) {
        for (const seg of cells.get(i * 100000 + j) || []) {
          if (Math.abs(seg.ux * f.tx + seg.uz * f.tz) < 0.85) continue;
          const depth = (seg.mx - f.px) * f.nx + (seg.mz - f.pz) * f.nz;
          if (depth < lot.front - 0.3 || depth > lot.front + 1.8) continue;
          if (!inRing(lot.pts, seg.mx + f.nx * 0.3, seg.mz + f.nz * 0.3) && !inRing(lot.pts, seg.mx, seg.mz)) continue;
          out.push(seg);
        }
      }
    }
    return out;
  };

  /** One step of work near (x, z): a square's lots decorated, the materials made, or what's drawn chosen again. Whether it did something. */
  function* work(x, z) {
    const r = reach();
    const held = squares();
    // A square's lots not yet looked at, the nearest first
    let next = null;
    for (const entry of held) {
      const state = done.get(entry.result);
      if (state && state.next >= state.lots.length) continue;
      const s = entry.square, d = Math.hypot(Math.max(s.x0 - x, 0, x - s.x1), Math.max(s.z0 - z, 0, z - s.z1));
      if (d > r) continue;
      if (!next || d < next.d) next = { entry, d };
    }
    if (next) {
      const result = next.entry.result;
      let state = done.get(result);
      if (!state) {
        // Which of its lots are decorated: the picking is cheap, the kits are not
        const lots = [];
        for (const lot of result.lots) {
          const decos = decorationsOf({ x: lot.home.cx, z: lot.home.cz, pts: lot.pts, units: lot.units ?? null, street: lot.home.street?.link });
          if (decos.length) lots.push({ lot, decos });
        }
        done.set(result, (state = { lots, next: 0, kits: [] }));
        decorated += lots.length;
        return true;
      }
      // A kit or two: the ground's triangles under a heavy one's yard first, one surface a step
      const began = performance.now();
      while (state.next < state.lots.length && performance.now() - began < 4) {
        const { lot, decos } = state.lots[state.next];
        if (decos.some((d) => d.heavy) && prepare(lot.home.cx, lot.home.cz, 25)) return true;
        const kit = houseKit(lot, decos, { ...env, fronts: frontsFor(result) });
        state.kits.push(bake(kit, origin.x, origin.z));
        state.next++;
      }
      changed = true;
      return true;
    }
    if (!bulbMesh && hasKits()) {
      yield* show();
      changed = true;
      return true;
    }
    const moved = origin.x !== lastOrigin.x || origin.z !== lastOrigin.z;
    if (bulbMesh && (changed || moved || !filledAt || Math.hypot(x - filledAt.x, z - filledAt.z) > REFILL)) {
      fill(x, z, r);
      return true;
    }
    return false;
  }
  const hasKits = () => squares().some((e) => (done.get(e.result)?.kits.length ?? 0) > 0);

  // The meshes, their materials compiled with one bulb and one triangle in them, out of sight
  function* show() {
    materials = christmasMaterials(env.glow);
    const quad = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = quad.index;
    geometry.setAttribute('position', quad.attributes.position);
    geometry.setAttribute('uv', quad.attributes.uv);
    geometry.setAttribute('normal', quad.attributes.normal);
    geometry.setAttribute('aBulb', new THREE.InstancedBufferAttribute(new Float32Array(room.bulbs * 4), 4));
    geometry.setAttribute('aLook', new THREE.InstancedBufferAttribute(new Float32Array(room.bulbs * 4), 4));
    geometry.instanceCount = 1;
    bulbMesh = new THREE.Mesh(geometry, materials.bulbs);
    bulbMesh.name = 'ChristmasBulbs';
    const shapeGeometry = new THREE.BufferGeometry();
    shapeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(room.vertices * 3), 3));
    shapeGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(room.vertices * 3), 3));
    shapeGeometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(room.vertices * 3), 3));
    shapeGeometry.setAttribute('aGlow', new THREE.Float32BufferAttribute(new Float32Array(room.vertices), 1));
    shapeGeometry.setDrawRange(0, 3);
    shapeMesh = new THREE.Mesh(shapeGeometry, materials.shapes);
    shapeMesh.name = 'ChristmasShapes';
    shapeMesh.castShadow = false;
    shapeMesh.receiveShadow = true;
    for (const mesh of [bulbMesh, shapeMesh]) {
      mesh.userData.lifted = true; // written where they stand
      mesh.frustumCulled = false; // what's in them is chosen near you
      group.add(mesh);
    }
    bulbMesh.castShadow = bulbMesh.receiveShadow = false;
    // Compiled with one bulb, deep under the ground, and one triangle of nothing
    geometry.attributes.aBulb.array[1] = -1000;
    yield;
    // Written from the origin, as the lots are (js/lot-details.js): anchored before it's revealed and again after
    anchor(group);
    yield reveal(group);
    anchor(group);
    group.updateMatrixWorld(true);
  }

  // What's drawn: the nearest decorated houses within r, as many as there's room for
  function fill(x, z, r) {
    filledAt = { x, z };
    changed = false;
    lastOrigin = { x: origin.x, z: origin.z };
    const near = [];
    for (const entry of squares()) {
      const state = done.get(entry.result);
      if (!state) continue;
      for (const kit of state.kits) {
        const d = Math.hypot(kit.x - x, kit.z - z);
        if (d <= r && (kit.n || kit.v)) near.push([d, kit]);
      }
    }
    near.sort((a, b) => a[0] - b[0]);
    const g = bulbMesh.geometry, aBulb = g.attributes.aBulb, aLook = g.attributes.aLook;
    const sg = shapeMesh.geometry, pos = sg.attributes.position, nor = sg.attributes.normal, col = sg.attributes.color, gl = sg.attributes.aGlow;
    let n = 0, v = 0, houses = 0, heavy = 0, shapes = 0;
    for (const [, kit] of near) {
      // A house whose bulbs don't fit is left out; one whose shapes don't has its bulbs only
      if (n + kit.n > room.bulbs) continue;
      rebase(kit, origin.x, origin.z);
      aBulb.array.set(kit.bulbs, n * 4);
      aLook.array.set(kit.look, n * 4);
      n += kit.n;
      if (kit.v && v + kit.v <= room.vertices) {
        pos.array.set(kit.pos, v * 3);
        nor.array.set(kit.nor, v * 3);
        col.array.set(kit.col, v * 3);
        gl.array.set(kit.glow, v);
        v += kit.v;
        shapes += kit.shapes;
      }
      houses += kit.heavy + kit.light;
      heavy += kit.heavy;
    }
    const upload = (attribute, count, size) => {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, Math.max(1, count) * size);
      attribute.needsUpdate = true;
    };
    upload(aBulb, n, 4);
    upload(aLook, n, 4);
    g.instanceCount = n;
    bulbMesh.visible = n > 0;
    for (const [attribute, size] of [[pos, 3], [nor, 3], [col, 3], [gl, 1]]) upload(attribute, v, size);
    sg.setDrawRange(0, v);
    shapeMesh.visible = v > 0;
    drawn = { houses, heavy, bulbs: n, vertices: v, shapes };
  }

  /** The decorated houses within r of (x, z), for the scripts: [{ x, z, heavy, light, bulbs, shapes }] */
  function list(x, z, r) {
    const out = [];
    for (const entry of squares()) {
      for (const kit of done.get(entry.result)?.kits ?? []) {
        if (Math.hypot(kit.x - x, kit.z - z) <= r) out.push({ x: Math.round(kit.x), z: Math.round(kit.z), heavy: kit.heavy, light: kit.light, bulbs: kit.n, shapes: kit.shapes });
      }
    }
    return out;
  }

  /**
   * For the scripts: each street's houses within r of (x, z) and how many are decorated, the most decorated first: [{ street, lots,
   * decorated, heavy, why }], and the 500 m squares by how many decorated houses they hold
   */
  function census(x, z, r) {
    const streets = new Map(), cells = new Map();
    for (const entry of squares()) {
      for (const lot of entry.result.lots) {
        if (Math.hypot(lot.home.cx - x, lot.home.cz - z) > r) continue;
        const link = lot.home.street?.link;
        const name = `${link?.name || '(no name)'}`;
        const s = streets.get(name) || streets.set(name, { street: name, lots: 0, decorated: 0, heavy: 0, why: {} }).get(name);
        s.lots++;
        const decos = decorationsOf({ x: lot.home.cx, z: lot.home.cz, pts: lot.pts, units: lot.units ?? null, street: link });
        for (const d of decos) {
          s.decorated++;
          if (d.heavy) s.heavy++;
          s.why[d.why] = (s.why[d.why] || 0) + 1;
        }
        if (decos.length) {
          const key = `${entry.square.x0},${entry.square.z0}`;
          cells.set(key, (cells.get(key) || 0) + decos.length);
        }
      }
    }
    return { streets: [...streets.values()].sort((a, b) => b.decorated - a.decorated || b.lots - a.lots),
      squares: [...cells].sort((a, b) => b[1] - a[1]) };
  }

  return {
    group,
    work,
    census,
    update(elapsed) { if (materials) materials.now.value = elapsed; },
    shown: () => !!bulbMesh,
    state: () => ({ decorated, drawn, at: filledAt && { x: Math.round(filledAt.x), z: Math.round(filledAt.z) },
      pending: squares().filter((e) => { const s = done.get(e.result); return !s || s.next < s.lots.length; }).length, lotsPending: !!lotsPending() }),
    list,
    clear() {
      bulbMesh?.geometry.dispose();
      shapeMesh?.geometry.dispose();
    }
  };
}

export { BULB, EFFECT, ROOM, createChristmasHouses, grown, houseKit, makeShapes, ringOf };
