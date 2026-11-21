import * as THREE from 'three/webgpu';
import { color, float, max, mix, smoothstep, texture, uv, vec4, vertexColor } from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addFirstShape } from './first-shapes.js';
import { MODEL_SITES, toWorldOf } from './model-sites.js';
import { groundHeight } from './surfaces.js';
import { buildHarbourBridge, harbourBridgeColliders } from './harbour-bridge.js';
import { buildOperaHouse } from './opera-house.js';
import { createRoadSurfaceMaterial } from './tsl-materials.js';
import { TOWER_SIGNS, placeTowerSign } from './tower-signs.js';
import { TOWER, TOWER_AXIS, TOWER_STREET, towerCables } from './sydney-tower.js';

// Sydney's icons at their real sites. The Opera House (js/opera-house.js) and the bridge have modules of their own.
// Where a model site (js/model-sites.js) is drawn in place of one of these, the game's shape is part of the site's first shape, shown
// till the model or its far version is drawn and hidden while it is: a line each, addFirstShape(<site id>, <object>) (js/first-shapes.js).

const stone = (hex, roughness = 0.88) => new THREE.MeshStandardNodeMaterial({ color: hex, roughness });
const SANDSTONE = () => stone(0xc9a877);

function settle(mesh, cast = true) {
  mesh.castShadow = cast;
  mesh.receiveShadow = true;
  mesh.userData.lifted = true;
  return mesh;
}

// Sydney Tower, from its shape (js/sydney-tower.js), and Westfield's podium round its foot: drawn from anywhere, and in place of its model
// (js/model-sites.js `sydney-tower`) wherever that isn't drawn, so the two are made alike. Three draws: the gold, everything else in its
// own colours, and the turret's windows, lit at night; with its far version too, which is the podium alone. The podium is a fourth,
// drawn only while nothing else stands there: the map's podium from its tile (js/first-shapes.js), the model, or its far version.
// Returns the group, the podium in it.
function buildSydneyTower(group) {
  const tower = new THREE.Group();
  tower.name = 'SydneyTower';
  tower.position.set(TOWER_AXIS.x, TOWER_STREET, TOWER_AXIS.z);
  tower.userData.lifted = true;
  const linear = (hex) => new THREE.Color(hex);
  const coloured = (g, hex) => {
    const c = linear(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g.index ? g.toNonIndexed() : g;
  };
  const lathe = (profile, segments) => new THREE.LatheGeometry(profile.map(([y, r]) => new THREE.Vector2(Math.max(r, 0.001), y)), segments);
  const gold = [], rest = [];
  for (const part of TOWER.parts) {
    const g = coloured(lathe(part.profile, part.name === 'spire' ? 6 : part.name === 'shaft' || part.name === 'base' ? 16 : 32), part.colour);
    (part.material === 'metal' ? gold : rest).push(g);
  }
  // The net, fewer cables than the model's: at this distance a mesh, not cables
  for (const [a, b] of towerCables(20)) {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
    const g = new THREE.CylinderGeometry(0.16, 0.16, A.distanceTo(B), 3, 1, true);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize()));
    g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
    rest.push(coloured(g, '#3c3a38'));
  }
  // The podium, its outline straight up from under the street to its roof
  const shape = new THREE.Shape(TOWER.podium.outline.map(([x, z]) => new THREE.Vector2(x - TOWER_AXIS.x, -(z - TOWER_AXIS.z))));
  const podium = new THREE.ExtrudeGeometry(shape, { depth: TOWER.podium.top + 2.5, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, -2.5, 0);
  const podiumGeometry = coloured(podium, '#cfc3ad');
  const cup = TOWER.parts.find((p) => p.name === 'cup').profile;
  const at = (y) => {
    const k = cup.findIndex(([y1]) => y1 >= y), i = k < 0 ? cup.length - 1 : Math.max(1, k);
    const [y0, r0] = cup[i - 1], [y1, r1] = cup[i];
    return r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
  };
  // each band bent where the cup's profile bends, so it's never under it
  const windows = TOWER.windows.map(([y0, y1]) => lathe([y0, ...cup.map(([y]) => y).filter((y) => y > y0 && y < y1), y1].map((y) => [y, at(y) + 0.05]), 32));
  const goldMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.85 });
  goldMaterial.emissiveNode = color(0xffc25a).mul(smoothstep(0.55, 1.2, cityUniforms.uInteriorGlow).mul(0.9));
  const restMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.35 });
  const glass = new THREE.MeshStandardNodeMaterial({ color: 0x1c2228, roughness: 0.15, metalness: 0.6 });
  glass.emissiveNode = color(0xffd9a0).mul(smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow).mul(0.7));
  const meshes = [];
  for (const [list, material] of [[gold, goldMaterial], [rest, restMaterial], [windows.map((g) => g.index ? g.toNonIndexed() : g), glass], [[podiumGeometry], restMaterial]]) {
    const mesh = settle(new THREE.Mesh(mergeGeometries(list.map((g) => { g.deleteAttribute('uv'); return g; }), false), material));
    mesh.frustumCulled = false; // js/scene-culling.js leaves it be, for the model to stand in for
    tower.add(mesh);
    meshes.push(mesh);
  }
  meshes[3].name = 'SydneyTowerPodium';
  group.add(tower);
  addFirstShape('sydney-tower', tower, { far: true });
  addFirstShape('sydney-tower', meshes[3], { bare: true });
  return tower;
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
  // Sydney Town Hall's clock tower over George St
  clockTower(group, -36, 6, 11, 56, sandstone, 7, slate);
  buildCentralTower(group);
  buildQvbDomes(group, copper);
  buildStMarysSpires(group);
  // The General Post Office on Martin Place: its clock tower, and the colonnade along the street
  clockTower(group, -12, -590, 10, 73, sandstone, 4, slate);
  colonnade(group, -55, -571.5, 35, -571.5, 22, 7.5, 1.1, sandstone);
  // The State Library's portico, up its steps on Shakespeare Place
  colonnade(group, 434, -782, 464, -782, 8, 12, 1.5, sandstone);
  const library = settle(new THREE.Mesh(new THREE.BoxGeometry(32, 3.2, 5), sandstone));
  library.position.set(449, groundHeight(449, -781) + 13.6, -781);
  group.add(library);
}

