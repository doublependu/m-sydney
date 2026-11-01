import * as THREE from 'three/webgpu';
import { Fn, float, color, positionWorld, uniform, mod, fract, step, smoothstep, mix } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SIGNAL_TIMING, blockAt, BLOCKS, nearestRoads } from './city-config.js';
import { GEO } from './geodata.js';
import { cityUniforms, createTreeGrateMaterial } from './tsl-materials.js';
import { createTreeFieldSteps } from './trees.js';
import { REAL_TREES, TREE_KINDS, TREE_HEIGHTS } from './tree-geodata.js';
import { placeStreetTreesSteps } from './tree-placements.js';
import { terrainHeight } from './terrain.js';

// Instanced street furniture, traffic signals, trees and nearby light pools.

function createStreetSignBladeTexture(label) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#17366b';
  ctx.fillRect(0, 0, 256, 64);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 5;
  ctx.strokeRect(4, 4, 248, 56);
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 30px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * TSL 3-Aspect Traffic Signal Lens Material (Red y=5.78, Amber y=5.42, Green y=5.06)
 * Driven by the shared signal clock and SIGNAL_TIMING (city-config.js), which js/traffic.js obeys.
 */
function createTrafficSignalLensMaterial(isAvenueHead, clock) {
  const { cycle, avenueAmber, avenueRed, streetAmber } = SIGNAL_TIMING;
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = Fn(() => {
    const t = mod(clock, cycle);
    const wy = positionWorld.y;
    const isTopRed = step(5.60, wy);
    const isBottomGreen = float(1.0).sub(step(5.24, wy));
    const isMidAmber = float(1.0).sub(isTopRed).mul(float(1.0).sub(isBottomGreen));

    // Avenue phase: Green, then Amber from avenueAmber, Red from avenueRed
    // Street phase: Red until avenueRed, then Green, Amber from streetAmber
    const greenActive = isAvenueHead
      ? float(1.0).sub(step(avenueAmber, t))
      : step(avenueRed, t).mul(float(1.0).sub(step(streetAmber, t)));
    const amberActive = isAvenueHead
      ? step(avenueAmber, t).mul(float(1.0).sub(step(avenueRed, t)))
      : step(streetAmber, t);
    const redActive = isAvenueHead
      ? step(avenueRed, t)
      : float(1.0).sub(step(avenueRed, t));

    const activeMask = isTopRed.mul(redActive)
      .add(isMidAmber.mul(amberActive))
      .add(isBottomGreen.mul(greenActive));

    const lensHue = mix(
      mix(color(0x18ff68), color(0xffaa10), isMidAmber),
      color(0xff2424),
      isTopRed
    );
    return mix(color(0x14181e), lensHue.mul(1.35), activeMask);
  })();
  return mat;
}

// Pedestrian signal for crossing alongside the avenue: WALK, then a flashing hand until the avenue's amber, then a
// steady hand
function createWalkSignalMaterial(clock) {
  const { cycle, avenueAmber, walk } = SIGNAL_TIMING;
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = Fn(() => {
    const t = mod(clock, cycle);
    const isWalk = float(1.0).sub(step(walk, t));
    const isFlashing = step(walk, t).mul(float(1.0).sub(step(avenueAmber, t)));
    const handLit = float(1.0).sub(isFlashing.mul(step(0.5, fract(t))));
    const hand = mix(color(0x14181e), color(0xff5518), handLit);
    return mix(hand, color(0xf4f9ff), isWalk);
  })();
  return mat;
}

