import * as THREE from 'three/webgpu';
import { abs, color, float, floor, fract, max, mix, mod, positionWorld, smoothstep, sqrt, step, texture, uv } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cityUniforms } from './tsl-materials.js';
import { BRIDGE_LENGTH, BRIDGE_SPAN, DECK_REACH, DECK_SID, bridgeAt, bridgePoint, deckGapAt, deckHeight, deckSpanAt } from './bridge.js';
import { GEO } from './geodata.js';
import { groundHeight } from './surfaces.js';

// The Sydney Harbour Bridge: the deck along the corridor (js/bridge.js), the steel through-arch over the water with its
// hangers, the granite pylons at each end of the arch, and the piers carrying the approaches.
//
// Across the deck, from west to east (plan 5, from OSM and the pictures in ref/details/):
//   the cycleway, the two railway tracks, the arch's west truss, the roadway's eight lanes: four northbound (the corridor, OSM's
//   northbound carriageway), two southbound, the bus lane and the Cahill's lane, the arch's east truss between those last two,
//   then the footway in its cage. Between the pylons the Cahill's lane runs apart from the rest, through an arch in each east pylon,
//   and the railway through an arch in each west one. The roads' extent comes from the tiles (deckSpanAt(), deckGapAt()), so the
//   model stands where the roads are; the game holds cars to them (js/surfaces.js).

const WATER = -2.2;
const ARCH_TOP = 134 + WATER; // top of the arch above the water
const LOWER_RISE = 118; // m the lower chord rises from its hinges
const PANELS = 28;
const PYLON_HEIGHT = 89 + WATER;
const PYLON_BASE = [20, 21]; // m across and along the deck
const PYLON_OPENING = 11; // m high at its crown, over the deck: what goes through the pylons, under the railway's wires (6.8 m)
const ARCH_CLEAR = 4.3; // m over the deck, at least, where an arch's head starts to close in: a truck's height
const PIER = 1.0; // m of granite at least between the roads and an opening
const PYLON_FROM_MIDDLE = 282; // m along the deck from the middle of the arch to each pair of pylons
const BEARINGS = 503; // m between the arch's hinges
const BARRIER = { width: 0.5, height: 0.9 };
const KIND_CUTTING = 3; // a street on the ground sunk into a cutting (js/surfaces.js KIND)
// The sign gantry over the lanes coming off the bridge southbound, where they run side by side on the ground before they part
// (ref/details/3.png): across the line z = SOUTH_GANTRY.z, over the southbound roads within `reach` of x. Its boards from the left
// as you drive under it (the east, the bus lanes to York St) to the right: [style, line, line]
const SOUTH_GANTRY = {
  x: -290, z: -1285, reach: 25,
  boards: [['bus', 'LANE', '24 hrs'], ['bus', 'LANE'], ['green', 'Western', 'Suburbs'], ['green', 'City South', 'Darling Hbr'], ['blank'], ['green', 'GROSVENOR ST', 'City North']]
};
const RAIL_WIDTH = 10.6, CYCLE_WIDTH = 2.8, FOOT_WIDTH = 2.8;

// What's where across the deck s m along it, m east of the corridor's line
function layout(s) {
  const span = deckSpanAt(s);
  const roadWest = span.west - 0.5, roadEast = span.east + 0.5; // the barriers' inner faces, half a metre past the lanes
  const railTo = roadWest - BARRIER.width - 0.3, railFrom = railTo - RAIL_WIDTH;
  const cycleTo = railFrom - 0.3, cycleFrom = cycleTo - CYCLE_WIDTH;
  const footFrom = roadEast + BARRIER.width, footTo = footFrom + FOOT_WIDTH;
  const gap = deckGapAt(s);
  return { roadWest, roadEast, gap, railFrom, railTo, tracks: [railTo - 2.8, railTo - 7.6], cycleFrom, cycleTo, footFrom, footTo, edgeWest: cycleFrom - 0.3, edgeEast: footTo + 0.3 };
}
// The arch's trusses: the west one beside the roadway, the east one between the bus lane and the Cahill's lane, where its hangers
// stand, at the middle of the span
const TRUSS = (() => {
  const mid = layout(BRIDGE_SPAN.middle);
  return { west: mid.roadWest - BARRIER.width - 0.15, east: mid.gap ? (mid.gap[0] + mid.gap[1]) / 2 : mid.roadEast + BARRIER.width + 0.15 };
})();
const TRUSSES = [TRUSS.west, TRUSS.east];
const TRUSS_MID = (TRUSS.west + TRUSS.east) / 2;
// A pylon's granite across the deck, from its inner face out, and the opening through it: { from, to, openFrom, openTo }, m east of the
// corridor's line, smaller first. West: the railway and cycleway go through. East: the Cahill's lane and the footway.
function pylonAcross(s, side) {
  const l = layout(s);
  if (side < 0) {
    const face = l.roadWest - BARRIER.width - 0.1;
    return { from: face - PYLON_BASE[0], to: face, openFrom: l.cycleFrom - 0.4, openTo: Math.min(face - PIER, l.railTo + 0.2) };
  }
  const face = l.gap ? l.gap[0] + 0.1 : l.roadEast + BARRIER.width + 0.1;
  const openFrom = l.gap ? Math.max(face + 0.6, Math.min(face + PIER, l.gap[1] - 0.1)) : face + PIER;
  return { from: face, to: face + PYLON_BASE[0], openFrom, openTo: Math.max(openFrom + 4, l.footTo + 0.4) };
}

