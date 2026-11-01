import * as THREE from 'three/webgpu';
import { GEO } from './geodata.js';
import { CITY_BOUNDS, DRIVE_SIDE } from './city-config.js';
import { terrainHeight } from './terrain.js';

// What keeps the harbour and George St alive: ferries on their real routes, and the light rail. They run on a clock
// along fixed lines, back and forth, and nothing has to get out of their way.

function lineOf(flat) {
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push({ x: flat[i], z: flat[i + 1], s: 0 });
  for (let i = 1; i < pts.length; i++) pts[i].s = pts[i - 1].s + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return pts;
}

// Where a vehicle is at `time`: out along the line and back, resting `dwell` seconds at each end
function travel(line, time, speed, dwell, out) {
  const L = line[line.length - 1].s, leg = L / speed;
  const t = time % ((leg + dwell) * 2);
  const back = t >= leg + dwell;
  const u = back ? t - leg - dwell : t;
  const s = Math.min(L, u * speed);
  const at = back ? L - s : s;
  let i = 1;
  while (i < line.length - 1 && line[i].s < at) i++;
  const a = line[i - 1], b = line[i], d = (at - a.s) / (b.s - a.s || 1);
  out.x = a.x + (b.x - a.x) * d;
  out.z = a.z + (b.z - a.z) * d;
  out.yaw = Math.atan2(b.x - a.x, b.z - a.z) + (back ? Math.PI : 0);
  return out;
}

function ferryMesh() {
  const hull = new THREE.MeshStandardNodeMaterial({ color: 0x1e5a3c, roughness: 0.5 });
  const cream = new THREE.MeshStandardNodeMaterial({ color: 0xece2c6, roughness: 0.6 });
  const group = new THREE.Group();
  const part = (w, h, d, y, material) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    m.position.y = y;
    m.castShadow = true;
    m.userData.lifted = true;
    group.add(m);
  };
  part(10, 2.2, 42, 0.9, hull);
  part(8.6, 2.6, 34, 3.2, cream);
  part(7.4, 2.4, 22, 5.6, cream);
  part(2.4, 3, 4, 8, hull);
  group.userData.lifted = true;
  return group;
}

function tramMesh() {
  const body = new THREE.MeshStandardNodeMaterial({ color: 0xc8202c, roughness: 0.42, metalness: 0.2 });
  const white = new THREE.MeshStandardNodeMaterial({ color: 0xe9ecef, roughness: 0.5 });
  const glass = new THREE.MeshStandardNodeMaterial({ color: 0x20303c, roughness: 0.15, metalness: 0.6 });
  const group = new THREE.Group();
  const part = (w, h, d, y, material, z = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    m.position.set(0, y, z);
    m.castShadow = true;
    m.userData.lifted = true;
    group.add(m);
  };
  part(2.65, 1.0, 44, 0.75, body);
  part(2.68, 1.3, 42, 1.85, glass);
  part(2.65, 0.5, 44, 2.75, white);
  group.userData.lifted = true;
  return group;
}

function buildMovingScenery(stage) {
  const group = new THREE.Group();
  group.name = 'MovingScenery';
  const movers = [];
  const add = (line, mesh, speed, dwell, phase, side = 0, ground = false) => {
    group.add(mesh);
    movers.push({ line, mesh, speed, dwell, phase, side, ground, at: { x: 0, z: 0, yaw: 0 } });
  };
  for (const [i, flat] of GEO.ferries.entries()) {
    const line = lineOf(flat);
    if (line[line.length - 1].s > 300) add(line, ferryMesh(), 9 + (i % 3), 40, i * 83);
  }
  for (const [i, flat] of GEO.lightRail.entries()) {
    const line = lineOf(flat);
    if (line[line.length - 1].s < 800) continue;
    for (let k = 0; k < 3; k++) add(line, tramMesh(), 8, 30, (k * line[line.length - 1].s) / 8 / 1.5 + i * 37, 1.6 * DRIVE_SIDE, true);
  }
  stage.add(group);
  return {
    group,
    update(elapsed) {
      for (const m of movers) {
        travel(m.line, elapsed + m.phase, m.speed, m.dwell, m.at);
        const { x, z, yaw } = m.at;
        const sx = Math.cos(yaw) * m.side, sz = -Math.sin(yaw) * m.side;
        m.mesh.position.set(x + sx, m.ground ? terrainHeight(x, z) + 0.05 : CITY_BOUNDS.waterLevel, z + sz);
        m.mesh.rotation.y = yaw;
      }
    }
  };
}

export { buildMovingScenery };
