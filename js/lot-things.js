import { HOUSE_STYLES } from './house-styles.js';
import { houseEntry } from './house-entry.js';
import { DOOR_KEEP } from './building-floor.js';
import { LAWN_TOP, PANEL, SLAB, SLAB_PIECE, acrossAt, alongOf, depthOf, hashOf, inRing, insideSpans, keyOf, slab } from './house-lots.js';

// What stands in a house's lot besides its fences between neighbours (js/house-lots.js), by the house's era (js/house-styles.js):
// - The car: a carport (a flat roof on two or four posts) beside post-war, triple-fronted and beach houses, at their driveway's end; a
//   single garage at the back of Federation houses and bungalows, its driveway taken on to it. A project home's garage is in its wall.
// - A front fence along the front line, with a gap for the driveway and a gate for the path: timber pickets (Federation), a low brick
//   wall on piers (bungalows, triple-fronted), an iron palisade (terraces), wire (post-war), each on some of the style's lots only; none
//   for project homes and beach houses. It holds the walker, as the fences between neighbours do.
// - A path to the door, from the driveway, or from the front gate where there's none.
// - A letterbox at the front line. Shrubs along the front wall on about half the lots; a low hedge along the front line on about half of
//   those without a front fence, holding the walker as a fence would.
// - A verandah on terraces and Federation houses, a porch on bungalows (on brick piers) and post-war houses (over the door), a deck
//   to the street on beach houses.
// - Steps up to a door its floor left over the ground: where its street address set the floor at its door and the cut into the slope
//   stopped at MAX_CUT (js/building-floor.js doorFloor()). Straight out where the yard holds them, along the front wall where it doesn't,
//   up to STEPS_TO; their treads go to the ground's lookup (`treads`), so a walker climbs them, and their open sides hold the walker.
// Boxes go to js/lot-details.js' instanced box of things ({ x, y, z: the middle of its foot; a: its length along, b: its width across,
// each a vector, with a rise in y for a slope; h: how high; kind (THING); colour; small: drawn only near }); paths go with the driveways'
// concrete; front fences' panels with the other fences'.

const THING = { paint: 0, brick: 1, leaves: 2, iron: 3, boards: 4, door: 5 };
const FENCE = { picket: 2, palisade: 3, wire: 4 }; // js/tsl-materials.js createFenceMaterial()'s kinds
const FRONT_FENCE = {
  'Victorian terrace': { kind: 'palisade', share: 0.7, height: 1.1 },
  'Millers Point terrace': { kind: 'palisade', share: 0.6, height: 1.1 },
  Federation: { kind: 'picket', share: 0.65, height: 1.1 },
  'California bungalow': { kind: 'brick', share: 0.6, height: 0.75 },
  'Triple-fronted brick veneer': { kind: 'brick', share: 0.4, height: 0.6 },
  'Post-war fibro': { kind: 'wire', share: 0.35, height: 1.0 }
};
const CARPORT_STYLES = new Set(['Post-war fibro', 'Triple-fronted brick veneer', 'Beach house']);
const GARAGE_STYLES = new Set(['Federation', 'California bungalow']);
const OLDER = new Set(['Victorian terrace', 'Millers Point terrace', 'Federation', 'California bungalow']);
const HOLD = 1.2; // m: a front fence's or hedge's collider, over a walker's jump (0.93 m)
const FRONT_IN = 0.15; // m inside the front line that a front fence stands
const GATE = 1.1; // m: the gap in a front fence for the path
const BRICK_RUN = 4.8; // m: a low brick wall's pieces at most, each level
const HEDGE_RUN = 4; // m: a hedge's
const PATH_TINT = [0.86, 0.58, 0.47]; // brick pavers, on the older houses' paths
const RISER = 0.18; // m at most
const TREAD = 0.28; // m
const LANDING = 1.0; // m deep, at the door
const STAIR = 1.2; // m wide
const STEPS_TO = 3; // m: a door higher over the ground than this has none
const CONCRETE = [0xb3aea4, 0xa59f94];

// Colours, linear
const lin = (hex) => { const c = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => (v / 255) ** 2.2); return c; };
const pickOf = (list, roll) => lin(list[Math.floor(roll * list.length) % list.length]);
const BRICKS = { 'California bungalow': [0x6e2f22, 0x5a2a20, 0x7a3a28], 'Triple-fronted brick veneer': [0xd8c49a, 0xc9b080, 0xe0cfa8],
  Federation: [0x8a3a26, 0x9a4630, 0x7e3422], other: [0x9a5a40, 0xb07a5a] };
