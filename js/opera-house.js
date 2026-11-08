import * as THREE from 'three/webgpu';
import { color, float, fract, fwidth, mix, smoothstep, uv } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cityUniforms } from './tsl-materials.js';

// The Sydney Opera House. Its shells are drawn here, near and far; so is a plain version of its glass and podium, which a model of its
// own takes the place of near it (js/model-sites.js, 'opera-house'). The model's script asks this module for the shells, arches and
// glass (operaGeometry()), so both are made from OPERA_HOUSE below.
//
// Every shell is cut from a sphere of the same radius, Utzon's solution: two mirrored halves meeting along a ridge, where their two
// spheres meet. Each half has four corners: its tip and the far end of its ridge on the hall's centre line, the foot of its valley at the
// side, and its foot, the pedestal its ribs fan from, where its arch comes down. Its arch (tip to foot), valley (ridge's end to the
// valley's foot) and the edge along its side between them are great circles. Two shells back to back share a valley; a shell nested in
// front of a bigger one has its valley under the bigger one's arch, which a louvre wall closes down to it.
//   halls: each with its origin (the foot of its southern glass wall on its centre line) and yaw (the game's rotation.y: 0 runs north)
//   s: m along the hall from its origin, north; v: m across it, east; y: m above the harbour
//   tip, ridge: [s, y]; valley, foot: [s, v, y] (and their mirrors at -v)
//   louvre: the shell nested in front of this one (`to`), and how far in from the arch at its tip the louvre wall hangs (`back`)
//   walls: where the glass walls under the shells stand, round the hall, [s, v, floor]: up from the floor to the shells
// From the hall's long section, the side photos (heights) and OpenStreetMap's podium and halls (where), ref/opera_house/ in m-sydney-private.
const OPERA_HOUSE = {
  radius: 75.2,
  podium: 12.6,
  halls: [
    {
      id: 'concert', origin: [495.9, -1822.5], yaw: -0.083,
      shells: [
        { id: 'A1', tip: [-13, 39.2], ridge: [36, 32.8], valley: [38, 24, 15.5], foot: [6, 19.5, 13] },
        { id: 'A2', tip: [75, 67.2], ridge: [36, 32.8], valley: [38, 24, 15.5], foot: [62, 25, 14.5], louvre: { to: 'A3', back: 11 } },
        { id: 'A3', tip: [96, 56], ridge: [63, 45], valley: [61, 24.5, 15], foot: [84, 24, 16], louvre: { to: 'A4', back: 9 } },
        { id: 'A4', tip: [125, 44.6], ridge: [87, 39.5], valley: [83, 23.5, 16.5], foot: [116, 22, 18.8] }
      ],
      // OpenStreetMap's upper podium round its south end, the shells' sides, and its northern foyer's glass
      walls: [[104, -24.5, 12.6], [90, -24.5, 12.6], [75, -24.5, 12.6], [62, -24.3, 12.6], [52.6, -21.5, 12.6], [50.9, -20.9, 12.6],
        [38.7, -21.9, 12.6], [37.3, -20.5, 12.6], [29.6, -18.5, 12.6], [20.8, -14.9, 12.6], [14.3, -14.8, 12.6], [10, -11.7, 12.6],
        [3.9, -5.7, 12.6], [0, 0, 12.6], [6.6, 9.3, 12.6], [14.9, 15.5, 12.6], [21.4, 15.4, 12.6], [30.4, 18.6, 12.6], [38.2, 20.3, 12.6],
        [39.6, 21.6, 12.6], [51.7, 20.1, 12.6], [64, 24.1, 12.6], [75, 23.8, 12.6], [90, 23.6, 12.6], [104, 23.5, 12.6], [108.5, 21.5, 18.6],
        [113, 21.0, 18.6], [116.5, 20.0, 18.6], [118.5, 17.5, 18.6], [120.3, 13.0, 18.6], [121.5, 8.0, 18.6], [122, 0, 18.6],
        [121.5, -8.0, 18.6], [120.3, -13.0, 18.6], [118.5, -17.5, 18.6], [116.5, -20.0, 18.6], [113, -21.0, 18.6], [108.5, -21.5, 18.6],
        [104, -24.5, 12.6]]
    },
    {
      id: 'joan-sutherland', origin: [525.3, -1838.0], yaw: 0.28,
      shells: [
        { id: 'B1', tip: [-11, 36], ridge: [31, 30.4], valley: [32, 21, 15.2], foot: [5, 16.5, 13] },
        { id: 'B2', tip: [64, 60], ridge: [31, 30.4], valley: [32, 21, 15.2], foot: [52, 22, 14.2], louvre: { to: 'B3', back: 10 } },
        { id: 'B3', tip: [81, 50.8], ridge: [54, 41.5], valley: [51, 21.5, 14.6], foot: [70, 21, 15.2], louvre: { to: 'B4', back: 8 } },
        { id: 'B4', tip: [103, 41.4], ridge: [74, 37], valley: [70, 20.5, 15.5], foot: [95, 19.5, 18.2] }
      ],
      walls: [[84, -21, 12.6], [70, -20.5, 12.6], [51.9, -18.9, 12.6], [50.7, -18.7, 12.6], [39.6, -15.3, 12.6], [29.4, -16.1, 12.6],
        [27.8, -14.9, 12.6], [16.5, -11.4, 12.6], [11, -11, 12.6], [5.7, -7.4, 12.6], [2.6, -4.2, 12.6], [0, 0, 12.6], [5.6, 7.3, 12.6],
        [10.9, 11.1, 12.6], [16.4, 11.6, 12.6], [27.6, 15.3, 12.6], [29.2, 16.5, 12.6], [39.4, 15.9, 12.6], [50.6, 19.5, 12.6],
        [50.7, 20.7, 12.6], [66, 21.5, 12.6], [84, 21, 12.6], [88, 19.5, 18.6], [93, 17.5, 18.6], [95.5, 12.5, 18.6], [96.3, 4.9, 18.6],
        [96.3, -0.6, 18.6], [96, -5.7, 18.6], [94.8, -12, 18.6], [92.5, -18, 18.6], [88, -20.5, 18.6], [84, -21, 12.6]]
    },
    {
      id: 'bennelong', origin: [472.1, -1811.3], yaw: 0.094,
      shells: [
        { id: 'C1', tip: [-23, 27.1], ridge: [0, 19.2], valley: [0, 12.5, 13.6], foot: [-14, 11, 12.8] },
        { id: 'C2', tip: [23, 27.1], ridge: [0, 19.2], valley: [0, 12.5, 13.6], foot: [14, 11, 12.8] }
      ],
      // the restaurant's outline
      walls: [[9.2, 10, 12.6], [-3.4, 11.8, 12.6], [-15.9, 6.5, 12.6], [-20.3, 1.4, 12.6], [-20.1, -1.4, 12.6], [-15.6, -6.4, 12.6],
        [-3.5, -11.6, 12.6], [9.1, -9.4, 12.6], [20.1, -1, 12.6], [20.3, 1.1, 12.6], [9.2, 10, 12.6]]
    }
  ],
  outline: [[538.5, -1774.8], [452.7, -1782.8], [462.7, -1887.7], [457.6, -1902.9], [459.8, -1921.8], [454.5, -1922.1], [456.1, -1941.1],
    [460, -1943.1], [472.1, -1947.1], [485.3, -1949.2], [491.5, -1949.4], [502, -1948.5], [510.5, -1946.7], [513.8, -1936.5], [515.6, -1928.2],
    [512.3, -1927.3], [516.1, -1913.6], [520.7, -1913], [532.8, -1934.6], [540.6, -1935], [547.1, -1934.5], [552.1, -1933.3], [557.3, -1931.7],
    [565.6, -1927.9], [569.4, -1924.6], [566.7, -1895.4], [559.2, -1881], [550.7, -1797.1], [541, -1797.9]],
  // The upper podium round the halls, and the lower one at the top of the Monumental Steps; two flights between them
  upper: { y: 12.6, poly: [[457.2, -1811.8], [462.7, -1887.7], [457.6, -1902.9], [459.8, -1921.8], [454.5, -1922.1], [456.1, -1941.1],
    [460, -1943.1], [472.1, -1947.1], [485.3, -1949.2], [491.5, -1949.4], [502, -1948.5], [510.5, -1946.7], [513.8, -1936.5], [515.6, -1928.2],
    [512.3, -1927.3], [516.1, -1913.6], [520.7, -1913], [532.8, -1934.6], [540.6, -1935], [547.1, -1934.5], [552.1, -1933.3], [557.3, -1931.7],
    [565.6, -1927.9], [569.4, -1924.6], [566.7, -1895.4], [559.2, -1881], [551.9, -1808.3], [541.5, -1809.4], [542.2, -1822], [522.2, -1822],
    [521.5, -1811.3], [516.1, -1811.8], [517.2, -1820.3], [504.6, -1821.3], [504.25, -1816.1], [486.9, -1817.6], [486.3, -1808.9],
    [482.9, -1801.1], [475.1, -1791.4], [470.3, -1789.7], [463.2, -1797.3], [458.3, -1808.1]] },
  lower: { y: 9.2, poly: [[538.5, -1774.8], [541, -1797.9], [541.2, -1805.5], [551.4, -1804.6], [551.9, -1808.3], [516.1, -1811.8],
    [517.2, -1820.3], [504.6, -1821.3], [503.6, -1807.3], [486.3, -1808.9], [482.9, -1801.1], [475.1, -1791.4], [470.3, -1789.7], [463.2, -1797.3],
    [458.3, -1808.1], [457.2, -1811.8], [455.2, -1792.5], [452.7, -1782.8]] },
  steps: { y0: 4.0, y1: 9.2, count: 30, front: [[451.1, -1765.3], [536.8, -1757.3]], back: [[452.7, -1782.8], [538.5, -1774.8]] },
  inner: [
    { y0: 9.2, y1: 12.6, count: 15, front: [[486.3, -1808.9], [503.6, -1807.3]], back: [[486.9, -1817.6], [504.25, -1816.1]] },
    { y0: 9.2, y1: 12.6, count: 15, front: [[521.5, -1811.3], [541.5, -1809.4]], back: [[522.2, -1822], [542.2, -1822]] }
  ],
  // The halls' north ends, from `from` on, rise in two tiers to their northern foyers
  tiers: [
    { hall: 'concert', from: 102, y: [15.6, 18.6], inset: [2.5, 5] },
    { hall: 'joan-sutherland', from: 82, y: [15.6, 18.6], inset: [2.5, 5] }
  ]
};

