import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addBuildingDetails } from './building-details.js';
import {
  Fn,
  vec2,
  color,
  uv,
  normalWorldGeometry,
  abs,
  fract,
  step,
  smoothstep,
  fwidth,
  max,
  min,
  mix,
  length
} from 'three/tsl';
import {
  createPreWarBuildingMaterial,
  createCurtainWallMaterial,
  filteredPulse
} from './tsl-materials.js';
import { GEO, TILE } from './geodata.js';
import { groundHeight } from './surfaces.js';
import { createBuildingFootprintsSteps } from './building-footprints.js';
import { polygonContains, polygonBoxOverlaps } from './building-collision.js';
import { buildingLook, mulberry32 } from './building-look.js';

// Surveyed footprints define buildings and collisions; architectural details stream around the player.

// The looks a building can have. Which one is js/building-look.js's choice.
const FACADES = [
  // 0: Sydney sandstone, the colour of the old city
  [createPreWarBuildingMaterial, {
    stoneColor: 0xd2b78b,
    trimColor: 0xa38a62,
    windowGlassColor: 0x1a2836,
    windowWidth: 2.6,
    floorHeight: 3.7,
    litProbability: 0.54,
    warmth: 0.80,
    seed: 12.4
  }],
  // 1: Federation red brick, the terraces and warehouses of the inner suburbs
  [createPreWarBuildingMaterial, {
    stoneColor: 0xa45a45,
    trimColor: 0xcab9a0,
    windowGlassColor: 0x16222e,
    windowWidth: 2.4,
    floorHeight: 3.5,
    litProbability: 0.56,
    warmth: 0.86,
    seed: 27.8
  }],
  // 2: Blue-green curtain-wall glass
  [createCurtainWallMaterial, {
    glassTint: 0x1a3a52,
    frameTint: 0x3b4c5b,
    windowWidth: 2.7,
    floorHeight: 3.9,
    litProbability: 0.60,
    warmth: 0.52,
    reflectivity: 0.92,
    seed: 63.5
  }],
  // 3: Dark bronze glass
  [createCurtainWallMaterial, {
    glassTint: 0x242220,
    frameTint: 0x3c3631,
    windowWidth: 2.5,
    floorHeight: 3.8,
    litProbability: 0.64,
    warmth: 0.72,
    reflectivity: 0.88,
    seed: 81.9
  }],
  // 4: Silver contemporary glass
  [createCurtainWallMaterial, {
    glassTint: 0x264664,
    frameTint: 0xb0bcc8,
    windowWidth: 2.9,
    floorHeight: 4.1,
    litProbability: 0.58,
    warmth: 0.48,
    reflectivity: 0.95,
    seed: 94.3
  }],
  // 5: A 1970s office block: poured concrete, a regular grid of big dark windows
  [createPreWarBuildingMaterial, {
    stoneColor: 0xb4afa5,
    trimColor: 0x8f8a80,
    windowGlassColor: 0x141c24,
    windowWidth: 2.6,
    floorHeight: 3.7,
    windowRatioX: 0.62,
    windowRatioY: 0.56,
    coursing: 0,
    litProbability: 0.58,
    warmth: 0.6,
    seed: 41.2
  }],
  // 6: Pink granite, the MLC Centre's and much of Sydney's 1980s
  [createPreWarBuildingMaterial, {
    stoneColor: 0xa67f76,
    trimColor: 0x7a5a54,
    windowGlassColor: 0x10161c,
    windowWidth: 2.8,
    floorHeight: 3.8,
    windowRatioX: 0.56,
    windowRatioY: 0.62,
    coursing: 0.4,
    litProbability: 0.58,
    warmth: 0.6,
    seed: 57.7
  }]
];
// What each facade averages out to from far away: its walls and its windows together
const FACADE_TONES = FACADES.map(([create, o]) => create === createCurtainWallMaterial
  ? new THREE.Color(o.glassTint).lerp(new THREE.Color(o.frameTint), 0.25).multiplyScalar(1.5)
  : new THREE.Color(o.stoneColor).lerp(new THREE.Color(o.windowGlassColor), 0.28));
