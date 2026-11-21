import * as THREE from 'three/webgpu';
import { EFFECT, christmasMaterials, lin, lookW } from './christmas-materials.js';

// The city's big Christmas trees in December (js/season-december.js), where 2025's stood: Martin Place, before the GPO; one afloat on
// Cockle Bay, Darling Harbour; Barangaroo, by Watermans Cove; The Rocks, at the top of Jack Mundey Place; and one each in Parramatta's
// Centenary Square, Chatswood's mall and Manly's Corso. And one inside the QVB, under its dome, while its model's ground floor is held.
// - Each is made in code from its height (treeKit()): tiers of boughs in a cone, bulbs wound round it in spirals, hung down it in drops
//   and scattered over it, baubles hanging from its boughs' tips, a star on top that glows at night, presents under it, all on a round
//   plinth with a low fence on its rim. The floating one's plinth is on a pontoon.
// - All of them are two meshes, the shapes and the bulbs, drawn with the houses' two materials (js/christmas-materials.js): nothing more
//   to compile once either is drawn.
// - Within the graphics level's buildingDetail of you a tree is drawn whole; past that, out to its farRange, it's a glow at night as wide
//   as its crown (EFFECT.beacon), so it reads across the harbour. Near, that glow fades out and its own bulbs are what you see.
// - Where one stands, no street tree is planted (its `clear` circle, as a model site's) and you can't walk or drive through its fence
//   (a collider): `clear(circles)` and `colliders.add(list)` from the season's ctx.
// - A tree indoors stands where a model's inside keeps a spot for it (`spots` in its JSON: the QVB's, under its dome), made when the
//   inside's held and let go of with it: `indoor()` says where they are now (ctx.spots('christmas-tree')). Its plinth is on the inside's
//   floor; it's slimmer than a street's (the spot's `r`), has no glow far off, and its fence holds you at the floor's height.

// x, z: its middle, found by name on the map and checked against the paving from above. y: the ground there as the map had it (only
// for the glow far off: the plinth is laid on the ground near you). h: m from the plinth to the star's top. `face`: the way its star
// faces (radians from +z towards +x), towards where it's mostly seen from. `float`: on a pontoon, on the water.
const CITY_TREES = [
  { id: 'martin-place', name: 'Martin Place', x: -6, z: -625, y: 15.1, h: 20, lights: 'multi', baubles: 'classic', face: Math.PI / 2 },
  { id: 'darling-harbour', name: 'Darling Harbour', x: -600, z: -175, y: -2.2, h: 15, lights: 'cool', baubles: 'silver', face: Math.PI / 2,
    float: true },
  { id: 'barangaroo', name: 'Barangaroo', x: -731, z: -1046, y: 1.7, h: 15, lights: 'warm', baubles: 'classic', face: Math.PI / 2 },
  { id: 'the-rocks', name: 'The Rocks', x: -92, z: -1549, y: 11.1, h: 11, lights: 'warm', baubles: 'native', face: Math.PI / 2 },
  { id: 'parramatta', name: 'Parramatta', x: -19536, z: -3622, y: 11.4, h: 16, lights: 'multi', baubles: 'classic', face: 0 },
  { id: 'chatswood', name: 'Chatswood', x: -3406, z: -8116, y: 92.3, h: 14, lights: 'multi', baubles: 'classic', face: 2.07 },
  { id: 'manly', name: 'Manly', x: 6156, z: -9290, y: 5.8, h: 15, lights: 'warm', baubles: 'classic', face: 2.29 }
];

const WARM = [1.0, 0.7, 0.36], COOL = [0.75, 0.86, 1.0];
const MULTI = [[1.0, 0.09, 0.05], [0.1, 0.85, 0.18], [0.12, 0.3, 1.0], [1.0, 0.52, 0.06], [0.95, 0.16, 0.62]];
const BAUBLES = {
  classic: [lin(0xb3121b), lin(0xd9a520), lin(0xc9ccd2), lin(0xb3121b), lin(0x1f4fb0)],
  silver: [lin(0xd6dbe2), lin(0x2a62c8), lin(0xf2f2f0), lin(0x8fb6e8)],
  // The Rocks' 2025 tree: wooden baubles and native flowers (waratah, wattle, kangaroo paw)
  native: [lin(0x8a5a32), lin(0xc0281e), lin(0xf2c21b), lin(0xd8661c), lin(0x6e4424)]
};
const LIGHTS = {
  multi: { spiral: EFFECT.chase, drop: EFFECT.chase, scatter: EFFECT.twinkle, colours: (k) => (k % 3 ? MULTI[k % MULTI.length] : WARM), beacon: [2.6, 1.6, 1.3] },
  warm: { spiral: EFFECT.steady, drop: EFFECT.chase, scatter: EFFECT.twinkle, colours: () => WARM, beacon: [2.6, 1.8, 0.95] },
  cool: { spiral: EFFECT.steady, drop: EFFECT.chase, scatter: EFFECT.twinkle, colours: (k) => (k % 4 ? COOL : WARM), beacon: [2.1, 2.3, 2.6] }
};
const GREEN = lin(0x23502b), TRUNK = lin(0x4a3220), GOLD = lin(0xd9a520), WHITE = lin(0xeeeee8), SKIRT = lin(0x8c1c1c), STONE = lin(0x274a30);
const DECK = lin(0x8a6a48), HULL = lin(0x3a3d40);

