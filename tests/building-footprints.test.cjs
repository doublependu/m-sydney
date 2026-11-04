const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

class Attribute {
  constructor(array, itemSize) { this.array = Float32Array.from(array); this.itemSize = itemSize; }
}
class Geometry {
  constructor() { this.attributes = {}; }
  setAttribute(name, value) { this.attributes[name] = value; }
  setIndex(value) { this.index = value; }
  computeBoundingSphere() { this.bounded = true; }
}
class Mesh {
  constructor(geometry, material) { Object.assign(this, { geometry, material, userData: {} }); }
}
const signedArea = points => points.reduce((sum, p, i) => {
  const next = points[(i + 1) % points.length];
  return sum + p.x * next.y - next.x * p.y;
}, 0) / 2;
let triangulations;
const THREE = {
  Vector2: class {
    constructor(x, y) { Object.assign(this, { x, y }); }
    equals(p) { return this.x === p.x && this.y === p.y; }
  },
  Group: class { constructor() { this.children = []; } add(child) { this.children.push(child); } },
  BufferGeometry: Geometry, Float32BufferAttribute: Attribute, Mesh,
  ShapeUtils: {
    isClockWise: points => signedArea(points) < 0,
    triangulateShape(outer, holes) {
      triangulations.push({ outer, holes });
      // Fixtures are convex; Three's triangulator returns counterclockwise indices, including for clockwise input.
      return holes.length ? [] : Array.from({ length: outer.length - 2 }, (_, i) => [0, i + 2, i + 1]);
    }
  }
};
const collision = loadModule(readFileSync(join(__dirname, '../js/building-collision.js'), 'utf8'));
const { createBuildingFootprints } = loadModule(readFileSync(join(__dirname, '../js/building-footprints.js'), 'utf8'), {
  imports: { 'three/webgpu': THREE, './tsl-materials.js': { WALL_KINDS: { shop: 0, front: 1, rear: 2, lotLine: 3, below: 4 } },
    './building-collision.js': collision }
});
const p = (x, z) => ({ x, z });
const square = (x = 0) => [p(x, 0), p(x + 10, 0), p(x + 10, 10), p(x, 10)];
const record = (outer, extra = {}) => {
  const b = { polygons: [{ outer, holes: [] }], height: 60, seed: 123, tone: 0.75, storefronts: true, ...extra };
  const points = b.polygons.flatMap(p => p.outer);
  b.cx = (Math.min(...points.map(p => p.x)) + Math.max(...points.map(p => p.x))) / 2;
  b.cz = (Math.min(...points.map(p => p.z)) + Math.max(...points.map(p => p.z))) / 2;
  return b;
};
const build = (records, getNeighbours) => { triangulations = []; return createBuildingFootprints({}, records, getNeighbours); };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-5, `${actual} != ${expected}`);

test('arbitrary wall angles preserve dimensions, outward normals and facade attributes', () => {
  const angle = 0.43, c = Math.cos(angle), s = Math.sin(angle);
  const outer = square().map(({ x, z }) => p(x * c - z * s, x * s + z * c));
  const source = record(outer), saved = JSON.stringify(source);
  const mesh = build([source]).children[0], attrs = mesh.geometry.attributes;
  assert.equal(JSON.stringify(source), saved, 'winding normalization must not mutate map geometry');
  const cx = 5 * c - 5 * s, cz = 5 * s + 5 * c;
  for (let i = 0; i < 16; i += 4) {
    const a = attrs.position.array.slice(i * 3, i * 3 + 3);
    const b = attrs.position.array.slice((i + 1) * 3, (i + 1) * 3 + 3);
    const n = attrs.normal.array.slice(i * 3, i * 3 + 3);
    close(Math.hypot(b[0] - a[0], b[2] - a[2]), 10);
    close(a[1], 0.22);
    close(attrs.position.array[(i + 2) * 3 + 1], 60.22);
    assert.ok(n[0] * (a[0] - cx) + n[2] * (a[2] - cz) > 0, 'wall normal faces outside');
    const axis = Math.abs(n[0]) >= Math.abs(n[2]) ? 2 : 0;
    const u0 = attrs.facadeWall.array[i * 3], u1 = attrs.facadeWall.array[(i + 1) * 3];
    assert.ok((b[axis] - a[axis]) * (u1 - u0) > 0, 'window U follows the interior-map tangent');
    for (let j = i; j < i + 4; j++) {
      [10, 60, 60, 123.7].forEach((v, k) => close(attrs.box.array[j * 4 + k], v));
      close(attrs.facadeWall.array[j * 3 + 1], j < i + 2 ? 60 : 0);
    }
  }
  assert.equal(mesh.geometry.index.length, 30, 'eight wall triangles and two roof triangles share one mesh');
  assert.equal(mesh.castShadow, true);
  assert.equal(mesh.receiveShadow, true);
});

