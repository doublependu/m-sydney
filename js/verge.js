import { ROAD_CLASS } from './surfaces.js';
import { HOUSE_STYLES } from './house-styles.js';

// The verge along a street of houses: a nature strip of lawn from the kerb, most often with a footpath in it, in place of the 3.5 m of
// paving the map lays along every kerb (tools/geodata/region-worker.mjs). Drawn over that paving, exactly on its triangles as drawn, so
// it can't come up through it or sink into it on a slope: each piece is cut to each paving triangle under it and laid in that
// triangle's plane, VERGE_LIFT over it.
// - Which sides: each side of a residential, unclassified or living street, from one junction to the next (its links joined where only
//   two meet), whose buildings (those that front it: js/street-front.js) are all houses, at least two, over enough of its length, not
//   mostly terraces nor built up to the footpath. Anything else keeps the paving: shops, flats, schools, parks, nothing. So does the
//   inner city, which the map paves right through.
// - Across it, from the kerb: its ledge, a lawn LAWN m wide, a footpath PATH m wide, and lawn on to past where the front yards' lawns
//   start, under them. A side with no footpath is lawn all the way.
// - Footpath or not: by the street's name, most streets having one, more of the older streets and the project homes' estates than the
//   post-war ones; now and then only one side.
// - It stops short of every junction, where the corner's paving takes over, and leaves the paving round each driveway's crossover and
//   each bus stop.
// - The footpath is laid on the front yards' lawn too, where that comes out over it, so the lawn never covers it.
// - The crowd walks along the footpath, or along the lawn's middle where there's none (walkLine(), js/pedestrian-routes.js).
// - A house's frontage with none of the map's trees on its strip gets one, now and then two, in the lawn's middle, clear of its
//   crossover, of the species of the street trees round it (js/street-details.js plants them in the tree field).

const STRIP_CLASSES = new Set([ROAD_CLASS.residential, ROAD_CLASS.unclassified, ROAD_CLASS.living_street]);
const LEDGE = 0.3; // m: the kerb's top, left as it is (js/ground-geometry.js addCurb())
const OUTER = 4.0; // m from the kerb that the strip's lawn reaches, under the front yards' lawn from where that starts
const VERGE_LIFT = 0.01; // m over the paving as drawn (and the footpath over the lawn, where it's laid on that)
const PAVING_TOP = 0.22; // m: the paving over the ground's triangles (js/ground-geometry.js SIDEWALK_TOP)
const LAWN_TOP = 0.24; // m: the lawn's (js/city-grid.js)
const STATION = 9; // m at most between the points a strip is drawn through, and at each bend of its street's line
const KERB_JUMP = 0.5; // m: where the kerb steps further than this between two points, no strip between them
const CHUNK = 24; // m of strip in each piece that's drawn or not by how far it is from you
const COVER = 0.35; // of a side's length that its houses' frontages must take up
// How often a street has a footpath, by its houses' styles
const PATH_SHARE = { 'Victorian terrace': 0.95, Federation: 0.95, 'California bungalow': 0.92, 'Post-war fibro': 0.55,
  'Triple-fronted brick veneer': 0.65, 'Project home': 0.95, 'Beach house': 0.6, 'Millers Point terrace': 0.95 };
const ONE_SIDE = 0.15; // of the streets with a footpath, those with it on one side only
const TREE_SPACING = 7; // m: an added tree keeps this far from any other
const CROSSOVER_CLEAR = 1.2; // m an added tree keeps from a crossover's side

const hashOf = (n) => {
  let h = Math.imul(n | 0, 0x9e3779b1) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const hashText = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h | 0;
};

// --- Geometry ------------------------------------------------------------------------------------------------------------------

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

