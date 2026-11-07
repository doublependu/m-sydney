import { GEO } from './geodata.js';
import { rawTerrainHeight as terrainHeight } from './terrain.js';
import { DECK_STRUCTURE, ownLaneOffsets, structureAt } from './surfaces.js';

// The Harbour Bridge's corridor: a road with its own height, one of the structures of js/surfaces.js. A car on the deck
// and a car on the street under its approach share (x, z); what tells them apart is the surface each is on. Its height
// comes from the road graph (tools/build-heights.mjs works out the deck's profile), so the model, the game and the
// roads that join it all agree. This module adds what the model and the scripts need: the line along it, and where
// along it a point is.

const PATH = [];
for (let i = 0; i < GEO.bridge.length; i += 2) PATH.push({ x: GEO.bridge[i], z: GEO.bridge[i + 1], s: 0 });
for (let i = 1; i < PATH.length; i++) PATH[i].s = PATH[i - 1].s + Math.hypot(PATH[i].x - PATH[i - 1].x, PATH[i].z - PATH[i - 1].z);
const LENGTH = PATH[PATH.length - 1].s;
const HALF_WIDTH = 12.5; // of the corridor anything can use, where the tiles don't say how far the deck reaches (deckSpanAt())
const DECK_SID = DECK_STRUCTURE;
// m from the corridor's line that any of the deck can be, either side
const DECK_REACH = 30;

/** Point on the corridor s metres from its south end, with its direction */
function bridgePoint(s) {
  let i = 1;
  while (i < PATH.length - 1 && PATH[i].s < s) i++;
  const a = PATH[i - 1], b = PATH[i];
  const L = b.s - a.s || 1;
  const t = (s - a.s) / L;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, ux: (b.x - a.x) / L, uz: (b.z - a.z) / L };
}

// Where the shore lies under the corridor, for the arch: the water runs between these
// Worked out with the whole map when the tiles are made (tools/tiles/derive.mjs), since the game may never hold all of the
// bridge at once
const SPAN = GEO.bridgeSpan || (() => {
  let south = 0, north = LENGTH;
  for (let s = 0; s < LENGTH; s += 5) {
    const p = bridgePoint(s);
    if (terrainHeight(p.x, p.z) < 2) { south = s; break; }
  }
  for (let s = LENGTH; s > 0; s -= 5) {
    const p = bridgePoint(s);
    if (terrainHeight(p.x, p.z) < 2) { north = s; break; }
  }
  return { south, north, middle: (south + north) / 2 };
})();

// The deck's height every 2 m along it, from the road graph
const DECK_STEP = 2;
const DECK_Y = new Float32Array(Math.ceil(LENGTH / DECK_STEP) + 1);
for (let i = 0; i < DECK_Y.length; i++) {
  const p = bridgePoint(Math.min(LENGTH, i * DECK_STEP));
  DECK_Y[i] = GEO.deckProfile?.[i] ?? structureAt(DECK_SID, p.x, p.z, 2)?.y ?? terrainHeight(p.x, p.z);
}

/** Deck height s metres along the corridor: ground at both ends, a long gentle climb to the arch, a slight crown over it */
function deckHeight(s) {
  const f = Math.max(0, Math.min(LENGTH, s)) / DECK_STEP;
  const i = Math.min(DECK_Y.length - 2, Math.floor(f));
  return DECK_Y[i] + (DECK_Y[i + 1] - DECK_Y[i]) * (f - i);
}

// How far the deck reaches across, west (negative) and east of the corridor's line, every so many metres along it: as far as any of
// its roads' lanes do (tools/build-tiles.mjs). The corridor is OSM's northbound carriageway; its southbound one, the bus lane and
// the Cahill's lane through the east pylons are east of it, on the same deck (plan 5).
const ACROSS = GEO.deckSpan;
/** The deck's roads across at s m along the corridor: { west, east }, m from its line, east positive */
function deckSpanAt(s) {
  if (!ACROSS) return { west: -HALF_WIDTH, east: HALF_WIDTH };
  const f = Math.max(0, Math.min(ACROSS.west.length - 1, s / ACROSS.step));
  const i = Math.min(ACROSS.west.length - 2, Math.floor(f)), t = f - i;
  return { west: ACROSS.west[i] + (ACROSS.west[i + 1] - ACROSS.west[i]) * t, east: ACROSS.east[i] + (ACROSS.east[i + 1] - ACROSS.east[i]) * t };
}