/** A hall's frame: (s, v, y) to the world's [x, y, z] */
function hallFrame(hall) {
  const [ox, oz] = hall.origin;
  const ux = Math.sin(hall.yaw), uz = -Math.cos(hall.yaw); // along: north, turned by yaw
  const vx = -uz, vz = ux; // across: east
  return (s, v, y) => [ox + ux * s + vx * v, y, oz + uz * s + vz * v];
}

// --- Spheres -----------------------------------------------------------------------------------------------------------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.sqrt(dot(a, a));
const unit = (a) => mul(a, 1 / (len(a) || 1));
const lerp3 = (a, b, t) => add(a, mul(sub(b, a), t));

/** The centre of the sphere of `radius` through a, b and c on the side that has it bulge towards `outward` */
function sphereThrough(a, b, c, radius, outward) {
  const ab = sub(b, a), ac = sub(c, a);
  const n = cross(ab, ac);
  // the triangle's circumcentre
  const o = add(a, mul(add(mul(cross(n, ab), dot(ac, ac)), mul(cross(ac, n), dot(ab, ab))), 1 / (2 * dot(n, n))));
  const circle = len(sub(a, o));
  const depth = Math.sqrt(Math.max(radius * radius - circle * circle, 1));
  const centre = add(o, mul(unit(n), dot(n, outward) < 0 ? depth : -depth));
  return { centre, r: len(sub(a, centre)) };
}