test('courtyard walls face the hole and pass the hole to roof triangulation', () => {
  const hole = [p(3, 3), p(7, 3), p(7, 7), p(3, 7)];
  const group = build([record([], { polygons: [{ outer: square().reverse(), holes: [hole.reverse()] }] })]);
  const attrs = group.children[0].geometry.attributes;
  for (let i = 16; i < 32; i++) {
    const x = attrs.position.array[i * 3], z = attrs.position.array[i * 3 + 2];
    const nx = attrs.normal.array[i * 3], nz = attrs.normal.array[i * 3 + 2];
    assert.ok(nx * (5 - x) + nz * (5 - z) > 0, 'courtyard wall normal faces the void');
    assert.equal(attrs.facadeWall.array[i * 3 + 2], 2);
  }
  assert.ok(signedArea(triangulations[0].outer) < 0);
  assert.ok(signedArea(triangulations[0].holes[0]) > 0);
});

test('roof and wall triangle winding matches their normals, including closed rings', () => {
  const outer = square();
  outer.push(outer[0]);
  const mesh = build([record(outer)]).children[0], geometry = mesh.geometry;
  const positions = geometry.attributes.position.array, normals = geometry.attributes.normal.array;
  const indices = geometry.index;
  assert.equal(positions.length / 3, 20, 'four wall quads and four roof corners');
  let roofArea = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const u = [0, 1, 2].map(k => positions[b + k] - positions[a + k]);
    const v = [0, 1, 2].map(k => positions[c + k] - positions[a + k]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    assert.ok(n.reduce((sum, value, k) => sum + value * normals[a + k], 0) > 0);
    if (normals[a + 1] === 1) { roofArea += n[1] / 2; close(positions[a + 1], 60.22); }
  }
  close(roofArea, 100);
});

test('nearby buildings share a merged batch while distant chunks reuse its pipeline', () => {
  const group = build([record(square()), record(square(20)), record(square(2000))]);
  assert.equal(group.children.length, 2);
  const [near, far] = group.children;
  assert.equal(near.geometry.index.length, 60);
  assert.equal(far.geometry.index.length, 30);
  assert.equal(far.userData.sharesPipelineWith, near);
  assert.ok(near.geometry.bounded && far.geometry.bounded);
});

const reserve = b => {
  const points = b.polygons.flatMap(p => p.outer);
  return { polygons: b.polygons, height: b.height + 0.22,
    x0: Math.min(...points.map(p => p.x)), x1: Math.max(...points.map(p => p.x)),
    z0: Math.min(...points.map(p => p.z)), z1: Math.max(...points.map(p => p.z)) };
};
const wallKinds = mesh => Array.from({ length: 4 }, (_, i) => mesh.geometry.attributes.facadeWall.array[i * 12 + 2]);

test('non-retail fronts keep their own treatment without changing courtyards or party walls', () => {
  const b = record(square(), { polygons: [{ outer: square(), holes: [[p(3, 3), p(7, 3), p(7, 7), p(3, 7)]] }] });
  const neighbours = () => [reserve(record(square(10), { height: 12 }))];
  const retail = build([b], neighbours).children[0].geometry;
  const residential = build([{ ...b, storefronts: false }], neighbours).children[0].geometry;
  for (let i = 0; i < 32; i++) {
    const kind = retail.attributes.facadeWall.array[i * 3 + 2];
    assert.equal(residential.attributes.facadeWall.array[i * 3 + 2], kind === 0 ? 1 : kind);
  }
  assert.deepEqual(residential.attributes.position.array, retail.attributes.position.array);
  assert.deepEqual(residential.index, retail.index);
});