/**
 * Nearest place on the corridor to (x, z), or null when farther than `reach` from it:
 * { s, off (metres to the right of travel north), y }
 */
function bridgeAt(x, z, reach = HALF_WIDTH) {
  let best = null, bd = reach * reach;
  for (let i = 1; i < PATH.length; i++) {
    const a = PATH[i - 1], b = PATH[i];
    const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1;
    const u = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2));
    const px = a.x + dx * u, pz = a.z + dz * u;
    const d = (x - px) ** 2 + (z - pz) ** 2;
    if (d < bd) {
      bd = d;
      const L = Math.sqrt(L2);
      best = { s: a.s + u * L, off: (-(x - px) * dz + (z - pz) * dx) / L, px, pz };
    }
  }
  if (best) best.y = deckHeight(best.s);
  return best;
}

/** Where the deck's easternmost lane runs apart from the rest at s, [from, to] m east of the corridor's line: the Cahill's, through
 *  the east pylons. Null where it doesn't. */
function deckGapAt(s) {
  if (!ACROSS?.gap) return null;
  const k = Math.max(0, Math.min(ACROSS.gap.length - 1, Math.round(s / ACROSS.step)));
  const here = ACROSS.gap[k];
  if (!here) return null;
  // Between two bins that both have one, the nearer's
  return here;
}

/** Whether (x, z) is over the deck's roads, `margin` m past their edges counting */
function onDeckSpan(x, z, margin = 0) {
  const here = bridgeAt(x, z, DECK_REACH + margin);
  if (!here) return false;
  const span = deckSpanAt(here.s);
  return here.off >= span.west - margin && here.off <= span.east + margin;
}

// The deck's lanes, laid out once: traffic drives them (js/road-network.js), the lines are painted between them (js/road-paint.js),
// and the gantries' signals and the lane numbers stand over them (js/harbour-bridge.js), so all four agree. OSM draws the deck's
// carriageways closer together than their lanes need (the northbound's line and the southbound's 8.2-9.2 m apart, where four
// lanes and two of 3.3 m want 9.9), so a road's lanes can't simply sit on its own line. Instead roads side by side between the same
// two barriers (their edges closer than ROADWAY_GAP, as tools/build-tiles.mjs deckSpan() finds the gap) share one roadway, split
// evenly between all their lanes, west to east: about 3.4 m each on the span. A road alone between its barriers keeps its own lanes
// (ownLaneOffsets()), as the roads joining the deck have them. Lanes are numbered 1 to 8 from the west, as painted on the deck, and
// where a road joins or leaves a roadway each lane moves over gradually, along LANE_EASE m either side, as painted lines would.
const LANE_STEP = 2; // m along the deck between places the layout is worked out
const LANE_EASE = 30;
const LINE_EASE = 20; // m either side over which a road's line is evened out
const ROADWAY_GAP = 0.3;
// Lanes the signals stand over: the main roadway's six, whose direction the time of day sets. Not the bus lane or the Cahill's lane east
// of them, which only ever run one way: in the video of the drive over, each gantry (1:18, 1:30, 1:54, 2:03, 2:15, 2:24) has six
// lights, over lanes 1-6.
const SIGNAL_LANES = 6;

// Nearest place on the corridor to (x, z) within `reach`, looking first near the segment `hint` (the last one found, walking along a
// road): { s, off, i } or null
function nearOnPath(x, z, reach, hint) {
  let best = null, bd = reach * reach;
  const look = (i) => {
    const a = PATH[i - 1], b = PATH[i];
    const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1;
    const u = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2));
    const px = a.x + dx * u, pz = a.z + dz * u, d = (x - px) ** 2 + (z - pz) ** 2;
    if (d < bd) {
      bd = d;
      const L = Math.sqrt(L2);
      best = { s: a.s + u * L, off: (-(x - px) * dz + (z - pz) * dx) / L, i };
    }
  };
  if (hint) {
    for (let i = Math.max(1, hint - 2); i <= Math.min(PATH.length - 1, hint + 2); i++) look(i);
    // Not at either end of the few looked at: it's the nearest
    if (best && best.i > Math.max(1, hint - 2) && best.i < Math.min(PATH.length - 1, hint + 2)) return best;
    best = null;
    bd = reach * reach;
  }
  for (let i = 1; i < PATH.length; i++) look(i);
  return best;
}

