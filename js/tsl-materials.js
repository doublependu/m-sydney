import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  color,
  uniform,
  attribute,
  varying,
  positionGeometry,
  positionLocal,
  positionWorld,
  positionView,
  positionViewDirection,
  normalLocal,
  normalWorld,
  normalWorldGeometry,
  normalGeometry,
  normalView,
  normalViewGeometry,
  modelNormalMatrix,
  frontFacing,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  screenSize,
  uv,
  vertexColor,
  time,
  sin,
  cos,
  abs,
  floor,
  fract,
  mod,
  min,
  max,
  clamp,
  mix,
  step,
  smoothstep,
  dot,
  length,
  normalize,
  reflect,
  pow,
  log2,
  exp2,
  sign,
  fwidth,
  texture,
  rotateUV,
  mrt,
  If,
  sqrt,
  specularColor,
  specularColorBlended,
  specularF90,
  diffuseColor,
  metalness,
  modelWorldMatrix,
  select,
  uniformArray,
} from 'three/tsl';
import { patternXZ } from './world-origin.js';
import { CITY_BOUNDS } from './city-config.js';
import { HOUSE_STYLES } from './house-styles.js';
import { CITY_SILL, WINDOW_CLEAR } from './wall-ground.js';
import { CELL, GLYPHS, HIGH, PAD, PALETTE } from './street-numbers.js';

// Procedural city materials: facades and interiors, vegetation, roads, water and lighting effects.

// Shared live uniforms controlled by lighting / time-of-day presets
const cityUniforms = {
  uSunColor: uniform(new THREE.Color(0xffca92)),
  uSkyTopColor: uniform(new THREE.Color(0x2c568c)),
  uSkyHorizonColor: uniform(new THREE.Color(0xebd1b5)),
  uSkySunDir: uniform(new THREE.Vector3(-0.66, 0.34, -0.67).normalize()),
  uInteriorGlow: uniform(0.78),
  uRoadWetness: uniform(0.38),
  uCanyonBounce: uniform(0.52)
};

// Fast deterministic 2D -> 1D hash in TSL
const hash2D = Fn(([p]) => {
  return fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
});

// The same without a sine (Dave Hoskins' hash12), for noise broad enough to see its lattice. fract(sin(x) * 43758) turns one
// bit of rounding in x into a different number, and a shader compiler that inlines it rounds a lattice corner differently
// for the cells either side of it, so the noise jumps along the lattice's lines: straight-edged shapes across the harbour.
// It costs more to compile, and nearly every material hashes, so the fine-grained noise keeps the sine.
const steadyHash2D = Fn(([p]) => {
  const q = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  q.addAssign(dot(q, q.yzx.add(33.33)));
  return fract(q.x.add(q.y).mul(q.z));
});

// Smooth 2D value noise in TSL
const valueNoise = (hash) => Fn(([p]) => {
  const pv = vec2(p).toVar();
  const i = floor(pv).toVar();
  const f = fract(pv).toVar();
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0))).toVar();
  const a = hash(i);
  const b = hash(i.add(vec2(1.0, 0.0)));
  const c = hash(i.add(vec2(0.0, 1.0)));
  const d = hash(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});
const noise2D = valueNoise(hash2D);
const steadyNoise2D = valueNoise(steadyHash2D);

/**
 * Mikkelsen's Surface-Gradient Hardware Derivative Bump Mapping (ported from CityGeneratorUtils.js)
 * Wrapped in Fn() so `height` is evaluated once into a scalar parameter before dFdx/dFdy!
 */
const bumpNormal = Fn(([height]) => {
  const h = float(height).toVar();
  const dpdx = positionView.dFdx();
  const dpdy = positionView.dFdy();
  const r1 = dpdy.cross(normalView);
  const r2 = normalView.cross(dpdx);
  const det = dpdx.dot(r1);
  const grad = det.sign().mul(h.dFdx().mul(r1).add(h.dFdy().mul(r2)));
  return det.abs().mul(normalView).sub(grad).normalize();
});

/**
 * Filter-Width Anti-Aliased Filled Band (ported from CityGenerator.js)
 * Wrapped in Fn() so NodeBuilder emits a single WGSL function instead of inlining fwidth trees.
 */
const lineAA = Fn(([coord, halfWidth]) => {
  const c = float(coord).toVar();
  const hw = float(halfWidth).toVar();
  const aa = fwidth(c).max(0.0001).toVar();
  const effHw = max(hw, aa.mul(0.5)).toVar();
  const cov = smoothstep(effHw.add(aa), effHw.sub(aa), abs(c));
  return cov.mul(min(float(1.0), hw.div(effHw)));
});

/**
 * Filter-Width Anti-Aliased Repeating Grid Line (ported from CityGenerator.js & SidewalkGenerator.js)
 */
const gridLine = Fn(([coord, period, halfWidth]) => {
  const p = float(period).toVar();
  const g = float(coord).div(p).toVar();
  const d = float(0.5).sub(abs(fract(g).sub(0.5))).toVar();
  const aa = fwidth(g).max(0.0001).toVar();
  const hw = float(halfWidth).div(p).toVar();
  const effHw = max(hw, aa.mul(0.5)).toVar();
  const cov = smoothstep(effHw.add(aa), effHw.sub(aa), d);
  return cov.mul(min(float(1.0), hw.div(effHw)));
});

/**
 * Box-Filtered Periodic Pulse: fraction of a footprint `w` wide around `x` where fract() lies in [a, b].
 * Exact anti-aliasing that settles to the mean coverage (b - a) once a period shrinks below a pixel, so facade grids
 * don't shimmer or moiré at distance & grazing angles. Pass the in-cell coordinate (fract) for precision.
 */
// A WGSL function of its own: the facades call it dozens of times, and written out at each call it was much of what their shaders
// took to compile.
const filteredPulse = Fn(([x, a, b, w]) => {
  const p = float(x).toVar();
  const lo = float(a).toVar();
  const hi = float(b).toVar();
  const hw = max(float(w), 0.0001).mul(0.5).toVar();
  const integral = (t) => floor(t).mul(hi.sub(lo)).add(clamp(fract(t), lo, hi).sub(lo));
  return integral(p.add(hw)).sub(integral(p.sub(hw))).div(hw.mul(2.0));
}).setLayout({ name: 'filteredPulse', type: 'float', inputs: [{ name: 'x', type: 'float' }, { name: 'a', type: 'float' }, { name: 'b', type: 'float' }, { name: 'w', type: 'float' }] });

// Share of [x - s, x + s] covered by the non-repeating interval [a, b].
const boxCoverage = Fn(([x, a, b, s]) => {
  const xv = float(x).toVar();
  const sv = max(float(s), 0.001).toVar();
  return clamp(min(xv.add(sv), b).sub(max(xv.sub(sv), a)).div(sv.mul(2.0)), 0.0, 1.0);
});

// Keep distant lit windows in 1–2 pixel clusters. Adjacent world-anchored scales cross-fade, and
// the half-width inset leaves room for filtering at cell edges while preserving mean brightness.
const distantWindowLight = Fn(([grid, fw, probability, seed, lod]) => {
  const light = float(probability).toVar();
  If(cityUniforms.uInteriorGlow.greaterThan(0.5).and(lod.greaterThan(0.0)), () => {
    const level = log2(max(max(fw.x, fw.y).mul(4.0), 2.0)).toVar();
    const scale = exp2(floor(level)).toVar();
    const cluster = (size) => {
      const p = grid.div(size).toVar();
      const width = fw.div(size).toVar();
      const lit = step(float(1.0).sub(probability), hash2D(floor(p).add(vec2(seed, 73.1))));
      const coverage = filteredPulse(fract(p.x), 0.25, 0.75, width.x)
        .mul(filteredPulse(fract(p.y), 0.25, 0.75, width.y));
      return lit.mul(coverage).mul(4.0);
    };
    const clustered = mix(cluster(scale), cluster(scale.mul(2.0)), smoothstep(0.0, 1.0, fract(level)));
    light.assign(mix(probability, clustered, smoothstep(0.5, 1.2, cityUniforms.uInteriorGlow)));
  });
  return light;
});

/**
 * Occlusion-Aware Urban Canyon Sky Visibility (aoNode)
 * Models how street canyons occlude overhead sky irradiance near the street floor, while opening up on upper tower shafts.
 * `height`: metres above the ground it stands on. Not above the sea: the city is on hills, and a road would brighten as it climbs.
 */
const canyonSkyAONode = (height) => {
  const heightOpenness = smoothstep(0.0, 68.0, height);
  const streetCrevice = smoothstep(0.0, 7.5, height).mul(0.22).add(0.78);
  return mix(float(0.5), float(1.0), heightOpenness).mul(streetCrevice);
};
// The same for what lies on the ground, with no height to ask: about what the CBD's streets had when this read sea level
const STREET_SKY = 0.6;

// Material caches to prevent duplicate WebGPU WGSL shader compilation across blocks & landmarks
const _curtainWallCache = new Map();
const _preWarCache = new Map();

// Camera-independent facade frame: the view/world normal round trip can change the dominant axis on 45-degree
// walls. Resolve near-ties in the vertex shader and keep that choice flat across each face.
const facadeNormalVertex = normalize(modelNormalMatrix.mul(normalLocal));
const facadeWorldNormal = varying(facadeNormalVertex, 'vFacadeWorldNormal').normalize();
const facadeAlongZ = varying(
  step(abs(facadeNormalVertex.z).sub(0.0001), abs(facadeNormalVertex.x)),
  'vFacadeAlongZ'
).setInterpolation(THREE.InterpolationSamplingType.FLAT, THREE.InterpolationSamplingMode.EITHER);

/**
 * Lightweight, Fast-Compiling 3D Parallax Apartment Interior Mapping (Upper Floors Only)
 * Modelled directly after `interior()` in `three/addons/generators/city/SkyscraperGenerator.js`:
 * - Evaluates `origin`, `dir`, `boxMin`, and `boxMax` in true world meters (isotropic 1:1:1 scale)
 *   so 3D room perspective is accurate from all viewing angles.
 * - Each apartment room spans 2.5 window bays wide (~6.8m) × 1 story tall (~3.5m) × ~5.2m deep,
 *   set back behind the facade so neighbouring windows look into the same full-sized room.
 * - Includes left & right fabric drapes hung just inside the window frame (`winUV`) from a 6-swatch
 *   domestic palette that block interior glow (`emit = 0.20`) so drapes silhouette against lit rooms.
 * - Once windows shrink to a pixel or two (`fwNode`: pixel footprint in cells), lit rooms merge into filtered
 *   clusters, drapes settle to their mean coverage & lamps fade out, so distant towers don't twinkle in motion.
 * - `drapeFwNode`: the drapes' pixel footprint (interiorDrapeFootprint()), taken outside, as this runs in a branch.
 * - Returns `vec4(roomColor, litEmit)`. Called through apartmentInteriorBehind().
 */
const evaluateApartmentInterior = Fn(([uCoord, vCoord, winUV, cellId, winWNode, floorHNode, seedNode, warmthNode, litProbNode, fwNode, drapeFwNode]) => {
  const u = float(uCoord).toVar();
  const v = float(vCoord).toVar();
  const wUV = vec2(winUV).toVar();
  const cid = vec2(cellId).toVar();
  const wW = float(winWNode).toVar();
  const fH = float(floorHNode).toVar();

  // Room module (SkyscraperGenerator.js lines 959-975):
  // Each room spans an INTEGER 2 or 3 window bays wide (~5.4m - 8.1m) and an INTEGER bay phase
  // offset per floor so partition walls ALWAYS land behind masonry piers/mullions, never mid-window!
  const floorIdx = floor(v.div(fH)).toVar();
  const fHash1 = fract(sin(floorIdx.mul(41.3).add(seedNode)).mul(43758.5453));
  const fHash2 = fract(sin(floorIdx.mul(73.7).add(seedNode.mul(1.7))).mul(43758.5453));
  const roomBays = mix(float(2.0), float(3.0), step(0.5, fHash1)).toVar();
  const roomPhase = floor(fHash2.mul(roomBays)).toVar();

  const gridU = u.div(wW);
  const roomU = gridU.add(roomPhase).div(roomBays).toVar();
  const roomIdx = floor(roomU).toVar();
  const roomId = vec2(roomIdx, floorIdx).toVar();

  const roomW = wW.mul(roomBays).toVar();
  const roomH = fH.mul(0.92).toVar();
  const setback = float(0.12);
  const depth = roomH.mul(1.55).toVar();

  // Pixel entry position `origin` in world meters relative to the multi-bay room center:
  // Window sill (wUV.y=0) sits ~0.75m above the room floor; window lintel (wUV.y=1) sits ~0.58m below the ceiling
  const originX = fract(roomU).sub(0.5).mul(roomW).toVar();
  const originY = wUV.y.sub(0.46).mul(roomH.mul(0.62)).toVar();

  // View ray `dir` in world meters in the room's (across, up, depth) frame. `across` runs along the wall's tangent
  // (+x on walls facing ±z, +z on walls facing ±x, turning with walls that follow a non-grid street)
  const rayWorld = normalize(positionWorld.sub(cameraPosition)).toVar();
  const tSign = mix(sign(facadeWorldNormal.z).negate(), sign(facadeWorldNormal.x), facadeAlongZ);
  const dirX = dot(rayWorld, vec3(facadeWorldNormal.z.negate(), 0.0, facadeWorldNormal.x).mul(tSign)).toVar();
  const dirY = rayWorld.y.toVar();
  const dirZ = max(abs(dot(rayWorld, facadeWorldNormal)), 0.05).toVar();

  // Slab intersection with the far planes of the room box:
  // [-halfW .. +halfW] x [-halfH .. +halfH] x [setback .. setback + depth]
  const halfW = roomW.mul(0.5).toVar();
  const halfH = roomH.mul(0.5).toVar();
  const tFarX = halfW.sub(originX.mul(sign(dirX))).div(max(abs(dirX), 0.0001)).toVar();
  const tFarY = halfH.sub(originY.mul(sign(dirY))).div(max(abs(dirY), 0.0001)).toVar();
  const tFarZ = setback.add(depth).div(dirZ).toVar();
  const t = min(min(tFarX, tFarY), tFarZ).toVar();
  const hit = vec3(originX.add(dirX.mul(t)), originY.add(dirY.mul(t)), dirZ.mul(t)).toVar();

  // Normalized 0..1 coordinates inside the room box (SkyscraperGenerator.js line 1150)
  const q = clamp(
    vec3(
      hit.x.div(roomW).add(0.5),
      hit.y.div(roomH).add(0.5),
      hit.z.sub(setback).div(depth)
    ),
    vec3(0.0),
    vec3(1.0)
  ).toVar();

  const onBack = step(tFarZ, tFarX).mul(step(tFarZ, tFarY)).toVar();
  const isYPlane = step(tFarY, tFarX).mul(step(tFarY, tFarZ)).toVar();
  const onCeil = isYPlane.mul(step(0.0, dirY)).toVar();
  const onFloor = isYPlane.mul(float(1.0).sub(step(0.0, dirY))).toVar();

  // Per-room hashes & bulb temperature (SkyscraperGenerator.js lines 1162-1171)
  const seed1 = hash2D(roomId.add(vec2(seedNode, 19.4))).toVar();
  const seed2 = hash2D(roomId.add(vec2(seedNode.mul(1.9), 83.1))).toVar();
  const seed3 = hash2D(roomId.add(vec2(63.2, seedNode.mul(0.7)))).toVar();
  const lod = smoothstep(0.3, 0.8, max(fwNode.x, fwNode.y)).toVar();
  const litRoom = step(float(1.0).sub(litProbNode), seed3).toVar();
  const lit = mix(litRoom, 1.0, lod).toVar();

  const warmLight = mix(color(0xffb845), color(0xffe49c), seed1);
  const coolLight = mix(color(0xdfe8ff), color(0x9fb6ff), seed2);
  const lightCol = mix(coolLight, warmLight, step(float(1.0).sub(warmthNode), seed2)).toVar();

  // Room shell: muted plaster walls with skirting board, wood floorboards + rug, ceiling lamp, back-wall door & art
  const wallBase = mix(mix(color(0x9a8b73), color(0x6f7a82), seed1), color(0xb9ad97), seed2.mul(0.6)).toVar();
  const wallCol = mix(wallBase, wallBase.mul(0.5), smoothstep(0.06, 0.04, q.y)).toVar();

  const seam = step(0.92, fract(q.x.mul(7.0)));
  const boards = mix(color(0x4a3320), color(0x6a4c30), seed1).mul(float(1.0).sub(seam.mul(0.3)));
  const rug = mix(color(0x7a3b32), color(0x3a5760), seed2);
  const inRug = step(abs(q.x.sub(0.5)), 0.28).mul(step(abs(q.z.sub(0.58)), 0.25));
  const floorCol = mix(boards, rug, inRug.mul(0.88)).toVar();

  const lamp = smoothstep(0.18, 0.11, length(vec2(q.x.sub(0.5), q.z.sub(0.5)))).mul(float(1.0).sub(lod));
  const ceilBase = mix(wallBase, color(0xe8e2d5), 0.28);
  const ceilCol = mix(ceilBase, lightCol.mul(mix(float(0.85), float(3.8), lit)), lamp).toVar();

  const doorX = mix(float(0.24), float(0.76), seed1);
  const doorCol = mix(color(0x5a4631), color(0x39383c), step(0.5, seed2));
  const inDoor = step(abs(q.x.sub(doorX)), 0.09).mul(step(abs(q.y.sub(0.34)), 0.34));
  const picX = mix(float(0.72), float(0.28), step(0.5, seed1));
  const inPicFrame = step(abs(q.x.sub(picX)), 0.085).mul(step(abs(q.y.sub(0.56)), 0.095));
  const inPicCanvas = step(abs(q.x.sub(picX)), 0.065).mul(step(abs(q.y.sub(0.56)), 0.075));
  const picCol = mix(color(0x2c3a4a), color(0x7a5a3a), fract(seed1.add(seed2)));
  const backWithDoor = mix(wallCol, doorCol, inDoor);
  const backWithFrame = mix(backWithDoor, color(0x141210), inPicFrame);
  const backCol = mix(backWithFrame, picCol, inPicCanvas).toVar();

  const shellCol = mix(mix(mix(wallCol, floorCol, onFloor), ceilCol, onCeil), backCol, onBack).toVar();

  // Soft 3D corner ambient occlusion & depth falloff (SkyscraperGenerator.js lines 1176 & 1213-1216)
  const aoX = smoothstep(0.0, 0.16, q.x).mul(smoothstep(0.0, 0.16, float(1.0).sub(q.x))).toVar();
  const aoY = smoothstep(0.0, 0.16, q.y).mul(smoothstep(0.0, 0.16, float(1.0).sub(q.y))).toVar();
  const aoZ = smoothstep(0.0, 0.16, q.z).mul(smoothstep(0.0, 0.16, float(1.0).sub(q.z))).toVar();
  const edgeAO = mix(mix(aoY.mul(aoZ), aoX.mul(aoZ), isYPlane), aoX.mul(aoY), onBack);
  const shellAO = mix(float(0.66), float(1.0), edgeAO);
  const falloff = mix(float(1.0), float(0.42), q.z);
  const shadedRoom = shellCol.mul(shellAO).mul(falloff).toVar();

  // Curtains hung just inside the glass of each window opening (SkyscraperGenerator.js lines 1274-1302)
  // Parallax shift onto the curtain plane behind the glass
  const cUVx = clamp(wUV.x.add(dirX.div(dirZ).mul(0.06)), 0.0, 1.0).toVar();
  const wSeed1 = hash2D(cid.add(vec2(seedNode.mul(0.8), 41.2))).toVar();
  const wSeed2 = hash2D(cid.add(vec2(17.9, seedNode.mul(1.3)))).toVar();

  const sL = smoothstep(0.18, 1.0, wSeed1);
  const sR = smoothstep(0.18, 1.0, wSeed2);
  const lw = sL.mul(sL).mul(0.48); // Left drape width (0..48% of window width)
  const rw = sR.mul(sR).mul(0.48); // Right drape width (0..48% of window width)
  // Drape edges widen to the pixel footprint & pleats fade to their mean shade once they'd shrink below a few pixels
  const cFw = float(drapeFwNode).toVar();
  const drapeAA = cFw.add(0.015).toVar();
  const inLeftDrape = smoothstep(lw.add(drapeAA), lw.sub(drapeAA), cUVx).mul(step(0.03, lw));
  const inRightDrape = smoothstep(float(1.0).sub(rw).sub(drapeAA), float(1.0).sub(rw).add(drapeAA), cUVx).mul(step(0.03, rw));
  const inDrape = mix(clamp(max(inLeftDrape, inRightDrape), 0.0, 1.0), 0.29, lod).toVar(); // 0.29: mean drape coverage

  // Domestic curtain fabric palette (cream, taupe, warm grey, dusty blue, sage green, faded terracotta)
  const pick = fract(seed1.mul(5.7)).mul(5.0);
  const sw0 = mix(color(0xcabfa6), color(0xd8cdb8), seed2);
  const sw1 = mix(color(0x8a7a64), color(0x9b8c72), seed2);
  const sw2 = mix(color(0x5f7079), color(0x6f818b), seed2);
  const sw3 = mix(color(0x6c7558), color(0x79835f), seed2);
  const sw4 = mix(color(0x8c5a44), color(0x9a6a52), seed2);
  const fabric = mix(
    mix(mix(mix(sw0, sw1, step(1.0, pick)), sw2, step(2.0, pick)), sw3, step(3.0, pick)),
    sw4,
    step(4.0, pick)
  );
  const pleatWave = sin(cUVx.mul(48.0).add(wSeed1.mul(6.28))).mul(float(1.0).sub(smoothstep(0.6, 1.6, cFw.mul(48.0))));
  const pleat = pleatWave.mul(0.205).add(0.945);
  const drapeCol = fabric.mul(pleat).mul(0.92).toVar();

  // A drape only transmits a little of the room's glow (0.20), never out-glowing the interior!
  const bestCol = mix(shadedRoom, drapeCol, inDrape);
  const bestEmit = mix(float(1.0), float(0.20), inDrape);
  const roomWarmth = mix(vec3(1.0), lightCol, lit.mul(0.85));
  const finalRoomCol = bestCol.mul(roomWarmth).mul(mix(float(0.85), float(1.35), lit));

  const distantLit = distantWindowLight(vec2(gridU, v.div(fH)), fwNode, litProbNode, seedNode, lod);
  return vec4(finalRoomCol, mix(litRoom, distantLit, lod).mul(bestEmit));
});

// The pixel footprint of the drapes' coordinate behind the glass (`cUVx` above). A derivative needs every pixel round it to take it,
// which a branch doesn't promise (and Firefox has no switch for it), so apartmentInteriorBehind() takes it before its branch.
const interiorDrapeFootprint = Fn(([winUV]) => {
  const rayWorld = normalize(positionWorld.sub(cameraPosition));
  const tSign = mix(sign(facadeWorldNormal.z).negate(), sign(facadeWorldNormal.x), facadeAlongZ);
  const dirX = dot(rayWorld, vec3(facadeWorldNormal.z.negate(), 0.0, facadeWorldNormal.x).mul(tSign));
  const dirZ = max(abs(dot(rayWorld, facadeWorldNormal)), 0.05);
  return fwidth(clamp(vec2(winUV).x.add(dirX.div(dirZ).mul(0.06)), 0.0, 1.0));
});

/**
 * The apartment behind the glass (evaluateApartmentInterior()), worked out only where `coverage` is more than 0: the share of the
 * pixel in the glass, or in the window's opening, that every output weights the room by (or by a mask inside it). Walls, piers,
 * frames, roofs and houses skip it, so no pixel works out a room it then throws away.
 * Its inputs go into variables before the branch, so what the rest of the shader shares with them is built once (what's first built
 * in a branch is built again outside it), and its one derivative is taken there too.
 */
function apartmentInteriorBehind(coverage, uCoord, vCoord, winUV, cellId, winW, floorH, seed, warmth, litProb, fw) {
  const drapeFootprint = interiorDrapeFootprint(winUV);
  return Fn(() => {
    const u = float(uCoord).toVar(), v = float(vCoord).toVar(), wUV = vec2(winUV).toVar(), cid = vec2(cellId).toVar();
    const w = float(winW).toVar(), lit = float(litProb).toVar(), fwv = vec2(fw).toVar(), drapeFw = float(drapeFootprint).toVar();
    const room = vec4(0.0).toVar();
    If(float(coverage).greaterThan(0.0), () => {
      room.assign(evaluateApartmentInterior(u, v, wUV, cid, w, floorH, seed, warmth, lit, fwv, drapeFw));
    });
    return room;
  })();
}

// Street fronts may have shops; courtyard walls have windows and shared lot-line walls are solid masonry. A house has one front, to
// its street, and its other outer walls are sides (js/building-footprints.js).
const WALL_KINDS = { shop: 0, front: 1, rear: 2, lotLine: 3, side: 4, below: 5 }; // below: under the floor, plus metres clear of the ground
// A house's front whose street address says it's one house carries WALL_KINDS.front + this: a front to everything that reads the kind,
// but never cut into a row of terraces (houseWall()). A city wall that isn't to one of its building's address streets is a `side`: no
// entrance (createBuildingEntrance()) and no shopfront (js/building-footprints.js gives it none)
const ONE_HOUSE = 0.125;

/**
 * A footprint wall's kind, and the ground's line over its floor's ground along it (m), from its facadeWall's z: where the ground runs up it
 * over its floor (js/wall-ground.js packKind()) that's -(8 * tenths of a metre + kind + 2), which no kind is; 0 for the line elsewhere.
 * mix() with the flag, never select(): with the flag 0, mix() gives the kind exactly.
 */
function wallKind(z) {
  const packed = step(z, -0.5);
  const raw = z.negate();
  const tenths = floor(raw.mul(0.125));
  return { kind: mix(z, raw.sub(tenths.mul(8.0)).sub(2.0), packed), line: tenths.mul(0.1).mul(packed) };
}

