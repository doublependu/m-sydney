import * as THREE from 'three/webgpu';
import { blockAt } from './city-config.js';
import { groundHeight, groundRoadAt, linkById, roadHeight } from './surfaces.js';
import { streetFront, tileStreets } from './street-front.js';
import { PATH_SURFACES, lawnSurface, pavingSurface } from './garden.js';
import { MODEL_SITES, cutsOf, toWorldOf } from './model-sites.js';
import { GEO, TILE, heldList, heldTiles, isHeld, tileExists, tileKey } from './geodata.js';
import { MARGIN, squareLots } from './house-lots.js';
import { houseEntry } from './house-entry.js';
import { lotThings } from './lot-things.js';
import { squareVerge, walkLine } from './verge.js';
import { createConcreteMaterial, createFenceMaterial, createLotThingMaterial, createParkLawnMaterial } from './tsl-materials.js';
import { outsideTunnelMouths } from './tunnel-mouths.js';
import { anchorToOrigin, onOriginMove, origin } from './world-origin.js';
import { activity, runToEnd } from './world-jobs.js';
import { dropLayers, setLayer } from './drawn-ground.js';

// The houses' lots near you (js/house-lots.js): their fences and driveways, drawn within the graphics level's houseDetail of you
// (js/quality.js), nearest first, once the city round you is complete; and the fences' colliders, which hold the walker and nothing else
// (js/controllers.js addWalkerColliders()).
// - The map is worked out in SQUARE m squares, one at a time, as the world's jobs have time (js/main.js), each once every tile within
//   MARGIN of it is built, and kept while those tiles are.
// - What's drawn is three instanced meshes: every fence panel (front fences' too), every slab of concrete (driveways, crossovers,
//   laybacks, paths), and every box of the lots' things (js/lot-things.js: carports, garages, brick walls, hedges, shrubs, letterboxes,
//   verandahs), the small ones only within the level's SMALL m; and the verges (js/verge.js), the nature strips' lawn and their
//   footpaths, as two meshes. They're refilled from the squares held when you've moved REFILL m, nearest first, as many as the level has
//   room for. The trees the verges add go to the street furniture's tree field (js/street-details.js), within houseDetail of you.

const SQUARE = 500; // m: two to a tile's side
const REFILL = 15; // m moved before what's drawn is chosen again
const HOLD = 120; // m round you that fences hold the walker
const FENCE_HOLD = 1.8; // m: a fence's collider, where it doesn't say
const KEEP = 300; // m past houseDetail that a square's lots are kept
// Instances each level has room for: a panel is 2 triangles, a slab 10; fences cast shadows on medium and high
const ROOM = { low: { panels: 1600, slabs: 900, things: 1200, lawn: 30000, path: 15000 },
  medium: { panels: 4500, slabs: 2200, things: 3000, lawn: 90000, path: 45000 },
  high: { panels: 6500, slabs: 3000, things: 4200, lawn: 140000, path: 70000 } }; // things are boxes of 12 triangles; lawn and path in vertices
