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
// - Its car: a driveway up a side gap of DRIVE_GAP or more (the wider, or the one a shed or garage of the map's stands behind), to just
//   past the front wall or to the shed; a project home's to the garage door in its front wall (js/house-entry.js); none for a terrace.
//   A crossover from the kerb to the front line, and a layback over the kerb.
// - Its fences: along every side of its lot but the front, from FENCE_BACK behind the front line, where the gap is NO_FENCE or more;
//   never through a building or into a model's site, nor on the footpath (off the lawn as drawn, or in the inner city, which is paved
//   right through, within the footpath's width of the kerb).
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
const SHED = 4; // the map's kind of building (js/tiles/tile-file.js)
const NEAR = 45; // m: neighbours, and roads, within this of a house's middle
const PANEL = 2.4; // m: a fence's panels, each level, so a fence steps down a slope
const FENCE_HEIGHT = 1.8; // m
const LAWN_TOP = 0.24; // m over the ground: the lawn as js/city-grid.js draws it (SIDEWALK_TOP + 0.02)
const PAVING_TOP = 0.22; // m: the footpath's
const SLAB = 0.015; // m a driveway lies over the lawn
const CROSSOVER = 0.03; // m a crossover lies over the footpath
const SLAB_PIECE = 3; // m: driveways in pieces this long, each laid on the lawn under it

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

/** The line between two neighbours: { ux, uz, m, gap }, a's side where x * ux + z * uz < m */
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
  return best;
}

// --- A whole island ------------------------------------------------------------------------------------------------------------

/**
 * The lots of the houses in a square of the map, with their fences, driveways and crossovers. A lot needs what's round it: its
 * neighbours, and theirs, since a pair is a pair if either chose the other. So `entries` must hold every building within MARGIN of
 * `square` ({ x0, z0, x1, z1 }); lots are worked out for those within LOT_MARGIN of it, so each pair's fence is the same in the squares
 * either side of it, and what's returned is what's in the square: each lot and its driveway by its house's middle, each fence by its
 * own. `entries`: [{ b, tile }], the buildings, in their tiles' order. `env`:
 *   streetOf(whole): the street a house faces, { x, z, ux, uz, link } (js/street-front.js streetFront(), as its walls have it), or null
 *   roadsNear(x, z, r): [{ link, x, z, d }], each road on the ground's nearest point to (x, z) within r; a link has its `pts` and `width`
 *   kerbFrom(x, z, nx, nz, most, tx, tz): m from (x, z) along (nx, nz) that the kerb island (tx, tz) is on starts, or null within `most`
 *   groundAt(x, z), lawnAt(x, z), pavingAt(x, z): the ground's height; the lawn's and footpath's as drawn (without their lift), or null
 *   onLawn(x, z): whether (x, z) is on a lawn as drawn, rather than a footpath, or null where that's not known
 *   roadAt(x, z): the road's surface
 *   sites: [{ rings }]: the model sites, which nothing of a lot reaches into, and which bound their neighbours' lots
 *   lotThings(lot, obstacles): what else stands in a lot (js/lot-things.js), { boxes, slabs, panels, fences }, or none
 * Yields as it goes; returns { lots, fences, panels, slabs, things, fronting }: `fronting`, every building near that faces a street and
 * bounds a lot, for the verges (js/verge.js squareVerge()).
 */
