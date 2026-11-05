import * as THREE from 'three/webgpu';
import { abs, color, float, floor, fract, max, mix, mod, normalWorld, positionWorld, smoothstep } from 'three/tsl';
import { GroundCells, offsetLine } from './ground-geometry.js';
import { DECK_DEPTH, DECK_STRUCTURE, KIND, LINKS, STRUCTURES, TUNNEL_HEIGHT, edgeNeighbour, groundHeight, onGroundRoad, tunnelCovered } from './surfaces.js';
import { onDeckSpan } from './bridge.js';
import { cityUniforms } from './tsl-materials.js';
import { patternXZ } from './world-origin.js';

// Every road off the ground, drawn from its own heights (js/surfaces.js): bridges and viaducts as decks, tunnels as
// cuttings that close over into lit tubes. The Harbour Bridge's own deck is js/harbour-bridge.js; the ramps that join
// it are drawn here, up to its edge.

const STEP = 6; // m between stations
const BARRIER = { height: 0.9, width: 0.4 };
const SOLID_BELOW = 4.5; // m: lower than this over the ground a deck stands on a wall (an abutment, an embankment)
const PIER_EVERY = 26; // m

// Stations along a link: { x, z, y, s }, every STEP or less, heights from its profile
function stations(link) {
  const out = [];
  let s = 0;
  for (let i = 0; i + 1 < link.pts.length; i++) {
    const p = link.pts[i], q = link.pts[i + 1];
    const L = Math.hypot(q.x - p.x, q.z - p.z);
    const n = Math.max(1, Math.ceil(L / STEP));
    for (let k = 0; k < n; k++) out.push({ x: p.x + ((q.x - p.x) * k) / n, z: p.z + ((q.z - p.z) * k) / n, y: p.y + ((q.y - p.y) * k) / n, s: s + (L * k) / n });
    s += L;
  }
  const last = link.pts[link.pts.length - 1];
  out.push({ x: last.x, z: last.z, y: last.y, s });
  return out;
}

// A quad strip between two rows of points (each row one point per station), wound to face `up` (or outward)
function strip(cells, c, rowA, rowB, normalOf, flip = false) {
  let prev = -1;
  for (let i = 0; i < rowA.length; i++) {
    const n = normalOf(i);
    const a = cells.vertex(c, rowA[i].x, rowA[i].y, rowA[i].z, n.x, n.y, n.z);
    cells.vertex(c, rowB[i].x, rowB[i].y, rowB[i].z, n.x, n.y, n.z);
    if (prev >= 0) {
      if (flip) c.index.push(prev, prev + 1, a, prev + 1, a + 1, a);
      else c.index.push(prev, a, prev + 1, prev + 1, a, a + 1);
    }
    prev = a;
  }
}

// Runs of stations where `closed(i)` holds, as [first, last] index pairs, each long enough to draw
function runs(n, closed) {
  const out = [];
  let from = -1;
  for (let i = 0; i <= n; i++) {
    const c = i < n && closed(i);
    if (c && from < 0) from = i;
    if (!c && from >= 0) {
      if (i - 1 > from) out.push([from, i - 1]);
      from = -1;
    }
  }
  return out;
}
const slice = (row, [a, b]) => row.slice(a, b + 1);

