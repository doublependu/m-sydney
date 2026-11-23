// Houses fitted to their real lots, NSW's cadastre (tools/build-lots.mjs). The lots are surveyed; the map's houses are mostly roofs traced
// from photos, 1-4 m out, and several houses of a pair or a row can be one outline. So:
// - The lots are shifted to the houses: each CELL m square of the map takes the shift, within MAX_SHIFT m, that leaves the least of the
//   lots' lines inside houses; a square with fewer than FEW houses takes the houses of the squares round it too. Each point of a lot moves
//   by the squares' shifts blended between their middles, so lots that share a line still share it.
// - Each house's lot is the one holding most of it. A house within IN m of its lot is in it. One over by MOVE_MOST m or less has each line
//   it's over moved into the gap between its outline and the next house's, halfway, CLEAR m from each where there's room, and MOVE_MOST m
//   at most: the line stays straight, and its ends slide along the lines they meet, so the lots round it follow. One on two lots or more,
//   each holding a fifth of it or more (SPAN) or a quarter of each covered by it (SPAN_LOT: a row of six drawn as one), stands on lines
//   that are shared walls, and so do two houses with no gap between them on a line. One over by more than MOVE_MOST
//   m, or with no lot, falls back on the game's own lot. A lot with two houses or more of SMALL_HOUSE m² is several houses' (a strata
//   scheme, a block of villas on one lot), but for a lot of RURAL m² or more that isn't a strata plan, whose biggest house is its own (a
//   farm's sheds the map styles as houses); smaller ones on a house's lot (a granny flat, a garage) stand in it, as in their own.
// - Only lots with a house are kept; their lines with the lots that aren't are theirs.
import { clipHalf, inRing, insideSpans } from '../../js/house-lots.js';

const CELL = 250; // m: the squares each with a shift of their own
const MAX_SHIFT = 5; // m a square's lots may be shifted, at most
const FEW = 20; // houses: a square with fewer takes the squares' round it
const IN = 0.3; // m a house may stand over its lot's line and be in it
const MOVE_MOST = 2; // m a house may stand over a line that's moved for it
const CLEAR = 0.3; // m a moved line keeps from each outline, where there's room
const SPAN = 0.2; // of a house in each of two lots: it stands on the line between them
const SPAN_LOT = 0.25; // of a lot a house covers, with SPAN_LEAST of the house in it: the house stands on its lines too
const SPAN_LEAST = 0.05;
const SMALL_HOUSE = 60; // m²: a house smaller than this on a bigger house's lot stands in that lot (NSW's most for a granny flat)
const RURAL = 4000; // m²: a lot this big, other than a strata plan's, is its biggest house's whatever else stands on it
const SAMPLE = 0.25; // m between the points a house is sampled at
const ON_LINE = 0.05; // m: points this near a line are on it
const STRAIGHT = 0.004; // sin of the angle two edges of a line may turn by, and still be one straight line
const FRONT_REACH = 12; // m past a road's half width that a lot's edge with no lot beyond it is its frontage

const STRATUM = 2; // `stratum` of a lot limited in height or depth (over a railway, under a road): not the ground's

// --- Geometry ----------------------------------------------------------------------------------------------------------------------

/** Whether (x, z) is in a lot: inside its rings, holes and pieces alike (even-odd) */
function inLot(lot, x, z) {
  let inside = false;
  for (const ring of lot.rings) if (inRing(ring, x, z)) inside = !inside;
  return inside;
}
function signedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
  return a / 2;
}
function segDistance(a, b, x, z) {
  const ex = b.x - a.x, ez = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / (ex * ex + ez * ez || 1)));
  return Math.hypot(a.x + ex * t - x, a.z + ez * t - z);
}
function boundaryDistance(lot, x, z) {
  let best = Infinity;
  for (const ring of lot.rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) best = Math.min(best, segDistance(ring[j], ring[i], x, z));
  return best;
}
const boxOf = (pts) => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z; }
  return { x0, x1, z0, z1 };
};
/** Whether segments pq and rs cross, other than at their ends */
function crosses(p, q, r, s) {
  const d = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  const d1 = d(r, s, p), d2 = d(r, s, q), d3 = d(p, q, r), d4 = d(p, q, s);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}