// Central Station's clock tower, at the north end of its west wing (js/model-sites.js `central-station`, in its frame): the shaft, the
// clock's stage and its four dials, the cornice, the belfry, the lantern's drum and its copper dome, the flagpole, to its model's
// heights. One mesh in its own colours, lit a little at night. Part of its first shape, with the map's box of the building; the map's
// box of the tower is left out of that (its site's `replaces`), as this stands there.
const CENTRAL_TOWER = { x: 63.4, z: -3.6, half: 5.0, foot: -4.0 };
function buildCentralTower(group) {
  const site = MODEL_SITES.find((s) => s.id === 'central-station');
  const { x, z, half, foot } = CENTRAL_TOWER;
  const parts = [];
  const add = (g, hex, dx = 0, y = 0, dz = 0) => {
    g.translate(x + dx, y, z + dz);
    const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    g.deleteAttribute('uv');
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  const block = (w, y0, y1, hex) => add(new THREE.BoxGeometry(w, y1 - y0, w), hex, 0, (y0 + y1) / 2);
  block(2 * half, foot, 47.0, 0xc3a072);
  block(2 * half + 0.8, 47.0, 48.2, 0xa2804f);
  block(2 * half, 48.2, 58.0, 0xd4b88b);
  block(2 * half + 1.5, 58.0, 59.4, 0xa2804f);
  block(2 * (half - 0.8), 59.4, 67.0, 0xc9a97a);
  block(2 * (half - 0.35), 67.0, 68.0, 0xa2804f);
  add(new THREE.CylinderGeometry(3.95, 3.95, 4.85, 8, 1).rotateY(Math.PI / 8), 0xd4b88b, 0, 70.42);
  add(new THREE.SphereGeometry(3.75, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 7.6 / 3.75, 1), 0x6d5a44, 0, 72.85);
  add(new THREE.ConeGeometry(0.5, 2.2, 8), 0x5a4630, 0, 81.5);
  add(new THREE.CylinderGeometry(0.04, 0.07, 8.0, 6), 0xe8e6df, 0, 86.4);
  // each face: its dial, and the belfry's openings, dark
  for (const [nx, nz] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
    const turn = (g) => g.rotateY(Math.atan2(nx, nz));
    add(turn(new THREE.CircleGeometry(2.45, 24)), 0xf4f0e4, nx * (half + 0.2), 53.1, nz * (half + 0.2));
    for (const s of [-2.6, 0, 2.6]) {
      add(turn(new THREE.PlaneGeometry(1.6, 4.4)), 0x2a2420, nx * (half - 0.78) + nz * s, 62.9, nz * (half - 0.78) - nx * s);
    }
  }
  const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.85 });
  material.emissiveNode = vertexColor().mul(smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow).mul(0.35));
  const mesh = settle(new THREE.Mesh(mergeGeometries(parts, false), material));
  mesh.name = 'CentralTower';
  mesh.position.set(site.x, site.y, site.z);
  mesh.rotation.y = site.yaw;
  group.add(mesh);
  addFirstShape('central-station', mesh);
}