test('adjoining masonry walls are blank above lower roofs without adding triangles', () => {
  for (const angle of [0, 0.4]) for (const reversed of [false, true]) {
    const rotate = points => points.map(({ x, z }) => p(x * Math.cos(angle) - z * Math.sin(angle), x * Math.sin(angle) + z * Math.cos(angle)));
    const outer = rotate(square());
    if (reversed) outer.reverse();
    const b = record(outer), neighbour = record(rotate(square(10)), { height: 12 });
    const mesh = build([b], () => [reserve(b), reserve(neighbour)]).children[0];
    assert.equal(wallKinds(mesh).filter(k => k === 3).length, 1);
    assert.equal(wallKinds(mesh).filter(k => k === 0).length, 3);
    const attrs = mesh.geometry.attributes;
    for (let i = 0; i < 16; i++) if (attrs.facadeWall.array[i * 3 + 2] === 3) close(attrs.box.array[i * 4 + 2], 48);
    assert.equal(mesh.geometry.index.length, 30);
  }
});

test('partial contacts and architectural props do not remove street-facing windows', () => {
  const b = record(square());
  const corner = record([p(10, 0), p(20, 0), p(20, 2), p(10, 2)]);
  const prop = { ...reserve(record(square(10))), height: 0 };
  const mesh = build([b], () => [reserve(b), reserve(corner), prop]).children[0];
  assert.deepEqual(wallKinds(mesh), [0, 0, 0, 0]);
  assert.deepEqual(wallKinds(build([b]).children[0]), [0, 0, 0, 0], 'materials without party-wall classification keep their facade');
  const tower = record(square(), { height: 120 });
  assert.deepEqual(wallKinds(build([tower], () => [reserve(record(square(10)))]).children[0]), [0, 0, 0, 0]);
});

test('party-wall sign clearance uses the tallest neighbor and leaves courtyard windows', () => {
  const b = record(square(), { polygons: [{ outer: square(), holes: [[p(3, 3), p(7, 3), p(7, 7), p(3, 7)]] }] });
  const low = record([p(10, 0), p(20, 0), p(20, 5), p(10, 5)], { height: 12 });
  const high = record([p(10, 5), p(20, 5), p(20, 10), p(10, 10)], { height: 24 });
  const court = record([p(3, 3), p(7, 3), p(7, 7), p(3, 7)], { height: 10 });
  const attrs = build([b], () => [reserve(low), reserve(high), reserve(court)]).children[0].geometry.attributes;
  let blankVertices = 0;
  for (let i = 0; i < 16; i++) if (attrs.facadeWall.array[i * 3 + 2] === 3) {
    close(attrs.box.array[i * 4 + 2], 36);
    blankVertices++;
  }
  assert.equal(blankVertices, 4);
  for (let i = 16; i < 32; i++) assert.equal(attrs.facadeWall.array[i * 3 + 2], 2);
});

// On a slope: the walls stand on the ground, and the stone below the floor reaches it
test('a wall on a slope runs from its roof down to the ground, with its floors counted from the floor', () => {
  const slope = (x) => x * 0.2; // from 0 at x = 0 up to 8 at x = 40
  const b = record([p(0, 0), p(40, 0), p(40, 10), p(0, 10)], { height: 12, base: 8 });
  const group = createBuildingFootprints({}, [b], undefined, null, { groundAt: (x) => slope(x) });
  const attrs = group.children[0].geometry.attributes;
  const top = 8.22 + 12;
  let foot = 0, shops = 0, fronts = 0;
  for (let i = 0; i < attrs.position.array.length / 3; i++) {
    const x = attrs.position.array[i * 3], y = attrs.position.array[i * 3 + 1];
    const fromTop = attrs.facadeWall.array[i * 3 + 1], kind = attrs.facadeWall.array[i * 3 + 2];
    if (attrs.normal.array[i * 3 + 1] > 0.5) continue; // the roof
    close(y + fromTop, top); // height on the wall and distance below its top always agree
    if (kind >= 4) {
      if (y < 8.22 - 1e-6) { foot++; close(y, slope(x) - 0.3); }
    } else {
      assert.ok(y >= 8.22 - 1e-6, 'nothing but the stone goes below the floor');
      if (kind === 0) shops++;
      if (kind === 1) fronts++;
    }
  }
  assert.ok(foot > 8, 'the foot of the wall follows the ground');
  assert.ok(shops > 0 && fronts > 0, 'shopfronts only where the wall meets the pavement');
});

