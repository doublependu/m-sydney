import { HOUSE_STYLES } from './house-styles.js';
import { houseEntry } from './house-entry.js';

// The lots of houses, worked out from the map: it has the houses and the streets, not the property lines. For each house (a building whose
// style has a look, js/house-styles.js, or a building of several pieces with one) that has a street within 60 m:
// - Its front road is the street its walls face (js/street-front.js), and its front line is where the paving meets the lawn: the kerb,
//   found where its kerb island starts, past any median, and FOOTPATH past that (tools/geodata/region-worker.mjs paves that much).
// - Its neighbours are the nearest buildings beside it along its road and behind it, within its depth or its width. A building of
//   another use bounds a lot too; a small one (a shed, a garage) is inside one; so does a model's site (js/model-sites.js), which has no
//   lot of its own. A pair is a pair if either chose the other, and between them is one line, the same for both: square to whichever of
//   their roads' ways shows the widest gap between them, halfway across it. Side by side on a street, that's square to the street; back to
//   back, along it; round a corner, both at once.
// - Its lot is what's behind its front line and on its side of each of those lines, no more than BACK_MOST behind it, and kept off every
//   other road's footpath: a corner lot's side runs along the side street's front line, and a lot with a lane behind stops at the lane's.
// - Lots don't overlap: any house, building or site (as above) that a lot covers OVERLAP m² of becomes a pair with its house, and so do
//   two houses whose lots overlap, each pair with its line; then the lots again, ROUNDS times at most. Two outlines that run into each
//   other by TOUCH or less (a shared wall) still have a line between them; a pair that no straight line separates (an L-shaped neighbour
//   round a house, outlines over each other) adds none, and what its lots cover is left to the fences' cut.
// - Its car: a driveway up a side gap of DRIVE_GAP or more (the wider, or the one a shed or garage of the map's stands behind), to just
//   past the front wall or to the shed; a project home's to the garage door in its front wall (js/house-entry.js); none for a terrace.
//   A crossover from the kerb to the front line, and a layback over the kerb.
// - Its fences: along every side of its lot but the front, from FENCE_BACK behind the front line, where the gap is NO_FENCE or more;
//   never through a building or into a model's site, nor on the footpath (off the lawn as drawn, or in the inner city, which is paved
//   right through, within the footpath's width of the kerb). A corner house standing over its side street's line has its fence along that
//   street only behind it, from its back wall; one over a road's line behind it, the fence either side of it, up to its walls.
// Where a house has its real lot (NSW's cadastre, fitted to the map's houses by tools/build-lots.mjs: js/real-lots.js), that's its lot
// instead, how the file says it fits:
// - A house in its lot, or with a line moved for it, or standing on two lots or more (a pair or a row the map drew as one): its lots,
//   put together, cut off at its front line, which stays the map's. Where the real frontage on its street is a little behind that, the
//   lot is brought forward to it, so the front yard is the lot's. Its other frontages are fenced as a road's side is.
// - Its fences: along every side but the front, from FENCE_BACK behind the front line, each line between two lots once; along a line
//   that's a shared wall (between two lots one house stands on, or two houses drawn into each other), only behind the house, from where
//   the line leaves its back wall; a row of terraces keeps its facade's cut between its houses instead (rowFences()). A line through
//   another house (one the file couldn't fit, or one standing in a lot) stops at it, on its longer side; a house built to its boundary
//   meets it. Nothing further than RURAL_REACH from the house.
// - Its driveway: up the side gap, as above, or up its handle where its lot is set behind another's (the land in front of the house
//   is the other lot's).
// - A house that stands in another house's lot (a granny flat, a shed the map styles as a house) has no lot of its own.
// - Several houses on one lot (a strata scheme, a block on one big lot): each its lot as above, within the real lot, and with only the
//   lot's own houses for neighbours.
// - A house the file can't fit (one well over another's lot, or on no lot), or with no file, has its lot as above, kept off the real lots
//   round it: cut along the line of each one it covers, the one that leaves it most.
// - A house with a real lot and no street near (in the bush, say) has its lot's fences, and no front, driveway or things.
// Everything is in steps (a generator, as js/buildings.js addBuildings() is), a square of the map at a time, near you (js/lot-details.js).

const FOOTPATH = 3.5; // m paved from the kerb before the lawn
const KERB_PAST = 0.4; // m a kerb stands past its road's edge, give or take, where the island can't be found
const FENCE_BACK = 2; // m behind the front line that the side fences start, so front yards are open
const ROAD_INSET = 0.3; // m inside another road's front line that a lot stops, so a fence along it stands clear of the footpath
const NO_FENCE = 1.2; // m: houses closer than this are joined, or nearly
const BACK_MOST = 25; // m a lot reaches behind its house, at most
const DRIVE_GAP = 3.0; // m beside a house for a driveway
const DRIVE_PAST = 4; // m past the front wall that a driveway runs, beside the house
const PARTNER_AREA = 80; // m²: a building of no house's this big bounds a lot; anything smaller stands in one, as a shed does
const OVERLAP = 1; // m² of a building or another lot that a lot covers, for the two to be a pair
const ROUNDS = 4; // times the lots are worked out, at most, with the pairs their overlaps add
const TOUCH = 2; // m two buildings' outlines can run into each other, each up to half that over the line between them: a shared wall, outlines traced over each other
const SHED = 4; // the map's kind of building (js/tiles/tile-file.js)
const NEAR = 45; // m: neighbours, and roads, within this of a house's middle
const PANEL = 2.4; // m: a fence's panels, each level, so a fence steps down a slope
const FENCE_HEIGHT = 1.8; // m
const LAWN_TOP = 0.24; // m over the ground: the lawn as js/city-grid.js draws it (SIDEWALK_TOP + 0.02)
const PAVING_TOP = 0.22; // m: the footpath's
const SLAB = 0.015; // m a driveway lies over the lawn
const CROSSOVER = 0.03; // m a crossover lies over the footpath
const SLAB_PIECE = 3; // m: driveways in pieces this long, each laid on the lawn under it
const RURAL_REACH = 60; // m round a house that its real lot's fences reach, at most: a rural lot's run for hundreds of metres
const FRONT_SLACK = 3; // m behind the front line that a real lot's frontage on its street may be, for the lot to be brought forward to it
const WALL_IN = 1; // m of a real lot's side line inside houses for it to be a shared wall, fenced only behind them
const IN_LINE = 0.3; // m a house may stand over a real line and be on it, built to its boundary (as tools/lots/fit.mjs has a house in its lot)
const OVERSHOOT = 0.5; // m of its house that a lot worked out from the map may leave beyond the line of a real lot it's kept off

// The house styles from after the war on have Colorbond between them; older ones timber palings
const COLORBOND_STYLES = new Set(['Post-war fibro', 'Triple-fronted brick veneer', 'Project home', 'Beach house']);
const STRIP_STYLES = new Set(['Federation', 'California bungalow', 'Post-war fibro']); // two wheel strips on some of their driveways

const hashOf = (n) => {
  let h = Math.imul(n | 0, 0x9e3779b1) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const keyOf = (x, z) => Math.round(x * 2) * 73856093 ^ Math.round(z * 2) * 19349663;

// --- Geometry ------------------------------------------------------------------------------------------------------------------

/** The part of polygon `poly` ([{ x, z, tag }], tag naming the edge from that point to the next) where a * x + b * z + c <= 0 */
function clipHalf(poly, a, b, c, tag) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const fp = a * p.x + b * p.z + c, fq = a * q.x + b * q.z + c;
    if (fp <= 0) out.push(p);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
      const t = fp / (fp - fq);
      // Leaving: the edge from here runs along the line. Coming in: it's the rest of the edge it came in on.
      out.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t, tag: fp < 0 ? tag : p.tag });
    }
  }
  return out;
}

function inRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
  return Math.abs(a / 2);
}

/** The area of ring `subject` inside convex ring `clip` (either way round) */
function areaInside(subject, clip) {
  let out = subject;
  const s = Math.sign(ringSigned(clip));
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const inp = out;
    out = [];
    for (let k = 0; k < inp.length; k++) {
      const p = inp[k], q = inp[(k + 1) % inp.length];
      const sp = s * ((b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x)), sq = s * ((b.x - a.x) * (q.z - a.z) - (b.z - a.z) * (q.x - a.x));
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t }); }
    }
  }
  return out.length < 3 ? 0 : ringArea(out);
}
function ringSigned(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
  return a / 2;
}

const boxOf = (pts) => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
  }
  return { x0, x1, z0, z1 };
};

/** The least and most of points' projections on (ux, uz) */
function span(pts, ux, uz) {
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) {
    const v = p.x * ux + p.z * uz;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/** Where along a segment from p to q (0-1) it's inside `rings`, each a closed ring, as sorted [t0, t1] spans */
function insideSpans(p, q, rings) {
  const spans = [];
  for (const ring of rings) {
    const ts = [0, 1];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i];
      const rx = q.x - p.x, rz = q.z - p.z, sx = b.x - a.x, sz = b.z - a.z;
      const den = rx * sz - rz * sx;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((a.x - p.x) * sz - (a.z - p.z) * sx) / den, u = ((a.x - p.x) * rz - (a.z - p.z) * rx) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    for (let k = 1; k < ts.length; k++) {
      const m = (ts[k - 1] + ts[k]) / 2;
      if (ts[k] - ts[k - 1] > 1e-9 && inRing(ring, p.x + (q.x - p.x) * m, p.z + (q.z - p.z) * m)) spans.push([ts[k - 1], ts[k]]);
    }
  }
  return spans;
}