// The house styles' looks (js/house-styles.js look), HOUSE_ROWS rows a style: [bay on the front, on the sides, share of the front's bays
// with a window, of the sides'], then the front's window and the sides' [width, height, sill, panes], then [front's transom, sides',
// frame, door], then [painted walls, garage, terrace, 1]. One table for every house, read with the style a wall carries.
const HOUSE_ROWS = 5;
const HOUSE_PIER = 0.45; // m of wall at each corner of a house before its first window
function houseRows(look) {
  if (!look) return Array.from({ length: HOUSE_ROWS }, () => new THREE.Vector4());
  const [wf, hf, sf, pf, tf] = look.window, [ws, hs, ss, ps, ts] = look.side;
  return [
    new THREE.Vector4(look.bay[0], look.bay[1], look.share[0], look.share[1]),
    new THREE.Vector4(wf, hf, sf, pf),
    new THREE.Vector4(ws, hs, ss, ps),
    new THREE.Vector4(tf, ts, look.frame, look.door),
    new THREE.Vector4(look.painted, look.garage ? 1 : 0, look.terrace ? 1 : 0, 1)
  ];
}
const HOUSE_TABLE = uniformArray(Array.from({ length: 16 }, (_, i) => houseRows(HOUSE_STYLES[i]?.look)).flat(), 'vec4');

/**
 * A wall's counts, from its own attributes: its window bays between the corner piers, its whole-bay offset, and how many
 * entrances (about 28 m apart) and shopfronts (7.5 m) it has. facadeCell() works them out in the vertex stage and passes them
 * flat, so every pixel of a wall has the same ones. Worked out in each pixel from the interpolated width, a wall whose sum came
 * to a half (11.5 m of 2.6 m bays inside 1.2 m piers is 3.5 bays) rounded either way pixel by pixel: two window layouts at once.
 * 0.50005 rounds a half up, as exact arithmetic would, whatever a GPU's division gives; no wall off a half is that near one.
 */
function facadeCounts(box, normal, windowWidth, cornerPier, footprintLocal, wall = null) {
  const nW = abs(normal);
  const wallWidth = footprintLocal ? box.x : mix(box.x, box.z, step(nW.z, nW.x));
  const count = (length, spacing) => max(floor(length.div(spacing).add(0.50005)), 1.0);
  const pier = min(float(cornerPier), wallWidth.mul(0.2));
  const bays = count(cornerPier > 0 ? wallWidth.sub(pier.mul(2.0)) : wallWidth, windowWidth);
  // Whole-bay offset per wall so walls don't repeat each other's windows
  const wallSeed = floor(box.w.add(dot(normal, vec3(17.0, 0.0, 37.0))));
  const city = vec4(bays, wallSeed, count(wallWidth, 28.0), count(wallWidth, 7.5));
  if (!wall) return city;
  // A house's wall has its own (houseWall()): its seed carries its style, 1000 times it, which no other building's reaches
  return Fn(() => {
    const counts = vec4(city).toVar();
    If(box.w.greaterThanEqual(1000.0), () => { counts.assign(houseWall(box, wall, normal)); });
    return counts;
  })();
}

const TERRACE_HOUSE = 5.5; // m: a row of terraces is cut into houses of its front's length over the nearest whole number of these

/**
 * A house's wall, worked out once in the vertex stage (facadeCounts()) so every pixel of it has the same: [its window bays, between
 * HOUSE_PIER at each end, at its style's spacing for a front or a side; its whole-bay offset; its windows' width (m); and the bay of
 * its door + 1, + 64 times the first of its garage door's two bays + 1, + 4096 times its style, + 65536 on a row of terraces]. A wall
 * with no door or garage has 0 for it. Whether each bay has a window is a hash of the bay and these (houseLayout()), so that's the same
 * in every pixel of it too.
 * A terrace's front long enough for two houses or more of TERRACE_HOUSE is a row of them (the map draws many rows as one footprint): two
 * bays a house, a door in one and a window in the other downstairs, and in place of a door's bay, which of each house's bays has its
 * door (rowDoor()) + 1. Not where its kind says it's one house (ONE_HOUSE).
 * `wall`: the facadeWall attribute (its kind in z); `table`: HOUSE_TABLE.
 */
function houseWall(box, wall, normal, table = HOUSE_TABLE) {
  const style = floor(box.w.mul(0.001));
  const row = (k) => table.element(style.mul(HOUSE_ROWS).add(k).toInt());
  const spacing = row(0), front = row(1), side = row(2), kinds = row(4);
  const seed = box.w.sub(style.mul(1000.0));
  const wallSeed = floor(seed.add(dot(normal, vec3(17.0, 0.0, 37.0))));
  const isFront = step(abs(wall.z.sub(WALL_KINDS.front)), 0.25);
  const pier = min(float(HOUSE_PIER), box.x.mul(0.2));
  const houses = max(floor(box.x.div(TERRACE_HOUSE).add(0.50005)), 1.0);
  // ...not on a front of one house (ONE_HOUSE)
  const oneHouse = step(ONE_HOUSE * 0.5, abs(wall.z.sub(WALL_KINDS.front)));
  const terraces = kinds.z.mul(isFront).mul(step(1.5, houses)).mul(float(1.0).sub(oneHouse));
  const bays = mix(max(floor(box.x.sub(pier.mul(2.0)).div(mix(spacing.y, spacing.x, isFront)).add(0.50005)), 1.0), houses.mul(2.0), terraces);
  const last = bays.sub(1.0);
  // The house's own choices, the same on each of its walls. Where its door and garage door go is from the bits of its digits, exactly:
  // the game works out the same on the CPU for its driveway and path (js/house-entry.js), which a hash through sin() wouldn't let it,
  // as each GPU rounds sin() of a large number its own way. h1: its low six bits, h2: its seventh, as 0.25 or 0.75.
  const house = floor(seed);
  const h1 = fract(house.mul(0.015625)).add(0.0078125), h2 = fract(floor(house.mul(0.015625)).mul(0.5)).add(0.25);
  const h3 = hash2D(vec2(house, 3.3));
  // A double garage door two bays wide at one end of a project home's front, with its door beside it
  const garage = kinds.y.mul(step(2.5, bays)).mul(isFront);
  const garageAt = mix(last.sub(1.0), 0.0, step(h2, 0.5));
  const byGarage = mix(last.sub(2.0), 2.0, step(h2, 0.5));
  // Otherwise at one end of a terrace or a front of two bays; on a wider front in the middle, the second bay or the second last
  const end = mix(last, 0.0, step(h1, 0.5));
  const middle = floor(last.mul(0.5).add(step(0.5, h2).mul(0.5)));
  const inner = mix(mix(middle, 1.0, step(0.45, h1)), last.sub(1.0), step(0.725, h1));
  const door = mix(mix(end, inner, step(2.5, bays).mul(float(1.0).sub(kinds.z))), byGarage, garage);
  // A row's houses: the first's door in its second bay or its first (h1), and the rest the same, or each the other way to the last (h2)
  const pattern = step(0.5, h1).add(step(0.5, h2).mul(2.0));
  const doorField = mix(min(door, 62.0), pattern, terraces).add(1.0).mul(isFront);
  const garageField = min(garageAt, 62.0).add(1.0).mul(garage);
  // Some houses' windows a little narrower than their style's
  const width = mix(side.x, front.x, isFront).mul(mix(1.0, 0.85, step(0.7, h3)));
  return vec4(bays, wallSeed, width, doorField.add(garageField.mul(64.0)).add(style.mul(4096.0)).add(terraces.mul(65536.0)));
}

/**
 * On a row of terraces (houseWall()), the bay of the door of the house a bay is in: two bays a house, from the wall's start; `pattern`,
 * the row's: + 1 where the first house's door is in its second bay, + 2 where each house's is the other way to the last's.
 */
function rowDoor(slot, pattern) {
  const unit = floor(slot.mul(0.5));
  const first = pattern.sub(floor(pattern.mul(0.5)).mul(2.0));
  const mirrored = floor(pattern.mul(0.5));
  const odd = unit.sub(floor(unit.mul(0.5)).mul(2.0));
  return unit.mul(2.0).add(mix(first, abs(odd.sub(first)), mirrored));
}

/**
 * Shared facade coordinates and masks. World-space by default; createFacadeBoxes and createBuildingFootprints
 * supply wall dimensions to fit whole window bays between the corners. `cornerPier` reserves solid masonry
 * at each end above the ground-floor shops. Partial storeys and the coping remain solid at each wall's top.
 */
// groundWindows: 1 where the ground floor has windows like the rest, as a house's does, rather than a shopfront or a plain base.
// houses: the material draws houses too (createPreWarBuildingMaterial), whose walls carry their style: `house` is then their layout,
// and null otherwise.
function facadeCell(windowWidth, floorHeight, boxLocal, cornerPier = 0, footprintLocal = false, groundWindows = float(0.0), houses = false) {
  // Local walls use geometry normals; world-space walls use the stable facade frame.
  const nWall = boxLocal ? normalGeometry : facadeWorldNormal;
  const nW = abs(nWall);
  const isRoof = step(0.75, nW.y);
  const alongZ = boxLocal ? step(nW.z, nW.x) : facadeAlongZ;
  let uCoord = mix(patternXZ.x, patternXZ.y, alongZ);
  let bayWidth = float(windowWidth);
  let gridU = uCoord.div(bayWidth);
  let inPier = float(0.0);
  let kind = float(WALL_KINDS.front);
  let line = float(0.0);
  let tone = float(0.5);
  let wallS = float(0.0);
  let wallW = float(1.0);
  let wallH = float(1.0);
  let exposedHeight = float(1.0);
  let fromTop = float(0.0);
  let boxSeed = float(0.0);
  let entrances = float(1.0);
  let shopfronts = float(1.0);
  let house = null;
  let wallSeed = float(0.0);
  let alongM = float(0.0);
  let pier = float(0.0);

  if (boxLocal) {
    const box = attribute('box', 'vec4'); // width, height, depth (exposed height for footprints), seed + tone
    // Merged footprints carry normalized distance along each wall, metres below its top, and its WALL_KINDS treatment.
    const wall = footprintLocal ? attribute('facadeWall', 'vec3') : null;
    const wallWidth = footprintLocal ? box.x : mix(box.x, box.z, alongZ);
    if (footprintLocal) ({ kind, line } = wallKind(wall.z));
    // The seed's fraction (0.1..0.9, never near an integer so floor() is stable on inexact varyings) is the tone
    tone = fract(box.w).sub(0.1).div(0.8);
    boxSeed = floor(box.w);
    const withHouses = houses && footprintLocal;
    const counts = varying(facadeCounts(box, normalGeometry, windowWidth, cornerPier, footprintLocal, withHouses ? vec3(wall.x, wall.y, kind) : null), 'vFacadeCounts')
      .setInterpolation(THREE.InterpolationSamplingType.FLAT, THREE.InterpolationSamplingMode.EITHER);
    wallSeed = counts.y;
    entrances = counts.z;
    shopfronts = counts.w;
    if (withHouses) {
      // A house's own counts (houseWall()): its style in the last, which no other wall's shopfronts reach, and whether it's a row
      const terraces = floor(counts.w.div(65536.0));
      const packed = counts.w.sub(terraces.mul(65536.0));
      const style = floor(packed.div(4096.0));
      const is = style.greaterThan(0.5);
      const rest = packed.sub(style.mul(4096.0));
      const garageField = floor(rest.div(64.0));
      house = { is, isF: step(0.5, style), style, width: counts.z, door: rest.sub(garageField.mul(64.0)).sub(1.0), garage: garageField.sub(1.0),
        terraces, bays: counts.x };
      // Its own seed, the style taken off; and no shops or entrances of a city building's
      // (mix() with the flag rather than select(): a select is a branch, and what's built in a branch is built again for each later use.
      // With the flag 0, mix() gives the other value exactly.)
      boxSeed = mix(boxSeed, boxSeed.sub(style.mul(1000.0)), house.isF);
      entrances = mix(entrances, float(1.0), house.isF);
      shopfronts = mix(shopfronts, float(1.0), house.isF);
    }
    const along = footprintLocal ? wall.x : mix(positionGeometry.x, positionGeometry.z, alongZ).add(0.5); // 0..1 along the wall
    wallW = wallWidth;
    // Read painted signs left to right when facing the wall.
    const flip = mix(step(nWall.z, 0.0), step(0.0, nWall.x), alongZ);
    wallS = mix(along, float(1.0).sub(along), flip).mul(wallWidth);
    wallH = box.y;
    exposedHeight = footprintLocal ? box.z : box.y;
    fromTop = footprintLocal ? wall.y : float(0.5).sub(positionGeometry.y).mul(box.y);
    const bays = counts.x;
    if (cornerPier > 0) {
      pier = min(float(cornerPier), wallWidth.mul(0.2));
      if (house) pier = mix(pier, min(float(HOUSE_PIER), wallWidth.mul(0.2)), house.isF);
      const inner = wallWidth.sub(pier.mul(2.0));
      const s = along.mul(wallWidth); // metres from the wall's corner
      alongM = s;
      bayWidth = inner.div(bays);
      gridU = s.sub(pier).div(bayWidth).add(wallSeed);
      inPier = float(1.0).sub(step(pier, s).mul(step(s, wallWidth.sub(pier))));
    } else {
      alongM = along.mul(wallWidth);
      bayWidth = wallWidth.div(bays);
      gridU = along.mul(bays).add(wallSeed);
    }
    uCoord = gridU.mul(bayWidth);
  }

  // Footprints measure from the building's own floor, wherever on the hills it stands. 0.22 is the kerb's height, where
  // a wall on the flat would start, and what the storefront and entrance dimensions are written against.
  const vCoord = footprintLocal ? wallH.sub(fromTop).add(0.22) : positionWorld.y;
  const gridV = vCoord.div(floorHeight);
  const cellId = vec2(floor(gridU), floor(gridV));
  const cellUV = vec2(fract(gridU), fract(gridV));
  const fw = vec2(fwidth(gridU), fwidth(gridV));

  // Ground floor is strictly floor index 0 (gridV < 1.0) so floor 1 is never sliced in half!
  const floor0 = float(1.0).sub(step(1.0, gridV)).mul(step(0.0, gridV));
  const wall = float(1.0).sub(isRoof);
  const isGroundFloor = floor0.mul(float(1.0).sub(step(WALL_KINDS.shop + 0.5, kind)));
  // Below the floor: stone, except a whole storey of windows where the wall stands that far clear of the ground
  const belowFloor = step(WALL_KINDS.below - 0.5, kind);
  // A house's sides (WALL_KINDS.side) are neither
  const notSide = float(1.0).sub(step(WALL_KINDS.side - 0.5, kind));
  const blank = step(WALL_KINDS.lotLine - 0.5, kind).mul(notSide).mul(wall);
  const back = step(WALL_KINDS.rear - 0.5, kind).mul(notSide).mul(wall);
  const baseWall = floor0.sub(isGroundFloor).mul(float(1.0).sub(back)).mul(wall).mul(float(1.0).sub(groundWindows));
  const clearOfGround = kind.sub(WALL_KINDS.below);
  const rowBase = floor(gridV).mul(floorHeight);
  const lowerWindows = belowFloor.mul(step(rowBase, -0.01)).mul(step(float(0.4).sub(clearOfGround), rowBase));
  let plinth = belowFloor.mul(float(1.0).sub(lowerWindows));
  // Where the ground runs up the wall over its floor (js/wall-ground.js): no window whose sill is under it plus WINDOW_CLEAR, a city
  // wall's lowest at CITY_SILL over its storey's floor; and no shopfront where it's over the wall's foot by more than WINDOW_CLEAR (a shop's
  // wall comes in pieces a shopfront long: js/building-footprints.js)
  const underGround = (sill) => step(rowBase.add(sill), line.add(WINDOW_CLEAR)).mul(step(0.05, line)).mul(wall);
  const buriedRow = mix(underGround(CITY_SILL), step(0.22 + WINDOW_CLEAR, line).mul(wall), isGroundFloor);
  // A box that isn't a whole number of storeys (landmark tiers) ends in a solid parapet instead of slicing a row of
  // windows, and starts with one above the roof it stands on; every wall is capped by a coping at its top
  let partial = float(0.0);
  let coping = float(0.0);
  if (boxLocal) {
    const top = vCoord.add(fromTop);
    const floorBase = floor(gridV).mul(floorHeight);
    const belowTop = step(floorBase.add(floorHeight), top.add(0.05));
    // Surveyed walls start at the sidewalk; only stacked boxes need a bottom cutoff.
    const whole = footprintLocal ? belowTop : step(top.sub(wallH).sub(0.05), floorBase).mul(belowTop);
    partial = float(1.0).sub(whole).mul(wall);
    // (not up a gable end, which is above the wall's top: js/building-footprints.js)
    coping = float(1.0).sub(step(0.32, fromTop)).mul(step(-0.05, fromTop)).mul(wall);
  }
  const solid = max(max(max(inPier.mul(float(1.0).sub(isGroundFloor)), blank), max(partial, baseWall)), max(plinth, buriedRow));
  let wallSolid = solid;
  if (house) {
    // On a row of terraces, the door of the house this bay is in
    house.door = mix(house.door, rowDoor(cellId.x.sub(wallSeed), house.door), house.terraces);
    Object.assign(house, houseLayout(house, cellId.x.sub(wallSeed), cellId.y, kind, wallSeed));
    // ...and none under the ground, at its style's sill (js/wall-ground.js)
    house.window = house.window.mul(float(1.0).sub(underGround(mix(house.rows[2].z, house.rows[1].z, house.front).add(0.22))));
    house.wallSeed = wallSeed;
    house.along = alongM;
    house.pier = pier;
    // A house's bays without a window are wall; under its floor it stands on stone, with no storey of windows in it; and it has no
    // coping of a city building's
    wallSolid = mix(solid, max(max(max(inPier, blank), partial), max(belowFloor, float(1.0).sub(house.window))), house.isF);
    plinth = mix(plinth, belowFloor, house.isF);
    coping = mix(coping, float(0.0), house.isF);
  }
  return {
    isRoof, uCoord, vCoord, gridV, cellId, cellUV, fw, bayWidth, isGroundFloor, solid: wallSolid, back, blank, tone,
    wallS, wallW, wallH, exposedHeight, fromTop, boxSeed, partial, coping, kind, line, plinth, entrances, shopfronts, house
  };
}

/**
 * Which of a house's bays have a window, from its wall's flat counts (houseWall()) and the bay's own number, so every pixel of a bay
 * agrees: the front's bays beside its door always, and any bay by a hash at its style's share for a front or a side; on a row of
 * terraces, every bay. On the ground floor, not its door's bay or its garage door's two; upstairs, over its door too. `slot`: the bay,
 * from 0 at the wall's start; `storey` from 0. { window (0 or 1), front (1 on its front), rows: the style's rows of HOUSE_TABLE }
 */
function houseLayout({ style, door, garage, terraces }, slot, storey, kind, wallSeed, table = HOUSE_TABLE) {
  const row = (k) => table.element(style.mul(HOUSE_ROWS).add(k).toInt());
  const rows = [row(0), row(1), row(2), row(3), row(4)];
  const front = step(abs(kind.sub(WALL_KINDS.front)), 0.25);
  const share = mix(rows[0].w, rows[0].z, front);
  const besideDoor = step(abs(abs(slot.sub(door)).sub(1.0)), 0.25).mul(step(-0.5, door));
  const chance = step(hash2D(vec2(slot.add(5.3), wallSeed.add(13.7))), share);
  const doorBay = step(abs(slot.sub(door)), 0.25);
  const garageBay = step(-0.5, garage).mul(step(garage.sub(0.25), slot)).mul(step(slot, garage.add(1.25)));
  const ground = float(1.0).sub(step(0.5, storey));
  const any = max(max(besideDoor, chance), terraces);
  const window = mix(max(any, doorBay), any.mul(float(1.0).sub(max(doorBay, garageBay))), ground);
  return { window, front, rows, doorBay, garageBay };
}

let _storefrontSignTexture;

function getStorefrontSignTexture() {
  if (_storefrontSignTexture) return _storefrontSignTexture;
  const labels = ['NEWSAGENT', 'COFFEE & BAKERY', 'BOOKS & RECORDS', 'CHEMIST',
    'DRY CLEANERS', 'FLORIST', 'HARDWARE', 'BOTTLE SHOP'];
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.font = '600 32px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  labels.forEach((label, i) => ctx.fillText(label, 256, i * 64 + 32, 464));
  _storefrontSignTexture = new THREE.CanvasTexture(canvas);
  return _storefrontSignTexture;
}

// The stone a building stands on where the ground falls away below its floor: coursed blocks, each a little different
function plinthStone({ uCoord, vCoord }) {
  const rows = vCoord.div(0.62);
  const row = floor(rows);
  const cols = uCoord.div(1.3).add(mod(row, 2.0).mul(0.5));
  const joints = max(gridLine(cols.mul(1.3), 1.3, 0.022), gridLine(vCoord, 0.62, 0.022));
  const blocks = hash2D(vec2(floor(cols), row)).sub(0.5).mul(float(1.0).sub(smoothstep(0.5, 1.0, fwidth(rows))));
  return mix(color(0xb9a27c).mul(blocks.mul(0.16).add(1.0)), color(0x75644a), joints);
}

// Shops span several upstairs bays; every material output shares their glazing and door layout.
function createStorefront(facade, seed, local) {
  const { wallS, wallW, boxSeed, uCoord, vCoord, isGroundFloor, isRoof, solid, coping, shopfronts } = facade;
  const width = local ? wallW.div(shopfronts) : float(7.5);
  const horizontal = local ? wallS : uCoord.mul(mix(sign(facadeWorldNormal.z), sign(facadeWorldNormal.x).negate(), facadeAlongZ));
  const grid = horizontal.div(width);
  const x = fract(grid).mul(width), y = vCoord;
  const fw = vec2(fwidth(grid).mul(width), fwidth(y)).toVar();
  const mask = isGroundFloor.mul(float(1).sub(max(max(solid, isRoof), coping))).mul(step(2.4, width));
  const id = vec2(floor(grid), boxSeed.add(seed));
  const choice = hash2D(id.add(vec2(3.1, 17.2)));
  const lit = step(0.28, hash2D(id.add(vec2(37.1, 9.8))));
  const band = (p, a, b, w) => boxCoverage(p, a, b, w.mul(0.5));
  const doorX = mix(float(0.24), width.sub(1.36), step(0.5, choice));
  const door = band(x, doorX, doorX.add(1.12), fw.x);
  const doorPane = band(x, doorX.add(0.06), doorX.add(1.06), fw.x).mul(band(y, 0.32, 2.42, fw.y));
  const display = band(x, 0.18, width.sub(0.18), fw.x).mul(band(y, 0.58, 2.88, fw.y));
  const transom = band(y, 2.46, 2.52, fw.y);
  const glass = max(display.mul(float(1).sub(max(door, transom))), doorPane)
    .add(display.mul(door).mul(band(y, 2.52, 2.88, fw.y))).clamp(0, 1);
  const handle = band(x, doorX.add(0.85), doorX.add(0.89), fw.x).mul(band(y, 1.05, 1.46, fw.y));
  const kickplate = door.mul(band(y, 0.23, 0.32, fw.y));
  const metal = max(handle, kickplate);
  const glazing = glass.mul(float(1).sub(handle));
  const paint = mix(mix(color(0x263831), color(0x463b30), step(0.38, choice)), color(0x242a32), step(0.72, choice));
  const signWidth = min(width.mul(0.82), 5.5);
  const signUV = vec2(x.sub(width.mul(0.5)).div(signWidth).add(0.5), y.sub(2.96).div(0.6));
  const signLod = log2(max(fw.x.mul(512).div(signWidth), fw.y.mul(64 / 0.6)));
  const signMask = band(signUV.x, 0, 1, fw.x.div(signWidth))
    .mul(band(signUV.y, 0, 1, fw.y.div(0.6))).mul(float(1).sub(smoothstep(4, 6, signLod)));
  const signInk = Fn(() => {
    const ink = float(0).toVar();
    If(mask.mul(signMask).greaterThan(0.001), () => {
      const atlasUV = vec2(signUV.x.clamp(0, 1), float(1).sub(floor(choice.mul(8)).add(float(1).sub(signUV.y.clamp(0, 1))).div(8)));
      ink.assign(texture(getStorefrontSignTexture(), atlasUV).level(signLod.clamp(0, 5)).a.mul(signMask));
    });
    return ink;
  })().toVar();
  const frame = mix(mix(paint, color(0x92958d), metal), color(0xe0d7bb), signInk);

  const interior = Fn(() => {
    const result = vec4(0).toVar();
    If(mask.greaterThan(0.001), () => {
      const light = mix(color(0xffd49a), color(0xe0edee), step(0.58, choice));
      const room = color(0x343330).toVar();
      const fixture = float(0).toVar();
      // Fine displays disappear before becoming subpixel; distant shops keep their average light level.
      const detail = float(1).sub(smoothstep(0.06, 0.20, max(fw.x, fw.y)));
      If(detail.greaterThan(0.001).and(glazing.greaterThan(0.001)), () => {
        const ray = positionWorld.sub(cameraPosition);
        const normal = facadeWorldNormal;
        const inward = max(abs(dot(ray, normal)), 0.1);
        const dx = dot(ray, vec3(normal.z, 0, normal.x.negate())).div(inward);
        const dy = ray.y.div(inward);
        const ox = x.sub(width.mul(0.5)), oy = y.sub(1.55);
        const tx = width.mul(0.5).sub(ox.mul(sign(dx))).div(max(abs(dx), 0.001));
        const ty = float(1.55).sub(oy.mul(sign(dy))).div(max(abs(dy), 0.001));
        const depth = min(min(tx, ty), 3.6);
        const px = x.add(dx.mul(depth)), py = y.add(dy.mul(depth));
        const onSide = step(tx, min(ty, 3.6));
        const onHorizontal = step(ty, min(tx, 3.6));
        const ceiling = onHorizontal.mul(step(0, dy));
        const floorMask = onHorizontal.mul(float(1).sub(step(0, dy)));
        const back = float(1).sub(max(onSide, onHorizontal));
        const roomFw = fw.mul(float(1).add(float(3.6).div(inward)));
        const shelfY = py.div(0.55);
        const shelves = filteredPulse(fract(shelfY), 0.05, 0.13, roomFw.y.div(0.55))
          .mul(band(py, 0.5, 2.3, roomFw.y)).mul(band(px, 0.3, width.sub(0.3), roomFw.x)).mul(back);
        const goodsX = px.div(0.28);
        const goodsSeed = hash2D(vec2(floor(goodsX), floor(shelfY)).add(choice.mul(31)));
        const goods = filteredPulse(fract(goodsX), 0.12, 0.88, roomFw.x.div(0.28))
          .mul(filteredPulse(fract(shelfY), 0.14, goodsSeed.mul(0.28).add(0.5), roomFw.y.div(0.55)))
          .mul(band(py, 0.5, 2.3, roomFw.y)).mul(back).mul(step(0.3, choice));
        const wall = mix(color(0x716557), color(0x596462), choice);
        const shell = mix(mix(wall, color(0x33302b), floorMask), color(0x9b9689), ceiling);
        const stock = mix(color(0x88654a), color(0x617b80), goodsSeed);
        const stocked = mix(mix(shell, stock, goods), color(0x30251b), shelves);
        // A counter sits nearer the glass than the rear shelves, so they shift at different rates as we pass.
        const displayX = x.add(dx.mul(1.3)), displayY = y.add(dy.mul(1.3));
        const counter = band(displayY, 0.65, 1.10, fw.y.mul(1.5))
          .mul(band(displayX, 0.2, width.sub(0.2), fw.x.mul(1.5))).mul(step(1.3, depth)).mul(float(1).sub(door));
        const furnished = mix(stocked, color(0x453a2d), counter.mul(0.82));
        const edgeShade = smoothstep(0, 0.5, min(px, width.sub(px))).mul(0.35).add(0.65);
        room.assign(mix(room, furnished.mul(edgeShade).mul(mix(0.58, 1, lit)), detail));
        const lamp = band(px, width.mul(0.18), width.mul(0.82), roomFw.x)
          .mul(band(depth, 0.65, 0.82, roomFw.y)).mul(ceiling);
        const backLight = band(py, 2.45, 2.52, roomFw.y).mul(back)
          .mul(band(px, 0.5, width.sub(0.5), roomFw.x));
        fixture.assign(max(lamp, backLight).mul(detail));
      });
      const view = normalize(cameraPosition.sub(positionWorld));
      const fresnel = pow(clamp(float(1).sub(abs(dot(view, facadeWorldNormal))), 0, 1), 2);
      const glassColor = mix(room.mul(light).mul(mix(0.35, 0.95, lit)), cityUniforms.uSkyHorizonColor, fresnel.mul(0.65).add(0.10));
      result.assign(vec4(mix(glassColor, light, fixture.mul(lit)), lit.mul(float(0.55).add(fixture.mul(2.2))).mul(float(1).sub(fresnel.mul(0.8)))));
    });
    return result;
  })().toVar();

  return {
    mask,
    color: mix(frame, interior.rgb, glazing),
    emissive: interior.rgb.mul(interior.a).mul(glazing).add(color(0xe0d7bb).mul(signInk).mul(lit).mul(0.12)).mul(cityUniforms.uInteriorGlow),
    roughness: mix(float(0.58), float(0.14).add(float(1).sub(smoothstep(0.3, 0.9, y)).mul(0.16)), glazing),
    relief: float(1).sub(glazing).mul(0.008).add(handle.mul(0.004))
  };
}