let layoutCache = null;
function deckLayout() {
  if (layoutCache) return layoutCache;
  const bins = Math.ceil(LENGTH / LANE_STEP) + 1;
  // Each road over the deck: the deck's own, and those that carry one of them on beyond where the map calls them the deck's, at its
  // level and alongside it, where a road the map ends short of the deck's ends runs on beside it. Where it is across the deck at each
  // place along it, and which way it runs.
  const travel = ([, flat, , , , , , , dir]) => {
    const a = [flat[0], flat[1]], b = [flat[flat.length - 2], flat[flat.length - 1]];
    return dir > 0 ? [a, b] : [b, a];
  };
  const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 3;
  const deckEnds = (GEO.bridgeLinks || []).filter((e) => e[3] && e[8]).map(travel);
  const roads = [];
  for (const entry of GEO.bridgeLinks || []) {
    const [id, flat, width, deck, , ys, kind, lanes = 0, dir = 0] = entry;
    if (!dir) continue;
    if (!deck) {
      if (kind !== 1 || !ys) continue;
      const [from, to] = travel(entry);
      if (!deckEnds.some(([a, b]) => near(to, a) || near(from, b))) continue;
    }
    const off = new Float32Array(bins).fill(NaN), hits = new Uint8Array(bins);
    let first = null, last = null, hint = 0;
    for (let i = 0; i + 3 < flat.length; i += 2) {
      const ax = flat[i], az = flat[i + 1], bx = flat[i + 2], bz = flat[i + 3], L = Math.hypot(bx - ax, bz - az);
      for (let d = 0; d <= L; d += 1) {
        const here = nearOnPath(ax + ((bx - ax) * d) / (L || 1), az + ((bz - az) * d) / (L || 1), DECK_REACH, hint);
        if (!here) continue;
        hint = here.i;
        // Not past either end of the corridor, where everything is at its end
        if (here.s < 0.5 || here.s > LENGTH - 0.5) continue;
        if (!deck && Math.abs(ys[i / 2] + ((ys[i / 2 + 1] - ys[i / 2]) * d) / (L || 1) - deckHeight(here.s)) > 0.5) continue;
        first ??= here;
        last = here;
        const k = Math.round(here.s / LANE_STEP);
        off[k] = hits[k] ? (off[k] * hits[k] + here.off) / (hits[k] + 1) : here.off;
        hits[k] = Math.min(255, hits[k] + 1);
      }
    }
    if (!first || Math.abs(last.s - first.s) < LANE_STEP) continue;
    // Not the deck's: only where it runs alongside, not where it curves off towards it or away
    if (!deck) {
      const kept = new Float32Array(bins).fill(NaN);
      for (let b = 0; b < bins; b++) {
        if (Number.isNaN(off[b])) continue;
        const before = Number.isNaN(off[b - 1]) ? b : b - 1, after = Number.isNaN(off[b + 1]) ? b : b + 1;
        if (after > before && Math.abs(off[after] - off[before]) < 0.08 * (after - before) * LANE_STEP) kept[b] = off[b];
      }
      off.set(kept);
    }
    // Its lanes by OSM's count, or those a map of only its width gives: tools/build-geodata.mjs made the width from them
    const own = ownLaneOffsets(width, lanes || Math.round((width - 1.5) / 3.3));
    const [from, to] = travel(entry);
    roads.push({ id, deck: !!deck, width, own, n: own.length, north: (last.s > first.s) === (dir > 0), off, from, to });
  }
  // Carriageways: roads that carry on one from the next, the same way with as many lanes. Each runs along one line, and each lane along
  // it keeps its place from one road to the next.
  const parent = new Map(roads.map((r) => [r, r]));
  const root = (r) => (parent.get(r) === r ? r : root(parent.get(r)));
  for (const p of roads) {
    for (const q of roads) if (p !== q && p.north === q.north && p.n === q.n && near(p.to, q.from)) parent.set(root(q), root(p));
  }
  // OSM's line wanders by up to half a metre either way along the deck, where the real road runs straight: along each carriageway, a mean
  // over the places either side of each, as many each way, so where it curves away it still follows it. Traffic runs along this line too
  // (js/road-network.js), so its lanes carry on from one edge to the next.
  for (const top of new Set(roads.map(root))) {
    const members = roads.filter((r) => root(r) === top);
    const off = new Float32Array(bins).fill(NaN);
    for (let k = 0; k < bins; k++) {
      const here = members.filter((r) => !Number.isNaN(r.off[k]));
      if (here.length) off[k] = here.reduce((sum, r) => sum + r.off[k], 0) / here.length;
    }
    const line = new Float32Array(bins).fill(NaN);
    for (let k = 0; k < bins; k++) {
      if (Number.isNaN(off[k])) continue;
      let from = k, to = k;
      while (from > 0 && !Number.isNaN(off[from - 1])) from--;
      while (to < bins - 1 && !Number.isNaN(off[to + 1])) to++;
      const h = Math.min(LINE_EASE / LANE_STEP, k - from, to - k);
      let sum = 0;
      for (let c = k - h; c <= k + h; c++) sum += off[c];
      line[k] = sum / (2 * h + 1);
    }
    for (const r of members) {
      for (let k = 0; k < bins; k++) if (!Number.isNaN(r.off[k])) r.off[k] = line[k];
      r.way = top.id;
    }
  }
  // Each place along the deck: its lanes west to east, a road's lanes on its own, a roadway's shared evenly
  const raw = [];
  for (let b = 0; b < bins; b++) {
    const here = roads.filter((r) => !Number.isNaN(r.off[b])).map((r) => ({ r, off: r.off[b] })).sort((p, q) => p.off - q.off);
    // Where one road gives way to the next along the same carriageway, or forks off it, both are here for a step: keep the one with
    // more lanes, so the lanes keep their numbers, and let it answer for the other
    const alias = new Map();
    for (let i = here.length - 1; i > 0; i--) {
      const p = here[i - 1], q = here[i];
      if (p.r.north !== q.r.north || q.off - p.off > 1.5) continue;
      const [gone, kept] = q.r.n > p.r.n ? [p, q] : [q, p];
      alias.set(gone.r.id, kept.r.id);
      here.splice(here.indexOf(gone), 1);
    }
    const lanes = [];
    let i = 0, way = 0;
    while (i < here.length) {
      let j = i + 1, east = here[i].off + here[i].r.width / 2;
      while (j < here.length && here[j].off - here[j].r.width / 2 - east < ROADWAY_GAP) {
        east = Math.max(east, here[j].off + here[j].r.width / 2);
        j++;
      }
      const group = here.slice(i, j);
      // base: its road's line there; rel: m from it; sig: the carriageways in its roadway
      const sig = group.map((h) => h.r.way).join();
      if (group.length === 1) {
        const { r, off } = group[0], w = r.n > 1 ? r.own[1] - r.own[0] : r.width;
        r.own.forEach((o, k) => lanes.push({ link: r.id, cw: r.way, deck: r.deck, k, north: r.north, base: off, rel: o, width: w, way, sig }));
      } else {
        const west = Math.min(...group.map((h) => h.off - h.r.width / 2));
        const n = group.reduce((sum, h) => sum + h.r.n, 0), w = (east - west) / n;
        let lane = 0;
        for (const { r, off } of group) {
          for (let k = 0; k < r.n; k++, lane++) lanes.push({ link: r.id, cw: r.way, deck: r.deck, k, north: r.north, base: off, rel: west + (lane + 0.5) * w - off, width: w, way, sig });
        }
      }
      i = j;
      way++;
    }
    lanes.alias = alias;
    raw.push(lanes);
  }
  // Each lane, by its number, eased along the deck: how far it is from its road's line a mean over the places either side, as many each
  // way. So a lane goes round the deck's bends with its road, and changes its place on it only gradually where the roads in its
  // roadway change or it widens. Up to the ends of the stretch it's there along, gaps of a few places counting as there. A new stretch
  // where it parts from the lane west of it, or joins it, across a barrier: the Cahill's lane where it forks off the bus lane's isn't
  // drawn back towards where it was.
  const ease = Math.round(LANE_EASE / LANE_STEP);
  const stretches = [];
  const shares = (list, number) => number > 0 && list[number - 1]?.way === list[number].way;
  for (let b = 0; b < bins; b++) {
    raw[b].forEach((_, number) => {
      const list = (stretches[number] ||= []);
      const last = list[list.length - 1];
      if (last && b - last[1] <= 4 && shares(raw[last[1]], number) === shares(raw[b], number)) last[1] = b;
      else list.push([b, b]);
    });
  }
  // Where its road is at place c: past its ends, where it was at the nearest end. Where the lane's road changes (forking from a road of
  // two lanes into two of one), each place measured from the lane's road here, not its own, and so not drawn towards another line.
  const byId = new Map(roads.map((r) => [r.id, r]));
  const lineAt = (r, c) => {
    if (!Number.isNaN(r.off[c])) return r.off[c];
    for (let d = 1; d < bins; d++) {
      if (c - d >= 0 && !Number.isNaN(r.off[c - d])) return r.off[c - d];
      if (c + d < bins && !Number.isNaN(r.off[c + d])) return r.off[c + d];
    }
    return 0;
  };
  const lanes = [];
  for (let b = 0; b < bins; b++) {
    const list = raw[b].map((l, number) => {
      const [from, to] = stretches[number].find(([f, t]) => b >= f && b <= t);
      const h = Math.min(ease, b - from, to - b);
      const road = byId.get(l.link);
      let sum = 0, sumW = 0, count = 0;
      for (let c = b - h; c <= b + h; c++) {
        const m = raw[c][number];
        if (!m) continue;
        sum += m.cw === l.cw ? m.rel : m.base + m.rel - lineAt(road, c);
        sumW += m.width;
        count++;
      }
      return { link: l.link, k: l.k, north: l.north, deck: l.deck, off: l.base + sum / count, rel: sum / count, width: sumW / count, way: l.way };
    });
    list.alias = raw[b].alias;
    lanes.push(list);
  }
  layoutCache = { bins, lanes, roads };
  return layoutCache;
}