// The Queen Victoria Building's copper domes, on the map's boxes of it (js/model-sites.js `qvb`, in its frame): the great dome on its drum
// over the middle, the twenty small ones along its roof where OpenStreetMap has them, twelve on the map's boxes of them and eight on the
// long box's roof. One mesh, part of its first shape: shown with the map's boxes till the model or its far version is drawn.
const QVB_MAP = { floor: 22.3, roof: 16, domes: 17, drum: 26 }; // the map's boxes of it: the floor they stand on, and their heights
function buildQvbDomes(group, material) {
  const site = MODEL_SITES.find((s) => s.id === 'qvb');
  const parts = [];
  const add = (lx, lz, base, r, k) => {
    const { x, z } = toWorldOf(site, lx, lz);
    const g = new THREE.SphereGeometry(r, k, Math.max(4, k / 2), 0, Math.PI * 2, 0, Math.PI / 2).scale(1, r > 6 ? 0.95 : 1.25, 1);
    g.deleteAttribute('uv');
    parts.push(g.translate(x, base, z));
  };
  add(0, 0, QVB_MAP.floor + QVB_MAP.drum, 10.6, 20);
  for (const x of [9.8, 79.0, 89.6]) for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(sx * x, sz * (x > 50 ? 10.7 : 10.9), QVB_MAP.floor + QVB_MAP.domes, 3.2, 10);
  for (const x of [39.3, 49.2]) for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(sx * x, sz * 10.9, QVB_MAP.floor + QVB_MAP.roof, 3.2, 10);
  const mesh = settle(new THREE.Mesh(mergeGeometries(parts, false), material));
  mesh.name = 'QvbDomes';
  group.add(mesh);
  addFirstShape('qvb', mesh);
}

// St Mary's twin towers and spires, in pale yellow stone, on the front of the map's box of the cathedral facing the forecourt: where
// its model's towers stand (js/model-sites.js `st-marys`), to the same height. Part of its first shape: shown with the map's box till
// the model or its far version is drawn.
function buildStMarysSpires(group) {
  const site = MODEL_SITES.find((s) => s.id === 'st-marys');
  const spires = new THREE.Group();
  spires.name = 'StMarysSpires';
  const paleStone = stone(0xcdb582);
  for (const dx of [-8.25, 8.25]) {
    const { x, z } = toWorldOf(site, dx, 50.75);
    clockTower(spires, x, z, 8.5, site.y + 43 - groundHeight(x, z), paleStone, 31.5, paleStone, false);
  }
  group.add(spires);
  addFirstShape('st-marys', spires);
}