// Entrances share the facade surface, including its lighting, shadows and distance filtering.
function createBuildingEntrance(facade, trim, local, modern = false) {
  const { wallS, wallW, wallH, fromTop, boxSeed, uCoord, vCoord, back, isRoof, coping, kind, line, entrances } = facade;
  const width = local ? wallW.div(entrances) : float(28);
  const horizontal = local ? wallS : uCoord.mul(mix(sign(facadeWorldNormal.z), sign(facadeWorldNormal.x).negate(), facadeAlongZ));
  const grid = horizontal.div(width);
  const x = fract(grid).sub(0.5).mul(width), y = vCoord.sub(0.22);
  const fw = vec2(fwidth(horizontal), fwidth(vCoord)).toVar();
  const band = (p, a, b, w) => boxCoverage(p, a, b, w.mul(0.5));
  const doubleDoor = step(modern ? 5 : 18, width);
  const halfWidth = min(mix(0.56, 0.95, doubleDoor), width.mul(0.5).sub(0.28));
  const height = local ? min(2.48, vCoord.add(fromTop).sub(0.74)) : float(2.48);
  const grounded = local ? float(1).sub(step(0.35, vCoord.add(fromTop).sub(wallH))) : float(1);
  const mask = band(x, halfWidth.add(0.20).negate(), halfWidth.add(0.20), fw.x)
    .mul(band(y, 0, height.add(0.20), fw.y)).mul(grounded).mul(step(WALL_KINDS.shop + 0.5, kind))
    .mul(float(1).sub(step(abs(kind.sub(WALL_KINDS.side)), 0.25)))
    .mul(float(1).sub(max(max(back, isRoof), coping))).mul(step(1.3, width)).mul(step(1.7, height))
    // ...nor where the ground runs over its foot by more than WINDOW_CLEAR (js/wall-ground.js)
    .mul(float(1).sub(step(0.22 + WINDOW_CLEAR, line))).toVar();
  const recess = band(x, halfWidth.add(0.07).negate(), halfWidth.add(0.07), fw.x)
    .mul(band(y, 0.06, height.add(0.07), fw.y));
  const leaf = band(x, halfWidth.negate(), halfWidth, fw.x).mul(band(y, 0.10, height, fw.y));
  const leafX = mix(x, abs(x).sub(halfWidth.mul(0.5)), doubleDoor);
  const leafWidth = mix(halfWidth, halfWidth.mul(0.5), doubleDoor);
  const inset = band(leafX, leafWidth.sub(0.10).negate(), leafWidth.sub(0.10), fw.x);
  const glass = inset.mul(band(y, height.mul(0.48), height.sub(0.16), fw.y)).mul(leaf);
  const panel = inset.mul(band(y, 0.25, height.mul(0.40), fw.y)).mul(leaf);
  const handleX = mix(halfWidth.sub(0.13), float(0.12), doubleDoor);
  const handle = band(mix(x, abs(x), doubleDoor), handleX.sub(0.02), handleX.add(0.02), fw.x)
    .mul(band(y, 0.98, 1.34, fw.y)).mul(leaf);
  const seam = band(x, -0.018, 0.018, fw.x).mul(doubleDoor).mul(leaf);
  const glazing = glass.mul(float(1).sub(max(handle, seam)));
  const colorNode = Fn(() => {
    const result = vec3(0).toVar();
    If(mask.greaterThan(0.001), () => {
      const choice = hash2D(vec2(boxSeed, floor(grid)));
      const paint = modern ? color(0x282d32) : mix(color(0x49372a), color(0x263d33), step(0.5, choice));
      const door = mix(mix(paint, paint.mul(0.62), panel), color(0x14191c), seam);
      const view = normalize(cameraPosition.sub(positionWorld));
      const fresnel = pow(float(1).sub(abs(dot(view, facadeWorldNormal))).clamp(0, 1), 2);
      const glassColor = mix(color(0x23302c), cityUniforms.uSkyHorizonColor, fresnel.mul(0.5).add(0.10));
      const doorColor = mix(mix(door, glassColor, glazing), color(0xa6a69b), handle);
      result.assign(mix(mix(trim.mul(0.85), color(0x101515), recess), doorColor, leaf));
    });
    return result;
  })();
  return {
    mask,
    color: colorNode,
    emissive: color(0xffd6a0).mul(glazing).mul(0.09).mul(cityUniforms.uInteriorGlow),
    roughness: mix(mix(0.72, 0.43, leaf), 0.16, max(glazing, handle)),
    relief: recess.mul(-0.025).add(leaf.mul(0.009)).sub(panel.mul(0.004)).add(handle.mul(0.012))
  };
}

/**
 * Curtain-Wall Glass Skyscraper TSL Material
 * Features:
 * - Mikkelsen `bumpNormal` 3D Mullion Relief & Per-Pane Thermal Glass Warble
 * - Interior mapping for apartments and ground-floor shops
 * - Urban Canyon Global Illumination (`aoNode` + warm bounce)
 */
function createCurtainWallMaterial(opts = {}) {
  const {
    glassTint = 0x162c42,
    frameTint = 0x26323e,
    windowWidth = 2.8,
    floorHeight = 3.8,
    mullionThickness = 0.075,
    spandrelRatio = 0.20,
    litProbability = 0.36,
    warmth = 0.62,
    reflectivity = 0.92,
    seed = 1.0,
    boxLocal = false,
    footprintLocal = false
  } = opts;

  const cacheKey = `${glassTint}_${frameTint}_${windowWidth}_${floorHeight}_${litProbability}_${warmth}_${reflectivity}_${seed}_${boxLocal}_${footprintLocal}`;
  if (_curtainWallCache.has(cacheKey)) {
    return _curtainWallCache.get(cacheKey);
  }

  const mat = new THREE.MeshStandardNodeMaterial({
    metalness: 0.72,
    roughness: 0.12
  });

  // The style's parameters are uniforms (not baked-in constants), so every curtain-wall style compiles to one shader
  const cGlass = uniform(new THREE.Color(glassTint));
  const cFrame = uniform(new THREE.Color(frameTint));
  const uWindowWidth = uniform(windowWidth);
  const uFloorHeight = uniform(floorHeight);
  const uLitProbability = uniform(litProbability);
  const uWarmth = uniform(warmth);
  const uReflectivity = uniform(reflectivity);
  const uSeed = uniform(seed);
  const cCanyonBounce = color(0xe89c68);

  // The facade cell and the apartment behind each pane are built once and shared by every output below, so the
  // shader carries a single copy of them (and evaluates the interior mapping once per pixel)
  const facade = facadeCell(uWindowWidth, uFloorHeight, boxLocal || footprintLocal, 0, footprintLocal);
  const { isRoof, uCoord, vCoord, gridV, cellId, cellUV, fw, bayWidth, solid, coping } = facade;
  mat.aoNode = canyonSkyAONode(vCoord);
  // Pane UV inside the mullions and spandrel.
  const winUV = clamp(
    vec2(
      cellUV.x.sub(mullionThickness).div(max(0.01, 1.0 - 2.0 * mullionThickness)),
      cellUV.y.sub(spandrelRatio).div(max(0.01, 1.0 - spandrelRatio - mullionThickness))
    ),
    vec2(0.0),
    vec2(1.0)
  );
  const floorIdx = floor(gridV);
  const isMechFloor = float(1.0).sub(step(1.0, mod(floorIdx.add(uSeed), 16.0))).mul(step(4.0, floorIdx));
  // Solid walls and coping have no glazing.
  const isGlassPane = filteredPulse(cellUV.x, mullionThickness * 0.5, 1.0 - mullionThickness * 0.5, fw.x)
    .mul(filteredPulse(cellUV.y, spandrelRatio + 0.015, 1.0 - mullionThickness * 0.5, fw.y))
    .mul(float(1.0).sub(isRoof)).mul(float(1.0).sub(solid)).mul(float(1.0).sub(coping));
  // The room shows only through the glass, and not on a mechanical floor's louvres: the glow's pane mask lies inside that too
  const aptRoom = apartmentInteriorBehind(isGlassPane.mul(float(1.0).sub(isMechFloor)), uCoord, vCoord, winUV, cellId, bayWidth,
    uFloorHeight, uSeed, uWarmth, uLitProbability.mul(0.65), fw);
  const storefront = createStorefront(facade, uSeed, boxLocal || footprintLocal);
  const entrance = createBuildingEntrance(facade, cFrame, boxLocal || footprintLocal, true);

  mat.colorNode = Fn(() => {
    const louverStripes = sin(vCoord.mul(22.0)).mul(0.5).add(0.5);

    // Per-Pane Thermal/Wind Glass Warble & Pillow Distortion
    const paneRandX = hash2D(cellId.add(vec2(uSeed, 3.7))).sub(0.5);
    const paneRandY = hash2D(cellId.add(vec2(11.3, uSeed))).sub(0.5);
    const pillowBowX = cellUV.x.sub(0.5).mul(0.11).add(paneRandX.mul(0.09));
    const pillowBowY = cellUV.y.sub(0.55).mul(0.11).add(paneRandY.mul(0.09));

    const sunDir = normalize(cityUniforms.uSkySunDir);
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const nPane = normalize(normalWorldGeometry.add(vec3(pillowBowX, pillowBowY, pillowBowX.negate())));
    const reflectDir = reflect(viewDir.negate(), nPane);

    const fresnel = pow(clamp(float(1.0).sub(abs(dot(viewDir, nPane))), 0.0, 1.0), 2.1);
    const reflectElev = clamp(reflectDir.y.mul(0.65).add(0.38), 0.0, 1.0);

    // Reflected neighbouring towers' silhouette, its edge & window grid filtered by their screen footprint
    const refAzimuth = uCoord.mul(0.045).add(reflectDir.x.mul(3.8)).add(reflectDir.z.mul(3.8));
    const neighborTowerH = hash2D(vec2(floor(refAzimuth.mul(2.4)), uSeed)).mul(0.46).add(0.16);
    const elevAA = fwidth(reflectElev).add(0.004);
    const inReflectedTower = smoothstep(neighborTowerH.add(elevAA), neighborTowerH.sub(elevAA), reflectElev);
    const refCols = refAzimuth.mul(15.0);
    const refRows = reflectElev.mul(30.0);
    const refWinGrid = filteredPulse(fract(refCols), 0.32, 1.0, fwidth(refCols))
      .mul(filteredPulse(fract(refRows), 0.32, 1.0, fwidth(refRows)));
    const reflectedBuildingCol = mix(
      color(0x0c1420),
      color(0xffd494),
      refWinGrid.mul(0.42).mul(cityUniforms.uInteriorGlow)
    );

    const skyReflect = mix(cityUniforms.uSkyHorizonColor, cityUniforms.uSkyTopColor, clamp(reflectElev.mul(1.4), 0.0, 1.0));
    const envReflection = mix(skyReflect, reflectedBuildingCol, inReflectedTower.mul(0.62));
    const sunSpec = pow(max(dot(reflectDir, sunDir), 0.0), 48.0).mul(1.25);

    // Interior mapping behind the upper-floor glazing.
    const pooledDirt = float(1.0).sub(smoothstep(spandrelRatio, spandrelRatio + 0.22, cellUV.y)).mul(0.32);
    const grime = float(0.56).add(pooledDirt).clamp(0.0, 0.92);
    const glazedBase = mix(aptRoom.xyz.mul(color(0xb6c6bf)), cGlass, grime);

    const glassColor = mix(glazedBase, envReflection, fresnel.mul(uReflectivity).add(0.18))
      .add(cityUniforms.uSunColor.mul(sunSpec));

    const spandrelDark = cFrame.mul(0.52);
    const frameBase = mix(cFrame, spandrelDark, filteredPulse(cellUV.y, 0.0, spandrelRatio, fw.y));

    const canyonBand = smoothstep(0.0, 14.0, vCoord).mul(float(1.0).sub(smoothstep(22.0, 75.0, vCoord)));
    const canyonGlow = cCanyonBounce.mul(canyonBand.mul(cityUniforms.uCanyonBounce).mul(0.16));

    const roofNoise = noise2D(patternXZ.mul(0.35));
    const roofColor = mix(color(0x7d8184), color(0xb4b6b4), fract(hash2D(vec2(facade.boxSeed, 3.1)).add(roofNoise.mul(0.35))));

    const facadeCol = mix(frameBase, glassColor, isGlassPane.mul(float(1.0).sub(isMechFloor))).add(canyonGlow);
    const mechCol = mix(cFrame.mul(0.36), cFrame.mul(0.76), louverStripes);
    const finalWall = mix(facadeCol, mechCol, isMechFloor.mul(float(1.0).sub(isRoof)));

    // Brushed-aluminium coping capping every wall
    const withCap = mix(finalWall, mix(cFrame, color(0xc9ced3), 0.45), coping);

    const surface = mix(mix(withCap, roofColor, isRoof), storefront.color, storefront.mask);
    return mix(mix(surface, entrance.color, entrance.mask), plinthStone(facade), facade.plinth);
  })();

  mat.metalnessNode = mix(float(0.72), float(0.0), facade.plinth);

  mat.roughnessNode = Fn(() => {
    const isFrame = float(1.0).sub(
      filteredPulse(cellUV.x, mullionThickness, 1.0 - mullionThickness, fw.x).mul(filteredPulse(cellUV.y, spandrelRatio, 1.0, fw.y))
    );
    const sillDirt = float(1.0).sub(smoothstep(spandrelRatio, spandrelRatio + 0.18, cellUV.y)).mul(0.18);
    const glassOrFrame = mix(float(0.05).add(sillDirt), float(0.54), max(max(isFrame, isRoof), solid));
    const surface = mix(mix(glassOrFrame, float(0.36), coping), storefront.roughness, storefront.mask);
    return mix(mix(surface, entrance.roughness, entrance.mask), float(0.88), facade.plinth);
  })();

  // Hardware derivative bumpNormal for raised curtain-wall mullions & spandrel channels (ramps >= 2px, see pre-war)
  mat.normalNode = Fn(() => {
    const camDist = length(positionWorld.sub(cameraPosition));
    const detailFade = float(1.0).sub(smoothstep(18.0, 140.0, camDist)).mul(float(1.0).sub(isRoof))
      .mul(float(1.0).sub(smoothstep(0.03, 0.1, max(fw.x, fw.y))));

    const ramp = fw.mul(2.0).max(0.02);
    const inPane = filteredPulse(cellUV.x, mullionThickness + 0.01, 0.99 - mullionThickness, ramp.x)
      .mul(filteredPulse(cellUV.y, spandrelRatio + 0.01, 0.99 - mullionThickness, ramp.y))
      .mul(float(1.0).sub(solid)).mul(float(1.0).sub(coping));
    const mullionRelief = float(1.0).sub(inPane).mul(0.014).add(coping.mul(0.01));

    const relief = mix(mullionRelief, storefront.relief, storefront.mask);
    return bumpNormal(mix(relief, entrance.relief, entrance.mask).mul(detailFade).mul(float(1.0).sub(facade.plinth)));
  })();

  mat.emissiveNode = Fn(() => {
    const inPane = filteredPulse(cellUV.x, mullionThickness + 0.015, 1.0 - mullionThickness - 0.015, fw.x)
      .mul(filteredPulse(cellUV.y, spandrelRatio + 0.02, 1.0 - mullionThickness * 0.5, fw.y));
    const paneMask = inPane.mul(float(1.0).sub(isRoof)).mul(float(1.0).sub(isMechFloor))
      .mul(float(1.0).sub(solid)).mul(float(1.0).sub(coping));

    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const fresnel = pow(clamp(float(1.0).sub(abs(dot(viewDir, normalWorldGeometry))), 0.0, 1.0), 2.0);
    const transmission = float(1.0).sub(fresnel.mul(0.75));

    const emission = aptRoom.xyz.mul(aptRoom.w)
      .mul(transmission)
      .mul(paneMask)
      .mul(cityUniforms.uInteriorGlow)
      .mul(0.72);
    return mix(mix(emission, storefront.emissive, storefront.mask), entrance.emissive, entrance.mask);
  })();

  _curtainWallCache.set(cacheKey, mat);
  return mat;
}

/**
 * Pre-War Limestone, Terra Cotta, Running-Bond Brick & Brownstone TSL Material
 * Features (ported from SkyscraperGenerator.js):
 * - Anti-Aliased Running-Bond Brickwork with Domed Brick Face Relief (`bumpNormal`)
 * - Fast 3D Apartment Interior Mapping on Upper Floors (2D Glazing on Ground-Floor Shops)
 * - Grimy Soda-Lime Window Glazing (pooled sill dirt + vertical rain streaks)
 * - Urban Canyon Global Illumination (`aoNode` + warm terracotta bounce)
 */