/**
 * A flat piece (a ring in x, z) laid on triangles ([[x, y, z] x 3], from js/garden.js trianglesIn()), `lift` over them: the part of it over
 * each triangle, in that triangle's plane, as triangles facing up, pushed onto `out` as x, y, z, each relative to (ox, oz)
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
      const poly = clipConvex([{ x: a[0], z: a[2] }, { x: b[0], z: b[2] }, { x: c[0], z: c[2] }], piece);
      if (poly.length < 3) continue;
      // The triangle's plane: y = a + gx (x - ax) + gz (z - az)
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const den = ux * vz - uz * vx;
      if (Math.abs(den) < 1e-9) continue;
      const gx = (uy * vz - uz * vy) / den, gz = (ux * vy - uy * vx) / den;
      const y = (p) => a[1] + gx * (p.x - a[0]) + gz * (p.z - a[2]) + lift;
      const up = areaOf(poly) >= 0;
      for (let i = 1; i + 1 < poly.length; i++) {
        const tri = up ? [poly[0], poly[i], poly[i + 1]] : [poly[0], poly[i + 1], poly[i]];
        // Slivers left by the clipping add nothing
        if (Math.abs(areaOf(tri)) < 1e-6) continue;
        for (const p of tri) out.push(p.x - ox, y(p), p.z - oz);
        n++;
      }
    }
  }
  return n;
}

// --- Streets as stretches between junctions ------------------------------------------------------------------------------------

/**
 * The stretches of street a strip can run along: residential, unclassified and living streets on the ground, links joined where just two
 * meet. Each: { parts: [{ link, forward }], pts, start, end (their nodes), degree at each end, and where along it each point is }
 */
function stretchesOf(links) {
  const at = new Map();
  for (const l of links) for (const n of [l.a, l.b]) (at.get(n) || at.set(n, []).get(n)).push(l);
  const ok = (l) => STRIP_CLASSES.has(l.cls);
  const onward = (n, l) => {
    const here = at.get(n) || [];
    return here.length === 2 && here.every(ok) ? here.find((o) => o !== l) : null;
  };
  const used = new Set(), out = [];
  const walk = (n, first) => {
    const parts = [];
    let link = first, node = n;
    while (link && !used.has(link)) {
      used.add(link);
      const forward = link.a === node;
      parts.push({ link, forward });
      node = forward ? link.b : link.a;
      link = onward(node, link);
    }
    return { parts, start: n, end: node };
  };
  const starts = [...at.keys()].filter((n) => {
    const here = at.get(n);
    return here.length !== 2 || !here.every(ok);
  });
  for (const n of starts) for (const l of at.get(n)) if (ok(l) && !used.has(l)) out.push(walk(n, l));
  for (const l of links) if (ok(l) && !used.has(l)) out.push(walk(l.a, l));
  for (const s of out) {
    s.pts = [];
    for (const { link, forward } of s.parts) {
      const pts = forward ? link.pts : [...link.pts].reverse();
      for (const p of pts) {
        const last = s.pts[s.pts.length - 1];
        if (!last || Math.hypot(p.x - last.x, p.z - last.z) > 0.01) s.pts.push({ x: p.x, z: p.z, link });
      }
    }
    s.at = [0];
    for (let i = 1; i < s.pts.length; i++) s.at.push(s.at[i - 1] + Math.hypot(s.pts[i].x - s.pts[i - 1].x, s.pts[i].z - s.pts[i - 1].z));
    s.length = s.at[s.at.length - 1];
    s.links = new Set(s.parts.map((p) => p.link));
    s.ends = [s.start, s.end].map((n) => at.get(n) || []);
  }
  return out.filter((s) => s.pts.length > 1 && s.length > 1);
}

/** Where (x, z) is along a stretch: { s, d }, d its offset to the left of the way the stretch runs */
function along(st, x, z) {
  let best = null;
  for (let i = 1; i < st.pts.length; i++) {
    const p = st.pts[i - 1], q = st.pts[i];
    const L = st.at[i] - st.at[i - 1];
    if (L < 1e-6) continue;
    const ux = (q.x - p.x) / L, uz = (q.z - p.z) / L;
    const t = Math.max(0, Math.min(L, (x - p.x) * ux + (z - p.z) * uz));
    const px = p.x + ux * t, pz = p.z + uz * t, dist = Math.hypot(x - px, z - pz);
    if (!best || dist < best.dist) best = { s: st.at[i - 1] + t, d: -(x - px) * uz + (z - pz) * ux, dist };
  }
  return best;
}