/** A half's corners in the world's frame and its sphere, through its tip, ridge's end and foot */
function halfSphere(hall, shell, side, radius) {
  const at = hallFrame(hall);
  const faces = Math.sign(shell.tip[0] - shell.ridge[0]); // 1: it opens north
  const ux = Math.sin(hall.yaw), uz = -Math.cos(hall.yaw), vx = -uz, vz = ux;
  const tip = at(shell.tip[0], 0, shell.tip[1]);
  const ridge = at(shell.ridge[0], 0, shell.ridge[1]);
  const foot = at(shell.foot[0], side * shell.foot[1], shell.foot[2]);
  const valley = at(shell.valley[0], side * shell.valley[1], shell.valley[2]);
  // Outward: to its own side, up, and away from the way it opens
  const outward = [vx * side - ux * faces * 0.6, 0.7, vz * side - uz * faces * 0.6];
  return { tip, ridge, foot, valley, ...sphereThrough(tip, ridge, foot, radius, outward) };
}

/** An arc of the circle about `centre` in the plane with normal `n`, from p to q (both on it), as a function of 0..1 */
function arc(centre, n, p, q) {
  const e1 = unit(sub(p, centre));
  const e2 = unit(cross(n, e1));
  const rho = len(sub(p, centre));
  const tq = sub(q, centre);
  let sweep = Math.atan2(dot(tq, e2), dot(tq, e1));
  if (Math.abs(sweep) > Math.PI) sweep -= Math.sign(sweep) * 2 * Math.PI;
  return (t) => add(centre, mul(add(mul(e1, Math.cos(t * sweep)), mul(e2, Math.sin(t * sweep))), rho));
}