function createPreWarBuildingMaterial(opts = {}) {
  const {
    stoneColor = 0xd8ceb8,
    stoneColor2 = stoneColor, // the other end of the walls' colours, which a building's tone picks between: a street of houses isn't one colour
    trimColor = 0x9e937f,
    windowGlassColor = 0x162432,
    windowWidth = 2.7,
    floorHeight = 3.8,
    windowRatioX = 0.50,
    windowRatioY = 0.58,
    coursing = 1.0, // brick and stone joints in the wall: 0 for poured concrete
    litProbability = 0.36,
    warmth = 0.82,
    crownGlowHeight = 9999.0,
    crownGlowColor = 0xffe0a3,
    seed = 42.0,
    boxLocal = false,
    footprintLocal = false,
    cornerPier = 1.2, // solid masonry at both ends of every wall above the shopfronts (box-local mode)
    groundWindows = 0, // 1: windows on the ground floor too, a house's
    houseBrick = 0 // 1: a house of this facade is face brick, laid at a brick's size
  } = opts;

  const cacheKey = `${coursing}_${stoneColor}_${stoneColor2}_${groundWindows}_${houseBrick}_${trimColor}_${windowWidth}_${floorHeight}_${litProbability}_${warmth}_${crownGlowHeight}_${seed}_${boxLocal}_${footprintLocal}_${cornerPier}`;
  if (_preWarCache.has(cacheKey)) {
    return _preWarCache.get(cacheKey);
  }

  const mat = new THREE.MeshStandardNodeMaterial({
    metalness: 0.06,
    roughness: 0.76
  });

  // The style's parameters are uniforms (not baked-in constants), so every masonry style compiles to one shader
  const cStone = uniform(new THREE.Color(stoneColor));
  const cStone2 = uniform(new THREE.Color(stoneColor2));
  const uGroundWindows = uniform(groundWindows);
  const uHouseBrick = uniform(houseBrick);
  const cTrim = uniform(new THREE.Color(trimColor));
  const uCoursing = uniform(coursing);
  const cGlass = uniform(new THREE.Color(windowGlassColor));
  const cCrown = uniform(new THREE.Color(crownGlowColor));
  const uWindowWidth = uniform(windowWidth);
  const uFloorHeight = uniform(floorHeight);
  const uLitProbability = uniform(litProbability);
  const uWarmth = uniform(warmth);
  const uCrownGlowHeight = uniform(crownGlowHeight);
  const uSeed = uniform(seed);
  const cSoot = color(0x4a4236);
  const cCanyonBounce = color(0xe89c68);

  const halfWinX = (1.0 - windowRatioX) * 0.5;
  const halfWinY = (1.0 - windowRatioY) * 0.5;

  // The facade cell, the window opening and the apartment behind it are built once and shared by every output below,
  // so the shader carries a single copy of them (and evaluates the interior mapping once per pixel)
  const facade = facadeCell(uWindowWidth, uFloorHeight, boxLocal || footprintLocal, cornerPier, footprintLocal, uGroundWindows, true);
  const { isRoof, uCoord, vCoord, gridV, cellId, cellUV, fw, bayWidth, isGroundFloor, solid, back, blank, tone, coping } = facade;
  mat.aoNode = canyonSkyAONode(vCoord);
  const { wallS, wallW, wallH, exposedHeight, fromTop, boxSeed, house } = facade;
  // A house's walls (facadeCell's `house`, on footprints): H(a, b) is a on a house's wall and b on any other's, and notHouse(x) is x on
  // any other's and none on a house's. Elsewhere there are no houses, and the shader is as it was.
  const H = house ? (a, b) => mix(b, a, house.isF) : (a, b) => b;
  const notHouse = house ? (x) => x.mul(float(1.0).sub(house.isF)) : (x) => x;
  const open = float(1.0).sub(solid);
  // Band courses are for the street's storeys, not any under the floor; a house has none
  const front = notHouse(float(1.0).sub(back).mul(step(0.0, gridV)));
  const effHalfX = float(halfWinX);
  const effHalfY = float(halfWinY);
  // A house's window in its bay: its style's width across the middle of the bay, its sill and height up from its storey's floor
  let hx0 = null, hy0 = null, hy1 = null, hWinH = null, frameColour = null;
  if (house) {
    const [, frontRow, sideRow, bars] = house.rows;
    const sill = mix(sideRow.z, frontRow.z, house.front);
    hWinH = mix(sideRow.y, frontRow.y, house.front);
    hx0 = clamp(float(0.5).sub(house.width.mul(0.5).div(bayWidth)), 0.06, 0.45);
    hy0 = sill.add(0.22).div(uFloorHeight);
    hy1 = min(sill.add(0.22).add(hWinH), uFloorHeight.sub(0.2)).div(uFloorHeight);
    hWinH = hy1.sub(hy0).mul(uFloorHeight);
    // Its frames' colour: the style's, or the one beside it for some houses (white and cream, aluminium and charcoal)
    const code = bars.z;
    const swapped = mix(code, float(3.0).sub(code), step(hash2D(vec2(boxSeed, 2.9)), 0.35));
    frameColour = mix(mix(color(0xf2f0ea), color(0xaeb3b6), step(0.5, swapped)), mix(color(0x34373a), color(0xe6dcc2), step(2.5, swapped)), step(1.5, swapped));
  }
  const winX0 = H(hx0, effHalfX), winX1 = H(house && float(1.0).sub(hx0), float(1.0).sub(effHalfX));
  const winY0 = H(hy0, effHalfY), winY1 = H(hy1, float(1.0).sub(effHalfY));
  // Glazing UV inside the apartment window opening.
  const winUV = clamp(
    vec2(
      cellUV.x.sub(winX0).div(H(house && float(1.0).sub(hx0.mul(2.0)), max(0.01, float(1.0).sub(effHalfX.mul(2.0))))),
      cellUV.y.sub(winY0).div(H(house && max(0.01, hy1.sub(hy0)), max(0.01, float(1.0).sub(effHalfY.mul(2.0)))))
    ),
    vec2(0.0),
    vec2(1.0)
  );
  // The room shows only in a city window's opening: the glass's mask (colour) and the glow's (emissive) below lie inside it, and a
  // house's windows have their own room (createHouseLook()), so no pixel of a house works it out
  const windowOpening = notHouse(filteredPulse(cellUV.x, effHalfX, float(1.0).sub(effHalfX), fw.x).mul(open)
    .mul(filteredPulse(cellUV.y, effHalfY, float(1.0).sub(effHalfY), fw.y)).mul(float(1.0).sub(isRoof)));
  const aptRoom = apartmentInteriorBehind(windowOpening, uCoord, vCoord, winUV, cellId, bayWidth, uFloorHeight, uSeed, uWarmth,
    uLitProbability.mul(0.62), fw);
  const storefront = createStorefront(facade, uSeed, boxLocal || footprintLocal);
  const entrance = createBuildingEntrance(facade, cTrim, boxLocal || footprintLocal);
  const entranceMask = notHouse(entrance.mask);
  // No sills or relief in the floor the band course covers
  const beltFloor = step(5.0, mod(floor(gridV), 6.0)).mul(front);
  // Metres a pixel along the wall and up it
  const uFw = fwidth(uCoord);
  const houseLook = house ? createHouseLook(facade, { winUV, hWinH, frameColour, uFw, fwV: fw.y.mul(uFloorHeight), uCoursing }) : null;
  // A house's face brick, at a brick's size (76 by 230 mm and its joints): its joints fade into the wall's colour as they shrink
  const houseBrickWall = house ? house.isF.mul(step(0.5, uHouseBrick)) : null;
  const brickH = house ? mix(float(0.24), float(0.086), houseBrickWall) : 0.24;
  const brickL = house ? mix(float(0.56), float(0.24), houseBrickWall) : 0.56;
  const jointHalf = house ? mix(float(0.016), float(0.005), houseBrickWall) : 0.016;
  mat.colorNode = Fn(() => {
    const oneMinusEffX = winX1;
    const oneMinusEffY = winY1;

    const inX = filteredPulse(cellUV.x, winX0, oneMinusEffX, fw.x).mul(open);
    const inY = filteredPulse(cellUV.y, winY0, oneMinusEffY, fw.y);

    // Horizontal cornice belt every 6 floors (street fronts only) + ground floor storefront fascia at top of floor 0
    const cornicePhase = fract(gridV.div(6.0));
    const isCornice = max(
      filteredPulse(cornicePhase, 0.86, 1.0, fw.y.div(6.0)).mul(front),
      isGroundFloor.mul(filteredPulse(cellUV.y, 0.86, 1.0, fw.y))
    );

    // Double-hung meeting rails; a house's own bars and frames
    const sashBarY = lineAA(cellUV.y.sub(0.52), 0.012).mul(float(1.0).sub(isGroundFloor));
    const sashBarX = lineAA(cellUV.x.sub(0.50), 0.009).mul(float(1.0).sub(isGroundFloor)).mul(0.55);
    const sashMask = H(house && houseLook.bars, max(sashBarY, sashBarX));

    const isWindowOpening = inX.mul(inY).mul(float(1.0).sub(isRoof)).mul(float(1.0).sub(isCornice));
    const isWindowGlass = isWindowOpening.mul(float(1.0).sub(sashMask));

    // Anti-Aliased Running-Bond Brickwork & Ashlar Stone Coursing
    const rowCoord = vCoord.div(brickH);
    const courseRow = floor(rowCoord);
    const colCoord = uCoord.div(brickL).add(mod(courseRow, 2.0).mul(0.5));
    // Courtyard and party walls use common brick, with weathered parging on some party walls.
    const backBrick = mix(
      mix(color(0x6c3d30), color(0x8a503e), fract(tone.mul(7.31))),
      mix(color(0x9a8669), color(0xb09a7a), fract(tone.mul(5.17))),
      step(0.58, tone)
    );
    const parged = float(0.0).toVar();
    If(blank.greaterThan(0.5), () => {
      const patch = smoothstep(0.6, 0.76, noise2D(vec2(uCoord.mul(0.11), vCoord.mul(0.07)).add(tone.mul(37.0))));
      parged.assign(notHouse(max(step(0.74, fract(tone.mul(3.7))), patch.mul(0.85))));
    });
    const backTint = mix(backBrick, color(0x8f8b84), parged);
    const mortarJoint = max(
      gridLine(colCoord.mul(brickL), brickL, jointHalf),
      gridLine(vCoord, brickH, jointHalf)
    ).mul(float(1.0).sub(isRoof)).mul(float(1.0).sub(parged)).mul(float(1.0).sub(coping)).mul(uCoursing);

    // Per-brick tint fades out once bricks shrink to a pixel (and soot streaks once they do), so neither can shimmer
    let brickVar = float(1.0).sub(smoothstep(0.5, 1.0, max(uFw.div(brickL), fwidth(rowCoord))));
    // A house's painted walls have no bricks to tint
    if (house) brickVar = brickVar.mul(H(uCoursing, float(1.0)));
    const brickCell = vec2(floor(colCoord), courseRow);
    const brickRnd = hash2D(brickCell.add(vec2(uSeed, 5.3))).sub(0.5).mul(brickVar);
    const brickWarmShift = hash2D(brickCell.add(vec2(17.1, uSeed))).sub(0.5).mul(0.12).mul(brickVar);
    const brickShiftVec = vec3(float(1.0).add(brickWarmShift), float(1.0), float(1.0).sub(brickWarmShift));

    const streakNoise = mix(float(0.5), noise2D(vec2(uCoord.mul(1.4), vCoord.mul(0.05))), float(1.0).sub(smoothstep(0.5, 1.0, uFw.mul(1.4))));
    // A house has no city's soot
    const sootDirt = notHouse(smoothstep(0.25, 0.78, streakNoise).mul(float(1.0).sub(smoothstep(0.0, 180.0, vCoord))).mul(0.36));

    const lintelShadow = smoothstep(oneMinusEffY.sub(0.14), oneMinusEffY, cellUV.y).mul(0.58);
    const jambShadow = float(1.0).sub(smoothstep(winX0, winX0.add(0.08), cellUV.x)).mul(0.42);
    // No sills in the floor the band course covers
    const sillSpan = filteredPulse(cellUV.x, winX0.sub(0.045), oneMinusEffX.add(0.045), fw.x).mul(open).mul(float(1.0).sub(beltFloor));
    const isSillTop = filteredPulse(cellUV.y, winY0.sub(0.032), winY0, fw.y).mul(sillSpan);
    const isSillUnderShadow = filteredPulse(cellUV.y, winY0.sub(0.075), winY0.sub(0.032), fw.y).mul(sillSpan);

    const corniceShadow = smoothstep(0.76, 0.86, cornicePhase).mul(0.32).mul(front);

    const canyonBand = smoothstep(0.0, 14.0, vCoord).mul(float(1.0).sub(smoothstep(22.0, 75.0, vCoord)));
    const canyonGlow = cCanyonBounce.mul(canyonBand.mul(cityUniforms.uCanyonBounce).mul(0.22));

    // Faded advertisements on broad party walls, never a house's. Lettering is evaluated only within the painted panel.
    const signW = max(min(wallW.sub(3.0), 18.0), 0.1);
    const signH = max(min(min(min(wallH.mul(0.3), signW.mul(0.42)), 6.5), exposedHeight.sub(1.8)), 0.1);
    const hasSign = notHouse(blank.mul(float(1.0).sub(step(0.74, fract(tone.mul(3.7)))))
      .mul(step(0.8, fract(tone.mul(13.7).add(boxSeed.mul(0.618)))))
      .mul(step(5.0, signW)).mul(step(2.6, signH)));
    const su = wallS.sub(wallW.sub(signW).mul(0.5)).div(signW);
    const sv = fromTop.sub(1.2).div(signH);
    const signFw = vec2(fwidth(su), fwidth(sv));
    const panel = boxCoverage(su, 0.0, 1.0, signFw.x.mul(0.5)).mul(boxCoverage(sv, 0.0, 1.0, signFw.y.mul(0.5))).mul(hasSign);
    const signPaint = vec4(0.0).toVar();
    If(panel.greaterThan(0.001), () => {
      const pal = fract(tone.mul(29.3));
      const ground = mix(mix(color(0xd3c9ae), color(0x86392b), step(0.5, pal)), color(0x2b3340), step(0.8, pal));
      const ink = mix(mix(color(0x6b2a20), color(0xddd2b6), step(0.5, pal)), color(0xd5c086), step(0.8, pal));
      const border = float(1.0).sub(filteredPulse(su, 0.02, 0.98, signFw.x).mul(filteredPulse(sv, 0.045, 0.955, signFw.y)));
      const lettering = (v0, v1, line) => {
        const glyphW = signH.mul((v1 - v0) * 0.64);
        const n = floor(signW.mul(0.86).div(glyphW));
        const gx = su.mul(signW).sub(signW.sub(n.mul(glyphW)).mul(0.5)).div(glyphW);
        const fy = sv.sub(v0).div(v1 - v0);
        const wx = signFw.x.mul(signW).div(glyphW);
        const wy = signFw.y.div(v1 - v0);
        const fx = fract(gx);
        const h1 = hash2D(vec2(floor(gx).add(line * 31.0), tone.mul(91.0)));
        const h2 = hash2D(vec2(floor(gx).add(line * 31.0 + 7.0), tone.mul(53.0)));
        const verticals = max(
          max(filteredPulse(fx, 0.1, 0.28, wx).mul(step(0.22, h1)), filteredPulse(fx, 0.41, 0.59, wx).mul(step(h1, 0.22))),
          filteredPulse(fx, 0.72, 0.9, wx).mul(step(0.45, h2))
        );
        const bars = max(
          max(filteredPulse(fy, 0.0, 0.17, wy).mul(step(0.35, fract(h1.mul(7.0)))), filteredPulse(fy, 0.42, 0.58, wy).mul(step(0.5, fract(h2.mul(5.0))))),
          filteredPulse(fy, 0.83, 1.0, wy).mul(step(0.4, fract(h1.mul(3.0))))
        ).mul(filteredPulse(fx, 0.1, 0.9, wx));
        const inText = boxCoverage(gx, 0.0, n, wx.mul(0.5)).mul(boxCoverage(fy, 0.0, 1.0, wy.mul(0.5))).mul(step(0.1, fract(h2.mul(11.0))));
        return max(verticals, bars).mul(inText);
      };
      const letters = max(lettering(0.14, 0.56, 0), lettering(0.66, 0.86, 1));
      const flake = smoothstep(0.5, 0.74, noise2D(vec2(wallS.mul(0.7), fromTop.mul(1.1)).add(tone.mul(31.0))));
      const cover = mix(float(0.34), float(0.66), fract(tone.mul(7.7))).mul(float(1.0).sub(flake.mul(0.9))).mul(panel);
      signPaint.assign(vec4(mix(ground, ink, max(letters, border)), cover));
    });

    const wallTint = mix(mix(mix(cStone, cStone2, tone), backTint, back), signPaint.xyz, signPaint.w);
    // Trim stone on the band courses, the storefront fascia and the coping capping every wall
    const trimMix = max(isCornice.mul(0.62).add(isGroundFloor.mul(0.28)), coping.mul(0.8));
    let masonryTint = mix(wallTint, cTrim, trimMix)
      .mul(brickRnd.mul(0.14).add(1.0))
      .mul(brickShiftVec);
    // A house's painted walls: their weatherboards, fibro sheets or render
    if (house) masonryTint = masonryTint.mul(houseLook.surface.x);
    const masonryWithMortar = mix(masonryTint, masonryTint.mul(0.62), mortarJoint);
    let masonryWeathered = mix(masonryWithMortar, cSoot, sootDirt)
      .mul(float(1.0).sub(corniceShadow))
      .mul(float(1.0).sub(isSillUnderShadow.mul(0.42)))
      .add(cityUniforms.uSunColor.mul(isSillTop.mul(0.24)))
      .add(canyonGlow);
    // and the shade under its eaves; on a row of terraces, each house's own shade and the piers between them
    if (house) masonryWeathered = mix(masonryWeathered.mul(houseLook.shade), houseLook.pierColor, houseLook.pier).mul(houseLook.eave);

    // Upper apartment floors use interior mapping behind grimy soda-lime glazing.
    const pooledDirt = float(1.0).sub(smoothstep(0.0, 0.32, winUV.y)).mul(0.36);
    // Grimy soda-lime glazing film (SkyscraperGenerator.js line 1688): baseline haze so panes read as glass, not open holes
    const upperGrime = float(0.52).add(sootDirt.mul(0.35)).add(pooledDirt).clamp(0.0, 0.90);

    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const fresnel = pow(clamp(float(1.0).sub(abs(dot(viewDir, normalWorldGeometry))), 0.0, 1.0), 2.0);
    const recessShade = float(1.0).sub(max(lintelShadow, jambShadow));

    const upperGlassBase = mix(aptRoom.xyz.mul(color(0xb6c6bf)), cGlass, upperGrime);
    const glassCol = H(
      house && mix(mix(houseLook.room.xyz, cGlass, 0.22), cityUniforms.uSkyHorizonColor, fresnel.mul(0.55).add(0.12)).mul(recessShade),
      mix(upperGlassBase, cityUniforms.uSkyHorizonColor, fresnel.mul(0.52).add(0.08)).mul(recessShade)
    );

    const frameCol = H(house && frameColour.mul(mix(float(1.0), recessShade, 0.4)), masonryTint.mul(0.46).mul(recessShade));
    const roofNoise = noise2D(patternXZ.mul(0.35));
    // Sydney's flat roofs from the air: pale membrane and concrete, some greyer than others, whatever the walls are
    const roofCol = mix(color(0x8d8f8e), color(0xc6c5be), fract(hash2D(vec2(boxSeed, 3.1)).add(roofNoise.mul(0.35))));

    const wallOrRoof = mix(masonryWeathered, roofCol, isRoof);
    const withFrames = mix(wallOrRoof, frameCol, isWindowOpening.mul(sashMask));
    const withGlass = mix(withFrames, glassCol, isWindowGlass);
    const surface = mix(withGlass, storefront.color, storefront.mask);
    let withDoors = mix(surface, entrance.color, entranceMask);
    // A house's front door, and a project home's garage door
    if (house) withDoors = mix(withDoors, houseLook.door.color, houseLook.door.mask);
    return mix(withDoors, plinthStone(facade), facade.plinth);
  })();

  mat.roughnessNode = Fn(() => {
    const belt = filteredPulse(gridV.div(6.0), 0.86, 1.0, fw.y.div(6.0)).mul(front);
    const inX = filteredPulse(cellUV.x, H(hx0, float(halfWinX)), H(house && float(1.0).sub(hx0), float(1.0 - halfWinX)), fw.x).mul(open).mul(float(1.0).sub(belt));
    const inY = filteredPulse(cellUV.y, H(hy0, float(halfWinY)), H(hy1, float(1.0 - halfWinY)), fw.y);
    const isWindow = inX.mul(inY).mul(float(1.0).sub(isRoof));

    const winY = H(house && winUV.y, clamp(cellUV.y.sub(halfWinY).div(max(0.01, 1.0 - 2.0 * halfWinY)), 0.0, 1.0));
    const pooledRough = notHouse(float(1.0).sub(smoothstep(0.0, 0.32, winY)).mul(0.38));
    const glassRough = float(0.14).add(pooledRough);

    const stoneGrain = noise2D(vec2(uCoord.mul(8.0), vCoord.mul(8.0))).mul(0.12);
    const surface = mix(mix(float(0.78).add(stoneGrain), glassRough, isWindow), storefront.roughness, storefront.mask);
    let withDoors = mix(surface, entrance.roughness, entranceMask);
    if (house) withDoors = mix(withDoors, houseLook.door.roughness, houseLook.door.mask);
    return mix(withDoors, float(0.88), facade.plinth);
  })();

  // Hardware derivative bumpNormal for domed brickwork, stone courses & recessed windows. Edges ramp over
  // >= 2px and the fine brick relief fades before it shrinks to pixels: sharper height steps turn into
  // derivative sparkles that crawl along every mortar joint & sill as the camera moves
  mat.normalNode = Fn(() => {
    const camDist = length(positionWorld.sub(cameraPosition));
    const detailFade = float(1.0).sub(smoothstep(16.0, 150.0, camDist)).mul(float(1.0).sub(isRoof))
      .mul(float(1.0).sub(smoothstep(0.03, 0.1, max(fw.x, fw.y))));
    const ramp = fw.mul(2.0);
    const footprint = max(fwidth(uCoord), fwidth(vCoord)); // Meters per pixel

    // Stone band course every 6 floors on street fronts: no window recesses or sills in it
    const belt = filteredPulse(gridV.div(6.0), 0.86, 1.0, ramp.y.div(6.0)).mul(front);
    const inX = filteredPulse(cellUV.x, winX0, winX1, ramp.x).mul(open).mul(float(1.0).sub(belt));
    const inY = filteredPulse(cellUV.y, winY0, winY1, ramp.y);
    const isWindow = inX.mul(inY);

    const rowCoord = vCoord.div(brickH);
    const courseRow = floor(rowCoord);
    const colCoord = uCoord.div(brickL).add(mod(courseRow, 2.0).mul(0.5));
    const distU = float(0.5).sub(abs(fract(colCoord).sub(0.5))).mul(brickL);
    const distV = float(0.5).sub(abs(fract(rowCoord).sub(0.5))).mul(brickH);
    let brickDome = smoothstep(0.0, 0.018, distU).mul(smoothstep(0.0, 0.018, distV)).mul(0.0045)
      .mul(float(1.0).sub(smoothstep(0.006, 0.012, footprint)));
    // A house's painted walls are smooth, or boards
    if (house) brickDome = brickDome.mul(H(uCoursing, float(1.0)));

    const sillLedge = filteredPulse(cellUV.y, winY0.sub(0.032), winY0, ramp.y).mul(inX).mul(0.016);
    const corniceLedge = belt.mul(0.022);

    let wallHeight = brickDome.mul(float(1.0).sub(coping)).add(sillLedge).add(corniceLedge).add(coping.mul(0.024));
    // A house's weatherboards and fibro strips
    if (house) wallHeight = wallHeight.add(houseLook.surface.y);
    const totalHeight = wallHeight.mul(float(1.0).sub(isWindow));

    const relief = mix(totalHeight, storefront.relief, storefront.mask);
    let withDoors = mix(relief, entrance.relief, entranceMask);
    if (house) withDoors = mix(withDoors, houseLook.door.relief, houseLook.door.mask);
    return bumpNormal(withDoors.mul(detailFade).mul(float(1.0).sub(facade.plinth)));
  })();

  mat.emissiveNode = Fn(() => {
    // The glow stays a hair inside the glazing
    const glowHalfX = float(halfWinX + 0.015);
    const glowHalfY = float(halfWinY + 0.015);

    const inX = filteredPulse(cellUV.x, H(house && hx0.add(0.015), glowHalfX), H(house && float(0.985).sub(hx0), float(1.0).sub(glowHalfX)), fw.x).mul(open);
    const inY = filteredPulse(cellUV.y, H(house && hy0.add(0.015), glowHalfY), H(house && hy1.sub(0.015), float(1.0).sub(glowHalfY)), fw.y);
    const isCornice = max(
      filteredPulse(fract(gridV.div(6.0)), 0.86, 1.0, fw.y.div(6.0)).mul(front),
      isGroundFloor.mul(filteredPulse(cellUV.y, 0.86, 1.0, fw.y))
    );

    const sashBarY = lineAA(cellUV.y.sub(0.52), 0.014).mul(float(1.0).sub(isGroundFloor));
    const sashBarX = lineAA(cellUV.x.sub(0.50), 0.010).mul(float(1.0).sub(isGroundFloor)).mul(0.55);
    const sashMask = H(house && houseLook.bars, max(sashBarY, sashBarX));

    const isWindow = inX.mul(inY)
      .mul(float(1.0).sub(isRoof))
      .mul(float(1.0).sub(isCornice))
      .mul(float(1.0).sub(sashMask));

    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const fresnel = pow(clamp(float(1.0).sub(abs(dot(viewDir, normalWorldGeometry))), 0.0, 1.0), 1.8);
    const transmission = float(1.0).sub(fresnel.mul(0.82));

    // A house's lit windows glow warm through the glass, or dimmer through a blind
    const winEmit = H(house && color(0xffc27a).mul(houseLook.room.w), aptRoom.xyz.mul(aptRoom.w)).mul(0.76)
      .mul(transmission)
      .mul(isWindow)
      .mul(cityUniforms.uInteriorGlow);

    const crownMask = smoothstep(uCrownGlowHeight, uCrownGlowHeight.add(26.0), vCoord).mul(float(1.0).sub(isRoof.mul(0.5)));
    const crownFlood = cCrown.mul(crownMask).mul(cityUniforms.uInteriorGlow).mul(0.55);

    const emission = mix(mix(winEmit, storefront.emissive, storefront.mask), entrance.emissive, entranceMask);
    return emission.add(crownFlood);
  })();

  _preWarCache.set(cacheKey, mat);
  return mat;
}

/**
 * What a house's walls have that a city building's don't, from facadeCell()'s `house`: { bars (its windows' frames, panes and
 * transoms, over the window's opening), surface (vec2: how much lighter or darker its painted wall is there, and the wall's relief in
 * m: weatherboards, fibro sheets or render), eave (the shade under its eaves), room (vec4: what's behind its glass, and how lit),
 * door ({ mask, color, roughness, relief }: its front door, and a project home's garage door), shade (vec3: a row of terraces' house's
 * own shade of the wall), pier (the piers between them) and pierColor }. The work is skipped on any other wall;
 * every derivative it needs is taken outside that, as `winUV` (the window's opening, 0-1 across and up), `uFw` and `fwV` (m a pixel
 * along the wall and up it).
 */