// Each side's stations with another road beside them at this road's level (js/surfaces.js, edgeNeighbour()): there's no
// barrier or wall there, and the gap between the two is deck. One road does what's between the two: the one with the lower
// id, or this one if the other is on the ground. Where the other carries traffic the other way, that's a median barrier.
function openEdges(link, st, row, side, across) {
  return row.map((p, i) => {
    const n = across(i, side);
    const a = st[Math.max(0, i - 1)], b = st[Math.min(st.length - 1, i + 1)], L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const next = edgeNeighbour(link, p.x, p.z, n.x, n.z, st[i].y, (b.x - a.x) / L, (b.z - a.z) / L);
    if (!next) return null;
    const owns = !next.link.kind || link.id < next.link.id;
    return { gap: next.gap, fills: owns && next.gap > 0.05, median: owns && next.opposite, nx: n.x, nz: n.z };
  });
}
// A median barrier down the middle of the gap to a road carrying traffic the other way
const MEDIAN = { height: 0.9, width: 0.5 };
function medians(concrete, w, row, st, open, side) {
  for (const run of runs(row.length, (i) => open[i]?.median)) {
    const at = (k, out) => {
      const p = row[run[0] + k], o = open[run[0] + k], d = Math.max(MEDIAN.width / 2, o.gap / 2) + out;
      return { x: p.x + o.nx * d, z: p.z + o.nz * d };
    };
    const n = run[1] - run[0] + 1;
    const near = Array.from({ length: n }, (_, k) => at(k, -MEDIAN.width / 2)), far = Array.from({ length: n }, (_, k) => at(k, MEDIAN.width / 2));
    const y = (k) => st[run[0] + k].y;
    const base = (r) => r.map((p, k) => ({ ...p, y: y(k) - 0.05 })), top = (r) => r.map((p, k) => ({ ...p, y: y(k) + MEDIAN.height }));
    const out = (k) => ({ x: open[run[0] + k].nx, y: 0, z: open[run[0] + k].nz }), back = (k) => ({ x: -open[run[0] + k].nx, y: 0, z: -open[run[0] + k].nz });
    // Its top, the row further left first, and its two faces, each wound to face its own way
    strip(concrete, w, top(side > 0 ? far : near), top(side > 0 ? near : far), () => ({ x: 0, y: 1, z: 0 }));
    strip(concrete, w, base(near), top(near), back, side > 0);
    strip(concrete, w, base(far), top(far), out, side < 0);
  }
}
// The deck across a gap to the road beside, and its underside; a tunnel's ceiling over it where it's covered
function fillGaps(deck, concrete, c, w, row, st, open, side, covered = null) {
  for (const run of runs(row.length, (i) => open[i]?.fills)) {
    const edge = slice(row, run).map((p, k) => ({ x: p.x, z: p.z, y: st[run[0] + k].y }));
    const out = edge.map((p, k) => { const o = open[run[0] + k]; return { x: p.x + o.nx * (o.gap + 0.1), z: p.z + o.nz * (o.gap + 0.1), y: p.y }; });
    // The row further left first, as for the road, to face up
    const [a, b] = side > 0 ? [out, edge] : [edge, out];
    strip(deck, c, a, b, () => ({ x: 0, y: 1, z: 0 }));
    const under = (r) => r.map((p) => ({ ...p, y: p.y - DECK_DEPTH }));
    strip(concrete, w, under(b), under(a), () => ({ x: 0, y: -1, z: 0 }));
    if (covered) {
      const roofed = runs(run[1] - run[0] + 1, (k) => covered[run[0] + k]);
      for (const r of roofed) {
        const lift = (rw) => slice(rw, r).map((p) => ({ ...p, y: p.y + TUNNEL_HEIGHT }));
        strip(concrete, w, lift(b), lift(a), () => ({ x: 0, y: -1, z: 0 }));
      }
    }
  }
}

// Soffits and decks in concrete; the walls of viaducts, cuttings and tunnel approaches in sandstone blocks, as along the
// Bradfield Highway and through the Warringah Freeway's cuttings. One for all the tiles.
let concreteMat = null, lampMat = null;
function structureMaterials() {
  if (concreteMat) return;
  concreteMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  const courses = positionWorld.y.div(0.75);
  const blocks = patternXZ.x.add(patternXZ.y).div(1.6).add(mod(floor(courses), 2).mul(0.5));
  const joints = max(smoothstep(0.43, 0.5, abs(fract(courses).sub(0.5))), smoothstep(0.46, 0.5, abs(fract(blocks).sub(0.5))));
  const wall = float(1).sub(smoothstep(0.3, 0.6, abs(normalWorld.y)));
  concreteMat.colorNode = mix(color(0x8b8a84), mix(color(0xa8946f), color(0x7a6a4e), joints.mul(0.8)), wall);
  // Strip lights along the tunnel ceilings, brighter after dark like the street lights
  lampMat = new THREE.MeshStandardNodeMaterial({ color: 0x222222, roughness: 0.6 });
  lampMat.emissiveNode = color(0xfff1d0).mul(smoothstep(0.0, 1.0, cityUniforms.uInteriorGlow).mul(1.5).add(1.2));
}

