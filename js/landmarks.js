import * as THREE from 'three/webgpu';
import { color, fract, mix, smoothstep, uv } from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LANDMARK_SITES } from './city-config.js';
import { groundHeight } from './surfaces.js';
import { buildHarbourBridge, harbourBridgeColliders } from './harbour-bridge.js';
import { createRoadSurfaceMaterial } from './tsl-materials.js';

// Sydney's icons at their real sites. The Opera House's shells are patches of spheres, the geometry Utzon settled on to
// make them buildable; the bridge has a module of its own.

const stone = (hex, roughness = 0.88) => new THREE.MeshStandardNodeMaterial({ color: hex, roughness });
const SANDSTONE = () => stone(0xc9a877);

function settle(mesh, cast = true) {
  mesh.castShadow = cast;
  mesh.receiveShadow = true;
  mesh.userData.lifted = true;
  return mesh;
}

// A curved triangle a, b, c on the sphere through them, its centre `depth` metres back along the triangle's normal
function shellPatch(a, b, c, depth, steps = 9) {
  const ab = new THREE.Vector3().subVectors(b, a), ac = new THREE.Vector3().subVectors(c, a);
  const n = new THREE.Vector3().crossVectors(ab, ac);
  // Circumcentre of the triangle
  const o = a.clone().add(
    new THREE.Vector3().crossVectors(n, ab).multiplyScalar(ac.lengthSq())
      .add(new THREE.Vector3().crossVectors(ac, n).multiplyScalar(ab.lengthSq()))
      .divideScalar(2 * n.lengthSq())
  );
  const centre = o.clone().addScaledVector(n.clone().normalize(), -depth);
  const radius = a.distanceTo(centre);
  const positions = [], normals = [], uvs = [], index = [];
  const p = new THREE.Vector3();
  const row = [];
  for (let i = 0; i <= steps; i++) {
    row.push(positions.length / 3);
    for (let j = 0; j <= steps - i; j++) {
      const u = i / steps, v = j / steps, w = 1 - u - v;
      p.set(0, 0, 0).addScaledVector(a, w).addScaledVector(b, u).addScaledVector(c, v).sub(centre).normalize();
      normals.push(p.x, p.y, p.z);
      p.multiplyScalar(radius).add(centre);
      positions.push(p.x, p.y, p.z);
      uvs.push(u, v);
    }
  }
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps - i; j++) {
      const q = row[i] + j, r = row[i + 1] + j;
      index.push(q, r, q + 1);
      if (j < steps - i - 1) index.push(q + 1, r, r + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  return g;
}

function buildOperaHouse(group, colliders) {
  const { x, z } = LANDMARK_SITES.operaHouse;
  const base = groundHeight(x, z);
  // The building's axis, pointing out along Bennelong Point
  const yaw = 0.4;
  const ux = Math.sin(yaw), uz = -Math.cos(yaw); // along the point, towards the harbour
  const vx = -uz, vz = ux; // across it, towards Farm Cove
  const at = (u, v, y) => new THREE.Vector3(x + ux * u + vx * v, base + y, z + uz * u + vz * v);

  // The podium in pink granite, the steps up to it from the forecourt
  const site = new THREE.Group();
  site.position.set(x, base, z);
  site.rotation.y = Math.atan2(ux, uz);
  site.userData.lifted = true;
  const granite = stone(0xa78f7f);
  const podium = settle(new THREE.Mesh(new THREE.BoxGeometry(120, 7.4, 186), granite));
  podium.position.set(0, 3.5, 0);
  site.add(podium);
  for (let i = 0; i < 6; i++) {
    const step = settle(new THREE.Mesh(new THREE.BoxGeometry(92, 1.25, 7), granite));
    step.position.set(0, 0.62 + i * 1.2, -96 - (5 - i) * 3.4);
    site.add(step);
  }
  group.add(site);

  // Each shell: a pointed arch of two patches meeting at a ridge, its tip leaning out towards the harbour
  const white = new THREE.MeshStandardNodeMaterial({ roughness: 0.34, metalness: 0.02, side: THREE.DoubleSide });
  const tiles = fract(uv().x.mul(26)).sub(0.5).abs().add(fract(uv().y.mul(26)).sub(0.5).abs());
  white.colorNode = mix(color(0xf3efe3), color(0xd9d0ba), smoothstep(0.82, 0.96, tiles));
  // Floodlit at night
  white.emissiveNode = color(0xfff4e0).mul(smoothstep(0.55, 1.2, cityUniforms.uInteriorGlow).mul(0.75));
  const shells = [];
  const shell = (v, u, length, height, span, depth = 70) => {
    const tip = at(u + length, v, height);
    const foot = at(u - length * 0.12, v, 7);
    for (const side of [-1, 1]) {
      const leg = at(u + length * 0.42, v + side * span, 7);
      shells.push(shellPatch(tip, side > 0 ? foot : leg, side > 0 ? leg : foot, depth));
    }
  };
  // The Concert Hall on the Sydney Cove side, the Joan Sutherland Theatre on the Farm Cove side
  for (const [v, heights] of [[-27, [65, 56, 44, 30]], [27, [58, 50, 40, 26]]]) {
    let u = -30;
    heights.forEach((h, i) => {
      shell(v, u, 34 - i * 3, h, 21 - i * 2.2);
      u += 27 - i * 2;
    });
    // The shell behind them, facing the forecourt
    shells.push(...[-1, 1].map((side) => shellPatch(at(-58, v, 34), side > 0 ? at(-24, v, 7) : at(-30, v + side * 16, 7), side > 0 ? at(-30, v + side * 16, 7) : at(-24, v, 7), 62)));
  }
  // The Bennelong restaurant's small shells at the foot of the steps
  shell(4, -92, 16, 20, 9, 42);
  shell(4, -78, 12, 15, 7, 42);
  group.add(settle(new THREE.Mesh(mergeGeometries(shells, false), white)));

  const hw = 62, hd = 118; // half width, half depth of the site
  const reach = Math.abs(ux) * hd + Math.abs(vx) * hw, reachZ = Math.abs(uz) * hd + Math.abs(vz) * hw;
  colliders.push({ minX: x - reach, maxX: x + reach, minZ: z - reachZ, maxZ: z + reachZ, minY: 0, maxY: 7.4,
    obb: { cx: x, cz: z, hx: hw, hz: hd, cs: Math.cos(Math.atan2(ux, uz)), sn: Math.sin(Math.atan2(ux, uz)) } });
}

// Sydney Tower: a slim golden turret on its shaft and the stays around it, standing out of Westfield
function buildSydneyTower(group) {
  const { x, z } = LANDMARK_SITES.sydneyTower;
  const base = groundHeight(x, z);
  const metal = new THREE.MeshStandardNodeMaterial({ color: 0xc8cbcd, roughness: 0.4, metalness: 0.6 });
  const gold = new THREE.MeshStandardNodeMaterial({ color: 0xd9a441, roughness: 0.32, metalness: 0.85 });
  gold.emissiveNode = color(0xffc25a).mul(smoothstep(0.55, 1.2, cityUniforms.uInteriorGlow).mul(0.9));
  const glass = new THREE.MeshStandardNodeMaterial({ color: 0x2f3e4a, roughness: 0.2, metalness: 0.7 });
  const add = (geometry, material, y) => {
    const mesh = settle(new THREE.Mesh(geometry, material));
    mesh.position.set(x, base + y, z);
    group.add(mesh);
  };
  add(new THREE.CylinderGeometry(3.6, 4.4, 250, 16), metal, 125);
  add(new THREE.CylinderGeometry(21, 16, 5, 28), gold, 232);
  add(new THREE.CylinderGeometry(23, 21, 6, 28), glass, 238);
  add(new THREE.CylinderGeometry(23, 23, 9, 28), gold, 245);
  add(new THREE.CylinderGeometry(21, 23, 6, 28), glass, 252);
  add(new THREE.CylinderGeometry(15, 21, 5, 28), gold, 257);
  add(new THREE.CylinderGeometry(0.4, 2.4, 50, 8), gold, 284);
  const stays = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const top = new THREE.Vector3(Math.cos(a) * 12, 228, Math.sin(a) * 12), foot = new THREE.Vector3(Math.cos(a) * 15, 60, Math.sin(a) * 15);
    const c = new THREE.CylinderGeometry(0.12, 0.12, top.distanceTo(foot), 5);
    c.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), top.clone().sub(foot).normalize()));
    c.translate((top.x + foot.x) / 2, (top.y + foot.y) / 2, (top.z + foot.z) / 2);
    stays.push(c);
  }
  add(mergeGeometries(stays, false), metal, 0);
}