/** Where road `link`'s line runs across the deck at its nearest place to (x, z), OSM's wandering evened out (see deckLayout()), as a
 *  point: or null where the layout doesn't have that road */
function deckRoadPoint(link, x, z) {
  const here = bridgeAt(x, z, DECK_REACH + 10);
  if (!here) return null;
  const { roads } = deckLayout();
  const b = deckBin(here.s), road = roads.find((r) => r.id === link);
  if (!road || Number.isNaN(road.off[b])) return null;
  // Between places: along the line from one to the next
  const b2 = here.s / LANE_STEP > b ? b + 1 : b - 1;
  const t = Math.abs(here.s / LANE_STEP - b);
  const off = Number.isNaN(road.off[b2]) ? road.off[b] : road.off[b] + (road.off[b2] - road.off[b]) * t;
  const p = bridgePoint(here.s);
  return { x: p.x - p.uz * off, z: p.z + p.ux * off };
}

/** The roads the deck's layout has lanes on, by id */
let laidIds = null;
function deckLinkIds() {
  if (!laidIds) {
    laidIds = new Set();
    for (const list of deckLayout().lanes) {
      for (const l of list) laidIds.add(l.link);
      for (const id of list.alias.keys()) laidIds.add(id);
    }
  }
  return laidIds;
}