function createHouseLook(facade, { winUV, hWinH, frameColour, uFw, fwV, uCoursing }) {
  const { house, cellId, fw, vCoord, fromTop, boxSeed, bayWidth, isRoof } = facade;
  const { rows } = house;
  const fwWin = vec2(fwidth(winUV.x), fwidth(winUV.y));
  // Coverage of d < half over a pixel `aa` wide, as lineAA() gives with its own derivative
  const under = (d, half, aa) => {
    const eff = max(half, aa.mul(0.5));
    return smoothstep(eff.add(aa), eff.sub(aa), d).mul(min(float(1.0), float(half).div(eff)));
  };

  const bars = Fn(() => {
    const out = float(0.0).toVar();
    If(house.is, () => {
      const width = house.width;
      const panes = max(mix(rows[2].w, rows[1].w, house.front), 1.0);
      const transom = mix(rows[3].y, rows[3].x, house.front);
      const aa = max(fwWin.x.mul(width), fwWin.y.mul(hWinH)).max(0.002);
      // Metres from the nearest bar between panes, from the transom, and in from the frame's outside
      const t = winUV.x.mul(panes);
      const mullion = abs(t.sub(floor(t.add(0.5)))).mul(width.div(panes));
      const across = winUV.x.mul(width), up = winUV.y.mul(hWinH);
      const edge = min(min(across, width.sub(across)), min(up, hWinH.sub(up)));
      const rail = abs(up.sub(transom.mul(hWinH)));
      out.assign(max(max(under(mullion, 0.022, aa), under(rail, 0.024, aa).mul(step(0.01, transom))), under(edge, 0.05, aa)));
    });
    return out;
  })();

  // Painted walls (the facade's coursing off): weatherboards a board every 0.18 m with the lap's shadow along its foot, fibro sheets
  // of 1.2 by 2.4 m with cover strips on their joints, or plain render. Boards and strips settle to their mean colour as they shrink
  // under a pixel.
  const surface = Fn(() => {
    const out = vec2(1.0, 0.0).toVar();
    If(house.is.and(uCoursing.lessThan(0.5)), () => {
      const painted = rows[4].x;
      const kind = select(painted.greaterThan(2.5), select(hash2D(vec2(boxSeed, 7.7)).lessThan(0.6), float(2.0), float(1.0)), painted);
      // The relief is the same steps ramped over two pixels or more, as the rest of the facade's is: a sharp one sparkles
      const board = fract(vCoord.div(0.18));
      const lap = filteredPulse(board, 0.0, 0.14, fwV.div(0.18));
      const lapRelief = float(1.0).sub(filteredPulse(board, 0.0, 0.14, fwV.div(0.18).mul(2.0).max(0.02)));
      const boards = vec2(float(1.0).sub(lap.mul(0.3)), lapRelief.mul(0.006));
      const stripAt = (u, v, w) => max(filteredPulse(fract(house.along.div(1.2).add(0.02)), 0.0, 0.04, u), filteredPulse(fract(vCoord.div(2.4).add(0.01)), 0.0, 0.02, v)).mul(w);
      const strip = stripAt(uFw.div(1.2), fwV.div(2.4), 1.0);
      const stripRelief = stripAt(uFw.div(1.2).mul(2.0).max(0.01), fwV.div(2.4).mul(2.0).max(0.005), 0.006);
      const fibro = vec2(float(1.0).add(strip.mul(0.1)), stripRelief);
      out.assign(select(kind.lessThan(0.5), vec2(1.0, 0.0), select(kind.lessThan(1.5), boards, fibro)));
    });
    return out;
  })();

  // The shade under the eaves, down the top half metre of the wall (not up a gable, which is above its top)
  const eave = mix(float(1.0), float(1.0).sub(float(1.0).sub(smoothstep(0.0, 0.5, fromTop)).mul(0.3).mul(step(-0.02, fromTop))), house.isF);

  // Behind the glass: a blind or curtain drawn down from the top, to a different depth in each window, or none; about one in five lit at
  // night, and far off the share of it, so no window flickers on and off
  const room = Fn(() => {
    const out = vec4(0.0).toVar();
    If(house.is, () => {
      const id = cellId.add(vec2(3.7, 11.9));
      const h1 = hash2D(id), h2 = hash2D(id.add(vec2(19.1, 7.3))), h3 = hash2D(id.add(vec2(5.9, 31.7)));
      const drawn = step(0.25, h2).mul(h2.mul(0.8));
      const edge = fwWin.y.max(0.002);
      const blind = smoothstep(float(1.0).sub(drawn).sub(edge), float(1.0).sub(drawn).add(edge), winUV.y).mul(step(0.01, drawn));
      const fabric = mix(mix(color(0xe8e0cc), color(0xc9bfa8), step(0.4, h3)), color(0x8f8a80), step(0.8, h3));
      const dark = mix(color(0x1c1f22), color(0x2a2724), h1);
      const lod = smoothstep(0.3, 0.8, max(fw.x, fw.y));
      const lit = mix(step(0.8, h1), float(0.2), lod);
      out.assign(vec4(mix(dark, fabric, blind), lit.mul(mix(float(1.0), float(0.55), blind))));
    });
    return out;
  })();

  // The front door in the middle of its bay, 0.92 by 2.04 m in its frame, with a fanlight over it or a sidelight beside it by the
  // style; a project home's garage door, 4.8 m (or as much as its two bays hold) by 2.1 m, across the middle of its two bays
  // How much of a pixel along the wall (hx) or up it (hy) a span [a, b] covers, written out rather than as boxCoverage() calls, which
  // each bring their own temporaries into the shader
  const hx = uFw.mul(0.5).max(0.001), hy = fwV.mul(0.5).max(0.001);
  const band = (p, a, b, h) => clamp(min(p.add(h), b).sub(max(p.sub(h), a)).div(h.mul(2.0)), 0.0, 1.0);
  const y = vCoord.sub(0.22);
  const kind = rows[3].w;
  const fan = step(0.5, kind).mul(step(kind, 1.5)), side = step(1.5, kind);
  const dx = house.along.sub(house.pier.add(house.door.add(0.5).mul(bayWidth)));
  const leafTop = 2.04, frame = 0.07, half = 0.46;
  const top = mix(float(leafTop), float(2.5), fan);
  const sideWidth = side.mul(0.36);
  const front = house.front.mul(float(1.0).sub(isRoof)).mul(house.isF);
  const doorMask = band(dx, -half - frame, sideWidth.add(half + frame), hx).mul(band(y, 0.0, top.add(frame), hy))
    .mul(step(-0.5, house.door)).mul(front);
  const gx = house.along.sub(house.pier.add(house.garage.add(1.0).mul(bayWidth)));
  const gHalf = min(float(2.4), bayWidth.sub(0.3));
  const garageMask = band(gx, gHalf.add(0.08).negate(), gHalf.add(0.08), hx).mul(band(y, 0.0, 2.18, hy))
    .mul(step(-0.5, house.garage)).mul(front);
  const mask = max(doorMask, garageMask).toVar();
  const leaf = band(dx, -half, half, hx).mul(band(y, 0.0, leafTop, hy));
  const garageLeaf = band(gx, gHalf.negate(), gHalf, hx).mul(band(y, 0.0, 2.1, hy));
  const glass = max(
    fan.mul(band(dx, -half, half, hx)).mul(band(y, leafTop + 0.06, 2.44, hy)),
    side.mul(band(dx, half + 0.06, half + 0.32, hx)).mul(band(y, 0.15, leafTop, hy))
  );
  const doorColor = Fn(() => {
    const out = vec3(0.0).toVar();
    If(mask.greaterThan(0.001), () => {
      const h = hash2D(vec2(boxSeed, 21.7));
      const paint = mix(mix(mix(color(0x2f4a3a), color(0x7a2a22), step(0.2, h)), mix(color(0x1f2f4a), color(0xd9cfb8), step(0.6, h)), step(0.4, h)),
        mix(color(0x5a3e2a), color(0x2b2b2b), step(0.9, h)), step(0.8, h));
      const panels = leaf.mul(band(abs(dx), 0.08, 0.36, hx)).mul(max(band(y, 0.25, 0.95, hy), band(y, 1.15, 1.85, hy)));
      const handle = leaf.mul(band(dx, 0.3, 0.35, hx)).mul(band(y, 0.95, 1.1, hy));
      const door = mix(mix(paint, paint.mul(0.72), panels), color(0xb8b4a8), handle);
      const panes = mix(color(0x1d2428), cityUniforms.uSkyHorizonColor, 0.3);
      const inFrame = mix(mix(frameColour, door, leaf), panes, glass);
      const g = hash2D(vec2(boxSeed, 33.1));
      const sheet = mix(mix(color(0xf0eee6), color(0xcfccc1), step(0.35, g)), mix(color(0x3b3d3f), color(0x5b5f59), step(0.85, g)), step(0.6, g));
      const grooves = filteredPulse(fract(y.div(0.55)), 0.0, 0.06, fwV.div(0.55));
      const garage = mix(frameColour, sheet.mul(float(1.0).sub(grooves.mul(0.25))), garageLeaf);
      out.assign(mix(garage, inFrame, step(garageMask, doorMask)));
    });
    return out;
  })();
  const door = {
    mask,
    color: doorColor,
    roughness: mix(float(0.5), float(0.15), glass),
    relief: max(leaf, garageLeaf).mul(-0.02).add(float(0.01))
  };

  // A row of terraces' houses (houseWall()): a thin rendered pier up the wall between each and the next, and each house its own shade of
  // the wall's colour. Two bays a house from the row's start; the row's ends are its corners. The pier hides where one shade meets the next.
  const row = house.terraces.mul(house.front).mul(float(1.0).sub(isRoof)).mul(house.isF);
  const u = house.along.sub(house.pier).div(bayWidth).mul(0.5);
  const toPier = abs(u.sub(floor(u.add(0.5)))).mul(bayWidth.mul(2.0));
  const between = step(0.5, u).mul(step(u, house.bays.mul(0.5).sub(0.5)));
  const pier = band(toPier, -1.0, 0.16, hx).mul(between).mul(row);
  // ...standing a little proud of the wall: a line of shade down each side of it
  const pierEdge = band(toPier, 0.16, 0.21, hx).mul(between).mul(row);
  const unit = floor(u);
  const light = hash2D(vec2(unit.add(0.37), boxSeed.add(41.3))).sub(0.5).mul(0.24);
  const warm = hash2D(vec2(unit.add(3.1), boxSeed.add(7.9))).sub(0.5).mul(0.1);
  const shade = mix(vec3(1.0), vec3(light.add(warm).add(1.0), light.add(1.0), light.sub(warm).add(1.0)), row).mul(float(1.0).sub(pierEdge.mul(0.35)));
  const pierColor = mix(color(0xe9e2d0), color(0xd6ccb6), hash2D(vec2(boxSeed, 12.7)));
  return { bars, surface, eave, room, door, shade, pier, pierColor };
}

// Axis-aligned landmark boxes, with dimensions and a seed for whole-bay facade layouts.
function createFacadeBoxes(material, boxes) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const box = new THREE.InstancedBufferAttribute(new Float32Array(boxes.length * 4), 4);
  geometry.setAttribute('box', box);

  const mesh = new THREE.InstancedMesh(geometry, material, boxes.length);
  const matrix = new THREE.Matrix4();
  boxes.forEach((b, i) => {
    mesh.setMatrixAt(i, matrix.makeScale(b.w, b.h, b.d).setPosition(b.x, b.y, b.z));
    box.setXYZW(i, b.w, b.h, b.d, ((i * 29) % 1000) + 0.5);
  });
  return mesh;
}

const _carPaintCache = new Map();

// Vehicle paint with Fresnel reflections and a sharp sun highlight.
function createCarPaintMaterial(baseHex = 0xffc218) {
  if (_carPaintCache.has(baseHex)) return _carPaintCache.get(baseHex);
  const mat = new THREE.MeshStandardNodeMaterial({
    metalness: 0.56,
    roughness: 0.11
  });

  const cBase = color(baseHex);

  mat.colorNode = Fn(() => {
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const sunDir = normalize(cityUniforms.uSkySunDir);
    const reflectDir = reflect(viewDir.negate(), normalWorld);
    const fresnel = pow(clamp(float(1.0).sub(abs(dot(viewDir, normalWorld))), 0.0, 1.0), 2.2);
    const envCol = mix(cityUniforms.uSkyHorizonColor, color(0xffffff), clamp(reflectDir.y.mul(0.55).add(0.5), 0.0, 1.0));
    const clearcoatSpec = pow(max(dot(reflectDir, sunDir), 0.0), 36.0).mul(0.55);
    return mix(cBase, envCol, fresnel.mul(0.48)).add(cityUniforms.uSunColor.mul(clearcoatSpec));
  })();

  _carPaintCache.set(baseHex, mat);
  return mat;
}

// Sunlight shining through leaves (Barré-Brisebois & Bouchard's fast translucency approximation): looking against
// the light, a leaf glows with the light it lets through. It takes the direct light's colour, so shadows (the crown's
// own included) dim it like the sunlit side. Materials set `translucencyNode` (vec3, 0 where nothing shines through).
class FoliageLightingModel extends THREE.PhysicalLightingModel {
  direct(lightData, builder) {
    const { lightDirection, lightColor, reflectedLight } = lightData;
    const translucency = builder.material.translucencyNode;
    if (translucency) {
      const scatter = normalize(lightDirection.add(normalView.mul(0.3)));
      const through = pow(clamp(dot(positionViewDirection, scatter.negate()), 0.0, 1.0), 3.0);
      reflectedLight.directDiffuse.addAssign(lightColor.mul(translucency).mul(through));
    }
    super.direct(lightData, builder);
  }
}

class TreeNodeMaterial extends THREE.MeshStandardNodeMaterial {
  static get type() {
    return 'TreeNodeMaterial';
  }

  constructor(parameters) {
    super(parameters);
    this.translucencyNode = null;
  }

  setupLightingModel() {
    return new FoliageLightingModel();
  }
}

// Prevailing wind (xz, blowing from the west-north-west across the city)
const TREE_WIND = vec2(0.86, 0.51);

/**
 * Instanced street & park tree material (js/trees.js): bark tubes and alpha-tested leaf cards in ONE draw per mesh.
 * Geometry attributes:
 * - uv: leaf-atlas coordinates on the cards; on the bark (metres round the stem, metres along it)
 * - normal: on the cards, crown-shell normals (out from the crown centre, blended with the card face), so a crown
 *   shades as one leafy volume and both sides of a card light alike (the back faces keep them unflipped)
 * - aTree (vec4): x = 1 on leaf cards / 0 on bark, y = crown occlusion (0 deep inside .. 1 on the outer shell),
 *   z = sway weight (0 on the trunk .. 1 at the twig tips & cards), w = per-card random (leaf flutter phase)
 * - aTreeData (instanced vec4): rgb = per-tree linear foliage tint, w = species index + per-tree random fraction
 *   (species 0 London plane: flaking camouflage bark, 1 honey locust & 2 elm: dark furrowed bark)
 * Leaf atlas texels: r = leaf brightness, g = per-leaf hue jitter, b = twig / stalk mask, a = coverage (its mipmaps
 * keep the coverage, so distant crowns stay full).
 * Shading: per-tree tint with sun-yellowed & cooler leaves, deep leaves darker and occluded from the sky, sunlight
 * shining through the leaves toward the camera (FoliageLightingModel), alpha-to-coverage leaf edges on the MSAA scene
 * pass (alpha-tested in the shadow maps: dappled shadows). Wind: gusts rolling across the city sway the crowns
 * (shadows follow), branches bob and leaves flutter.
 */
function createTreeMaterial(leafAtlas) {
  const mat = new TreeNodeMaterial({
    side: THREE.DoubleSide,
    alphaToCoverage: true,
    metalness: 0.0,
    roughness: 0.8
  });

  const aTree = attribute('aTree', 'vec4');
  const aData = attribute('aTreeData', 'vec4');
  const isLeaf = aTree.x;
  const crownAO = aTree.y;
  const rnd = fract(aData.w);
  const species = floor(aData.w);
  const leaf = texture(leafAtlas, uv());

  // Wind. positionLocal is already instanced (world space); positionGeometry is the tree's own frame (metres)
  mat.positionNode = Fn(() => {
    const p = positionLocal;
    const g = positionGeometry;
    const phase = rnd.mul(6.2832);
    // gusts rolling downwind across the city
    const gust = sin(time.mul(0.5).sub(dot(p.xz, TREE_WIND).mul(0.045))).mul(0.5).add(0.5);
    const strength = gust.mul(gust).mul(0.7).add(0.3);
    // the whole tree bends with height, leaning downwind and rocking across it
    const h = g.y.div(11.0);
    const bend = h.mul(h);
    const lean = sin(time.mul(0.85).add(phase)).mul(0.45).add(0.55).mul(strength).mul(0.2);
    const rock = sin(time.mul(0.67).add(phase.mul(1.7))).mul(0.06).mul(strength);
    const sway = vec3(TREE_WIND.x.mul(lean).sub(TREE_WIND.y.mul(rock)), 0.0, TREE_WIND.y.mul(lean).add(TREE_WIND.x.mul(rock))).mul(bend);
    // branches bob, the phase flowing smoothly through the crown so joints stay together
    const bob = sin(time.mul(2.1).add(g.x.mul(0.9)).add(g.z.mul(0.7)).add(phase)).mul(0.05).mul(aTree.z).mul(strength);
    // leaves flutter, every card on its own
    const flutter = sin(time.mul(8.0).add(aTree.w.mul(37.0)).add(g.y.mul(2.0))).mul(0.03).mul(isLeaf).mul(aTree.z).mul(strength.add(0.25));
    return p.add(sway).add(vec3(0.0, bob, 0.0)).add(normalLocal.mul(flutter));
  })();

  // Coverage: leaf cards from the atlas; bark is opaque from outside (its back faces are dropped)
  const alpha = mix(float(frontFacing), leaf.a, isLeaf);
  mat.alphaTest = 0.5;

  mat.colorNode = Fn(() => {
    // Leaves: per-tree tint x atlas brightness, a share of sun-yellowed and of cooler leaves, brown twigs & stalks,
    // darker deep in the crown. A garden's flowers and roses (species 14 and 15, js/trees.js) are in flower on half their cards, in
    // leaf on the rest.
    const flowering = step(13.5, species).mul(step(species, 15.5));
    const inLeaf = flowering.mul(float(1.0).sub(step(0.5, fract(aTree.w.mul(7.31)))));
    const tint = mix(aData.xyz, color(0x3b5a28), inLeaf);
    const base = tint.mul(leaf.r.mul(1.4));
    const warm = smoothstep(0.62, 1.0, leaf.g).mul(0.55);
    const cool = smoothstep(0.38, 0.0, leaf.g).mul(0.45);
    const leafCol = mix(mix(base, base.mul(vec3(1.25, 1.08, 0.5)), warm), base.mul(vec3(0.8, 0.92, 1.05)), cool);
    const foliage = mix(leafCol, color(0x4a3b2c), leaf.b).mul(crownAO.mul(0.45).add(0.55));

    // Bark (uv in metres): furrowed grey-brown ridges, or the London plane's olive bark flaking to cream & tan
    const bu = uv();
    const n1 = noise2D(vec2(bu.x.mul(5.0), bu.y.mul(1.1)).add(rnd.mul(17.0)));
    const n2 = noise2D(bu.mul(vec2(3.2, 1.9)).add(rnd.mul(31.0)));
    const ridge = float(1.0).sub(abs(n1.sub(0.5).mul(2.0)));
    const furrowed = mix(color(0x2e261f), color(0x5c5043), smoothstep(0.35, 0.9, ridge));
    const planeBark = mix(mix(color(0x645e4b), color(0x948c73), smoothstep(0.56, 0.66, n2)), color(0x4a3f31), smoothstep(0.3, 0.22, n2));
    const bark = mix(furrowed, planeBark, step(species, 0.5)).mul(crownAO.mul(0.4).add(0.6));

    return vec4(mix(bark, foliage, isLeaf), alpha);
  })();

  mat.roughnessNode = mix(float(0.93), float(0.72).sub(leaf.r.mul(0.1)), isLeaf);

  // Card normals are crown-shell normals on both faces: no back-face flip
  mat.normalNode = normalViewGeometry;

  // Sky light: street-canyon occlusion, deep inside the crown far less
  mat.aoNode = float(STREET_SKY + 0.1).mul(crownAO.mul(0.75).add(0.25));

  // Light through the leaves: yellow-green, strongest out on the thin shell
  mat.translucencyNode = aData.xyz.mul(vec3(1.0, 1.2, 0.45)).mul(leaf.r.mul(1.5)).mul(crownAO.mul(0.8).add(0.2)).mul(isLeaf);

  return mat;
}

/**
 * Concentric Cast-Iron Sidewalk Tree Pit Grate TSL Material (ported from StreetTreeGenerator.js)
 */
function createTreeGrateMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({
    metalness: 0.45,
    roughness: 0.68
  });

  mat.aoNode = float(STREET_SKY);

  mat.colorNode = Fn(() => {
    const r = length(positionLocal.xz);
    const concentricSlots = smoothstep(0.35, 0.52, fract(r.mul(11.0)));
    const radialRibs = smoothstep(0.25, 0.45, abs(sin(positionLocal.x.mul(14.0)).mul(cos(positionLocal.z.mul(14.0)))));
    return mix(color(0x141312), color(0x3b3936), max(concentricSlots, radialRibs));
  })();

  return mat;
}

// Post-rain puddle field (organic standing rainwater pools) shared by every road surface channel
function roadPuddleField(wx, wz) {
  const nMacro = noise2D(vec2(wx.mul(0.095), wz.mul(0.075)));
  const nMid = noise2D(vec2(wx.mul(0.25).add(19.4), wz.mul(0.22).add(11.8)));
  const nDetail = noise2D(vec2(wx.mul(0.68).sub(7.3), wz.mul(0.68).add(29.1)));
  return nMacro.mul(0.52).add(nMid.mul(0.34)).add(nDetail.mul(0.14));
}

/**
 * Wetness masks over a puddle field, driven by cityUniforms.uRoadWetness (0 = bone dry … 1 = right after a downpour):
 * x = damp stains (darker, satin), y = standing water (mirror-smooth; none on a dry day), z = wet film over everything.
 * Water collects in the field's highest (lowest-lying) spots first, so pools appear, grow & merge as wetness rises;
 * `drainage` raises the water line for better-drained surfaces such as the crowned sidewalk flags.
 */
function roadWetMasks(field, drainage = 0.0) {
  const w = cityUniforms.uRoadWetness;
  const level = mix(float(0.86), float(0.56), clamp(w.sub(0.1).div(0.55), 0.0, 1.0)).add(drainage);
  const damp = smoothstep(level.sub(0.09), level.sub(0.015), field);
  const puddle = smoothstep(level, level.add(0.022), field).mul(smoothstep(0.1, 0.22, w));
  const film = smoothstep(0.2, 0.8, w);
  return vec3(damp, puddle, film);
}

/**
 * `detail()` where `active` holds, else `flat`: the value the detail's own fade settles to. Texture that the pixel's footprint or the
 * distance has faded out is skipped, not worked out and multiplied by nothing. Call it inside a Fn, with every input that other code
 * shares or that a derivative is taken of already in a variable (what's first built in a branch is built again outside it, and a
 * derivative can't be taken in one).
 */
function fadedDetail(active, flat, detail) {
  const out = float(flat).toVar();
  If(active, () => {
    out.assign(detail());
  });
  return out;
}

// Distance from p to the nearest border of its jittered 3x3 Voronoi cell (in cell units, ~(F2 - F1) / 2)
const voronoiBorder = Fn(([p]) => {
  const pv = vec2(p).toVar();
  const ip = floor(pv).toVar();
  const fp = fract(pv).toVar();
  const f1 = float(8.0).toVar();
  const f2 = float(8.0).toVar();
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const id = ip.add(vec2(i, j));
      const site = vec2(i, j).add(vec2(hash2D(id), hash2D(id.add(vec2(37.1, 11.7)))).mul(0.8).add(0.1));
      const d = length(fp.sub(site)).toVar();
      f2.assign(min(f2, max(f1, d)));
      f1.assign(min(f1, d));
    }
  }
  return f2.sub(f1).mul(0.5);
});

/**
 * Wear & repairs of the asphalt at world xz, `px` metres a pixel: x = hairline crack coverage (block & alligator
 * cracking in worn stretches), y = signed distance to the edge of a rectangular utility-cut patch (m, < 0 inside),
 * z = pothole depth (0 .. 1 at the bottom of the bowl), w = 1 where the 11 m cell has a patch.
 * Cracks are only traced near the camera and in the worn stretches, where they can show, and potholes only in their cells.
 */
const roadWear = Fn(([wxz, px]) => {
  // Worn stretches: about a quarter of the roadway, in patches a block or so across
  const worn = smoothstep(0.5, 0.78, noise2D(wxz.mul(0.045).add(71.0))).toVar();

  const crack = float(0.0).toVar();
  If(worn.greaterThan(0.001).and(px.lessThan(0.04)), () => {
    const warp = vec2(noise2D(wxz.mul(2.7)), noise2D(wxz.mul(2.7).add(13.0))).sub(0.5).mul(0.35);
    const cell = 0.55;
    const border = voronoiBorder(wxz.div(cell).add(warp)).mul(cell);
    const width = worn.mul(0.0016).add(0.0012);
    const effWidth = max(width, px.mul(0.6));
    crack.assign(float(1.0).sub(smoothstep(effWidth, effWidth.add(px), border)).mul(width.div(effWidth)).mul(worn)
      .mul(smoothstep(0.04, 0.015, px)));
  });

  // Rectangular utility-cut patches (water & sewer trenches): one 11 m cell in five, kept inside its cell. Some are squarish
  // cuts, others long narrow trenches running along the road or across it
  const pCell = floor(wxz.div(11.0));
  const hasPatch = step(0.8, hash2D(pCell.add(vec2(3.7, 8.1))));
  const trench = step(0.6, hash2D(pCell.add(vec2(2.9, 6.3))));
  const alongX = step(0.5, hash2D(pCell.add(vec2(5.5, 9.9))));
  const pCentre = pCell.add(0.5).add(vec2(hash2D(pCell.add(vec2(1.3, 5.9))), hash2D(pCell.add(vec2(9.2, 2.4)))).sub(0.5)
    .mul(mix(float(0.4), float(0.08), trench))).mul(11.0);
  const cutHalf = vec2(hash2D(pCell.add(vec2(4.4, 0.6))).mul(1.8).add(0.6), hash2D(pCell.add(vec2(7.8, 3.1))).mul(1.4).add(0.5));
  const trenchLong = hash2D(pCell.add(vec2(0.7, 4.8))).mul(2.0).add(2.4);
  const trenchNarrow = hash2D(pCell.add(vec2(6.6, 7.2))).mul(0.25).add(0.3);
  const trenchHalf = mix(vec2(trenchNarrow, trenchLong), vec2(trenchLong, trenchNarrow), alongX);
  const pHalf = mix(cutHalf, trenchHalf, trench);
  const pq = abs(wxz.sub(pCentre)).sub(pHalf);
  const patchDist = max(pq.x, pq.y);

  // Potholes, mostly in the worn stretches: a ragged bowl a hand or two across
  const hCell = floor(wxz.div(7.0)).toVar();
  const pothole = float(0.0).toVar();
  If(hash2D(hCell.add(vec2(8.8, 0.3))).greaterThanEqual(float(0.975).sub(worn.mul(0.12))), () => {
    const hCentre = hCell.add(vec2(hash2D(hCell.add(vec2(2.2, 7.7))), hash2D(hCell.add(vec2(6.1, 1.9)))).mul(0.6).add(0.2)).mul(7.0);
    const hRadius = hash2D(hCell.add(vec2(5.3, 4.2))).mul(0.24).add(0.12);
    const hDist = length(wxz.sub(hCentre)).mul(noise2D(wxz.mul(6.0)).sub(0.5).mul(0.5).add(1.0));
    pothole.assign(smoothstep(hRadius.add(px), hRadius.mul(0.35), hDist));
  });

  return vec4(crack.mul(float(1.0).sub(step(patchDist, 0.0).mul(hasPatch))), patchDist, pothole, hasPatch);
});

/**
 * "Tar snakes" at world xz, `px` metres a pixel: the meandering 3-5 cm bands of black crack sealant the city pours over
 * the wider cracks, in a broken network of ~2.4 m cells across sealed stretches of the roadway. Wide enough to read
 * from the car, so they are traced further than the hairline cracks, thinning out before they shrink below a pixel.
 */
const roadTarSnakes = Fn(([wxz, px]) => {
  const zone = smoothstep(0.44, 0.6, noise2D(wxz.mul(0.03).add(17.0))).toVar();
  const snake = float(0.0).toVar();
  If(zone.greaterThan(0.001).and(px.lessThan(0.12)), () => {
    const warp = vec2(noise2D(wxz.mul(0.9)), noise2D(wxz.mul(0.9).add(31.0))).sub(0.5).mul(0.6);
    const cell = 2.4;
    const border = voronoiBorder(wxz.div(cell).add(warp)).mul(cell);
    // Only some cracks were sealed: the network breaks up into runs a few metres long
    const keep = smoothstep(0.38, 0.5, noise2D(wxz.mul(0.6).add(5.0)));
    const width = noise2D(wxz.mul(1.7).add(9.0)).mul(0.006).add(0.007);
    const effWidth = max(width, px.mul(0.6));
    snake.assign(float(1.0).sub(smoothstep(effWidth, effWidth.add(px), border)).mul(width.div(effWidth)).mul(zone).mul(keep)
      .mul(smoothstep(0.12, 0.06, px)));
  });
  return snake;
});

// Dry asphalt reflects far less of the sun than a standard surface does at a low angle. With the standard amount a road is light
// brown looking towards a low sun and dark grey looking away, so it changes colour at every corner. What's wet (metalness, which
// the puddles ride on) still reflects as water does.
const DRY_ASPHALT_SPECULAR = 0.15;
class RoadMaterial extends THREE.MeshStandardNodeMaterial {
  setupSpecular() {
    const dry = vec3(0.04 * DRY_ASPHALT_SPECULAR);
    specularColor.assign(dry);
    specularColorBlended.assign(mix(dry, diffuseColor.rgb, metalness));
    specularF90.assign(mix(float(DRY_ASPHALT_SPECULAR), float(1.0), metalness));
  }
}

