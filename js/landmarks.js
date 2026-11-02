import * as THREE from 'three/webgpu';
import { color, float, fract, fwidth, mix, smoothstep, texture, uv } from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LANDMARK_SITES } from './city-config.js';
import { groundHeight } from './surfaces.js';
import { buildHarbourBridge, harbourBridgeColliders } from './harbour-bridge.js';
import { createRoadSurfaceMaterial } from './tsl-materials.js';
import { TOWER_SIGNS, placeTowerSign } from './tower-signs.js';

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

// A curved triangle a, b, c on a sphere of `radius` through them, bulging towards `outward`. Its edges are great circles,
// as the real shells' are. uv: 0 at a, (1, 0) at b, (0, 1) at c.
function shellPatch(a, b, c, radius, outward, steps = 20) {
  const ab = new THREE.Vector3().subVectors(b, a), ac = new THREE.Vector3().subVectors(c, a);
  const n = new THREE.Vector3().crossVectors(ab, ac);
  // Circumcentre of the triangle
  const o = a.clone().add(
    new THREE.Vector3().crossVectors(n, ab).multiplyScalar(ac.lengthSq())
      .add(new THREE.Vector3().crossVectors(ac, n).multiplyScalar(ab.lengthSq()))
      .divideScalar(2 * n.lengthSq())
  );
  const circle = o.distanceTo(a);
  const depth = Math.sqrt(Math.max(radius * radius - circle * circle, 1));
  const flip = n.dot(outward) < 0;
  const centre = o.clone().addScaledVector(n.clone().normalize(), flip ? depth : -depth);
  const R = a.distanceTo(centre);
  const positions = [], normals = [], uvs = [], index = [];
  const pointAt = (u, v) => {
    const q = new THREE.Vector3().addScaledVector(a, 1 - u - v).addScaledVector(b, u).addScaledVector(c, v).sub(centre).normalize();
    return { normal: q.clone(), position: q.multiplyScalar(R).add(centre) };
  };
  const row = [];
  for (let i = 0; i <= steps; i++) {
    row.push(positions.length / 3);
    for (let j = 0; j <= steps - i; j++) {
      const { normal, position } = pointAt(i / steps, j / steps);
      normals.push(normal.x, normal.y, normal.z);
      positions.push(position.x, position.y, position.z);
      uvs.push(i / steps, j / steps);
    }
  }
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps - i; j++) {
      const q = row[i] + j, r = row[i + 1] + j;
      // Outward faces wind counter-clockwise, whichever way round a, b, c came
      if (flip) { index.push(q, q + 1, r); if (j < steps - i - 1) index.push(q + 1, r + 1, r); }
      else { index.push(q, r, q + 1); if (j < steps - i - 1) index.push(q + 1, r, r + 1); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  return { geometry: g, pointAt };
}

// The Sydney Opera House, laid out from the footprint in the map and the side view in the reference photos. Every shell
// is cut from a sphere of about 75 m radius, Utzon's solution: a pair of mirrored curved triangles meeting along a ridge.
const OPERA = {
  radius: 75,
  podium: 14, // m above the harbour
  outline: [[457, -1829], [457, -1821], [455, -1808], [453, -1789], [453, -1783], [457, -1782], [486, -1780], [486, -1815], [548, -1815],
    [552, -1808], [553, -1820], [559, -1881], [567, -1895], [569, -1925], [566, -1928], [562, -1930], [557, -1932], [552, -1933], [547, -1935],
    [541, -1935], [533, -1935], [521, -1913], [516, -1914], [514, -1920], [512, -1927], [516, -1928], [514, -1937], [512, -1943], [510, -1947],
    [502, -1948], [492, -1949], [485, -1949], [479, -1948], [472, -1947], [467, -1945], [460, -1943], [456, -1941], [455, -1932], [454, -1922],
    [460, -1922], [459, -1915], [458, -1903], [461, -1894], [463, -1888], [462, -1878], [460, -1857], [458, -1834]],
  steps: { x0: 486, x1: 548, z0: -1815, z1: -1775, count: 26 },
  // Each hall runs north from its origin. s: metres along it. Each shell: its tip, the feet of its arch and of its ridge
  halls: [
    { x: 497, z: -1822, yaw: -0.1, scale: 1, shells: [
      // The Concert Hall, from the side photo. The first faces the steps, the rest the harbour, each nested in the next.
      // A shell's tip overhangs far ahead of its feet.
      { tip: 8, height: 38.5, foot: 18, span: 22, ridge: 46, faces: -1 },
      { tip: 75, height: 67, foot: 52, span: 28, ridge: 25, faces: 1 },
      { tip: 91, height: 54, foot: 72, span: 25, ridge: 46, faces: 1 },
      { tip: 113, height: 45, foot: 90, span: 21, ridge: 66, faces: 1 },
      { tip: 118, height: 35, foot: 108, span: 13, ridge: 88, faces: 1 }
    ] },
    { x: 525, z: -1825, yaw: 0.3, scale: 0.9, shells: [
      // The Joan Sutherland Theatre, a little smaller
      { tip: 6, height: 34, foot: 15, span: 20, ridge: 40, faces: -1 },
      { tip: 68, height: 58, foot: 47, span: 25, ridge: 23, faces: 1 },
      { tip: 83, height: 48, foot: 65, span: 22, ridge: 42, faces: 1 },
      { tip: 103, height: 41, foot: 82, span: 19, ridge: 60, faces: 1 },
      { tip: 107, height: 31, foot: 98, span: 12, ridge: 80, faces: 1 }
    ] },
    { x: 474, z: -1810, yaw: -0.1, scale: 1, shells: [
      // The Bennelong restaurant, its two pairs back to back
      { tip: 18, height: 30, foot: 8, span: 12, ridge: -4, faces: 1 },
      { tip: -18, height: 30, foot: -8, span: 12, ridge: 4, faces: -1 }
    ] }
  ]
};

function buildOperaHouse(group, colliders) {
  const { outline, podium, steps } = OPERA;
  const ground = groundHeight(steps.x0, steps.z1);

  // The shells. Outside: white and cream tiles in chevrons, with a band of bare concrete rib along the arch. Under them:
  // concrete ribs fanning from the foot of the arch.
  const tile = new THREE.MeshStandardNodeMaterial({ roughness: 0.34, metalness: 0.02 });
  const tileUv = uv().mul(46);
  const zig = fract(tileUv.x).sub(0.5).abs().mul(2);
  const lines = fract(tileUv.y.add(zig));
  const across = fwidth(tileUv.y).add(fwidth(tileUv.x));
  const chevrons = smoothstep(0.08, 0.14, lines).mul(float(1).sub(smoothstep(0.86, 0.92, lines)));
  const faded = mix(chevrons, float(0.8), smoothstep(0.25, 0.7, across));
  const lids = mix(color(0xcfc5ac), color(0xf5f2e8), faded);
  const rib = float(1).sub(smoothstep(0.012, 0.022, uv().x)); // the arch's edge: uv's x is 0 from the tip to the arch's foot
  tile.colorNode = mix(lids, color(0xd8cbb0), rib);
  tile.emissiveNode = color(0xfff4e0).mul(smoothstep(0.55, 1.2, cityUniforms.uInteriorGlow).mul(0.75));
  const underside = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, side: THREE.BackSide });
  // Rays from the arch's foot, where uv is (0, 1)
  const fan = uv().x.div(float(1).sub(uv().y).max(0.001)).mul(20);
  underside.colorNode = mix(color(0x9c8f7a), color(0xc9bea6), smoothstep(0.1, 0.25, fract(fan).sub(0.5).abs()));
  underside.emissiveNode = color(0xffcf96).mul(smoothstep(0.55, 1.2, cityUniforms.uInteriorGlow).mul(0.35));
  const glass = new THREE.MeshStandardNodeMaterial({ color: 0x75674f, roughness: 0.2, metalness: 0.25, side: THREE.DoubleSide });
  glass.emissiveNode = color(0xffbc70).mul(smoothstep(0.55, 1.2, cityUniforms.uInteriorGlow).mul(0.6));

  const parts = [], glazing = [];
  const footY = podium - 8; // well under the podium's top, since a shell's lower edge bows up between its feet
  for (const hall of OPERA.halls) {
    const ux = Math.sin(hall.yaw), uz = -Math.cos(hall.yaw); // north along the hall
    const vx = -uz, vz = ux; // east across it
    const at = (s, v, y) => new THREE.Vector3(hall.x + ux * s + vx * v, y, hall.z + uz * s + vz * v);
    for (const { tip, height, foot, span, ridge, faces } of hall.shells) {
      const T = at(tip, 0, height), R = at(ridge, 0, footY);
      const rim = [];
      for (const side of [-1, 1]) {
        const F = at(foot, side * span, footY);
        // Outward: to its own side, up, and away from the way it opens
        const out = new THREE.Vector3(vx * side - ux * faces * 0.6, 0.7, vz * side - uz * faces * 0.6);
        const patch = shellPatch(T, R, F, OPERA.radius, out);
        parts.push(patch.geometry);
        // The arch's edge, for the glass under it
        const edge = [];
        for (let k = 0; k <= 12; k++) edge.push(patch.pointAt(0, k / 12).position);
        rim.push(side < 0 ? edge.reverse() : edge);
      }
      // A wall of bronze glass set well back under the arch, up to about half its height: the ribs fill the rest
      const back = new THREE.Vector3(-ux * faces * 7, 0, -uz * faces * 7);
      const ceiling = podium + (height - podium) * 0.42;
      const points = [...rim[0], ...rim[1].slice(1)].map((p) => {
        const q = p.clone().add(back);
        q.y = Math.min(q.y, ceiling);
        return q;
      });
      const base = at(foot - faces * 7, 0, footY);
      const position = [base.x, base.y, base.z, ...points.flatMap((p) => [p.x, p.y, p.z])];
      const index = [];
      for (let k = 1; k < points.length; k++) index.push(0, k, k + 1);
      const wall = new THREE.BufferGeometry();
      wall.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
      wall.setIndex(index);
      wall.computeVertexNormals();
      glazing.push(wall);
    }
  }
  const shells = mergeGeometries(parts, false);
  group.add(settle(new THREE.Mesh(shells, tile)));
  group.add(settle(new THREE.Mesh(shells, underside), false));
  const glazed = settle(new THREE.Mesh(mergeGeometries(glazing, false), glass), false);
  glazed.receiveShadow = false;
  group.add(glazed);

  // The podium in pink-brown granite, on the footprint in the map, with its strip of dark windows
  const ring = outline.map(([x, z]) => new THREE.Vector2(x, z));
  if (THREE.ShapeUtils.isClockWise(ring)) ring.reverse();
  const wall = (y0, y1, push = 0) => {
    const position = [], normal = [], index = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const L = a.distanceTo(b);
      if (L < 0.01) continue;
      // Not across the head of the steps: that's the stair
      if (Math.abs(a.y - steps.z0) < 1 && Math.abs(b.y - steps.z0) < 1) continue;
      const nx = (b.y - a.y) / L, nz = -(b.x - a.x) / L;
      const k = position.length / 3;
      position.push(a.x + nx * push, y0, a.y + nz * push, b.x + nx * push, y0, b.y + nz * push, a.x + nx * push, y1, a.y + nz * push, b.x + nx * push, y1, b.y + nz * push);
      for (let m = 0; m < 4; m++) normal.push(nx, 0, nz);
      index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
    g.setIndex(index);
    return g;
  };
  const granite = stone(0x7a5e50, 0.8);
  group.add(settle(new THREE.Mesh(wall(-2.5, podium), granite)));
  group.add(settle(new THREE.Mesh(wall(podium * 0.42, podium * 0.56, 0.12), glass), false));
  group.add(settle(new THREE.Mesh(wall(podium * 0.78, podium * 0.84, 0.3), stone(0x70564a, 0.8)), false));
  const faces = THREE.ShapeUtils.triangulateShape(ring, []);
  const top = new THREE.BufferGeometry();
  top.setAttribute('position', new THREE.Float32BufferAttribute(ring.flatMap((p) => [p.x, podium, p.y]), 3));
  top.setAttribute('normal', new THREE.Float32BufferAttribute(ring.flatMap(() => [0, 1, 0]), 3));
  top.setIndex(faces.flatMap(([a, b, c]) => [a, c, b]));
  const paving = stone(0x9a8472, 0.9);
  group.add(settle(new THREE.Mesh(top, paving)));

  // The Monumental Steps, from the forecourt up to the podium
  const treads = [];
  for (let i = 0; i < steps.count; i++) {
    const t0 = i / steps.count, t1 = (i + 1) / steps.count;
    const y1 = ground + (podium - ground) * (1 - t0);
    const z0 = steps.z0 + (steps.z1 - steps.z0) * t0, z1 = steps.z0 + (steps.z1 - steps.z0) * t1;
    const tread = new THREE.BoxGeometry(steps.x1 - steps.x0, y1 - ground + 1.5, z1 - z0);
    tread.translate((steps.x0 + steps.x1) / 2, (y1 + ground - 1.5) / 2, (z0 + z1) / 2);
    treads.push(tread);
  }
  group.add(settle(new THREE.Mesh(mergeGeometries(treads, false), paving)));

  // Solid to anyone below its top: the podium, and the stair as a block, since nothing here climbs it yet
  const polygon = { outer: outline.map(([x, z]) => ({ x, z })), holes: [] };
  const xs = outline.map((p) => p[0]), zs = outline.map((p) => p[1]);
  colliders.push({ minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs), minY: 0, maxY: podium - ground, polygon });
  const hx = (steps.x1 - steps.x0) / 2, hz = (steps.z1 - steps.z0) / 2;
  colliders.push({ minX: steps.x0, maxX: steps.x1, minZ: steps.z0, maxZ: steps.z1, minY: 0, maxY: (podium - ground) * 0.5,
    obb: { cx: steps.x0 + hx, cz: steps.z0 + hz, hx, hz, cs: 1, sn: 0 } });
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
  buildOperaHouse(group, colliders);
  buildSydneyTower(group);
  buildHeritage(group);
  buildLunaPark(group);
  harbourBridgeColliders(colliders);
  scene.add(group);
  return { group, colliders };
}

/** Just where the landmarks stand, for making the tiles: the buildings they replace (tools/tiles/derive.mjs) */
function landmarkColliders() {
  const colliders = [];
  buildOperaHouse(new THREE.Group(), colliders);
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