function* buildStreetDetails(scene, colliders = [], lightPools) {
  const group = new THREE.Group();
  group.name = 'StreetDetails';

  const dummy = new THREE.Object3D();
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 10);

  // Ground footprints of street furniture that traffic and pedestrians must keep clear of
  const footprints = [];
  const addFootprint = (x, z, w, d, pedestrianOnly = false) => footprints.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, pedestrianOnly });

  // Signal clock (seconds), set every frame by main.js
  const signalClock = uniform(0);

  // Shared materials
  const poleMetalMat = new THREE.MeshStandardNodeMaterial({
    color: 0x3b4046,
    roughness: 0.45,
    metalness: 0.78
  });
  const signalHousingMat = new THREE.MeshStandardNodeMaterial({
    color: 0x24282c, // Dark housings, as on Sydney's signals
    roughness: 0.38,
    metalness: 0.35,
    side: THREE.DoubleSide // the tunnel visors are open half-tubes
  });
  const aveSignalLensMat = createTrafficSignalLensMaterial(true, signalClock);
  const streetSignalLensMat = createTrafficSignalLensMaterial(false, signalClock);
  const walkSignalGlow = createWalkSignalMaterial(signalClock);
  // Cobra-head LED streetlight lens & pedestrian post-top globe: pale diffuser by day, warm white after dusk
  const lampBulbGlow = new THREE.MeshBasicNodeMaterial();
  lampBulbGlow.colorNode = mix(color(0x8f918c), color(0xfff1d6).mul(2.1), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow));
  const pedGlobeGlow = new THREE.MeshBasicNodeMaterial();
  pedGlobeGlow.colorNode = mix(color(0xd4d2c8), color(0xffe4b0).mul(1.95), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow));
  const streetBladeMat = new THREE.MeshStandardNodeMaterial({
    map: createStreetSignBladeTexture('GEORGE ST'),
    roughness: 0.32
  });

  // 12-inch three-section signal head (origin at its centre, y = 5.42): yellow housing, a tunnel visor over each lens
  // and a hanger to the mast arm, lenses on both faces (+-z) so it reads from both approaches; the lens material
  // picks red / amber / green from each lens's world height (5.78 / 5.42 / 5.06)
  const HEAD_W = 0.4;
  const HEAD_H = 1.12;
  const HEAD_D = 0.28;
  const LENS_R = 0.145;
  const LENS_Y = [0.36, 0, -0.36];
  const bothFaces = (geo) => [geo, geo.clone().rotateY(Math.PI)];
  const signalHousingGeo = mergeGeometries([
    new THREE.BoxGeometry(HEAD_W, HEAD_H, HEAD_D),
    new THREE.BoxGeometry(0.07, 0.2, 0.07).translate(0, HEAD_H / 2 + 0.1, 0),
    ...LENS_Y.flatMap((ly) => bothFaces(
      new THREE.CylinderGeometry(LENS_R + 0.03, LENS_R + 0.03, 0.24, 14, 1, true, Math.PI / 2, Math.PI)
        .rotateX(Math.PI / 2).translate(0, ly, HEAD_D / 2 + 0.12)
    ))
  ]);
  const signalLensGeo = mergeGeometries(LENS_Y.flatMap((ly) => bothFaces(new THREE.CircleGeometry(LENS_R, 18).translate(0, ly, HEAD_D / 2 + 0.004))));
  // Pedestrian signal: housing with the WALK / hand face lit on both sides (+-z, toward the crosswalk's far end)
  const walkHousingGeo = new THREE.BoxGeometry(0.34, 0.4, 0.24);
  const walkPanelGeo = mergeGeometries(bothFaces(new THREE.PlaneGeometry(0.27, 0.31).translate(0, 0, 0.125)));
  // Cobra-head luminaire on the end of the arm: flattened grey housing, flat lens underneath
  const lampHousingGeo = new THREE.SphereGeometry(1, 14, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(0.7, 0.2, 0.3);
  const lampLensGeo = new THREE.CircleGeometry(1, 16).rotateX(Math.PI / 2).scale(0.6, 1, 0.24).translate(0, -0.005, 0);
  // Cast-iron pedestrian post-top globe lightpole (fluted base + shaft + decorative capital + opal globe)
  const pedLampPostGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.11, 0.16, 0.85, 10).translate(0, 0.425, 0),
    new THREE.CylinderGeometry(0.065, 0.085, 2.75, 10).translate(0, 2.22, 0),
    new THREE.CylinderGeometry(0.14, 0.07, 0.16, 10).translate(0, 3.62, 0)
  ]);
  const pedGlobeGeo = new THREE.SphereGeometry(0.23, 8, 6).translate(0, 3.84, 0);

  yield;
  // =========================================================================
  yield;
  // 1. TRAFFIC SIGNALS, STREET BLADES & WALK SIGNALS
  yield;
  // =========================================================================
  const poleMatrices = [];
  const armMatrices = [];
  const yellowBoxMatrices = []; // Signal housings
  const aveLensMatrices = [];
  const streetLensMatrices = [];
  const streetBladeMatrices = [];
  const walkBoxMatrices = [];
  const audioSignals = [];
  const signalIntersections = [];
  const lampHeadMatrices = [];
  const pedPostMatrices = [];
  const cobraLampSites = [];
  const streetPointSites = [];
  // Only nearby poles can conflict, even with street furniture across the whole island.
  const POLE_CELL = 8;
  const poleCells = new Map();
  function addPole(x, z, width) {
    const key = Math.floor(x / POLE_CELL) + ',' + Math.floor(z / POLE_CELL);
    let cell = poleCells.get(key);
    if (!cell) poleCells.set(key, cell = []);
    cell.push({ x, z });
    // Poles stand on curbs: pedestrians avoid them, but they must not narrow the inferred road gaps.
    addFootprint(x, z, width, width, true);
  }

  // True only when (x, z) and its surrounding pad-meter footprint sit on a real curb island (never in a road or median)
  const isOnCurbIsland = (x, z, pad = 0.55) => {
    const b = blockAt(x, z);
    if (!b || b.median) return false;
    if (pad <= 0) return true;
    const b1 = blockAt(x - pad, z);
    const b2 = blockAt(x + pad, z);
    const b3 = blockAt(x, z - pad);
    const b4 = blockAt(x, z + pad);
    return !!(b1 && !b1.median && b2 && !b2.median && b3 && !b3.median && b4 && !b4.median);
  };

  // True only when (x, z) is on a non-park, non-median, non-plaza sidewalk with `pad` clearance from all curbs
  const isOnSidewalk = (x, z, pad = 0.55) => {
    if (!isOnCurbIsland(x, z, pad)) return false;
    const b = blockAt(x, z);
    return !(b.park > 0.6);
  };

  const isClearOfPoles = (x, z, minDist = 6.0) => {
    const md2 = minDist * minDist;
    for (let ix = Math.floor((x - minDist) / POLE_CELL); ix <= Math.floor((x + minDist) / POLE_CELL); ix++) {
      for (let iz = Math.floor((z - minDist) / POLE_CELL); iz <= Math.floor((z + minDist) / POLE_CELL); iz++) {
        for (const p of poleCells.get(ix + ',' + iz) || []) {
          if ((p.x - x) ** 2 + (p.z - z) ** 2 < md2) return false;
        }
      }
    }
    return true;
  };

  // Every signalised junction: a signal mast on the two curbs nearest the junction, on opposite sides of it, its arm
  // reaching out over the road. Heads and walk lights share the junction's clock.
  for (let i = 0; i < GEO.signals.length; i += 2) {
    if ((i & 30) === 0) yield;
    const jx = GEO.signals[i], jz = GEO.signals[i + 1];
    let placedSignal = false;
    const used = [];
    // Corners: curb points around the junction, found by walking out along eight directions
    const corners = [];
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2, ux = Math.cos(a), uz = Math.sin(a);
      for (let r = 4; r <= 26; r += 1) {
        const x = jx + ux * r, z = jz + uz * r;
        if (isOnCurbIsland(x, z, 0.55)) { corners.push({ x, z, ux, uz, a, r }); break; }
      }
    }
    corners.sort((p, q) => p.r - q.r);
    for (const c of corners) {
      if (used.length === 2) break;
      if (used.some((u) => Math.cos(u.a - c.a) > -0.2) || !isClearOfPoles(c.x, c.z, 4.0)) continue;
      used.push(c);
      const px = c.x, pz = c.z;
      addPole(px, pz, 0.5);
      if (!placedSignal) {
        signalIntersections.push({ x: jx, z: jz });
        placedSignal = true;
      }
      const armYaw = Math.atan2(c.uz, -c.ux); // the arm points from the curb to the junction
      const out = (d) => [px - c.ux * d, pz - c.uz * d];

      dummy.position.set(px, 3.3, pz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(0.14, 6.4, 0.14);
      dummy.updateMatrix();
      poleMatrices.push(dummy.matrix.clone());

      // Street name blade and pedestrian signal on the pole
      dummy.rotation.set(0, armYaw, 0);
      dummy.position.set(...[out(0.68)[0]], 4.65, out(0.68)[1]);
      dummy.scale.set(1.38, 0.34, 0.08);
      dummy.updateMatrix();
      streetBladeMatrices.push(dummy.matrix.clone());
      dummy.position.set(out(0.24)[0], 3.15, out(0.24)[1]);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      walkBoxMatrices.push(dummy.matrix.clone());
      audioSignals.push({ x: dummy.position.x, y: dummy.position.y, z: dummy.position.z, isAvenue: used.length === 1 });

      // Mast arm over the roadway
      const [ax, az] = out(3.25);
      dummy.position.set(ax, 6.1, az);
      dummy.scale.set(6.5, 0.11, 0.11);
      dummy.updateMatrix();
      armMatrices.push(dummy.matrix.clone());

      const [lx, lz] = out(1.85);
      dummy.position.set(lx, 6.22, lz);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      lampHeadMatrices.push(dummy.matrix.clone());
      cobraLampSites.push({ x: lx, y: 6.18, z: lz, tx: out(2.8)[0], tz: out(2.8)[1] });

      // Two heads on the arm, one for each road through the junction
      for (const armDist of [3.1, 5.5]) {
        const [hx, hz] = out(armDist);
        dummy.position.set(hx, 5.42, hz);
        dummy.rotation.set(0, armYaw + (armDist < 4.0 ? Math.PI / 2 : 0), 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        yellowBoxMatrices.push(dummy.matrix.clone());
        (armDist < 4.0 ? aveLensMatrices : streetLensMatrices).push(dummy.matrix.clone());
      }
      dummy.rotation.set(0, 0, 0);
    }
  }

  yield;
  // =========================================================================
  yield;
  // 2. MID-BLOCK AVENUE & STREET ORNAMENTAL ACORN & COBRA STREETLIGHTS
  //    Placed directly along the true curb edges of every city block (BLOCKS)
  //    and verified with blockAt(x, z) so no pole ever stands in any roadway.
  yield;
  // =========================================================================
  const allBlocks = BLOCKS || [];

  for (const b of allBlocks) {
    yield;
    if (!b || !b.poly || b.poly.length < 3 || b.median || b.park > 0.6) continue;

    const poly = b.poly;
    for (let i = 0; i < poly.length; i++) {
      const p0 = poly[i];
      const p1 = poly[(i + 1) % poly.length];
      const dx = p1.x - p0.x;
      const dz = p1.z - p0.z;
      const len = Math.hypot(dx, dz);
      if (len < 24) continue;

      const ux = dx / len;
      const uz = dz / len;
      const mx = (p0.x + p1.x) * 0.5;
      const mz = (p0.z + p1.z) * 0.5;

      // Determine inward normal (into the sidewalk block) and outward normal (into the street roadway)
      let inx = -uz;
      let inz = ux;
      if (blockAt(mx + inx * 1.6, mz + inz * 1.6) !== b) {
        inx = uz;
        inz = -ux;
      }
      if (blockAt(mx + inx * 1.6, mz + inz * 1.6) !== b) continue;
      const outX = -inx;
      const outZ = -inz;
      // Confirm this curb edge fronts an open roadway
      if (blockAt(mx + outX * 2.5, mz + outZ * 2.5)) continue;

      const isAvenueEdge = Math.abs(uz) > 0.65;
      if (isAvenueEdge) {
        const armYaw = Math.atan2(-outZ, outX);
        const cobraFracs = inx > 0 ? [0.26, 0.72] : [0.32, 0.78];
        for (const f of cobraFracs) {
          const cx = p0.x + dx * f;
          const cz = p0.z + dz * f;
          const lx = cx + inx * 1.08;
          const lz = cz + inz * 1.08;
          const headX = lx + outX * 2.6;
          const headZ = lz + outZ * 2.6;
          if (
            !isOnSidewalk(lx, lz, 0.55) ||
            blockAt(cx + outX * 2.5, cz + outZ * 2.5) ||
            blockAt(headX, headZ) ||
            !isClearOfPoles(lx, lz, 6.5)
          ) {
            continue;
          }
          addPole(lx, lz, 0.45);

          // Tall ornamental streetlight pole
          dummy.position.set(lx, 4.3, lz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(0.12, 8.4, 0.12);
          dummy.updateMatrix();
          poleMatrices.push(dummy.matrix.clone());

          // Upper luminaire bracket arm overhanging the street
          dummy.position.set(lx + outX * 1.15, 8.2, lz + outZ * 1.15);
          dummy.rotation.set(0, armYaw, 0);
          dummy.scale.set(2.3, 0.09, 0.09);
          dummy.updateMatrix();
          armMatrices.push(dummy.matrix.clone());

          // Cobra-head LED luminaire on the end of the arm, lens facing the street
          dummy.position.set(headX, 8.08, headZ);
          dummy.rotation.set(0, armYaw, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          lampHeadMatrices.push(dummy.matrix.clone());
          dummy.rotation.set(0, 0, 0);

          cobraLampSites.push({
            x: headX,
            y: 8.02,
            z: headZ,
            tx: lx + outX * 3.4,
            tz: lz + outZ * 3.4
          });
        }

        // Cast-iron pedestrian post-top globe lightpoles along main-road footpaths (with PointLights)
        const pedFracs = len >= 48 ? [0.16, 0.50, 0.84] : [0.24, 0.76];
        for (const f of pedFracs) {
          const cx = p0.x + dx * f;
          const cz = p0.z + dz * f;
          const px = cx + inx * 1.42;
          const pz = cz + inz * 1.42;
          if (
            !isOnSidewalk(px, pz, 0.55) ||
            blockAt(cx + outX * 2.2, cz + outZ * 2.2) ||
            !isClearOfPoles(px, pz, 5.2)
          ) {
            continue;
          }
          addPole(px, pz, 0.4);

          dummy.position.set(px, 0.18, pz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          pedPostMatrices.push(dummy.matrix.clone());
          streetPointSites.push({
            x: px,
            y: 4.02,
            z: pz,
            color: 0xffe0aa,
            intensity: 30,
            dist: 14.5
          });
        }
      } else if (len >= 36) {
        // Cross-street cast-iron pedestrian post-top globe lightpoles along north and south block curbs
        const crossFracs = len >= 115 ? [0.20, 0.40, 0.60, 0.80] : [0.24, 0.50, 0.76];
        for (const f of crossFracs) {
          const cx = p0.x + dx * f;
          const cz = p0.z + dz * f;
          const px = cx + inx * 1.22;
          const pz = cz + inz * 1.22;
          if (
            !isOnSidewalk(px, pz, 0.55) ||
            blockAt(cx + outX * 2.2, cz + outZ * 2.2) ||
            !isClearOfPoles(px, pz, 5.5)
          ) {
            continue;
          }
          addPole(px, pz, 0.4);

          dummy.position.set(px, 0.18, pz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          pedPostMatrices.push(dummy.matrix.clone());
          streetPointSites.push({
            x: px,
            y: 4.02,
            z: pz,
            color: 0xffe0aa,
            intensity: 28,
            dist: 14.0
          });
        }
      }
    }
  }

  function addMatrixArrayInstanced(geo, mat, matrices, castShadow = true) {
    if (matrices.length === 0) return;
    const inst = new THREE.InstancedMesh(geo, mat, matrices.length);
    if (castShadow && !mat.isMeshBasicNodeMaterial && mat.type !== 'MeshBasicNodeMaterial' && !mat.transparent) {
      inst.castShadow = true;
      inst.receiveShadow = true;
    }
    for (let i = 0; i < matrices.length; i++) {
      inst.setMatrixAt(i, matrices[i]);
    }
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
    return inst;
  }

  addMatrixArrayInstanced(unitCyl, poleMetalMat, poleMatrices);
  yield;
  addMatrixArrayInstanced(unitBox, poleMetalMat, armMatrices);
  yield;
  addMatrixArrayInstanced(signalHousingGeo, signalHousingMat, yellowBoxMatrices);
  yield;
  addMatrixArrayInstanced(signalLensGeo, aveSignalLensMat, aveLensMatrices, false);
  yield;
  addMatrixArrayInstanced(signalLensGeo, streetSignalLensMat, streetLensMatrices, false);
  yield;
  addMatrixArrayInstanced(unitBox, streetBladeMat, streetBladeMatrices);
  yield;
  addMatrixArrayInstanced(walkHousingGeo, signalHousingMat, walkBoxMatrices);
  yield;
  addMatrixArrayInstanced(walkPanelGeo, walkSignalGlow, walkBoxMatrices, false);
  yield;
  addMatrixArrayInstanced(lampHousingGeo, poleMetalMat, lampHeadMatrices);
  yield;
  addMatrixArrayInstanced(lampLensGeo, lampBulbGlow, lampHeadMatrices, false);
  yield;
  const pedPosts = addMatrixArrayInstanced(pedLampPostGeo, poleMetalMat, pedPostMatrices);
  // ~28k posts: they cast as 4-sided base + shaft (16 triangles instead of 120; scene-culling.js shadow stand-ins)
  if (pedPosts) {
    pedPosts.userData.shadowStandIn = mergeGeometries([
      new THREE.CylinderGeometry(0.12, 0.18, 0.85, 4, 1, true).translate(0, 0.425, 0),
      new THREE.CylinderGeometry(0.072, 0.094, 2.85, 4, 1, true).translate(0, 2.275, 0)
    ]);
  }
  addMatrixArrayInstanced(pedGlobeGeo, pedGlobeGlow, pedPostMatrices, false);
  yield;

  yield;
  // Australia Post's red boxes, and bus shelters along the kerb, where they really stand
  const postMat = new THREE.MeshStandardNodeMaterial({ color: 0xc8202c, roughness: 0.42, metalness: 0.2 });
  const postGeo = mergeGeometries([new THREE.CylinderGeometry(0.27, 0.27, 1.3, 12).translate(0, 0.65, 0), new THREE.SphereGeometry(0.27, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 1.3, 0)]);
  const postMatrices = [];
  for (let i = 0; i < GEO.postBoxes.length; i += 2) {
    const x = GEO.postBoxes[i], z = GEO.postBoxes[i + 1];
    if (!isOnSidewalk(x, z, 0.4)) continue;
    postMatrices.push(new THREE.Matrix4().makeTranslation(x, 0.22, z));
    addFootprint(x, z, 0.6, 0.6, true);
  }
  addMatrixArrayInstanced(postGeo, postMat, postMatrices);
  const shelterRoofMat = new THREE.MeshStandardNodeMaterial({ color: 0x2b3036, roughness: 0.5, metalness: 0.4 });
  const shelterGlassMat = new THREE.MeshStandardNodeMaterial({ color: 0x9fb6c2, roughness: 0.12, metalness: 0.5, transparent: true, opacity: 0.35, depthWrite: false });
  const shelterFrame = mergeGeometries([
    new THREE.BoxGeometry(4.6, 0.1, 1.5).translate(0, 2.5, 0),
    ...[-2.1, 2.1].map((x) => new THREE.BoxGeometry(0.09, 2.5, 0.09).translate(x, 1.25, -0.6)),
    new THREE.BoxGeometry(2.4, 0.08, 0.4).translate(0, 0.46, -0.45)
  ]);
  const shelterBack = new THREE.BoxGeometry(4.2, 1.9, 0.04).translate(0, 1.25, -0.62);
  const shelterMatrices = [];
  for (let i = 0; i < GEO.busShelters.length; i += 2) {
    if (i % 40 === 0) yield;
    const nodeX = GEO.busShelters[i], nodeZ = GEO.busShelters[i + 1];
    const road = nearestRoads(nodeX, nodeZ, 18)[0];
    if (!road || !road.road.w) continue;
    // The stop's node sits anywhere from the kerb to the centreline: stand it on the footpath, facing the road
    let best = Infinity, cx = 0, cz = 0, tx = 1, tz = 0;
    const pts = road.road.pts;
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((nodeX - a.x) * dx + (nodeZ - a.z) * dz) / L2));
      const d = Math.hypot(a.x + t * dx - nodeX, a.z + t * dz - nodeZ);
      if (d < best) { best = d; cx = a.x + t * dx; cz = a.z + t * dz; const L = Math.sqrt(L2); tx = dx / L; tz = dz / L; }
    }
    const side = (nodeX - cx) * -tz + (nodeZ - cz) * tx >= 0 ? 1 : -1;
    const out = road.road.w / 2 + 1.7;
    const x = cx - tz * side * out, z = cz + tx * side * out;
    if (!isOnSidewalk(x, z, 0.8)) continue;
    const yaw = Math.atan2(tz, tx);
    dummy.position.set(x, 0.22, z);
    // Local +z, the open side, is (-sin yaw, cos yaw) after this turn: point it back at the road
    dummy.rotation.set(0, side > 0 ? -yaw + Math.PI : -yaw, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    shelterMatrices.push(dummy.matrix.clone());
    addFootprint(x, z, 3, 3, true);
  }
  dummy.rotation.set(0, 0, 0);
  addMatrixArrayInstanced(shelterFrame, shelterRoofMat, shelterMatrices);
  addMatrixArrayInstanced(shelterBack, shelterGlassMat, shelterMatrices, false);

  yield;
  // =========================================================================
  yield;
  // 7. TREES: every surveyed park and street tree
  //    London planes, honey locusts & American elms (one unified trunk + crown instanced mesh per species & band)
  yield;
  // =========================================================================
  const treePositions = []; // { x, y, z, scale, species }
  const subwayColliders = [];

  // Surveyed street trees; parks keep their authored terrain, clearings and tree layouts.
  let sidewalkTreePositions = yield* placeStreetTreesSteps(REAL_TREES, TREE_KINDS, TREE_HEIGHTS, treePositions,
    (x, z) => isClearOfPoles(x, z, 2.2));
  for (const tree of sidewalkTreePositions) treePositions.push(tree);
  sidewalkTreePositions = sidewalkTreePositions.filter((t) => t.tier > 0);
  for (const t of treePositions) t.y = (t.y || 0) + terrainHeight(t.x, t.z);
  const treeField = yield* createTreeFieldSteps(scene, treePositions, [...colliders, ...subwayColliders]);
  treeField.group.traverse((o) => { o.userData.lifted = true; }); // placed on the ground already
  group.add(treeField.group);
  sidewalkTreePositions = sidewalkTreePositions.filter((t) => treeField.sites.has(t));
  console.info(`[streetDetails] ${treeField.stats.trees} trees (${sidewalkTreePositions.length} street trees)`);

  const grateMat = createTreeGrateMaterial();
  const pitCurbMat = new THREE.MeshStandardNodeMaterial({ color: 0x484642, roughness: 0.88 });
  const pitSoilMat = new THREE.MeshStandardNodeMaterial({ color: 0x241c14, roughness: 0.96 });

  // Curbside tree pit surrounds & dark soil beds, with concentric cast-iron grates on the main own avenues
  // (pits run along the curb: t.pitRot = PI/2 on cross streets)
  const pitCurbGeo = new THREE.BoxGeometry(1.7, 0.22, 2.6);
  const pitSoilGeo = new THREE.BoxGeometry(1.35, 0.23, 2.25);
  const pitGrateGeo = new THREE.RingGeometry(0.24, 0.82, 12, 1).rotateX(-Math.PI / 2);
  const gratedTrees = sidewalkTreePositions.filter((t) => t.grate !== false);

  const pitCurbInst = new THREE.InstancedMesh(pitCurbGeo, pitCurbMat, sidewalkTreePositions.length);
  const pitSoilInst = new THREE.InstancedMesh(pitSoilGeo, pitSoilMat, sidewalkTreePositions.length);
  const pitGrateInst = new THREE.InstancedMesh(pitGrateGeo, grateMat, Math.max(1, gratedTrees.length));
  pitCurbInst.receiveShadow = true;
  pitSoilInst.receiveShadow = true;
  pitGrateInst.receiveShadow = true;
  pitGrateInst.count = gratedTrees.length;

  sidewalkTreePositions.forEach((t, i) => {
    dummy.rotation.set(0, t.pitRot || 0, 0);
    dummy.scale.set(t.pitS || 1, 1, 1);
    dummy.position.set(t.x, 0.19, t.z);
    dummy.updateMatrix();
    pitCurbInst.setMatrixAt(i, dummy.matrix);

    dummy.position.set(t.x, 0.20, t.z);
    dummy.updateMatrix();
    pitSoilInst.setMatrixAt(i, dummy.matrix);
  });
  gratedTrees.forEach((t, i) => {
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(t.x, 0.225, t.z);
    dummy.updateMatrix();
    pitGrateInst.setMatrixAt(i, dummy.matrix);
  });
  pitCurbInst.instanceMatrix.needsUpdate = true;
  pitSoilInst.instanceMatrix.needsUpdate = true;
  pitGrateInst.instanceMatrix.needsUpdate = true;
  // Their footprint would keep these 20 cm boxes drawn at any distance (scene-culling.js): culled with the cross-street
  // trees over them instead (trees.js MAX_DIST)
  for (const pit of [pitCurbInst, pitSoilInst, pitGrateInst]) {
    pit.computeBoundingSphere();
    pit.userData.cullDistance = 950;
  }
  group.add(pitCurbInst, pitSoilInst, pitGrateInst);


  yield;
  // =========================================================================
  yield;
  // 8. CLUSTERED STREETLIGHTS & STREET FURNITURE LIGHT POOLS
  yield;
  // =========================================================================
  const STREETLIGHT_DIST = 115;
  const STREET_POINT_DIST = 110;
  const { streetSpots: streetlightSpotPool, streetPoints: streetPointPool } = lightPools;

  // Source positions are static. Query nearby cells instead of scanning the island every frame.
  const LIGHT_CELL = 128;
  function indexLights(sites) {
    const cells = new Map();
    for (const s of sites) {
      const key = Math.floor(s.x / LIGHT_CELL) + ',' + Math.floor(s.z / LIGHT_CELL);
      let cell = cells.get(key);
      if (!cell) cells.set(key, cell = []);
      cell.push(s);
    }
    return cells;
  }
  for (const s of [...cobraLampSites, ...streetPointSites]) s.ground = terrainHeight(s.x, s.z);
  const cobraCells = indexLights(cobraLampSites);
  const pointCells = indexLights(streetPointSites);

  function nearbyLights(cells, camera, range, active) {
    const { x: cx, y: cy, z: cz } = camera.position;
    const me = camera.matrixWorld.elements;
    const fwdX = -me[8], fwdZ = -me[10];
    let count = 0;
    for (let ix = Math.floor((cx - range) / LIGHT_CELL); ix <= Math.floor((cx + range) / LIGHT_CELL); ix++) {
      for (let iz = Math.floor((cz - range) / LIGHT_CELL); iz <= Math.floor((cz + range) / LIGHT_CELL); iz++) {
        for (const s of cells.get(ix + ',' + iz) || []) {
          const dx = s.x - cx, dz = s.z - cz;
          const d2 = dx * dx + dz * dz + cy * cy;
          if (d2 > range * range) continue;
          const effDist = Math.sqrt(d2) + Math.max(0, 6.0 - dx * fwdX - dz * fwdZ) * 2.8;
          if (effDist >= range) continue;
          s._effDist = effDist;
          active[count++] = s;
        }
      }
    }
    active.length = count;
    if (count > 1) active.sort((a, b) => a._effDist - b._effDist);
    return count;
  }

  const activeCobras = [];
  const activePoints = [];

  function smoothFade(d, start, end) {
    const t = Math.min(1, Math.max(0, (end - d) / (end - start)));
    return t * t * (3 - 2 * t);
  }

  function update(camera) {
    if (!camera) return;
    treeField.update(camera.position);
    const glow = cityUniforms.uInteriorGlow.value;
    // Increase streetlight intensity toward dusk.
    const lampScale = Math.min(1.25, Math.max(0.0, (glow - 0.36) * 1.15));
    if (lampScale <= 0.001) {
      for (let i = 0; i < streetlightSpotPool.length; i++) {
        streetlightSpotPool[i].intensity = 0;
        streetlightSpotPool[i].position.set(0, -1000, 0);
      }
      for (let i = 0; i < streetPointPool.length; i++) {
        streetPointPool[i].intensity = 0;
        streetPointPool[i].position.set(0, -1000, 0);
      }
      return;
    }

    const cobraCount = nearbyLights(cobraCells, camera, STREETLIGHT_DIST, activeCobras);

    const cobraCutoff = cobraCount > streetlightSpotPool.length
      ? Math.min(STREETLIGHT_DIST, activeCobras[streetlightSpotPool.length]._effDist)
      : STREETLIGHT_DIST;
    const spotUsed = Math.min(cobraCount, streetlightSpotPool.length);
    for (let i = 0; i < spotUsed; i++) {
      const s = activeCobras[i];
      const fade = smoothFade(s._effDist, cobraCutoff * 0.62, cobraCutoff);
      const spot = streetlightSpotPool[i];
      spot.position.set(s.x, s.y + s.ground, s.z);
      spot.target.position.set(s.tx, s.ground, s.tz);
      spot.target.updateMatrixWorld();
      spot.intensity = 88.0 * lampScale * fade;
    }
    for (let i = spotUsed; i < streetlightSpotPool.length; i++) {
      streetlightSpotPool[i].intensity = 0;
      streetlightSpotPool[i].position.set(0, -1000, 0);
    }

    const ptCount = nearbyLights(pointCells, camera, STREET_POINT_DIST, activePoints);

    const ptCutoff = ptCount > streetPointPool.length
      ? Math.min(STREET_POINT_DIST, activePoints[streetPointPool.length]._effDist)
      : STREET_POINT_DIST;
    const ptUsed = Math.min(ptCount, streetPointPool.length);
    for (let i = 0; i < ptUsed; i++) {
      const s = activePoints[i];
      const fade = smoothFade(s._effDist, ptCutoff * 0.62, ptCutoff);
      const pt = streetPointPool[i];
      pt.color.setHex(s.color);
      pt.position.set(s.x, s.y + s.ground, s.z);
      pt.distance = s.dist;
      pt.intensity = s.intensity * lampScale * fade;
    }
    for (let i = ptUsed; i < streetPointPool.length; i++) {
      streetPointPool[i].intensity = 0;
      streetPointPool[i].position.set(0, -1000, 0);
    }
  }

  scene.add(group);
  return { group, footprints, signalClock, signalIntersections, audioSignals, treeField, update };
}

export { buildStreetDetails };