/** The point s along a stretch, and its way along (averaged over a bend, so a strip keeps its width round it) */
function pointAt(st, s) {
  let i = 1;
  while (i < st.pts.length - 1 && st.at[i] < s) i++;
  const p = st.pts[i - 1], q = st.pts[i], L = st.at[i] - st.at[i - 1] || 1;
  const t = Math.max(0, Math.min(1, (s - st.at[i - 1]) / L));
  let ux = (q.x - p.x) / L, uz = (q.z - p.z) / L;
  // At a point of the line itself, the mean of its two segments' ways
  const blend = (j) => {
    const a = st.pts[j - 1], b = st.pts[j], c = st.pts[j + 1];
    const l1 = Math.hypot(b.x - a.x, b.z - a.z) || 1, l2 = Math.hypot(c.x - b.x, c.z - b.z) || 1;
    const mx = (b.x - a.x) / l1 + (c.x - b.x) / l2, mz = (b.z - a.z) / l1 + (c.z - b.z) / l2, ml = Math.hypot(mx, mz) || 1;
    return { ux: mx / ml, uz: mz / ml };
  };
  if (t < 1e-3 && i > 1) ({ ux, uz } = blend(i - 1));
  else if (t > 1 - 1e-3 && i < st.pts.length - 1) ({ ux, uz } = blend(i));
  return { x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t, ux, uz, link: (t < 0.5 ? p : q).link || q.link };
}

/** How far short of each end a strip stops: past the corner where another street meets it, a little at a dead end */
function endTrim(ends, link, corner) {
  if (ends.length >= 3) return Math.max(...ends.filter((o) => o !== link).map((o) => o.width / 2)) + 0.4 + corner + 1.0;
  return ends.length <= 1 ? 2 : 1;
}

// --- The verge of a square ------------------------------------------------------------------------------------------------------

/**
 * The verges along the streets of a square of the map. `fronting`: [{ street ({ x, z, link }), house (its style, 0 for no house),
 * terrace, yard (m from its kerb to its front line), frontage ([x, z] x 2: its front's ends, on its front line), lot }], every building
 * near the square that faces a street and bounds a lot (js/house-lots.js), with its lot where that's worked out (for its crossover:
 * lot.drive and lot.frame). `env`: links (the roads on the ground), kerbFrom (as js/house-lots.js has it), pavingTris and lawnTris
 * (js/garden.js trianglesIn()), busStops ([{ x, z }]), trees ({ near(x, z, r) => [{ x, z, species }], species }: the map's), corner (m:
 * a junction's kerb's radius), paved(x, z) (whether that's where the map paves the islands right through, so no lawns). Yields as it goes. Returns { sides, lawn, path, trees }: each side looked at ({ x, z, length, strip, path }),
 * the pieces to draw ({ x, z, pos }: triangles x, y, z from (x, z)), and the trees added ({ x, z, species, scale }), those in the square.
 */