test('a storey of windows only fits where the wall stands that far clear of the ground', () => {
  const b = record([p(0, 0), p(40, 0), p(40, 10), p(0, 10)], { height: 12, base: 8 });
  const group = createBuildingFootprints({}, [b], undefined, null, { groundAt: (x) => x * 0.2, storey: { width: 2.5, height: 3.5 } });
  const kinds = Array.from(group.children[0].geometry.attributes.facadeWall.array).filter((_, i) => i % 3 === 2).filter((k) => k >= 4);
  const clear = kinds.map((k) => k - 4);
  assert.ok(Math.max(...clear) > 7 && Math.min(...clear) < 1, `clearances ${Math.min(...clear)} to ${Math.max(...clear)}`);
});

// Plan 4, Phase I: a house's roof, hipped or gabled at its style's pitch, with eaves
test('a pitched roof covers the house and its eaves at its pitch, and a gable end is walled up to it', () => {
  Geometry.prototype.computeVertexNormals ??= function () {};
  const colours = Array.from({ length: 13 }, (_, i) => ({ r: i / 12, g: 0.5, b: 0.25 }));
  const roofs = { material: 'roof', colours };
  const area = (pos) => {
    let sum = 0;
    for (let i = 0; i < pos.length; i += 9) sum += Math.abs((pos[i + 3] - pos[i]) * (pos[i + 8] - pos[i + 2]) - (pos[i + 5] - pos[i + 2]) * (pos[i + 6] - pos[i])) / 2;
    return sum;
  };
  const tan30 = Math.tan(Math.PI / 6);
  for (const gabled of [true, false]) {
    triangulations = [];
    const house = record([p(0, 0), p(12, 0), p(12, 8), p(0, 8)], { height: 3.2, pitched: true, pitch: 30, gabled, eaves: 0.5, roof: 4, storefronts: false });
    const group = createBuildingFootprints({}, [house], undefined, roofs);
    const roof = group.children.find((m) => m.material === 'roof');
    const pos = roof.geometry.attributes.position.array;
    // The footprint grown by the eaves, 13 by 9, all of it under the roof
    close(area(pos), 13 * 9);
    const ys = []; for (let i = 1; i < pos.length; i += 3) ys.push(pos[i]);
    close(Math.max(...ys), 0.22 + 3.2 + 4 * tan30);
    close(Math.min(...ys), 0.22 + 3.2 - 0.5 * tan30);
    const col = roof.geometry.attributes.color.array;
    close(col[0], colours[4].r);
    // No flat roof under it
    const walls = group.children.find((m) => m.material !== 'roof').geometry;
    const normals = walls.attributes.normal.array;
    for (let i = 1; i < normals.length; i += 3) assert.equal(normals[i], 0, 'walls only: the roof is pitched');
    // A gable's walls go up to the ridge at the short ends; a hip's walls stop at the eaves
    const wall = walls.attributes.facadeWall.array;
    const raised = [];
    // Above the wall's top: metres from it below zero
    for (let v = 0; v < wall.length / 3; v++) if (wall[v * 3 + 1] < -0.01) raised.push(walls.attributes.position.array[v * 3 + 1]);
    if (gabled) close(Math.max(...raised), 0.22 + 3.2 + 4 * tan30);
    else assert.equal(raised.length, 0);
  }
});
