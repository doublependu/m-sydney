// tools/garden/raised-lawn.mjs: a formal garden's raised lawn and its paved areas, traced from a raster of what's raised, for
// tools/build-garden.mjs: the hand-made areas a cluster at a time, the parks by rule a 240 m square at a time (tools/garden/rule-parks.mjs).
// In a formal park the lawn stands RAISE over the map's (js/garden.js), with a kerb along every edge of it and its paved paths down
// between: the map's lawn in the park (its pieces, tools/geodata/region-worker.mjs) less a corridor along each kerbed path, steps too
// (half its width and the kerb's: the kerb stands in the corridor, at the path's edge), and less the water (the kerb round a pond stands in
// its water, under its coping; a lake's bank, js/garden.js, is kept clear). Tracks are worn into it, not cut out of it; beds and hedges stand
// on it. A gate stands on its path, its pillars on the lawn either side, so its opening is the path's corridor. Traced in the map's 240 m
// squares, as its lawns are, so each piece is cheap to lay on the lawn's triangles; each traced point is then moved onto what its cells
// stand for (a corridor's edge, a pond's edge, the lawn's or the park's outline), so a kerb stands at its path's edge, not wherever the
// cells put it, and kept to the centimetre. Nor is it raised where the map draws a beach's sand or the coast's rock over the lawn
// (tools/build-sand.mjs): it stops at their edge.
import { Raster, bbox, ringArea, tiledPolygons } from '../geo-common.mjs';

export const RAISED_RES = 0.5; // m: the raster's cells
export const KERB = 0.1; // m: the kerb's width (js/garden.js)
const SNAP = 0.6; // m a traced point may move onto what its cells stand for
const MIN_LAWN = 1; // m²: smaller pieces of raised lawn, and holes in it, are left out
const SLIVER = 0.3; // m: raised lawn narrower than twice this is left out
const SPIKE = 0.06; // m²: a traced point that turns the ring back on itself, the triangle with its two neighbours smaller than this, is left out
export const SQUARE = 240; // m: the map's lawns' squares (tools/geodata/region-worker.mjs)
const LINE_CELL = 8;
/** Whether a path of `kind` and `surface` is kerbed: tracks aren't, and trodden grass that isn't one isn't drawn */
export const kerbed = (kind, surface) => kind !== 3 && surface !== 4;
/** Each point's way across a polyline ([[x, z], ...]), with its mitre's stretch, as js/garden.js across() draws a path's */
const mitres = (pts) => pts.map((p, i) => {
  const unit = (x, z) => { const L = Math.hypot(x, z) || 1; return [x / L, z / L]; };
  const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
  const prev = i > 0 ? unit(p[0] - a[0], p[1] - a[1]) : null, next = i < pts.length - 1 ? unit(b[0] - p[0], b[1] - p[1]) : null;
  const d = prev && next ? unit(prev[0] + next[0], prev[1] + next[1]) : prev || next;
  const stretch = prev && next ? Math.min(2, 1 / Math.max(0.5, d[0] * next[0] + d[1] * next[1])) : 1;
  return [-d[1] * stretch, d[0] * stretch];
});
const q2 = (v) => Math.round(v * 100) / 100;
const pointsOf = (f) => { const out = []; for (let k = 0; k + 1 < f.length; k += 2) out.push([f[k], f[k + 1]]); return out; };

/**
 * The raised lawn and the paved areas in `box` (on the 240 m squares' lines), from:
 * - `fill(raised, ringLines)`: marks the cells it's raised in (1) or not (0), with ringLines(ring) for each ring it fills by;
 * - `lawns`: the map's lawn pieces (each [outer, ...holes], flat rings); `plazas`: paved areas [{ surface, rings }];
 * - `paths`: the garden's paths [kind, surface, width, x, z, ...], whose kerbed ones' corridors it's cut along;
 * - `wet`: [{ ring: [[x, z], ...], val, bank }] in order: water (1) and islands in it (0), with `bank` m round its edge kept clear too;
 * - `sand`: the sand and rock pieces [kind, outer, ...holes] (tools/sand-pieces.mjs); `kerbOf(outer)`: what a piece's kerbs are, 0 or 1.
 * `margin`: m of cells round the box it's worked out on too, though only the box is traced, so a square traced alone has its edges as a
 * bigger raster would; `crossing`: a path counts where its box reaches the box, not only where one of its points is near it (a square). Returns { lawns: [[kerb, outer, ...holes]], plazas: [[surface, outer, ...holes]], stats }, rings [x, z, ...].
 */