function* squareVerge(fronting, env, square) {
  const owns = (x, z) => x >= square.x0 && x < square.x1 && z >= square.z0 && z < square.z1;
  const stretches = stretchesOf(env.links);
  yield;
  // Each building onto the stretch and side it fronts
  const byLink = new Map();
  for (const st of stretches) for (const p of st.parts) byLink.set(p.link, st);
  const onto = new Map(); // stretch -> { [-1]: [], [1]: [] }
  for (const f of fronting) {
    const st = byLink.get(f.street.link);
    if (!st) continue;
    const a = along(st, f.street.x, f.street.z), w = along(st, f.cx, f.cz);
    if (!a || !w) continue;
    const side = w.d >= 0 ? 1 : -1;
    const span = f.frontage.map(([x, z]) => along(st, x, z).s);
    (onto.get(st) || onto.set(st, { [-1]: [], [1]: [] }).get(st))[side].push({ ...f, s0: Math.min(...span), s1: Math.max(...span) });
  }
  yield;
  const sides = [], lawn = [], path = [], trees = [], walks = [];
  let work = 0;
  for (const st of stretches) {
    const mid = pointAt(st, st.length / 2);
    // Only the stretches that come into the square, within its margin
    let inside = false;
    for (const p of st.pts) if (owns(p.x, p.z)) { inside = true; break; }
    if (!inside) {
      for (let s = 0; s < st.length && !inside; s += STATION) { const p = pointAt(st, s); inside = owns(p.x, p.z); }
    }
    if (!inside) continue;
    const trimA = endTrim(st.ends[0], st.parts[0].link, env.corner), trimB = endTrim(st.ends[1], st.parts[st.parts.length - 1].link, env.corner);
    const from = trimA, to = st.length - trimB;
    const name = st.parts[0].link.name || `#${st.parts[0].link.id}`;
    // The inner city keeps its paving: it has no front lawns to run on to
    if (env.paved?.(mid.x, mid.z)) {
      for (const side of [1, -1]) sides.push({ x: mid.x, z: mid.z, length: Math.max(0, to - from), strip: false, path: false, side, name, why: 'inner city' });
      continue;
    }
    const front = onto.get(st) || { [-1]: [], [1]: [] };
    // The street's footpath, by its name: the share its houses' era has
    const roll = hashOf(hashText(name)), roll2 = hashOf(hashText(name) ^ 0x51ed27);
    const look = (side) => {
      const list = front[side];
      const houses = list.filter((f) => f.house), others = list.length - houses.length;
      // How much of the side its houses take up, each with a little of its yard either side
      const spans = houses.map((f) => [Math.max(from, f.s0 - 3), Math.min(to, f.s1 + 3)]).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
      let covered = 0, at = -Infinity;
      for (const [a, b] of spans) { covered += Math.max(0, b - Math.max(a, at)); at = Math.max(at, b); }
      const terraces = houses.filter((f) => f.terrace).length;
      const yard = houses.length ? houses.reduce((t, f) => t + f.yard, 0) / houses.length : 0;
      const why = to - from <= 8 ? 'short' : others ? 'not all houses' : houses.length < 2 ? 'no houses' : covered < COVER * (to - from) ? 'few houses'
        : terraces * 2 >= houses.length ? 'terraces' : yard < 2.5 ? 'built to the footpath' : null;
      return { houses, others, strip: !why, why };
    };
    const left = look(1), right = look(-1);
    // The era the street's houses are mostly of decides how likely its footpath is
    const count = new Map();
    for (const f of [...left.houses, ...right.houses]) count.set(f.house, (count.get(f.house) || 0) + 1);
    const era = [...count].sort((p, q) => q[1] - p[1])[0]?.[0];
    const share = PATH_SHARE[HOUSE_STYLES[era]?.name] ?? 0.75;
    const has = roll < share;
    const oneSide = has && roll2 < ONE_SIDE ? (roll2 < ONE_SIDE / 2 ? 1 : -1) : 0;
    const widths = { lawn: 1.6 + 0.4 * hashOf(hashText(name) ^ 0x2c1b3c), path: 1.2 + 0.3 * hashOf(hashText(name) ^ 0x7f4a7c) };
    if (widths.lawn + widths.path > OUTER - 0.7) widths.lawn = OUTER - 0.7 - widths.path;
    for (const [side, info] of [[1, left], [-1, right]]) {
      const withPath = has && oneSide !== side;
      sides.push({ x: mid.x, z: mid.z, length: Math.max(0, to - from), strip: info.strip, path: info.strip && withPath, side, name, why: info.why });
      if (!info.strip) continue;
      // Where the paving stays: each crossover, each bus stop
      const cuts = [];
      for (const f of info.houses) {
        const d = f.lot?.drive, fr = f.lot?.frame;
        if (!d) continue;
        const w = d.w + 0.6;
        const s = [-1, 1].flatMap((k) => [f.lot.kerb - 0.6, f.lot.front + 0.1].map((dd) => {
          const x = fr.px + fr.tx * (d.a + (k * w) / 2) + fr.nx * dd, z = fr.pz + fr.tz * (d.a + (k * w) / 2) + fr.nz * dd;
          return along(st, x, z).s;
        }));
        cuts.push([Math.min(...s) - 0.05, Math.max(...s) + 0.05]);
      }
      for (const b of env.busStops) {
        const a = along(st, b.x, b.z);
        if (a && a.dist < 20 && (a.d * side > -1)) cuts.push([a.s - 8, a.s + 8]);
      }
      const cutAt = (s) => cuts.some(([a, b]) => s > a && s < b);
      // Its points: every STATION m, and at each cut's ends
      const marks = new Set();
      for (let s = from; s < to; s += STATION) marks.add(+s.toFixed(3));
      for (let i = 1; i < st.pts.length - 1; i++) {
        const a = st.pts[i - 1], p = st.pts[i], q = st.pts[i + 1];
        const turn = Math.abs(Math.atan2(q.z - p.z, q.x - p.x) - Math.atan2(p.z - a.z, p.x - a.x)) % (2 * Math.PI);
        if (Math.min(turn, 2 * Math.PI - turn) > 0.08 && st.at[i] > from && st.at[i] < to) marks.add(+st.at[i].toFixed(3));
      }
      marks.add(+to.toFixed(3));
      for (const [a, b] of cuts) for (const s of [a, b]) if (s > from && s < to) marks.add(+s.toFixed(3));
      const stations = [...marks].sort((p, q) => p - q).map((s) => {
        const p = pointAt(st, s);
        const nx = -p.uz * side, nz = p.ux * side, half = p.link.width / 2;
        const k = env.kerbFrom(p.x, p.z, nx, nz, half + 6, p.x + nx * (half + 2), p.z + nz * (half + 2));
        return { s, x: p.x, z: p.z, nx, nz, k };
      });
      // Where the crowd walks along it: two lines either side of the footpath's middle, or of the lawn's where there's none
      const ks = stations.map((p) => p.k).filter((k) => k != null).sort((p, q) => p - q);
      if (ks.length) {
        const k = ks[ks.length >> 1];
        walks.push({ links: new Set(st.parts.map((p) => p.link.id)), side, st, from, to, middle: k + (withPath ? widths.lawn + widths.path / 2 : (LEDGE + OUTER - 0.5) / 2) });
      }
      const bands = withPath
        ? [['lawn', LEDGE, widths.lawn], ['path', widths.lawn, widths.lawn + widths.path], ['lawn', widths.lawn + widths.path, OUTER]]
        : [['lawn', LEDGE, OUTER]];
      let chunk = null;
      const flush = () => {
        if (chunk && chunk.lawn.length + chunk.path.length) {
          if (chunk.lawn.length) lawn.push({ x: chunk.x, z: chunk.z, pos: new Float32Array(chunk.lawn) });
          if (chunk.path.length) path.push({ x: chunk.x, z: chunk.z, pos: new Float32Array(chunk.path) });
        }
        chunk = null;
      };
      for (let i = 1; i < stations.length; i++) {
        const a = stations[i - 1], b = stations[i];
        const m = (a.s + b.s) / 2;
        if (a.k == null || b.k == null || Math.abs(a.k - b.k) > KERB_JUMP || cutAt(m) || !owns((a.x + b.x) / 2, (a.z + b.z) / 2)) { flush(); continue; }
        if (!chunk || m - chunk.s > CHUNK) {
          flush();
          chunk = { s: a.s, x: Math.round(a.x), z: Math.round(a.z), lawn: [], path: [] };
        }
        const at = (p, d) => ({ x: p.x + p.nx * (p.k + d), z: p.z + p.nz * (p.k + d) });
        for (const [kind, d0, d1] of bands) {
          const ring = [at(a, d0), at(b, d0), at(b, d1), at(a, d1)];
          let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
          for (const p of ring) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
          const target = kind === 'path' ? chunk.path : chunk.lawn;
          drape(ring, env.pavingTris(x0, z0, x1, z1), PAVING_TOP + VERGE_LIFT, target, chunk.x, chunk.z);
          // Where a front yard's lawn comes out over the footpath, the footpath over it too
          if (kind === 'path') drape(ring, env.lawnTris(x0, z0, x1, z1), LAWN_TOP + VERGE_LIFT, target, chunk.x, chunk.z);
        }
        if (++work % 24 === 0) yield;
      }
      flush();
      // Trees on the strip: for each house frontage in the square with none of the map's on its strip, one in the lawn's middle (two on a
      // wide one), clear of its crossover
      const middle = withPath ? (LEDGE + widths.lawn) / 2 : 1.2;
      const kerbAt = (s) => {
        let best = null;
        for (const p of stations) if (p.k != null && (!best || Math.abs(p.s - s) < Math.abs(best.s - s))) best = p;
        return best && Math.abs(best.s - s) < STATION ? best.k : null;
      };
      for (const f of info.houses) {
        if (!owns(f.street.x, f.street.z)) continue;
        const s0 = Math.max(from + 1, f.s0), s1 = Math.min(to - 1, f.s1);
        if (s1 - s0 < 4) continue;
        const pa = pointAt(st, (s0 + s1) / 2);
        const near = env.trees.near(pa.x, pa.z, (s1 - s0) / 2 + 10);
        const onStrip = near.some((t) => {
          const w = along(st, t.x, t.z);
          return w && w.s > s0 - 1 && w.s < s1 + 1 && w.d * side > 0 && Math.abs(w.d) < pa.link.width / 2 + OUTER + 1.5;
        });
        if (onStrip) continue;
        const want = s1 - s0 >= 16 && hashOf(hashText(name) ^ Math.round(s0 * 10)) < 0.35 ? 2 : 1;
        for (let j = 0; j < want; j++) {
          let s = s0 + ((s1 - s0) * (j + 1)) / (want + 1);
          if (cutAt(s) || cuts.some(([a, b]) => s > a - CROSSOVER_CLEAR && s < b + CROSSOVER_CLEAR)) {
            // Beside the crossover, on whichever side has room
            const c = cuts.find(([a, b]) => s > a - CROSSOVER_CLEAR && s < b + CROSSOVER_CLEAR);
            const options = [c[0] - CROSSOVER_CLEAR - 0.5, c[1] + CROSSOVER_CLEAR + 0.5].filter((v) => v > s0 && v < s1 && !cutAt(v)
              && !cuts.some(([a, b]) => v > a - CROSSOVER_CLEAR && v < b + CROSSOVER_CLEAR));
            if (!options.length) continue;
            s = options.sort((p, q) => Math.abs(p - s) - Math.abs(q - s))[0];
          }
          const k = kerbAt(s);
          if (k == null) continue;
          const p = pointAt(st, s);
          const x = p.x - p.uz * side * (k + middle), z = p.z + p.ux * side * (k + middle);
          if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < TREE_SPACING)) continue;
          if (near.some((t) => Math.hypot(t.x - x, t.z - z) < TREE_SPACING)) continue;
          const r = hashOf(Math.round(x * 10) * 73856093 ^ Math.round(z * 10) * 19349663);
          trees.push({ x, z, species: env.trees.species(x, z, r), scale: 0.45 + 0.25 * r, along: { ux: p.ux, uz: p.uz } });
        }
      }
    }
  }
  return { sides, lawn, path, trees, walks };
}

/**
 * How far from its street's middle line the crowd walks along a verge at (x, z), where a link of that street (its id) has one; or null.
 * `walks`: squareVerge()'s.
 */
function walkLine(walks, link, x, z) {
  for (const w of walks) {
    if (!w.links.has(link)) continue;
    const a = along(w.st, x, z);
    if (a && a.d * w.side > 0 && a.s >= w.from && a.s <= w.to && a.dist < w.middle + 4) return w.middle;
  }
  return null;
}

export { LEDGE, OUTER, PAVING_TOP, STRIP_CLASSES, VERGE_LIFT, along, clipConvex, drape, squareVerge, stretchesOf, walkLine };
