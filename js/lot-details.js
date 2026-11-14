import * as THREE from 'three/webgpu';
import { blockAt } from './city-config.js';
import { groundHeight, groundRoadAt, linkById, roadHeight } from './surfaces.js';
import { streetFront, tileStreets } from './street-front.js';
import { lawnSurface, pavingSurface } from './garden.js';
import { MODEL_SITES, toWorldOf } from './model-sites.js';
import { TILE, heldTiles, isHeld, tileExists, tileKey } from './geodata.js';
import { MARGIN, squareLots } from './house-lots.js';
import { createConcreteMaterial, createFenceMaterial } from './tsl-materials.js';
import { anchorToOrigin, onOriginMove, origin } from './world-origin.js';
import { activity, runToEnd } from './world-jobs.js';

// The houses' lots near you (js/house-lots.js): their fences and driveways, drawn within the graphics level's houseDetail of you
// (js/quality.js), nearest first, once the city round you is complete; and the fences' colliders, which hold the walker and nothing else
// (js/controllers.js addWalkerColliders()).
// - The map is worked out in SQUARE m squares, one at a time, as the world's jobs have time (js/main.js), each once every tile within
//   MARGIN of it is built, and kept while those tiles are.
// - What's drawn is two instanced meshes: every fence panel, and every slab of concrete (driveways, crossovers, laybacks). They're
//   refilled from the squares held when you've moved REFILL m, nearest first, as many as the level has room for.

const SQUARE = 500; // m: two to a tile's side
const REFILL = 15; // m moved before what's drawn is chosen again
const HOLD = 120; // m round you that fences hold the walker
const KEEP = 300; // m past houseDetail that a square's lots are kept
// Instances each level has room for: a panel is 2 triangles, a slab 10; fences cast shadows on medium and high
const ROOM = { low: { panels: 1600, slabs: 700 }, medium: { panels: 4500, slabs: 1800 }, high: { panels: 6500, slabs: 2600 } };
const THICK = [0.12, 0.12, 0.34]; // m of concrete under a slab's top: driveway, crossover, layback
// The inner city, where the map paves the kerb islands right through and there's no lawn to keep a fence on (tools/geodata/region-worker.mjs
// PAVED_AREA)
const PAVED_AREA = { x0: -2100, x1: 2700, z0: -4500, z1: 2100 };
const PAVED_RING = Array.from({ length: 12 }, (_, k) => [Math.cos((k * Math.PI) / 6) * 3.6, Math.sin((k * Math.PI) / 6) * 3.6]);

// A fence panel: a quad from (-0.5, 0) to (0.5, 1), facing +z
function panelGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  return g;
}

// A slab: a box from (-0.5, -1, -0.5) to (0.5, 0, 0.5) with no bottom, its top at y = 0
function slabGeometry() {
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, -0.5, 0);
  const index = box.index.array;
  const keep = [];
  // BoxGeometry's groups: +x, -x, +y, -y, +z, -z, 6 indices each; leave out -y
  for (let i = 0; i < index.length; i++) if (Math.floor(i / 6) !== 3) keep.push(index[i]);
  box.setIndex(keep);
  box.clearGroups();
  return box;
}

function inRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** The model sites near (x, z), as js/house-lots.js wants them: each one's outline, a rectangle round each of its rings 3 m out, and its cut */
function sitesNear(x, z, r) {
  const out = [];
  for (const s of MODEL_SITES) {
    if (s.debug || Math.hypot(s.x - x, s.z - z) > r + 200) continue;
    const rings = [];
    for (const [, ring] of s.outline || []) {
      const xs = ring.map((p) => p[0]), zs = ring.map((p) => p[1]);
      const x0 = Math.min(...xs) - 3, x1 = Math.max(...xs) + 3, z0 = Math.min(...zs) - 3, z1 = Math.max(...zs) + 3;
      rings.push([[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([px, pz]) => toWorldOf(s, px, pz)));
    }
    if (s.cut) rings.push(s.cut.poly.map(([px, pz]) => toWorldOf(s, px, pz)));
    if (rings.length) out.push({ rings });
  }
  return out;
}

const squareWorkNow = (square, tiles) => runToEnd(squareWork(square, tiles));

/** The tiles a square's lots need: every tile within MARGIN of it */
function tilesFor(square) {
  const keys = [];
  for (let ix = Math.floor((square.x0 - MARGIN) / TILE); ix <= Math.floor((square.x1 + MARGIN) / TILE); ix++) {
    for (let iz = Math.floor((square.z0 - MARGIN) / TILE); iz <= Math.floor((square.z1 + MARGIN) / TILE); iz++) {
      const key = tileKey(ix, iz);
      if (tileExists(key)) keys.push(key);
    }
  }
  return keys;
}

/**
 * What js/house-lots.js squareLots() needs for a square, from the tiles held: its buildings and the world round them, { entries, env }.
 * `tiles`: the held tiles, by key. In steps; squareWorkNow() all at once.
 */
function* squareWork(square, tiles) {
  const x0 = square.x0 - MARGIN, x1 = square.x1 + MARGIN, z0 = square.z0 - MARGIN, z1 = square.z1 + MARGIN;
  const entries = [];
  const links = new Set();
  const lawns = [];
  for (const key of tilesFor(square)) {
    const tile = tiles.get(key);
    if (!tile) continue;
    lawns.push(...(tile.placedLawns || []));
    for (const b of tile.buildings) if (b.cx >= x0 && b.cx < x1 && b.cz >= z0 && b.cz < z1) entries.push({ b, tile });
    yield;
    for (const r of tile.links) {
      const l = linkById.get(r[0]);
      if (l && !l.kind && !l.deck) links.add(l);
    }
  }
  // The roads on the ground, in cells, for each one's nearest point
  const CELL = 32, cells = new Map();
  for (const link of links) {
    for (let i = 1; i < link.pts.length; i++) {
      const p = link.pts[i - 1], q = link.pts[i];
      const L = Math.hypot(q.x - p.x, q.z - p.z);
      if (L < 0.01) continue;
      const seg = { link, x: p.x, z: p.z, ux: (q.x - p.x) / L, uz: (q.z - p.z) / L, L };
      for (let ix = Math.floor(Math.min(p.x, q.x) / CELL); ix <= Math.floor(Math.max(p.x, q.x) / CELL); ix++) {
        for (let iz = Math.floor(Math.min(p.z, q.z) / CELL); iz <= Math.floor(Math.max(p.z, q.z) / CELL); iz++) {
          const k = ix * 100000 + iz;
          (cells.get(k) || cells.set(k, []).get(k)).push(seg);
        }
      }
    }
  }
  const roadsNear = (x, z, r) => {
    const best = new Map();
    for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) {
      for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
        for (const seg of cells.get(ix * 100000 + iz) || []) {
          const t = Math.max(0, Math.min(seg.L, (x - seg.x) * seg.ux + (z - seg.z) * seg.uz));
          const px = seg.x + seg.ux * t, pz = seg.z + seg.uz * t, d = Math.hypot(px - x, pz - z);
          const was = best.get(seg.link);
          if (d <= r && (!was || d < was.d)) best.set(seg.link, { link: seg.link, x: px, z: pz, d });
        }
      }
    }
    return [...best.values()];
  };
  yield;
  const home = tiles.get(tileKey(Math.floor((square.x0 + square.x1) / 2 / TILE), Math.floor((square.z0 + square.z1) / 2 / TILE)))
    || { ix: Math.floor(square.x0 / TILE), iz: Math.floor(square.z0 / TILE) };
  const lawn = lawnSurface(home);
  yield;
  const paving = pavingSurface(home);
  yield;
  // Each lawn's and footpath's triangles are made the first time a height is asked of it (js/garden.js): for the ones in the square, where
  // its driveways lie, ahead of time, a few to a step
  for (const rings of [...lawns, ...tilesFor(square).flatMap((key) => tiles.get(key)?.placedPavements || [])]) {
    const p = rings[0][0];
    if (p.x < square.x0 - 20 || p.x > square.x1 + 20 || p.z < square.z0 - 20 || p.z > square.z1 + 20) continue;
    lawn(p.x, p.z);
    paving(p.x, p.z);
    yield;
  }
  // Whether a point's on a lawn as drawn, in cells; in the inner city, where the islands are paved right through, off the footpath
  const LCELL = 50, lawnCells = new Map();
  for (const rings of lawns) {
    let lx0 = Infinity, lx1 = -Infinity, lz0 = Infinity, lz1 = -Infinity;
    for (const p of rings[0]) { lx0 = Math.min(lx0, p.x); lx1 = Math.max(lx1, p.x); lz0 = Math.min(lz0, p.z); lz1 = Math.max(lz1, p.z); }
    for (let ix = Math.floor(lx0 / LCELL); ix <= Math.floor(lx1 / LCELL); ix++) {
      for (let iz = Math.floor(lz0 / LCELL); iz <= Math.floor(lz1 / LCELL); iz++) {
        const k = ix * 100000 + iz;
        (lawnCells.get(k) || lawnCells.set(k, []).get(k)).push(rings);
      }
    }
  }
  const onLawn = (x, z) => {
    // In the inner city, the footpath is the 3.5 m of paving along the kerb: off it where the kerb is no nearer than that
    if (x >= PAVED_AREA.x0 && x <= PAVED_AREA.x1 && z >= PAVED_AREA.z0 && z <= PAVED_AREA.z1) {
      for (const [dx, dz] of PAVED_RING) if (!blockAt(x + dx, z + dz)) return false;
      return true;
    }
    return (lawnCells.get(Math.floor(x / LCELL) * 100000 + Math.floor(z / LCELL)) || [])
      .some((rings) => inRing(rings[0], x, z) && !rings.slice(1).some((h) => inRing(h, x, z)));
  };
  yield;
  const env = {
    streetOf: (w) => {
      const found = streetFront(tileStreets(w.tile), w.cx, w.cz);
      return found && { x: found.x, z: found.z, ux: found.ux, uz: found.uz, link: found.link };
    },
    roadsNear,
    // Where the kerb island that (tx, tz) is on starts, along a ray from a road's middle line, past any median: to 0.25 m, then to 2 cm
    kerbFrom: (x, z, nx, nz, most, tx, tz) => {
      const island = blockAt(tx, tz);
      const on = (s) => {
        const b = blockAt(x + nx * s, z + nz * s);
        return island ? b === island : !!b;
      };
      for (let s = 0.25; s <= most; s += 0.25) {
        if (!on(s)) continue;
        let lo = s - 0.25, hi = s;
        while (hi - lo > 0.02) {
          const m = (lo + hi) / 2;
          if (on(m)) hi = m; else lo = m;
        }
        return hi;
      }
      return null;
    },
    groundAt: groundHeight,
    onLawn,
    lawnAt: lawn,
    pavingAt: paving,
    roadAt: (x, z) => {
      const road = groundRoadAt(x, z);
      return road ? roadHeight(road, x, z) : groundHeight(x, z);
    },
    sites: sitesNear((square.x0 + square.x1) / 2, (square.z0 + square.z1) / 2, SQUARE + MARGIN)
  };
  return { entries, env };
}