const COLORBOND = [0xf0eee6, 0xc9bea2, 0x7c846a, 0x4f514b]; // Surfmist, Paperbark, Pale Eucalypt, Woodland Grey
const TRIM = [0xf2efe6, 0xe8dfc8, 0xf6f4ee]; // white and cream paint
const LEAVES = [0x34552a, 0x3f6130, 0x4a6a34, 0x2f4a26];
const DOORS = [0xe9e4d8, 0x5e6a4e, 0x8a4a32, 0x4a4f55];
const IRON_ROOFS = [0x8a8f92, 0x9a3e30, 0x6c7a6a];

/**
 * What stands in a lot, `lot` from js/house-lots.js squareLots() (its drive worked out: a garage at the back takes it on, so this comes
 * first), `obstacles` the buildings round it ({ rings, whole }), `env` as squareLots() has it. Returns { boxes, slabs, panels, fences }.
 * One house of a row of terraces drawn as one footprint has its own lot, `lot.unit` (squareLots()'s units: its door and its stretch of
 * the front wall), and things of its own.
 */
function lotThings(lot, obstacles, env) {
  const h = lot.home, f = lot.frame, style = HOUSE_STYLES[h.house], look = style?.look;
  const out = { boxes: [], slabs: [], panels: [], fences: [], treads: [], steps: null };
  if (!look) return out;
  const name = style.name;
  const unit = lot.unit ?? null;
  const k0 = unit ? unit.index * 13.7 : 0;
  const roll = (k) => hashOf(keyOf(h.cx * 3 + k * 7.31 + k0, h.cz * 5 - k * 3.17 + k0));
  const pick = (list, k) => lin(list[Math.floor(roll(k) * list.length) % list.length]);
  const at = (a, d) => ({ x: f.px + f.tx * a + f.nx * d, z: f.pz + f.tz * a + f.nz * d });
  const ground = (x, z) => (env.lawnAt(x, z) ?? env.groundAt(x, z)) + LAWN_TOP;
  const others = obstacles.filter((o) => o.whole !== h);
  const blocked = (pts, list = obstacles) => pts.some((p) => list.some((o) => o.rings.some((r) => inRing(r, p.x, p.z))));
  const inLot = (p) => inRing(lot.pts, p.x, p.z);
  const yard = unit ? Math.min(depthOf(f, unit.wall.ax, unit.wall.az), depthOf(f, unit.wall.bx, unit.wall.bz)) - lot.front : h.ext.d0 - lot.front;
  const entry = unit ? { door: unit.door, garage: null } : h.frontWall ? houseEntry(h.frontWall, h.house) : null;
  const door = entry && { a: alongOf(f, entry.door.x, entry.door.z), d: depthOf(f, entry.door.x, entry.door.z) };
  const drive = lot.drive;
  // Steps up to the door, where its floor is over the ground outside it: where the path meets them
  const foot = door && h.address ? steps(out, { h, lot, f, door, yard, drive, others, at, ground, inLot, blocked, name, roll }) : null;
  const pathA = foot ? foot.a : door?.a;

  /** An upright box square to the lot's frame, a0-a1 along and d0-d1 deep, standing on the lawn: `height` over its highest corner */
  const box = (a0, a1, d0, d1, height, kind, colour, { small = false, lift = 0 } = {}) => {
    const corners = [at(a0, d0), at(a1, d0), at(a0, d1), at(a1, d1)].map((p) => ground(p.x, p.z));
    const low = Math.min(...corners) - 0.05 + lift, top = Math.max(...corners) + height;
    const c = at((a0 + a1) / 2, (d0 + d1) / 2);
    out.boxes.push({ x: c.x, y: low, z: c.z, ax: f.tx * (a1 - a0), ay: 0, az: f.tz * (a1 - a0), bx: f.nx * (d1 - d0), by: 0, bz: f.nz * (d1 - d0),
      h: top - low, kind, colour, small });
  };
  /** A box between two points on the ground, `width` across and `height` over the higher end: a wall or hedge's piece */
  const run = (p, q, width, height, kind, colour, small = false) => {
    const L = Math.hypot(q.x - p.x, q.z - p.z);
    if (L < 0.05) return;
    const ux = (q.x - p.x) / L, uz = (q.z - p.z) / L;
    const g0 = ground(p.x, p.z), g1 = ground(q.x, q.z);
    const low = Math.min(g0, g1) - 0.05, top = Math.max(g0, g1) + height;
    out.boxes.push({ x: (p.x + q.x) / 2, y: low, z: (p.z + q.z) / 2, ax: ux * L, ay: 0, az: uz * L, bx: -uz * width, by: 0, bz: ux * width,
      h: top - low, kind, colour, small });
  };

  // --- The car: a garage at the back, or a carport beside -------------------------------------------------------------------
  if (drive && drive.side && !drive.shed && GARAGE_STYLES.has(name) && roll(1) < 0.6) {
    // Its outer wall in line with the driveway's outer edge, the rest of it behind the house
    const gc = drive.a + drive.side * (drive.w / 2 + 0.1 - 1.6);
    const a0 = gc - 1.6, a1 = gc + 1.6, g0 = h.ext.d1 + 1.0, g1 = g0 + 6.0;
    const [lo0, hi0] = acrossAt(lot, g0 + 0.1), [lo1, hi1] = acrossAt(lot, g1 + 0.3);
    const fits = lo0 <= a0 - 0.2 && hi0 >= a1 + 0.2 && lo1 <= a0 - 0.2 && hi1 >= a1 + 0.2;
    // Its own footprint and the way to it beside the house clear of everything, the house too
    const way = [];
    for (let d = drive.d1; d <= g0; d += 1) for (const a of [drive.a - drive.w / 2, drive.a, drive.a + drive.w / 2]) way.push(at(a, d));
    const site = [];
    for (let d = g0; d <= g1; d += 1.5) for (let a = a0; a <= a1 + 0.01; a += 0.8) site.push(at(a, d));
    if (fits && !blocked(way) && !blocked(site)) {
      drive.d1 = g0;
      drive.garage = true;
      const brick = name === 'California bungalow';
      const wall = brick ? pick(BRICKS[name], 2) : pick(TRIM, 2);
      box(a0, a1, g0, g1, 2.5, brick ? THING.brick : THING.boards, wall);
      // A low roof over it, and its tilt door on the front
      const corners = [at(a0, g0), at(a1, g0), at(a0, g1), at(a1, g1)].map((p) => ground(p.x, p.z));
      const top = Math.max(...corners) + 2.5;
      const c = at(gc, (g0 + g1) / 2);
      out.boxes.push({ x: c.x, y: top, z: c.z, ax: f.tx * 3.5, ay: 0, az: f.tz * 3.5, bx: f.nx * 6.4, by: 0, bz: f.nz * 6.4, h: 0.16,
        kind: THING.iron, colour: pick(IRON_ROOFS, 3) });
      box(gc - 1.2, gc + 1.2, g0 - 0.05, g0 + 0.02, 2.1, THING.door, pick(DOORS, 4), { lift: 0.05 });
      const mid = at(gc, (g0 + g1) / 2);
      out.fences.push({ box: { cx: mid.x, cz: mid.z, ux: f.tx, uz: f.tz, hx: 1.6, hz: 3.0 }, hold: 2.5, a: at(a0, (g0 + g1) / 2), b: at(a1, (g0 + g1) / 2) });
    }
  } else if (drive && drive.side && !drive.shed && CARPORT_STYLES.has(name) && roll(1) < 0.7) {
    const d0 = Math.max(lot.front + 1.5, h.ext.d0 - 0.5), d1 = Math.min(drive.d1, d0 + 5.6);
    if (d1 - d0 >= 4.5) {
      const w = drive.w + 0.3, a0 = drive.a - w / 2, a1 = drive.a + w / 2;
      const area = [];
      for (let d = d0; d <= d1; d += 1) for (const a of [a0, drive.a, a1]) area.push(at(a, d));
      if (!blocked(area, others)) {
        const corners = [at(a0, d0), at(a1, d0), at(a0, d1), at(a1, d1)].map((p) => ground(p.x, p.z));
        const top = Math.max(...corners) + 2.4;
        const c = at(drive.a, (d0 + d1) / 2);
        const roof = pick(COLORBOND, 5);
        out.boxes.push({ x: c.x, y: top, z: c.z, ax: f.tx * w, ay: 0, az: f.tz * w, bx: f.nx * (d1 - d0 + 0.3), by: 0, bz: f.nz * (d1 - d0 + 0.3),
          h: 0.12, kind: THING.iron, colour: roof });
        // Posts on its open side, or at all four corners
        const outer = drive.side > 0 ? a1 - 0.08 : a0 + 0.08, inner = drive.side > 0 ? a0 + 0.08 : a1 - 0.08;
        const posts = roll(6) < 0.4 ? [outer, inner] : [outer];
        const post = pick(TRIM, 7);
        for (const a of posts) {
          for (const d of [d0 + 0.1, d1 - 0.1]) {
            const p = at(a, d), g = ground(p.x, p.z);
            out.boxes.push({ x: p.x, y: g - 0.05, z: p.z, ax: f.tx * 0.09, ay: 0, az: f.tz * 0.09, bx: f.nx * 0.09, by: 0, bz: f.nz * 0.09,
              h: top - g + 0.05, kind: THING.paint, colour: post });
          }
        }
      }
    }
  }

  // --- A front fence, or a hedge ---------------------------------------------------------------------------------------------
  // Its line: along the lot's front edges, a little inside, with a gap for the driveway and one for the path to the door
  const gaps = [];
  if (drive) gaps.push([drive.a - drive.w / 2 - 0.2, drive.a + drive.w / 2 + 0.2]);
  const gateAt = door && !(drive && drive.side) ? pathA : null;
  if (gateAt !== null) gaps.push([gateAt - GATE / 2, gateAt + GATE / 2]);
  const frontLine = (inset) => {
    const pieces = [];
    for (let i = 0; i < lot.pts.length; i++) {
      if (lot.pts[i].tag !== 'front') continue;
      const p = lot.pts[i], q = lot.pts[(i + 1) % lot.pts.length];
      let a0 = alongOf(f, p.x, p.z), a1 = alongOf(f, q.x, q.z);
      if (a0 > a1) [a0, a1] = [a1, a0];
      a0 += 0.15; a1 -= 0.15;
      let spans = [[a0, a1]];
      for (const [g0, g1] of gaps) spans = spans.flatMap(([s0, s1]) => [[s0, Math.min(s1, g0)], [Math.max(s0, g1), s1]]).filter(([s0, s1]) => s1 - s0 > 0.6);
      // On the lawn as drawn, not the footpath: a little further in where the lawn starts further from the kerb than the front line
      const offLawn = (d) => {
        let off = 0, n = 0;
        for (let a = a0; a <= a1; a += 0.5, n++) { const p = at(a, d); if (env.onLawn && env.onLawn(p.x, p.z) === false) off++; }
        return off / Math.max(1, n);
      };
      let depth = lot.front + inset;
      for (const more of [0, 0.3, 0.6, 1.0]) {
        if (offLawn(lot.front + inset + more) <= 0.1) { depth = lot.front + inset + more; break; }
      }
      for (const [s0, s1] of spans) {
        // Clear of the buildings, the house among them where it's built up to the front, and of the footpath
        const P = at(s0, depth), Q = at(s1, depth);
        const gone = [];
        for (const o of obstacles) for (const [t0, t1] of insideSpans(P, Q, o.rings)) gone.push([t0 - 0.2 / (s1 - s0), t1 + 0.2 / (s1 - s0)]);
        const n = Math.max(2, Math.ceil((s1 - s0) / 0.5));
        for (let k = 0; k <= n; k++) {
          const p = at(s0 + ((s1 - s0) * k) / n, depth);
          if (env.onLawn && env.onLawn(p.x, p.z) === false) gone.push([(k - 0.5) / n, (k + 0.5) / n]);
        }
        gone.sort((x, y) => x[0] - y[0]);
        let t = 0;
        for (const [t0, t1] of [...gone, [1, 1]]) {
          if (t0 > t && (t0 - t) * (s1 - s0) > 0.6) pieces.push([at(s0 + (s1 - s0) * t, depth), at(s0 + (s1 - s0) * Math.min(1, t0), depth)]);
          t = Math.max(t, t1);
        }
      }
    }
    return pieces;
  };
  const fence = FRONT_FENCE[name];
  const fenced = fence && yard >= 1.2 && roll(8) < fence.share;
  if (fenced) {
    const height = fence.height + (roll(9) - 0.5) * 0.15;
    for (const [p, q] of frontLine(FRONT_IN)) {
      out.fences.push({ a: p, b: q, hold: HOLD });
      if (fence.kind === 'brick') {
        // A wall in pieces of up to BRICK_RUN m, each level, with a pier at each end
        const L = Math.hypot(q.x - p.x, q.z - p.z), n = Math.ceil(L / BRICK_RUN), colour = pick(BRICKS[name] || BRICKS.other, 10);
        for (let k = 0; k < n; k++) {
          const s0 = k / n, s1 = (k + 1) / n;
          run({ x: p.x + (q.x - p.x) * s0, z: p.z + (q.z - p.z) * s0 }, { x: p.x + (q.x - p.x) * s1, z: p.z + (q.z - p.z) * s1 }, 0.23, height, THING.brick, colour);
        }
        for (const s of [0, 1]) {
          const c = { x: p.x + (q.x - p.x) * s, z: p.z + (q.z - p.z) * s }, ux = (q.x - p.x) / L, uz = (q.z - p.z) / L;
          run({ x: c.x - ux * 0.18, z: c.z - uz * 0.18 }, { x: c.x + ux * 0.18, z: c.z + uz * 0.18 }, 0.36, height + 0.14, THING.brick, colour);
        }
      } else {
        const kind = FENCE[fence.kind];
        const colour = fence.kind === 'picket' ? Math.floor(roll(11) * 2) : fence.kind === 'palisade' ? Math.floor(roll(11) * 2) : 0;
        panelsAlong(out.panels, p, q, height, kind, colour, roll(12), env);
      }
    }
  } else if (yard >= 1.6 && roll(13) < 0.55) {
    const colour = pick(LEAVES, 14), height = 0.7 + roll(15) * 0.35;
    for (const [p, q] of frontLine(0.45)) {
      out.fences.push({ a: p, b: q, hold: HOLD });
      const L = Math.hypot(q.x - p.x, q.z - p.z), n = Math.ceil(L / HEDGE_RUN);
      for (let k = 0; k < n; k++) {
        const s0 = k / n, s1 = (k + 1) / n;
        run({ x: p.x + (q.x - p.x) * s0, z: p.z + (q.z - p.z) * s0 }, { x: p.x + (q.x - p.x) * s1, z: p.z + (q.z - p.z) * s1 }, 0.6, height, THING.leaves, colour);
      }
    }
  }

  // --- The path to the door --------------------------------------------------------------------------------------------------
  const pathWidth = OLDER.has(name) ? 1.0 : 1.2;
  const tint = OLDER.has(name) && roll(16) < 0.6 ? PATH_TINT : null;
  const legs = [];
  if (door && door.d - lot.front > 1.2) {
    const wall = foot ? foot.d : door.d - 0.05;
    if (drive && drive.side) {
      const edge = drive.a - Math.sign(drive.a - pathA) * (drive.w / 2);
      const d = Math.max(lot.front + 0.8, wall - 1.4);
      if (Math.abs(edge - pathA) > 0.8) legs.push([edge, d, pathA, d]);
      legs.push([pathA, d - pathWidth / 2, pathA, wall]);
    } else if (drive) {
      // A project home's: from its driveway beside the door
      const edge = drive.a - Math.sign(drive.a - pathA) * (drive.w / 2);
      const d = wall - 1.0;
      if (Math.abs(edge - pathA) > 0.6 && d > lot.front + 0.5) {
        legs.push([edge, d, pathA, d]);
        legs.push([pathA, d - pathWidth / 2, pathA, wall]);
      }
    } else {
      legs.push([pathA, lot.front + 0.05, pathA, wall]);
    }
  }
  for (const [a0, d0, a1, d1] of legs) {
    const p = at(a0, d0), q = at(a1, d1);
    const L = Math.hypot(q.x - p.x, q.z - p.z);
    if (L < 0.3) continue;
    const n = Math.max(1, Math.ceil(L / SLAB_PIECE));
    const ux = (q.x - p.x) / L, uz = (q.z - p.z) / L, wx = -uz * pathWidth / 2, wz = ux * pathWidth / 2;
    const mid = (t) => ({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t });
    if (blocked([mid(0.25), mid(0.5), mid(0.75)], others) || !inLot(mid(0.5))) continue;
    const lift = (pt) => ({ ...pt, y: ground(pt.x, pt.z) + SLAB });
    for (let k = 0; k < n; k++) {
      const s = mid(k / n), e = mid((k + 1) / n);
      const piece = slab(lift({ x: s.x - wx, z: s.z - wz }), lift({ x: e.x - wx, z: e.z - wz }), lift({ x: s.x + wx, z: s.z + wz }),
        lift({ x: e.x + wx, z: e.z + wz }), 0, 0.95);
      if (tint) piece.rgb = tint;
      piece.near = true;
      out.slabs.push(piece);
    }
  }

  // --- A letterbox at the front line ------------------------------------------------------------------------------------------
  if (yard >= 1.0) {
    let a = null;
    if (drive) a = drive.a + (door && door.a < drive.a ? -1 : 1) * (drive.w / 2 + 0.55);
    else if (gateAt !== null) {
      const middle = unit ? alongOf(f, (unit.wall.ax + unit.wall.bx) / 2, (unit.wall.az + unit.wall.bz) / 2) : (h.ext.a0 + h.ext.a1) / 2;
      a = gateAt + (gateAt < middle ? 1 : -1) * (GATE / 2 + 0.4);
    }
    if (a !== null) {
      const d = lot.front + (fenced ? 0.45 : 0.3), p = at(a, d);
      if (inLot(p) && !blocked([p], others)) {
        if (OLDER.has(name) || name === 'Triple-fronted brick veneer') {
          box(a - 0.21, a + 0.21, d - 0.21, d + 0.21, 1.05, THING.brick, pick(BRICKS[name] || BRICKS.other, 17), { small: true });
        } else {
          box(a - 0.04, a + 0.04, d - 0.04, d + 0.04, 0.85, THING.paint, pick(TRIM, 18), { small: true });
          const g = ground(p.x, p.z);
          out.boxes.push({ x: p.x, y: g + 0.85, z: p.z, ax: f.tx * 0.42, ay: 0, az: f.tz * 0.42, bx: f.nx * 0.32, by: 0, bz: f.nz * 0.32, h: 0.3,
            kind: THING.paint, colour: pick(COLORBOND, 19), small: true });
        }
      }
    }
  }

  // --- The front wall: shrubs along it, and a verandah, a porch or a deck ----------------------------------------------------
  const wall = unit ? wallFrame(unit.wall, h) : h.frontWall && wallFrame(h.frontWall, h);
  if (wall && yard >= 1.6) {
    if (roll(20) < 0.5) {
      const n = Math.max(1, Math.min(3, Math.floor(wall.width / 2.8)));
      for (let k = 0; k < n; k++) {
        const s = (wall.width * (k + 0.5)) / n;
        const c = wall.at(s, 0.65);
        if (entry && Math.hypot(c.x - entry.door.x, c.z - entry.door.z) < 1.4) continue;
        if (entry?.garage && Math.hypot(c.x - entry.garage.x, c.z - entry.garage.z) < entry.garage.width / 2 + 0.8) continue;
        if (drive && Math.abs(alongOf(f, c.x, c.z) - drive.a) < drive.w / 2 + 0.5 && depthOf(f, c.x, c.z) < drive.d1 + 0.5) continue;
        if (!inLot(c) || blocked([c], others)) continue;
        // Clipped shrubs, longer than they're high
        const w = 1.2 + roll(21 + k) * 0.9, height = 0.45 + roll(25 + k) * 0.4;
        run(wall.at(s - w / 2, 0.6), wall.at(s + w / 2, 0.6), 0.7, height, THING.leaves, pick(LEAVES, 29 + k), true);
      }
    }
    verandah(out, name, wall, entry, yard, lot, others, ground, roll, pick);
  }
  return out;
}