const ROOF_COLOURS = [0x8d8f8e, 0xa3a4a1, 0xb5b5af, 0xc6c5be].map((c) => new THREE.Color(c));

/**
 * Spatial 2D quadtree for range queries around the active player/camera position.
 */
class Quadtree {
  constructor(bounds, capacity = 6, maxDepth = 6, depth = 0) {
    this.bounds = bounds; // { minX, maxX, minZ, maxZ }
    this.capacity = capacity;
    this.maxDepth = maxDepth;
    this.depth = depth;
    this.items = [];
    this.divided = false;
    this.nw = null;
    this.ne = null;
    this.sw = null;
    this.se = null;
  }

  containsPoint(x, z) {
    const b = this.bounds;
    return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
  }

  intersectsCircle(cx, cz, radius) {
    const b = this.bounds;
    const closestX = Math.max(b.minX, Math.min(cx, b.maxX));
    const closestZ = Math.max(b.minZ, Math.min(cz, b.maxZ));
    const dx = cx - closestX;
    const dz = cz - closestZ;
    return (dx * dx + dz * dz) <= (radius * radius);
  }

  subdivide() {
    const b = this.bounds;
    const midX = (b.minX + b.maxX) * 0.5;
    const midZ = (b.minZ + b.maxZ) * 0.5;
    const nextDepth = this.depth + 1;

    this.nw = new Quadtree({ minX: b.minX, maxX: midX, minZ: b.minZ, maxZ: midZ }, this.capacity, this.maxDepth, nextDepth);
    this.ne = new Quadtree({ minX: midX, maxX: b.maxX, minZ: b.minZ, maxZ: midZ }, this.capacity, this.maxDepth, nextDepth);
    this.sw = new Quadtree({ minX: b.minX, maxX: midX, minZ: midZ, maxZ: b.maxZ }, this.capacity, this.maxDepth, nextDepth);
    this.se = new Quadtree({ minX: midX, maxX: b.maxX, minZ: midZ, maxZ: b.maxZ }, this.capacity, this.maxDepth, nextDepth);
    this.divided = true;

    for (const item of this.items) {
      this._insertIntoChildren(item);
    }
    this.items.length = 0;
  }

  _insertIntoChildren(item) {
    if (this.nw.containsPoint(item.cx, item.cz)) return this.nw.insert(item);
    if (this.ne.containsPoint(item.cx, item.cz)) return this.ne.insert(item);
    if (this.sw.containsPoint(item.cx, item.cz)) return this.sw.insert(item);
    if (this.se.containsPoint(item.cx, item.cz)) return this.se.insert(item);
    return false;
  }

  insert(item) {
    if (!this.containsPoint(item.cx, item.cz)) return false;

    if (!this.divided) {
      if (this.items.length < this.capacity || this.depth >= this.maxDepth) {
        this.items.push(item);
        return true;
      }
      this.subdivide();
    }
    return this._insertIntoChildren(item);
  }

  queryRange(cx, cz, radius, found = []) {
    if (!this.intersectsCircle(cx, cz, radius)) return found;

    const rSq = radius * radius;
    if (!this.divided) {
      for (let i = 0; i < this.items.length; i++) {
        const item = this.items[i];
        const dx = item.cx - cx;
        const dz = item.cz - cz;
        if (dx * dx + dz * dz <= rSq) {
          found.push(item);
        }
      }
      return found;
    }

    this.nw.queryRange(cx, cz, radius, found);
    this.ne.queryRange(cx, cz, radius, found);
    this.sw.queryRange(cx, cz, radius, found);
    this.se.queryRange(cx, cz, radius, found);
    return found;
  }
}