/**
 * A shell's two halves, side -1 (west) and 1 (east): their corners in the world's frame (tip, ridge, valley, foot), their sphere, and
 * `at(a, b)`, the point and its normal: a from the arch (0) to the valley (1), b from the ridge (0) to the side (1). So (0, 0) is the
 * tip, (1, 0) the ridge's end, (1, 1) the valley's foot and (0, 1) the foot. The ridge is where its sphere and its mirror's meet; the
 * valley of two shells back to back, where theirs do.
 */
function shellHalves(hall, shell, radius = OPERA_HOUSE.radius) {
  const ux = Math.sin(hall.yaw), uz = -Math.cos(hall.yaw), vx = -uz, vz = ux;
  const across = [vx, 0, vz];
  const origin = [hall.origin[0], 0, hall.origin[1]];
  const same = (p, q) => p.length === q.length && p.every((x, i) => Math.abs(x - q[i]) < 1e-9);
  const partner = hall.shells.find((o) => o !== shell && same(o.ridge, shell.ridge) && same(o.valley, shell.valley));
  return [-1, 1].map((side) => {
    const h = halfSphere(hall, shell, side, radius);
    const { tip, ridge, foot, centre, r } = h;
    const onSphere = (p) => add(centre, mul(unit(sub(p, centre)), r));
    // The ridge: the circle the sphere meets the hall's middle plane in, from the tip to the ridge's end
    const d = dot(sub(centre, origin), across);
    const ridgeAt = arc(sub(centre, mul(across, d)), across, tip, ridge);
    // The valley: where this sphere meets its partner's, from the ridge's end to the point on that circle nearest the valley's foot;
    // with no partner, the great circle to the valley's foot
    let valley = onSphere(h.valley), valleyAt = null;
    if (partner) {
      const o = halfSphere(hall, partner, side, radius);
      const D = len(sub(o.centre, centre)), n = unit(sub(o.centre, centre));
      const t = (r * r - o.r * o.r + D * D) / (2 * D);
      const k = add(centre, mul(n, t));
      const toV = sub(h.valley, k);
      valley = add(k, mul(unit(sub(toV, mul(n, dot(toV, n)))), Math.sqrt(Math.max(r * r - t * t, 1))));
      valleyAt = arc(k, n, ridge, valley);
    }
    const plain = (a, b) => onSphere(add(add(mul(tip, (1 - a) * (1 - b)), mul(ridge, a * (1 - b))), add(mul(valley, a * b), mul(foot, (1 - a) * b))));
    return {
      side, tip, ridge, valley, foot, centre, r,
      at(a, b) {
        let p = add(plain(a, b), mul(sub(ridgeAt(a), plain(a, 0)), (1 - b) * (1 - b)));
        if (valleyAt) p = add(p, mul(sub(valleyAt(b), plain(1, b)), a * a));
        const q = unit(sub(p, centre));
        return { position: add(centre, mul(q, r)), normal: q };
      }
    };
  });
}