const deckBin = (s) => Math.max(0, Math.min(deckLayout().bins - 1, Math.round(s / LANE_STEP)));

/**
 * The deck's lanes s m along it, west to east: [{ link, k (its road's lanes counted west to east), north, off (m east of the
 * corridor's line, its middle), width, way (its roadway, counted from the west), deck (on one of the deck's own roads: the bridge's
 * model is as wide as those, js/harbour-bridge.js), number (1 for the westernmost on the deck), signal (whether the gantries light
 * it) }]. The southbound's and the Cahill's lanes beside the northbound for 60 m at the south end aren't the deck's: the model's
 * barrier stands between, so they share the northbound's roadway but get no lights, numbers or lines from it.
 */
function deckLanes(s) {
  return deckLayout().lanes[deckBin(s)].map((l, i) => ({ ...l, number: i + 1, signal: i < SIGNAL_LANES && l.deck }));
}

/**
 * The lanes of road `link` across the deck at its nearest place to (x, z), west to east: or null where the layout doesn't have that
 * road there. Each as a point with its width, and `rel`, how far east of its road's line it is (deckRoadPoint()), the same all along a
 * stretch where its roadway is made of the same roads, and `east`, the way across the deck there. Where one road gives way to the next
 * along its carriageway, the one the layout kept answers for both, and rel is null: it's from the other's line.
 */