const SMALL = { low: 50, medium: 70, high: 90 }; // m: the lots' small things (letterboxes, shrubs, posts) drawn within this of you
const THINGS = { low: 70, medium: 110, high: 130 }; // m: and the rest of them, and the paths to the doors
// The verges' trees planted, the nearest: each is most of a thousand triangles near, with its shadows
const TREES = { low: 6, medium: 12, high: 16 };
const THICK = [0.12, 0.12, 0.34]; // m of concrete under a slab's top: driveway, crossover, layback
const ADDRESS_REACH = 1.5; // m: a street address's point (in 0.5 m) is on its road within this
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
    for (const cut of cutsOf(s)) rings.push(cut.poly.map(([px, pz]) => toWorldOf(s, px, pz)));
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
  // The map's trees in the square's tiles, in cells, and which species its street trees are round a point
  const TCELL = 40, treeCells = new Map();
  for (const key of tilesFor(square)) {
    const t = tiles.get(key)?.trees;
    if (!t) continue;
    for (let i = 0; i < t.kinds.length; i++) {
      if (i % 4096 === 4095) yield;
      const x = t.points[i * 2], z = t.points[i * 2 + 1];
      if (x < x0 || x > x1 || z < z0 || z > z1) continue;
      // Flat, as x, z, species: there are tens of thousands
      const k = Math.floor(x / TCELL) * 100000 + Math.floor(z / TCELL);
      (treeCells.get(k) || treeCells.set(k, []).get(k)).push(x, z, t.kinds[i]);
    }
  }
  const treesNear = (x, z, r) => {
    const out = [];
    for (let ix = Math.floor((x - r) / TCELL); ix <= Math.floor((x + r) / TCELL); ix++) {
      for (let iz = Math.floor((z - r) / TCELL); iz <= Math.floor((z + r) / TCELL); iz++) {
        const c = treeCells.get(ix * 100000 + iz);
        if (!c) continue;
        for (let i = 0; i < c.length; i += 3) if (Math.hypot(c[i] - x, c[i + 1] - z) <= r) out.push({ x: c[i], z: c[i + 1], species: c[i + 2] });
      }
    }
    return out;
  };
  // The street trees' own six species (js/trees.js): the most common round a point, or a suburb's usual mix where there are none
  const STREET_MIX = [2, 2, 2, 5, 5, 0, 0, 1];
  const speciesAt = (x, z, roll) => {
    const count = new Map();
    for (const t of treesNear(x, z, 200)) if (t.species < 6) count.set(t.species, (count.get(t.species) || 0) + 1);
    const common = [...count].sort((p, q) => q[1] - p[1]);
    if (common.length && roll < 0.8) return common[0][0];
    return STREET_MIX[Math.floor(roll * STREET_MIX.length) % STREET_MIX.length];
  };
  const busStops = [];
  const stops = heldList('busShelters');
  for (let i = 0; i < stops.length; i += 2) if (stops[i] >= x0 && stops[i] <= x1 && stops[i + 1] >= z0 && stops[i + 1] <= z1) busStops.push({ x: stops[i], z: stops[i + 1] });
  // The road on the ground nearest (x, z) within r, and the way its segment runs there: { x, z, ux, uz, link }, or null
  const roadNear = (x, z, r) => {
    let best = null, bestD = r;
    for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) {
      for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
        for (const seg of cells.get(ix * 100000 + iz) || []) {
          const t = Math.max(0, Math.min(seg.L, (x - seg.x) * seg.ux + (z - seg.z) * seg.uz));
          const px = seg.x + seg.ux * t, pz = seg.z + seg.uz * t, d = Math.hypot(px - x, pz - z);
          if (d <= bestD) { bestD = d; best = { x: px, z: pz, ux: seg.ux, uz: seg.uz, link: seg.link }; }
        }
      }
    }
    return best;
  };
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
    // Its main street's, where the tile gives its street address (js/addresses.js), as its walls have it (js/buildings.js streetOf()):
    // the road at that point, among those held, so it's found whichever tile it's in. Otherwise, or where that's no road on the ground,
    // the nearest street among its own tile's
    streetOf: (w) => {
      const a = w.pieces.find((b) => b.address)?.address[0];
      const road = a && roadNear(a.x, a.z, ADDRESS_REACH);
      if (road) return road;
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
    sites: sitesNear((square.x0 + square.x1) / 2, (square.z0 + square.z1) / 2, SQUARE + MARGIN),
    // For each lot's things and the verges
    lotThings: (lot, near) => lotThings(lot, near, env),
    links: [...links],
    pavingTris: paving.trianglesIn,
    lawnTris: lawn.trianglesIn,
    busStops,
    trees: { near: treesNear, species: speciesAt },
    corner: GEO.frame.corner,
    paved: (x, z) => x >= PAVED_AREA.x0 && x <= PAVED_AREA.x1 && z >= PAVED_AREA.z0 && z <= PAVED_AREA.z1
  };
  return { entries, env };
}

/**
 * What a square's lots draw over the ground, as triangles in the world (for js/drawn-ground.js, which the walker and what's ridden stand on):
 * { lawn, path, slabs }, its verges' lawn and footpath, and the tops of its slabs (driveways, crossovers, laybacks and paths)
 */