/** What's left of [0, 1] once `gone` ([t0, t1] spans) is taken out */
function keptSpans(gone) {
  gone.sort((a, b) => a[0] - b[0]);
  const kept = [];
  let at = 0;
  for (const [t0, t1] of gone) {
    if (t0 > at) kept.push([at, t0]);
    at = Math.max(at, t1);
  }
  if (at < 1) kept.push([at, 1]);
  return kept;
}

/** The convex hull of points */
function convexHull(points) {
  const pts = [...points].sort((p, q) => p.x - q.x || p.z - q.z);
  if (pts.length < 3) return pts;
  const cross = (o, p, q) => (p.x - o.x) * (q.z - o.z) - (p.z - o.z) * (q.x - o.x);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

const pointOn = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });

/** How far rings stand over the line from a to b on their lesser side, within its length: 0 where they're all on one side */
function overLine(rings, a, b) {
  const L = Math.hypot(b.x - a.x, b.z - a.z), ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
  let left = 0, right = 0;
  for (const ring of rings) {
    for (const p of ring) {
      const t = (p.x - a.x) * ux + (p.z - a.z) * uz;
      if (t < 0 || t > L) continue;
      const d = (p.x - a.x) * uz - (p.z - a.z) * ux;
      if (d > left) left = d;
      if (-d > right) right = -d;
    }
  }
  return Math.min(left, right);
}

/** Where along a segment from a to b (0-1) it's within box { x0, x1, z0, z1 }: [t0, t1], or null */
function spanInBox(a, b, box) {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dz = b.z - a.z;
  for (const [p, q] of [[-dx, a.x - box.x0], [dx, box.x1 - a.x], [-dz, a.z - box.z0], [dz, box.z1 - a.z]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

// --- Real lots (js/real-lots.js) -------------------------------------------------------------------------------------------------

const vertexKey = (p) => `${Math.round(p.x * 100)},${Math.round(p.z * 100)}`;

/** A real lot's outer rings (counter-clockwise, as js/tiles/lot-file.js has them), each point with its edge's kind and line */
function outerRings(lot) {
  const out = [];
  lot.rings.forEach((ring, r) => {
    if (ringSigned(ring) <= 0) return;
    out.push(ring.map((p, i) => ({ x: p.x, z: p.z, kind: lot.edges[r][i], line: lot.lines[r][i] })));
  });
  return out;
}

/** Of rings, the one that holds (x, z), or else the biggest */
function ringAt(rings, x, z) {
  return rings.find((r) => inRing(r, x, z)) || rings.reduce((best, r) => (!best || ringArea(r) > ringArea(best) ? r : best), null);
}

/**
 * The lots one house stands on, put together: { ring, walls }, the ring round them all that holds its middle (x, z) (or the biggest),
 * and the edges they share, each once ({ a, b, kind, line }). Their shared edges are the same corners both ways round (js/real-lots.js),
 * so what's left of their edges once those are taken out goes round them. Null where it doesn't come out as rings.
 */
function lotsTogether(lots, x, z) {
  const rings = lots.flatMap(outerRings);
  if (lots.length === 1) return rings.length ? { ring: ringAt(rings, x, z), walls: [] } : null;
  const edges = [];
  for (const ring of rings) ring.forEach((a, i) => edges.push({ a, b: ring[(i + 1) % ring.length], ka: vertexKey(a), kb: vertexKey(ring[(i + 1) % ring.length]) }));
  const forward = new Set(edges.map((e) => `${e.ka}|${e.kb}`));
  const walls = [], from = new Map();
  for (const e of edges) {
    if (e.ka === e.kb) continue;
    if (forward.has(`${e.kb}|${e.ka}`)) {
      if (e.ka < e.kb) walls.push({ a: e.a, b: e.b, kind: e.a.kind, line: e.a.line });
      continue;
    }
    if (from.has(e.ka)) return null; // two ways on from one corner: lots that only touch there
    from.set(e.ka, e);
  }
  const out = [], used = new Set();
  for (const start of from.values()) {
    if (used.has(start)) continue;
    const ring = [];
    for (let e = start; e && !used.has(e); e = from.get(e.kb)) {
      used.add(e);
      ring.push(e.a);
    }
    if (ring.length < 3 || from.get(vertexKey(ring[ring.length - 1]))?.kb !== vertexKey(ring[0])) return null;
    out.push(ring);
  }
  const outer = out.filter((r) => ringSigned(r) > 0);
  return outer.length ? { ring: ringAt(outer, x, z), walls } : null;
}

/**
 * How a house's real lot fits it (env.realLots(w), js/real-lots.js), kept on the house: `real`, its own lots together ({ rule, ring,
 * walls }); `several`, the lot it shares with other houses ({ lot, ring }); `inside`, where it stands in another house's lot. Returns
 * which, or 'fallback' or 'none' where it has no real lot.
 */
function realOf(w, env) {
  const home = env.realLots(w);
  if (!home) return 'none';
  if (home.rule === 'fallback' || !home.lots.length) return 'fallback';
  if (home.rule === 'several') {
    const ring = ringAt(outerRings(home.lots[0]), w.cx, w.cz);
    if (!ring) return 'fallback';
    w.several = { lot: home.lots[0], ring };
    return 'several';
  }
  const own = home.lots.filter((l) => l.homes[0] === home);
  if (!own.length) {
    w.inside = true;
    return 'inside';
  }
  // Lots that don't come out as one ring together: the one the house's middle is on
  const together = lotsTogether(own, w.cx, w.cz)
    || lotsTogether([own.find((l) => outerRings(l).some((r) => inRing(r, w.cx, w.cz))) || own[0]], w.cx, w.cz);
  if (!together) return 'fallback';
  w.real = { rule: home.rule, ...together };
  return 'real';
}

/**
 * A real lot's ring as a lot's points (each tagged { real: its edge's kind, line }), brought forward to the front line where its frontage
 * on the house's street is a little behind it: each stretch of that frontage goes on, square to the street, past the front line, which
 * then cuts it there
 */
function forward(h, ring) {
  const f = h.frame, n = ring.length;
  const pts = ring.map((p) => ({ x: p.x, z: p.z, tag: { real: p.kind, line: p.line } }));
  const frontage = (i) => {
    const p = ring[i], q = ring[(i + 1) % n];
    if (p.kind !== 'front') return false;
    const L = Math.hypot(q.x - p.x, q.z - p.z);
    if (L < 0.05) return false;
    return Math.abs((q.x - p.x) * f.tx + (q.z - p.z) * f.tz) / L > 0.5 && depthOf(f, (p.x + q.x) / 2, (p.z + q.z) / 2) <= h.front + FRONT_SLACK;
  };
  const start = ring.findIndex((_, i) => !frontage(i));
  if (start < 0) return pts;
  const out = [];
  const ahead = (p) => {
    const d = depthOf(f, p.x, p.z) - (h.front - 0.05);
    return { x: p.x - f.nx * d, z: p.z - f.nz * d, tag: 'front' };
  };
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    if (!frontage(i)) { out.push(pts[i]); continue; }
    // A stretch of frontage from i on: its first corner, out to past the front line, along it, and back to its last corner
    let j = i;
    while (frontage((j + 1) % n) && (j + 1) % n !== start) j = (j + 1) % n;
    const first = pts[i], last = pts[(j + 1) % n];
    if (depthOf(f, first.x, first.z) > h.front - 0.05 || depthOf(f, last.x, last.z) > h.front - 0.05) {
      out.push({ ...first, tag: 'front' }, ahead(first), { ...ahead(last), tag: 'front' });
    } else {
      for (let m = i; m !== (j + 1) % n; m = (m + 1) % n) out.push(pts[m]);
    }
    k += (j - i + n) % n;
  }
  return out;
}

/** A real lot cut off at the front line: its frontages on other streets are fenced as a road's side is. Null where nothing's left */
function frontOf(h, poly) {
  for (const p of poly) if (p.tag?.real === 'front') p.tag = 'road';
  return poly.length >= 3 ? poly : null;
}

/**
 * A lot worked out from the map (`poly`, convex) kept off the real lots near it: cut along the line of an edge of each one it covers
 * OVERLAP m² of, the edge with the house outside it (but for OVERSHOOT) that leaves the lot most, a few times over for a lot that isn't
 * convex. The cut is tagged with that edge's line, so its fence is the real lot's. A house well over a real lot stays over it.
 */
function offReal(h, poly, lots) {
  for (const lot of lots) {
    for (const ring of outerRings(lot)) {
      if (inRing(ring, h.cx, h.cz)) continue;
      for (let k = 0; k < 3; k++) {
        if (areaInside(ring, poly) < OVERLAP) break;
        let best = null;
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b = ring[(i + 1) % ring.length], L = Math.hypot(b.x - a.x, b.z - a.z);
          if (L < 0.05) continue;
          // Out of a counter-clockwise ring is to the right of its edge
          const nx = (b.z - a.z) / L, nz = -(b.x - a.x) / L;
          if ((h.cx - a.x) * nx + (h.cz - a.z) * nz < 0.05) continue;
          // Not through its own house
          if (h.pts.some((p) => (p.x - a.x) * nx + (p.z - a.z) * nz < -OVERSHOOT)) continue;
          const cut = clipHalf(poly, -nx, -nz, nx * a.x + nz * a.z, { real: 'side', line: a.line });
          if (cut.length < 3) continue;
          const area = ringArea(cut);
          if (!best || area > best.area) best = { cut, area };
        }
        if (!best) break;
        poly = best.cut;
      }
    }
  }
  return poly;
}

// --- A house's frame and its neighbours ----------------------------------------------------------------------------------------

/**
 * The buildings that stand for houses among `entries` ([{ b, tile }], a tile's buildings in its order): one for each building, or
 * each group of pieces (js/buildings.js wholeOf()), with all its outlines. `house`: its style, where it has a look.
 */
function wholesOf(entries) {
  const wholes = new Map();
  for (const { b, tile } of entries) {
    const key = b.group ? `${tile.key}:${b.group}` : b;
    let w = wholes.get(key);
    if (!w) wholes.set(key, (w = { key, tile, pieces: [], cx: b.cx, cz: b.cz, house: 0, kind: b.kind }));
    w.pieces.push(b);
    if (b.group && !b.bottom) { w.cx = b.cx; w.cz = b.cz; } // as wholeOf(): the last piece on the ground
  }
  for (const w of wholes.values()) {
    w.rings = w.pieces.flatMap((b) => b.polygons.map((p) => p.outer));
    w.pts = w.rings.flat();
    w.box = boxOf(w.pts);
    w.area = w.pieces.filter((b) => !b.bottom).reduce((sum, b) => sum + b.polygons.reduce((s, p) => s + ringArea(p.outer), 0), 0);
    // The piece whose walls have the front: the one on the ground nearest its street (js/buildings.js streetOf())
    const styled = w.pieces.find((b) => b.frontWall) || w.pieces.find((b) => HOUSE_STYLES[b.houseStyle || 0]?.look && !b.bottom);
    w.house = styled && HOUSE_STYLES[styled.houseStyle || 0]?.look ? styled.houseStyle : 0;
    w.frontWall = styled?.frontWall ?? null;
    // Its front walls' foot and height, as js/buildings.js stands them (its floor, the paving's height over it)
    w.wallBase = (styled?.floor ?? 0) + 0.22;
    // Its street address, where the tiles give it (js/tiles/tile-file.js): its floor was set at its door (js/lot-things.js steps())
    w.address = styled?.address ?? null;
    w.wallHeight = styled?.height ?? 3;
  }
  return [...wholes.values()];
}

/** A house's frame from its street: P its nearest point, n from it towards the house, t along the street */
function frameOf(home, street) {
  let nx = home.cx - street.x, nz = home.cz - street.z;
  const d = Math.hypot(nx, nz);
  if (d < 0.5) { nx = -street.uz; nz = street.ux; } else { nx /= d; nz /= d; }
  return { px: street.x, pz: street.z, nx, nz, tx: nz, tz: -nx };
}
const depthOf = (f, x, z) => (x - f.px) * f.nx + (z - f.pz) * f.nz;
const alongOf = (f, x, z) => (x - f.px) * f.tx + (z - f.pz) * f.tz;

/** The extents of points in a frame: { a0, a1, d0, d1 } */
function extentIn(f, pts) {
  const [a0, a1] = span(pts, f.tx, f.tz), [d0, d1] = span(pts, f.nx, f.nz);
  const at = f.px * f.tx + f.pz * f.tz, dt = f.px * f.nx + f.pz * f.nz;
  return { a0: a0 - at, a1: a1 - at, d0: d0 - dt, d1: d1 - dt };
}

const overlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);