const START = 1.25; // m over the plinth: the lowest boughs' tips
const FENCE = 0.72; // m high
const PONTOON = { freeboard: 0.45, draft: 0.6 }; // m over and under the water
const STEP = 0.3; // m between bulbs along a spiral, on high
// How much of each a level has: bulbs and baubles in proportion; and the room in the meshes, bulbs and the shapes' vertices
const DENSITY = { low: 0.45, medium: 0.75, high: 1 };
const ROOM = { low: { bulbs: 6000, vertices: 70000 }, medium: { bulbs: 9000, vertices: 100000 }, high: { bulbs: 12000, vertices: 120000 } };
const REFILL = 100; // m moved before what's drawn is chosen again

/** The base of the cone's lowest boughs, m from the trunk: an indoor one's as its spot says */
const reachOf = (tree) => tree.r ?? 0.36 * tree.h;
/** The plinth's radius: the lowest boughs' tips, and room for the fence under them */
const plinthOf = (tree) => reachOf(tree) + 0.85;

function seeded(text) {
  let a = 2166136261;
  for (let i = 0; i < text.length; i++) a = Math.imul(a ^ text.charCodeAt(i), 16777619);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Shapes, in the tree's frame: x, z from its middle, y in the world ------------------------------------------------------------------

function builder() {
  const pos = [], nor = [], col = [], glow = [];
  const vert = (p, n, c, g) => {
    pos.push(p[0], p[1], p[2]);
    nor.push(n[0], n[1], n[2]);
    col.push(c[0], c[1], c[2]);
    glow.push(g);
  };
  const cross = (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };
  const unit = (n) => {
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  };
  /** A triangle facing `out` (its corners turned to face it), each corner its own normal and colour */
  const tri = (a, b, c, na, nb, nc, ca, cb, cc, g = 0, out = null) => {
    const n = cross(a, b, c);
    const want = out ?? [na[0] + nb[0] + nc[0], na[1] + nb[1] + nc[1], na[2] + nb[2] + nc[2]];
    if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) {
      vert(a, na, ca, g); vert(c, nc, cc, g); vert(b, nb, cb, g);
    } else {
      vert(a, na, ca, g); vert(b, nb, cb, g); vert(c, nc, cc, g);
    }
  };
  /** A flat triangle facing `out` */
  const flat = (a, b, c, colour, g, out) => {
    let n = unit(cross(a, b, c));
    if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) n = [-n[0], -n[1], -n[2]];
    tri(a, b, c, n, n, n, colour, colour, colour, g, n);
  };
  const quad = (a, b, c, d, colour, g, out) => {
    flat(a, b, c, colour, g, out);
    flat(a, c, d, colour, g, out);
  };
  return {
    tri,
    flat,
    quad,
    /** A box from its middle and size, turned by yaw */
    box(cx, cy, cz, sx, sy, sz, colour, g = 0, yaw = 0) {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const at = (x, y, z) => [cx + x * c + z * s, cy + y, cz - x * s + z * c];
      const hx = sx / 2, hy = sy / 2, hz = sz / 2;
      const faces = [
        [[1, 0, 0], [[hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]]],
        [[-1, 0, 0], [[-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz]]],
        [[0, 0, 1], [[hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz], [-hx, -hy, hz]]],
        [[0, 0, -1], [[-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz], [hx, -hy, -hz]]],
        [[0, 1, 0], [[-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz]]]
      ];
      for (const [n, q] of faces) {
        const out = [n[0] * c + n[2] * s, n[1], -n[0] * s + n[2] * c];
        const [p0, p1, p2, p3] = q.map((p) => at(...p));
        quad(p0, p1, p2, p3, colour, g, out);
      }
    },
    /** A ball, its normals smooth */
    ball(cx, cy, cz, r, colour, g = 0, sides = 6, rings = 4) {
      const at = (i, j) => {
        const th = (i / sides) * Math.PI * 2, ph = (j / rings) * Math.PI;
        const n = [Math.sin(ph) * Math.cos(th), -Math.cos(ph), Math.sin(ph) * Math.sin(th)];
        return { p: [cx + n[0] * r, cy + n[1] * r, cz + n[2] * r], n };
      };
      for (let j = 0; j < rings; j++) {
        for (let i = 0; i < sides; i++) {
          const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
          if (j > 0) tri(a.p, b.p, c.p, a.n, b.n, c.n, colour, colour, colour, g);
          if (j < rings - 1) tri(a.p, c.p, d.p, a.n, c.n, d.n, colour, colour, colour, g);
        }
      }
    },
    /** An upright ring of wall from y0 to y1 at radius r, facing out (or in), its normals smooth */
    wall(r, y0, y1, colour, sides, g = 0, inward = false) {
      for (let i = 0; i < sides; i++) {
        const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
        const s = inward ? -1 : 1;
        const n0 = [Math.cos(a0) * s, 0, Math.sin(a0) * s], n1 = [Math.cos(a1) * s, 0, Math.sin(a1) * s];
        const p0 = [Math.cos(a0) * r, y0, Math.sin(a0) * r], p1 = [Math.cos(a1) * r, y0, Math.sin(a1) * r];
        const q0 = [p0[0], y1, p0[2]], q1 = [p1[0], y1, p1[2]];
        tri(p0, p1, q1, n0, n1, n1, colour, colour, colour, g);
        tri(p0, q1, q0, n0, n1, n0, colour, colour, colour, g);
      }
    },
    /** A flat ring, or a disc (r0 = 0), at y, facing up */
    disc(r0, r1, y, colour, sides, g = 0) {
      const up = [0, 1, 0];
      for (let i = 0; i < sides; i++) {
        const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
        const o0 = [Math.cos(a0) * r1, y, Math.sin(a0) * r1], o1 = [Math.cos(a1) * r1, y, Math.sin(a1) * r1];
        if (r0 <= 0) {
          tri([0, y, 0], o0, o1, up, up, up, colour, colour, colour, g, up);
          continue;
        }
        const i0 = [Math.cos(a0) * r0, y, Math.sin(a0) * r0], i1 = [Math.cos(a1) * r0, y, Math.sin(a1) * r0];
        tri(i0, o0, o1, up, up, up, colour, colour, colour, g, up);
        tri(i0, o1, i1, up, up, up, colour, colour, colour, g, up);
      }
    },
    vertices: () => pos.length / 3,
    done: () => ({ pos: new Float32Array(pos), nor: new Float32Array(nor), col: new Float32Array(col), glow: new Float32Array(glow), v: pos.length / 3 })
  };
}