function groundOf(result) {
  const inWorld = (chunks) => chunks.map((c) => {
    const t = new Float32Array(c.pos.length);
    for (let i = 0; i < c.pos.length; i += 3) {
      t[i] = c.pos[i] + c.x;
      t[i + 1] = c.pos[i + 1];
      t[i + 2] = c.pos[i + 2] + c.z;
    }
    return t;
  });
  // A slab's top: its middle, half its length either way along (a) and half its width across (b), as js/house-lots.js slab() makes it
  const tops = new Float32Array(result.slabs.length * 18);
  let n = 0;
  for (const s of result.slabs) {
    const at = (u, w) => [s.x + s.ax * u + s.bx * w, s.y + s.ay * u + s.by * w, s.z + s.az * u + s.bz * w];
    const a = at(-0.5, -0.5), b = at(0.5, -0.5), c = at(0.5, 0.5), d = at(-0.5, 0.5);
    tops.set([...a, ...b, ...c, ...a, ...c, ...d], n);
    n += 18;
  }
  return { lawn: inWorld(result.verge.lawn), path: inWorld(result.verge.path), slabs: [tops] };
}

/** A unit box from (-0.5, 0, -0.5) to (0.5, 1, 0.5): each of the lots' things */
function thingGeometry() {
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  return box;
}

/** A mesh drawn from `capacity` vertices filled as wanted: the verges' lawn or footpath */
function vergeMesh(capacity, material, colour = null) {
  const g = new THREE.BufferGeometry();
  // Static usage, as every buffer here: three.js uploads a DynamicDrawUsage attribute whole in every pass of every frame it's drawn in
  // (js/trees.js has the same), where needsUpdate uploads only what a refill wrote
  const position = new THREE.Float32BufferAttribute(new Float32Array(capacity * 3), 3);
  g.setAttribute('position', position);
  const normals = new Float32Array(capacity * 3);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  if (colour) {
    const colours = new Float32Array(capacity * 3);
    for (let i = 0; i < capacity; i++) colours.set(colour, i * 3);
    g.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  }
  g.setDrawRange(0, 0);
  const mesh = new THREE.Mesh(g, material);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}

// The nature strips' lawn: the parks' lawn, over the paving as the garden's paths are
let vergeLawn = null;
function vergeLawnMaterial() {
  if (vergeLawn) return vergeLawn;
  vergeLawn = createParkLawnMaterial(false);
  vergeLawn.polygonOffset = true;
  vergeLawn.polygonOffsetFactor = -2;
  vergeLawn.polygonOffsetUnits = -2;
  vergeLawn.maskNode = outsideTunnelMouths();
  return vergeLawn;
}

// The nature strips' footpath: the garden paths' plain asphalt (their colour in the vertices), over the paving as the garden's paths are.
// Not the gardens' own material, whose tracks' worn edges (createGardenPathMaterial()) cost every pixel a few noises and an alpha test.
let vergePath = null;
function vergePathMaterial() {
  if (vergePath) return vergePath;
  vergePath = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.9 });
  vergePath.polygonOffset = true;
  vergePath.polygonOffsetFactor = -2;
  vergePath.polygonOffsetUnits = -2;
  return vergePath;
}

/**
 * The lots near you. `level`: the graphics level's name; `reach()`: m round you they're drawn (houseDetail); `built(key)`: whether that
 * tile is built; `walker`: { add(list), remove(list) } for the fences' colliders; `shadows`: whether they cast them.
 */