/**
 * Road asphalt, Footprint-Filtered Aggregate `bumpNormal`, Scattered Manholes, Wear & Repairs
 * (block cracking, tar-sealed utility-cut patches & trenches, potholes, tar snakes, oil drips, exposed stone chips, a
 * gentle swell of the paving; see roadWear & roadTarSnakes) & Post-Rain Wetness (upgraded with techniques from
 * CityGenerator.js `createRoadMaterial`).
 * cityUniforms.uRoadWetness drives damp stains, a faint wet sheen & standing puddles (roadWetMasks): bone dry at
 * midday and at golden hour, glossy stains & pools mirroring the lights at night. Water's Fresnel rides
 * on metalness (as for the rivers), so puddles reflect the street through SSR at grazing angles yet only darken seen
 * from above.
 * Lane markings are separate geometry built from the road network (js/road-paint.js).
 */
function createRoadSurfaceMaterial() {
  const mat = new RoadMaterial({
    metalness: 0.24,
    roughness: 0.48
  });

  // Weathered, oxidised asphalt (fresh blacktop only in the newer patches)
  const cAsphaltDark = color(0x4c4e51);
  const cAsphaltLight = color(0x77797c);
  const cManhole = color(0x4a433c);
  const cOldPatch = color(0x85878a);

  // World size of a pixel: fine texture settles to its mean before it can alias at grazing angles or from the air
  const pixelSize = length(fwidth(positionWorld.xz));
  // Cracks, utility-cut patches & potholes, shared by every channel below (see roadWear)
  const wear = roadWear(patternXZ, pixelSize);
  const crack = wear.x;
  const patchDist = wear.y;
  const pothole = wear.z;
  const patchCover = smoothstep(pixelSize, pixelSize.negate(), patchDist).mul(wear.w);
  // The tar sealing the saw-cut edge of each patch, a few centimetres wide
  const sealWidth = max(float(0.022), pixelSize.mul(0.75));
  const patchSeal = float(1.0).sub(smoothstep(sealWidth, sealWidth.add(pixelSize), abs(patchDist))).mul(float(0.022).div(sealWidth)).mul(wear.w);
  // Fresh patches are darker & tighter than the roadway, old ones paler & greyer
  const patchFresh = step(0.55, hash2D(floor(patternXZ.div(11.0)).add(vec2(12.9, 6.6))));
  // Exposed light stone chips in the worn surface, settling to their average where they shrink below a pixel
  const chips = Fn(() => {
    const xz = vec2(patternXZ).toVar();
    const px = float(pixelSize).toVar();
    return fadedDetail(px.lessThan(0.03), 0.035, () =>
      mix(float(0.035), smoothstep(0.72, 0.8, noise2D(xz.mul(30.0))), smoothstep(0.03, 0.012, px)));
  })();
  // Tar-snake crack sealant (none over the newer patches)
  const tarSnake = roadTarSnakes(patternXZ, pixelSize).mul(float(1.0).sub(patchCover));
  // Oil & coolant drips from parked & idling cars: ragged dark blots a hand or two across, one 2.5 m cell in three, worked out only in
  // the cells that have one
  const oilDrip = Fn(() => {
    const xz = vec2(patternXZ).toVar();
    const px = float(pixelSize).toVar();
    const oilCell = floor(xz.div(2.5)).toVar();
    return fadedDetail(hash2D(oilCell.add(vec2(7.7, 3.3))).greaterThanEqual(0.66), 0.0, () => {
      const oilCentre = oilCell.add(vec2(hash2D(oilCell.add(vec2(4.1, 2.2))), hash2D(oilCell.add(vec2(8.3, 6.7)))).mul(0.6).add(0.2)).mul(2.5);
      const oilDist = length(xz.sub(oilCentre)).mul(noise2D(xz.mul(5.0)).sub(0.5).mul(0.8).add(1.0));
      const oilRadius = hash2D(oilCell.add(vec2(1.9, 9.4))).mul(0.25).add(0.1);
      return smoothstep(oilRadius.add(px), oilRadius.mul(0.3), oilDist).mul(hash2D(oilCell.add(vec2(2.6, 5.1))).mul(0.6).add(0.4));
    });
  })();

  // Circular cast-iron manhole covers scattered over the roadway (one 14 m cell in three)
  const mhCell = floor(patternXZ.div(14.0));
  const mhCentre = mhCell.add(vec2(hash2D(mhCell.add(13.7)), hash2D(mhCell.add(29.1))).mul(0.6).add(0.2)).mul(14.0);
  const mhDist = length(patternXZ.sub(mhCentre));
  const hasManhole = step(0.66, hash2D(mhCell));

  // Puddle field & wetness masks shared by every channel below (each node is generated once per fragment); potholes
  // hold water first
  const puddleField = roadPuddleField(patternXZ.x, patternXZ.y).add(pothole.mul(0.45));
  const wet = roadWetMasks(puddleField);
  const damp = wet.x;
  const puddle = wet.y;
  const film = wet.z;
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const waterFresnel = pow(float(1.0).sub(clamp(viewDir.y, 0.0, 1.0)), 5.0).mul(0.98).add(0.02);

  mat.aoNode = float(STREET_SKY);

  // Each layer of texture below is skipped where its fade has reached its flat value (fadedDetail()): the pixel's world size and the
  // distance are put in variables first, and the place too, as the layers share it with the rest of the shader
  mat.colorNode = Fn(() => {
    const xz = vec2(patternXZ).toVar();
    const wx = xz.x;
    const wz = xz.y;
    const px = float(pixelSize).toVar();
    const camDist = length(positionWorld.sub(cameraPosition)).toVar();
    const detail = smoothstep(240.0, 22.0, camDist).toVar();

    // Two-scale aggregate grit, patchwork pours, oily wear stains & tar crack seams
    const microAggregate = fadedDetail(px.lessThan(0.06), 0.5, () =>
      mix(float(0.5), noise2D(vec2(wx.mul(16.0), wz.mul(16.0))), smoothstep(0.06, 0.02, px)));
    const fineGrain = fadedDetail(px.lessThan(0.4), 0.5, () =>
      mix(float(0.5), noise2D(vec2(wx.mul(3.2), wz.mul(3.2))), smoothstep(0.4, 0.12, px)));
    const patchNoise = noise2D(vec2(wx.mul(0.18), wz.mul(0.18)));
    const oilyStain = fadedDetail(camDist.lessThan(240.0), 0.0, () =>
      smoothstep(0.52, 0.84, noise2D(vec2(wx.mul(0.42), wz.mul(0.42)))).mul(detail));
    const tarSeam = float(1.0).sub(smoothstep(0.0, 0.015, abs(patchNoise.sub(0.52)))).mul(0.14).mul(detail);
    // Binder-rich (dark) & ravelled, aggregate-exposed (pale) mottling a stride or so across
    const mottle = noise2D(vec2(wx.mul(0.9), wz.mul(0.9)).add(41.0)).mul(0.65).add(noise2D(vec2(wx.mul(2.3), wz.mul(2.3)).add(7.0)).mul(0.35));

    const baseAsphalt = mix(
      cAsphaltDark,
      cAsphaltLight,
      fineGrain.mul(0.22).add(microAggregate.mul(0.22)).add(patchNoise.mul(0.07)).add(smoothstep(0.3, 0.7, mottle).mul(0.07)).add(0.19)
    )
      .mul(float(1.0).sub(oilyStain.mul(0.12)))
      .mul(float(1.0).sub(tarSeam));

    // Utility-cut patches with their tar-sealed edges, stone chips, tar snakes, oil drips, cracks & potholes
    const patchCol = mix(mix(baseAsphalt, cOldPatch, 0.22).mul(1.03), mix(baseAsphalt, color(0x3a3c40), 0.55), patchFresh);
    const repaired = mix(baseAsphalt, patchCol, patchCover)
      .mul(float(1.0).sub(patchSeal.mul(0.5)))
      .add(chips.mul(0.08).mul(float(1.0).sub(patchCover.mul(patchFresh))))
      .mul(float(1.0).sub(tarSnake.mul(0.4)))
      .mul(float(1.0).sub(oilDrip.mul(0.45)))
      .mul(float(1.0).sub(crack.mul(0.65)))
      .mul(float(1.0).sub(pothole.mul(0.4)));

    const isManhole = float(1.0).sub(smoothstep(0.52, 0.60, mhDist)).mul(hasManhole).mul(detail);
    const mhRings = sin(mhDist.mul(36.0)).mul(0.15).add(0.85);

    // Water filling the pores darkens the surface: damp stains & pools most, the overall wet film a little
    const wetDarkening = mix(mix(float(1.0), float(0.72), damp), float(0.6), puddle).mul(mix(float(1.0), float(0.8), film));
    return mix(repaired, cManhole.mul(mhRings), isManhole).mul(wetDarkening);
  })();

  mat.roughnessNode = Fn(() => {
    const xz = vec2(patternXZ).toVar();
    const px = float(pixelSize).toVar();
    const microRough = fadedDetail(px.lessThan(0.08), 0.04, () =>
      mix(float(0.04), noise2D(xz.mul(12.0)).mul(0.08), smoothstep(0.08, 0.03, px)));
    // Tar sealant is glossier, oil satin, fresh patches a little tighter, potholes & cracks rougher
    const dry = float(0.90).add(microRough)
      .sub(patchSeal.mul(0.3))
      .sub(tarSnake.mul(0.38))
      .sub(oilDrip.mul(0.18))
      .sub(patchCover.mul(patchFresh).mul(0.06))
      .add(pothole.mul(0.06));
    // The wet film only takes the edge off the asphalt's mattness (a soft sheen, too rough for SSR); real gloss is kept
    // for the damp stains and the standing water
    const filmed = mix(dry, float(0.68), film.mul(0.7));
    const wetRough = mix(filmed, float(0.4), damp.mul(0.85));
    return mix(wetRough, float(0.1), puddle);
  })();

  // Water's Fresnel (F0 = 0.02): weights SSR & trades diffuse for reflection in pools (fully), damp stains (partly) and
  // the wet film (barely)
  mat.metalnessNode = clamp(waterFresnel.mul(1.6), 0.0, 0.85).mul(max(puddle, max(damp.mul(0.35), film.mul(0.15))));

  // Footprint-gated asphalt relief via bumpNormal (from CityGenerator.js): a gentle swell & sag of the paving, shallow
  // ruts & ripples, 6 mm ravelled coarse texture + 2.2 mm & 1.6 mm aggregate grit, stone chips, hairline cracks, raised
  // patches with their tar seals, tar-snake beads, pothole bowls and the manhole covers' rims & rings. Steps ramp over
  // >= 2 px so no edge sparkles; the finest relief fades before it shrinks to a pixel. Flattens to mirror-smooth 0.0
  // inside standing rainwater puddles so SSR reflections stay crisp!
  mat.normalNode = Fn(() => {
    const xz = vec2(patternXZ).toVar();
    const wx = xz.x;
    const wz = xz.y;
    const px = float(pixelSize).toVar();
    const coarseFade = smoothstep(0.12, 0.035, px).toVar();
    const midFade = smoothstep(0.035, 0.012, px).toVar();
    const fineFade = smoothstep(0.02, 0.006, px).mul(float(1.0).sub(film.mul(0.6))).toVar();
    const ramp = max(float(0.012), px.mul(2.0));

    const swell = noise2D(vec2(wx.mul(0.55), wz.mul(0.55)).add(23.0)).sub(0.5).mul(0.02)
      .add(noise2D(vec2(wx.mul(1.9), wz.mul(1.9))).sub(0.5).mul(0.005));
    const ripples = fadedDetail(px.lessThan(0.3), 0.0, () =>
      noise2D(vec2(wx.mul(3.6), wz.mul(3.6)).add(61.0)).sub(0.5).mul(0.004).mul(smoothstep(0.3, 0.1, px)));
    const coarseGrit = fadedDetail(px.lessThan(0.12), 0.0, () =>
      noise2D(vec2(wx.mul(8.5), wz.mul(8.5))).sub(0.5).mul(0.006).mul(coarseFade));
    const midGrit = fadedDetail(px.lessThan(0.035), 0.0, () =>
      noise2D(vec2(wx.mul(19.0), wz.mul(19.0)).add(3.0)).sub(0.5).mul(0.0022).mul(midFade));
    const fineGrit = fadedDetail(px.lessThan(0.02), 0.0, () =>
      noise2D(vec2(wx.mul(36.0), wz.mul(36.0))).sub(0.5).mul(0.0016).mul(fineFade));
    const chipRelief = chips.mul(0.0015).mul(midFade);
    const snakeBead = tarSnake.mul(0.0018);
    const crackGroove = crack.mul(0.003).mul(smoothstep(0.012, 0.004, px));
    const patchStep = smoothstep(ramp, ramp.negate(), patchDist).mul(wear.w).mul(0.004);
    const sealBead = float(1.0).sub(smoothstep(0.0, max(float(0.03), ramp), abs(patchDist))).mul(wear.w).mul(0.0015);
    const bowl = pothole.mul(0.03);
    const mhRim = float(1.0).sub(smoothstep(0.0, max(float(0.02), ramp), abs(mhDist.sub(0.58)))).mul(0.004);
    const mhPattern = sin(mhDist.mul(36.0)).mul(0.0008).mul(step(mhDist, 0.54)).mul(smoothstep(0.01, 0.004, px));
    const manhole = mhPattern.sub(mhRim).mul(hasManhole).mul(coarseFade);

    const height = swell.add(ripples).add(coarseGrit).add(midGrit).add(fineGrit).add(chipRelief).add(snakeBead).sub(crackGroove)
      .add(patchStep).add(sealBead).sub(bowl).add(manhole);
    return bumpNormal(height.mul(float(1.0).sub(puddle)));
  })();

  // At night the wet road mirrors the sky
  mat.emissiveNode = Fn(() => {
    const roadFresnel = pow(clamp(float(1.0).sub(abs(viewDir.y)), 0.0, 1.0), 2.3);
    const skyMirror = mix(cityUniforms.uSkyHorizonColor, cityUniforms.uSkyTopColor, 0.40).mul(0.10);
    return skyMirror.mul(max(puddle, film.mul(0.35))).mul(roadFresnel).mul(cityUniforms.uInteriorGlow).mul(0.07);
  })();

  return mat;
}

/**
 * Road markings built from the road network (js/road-paint.js): vertex-coloured strips whose `paint` attribute
 * holds (metres along the strip, pattern period, duty cycle) and `side` the offset from the strip's centre line.
 * Strips thinner than ~1.5 px are widened on screen and faded to match (phone-wire AA) and dashes are box-filtered,
 * so distant markings fade out smoothly instead of breaking up and flickering. Worn, and dark & glossy in puddles.
 */
let _roadPaintMaterial = null;

function createRoadPaintMaterial() {
  if (_roadPaintMaterial) return _roadPaintMaterial;
  const mat = new THREE.MeshStandardNodeMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    metalness: 0.0
  });
  mat.mrtNode = _transparentEffectMRT; // SSR keeps seeing the asphalt (and its puddles) underneath

  const paint = attribute('paint', 'vec3');
  const side = attribute('side', 'vec2');
  const sideOffset = vec3(side.x, 0.0, side.y);

  // How much to widen the strip so it is at least 1.5 px wide on screen (1 when it already is)
  const widen = Fn(() => {
    const toClip = (p) => cameraProjectionMatrix.mul(cameraViewMatrix.mul(modelWorldMatrix.mul(vec4(p, 1.0))));
    const edge = toClip(positionGeometry).toVar();
    const centre = toClip(positionGeometry.sub(sideOffset)).toVar();
    const halfWidthPx = length(edge.xy.div(edge.w).sub(centre.xy.div(centre.w)).mul(screenSize).mul(0.5));
    const inFront = step(0.05, min(edge.w, centre.w));
    return clamp(float(0.75).div(max(halfWidthPx, 0.001)), 1.0, 16.0).mul(inFront).max(1.0);
  })();
  mat.positionNode = positionGeometry.add(sideOffset.mul(widen.sub(1.0)));

  // Exact box filter of the dashes (on for `duty` of each period) over the pixel footprint
  const t = paint.x.div(paint.y);
  const footprint = max(fwidth(t), 0.0001);
  const duty = paint.z;
  const onSoFar = (x) => floor(x).mul(duty).add(clamp(fract(x).sub(float(1.0).sub(duty).mul(0.5)), 0.0, duty));
  const dashes = onSoFar(t.add(footprint.mul(0.5))).sub(onSoFar(t.sub(footprint.mul(0.5)))).div(footprint);

  const xz = patternXZ;
  const camDist = length(positionWorld.sub(cameraPosition));
  const detail = smoothstep(70.0, 15.0, camDist);
  const distFade = smoothstep(1650.0, 1300.0, camDist);
  const wear = Fn(() => {
    const w = float(0.5).toVar();
    If(detail.greaterThan(0.001), () => {
      w.assign(mix(float(0.5), noise2D(xz.mul(0.8)).mul(0.6).add(noise2D(xz.mul(2.3)).mul(0.4)), detail));
    });
    return w;
  })();
  mat.opacityNode = dashes.mul(varying(float(1.0).div(widen))).mul(smoothstep(0.1, 0.6, wear).mul(0.4).add(0.55)).mul(distFade);

  // Standing-water puddle mask is zero when uRoadWetness <= 0.1 (e.g. midday); evaluate once and share across channels
  const puddle = Fn(() => {
    const p = float(0.0).toVar();
    If(cityUniforms.uRoadWetness.greaterThan(0.1), () => {
      p.assign(roadWetMasks(roadPuddleField(patternXZ.x, patternXZ.y)).y);
    });
    return p;
  })();
  const film = smoothstep(0.2, 0.8, cityUniforms.uRoadWetness);
  mat.colorNode = vec3(mix(float(1.0), float(0.72), puddle).mul(mix(float(1.0), float(0.86), film)));
  mat.roughnessNode = mix(mix(float(0.62), float(0.42), film), float(0.2), puddle);
  mat.aoNode = float(STREET_SKY);

  _roadPaintMaterial = mat;
  return mat;
}

/**
 * Concrete footpath flags: 5 ft squares with filter-width anti-aliased 6 mm tooled joints (rounded `bumpNormal`
 * grooves, trowelled margins & joint grime), per-flag tone, paler replacement flags, slightly heaved flags, hairline
 * cracks, flattened chewing gum, weathering stains & Post-Rain Damp Patches
 * that follow cityUniforms.uRoadWetness like the roadway (better drained: fewer, smaller pools)
 * (Ported from SidewalkGenerator.js)
 */
function createSidewalkMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({
    metalness: 0.0,
    roughness: 0.88
  });

  const cConcreteA = color(0xa7a197);
  const cConcreteB = color(0x8e887e);
  const cGumOld = color(0x77756f);
  const cGumNew = color(0x34332f);

  // Damp patches & pools on the flags, shared by every channel below (own field; drains better than the roadway)
  const swField = noise2D(vec2(patternXZ.x.mul(0.14).add(7.4), patternXZ.y.mul(0.14).sub(13.1))).mul(0.65)
    .add(noise2D(vec2(patternXZ.x.mul(0.38), patternXZ.y.mul(0.38))).mul(0.35));
  const swWet = roadWetMasks(swField, 0.06);
  const swPuddle = swWet.y.mul(smoothstep(0.5, 0.9, normalWorldGeometry.y));
  const swFresnel = pow(float(1.0).sub(clamp(normalize(cameraPosition.sub(positionWorld)).y, 0.0, 1.0)), 5.0).mul(0.98).add(0.02);
  const pixelSize = length(fwidth(positionWorld.xz));

  // 5 ft (1.524 m) flags poured in place: the flag, where in it (-0.5 .. 0.5) and how far to its tooled joints (m)
  const FLAG = 1.524;
  const wxz = patternXZ;
  const flagCoord = wxz.div(FLAG);
  const flagId = floor(flagCoord);
  const flagHash = hash2D(flagId);
  const flagLocal = fract(flagCoord).sub(0.5);
  const edgeDist = float(0.5).sub(max(abs(flagLocal.x), abs(flagLocal.y))).mul(FLAG);
  // One flag in seven is a newer, paler replacement that hasn't collected the grime & gum of its neighbours yet
  const replaced = step(0.86, flagHash);
  // 6 mm tooled joints filled with dirt, the grime that collects either side of them and the smooth trowelled margin the
  // jointing tool leaves beyond that (filter-width anti-aliased: each settles to its mean once below a pixel)
  const gridBand = (halfWidth) => max(gridLine(patternXZ.x, FLAG, halfWidth), gridLine(patternXZ.y, FLAG, halfWidth));
  const joints = gridBand(0.003);
  const jointGrime = gridBand(0.018);
  const tooledBand = gridBand(0.045).sub(jointGrime).max(0.0);

  // Flattened chewing gum: a dark fresh blob here and there, grey ghosts of older ones, thickest on busy stretches. Only traced where
  // blobs can show, and only in the cells that have one
  const gumCell = 0.32;
  const gumCoord = wxz.div(gumCell);
  const gumId = floor(gumCoord);
  const gum = Fn(() => {
    const xz = vec2(wxz).toVar();
    const px = float(pixelSize).toVar();
    const notReplaced = float(1.0).sub(replaced.mul(0.8)).toVar();
    const coord = vec2(gumCoord).toVar();
    const id = vec2(gumId).toVar();
    return fadedDetail(px.lessThan(0.04), 0.0, () => {
      const gumDensity = smoothstep(0.3, 0.8, noise2D(xz.mul(0.07).add(5.3))).mul(0.4).add(0.12).mul(notReplaced);
      return fadedDetail(hash2D(id.add(vec2(7.7, 3.3))).greaterThanEqual(float(1.0).sub(gumDensity)), 0.0, () => {
        const gumCentre = vec2(hash2D(id.add(vec2(11.3, 2.9))), hash2D(id.add(vec2(23.9, 17.4)))).mul(0.6).add(0.2);
        const gumRadius = hash2D(id.add(vec2(4.1, 31.7))).mul(0.011).add(0.006);
        const gumWobble = noise2D(coord.mul(9.0)).sub(0.5).mul(0.35).add(1.0);
        const gumDist = length(fract(coord).sub(gumCentre)).mul(gumCell).mul(gumWobble);
        const gumAA = max(px, 0.001);
        return smoothstep(gumRadius.add(gumAA), gumRadius.sub(gumAA.mul(0.5)), gumDist).mul(smoothstep(0.04, 0.015, px));
      });
    });
  })();
  const gumAge = hash2D(gumId.add(vec2(19.1, 0.7)));

  // Hairline settlement cracks across about one flag in eight, wandering a little
  const crackAngle = hash2D(flagId.add(vec2(5.5, 1.3))).mul(Math.PI);
  const crackOffset = hash2D(flagId.add(vec2(8.8, 6.2))).sub(0.5).mul(0.6);
  const crackWander = noise2D(wxz.mul(7.0)).sub(0.5).mul(0.02).add(noise2D(wxz.mul(1.7).add(3.7)).sub(0.5).mul(0.07));
  const crackDist = dot(flagLocal, vec2(cos(crackAngle), sin(crackAngle))).sub(crackOffset).mul(FLAG).add(crackWander);
  const hasCrack = step(0.875, hash2D(flagId.add(vec2(41.7, 9.2)))).mul(float(1.0).sub(replaced));
  const crack = lineAA(crackDist, 0.0012).mul(hasCrack).mul(smoothstep(0.004, 0.02, edgeDist));

  mat.aoNode = float(STREET_SKY);

  // As on the road, each layer of texture is skipped where its fade has reached its flat value (fadedDetail())
  mat.colorNode = Fn(() => {
    const xz = vec2(patternXZ).toVar();
    const wx = xz.x;
    const wz = xz.y;
    const px = float(pixelSize).toVar();
    const camDist = length(positionWorld.sub(cameraPosition)).toVar();
    const detail = smoothstep(190.0, 16.0, camDist).toVar();

    // Pour-to-pour tone, broad traffic-worn & weathered stains, and fine exposed aggregate
    const tone = noise2D(vec2(wx.mul(0.48), wz.mul(0.48)));
    const stainField = noise2D(vec2(wx.mul(0.8), wz.mul(0.8)).add(17.0)).mul(0.65).add(noise2D(vec2(wx.mul(2.6), wz.mul(2.6))).mul(0.35));
    const stain = smoothstep(0.52, 0.86, stainField).mul(mix(float(0.24), float(0.08), replaced));
    const grit = fadedDetail(px.lessThan(0.07).and(camDist.lessThan(190.0)), 0.0, () =>
      noise2D(vec2(wx.mul(14.0), wz.mul(14.0))).sub(0.5).mul(0.07).mul(detail).mul(smoothstep(0.07, 0.02, px)));
    // Cloudy trowel & curing mottling a hand or two across
    const mottle = fadedDetail(px.lessThan(0.15), 0.0, () =>
      noise2D(vec2(wx.mul(3.1), wz.mul(3.1)).add(41.0)).mul(0.6).add(noise2D(vec2(wx.mul(7.3), wz.mul(7.3))).mul(0.4))
        .sub(0.5).mul(0.12).mul(smoothstep(0.15, 0.05, px)));
    const aggregate = fadedDetail(px.lessThan(0.02), 0.0, () =>
      noise2D(vec2(wx.mul(55.0), wz.mul(55.0))).sub(0.5).mul(0.08).mul(smoothstep(0.02, 0.006, px)));

    const flagTone = flagHash.sub(0.5).mul(0.2).add(1.0).mul(mix(float(1.0), float(1.1), replaced));
    const concrete = mix(cConcreteB, cConcreteA, tone)
      .mul(flagTone)
      .mul(float(1.0).sub(stain))
      .mul(mottle.add(1.0))
      .add(grit.add(aggregate).mul(0.6))
      .mul(tooledBand.mul(0.06).add(1.0))
      .mul(float(1.0).sub(jointGrime.mul(0.18)));

    const withGum = mix(concrete, mix(cGumNew, cGumOld, gumAge), gum.mul(mix(float(0.9), float(0.45), gumAge)));
    const withJoints = withGum.mul(float(1.0).sub(joints.mul(0.55).mul(detail))).mul(float(1.0).sub(crack.mul(0.45)));

    // Post-rain damp patches, pools & the overall wet film darken the flags
    return withJoints
      .mul(mix(float(1.0), float(0.72), max(swWet.x, swPuddle)))
      .mul(mix(float(1.0), float(0.8), swWet.z));
  })();

  mat.roughnessNode = Fn(() => {
    const dry = float(0.9).sub(flagHash.mul(0.06)).sub(tooledBand.mul(0.1)).sub(gum.mul(0.25));
    const wetRough = mix(dry, float(0.55), max(swWet.z, swWet.x.mul(0.7)));
    return mix(wetRough, float(0.2), swPuddle);
  })();

  // Water's Fresnel (F0 = 0.02) on pools & the wet film, as for the roadway
  mat.metalnessNode = clamp(swFresnel.mul(1.6), 0.0, 0.85).mul(max(swPuddle, swWet.z.mul(0.3)));

  // 6 mm tooled joint grooves with rounded edges, flags heaved a little out of true by tree roots & frost, hairline
  // cracks, gum blobs and concrete grain via bumpNormal. Edges ramp over >= 2 px so nothing sparkles along the joints.
  mat.normalNode = Fn(() => {
    const xz = vec2(patternXZ).toVar();
    const wx = xz.x;
    const wz = xz.y;
    const px = float(pixelSize).toVar();
    const camDist = length(positionWorld.sub(cameraPosition)).toVar();
    const detail = smoothstep(140.0, 14.0, camDist);
    const rampPx = px.mul(2.0);

    const groove = float(1.0).sub(smoothstep(0.003, max(float(0.012), rampPx), edgeDist)).mul(0.006).mul(smoothstep(0.02, 0.006, px));
    const tiltAngle = hash2D(flagId.add(vec2(2.3, 13.1))).mul(Math.PI * 2.0);
    const tiltSlope = hash2D(flagId.add(vec2(29.3, 3.7))).mul(0.012).mul(float(1.0).sub(replaced));
    const tilt = dot(flagLocal, vec2(cos(tiltAngle), sin(tiltAngle))).mul(FLAG).mul(tiltSlope)
      .mul(smoothstep(0.0, max(float(0.06), px.mul(3.0)), edgeDist));
    // The whole relief fades out with distance, so its grain is skipped beyond that
    const grain = fadedDetail(camDist.lessThan(140.0), 0.0, () => noise2D(vec2(wx.mul(4.5), wz.mul(4.5))).sub(0.5).mul(0.003));
    const pores = fadedDetail(px.lessThan(0.012), 0.0, () =>
      noise2D(vec2(wx.mul(38.0), wz.mul(38.0))).sub(0.5).mul(0.0008).mul(smoothstep(0.012, 0.004, px)));
    const height = grain.add(pores).add(tilt).sub(groove).sub(crack.mul(0.0015)).add(gum.mul(0.0008))
      .mul(detail).mul(float(1.0).sub(swPuddle));
    return bumpNormal(height);
  })();

  return mat;
}