// Luna Park: the face at its gate between its two towers, and the wheel behind, in the site's frame (js/model-sites.js `luna-park`: the
// face's front at its middle, +z out through it). Its site's first shape, with the map's boxes the model replaces (js/first-shapes.js):
// one mesh in its own colours, glowing a little at night, hidden once the model or its far version is drawn. Its towers stand round the
// map's boxes of them, so the two are never drawn in one plane.
const LUNA_WHEEL = { x: -85.4, z: -2726.6, plane: [0.605, -0.796], hub: 17.8, rim: 15 }; // the world's frame: its fence's middle, along it
function buildLunaPark(group) {
  const site = MODEL_SITES.find((s) => s.id === 'luna-park');
  const parts = [];
  const add = (g, hex, x = 0, y = 0, z = 0) => {
    g.translate(x, y, z);
    const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    g.deleteAttribute('uv');
    parts.push(g.index ? g.toNonIndexed() : g);
    return g;
  };
  const box = (x0, y0, z0, x1, y1, z1, hex) => add(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), hex, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  for (const s of [-1, 1]) {
    const [x0, x1] = s > 0 ? [4.2, 8.75] : [-8.75, -4.2];
    box(x0 - 0.1, -1.5, -3.4, x1 + 0.1, 3.05, 1.9, 0x1f73c4);
    box(x0, 3.05, -3.3, x1, 16.6, 1.8, 0xf2e6d0);
    box(x0 - 0.15, 16.6, -3.45, x1 + 0.15, 18.1, 1.95, 0x1a7f9c);
    const cx = (x0 + x1) / 2;
    box(cx - 1.6, 18.1, -2.35, cx + 1.6, 20.4, 0.85, 0xf2e6d0);
    add(new THREE.ConeGeometry(1.6, 8.2, 8), 0xf6f3ec, cx, 24.5, -0.75);
  }
  // the face's block, its mouth open under it, and its jaw either side
  box(-4.2, 3.3, -2.9, 4.2, 12, 0.1, 0xf2e6d0);
  for (const s of [-1, 1]) box(s > 0 ? 3.55 : -4.2, -1.5, -2.9, s > 0 ? 4.2 : -3.55, 3.3, 0.1, 0x1f73c4);
  // the headdress, its band, the face, its eyes and its lip
  add(new THREE.CircleGeometry(4.6, 24, 0, Math.PI).scale(1, 1.5, 1), 0x2b5fb2, 0, 9.47, 0.2);
  add(new THREE.RingGeometry(3.5, 4.1, 24, 1, 0, Math.PI).scale(1, 0.95, 1), 0xef8a24, 0, 9.47, 0.3);
  add(new THREE.CircleGeometry(3.5, 24, 0, Math.PI).scale(1, 0.75, 1), 0xf3dbc6, 0, 9.47, 0.3);
  add(new THREE.PlaneGeometry(8.4, 6.17), 0xf3dbc6, 0, 6.385, 0.3);
  for (const s of [-1, 1]) {
    add(new THREE.CircleGeometry(1, 16).scale(1.39, 0.87, 1), 0xf6f3ec, s * 1.97, 8.16, 0.4);
    add(new THREE.CircleGeometry(0.6, 12), 0x2f86d9, s * 1.97, 8.19, 0.45);
  }
  add(new THREE.PlaneGeometry(7.1, 0.95), 0xd22a2c, 0, 3.8, 0.4);
  // the wheel, still: its rims, spokes, gondolas and A-frames, on the ground where it stands
  const c = Math.cos(site.yaw), sn = Math.sin(site.yaw);
  const local = (x, z) => [(x - site.x) * c - (z - site.z) * sn, (x - site.x) * sn + (z - site.z) * c];
  const [wx, wz] = local(LUNA_WHEEL.x, LUNA_WHEEL.z);
  const hubY = groundHeight(LUNA_WHEEL.x, LUNA_WHEEL.z) - site.y + LUNA_WHEEL.hub;
  const [px, pz] = [LUNA_WHEEL.plane[0] * c - LUNA_WHEEL.plane[1] * sn, LUNA_WHEEL.plane[0] * sn + LUNA_WHEEL.plane[1] * c];
  const turnTo = (g) => g.rotateY(Math.atan2(-pz, px));
  const wheel = [];
  const piece = (g, hex) => { wheel.push([g, hex]); return g; };
  for (const side of [-1, 1]) {
    piece(new THREE.TorusGeometry(LUNA_WHEEL.rim, 0.25, 4, 40).translate(0, 0, side), 0xe9e9e4);
    for (let i = 0; i < 12; i++) {
      piece(new THREE.BoxGeometry(0.15, LUNA_WHEEL.rim * 2, 0.15).rotateZ((i / 12) * Math.PI).translate(0, 0, side), 0xe9e9e4);
    }
    for (const q of [-1, 1]) {
      // from the ground 8 m out along the wheel's plane up to the axle's end
      const length = Math.hypot(8, LUNA_WHEEL.hub);
      const leg = new THREE.BoxGeometry(0.5, length, 0.5);
      leg.translate(0, length / 2, 0).rotateZ(q * Math.atan2(8, LUNA_WHEEL.hub)).translate(q * 8, -LUNA_WHEEL.hub, side * 2.8);
      piece(leg, 0xc42f2a);
    }
  }
  for (let i = 0; i < 24; i++) {
    const t = (i / 24) * Math.PI * 2;
    piece(new THREE.BoxGeometry(1.3, 1.5, 1.6).translate(Math.cos(t) * LUNA_WHEEL.rim, Math.sin(t) * LUNA_WHEEL.rim - 1.2, 0), 0xf4f1ea);
  }
  for (const [g, hex] of wheel) add(turnTo(g).translate(wx, hubY, wz), hex);
  const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6 });
  material.emissiveNode = vertexColor().mul(smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow).mul(0.4));
  const mesh = settle(new THREE.Mesh(mergeGeometries(parts, false), material));
  mesh.name = 'LunaPark';
  mesh.position.set(site.x, site.y, site.z);
  mesh.rotation.y = site.yaw;
  group.add(mesh);
  addFirstShape('luna-park', mesh);
}

