import * as THREE from 'three/webgpu';
import { Fn, attribute, color, cameraPosition, float, floor, fract, fwidth, length, mix, positionWorld, sin, smoothstep, step, vec2, dot } from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';
import { patternXZ } from './world-origin.js';

// The far model of a building: up to six points and a height, in the plain colours of its facade. Beyond the detail range
// one of these meshes stands in for each 1 km of normal buildings: a fraction of the triangles and far cheaper to shade.

const MAX_POINTS = 6;
// Each vertex holds its building's tile as two bytes, ix and iz from -128 to 127 km
const HOME_OFFSET = 128;
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
  // No normals stored: a flat face's own slope gives it, and the colour's fourth byte says which faces are roofs
  material = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0.05, flatShading: true });
  material.maskNode = hideWhereShown(attribute('outlineHome', 'vec2').mul(255).round().sub(HOME_OFFSET));
  const packed = attribute('outlineColor', 'vec4');
  const wall = packed.xyz;
  const isRoof = step(0.5, packed.w);
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
  // Bytes a vertex: 12 for where it is, 4 for its colour and whether it's a roof, 2 (4 on the GPU) for its tile. Written straight
  // into arrays of the right size, counted first: a square of the far level is a few hundred thousand vertices, and building them
  // as lists of numbers first would leave tens of megabytes behind for the garbage collector, every square, while flying
  const outlines = [];
  let vertices = 0, indices = 0;
  for (const [n, r] of records.entries()) {
    if (n % 48 === 0) yield;
    for (const ring of r.rings) {
      if (ring.length < 3) continue;
      const points = ring.map((p) => new THREE.Vector2(p.x, p.z));
      if (THREE.ShapeUtils.isClockWise(points)) points.reverse();
      const walls = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        if (a.distanceTo(b) >= 0.01) walls.push(i);
      }
      const roof = THREE.ShapeUtils.triangulateShape(points, []);
      outlines.push({ r, points, walls, roof });
      vertices += walls.length * 4 + points.length;
      indices += walls.length * 6 + roof.length * 3;
    }
  }
  if (!indices) return null;
  const position = new Float32Array(vertices * 3), colors = new Uint8Array(vertices * 4), homes = new Uint8Array(vertices * 2);
  const index = vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  let v = 0, k = 0;
  const vertex = (x, y, z, c, roof, r) => {
    position[v * 3] = x; position[v * 3 + 1] = y; position[v * 3 + 2] = z;
    colors[v * 4] = Math.round(c.r * 255); colors[v * 4 + 1] = Math.round(c.g * 255); colors[v * 4 + 2] = Math.round(c.b * 255); colors[v * 4 + 3] = roof ? 255 : 0;
    homes[v * 2] = r.ix + HOME_OFFSET; homes[v * 2 + 1] = r.iz + HOME_OFFSET;
    return v++;
  };
  for (const [n, { r, points, walls, roof }] of outlines.entries()) {
    if (n % 48 === 0) yield;
    const floorY = r.floor + 0.22, top = floorY + r.height;
    const bottom = r.bottom ? floorY + r.bottom : r.low - 0.3;
    for (const i of walls) {
      const a = points[i], b = points[(i + 1) % points.length];
      const q = vertex(a.x, bottom, a.y, r.wall, false, r);
      vertex(b.x, bottom, b.y, r.wall, false, r);
      vertex(a.x, top, a.y, r.wall, false, r);
      vertex(b.x, top, b.y, r.wall, false, r);
      index[k++] = q; index[k++] = q + 2; index[k++] = q + 1; index[k++] = q + 1; index[k++] = q + 2; index[k++] = q + 3;
    }
    const first = v;
    for (const p of points) vertex(p.x, top, p.y, r.roof, true, r);
    for (const [a, b, c] of roof) { index[k++] = first + a; index[k++] = first + c; index[k++] = first + b; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('outlineColor', new THREE.BufferAttribute(colors, 4, true));
  g.setAttribute('outlineHome', new THREE.BufferAttribute(homes, 2, true));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, outlineMaterial(hideWhereShown));
  mesh.name = 'BuildingOutlines';
  mesh.userData.lifted = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

export { MAX_POINTS, TALL, TALL_POINTS, outlineMaterial, outlineMesh, outlineOf };
