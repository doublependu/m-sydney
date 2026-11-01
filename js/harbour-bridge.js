import * as THREE from 'three/webgpu';
import { color, smoothstep } from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';
import { BRIDGE_LENGTH, BRIDGE_SPAN, DECK_SID, HALF_WIDTH, bridgeAt, bridgePoint, deckHeight } from './bridge.js';
import { GEO } from './geodata.js';
import { LINKS, groundHeight } from './surfaces.js';

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

// The streets under the bridge, as segments with half widths, so nothing built for the bridge stands on one
const streets = [];
{
  const RG = GEO.roadGraph, N = RG.nodes;
  for (const [a, b, , width, , , inner, , deck] of RG.links) {
    if (deck) continue;
    const pts = [[N[a * 2], N[a * 2 + 1]]];
    for (let k = 0; k < inner.length; k += 2) pts.push([inner[k], inner[k + 1]]);
    pts.push([N[b * 2], N[b * 2 + 1]]);
    for (let i = 1; i < pts.length; i++) streets.push({ ax: pts[i - 1][0], az: pts[i - 1][1], bx: pts[i][0], bz: pts[i][1], half: width / 2 });
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

const steel = new THREE.MeshStandardNodeMaterial({ color: 0x70767c, roughness: 0.62, metalness: 0.55 });
// The arch and pylons are lit after dark
steel.emissiveNode = color(0x8fa8c8).mul(smoothstep(0.55, 1.2, cityUniforms.uInteriorGlow).mul(0.3));
const granite = new THREE.MeshStandardNodeMaterial({ color: 0xa79a86, roughness: 0.9 });
granite.emissiveNode = color(0xffe2b8).mul(smoothstep(0.55, 1.2, cityUniforms.uInteriorGlow).mul(0.32));
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
  for (const l of LINKS) {
    if (l.deck || !l.kind || l.sid !== DECK_SID) continue;
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

function buildHarbourBridge(group) {
  const bridge = new THREE.Group();
  bridge.name = 'HarbourBridge';
  bridge.userData.lifted = true;
  const struts = [];
  const strut = (a, b, w = 1.6, d = 1.6) => struts.push(strutMatrix(a, b, w, d));
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
      if (lower(t0) > y + 2) strut(at(s0, side, y), at(s0, side, lower(t0)), 0.7, 0.7);
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
  const barrierMat = new THREE.MeshStandardNodeMaterial({ color: 0xb4b0a6, roughness: 0.85 });
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

  // The four granite pylons, where they were placed above
  for (const s of pylonPlaces) {
    for (const side of [-1, 1]) {
      const p = at(s, side * PYLON_OFFSET, 0);
      const q = axis(s);
      const yaw = Math.atan2(q.ux, q.uz);
      const base = Math.max(WATER, groundHeight(p.x, p.z)) - 1;
      const parts = [[PYLON_BASE[0], PYLON_BASE[1], base, PYLON_HEIGHT - 12], [12.5, 18, PYLON_HEIGHT - 12, PYLON_HEIGHT - 3], [10.5, 15.5, PYLON_HEIGHT - 3, PYLON_HEIGHT]];
      for (const [w, d, y0, y1] of parts) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, y1 - y0, d), granite);
        mesh.position.set(p.x, (y0 + y1) / 2, p.z);
        mesh.rotation.y = yaw;
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.userData.lifted = true;
        bridge.add(mesh);
      }
    }
  }
  group.add(bridge);
  return surface;
}

export { buildHarbourBridge, harbourBridgeColliders };