function buildLandmarks(scene) {
  const group = new THREE.Group();
  group.name = 'Landmarks';
  const colliders = [];
  const opera = buildOperaHouse(group, colliders);
  // The Opera House's plain podium, glass and steps are its first shape, where its model isn't drawn
  for (const mesh of opera.plain) addFirstShape('opera-house', mesh);
  const tower = buildSydneyTower(group);
  buildHeritage(group);
  buildLunaPark(group);
  harbourBridgeColliders(colliders);
  scene.add(group);
  return { group, colliders, operaPlain: opera.plain, operaShells: opera.shells, towerPlain: tower };
}

/** Just where the landmarks stand, for making the tiles: the buildings they replace (tools/tiles/derive.mjs) */
function landmarkColliders() {
  const colliders = [];
  buildOperaHouse(new THREE.Group(), colliders, colliders);
  harbourBridgeColliders(colliders);
  return colliders;
}

// The company names on the two towers (js/tower-signs.js), from one texture and one unlit material. A panel sign is drawn at once; a
// wordmark when its SVG has come, on a clear ground: the material cuts out round its letters, so they stand on the tower's face with
// nothing behind them, and cast their shadows on it. The texture is filtered premultiplied and divided out after, so a letter's edge
// keeps its own colour rather than fading to the clear ground's black.
function addTowerSigns(group) {
  const ROW = 256;
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = ROW * 2;
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  map.premultiplyAlpha = true;
  const parts = TOWER_SIGNS.map((sign, i) => {
    const height = Math.round(canvas.width * (sign.h / sign.w));
    if (sign.file) {
      // read as text and drawn from a blob of its own type, whatever type the host sends it as
      fetch(new URL(sign.file, document.baseURI)).then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.text();
      }).then((svg) => new Promise((done, fail) => {
        const art = new Image();
        const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        art.onload = () => {
          ctx.drawImage(art, 0, i * ROW, canvas.width, height);
          map.needsUpdate = true;
          URL.revokeObjectURL(url);
          done();
        };
        art.onerror = () => fail(new Error('not drawn'));
        art.src = url;
      })).catch((e) => console.warn('[signs]', sign.file, e.message));
    } else {
      // the panel a little past its strip, so its edge stays put as it's filtered from afar
      ctx.fillStyle = '#10151c';
      ctx.fillRect(0, i * ROW, canvas.width, Math.min(height + 16, ROW - 24));
      ctx.fillStyle = sign.ink;
      ctx.font = `700 ${Math.round(height * 0.84)}px Overpass, Inter, Arial, sans-serif`;
      ctx.fillText(sign.text, canvas.width / 2, i * ROW + height * 0.54, canvas.width * 0.95);
    }
    const place = placeTowerSign(sign);
    const plane = new THREE.PlaneGeometry(sign.w, sign.h);
    // This sign's strip of the texture; canvas rows run top down, texture rows bottom up
    const coords = plane.attributes.uv;
    const v1 = 1 - (i * ROW) / canvas.height, v0 = 1 - (i * ROW + height) / canvas.height;
    for (let k = 0; k < coords.count; k++) coords.setY(k, coords.getY(k) > 0.5 ? v1 : v0);
    plane.rotateY(place.yaw).translate(place.x, place.y, place.z);
    return plane;
  });
  const material = new THREE.MeshBasicNodeMaterial({ alphaToCoverage: true });
  const ink = texture(map, uv());
  const glow = mix(float(0.9), float(1.7), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow));
  material.colorNode = vec4(ink.rgb.div(max(ink.a, float(1 / 255))).mul(glow), ink.a);
  material.alphaTest = 0.5;
  // a plane: its shadow from either side
  material.shadowSide = THREE.DoubleSide;
  const mesh = new THREE.Mesh(mergeGeometries(parts), material);
  mesh.name = 'TowerSigns';
  mesh.castShadow = true;
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
