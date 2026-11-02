import * as THREE from 'three/webgpu';
import { abs, color, float, floor, fract, max, mix, mod, positionWorld, smoothstep, sqrt, step, texture, uv } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cityUniforms } from './tsl-materials.js';
import { BRIDGE_LENGTH, BRIDGE_SPAN, DECK_SID, HALF_WIDTH, bridgeAt, bridgePoint, deckHeight } from './bridge.js';
import { GEO } from './geodata.js';
import { groundHeight } from './surfaces.js';

// The Sydney Harbour Bridge: the deck along the corridor (js/bridge.js), the steel through-arch over the water with its
// hangers, the granite pylons at each end of the arch, and the piers carrying the approaches. The roadway is the
// corridor's width, with a barrier at each edge where the game holds cars (js/controllers.js); the footway runs
// along its east side and the railway along its west, out to the deck's full width.

const WATER = -2.2;
const DECK_WIDTH = 34; // of what is modelled; the corridor's lanes run down the middle
const TRUSS_OFFSET = 15; // m each side of the deck's centre line
const ARCH_TOP = 134 + WATER; // top of the arch above the water
const LOWER_RISE = 118; // m the lower chord rises from its hinges
const PANELS = 28;
const PYLON_HEIGHT = 89 + WATER;
const PYLON_BASE = [15.5, 21]; // m across and along the deck
const PYLON_OFFSET = DECK_WIDTH / 2 + 1 + PYLON_BASE[0] / 2; // the inner face a metre outside the deck
const BARRIER = { width: 0.5, height: 0.9 };

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
const PYLON_ARCH = { from: 58, to: 68, halfWidth: 3.1 };
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

// Where the pylons stand, either side of the deck at each end of the arch: each pair starts 7 m back from the arch's usual
// bearings (503 m apart, centred on the water) and moves away from the water until it is clear of the streets beneath
// (Hickson Rd at the south end, Olympic Dr at the north). The arch then spans from pylon to pylon.
let pylonPlaces = null;
function pylonStations() {
  if (pylonPlaces) return pylonPlaces;
  const clear = (where) => [-1, 1].every((side) => {
    const q = axis(where), p = at(where, side * PYLON_OFFSET, 0);
    return clearOfStreets(p.x, p.z, q.ux, q.uz, PYLON_BASE[0] / 2, PYLON_BASE[1] / 2, 1);
  });
  pylonPlaces = [[BRIDGE_SPAN.middle - 251.5 - 7, -1], [BRIDGE_SPAN.middle + 251.5 + 7, 1]].map(([start, step]) => {
    let s = start;
    for (let k = 0; k < 40 && !clear(s); k++) s += step;
    return s;
  });
  return pylonPlaces;
}