function deckLanePoints(link, x, z) {
  const here = bridgeAt(x, z, DECK_REACH + 10);
  if (!here) return null;
  const list = deckLayout().lanes[deckBin(here.s)];
  const kept = list.alias.get(link) ?? link;
  const mine = list.filter((l) => l.link === kept);
  if (!mine.length) return null;
  const p = bridgePoint(here.s), east = { x: -p.uz, z: p.ux };
  return mine.map((l) => ({ x: p.x + east.x * l.off, z: p.z + east.z * l.off, width: l.width, north: l.north, rel: kept === link ? l.rel : null, east }));
}

/**
 * The lines between the deck's lanes from s0 to s1: [{ solid, pts: [[x, z, s, link], ...] }], `link` the road west of it there, for
 * its height.
 * Dashed between lanes going the same way, solid between the two directions and either side of a lane for buses (`busOnly(link)`):
 * what the video of the drive over shows (1:15, 1:52). None at the kerbs, nor between roadways or the deck's roads and others, where a
 * barrier stands, nor where two
 * lanes fork or merge. A point every `every` places, as the deck curves gently, and either side of each bend in its line.
 */
function deckLines(s0, s1, busOnly = () => false, every = 3) {
  const { bins, lanes: all } = deckLayout();
  // A point either side of each bend in the corridor too, or the line would cut the corner
  const bends = new Set();
  for (const v of PATH) bends.add(Math.floor(v.s / LANE_STEP)).add(Math.ceil(v.s / LANE_STEP));
  const lines = [];
  const b0 = Math.max(0, Math.floor(s0 / LANE_STEP)), b1 = Math.min(bins - 1, Math.ceil(s1 / LANE_STEP));
  const open = new Map(); // the line between lanes k and k + 1 -> the line being drawn
  for (let b = b0; b <= b1; b++) {
    const s = b * LANE_STEP, p = bridgePoint(s), lanes = all[b];
    for (let k = 0; k < 8; k++) {
      const a = lanes[k], c = lanes[k + 1];
      const kind = a && c && a.way === c.way && a.deck === c.deck ? (a.north !== c.north || busOnly(a.link) !== busOnly(c.link) ? 'solid' : 'dash') : null;
      let line = open.get(k);
      if (line && line.kind !== kind) {
        if (line.last !== line.pts[line.pts.length - 1]) line.pts.push(line.last);
        open.delete(k);
        line = null;
      }
      if (!kind) continue;
      const off = (a.off + c.off) / 2, pt = [p.x - p.uz * off, p.z + p.ux * off, s, a.link];
      if (!line) {
        line = { kind, pts: [pt] };
        lines.push(line);
        open.set(k, line);
      } else if ((b - b0) % every === 0 || bends.has(b)) line.pts.push(pt);
      line.last = pt;
    }
  }
  for (const line of open.values()) if (line.last !== line.pts[line.pts.length - 1]) line.pts.push(line.last);
  // Not the few metres two lanes run side by side where they fork or merge
  return lines.filter((line) => line.pts[line.pts.length - 1][2] - line.pts[0][2] >= 15).map(({ kind, pts }) => ({ solid: kind === 'solid', pts }));
}

export { DECK_REACH, DECK_STEP, DECK_SID, HALF_WIDTH, LENGTH as BRIDGE_LENGTH, SPAN as BRIDGE_SPAN, bridgeAt, bridgePoint, deckGapAt, deckHeight, deckLanePoints, deckLanes, deckLines, deckLinkIds, deckRoadPoint, deckSpanAt, onDeckSpan };