/**
 * One tree's shapes and bulbs: { pos, nor, col, glow, v (its shapes' vertices), bulbs (x, y, z, s each), look (r, g, b, w each), n (its
 * bulbs), star, top }, x and z from its middle and y in the world. `base`: the plinth's top; `foot`: its foot (the lowest ground under
 * it, or the pontoon's deck); `water`: the water's level, for a floating one; `density`: how many of its bulbs and baubles (0-1).
 * Made a piece at a time (a few milliseconds each), yielding between them; treeKit() makes it at once.
 */
function* treeKitSteps(tree, { base = 0, foot = base - 0.4, water = -2.2, density = 1 } = {}) {
  const rand = seeded(tree.id);
  const H = tree.h, R = reachOf(tree), Rp = plinthOf(tree);
  const trunkR = 0.16 + 0.012 * H;
  const top = H * 0.86; // the top bough's tip; the star over it
  const b = builder();
  const tint = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

  // The boughs: tiers, each a skirt from the trunk out and down to its tips, bulging a little, its tips jagged; the next one up over it
  const tiers = Math.max(5, Math.round((top - START) / 1.35));
  const pitch = (top - START) / tiers;
  const cone = (y) => R * Math.max(0, (top - y) / (top - START));
  const profiles = []; // each tier's [y, r] from its tips in to the trunk, for laying the bulbs on what's outside
  for (let t = 0; t < tiers; t++) {
    const last = t === tiers - 1;
    const yRim = base + START + t * pitch;
    const rOut = cone(yRim - base) * 0.97 + 0.3;
    const yIn = last ? base + top + 0.4 : yRim + pitch * 1.9;
    const rIn = last ? 0.04 : trunkR + 0.08;
    const rMid = rIn + (rOut - rIn) * 0.6, yMid = yIn - (yIn - yRim) * 0.45;
    profiles.push([[yRim, rOut * 0.96], [yMid, rMid], [yIn, rIn]]);
    const sides = Math.max(10, Math.min(44, Math.round((rOut * Math.PI * 2) / 0.62)));
    const twist = rand() * Math.PI * 2;
    const ringAt = (k, r, y) => {
      const a = twist + (k / sides) * Math.PI * 2;
      return [Math.cos(a) * r, y, Math.sin(a) * r];
    };
    // The outside's normal along the profile, from (r0, y0) out to (r1, y1), tilted up a little: soft, as a mass of needles is
    const normalOf = (k, r0, y0, r1, y1) => {
      const a = twist + (k / sides) * Math.PI * 2;
      let nr = y0 - y1, ny = r1 - r0;
      const l = Math.hypot(nr, ny) || 1;
      nr /= l;
      ny = ny / l + 0.35;
      const m = Math.hypot(nr, ny);
      return [(Math.cos(a) * nr) / m, ny / m, (Math.sin(a) * nr) / m];
    };
    const shade = Array.from({ length: sides }, () => 0.86 + rand() * 0.28);
    // The tips jagged, every other one a bough's end: each its own length and droop
    const tip = Array.from({ length: sides }, (_, k) => (k % 2 ? [0.88 + rand() * 0.04, 0.08] : [0.97 + rand() * 0.08, -0.06 - rand() * 0.22]));
    for (let k = 0; k < sides; k++) {
      const k1 = (k + 1) % sides;
      const A0 = ringAt(k, rIn, yIn), A1 = ringAt(k + 1, rIn, yIn);
      const B0 = ringAt(k, rMid, yMid), B1 = ringAt(k + 1, rMid, yMid);
      const C0 = ringAt(k, rOut * tip[k][0], yRim + tip[k][1]), C1 = ringAt(k + 1, rOut * tip[k1][0], yRim + tip[k1][1]);
      const nA0 = normalOf(k, rIn, yIn, rMid, yMid), nA1 = normalOf(k + 1, rIn, yIn, rMid, yMid);
      const nB0 = normalOf(k, rIn, yIn, rOut, yRim), nB1 = normalOf(k + 1, rIn, yIn, rOut, yRim);
      const nC0 = normalOf(k, rMid, yMid, rOut, yRim), nC1 = normalOf(k + 1, rMid, yMid, rOut, yRim);
      const cA = tint(GREEN, 0.5 * shade[k]), cB = tint(GREEN, 0.85 * shade[k]), cC0 = tint(GREEN, 1.12 * shade[k]), cC1 = tint(GREEN, 1.12 * shade[k1]);
      b.tri(A0, A1, B1, nA0, nA1, nB1, cA, cA, cB);
      b.tri(A0, B1, B0, nA0, nB1, nB0, cA, cB, cB);
      b.tri(B0, B1, C1, nB0, nB1, nC1, cB, cB, cC1);
      b.tri(B0, C1, C0, nB0, nC1, nC0, cB, cC1, cC0);
      if (last) continue;
      // Underneath, from the tips back in to the trunk: seen from close under the lowest
      const U0 = ringAt(k, rIn, yRim + 0.3), U1 = ringAt(k + 1, rIn, yRim + 0.3);
      const down = [0, -1, 0], cU = tint(GREEN, 0.3);
      b.tri(C0, C1, U1, down, down, down, cU, cU, cU, 0, down);
      b.tri(C0, U1, U0, down, down, down, cU, cU, cU, 0, down);
    }
  }
  // How far out what's outside is at height y: the tiers' profiles, the furthest out
  const outsideAt = (y) => {
    let r = 0;
    for (const p of profiles) {
      for (let i = 0; i + 1 < p.length; i++) {
        const [y0, r0] = p[i], [y1, r1] = p[i + 1];
        if (y >= y0 && y <= y1) r = Math.max(r, r0 + ((r1 - r0) * (y - y0)) / (y1 - y0));
      }
    }
    return r;
  };

  yield;
  // The trunk, up into the boughs
  b.wall(trunkR, foot, base + START + pitch * 1.5, TRUNK, 7);

  // The plinth: a dais with a skirt on it, a gold band round its edge, and a low white fence on its rim
  const sides = Math.max(24, Math.min(56, Math.round(Rp * 5)));
  b.wall(Rp, foot, base, STONE, sides);
  b.wall(Rp + 0.01, base - 0.07, base + 0.005, GOLD, sides, 0.15);
  b.disc(trunkR, Rp, base, SKIRT, sides);
  const Rf = Rp - 0.14;
  for (const [y0, y1] of [[0.16, 0.24], [0.5, 0.58]]) {
    b.wall(Rf + 0.012, base + y0, base + y1, WHITE, sides * 2);
    b.wall(Rf - 0.012, base + y0, base + y1, WHITE, sides * 2, 0, true);
  }
  const pickets = Math.round((Rf * Math.PI * 2) / 0.3);
  for (let i = 0; i < pickets; i++) {
    const a = (i / pickets) * Math.PI * 2;
    b.box(Math.cos(a) * Rf, base + FENCE / 2, Math.sin(a) * Rf, 0.07, FENCE, 0.035, WHITE, 0, Math.PI / 2 - a);
  }

  // Presents under the lowest boughs
  const presents = Math.round(6 + H * 0.5);
  const wraps = [SKIRT, GOLD, lin(0x1f6a2c), lin(0x2a4fb0), lin(0xd8d8d8), lin(0x7a2a8a)];
  for (let i = 0; i < presents; i++) {
    const a = rand() * Math.PI * 2, r = trunkR + 0.6 + rand() * (R * 0.62 - trunkR - 0.6);
    const sx = 0.45 + rand() * 0.6, sy = 0.35 + rand() * 0.55, sz = 0.45 + rand() * 0.6, yaw = rand() * Math.PI;
    const wrap = wraps[i % wraps.length], ribbon = wrap === GOLD ? SKIRT : GOLD;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    b.box(x, base + sy / 2, z, sx, sy, sz, wrap, 0.05, yaw);
    b.box(x, base + sy / 2 + 0.005, z, sx + 0.01, sy + 0.01, 0.07, ribbon, 0.05, yaw);
  }

  // The floating one's pontoon: a deck on a hull, a rail round it
  if (tree.float) {
    const half = Rp + 1.2, deck = water + PONTOON.freeboard, keel = water - PONTOON.draft;
    for (let s = 0; s < 4; s++) {
      const a = (s * Math.PI) / 2, c = Math.cos(a), si = Math.sin(a);
      const at = (u, y) => [c * half - si * u, y, si * half + c * u];
      b.quad(at(-half, keel), at(half, keel), at(half, deck), at(-half, deck), HULL, 0, [c, 0, si]);
    }
    b.quad([-half, deck, -half], [half, deck, -half], [half, deck, half], [-half, deck, half], DECK, 0, [0, 1, 0]);
    const posts = Math.round(half / 1.5) * 2;
    for (let s = 0; s < 4; s++) {
      const a = (s * Math.PI) / 2, c = Math.cos(a), si = Math.sin(a);
      for (let i = 0; i < posts; i++) {
        const u = -half + 0.1 + ((half * 2 - 0.2) * i) / posts;
        b.box(c * (half - 0.1) - si * u, deck + 0.5, si * (half - 0.1) + c * u, 0.06, 1.0, 0.06, WHITE);
      }
      b.box(c * (half - 0.1), deck + 1.0, si * (half - 0.1), Math.abs(si) * (half * 2 - 0.2) + 0.06, 0.06, Math.abs(c) * (half * 2 - 0.2) + 0.06, WHITE);
    }
  }

  yield;
  // Baubles, hanging under the boughs' tips, on every tier but the top one: rounder on high
  const palette = BAUBLES[tree.baubles] ?? BAUBLES.classic;
  const baubles = Math.round(266 * (H / 20) ** 2 * density);
  const radius = 0.15 * Math.sqrt(H / 20) + 0.05;
  const rings = profiles.slice(0, -1).map((p) => p[0]);
  const around = rings.reduce((sum, [, r]) => sum + r, 0);
  for (let i = 0; i < baubles; i++) {
    let pick = rand() * around, ring = rings[0];
    for (const rg of rings) {
      ring = rg;
      if ((pick -= rg[1]) <= 0) break;
    }
    const a = rand() * Math.PI * 2, r = ring[1] * (0.86 + rand() * 0.08), s = radius * (0.75 + rand() * 0.5);
    b.ball(Math.cos(a) * r, ring[0] - 0.12 - s, Math.sin(a) * r, s, palette[i % palette.length], 0.12, ...(density >= 1 ? [6, 3] : [5, 3]));
    if (i % 80 === 79) yield;
  }

  // The star: five points, its faces raised to its middle, facing `face`
  const rs = 0.085 * H, cy = base + top + 0.35 + rs * 0.85, depth = rs * 0.22;
  const fc = Math.cos(tree.face ?? 0), fs = Math.sin(tree.face ?? 0);
  const inFrame = (u, v, w) => [u * fc + w * fs, cy + v, -u * fs + w * fc];
  const pts = Array.from({ length: 10 }, (_, k) => {
    const a = Math.PI / 2 + (k * Math.PI) / 5, r = k % 2 ? rs * 0.42 : rs;
    return [Math.cos(a) * r, Math.sin(a) * r];
  });
  for (const w of [1, -1]) {
    const middle = inFrame(0, 0, depth * w);
    for (let k = 0; k < 10; k++) {
      const p = pts[k], q = pts[(k + 1) % 10];
      b.flat(middle, inFrame(p[0], p[1], 0), inFrame(q[0], q[1], 0), GOLD, 3.0, [fs * w, 0, fc * w]);
    }
  }
  b.wall(0.06, base + top, cy, GOLD, 5, 0.5);

  yield;
  // The bulbs: on what's outside, a little out from it. s: how far along its string, for the chase
  const lights = LIGHTS[tree.lights] ?? LIGHTS.warm;
  const bulbs = [], look = [];
  const bulb = (x, y, z, s, rgb, effect, seed, size = 1) => {
    bulbs.push(x, y, z, s);
    look.push(rgb[0], rgb[1], rgb[2], lookW(effect, seed, size));
  };
  const lowest = profiles[0][0][0];
  const onOutside = (a, y, out = 0.07) => {
    const r = outsideAt(Math.max(y, lowest)) + out;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  };
  const step = STEP / density;
  const yTop = base + top - 0.2, yBottom = base + START - 0.1;
  // Spirals, wound down from the top, swagged between the boughs
  const spirals = H >= 14 ? 4 : 3, turns = (top - START) / 2.4;
  for (let g = 0; g < spirals; g++) {
    const phase = (g / spirals) * Math.PI * 2, seed = rand();
    let s = 0, last = null, k = 0;
    const samples = 1000;
    for (let i = 0; i <= samples; i++) {
      const u = i / samples, a = phase + u * turns * Math.PI * 2;
      const y = yTop - u * (yTop - yBottom) - 0.25 * Math.abs(Math.sin(u * turns * Math.PI * 6));
      const p = onOutside(a, y, 0.1);
      if (last) s += Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]);
      last = p;
      if (s >= k * step) {
        bulb(p[0], p[1], p[2], s, lights.colours(k + g), lights.spiral, seed);
        k++;
      }
    }
    yield;
  }
  yield;
  // Drops, from near the top straight down the outside
  const drops = Math.round((R * Math.PI * 2) / 2.3);
  for (let d = 0; d < drops; d++) {
    const a = (d / drops) * Math.PI * 2 + rand() * 0.1, seed = rand();
    const y0 = yTop - 0.6 - rand() * 1.2;
    const n = Math.floor((y0 - yBottom) / (0.4 / density));
    for (let i = 0; i <= n; i++) {
      const y = y0 - i * (0.4 / density), p = onOutside(a, y, 0.05);
      bulb(p[0], p[1], p[2], i * 0.4, tree.lights === 'multi' ? WARM : lights.colours(d), lights.drop, seed);
    }
  }
  // Scattered over it, twinkling: as many as on a cone's outside a bulb a 0.3 m square
  const scatter = Math.round(R * (top - START) * 3.2 * density);
  for (let i = 0; i < scatter; i++) {
    const y = yTop - (yTop - yBottom) * Math.sqrt(rand());
    const p = onOutside(rand() * Math.PI * 2, y, 0.04);
    bulb(p[0], p[1], p[2], i * 0.3, lights.colours(i), lights.scatter, rand());
  }
  const star = [0, cy, 0];
  // The star's glow at night, and the tree's beacon: its crown's glow far off
  bulb(0, cy, 0, 0, [1.0, 0.78, 0.4], EFFECT.glow, 0, H >= 14 ? 5 : 4);
  bulb(0, base + H * 0.42, 0, 0, lights.beacon, EFFECT.beacon, 0, H >= 14 ? 6 : 5);

  const shapes = b.done();
  return { ...shapes, bulbs: new Float32Array(bulbs), look: new Float32Array(look), n: bulbs.length / 4, star, top: cy + rs };
}
function treeKit(tree, options) {
  const job = treeKitSteps(tree, options);
  for (;;) {
    const step = job.next();
    if (step.done) return step.value;
  }
}