// What stops the player: exactly the granite's footprint, turned with it. Needed from the start, unlike the bridge itself.
function harbourBridgeColliders(colliders) {
  readStreets();
  for (const s of pylonStations()) {
    for (const side of [-1, 1]) {
      const p = at(s, side * PYLON_OFFSET, 0);
      const q = axis(s);
      const yaw = Math.atan2(q.ux, q.uz);
      const hx = PYLON_BASE[0] / 2, hz = PYLON_BASE[1] / 2;
      const ex = Math.abs(Math.cos(yaw)) * hx + Math.abs(Math.sin(yaw)) * hz, ez = Math.abs(Math.sin(yaw)) * hx + Math.abs(Math.cos(yaw)) * hz;
      colliders.push({
        minX: p.x - ex, maxX: p.x + ex, minZ: p.z - ez, maxZ: p.z + ez, minY: 0, maxY: PYLON_HEIGHT - groundHeight(p.x, p.z),
        obb: { cx: p.x, cz: p.z, hx, hz, cs: Math.cos(yaw), sn: Math.sin(yaw) }
      });
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
        const here = bridgeAt(p.x + ((q.x - p.x) * d) / (L || 1), p.z + ((q.z - p.z) * d) / (L || 1), 30);
        if (here && last && (Math.abs(here.off) >= HALF_WIDTH) !== (Math.abs(last.off) >= HALF_WIDTH)) {
          // The shallower it leaves, the longer the gap along the deck
          const slant = Math.max(0.2, Math.min(1, Math.abs(here.off - last.off) / Math.max(1e-3, Math.hypot(here.s - last.s, here.off - last.off))));
          const reach = (l.half + 1.5) / slant;
          gaps.push({ side: Math.sign(here.off), from: here.s - reach, to: here.s + reach });
        }
        if (here) last = here;
      }
    }
  }
  return (s, side) => gaps.some((g) => g.side === side && s > g.from && s < g.to);
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

  const archFrom = pylonPlaces[0] + PYLON_BASE[1] / 2, archTo = pylonPlaces[1] - PYLON_BASE[1] / 2;
  const middle = (archFrom + archTo) / 2, halfSpan = (archTo - archFrom) / 2;
  const lower = (t) => WATER + 3 + LOWER_RISE * (1 - t * t); // t: -1 .. 1 along the span
  const upper = (t) => {
    const depth = 18 + 40 * t * t; // the truss deepens towards the bearings
    return Math.min(ARCH_TOP + WATER * 0, lower(t) + depth);
  };

  // Two trusses and the bracing between them
  for (const side of [-TRUSS_OFFSET, TRUSS_OFFSET]) {
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
          const inward = side > 0 ? side - 5 : side + 5;
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
    strut(at(s, -TRUSS_OFFSET, upper(t)), at(s, TRUSS_OFFSET, upper(t)), 0.9, 0.9);
    if (i < PANELS) {
      const t1 = (i + 1) / PANELS * 2 - 1, s1 = middle + t1 * halfSpan;
      strut(at(s, -TRUSS_OFFSET, upper(t)), at(s1, TRUSS_OFFSET, upper(t1)), 0.6, 0.6);
      strut(at(s, TRUSS_OFFSET, upper(t)), at(s1, -TRUSS_OFFSET, upper(t1)), 0.6, 0.6);
      if (lower(t) > deckHeight(s) + 7) {
        strut(at(s, -TRUSS_OFFSET, lower(t)), at(s, TRUSS_OFFSET, lower(t)), 0.9, 0.9);
      }
    }
  }

  // Approach spans: steel piers from the ground up to the deck, either side of the arch. A pier that would land on a
  // street below moves along a little, or isn't built.
  const PIER_STEP = 56;
  for (let s0 = 40; s0 < BRIDGE_LENGTH - 40; s0 += PIER_STEP) {
    if (s0 > middle - halfSpan - 6 && s0 < middle + halfSpan + 6) continue;
    const s = [0, 4, -4, 8, -8, 12, -12, 16, -16].map((d) => s0 + d).find((t) => [-TRUSS_OFFSET, TRUSS_OFFSET].every((side) => {
      const foot = at(t, side, 0), q = axis(t);
      return clearOfStreets(foot.x, foot.z, q.ux, q.uz, 1.4, 1.4, 0.5);
    }));
    if (s === undefined) continue;
    const deck = deckHeight(s) - 1.4;
    for (const side of [-TRUSS_OFFSET, TRUSS_OFFSET]) {
      const foot = at(s, side, 0);
      const ground = Math.max(WATER, groundHeight(foot.x, foot.z));
      if (deck - ground < 2.5) continue;
      foot.y = ground - 1;
      strut(foot, at(s, side, deck), 2.0, 2.8);
    }
    const p = at(s, 0, 0);
    if (deck - Math.max(WATER, groundHeight(p.x, p.z)) > 2.5) strut(at(s, -TRUSS_OFFSET, deck), at(s, TRUSS_OFFSET, deck), 1.4, 2.2);
  }

  // The approaches: a steel truss under the deck on either side, from pier to pier, wherever there's height for it. Lamp
  // standards along the roadway, where no hanger carries a lantern.
  const TRUSS_BAY = 14, TRUSS_DEPTH = 7;
  for (let s0 = 40; s0 + TRUSS_BAY < BRIDGE_LENGTH - 40; s0 += TRUSS_BAY) {
    const s1 = s0 + TRUSS_BAY;
    if (s1 > middle - halfSpan - 12 && s0 < middle + halfSpan + 12) continue;
    const top0 = deckHeight(s0) - 1.4, top1 = deckHeight(s1) - 1.4;
    for (const side of [-TRUSS_OFFSET, TRUSS_OFFSET]) {
      const foot = at(s0, side, 0);
      if (top0 - TRUSS_DEPTH - Math.max(WATER, groundHeight(foot.x, foot.z)) < 5.5) continue;
      strut(at(s0, side, top0 - TRUSS_DEPTH), at(s1, side, top1 - TRUSS_DEPTH), 0.9, 1.2);
      strut(at(s0, side, top0), at(s0, side, top0 - TRUSS_DEPTH), 0.5, 0.5);
      strut(at(s0, side, top0), at(s1, side, top1 - TRUSS_DEPTH), 0.4, 0.4);
      strut(at(s0, side, top0 - TRUSS_DEPTH), at(s1, side, top1), 0.4, 0.4);
    }
    if (Math.floor(s0 / TRUSS_BAY) % 3 === 0) {
      for (const side of [-1, 1]) {
        const off = side * (HALF_WIDTH + 1.1), y = deckHeight(s0);
        strut(at(s0, off, y), at(s0, off, y + 8.6), 0.25, 0.25);
        strut(at(s0, off, y + 8.6), at(s0, off - side * 4, y + 8.8), 0.16, 0.16);
        lanterns.push(at(s0, off - side * 4, y + 8.5));
      }
    }
  }

  // Lane gantries over the roadway: lights over each lane, arrows for those coming your way and crosses for those not
  const GANTRIES = [BRIDGE_SPAN.south - 160, BRIDGE_SPAN.south + 120, BRIDGE_SPAN.middle, BRIDGE_SPAN.north - 120, BRIDGE_SPAN.north + 160]
    .filter((g) => g > 80 && g < BRIDGE_LENGTH - 80);
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
      const y = deckHeight(s);
      for (const h of [6.2, 7.3]) strut(at(s, -HALF_WIDTH - 1, y + h), at(s, HALF_WIDTH + 1, y + h), 0.24, 0.24);
      for (const side of [-1, 1]) strut(at(s, side * (HALF_WIDTH + 1), y), at(s, side * (HALF_WIDTH + 1), y + 7.6), 0.42, 0.42);
      for (let off = -10.5; off <= 10.5; off += 3) {
        strut(at(s, off, y + 6.2), at(s, off, y + 7.3), 0.1, 0.1);
        // Facing south, traffic heading north, which keeps to the west
        sign(s, off, y + 6.75, -1, off < 0 ? 0 : 1);
        sign(s, off, y + 6.75, 1, off > 0 ? 0 : 1);
      }
      sign(s, -12.4, y + 6.75, -1, 2);
      sign(s, 12.4, y + 6.75, 1, 2);
    }
  }

  // Flags on top of the arch
  for (const side of [-3, 3]) strut(at(middle, side, upper(0)), at(middle, side, upper(0) + 14), 0.22, 0.22);

  // Railings along the deck's outer edges, and masts for the railway's wires
  for (let s = 60; s + 6 <= BRIDGE_LENGTH - 60; s += 6) {
    if (s > 66 && s < BRIDGE_LENGTH - 66) {
      for (const side of [-1, 1]) {
        const off = side * (DECK_WIDTH / 2 - 0.25), y = deckHeight(s) + 0.1, y1 = deckHeight(s + 6) + 0.1;
        strut(at(s, off, y), at(s, off, y + 1.5), 0.08, 0.08);
        strut(at(s, off, y + 1.5), at(s + 6, off, y1 + 1.5), 0.08, 0.08);
      }
    }
    if (Math.round(s / 6) % 10 === 0) {
      const y = deckHeight(s);
      strut(at(s, -DECK_WIDTH / 2 + 0.4, y), at(s, -DECK_WIDTH / 2 + 0.4, y + 6.8), 0.2, 0.2);
      strut(at(s, -DECK_WIDTH / 2 + 0.4, y + 6.6), at(s, -13.2, y + 6.6), 0.1, 0.1);
    }
  }

  // Two railway tracks along the west side of the deck, where it is wide enough to carry them
  for (let s = 60; s + 12 <= BRIDGE_LENGTH - 60; s += 12) {
    for (const off of [-14.2, -15.7]) {
      for (const gauge of [-0.72, 0.72]) {
        const a = at(s, off + gauge, deckHeight(s) + 0.05), b = at(s + 12, off + gauge, deckHeight(s + 12) + 0.05);
        strut(a, b, 0.08, 0.16);
      }
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
  const STEP = 12;
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
  const rows = { road: [], footway: [], rail: [], barrierWest: [], barrierEast: [], flankWest: [], flankEast: [] };
  for (const s of stations) {
    const y = deckHeight(s) - 0.04;
    const hw = s < 60 || s > BRIDGE_LENGTH - 60 ? HALF_WIDTH + BARRIER.width : DECK_WIDTH / 2;
    const r = { road: [], footway: [], rail: [], barrierWest: [], barrierEast: [], flankWest: [], flankEast: [] };
    // Each pair runs left to right seen from above, travelling north
    ribbon(r.road, s, -HALF_WIDTH, HALF_WIDTH, y, y);
    for (const side of [-1, 1]) {
      if (opening(s, side)) continue;
      const barrier = side < 0 ? r.barrierWest : r.barrierEast;
      const inner = side * HALF_WIDTH, outer = side * (HALF_WIDTH + BARRIER.width), top = y + BARRIER.height;
      const [a, b] = side < 0 ? [outer, inner] : [inner, outer];
      ribbon(barrier, s, a, b, top, top); // its top
      ribbon(barrier, s, inner, inner, side < 0 ? top : y, side < 0 ? y : top, -side, 0, 0); // the face to the road
      ribbon(side < 0 ? r.flankWest : r.flankEast, s, side * hw, side * hw, side < 0 ? y - 2.6 : y + 1.1, side < 0 ? y + 1.1 : y - 2.6, side, 0, 0);
    }
    if (hw > HALF_WIDTH + BARRIER.width + 0.5) {
      if (!opening(s, 1)) ribbon(r.footway, s, HALF_WIDTH + BARRIER.width, hw, y + 0.18, y + 0.18);
      if (!opening(s, -1)) ribbon(r.rail, s, -hw, -(HALF_WIDTH + BARRIER.width), y - 0.02, y - 0.02);
    }
    for (const key of Object.keys(rows)) rows[key].push(r[key]);
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
    barrierWest: barrierMat, barrierEast: barrierMat, flankWest: flankMat, flankEast: flankMat
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

  // The four granite pylons, where they were placed above: tapering, with ledges, and stepping in at the top
  for (const s of pylonPlaces) {
    for (const side of [-1, 1]) {
      const p = at(s, side * PYLON_OFFSET, 0);
      const q = axis(s);
      const yaw = Math.atan2(q.ux, q.uz);
      const base = Math.max(WATER, groundHeight(p.x, p.z)) - 1;
      const H = PYLON_HEIGHT, W = PYLON_BASE[0], D = PYLON_BASE[1];
      const sections = [
        [base, H - 34, 1, 0.9], [H - 34, H - 32.8, 0.95, 0.95], [H - 32.8, H - 12, 0.86, 0.76],
        [H - 12, H - 10.8, 0.82, 0.82], [H - 10.8, H - 3, 0.72, 0.64], [H - 3, H - 2, 0.7, 0.7], [H - 2, H, 0.58, 0.5]
      ];
      const parts = sections.map(([y0, y1, a, b]) => frustum(W * a, D * a, W * b, D * b, y0, y1));
      const mesh = new THREE.Mesh(mergeGeometries(parts, false), granite);
      mesh.position.set(p.x, 0, p.z);
      mesh.rotation.y = yaw;
      mesh.castShadow = mesh.receiveShadow = true;
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
        const off = side * (DECK_WIDTH / 2 + 0.2);
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