/** How far (x, z) is from a line through `pts` */
function lineDistance(pts, x, z) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i], dx = q.x - p.x, dz = q.z - p.z;
    const t = Math.max(0, Math.min(1, ((x - p.x) * dx + (z - p.z) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(p.x + dx * t - x, p.z + dz * t - z));
  }
  return best;
}

/** The convex hull of a building's points, kept on it */
function hullOf(w) {
  if (w.hull) return w.hull;
  const pts = [...w.pts].sort((p, q) => p.x - q.x || p.z - q.z);
  const cross = (o, p, q) => (p.x - o.x) * (q.z - o.z) - (p.z - o.z) * (q.x - o.x);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  w.hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  return w.hull;
}

/**
 * The line between two neighbours: { ux, uz, m, gap }, a's side where x * ux + z * uz < m. Square to or along their streets where those
 * show a gap between them; otherwise along whichever edge of either's outline (its hull) shows the widest, where they don't overlap
 * (two houses set at an angle to their streets, or one diagonally behind the other); gap <= 0 where nothing separates them.
 */
function pairLine(a, b) {
  const axes = [];
  const frames = [a.frame, b.frame].filter(Boolean);
  for (const f of frames) for (const [x, z] of [[f.tx, f.tz], [f.nx, f.nz]]) axes.push([x, z, 0], [-x, -z, 0]);
  // Square to both their streets at once, where both have one running nearly the same way
  if (frames.length === 2) {
    const [fa, fb] = frames;
    for (const [ax, az] of [[fa.tx, fa.tz], [fa.nx, fa.nz]]) {
      for (const [bx, bz] of [[fb.tx, fb.tz], [fb.nx, fb.nz], [-fb.tx, -fb.tz], [-fb.nx, -fb.nz]]) {
        if (ax * bx + az * bz < 0.87) continue;
        const L = Math.hypot(ax + bx, az + bz);
        axes.push([(ax + bx) / L, (az + bz) / L, 0.3], [-(ax + bx) / L, -(az + bz) / L, 0.3]);
      }
    }
  }
  let best = null;
  for (const [ux, uz, bonus] of axes) {
    const [, aHi] = span(a.pts, ux, uz), [bLo] = span(b.pts, ux, uz);
    const gap = bLo - aHi;
    if (!best || gap + bonus > best.score) best = { ux, uz, m: (aHi + bLo) / 2, gap, score: gap + bonus };
  }
  if (best && best.gap > 0) return best;
  for (const hull of [hullOf(a), hullOf(b)]) {
    for (let i = 0; i < hull.length; i++) {
      const p = hull[i], q = hull[(i + 1) % hull.length], L = Math.hypot(q.x - p.x, q.z - p.z);
      if (L < 0.05) continue;
      for (const sign of [1, -1]) {
        const ux = (sign * (q.z - p.z)) / L, uz = (sign * -(q.x - p.x)) / L;
        const [, aHi] = span(a.pts, ux, uz), [bLo] = span(b.pts, ux, uz);
        const gap = bLo - aHi;
        if (gap > best.gap) best = { ux, uz, m: (aHi + bLo) / 2, gap, score: gap };
      }
    }
  }
  return best;
}

// --- A whole island ------------------------------------------------------------------------------------------------------------

/**
 * The lots of the houses in a square of the map, with their fences, driveways and crossovers. A lot needs what's round it: its
 * neighbours, and theirs, since a pair is a pair if either chose the other, and the lots round it, which it mustn't overlap. So
 * `entries` must hold every building within MARGIN of `square` ({ x0, z0, x1, z1 }); each house within PICK_MARGIN has its lot worked
 * out for the overlaps, and those within LOT_MARGIN have theirs kept, so each pair's fence is the same in the squares either side of it;
 * what's returned is what's in the square: each lot and its driveway by its house's middle, each fence by its own. `entries`: [{ b, tile }],
 * the buildings, in their tiles' order. `env`:
 *   streetOf(whole): the street a house faces, { x, z, ux, uz, link } (js/street-front.js streetFront(), as its walls have it), or null
 *   roadsNear(x, z, r): [{ link, x, z, d }], each road on the ground's nearest point to (x, z) within r; a link has its `pts` and `width`
 *   kerbFrom(x, z, nx, nz, most, tx, tz): m from (x, z) along (nx, nz) that the kerb island (tx, tz) is on starts, or null within `most`
 *   groundAt(x, z), lawnAt(x, z), pavingAt(x, z): the ground's height; the lawn's and footpath's as drawn (without their lift), or null
 *   onLawn(x, z): whether (x, z) is on a lawn as drawn, rather than a footpath, or null where that's not known
 *   roadAt(x, z): the road's surface
 *   sites: [{ rings }]: the model sites, which nothing of a lot reaches into, and which bound their neighbours' lots
 *   lotThings(lot, obstacles): what else stands in a lot (js/lot-things.js), { boxes, slabs, panels, fences }, or none
 *   realLots(whole): a house's real lot, as js/real-lots.js realLotsFrom() homeAt() gives it, or null; none where there are no lot files
 *   realLotsIn(x0, z0, x1, z1): the real lots near, for the lots worked out from the map to keep off
 *   lines: true for the fences as the lots' edges have them, before they're cut, for measuring them
 * Yields as it goes; returns { lots, fences, panels, slabs, things, treads, plates, fronting }: `plates`, its letterboxes' street numbers
 * (js/street-numbers.js); `fronting`, every building near that faces a street and bounds a lot, for the verges (js/verge.js
 * squareVerge()). With `lines`, also `lines`, each fence before the cut ({ a, b, homes, kind:
 * 'pair' with its `line`, 'back', 'road' or 'row', or a real lot's 'side', 'moved', 'bound' or 'wall', own: whether it's the square's }),
 * and `measure`: { obstacles, pairs, rounds, added, unseparated, left, rules }, the pairs the overlaps added, those no line separates, and
 * the overlaps still left after ROUNDS, each { home, other, why: 'building' or 'lot' }; and with real lots, how many houses near took each
 * (real, inside, several, fallback, none, and bare: real with no street).
 */