/**
 * The collider round a tree's plinth: no walking or driving through its fence, nor standing on it. The floating one has none. An indoor
 * one's heights are the floor's it stands on (as a model's walls are: js/controllers.js), so it holds you there and not under the floor.
 */
function colliderOf(tree) {
  if (tree.float) return null;
  const r = plinthOf(tree) + 0.05, outer = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    outer.push({ x: tree.x + Math.cos(a) * r, z: tree.z + Math.sin(a) * r });
  }
  const heights = tree.indoor ? { minY: tree.y, maxY: 2.4, level: true, baseY: tree.y } : { minY: 0, maxY: 2.4 };
  return { minX: tree.x - r, maxX: tree.x + r, minZ: tree.z - r, maxZ: tree.z + r, ...heights, polygon: { outer, holes: [] }, christmas: true };
}

/** A tree for a model inside's spot (js/interiors.js spots()): the QVB's, warm white with silver baubles, as its crystal ones */
const indoorTree = (spot) => ({ id: `${spot.site}:${spot.id}`, name: spot.id, x: spot.x, y: spot.y, z: spot.z, h: spot.h, r: spot.r, lights: 'warm',
  baubles: 'silver', face: Math.PI / 2, indoor: true });
/** Where no street tree is planted round a tree: its crown kept off the boughs */
const clearingOf = (tree) => (tree.float ? null : { x: tree.x, z: tree.z, r: plinthOf(tree) + 3.5 });

