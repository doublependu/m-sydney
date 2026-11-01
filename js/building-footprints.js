import * as THREE from 'three/webgpu';
import { WALL_KINDS } from './tsl-materials.js';
import { polygonContains } from './building-collision.js';

function partyWallHeight(record, a, b, neighbours) {
  const dx = b.x - a.x, dz = b.y - a.y, length = Math.hypot(dx, dz);
  let height = 0;
  // Sample along the wall so a single touching corner does not blank the entire facade.
  for (const t of [0.15, 0.5, 0.85]) {
    const x = a.x + dx * t - dz / length, z = a.y + dz * t + dx / length;
    let roof = 0;
    for (const n of neighbours) {
      if (n.polygons === record.polygons || n.height <= 0 ||
        x < n.x0 || x > n.x1 || z < n.z0 || z > n.z1) continue;
      if (n.polygons.some(p => polygonContains(p, x, z))) roof = Math.max(roof, n.height);
    }
    if (!roof) return 0;
    height = Math.max(height, roof);
  }
  return height;
}

// One merged facade/roof mesh per 1 km cell. Explicit wall coordinates keep window bays metre-sized on any angle.
// A hipped roof over a simple footprint: the walls' top ring drawn in towards a ridge line. Terracotta or slate by seed.
function addPitchedRoof(roofs, ring, top, seed) {
  const n = ring.length;
  let area = 0, cx = 0, cz = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
    cx += ring[i].x;
    cz += ring[i].y;
  }
  area = Math.abs(area / 2);
  if (n > 14 || area < 25 || area > 900) return false;
  cx /= n;
  cz /= n;
  // Longest edge sets the ridge
  let best = 0, ux = 1, uz = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L > best) { best = L; ux = (b.x - a.x) / L; uz = (b.y - a.y) / L; }
  }
  let lo = Infinity, hi = -Infinity, wide = 0;
  for (const p of ring) {
    const u = (p.x - cx) * ux + (p.y - cz) * uz, v = -(p.x - cx) * uz + (p.y - cz) * ux;
    lo = Math.min(lo, u); hi = Math.max(hi, u); wide = Math.max(wide, Math.abs(v));
  }
  const rise = Math.min(3.4, wide * 0.55);
  const inset = Math.min(wide, (hi - lo) * 0.3);
  const a = { x: cx + ux * (lo + inset), z: cz + uz * (lo + inset) }, b = { x: cx + ux * (hi - inset), z: cz + uz * (hi - inset) };
  const list = seed % 3 < 2 ? roofs.tile : roofs.slate;
  for (let i = 0; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    // Each wall's slope climbs to whichever end of the ridge lies nearer
    const mid = ((p.x + q.x) / 2 - cx) * ux + ((p.y + q.y) / 2 - cz) * uz;
    const r = mid < (lo + hi) / 2 ? a : b;
    list.push(p.x, top, p.y, q.x, top, q.y, r.x, top + rise, r.z);
  }
  list.push(a.x, top + rise, a.z, b.x, top + rise, b.z, b.x, top + rise, b.z);
  return true;
}