/**
 * Dressed stone kerb TSL material (ported from SidewalkGenerator.js `createCurbMaterial`)
 * Dense cool grey flamed granite with 1.5m segment joints, grimier road-facing vertical face,
 * and `bumpNormal` granite grain.
 */
function createCurbMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({
    metalness: 0.06,
    roughness: 0.72
  });

  mat.aoNode = float(STREET_SKY);

  // The speckle and the grain are skipped beyond the distance they fade out at (fadedDetail())
  mat.colorNode = Fn(() => {
    const xz = vec2(patternXZ).toVar();
    const wx = xz.x;
    const wz = xz.y;
    const camDist = length(positionWorld.sub(cameraPosition)).toVar();
    const detail = smoothstep(180.0, 16.0, camDist).toVar();

    const tone = noise2D(vec2(wx.mul(0.6), wz.mul(0.6)));
    const speckle = fadedDetail(camDist.lessThan(180.0), 0.0, () =>
      noise2D(vec2(wx.mul(18.0), wz.mul(18.0))).sub(0.5).mul(0.06).mul(detail));
    const stone = mix(color(0x4c4c45), color(0x63635a), tone).add(speckle);

    const joints = max(gridLine(wx, 1.5, 0.005), gridLine(wz, 1.5, 0.005)).mul(detail);
    const topFace = smoothstep(0.5, 0.85, normalWorldGeometry.y);
    const wetFilm = smoothstep(0.2, 0.8, cityUniforms.uRoadWetness); // rain-darkened granite, like the roadway's film
    return mix(stone.mul(0.68), stone, topFace).mul(float(1.0).sub(joints.mul(0.42))).mul(mix(float(1.0), float(0.78), wetFilm));
  })();

  mat.roughnessNode = mix(float(0.72), float(0.5), smoothstep(0.2, 0.8, cityUniforms.uRoadWetness));

  mat.normalNode = Fn(() => {
    const xz = vec2(patternXZ).toVar();
    const wx = xz.x;
    const wz = xz.y;
    const camDist = length(positionWorld.sub(cameraPosition)).toVar();
    const grain = fadedDetail(camDist.lessThan(120.0), 0.0, () =>
      noise2D(vec2(wx.mul(5.5), wz.mul(5.5))).sub(0.5).mul(0.0022).mul(smoothstep(120.0, 12.0, camDist)));
    return bumpNormal(grain);
  })();

  return mat;
}

/**
 * Tileable wind-wave texture shared by every water surface, synthesised once on the CPU: a random-phase directional
 * wind-sea spectrum (k^-4 saturation range above a spectral peak, cos² spreading) inverse-FFT'd to height & slopes.
 * RGBA half-float: R,G = slope (dh/du, dh/dv in tile units, unit RMS), B = squared slope, A = height (unit RMS).
 * The box-filtered mip chain is averaged in float, so trilinear / anisotropic sampling returns the mean slope AND the
 * mean squared slope over each pixel footprint: their difference is the slope variance of waves too small to resolve,
 * which createWaterMaterial turns into GGX roughness (LEAN mapping) instead of letting them shimmer.
 */
let _waterWaveTexture = null;

// In-place 2D inverse FFT (unnormalised, n = power of two) on separate real / imaginary arrays
function fft2DInverse(re, im, n) {
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const fft1D = () => {
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = ar[i]; ar[i] = ar[j]; ar[j] = t;
        t = ai[i]; ai[i] = ai[j]; ai[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const wr = Math.cos((2 * Math.PI) / len);
      const wi = Math.sin((2 * Math.PI) / len);
      for (let i = 0; i < n; i += len) {
        let cr = 1;
        let ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k;
          const b = a + half;
          const tr = ar[b] * cr - ai[b] * ci;
          const ti = ar[b] * ci + ai[b] * cr;
          ar[b] = ar[a] - tr; ai[b] = ai[a] - ti;
          ar[a] += tr; ai[a] += ti;
          const nr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = nr;
        }
      }
    }
  };
  for (let pass = 0; pass < 2; pass++) { // rows, then columns
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) { const idx = pass === 0 ? r * n + c : c * n + r; ar[c] = re[idx]; ai[c] = im[idx]; }
      fft1D();
      for (let c = 0; c < n; c++) { const idx = pass === 0 ? r * n + c : c * n + r; re[idx] = ar[c]; im[idx] = ai[c]; }
    }
  }
}

function getWaterWaveTexture() {
  if (_waterWaveTexture) return _waterWaveTexture;
  const N = 256;
  const size = N * N;
  let seed = 0x2f6b9d1;
  const rand = () => { // mulberry32
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gRe = new Float64Array(size);
  const gIm = new Float64Array(size);
  for (let i = 0; i < size; i++) { // complex Gaussian white noise (Box-Muller)
    const r = Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-9)));
    const a = 2 * Math.PI * rand();
    gRe[i] = r * Math.cos(a);
    gIm[i] = r * Math.sin(a);
  }

  const sRe = new Float64Array(size); // slope field packed as dh/du + i dh/dv
  const sIm = new Float64Array(size);
  const hRe = new Float64Array(size); // height field
  const hIm = new Float64Array(size);
  const kPeak = 5.0; // spectral peak (cycles per tile)
  const kCut = 56.0; // soft high cut, well inside Nyquist so slopes stay resolved at mip 0
  const windU = Math.cos(0.3);
  const windV = Math.sin(0.3);
  for (let y = 0; y < N; y++) {
    const ky = y < N / 2 ? y : y - N;
    for (let x = 0; x < N; x++) {
      const kx = x < N / 2 ? x : x - N;
      const k = Math.hypot(kx, ky);
      if (k < 1 || k > N / 2 - 2) continue;
      const c = (kx * windU + ky * windV) / k;
      const spread = 0.22 + c * c; // mostly along the wind axis, with some cross-sea
      const amp = Math.sqrt(spread * Math.exp(-1.25 * (kPeak / k) ** 2 - (k / kCut) ** 2)) / (k * k);
      const i = y * N + x;
      const m = ((N - y) % N) * N + ((N - x) % N); // index of -k: H(-k) = conj(H(k)) keeps both fields real
      const aRe = (gRe[i] + gRe[m]) * amp;
      const aIm = (gIm[i] - gIm[m]) * amp;
      hRe[i] = aRe;
      hIm[i] = aIm;
      sRe[i] = -kx * aIm - ky * aRe; // FFT⁻¹(i·kx·H − ky·H) = dh/du + i·dh/dv (up to 2π, normalised below)
      sIm[i] = kx * aRe - ky * aIm;
    }
  }
  fft2DInverse(sRe, sIm, N);
  fft2DInverse(hRe, hIm, N);

  let s2 = 0;
  let h2 = 0;
  for (let i = 0; i < size; i++) {
    s2 += sRe[i] * sRe[i] + sIm[i] * sIm[i];
    h2 += hRe[i] * hRe[i];
  }
  const sNorm = 1 / Math.sqrt(s2 / size);
  const hNorm = 1 / Math.sqrt(h2 / size);

  let w = N;
  let level = new Float32Array(size * 4);
  for (let i = 0; i < size; i++) {
    const sx = sRe[i] * sNorm;
    const sy = sIm[i] * sNorm;
    level[i * 4] = sx;
    level[i * 4 + 1] = sy;
    level[i * 4 + 2] = sx * sx + sy * sy;
    level[i * 4 + 3] = hRe[i] * hNorm;
  }
  const toHalf = THREE.DataUtils.toHalfFloat;
  const mipmaps = [];
  for (;;) {
    const data = new Uint16Array(level.length);
    for (let i = 0; i < level.length; i++) data[i] = toHalf(level[i]);
    mipmaps.push({ data, width: w, height: w });
    if (w === 1) break;
    const h = w >> 1;
    const next = new Float32Array(h * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < h; x++) {
        for (let c = 0; c < 4; c++) {
          const a = (2 * y * w + 2 * x) * 4 + c;
          next[(y * h + x) * 4 + c] = 0.25 * (level[a] + level[a + 4] + level[a + w * 4] + level[a + w * 4 + 4]);
        }
      }
    }
    level = next;
    w = h;
  }

  const tex = new THREE.DataTexture(mipmaps[0].data, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mipmaps = mipmaps;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = false;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  _waterWaveTexture = tex;
  return tex;
}

/**
 * Sydney Harbour: physically based water TSL material
 * - Wave normals (normalNode) from 4 rotated, scaled & drifting samples of the LEAN wave texture whose energy follows
 *   slowly drifting wind patches; the slope variance below each pixel footprint (plus always-unresolved capillary
 *   ripples) becomes GGX roughness, so crisp chop near the piers turns into a soft glitter path towards the horizon
 *   and from the air, without shimmer or visible tiling.
 * - Murky, sediment-laden green-grey body colour lit as a diffuse volume. Metalness carries the water's Fresnel
 *   (F0 = 0.02): it hands the transmitted share to the body colour and weights the pipeline's SSR, so reflections come
 *   only from the sky IBL, the sun's GGX specular and SSR (no painted-in glint).
 * - Park lakes, the Reservoir & fountains (well above the harbour) get finer, calmer ripples and a greener, duller body.
 */
function createWaterMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({
    metalness: 0.0,
    roughness: 0.25
  });

  const waveTex = getWaterWaveTexture();
  const harbourY = CITY_BOUNDS ? CITY_BOUNDS.waterLevel : -2.2;
  const pond = smoothstep(harbourY + 1.0, harbourY + 2.0, positionWorld.y);

  // [tile size (m), rotation (rad), RMS slope]: incommensurate scales & angles so no pattern repeats
  const LAYERS = [
    [61.0, 0.0, 0.052],
    [23.3, 1.93, 0.06],
    [8.7, 4.07, 0.064],
    [3.3, 2.71, 0.064]
  ];

  // vec4(mean slope x, mean slope z, unresolved slope variance, crest height)
  const waves = Fn(() => {
    const p = patternXZ;
    const t = time;
    const q = p.mul(mix(float(1.0), float(2.6), pond)); // sheltered ponds: finer ripples

    // Wind patches drifting with the breeze: large-scale wave energy that reads from the air and hides tiling
    const gustA = steadyNoise2D(p.mul(0.0047).add(vec2(t.mul(0.011), t.mul(-0.007))));
    const gustB = steadyNoise2D(p.mul(0.0135).add(vec2(t.mul(-0.009), t.mul(0.013))).add(31.7));
    const gust = smoothstep(0.18, 0.82, gustA.mul(0.62).add(gustB.mul(0.38)));
    const energy = mix(float(0.45), float(1.3), gust).mul(mix(float(1.0), float(0.42), pond)).toVar();

    const slope = vec2(0.0, 0.0).toVar();
    const variance = energy.mul(energy).mul(0.0022).toVar(); // capillary ripples, always below a pixel
    const crest = float(0.0).toVar();
    for (const [L, rot, sigma] of LAYERS) {
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      const speed = (0.8 * Math.sqrt(L / 9)) / L; // ~phase speed of the tile's dominant waves, in tiles per second
      const uv = vec2(q.x.mul(c).sub(q.y.mul(s)), q.x.mul(s).add(q.y.mul(c))).div(L)
        .add(vec2(Math.cos(0.3) * speed, Math.sin(0.3) * speed).mul(t));
      const smp = texture(waveTex, uv);
      const amp = energy.mul(sigma);
      slope.addAssign(vec2(smp.x.mul(c).add(smp.y.mul(s)), smp.y.mul(c).sub(smp.x.mul(s))).mul(amp));
      variance.addAssign(max(smp.z.sub(dot(smp.xy, smp.xy)), 0.0).mul(amp.mul(amp)));
      crest.addAssign(smp.w.mul(sigma));
    }
    return vec4(slope, variance, crest.mul(4.0));
  })();

  const slope = waves.xy;
  const variance = waves.z;
  // Fountain rims & other non-horizontal faces keep their own normal
  const flatTop = smoothstep(0.5, 0.9, normalWorldGeometry.y);
  const waterNormal = normalize(mix(normalWorldGeometry, vec3(slope.x.negate(), 1.0, slope.y.negate()), flatTop));
  mat.normalNode = cameraViewMatrix.transformDirection(waterNormal);

  // GGX alpha ≈ RMS slope of the unresolved waves (Beckmann m), roughness = sqrt(alpha); murkier ponds a touch duller
  mat.roughnessNode = clamp(pow(variance, 0.25).add(pond.mul(0.05)), 0.08, 0.65);

  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const fresnel = pow(float(1.0).sub(clamp(dot(waterNormal, viewDir), 0.0, 1.0)), 5.0).mul(0.98).add(0.02);
  mat.metalnessNode = clamp(fresnel.mul(1.6), 0.0, 0.9);

  // Sediment-laden estuary: deep blue-green grey ↔ silty olive grey; thin sunlit crests transmit a greener tint
  mat.colorNode = Fn(() => {
    const silt = steadyNoise2D(patternXZ.mul(0.0031).add(7.3));
    const body = mix(color(0x162d2c), color(0x2e3f36), smoothstep(0.25, 0.85, silt));
    const lake = mix(color(0x24321f), color(0x33402a), silt);
    const crestTint = smoothstep(0.6, 2.4, waves.w).mul(0.35).add(1.0);
    return mix(body, lake, pond).mul(crestTint);
  })();


  // After dark the harbour holds a little of the city's glow; SSR reflects whatever is close by
  mat.emissiveNode = color(0x20344e).mul(smoothstep(0.55, 1.35, cityUniforms.uInteriorGlow).mul(0.35));
  return mat;
}

/**
 * Park Lawn Multi-Octave Turf, Clover & Mowing Stripes TSL Material
 */
function createParkLawnMaterial(isMeadow = false) {
  const mat = new THREE.MeshStandardNodeMaterial({
    metalness: 0.0,
    roughness: 0.86
  });

  const cGrassDeep = color(isMeadow ? 0x2c5c28 : 0x224c20);
  const cGrassMid = color(isMeadow ? 0x457d36 : 0x36682c);
  const cGrassSun = color(0x6b9c3e);

  mat.colorNode = Fn(() => {
    const wp = patternXZ;
    const macroPatch = noise2D(wp.mul(0.06));
    const midClover = noise2D(wp.mul(0.35));
    const microBlade = noise2D(wp.mul(3.8));
    const mowStripe = sin(wp.x.mul(0.55).add(wp.y.mul(0.25))).mul(0.5).add(0.5);

    const baseLawn = mix(
      cGrassDeep,
      cGrassMid,
      macroPatch.mul(0.45).add(midClover.mul(0.35)).add(mowStripe.mul(0.20))
    );
    return mix(baseLawn, cGrassSun, microBlade.mul(0.38));
  })();

  mat.normalNode = Fn(() => {
    const wp = patternXZ;
    const camDist = length(positionWorld.sub(cameraPosition));
    const detail = smoothstep(85.0, 10.0, camDist);
    const turf = noise2D(wp.mul(7.5)).sub(0.5).mul(0.008);
    return bumpNormal(turf.mul(detail));
  })();

  // Grass is a canopy of blades that shadow each other, not a flat dielectric: at grazing angles a plain F0 = 0.04 /
  // F90 = 1 Fresnel mirrors the sky and turns lawns teal, so weaken the specular and cap its grazing rise
  mat.setupSpecular = function () {
    specularColor.assign(vec3(0.025));
    specularColorBlended.assign(vec3(0.025));
    specularF90.assign(0.3);
  };

  return mat;
}

/**
 * A garden's beds (js/garden.js): mulch or gravel, speckled with what's planted in them, so they read as planted from further off than
 * their plants are drawn. Up to four kinds of bed, `beds` as [{ soil, speckles (three colours), cover (how much of it they cover) }]; a
 * vertex's colour says which (its red, the kind over 3), so one material draws them all.
 */
/**
 * Sandstone in courses, as the harbour's sea walls are built: blocks about 1.2 m long and 0.45 m high, each its own shade of honey to
 * ochre, with thin pale joints, and the stone darker and greener up to half a metre over the water, where the tide wets it. The blocks
 * run along the world's x + z, so a wall facing any way has them; the courses go by height.
 */
function createSandstoneWallMaterial({ waterLevel }) {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0.0, roughness: 0.9 });
  mat.colorNode = Fn(() => {
    const y = positionWorld.y;
    const course = y.div(0.45);
    const row = floor(course);
    const along = patternXZ.x.add(patternXZ.y).div(1.2).add(mod(row, 2.0).mul(0.5));
    const shade = hash2D(vec2(floor(along), row));
    const grain = noise2D(patternXZ.mul(2.5).add(vec2(y.mul(2.5), y.mul(1.7)))).mul(0.14).add(0.93);
    const stone = mix(color(0xb59462), color(0x8c6c45), shade).mul(grain);
    // Joints about 2 cm wide, fading out as they shrink under a pixel
    const joint = max(smoothstep(0.455, 0.49, abs(fract(course).sub(0.5))), smoothstep(0.47, 0.495, abs(fract(along).sub(0.5))))
      .mul(float(1.0).sub(smoothstep(0.08, 0.3, fwidth(course))));
    const laid = mix(stone, color(0xcdbb98), joint.mul(0.6));
    const wet = float(1.0).sub(smoothstep(waterLevel + 0.1, waterLevel + 0.7, y));
    return mix(laid, color(0x3d4836), wet.mul(0.7));
  })();
  return mat;
}

/**
 * A beach's sand (js/city-grid.js): pale gold, in drifts and wind ripples, darker and shinier within half a metre of the water where the
 * swash wets it, and over that a band of foam that runs up the slope and back every ten seconds or so. The beach runs down under the
 * water (its face, drawn past the shore), so the sea meets it at a line, and the foam is where they meet.
 */
function createSandMaterial({ waterLevel }) {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0.0, roughness: 0.93 });
  const y = positionWorld.y;
  const wetness = smoothstep(waterLevel + 0.55, waterLevel + 0.08, y);
  mat.colorNode = Fn(() => {
    const p = patternXZ;
    const drift = noise2D(p.mul(0.045));
    const grain = noise2D(p.mul(2.7));
    const ripple = sin(p.x.mul(1.4).add(p.y.mul(0.45)).add(noise2D(p.mul(0.18)).mul(5.0))).mul(0.5).add(0.5);
    const dry = mix(color(0xab8b56), color(0xc4a36d), drift.mul(0.6).add(grain.mul(0.22)).add(ripple.mul(0.18)));
    const wet = mix(color(0x7d6440), color(0x8f7650), grain);
    const sand = mix(dry, wet, wetness);
    // The swash: how far up the slope it reaches now, by where it is along the beach, and lace in its foam
    const along = p.x.mul(0.045).add(p.y.mul(0.031));
    const reach = sin(time.mul(0.62).add(along.mul(6.2831))).mul(0.5).add(0.5).mul(0.24).add(waterLevel + 0.04);
    const lace = noise2D(p.mul(1.7).add(vec2(time.mul(0.35), time.mul(-0.22))));
    const band = smoothstep(reach, reach.sub(0.07), y).mul(smoothstep(waterLevel - 0.06, waterLevel + 0.01, y));
    return mix(sand, color(0xf2f4f1), band.mul(smoothstep(0.22, 0.6, lace)));
  })();
  mat.roughnessNode = mix(float(0.95), float(0.42), wetness);
  mat.normalNode = Fn(() => {
    const camDist = length(positionWorld.sub(cameraPosition));
    const ripple = sin(patternXZ.x.mul(1.4).add(patternXZ.y.mul(0.45)).add(noise2D(patternXZ.mul(0.18)).mul(5.0)));
    return bumpNormal(ripple.mul(0.006).mul(smoothstep(60.0, 8.0, camDist)).mul(float(1.0).sub(wetness)));
  })();
  return mat;
}

/**
 * The coast's sandstone where it's bare (js/city-grid.js): its headlands, the cliffs' faces and the rock shelves at the water's edge.
 * Honey and orange-brown in layers by height, weathered grey in patches, pitted dark, and wet, dark and green up to half a metre over the
 * sea, as a shelf awash is.
 */
function createCoastRockMaterial({ waterLevel }) {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0.0, roughness: 0.9, side: THREE.DoubleSide });
  // Over the lawn on a cliff's slope, where the two are triangulated apart: pulled towards the eye by the slope, as the garden's paths are
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -4;
  mat.polygonOffsetUnits = -4;
  const y = positionWorld.y;
  const wet = smoothstep(waterLevel + 0.6, waterLevel + 0.12, y);
  mat.colorNode = Fn(() => {
    const p = patternXZ;
    const layer = sin(y.mul(7.0).add(noise2D(p.mul(0.25)).mul(4.0))).mul(0.5).add(0.5);
    const tone = noise2D(p.mul(0.11));
    const stone = mix(mix(color(0x9c6a3a), color(0x7e4c27), tone), color(0xab7d4a), layer.mul(0.35));
    const weathered = mix(stone, color(0x77716a), smoothstep(0.5, 0.85, noise2D(p.mul(0.035).add(3.1))).mul(0.55));
    const pits = smoothstep(0.62, 0.9, noise2D(p.mul(1.9))).mul(0.35);
    const dry = weathered.mul(float(1.0).sub(pits));
    return mix(dry, mix(color(0x3e3a2a), color(0x4a5236), noise2D(p.mul(0.6))), wet.mul(0.85));
  })();
  mat.roughnessNode = mix(float(0.92), float(0.5), wet);
  mat.normalNode = Fn(() => {
    const camDist = length(positionWorld.sub(cameraPosition));
    const rough = noise2D(patternXZ.mul(1.3)).mul(0.05).add(noise2D(patternXZ.mul(4.1)).mul(0.012));
    return bumpNormal(rough.mul(smoothstep(80.0, 10.0, camDist)));
  })();
  return mat;
}

// A structure's face laid in stone carries this in its uv.y, its distance along the wall in uv.x (js/structures.js); a face that's to
// look like the plain dark ground under the city (js/city-grid.js), this
const STONE_FACE = 1e6, BASE_FACE = 2e6;

/**
 * Roads off the ground (js/structures.js), in one material, so a tile's structures are one draw:
 * - The walls of cuttings, tunnel approaches and embankments, where the geometry says so (uv.y = STONE_FACE): Sydney sandstone in dressed
 *   blocks, as along the Bradfield Highway and through the Warringah Freeway's cuttings. Courses 0.6 m high of blocks 0.9-1.9 m long, each
 *   course its own length and set off from the last, each block its own tone from honey and ochre to weathered grey, banded with
 *   ironstone, streaked where water runs down, joints thin and pale. uv.x is the wall's own distance along it, so a curved wall keeps its
 *   courses; heights are the world's.
 * - Everything else, decks' undersides, barriers, medians, tunnels' ceilings and piers: plain concrete, grey, mottled, with the faint
 *   lines of its formwork.
 */
function createStructureMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0.0, roughness: 0.9 });
  mat.colorNode = Fn(() => {
    const y = positionWorld.y;
    const s = uv().x;
    const course = y.div(0.6);
    const row = floor(course);
    const blockLength = hash2D(vec2(row, 17.0)).add(0.9);
    const along = s.div(blockLength).add(hash2D(vec2(row, 3.0)));
    const block = floor(along);
    const tone = hash2D(vec2(block, row));
    const weather = hash2D(vec2(block.add(31.0), row));
    const honey = mix(color(0xb59a72), color(0xa1825c), smoothstep(0.3, 1.0, tone).mul(0.7));
    const sandstone = mix(honey, color(0x948f84), weather.mul(0.35).add(0.25));
    // Ironstone in bands across each block, and the stone's grain
    const bands = noise2D(vec2(s.mul(0.9), y.mul(2.6)).add(vec2(block.mul(5.3), row.mul(1.7))));
    const iron = smoothstep(0.64, 0.82, bands).mul(0.3);
    const grain = noise2D(vec2(s, y).mul(7.0)).mul(0.12).add(0.94);
    // Streaks where water runs down the face, long and narrow
    const streak = smoothstep(0.55, 0.85, noise2D(vec2(s.mul(1.6), y.mul(0.12)))).mul(0.28);
    const laid = mix(sandstone, color(0x7d5a3c), iron).mul(grain).mul(float(1.0).sub(streak));
    // Joints about 1.5 cm, pale, with the dressed edge of each block a little darker beside them; faded out under a pixel
    const fx = abs(fract(along).sub(0.5)).mul(blockLength), fy = abs(fract(course).sub(0.5)).mul(0.6);
    const edge = min(float(0.5).mul(blockLength).sub(fx), float(0.3).sub(fy));
    const fade = float(1.0).sub(smoothstep(0.03, 0.12, fwidth(s).add(fwidth(y))));
    const joint = float(1.0).sub(smoothstep(0.006, 0.012, edge)).mul(fade);
    const arris = float(1.0).sub(smoothstep(0.012, 0.05, edge)).mul(fade).mul(0.18);
    const stone = mix(laid.mul(float(1.0).sub(arris)), color(0xd6cbb2), joint.mul(0.85));

    const p = vec2(patternXZ.x.add(patternXZ.y), y);
    const mottle = noise2D(p.mul(0.35)).mul(0.6).add(noise2D(p.mul(2.2)).mul(0.4));
    const lines = float(1.0).sub(smoothstep(0.0, 0.03, abs(fract(y.div(1.2)).sub(0.5)).sub(0.47).abs())).mul(0.06);
    const concrete = mix(color(0x8c8a83), color(0xa3a199), mottle).mul(float(1.0).sub(lines));
    return mix(mix(concrete, stone, step(STONE_FACE * 0.5, uv().y)), color(0x2c2b29), step(STONE_FACE * 1.5, uv().y));
  })();
  return mat;
}

/**
 * A palisade fence of black steel along the top of a cutting's wall: bars 13 cm apart with pointed heads between two rails, cut out of a
 * strip whose uv is (m along it, m up from its foot), so a whole fence is one draw
 */
function createPalisadeMaterial(height) {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0x1b1d1e, metalness: 0.45, roughness: 0.55, side: THREE.DoubleSide });
  const u = uv().x.div(0.13), v = uv().y;
  const across = abs(fract(u).sub(0.5)).mul(0.13); // m from the middle of the nearest bar
  // The bar narrows to a point over its last 8 cm
  const head = clamp(float(height).sub(v).div(0.08), 0.0, 1.0);
  const bar = step(across, head.mul(0.014)).mul(step(v, float(height)));
  const rails = max(step(abs(v.sub(0.12)), float(0.025)), step(abs(v.sub(height - 0.18)), float(0.025)));
  mat.opacityNode = max(bar, rails);
  mat.alphaTest = 0.5;
  return mat;
}

/**
 * A garden's pond: still, fresh water, dark olive with slow patches of green and brown where it's shallow or weedy, and only a soft
 * sheen of the sky. The harbour's water is a dark mirror with waves; this is neither.
 */
function createPondMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0.0, roughness: 0.32 });
  mat.colorNode = Fn(() => {
    const patch = noise2D(patternXZ.mul(0.18)).mul(0.6).add(noise2D(patternXZ.mul(0.7)).mul(0.4));
    return mix(color(0x1e2a1b), color(0x3a4429), smoothstep(0.35, 0.85, patch));
  })();
  return mat;
}

/**
 * A garden's paths (js/garden.js): the colour in each vertex. A track is a strip worn into the lawn, not laid on it: its vertices carry how
 * far across it they are in the colour's fourth value, 0 to 0.5, where a path's have 1 (a geometry with no fourth value reads as 1). Its
 * edges are ragged, cut by noise along it, and its colour mottled and darker towards them. No branch and no derivative: a pixel off a track
 * takes exactly its colour.
 */
function createGardenPathMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0.0, roughness: 0.9 });
  const vc = vertexColor();
  const track = float(1.0).sub(step(0.75, vc.a));
  const across = clamp(vc.a.mul(2.0), 0.0, 1.0);
  // 0 at either side of a track, 1 down its middle; 0 everywhere off a track, where nothing's cut
  const edge = min(across, float(1.0).sub(across)).mul(2.0);
  const wp = patternXZ;
  const ragged = noise2D(wp.mul(1.4)).mul(0.3).add(noise2D(wp.mul(4.7)).mul(0.14)).add(0.06).mul(track);
  const inner = smoothstep(ragged, ragged.add(0.35), edge);
  const grain = noise2D(wp.mul(2.6)).mul(0.24).add(0.88);
  const worn = mix(vc.rgb.mul(vec3(0.82, 0.9, 0.7)), vc.rgb.mul(grain), inner);
  mat.colorNode = mix(vc.rgb, worn, track);
  mat.opacityNode = step(ragged, edge);
  mat.alphaTest = 0.5;
  return mat;
}

function createGardenBedMaterial(beds) {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0.0, roughness: 0.95 });
  const kinds = [0, 1, 2, 3].map((i) => beds[Math.min(i, beds.length - 1)]);
  mat.colorNode = Fn(() => {
    const k = vertexColor().r.mul(3.0).add(0.5).floor();
    const pick = (values) => mix(mix(values[0], values[1], step(0.5, k)), mix(values[2], values[3], step(2.5, k)), step(1.5, k));
    const soil = pick(kinds.map((b) => color(b.soil)));
    const [c0, c1, c2] = [0, 1, 2].map((i) => pick(kinds.map((b) => color(b.speckles[i]))));
    const cover = pick(kinds.map((b) => float(b.cover)));
    const wp = patternXZ;
    // Clumps about a metre across, each in one of the colours
    const clump = noise2D(wp.mul(1.1));
    const which = noise2D(wp.mul(0.45).add(vec2(17.0, 3.0)));
    const plant = mix(mix(c0, c1, step(0.36, which)), c2, step(0.66, which));
    const grain = noise2D(wp.mul(6.0)).mul(0.25).add(0.85);
    return mix(soil, plant, step(float(1.0).sub(cover), clump)).mul(grain);
  })();
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  mat.polygonOffsetUnits = -2;
  return mat;
}

/**
 * ConEd Iconic Street Steam Stack Volumetric Billowing SpriteNodeMaterial
 * Modelled after `three.js/examples/webgpu_particles.html`:
 * - Uses `THREE.SpriteNodeMaterial` on an instanced `PlaneGeometry(1, 1)` so every puff is a
 *   camera-facing billboard sprite with zero polygonal facets.
 * - Continuously rises from the orange-and-white ConEd stack nozzle (`life = fract(phase + time * speed)`),
 *   expands (`scaleNode`), curls downwind (`positionNode`), and rotates (`rotateUV`) with soft
 *   sunlit top rims and cool urban-canyon self-shadowing.
 */
// Transparent decal/effect planes & sprites preserve the underlying road/scene G-buffer in MRT (zero RGB & zero alpha on normal & metalRough)
const _transparentEffectMRT = mrt({
  normal: vec4(0.0, 0.0, 0.0, 0.0),
  metalRough: vec4(0.0, 0.0, 0.0, 0.0)
});

/**
 * Soft Rounded-Rectangle Under-Vehicle Contact Shadow (Ambient Occlusion) TSL Material
 */
function createContactShadowMaterial() {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    fog: false
  });

  const shadowOpacity = Fn(() => {
    const uvCentered = uv().sub(vec2(0.5, 0.5)).mul(2.0);
    const p = abs(uvCentered);
    // Rounded-box SDF in normalized [-1, 1]^2 quad coords with smooth falloff to 0 before quad edges
    const q = p.sub(vec2(0.64, 0.70));
    const d = length(max(q, vec2(0.0, 0.0))).add(min(max(q.x, q.y), 0.0));
    const chassisAO = smoothstep(0.30, -0.14, d);
    const coreAO = smoothstep(0.76, 0.12, p.x).mul(smoothstep(0.82, 0.16, p.y));
    // Extra contact darkening directly under the 4 tires
    const wheelPatch = smoothstep(0.22, 0.0, length(p.sub(vec2(0.68, 0.56)).mul(vec2(1.4, 1.0))));
    return clamp(chassisAO.mul(0.72).add(coreAO.mul(0.18)).add(wheelPatch.mul(0.18)), 0.0, 0.88);
  })();

  mat.colorNode = Fn(() => color(0x020305))();
  mat.opacityNode = shadowOpacity;
  // Smoothly occlude wet-road SSR under the vehicle footprint proportional to shadow opacity (0 at quad edges)
  mat.mrtNode = mrt({
    normal: vec4(0.0, 0.0, 0.0, 0.0),
    metalRough: vec4(0.0, 1.0, 0.0, shadowOpacity.mul(0.88))
  });

  return mat;
}

/**
 * A soft shadow under the walker or the bike where the sun casts none (the low level, js/quality.js): an ellipse that fills its quad,
 * `peak` dark a quarter of the way out, then fading to nothing at its rim. The G-buffer under it is kept, so it cuts no reflection out
 * of the road.
 */
function createBlobShadowMaterial(peak) {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    fog: false
  });
  const rim = length(uv().sub(vec2(0.5, 0.5)).mul(2.0)); // 0 in the middle, 1 on the ellipse's rim
  mat.colorNode = color(0x020305);
  mat.opacityNode = float(1.0).sub(smoothstep(0.25, 1.0, rim)).mul(peak);
  mat.mrtNode = _transparentEffectMRT;
  return mat;
}

// The fences of houses' lots (js/lot-details.js): one material for every panel, each an instance of a quad from (-0.5, 0) to (0.5, 1),
// seen from both sides. Each instance's `fence` attribute: [its length (m), its height (m), its kind, its colour + a number in 0-1 of its
// own in the fraction]. Kinds, between neighbours: 0 Colorbond (steel sheet in one of its four colours, its ribs, a capping rail along the
// top and a post at each end), 1 timber palings (boards of weathered timber, each a little different, with a slit of shade between
// them); along the front (js/lot-things.js): 2 timber pickets (white or cream, two rails behind), 3 an iron palisade (black or dark
// green bars with spear tops between two rails), 4 wire (a galvanised frame, the mesh seen only close). Each pattern settles to its mean
// as it shrinks under a pixel. The front fences are seen through: what isn't picket, bar or rail is left out (alphaTest). A picket fence
// far off is a solid band of its colour; the palisade's bars and the wire's frame are kept a pixel or more wide, then go, as they would.
const FENCE_COLOURS = [0x7c846a, 0xc9bea2, 0x4f514b, 0x6c6153]; // Colorbond's Pale Eucalypt, Paperbark, Woodland Grey and Jasper
function createFenceMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.6 });
  const data = attribute('fence', 'vec4');
  const u = positionGeometry.x.add(0.5).mul(data.x); // m along the panel
  const v = positionGeometry.y.mul(data.y); // m up it
  const kind = data.z, id = floor(data.w), roll = fract(data.w);
  const timber = step(0.5, kind).mul(step(kind, 1.5));
  const isPicket = step(1.5, kind).mul(step(kind, 2.5)), isPalisade = step(2.5, kind).mul(step(kind, 3.5)), isWire = step(3.5, kind);
  const fu = fwidth(u).max(0.0005), fv = fwidth(v).max(0.0005);
  // Colorbond: ribs every 0.2 m, a rail 0.06 m deep along the top, and the posts' 0.05 m at the ends
  let sheet = color(FENCE_COLOURS[0]);
  for (let k = 1; k < 4; k++) sheet = mix(sheet, color(FENCE_COLOURS[k]), step(k - 0.5, id));
  const rib = filteredPulse(u.div(0.2), 0.0, 0.22, fu.div(0.2));
  const rail = boxCoverage(v, data.y.sub(0.06), data.y.add(1.0), fv);
  const post = max(boxCoverage(u, -1.0, 0.05, fu), boxCoverage(u, data.x.sub(0.05), data.x.add(1.0), fu));
  const steel = sheet.mul(float(1.0).sub(rib.mul(0.12)).sub(rail.mul(0.1)).sub(post.mul(0.16)));
  // Palings 0.15 m across, a slit of 0.012 m between them; each board its own shade, the whole fence weathered from brown to grey
  const board = floor(u.div(0.15));
  const shade = hash2D(vec2(board, roll.mul(97.0).add(1.3))).sub(0.5).mul(0.22);
  const far = smoothstep(0.25, 0.9, fu.div(0.15));
  const wood = mix(color(0x8a7254), color(0x77736a), roll).mul(float(1.0).add(shade.mul(float(1.0).sub(far))));
  const slit = filteredPulse(u.div(0.15), 0.0, 0.08, fu.div(0.15));
  const paling = wood.mul(float(1.0).sub(slit.mul(0.55))).mul(float(1.0).sub(post.mul(0.25)));
  // Pickets 0.09 m wide every 0.15 m, pointed over their last 0.08 m, on rails 0.25 m from the bottom and the top
  const top = data.y;
  const point = clamp(top.sub(v).div(0.08), 0.0, 1.0);
  const picket = filteredPulse(u.div(0.15), float(0.3).sub(point.mul(0.3)), float(0.3).add(point.mul(0.3)), fu.div(0.15));
  const rails = max(boxCoverage(v, 0.2, 0.3, fv), boxCoverage(v, top.sub(0.35), top.sub(0.25), fv));
  const picketSolid = smoothstep(0.35, 0.6, fu.div(0.15));
  const picketCover = mix(max(picket, rails), 1.0, picketSolid);
  const paint = mix(color(0xeeeae0), color(0xe2d6b8), step(0.5, id)).mul(float(1.0).sub(rails.mul(0.06)));
  // The palisade: bars 0.02 m every 0.12 m (no narrower than a pixel and a half), spear tops, rails at 0.15 m and 0.15 m from the top
  const barWidth = max(0.02, fu.mul(1.5)).div(0.12);
  const spear = clamp(top.sub(v).div(0.07), 0.0, 1.0);
  const bar = filteredPulse(u.div(0.12), float(0.5).sub(barWidth.mul(0.5).mul(spear.mul(1.6).min(1.0))), float(0.5).add(barWidth.mul(0.5).mul(spear.mul(1.6).min(1.0))), fu.div(0.12));
  const railWidth = max(0.04, fv.mul(1.5));
  const ironRails = max(boxCoverage(v, float(0.15).sub(railWidth.mul(0.5)), float(0.15).add(railWidth.mul(0.5)), fv),
    boxCoverage(v, top.sub(0.15).sub(railWidth.mul(0.5)), top.sub(0.15).add(railWidth.mul(0.5)), fv));
  const ironGone = smoothstep(0.025, 0.045, fu);
  const ironCover = max(bar, ironRails).mul(float(1.0).sub(ironGone));
  const iron = mix(color(0x1b1d1e), color(0x1f2a22), step(0.5, id));
  // Wire: posts 0.05 m at the ends and a rail along the top, kept a pixel and a half wide; the diamonds of the mesh only close
  const wirePost = max(boxCoverage(u, -1.0, max(0.05, fu.mul(1.5)), fu), boxCoverage(u, data.x.sub(max(0.05, fu.mul(1.5))), data.x.add(1.0), fu));
  const wireRail = boxCoverage(v, top.sub(max(0.04, fv.mul(1.5))), top.add(1.0), fv);
  const diamonds = max(filteredPulse(u.add(v).div(0.06), 0.0, max(0.004, fu.mul(1.2)).div(0.06), fu.div(0.06)),
    filteredPulse(u.sub(v).div(0.06), 0.0, max(0.004, fu.mul(1.2)).div(0.06), fu.div(0.06))).mul(float(1.0).sub(smoothstep(0.004, 0.008, fu)));
  const wireCover = max(max(wirePost, wireRail), diamonds).mul(float(1.0).sub(smoothstep(0.03, 0.05, fu)));
  const front = mix(mix(paint, iron, isPalisade), color(0x9a9c98), isWire);
  const back = mix(steel, paling, timber);
  const isFront = step(1.5, kind);
  m.colorNode = mix(back, front, isFront);
  m.opacityNode = mix(float(1.0), mix(mix(picketCover, ironCover, isPalisade), wireCover, isWire), isFront);
  m.alphaTest = 0.5;
  m.roughnessNode = mix(mix(float(0.45), float(0.9), timber), mix(float(0.7), float(0.5), isPalisade.add(isWire)), isFront);
  m.metalnessNode = mix(mix(float(0.2), float(0.0), timber), mix(float(0.0), float(0.4), isPalisade.add(isWire)), isFront);
  return m;
}

// The lots' things (js/lot-things.js): one material for every box, each an instance of a unit box standing on y = 0, its colour in the
// instance colour and its `thing` attribute [its length along (m), its height (m), its width across (m), its kind]: 0 paint (posts, a
// letterbox, a carport's frame), 1 face brick (a brick's courses, mortar between, each brick its own shade; the top a plain cap), 2
// leaves (shrubs and hedges: clumps of light and shade, darker low down), 3 corrugated iron (roofs: the ribs down the slope), 4 timber
// boards (a deck's on top; a garage's weatherboards on its sides), 5 a garage's tilt door (its panels). Patterns settle to their mean
// under a pixel.
function createLotThingMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.7 });
  const data = attribute('thing', 'vec4');
  const kind = data.w;
  const n = normalGeometry;
  // Which face: an end (square to its length), or the top or bottom. mix(), not select(): TSL writes a select as an if/else and builds
  // what's inside again at each use
  const across = step(0.5, abs(n.x)), up = step(0.5, abs(n.y));
  // m along each face: across it and up it (on the top, along and across)
  const along = positionGeometry.x.mul(data.x), deep = positionGeometry.z.mul(data.z), high = positionGeometry.y.mul(data.y);
  const fa = mix(along, deep, across);
  const fb = mix(high, deep, up);
  const wa = fwidth(fa).max(0.0005), wb = fwidth(fb).max(0.0005);
  const is = (k) => step(k - 0.5, kind).mul(step(kind, k + 0.5));
  // Brick: courses 0.086 m, bricks 0.24 m in stretcher bond, 10 mm joints
  const course = fb.div(0.086);
  const offset = floor(course).mul(0.5);
  const brickU = fa.div(0.24).add(offset);
  const bed = filteredPulse(course, 0.0, 0.116, wb.div(0.086));
  const perp = filteredPulse(brickU, 0.0, 0.042, wa.div(0.24));
  const mortar = max(bed, perp).mul(float(1.0).sub(up));
  const brickShade = hash2D(vec2(floor(brickU), floor(course))).sub(0.5).mul(0.14).mul(float(1.0).sub(smoothstep(0.3, 0.9, wa.div(0.24))));
  const brick = mix(vec3(1.0).add(brickShade), vec3(1.55, 1.5, 1.4), mortar);
  // Leaves: clumps, darker towards the foot
  const clump = noise2D(vec2(fa.mul(3.1), fb.mul(3.1).add(positionWorld.x.mul(0.37)))).mul(0.55).add(noise2D(vec2(fa.mul(9.0), fb.mul(9.0))).mul(0.3));
  const leaves = vec3(float(0.62).add(clump.mul(0.75)).mul(float(0.72).add(positionGeometry.y.mul(0.35))));
  // Corrugated iron, ribs every 0.076 m along its length, on the top and underneath
  const ribs = filteredPulse(along.div(0.076), 0.0, 0.5, fwidth(along).max(0.0005).div(0.076));
  const ironShade = vec3(mix(float(0.85), float(0.92).add(ribs.mul(0.12)), up));
  // Boards: 0.14 m deck boards on top, 0.18 m weatherboards on the sides, a line of shade under each
  const boardGap = mix(filteredPulse(fb.div(0.18), 0.0, 0.1, wb.div(0.18)),
    filteredPulse(deep.div(0.14), 0.0, 0.06, fwidth(deep).max(0.0005).div(0.14)), up);
  const boards = vec3(float(1.0).sub(boardGap.mul(0.35)));
  // A tilt door: horizontal panels every 0.3 m
  const panel = filteredPulse(high.div(0.3), 0.0, 0.08, fwidth(high).max(0.0005).div(0.3));
  const door = vec3(float(1.0).sub(panel.mul(0.18)));
  const paint = vec3(1.0);
  const tone = paint.mul(is(0)).add(brick.mul(is(1))).add(leaves.mul(is(2))).add(ironShade.mul(is(3))).add(boards.mul(is(4))).add(door.mul(is(5)));
  m.colorNode = vec4(tone, 1.0);
  m.roughnessNode = float(0.6).mul(is(0)).add(float(0.9).mul(is(1))).add(float(0.95).mul(is(2))).add(float(0.45).mul(is(3))).add(float(0.85).mul(is(4))).add(float(0.5).mul(is(5)));
  m.metalnessNode = float(0.3).mul(is(3));
  return m;
}

// Driveways, crossovers and laybacks: concrete, each slab's shade in its instance colour, laid over the lawn or the footpath with the
// polygon offset the garden's paths have, so the two never fight for a pixel
function createConcreteMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0xc4bfb4, roughness: 0.92 });
  // A little mottling, broad enough not to sparkle
  m.colorNode = color(0xc4bfb4).mul(float(0.94).add(steadyHash2D(floor(patternXZ.mul(0.7))).mul(0.08)));
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.polygonOffsetUnits = -2;
  return m;
}

// Street numbers' plates (js/street-numbers.js), drawn by js/lot-details.js as a quad each: its characters from an atlas of cells 32 px
// wide and 64 high, 16 to a row, a blank first and then GLYPHS, white on black: the ink. A plate's `plate` attribute: its characters four
// to a number, 6 bits each, and their count + 16 times its colours' entry in PALETTE. Its colour where there's no ink; opaque.
let _numberAtlas = null;
function numberAtlas() {
  if (_numberAtlas) return _numberAtlas;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 512, 256);
  ctx.fillStyle = '#fff';
  // Digits 1/HIGH of the cell's height: 40 px of 64
  ctx.font = 'bold 56px sans-serif';
  ctx.textAlign = 'center';
  const m = ctx.measureText('8');
  const scale = 64 / HIGH / Math.max(1, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent);
  ctx.font = `bold ${Math.round(56 * scale)}px sans-serif`;
  const fit = ctx.measureText('8');
  [...GLYPHS].forEach((c, i) => {
    const cell = i + 1, x = (cell % 16) * 32 + 16, top = Math.floor(cell / 16) * 64;
    ctx.fillText(c, x, top + 32 + (fit.actualBoundingBoxAscent - fit.actualBoundingBoxDescent) / 2, 27);
  });
  _numberAtlas = new THREE.CanvasTexture(canvas);
  _numberAtlas.anisotropy = 4;
  return _numberAtlas;
}

function createNumberPlateMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.4 });
  // The same on every pixel of a plate, exactly: its characters are whole numbers up to 2^24, which an interpolated varying can be a unit off
  const data = varying(attribute('plate', 'vec4'), 'vNumberPlate')
    .setInterpolation(THREE.InterpolationSamplingType.FLAT, THREE.InterpolationSamplingMode.EITHER);
  const count = mod(data.w, 16.0), entry = floor(data.w.mul(1 / 16));
  const p = uv();
  // Along the plate in characters, from the first one's left edge; its padding either end
  const u = p.x.mul(count.add((2 * PAD) / CELL)).sub(PAD / CELL);
  const k = floor(u);
  const inside = step(0.0, u).mul(step(u, count.sub(0.0001)));
  // The k-th character: its number's 6 bits, by multiplying by exact powers of two
  const word = mix(mix(data.x, data.y, step(3.5, k)), data.z, step(7.5, k));
  const j = mod(k, 4.0);
  const shift = mix(mix(float(1), float(1 / 64), step(0.5, j)), mix(float(1 / 4096), float(1 / 262144), step(2.5, j)), step(1.5, j));
  const above = floor(word.mul(shift));
  const code = above.sub(floor(above.mul(1 / 64)).mul(64.0)).mul(inside);
  const row = floor(code.mul(1 / 16)), col = code.sub(row.mul(16.0));
  const atlasUV = vec2(col.add(fract(u)).mul(1 / 16), float(3).sub(row).add(p.y).mul(0.25));
  // The mip level from the plate's own coordinates: fract() jumps at each character's edge
  const lod = log2(max(fwidth(u).mul(32.0), fwidth(p.y).mul(64.0)).max(1e-4)).clamp(0, 4);
  const ink = texture(numberAtlas(), atlasUV).level(lod).r;
  const is = (e) => step(e - 0.5, entry).mul(step(entry, e + 0.5));
  let plate = vec3(0), digits = vec3(0);
  PALETTE.forEach(({ plate: pc, ink: ic }, e) => {
    plate = plate.add(color(pc).mul(is(e)));
    digits = digits.add(color(ic).mul(is(e)));
  });
  m.colorNode = vec4(mix(plate, digits, ink), 1.0);
  // Brass a metal, the rest glazed
  m.metalnessNode = is(2).mul(0.65);
  m.roughnessNode = mix(float(0.35), float(0.45), is(2));
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -4;
  return m;
}

export {
  cityUniforms,
  WALL_KINDS,
  ONE_HOUSE,
  wallKind,
  filteredPulse,
  createCurtainWallMaterial,
  createPreWarBuildingMaterial,
  createCarPaintMaterial,
  createTreeMaterial,
  createTreeGrateMaterial,
  createRoadSurfaceMaterial,
  createRoadPaintMaterial,
  createSidewalkMaterial,
  createCurbMaterial,
  createPondMaterial,
  createSandstoneWallMaterial,
  createSandMaterial,
  createCoastRockMaterial,
  STONE_FACE,
  BASE_FACE,
  createStructureMaterial,
  createPalisadeMaterial,
  createWaterMaterial,
  createParkLawnMaterial,
  createGardenBedMaterial,
  createGardenPathMaterial,
  createContactShadowMaterial,
  createBlobShadowMaterial,
  createFenceMaterial,
  createLotThingMaterial,
  createConcreteMaterial,
  createNumberPlateMaterial
};
