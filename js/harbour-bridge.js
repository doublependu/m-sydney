import * as THREE from 'three/webgpu';
import { color, smoothstep } from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';
import { BRIDGE_LENGTH, BRIDGE_SPAN, bridgePoint, deckHeight } from './bridge.js';
import { terrainHeight } from './terrain.js';

// The Sydney Harbour Bridge: the deck along the corridor (js/bridge.js), the steel through-arch over the water with its
// hangers, the granite pylons at each end of the arch, and the piers carrying the approaches.

const WATER = -2.2;
const DECK_WIDTH = 34; // of what is modelled; the corridor's lanes run down the middle
const TRUSS_OFFSET = 15; // m each side of the deck's centre line
const ARCH_TOP = 134 + WATER; // top of the arch above the water
const LOWER_RISE = 118; // m the lower chord rises from its hinges
const PANELS = 28;
const PYLON_HEIGHT = 89 + WATER;

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

function buildHarbourBridge(group, colliders) {
  const bridge = new THREE.Group();
  bridge.name = 'HarbourBridge';
  bridge.userData.lifted = true;
  const struts = [];
  const strut = (a, b, w = 1.6, d = 1.6) => struts.push(strutMatrix(a, b, w, d));

  // The arch's axis: straight between the shores, on the deck's line
  const { south, north, middle } = BRIDGE_SPAN;
  const halfSpan = Math.min(251.5, (north - south) / 2 + 40);
  const axis = (s) => bridgePoint(s);
  const across = (p, side) => new THREE.Vector2(-p.uz * side, p.ux * side);
  const at = (s, side, y) => {
    const p = axis(s), n = across(p, side);
    return new THREE.Vector3(p.x + n.x, y, p.z + n.y);
  };
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

  // Approach spans: steel piers from the ground up to the deck, either side of the arch
  const PIER_STEP = 56;
  for (let s = 40; s < BRIDGE_LENGTH - 40; s += PIER_STEP) {
    if (s > middle - halfSpan - 6 && s < middle + halfSpan + 6) continue;
    const deck = deckHeight(s) - 1.4;
    for (const side of [-TRUSS_OFFSET, TRUSS_OFFSET]) {
      const foot = at(s, side, 0);
      const ground = Math.max(WATER, terrainHeight(foot.x, foot.z));
      if (deck - ground < 2.5) continue;
      foot.y = ground - 1;
      strut(foot, at(s, side, deck), 2.0, 2.8);
    }
    const p = at(s, 0, 0);
    if (deck - Math.max(WATER, terrainHeight(p.x, p.z)) > 2.5) strut(at(s, -TRUSS_OFFSET, deck), at(s, TRUSS_OFFSET, deck), 1.4, 2.2);
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

  // The deck: road surface, parapets, its steel flank, all following the corridor's height
  const position = [], normal = [], uv = [], index = [];
  const flank = { position: [], normal: [], index: [] };
  for (let s = 0; s <= BRIDGE_LENGTH + 0.1; s += 12) {
    const q = axis(Math.min(s, BRIDGE_LENGTH)), n = across(q, 1), y = deckHeight(Math.min(s, BRIDGE_LENGTH)) - 0.04;
    const hw = s < 60 || s > BRIDGE_LENGTH - 60 ? 13 : DECK_WIDTH / 2;
    const i = position.length / 3;
    position.push(q.x + n.x * hw, y, q.z + n.y * hw, q.x - n.x * hw, y, q.z - n.y * hw);
    normal.push(0, 1, 0, 0, 1, 0);
    uv.push(0, s, 1, s);
    const f = flank.position.length / 3;
    for (const side of [1, -1]) {
      const fx = q.x + n.x * hw * side, fz = q.z + n.y * hw * side;
      flank.position.push(fx, y + 1.1, fz, fx, y - 2.6, fz);
      flank.normal.push(n.x * side, 0, n.y * side, n.x * side, 0, n.y * side);
    }
    if (s > 0) {
      index.push(i - 2, i, i - 1, i - 1, i, i + 1);
      flank.index.push(f - 4, f - 3, f, f, f - 3, f + 1, f - 2, f + 2, f - 1, f - 1, f + 2, f + 3);
    }
  }
  const surface = new THREE.BufferGeometry();
  surface.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  surface.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  surface.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  surface.setIndex(index);
  const flanks = new THREE.BufferGeometry();
  flanks.setAttribute('position', new THREE.Float32BufferAttribute(flank.position, 3));
  flanks.setAttribute('normal', new THREE.Float32BufferAttribute(flank.normal, 3));
  flanks.setIndex(flank.index);
  const flankMaterial = deckSide.clone();
  flankMaterial.side = THREE.DoubleSide;
  const flankMesh = new THREE.Mesh(flanks, flankMaterial);
  flankMesh.castShadow = true;
  flankMesh.userData.lifted = true;
  bridge.add(flankMesh);

  // Four granite pylons, two at each end of the arch
  for (const s of [middle - halfSpan - 7, middle + halfSpan + 7]) {
    for (const side of [-TRUSS_OFFSET - 1, TRUSS_OFFSET + 1]) {
      const p = at(s, side, 0);
      const q = axis(s);
      const yaw = Math.atan2(q.ux, q.uz);
      const base = Math.max(WATER, terrainHeight(p.x, p.z)) - 1;
      const parts = [[15.5, 21, base, PYLON_HEIGHT - 12], [12.5, 18, PYLON_HEIGHT - 12, PYLON_HEIGHT - 3], [10.5, 15.5, PYLON_HEIGHT - 3, PYLON_HEIGHT]];
      for (const [w, d, y0, y1] of parts) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, y1 - y0, d), granite);
        mesh.position.set(p.x, (y0 + y1) / 2, p.z);
        mesh.rotation.y = yaw;
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.userData.lifted = true;
        bridge.add(mesh);
      }
      colliders.push({ minX: p.x - 14, maxX: p.x + 14, minZ: p.z - 14, maxZ: p.z + 14, minY: 0, maxY: PYLON_HEIGHT - terrainHeight(p.x, p.z) });
    }
  }
  group.add(bridge);
  return surface;
}

export { buildHarbourBridge };