// The streets under the bridge, as segments with half widths, so nothing built for the bridge stands on one. From the far
// file (js/geodata.js, loadFar): the bridge is built once, whichever tiles are held then.
const streets = [];
function readStreets() {
  if (streets.length) return;
  for (const [, flat, width, deck] of GEO.bridgeLinks) {
    if (deck) continue;
    for (let i = 2; i + 1 < flat.length; i += 2) streets.push({ ax: flat[i - 2], az: flat[i - 1], bx: flat[i], bz: flat[i + 1], half: width / 2 });
  }
}
const segmentDistance = (x, z, g) => {
  const dx = g.bx - g.ax, dz = g.bz - g.az;
  const t = Math.max(0, Math.min(1, ((x - g.ax) * dx + (z - g.az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(g.ax + dx * t - x, g.az + dz * t - z);
};
// Whether a footprint, a box centred at (x, z) facing along (ux, uz), keeps `margin` clear of every street
function clearOfStreets(x, z, ux, uz, halfAcross, halfAlong, margin) {
  const reach = Math.hypot(halfAcross, halfAlong) + margin + 20;
  for (const g of streets) {
    if (Math.min(g.ax, g.bx) > x + reach || Math.max(g.ax, g.bx) < x - reach || Math.min(g.az, g.bz) > z + reach || Math.max(g.az, g.bz) < z - reach) continue;
    // Sample the box's outline and middle against the street's ribbon
    for (let a = -1; a <= 1; a += 0.25) {
      for (let b = -1; b <= 1; b += 0.25) {
        if (Math.abs(a) < 1 && Math.abs(b) < 1 && (a !== 0 || b !== 0)) continue;
        const px = x - uz * a * halfAcross + ux * b * halfAlong, pz = z + ux * a * halfAcross + uz * b * halfAlong;
        if (segmentDistance(px, pz, g) < g.half + margin) return false;
      }
    }
  }
  return true;
}

const steel = new THREE.MeshStandardNodeMaterial({ color: 0x3f454a, roughness: 0.62, metalness: 0.55 });
// The arch and pylons are lit after dark
steel.emissiveNode = color(0x8fa8c8).mul(smoothstep(0.55, 1.2, cityUniforms.uInteriorGlow).mul(0.14));
const night = smoothstep(0.55, 1.2, cityUniforms.uInteriorGlow);
// The pylons' granite: rusticated blocks in courses, a tall arched opening high on each face (uv: metres across the face,
// height). Floodlit from below at night.
const PYLON_ARCH = { from: 66, to: 75, halfWidth: 3.1 };
const granite = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
{
  const across = uv().x, up = uv().y;
  const row = floor(up.div(1.5));
  const col = across.div(3).add(mod(row, 2).mul(0.5));
  const joint = max(smoothstep(0.42, 0.5, abs(fract(up.div(1.5)).sub(0.5))), smoothstep(0.46, 0.5, abs(fract(col).sub(0.5))));
  const block = fract(floor(col).mul(12.9898).add(row.mul(78.233)).sin().mul(437.585)).sub(0.5);
  const stoneTone = mix(color(0xa8916f).mul(block.mul(0.14).add(1)), color(0x6f5f49), joint.mul(0.7));
  const roundTop = PYLON_ARCH.to + PYLON_ARCH.halfWidth;
  const arch = step(abs(across), float(PYLON_ARCH.halfWidth)).mul(step(float(PYLON_ARCH.from), up)).mul(
    step(up, float(PYLON_ARCH.to)).add(step(float(PYLON_ARCH.to), up).mul(step(up.sub(PYLON_ARCH.to), sqrt(max(float(PYLON_ARCH.halfWidth ** 2).sub(across.mul(across)), 0)))))
  ).mul(step(up, float(roundTop)));
  granite.colorNode = mix(stoneTone, color(0x14171a), arch);
  granite.emissiveNode = stoneTone.mul(color(0xffd2a0)).mul(night).mul(mix(float(1.3), float(0.5), smoothstep(10, 85, positionWorld.y))).mul(float(1).sub(arch));
}
// Sandstone arches, where the approaches come down to the land: uv: arches along, height up the wall (0 to 1)
const sandstoneArches = new THREE.MeshStandardNodeMaterial({ roughness: 0.92 });
{
  const a = fract(uv().x).sub(0.5);
  const opening = step(abs(a), float(0.34)).mul(step(uv().y, float(0.5).add(sqrt(max(float(0.1156).sub(a.mul(a)), 0)).mul(0.9))));
  const courses = smoothstep(0.42, 0.5, abs(fract(positionWorld.y.div(0.9)).sub(0.5)));
  sandstoneArches.colorNode = mix(mix(color(0xb99d74), color(0x8a7554), courses.mul(0.6)), color(0x1d1a17), opening);
  sandstoneArches.emissiveNode = color(0xffcf94).mul(night).mul(0.18).mul(float(1).sub(opening));
}
const lanternGlass = new THREE.MeshBasicNodeMaterial();
lanternGlass.colorNode = mix(color(0xb5b3a8), color(0xffe9c0).mul(2.4), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow));
const deckSide = new THREE.MeshStandardNodeMaterial({ color: 0x5a6066, roughness: 0.7, metalness: 0.3 });

// Struts: a unit box stretched between two points
const X = new THREE.Vector3(0, 0, 1);
function strutMatrix(a, b, w, d) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromUnitVectors(X, dir.normalize());
  m.compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(w, d, len));
  return m;
}

const axis = (s) => bridgePoint(s);
const across = (p, side) => new THREE.Vector2(-p.uz * side, p.ux * side);
const at = (s, side, y) => {
  const p = axis(s), n = across(p, side);
  return new THREE.Vector3(p.x + n.x, y, p.z + n.y);
};

// Where the pylons stand, either side of the deck at each end of the arch: each pair 282 m from the middle of the span, about 30 m
// beyond the arch's bearings (503 m apart, centred on the water), where OSM has the Cahill's lane through them (its covered ways)
// and the south pair's outline is; moved away from the water until clear of the streets beneath (Hickson Rd at the south end,
// Olympic Dr at the north). Before plan 5 they stood 7 m back from the bearings, about 30 m too near the water.
let pylonPlaces = null;
function pylonStations() {
  if (pylonPlaces) return pylonPlaces;
  const clear = (where) => [-1, 1].every((side) => {
    const across = pylonAcross(where, side);
    const q = axis(where), p = at(where, (across.from + across.to) / 2, 0);
    return clearOfStreets(p.x, p.z, q.ux, q.uz, PYLON_BASE[0] / 2, PYLON_BASE[1] / 2, 1);
  });
  pylonPlaces = [[BRIDGE_SPAN.middle - PYLON_FROM_MIDDLE, -1], [BRIDGE_SPAN.middle + PYLON_FROM_MIDDLE, 1]].map(([start, step]) => {
    let s = start;
    for (let k = 0; k < 40 && !clear(s); k++) s += step;
    return s;
  });
  return pylonPlaces;
}

// A pylon's granite either side of its opening, across: [[from, to], [from, to]]
const pylonPieces = (s, side) => {
  const a = pylonAcross(s, side);
  return [[a.from, a.openFrom], [a.openTo, a.to]].filter(([from, to]) => to - from > 0.2);
};

// What stops the player: exactly the granite's footprint either side of its opening, turned with it. Needed from the start,
// unlike the bridge itself. Not the opening's: a car on the deck is at the simulation's flat height, as it is on the ground.
function harbourBridgeColliders(colliders) {
  readStreets();
  for (const s of pylonStations()) {
    for (const side of [-1, 1]) {
      for (const [from, to] of pylonPieces(s, side)) {
        const p = at(s, (from + to) / 2, 0);
        const q = axis(s);
        const yaw = Math.atan2(q.ux, q.uz);
        const hx = (to - from) / 2, hz = PYLON_BASE[1] / 2;
        const ex = Math.abs(Math.cos(yaw)) * hx + Math.abs(Math.sin(yaw)) * hz, ez = Math.abs(Math.sin(yaw)) * hx + Math.abs(Math.cos(yaw)) * hz;
        colliders.push({
          minX: p.x - ex, maxX: p.x + ex, minZ: p.z - ez, maxZ: p.z + ez, minY: 0, maxY: PYLON_HEIGHT - groundHeight(p.x, p.z),
          obb: { cx: p.x, cz: p.z, hx, hz, cs: Math.cos(yaw), sn: Math.sin(yaw) }
        });
      }
    }
  }
}

// Where a ramp leaves the deck its barrier and side stop, for the ramp's width: (s, side) -> is it open there?
function rampOpenings() {
  const gaps = [];
  for (const [, flat, width, deck, onDeck, ys, kind] of GEO.bridgeLinks) {
    if (deck || !kind || !ys || !onDeck) continue;
    const l = { half: width / 2 + 0.6, pts: [] };
    for (let i = 0; i + 1 < flat.length; i += 2) l.pts.push({ x: flat[i], z: flat[i + 1] });
    let last = null;
    for (let i = 1; i < l.pts.length; i++) {
      const p = l.pts[i - 1], q = l.pts[i], L = Math.hypot(q.x - p.x, q.z - p.z);
      for (let d = 0; d <= L; d += 1) {
        const here = bridgeAt(p.x + ((q.x - p.x) * d) / (L || 1), p.z + ((q.z - p.z) * d) / (L || 1), DECK_REACH + 5);
        const outside = (h) => {
          const at = layout(h.s);
          return h.off < at.roadWest || h.off > at.roadEast;
        };
        if (here && last && outside(here) !== outside(last)) {
          // The shallower it leaves, the longer the gap along the deck
          const slant = Math.max(0.2, Math.min(1, Math.abs(here.off - last.off) / Math.max(1e-3, Math.hypot(here.s - last.s, here.off - last.off))));
          const reach = (l.half + 1.5) / slant;
          const mid = layout(here.s);
          gaps.push({ side: here.off < (mid.roadWest + mid.roadEast) / 2 ? -1 : 1, from: here.s - reach, to: here.s + reach });
        }
        if (here) last = here;
      }
    }
  }
  return (s, side) => gaps.some((g) => g.side === side && s > g.from && s < g.to);
}

// The deck's lanes s m along it: [{ off (m east of the corridor's line), north }], west to east, from its roads (GEO.bridgeLinks)
function deckLanesAt(s) {
  const out = [];
  for (const entry of GEO.bridgeLinks || []) {
    const [, flat, width, deck, , , , lanes = 0, dir = 0] = entry;
    if (!deck) continue;
    let best = null, first = null, last = null;
    for (let i = 0; i + 3 < flat.length; i += 2) {
      const ax = flat[i], az = flat[i + 1], bx = flat[i + 2], bz = flat[i + 3], L = Math.hypot(bx - ax, bz - az) || 1;
      for (let d = 0; d <= L; d += 2) {
        const here = bridgeAt(ax + ((bx - ax) * d) / L, az + ((bz - az) * d) / L, DECK_REACH);
        if (!here) continue;
        first ??= here;
        last = here;
        if (!best || Math.abs(here.s - s) < Math.abs(best.s - s)) best = here;
      }
    }
    if (!best || Math.abs(best.s - s) > 6 || !first || first === last) continue;
    const north = (last.s > first.s) === (dir >= 0);
    const n = Math.max(1, lanes || Math.round((width - 1.5) / 3.3));
    for (let k = 0; k < n; k++) out.push({ off: best.off + (k - (n - 1) / 2) * 3.3 * (north ? 1 : -1), north });
  }
  return out.sort((a, b) => a.off - b.off);
}

// A tapering block, centred on the y axis: w across and d along at its foot, narrowing to w1 and d1. uv: metres across the
// face from its centre, and height.
function frustum(w0, d0, w1, d1, y0, y1) {
  const corners = (w, d, y) => [[-w / 2, y, -d / 2], [w / 2, y, -d / 2], [w / 2, y, d / 2], [-w / 2, y, d / 2]];
  const low = corners(w0, d0, y0), high = corners(w1, d1, y1);
  const position = [], normal = [], coords = [], index = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4, k = position.length / 3;
    const a = new THREE.Vector3(...low[i]), b = new THREE.Vector3(...low[j]), c = new THREE.Vector3(...high[i]);
    const n = new THREE.Vector3().subVectors(c, a).cross(new THREE.Vector3().subVectors(b, a)).normalize();
    position.push(...low[i], ...low[j], ...high[i], ...high[j]);
    for (let m = 0; m < 4; m++) normal.push(n.x, n.y, n.z);
    const half0 = a.distanceTo(b) / 2, half1 = new THREE.Vector3(...high[i]).distanceTo(new THREE.Vector3(...high[j])) / 2;
    coords.push(-half0, y0, half0, y0, -half1, y1, half1, y1);
    index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
  }
  const top = position.length / 3;
  for (const v of high) { position.push(...v); normal.push(0, 1, 0); coords.push(0, y1 + 40); }
  index.push(top, top + 2, top + 1, top, top + 3, top + 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(coords, 2));
  g.setIndex(index);
  return g;
}

