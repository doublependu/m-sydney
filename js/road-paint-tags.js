import * as THREE from 'three/webgpu';
import { edgeHeight, groundRoadAt, roadHeight, structureAt, structuresAt } from './surfaces.js';
import { heldTags } from './geodata.js';

// Road paint from OpenStreetMap's tags (js/road-paint.js draws the rest): red bus lanes, green cycle lanes and cycleways,
// zebra crossings, and the words and numbers on the road.

const BUS_RED = new THREE.Color(0x96302a);

// Along a way, its road's edge: a lane `width` wide against the kerb on the left (side 1) or right (side 2) of travel
// The road at (x, z): on the ground, or else the nearest on a bridge (the bus lane over the Harbour Bridge), never in a tunnel
function roadAt(x, z) {
  const ground = groundRoadAt(x, z);
  if (ground) return ground;
  let best = null;
  for (const { sid } of structuresAt(x, z)) {
    const here = structureAt(sid, x, z);
    if (here && here.link.kind === 1 && (!best || here.d < best.d)) best = here;
  }
  return best ? best.link : null;
}
function eachKerbLane(flat, side, width, paint) {
  for (let i = 0; i + 3 < flat.length; i += 2) {
    const ax = flat[i], az = flat[i + 1], bx = flat[i + 2], bz = flat[i + 3];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 2) continue;
    const road = roadAt((ax + bx) / 2, (az + bz) / 2);
    if (!road) continue;
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    // A road of one lane is all that lane
    const off = road.lanes === 1 ? 0 : (road.width / 2 - width / 2 - 0.2) * (side === 1 ? 1 : -1);
    // Left of travel is (uz, -ux)
    paint(ax + uz * off, az - ux * off, bx + uz * off, bz - ux * off, road);
  }
}

// What OpenStreetMap says is painted: red bus lanes, green cycle lanes and cycleways, zebra crossings
function paintFromTags(strip, onEdge, WHITE, GREEN) {
  const ROAD_TAGS = heldTags();
  const onRoad = (road, paint) => onEdge(road.sid ? { link: road.id } : null, paint);
  for (const line of ROAD_TAGS.buses) eachKerbLane(line, 1, 3.1, (ax, az, bx, bz, road) => onRoad(road, () => strip(ax, az, bx, bz, 3.1, BUS_RED)));
  for (const [sides, ...line] of ROAD_TAGS.cycles) {
    for (const side of [1, 2]) {
      if (sides & side) eachKerbLane(line, side, 1.5, (ax, az, bx, bz, road) => onRoad(road, () => strip(ax, az, bx, bz, 1.5, GREEN)));
    }
  }
  // A separated cycleway, painted where it runs in or beside a road
  for (const line of ROAD_TAGS.cycleways) {
    for (let i = 0; i + 3 < line.length; i += 2) {
      const mx = (line[i] + line[i + 2]) / 2, mz = (line[i + 1] + line[i + 3]) / 2;
      const road = groundRoadAt(mx, mz);
      if (road) strip(line[i], line[i + 1], line[i + 2], line[i + 3], 2.2, GREEN);
    }
  }
  for (let i = 0; i + 1 < ROAD_TAGS.zebras.length; i += 2) {
    const x = ROAD_TAGS.zebras[i], z = ROAD_TAGS.zebras[i + 1];
    const road = groundRoadAt(x, z);
    if (!road) continue;
    let best = null;
    for (let k = 1; k < road.pts.length; k++) {
      const p = road.pts[k - 1], q = road.pts[k], L = Math.hypot(q.x - p.x, q.z - p.z) || 1;
      const t = Math.max(0, Math.min(L, ((x - p.x) * (q.x - p.x) + (z - p.z) * (q.z - p.z)) / L));
      const d = Math.hypot(p.x + ((q.x - p.x) * t) / L - x, p.z + ((q.z - p.z) * t) / L - z);
      if (!best || d < best.d) best = { d, ux: (q.x - p.x) / L, uz: (q.z - p.z) / L, cx: p.x + ((q.x - p.x) * t) / L, cz: p.z + ((q.z - p.z) * t) / L };
    }
    if (!best) continue;
    const half = road.width / 2 - 0.3;
    // White bars along the traffic's way, side by side across the road
    for (let o = -half + 0.3; o <= half - 0.3; o += 1.1) {
      const sx = best.cx - best.uz * o, sz = best.cz + best.ux * o;
      strip(sx - best.ux * 1.6, sz - best.uz * 1.6, sx + best.ux * 1.6, sz + best.uz * 1.6, 0.55, WHITE);
    }
  }
}

// Words and numbers painted on the road: BUS LANE along a bus lane, the speed limit near the start of a stretch
function addRoadWords(group) {
  const ROAD_TAGS = heldTags();
  if (typeof document === 'undefined') return;
  const WORDS = ['BUS LANE', '40', '50', '60', '70', '80'];
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 64 * WORDS.length;
  const c = canvas.getContext('2d');
  c.fillStyle = '#fff';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.font = '800 56px Arial, sans-serif';
  WORDS.forEach((w, i) => c.fillText(w, 256, i * 64 + 32, 500));
  const map = new THREE.CanvasTexture(canvas);
  map.anisotropy = 8;
  const positions = [], uvs = [], index = [];
  const word = (w, x, z, ux, uz, along, across) => {
    const row = WORDS.indexOf(w);
    if (row < 0) return;
    const road = groundRoadAt(x, z);
    const y = (road ? roadHeight(road, x, z) : edgeHeight(null, x, z)) + 0.02;
    const k = positions.length / 3;
    // The text reads from a driver's seat coming along (ux, uz): its top is further away
    for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      positions.push(x + (a * across * uz) / 2 + (b * along * ux) / 2, y, z - (a * across * ux) / 2 + (b * along * uz) / 2);
      uvs.push((a + 1) / 2, 1 - (row + (1 - b) / 2) / WORDS.length);
    }
    index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
  };
  for (const line of ROAD_TAGS.buses) {
    let carried = 30;
    eachKerbLane(line, 1, 3.1, (ax, az, bx, bz) => {
      const L = Math.hypot(bx - ax, bz - az);
      for (let d = carried; d < L; d += 70) word('BUS LANE', ax + ((bx - ax) * d) / L, az + ((bz - az) * d) / L, (bx - ax) / L, (bz - az) / L, 1.6, 2.7);
      carried = Math.max(0, carried - L);
    });
  }
  for (const [speed, x, z, ux, uz, oneWay] of ROAD_TAGS.speeds) {
    const road = groundRoadAt(x, z);
    if (!road) continue;
    // In the lane on the left of travel
    const off = oneWay ? 0 : Math.max(1.8, road.width / 4);
    word(String(speed), x + uz * off, z - ux * off, ux, uz, 3.2, 1.8);
  }
  if (!index.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardNodeMaterial({ map, transparent: true, depthWrite: false, roughness: 0.8, color: 0xe6e2d6 }));
  mesh.name = 'RoadWords';
  mesh.userData.ownMaterial = true;
  mesh.userData.lifted = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

export { addRoadWords, paintFromTags };
