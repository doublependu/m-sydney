import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { groundRoadAt } from './surfaces.js';
import { heldTags } from './geodata.js';

// The signs beside the road, from OpenStreetMap's tags: speed limits, one-way arrows, zebra crossing diamonds and
// motorway direction boards. One texture, one merged mesh per 1 km cell, each on a slim post at the kerb.

const CELLS = ['40', '50', '60', '70', '80', 'ONEWAY', 'ZEBRA', 'P'];
const COLUMNS = 4, ROWS = 2, CELL = 128;

function drawSigns() {
  const canvas = document.createElement('canvas');
  canvas.width = COLUMNS * CELL;
  canvas.height = ROWS * CELL + 256; // the direction boards go in rows below
  const c = canvas.getContext('2d');
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  CELLS.forEach((cell, i) => {
    const x = (i % COLUMNS) * CELL, y = Math.floor(i / COLUMNS) * CELL, m = CELL / 2;
    c.save();
    c.translate(x, y);
    if (/^\d/.test(cell)) {
      c.fillStyle = '#fff'; c.fillRect(0, 0, CELL, CELL);
      c.beginPath(); c.arc(m, m, 54, 0, Math.PI * 2); c.fillStyle = '#d81e28'; c.fill();
      c.beginPath(); c.arc(m, m, 40, 0, Math.PI * 2); c.fillStyle = '#fff'; c.fill();
      c.fillStyle = '#111'; c.font = '800 44px Arial, sans-serif'; c.fillText(cell, m, m + 2);
    } else if (cell === 'ONEWAY') {
      c.fillStyle = '#111'; c.fillRect(0, 0, CELL, CELL);
      c.fillStyle = '#fff'; c.fillRect(10, 44, 90, 40);
      c.beginPath(); c.moveTo(92, 22); c.lineTo(122, 64); c.lineTo(92, 106); c.fill();
      c.fillStyle = '#111'; c.font = '800 20px Arial, sans-serif'; c.fillText('ONE WAY', 56, 66);
    } else if (cell === 'ZEBRA') {
      c.fillStyle = '#f5c518'; c.fillRect(0, 0, CELL, CELL);
      c.strokeStyle = '#111'; c.lineWidth = 6; c.strokeRect(8, 8, CELL - 16, CELL - 16);
      c.fillStyle = '#111'; c.beginPath(); c.arc(m, 40, 10, 0, Math.PI * 2); c.fill();
      c.fillRect(m - 6, 50, 12, 34);
      c.fillRect(m - 20, 84, 40, 8);
    } else {
      c.fillStyle = '#1763b5'; c.fillRect(0, 0, CELL, CELL);
      c.fillStyle = '#fff'; c.font = '800 88px Arial, sans-serif'; c.fillText('P', m, m + 4);
    }
    c.restore();
  });
  return canvas;
}

const KERB = 0.7; // m back from the road's edge