/**
 * The lots near you. `level`: the graphics level's name; `reach()`: m round you they're drawn (houseDetail); `built(key)`: whether that
 * tile is built; `walker`: { add(list), remove(list) } for the fences' colliders; `shadows`: whether they cast them.
 */
function createLotDetails({ level = 'high', reach = () => 260, built = () => false, walker = null, shadows = true } = {}) {
  const room = ROOM[level] || ROOM.high;
  const group = new THREE.Group();
  group.name = 'HouseLots';

  const fenceData = new THREE.InstancedBufferAttribute(new Float32Array(room.panels * 4), 4);
  fenceData.setUsage(THREE.DynamicDrawUsage);
  const panelGeo = panelGeometry();
  panelGeo.setAttribute('fence', fenceData);
  const fences = new THREE.InstancedMesh(panelGeo, createFenceMaterial(), room.panels);
  fences.name = 'LotFences';
  fences.castShadow = shadows;
  fences.receiveShadow = true;
  fences.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const slabs = new THREE.InstancedMesh(slabGeometry(), createConcreteMaterial(), room.slabs);
  slabs.name = 'LotSlabs';
  slabs.receiveShadow = true;
  slabs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  slabs.setColorAt(0, new THREE.Color(1, 1, 1));
  slabs.instanceColor.setUsage(THREE.DynamicDrawUsage);
  for (const mesh of [fences, slabs]) {
    mesh.userData.lifted = true; // written on the ground already
    mesh.count = 0;
    group.add(mesh);
  }

  const squares = new Map(); // key -> { square, keys (the tiles it needs), result (squareLots()) }
  let filledAt = null, changed = true, originMoved = false;
  let held = new Set(); // the colliders handed to the walker
  onOriginMove(() => { originMoved = true; });

  const heldByKey = () => new Map(heldTiles().map((t) => [t.key, t]));
  const squareKey = (ix, iz) => ix * 100000 + iz;

  /** One step of work, if there's any near (x, z): a square's lots, or what's drawn chosen again. Whether it did something. */
  function* work(x, z) {
    const r = reach();
    // Squares no longer wanted, or whose tiles have gone
    for (const [key, entry] of squares) {
      const far = Math.max(entry.square.x0 - x, x - entry.square.x1, entry.square.z0 - z, z - entry.square.z1) > r + KEEP;
      if (far || !entry.keys.every((k) => isHeld(k))) {
        squares.delete(key);
        changed = true;
      }
    }
    // A square near you that's ready, nearest first
    let next = null;
    for (let ix = Math.floor((x - r) / SQUARE); ix <= Math.floor((x + r) / SQUARE); ix++) {
      for (let iz = Math.floor((z - r) / SQUARE); iz <= Math.floor((z + r) / SQUARE); iz++) {
        const key = squareKey(ix, iz);
        if (squares.has(key)) continue;
        const square = { x0: ix * SQUARE, z0: iz * SQUARE, x1: (ix + 1) * SQUARE, z1: (iz + 1) * SQUARE };
        const d = Math.hypot(Math.max(square.x0 - x, 0, x - square.x1), Math.max(square.z0 - z, 0, z - square.z1));
        if (d > r) continue;
        const keys = tilesFor(square);
        if (!keys.every((k) => built(k))) continue;
        if (!next || d < next.d) next = { key, square, keys, d };
      }
    }
    if (next) {
      activity.label = 'houses\' lots';
      const { entries, env } = yield* squareWork(next.square, heldByKey());
      const result = yield* squareLots(entries, env, next.square);
      // Let go of while it was worked out
      if (next.keys.every((k) => isHeld(k))) squares.set(next.key, { square: next.square, keys: next.keys, result });
      changed = true;
      return true;
    }
    if (changed || originMoved || !filledAt || Math.hypot(x - filledAt.x, z - filledAt.z) > REFILL) {
      activity.label = 'houses\' fences';
      fill(x, z, r);
      if (lines) debugLines(true);
      return true;
    }
    return false;
  }

  const m = new THREE.Matrix4();
  // What's drawn, from the squares held: the nearest of each kind, as many as there's room for
  function fill(x, z, r) {
    filledAt = { x, z };
    changed = false;
    originMoved = false;
    const panels = [], concrete = [], pieces = [];
    for (const { result } of squares.values()) {
      for (const p of result.panels) {
        const d = Math.hypot(p.x - x, p.z - z);
        if (d <= r) panels.push([d, p]);
      }
      for (const s of result.slabs) {
        const d = Math.hypot(s.x - x, s.z - z);
        if (d <= r) concrete.push([d, s]);
      }
      for (const f of result.fences) {
        const d = Math.hypot((f.a.x + f.b.x) / 2 - x, (f.a.z + f.b.z) / 2 - z);
        if (d <= HOLD) pieces.push(f);
      }
    }
    panels.sort((a, b) => a[0] - b[0]);
    concrete.sort((a, b) => a[0] - b[0]);
    const np = Math.min(panels.length, room.panels), ns = Math.min(concrete.length, room.slabs);
    const data = fenceData.array;
    for (let i = 0; i < np; i++) {
      const p = panels[i][1];
      // Along the fence, up, and out of it
      m.set(p.ux * p.length, 0, -p.uz, p.x - origin.x, 0, p.height, 0, p.y, p.uz * p.length, 0, p.ux, p.z - origin.z, 0, 0, 0, 1);
      fences.setMatrixAt(i, m);
      data[i * 4] = p.length;
      data[i * 4 + 1] = p.height;
      data[i * 4 + 2] = p.kind;
      data[i * 4 + 3] = p.colour + Math.min(p.roll, 0.999);
    }
    const tint = new THREE.Color();
    for (let i = 0; i < ns; i++) {
      const s = concrete[i][1];
      const t = THICK[s.kind];
      // The across vector the way that keeps the box the right way out
      const flip = s.ax * s.bz - s.az * s.bx > 0 ? 1 : -1;
      m.set(s.ax, 0, s.bx * flip, s.x - origin.x, s.ay, t, s.by * flip, s.y, s.az, 0, s.bz * flip, s.z - origin.z, 0, 0, 0, 1);
      slabs.setMatrixAt(i, m);
      const shade = s.kind === 2 ? s.tint * 0.96 : s.tint;
      slabs.setColorAt(i, tint.setRGB(shade, shade, shade * 0.98));
    }
    fences.count = np;
    slabs.count = ns;
    for (const [mesh, n] of [[fences, np], [slabs, ns]]) {
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, Math.max(1, n) * 16);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.boundingSphere = null;
      if (n) mesh.computeBoundingSphere();
    }
    fenceData.clearUpdateRanges();
    fenceData.addUpdateRange(0, Math.max(1, np) * 4);
    fenceData.needsUpdate = true;
    if (slabs.instanceColor) {
      slabs.instanceColor.clearUpdateRanges();
      slabs.instanceColor.addUpdateRange(0, Math.max(1, ns) * 3);
      slabs.instanceColor.needsUpdate = true;
    }
    // The walker's colliders: the fences near, each piece a thin box from the ground to the fence's top
    const wanted = new Set(pieces.map(colliderOf));
    if (walker) {
      const gone = [...held].filter((c) => !wanted.has(c)), come = [...wanted].filter((c) => !held.has(c));
      walker.remove(gone);
      walker.add(come);
    }
    held = wanted;
  }

  const colliders = new WeakMap();
  function colliderOf(f) {
    let c = colliders.get(f);
    if (c) return c;
    const L = Math.hypot(f.b.x - f.a.x, f.b.z - f.a.z), ux = (f.b.x - f.a.x) / L, uz = (f.b.z - f.a.z) / L;
    const cx = (f.a.x + f.b.x) / 2, cz = (f.a.z + f.b.z) / 2, hz = 0.05;
    const ex = Math.abs(ux) * L / 2 + Math.abs(uz) * hz, ez = Math.abs(uz) * L / 2 + Math.abs(ux) * hz;
    c = { minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez, minY: 0, maxY: 1.8, fence: true,
      obb: { cx, cz, cs: ux, sn: -uz, hx: L / 2, hz } };
    colliders.set(f, c);
    return c;
  }

  /** For the debug view and the scripts: what's worked out and what's drawn */
  function state(x = filledAt?.x ?? 0, z = filledAt?.z ?? 0, r = reach()) {
    const lots = [], fenceList = [], drives = [];
    for (const { result } of squares.values()) {
      for (const lot of result.lots) {
        if (Math.hypot(lot.home.cx - x, lot.home.cz - z) > r) continue;
        lots.push(lot);
        if (lot.drive) drives.push(lot);
      }
      for (const f of result.fences) if (Math.hypot((f.a.x + f.b.x) / 2 - x, (f.a.z + f.b.z) / 2 - z) <= r) fenceList.push(f);
    }
    return { squares: squares.size, lots, fences: fenceList, drives, panels: fences.count, slabs: slabs.count, colliders: held.size };
  }

  /** Hidden or shown, at once (for measuring what they cost) */
  function setShown(on) {
    fences.visible = slabs.visible = !!on;
  }

  /** Lets go of everything: the colliders back from the walker */
  function clear() {
    squares.clear();
    if (walker) walker.remove([...held]);
    held = new Set();
    fences.count = slabs.count = 0;
    changed = true;
  }

  // The debug view: each lot's outline over the ground, its front cyan and the rest yellow; the fences red, the driveways white
  let lines = null;
  function debugLines(on) {
    if (lines) {
      group.remove(lines);
      lines.geometry.dispose();
      lines = null;
    }
    if (!on || !filledAt) return;
    const positions = [], colors = [];
    const add = (a, b, c) => {
      for (const p of [a, b]) positions.push(p.x - origin.x, groundHeight(p.x, p.z) + 0.6, p.z - origin.z);
      colors.push(...c, ...c);
    };
    const { lots, fences: list } = state();
    for (const lot of lots) {
      for (let i = 0; i < lot.pts.length; i++) add(lot.pts[i], lot.pts[(i + 1) % lot.pts.length], lot.pts[i].tag === 'front' ? [0, 1, 1] : [1, 1, 0]);
      const d = lot.drive, f = lot.frame;
      if (!d) continue;
      const at = (a, dd) => ({ x: f.px + f.tx * a + f.nx * dd, z: f.pz + f.tz * a + f.nz * dd });
      add(at(d.a, lot.kerb), at(d.a, d.d1), [1, 1, 1]);
    }
    for (const f of list) add(f.a, f.b, [1, 0.1, 0.1]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    lines = new THREE.LineSegments(geometry, new THREE.LineBasicNodeMaterial({ vertexColors: true, depthTest: false }));
    lines.renderOrder = 10;
    lines.frustumCulled = false;
    lines.userData.lifted = true;
    group.add(lines);
  }

  // Positions are written from the origin, as js/buildings.js writes its pools
  const anchor = () => anchorToOrigin(group);
  return { group, anchor, work, state, setShown, clear, debugLines, squares };
}

export { HOLD, REFILL, SQUARE, createLotDetails, squareWork, squareWorkNow, tilesFor };