function createLotDetails({ level = 'high', reach = () => 260, built = () => false, walker = null, shadows = true } = {}) {
  const room = ROOM[level] || ROOM.high, small = SMALL[level] || SMALL.high, thingsReach = THINGS[level] || THINGS.high;
  const group = new THREE.Group();
  group.name = 'HouseLots';

  // Static usage throughout (vergeMesh()): refills upload what they write, through needsUpdate
  const fenceData = new THREE.InstancedBufferAttribute(new Float32Array(room.panels * 4), 4);
  const panelGeo = panelGeometry();
  panelGeo.setAttribute('fence', fenceData);
  const fences = new THREE.InstancedMesh(panelGeo, createFenceMaterial(), room.panels);
  fences.name = 'LotFences';
  fences.castShadow = shadows;
  fences.receiveShadow = true;
  const slabs = new THREE.InstancedMesh(slabGeometry(), createConcreteMaterial(), room.slabs);
  slabs.name = 'LotSlabs';
  slabs.receiveShadow = true;
  slabs.setColorAt(0, new THREE.Color(1, 1, 1));
  const thingData = new THREE.InstancedBufferAttribute(new Float32Array(room.things * 4), 4);
  const thingGeo = thingGeometry();
  thingGeo.setAttribute('thing', thingData);
  const things = new THREE.InstancedMesh(thingGeo, createLotThingMaterial(), room.things);
  things.name = 'LotThings';
  things.castShadow = shadows;
  things.receiveShadow = true;
  things.setColorAt(0, new THREE.Color(1, 1, 1));
  for (const mesh of [fences, slabs, things]) {
    mesh.userData.lifted = true; // written on the ground already
    mesh.count = 0;
    group.add(mesh);
  }
  const lawns = vergeMesh(room.lawn, vergeLawnMaterial());
  lawns.name = 'VergeLawn';
  const paths = vergeMesh(room.path, vergePathMaterial(), PATH_SURFACES[1]);
  paths.name = 'VergePath';
  for (const mesh of [lawns, paths]) {
    mesh.userData.lifted = true;
    mesh.frustumCulled = false; // what's in it is chosen near you
    group.add(mesh);
  }

  const squares = new Map(); // key -> { square, keys (the tiles it needs), result (squareLots(), with its verge) }
  let filledAt = null, changed = true, originMoved = false, treesVersion = 0;
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
        dropLayers(`lots:${key}:`);
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
    pending = !!next;
    if (next) {
      activity.label = 'houses\' lots';
      const { entries, env } = yield* squareWork(next.square, heldByKey());
      const result = yield* squareLots(entries, env, next.square);
      result.verge = yield* squareVerge(result.fronting, env, next.square);
      result.fronting = null;
      treesVersion++;
      // Let go of while it was worked out
      if (next.keys.every((k) => isHeld(k))) {
        squares.set(next.key, { square: next.square, keys: next.keys, result });
        // Each by itself, so the lookup can say which it stood on
        for (const [what, tris] of Object.entries(groundOf(result))) setLayer(`lots:${next.key}:${what}`, tris);
      }
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
  let pending = true;

  const m = new THREE.Matrix4();
  const tint = new THREE.Color();
  // The instance matrix of a box or slab from its middle and its vectors along, up and across, turned the right way out
  const boxMatrix = (x, y, z, ax, ay, az, hy, bx, by, bz) => {
    const flip = ax * bz - az * bx > 0 ? 1 : -1;
    return m.set(ax, 0, bx * flip, x - origin.x, ay, hy, by * flip, y, az, 0, bz * flip, z - origin.z, 0, 0, 0, 1);
  };
  const nearest = (list, n) => (list.length > n ? list.sort((a, b) => a[0] - b[0]).slice(0, n) : list.sort((a, b) => a[0] - b[0]));
  const update = (attribute, n, size) => {
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, Math.max(1, n) * size);
    attribute.needsUpdate = true;
  };
  // What's drawn, from the squares held: the nearest of each kind, as many as there's room for
  function fill(x, z, r) {
    filledAt = { x, z };
    changed = false;
    originMoved = false;
    const panels = [], concrete = [], boxes = [], lawnChunks = [], pathChunks = [], pieces = [];
    for (const { result } of squares.values()) {
      for (const p of result.panels) {
        const d = Math.hypot(p.x - x, p.z - z);
        if (d <= r) panels.push([d, p]);
      }
      for (const s of result.slabs) {
        const d = Math.hypot(s.x - x, s.z - z);
        if (d <= (s.near ? Math.min(r, thingsReach) : r)) concrete.push([d, s]);
      }
      for (const b of result.things) {
        const d = Math.hypot(b.x - x, b.z - z);
        if (d <= Math.min(r, b.small ? small : thingsReach)) boxes.push([d, b]);
      }
      for (const [list, out] of [[result.verge.lawn, lawnChunks], [result.verge.path, pathChunks]]) {
        for (const c of list) {
          const d = Math.hypot(c.x - x, c.z - z);
          if (d <= r + 12) out.push([d, c]);
        }
      }
      for (const f of result.fences) {
        const d = Math.hypot((f.a.x + f.b.x) / 2 - x, (f.a.z + f.b.z) / 2 - z);
        if (d <= HOLD) pieces.push(f);
      }
    }
    const P = nearest(panels, room.panels), S = nearest(concrete, room.slabs), B = nearest(boxes, room.things);
    const data = fenceData.array;
    for (let i = 0; i < P.length; i++) {
      const p = P[i][1];
      // Along the fence, up, and out of it
      m.set(p.ux * p.length, 0, -p.uz, p.x - origin.x, 0, p.height, 0, p.y, p.uz * p.length, 0, p.ux, p.z - origin.z, 0, 0, 0, 1);
      fences.setMatrixAt(i, m);
      data[i * 4] = p.length;
      data[i * 4 + 1] = p.height;
      data[i * 4 + 2] = p.kind;
      data[i * 4 + 3] = p.colour + Math.min(p.roll, 0.999);
    }
    for (let i = 0; i < S.length; i++) {
      const s = S[i][1];
      slabs.setMatrixAt(i, boxMatrix(s.x, s.y, s.z, s.ax, s.ay, s.az, THICK[s.kind], s.bx, s.by, s.bz));
      const shade = s.kind === 2 ? s.tint * 0.96 : s.tint;
      if (s.rgb) slabs.setColorAt(i, tint.setRGB(s.rgb[0] * shade, s.rgb[1] * shade, s.rgb[2] * shade));
      else slabs.setColorAt(i, tint.setRGB(shade, shade, shade * 0.98));
    }
    const td = thingData.array;
    for (let i = 0; i < B.length; i++) {
      const b = B[i][1];
      things.setMatrixAt(i, boxMatrix(b.x, b.y, b.z, b.ax, b.ay, b.az, b.h, b.bx, b.by, b.bz));
      things.setColorAt(i, tint.setRGB(b.colour[0], b.colour[1], b.colour[2]));
      td[i * 4] = Math.hypot(b.ax, b.ay, b.az);
      td[i * 4 + 1] = b.h;
      td[i * 4 + 2] = Math.hypot(b.bx, b.by, b.bz);
      td[i * 4 + 3] = b.kind;
    }
    fences.count = P.length;
    slabs.count = S.length;
    things.count = B.length;
    for (const [mesh, n] of [[fences, P.length], [slabs, S.length], [things, B.length]]) {
      update(mesh.instanceMatrix, n, 16);
      mesh.boundingSphere = null;
      if (n) mesh.computeBoundingSphere();
      if (mesh.instanceColor) update(mesh.instanceColor, n, 3);
    }
    update(fenceData, P.length, 4);
    update(thingData, B.length, 4);
    // The verges, a chunk at a time, nearest first, as many vertices as there's room for
    for (const [mesh, chunks, capacity] of [[lawns, lawnChunks, room.lawn], [paths, pathChunks, room.path]]) {
      chunks.sort((a, b) => a[0] - b[0]);
      const pos = mesh.geometry.attributes.position, array = pos.array;
      let n = 0;
      for (const [, c] of chunks) {
        const count = c.pos.length / 3;
        if (n + count > capacity) break;
        const ox = c.x - origin.x, oz = c.z - origin.z;
        for (let i = 0; i < c.pos.length; i += 3) {
          array[n * 3 + i] = c.pos[i] + ox;
          array[n * 3 + i + 1] = c.pos[i + 1];
          array[n * 3 + i + 2] = c.pos[i + 2] + oz;
        }
        n += count;
      }
      update(pos, n, 3);
      mesh.geometry.setDrawRange(0, n);
      mesh.visible = shown && n > 0; // a draw of nothing is still a draw
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
    // A garage's walls, or a fence's thin box along it
    const o = f.box || (() => {
      const L = Math.hypot(f.b.x - f.a.x, f.b.z - f.a.z);
      return { cx: (f.a.x + f.b.x) / 2, cz: (f.a.z + f.b.z) / 2, ux: (f.b.x - f.a.x) / L, uz: (f.b.z - f.a.z) / L, hx: L / 2, hz: 0.05 };
    })();
    const ex = Math.abs(o.ux) * o.hx + Math.abs(o.uz) * o.hz, ez = Math.abs(o.uz) * o.hx + Math.abs(o.ux) * o.hz;
    c = { minX: o.cx - ex, maxX: o.cx + ex, minZ: o.cz - ez, maxZ: o.cz + ez, minY: 0, maxY: f.hold ?? FENCE_HOLD, fence: true,
      obb: { cx: o.cx, cz: o.cz, cs: o.ux, sn: -o.uz, hx: o.hx, hz: o.hz } };
    colliders.set(f, c);
    return c;
  }

  /**
   * The trees the verges add within r of (x, z), the nearest TREES of them, for the street furniture's tree field; and a number that changes
   * when they might have
   */
  function trees(x, z, r = reach(), most = TREES[level] || TREES.high) {
    const out = [];
    for (const { result } of squares.values()) {
      for (const t of result.verge.trees) {
        const d = Math.hypot(t.x - x, t.z - z);
        if (d <= r) out.push([d, t]);
      }
    }
    return out.sort((a, b) => a[0] - b[0]).slice(0, most).map(([, t]) => t);
  }
  const treesState = () => ({ version: treesVersion, pending });
  /** How far from its street's middle the crowd walks at (x, z) beside a link (its id) with a verge there, or null (js/verge.js walkLine()) */
  function walkAt(link, x, z) {
    for (const { square, result } of squares.values()) {
      if (x < square.x0 - 40 || x > square.x1 + 40 || z < square.z0 - 40 || z > square.z1 + 40) continue;
      const d = walkLine(result.verge.walks, link, x, z);
      if (d !== null) return d;
    }
    return null;
  }

  /** For the debug view and the scripts: what's worked out and what's drawn */
  function state(x = filledAt?.x ?? 0, z = filledAt?.z ?? 0, r = reach()) {
    const lots = [], fenceList = [], drives = [], sides = [];
    let added = 0;
    for (const { result } of squares.values()) {
      for (const lot of result.lots) {
        if (Math.hypot(lot.home.cx - x, lot.home.cz - z) > r) continue;
        lots.push(lot);
        if (lot.drive) drives.push(lot);
      }
      for (const f of result.fences) if (Math.hypot((f.a.x + f.b.x) / 2 - x, (f.a.z + f.b.z) / 2 - z) <= r) fenceList.push(f);
      for (const sd of result.verge.sides) if (Math.hypot(sd.x - x, sd.z - z) <= r) sides.push(sd);
      for (const t of result.verge.trees) if (Math.hypot(t.x - x, t.z - z) <= r) added++;
    }
    return { squares: squares.size, lots, fences: fenceList, drives, panels: fences.count, slabs: slabs.count, things: things.count,
      lawn: lawns.geometry.drawRange.count / 3, path: paths.geometry.drawRange.count / 3, sides, trees: added, colliders: held.size };
  }

  /** Hidden or shown, at once (for measuring what they cost) */
  let shown = true;
  function setShown(on) {
    shown = !!on;
    fences.visible = slabs.visible = things.visible = shown;
    lawns.visible = shown && lawns.geometry.drawRange.count > 0;
    paths.visible = shown && paths.geometry.drawRange.count > 0;
  }

  /** Lets go of everything: the colliders back from the walker */
  function clear() {
    squares.clear();
    dropLayers('lots:');
    if (walker) walker.remove([...held]);
    held = new Set();
    fences.count = slabs.count = things.count = 0;
    lawns.geometry.setDrawRange(0, 0);
    paths.geometry.setDrawRange(0, 0);
    changed = true;
    treesVersion++;
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
  return { group, anchor, work, state, setShown, clear, debugLines, squares, trees, treesState, walkAt };
}

// houseEntry() too, for the seasons (js/seasons.js ctx.houses), which import nothing of the game's
export { HOLD, REFILL, SQUARE, createLotDetails, groundOf, houseEntry, squareWork, squareWorkNow, tilesFor };