const PICK_MARGIN = 160; // m: houses whose neighbours are looked for, round the square
const LOT_MARGIN = 80; // m: houses whose lots are kept, and their fences drawn
const MARGIN = 240; // m: buildings that must be given
function* squareLots(entries, env, square) {
  const within = (w, m) => w.cx >= square.x0 - m && w.cx < square.x1 + m && w.cz >= square.z0 - m && w.cz < square.z1 + m;
  const owns = (x, z) => x >= square.x0 && x < square.x1 && z >= square.z0 && z < square.z1;
  const wholes = wholesOf(entries);
  yield;
  const homes = [];
  const partners = [];
  const bare = []; // houses with a real lot and no street near: their lots' fences alone
  const rules = { real: 0, inside: 0, several: 0, fallback: 0, none: 0, bare: 0 };
  let seen = 0;
  for (const w of wholes) {
    if (++seen % 64 === 0) yield;
    if (w.house && within(w, PICK_MARGIN)) {
      if (env.realLots) rules[realOf(w, env)]++;
      const street = env.streetOf(w);
      if (street) {
        w.street = street;
        w.frame = frameOf(w, street);
        homes.push(w);
      } else if (w.real) {
        bare.push(w);
        rules.bare++;
      }
    }
    if (w.house || (w.kind !== SHED && w.area >= PARTNER_AREA)) partners.push(w);
  }
  // The real lots that houses' own lots stay off, round a lot worked out from the map
  const realNear = env.realLotsIn ? (b) => env.realLotsIn(b.x0, b.z0, b.x1, b.z1) : null;
  // Whether q may be h's neighbour: houses with real lots have none, and a lot worked out from the map stays off the real lots round
  // it, so its neighbours are those without one; several houses on one real lot have the lot's own buildings
  const sameLot = (h, q) => q.several?.lot === h.several.lot || (!q.house && !q.site && inRing(h.several.ring, q.cx, q.cz));
  const mayPair = (h, q) => (h.several ? sameLot(h, q) : !(q.real || q.inside || q.several));
  const obstacles = wholes.map((w) => {
    const small = !w.house && (w.kind === SHED || w.area < PARTNER_AREA);
    return { rings: w.rings, box: w.box, whole: w, small, partner: small ? null : w };
  });
  // The model sites stand where their houses are: lots stop short of them
  for (const site of env.sites || []) {
    const pts = site.rings.flat(), box = boxOf(pts);
    const partner = { key: site, site: true, rings: site.rings, pts, box, cx: (box.x0 + box.x1) / 2, cz: (box.z0 + box.z1) / 2 };
    partners.push(partner);
    obstacles.push({ rings: site.rings, box, site: true, partner });
  }
  // Obstacles in cells too, for what's in a fence's or a driveway's way
  const OCELL = 40, ogrid = new Map();
  for (const o of obstacles) {
    for (let ix = Math.floor(o.box.x0 / OCELL); ix <= Math.floor(o.box.x1 / OCELL); ix++) {
      for (let iz = Math.floor(o.box.z0 / OCELL); iz <= Math.floor(o.box.z1 / OCELL); iz++) {
        const k = ix * 100000 + iz;
        (ogrid.get(k) || ogrid.set(k, []).get(k)).push(o);
      }
    }
  }
  const obstaclesIn = (x0, z0, x1, z1) => {
    const out = new Set();
    for (let ix = Math.floor(x0 / OCELL); ix <= Math.floor(x1 / OCELL); ix++) {
      for (let iz = Math.floor(z0 / OCELL); iz <= Math.floor(z1 / OCELL); iz++) {
        for (const o of ogrid.get(ix * 100000 + iz) || []) if (o.box.x1 >= x0 && o.box.x0 <= x1 && o.box.z1 >= z0 && o.box.z0 <= z1) out.add(o);
      }
    }
    return out;
  };
  yield;
  // Partners in cells, to look for neighbours among those near
  const CELL = 40;
  const grid = new Map();
  for (const q of partners) {
    for (let ix = Math.floor(q.box.x0 / CELL); ix <= Math.floor(q.box.x1 / CELL); ix++) {
      for (let iz = Math.floor(q.box.z0 / CELL); iz <= Math.floor(q.box.z1 / CELL); iz++) {
        const k = ix * 100000 + iz;
        (grid.get(k) || grid.set(k, []).get(k)).push(q);
      }
    }
  }
  const partnersNear = (x, z, r) => {
    const out = new Set();
    for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) {
      for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) for (const q of grid.get(ix * 100000 + iz) || []) out.add(q);
    }
    return out;
  };
  yield;

  // Each house's front line, and its neighbours beside and behind
  // How far from a road's middle line its kerb is, on the side towards (tx, tz), on the island that's on
  const kerbOf = (link, x, z, nx, nz, tx, tz) => {
    const most = link.width / 2 + 6;
    const k = env.kerbFrom(x, z, nx, nz, most, tx, tz);
    return k ?? link.width / 2 + KERB_PAST;
  };
  for (const [i, h] of homes.entries()) {
    if (i % 24 === 23) yield;
    const f = h.frame;
    h.ext = extentIn(f, h.pts);
    const k = kerbOf(h.street.link, f.px, f.pz, f.nx, f.nz, h.cx, h.cz);
    h.kerb = k;
    // A house built up to its front boundary: its front yard is nothing
    h.front = Math.max(k + 0.5, Math.min(k + FOOTPATH, h.ext.d0));
  }
  yield;
  const pairs = new Map(); // home -> Set of partners
  const link = (a, b) => {
    if (!pairs.has(a)) pairs.set(a, new Set());
    pairs.get(a).add(b);
    if (b.frame) {
      if (!pairs.has(b)) pairs.set(b, new Set());
      pairs.get(b).add(a);
    }
  };
  let count = 0;
  for (const h of homes) {
    if (h.real || h.inside) continue;
    const { a0, a1, d0, d1 } = h.ext;
    let left = null, right = null, back = null;
    for (const q of partnersNear(h.cx, h.cz, NEAR + 30)) {
      if (q === h || !mayPair(h, q)) continue;
      const e = extentIn(h.frame, q.pts);
      const deep = overlap(Math.max(d0, h.front), d1, e.d0, e.d1);
      if (deep >= Math.min(2, 0.3 * (d1 - d0))) {
        if (e.a0 > a1 - 0.5 && e.a0 - a1 < 40 && (!right || e.a0 - a1 < right.gap)) right = { q, gap: e.a0 - a1 };
        if (e.a1 < a0 + 0.5 && a0 - e.a1 < 40 && (!left || a0 - e.a1 < left.gap)) left = { q, gap: a0 - e.a1 };
      }
      const wide = overlap(a0, a1, e.a0, e.a1);
      if (wide >= Math.min(2, 0.3 * (a1 - a0)) && e.d0 > d1 - 0.5 && e.d0 - d1 < 2 * BACK_MOST && (!back || e.d0 - d1 < back.gap)) {
        back = { q, gap: e.d0 - d1 };
      }
    }
    for (const n of [left, right, back]) if (n) link(h, n.q);
    if (++count % 16 === 0) yield;
  }
  yield;

  // One line for each pair, the same for both
  const lines = new Map();
  const lineOf = (a, b) => {
    let byB = lines.get(a);
    if (!byB) lines.set(a, (byB = new Map()));
    if (byB.has(b)) return byB.get(b);
    let line = lines.get(b)?.get(a);
    if (line) line = { ...line, ux: -line.ux, uz: -line.uz, m: -line.m, flipped: true };
    else line = { ...pairLine(a, b), id: lines.size + byB.size, flipped: false };
    byB.set(b, line);
    return line;
  };

  // A house's lot: behind its front line, on its side of each pair's line, no more than BACK_MOST behind it, off every other road's
  // footpath; null where its middle isn't in that
  const roadClips = new Map(); // home -> [[a, b, c]], its other roads' lines
  const lotShape = (h) => {
    if (h.inside) return null;
    const f = h.frame;
    const pdot = f.px * f.nx + f.pz * f.nz;
    if (h.real) return frontOf(h, clipHalf(forward(h, h.real.ring), -f.nx, -f.nz, pdot + h.front, 'front'));
    const half = Math.max(h.box.x1 - h.box.x0, h.box.z1 - h.box.z0) / 2 + BACK_MOST + 15;
    let poly = h.several ? forward(h, h.several.ring)
      : [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => ({ x: h.cx + sx * half, z: h.cz + sz * half, tag: 'square' }));
    poly = clipHalf(poly, -f.nx, -f.nz, pdot + h.front, 'front');
    poly = clipHalf(poly, f.nx, f.nz, -(pdot + h.ext.d1 + BACK_MOST), 'back');
    for (const q of pairs.get(h) || []) {
      const line = lineOf(h, q);
      poly = clipHalf(poly, line.ux, line.uz, -line.m, { line: line.flipped ? lines.get(q).get(h) : line, gap: line.gap, partner: q });
    }
    // Off every other road's footpath
    let clips = roadClips.get(h);
    if (!clips) {
      clips = [];
      for (const r of env.roadsNear(h.cx, h.cz, NEAR)) {
        if (r.link === h.street.link || r.d < 0.5) continue;
        const nx = (h.cx - r.x) / r.d, nz = (h.cz - r.z) / r.d;
        const k = kerbOf(r.link, r.x, r.z, nx, nz, h.cx, h.cz);
        clips.push([-nx, -nz, r.x * nx + r.z * nz + k + FOOTPATH + ROAD_INSET]);
      }
      roadClips.set(h, clips);
    }
    for (const [a, b, c] of clips) poly = clipHalf(poly, a, b, c, 'road');
    if (h.several) poly = frontOf(h, poly);
    else if (realNear && poly.length >= 3) poly = offReal(h, poly, realNear(boxOf(poly)));
    return poly.length >= 3 && inRing(poly, h.cx, h.cz) ? poly : null;
  };

  // Every house's lot, then the overlaps: a house, building or site a lot covers OVERLAP m² of, or another lot, becomes a pair, unless no
  // straight line separates the two; then the lots that gained a pair again. A lot only shrinks with each pair, so it settles.
  const shapes = new Map(); // home -> its lot's points, or null
  for (const [i, h] of homes.entries()) {
    shapes.set(h, lotShape(h));
    if (i % 32 === 31) yield;
  }
  const order = new Map(homes.map((h, i) => [h, i]));
  const refused = new Map(); // home -> Set of those no line separates it from
  const isRefused = (a, b) => refused.get(a)?.has(b) || refused.get(b)?.has(a);
  const added = [], unseparated = [], left = [];
  // A real lot is as it is: only the lots worked out from the map look for what they cover
  let rounds = 1, changed = homes.filter((h) => !h.real && !h.inside);
  for (;;) {
    const LCELL = 40, lgrid = new Map(), lbox = new Map();
    for (const [h, poly] of shapes) {
      if (!poly) continue;
      const b = boxOf(poly);
      lbox.set(h, b);
      for (let ix = Math.floor(b.x0 / LCELL); ix <= Math.floor(b.x1 / LCELL); ix++) {
        for (let iz = Math.floor(b.z0 / LCELL); iz <= Math.floor(b.z1 / LCELL); iz++) {
          const k = ix * 100000 + iz;
          (lgrid.get(k) || lgrid.set(k, []).get(k)).push(h);
        }
      }
    }
    yield;
    const recheck = new Set(changed);
    const found = [];
    let n = 0;
    for (const h of changed) {
      const poly = shapes.get(h);
      if (!poly) continue;
      if (++n % 16 === 0) yield;
      const b = lbox.get(h), mine = pairs.get(h);
      // Several houses' lots within a real lot needn't be convex: their hull for what they cover
      const clip = h.several ? convexHull(poly) : poly;
      for (const o of obstaclesIn(b.x0, b.z0, b.x1, b.z1)) {
        const q = o.partner;
        if (!q || q === h || mine?.has(q) || isRefused(h, q) || (h.several && !sameLot(h, q))) continue;
        if (o.rings.reduce((sum, r) => sum + areaInside(r, clip), 0) >= OVERLAP) found.push({ home: h, other: q, why: 'building' });
      }
      const near = new Set();
      for (let ix = Math.floor(b.x0 / LCELL); ix <= Math.floor(b.x1 / LCELL); ix++) {
        for (let iz = Math.floor(b.z0 / LCELL); iz <= Math.floor(b.z1 / LCELL); iz++) for (const g of lgrid.get(ix * 100000 + iz) || []) near.add(g);
      }
      for (const g of near) {
        // Each pair once: from the first of the two in the homes' order, where both are looked at
        if (g === h || mine?.has(g) || isRefused(h, g) || (recheck.has(g) && order.get(g) < order.get(h))) continue;
        if (h.several && g.several?.lot !== h.several.lot) continue;
        const gb = lbox.get(g);
        if (gb.x0 >= b.x1 || gb.x1 <= b.x0 || gb.z0 >= b.z1 || gb.z1 <= b.z0) continue;
        if (areaInside(shapes.get(g), clip) >= OVERLAP) found.push({ home: h, other: g, why: 'lot' });
      }
    }
    if (!found.length) break;
    if (rounds === ROUNDS) {
      left.push(...found);
      break;
    }
    const next = new Set();
    for (const p of found) {
      const { home: h, other: q } = p;
      if (pairs.get(h)?.has(q) || isRefused(h, q)) continue;
      if (!(lineOf(h, q).gap > -TOUCH)) {
        if (!refused.has(h)) refused.set(h, new Set());
        refused.get(h).add(q);
        unseparated.push(p);
        continue;
      }
      link(h, q);
      added.push(p);
      next.add(h);
      if (q.frame) next.add(q);
    }
    if (!next.size) break;
    rounds++;
    changed = homes.filter((h) => next.has(h) && !h.real && !h.inside);
    for (const [i, h] of changed.entries()) {
      shapes.set(h, lotShape(h));
      if (i % 32 === 31) yield;
    }
  }
  yield;

  const lots = [], lotOf = new Map();
  const fenceSpans = new Map(); // a pair's line -> [{ s0, s1 }] from each of the two lots
  const realSpans = new Map(); // a real lot's line, by its key -> { line, kind, spans, homes }, from each lot along it
  const fences = [];
  // A real lot's fence from a to b, only within RURAL_REACH of its house; each line once, from whichever lots have it (and along a shared
  // wall only behind the houses, shared() below)
  const nearHouse = (h, a, b) => {
    const t = spanInBox(a, b, { x0: h.box.x0 - RURAL_REACH, x1: h.box.x1 + RURAL_REACH, z0: h.box.z0 - RURAL_REACH, z1: h.box.z1 + RURAL_REACH });
    return t ? [[pointOn(a, b, t[0]), pointOn(a, b, t[1])]] : [];
  };
  const addReal = (h, tag, a, b) => {
    const { line, real: kind } = tag;
    for (const [p, q] of nearHouse(h, a, b)) {
      // Within the edge: a lot kept off a real lot is cut along its edge's whole line
      const s0 = (p.x - line.ax) * line.ux + (p.z - line.az) * line.uz, s1 = (q.x - line.ax) * line.ux + (q.z - line.az) * line.uz;
      const lo = Math.max(0, Math.min(s0, s1)), hi = Math.min(line.length, Math.max(s0, s1));
      if (hi - lo < 0.05) continue;
      if (!realSpans.has(line.key)) realSpans.set(line.key, { line, kind, spans: [], homes: [] });
      const entry = realSpans.get(line.key);
      entry.spans.push([lo, hi]);
      if (!entry.homes.includes(h)) entry.homes.push(h);
    }
  };
  // An edge of several houses' lot within a real lot that runs outside that lot (the cut along a line across a corner that turns in)
  const outside = (ring, p, q) => {
    const L = Math.hypot(q.x - p.x, q.z - p.z);
    if (L < 1e-6) return true;
    const mx = (p.x + q.x) / 2, mz = (p.z + q.z) / 2, nx = (q.z - p.z) / L * 0.05, nz = -(q.x - p.x) / L * 0.05;
    return !inRing(ring, mx + nx, mz + nz) && !inRing(ring, mx - nx, mz - nz);
  };
  for (const h of homes) {
    // A real lot's fences reach RURAL_REACH from its house, so its lot is worked out that much further round the square
    if (!within(h, h.real ? LOT_MARGIN + RURAL_REACH : LOT_MARGIN)) continue;
    const f = h.frame;
    const poly = shapes.get(h);
    if (!poly) {
      yield;
      continue;
    }
    const lot = { home: h, pts: poly, front: h.front, kerb: h.kerb, frame: f, style: h.house };
    // A real lot, or a part of one, needn't be convex (acrossAt())
    if (h.real || h.several) lot.real = true;
    lots.push(lot);
    lotOf.set(h, lot);
    // A row of terraces drawn as one footprint: its lot cut where its facade cuts it into houses, and a fence between their back yards
    const row = HOUSE_STYLES[h.house]?.look?.terrace && h.frontWall ? houseEntry(h.frontWall, h.house)?.row : null;
    if (row) {
      lot.units = unitsOf(lot, row);
      for (const fence of rowFences(lot, row)) fences.push({ ...fence, kind: 'row' });
    }
    // The shared walls inside a house's real lots, from behind it: a row's are its facade's instead
    if (h.real && !row) {
      for (const w of h.real.walls) {
        const from = h.front + FENCE_BACK, dp = depthOf(f, w.a.x, w.a.z), dq = depthOf(f, w.b.x, w.b.z);
        if (dp < from && dq < from) continue;
        const t = dp < from || dq < from ? (from - dp) / (dq - dp) : null;
        addReal(h, { real: 'wall', line: w.line }, dp < from ? pointOn(w.a, w.b, t) : w.a, dq < from ? pointOn(w.a, w.b, t) : w.b);
      }
    }

    // The fences along it: every side but the front, from FENCE_BACK behind the front line
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const tag = p.tag;
      if (tag === 'front' || tag === 'square') continue;
      if (h.several && outside(h.several.ring, p, q)) continue;
      // A terrace's side to a street is the end house's own wall, or more of a row the map drew as one footprint, whose doors are on it
      if (tag === 'road' && HOUSE_STYLES[h.house]?.look?.terrace) continue;
      if (typeof tag === 'object' && tag.gap < NO_FENCE) continue;
      const from = h.front + FENCE_BACK;
      const dp = depthOf(f, p.x, p.z), dq = depthOf(f, q.x, q.z);
      if (dp < from && dq < from) continue;
      let a = p, b = q;
      if (dp < from) a = { x: p.x + (q.x - p.x) * ((from - dp) / (dq - dp)), z: p.z + (q.z - p.z) * ((from - dp) / (dq - dp)) };
      if (dq < from) b = { x: p.x + (q.x - p.x) * ((from - dp) / (dq - dp)), z: p.z + (q.z - p.z) * ((from - dp) / (dq - dp)) };
      const da = depthOf(f, a.x, a.z), db = depthOf(f, b.x, b.z), L = Math.hypot(b.x - a.x, b.z - a.z);
      if (tag === 'road' && Math.abs(db - da) > 0.3 * L) {
        // A corner house over its side street's line: the fence along the street only behind it, from where the line leaves its back wall.
        // (A house over a road's line behind it, which runs along its street, has the fence either side of it, meeting its walls.)
        const inside = insideSpans(a, b, h.rings).filter(([t0, t1]) => (t1 - t0) * L > 0.3);
        if (inside.length) {
          const t = da < db ? Math.max(...inside.map((s) => s[1])) : Math.min(...inside.map((s) => s[0]));
          const at = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
          if (da < db) a = at;
          else b = at;
          if (Math.hypot(b.x - a.x, b.z - a.z) < 0.3) continue;
        }
      }
      if (tag.real) {
        addReal(h, tag, a, b);
      } else if (h.real) {
        // Its frontages on other streets
        for (const [p0, q0] of nearHouse(h, a, b)) fences.push({ a: p0, b: q0, homes: [h], kind: tag });
      } else if (typeof tag === 'object') {
        // Along the pair's own line, from either lot's side of it
        const line = tag.line;
        const wx = -line.uz, wz = line.ux;
        const s0 = a.x * wx + a.z * wz, s1 = b.x * wx + b.z * wz;
        if (!fenceSpans.has(line)) fenceSpans.set(line, { line, spans: [], homes: [] });
        const entry = fenceSpans.get(line);
        entry.spans.push([Math.min(s0, s1), Math.max(s0, s1)]);
        entry.homes.push(h, tag.partner);
      } else {
        fences.push({ a, b, homes: [h], kind: tag });
      }
    }
    yield;
  }
  for (const { line, spans, homes: owners } of fenceSpans.values()) {
    spans.sort((x, y) => x[0] - y[0]);
    const wx = -line.uz, wz = line.ux;
    let cur = null;
    const flush = () => {
      if (cur && cur[1] - cur[0] > 0.3) {
        fences.push({ a: { x: line.ux * line.m + wx * cur[0], z: line.uz * line.m + wz * cur[0] },
          b: { x: line.ux * line.m + wx * cur[1], z: line.uz * line.m + wz * cur[1] }, homes: owners, kind: 'pair', line });
      }
    };
    for (const s of spans) {
      if (cur && s[0] <= cur[1] + 0.05) cur[1] = Math.max(cur[1], s[1]);
      else { flush(); cur = [...s]; }
    }
    flush();
  }
  // A house with a real lot and no street near: its lot's fences, with no front (and none along a shared wall, with no front to be behind)
  for (const h of bare) {
    if (!within(h, LOT_MARGIN + RURAL_REACH)) continue;
    const ring = h.real.ring;
    ring.forEach((p, i) => {
      const q = ring[(i + 1) % ring.length];
      if (p.kind === 'front') for (const [a, b] of nearHouse(h, p, q)) fences.push({ a, b, homes: [h], kind: 'road' });
      else if (p.kind !== 'wall') addReal(h, { real: p.kind, line: p.line }, p, q);
    });
  }
  // A line that's a shared wall (between two lots one house stands on, or two houses drawn into each other), or that runs WALL_IN or
  // more inside the houses of the lots either side of it (a house built to its boundary): up the side of the house it's in most, only
  // behind those houses, from where it leaves the last of them at the back; along a shared wall clear of them, only behind their middles.
  // Where that house has no street to be behind from, the longest stretch of the line clear of them; along the street, as it is (a house
  // over its back line meets it).
  const shared = (kind, owners, a, b) => {
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const inside = insideSpans(a, b, owners.flatMap((w) => w.rings)).filter(([t0, t1]) => (t1 - t0) * L > 0.05);
    const metres = (w) => insideSpans(a, b, w.rings).reduce((sum, [t0, t1]) => sum + (t1 - t0) * L, 0);
    if (kind !== 'wall' && inside.reduce((sum, [t0, t1]) => sum + (t1 - t0) * L, 0) < WALL_IN) return [[a, b]];
    const h = inside.length ? owners.map((w) => [metres(w), w]).sort((p, q) => q[0] - p[0])[0][1] : owners.find((w) => w.frame);
    if (!h?.frame) {
      if (!inside.length) return kind === 'wall' ? [] : [[a, b]];
      const clear = keptSpans(inside.map((s) => [...s])).sort((p, q) => q[1] - q[0] - (p[1] - p[0]))[0];
      return clear ? [[pointOn(a, b, clear[0]), pointOn(a, b, clear[1])]] : [];
    }
    const f = h.frame;
    if (kind !== 'wall' && Math.abs((b.x - a.x) * f.nx + (b.z - a.z) * f.nz) < 0.7 * L) return [[a, b]];
    if (!inside.length) return depthOf(f, (a.x + b.x) / 2, (a.z + b.z) / 2) > (h.ext.d0 + h.ext.d1) / 2 ? [[a, b]] : [];
    const deeper = depthOf(f, b.x, b.z) >= depthOf(f, a.x, a.z);
    const t = deeper ? Math.max(...inside.map((s) => s[1])) : Math.min(...inside.map((s) => s[0]));
    return deeper ? (t < 1 ? [[pointOn(a, b, t), b]] : []) : (t > 0 ? [[a, pointOn(a, b, t)]] : []);
  };
  // And through another house (one the file couldn't fit, or one standing in a lot), WALL_IN or more inside it and more than IN_LINE
  // over it: only the longer stretch, the one side of it. A house standing on the line (built to its boundary) meets it.
  const pastOthers = (owners, a, b) => {
    let pieces = [[a, b]];
    for (const o of obstaclesIn(Math.min(a.x, b.x), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.z, b.z))) {
      if (!o.whole?.house || owners.includes(o.whole)) continue;
      pieces = pieces.flatMap(([p, q]) => {
        const L = Math.hypot(q.x - p.x, q.z - p.z);
        const inside = insideSpans(p, q, o.rings);
        if (inside.reduce((sum, [t0, t1]) => sum + (t1 - t0) * L, 0) < WALL_IN || overLine(o.rings, p, q) <= IN_LINE) return [[p, q]];
        const t0 = Math.min(...inside.map((s) => s[0])), t1 = Math.max(...inside.map((s) => s[1]));
        return t0 >= 1 - t1 ? [[p, pointOn(p, q, t0)]] : [[pointOn(p, q, t1), q]];
      });
    }
    return pieces;
  };
  for (const { line, kind, spans, homes: owners } of realSpans.values()) {
    spans.sort((x, y) => x[0] - y[0]);
    let cur = null;
    const flush = () => {
      if (!cur || cur[1] - cur[0] <= 0.3) return;
      const a = { x: line.ax + line.ux * cur[0], z: line.az + line.uz * cur[0] }, b = { x: line.ax + line.ux * cur[1], z: line.az + line.uz * cur[1] };
      for (const [p0, q0] of shared(kind, owners, a, b)) {
        for (const [p, q] of pastOthers(owners, p0, q0)) if (Math.hypot(q.x - p.x, q.z - p.z) > 0.3) fences.push({ a: p, b: q, homes: owners, kind });
      }
    };
    for (const s of spans) {
      if (cur && s[0] <= cur[1] + 0.05) cur[1] = Math.max(cur[1], s[1]);
      else { flush(); cur = [...s]; }
    }
    flush();
  }
  yield;
  // Asked for (env.lines): every fence as its lot's edges have it, before the cut, the square's own marked `own`
  const before = env.lines ? fences.map((f) => ({ ...f, own: owns((f.a.x + f.b.x) / 2, (f.a.z + f.b.z) / 2) })) : null;

  // Each fence cut where it would go through a building, into a site, or onto a footpath: the square's own, by their middles
  const pieces = [];
  let done = 0;
  for (const fence of fences) {
    const { a, b } = fence;
    if (!owns((a.x + b.x) / 2, (a.z + b.z) / 2)) continue;
    if (++done % 6 === 0) yield;
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 0.5) continue;
    const bx0 = Math.min(a.x, b.x) - 1, bx1 = Math.max(a.x, b.x) + 1, bz0 = Math.min(a.z, b.z) - 1, bz1 = Math.max(a.z, b.z) + 1;
    const gone = [];
    const grow = 0.15 / L;
    for (const o of obstaclesIn(bx0, bz0, bx1, bz1)) {
      for (const [t0, t1] of insideSpans(a, b, o.rings)) gone.push([t0 - grow, t1 + grow]);
    }
    // On a footpath: within a road's kerb and FOOTPATH of its middle line, sampled each half metre
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const roads = env.roadsNear(mx, mz, L / 2 + FOOTPATH + 12).map((r) => {
      const nx = r.d > 0.01 ? (mx - r.x) / r.d : 0, nz = r.d > 0.01 ? (mz - r.z) / r.d : 0;
      return { pts: r.link.pts, reach: kerbOf(r.link, r.x, r.z, nx, nz, mx, mz) + FOOTPATH + ROAD_INSET - 0.05 };
    });
    if (roads.length) {
      const n = Math.max(2, Math.ceil(L / 0.5));
      for (let k = 0; k <= n; k++) {
        const t = k / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        // Off the lawn as drawn is on the footpath (in the inner city, off the paving 3.5 m from the kerb)
        const lawn = env.onLawn ? env.onLawn(x, z) : null;
        if (lawn === false || roads.some((r) => lineDistance(r.pts, x, z) < r.reach)) gone.push([t - 0.5 / n, t + 0.5 / n]);
      }
    }
    // Nothing shorter than a panel's half: a fence along the footpath's edge would otherwise come out dashed
    for (const [t0, t1] of keptSpans(gone)) {
      if ((t1 - t0) * L < PANEL / 2) continue;
      pieces.push({ a: { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0 }, b: { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1 },
        homes: fence.homes });
    }
  }
  yield;

  // Each piece's look: Colorbond if either side is post-war or newer, in one of four colours; otherwise timber palings
  const finished = [];
  for (const piece of pieces) {
    const styles = piece.homes.filter((w) => w?.house).map((w) => HOUSE_STYLES[w.house].name);
    const colorbond = styles.some((s) => COLORBOND_STYLES.has(s));
    const roll = hashOf(keyOf(piece.a.x + piece.b.x, piece.a.z + piece.b.z));
    finished.push({ ...piece, kind: colorbond ? 0 : 1, colour: Math.floor(roll * 4), roll });
  }

  // Panels, each level, standing on the ground at its lower end
  const panels = [];
  for (const [i, piece] of finished.entries()) {
    if (i % 40 === 39) yield;
    const { a, b } = piece;
    const L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.ceil(L / PANEL);
    const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
    const ground = [];
    for (let k = 0; k <= n; k++) ground.push(env.groundAt(a.x + ux * (L * k) / n, a.z + uz * (L * k) / n) + LAWN_TOP);
    for (let k = 0; k < n; k++) {
      const g0 = ground[k], g1 = ground[k + 1];
      const bottom = Math.min(g0, g1) - 0.06, top = (g0 + g1) / 2 + FENCE_HEIGHT;
      const s = (L * (k + 0.5)) / n;
      panels.push({ x: a.x + ux * s, z: a.z + uz * s, y: bottom, height: top - bottom, length: L / n, ux, uz, kind: piece.kind,
        colour: piece.colour, roll: piece.roll });
    }
  }
  yield;

  // The driveways, crossovers and laybacks, and each lot's own things (env.lotThings, js/lot-things.js): a garage at the back takes
  // its driveway on to it. A crossover just over the square's edge is known too, for the verge (js/verge.js) to leave its paving.
  const slabs = [], things = [], treads = [], plates = [];
  const mine = lots.filter((lot) => owns(lot.home.cx, lot.home.cz));
  const NEAR_EDGE = 20; // m
  for (const lot of lots) {
    const h = lot.home;
    if (h.cx < square.x0 - NEAR_EDGE || h.cx >= square.x1 + NEAR_EDGE || h.cz < square.z0 - NEAR_EDGE || h.cz >= square.z1 + NEAR_EDGE) continue;
    const near = [...obstaclesIn(h.cx - 60, h.cz - 60, h.cx + 60, h.cz + 60)];
    lot.drive = driveOf(lot, near);
    if (!owns(h.cx, h.cz)) continue;
    // A row's things house by house, each in its own stretch of the lot
    const parts = env.lotThings ? (lot.units ? lot.units.map((unit) => env.lotThings({ ...lot, pts: unit.pts, unit }, near)) : [env.lotThings(lot, near)]).filter(Boolean) : [];
    const own = parts.length ? { slabs: parts.flatMap((o) => o.slabs), panels: parts.flatMap((o) => o.panels), boxes: parts.flatMap((o) => o.boxes),
      fences: parts.flatMap((o) => o.fences), treads: parts.flatMap((o) => o.treads || []), plates: parts.flatMap((o) => o.plates || []) } : null;
    if (lot.drive) slabs.push(...laid(lot, lot.drive, env));
    if (own) {
      slabs.push(...own.slabs);
      panels.push(...own.panels);
      things.push(...own.boxes);
      finished.push(...own.fences);
      treads.push(...own.treads);
      plates.push(...own.plates);
    }
    yield;
  }
  // Every building that faces a street and bounds a lot, for the verge: which sides of which streets are all houses
  const fronting = [];
  for (const h of homes) {
    const f = h.frame, at = (a) => [f.px + f.tx * a + f.nx * h.front, f.pz + f.tz * a + f.nz * h.front];
    fronting.push({ street: h.street, house: h.house, terrace: !!HOUSE_STYLES[h.house]?.look?.terrace, yard: h.front - h.kerb,
      frontage: [at(h.ext.a0), at(h.ext.a1)], cx: h.cx, cz: h.cz, lot: lotOf.get(h) || null });
  }
  for (const [i, w] of partners.entries()) {
    if (w.house || w.site || !within(w, PICK_MARGIN)) continue;
    if (i % 64 === 63) yield;
    const street = env.streetOf(w);
    if (street) fronting.push({ street, house: 0, terrace: false, yard: 0, frontage: [[w.cx, w.cz], [w.cx, w.cz]], cx: w.cx, cz: w.cz, lot: null });
  }
  const result = { lots: mine, fences: finished, panels, slabs, things, treads, plates, fronting };
  if (before) Object.assign(result, { lines: before, measure: { obstacles, pairs, rounds, added, unseparated, left, rules: env.realLots ? rules : null } });
  return result;
}