/** One half's mesh: plain arrays of positions, normals and uvs (a, b), and triangles wound to face out */
function halfMesh(half, n = 20) {
  const positions = [], normals = [], uvs = [], index = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const { position, normal } = half.at(i / n, j / n);
      positions.push(...position);
      normals.push(...normal);
      uvs.push(i / n, j / n);
    }
  }
  // which way round faces out: the first cell's against its normal
  const p = (k) => positions.slice(3 * k, 3 * k + 3);
  const face = cross(sub(p(1), p(0)), sub(p(n + 1), p(0)));
  const flip = dot(face, normals.slice(0, 3)) < 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      if (flip) index.push(a, c, b, b, c, d);
      else index.push(a, b, c, b, d, c);
    }
  }
  return { positions, normals, uvs, index };
}

/** Every half of every shell, and its mesh: { hall, shell, half, mesh } */
function allHalves(n = 20) {
  const out = [];
  for (const hall of OPERA_HOUSE.halls) {
    for (const shell of hall.shells) {
      for (const half of shellHalves(hall, shell)) out.push({ hall, shell, half, mesh: halfMesh(half, n) });
    }
  }
  return out;
}

/** The heights of the shells' surfaces over (x, z), from their meshes: `heightsAt(x, z)` lists them */
function surfaceLookup(halves, cell = 2) {
  const tris = [];
  const grid = new Map();
  for (const { mesh } of halves) {
    const P = mesh.positions;
    for (let k = 0; k < mesh.index.length; k += 3) {
      const t = [0, 1, 2].map((m) => P.slice(3 * mesh.index[k + m], 3 * mesh.index[k + m] + 3));
      const id = tris.push(t) - 1;
      const xs = t.map((q) => q[0]), zs = t.map((q) => q[2]);
      for (let gx = Math.floor(Math.min(...xs) / cell); gx <= Math.floor(Math.max(...xs) / cell); gx++) {
        for (let gz = Math.floor(Math.min(...zs) / cell); gz <= Math.floor(Math.max(...zs) / cell); gz++) {
          const key = `${gx},${gz}`;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(id);
        }
      }
    }
  }
  return {
    heightsAt(x, z) {
      const out = [];
      for (const id of grid.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? []) {
        const [a, b, c] = tris[id];
        const det = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
        if (Math.abs(det) < 1e-9) continue;
        const u = ((x - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (z - a[2])) / det;
        const v = ((b[0] - a[0]) * (z - a[2]) - (x - a[0]) * (b[2] - a[2])) / det;
        if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
        out.push(a[1] + (b[1] - a[1]) * u + (c[1] - a[1]) * v);
      }
      return out;
    }
  };
}

/** A shell's arch, west foot to tip to east foot, `n` steps a side, moved in from it towards its valley by `back` m at the tip and
 * less towards the feet, none at them. [x, y, z] each. */
function archLine(hall, shell, n = 16, back = 0) {
  const [west, east] = shellHalves(hall, shell);
  const point = (half, b) => {
    const edge = half.at(0, b).position;
    if (!back) return edge;
    const want = back * Math.pow(1 - b, 0.7);
    const t = Math.min(0.85, want / Math.max(1, len(sub(edge, half.at(1, b).position))));
    return half.at(t, b).position;
  };
  const out = [];
  for (let k = n; k >= 0; k--) out.push(point(west, k / n));
  for (let k = 1; k <= n; k++) out.push(point(east, k / n));
  return out;
}

/**
 * The glass under the shells, as upright strips: { hall, kind, top: [[x, y, z]], bottom: [[x, y, z]] }.
 * - 'wall': round each hall where OPERA_HOUSE says, from the floor up to the first shell over it.
 * - 'louvre': under a shell's arch where another is nested in front of it, from the line in from the arch, down and forwards to the
 *   nested shell, or the podium where that isn't in the way.
 */
function glassWalls(halves = allHalves()) {
  const out = [];
  const all = surfaceLookup(halves);
  for (const hall of OPERA_HOUSE.halls) {
    const to = hallFrame(hall);
    const top = [], bottom = [];
    for (let k = 0; k + 1 < hall.walls.length; k++) {
      const [s0, v0, f0] = hall.walls[k], [s1, v1, f1] = hall.walls[k + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(s1 - s0, v1 - v0) / 2));
      for (let i = k ? 1 : 0; i <= steps; i++) {
        const t = i / steps;
        const [x, , z] = to(s0 + (s1 - s0) * t, v0 + (v1 - v0) * t, 0);
        const floor = f0 + (f1 - f0) * t;
        const over = all.heightsAt(x, z).filter((y) => y > floor + 0.3);
        top.push([x, over.length ? Math.min(...over) : floor + 3, z]);
        bottom.push([x, floor, z]);
      }
    }
    out.push({ hall: hall.id, kind: 'wall', top, bottom });
    for (const shell of hall.shells) {
      if (!shell.louvre) continue;
      const nested = surfaceLookup(halves.filter((h) => h.hall === hall && h.shell.id === shell.louvre.to));
      const ux = Math.sin(hall.yaw), uz = -Math.cos(hall.yaw);
      const faces = Math.sign(shell.tip[0] - shell.ridge[0]);
      const dir = unit([ux * faces * 0.7, -1, uz * faces * 0.7]);
      const from = archLine(hall, shell, 16, shell.louvre.back);
      const ends = from.map((p) => {
        for (let t = 0; t < 80; t += 0.5) {
          const q = add(p, mul(dir, t));
          if (q[1] <= shell.foot[2]) return [q[0], shell.foot[2], q[2]];
          const under = nested.heightsAt(q[0], q[2]);
          if (under.some((y) => y >= q[1])) return q;
        }
        return add(p, mul(dir, 80));
      });
      out.push({ hall: hall.id, shell: shell.id, kind: 'louvre', top: from, bottom: ends });
    }
  }
  return out;
}