function buildHarbourBridge(group) {
  readStreets();
  const bridge = new THREE.Group();
  bridge.name = 'HarbourBridge';
  bridge.userData.lifted = true;
  const struts = [];
  const strut = (a, b, w = 1.6, d = 1.6) => struts.push(strutMatrix(a, b, w, d));
  const lanterns = [];
  const pylonPlaces = pylonStations();

  // The arch from hinge to hinge, short of the pylons: the approaches' trusses carry the deck between
  const archFrom = BRIDGE_SPAN.middle - BEARINGS / 2, archTo = BRIDGE_SPAN.middle + BEARINGS / 2;
  const middle = (archFrom + archTo) / 2, halfSpan = (archTo - archFrom) / 2;
  const lower = (t) => WATER + 3 + LOWER_RISE * (1 - t * t); // t: -1 .. 1 along the span
  const upper = (t) => {
    const depth = 18 + 40 * t * t; // the truss deepens towards the bearings
    return Math.min(ARCH_TOP + WATER * 0, lower(t) + depth);
  };

  // Two trusses and the bracing between them
  for (const side of TRUSSES) {
    for (let i = 0; i < PANELS; i++) {
      const t0 = i / PANELS * 2 - 1, t1 = (i + 1) / PANELS * 2 - 1;
      const s0 = middle + t0 * halfSpan, s1 = middle + t1 * halfSpan;
      strut(at(s0, side, lower(t0)), at(s1, side, lower(t1)), 2.6, 3.4);
      strut(at(s0, side, upper(t0)), at(s1, side, upper(t1)), 2.2, 2.6);
      strut(at(s0, side, lower(t0)), at(s0, side, upper(t0)), 1.2, 1.2);
      strut(i % 2 ? at(s0, side, lower(t0)) : at(s1, side, lower(t1)), i % 2 ? at(s1, side, upper(t1)) : at(s0, side, upper(t0)), 1.1, 1.1);
      // Hangers carry the deck wherever the arch has risen above it
      const y = deckHeight(s0);
      if (lower(t0) > y + 2) {
        strut(at(s0, side, y), at(s0, side, lower(t0)), 1.3, 0.8);
        // A lantern on an arm over the roadway, as the bridge's posts have
        if (lower(t0) > y + 10) {
          const inward = side === TRUSS.east ? side - 5 : side + 5;
          strut(at(s0, side, y + 8.6), at(s0, inward, y + 8.6), 0.5, 0.3);
          lanterns.push(at(s0, inward, y + 8.2));
        }
      }
    }
    const end = PANELS / 2;
    void end;
  }
  for (let i = 0; i <= PANELS; i++) {
    const t = i / PANELS * 2 - 1, s = middle + t * halfSpan;
    strut(at(s, TRUSS.west, upper(t)), at(s, TRUSS.east, upper(t)), 0.9, 0.9);
    if (i < PANELS) {
      const t1 = (i + 1) / PANELS * 2 - 1, s1 = middle + t1 * halfSpan;
      strut(at(s, TRUSS.west, upper(t)), at(s1, TRUSS.east, upper(t1)), 0.6, 0.6);
      strut(at(s, TRUSS.east, upper(t)), at(s1, TRUSS.west, upper(t1)), 0.6, 0.6);
      if (lower(t) > deckHeight(s) + 7) {
        strut(at(s, TRUSS.west, lower(t)), at(s, TRUSS.east, lower(t)), 0.9, 0.9);
      }
    }
  }

  // Approach spans: steel piers from the ground up to the deck, either side of the arch. A pier that would land on a
  // street below moves along a little, or isn't built.
  const PIER_STEP = 56;
  for (let s0 = 40; s0 < BRIDGE_LENGTH - 40; s0 += PIER_STEP) {
    if (s0 > middle - halfSpan - 6 && s0 < middle + halfSpan + 6) continue;
    const s = [0, 4, -4, 8, -8, 12, -12, 16, -16].map((d) => s0 + d).find((t) => TRUSSES.every((side) => {
      const foot = at(t, side, 0), q = axis(t);
      return clearOfStreets(foot.x, foot.z, q.ux, q.uz, 1.4, 1.4, 0.5);
    }));
    if (s === undefined) continue;
    const deck = deckHeight(s) - 1.4;
    for (const side of TRUSSES) {
      const foot = at(s, side, 0);
      const ground = Math.max(WATER, groundHeight(foot.x, foot.z));
      if (deck - ground < 2.5) continue;
      foot.y = ground - 1;
      strut(foot, at(s, side, deck), 2.0, 2.8);
    }
    const p = at(s, TRUSS_MID, 0);
    if (deck - Math.max(WATER, groundHeight(p.x, p.z)) > 2.5) strut(at(s, TRUSS.west, deck), at(s, TRUSS.east, deck), 1.4, 2.2);
  }

  // The approaches: a steel truss under the deck on either side, from pier to pier, wherever there's height for it. Lamp
  // standards along the roadway, where no hanger carries a lantern.
  const TRUSS_BAY = 14, TRUSS_DEPTH = 7;
  for (let s0 = 40; s0 + TRUSS_BAY < BRIDGE_LENGTH - 40; s0 += TRUSS_BAY) {
    const s1 = s0 + TRUSS_BAY;
    if (s1 > middle - halfSpan - 12 && s0 < middle + halfSpan + 12) continue;
    const top0 = deckHeight(s0) - 1.4, top1 = deckHeight(s1) - 1.4;
    for (const side of TRUSSES) {
      const foot = at(s0, side, 0);
      if (top0 - TRUSS_DEPTH - Math.max(WATER, groundHeight(foot.x, foot.z)) < 5.5) continue;
      strut(at(s0, side, top0 - TRUSS_DEPTH), at(s1, side, top1 - TRUSS_DEPTH), 0.9, 1.2);
      strut(at(s0, side, top0), at(s0, side, top0 - TRUSS_DEPTH), 0.5, 0.5);
      strut(at(s0, side, top0), at(s1, side, top1 - TRUSS_DEPTH), 0.4, 0.4);
      strut(at(s0, side, top0 - TRUSS_DEPTH), at(s1, side, top1), 0.4, 0.4);
    }
    if (Math.floor(s0 / TRUSS_BAY) % 3 === 0) {
      for (const side of [-1, 1]) {
        const lay = layout(s0), off = side < 0 ? lay.roadWest - 0.6 : lay.roadEast + 0.6, y = deckHeight(s0);
        strut(at(s0, off, y), at(s0, off, y + 8.6), 0.25, 0.25);
        strut(at(s0, off, y + 8.6), at(s0, off - side * 4, y + 8.8), 0.16, 0.16);
        lanterns.push(at(s0, off - side * 4, y + 8.5));
      }
    }
  }

  // Lane gantries over the roadway, where the video of the drive over has them (ref/, plan 5: 1:06, 1:21, 1:33, 1:57, 2:06, 2:18, 2:27):
  // a light over each lane, an arrow for those coming your way and a cross for those not, and the 70 sign at each end
  const GANTRIES = [200, 490, 700, 1068, 1220, 1430, 1580].filter((g) => g > 80 && g < BRIDGE_LENGTH - 80);
  const laneSigns = [];
  {
    const SIZE = 1.0;
    const sign = (s, off, y, facing, cell) => {
      const q = axis(s), p = at(s, off, y);
      const g = new THREE.PlaneGeometry(SIZE, SIZE);
      const coords = g.attributes.uv;
      for (let k = 0; k < coords.count; k++) coords.setX(k, (coords.getX(k) + cell) / 3);
      g.rotateY(Math.atan2(q.ux * facing, q.uz * facing)).translate(p.x + q.ux * facing * 0.2, p.y, p.z + q.uz * facing * 0.2);
      laneSigns.push(g);
    };
    for (const s of GANTRIES) {
      const lanes = deckLanesAt(s);
      if (!lanes.length) continue;
      const y = deckHeight(s);
      const west = Math.min(...lanes.map((l) => l.off)) - 2.6, east = Math.max(...lanes.map((l) => l.off)) + 2.6;
      for (const h of [6.2, 7.3]) strut(at(s, west, y + h), at(s, east, y + h), 0.24, 0.24);
      for (const off of [west, east]) strut(at(s, off, y), at(s, off, y + 7.6), 0.42, 0.42);
      for (const lane of lanes) {
        strut(at(s, lane.off, y + 6.2), at(s, lane.off, y + 7.3), 0.1, 0.1);
        // Facing south, seen by traffic heading north
        sign(s, lane.off, y + 6.75, -1, lane.north ? 0 : 1);
        sign(s, lane.off, y + 6.75, 1, lane.north ? 1 : 0);
      }
      sign(s, west + 0.6, y + 6.75, -1, 2);
      sign(s, east - 0.6, y + 6.75, 1, 2);
    }
  }

  // The sign gantry at the south end, over the southbound lanes (SOUTH_GANTRY): boards on top of its truss, read by those coming
  // off the bridge, and a green arrow over each lane under it
  const boards = [], boardBacks = [];
  {
    const { x: gx, z: gz, reach, boards: BOARDS } = SOUTH_GANTRY;
    let west = Infinity, east = -Infinity;
    for (const [, flat, width, , , , kind, , dir] of GEO.bridgeLinks || []) {
      if ((kind && kind !== KIND_CUTTING) || !dir) continue; // on the ground, or sunk a little into it
      for (let i = 0; i + 3 < flat.length; i += 2) {
        const az = flat[i + 1], bz = flat[i + 3];
        if ((az - gz) * (bz - gz) > 0 || az === bz || (bz - az) * dir < 0) continue;
        const x = flat[i] + ((flat[i + 2] - flat[i]) * (gz - az)) / (bz - az);
        if (Math.abs(x - gx) > reach) continue;
        west = Math.min(west, x - width / 2);
        east = Math.max(east, x + width / 2);
      }
    }
    if (east > west) {
      const P = (x, h) => ({ x, y: groundHeight(x, gz) + h, z: gz });
      const w0 = west - 1.2, e0 = east + 1.2;
      for (const h of [6.0, 7.4]) strut(P(w0, h), P(e0, h), 0.22, 0.22);
      for (let x = w0; x + 2.4 <= e0; x += 2.4) strut(P(x, 6.0), P(x + 2.4, 7.4), 0.07, 0.07);
      for (const x of [w0, e0]) strut(P(x, 0), P(x, 7.6), 0.45, 0.45);
      const span = east - west, n = BOARDS.length, bw = Math.min(4.6, span / n - 0.3), bh = 1.6;
      BOARDS.forEach((_, k) => {
        const x = east - (span * (k + 0.5)) / n, p = P(x, 7.4 + bh / 2 + 0.1);
        const g = new THREE.PlaneGeometry(bw, bh);
        const coords = g.attributes.uv;
        for (let m = 0; m < coords.count; m++) coords.setY(m, (coords.getY(m) + (n - 1 - k)) / n);
        // Facing north, up the road towards the bridge
        g.rotateY(Math.PI).translate(p.x, p.y, gz - 0.3);
        boards.push(g);
        boardBacks.push(new THREE.BoxGeometry(bw + 0.1, bh + 0.1, 0.12).translate(p.x, p.y, gz - 0.2));
      });
      const lanes = Math.max(1, Math.round(span / 3.5));
      for (let l = 0; l < lanes; l++) {
        const x = west + ((l + 0.5) * span) / lanes;
        strut(P(x, 5.6), P(x, 6.0), 0.08, 0.08);
        const g = new THREE.PlaneGeometry(1.0, 1.0);
        const coords = g.attributes.uv;
        for (let m = 0; m < coords.count; m++) coords.setX(m, coords.getX(m) / 3);
        const p = P(x, 5.3);
        g.rotateY(Math.PI).translate(p.x, p.y, gz - 0.25);
        laneSigns.push(g);
      }
    }
  }

  // Flags on top of the arch
  for (const side of [-3, 3]) strut(at(middle, TRUSS_MID + side, upper(0)), at(middle, TRUSS_MID + side, upper(0) + 14), 0.22, 0.22);

  // Railings along the deck's outer edges, and masts for the railway's wires
  for (let s = 60; s + 6 <= BRIDGE_LENGTH - 60; s += 6) {
    if (s > 66 && s < BRIDGE_LENGTH - 66) {
      for (const side of [-1, 1]) {
        const here = layout(s), next = layout(s + 6);
        const off = side < 0 ? here.edgeWest + 0.25 : here.edgeEast - 0.25, off1 = side < 0 ? next.edgeWest + 0.25 : next.edgeEast - 0.25;
        const y = deckHeight(s) + 0.1, y1 = deckHeight(s + 6) + 0.1;
        strut(at(s, off, y), at(s, off, y + 1.5), 0.08, 0.08);
        strut(at(s, off, y + 1.5), at(s + 6, off1, y1 + 1.5), 0.08, 0.08);
      }
    }
    if (Math.round(s / 6) % 10 === 0) {
      const y = deckHeight(s);
      const lay = layout(s);
      strut(at(s, lay.railFrom + 0.3, y), at(s, lay.railFrom + 0.3, y + 6.8), 0.2, 0.2);
      strut(at(s, lay.railFrom + 0.3, y + 6.6), at(s, lay.tracks[0], y + 6.6), 0.1, 0.1);
    }
  }

  // Two railway tracks along the west side of the deck, north and south, through the west pylons
  for (let s = 60; s + 12 <= BRIDGE_LENGTH - 60; s += 12) {
    const here = layout(s).tracks, next = layout(s + 12).tracks;
    for (let k = 0; k < 2; k++) {
      for (const gauge of [-0.72, 0.72]) {
        const a = at(s, here[k] + gauge, deckHeight(s) + 0.05), b = at(s + 12, next[k] + gauge, deckHeight(s + 12) + 0.05);
        strut(a, b, 0.08, 0.16);
      }
    }
  }

  {
    // Posts curving in over the footway every 3 m, rails along their tops, and a mesh between them
    const from = pylonPlaces[0] - PYLON_BASE[1] / 2 - 30, to = pylonPlaces[1] + PYLON_BASE[1] / 2 + 30;
    const panels = [];
    for (let s = from; s + 3 <= to; s += 3) {
      const lay = layout(s), lay1 = layout(s + 3), y = deckHeight(s) + 0.18, y1 = deckHeight(s + 3) + 0.18;
      const outer = lay.edgeEast - 0.35, outer1 = lay1.edgeEast - 0.35;
      strut(at(s, outer, y), at(s, outer, y + 2.4), 0.07, 0.07);
      strut(at(s, outer, y + 2.4), at(s, outer - 1.1, y + 3.0), 0.07, 0.07);
      strut(at(s, outer - 1.1, y + 3.0), at(s + 3, outer1 - 1.1, y1 + 3.0), 0.05, 0.05);
      // The mesh up the outside, and over the curve
      const a = at(s, outer, y), b = at(s + 3, outer1, y1), a2 = at(s, outer, y + 2.4), b2 = at(s + 3, outer1, y1 + 2.4);
      const c = at(s, outer - 1.1, y + 3.0), d = at(s + 3, outer1 - 1.1, y1 + 3.0);
      panels.push([a, b, a2, b2], [a2, b2, c, d]);
    }
    if (panels.length && typeof document !== 'undefined') {
      const position = [], coords = [], index = [];
      for (const [p, q, r, t] of panels) {
        const k = position.length / 3;
        position.push(p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z, t.x, t.y, t.z);
        coords.push(0, 0, 3, 0, 0, 2.4, 3, 2.4);
        index.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(coords, 2));
      g.setIndex(index);
      g.computeVertexNormals();
      // Diamond wire mesh: a grid along the diagonals, 12 cm across, cut out where there's no wire
      const diagA = fract(uv().x.add(uv().y).mul(8)), diagB = fract(uv().x.sub(uv().y).mul(8));
      const wire = max(step(diagA, float(0.12)), step(diagB, float(0.12)));
      const cage = new THREE.MeshStandardNodeMaterial({ color: 0x55595c, roughness: 0.6, metalness: 0.5, side: THREE.DoubleSide });
      cage.opacityNode = wire;
      cage.alphaTest = 0.5;
      const mesh = new THREE.Mesh(g, cage);
      mesh.userData.lifted = true;
      bridge.add(mesh);
    }
  }

  const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), steel, struts.length);
  struts.forEach((m, i) => inst.setMatrixAt(i, m));
  inst.instanceMatrix.needsUpdate = true;
  inst.castShadow = true;
  inst.receiveShadow = true;
  inst.computeBoundingSphere();
  inst.userData.lifted = true;
  inst.frustumCulled = false;
  bridge.add(inst);

  // The deck, following the corridor's height: the roadway between two barriers, the footway beyond the east barrier
  // and the railway beyond the west one, out to the steel flanks at the deck's edges
  const ribbon = (list, s, offA, offB, ya, yb, nx = 0, ny = 1, nz = 0) => list.push({ s, offA, offB, ya, yb, nx, ny, nz });
  const STEP = 6;
  const stations = [];
  for (let s = 0; s <= BRIDGE_LENGTH + 0.1; s += STEP) stations.push(Math.min(s, BRIDGE_LENGTH));
  if (stations[stations.length - 1] < BRIDGE_LENGTH) stations.push(BRIDGE_LENGTH);
  const geometry = (rows) => {
    const position = [], normal = [], uv = [], index = [];
    for (let r = 0; r < rows.length; r++) {
      for (const row of rows[r]) {
        const q = axis(row.s), n = across(q, 1);
        const i = position.length / 3;
        position.push(q.x + n.x * row.offA, row.ya, q.z + n.y * row.offA, q.x + n.x * row.offB, row.yb, q.z + n.y * row.offB);
        // A side face's normal points away from the deck's centre line on its own side
        const sx = row.ny ? 0 : n.x * row.nx, sz = row.ny ? 0 : n.y * row.nx;
        normal.push(sx, row.ny, sz, sx, row.ny, sz);
        uv.push(row.offA / 10, row.s / 10, row.offB / 10, row.s / 10);
        if (r > 0) {
          const j = i - rows[r - 1].length * 2; // the same pair at the station before
          // Counter-clockwise seen from above for a strip whose pairs run west to east
          index.push(j, j + 1, i, j + 1, i + 1, i);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(index);
    g.computeBoundingSphere();
    return g;
  };
  // One row of vertex pairs per station, for each strip
  const opening = rampOpenings();
  const strips = ['road', 'footway', 'rail', 'cycleway', 'barrierWest', 'barrierEast', 'separator', 'flankWest', 'flankEast'];
  const rows = Object.fromEntries(strips.map((k) => [k, []]));
  for (const s of stations) {
    const y = deckHeight(s) - 0.04;
    const lay = layout(s);
    // Near its ends the deck is its roads alone; between, its rail, cycleway and footway too
    const full = s >= 60 && s <= BRIDGE_LENGTH - 60;
    const r = Object.fromEntries(strips.map((k) => [k, []]));
    // Each pair runs left to right seen from above, travelling north
    ribbon(r.road, s, lay.roadWest, lay.roadEast, y, y);
    for (const side of [-1, 1]) {
      if (opening(s, side)) continue;
      const barrier = side < 0 ? r.barrierWest : r.barrierEast;
      const inner = side < 0 ? lay.roadWest : lay.roadEast, outer = inner + side * BARRIER.width, top = y + BARRIER.height;
      const [a, b] = side < 0 ? [outer, inner] : [inner, outer];
      ribbon(barrier, s, a, b, top, top); // its top
      ribbon(barrier, s, inner, inner, side < 0 ? top : y, side < 0 ? y : top, -side, 0, 0); // the face to the road
      const edge = full ? (side < 0 ? lay.edgeWest : lay.edgeEast) : outer;
      ribbon(side < 0 ? r.flankWest : r.flankEast, s, edge, edge, side < 0 ? y - 2.6 : y + 1.1, side < 0 ? y + 1.1 : y - 2.6, side, 0, 0);
    }
    // Between the bus lane and the Cahill's lane where it runs apart: a barrier down the middle of the gap, both faces
    if (lay.gap) {
      const mid = (lay.gap[0] + lay.gap[1]) / 2, half = Math.min(BARRIER.width, lay.gap[1] - lay.gap[0]) / 2, top = y + BARRIER.height;
      ribbon(r.separator, s, mid - half, mid + half, top, top);
      ribbon(r.separator, s, mid - half, mid - half, top, y, -1, 0, 0);
      ribbon(r.separator, s, mid + half, mid + half, y, top, 1, 0, 0);
    }
    if (full) {
      if (!opening(s, 1)) ribbon(r.footway, s, lay.footFrom, lay.edgeEast, y + 0.18, y + 0.18);
      if (!opening(s, -1)) {
        ribbon(r.rail, s, lay.railFrom, lay.roadWest - BARRIER.width, y - 0.02, y - 0.02);
        ribbon(r.cycleway, s, lay.edgeWest, lay.railFrom, y + 0.12, y + 0.12);
      }
    }
    for (const key of strips) rows[key].push(r[key]);
  }
  // Strips that start or stop partway along (the footway and railway near the ends) are built per run of stations
  const runs = (list) => {
    const out = [];
    let run = [];
    for (const row of list) {
      if (row.length && (!run.length || run[run.length - 1].length === row.length)) run.push(row);
      else { if (run.length > 1) out.push(run); run = row.length ? [row] : []; }
    }
    if (run.length > 1) out.push(run);
    return out;
  };
  const barrierMat = new THREE.MeshStandardNodeMaterial({ color: 0x2f3234, roughness: 0.6, metalness: 0.4 });
  const flankMat = Object.assign(deckSide.clone(), { side: THREE.DoubleSide });
  const materials = {
    footway: new THREE.MeshStandardNodeMaterial({ color: 0x9a948a, roughness: 0.9 }),
    rail: new THREE.MeshStandardNodeMaterial({ color: 0x4e4a46, roughness: 0.95 }),
    cycleway: new THREE.MeshStandardNodeMaterial({ color: 0x7d7a72, roughness: 0.9 }),
    barrierWest: barrierMat, barrierEast: barrierMat, separator: barrierMat, flankWest: flankMat, flankEast: flankMat
  };
  for (const key of Object.keys(materials)) {
    for (const run of runs(rows[key])) {
      const mesh = new THREE.Mesh(geometry(run), materials[key]);
      mesh.castShadow = key.startsWith('flank') || key.startsWith('barrier');
      mesh.receiveShadow = true;
      mesh.userData.lifted = true;
      bridge.add(mesh);
    }
  }
  const surface = geometry(rows.road);

  // The four granite pylons, where they were placed above. Solid to the deck; there, an arch through each, round-headed, for the
  // railway and cycleway on the west and the Cahill's lane and the footway on the east; then tapering, with ledges, stepping in at
  // the top. In the pylon's own frame x runs west, so a place across the deck east of its line is at -(off - middle).
  for (const s of pylonPlaces) {
    for (const side of [-1, 1]) {
      const across = pylonAcross(s, side), middle = (across.from + across.to) / 2;
      const p = at(s, middle, 0);
      const q = axis(s);
      const yaw = Math.atan2(q.ux, q.uz);
      const base = Math.max(WATER, groundHeight(p.x, p.z)) - 1;
      const H = PYLON_HEIGHT, W = PYLON_BASE[0], D = PYLON_BASE[1];
      const dy = deckHeight(s), crown = dy + PYLON_OPENING, top = crown + 3;
      // Below the deck, solid; the piers either side of the arch, and over it, plain granite (no window: uv lifted out of its band)
      const block = (from, to, y0, y1, scale = 0.97) => {
        const g = frustum(to - from, D * scale, to - from, D * scale, y0, y1).translate(-((from + to) / 2 - middle), 0, 0);
        const uvs = g.attributes.uv;
        for (let k = 0; k < uvs.count; k++) uvs.setY(k, uvs.getY(k) + 200);
        return g;
      };
      const parts = [frustum(W, D, W * 0.98, D * 0.98, base, dy - 1.2)];
      for (const [from, to] of pylonPieces(s, side)) parts.push(block(from, to, dy - 1.2, top));
      parts.push(block(across.openFrom, across.openTo, crown, top));
      // The arch's head: the corners filled in, in steps, to a half circle no wider than the opening
      const r = Math.min((across.openTo - across.openFrom) / 2, PYLON_OPENING - ARCH_CLEAR);
      const steps = 6;
      for (let k = 0; k < steps; k++) {
        const y0 = crown - r + (k * r) / steps, y1 = crown - r + ((k + 1) * r) / steps;
        const open = Math.sqrt(Math.max(0, r * r - (y1 - (crown - r)) ** 2));
        const fill = (across.openTo - across.openFrom) / 2 - open;
        if (fill < 0.05) continue;
        parts.push(block(across.openFrom, across.openFrom + fill, y0, y1));
        parts.push(block(across.openTo - fill, across.openTo, y0, y1));
      }
      const sections = [
        [top, H - 12, 0.9, 0.76], [H - 12, H - 10.8, 0.82, 0.82], [H - 10.8, H - 3, 0.72, 0.64], [H - 3, H - 2, 0.7, 0.7], [H - 2, H, 0.58, 0.5]
      ].filter(([y0, y1]) => y1 > y0);
      for (const [y0, y1, a, b] of sections) parts.push(frustum(W * a, D * a, W * b, D * b, y0, y1));
      const mesh = new THREE.Mesh(mergeGeometries(parts, false), granite);
      mesh.position.set(p.x, 0, p.z);
      mesh.rotation.y = yaw;
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.userData.lifted = true;
      bridge.add(mesh);
    }
  }

  // Lane numbers painted across the roadway before each gantry, 1 to 8 from west to east, read by those coming up to it (the video,
  // 1:21 and 2:12), and the footway's cage between the pylons (ref/details/4.png)
  if (typeof document !== 'undefined') {
    const numbers = [];
    for (const g of GANTRIES) {
      deckLanesAt(g).forEach((lane, k) => {
        if (k > 7) return;
        const towards = lane.north ? 1 : -1, s = g - towards * 18;
        const q = axis(s), p = at(s, lane.off, deckHeight(s) + 0.03);
        const plane = new THREE.PlaneGeometry(1.6, 2.4);
        const uvs = plane.attributes.uv;
        for (let i = 0; i < uvs.count; i++) uvs.setX(i, (uvs.getX(i) + k) / 8);
        // Flat on the deck, its top towards where the lane goes
        plane.rotateX(-Math.PI / 2).rotateY(Math.atan2(q.ux * towards, q.uz * towards) + Math.PI).translate(p.x, p.y, p.z);
        numbers.push(plane);
      });
    }
    if (numbers.length) {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 96;
      const c = canvas.getContext('2d');
      c.fillStyle = '#f2f2ee';
      c.font = '800 84px Arial, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      for (let k = 0; k < 8; k++) c.fillText(String(k + 1), 32 + k * 64, 52);
      const map = new THREE.CanvasTexture(canvas);
      map.colorSpace = THREE.SRGBColorSpace;
      const paint = new THREE.MeshStandardNodeMaterial({ map, alphaTest: 0.5, transparent: false, roughness: 0.8 });
      const mesh = new THREE.Mesh(mergeGeometries(numbers, false), paint);
      mesh.receiveShadow = true;
      mesh.userData.lifted = true;
      bridge.add(mesh);
    }
  }
  // The lanterns' glass, the gantries' lights and the flags
  if (lanterns.length) {
    const lit = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 0.7, 0.42), lanternGlass, lanterns.length);
    const m = new THREE.Matrix4();
    lanterns.forEach((v, i) => lit.setMatrixAt(i, m.makeTranslation(v.x, v.y, v.z)));
    lit.instanceMatrix.needsUpdate = true;
    lit.computeBoundingSphere();
    lit.userData.lifted = true;
    lit.frustumCulled = false;
    bridge.add(lit);
  }
  if (laneSigns.length && typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = 128;
    const c = canvas.getContext('2d');
    c.fillStyle = '#0c0e10';
    c.fillRect(0, 0, 384, 128);
    c.lineWidth = 16;
    c.lineCap = 'round';
    c.strokeStyle = '#34e07a';
    c.beginPath(); c.moveTo(64, 28); c.lineTo(64, 96); c.moveTo(36, 68); c.lineTo(64, 98); c.lineTo(92, 68); c.stroke();
    c.strokeStyle = '#f0303a';
    c.beginPath(); c.moveTo(160, 32); c.lineTo(224, 96); c.moveTo(224, 32); c.lineTo(160, 96); c.stroke();
    c.fillStyle = '#d81e28';
    c.beginPath(); c.arc(320, 64, 58, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#fff';
    c.font = '800 64px Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('70', 320, 68);
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.FrontSide });
    material.colorNode = texture(map, uv()).mul(1.5);
    const mesh = new THREE.Mesh(mergeGeometries(laneSigns, false), material);
    mesh.userData.lifted = true;
    bridge.add(mesh);
  }
  if (boards.length && typeof document !== 'undefined') {
    const n = SOUTH_GANTRY.boards.length, W = 512, H = 160;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H * n;
    const c = canvas.getContext('2d');
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    SOUTH_GANTRY.boards.forEach(([style, ...lines], k) => {
      const y0 = k * H;
      c.fillStyle = style === 'bus' ? '#f4f4f0' : style === 'green' ? '#0f6a3a' : '#3b352e';
      c.fillRect(0, y0, W, H);
      c.strokeStyle = style === 'bus' ? '#111' : style === 'green' ? '#f4f4f0' : '#2a2520';
      c.lineWidth = 6;
      c.strokeRect(8, y0 + 8, W - 16, H - 16);
      let x = W / 2;
      if (style === 'bus') {
        // The bus lane's B, white on red, then its words
        c.fillStyle = '#d4402a';
        c.fillRect(30, y0 + 30, 100, 100);
        c.fillStyle = '#fff';
        c.font = '800 80px Arial, sans-serif';
        c.fillText('B', 80, y0 + 84);
        c.fillStyle = '#111';
        x = (W + 140) / 2;
      } else c.fillStyle = '#fff';
      const big = lines.length > 1 ? 52 : 64;
      c.font = `700 ${big}px Arial, sans-serif`;
      lines.forEach((line, i) => c.fillText(line, x, y0 + H / 2 + (i - (lines.length - 1) / 2) * (big + 6), W - (style === 'bus' ? 180 : 40)));
    });
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 4;
    const signs = new THREE.Mesh(mergeGeometries(boards, false), new THREE.MeshBasicNodeMaterial({ map, side: THREE.FrontSide }));
    signs.userData.lifted = true;
    bridge.add(signs);
    const backs = new THREE.Mesh(mergeGeometries(boardBacks, false), new THREE.MeshStandardNodeMaterial({ color: 0x6d7174, roughness: 0.7 }));
    backs.userData.lifted = true;
    bridge.add(backs);
  }
  {
    const flagGeo = [-3, 3].map((off) => new THREE.BoxGeometry(0.06, 2.6, 5).translate(at(middle, off, 0).x, upper(0) + 12.4, at(middle, off, 0).z + 2.6));
    const flags = new THREE.Mesh(mergeGeometries(flagGeo, false), new THREE.MeshBasicNodeMaterial({ color: 0x1b2a78 }));
    flags.userData.lifted = true;
    bridge.add(flags);
  }

  // Sandstone arches where the approaches come down to the land, wherever nothing runs through. Each wall stands on the
  // ground beneath it, out to the deck's edge.
  {
    const position = [], normal = [], coords = [], index = [];
    const BAY = 6, ARCH = 15;
    for (let s0 = 30; s0 + BAY < BRIDGE_LENGTH - 30; s0 += BAY) {
      const s1 = s0 + BAY;
      if (s1 > pylonPlaces[0] - 40 && s0 < pylonPlaces[1] + 40) continue;
      for (const side of [-1, 1]) {
        const off = side < 0 ? layout(s0).edgeWest - 0.2 : layout(s0).edgeEast + 0.2;
        const a = at(s0, off, 0), b = at(s1, off, 0);
        const ga = Math.max(WATER, groundHeight(a.x, a.z)), gb = Math.max(WATER, groundHeight(b.x, b.z));
        const ta = deckHeight(s0) - 0.2, tb = deckHeight(s1) - 0.2;
        const rise = (ta + tb - ga - gb) / 2;
        if (rise < 4 || rise > 13) continue;
        const q = axis(s0);
        if (!clearOfStreets((a.x + b.x) / 2, (a.z + b.z) / 2, q.ux, q.uz, 1.5, BAY / 2 + 1, 0.5)) continue;
        const n = across(q, side);
        const k = position.length / 3;
        position.push(a.x, ga - 1, a.z, b.x, gb - 1, b.z, a.x, ta, a.z, b.x, tb, b.z);
        for (let m = 0; m < 4; m++) normal.push(n.x, 0, n.y);
        coords.push(s0 / ARCH, 0, s1 / ARCH, 0, s0 / ARCH, 1, s1 / ARCH, 1);
        if (side > 0) index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
        else index.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    if (index.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(coords, 2));
      g.setIndex(index);
      g.computeBoundingSphere();
      const walls = new THREE.Mesh(g, sandstoneArches);
      walls.castShadow = walls.receiveShadow = true;
      walls.userData.lifted = true;
      bridge.add(walls);
    }
  }
  group.add(bridge);
  return surface;
}

export { buildHarbourBridge, harbourBridgeColliders };