// --- A row of terraces ------------------------------------------------------------------------------------------------------------

/** The way along a row's front wall, from where its houses start (js/house-entry.js), and the way into the house from it */
function rowAxes(lot, row) {
  const { a0 } = row.units[0], { a1 } = row.units[row.units.length - 1];
  const L = Math.hypot(a1.x - a0.x, a1.z - a0.z) || 1, ux = (a1.x - a0.x) / L, uz = (a1.z - a0.z) / L;
  const h = lot.home, inward = (h.cx - a0.x) * -uz + (h.cz - a0.z) * ux >= 0 ? 1 : -1;
  return { ux, uz, wx: -uz * inward, wz: ux * inward };
}

/**
 * A row's lot cut into its houses' (`row`: houseEntry()'s), square to its front wall where one house meets the next: [{ index, pts, door,
 * wall: its stretch of the front wall, as js/building-footprints.js keeps a front ({ ax, az, bx, bz, width }) }]. The end houses' lots
 * take in the rest of the row's.
 */
function unitsOf(lot, row) {
  const { ux, uz } = rowAxes(lot, row), n = row.units.length;
  const units = [];
  row.units.forEach((u, k) => {
    let pts = lot.pts;
    if (k > 0) { const b = row.units[k - 1].a1; pts = clipHalf(pts, -ux, -uz, b.x * ux + b.z * uz, 'unit'); }
    if (k < n - 1) { const b = u.a1; pts = clipHalf(pts, ux, uz, -(b.x * ux + b.z * uz), 'unit'); }
    if (pts.length < 3) return;
    const width = Math.hypot(u.a1.x - u.a0.x, u.a1.z - u.a0.z);
    units.push({ index: k, pts, door: u.door, wall: { ax: u.a0.x, az: u.a0.z, bx: u.a1.x, bz: u.a1.z, width } });
  });
  return units;
}