function* createBuildingFootprintsSteps(material, records, getNeighbours, plinthMaterial = null, roofMaterials = null) {
  const roofs = { tile: [], slate: [] };
  const cells = new Map();
  const plinths = []; // walls running down to the street where the ground falls away: ax, az, bx, bz, top, bottom, nx, nz
  for (const [index, record] of records.entries()) {
    yield;
    if (!(record.height > 0)) continue;
    const key = Math.floor(record.cx / 1000) + ',' + Math.floor(record.cz / 1000);
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { positions: [], normals: [], indices: [], boxes: [], walls: [] }));
    const height = record.height, base = (record.base ?? 0) + 0.22, top = height + base;
    const seed = Math.floor(record.seed ?? index * 29) % 1000 + 0.1 + 0.8 * (record.tone ?? 0.5);
    const neighbours = getNeighbours && height <= 60 ? getNeighbours(record) : [];

    for (const polygon of record.polygons) {
      const rings = [polygon.outer, ...(polygon.holes || [])].map((ring, i) => {
        const points = ring.map(p => new THREE.Vector2(p.x, p.z));
        if (points.length > 1 && points[0].equals(points[points.length - 1])) points.pop();
        // Clockwise outer walls face away from the building; courtyard walls face into their holes.
        if (THREE.ShapeUtils.isClockWise(points) !== (i === 0)) points.reverse();
        return points;
      });
      if (rings[0].length < 3) continue;
      rings.forEach((ring, i) => {
        for (let j = 0; j < ring.length; j++) {
          const a = ring[j], b = ring[(j + 1) % ring.length];
          const dx = b.x - a.x, dz = b.y - a.y, width = Math.hypot(dx, dz);
          if (width === 0) continue;
          const offset = cell.positions.length / 3;
          const adjacentHeight = !i && neighbours.length ? partyWallHeight(record, a, b, neighbours) : 0;
          const kind = i ? WALL_KINDS.rear : adjacentHeight ? WALL_KINDS.lotLine
            : record.storefronts ? WALL_KINDS.shop : WALL_KINDS.front;
          const exposedHeight = adjacentHeight ? Math.max(0, height + 0.22 - adjacentHeight) : height;
          // Match the positive-world-axis tangent used by the shared interior-map view ray.
          const reverse = (Math.abs(dz) >= Math.abs(dx) ? dz : dx) < 0;
          cell.positions.push(a.x, base, a.y, b.x, base, b.y, a.x, top, a.y, b.x, top, b.y);
          if (record.plinth > 0.1 && !i) plinths.push(a.x, a.y, b.x, b.y, base, base - record.plinth, -dz / width, dx / width);
          for (let k = 0; k < 4; k++) {
            cell.normals.push(-dz / width, 0, dx / width);
            // Footprint walls use the box's unused depth for the exposed height above adjoining roofs.
            cell.boxes.push(width, height, exposedHeight, seed);
            cell.walls.push(reverse ? 1 - k % 2 : k % 2, k < 2 ? height : 0, kind);
          }
          cell.indices.push(offset, offset + 1, offset + 2, offset + 2, offset + 1, offset + 3);
        }
      });
      if (record.pitched && roofMaterials && rings.length === 1 && addPitchedRoof(roofs, rings[0], top, Math.floor(seed))) continue;
      const triangles = THREE.ShapeUtils.triangulateShape(rings[0], rings.slice(1));
      const points = rings.flat(), offset = cell.positions.length / 3;
      for (const p of points) {
        cell.positions.push(p.x, top, p.y);
        cell.normals.push(0, 1, 0);
        cell.boxes.push(1, height, height, seed);
        cell.walls.push(0, 0, WALL_KINDS.front);
      }
      for (const [a, b, c] of triangles) cell.indices.push(offset + a, offset + c, offset + b);
    }
  }

  const group = new THREE.Group();
  group.name = 'SurveyedBuildings';
  let first;
  for (const cell of cells.values()) {
    yield;
    if (cell.indices.length === 0) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(cell.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(cell.normals, 3));
    geometry.setAttribute('box', new THREE.Float32BufferAttribute(cell.boxes, 4));
    geometry.setAttribute('facadeWall', new THREE.Float32BufferAttribute(cell.walls, 3));
    geometry.setIndex(cell.indices);
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'SurveyedBuildingChunk';
    mesh.userData.lifted = true;
    mesh.castShadow = mesh.receiveShadow = true;
    // Most cells are too small for scene-culling.js to pick them as big casters on its own: opt in to its stand-ins.
    mesh.userData.shadowStandIn = true;
    if (first) mesh.userData.sharesPipelineWith = first;
    else first = mesh;
    group.add(mesh);
  }
  for (const [list, roofMaterial] of roofMaterials ? [[roofs.tile, roofMaterials[0]], [roofs.slate, roofMaterials[1]]] : []) {
    if (!list.length) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(list, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, roofMaterial);
    mesh.name = 'PitchedRoofs';
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.lifted = true;
    group.add(mesh);
  }
  // On a slope each building sits level on a stone base
  if (plinthMaterial && plinths.length) {
    const positions = [], normals = [], indices = [];
    for (let i = 0; i < plinths.length; i += 8) {
      const [ax, az, bx, bz, topY, bottomY, nx, nz] = plinths.slice(i, i + 8);
      const offset = positions.length / 3;
      positions.push(ax, bottomY, az, bx, bottomY, bz, ax, topY, az, bx, topY, bz);
      for (let k = 0; k < 4; k++) normals.push(nx, 0, nz);
      indices.push(offset, offset + 1, offset + 2, offset + 2, offset + 1, offset + 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, plinthMaterial);
    mesh.name = 'BuildingPlinths';
    mesh.userData.lifted = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

function createBuildingFootprints(material, records, getNeighbours) {
  const job = createBuildingFootprintsSteps(material, records, getNeighbours);
  let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
}

export { createBuildingFootprints, createBuildingFootprintsSteps };