export function traceRaised({ box, margin = 0, fill, lawns, plazas, paths, wet, sand, kerbOf, crossing = false }) {
  const out = { lawns: [], plazas: [], stats: { pieces: 0, area: 0, moved: 0, kept: 0, corners: 0, plazaArea: 0 } };
  const st = out.stats;
  const rbox = margin ? { x0: box.x0 - margin, z0: box.z0 - margin, x1: box.x1 + margin, z1: box.z1 + margin } : box;
  const blank = () => new Raster(rbox.x0, rbox.z0, rbox.x1 - RAISED_RES, rbox.z1 - RAISED_RES, RAISED_RES);
  // What its cells stand for, as lines: each { a, b, r }, the edge r out from the segment a-b
  const lines = new Map();
  const addLine = (a, b, r = 0) => {
    const s = { a, b, r };
    for (let cx = Math.floor((Math.min(a[0], b[0]) - r - SNAP) / LINE_CELL); cx <= Math.floor((Math.max(a[0], b[0]) + r + SNAP) / LINE_CELL); cx++) {
      for (let cz = Math.floor((Math.min(a[1], b[1]) - r - SNAP) / LINE_CELL); cz <= Math.floor((Math.max(a[1], b[1]) + r + SNAP) / LINE_CELL); cz++) {
        const key = cx * 100000 + cz;
        (lines.get(key) || lines.set(key, []).get(key)).push(s);
      }
    }
  };
  // A lawn piece's edge along its square's (a seam, where the next piece goes on) is nothing to stand at
  const onSeam = (a, b) => (a[0] === b[0] && Math.abs(a[0] / SQUARE - Math.round(a[0] / SQUARE)) < 1e-9)
    || (a[1] === b[1] && Math.abs(a[1] / SQUARE - Math.round(a[1] / SQUARE)) < 1e-9);
  const ringLines = (ring, r = 0) => { for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) if (!onSeam(ring[j], ring[i])) addLine(ring[j], ring[i], r); };
  const inBox = (pts) => pts.some(([x, z]) => x >= rbox.x0 - 10 && x <= rbox.x1 + 10 && z >= rbox.z0 - 10 && z <= rbox.z1 + 10);
  // ...or, with `crossing`, a line whose box is: one straight segment can cross a 240 m square with both its ends outside it
  const across = (pts) => {
    if (!crossing) return inBox(pts);
    const b = bbox(pts);
    return b.x1 >= rbox.x0 - 10 && b.x0 <= rbox.x1 + 10 && b.z1 >= rbox.z0 - 10 && b.z0 <= rbox.z1 + 10;
  };

  // Where it's raised, less what's left out of it
  const raised = blank();
  fill(raised, ringLines);
  // ...where the map has lawn: each piece's outline less its holes
  const lawn = blank();
  for (const rings of lawns) {
    const pts = rings.map(pointsOf);
    if (!inBox(pts[0])) continue;
    lawn.fillRing(pts[0], 1);
    for (const hole of pts.slice(1)) lawn.fillRing(hole, 0);
    for (const ring of pts) ringLines(ring);
  }
  for (let i = 0; i < raised.d.length; i++) raised.d[i] &= lawn.d[i];
  // ...less the paved areas, each surface's traced on its own (below) where it's on the map's lawn in the garden
  const plazaBy = new Map();
  for (const p of plazas) {
    if (!inBox(p.rings[0])) continue;
    const r = plazaBy.get(p.surface) || plazaBy.set(p.surface, blank()).get(p.surface);
    r.fillRing(p.rings[0], 1);
    for (const hole of p.rings.slice(1)) r.fillRing(hole, 0);
    for (const ring of p.rings) ringLines(ring);
  }
  for (const r of plazaBy.values()) {
    for (let i = 0; i < r.d.length; i++) {
      r.d[i] &= raised.d[i];
      if (r.d[i]) raised.d[i] = 0;
    }
  }
  // ...less the corridors of its kerbed paths and steps, and its water
  // A corridor is its path as js/garden.js draws it (mitred where it bends: pathPieces()), KERB wider either side, and KERB past each end:
  // its kerb across a path that ends on the lawn
  for (const [kind, surface, width, ...line] of paths) {
    if (!kerbed(kind, surface)) continue;
    const pts = pointsOf(line);
    if (!across(pts)) continue;
    const r = width / 2 + KERB;
    const side = mitres(pts);
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-3) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      const back = i === 1 ? KERB : 0, on = i === pts.length - 1 ? KERB : 0;
      const a = [ax - ux * back, az - uz * back], b = [bx + ux * on, bz + uz * on];
      const [sa, sb] = [side[i - 1], side[i]];
      const quad = [[a[0] + sa[0] * r, a[1] + sa[1] * r], [b[0] + sb[0] * r, b[1] + sb[1] * r], [b[0] - sb[0] * r, b[1] - sb[1] * r], [a[0] - sa[0] * r, a[1] - sa[1] * r]];
      raised.fillRing(quad, 0);
      addLine(quad[0], quad[1]);
      addLine(quad[3], quad[2]);
      if (back) addLine(quad[0], quad[3]);
      if (on) addLine(quad[1], quad[2]);
    }
  }
  // ...its water, that is: not its islands, which are lawn as the park's round it is; and a bank round it, where it has one
  const wetCells = blank();
  let anyWet = false;
  for (const { ring, val, bank = 0 } of wet) {
    if (!inBox(ring)) continue;
    wetCells.fillRing(ring, val);
    ringLines(ring, bank);
    anyWet = true;
  }
  for (const { ring, bank = 0 } of wet) {
    if (!bank || !inBox(ring)) continue;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      if (!onSeam(ring[j], ring[i])) wetCells.stampSegment(ring[j][0], ring[j][1], ring[i][0], ring[i][1], bank, 1);
    }
  }
  if (anyWet) {
    for (let i = 0; i < wetCells.d.length; i++) {
      if (!wetCells.d[i]) continue;
      raised.d[i] = 0;
      for (const r of plazaBy.values()) r.d[i] = 0;
    }
  }
  // ...and the sand and rock on land, each piece's outline less its holes: a piece over no raised lawn adds no lines to move points onto
  for (const [kind, ...flats] of sand) {
    if (kind > 1) continue;
    const rings = flats.map(pointsOf);
    if (!inBox(rings[0])) continue;
    const b = bbox(rings[0]);
    // Its own cells, on the same grid as the garden's: none where it's only within the 10 m round it
    const px0 = Math.max(b.x0, rbox.x0), pz0 = Math.max(b.z0, rbox.z0), px1 = Math.min(b.x1, rbox.x1 - RAISED_RES), pz1 = Math.min(b.z1, rbox.z1 - RAISED_RES);
    const cells = (a0, a1) => Math.ceil((a1 - Math.floor(a0 / RAISED_RES) * RAISED_RES) / RAISED_RES) + 1;
    if (cells(px0, px1) < 1 || cells(pz0, pz1) < 1) continue;
    const piece = new Raster(px0, pz0, px1, pz1, RAISED_RES);
    piece.fillRing(rings[0], 1);
    for (const hole of rings.slice(1)) piece.fillRing(hole, 0);
    const di = Math.round((piece.x0 - raised.x0) / RAISED_RES), dj = Math.round((piece.z0 - raised.z0) / RAISED_RES);
    let cut = 0;
    for (let j = 0; j < piece.h; j++) {
      for (let i = 0; i < piece.w; i++) {
        const k = (j + dj) * raised.w + i + di;
        if (piece.d[j * piece.w + i] && i + di < raised.w && j + dj < raised.h && raised.d[k]) { raised.d[k] = 0; cut++; }
      }
    }
    if (cut) for (const ring of rings) ringLines(ring);
  }

  // ...less what's too narrow for its cells to draw: a strip between two corridors that close is lawn at the paths' level
  raised.open(SLIVER);
  // A traced point moved onto the nearest line within SNAP, or where two meet onto both, with the lines it's on; a point on its square's
  // edge stays put
  const project = (p, s) => {
    const [ax, az] = s.a, [bx, bz] = s.b;
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-12;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / L2));
    const cx = ax + dx * t, cz = az + dz * t, d = Math.hypot(p[0] - cx, p[1] - cz);
    if (!s.r) return { at: [cx, cz], off: d };
    if (d < 1e-6) return null;
    return { at: [cx + ((p[0] - cx) / d) * s.r, cz + ((p[1] - cz) / d) * s.r], off: Math.abs(d - s.r) };
  };
  const moveOnto = (p, onEdge) => {
    if (onEdge(p[0], p[1])) return { at: alongSeam(p), on: [] };
    const near = [];
    for (const s of lines.get(Math.floor(p[0] / LINE_CELL) * 100000 + Math.floor(p[1] / LINE_CELL)) || []) {
      const hit = project(p, s);
      if (hit && hit.off < SNAP) near.push({ s, ...hit });
    }
    if (!near.length) { st.kept++; return { at: p, on: [] }; }
    near.sort((u, v) => u.off - v.off);
    st.moved++;
    // Where two lines meet: onto both, turn about
    if (near.length > 1 && near[1].off < SNAP / 2 && near[1].s !== near[0].s) {
      let q = p;
      for (let k = 0; k < 12; k++) q = project(project(q, near[0].s)?.at ?? q, near[1].s)?.at ?? q;
      const a = project(q, near[0].s), b = project(q, near[1].s);
      if (a && b && a.off < 0.02 && b.off < 0.02 && Math.hypot(q[0] - p[0], q[1] - p[1]) < SNAP) return { at: q, on: [near[0].s, near[1].s] };
    }
    return { at: near[0].at, on: [near[0].s] };
  };
  // A point on a square's edge, slid along it onto the nearest line that crosses it there: the same for the squares either side, whose
  // pieces meet on it. One at a square's corner stays put.
  const alongSeam = (p) => {
    const onX = Math.abs(p[0] / SQUARE - Math.round(p[0] / SQUARE)) < 1e-9, onZ = Math.abs(p[1] / SQUARE - Math.round(p[1] / SQUARE)) < 1e-9;
    if (onX === onZ) return p;
    let best = null, far = SNAP;
    for (const s of lines.get(Math.floor(p[0] / LINE_CELL) * 100000 + Math.floor(p[1] / LINE_CELL)) || []) {
      if (s.r) continue;
      const [ax, az] = s.a, [bx, bz] = s.b;
      // Where the line crosses the seam, if it does within its length
      const [u, ua, ub] = onX ? [p[0], ax, bx] : [p[1], az, bz];
      if ((ua - u) * (ub - u) > 0 || ua === ub) continue;
      const t = (u - ua) / (ub - ua);
      const at = onX ? [p[0], az + (bz - az) * t] : [ax + (bx - ax) * t, p[1]];
      const d = Math.hypot(at[0] - p[0], at[1] - p[1]);
      if (d < far) { far = d; best = at; }
    }
    return best || p;
  };
  // Where two straight lines cross, carried on past their ends
  const meet = (s, t) => {
    const [ax, az] = s.a, [bx, bz] = s.b, [cx, cz] = t.a, [dx, dz] = t.b;
    const ux = bx - ax, uz = bz - az, vx = dx - cx, vz = dz - cz, den = ux * vz - uz * vx;
    if (Math.abs(den) < 1e-6 * Math.hypot(ux, uz) * Math.hypot(vx, vz)) return null;
    const k = ((cx - ax) * vz - (cz - az) * vx) / den;
    return [ax + ux * k, az + uz * k];
  };
  const snap = (ring, onEdge) => {
    const moved = ring.map((p) => moveOnto(p, onEdge));
    const res = [];
    for (let i = 0; i < moved.length; i++) {
      const p = moved[i], q = moved[(i + 1) % moved.length];
      res.push(p.at);
      // Two points on two lines that meet between them: the corner too, which the straight edge from one to the other would cut
      const s = p.on[p.on.length - 1], t = q.on[0];
      if (!s || !t || s === t || p.on.includes(t) || q.on.includes(s) || s.r || t.r) continue;
      const c = meet(s, t);
      if (!c) continue;
      const pq = Math.hypot(q.at[0] - p.at[0], q.at[1] - p.at[1]);
      const cp = Math.hypot(c[0] - p.at[0], c[1] - p.at[1]), cq = Math.hypot(c[0] - q.at[0], c[1] - q.at[1]);
      if (cp < 0.005 || cq < 0.005 || cp > 12 || cq > 12 || cp + cq > pq + 0.75) continue;
      res.push(c);
      st.corners++;
    }
    return despike(res).map(([x, z]) => [q2(x), q2(z)]);
  };
  // Without a point where the ring doubles back on itself, a thin spike: one moved onto a line just past where it meets another
  const despike = (ring) => {
    let res = ring;
    for (let changed = true; changed && res.length > 3;) {
      changed = false;
      const keep = res.filter((b, i) => {
        const a = res[(i + res.length - 1) % res.length], c = res[(i + 1) % res.length];
        const ux = b[0] - a[0], uz = b[1] - a[1], vx = c[0] - b[0], vz = c[1] - b[1];
        const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
        if (lu < 1e-6 || lv < 1e-6) { changed = true; return false; }
        if (Math.abs(ux * vz - uz * vx) / 2 < SPIKE && ux * vx + uz * vz < -0.5 * lu * lv) { changed = true; return false; }
        return true;
      });
      if (keep.length < 3) break;
      res = keep;
    }
    return res;
  };
  // Worked out with a margin, traced in the box alone
  const crop = (r) => {
    if (!margin) return r;
    const c = new Raster(box.x0, box.z0, box.x1 - RAISED_RES, box.z1 - RAISED_RES, RAISED_RES);
    const di = Math.round((c.x0 - r.x0) / RAISED_RES), dj = Math.round((c.z0 - r.z0) / RAISED_RES);
    for (let j = 0; j < c.h; j++) for (let i = 0; i < c.w; i++) c.d[j * c.w + i] = r.d[(j + dj) * r.w + i + di];
    return c;
  };
  const exact = (rings) => rings.map((r) => r.map(([x, z]) => [q2(x), q2(z)]).filter((p, i, all) => {
    const q = all[(i + 1) % all.length];
    return p[0] !== q[0] || p[1] !== q[1];
  }).flat());
  for (const rings of tiledPolygons(crop(raised), SQUARE, 0.02, MIN_LAWN / RAISED_RES ** 2, MIN_LAWN, null, snap)) {
    if (Math.abs(ringArea(rings[0])) - rings.slice(1).reduce((t, r) => t + Math.abs(ringArea(r)), 0) < MIN_LAWN) continue;
    // To the centimetre, without a point repeated once rounded, nor the first again at the end
    out.lawns.push([kerbOf(rings[0]), ...exact(rings)]);
    st.pieces++;
    st.area += Math.abs(ringArea(rings[0])) - rings.slice(1).reduce((t, r) => t + Math.abs(ringArea(r)), 0);
  }
  // The paved areas, traced as the raised lawn is, so their edges and its meet on the same lines: [surface, outer, ...holes]
  for (const [surface, r] of [...plazaBy].sort((p, q) => p[0] - q[0])) {
    for (const rings of tiledPolygons(crop(r), SQUARE, 0.02, MIN_LAWN / RAISED_RES ** 2, MIN_LAWN, null, snap)) {
      const held = Math.abs(ringArea(rings[0])) - rings.slice(1).reduce((t, q) => t + Math.abs(ringArea(q)), 0);
      if (held < MIN_LAWN) continue;
      out.plazas.push([surface, ...exact(rings)]);
      st.plazaArea += held;
    }
  }
  return out;
}