/** Fences between a row's houses, from its front wall back across its lot: the house itself and the footpaths cut them as any other's */
function rowFences(lot, row) {
  const { wx, wz } = rowAxes(lot, row), reach = BACK_MOST + (lot.home.ext.d1 - lot.home.ext.d0) + 20;
  const out = [];
  for (const u of row.units.slice(0, -1)) {
    const p = { x: u.a1.x + wx * 0.05, z: u.a1.z + wz * 0.05 }, q = { x: u.a1.x + wx * reach, z: u.a1.z + wz * reach };
    for (const [t0, t1] of insideSpans(p, q, [lot.pts])) {
      out.push({ a: { x: p.x + (q.x - p.x) * t0, z: p.z + (q.z - p.z) * t0 }, b: { x: p.x + (q.x - p.x) * t1, z: p.z + (q.z - p.z) * t1 }, homes: [lot.home] });
    }
  }
  return out;
}

/**
 * Where a lot's car goes: { a (m along its road, the driveway's middle), w (its width), d0, d1 (m from the road it runs between), side
 * (-1 left, 1 right, 0 the front), strips (two wheel strips, not a slab) }, or null
 */
function driveOf(lot, obstacles) {
  const h = lot.home, f = lot.frame, look = HOUSE_STYLES[h.house]?.look;
  if (!look || look.terrace) return null;
  const roll = hashOf(keyOf(h.cx, h.cz));
  const strips = STRIP_STYLES.has(HOUSE_STYLES[h.house].name) && roll < 0.55;
  // A real lot set behind another's (the land in front of the house is the other lot's): up its handle from the street
  if (lot.real && h.ext.d0 - lot.front > 6) {
    const yard = (lot.front + h.ext.d0) / 2, at = (a) => ({ x: f.px + f.tx * a + f.nx * yard, z: f.pz + f.tz * a + f.nz * yard });
    const { a0: e0, a1: e1 } = h.ext;
    if ([0.25, 0.5, 0.75].every((s) => { const p = at(e0 + (e1 - e0) * s); return !inRing(lot.pts, p.x, p.z); })) return handleOf(lot, obstacles, strips);
  }
  // A project home's garage door, in its front wall facing the street
  if (look.garage && h.frontWall) {
    const entry = houseEntry(h.frontWall, h.house);
    if (entry?.garage) {
      const a = alongOf(f, entry.garage.x, entry.garage.z), d = depthOf(f, entry.garage.x, entry.garage.z);
      if (d > lot.front + 1) return { a, w: entry.garage.width + 0.4, d0: lot.front, d1: d, side: 0, strips: false };
    }
  }
  // Beside the house: the gap from its front part to its lot's side, at a few depths
  const { d0 } = h.ext;
  const reach = d0 + DRIVE_PAST;
  let a0 = Infinity, a1 = -Infinity;
  for (const ring of h.rings) {
    let part = ring.map((p) => ({ x: p.x, z: p.z, tag: 0 }));
    part = clipHalf(part, f.nx, f.nz, -(f.px * f.nx + f.pz * f.nz + reach + 1), 0);
    for (const p of part) {
      const a = alongOf(f, p.x, p.z);
      if (a < a0) a0 = a; if (a > a1) a1 = a;
    }
  }
  if (!(a1 > a0)) return null;
  const across = (d) => acrossAt(lot, d);
  let left = Infinity, right = Infinity, la = -Infinity, ra = Infinity;
  for (const d of [lot.front + 0.2, (lot.front + d0) / 2, d0, reach]) {
    const [lo, hi] = across(d);
    if (!Number.isFinite(lo)) return null;
    left = Math.min(left, a0 - lo);
    right = Math.min(right, hi - a1);
    la = Math.max(la, lo);
    ra = Math.min(ra, hi);
  }
  // Each side's corridor: what's in it stops the driveway there; a shed or garage behind decides the side
  const sides = [];
  const near = obstacles.filter((o) => o.whole !== h).map((o) => ({ o, e: extentIn(f, o.rings.flat()) }));
  for (const [side, gap, lo, hi] of [[-1, left, la, a0], [1, right, a1, ra]]) {
    if (gap < DRIVE_GAP) continue;
    const w = Math.min(3.0, gap - 0.6), mid = (lo + hi) / 2;
    // The first thing in its way, up the lot: nothing before the front wall and a little past; a shed or garage of the map's ends it
    let first = null;
    for (const { o, e } of near) {
      if (overlap(mid - w / 2, mid + w / 2, e.a0, e.a1) <= 0 || e.d1 < lot.front || e.d0 > h.ext.d1 + BACK_MOST) continue;
      if (!first || e.d0 < first.e.d0) first = { o, e };
    }
    if (first && first.e.d0 < d0 + 1.5) continue;
    let end = reach, shed = false;
    if (first && first.e.d0 - 0.3 < end) end = first.e.d0 - 0.3;
    else if (first && first.o.small && !first.o.site && inRing(lot.pts, (first.o.box.x0 + first.o.box.x1) / 2, (first.o.box.z0 + first.o.box.z1) / 2)
      && overlap(mid - w / 2, mid + w / 2, h.ext.a0, h.ext.a1) <= 0 && Number.isFinite(across(first.e.d0 - 0.5)[0])) {
      // A shed or garage behind, on this side, with the house nowhere in the way: up to it
      const [lo2, hi2] = across(first.e.d0 - 0.5);
      if (lo2 <= mid - w / 2 && hi2 >= mid + w / 2) { end = first.e.d0 - 0.3; shed = true; }
    }
    sides.push({ side, gap, a: mid, w, d0: lot.front, d1: Math.max(end, lot.front + 2), shed });
  }
  if (!sides.length) return null;
  sides.sort((p, q) => (q.shed - p.shed) || (q.gap - p.gap));
  const s = sides[0];
  return { a: s.a, w: s.w, d0: s.d0, d1: s.d1, side: s.side, strips, shed: s.shed };
}