function* buildRoadSigns(group, { dummy, isOnCurbIsland, addPole, isClearOfPoles, poleMatrices }) {
  const ROAD_TAGS = heldTags();
  if (typeof document === 'undefined') return;
  const canvas = drawSigns();
  const c = canvas.getContext('2d');
  const H = canvas.height, W = canvas.width;
  const uvOf = (i) => [(i % COLUMNS) / COLUMNS, Math.floor(i / COLUMNS) * CELL / H, (i % COLUMNS + 1) / COLUMNS, (Math.floor(i / COLUMNS) + 1) * CELL / H];
  const parts = new Map();
  // A flat panel facing back along (ux, uz) at height y, with this box of the canvas on it: u0, v0, u1, v1, top down
  const panel = (x, y, z, ux, uz, w, h, [u0, v0, u1, v1], rotate = 0) => {
    const g = new THREE.PlaneGeometry(w, h);
    const coords = g.attributes.uv;
    for (let k = 0; k < coords.count; k++) {
      coords.setXY(k, coords.getX(k) > 0.5 ? u1 : u0, coords.getY(k) > 0.5 ? 1 - v0 : 1 - v1);
    }
    if (rotate) g.rotateZ(rotate);
    g.rotateY(Math.atan2(-ux, -uz)).translate(x, y, z);
    const key = `${Math.floor(x / 1000)},${Math.floor(z / 1000)}`;
    if (!parts.has(key)) parts.set(key, []);
    parts.get(key).push(g);
  };
  // Where a sign stands for a road at (x, z): on the footpath at the left kerb of travel
  const atKerb = (x, z, ux, uz, oneWay = false) => {
    const road = groundRoadAt(x, z);
    if (!road) return null;
    const out = road.width / 2 + KERB;
    const px = x + uz * out, pz = z - ux * out;
    if (!isOnCurbIsland(px, pz, 0.3) || !isClearOfPoles(px, pz, 1.2)) return null;
    return { x: px, z: pz, oneWay };
  };
  const post = (x, z, height) => {
    addPole(x, z, 0.14);
    dummy.position.set(x, height / 2, z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(0.04, height, 0.04);
    dummy.updateMatrix();
    poleMatrices.push(dummy.matrix.clone());
  };

  for (const [n, [speed, x, z, ux, uz]] of ROAD_TAGS.speeds.entries()) {
    if (n % 40 === 0) yield;
    const cell = CELLS.indexOf(String(speed));
    if (cell < 0) continue;
    const spot = atKerb(x, z, ux, uz);
    if (!spot) continue;
    post(spot.x, spot.z, 2.6);
    panel(spot.x, 2.35, spot.z, ux, uz, 0.6, 0.6, uvOf(cell));
  }
  const oneWayCell = CELLS.indexOf('ONEWAY');
  const ways = ROAD_TAGS.oneways;
  for (let i = 0; i + 3 < ways.length; i += 4) {
    if (i % 160 === 0) yield;
    const x = ways[i], z = ways[i + 1], ux = ways[i + 2], uz = ways[i + 3];
    const spot = atKerb(x, z, ux, uz, true);
    if (!spot) continue;
    post(spot.x, spot.z, 2.6);
    // Across the road, pointing the way it runs, seen from the cross street
    panel(spot.x, 2.4, spot.z, uz, -ux, 0.75, 0.3, uvOf(oneWayCell));
  }
  const zebraCell = CELLS.indexOf('ZEBRA');
  const zebras = ROAD_TAGS.zebras;
  for (let i = 0; i + 1 < zebras.length; i += 2) {
    if (i % 80 === 0) yield;
    const x = zebras[i], z = zebras[i + 1];
    const road = groundRoadAt(x, z);
    if (!road) continue;
    const p = road.pts[0], q = road.pts[road.pts.length - 1];
    const L = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    const ux = (q.x - p.x) / L, uz = (q.z - p.z) / L;
    for (const side of [1, -1]) {
      const spot = atKerb(x, z, ux * side, uz * side);
      if (!spot) continue;
      post(spot.x, spot.z, 2.9);
      panel(spot.x, 2.55, spot.z, ux * side, uz * side, 0.72, 0.72, uvOf(zebraCell), Math.PI / 4);
    }
  }
  // Blue parking signs on the CBD's kerbs, about one a block
  const parkingCell = CELLS.indexOf('P');
  for (let i = 0; i + 3 < ways.length; i += 12) {
    const x = ways[i], z = ways[i + 1], ux = ways[i + 2], uz = ways[i + 3];
    if (x < -450 || x > 1000 || z < -1500 || z > 1100) continue;
    const spot = atKerb(x + ux * 18, z + uz * 18, ux, uz);
    if (!spot) continue;
    post(spot.x, spot.z, 2.5);
    panel(spot.x, 2.3, spot.z, ux, uz, 0.4, 0.4, uvOf(parkingCell));
  }
  // Green motorway boards, on two tall posts, with where the road goes
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const BOARDS = 8, boardTop = ROWS * CELL, boardH = 256 / BOARDS;
  const seen = new Map();
  for (const [text, x, z, ux, uz] of ROAD_TAGS.directions) {
    const row = seen.get(text) ?? (seen.size < BOARDS ? seen.size : -1);
    if (row < 0) continue;
    if (!seen.has(text)) {
      seen.set(text, row);
      c.fillStyle = '#0f5f35';
      c.fillRect(0, boardTop + row * boardH, W, boardH);
      c.strokeStyle = '#fff';
      c.lineWidth = 2;
      c.strokeRect(2, boardTop + row * boardH + 2, W - 4, boardH - 4);
      c.fillStyle = '#fff';
      c.font = '700 20px Arial, sans-serif';
      c.fillText(text, W / 2, boardTop + row * boardH + boardH / 2 + 1, W - 12);
    }
    const road = groundRoadAt(x, z);
    const out = (road ? road.width / 2 : 5) + 2;
    const px = x + uz * out, pz = z - ux * out;
    if (!isClearOfPoles(px, pz, 2)) continue;
    post(px - ux * 0, pz, 5);
    panel(px, 4.4, pz, ux, uz, 6.4, 1.4, [0, (boardTop + row * boardH) / H, 1, (boardTop + (row + 1) * boardH) / H]);
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const material = new THREE.MeshBasicNodeMaterial({ map, side: THREE.DoubleSide });
  for (const list of parts.values()) {
    yield;
    const mesh = new THREE.Mesh(mergeGeometries(list, false), material);
    mesh.name = 'RoadSigns';
    mesh.userData.cullDistance = 400;
    mesh.userData.ownMaterial = true; // the boards it draws depend on what's near
    group.add(mesh);
  }
}

export { buildRoadSigns };