/**
 * Steps up to a house's door where its floor is more than DOOR_KEEP over the ground outside it, into `out` (boxes from the ground up to
 * each tread, the treads' tops for the lookup, and fences along their open sides to hold the walker): straight out from the door where the
 * yard holds them, else along the front wall beside a landing at the door; none over STEPS_TO, or where neither fits (`out.steps` says
 * which). The point where a path meets them, { a, d } in the lot's frame, or null where there are none.
 */
function steps(out, { h, lot, f, door, yard, drive, others, at, ground, inLot, blocked, name, roll }) {
  const sill = h.wallBase;
  const outside = ground(...Object.values(at(door.a, door.d - 0.3)));
  if (!(sill - outside > DOOR_KEEP)) return null;
  if (sill - outside > STEPS_TO) { out.steps = { kind: 'high', rise: sill - outside }; return null; }
  const kind = OLDER.has(name) ? THING.brick : name === 'Beach house' ? THING.boards : THING.paint;
  const colour = kind === THING.brick ? pickOf(BRICKS[name] || BRICKS.other, roll(60)) : kind === THING.boards ? lin(0x8a6a4c) : pickOf(CONCRETE, roll(60));
  const g = (a, d) => ground(...Object.values(at(a, d)));
  /** A block square to the lot's frame from the ground up to `top`, and its top for the lookup */
  const block = (a0, a1, d0, d1, top, tread = true) => {
    const low = Math.min(g(a0, d0), g(a1, d0), g(a0, d1), g(a1, d1)) - 0.05;
    const c = at((a0 + a1) / 2, (d0 + d1) / 2);
    const piece = { x: c.x, y: low, z: c.z, ax: f.tx * (a1 - a0), ay: 0, az: f.tz * (a1 - a0), bx: f.nx * (d1 - d0), by: 0, bz: f.nz * (d1 - d0) };
    out.boxes.push({ ...piece, h: top - low, kind, colour });
    if (tread) out.treads.push({ ...piece, y: top });
  };
  const hold = (a0, d0, a1, d1, top) => out.fences.push({ a: at(a0, d0), b: at(a1, d1), hold: Math.max(0.3, top - Math.min(g(a0, d0), g(a1, d1))) });
  // How many risers from a foot whose ground is `low`: never over RISER
  const risers = (low) => Math.max(1, Math.ceil((sill - low) / RISER - 1e-6));
  const clear = (pts) => pts.every(inLot) && !blocked(pts, others) && !(drive && pts.some((p) => {
    const a = (p.x - f.px) * f.tx + (p.z - f.pz) * f.tz, d = (p.x - f.px) * f.nx + (p.z - f.pz) * f.nz;
    return Math.abs(a - drive.a) < drive.w / 2 + 0.1 && d >= drive.d0 - 0.1 && d <= drive.d1 + 0.1;
  }));
  const a0 = door.a - STAIR / 2, a1 = door.a + STAIR / 2, top = door.d - 0.02;
  // Straight out: the ground at its foot sets how many, which sets where its foot is; more till the foot's ground needs no more, so none
  // is over RISER
  let n = risers(outside);
  for (let k = 0; k < 24; k++) {
    const more = risers(g(door.a, door.d - LANDING - (n - 1) * TREAD - 0.15));
    if (more <= n) break;
    n = more;
  }
  const footD = door.d - LANDING - (n - 1) * TREAD;
  const straight = [];
  for (let d = footD; d <= top; d += 0.5) for (const a of [a0, door.a, a1]) straight.push(at(a, d));
  if (footD - 0.3 >= lot.front && clear(straight)) {
    const low = g(door.a, footD - 0.15);
    const rise = (sill - low) / n;
    for (let j = 1; j < n; j++) block(a0, a1, footD + (j - 1) * TREAD, footD + j * TREAD, low + j * rise);
    block(a0, a1, door.d - LANDING, top, sill - 0.02);
    if (sill - low > 0.6) { hold(a0, footD + TREAD, a0, top - 0.1, sill); hold(a1, footD + TREAD, a1, top - 0.1, sill); }
    out.steps = { kind: 'straight', rise: sill - low, risers: n };
    return { a: door.a, d: footD - 0.05 };
  }
  // Along the wall: a landing at the door, the flight down beside it to whichever side holds it, nearer the wall than the landing's edge
  const width = LANDING + 0.2, d0 = door.d - width, d1 = door.d - 0.02;
  for (const side of [1, -1]) {
    let m = risers(outside);
    for (let k = 0; k < 24; k++) {
      const more = risers(g(door.a + side * (STAIR / 2 + (m - 1) * TREAD + 0.15), (d0 + d1) / 2));
      if (more <= m) break;
      m = more;
    }
    const length = (m - 1) * TREAD;
    const end = door.a + side * (STAIR / 2 + length);
    const pts = [];
    for (let a = door.a - STAIR / 2; a <= door.a + STAIR / 2; a += 0.4) for (const d of [d0, d1]) pts.push(at(a, d));
    for (let s = 0; s <= length + 0.3; s += 0.4) for (const d of [d0, (d0 + d1) / 2, d1]) pts.push(at(door.a + side * (STAIR / 2 + s), d));
    if (yard < width + 0.3 || !clear(pts)) continue;
    const low = g(end + side * 0.15, (d0 + d1) / 2), rise = (sill - low) / m;
    block(a0, a1, d0, d1, sill - 0.02);
    for (let j = 1; j < m; j++) {
      // the j-th from the landing down
      const s0 = STAIR / 2 + (j - 1) * TREAD, s1 = STAIR / 2 + j * TREAD;
      const [p0, p1] = side > 0 ? [door.a + s0, door.a + s1] : [door.a - s1, door.a - s0];
      block(p0, p1, d0 + 0.2, d1, sill - j * rise);
    }
    if (sill - low > 0.6) {
      hold(door.a - side * STAIR / 2, d0, end, d0 + 0.2, sill);
      hold(door.a - side * STAIR / 2, d0, door.a - side * STAIR / 2, d1 - 0.1, sill);
    }
    out.steps = { kind: 'along', rise: sill - low, risers: m };
    return { a: end + side * 0.5, d: (d0 + d1) / 2 };
  }
  out.steps = { kind: 'none', rise: sill - outside };
  return null;
}