/**
 * The driveway of a lot set behind another's, `lot` (a real one), up its handle: from the front line, as long as the handle runs straight
 * and wide enough, and a little into the lot where it opens out, short of the house and of anything in its way; or null
 */
function handleOf(lot, obstacles, strips) {
  const h = lot.home, f = lot.frame;
  const [lo, hi] = acrossAt(lot, lot.front + 0.3);
  if (!(hi - lo >= DRIVE_GAP)) return null;
  const a = (lo + hi) / 2, w = Math.min(3.0, hi - lo - 0.6), most = h.ext.d0 - 0.5;
  let end = lot.front + 0.3;
  for (let d = lot.front + 1; d < most; d += 1) {
    const [l, r] = acrossAt(lot, d, a);
    if (!(l <= a - w / 2 && r >= a + w / 2)) break; // the handle turns, or narrows
    end = d;
    if (r - l > hi - lo + 2) { end = Math.min(d + 3, most); break; } // out of it, into the lot
  }
  for (const o of obstacles) {
    if (o.whole === h) continue;
    const e = extentIn(f, o.rings.flat());
    if (overlap(a - w / 2, a + w / 2, e.a0, e.a1) > 0 && e.d1 > lot.front && e.d0 - 0.3 < end) end = e.d0 - 0.3;
  }
  if (end - lot.front < 4) return null;
  return { a, w, d0: lot.front, d1: end, side: a < alongOf(f, h.cx, h.cz) ? -1 : 1, strips, shed: false, handle: true };
}