/** What the model's script draws on (tools/models/ in m-sydney-private): the shells' meshes, arches and glass, and OPERA_HOUSE */
function operaGeometry() {
  const halves = allHalves();
  return {
    data: OPERA_HOUSE,
    shells: halves.map(({ hall, shell, half, mesh }) => ({ hall: hall.id, shell: shell.id, side: half.side, ...mesh })),
    arches: OPERA_HOUSE.halls.flatMap((hall) => hall.shells.map((shell) => ({ hall: hall.id, shell: shell.id, line: archLine(hall, shell) }))),
    glass: glassWalls(halves),
    tiers: OPERA_HOUSE.tiers.map((tier) => ({ ...tier, rings: tierRings(tier) }))
  };
}

// --- Drawing -----------------------------------------------------------------------------------------------------------------
function meshGeometry({ positions, normals, uvs, index }) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  return g;
}

/** Strips between two lines of points, both faces */
function stripGeometry(top, bottom) {
  const position = [], index = [];
  for (let k = 0; k < top.length; k++) position.push(...top[k], ...bottom[k]);
  for (let k = 0; k + 1 < top.length; k++) {
    const a = 2 * k, b = a + 1, c = a + 2, d = a + 3;
    index.push(a, b, c, c, b, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** A solid on a ring of [x, z] from y0 up to y1: its walls and top */
function prismGeometry(ring, y0, y1) {
  const pts = ring.map(([x, z]) => new THREE.Vector2(x, z));
  if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
  const position = [], normal = [], index = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const L = a.distanceTo(b);
    if (L < 0.01) continue;
    const nx = (b.y - a.y) / L, nz = -(b.x - a.x) / L;
    const k = position.length / 3;
    position.push(a.x, y0, a.y, b.x, y0, b.y, a.x, y1, a.y, b.x, y1, b.y);
    for (let m = 0; m < 4; m++) normal.push(nx, 0, nz);
    index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
  }
  const k = position.length / 3;
  for (const p of pts) {
    position.push(p.x, y1, p.y);
    normal.push(0, 1, 0);
  }
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(pts, [])) index.push(k + a, k + c, k + b);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  g.setIndex(index);
  return g;
}

/** A flight of steps between two edges, front (bottom) and back (top), each [[x, z], [x, z]] from one end to the other */
function flightGeometry({ y0, y1, count, front, back }) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const t0 = i / count, t1 = (i + 1) / count;
    const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    const ring = [lerp(front[0], back[0], t0), lerp(front[1], back[1], t0), lerp(front[1], back[1], t1), lerp(front[0], back[0], t1)];
    parts.push(prismGeometry(ring, y0 - 1.5, y0 + (y1 - y0) * (i + 1) / count));
  }
  return mergeGeometries(parts, false);
}

