import * as THREE from 'three/webgpu';
import { Fn, attribute, color, cameraPosition, float, floor, fract, fwidth, length, mix, positionWorld, sin, smoothstep, step, vec2, dot } from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';
import { patternXZ } from './world-origin.js';

// The far model of a building: up to six points and a height, in the plain colours of its facade. Beyond the detail range
// one of these meshes stands in for each 1 km of normal buildings: a fraction of the triangles and far cheaper to shade.

const MAX_POINTS = 6;
// A tower is what the eye goes to: it keeps more of its shape
const TALL = 80;
const TALL_POINTS = 12;

function hull(points) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const half = (list) => {
    const out = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/** A footprint ring as an outline: itself if it's simple, else its hull with the least important corners dropped */
function outlineOf(ring, most = MAX_POINTS) {
  if (ring.length <= most) return ring;
  const out = hull(ring);
  while (out.length > most) {
    let least = Infinity, at = 0;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i + out.length - 1) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const area = Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z));
      if (area < least) { least = area; at = i; }
    }
    out.splice(at, 1);
  }
  return out;
}

let material = null;
function outlineMaterial(hideWhereShown) {
  if (material) return material;
  material = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0.05 });
  material.maskNode = hideWhereShown(attribute('outlineHome', 'vec2'));
  const wall = attribute('outlineColor', 'vec3');
  const isRoof = step(0.5, attribute('normal', 'vec3').y);
  // Storeys and bays, settling to their average once they're too small to see: so the swap from the full model is gentle
  const storey = positionWorld.y.div(3.7), bay = patternXZ.x.add(patternXZ.y).div(5);
  const fade = float(1).sub(smoothstep(0.2, 0.7, fwidth(storey).add(fwidth(bay)))).mul(float(1).sub(isRoof));
  const rows = smoothstep(0.25, 0.35, fract(storey)).mul(float(1).sub(smoothstep(0.75, 0.85, fract(storey))));
  material.colorNode = wall.mul(mix(float(1), float(0.72).add(rows.mul(0.4)), fade));
  // After dark, a scattering of lit windows, one bay by one storey each
  const cell = vec2(floor(bay), floor(storey));
  const lit = step(0.72, fract(sin(dot(cell, vec2(12.9898, 78.233))).mul(43758.5)));
  const far = smoothstep(0.2, 0.7, fwidth(storey).add(fwidth(bay)));
  const windows = mix(lit.mul(rows), float(0.2), far).mul(float(1).sub(isRoof));
  material.emissiveNode = color(0xffd8a0).mul(windows).mul(smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow)).mul(0.55);
  return material;
}

/**
 * One mesh for a list of far records (js/tiles/tile-file.js): { rings, height, bottom, floor, low, wall: Color, roof: Color,
 * ix, iz }. Every vertex knows its building's tile: the mesh's material leaves out buildings whose tile is drawn in full.
 */
function* outlineMesh(records, hideWhereShown) {
  const position = [], normal = [], colors = [], homes = [], index = [];
  for (const [n, r] of records.entries()) {
    if (n % 24 === 0) yield;
    const floorY = r.floor + 0.22, top = floorY + r.height;
    const bottom = r.bottom ? floorY + r.bottom : r.low - 0.3;
    for (const ring of r.rings) {
      if (ring.length < 3) continue;
      const points = ring.map((p) => new THREE.Vector2(p.x, p.z));
      if (THREE.ShapeUtils.isClockWise(points)) points.reverse();
      for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        const L = a.distanceTo(b);
        if (L < 0.01) continue;
        const nx = (b.y - a.y) / L, nz = -(b.x - a.x) / L;
        const k = position.length / 3;
        position.push(a.x, bottom, a.y, b.x, bottom, b.y, a.x, top, a.y, b.x, top, b.y);
        for (let m = 0; m < 4; m++) {
          normal.push(nx, 0, nz);
          colors.push(r.wall.r, r.wall.g, r.wall.b);
          homes.push(r.ix, r.iz);
        }
        index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
      }
      const k = position.length / 3;
      for (const p of points) {
        position.push(p.x, top, p.y);
        normal.push(0, 1, 0);
        colors.push(r.roof.r, r.roof.g, r.roof.b);
        homes.push(r.ix, r.iz);
      }
      for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(points, [])) index.push(k + a, k + c, k + b);
    }
  }
  if (!index.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute('outlineColor', new THREE.Float32BufferAttribute(colors, 3));
  g.setAttribute('outlineHome', new THREE.Float32BufferAttribute(homes, 2));
  g.setIndex(index);
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, outlineMaterial(hideWhereShown));
  mesh.name = 'BuildingOutlines';
  mesh.userData.lifted = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

export { MAX_POINTS, TALL, TALL_POINTS, outlineMaterial, outlineMesh, outlineOf };