/**
 * A lot's extent across its frame at depth d: [least, most] along its road, or [Infinity, -Infinity] where it doesn't reach that deep.
 * A real lot needn't be convex: there it's the stretch across it that holds `at` (m along its road; its house's middle by default), or
 * else the nearest.
 */
function acrossAt(lot, d, at = null) {
  const f = lot.frame, pts = lot.pts;
  if (lot.real) {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const dp = depthOf(f, p.x, p.z), dq = depthOf(f, q.x, q.z);
      if ((dp <= d) === (dq <= d)) continue;
      const t = (d - dp) / (dq - dp);
      xs.push(alongOf(f, p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t));
    }
    xs.sort((u, v) => u - v);
    const a = at ?? alongOf(f, lot.home.cx, lot.home.cz);
    let best = [Infinity, -Infinity], far = Infinity;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const off = a < xs[i] ? xs[i] - a : a > xs[i + 1] ? a - xs[i + 1] : 0;
      if (off < far) { far = off; best = [xs[i], xs[i + 1]]; }
    }
    return best;
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const dp = depthOf(f, p.x, p.z), dq = depthOf(f, q.x, q.z);
    if ((dp - d) * (dq - d) > 0 || dp === dq) continue;
    const t = (d - dp) / (dq - dp);
    const a = alongOf(f, p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t);
    if (a < lo) lo = a; if (a > hi) hi = a;
  }
  return [lo, hi];
}

/** A slab whose top passes through four corners' heights as nearly as a plane can: the instance js/lot-details.js draws */
function slab(c00, c10, c01, c11, kind, tint) {
  // c(i, j): i along, j across; each { x, y, z }
  const mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, z: (p.z + q.z) / 2 });
  const back = mid(c00, c01), ahead = mid(c10, c11), left = mid(c00, c10), right = mid(c01, c11);
  return {
    x: (back.x + ahead.x) / 2, y: (c00.y + c10.y + c01.y + c11.y) / 4, z: (back.z + ahead.z) / 2,
    ax: ahead.x - back.x, ay: ahead.y - back.y, az: ahead.z - back.z,
    bx: right.x - left.x, by: right.y - left.y, bz: right.z - left.z, kind, tint
  };
}

/** A lot's driveway, crossover and layback as slabs */
function laid(lot, drive, env) {
  const f = lot.frame, out = [];
  const at = (a, d) => ({ x: f.px + f.tx * a + f.nx * d, z: f.pz + f.tz * a + f.nz * d });
  const tint = 0.88 + 0.16 * hashOf(keyOf(lot.home.cx * 3, lot.home.cz));
  const on = (surface, lift, fallback) => (p) => ({ ...p, y: (surface(p.x, p.z) ?? env.groundAt(p.x, p.z) + fallback) + lift });
  const lawn = on(env.lawnAt, LAWN_TOP + SLAB, 0), paving = on(env.pavingAt, PAVING_TOP + CROSSOVER, 0);
  // Up the lot, in pieces each laid on the lawn
  const tracks = drive.strips ? [[drive.a - 0.75, 0.55], [drive.a + 0.75, 0.55]] : [[drive.a, drive.w]];
  const length = drive.d1 - drive.d0, n = Math.max(1, Math.ceil(length / SLAB_PIECE));
  for (const [a, w] of tracks) {
    for (let k = 0; k < n; k++) {
      const d0 = drive.d0 + (length * k) / n, d1 = drive.d0 + (length * (k + 1)) / n;
      out.push(slab(lawn(at(a - w / 2, d0)), lawn(at(a - w / 2, d1)), lawn(at(a + w / 2, d0)), lawn(at(a + w / 2, d1)), 0, tint));
    }
  }
  // Across the footpath, a little wider than the driveway
  const w = drive.w + 0.6, k = lot.kerb;
  const kerbAt = (a, d) => ({ ...at(a, d), y: env.groundAt(at(a, d).x, at(a, d).z) + PAVING_TOP + CROSSOVER });
  out.push(slab(paving(at(drive.a - w / 2, k)), paving(at(drive.a - w / 2, lot.front + 0.05)),
    paving(at(drive.a + w / 2, k)), paving(at(drive.a + w / 2, lot.front + 0.05)), 1, tint));
  // The layback: from the gutter up over the kerb to the crossover's top
  const road = (a, d) => ({ ...at(a, d), y: env.roadAt(at(a, d).x, at(a, d).z) + 0.008 });
  const lay = slab(road(drive.a - w / 2, k - 0.55), kerbAt(drive.a - w / 2, k + 0.02), road(drive.a + w / 2, k - 0.55),
    kerbAt(drive.a + w / 2, k + 0.02), 2, tint);
  out.push(lay);
  return out;
}

export {
  BACK_MOST, DRIVE_GAP, FENCE_BACK, FENCE_HEIGHT, FOOTPATH, LAWN_TOP, MARGIN, NO_FENCE, PANEL, PAVING_TOP, SLAB, SLAB_PIECE, acrossAt, alongOf,
  clipHalf, depthOf, hashOf, inRing, insideSpans, keptSpans, keyOf, pairLine, slab, squareLots, wholesOf
};