// --- The trees near you -------------------------------------------------------------------------------------------------------------

/**
 * The city's trees near you. `level`: the graphics level's name; `reach()`: m round you a tree is drawn whole (buildingDetail); `far()`:
 * m round you its glow reaches (farRange). `env`: ground(x, z) the top of what's drawn there; prepare(x, z, r) one of the map's surfaces'
 * triangles made there (true if it did one); glow, the night's glow uniform; water, the sea's level. `origin`, `anchor(object)` and
 * `reveal(group)` as the season's ctx has them; `clear(circles)` and `colliders` ({ add(list), remove(list) }) to keep the street
 * trees and the player out. `group` is revealed once there's a tree or a glow to draw.
 */
function createCityTrees({ level = 'high', reach = () => 2000, far = () => 8000, env, origin, reveal, anchor, clear = () => {},
  colliders = { add() {}, remove() {} }, trees = CITY_TREES, indoor = () => [] }) {
  const density = DENSITY[level] ?? 1, room = ROOM[level] ?? ROOM.high;
  const group = new THREE.Group();
  group.name = 'ChristmasTrees';
  let bulbMesh = null, shapeMesh = null, materials = null;
  const made = new Map(); // id -> { tree, kit }
  let roomMade = false, held = [], unclear = null;
  let filledAt = null, changed = false, lastOrigin = { x: origin.x, z: origin.z };
  let drawn = { trees: 0, beacons: 0, bulbs: 0, vertices: 0 };
  const away = (t, x, z) => Math.hypot(t.x - x, t.z - z);
  const inside = new Map(); // id -> { tree, collider }: the indoor trees whose spots are held now

  /** The indoor trees as the insides held have them now: a new spot's tree to be made, a spot let go of takes its tree with it */
  function holdIndoor() {
    const now = new Map(indoor().map((spot) => [`${spot.site}:${spot.id}`, spot]));
    for (const [id, held] of inside) {
      if (now.has(id)) continue;
      inside.delete(id);
      colliders.remove([held.collider]);
      if (made.delete(id)) changed = true;
    }
    for (const [id, spot] of now) {
      if (inside.has(id)) continue;
      const tree = indoorTree(spot), collider = colliderOf(tree);
      inside.set(id, { tree, collider });
      colliders.add([collider]);
    }
  }
  const everyTree = () => [...trees, ...[...inside.values()].map((h) => h.tree)];

  /** A tree's plinth laid on the ground round it: its top over the highest of it, its foot under the lowest; indoors on the floor */
  function levels(tree) {
    if (tree.indoor) return { base: tree.y + 0.25, foot: tree.y };
    if (tree.float) {
      const deck = env.water + PONTOON.freeboard;
      return { base: deck + 0.3, foot: deck };
    }
    const Rp = plinthOf(tree), ys = [env.ground(tree.x, tree.z)];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ys.push(env.ground(tree.x + Math.cos(a) * Rp, tree.z + Math.sin(a) * Rp));
    }
    const low = Math.min(...ys), high = Math.max(...ys);
    return { base: Math.max(high + 0.12, ys[0] + 0.25), foot: low - 0.3 };
  }

  /** One step of work near (x, z): the room made, a tree made, the meshes made, or what's drawn chosen again. Whether it did something. */
  function* work(x, z) {
    if (!roomMade) {
      roomMade = true;
      unclear = clear(trees.map(clearingOf).filter(Boolean));
      held = trees.map(colliderOf).filter(Boolean);
      colliders.add(held);
      return true;
    }
    holdIndoor();
    const r = reach();
    // The nearest tree within reach not made yet: the ground's triangles under it first, one surface a step
    let next = null;
    for (const t of everyTree()) if (!made.has(t.id) && away(t, x, z) <= r && (!next || away(t, x, z) < away(next, x, z))) next = t;
    if (next) {
      if (!next.float && !next.indoor && env.prepare(next.x, next.z, plinthOf(next) + 1)) return true;
      const { base, foot } = levels(next);
      const kit = yield* treeKitSteps(next, { base, foot, water: env.water, density });
      // let go of while it was being made
      if (next.indoor && !inside.has(next.id)) return true;
      made.set(next.id, { tree: next, base, kit });
      changed = true;
      return true;
    }
    for (const [id, m] of made) {
      if (away(m.tree, x, z) > r + 500) {
        made.delete(id);
        changed = true;
      }
    }
    if (!bulbMesh) {
      if (!made.size && !everyTree().some((t) => away(t, x, z) <= far())) return false;
      yield* show();
      changed = true;
      return true;
    }
    const moved = origin.x !== lastOrigin.x || origin.z !== lastOrigin.z;
    if (changed || moved || !filledAt || Math.hypot(x - filledAt.x, z - filledAt.z) > REFILL) {
      fill(x, z);
      return true;
    }
    return false;
  }

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
    bulbMesh.name = 'ChristmasTreeBulbs';
    const shapeGeometry = new THREE.BufferGeometry();
    shapeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(room.vertices * 3), 3));
    shapeGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(room.vertices * 3), 3));
    shapeGeometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(room.vertices * 3), 3));
    shapeGeometry.setAttribute('aGlow', new THREE.Float32BufferAttribute(new Float32Array(room.vertices), 1));
    shapeGeometry.setDrawRange(0, 3);
    shapeMesh = new THREE.Mesh(shapeGeometry, materials.shapes);
    shapeMesh.name = 'ChristmasTrees';
    shapeMesh.castShadow = true;
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

  // What's drawn: the trees made within reach, the nearest first, as many as there's room for; and the glow of the rest within far()
  function fill(x, z) {
    filledAt = { x, z };
    changed = false;
    lastOrigin = { x: origin.x, z: origin.z };
    const g = bulbMesh.geometry, aBulb = g.attributes.aBulb, aLook = g.attributes.aLook;
    const sg = shapeMesh.geometry, pos = sg.attributes.position, nor = sg.attributes.normal, col = sg.attributes.color, gl = sg.attributes.aGlow;
    const near = [...made.values()].filter((m) => away(m.tree, x, z) <= reach()).sort((a, b) => away(a.tree, x, z) - away(b.tree, x, z));
    let n = 0, v = 0, whole = 0, beacons = 0;
    const shown = new Set();
    for (const { tree, kit } of near) {
      if (n + kit.n > room.bulbs || v + kit.v > room.vertices) continue;
      const dx = tree.x - origin.x, dz = tree.z - origin.z;
      const B = aBulb.array, L = aLook.array;
      for (let i = 0; i < kit.n; i++) {
        B[(n + i) * 4] = kit.bulbs[i * 4] + dx;
        B[(n + i) * 4 + 1] = kit.bulbs[i * 4 + 1];
        B[(n + i) * 4 + 2] = kit.bulbs[i * 4 + 2] + dz;
        B[(n + i) * 4 + 3] = kit.bulbs[i * 4 + 3];
      }
      L.set(kit.look, n * 4);
      n += kit.n;
      const P = pos.array;
      for (let i = 0; i < kit.v; i++) {
        P[(v + i) * 3] = kit.pos[i * 3] + dx;
        P[(v + i) * 3 + 1] = kit.pos[i * 3 + 1];
        P[(v + i) * 3 + 2] = kit.pos[i * 3 + 2] + dz;
      }
      nor.array.set(kit.nor, v * 3);
      col.array.set(kit.col, v * 3);
      gl.array.set(kit.glow, v);
      v += kit.v;
      whole++;
      shown.add(tree.id);
    }
    // The rest, far off: a glow each at night, as wide as its crown, from the ground the map had there
    for (const tree of trees) {
      if (shown.has(tree.id) || away(tree, x, z) > far() || n >= room.bulbs) continue;
      const lights = LIGHTS[tree.lights] ?? LIGHTS.warm;
      aBulb.array.set([tree.x - origin.x, tree.y + (tree.float ? 1.05 : 0.25) + tree.h * 0.42, tree.z - origin.z, 0], n * 4);
      aLook.array.set([...lights.beacon, lookW(EFFECT.beacon, 0, tree.h >= 14 ? 6 : 5)], n * 4);
      n++;
      beacons++;
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
    drawn = { trees: whole, beacons, bulbs: n, vertices: v };
  }

  return {
    group,
    work,
    update(elapsed) { if (materials) materials.now.value = elapsed; },
    shown: () => !!bulbMesh,
    /** For the scripts: what's made and drawn; `pending`, the trees within reach not made or not drawn yet */
    state(x, z) {
      const within = everyTree().filter((t) => away(t, x, z) <= reach());
      return {
        made: [...made.keys()], drawn, at: filledAt && { x: Math.round(filledAt.x), z: Math.round(filledAt.z) },
        pending: within.filter((t) => !made.has(t.id)).length + (within.length && (!bulbMesh || changed) ? 1 : 0),
        indoor: [...inside.keys()]
      };
    },
    /** For the scripts: each tree, how far it is, and where its plinth was laid */
    list: (x, z) => everyTree().map((t) => ({ id: t.id, x: t.x, z: t.z, h: t.h, away: Math.round(away(t, x, z)), base: made.get(t.id)?.base ?? null,
      vertices: made.get(t.id)?.kit.v ?? 0, bulbs: made.get(t.id)?.kit.n ?? 0, ...(t.indoor ? { indoor: true } : {}) })),
    stop() {
      colliders.remove(held);
      colliders.remove([...inside.values()].map((h) => h.collider));
      inside.clear();
      unclear?.();
      bulbMesh?.geometry.dispose();
      shapeMesh?.geometry.dispose();
    }
  };
}

export { CITY_TREES, ROOM, clearingOf, colliderOf, createCityTrees, plinthOf, treeKit, treeKitSteps };