function clockTower(group, x, z, w, height, material, roofHeight = 0, roof = null) {
  const base = groundHeight(x, z);
  const shaft = settle(new THREE.Mesh(new THREE.BoxGeometry(w, height, w), material));
  shaft.position.set(x, base + height / 2, z);
  group.add(shaft);
  if (roof) {
    const cap = settle(new THREE.Mesh(new THREE.ConeGeometry(w * 0.72, roofHeight, 4), roof));
    cap.rotation.y = Math.PI / 4;
    cap.position.set(x, base + height + roofHeight / 2, z);
    group.add(cap);
  }
  const dial = new THREE.MeshStandardNodeMaterial({ color: 0xf2ead7, roughness: 0.6 });
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const face = new THREE.Mesh(new THREE.CircleGeometry(w * 0.3, 20), dial);
    face.position.set(x + dx * (w / 2 + 0.05), base + height * 0.86, z + dz * (w / 2 + 0.05));
    face.rotation.y = Math.atan2(dx, dz);
    face.userData.lifted = true;
    group.add(face);
  }
}

function dome(group, x, z, y, radius, material) {
  const mesh = settle(new THREE.Mesh(new THREE.SphereGeometry(radius, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), material));
  mesh.scale.y = 1.25;
  mesh.position.set(x, groundHeight(x, z) + y, z);
  group.add(mesh);
}

