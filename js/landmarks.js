import * as THREE from 'three/webgpu';
import { color, float, mix, smoothstep, texture, uv } from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LANDMARK_SITES } from './city-config.js';
import { groundHeight } from './surfaces.js';
import { buildHarbourBridge, harbourBridgeColliders } from './harbour-bridge.js';
import { buildOperaHouse } from './opera-house.js';
import { createRoadSurfaceMaterial } from './tsl-materials.js';
import { TOWER_SIGNS, placeTowerSign } from './tower-signs.js';

// Sydney's icons at their real sites. The Opera House (js/opera-house.js) and the bridge have modules of their own.

const stone = (hex, roughness = 0.88) => new THREE.MeshStandardNodeMaterial({ color: hex, roughness });
const SANDSTONE = () => stone(0xc9a877);

function settle(mesh, cast = true) {
  mesh.castShadow = cast;
  mesh.receiveShadow = true;
  mesh.userData.lifted = true;
  return mesh;
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

function clockTower(group, x, z, w, height, material, roofHeight = 0, roof = null, dials = true) {
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
  if (!dials) return;
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

// A row of square stone piers from a to b, with the beam along their tops
function colonnade(group, ax, az, bx, bz, count, height, width, material) {
  const y = groundHeight((ax + bx) / 2, (az + bz) / 2);
  const parts = [];
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0.5;
    parts.push(new THREE.BoxGeometry(width, height + 2, width).translate(ax + (bx - ax) * t, y + height / 2 - 1, az + (bz - az) * t));
  }
  const L = Math.hypot(bx - ax, bz - az);
  const beam = new THREE.BoxGeometry(L + width, 1, width * 1.3);
  beam.rotateY(-Math.atan2(bz - az, bx - ax)).translate((ax + bx) / 2, y + height + 0.5, (az + bz) / 2);
  parts.push(beam);
  group.add(settle(new THREE.Mesh(mergeGeometries(parts, false), material)));
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
  // St Mary's twin spires, in pale yellow stone, facing Hyde Park
  const paleStone = stone(0xcdb582);
  for (const dx of [-11, 11]) clockTower(group, 567 + dx, -228, 8.5, 54, paleStone, 22, slate, false);
  // The General Post Office on Martin Place: its clock tower, and the colonnade along the street
  clockTower(group, -12, -590, 10, 73, sandstone, 4, slate);
  colonnade(group, -55, -571.5, 35, -571.5, 22, 7.5, 1.1, sandstone);
  // The State Library's portico, up its steps on Shakespeare Place
  colonnade(group, 434, -782, 464, -782, 8, 12, 1.5, sandstone);
  const library = settle(new THREE.Mesh(new THREE.BoxGeometry(32, 3.2, 5), sandstone));
  library.position.set(449, groundHeight(449, -781) + 13.6, -781);
  group.add(library);
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
  const opera = buildOperaHouse(group, colliders);
  buildSydneyTower(group);
  buildHeritage(group);
  buildLunaPark(group);
  harbourBridgeColliders(colliders);
  scene.add(group);
  return { group, colliders, operaPlain: opera.plain };
}

/** Just where the landmarks stand, for making the tiles: the buildings they replace (tools/tiles/derive.mjs) */
function landmarkColliders() {
  const colliders = [];
  buildOperaHouse(new THREE.Group(), colliders, colliders);
  harbourBridgeColliders(colliders);
  return colliders;
}

// The company names on the two towers (js/tower-signs.js), from one texture and one unlit material
function addTowerSigns(group) {
  const ROW = 256;
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = ROW * 2;
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const parts = TOWER_SIGNS.map((sign, i) => {
    const height = Math.round(canvas.width * (sign.h / sign.w));
    ctx.fillStyle = '#10151c';
    ctx.fillRect(0, i * ROW, canvas.width, height);
    ctx.fillStyle = sign.ink;
    ctx.font = `700 ${Math.round(height * 0.84)}px Overpass, Inter, Arial, sans-serif`;
    ctx.fillText(sign.text, canvas.width / 2, i * ROW + height * 0.54, canvas.width * 0.95);
    const place = placeTowerSign(sign);
    const plane = new THREE.PlaneGeometry(sign.w, sign.h);
    // This sign's strip of the texture; canvas rows run top down, texture rows bottom up
    const coords = plane.attributes.uv;
    const v1 = 1 - (i * ROW) / canvas.height, v0 = 1 - (i * ROW + height) / canvas.height;
    for (let k = 0; k < coords.count; k++) coords.setY(k, coords.getY(k) > 0.5 ? v1 : v0);
    plane.rotateY(place.yaw).translate(place.x, place.y, place.z);
    return plane;
  });
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = texture(map, uv()).mul(mix(float(0.9), float(1.7), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow)));
  const mesh = new THREE.Mesh(mergeGeometries(parts), material);
  mesh.name = 'TowerSigns';
  mesh.userData.lifted = true; // placed at the towers' own height
  group.add(mesh);
}

// The bridge itself is most of the time the landmarks take to build, and nothing shows them before the first frame
function addHarbourBridge(group) {
  const deck = new THREE.Mesh(buildHarbourBridge(group), createRoadSurfaceMaterial());
  deck.receiveShadow = true;
  deck.userData.lifted = true;
  group.add(deck);
}

export { addHarbourBridge, addTowerSigns, buildLandmarks, landmarkColliders };