function simple(ring) {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    for (let k = i + 2; k < n; k++) {
      if (i === 0 && k === n - 1) continue;
      if (crosses(ring[i], ring[(i + 1) % n], ring[k], ring[(k + 1) % n])) return false;
    }
  }
  return true;
}
/** The part of rings in the strip along line a-b (unit d, length L), as points */
function inStrip(rings, a, d, L) {
  const out = [];
  const c0 = d.x * a.x + d.z * a.z;
  for (const ring of rings) {
    let poly = ring.map((p) => ({ x: p.x, z: p.z }));
    poly = clipHalf(poly, -d.x, -d.z, c0, 0);
    poly = clipHalf(poly, d.x, d.z, -c0 - L, 0);
    out.push(...poly);
  }
  return out;
}

/** A spatial index of boxes, CELL_SIZE m cells */
function boxGrid(size) {
  const cells = new Map();
  return {
    add(item, b) {
      for (let ix = Math.floor(b.x0 / size); ix <= Math.floor(b.x1 / size); ix++) {
        for (let iz = Math.floor(b.z0 / size); iz <= Math.floor(b.z1 / size); iz++) {
          const k = ix * 1000003 + iz;
          (cells.get(k) || cells.set(k, []).get(k)).push(item);
        }
      }
    },
    near(x0, z0, x1, z1) {
      const out = new Set();
      for (let ix = Math.floor(x0 / size); ix <= Math.floor(x1 / size); ix++) {
        for (let iz = Math.floor(z0 / size); iz <= Math.floor(z1 / size); iz++) for (const item of cells.get(ix * 1000003 + iz) || []) out.add(item);
      }
      return out;
    }
  };
}

// --- The shift ---------------------------------------------------------------------------------------------------------------------

const cellOf = (v) => Math.floor(v / CELL);

/**
 * Each square's shift: { key 'cx,cz': { dx, dz, houses } }, from the houses whose middle is in it (and its neighbours', where it has fewer
 * than FEW), and the lots' unique lines `lines` ([a, b] points), in a boxGrid.
 */
function cellShifts(houses, lines, lineGrid) {
  const byCell = new Map();
  for (const h of houses) {
    const k = `${cellOf(h.cx)},${cellOf(h.cz)}`;
    (byCell.get(k) || byCell.set(k, []).get(k)).push(h);
  }
  const reach = MAX_SHIFT + 1;
  const linesNear = new Map();
  const near = (h) => {
    let ls = linesNear.get(h);
    if (!ls) {
      ls = [...lineGrid.near(h.box.x0 - reach, h.box.z0 - reach, h.box.x1 + reach, h.box.z1 + reach)];
      linesNear.set(h, ls);
    }
    return ls;
  };
  const score = (set, dx, dz) => {
    let metres = 0;
    for (const h of set) {
      for (const [a, b] of near(h)) {
        const p = { x: a.x + dx, z: a.z + dz }, q = { x: b.x + dx, z: b.z + dz };
        if (Math.max(p.x, q.x) < h.box.x0 || Math.min(p.x, q.x) > h.box.x1 || Math.max(p.z, q.z) < h.box.z0 || Math.min(p.z, q.z) > h.box.z1) continue;
        const L = Math.hypot(q.x - p.x, q.z - p.z);
        for (const [t0, t1] of insideSpans(p, q, h.rings)) metres += (t1 - t0) * L;
      }
    }
    return metres;
  };
  // Every square with houses within two squares of it
  const wanted = new Set();
  for (const k of byCell.keys()) {
    const [cx, cz] = k.split(',').map(Number);
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) wanted.add(`${cx + i},${cz + j}`);
  }
  const shifts = new Map();
  for (const k of [...wanted].sort()) {
    const [cx, cz] = k.split(',').map(Number);
    let set = [];
    for (let r = 0; r <= 2; r++) {
      set = [];
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) set.push(...(byCell.get(`${cx + i},${cz + j}`) || []));
      if (set.length >= FEW) break;
    }
    if (!set.length) continue;
    // The least line, and of shifts that leave as little, the least shift (a centimetre of line for each metre)
    let best = { dx: 0, dz: 0, m: score(set, 0, 0), cost: 0 };
    best.cost = best.m;
    const at0 = best.m;
    for (const [step, R] of [[1, MAX_SHIFT], [0.25, 0.75]]) {
      const c = best;
      for (let dx = c.dx - R; dx <= c.dx + R + 1e-9; dx += step) {
        for (let dz = c.dz - R; dz <= c.dz + R + 1e-9; dz += step) {
          const off = Math.hypot(dx, dz);
          if (off > MAX_SHIFT + 1e-9 || (dx === c.dx && dz === c.dz)) continue;
          const m = score(set, dx, dz), cost = m + 0.01 * off;
          if (cost < best.cost - 1e-9) best = { dx, dz, m, cost };
        }
      }
    }
    shifts.set(k, { dx: best.dx, dz: best.dz, houses: set.length, own: byCell.get(k)?.length || 0, before: at0, after: best.m });
  }
  return shifts;
}