function buildHeritage(group) {
  const sandstone = SANDSTONE();
  const copper = stone(0x5f8f7c, 0.6);
  const slate = stone(0x4d545c, 0.7);
  // Sydney Town Hall's clock tower over George St, and Central's
  clockTower(group, -36, 6, 11, 56, sandstone, 7, slate);
  clockTower(group, 96, 1160, 13, 76, sandstone);
  // The Queen Victoria Building's copper domes down its roof
  dome(group, -40, -143, 36, 11, copper);
  for (const dz of [-70, -46, 46, 70]) dome(group, -40, -143 + dz, 34, 4.2, copper);
  // St Mary's twin spires, facing Hyde Park
  for (const dx of [-11, 11]) clockTower(group, 567 + dx, -228, 8.5, 54, sandstone, 22, slate);
}

// Luna Park: the big face at the gate and the wheel behind it
function buildLunaPark(group) {
  const { x, z } = LANDMARK_SITES.lunaPark;
  const base = groundHeight(x, z);
  const bright = (hex) => new THREE.MeshStandardNodeMaterial({ color: hex, roughness: 0.5, emissive: hex, emissiveIntensity: 0.25 });
  const face = new THREE.Group();
  face.position.set(x + 10, base, z + 20);
  face.rotation.y = 2.8;
  face.userData.lifted = true;
  const disc = (r, hex, px, py, pz = 0.4) => {
    const m = new THREE.Mesh(new THREE.CircleGeometry(r, 28), bright(hex));
    m.position.set(px, py, pz);
    m.userData.lifted = true;
    face.add(m);
  };
  disc(10.5, 0xf6c21c, 0, 12);
  disc(2.2, 0xffffff, -3.8, 15);
  disc(2.2, 0xffffff, 3.8, 15);
  disc(1.1, 0x1b5fbb, -3.8, 15, 0.5);
  disc(1.1, 0x1b5fbb, 3.8, 15, 0.5);
  disc(4.4, 0xc4202a, 0, 7.6);
  disc(3.2, 0x201414, 0, 6.4, 0.5);
  for (const dx of [-13, 13]) {
    const tower = settle(new THREE.Mesh(new THREE.CylinderGeometry(1.7, 2.1, 22, 12), bright(dx < 0 ? 0xd9304a : 0x27a0d8)));
    tower.position.set(dx, 11, 0);
    face.add(tower);
  }
  group.add(face);

  const steel = new THREE.MeshStandardNodeMaterial({ color: 0xd8dde2, roughness: 0.45, metalness: 0.5 });
  const wheel = new THREE.Group();
  wheel.position.set(x - 25, base + 21, z + 45);
  wheel.userData.lifted = true;
  const rim = settle(new THREE.Mesh(new THREE.TorusGeometry(17, 0.4, 8, 40), steel));
  rim.userData.lifted = true;
  wheel.add(rim);
  for (let i = 0; i < 12; i++) {
    const spoke = settle(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 34, 5), steel));
    spoke.rotation.z = (i / 12) * Math.PI;
    wheel.add(spoke);
    const a = (i / 12) * Math.PI * 2;
    const car = settle(new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 2), bright([0xd9304a, 0xf6c21c, 0x27a0d8][i % 3])));
    car.position.set(Math.cos(a) * 17, Math.sin(a) * 17 - 1, 0);
    wheel.add(car);
  }
  group.add(wheel);
}

function buildLandmarks(scene) {
  const group = new THREE.Group();
  group.name = 'Landmarks';
  const colliders = [];
  buildOperaHouse(group, colliders);
  buildSydneyTower(group);
  buildHeritage(group);
  buildLunaPark(group);
  harbourBridgeColliders(colliders);
  scene.add(group);
  return { group, colliders };
}

// The bridge itself is most of the time the landmarks take to build, and nothing shows them before the first frame
function addHarbourBridge(group) {
  const deck = new THREE.Mesh(buildHarbourBridge(group), createRoadSurfaceMaterial());
  deck.receiveShadow = true;
  deck.userData.lifted = true;
  group.add(deck);
}

export { addHarbourBridge, buildLandmarks };