// `links`: the structure links to build. `touching`: every link near them, for the joints between them; `wanted` says which
// joints are this call's to build.
function* buildStructures(group, roadMat, links = LINKS, touching = links, wanted = () => true) {
  structureMaterials();
  const deck = new GroundCells(1e6); // road surfaces
  const concrete = new GroundCells(1e6); // barriers, walls, soffits, tunnel linings
  const piers = [];
  const lights = [];
  const colliders = [];
  const deckSid = DECK_STRUCTURE;

  for (const link of links) {
    if (!link.kind || link.deck) continue;
    yield;
    let st = stations(link);
    // A ramp joining the Harbour Bridge stops just inside its edge: the bridge's own deck carries on from there
    if (link.sid === deckSid) st = st.filter((p, i) => !onDeckSpan(p.x, p.z) || (st[i - 1] && !onDeckSpan(st[i - 1].x, st[i - 1].z)) || (st[i + 1] && !onDeckSpan(st[i + 1].x, st[i + 1].z)));
    if (st.length < 2) continue;
    const half = link.half;
    const left = offsetLine(st, half), right = offsetLine(st, -half);
    for (const [k, row] of [left, right].entries()) row.forEach((p, i) => { p.y = st[i].y; p.side = k ? -1 : 1; });
    const ground = (p) => groundHeight(p.x, p.z);
    const c = deck.cell(st[0].x, st[0].z), w = concrete.cell(st[0].x, st[0].z);
    const up = () => ({ x: 0, y: 1, z: 0 });
    const across = (i, side) => {
      const a = st[Math.max(0, i - 1)], b = st[Math.min(st.length - 1, i + 1)];
      const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      return { x: (-(b.z - a.z) / L) * side, y: 0, z: ((b.x - a.x) / L) * side };
    };

    if (link.kind === KIND.BRIDGE) {
      // The road surface
      strip(deck, c, left, right, up);
      // Each side: a barrier where it's high enough to fall from, and below the deck either a wall down to the ground or
      // the deck's edge over open air. Not where another road carries on beside it at its level: there the two are one deck.
      for (const [side, row] of [[1, left], [-1, right]]) {
        const open = openEdges(link, st, row, side, across);
        fillGaps(deck, concrete, c, w, row, st, open, side);
        medians(concrete, w, row, st, open, side);
        const raised = row.map((p, i) => p.y - ground(p) > 1 ? 1 : 0).map((v, i, all) => v || all[i - 1] || all[i + 1] ? 1 : 0);
        const top = row.map((p, i) => ({ x: p.x, z: p.z, y: p.y + (raised[i] ? BARRIER.height : 0.05) }));
        const inner = offsetLine(st, (half - BARRIER.width) * side).map((p, i) => ({ x: p.x, z: p.z, y: top[i].y }));
        const foot = row.map((p, i) => ({ x: p.x, z: p.z, y: p.y - ground(p) < SOLID_BELOW ? ground(p) - 0.3 : p.y - DECK_DEPTH }));
        const innerBase = inner.map((p, i) => ({ x: p.x, z: p.z, y: st[i].y }));
        // Barrier top (the row further out on the +n side first, as for the road), its face to the road, and the outer
        // face down to the wall's foot. A vertical strip from foot to top faces +n unflipped.
        for (const run of runs(row.length, (i) => !open[i])) {
          const n0 = run[0];
          const out = (i) => across(n0 + i, side), back = (i) => across(n0 + i, -side);
          strip(concrete, w, slice(side > 0 ? top : inner, run), slice(side > 0 ? inner : top, run), up);
          strip(concrete, w, slice(innerBase, run), slice(inner, run), back, side > 0);
          strip(concrete, w, slice(foot, run), slice(top, run), out, side < 0);
        }
      }
      // The underside, facing down, where there is air under it
      const soffitL = left.map((p) => ({ x: p.x, z: p.z, y: p.y - DECK_DEPTH }));
      const soffitR = right.map((p) => ({ x: p.x, z: p.z, y: p.y - DECK_DEPTH }));
      strip(concrete, w, soffitR, soffitL, () => ({ x: 0, y: -1, z: 0 }));
      // Piers under the middle, wherever it stands high, kept off the streets beneath
      for (let s0 = PIER_EVERY / 2; s0 < st[st.length - 1].s; s0 += PIER_EVERY) {
        const at = [0, 4, -4, 8, -8].map((d) => s0 + d).map((s) => st.reduce((best, p) => (Math.abs(p.s - s) < Math.abs(best.s - s) ? p : best), st[0]))
          .find((p) => p.y - ground(p) > SOLID_BELOW && !onGroundRoad(p.x, p.z) && ![2, -2].some((d) => onGroundRoad(p.x + d, p.z + d)));
        if (!at) continue;
        const g = ground(at);
        const r = half > 7 ? 1.3 : 0.9;
        piers.push([at.x, g - 0.5, at.z, at.y - DECK_DEPTH, r]);
        colliders.push({ minX: at.x - r, maxX: at.x + r, minZ: at.z - r, maxZ: at.z + r, minY: 0, maxY: at.y - DECK_DEPTH - g });
      }
    } else {
      // A tunnel: open to the sky while it's shallow (the ground is lowered over it, js/surfaces.js), a tube once the
      // ground closes over it
      const covered = st.map((p) => tunnelCovered(link, p.s));
      // The road surface, all the way
      strip(deck, c, left, right, up);
      for (const [side, row] of [[1, left], [-1, right]]) {
        // Walls: up to the ceiling in the tube, up to the ground above in the cutting. None where another road runs beside
        // it at its level, as where a ramp joins in a cutting or two tunnels' roads merge underground.
        const open = openEdges(link, st, row, side, across);
        fillGaps(deck, concrete, c, w, row, st, open, side, covered);
        medians(concrete, w, row, st, open, side);
        const wallTop = row.map((p, i) => ({ x: p.x, z: p.z, y: covered[i] ? p.y + TUNNEL_HEIGHT : Math.max(p.y + 1, groundHeight(p.x + across(i, side).x * 1.5, p.z + across(i, side).z * 1.5)) }));
        const wallFoot = row.map((p) => ({ x: p.x, z: p.z, y: p.y - 0.2 }));
        for (const run of runs(row.length, (i) => !open[i])) strip(concrete, w, slice(wallFoot, run), slice(wallTop, run), (i) => across(run[0] + i, -side), side > 0);
      }
      // The ceiling and its lights, where it's covered
      let run = [];
      const flushCeiling = () => {
        if (run.length > 1) {
          const cl = run.map((i) => ({ x: left[i].x, z: left[i].z, y: st[i].y + TUNNEL_HEIGHT }));
          const cr = run.map((i) => ({ x: right[i].x, z: right[i].z, y: st[i].y + TUNNEL_HEIGHT }));
          strip(concrete, w, cr, cl, () => ({ x: 0, y: -1, z: 0 }));
        }
        run = [];
      };
      st.forEach((p, i) => {
        if (covered[i]) {
          run.push(i);
          if (i % 2 === 0) lights.push([p.x, p.y + TUNNEL_HEIGHT - 0.1, p.z, Math.atan2(st[Math.min(i + 1, st.length - 1)].x - p.x, st[Math.min(i + 1, st.length - 1)].z - p.z)]);
        } else flushCeiling();
      });
      flushCeiling();
      // Portals: where the cutting closes over, a face from the ceiling up to the ground above
      for (let i = 1; i < st.length; i++) {
        if (covered[i] === covered[i - 1]) continue;
        const k = covered[i] ? i : i - 1;
        const g = ground(st[k]) + 0.4;
        const pl = left[k], pr = right[k];
        const n = across(k, 1);
        const face = [
          { x: pl.x + n.x * 1.5, z: pl.z + n.z * 1.5, y: st[k].y + TUNNEL_HEIGHT },
          { x: pr.x - n.x * 1.5, z: pr.z - n.z * 1.5, y: st[k].y + TUNNEL_HEIGHT }
        ];
        const topRow = face.map((p) => ({ ...p, y: Math.max(p.y + 0.5, g) }));
        // Facing out of the tunnel, towards the cutting
        const dir = Math.sign((st[i].s - st[i - 1].s) * (covered[i] ? 1 : -1));
        const fwd = (() => { const a = st[k], b = st[Math.min(st.length - 1, k + 1)], L = Math.hypot(b.x - a.x, b.z - a.z) || 1; return { x: ((b.x - a.x) / L) * -dir, y: 0, z: ((b.z - a.z) / L) * -dir }; })();
        strip(concrete, w, face, topRow, () => fwd, dir > 0);
      }
    }
  }

  // Joints between structure links: a disc at the node's height, so two decks meeting at an angle leave no gap
  {
    const ends = new Map();
    for (const link of touching) {
      if (!link.kind || link.deck) continue;
      for (const [n, p] of [[link.a, link.pts[0]], [link.b, link.pts[link.pts.length - 1]]]) {
        const e = ends.get(n) || { x: p.x, z: p.z, y: p.y, r: 0, count: 0, kind: link.kind };
        e.r = Math.max(e.r, link.half);
        e.count++;
        ends.set(n, e);
      }
    }
    for (const e of ends.values()) {
      if (e.count < 2 || e.kind !== KIND.BRIDGE || !wanted(e.x, e.z)) continue;
      const c = deck.cell(e.x, e.z);
      const centre = deck.vertex(c, e.x, e.y, e.z, 0, 1, 0);
      const R = 16;
      for (let k = 0; k < R; k++) {
        const a = (k / R) * Math.PI * 2;
        deck.vertex(c, e.x + Math.cos(a) * e.r, e.y, e.z + Math.sin(a) * e.r, 0, 1, 0);
      }
      for (let k = 0; k < R; k++) c.index.push(centre, centre + 1 + ((k + 1) % R), centre + 1 + k);
    }
  }
  yield;

  const build = (cells, material, cast) => {
    for (const c of cells.cells.values()) {
      if (!c.index.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(c.position, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(c.normal, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(c.uv, 2));
      g.setIndex(c.index);
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, material);
      mesh.receiveShadow = true;
      mesh.castShadow = cast;
      mesh.userData.lifted = true;
      group.add(mesh);
    }
  };
  build(deck, roadMat, false);
  build(concrete, concreteMat, true);
  if (piers.length) {
    const inst = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 10).translate(0, 0.5, 0), concreteMat, piers.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    piers.forEach(([x, y0, z, top, r], i) => inst.setMatrixAt(i, m.compose(new THREE.Vector3(x, y0, z), q, new THREE.Vector3(r, top - y0, r))));
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    inst.castShadow = true;
    inst.userData.lifted = true;
    group.add(inst);
  }
  if (lights.length) {
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.12, 2.4), lampMat, lights.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    lights.forEach(([x, y, z, h], i) => inst.setMatrixAt(i, m.compose(new THREE.Vector3(x, y, z), q.setFromAxisAngle(up, h), new THREE.Vector3(1, 1, 1))));
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    inst.userData.lifted = true;
    group.add(inst);
  }
  return { colliders, count: STRUCTURES.length - 1 };
}

export { buildStructures };