/** The shift at (x, z): the squares' blended between their middles */
function shiftAt(shifts, x, z) {
  const fx = x / CELL - 0.5, fz = z / CELL - 0.5;
  const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
  let dx = 0, dz = 0, w = 0;
  for (const [i, j, k] of [[0, 0, (1 - tx) * (1 - tz)], [1, 0, tx * (1 - tz)], [0, 1, (1 - tx) * tz], [1, 1, tx * tz]]) {
    const s = shifts.get(`${ix + i},${iz + j}`);
    if (!s || k === 0) continue;
    dx += s.dx * k; dz += s.dz * k; w += k;
  }
  return w > 0 ? { dx: dx / w, dz: dz / w } : { dx: 0, dz: 0 };
}

// --- The fit -----------------------------------------------------------------------------------------------------------------------

/**
 * `lots`: [{ id, plan, cls, stratum, rings: [[{ x, z }]] }] in the world's metres, as fetched (no closing point). `houses`: [{ cx, cz, rings,
 * box }] (js/house-lots.js wholesOf()'s houses), `others`: the buildings that aren't houses a moved line keeps clear of, `roads`: [{ pts,
 * width }] on the ground. `fitted(h)`: whether house h's lot is wanted (those further out are only for the shift and the lines between);
 * `active(h)`: whether lines may be moved for it (the houses whose moves can reach a fitted house's lot, for the same lots either side of
 * a tile's edge).
 * Returns { lots, homes, shifts, measure }: `homes` each fitted house's { house, rule, over, before, lots }, `lots` those with a home,
 * each { lot, kind, homes, rings, edges } (rings as js/tiles/lot-file.js has them).
 */