const PICK_MARGIN = 160; // m: houses whose neighbours are looked for, round the square
const LOT_MARGIN = 80; // m: houses whose lots are worked out
const MARGIN = 240; // m: buildings that must be given
function* squareLots(entries, env, square) {
  const within = (w, m) => w.cx >= square.x0 - m && w.cx < square.x1 + m && w.cz >= square.z0 - m && w.cz < square.z1 + m;
  const owns = (x, z) => x >= square.x0 && x < square.x1 && z >= square.z0 && z < square.z1;
  const wholes = wholesOf(entries);
  yield;
  const homes = [];
  const partners = [];
  let seen = 0;
  for (const w of wholes) {
    if (++seen % 64 === 0) yield;
    if (w.house && within(w, PICK_MARGIN)) {
      const street = env.streetOf(w);
      if (street) {
        w.street = street;
        w.frame = frameOf(w, street);
        homes.push(w);
      }
    }
    if (w.house || (w.kind !== SHED && w.area >= PARTNER_AREA)) partners.push(w);
  }
  // The model sites stand where their houses are: lots stop short of them
  for (const site of env.sites || []) {
    const pts = site.rings.flat(), box = boxOf(pts);
    partners.push({ key: site, site: true, rings: site.rings, pts, box, cx: (box.x0 + box.x1) / 2, cz: (box.z0 + box.z1) / 2 });
  }
  const obstacles = wholes.map((w) => ({ rings: w.rings, box: w.box, whole: w, small: !w.house && (w.kind === SHED || w.area < PARTNER_AREA) }));
  for (const site of env.sites || []) obstacles.push({ rings: site.rings, box: boxOf(site.rings.flat()), site: true });
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
    const { a0, a1, d0, d1 } = h.ext;
    let left = null, right = null, back = null;
    for (const q of partnersNear(h.cx, h.cz, NEAR + 30)) {
      if (q === h) continue;
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

  const lots = [], lotOf = new Map();
  const fenceSpans = new Map(); // a pair's line -> [{ s0, s1 }] from each of the two lots
  const fences = [];
  for (const h of homes) {
    if (!within(h, LOT_MARGIN)) continue;
    const f = h.frame;
    const half = Math.max(h.box.x1 - h.box.x0, h.box.z1 - h.box.z0) / 2 + BACK_MOST + 15;
    let poly = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => ({ x: h.cx + sx * half, z: h.cz + sz * half, tag: 'square' }));
    const pdot = f.px * f.nx + f.pz * f.nz;
    poly = clipHalf(poly, -f.nx, -f.nz, pdot + h.front, 'front');
    poly = clipHalf(poly, f.nx, f.nz, -(pdot + h.ext.d1 + BACK_MOST), 'back');
    for (const q of pairs.get(h) || []) {
      const line = lineOf(h, q);
      poly = clipHalf(poly, line.ux, line.uz, -line.m, { line: line.flipped ? lines.get(q).get(h) : line, gap: line.gap, partner: q });
    }
    // Off every other road's footpath
    for (const r of env.roadsNear(h.cx, h.cz, NEAR)) {
      if (r.link === h.street.link || r.d < 0.5) continue;
      const nx = (h.cx - r.x) / r.d, nz = (h.cz - r.z) / r.d;
      const k = kerbOf(r.link, r.x, r.z, nx, nz, h.cx, h.cz);
      poly = clipHalf(poly, -nx, -nz, r.x * nx + r.z * nz + k + FOOTPATH + ROAD_INSET, 'road');
    }
    if (poly.length < 3 || !inRing(poly, h.cx, h.cz)) {
      yield;
      continue;
    }
    const lot = { home: h, pts: poly, front: h.front, kerb: h.kerb, frame: f, style: h.house };
    lots.push(lot);
    lotOf.set(h, lot);
    // A row of terraces drawn as one footprint: its lot cut where its facade cuts it into houses, and a fence between their back yards
    const row = HOUSE_STYLES[h.house]?.look?.terrace && h.frontWall ? houseEntry(h.frontWall, h.house)?.row : null;
    if (row) {
      lot.units = unitsOf(lot, row);
      for (const fence of rowFences(lot, row)) fences.push(fence);
    }

    // The fences along it: every side but the front, from FENCE_BACK behind the front line
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const tag = p.tag;
      if (tag === 'front' || tag === 'square') continue;
      // A terrace's side to a street is the end house's own wall, or more of a row the map drew as one footprint, whose doors are on it
      if (tag === 'road' && HOUSE_STYLES[h.house]?.look?.terrace) continue;
      if (typeof tag === 'object' && tag.gap < NO_FENCE) continue;
      const from = h.front + FENCE_BACK;
      const dp = depthOf(f, p.x, p.z), dq = depthOf(f, q.x, q.z);
      if (dp < from && dq < from) continue;
      let a = p, b = q;
      if (dp < from) a = { x: p.x + (q.x - p.x) * ((from - dp) / (dq - dp)), z: p.z + (q.z - p.z) * ((from - dp) / (dq - dp)) };
      if (dq < from) b = { x: p.x + (q.x - p.x) * ((from - dp) / (dq - dp)), z: p.z + (q.z - p.z) * ((from - dp) / (dq - dp)) };
      if (typeof tag === 'object') {
        // Along the pair's own line, from either lot's side of it
        const line = tag.line;
        const wx = -line.uz, wz = line.ux;
        const s0 = a.x * wx + a.z * wz, s1 = b.x * wx + b.z * wz;
        if (!fenceSpans.has(line)) fenceSpans.set(line, { line, spans: [], homes: [] });
        const entry = fenceSpans.get(line);
        entry.spans.push([Math.min(s0, s1), Math.max(s0, s1)]);
        entry.homes.push(h, tag.partner);
      } else {
        fences.push({ a, b, homes: [h] });
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
          b: { x: line.ux * line.m + wx * cur[1], z: line.uz * line.m + wz * cur[1] }, homes: owners });
      }
    };
    for (const s of spans) {
      if (cur && s[0] <= cur[1] + 0.05) cur[1] = Math.max(cur[1], s[1]);
      else { flush(); cur = [...s]; }
    }
    flush();
  }
  yield;

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
  const slabs = [], things = [];
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
      fences: parts.flatMap((o) => o.fences) } : null;
    if (lot.drive) slabs.push(...laid(lot, lot.drive, env));
    if (own) {
      slabs.push(...own.slabs);
      panels.push(...own.panels);
      things.push(...own.boxes);
      finished.push(...own.fences);
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
  return { lots: mine, fences: finished, panels, slabs, things, fronting };
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

/** A lot's extent across its frame at depth d: [least, most] along its road, or [Infinity, -Infinity] where it doesn't reach that deep */
function acrossAt(lot, d) {
  const f = lot.frame, pts = lot.pts;
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