/** A house's front wall as a frame: along it from a, out from it away from the house, and its foot and top */
function wallFrame(front, h) {
  const { ax, az, bx, bz, width } = front;
  const ux = (bx - ax) / width, uz = (bz - az) / width;
  let ox = -uz, oz = ux;
  if (((ax + bx) / 2 - h.cx) * ox + ((az + bz) / 2 - h.cz) * oz < 0) { ox = -ox; oz = -oz; }
  const at = (s, out) => ({ x: ax + ux * s + ox * out, z: az + uz * s + oz * out });
  return { ax, az, ux, uz, ox, oz, width, at, base: h.wallBase ?? 0.22, height: h.wallHeight ?? 3 };
}

/** A verandah, porch or deck on a house's front wall, by its style */
function verandah(out, name, wall, entry, yard, lot, others, ground, roll, pick) {
  const blocked = (pts) => pts.some((p) => others.some((o) => o.rings.some((r) => inRing(r, p.x, p.z))));
  const doorS = entry ? (entry.door.x - wall.ax) * wall.ux + (entry.door.z - wall.az) * wall.uz : wall.width / 2;
  // Its roof against the wall under the eaves, sloping down to its posts
  const roofed = (s0, s1, depth, top, fall, postKind, postColour, postSize, roofColour) => {
    s0 = Math.max(0.1, s0); s1 = Math.min(wall.width - 0.1, s1);
    if (s1 - s0 < 1.2) return;
    const corners = [wall.at(s0, depth), wall.at(s1, depth), wall.at((s0 + s1) / 2, depth)];
    if (!corners.every((p) => inRing(lot.pts, p.x, p.z)) || blocked(corners)) return;
    const c = wall.at((s0 + s1) / 2, depth / 2);
    out.boxes.push({ x: c.x, y: top - fall / 2, z: c.z, ax: wall.ux * (s1 - s0), ay: 0, az: wall.uz * (s1 - s0), bx: wall.ox * depth, by: -fall, bz: wall.oz * depth,
      h: 0.07, kind: THING.iron, colour: roofColour });
    const n = Math.max(2, Math.round((s1 - s0) / 2.6) + 1);
    for (let k = 0; k < n; k++) {
      const s = s0 + postSize / 2 + ((s1 - s0 - postSize) * k) / (n - 1), p = wall.at(s, depth - postSize / 2 - 0.05), g = ground(p.x, p.z);
      out.boxes.push({ x: p.x, y: g - 0.05, z: p.z, ax: wall.ux * postSize, ay: 0, az: wall.uz * postSize, bx: wall.ox * postSize, by: 0, bz: wall.oz * postSize,
        h: top - fall - g + 0.05, kind: postKind, colour: postColour, small: postSize < 0.2 });
    }
  };
  const storey = Math.min(wall.height, 3.0);
  const eave = wall.base + storey - 0.25;
  if (name === 'Victorian terrace' || name === 'Millers Point terrace') {
    if (yard < 2.4) return;
    const iron = roll(40) < 0.5;
    roofed(0.1, wall.width - 0.1, 1.8, eave, 0.35, THING.paint, iron ? lin(0x1d1f20) : lin(0xf0ede4), 0.1, pick(IRON_ROOFS, 41));
  } else if (name === 'Federation') {
    if (yard < 2.6) return;
    const span = wall.width * 0.62;
    const [s0, s1] = doorS < wall.width / 2 ? [0.1, span] : [wall.width - span, wall.width - 0.1];
    roofed(s0, s1, 2.0, eave, 0.4, THING.paint, lin(0xf2efe6), 0.12, pick(IRON_ROOFS, 42));
  } else if (name === 'California bungalow') {
    if (yard < 2.8) return;
    roofed(doorS - 1.8, doorS + 1.8, 2.2, eave, 0.25, THING.brick, pick(BRICKS[name], 43), 0.45, lin([0x8a3a2a, 0x6e3a2e, 0x7a4a3a][Math.floor(roll(44) * 3)]));
  } else if (name === 'Post-war fibro') {
    if (yard < 1.8 || !entry) return;
    roofed(doorS - 0.95, doorS + 0.95, 1.2, wall.base + 2.45, 0.05, THING.paint, lin(0xe8e6e0), 0.06, pick(COLORBOND, 45));
  } else if (name === 'Beach house') {
    if (yard < 3.2) return;
    const s0 = Math.max(0.2, doorS - wall.width * 0.3), s1 = Math.min(wall.width - 0.2, doorS + wall.width * 0.3);
    const corners = [wall.at(s0, 2.4), wall.at(s1, 2.4)];
    if (s1 - s0 < 2 || !corners.every((p) => inRing(lot.pts, p.x, p.z)) || blocked(corners)) return;
    const c = wall.at((s0 + s1) / 2, 1.2), g = Math.min(...[...corners, c].map((p) => ground(p.x, p.z)));
    const top = Math.max(wall.base - 0.05, g + 0.3);
    out.boxes.push({ x: c.x, y: g - 0.05, z: c.z, ax: wall.ux * (s1 - s0), ay: 0, az: wall.uz * (s1 - s0), bx: wall.ox * 2.4, by: 0, bz: wall.oz * 2.4,
      h: top - g + 0.05, kind: THING.boards, colour: lin(0x8a6a4c) });
  }
}

/** Front fence panels between p and q, each level and no longer than a panel, standing on the ground as the side fences do */
function panelsAlong(panels, p, q, height, kind, colour, roll, env) {
  const L = Math.hypot(q.x - p.x, q.z - p.z), n = Math.ceil(L / PANEL);
  const ux = (q.x - p.x) / L, uz = (q.z - p.z) / L;
  const ground = [];
  for (let k = 0; k <= n; k++) ground.push(env.groundAt(p.x + (ux * L * k) / n, p.z + (uz * L * k) / n) + LAWN_TOP);
  for (let k = 0; k < n; k++) {
    const g0 = ground[k], g1 = ground[k + 1];
    const bottom = Math.min(g0, g1) - 0.06, top = (g0 + g1) / 2 + height;
    const s = (L * (k + 0.5)) / n;
    panels.push({ x: p.x + ux * s, z: p.z + uz * s, y: bottom, height: top - bottom, length: L / n, ux, uz, kind, colour, roll });
  }
}

export { FENCE, THING, lotThings };