function fitLots({ lots: fetched, houses, others = [], roads = [], fitted = () => true, active = () => true }) {
  const measure = { lots: fetched.length, stratum: 0, overlapping: 0, moves: 0, movesUndone: 0, blocked: 0, tight: 0, ms: {} };
  let clock = performance.now();
  const lap = (name) => { const t = performance.now(); measure.ms[name] = Math.round(t - clock); clock = t; };
  // The ground's lots only, their points shared where two lots meet (to the centimetre), so a moved point moves in each
  const verts = new Map();
  const vertexAt = (x, z) => {
    const k = `${Math.round(x * 100)},${Math.round(z * 100)}`;
    let v = verts.get(k);
    if (!v) verts.set(k, (v = { x, z, x0: x, z0: z, refs: [] }));
    return v;
  };
  const lots = [];
  for (const f of fetched) {
    if (f.stratum === STRATUM) { measure.stratum++; continue; }
    const lot = { id: f.id, plan: f.plan, cls: f.cls, rings: [] };
    for (const r of f.rings) {
      const ring = [];
      for (const p of r) {
        const v = vertexAt(p.x, p.z);
        if (ring[ring.length - 1] !== v && ring[0] !== v) ring.push(v);
      }
      if (ring.length >= 3) lot.rings.push(ring);
    }
    if (!lot.rings.length) continue;
    lot.rings.forEach((ring, r) => ring.forEach((v, i) => v.refs.push([lot, r, i])));
    lots.push(lot);
  }
  // The lines, once each, for the shift
  const lineGrid = boxGrid(20), seen = new Set(), lines = [];
  for (const lot of lots) {
    for (const ring of lot.rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const k = a.x0 < b.x0 || (a.x0 === b.x0 && a.z0 < b.z0) ? `${a.x0},${a.z0},${b.x0},${b.z0}` : `${b.x0},${b.z0},${a.x0},${a.z0}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const line = [{ x: a.x0, z: a.z0 }, { x: b.x0, z: b.z0 }];
        lines.push(line);
        lineGrid.add(line, boxOf(line));
      }
    }
  }
  lap('lots');
  const shifts = cellShifts(houses, lines, lineGrid);
  lap('shift');
  for (const v of verts.values()) {
    const s = shiftAt(shifts, v.x0, v.z0);
    v.xs = v.x = v.x0 + s.dx;
    v.zs = v.z = v.z0 + s.dz;
  }
  let lotGrid;
  const indexLots = () => {
    lotGrid = boxGrid(40);
    for (const lot of lots) {
      lot.box = boxOf(lot.rings.flat());
      lotGrid.add(lot, lot.box);
    }
  };
  indexLots();
  for (const lot of lots) lot.area0 = Math.abs(lot.rings.reduce((s, r) => s + signedArea(r), 0));
  const inBox = (l, x, z) => x >= l.box.x0 && x <= l.box.x1 && z >= l.box.z0 && z <= l.box.z1;
  const lotsAt = (x, z) => [...lotGrid.near(x, z, x, z)].filter((l) => inBox(l, x, z) && inLot(l, x, z));

  // Each house sampled against the lots: which holds most of it, how much each holds, how far it stands over its main one
  const sampleOf = (h) => {
    const counts = new Map();
    const pts = [];
    let total = 0, overlapping = 0;
    const cand = [...lotGrid.near(h.box.x0, h.box.z0, h.box.x1, h.box.z1)];
    for (let x = h.box.x0 + SAMPLE / 2; x < h.box.x1; x += SAMPLE) {
      for (let z = h.box.z0 + SAMPLE / 2; z < h.box.z1; z += SAMPLE) {
        if (!h.rings.some((r) => inRing(r, x, z))) continue;
        total++;
        const holding = cand.filter((l) => inBox(l, x, z) && inLot(l, x, z));
        if (holding.length > 1) overlapping++;
        const l = holding.length > 1 ? holding.reduce((p, q) => (q.area0 < p.area0 ? q : p)) : holding[0] || null;
        counts.set(l, (counts.get(l) || 0) + 1);
        pts.push(x, z, l);
      }
    }
    const ranked = [...counts.entries()].filter(([l]) => l).sort((a, b) => b[1] - a[1] || a[0].id - b[0].id);
    if (!ranked.length) return { total, main: null, shares: [], spans: [], over: Infinity, out: Infinity, overlapping };
    // How far it stands over its lot into another (over a frontage onto the street, or past a lot with nothing beyond, is `out`: the game
    // keeps its own front line, and no lot's beyond)
    const main = ranked[0][0];
    let over = 0, out = 0;
    for (let i = 0; i < pts.length; i += 3) {
      if (pts[i + 2] === main) continue;
      const d = boundaryDistance(main, pts[i], pts[i + 1]);
      if (pts[i + 2]) over = Math.max(over, d);
      else out = Math.max(out, d);
    }
    // The lots it stands on: those holding a fifth of it or more, or a quarter of which it covers
    const shares = ranked.map(([l, n]) => ({ lot: l, share: n / total }));
    const spans = shares.filter((x) => x.share >= SPAN || (x.share >= SPAN_LEAST && (x.share * total * SAMPLE * SAMPLE) / x.lot.area0 >= SPAN_LOT));
    return { total, main, shares, spans, over, out, overlapping };
  };

  const order = [...houses].sort((a, b) => a.cz - b.cz || a.cx - b.cx);
  const first = new Map();
  for (const h of order) {
    const s = sampleOf(h);
    first.set(h, s);
    if (s.overlapping) measure.overlapping++;
  }
  lap('sample');

  // Lines moved into the gaps
  const vertGrid = boxGrid(10);
  for (const v of verts.values()) vertGrid.add(v, { x0: v.x, x1: v.x, z0: v.z, z1: v.z });
  const obstacles = boxGrid(40);
  for (const o of [...houses, ...others]) obstacles.add(o, o.box);
  const movedLines = [], blockedLines = [];
  const normalOut = (lot, a, b) => {
    const L = Math.hypot(b.x - a.x, b.z - a.z), d = { x: (b.x - a.x) / L, z: (b.z - a.z) / L };
    let n = { x: d.z, z: -d.x };
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    if (inLot(lot, mx + n.x * 0.05, mz + n.z * 0.05)) n = { x: -n.x, z: -n.z };
    return { d, n, L };
  };
  /**
   * Line a-b (its points `chain` and any other lot's on it) moved by o along n, its normal: each point on it slides along the line it meets
   * that's most square to it, or straight out along n
   */
  const moveLine = (a, b, n, o, chain) => {
    const L = Math.hypot(b.x - a.x, b.z - a.z), d = { x: (b.x - a.x) / L, z: (b.z - a.z) / L };
    const R = ON_LINE + 5;
    const on = [...new Set([...chain, ...[...vertGrid.near(Math.min(a.x, b.x) - R, Math.min(a.z, b.z) - R, Math.max(a.x, b.x) + R, Math.max(a.z, b.z) + R)].filter((v) => {
      const t = (v.x - a.x) * d.x + (v.z - a.z) * d.z, s = (v.x - a.x) * n.x + (v.z - a.z) * n.z;
      return Math.abs(s) <= ON_LINE && t >= -ON_LINE && t <= L + ON_LINE;
    })])];
    const was = on.map((v) => [v, v.x, v.z]);
    const touched = new Set();
    const moves = [];
    for (const v of on) {
      let slide = null, best = 0.5; // sin 30°: along a line nearer the moved one's way than that, it moves straight out
      for (const [lot, r, i] of v.refs) {
        touched.add(lot);
        const ring = lot.rings[r];
        for (const u of [ring[(i + ring.length - 1) % ring.length], ring[(i + 1) % ring.length]]) {
          if (on.includes(u)) continue;
          const wl = Math.hypot(u.x - v.x, u.z - v.z);
          if (wl < 1e-6) continue;
          const w = { x: (u.x - v.x) / wl, z: (u.z - v.z) / wl };
          const sq = Math.abs(w.x * d.z - w.z * d.x);
          if (sq > best) { best = sq; slide = w; }
        }
      }
      const s0 = (v.x - a.x) * n.x + (v.z - a.z) * n.z;
      if (slide) {
        const k = (o - s0) / (slide.x * n.x + slide.z * n.z);
        moves.push([v, v.x + slide.x * k, v.z + slide.z * k]);
      } else moves.push([v, v.x + n.x * (o - s0), v.z + n.z * (o - s0)]);
    }
    for (const [v, x, z] of moves) { v.x = x; v.z = z; }
    // Each lot it touched still one simple shape, and at least half what it was
    const ok = [...touched].every((lot) => lot.rings.every(simple) && Math.abs(lot.rings.reduce((s, r) => s + signedArea(r), 0)) >= 0.5 * lot.area0);
    if (!ok) {
      for (const [v, x, z] of was) { v.x = x; v.z = z; }
      return false;
    }
    for (const lot of touched) lot.box = boxOf(lot.rings.flat());
    return true;
  };

  const movedHouses = new Set(), blockedHouses = new Set();
  const why = new Map(); // house -> what each line it stood over came to, for measuring
  const note = (h, w) => (why.get(h) || why.set(h, []).get(h)).push(w);
  for (const h of order) {
    const s = first.get(h);
    if (!active(h) || !s.main || s.over <= IN || s.over > MOVE_MOST || s.spans.length >= 2) continue;
    const L0 = s.main;
    for (const ring of L0.rings) {
      for (let i = 0; i < ring.length; i++) {
        let a = ring[i], b = ring[(i + 1) % ring.length];
        if (a === b) continue;
        const e = normalOut(L0, a, b);
        if (e.L < 0.3) continue;
        const pts = inStrip(h.rings, a, e.d, e.L);
        const dmax0 = Math.max(-Infinity, ...pts.map((p) => (p.x - a.x) * e.n.x + (p.z - a.z) * e.n.z));
        if (!(dmax0 > IN)) continue;
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
        const beyond = lotsAt(mx + e.n.x * 0.3, mz + e.n.z * 0.3).filter((l) => l !== L0);
        if (!beyond.length) { note(h, 'no lot beyond'); continue; } // a frontage, or no lot beyond: the line stays
        const N = beyond[0];
        // The line along the lot's side to that lot: on, either way, while it runs straight
        let ia = i, ib = (i + 1) % ring.length;
        for (let k = 0; k < ring.length; k++) {
          const p = ring[(ia + ring.length - 1) % ring.length];
          const f = normalOut(L0, p, ring[ia]);
          if (f.L < 1e-6 || Math.abs(f.d.x * e.d.z - f.d.z * e.d.x) > STRAIGHT || f.d.x * e.d.x + f.d.z * e.d.z < 0) break;
          if (!lotsAt((p.x + ring[ia].x) / 2 + f.n.x * 0.3, (p.z + ring[ia].z) / 2 + f.n.z * 0.3).includes(N)) break;
          ia = (ia + ring.length - 1) % ring.length;
          if (ia === ib) break;
        }
        for (let k = 0; k < ring.length; k++) {
          const q = ring[(ib + 1) % ring.length];
          const f = normalOut(L0, ring[ib], q);
          if (f.L < 1e-6 || Math.abs(f.d.x * e.d.z - f.d.z * e.d.x) > STRAIGHT || f.d.x * e.d.x + f.d.z * e.d.z < 0) break;
          if (!lotsAt((q.x + ring[ib].x) / 2 + f.n.x * 0.3, (q.z + ring[ib].z) / 2 + f.n.z * 0.3).includes(N)) break;
          ib = (ib + 1) % ring.length;
          if (ib === ia) break;
        }
        const chain = [];
        for (let k = ia; ; k = (k + 1) % ring.length) { chain.push(ring[k]); if (k === ib) break; }
        a = ring[ia]; b = ring[ib];
        const line = normalOut(L0, a, b);
        if (line.L < 0.3) continue;
        const n = line.n;
        const hp = inStrip(h.rings, a, line.d, line.L);
        const dmax = Math.max(...hp.map((p) => (p.x - a.x) * n.x + (p.z - a.z) * n.z));
        let dmin = Infinity;
        const sb = boxOf([a, b]);
        for (const o of obstacles.near(sb.x0 - 6, sb.z0 - 6, sb.x1 + 6, sb.z1 + 6)) {
          if (o === h) continue;
          const op = inStrip(o.rings, a, line.d, line.L);
          if (!op.length) continue;
          const ds = op.map((p) => (p.x - a.x) * n.x + (p.z - a.z) * n.z);
          if (Math.max(...ds) <= dmax) continue; // on the house's side
          dmin = Math.min(dmin, ...ds);
        }
        // Halfway into the gap, CLEAR from each outline, and no more than MOVE_MOST m (or CLEAR past the house, where that's more)
        let o;
        const lo = dmax + CLEAR, hi = dmin - CLEAR;
        if (dmin - dmax > 0 && lo > hi) {
          o = (dmax + dmin) / 2;
          measure.tight++;
        } else if (dmin - dmax > 0) {
          o = Math.min(Math.max(dmin === Infinity ? lo : (dmax + dmin) / 2, lo), Math.min(hi, Math.max(lo, MOVE_MOST)));
        } else {
          // No gap: the two outlines run into each other over the line, which is a shared wall
          blockedLines.push({ a: { x: a.x, z: a.z }, b: { x: b.x, z: b.z } });
          blockedHouses.add(h);
          measure.blocked++;
          note(h, 'blocked');
          continue;
        }
        const was = { a: { x: a.x + n.x * o, z: a.z + n.z * o }, b: { x: b.x + n.x * o, z: b.z + n.z * o } };
        if (moveLine(a, b, n, o, chain)) {
          measure.moves++;
          movedHouses.add(h);
          movedLines.push(was);
          note(h, 'moved');
        } else { measure.movesUndone++; note(h, 'undone'); }
      }
    }
  }

  lap('move');
  // Each house's rule, on the lots as they are now
  indexLots();
  const homes = [];
  const homesOf = new Map();
  const after = new Map();
  const onLot = new Map(); // lot -> the houses it holds most of, that don't stand on its lines with another
  for (const h of order) {
    const s = sampleOf(h);
    after.set(h, s);
    if (!s.main || first.get(h).over > MOVE_MOST || s.spans.length >= 2) continue;
    (onLot.get(s.main) || onLot.set(s.main, []).get(s.main)).push(h);
  }
  // On each lot, its biggest house, and the houses that stand in its lot (smaller than SMALL_HOUSE and half its size); several houses'
  // where two or more others are left, but on a lot of RURAL m² that isn't a strata plan's
  const biggest = new Map(), standing = new Set(), several = new Set();
  for (const [lot, hs] of onLot) {
    const big = hs.reduce((p, q) => (q.area > p.area ? q : p));
    biggest.set(lot, big);
    for (const h of hs) if (h !== big && h.area < SMALL_HOUSE && h.area < big.area / 2) standing.add(h);
    const own = hs.filter((h) => !standing.has(h));
    if (own.length >= 2 && (lot.area0 < RURAL || lot.plan === 'SP')) for (const h of own) several.add(h);
    else for (const h of own) if (h !== big) standing.add(h);
  }
  for (const h of order) {
    if (!fitted(h)) continue;
    const b = first.get(h), s = after.get(h);
    const spans = s.spans;
    let rule, on = [];
    if (!s.main || (b.over > MOVE_MOST && spans.length < 2)) rule = 'fallback';
    else if (spans.length >= 2 && s.over > IN) { rule = 'wall'; on = spans.map((x) => x.lot); }
    else if (several.has(h)) { rule = 'several'; on = [s.main]; }
    else if (standing.has(h)) { rule = 'in'; on = [s.main]; } // standing in a bigger house's lot
    else if (movedHouses.has(h)) { rule = 'moved'; on = [s.main]; }
    else if (blockedHouses.has(h)) { rule = 'wall'; on = [s.main]; }
    else { rule = 'in'; on = [s.main]; }
    const home = { house: h, rule, before: b.over, over: s.over, out: s.out, lots: on, why: why.get(h) || [] };
    homes.push(home);
    for (const l of on) (homesOf.get(l) || homesOf.set(l, []).get(l)).push(home);
  }

  lap('rules');
  // The lots kept, each edge's kind
  const onLine = (list, a, b) => {
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 1e-6) return false;
    const d = { x: (b.x - a.x) / L, z: (b.z - a.z) / L };
    return list.some((m) => {
      const ml = Math.hypot(m.b.x - m.a.x, m.b.z - m.a.z);
      const md = { x: (m.b.x - m.a.x) / ml, z: (m.b.z - m.a.z) / ml };
      const t = (mx - m.a.x) * md.x + (mz - m.a.z) * md.z, s = (mx - m.a.x) * md.z - (mz - m.a.z) * md.x;
      return Math.abs(d.x * md.z - d.z * md.x) < 0.05 && t > -0.05 && t < ml + 0.05 && Math.abs(s) < 0.1;
    });
  };
  const roadGrid = boxGrid(40);
  for (const r of roads) {
    for (let i = 1; i < r.pts.length; i++) {
      const seg = { a: r.pts[i - 1], b: r.pts[i], width: r.width };
      roadGrid.add(seg, boxOf([seg.a, seg.b]));
    }
  }
  const frontage = (x, z) => [...roadGrid.near(x - 30, z - 30, x + 30, z + 30)].some((s) => segDistance(s.a, s.b, x, z) <= s.width / 2 + FRONT_REACH);
  const kept = [];
  for (const lot of lots) {
    const hs = homesOf.get(lot);
    if (!hs) continue;
    // The outer ring counter-clockwise (positive), holes the other way round: a ring inside another of the lot's is a hole
    const rings = lot.rings.map((ring) => ring.map((v) => ({ x: v.x, z: v.z })));
    const holes = rings.map((r, k) => rings.some((o, j) => j !== k && Math.abs(signedArea(o)) > Math.abs(signedArea(r)) && inRing(o, r[0].x, r[0].z)));
    rings.forEach((r, k) => { if ((signedArea(r) > 0) === holes[k]) r.reverse(); });
    const edges = rings.map((ring) => ring.map((a, i) => {
      const b = ring[(i + 1) % ring.length];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 1e-6) return 'side';
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      let nx = (b.z - a.z) / L, nz = -(b.x - a.x) / L;
      if (inLot(lot, mx + nx * 0.05, mz + nz * 0.05)) { nx = -nx; nz = -nz; }
      const other = lotsAt(mx + nx * 0.3, mz + nz * 0.3).find((l) => l !== lot);
      if (other) {
        if ((homesOf.get(other) || []).some((h) => hs.includes(h))) return 'wall';
        if (onLine(movedLines, a, b)) return 'moved';
        if (onLine(blockedLines, a, b)) return 'wall';
        return 'side';
      }
      return frontage(mx, mz) ? 'front' : 'bound';
    }));
    // The lot's own house first: its biggest, where the others stand in it
    const homesIn = [...hs].sort((p, q) => q.house.area - p.house.area);
    kept.push({ lot, kind: hs.filter((h) => h.rule === 'several').length >= 2 ? 'several' : 'fitted', homes: homesIn, rings, edges });
  }
  lap('edges');
  return { lots: kept, homes, shifts, measure, all: lots };
}

/**
 * How much real line runs inside `houses` (m): every lot's lines as fetched (`fetched`) and once shifted (`shifted`), and the kept lots'
 * as fitted, by their edges' kind (`fitted`), each line once
 */
function insideLines(result, houses) {
  const grid = boxGrid(40);
  for (const h of houses) grid.add(h, h.box);
  const inside = (a, b) => {
    let m = 0;
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    for (const h of grid.near(Math.min(a.x, b.x), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.z, b.z))) {
      if (Math.max(a.x, b.x) < h.box.x0 || Math.min(a.x, b.x) > h.box.x1 || Math.max(a.z, b.z) < h.box.z0 || Math.min(a.z, b.z) > h.box.z1) continue;
      for (const [t0, t1] of insideSpans(a, b, h.rings)) m += (t1 - t0) * L;
    }
    return m;
  };
  const key = (a, b) => {
    const p = `${Math.round(a.x * 20)},${Math.round(a.z * 20)}`, q = `${Math.round(b.x * 20)},${Math.round(b.z * 20)}`;
    return p < q ? p + '|' + q : q + '|' + p;
  };
  const out = { fetched: 0, shifted: 0, fitted: {} };
  for (const [name, X, Z] of [['fetched', 'x0', 'z0'], ['shifted', 'xs', 'zs']]) {
    const seen = new Set();
    for (const lot of result.all) {
      for (const ring of lot.rings) {
        for (let i = 0; i < ring.length; i++) {
          const a = { x: ring[i][X], z: ring[i][Z] }, b = { x: ring[(i + 1) % ring.length][X], z: ring[(i + 1) % ring.length][Z] };
          const k = key(a, b);
          if (seen.has(k)) continue;
          seen.add(k);
          out[name] += inside(a, b);
        }
      }
    }
  }
  const seen = new Set();
  for (const lot of result.lots) {
    lot.rings.forEach((ring, r) => ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length], k = key(a, b);
      if (seen.has(k)) return;
      seen.add(k);
      const kind = lot.edges[r][i];
      out.fitted[kind] = (out.fitted[kind] || 0) + inside(a, b);
    }));
  }
  const r = (v) => Math.round(v);
  return { fetched: r(out.fetched), shifted: r(out.shifted), fitted: Object.fromEntries(Object.entries(out.fitted).map(([k, v]) => [k, r(v)])) };
}

export { CELL, CLEAR, FEW, IN, MAX_SHIFT, MOVE_MOST, SPAN, SPAN_LOT, fitLots, inLot, insideLines, shiftAt };