// The buildings of the tiles held, each tile's added and removed as a piece, on materials they all share so a new tile
// compiles nothing. The roof and street-front details are pools in `group`, filled around the player.
function createCityBlocks(scene) {
  const group = new THREE.Group();
  group.name = 'CityBlocks';
  const tiles = new Map(); // key -> { x, z, quadtree, details, colliders, reserves }

  const materials = FACADES.map(([create, opts]) => create({ ...opts, footprintLocal: true }));
  const roofMaterials = [new THREE.MeshStandardNodeMaterial({ color: 0xa8583a, roughness: 0.82 }), new THREE.MeshStandardNodeMaterial({ color: 0x565d63, roughness: 0.7 })];

  // The landmarks' own models stand where the buildings they replace were (tools/tiles/derive.mjs)
  const landmarkReserves = GEO.landmarkBoxes.map((c) => ({ x0: c.minX, x1: c.maxX, z0: c.minZ, z1: c.maxZ, height: c.maxY }));
  const hitR = (a, x0, x1, z0, z1) => a.x0 < x1 && a.x1 > x0 && a.z0 < z1 && a.z1 > z0;
  const reserveCells = new Map();
  const reserveKey = (ix, iz) => (ix + 4096) * 8192 + (iz + 4096);
  const eachReserveCell = (r, fn) => {
    for (let ix = Math.floor(r.x0 / 128); ix <= Math.floor(r.x1 / 128); ix++) {
      for (let iz = Math.floor(r.z0 / 128); iz <= Math.floor(r.z1 / 128); iz++) fn(reserveKey(ix, iz));
    }
  };
  function addReserve(r, owner = null) {
    owner?.reserves.push(r);
    eachReserveCell(r, (key) => {
      if (!reserveCells.has(key)) reserveCells.set(key, []);
      reserveCells.get(key).push(r);
    });
  }
  function removeReserves(list) {
    const gone = new Set(list);
    for (const r of list) {
      eachReserveCell(r, (key) => {
        const cell = reserveCells.get(key);
        if (!cell) return;
        const kept = cell.filter((o) => !gone.has(o));
        if (kept.length) reserveCells.set(key, kept);
        else reserveCells.delete(key);
      });
    }
  }
  function nearbyReserves(b, padding = 0) {
    const minX = b.minX - padding, maxX = b.maxX + padding;
    const minZ = b.minZ - padding, maxZ = b.maxZ + padding;
    const found = new Set();
    for (let ix = Math.floor(minX / 128); ix <= Math.floor(maxX / 128); ix++) {
      for (let iz = Math.floor(minZ / 128); iz <= Math.floor(maxZ / 128); iz++) {
        for (const r of reserveCells.get(reserveKey(ix, iz)) || []) {
          if (hitR(r, minX, maxX, minZ, maxZ)) found.add(r);
        }
      }
    }
    return Array.from(found);
  }
  for (const r of landmarkReserves) {
    addReserve({ ...r, polygons: [{ outer: [
      { x: r.x0, z: r.z0 }, { x: r.x1, z: r.z0 }, { x: r.x1, z: r.z1 }, { x: r.x0, z: r.z1 }
    ], holes: [] }] });
  }

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const dummy = new THREE.Object3D();

  // ============================================================================
  // STREAMED ARCHITECTURAL DETAILS
  // ============================================================================
  const MAX_CORNICES = 7000;
  const MAX_HVAC = 1600;
  const MAX_AWNINGS = 1800;
  const MAX_SHEDS = 300;

  // 1. Projecting horizontal stone cornices & parapet ledges
  const corniceMat = new THREE.MeshStandardNodeMaterial({ color: 0xc8bca6, roughness: 0.78, metalness: 0.08 });
  const corniceInst = new THREE.InstancedMesh(unitBox, corniceMat, MAX_CORNICES);
  corniceInst.castShadow = true;
  corniceInst.receiveShadow = true;
  corniceInst.frustumCulled = false;
  group.add(corniceInst);

  // 3. Rooftop mechanical penthouses & HVAC chillers with top exhaust fans & side louvers
  const hvacMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.52, metalness: 0.45 });
  hvacMat.colorNode = Fn(() => {
    const u = uv();
    const isTop = step(0.7, normalWorldGeometry.y);
    const fan1 = length(u.sub(vec2(0.3, 0.5)));
    const fan2 = length(u.sub(vec2(0.7, 0.5)));
    const fanDist = min(fan1, fan2);
    const inFanWell = smoothstep(0.19, 0.17, fanDist);
    // Average subpixel slats and fan rings instead of letting them shimmer at a distance.
    const fanCoord = fanDist.mul(16.0);
    const fanRing = filteredPulse(fract(fanCoord), 0.4835, 0.5165, fwidth(fanCoord)).mul(inFanWell);
    const topCol = mix(color(0x889098), color(0x1b2026), inFanWell.mul(0.82).sub(fanRing.mul(0.45)));

    const inLouverBox = step(0.12, u.x).mul(step(u.x, 0.88)).mul(step(0.18, u.y)).mul(step(u.y, 0.82));
    const slatCoord = u.y.mul(14.0);
    const louverSlat = filteredPulse(fract(slatCoord), 0.45, 1.0, fwidth(slatCoord)).mul(inLouverBox);
    const panelSeam = smoothstep(0.03, 0.0, abs(fract(u.x.mul(3.0)).sub(0.5)));
    const sideCol = mix(color(0x7c848c), color(0x282e36), max(louverSlat.mul(0.72), panelSeam.mul(0.35)));
    return mix(sideCol, topCol, isTop);
  })();
  const hvacInst = new THREE.InstancedMesh(unitBox, hvacMat, MAX_HVAC);
  hvacInst.castShadow = hvacInst.receiveShadow = true;
  hvacInst.frustumCulled = false;
  group.add(hvacInst);

  // 4. Instanced fire escapes: real steps nearby, lightweight silhouettes in the distance.

  // 5. Ground-floor retail canvas awnings & illuminated storefront fascia signs
  const awningMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.65 });
  const awningPalette = [
    new THREE.Color(0x9e222e),
    new THREE.Color(0x1f593b),
    new THREE.Color(0x213d68),
    new THREE.Color(0xd9912b),
    new THREE.Color(0x2d2d32)
  ];
  const awningInst = new THREE.InstancedMesh(unitBox, awningMat, MAX_AWNINGS);
  awningInst.castShadow = awningInst.receiveShadow = true;
  awningInst.frustumCulled = false;
  // Pre-initialize instanceColor buffer so dynamic updates work cleanly
  for (let i = 0; i < MAX_AWNINGS; i++) {
    awningInst.setColorAt(i, awningPalette[i % awningPalette.length]);
  }
  group.add(awningInst);

  const signThemes = [
    { bg: '#161210', border: '#c89d54', text: 'THE SANDSTONE BISTRO · EST. 1928', color: '#ffe4a8' },
    { bg: '#0c2244', border: '#38b6ff', text: 'CITY CHEMIST · PHARMACY', color: '#ffffff' },
    { bg: '#142b20', border: '#d4af37', text: 'HARBOUR BOOKS & ESPRESSO', color: '#fff2cc' },
    { bg: '#280a10', border: '#ff5252', text: 'HARBOUR CITY GRILL · 24HR', color: '#ffd180' },
    { bg: '#101318', border: '#e0e6ed', text: 'STRAND WATCHES · SYDNEY', color: '#f5f9ff' }
  ];
  const MAX_SIGNS_PER_THEME = Math.ceil(MAX_AWNINGS / signThemes.length) + 32;
  const signInsts = signThemes.map((st) => {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 96;
    const ctx = c.getContext('2d');
    ctx.fillStyle = st.bg;
    ctx.fillRect(0, 0, 512, 96);
    ctx.strokeStyle = st.border;
    ctx.lineWidth = 6;
    ctx.strokeRect(6, 6, 500, 84);
    ctx.fillStyle = st.color;
    ctx.font = '800 26px Inter, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(st.text, 256, 50);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sMat = new THREE.MeshBasicNodeMaterial({ map: tex });
    const sInst = new THREE.InstancedMesh(unitBox, sMat, MAX_SIGNS_PER_THEME);
    sInst.frustumCulled = false;
    group.add(sInst);
    return sInst;
  });

  // 6. Sidewalk construction scaffolding sheds
  const shedMat = new THREE.MeshStandardNodeMaterial({ color: 0x214f37, roughness: 0.6, metalness: 0.25 });
  const shedInst = new THREE.InstancedMesh(unitBox, shedMat, MAX_SHEDS);
  shedInst.castShadow = shedInst.receiveShadow = true;
  shedInst.frustumCulled = false;
  group.add(shedInst);

  // 7. Ground-floor storefront clustered SpotLights (awnings/fascia signs)
  const storeLightGroup = new THREE.Group();
  storeLightGroup.name = 'StoreClusteredLights';

  const storeThemeColors = [
    new THREE.Color(0xffd896), // Bistro warm gold
    new THREE.Color(0xd8eeff), // Chemist crisp cool white
    new THREE.Color(0xffe4ad), // Bookstore warm amber
    new THREE.Color(0xffbe88), // 24hr grill warm orange-gold
    new THREE.Color(0xfff2d6)  // Watch boutique warm ivory
  ];

  const STORE_SPOT_POOL = 28;
  const STORE_SPOT_INTENSITY = 46 * ((0.85 - 0.15) / 0.90);
  const storeSpotPool = [];
  for (let i = 0; i < STORE_SPOT_POOL; i++) {
    const spot = new THREE.SpotLight(0xffd896, 0, 12.0, 0.84, 0.80, 1.30);
    spot.castShadow = false;
    spot.position.set(0, -1000, 0);
    spot.target.position.set(0, -1001, 0);
    storeLightGroup.add(spot);
    storeLightGroup.add(spot.target);
    storeSpotPool.push(spot);
  }

  const activeAwnings = [];
  const spotCandidates = [];

  // ============================================================================
  // STREAMING AROUND THE PLAYER / CAMERA
  // ============================================================================
  let lastStreamX = Infinity;
  let lastStreamZ = Infinity;
  const STREAM_RADIUS = 560; // High-detail architectural radius around player in meters

  // Streaming rewrites only the active prefix; unused pool capacity need not cross the GPU queue.
  function flagRange(attribute, count) {
    if (count === 0) return;
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, count * attribute.itemSize);
    attribute.needsUpdate = true;
  }

  function update(focusX, focusZ, force = false) {
    const dx = focusX - lastStreamX;
    const dz = focusZ - lastStreamZ;
    if (!force && (dx * dx + dz * dz) < 324) {
      // Player moved less than 18m since last Quadtree stream update
      return;
    }
    lastStreamX = focusX;
    lastStreamZ = focusZ;

    const nearbyBlocks = [];
    for (const tile of tiles.values()) {
      if (Math.max(Math.abs(tile.x - focusX), Math.abs(tile.z - focusZ)) < STREAM_RADIUS + TILE) nearbyBlocks.push(...tile.quadtree.queryRange(focusX, focusZ, STREAM_RADIUS));
    }
    // Sort closest blocks first so if any pool hits capacity, closest blocks around the player always win
    nearbyBlocks.sort((a, b) => {
      const da = (a.cx - focusX) * (a.cx - focusX) + (a.cz - focusZ) * (a.cz - focusZ);
      const db = (b.cx - focusX) * (b.cx - focusX) + (b.cz - focusZ) * (b.cz - focusZ);
      return da - db;
    });
    activeAwnings.length = 0;

    let corniceCount = 0;
    let hvacCount = 0;
    let awningCount = 0;
    let awningBlocks = 0;
    let shedCount = 0;
    const signCounts = signInsts.map(() => 0);

    for (const blk of nearbyBlocks) {
      const collectNearLights = blk.awnings.length > 0 && awningBlocks++ < 20;
      const base = blk.base;

      // 1. Stone cornices & setback ledges, hung just below their roof line (top 0.1h under it, so no two ledges or
      //    roofs share a plane) so roofs & terraces keep their own roofing instead of a stone lid
      for (let i = 0; i < blk.cornices.length && corniceCount < MAX_CORNICES; i++) {
        const c = blk.cornices[i];
        dummy.rotation.set(0, c.ry || 0, 0);
        dummy.position.set(c.x, base + c.y - c.h * 0.6, c.z);
        dummy.scale.set(c.w, c.h, c.d);
        dummy.updateMatrix();
        corniceInst.setMatrixAt(corniceCount++, dummy.matrix);
      }

      // 3. Rooftop HVAC & mechanical bulkheads
      for (let i = 0; i < blk.hvacUnits.length && hvacCount < MAX_HVAC; i++) {
        const u = blk.hvacUnits[i];
        dummy.rotation.set(0, u.ry || 0, 0);
        dummy.position.set(u.x, base + u.y + u.h * 0.5, u.z);
        dummy.scale.set(u.w, u.h, u.d);
        dummy.updateMatrix();
        hvacInst.setMatrixAt(hvacCount++, dummy.matrix);
      }

      // 4. Wrought-iron fire escapes

      // 5. Retail awnings & illuminated storefront fascia signs
      for (let i = 0; i < blk.awnings.length && awningCount < MAX_AWNINGS; i++) {
        const a = blk.awnings[i];
        dummy.rotation.set(0, a.ry || 0, 0);
        dummy.position.set(a.x, base + a.y, a.z);
        dummy.scale.set(a.w, 0.75, a.d);
        dummy.updateMatrix();
        awningInst.setMatrixAt(awningCount, dummy.matrix);
        awningInst.setColorAt(awningCount, awningPalette[a.colorIdx % awningPalette.length]);

        const themeIdx = a.colorIdx % signInsts.length;
        if (signCounts[themeIdx] < MAX_SIGNS_PER_THEME) {
          dummy.position.set(a.x, base + 4.68, a.z);
          dummy.scale.set(0.28, 0.86, a.d * 0.92);
          dummy.updateMatrix();
          signInsts[themeIdx].setMatrixAt(signCounts[themeIdx]++, dummy.matrix);
        }
        if (collectNearLights) {
          activeAwnings.push({ a, themeIdx, ry: a.ry || 0, base });
        }
        awningCount++;
      }

      // 6. Sidewalk construction sheds
      for (let i = 0; i < blk.scaffoldSheds.length && shedCount < MAX_SHEDS; i++) {
        const s = blk.scaffoldSheds[i];
        dummy.rotation.set(0, s.ry || 0, 0);
        dummy.position.set(s.x, base + s.y + 3.6, s.z);
        dummy.scale.set(s.w, 0.85, s.d);
        dummy.updateMatrix();
        shedInst.setMatrixAt(shedCount++, dummy.matrix);
      }
    }
    dummy.rotation.set(0, 0, 0);

    corniceInst.count = corniceCount;
    flagRange(corniceInst.instanceMatrix, corniceCount);

    hvacInst.count = hvacCount;
    flagRange(hvacInst.instanceMatrix, hvacCount);


    awningInst.count = awningCount;
    flagRange(awningInst.instanceMatrix, awningCount);
    if (awningInst.instanceColor) flagRange(awningInst.instanceColor, awningCount);

    signInsts.forEach((sInst, idx) => {
      sInst.count = signCounts[idx];
      flagRange(sInst.instanceMatrix, signCounts[idx]);
    });

    shedInst.count = shedCount;
    flagRange(shedInst.instanceMatrix, shedCount);
  }

  function smoothFade(d, start, end) {
    const t = Math.min(1, Math.max(0, (end - d) / (end - start)));
    return t * t * (3 - 2 * t);
  }

  function updateLights(camera) {
    if (!camera) {
      for (let i = 0; i < STORE_SPOT_POOL; i++) {
        storeSpotPool[i].intensity = 0;
        storeSpotPool[i].position.set(0, -1000, 0);
      }
      return;
    }

    const camX = camera.position.x;
    const camY = camera.position.y;
    const camZ = camera.position.z;
    const e = camera.matrixWorld.elements;
    const fwdLen = Math.hypot(e[8], e[10]) || 1;
    const fwdX = -e[8] / fwdLen;
    const fwdZ = -e[10] / fwdLen;
    const STORE_MAX_DIST = 115;

    spotCandidates.length = 0;
    for (let i = 0; i < activeAwnings.length; i++) {
      const item = activeAwnings[i];
      const a = item.a;
      const dx = a.x - camX;
      const dz = a.z - camZ;
      const d2 = dx * dx + dz * dz + camY * camY;
      if (d2 > STORE_MAX_DIST * STORE_MAX_DIST) continue;
      const d = Math.sqrt(d2);
      const forwardDot = dx * fwdX + dz * fwdZ;
      const effDist = d + Math.max(0, 6.0 - forwardDot) * 2.8;
      if (effDist >= STORE_MAX_DIST) continue;
      spotCandidates.push({ item, effDist });
    }
    spotCandidates.sort((a, b) => a.effDist - b.effDist);

    const storeCutoff = spotCandidates.length > STORE_SPOT_POOL
      ? Math.min(STORE_MAX_DIST, spotCandidates[STORE_SPOT_POOL].effDist)
      : STORE_MAX_DIST;
    const activeSpots = Math.min(STORE_SPOT_POOL, spotCandidates.length);
    for (let i = 0; i < STORE_SPOT_POOL; i++) {
      const spot = storeSpotPool[i];
      if (i < activeSpots) {
        const cand = spotCandidates[i];
        const { a, themeIdx, ry, base } = cand.item;
        const fade = smoothFade(cand.effDist, storeCutoff * 0.62, storeCutoff);
        const outX = Math.cos(ry);
        const outZ = -Math.sin(ry);
        spot.position.set(a.x + outX * 0.45, base + 4.35, a.z + outZ * 0.45);
        spot.target.position.set(a.x + outX * 1.85, base, a.z + outZ * 1.85);
        spot.target.updateMatrixWorld();
        spot.color.copy(storeThemeColors[themeIdx % storeThemeColors.length]);
        spot.intensity = STORE_SPOT_INTENSITY * fade;
      } else {
        spot.intensity = 0;
        spot.position.set(0, -1000, 0);
      }
    }
  }

  // A building in several pieces (a tower on its podium): one floor under all of them, one look, from the tallest. All its
  // pieces are in one tile.
  function wholeOf(tile) {
    if (tile.wholes) return tile.wholes;
    tile.wholes = new Map();
    for (const b of tile.buildings) {
      if (!b.group) continue;
      const w = tile.wholes.get(b.group);
      if (!w) tile.wholes.set(b.group, { cx: b.cx, cz: b.cz, height: b.height, floor: b.floor, low: b.low });
      else {
        w.height = Math.max(w.height, b.height);
        if (!b.bottom) { w.cx = b.cx; w.cz = b.cz; }
      }
    }
    return tile.wholes;
  }

  function recordOf(tile) {
    if (!tiles.has(tile.key)) {
      const x = (tile.ix + 0.5) * TILE, z = (tile.iz + 0.5) * TILE, reach = TILE * 1.5;
      tiles.set(tile.key, { x, z, details: [], colliders: [], reserves: [],
        quadtree: new Quadtree({ minX: x - reach, maxX: x + reach, minZ: z - reach, maxZ: z + reach }, 6, 7) });
    }
    return tiles.get(tile.key);
  }

  /** Raises some of a tile's buildings into `target`, and returns their colliders. Nothing depends on the order they come in. */
  function* addBuildings(tile, buildings, target) {
    const record = recordOf(tile);
    for (const b of buildings) addReserve({ x0: b.minX, x1: b.maxX, z0: b.minZ, z1: b.maxZ, height: b.height + 0.22, polygons: b.polygons }, record);
    const wholes = wholeOf(tile);
    const colliders = [];
    const surveyedBuckets = materials.map(() => []);
    const detailsToPlace = [];
    for (const b of buildings) {
      // The pieces of one building share its look and its floor
      const whole = b.group ? wholes.get(b.group) : b;
      const { mat, tone, seed } = buildingLook(b, whole);
      const rand = mulberry32(b.group ? seed ^ Math.round(b.cx * 7 + b.cz * 13) : seed);
      // The survey has no building-use data; choose retail independently of facade style and roof details.
      const storefronts = !b.bottom && b.height >= 6 && (b.kind === 3 || (b.kind === 0 && mulberry32(seed ^ 0x53544f52)() < 0.45));
      // Level, on the highest ground along its walls: no wall starts underground (js/building-floor.js, when the tile was made)
      const base = whole.floor;
      const item = { ...b, tone, storefronts, base };
      surveyedBuckets[mat].push(item);
      const detail = {
        cx: b.cx, cz: b.cz, minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ, base,
        cornices: [], hvacUnits: [], fireEscapes: [], awnings: [], scaffoldSheds: [], footprints: []
      };
      const top = b.height + 0.22;
      for (const polygon of b.polygons) {
        const xs = polygon.outer.map((p) => p.x), zs = polygon.outer.map((p) => p.z);
        const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
        colliders.push({ minX, maxX, minZ, maxZ, minY: b.bottom || 0, maxY: top, baseY: base, polygon });
        detail.footprints.push({ h: top, pts: polygon.outer, holes: polygon.holes });
      }
      detailsToPlace.push({ b: item, detail, masonry: mat < 2 || mat > 4, rand });
      record.details.push(detail);
      yield;
    }
    // Reserve every fire escape before placing storefronts on neighbouring buildings.
    for (const { b, detail, masonry, rand } of detailsToPlace) {
      const neighbours = nearbyReserves(b, 6);
      for (const reserve of addBuildingDetails(b, detail, { masonry, rand, neighbours, groundAt: groundHeight })) addReserve(reserve, record);
      record.quadtree.insert(detail);
      yield;
    }
    for (const [i, items] of surveyedBuckets.entries()) {
      if (!items.length) continue;
      const made = yield* createBuildingFootprintsSteps(materials[i], items, i < 2 || i > 4 ? (b) => nearbyReserves(b, 2) : undefined, roofMaterials, {
        groundAt: groundHeight,
        storey: { width: FACADES[i][1].windowWidth, height: FACADES[i][1].floorHeight }
      });
      for (const mesh of [...made.children]) target.add(mesh);
      yield;
    }
    record.colliders.push(...colliders);
    return colliders;
  }

  /** Forgets a tile: its colliders are the caller's to take back, and its meshes went with the stage they were built into */
  function removeTile(tile) {
    const record = tiles.get(tile.key);
    if (!record) return;
    tiles.delete(tile.key);
    removeReserves(record.reserves);
    tile.wholes = null;
    update(lastStreamX, lastStreamZ, true);
  }

  scene.add(storeLightGroup);
  return { group, addBuildings, removeTile, update, updateLights };
}

export { FACADE_TONES, ROOF_COLOURS, createCityBlocks };