/** Where each hall's north end rises in tiers: its part of the outline north of `from`, moved in */
function tierRings(tier) {
  const hall = OPERA_HOUSE.halls.find((h) => h.id === tier.hall);
  const [ox, oz] = hall.origin;
  const ux = Math.sin(hall.yaw), uz = -Math.cos(hall.yaw);
  const sOf = ([x, z]) => (x - ox) * ux + (z - oz) * uz;
  const vOf = ([x, z]) => (x - ox) * -uz + (z - oz) * ux;
  return tier.inset.map((inset) => {
    // the outline's points past `from` and within the hall's width, then the line across at `from`
    const ring = OPERA_HOUSE.outline.filter((p) => sOf(p) > tier.from && Math.abs(vOf(p)) < 34);
    const at = hallFrame(hall);
    const vs = ring.map(vOf);
    const v0 = Math.min(...vs), v1 = Math.max(...vs);
    const across = [at(tier.from, v1, 0), at(tier.from, v0, 0)].map((p) => [p[0], p[2]]);
    const pts = [...ring, ...across];
    // in towards the middle of what's past `from`
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cz = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    return pts.map(([x, z]) => {
      const d = Math.hypot(x - cx, z - cz) || 1;
      return [x - ((x - cx) / d) * inset, z - ((z - cz) / d) * inset];
    });
  });
}

/**
 * The Opera House into `group`: the shells, and the plain glass, podium and steps a model of its own takes the place of near it. What
 * stops you walking into the podium goes into `colliders`; the ground it stands on, for the tile build (`reserves`), too.
 * Returns { plain }: the meshes the model takes the place of.
 */
function buildOperaHouse(group, colliders, reserves = null) {
  const settle = (mesh, cast = true) => {
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    mesh.userData.lifted = true;
    return mesh;
  };
  // The shells. Outside: white and cream tiles in chevrons, with a band of bare concrete rib along the arch. Under them: concrete ribs
  // fanning from the foot.
  const tile = new THREE.MeshStandardNodeMaterial({ roughness: 0.34, metalness: 0.02 });
  const tileUv = uv().mul(46);
  const zig = fract(tileUv.x).sub(0.5).abs().mul(2);
  const lines = fract(tileUv.y.add(zig));
  const across = fwidth(tileUv.y).add(fwidth(tileUv.x));
  const chevrons = smoothstep(0.08, 0.14, lines).mul(float(1).sub(smoothstep(0.86, 0.92, lines)));
  const faded = mix(chevrons, float(0.8), smoothstep(0.25, 0.7, across));
  const lids = mix(color(0xcfc5ac), color(0xf5f2e8), faded);
  const rib = float(1).sub(smoothstep(0.012, 0.022, uv().x)); // the arch's edge: uv's x is 0 along it
  tile.colorNode = mix(lids, color(0xd8cbb0), rib);
  tile.emissiveNode = color(0xfff4e0).mul(smoothstep(0.55, 1.2, cityUniforms.uInteriorGlow).mul(0.75));
  const underside = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, side: THREE.BackSide });
  // Rays from the foot, where uv is (0, 1)
  const fan = uv().x.div(float(1).sub(uv().y).max(0.001)).mul(20);
  underside.colorNode = mix(color(0x9c8f7a), color(0xc9bea6), smoothstep(0.1, 0.25, fract(fan).sub(0.5).abs()));
  underside.emissiveNode = color(0xffcf96).mul(smoothstep(0.55, 1.2, cityUniforms.uInteriorGlow).mul(0.35));

  const halves = allHalves();
  const shells = mergeGeometries(halves.map((h) => meshGeometry(h.mesh)), false);
  group.add(settle(new THREE.Mesh(shells, tile)));
  group.add(settle(new THREE.Mesh(shells, underside), false));

  // The plain version of the rest: frustumCulled off, so js/scene-culling.js leaves them be for the model to stand in for
  const plain = [];
  const keep = (mesh) => {
    mesh.frustumCulled = false;
    plain.push(mesh);
    group.add(mesh);
    return mesh;
  };
  const glass = new THREE.MeshStandardNodeMaterial({ color: 0x2c2620, roughness: 0.12, metalness: 0.55, side: THREE.DoubleSide });
  glass.emissiveNode = color(0xffbc70).mul(smoothstep(0.55, 1.2, cityUniforms.uInteriorGlow).mul(0.6));
  const glazed = keep(settle(new THREE.Mesh(mergeGeometries(glassWalls(halves).map((w) => stripGeometry(w.top, w.bottom)), false), glass), false));
  glazed.receiveShadow = false;

  // The podium in pink-brown granite, on the outline in the map: the upper podium round the halls, the lower one at the top of the
  // Monumental Steps, the north ends in tiers
  const granite = new THREE.MeshStandardNodeMaterial({ color: 0x8a6b5a, roughness: 0.8 });
  const paving = new THREE.MeshStandardNodeMaterial({ color: 0x9a8472, roughness: 0.9 });
  const { podium, upper, lower, steps, inner } = OPERA_HOUSE;
  const blocks = [prismGeometry(upper.poly, -2.5, podium - 0.02)];
  for (const tier of OPERA_HOUSE.tiers) tierRings(tier).forEach((ring, k) => blocks.push(prismGeometry(ring, podium - 1, tier.y[k])));
  keep(settle(new THREE.Mesh(mergeGeometries(blocks, false), granite)));
  keep(settle(new THREE.Mesh(mergeGeometries([prismGeometry(lower.poly, -2.5, lower.y), flightGeometry(steps), ...inner.map(flightGeometry)], false), paving)));

  // Solid to anyone at the harbour's level: up to just under the lower podium, which is the model's floor to stand on
  const xs = OPERA_HOUSE.outline.map((p) => p[0]), zs = OPERA_HOUSE.outline.map((p) => p[1]);
  colliders.push({
    minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs), minY: 0, maxY: lower.y - 0.2, baseY: 0,
    polygon: { outer: OPERA_HOUSE.outline.map(([x, z]) => ({ x, z })), holes: [] }
  });
  if (reserves) {
    const sx = [...steps.front, ...steps.back].map((p) => p[0]), sz = [...steps.front, ...steps.back].map((p) => p[1]);
    reserves.push({ minX: Math.min(...sx), maxX: Math.max(...sx), minZ: Math.min(...sz), maxZ: Math.max(...sz), maxY: steps.y1 });
  }
  return { plain };
}

export { OPERA_HOUSE, archLine, buildOperaHouse, glassWalls, hallFrame, operaGeometry, shellHalves, surfaceLookup };
