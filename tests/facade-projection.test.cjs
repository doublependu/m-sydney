const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Evaluate the production TSL expressions numerically, without a browser or Three dependency.
const f = Math.fround;
const values = (v) => v instanceof Node ? v.values : Array.isArray(v) ? v : [v];
function binary(a, b, op) {
  a = values(a); b = values(b);
  return new Node(Array.from({ length: Math.max(a.length, b.length) }, (_, i) => op(a[i % a.length], b[i % b.length])));
}
class Node {
  constructor(v) { this.values = values(v).map(f); }
  get x() { return new Node(this.values[0]); }
  get y() { return new Node(this.values[1]); }
  get z() { return new Node(this.values[2]); }
  get w() { return new Node(this.values[3]); }
  add(v) { return binary(this, v, (a, b) => a + b); }
  sub(v) { return binary(this, v, (a, b) => a - b); }
  mul(v) { return binary(this, v, (a, b) => a * b); }
  div(v) { return binary(this, v, (a, b) => a / b); }
  negate() { return this.mul(-1); }
  normalize() { const length = Math.hypot(...this.values); return new Node(this.values.map(v => v / length)); }
  toVar() { return this; }
  setInterpolation(sampling, mode) { this.interpolation = { sampling, mode }; return this; }
}
const unary = (op) => (v) => new Node(values(v).map(op));
const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]; // Row-major normal matrices in this harness.
function matrix(elements) {
  return { mul(v) {
    const a = values(v);
    return new Node([0, 3, 6].map(i => f(f(f(elements[i] * a[0]) + f(elements[i + 1] * a[1])) + f(elements[i + 2] * a[2]))));
  } };
}
const source = readFileSync(join(__dirname, '../js/tsl-materials.js'), 'utf8');
const frame = source.match(/const facadeNormalVertex =[\s\S]*?const facadeAlongZ =[\s\S]*?\.setInterpolation\([\s\S]*?\);/);
assert.ok(frame, 'the shared camera-independent facade frame must exist');
const projectionStart = source.indexOf('function facadeCell(');
const projection = source.slice(source.indexOf('{', projectionStart) + 1, source.indexOf('let bayWidth', projectionStart));
const interiorStart = source.indexOf('const rayWorld =', source.indexOf('const evaluateApartmentInterior'));
const interior = source.slice(interiorStart, source.indexOf('// Slab intersection', interiorStart));
const buildFrame = vm.runInNewContext(`(function (normalLocal, modelNormalMatrix, normalWorldGeometry, cameraViewMatrix) {
  ${frame[0]}
  return {
    normal: facadeWorldNormal, axis: facadeAlongZ,
    project(boxLocal, normalGeometry, positionWorld) { const patternXZ = { x: positionWorld.x, y: positionWorld.z }; ${projection} return { alongZ, uCoord, isRoof }; },
    interior(positionWorld, cameraPosition) { ${interior} return { dirX, dirY, dirZ }; }
  };
})`, {
  THREE: { InterpolationSamplingType: { FLAT: 'flat' }, InterpolationSamplingMode: { EITHER: 'either' } },
  normalize: v => v.normalize(),
  varying: v => new Node(v),
  abs: unary(Math.abs), sign: unary(Math.sign),
  step: (edge, v) => binary(edge, v, (a, b) => b < a ? 0 : 1),
  max: (a, b) => binary(a, b, Math.max),
  mix: (a, b, t) => binary(binary(a, t, (v, t) => v * (1 - t)), binary(b, t, (v, t) => v * t), (a, b) => a + b),
  vec3: (...v) => new Node(v.flatMap(values)),
  dot: (a, b) => new Node(values(a).reduce((sum, v, i) => sum + v * values(b)[i], 0))
});
const scalar = v => v.values[0];
const position = new Node([-204.25, 220, 5267.625]);
const eye = new Node([-130, 250, 5180]);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 2e-6, `${actual} should equal ${expected}`);

// Float32 rotation into and out of view space reproduces the old normalWorldGeometry round-trip.
function cameraMatrix(yaw) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cx = Math.cos(-0.38), sx = Math.sin(-0.38);
  const cz = Math.cos(0.03), sz = Math.sin(0.03);
  return [cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx,
    cx * sz, cx * cz, -sx,
    -sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx].map(f);
}
function roundTrip(normal, camera) {
  const transpose = [camera[0], camera[3], camera[6], camera[1], camera[4], camera[7], camera[2], camera[5], camera[8]];
  return matrix(transpose).mul(matrix(camera).mul(normal).normalize()).normalize();
}

for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
  test(`45-degree facade (${sx}, ${sz}) keeps its windows and room frame across camera rotations`, () => {
    // Exact normal of One WTC's fitted diagonal glass shaft, including its slight outward slope.
    const normal = new Node([sx * 0.7068521976470947, -0.02683299221098423, sz * 0.7068521976470947]);
    const reference = buildFrame(normal, matrix(identity), normal, matrix(identity));
    const room = reference.interior(position, eye);
    const oldAxes = new Set();
    for (let i = 0; i < 720; i++) {
      const camera = cameraMatrix(i * Math.PI / 360);
      const unstable = roundTrip(normal, camera);
      oldAxes.add(Math.abs(unstable.values[0]) >= Math.abs(unstable.values[2]) ? 1 : 0);
      const actual = buildFrame(normal, matrix(identity), unstable, matrix(camera));
      assert.equal(scalar(actual.axis), 1, 'near-equal diagonal components have one deterministic tie-break');
      assert.deepEqual(actual.normal.values, reference.normal.values);
      const projected = actual.project(false, normal, position);
      assert.equal(scalar(projected.uCoord), position.values[2], 'the entire window grid must not switch to world X');
      assert.equal(scalar(projected.isRoof), 0);
      const directions = actual.interior(position, eye);
      for (const key of ['dirX', 'dirY', 'dirZ']) assert.deepEqual(directions[key].values, room[key].values);
    }
    assert.equal(oldAxes.size, 2, 'the fixture must expose the original camera-dependent axis flip');
    assert.equal(reference.axis.interpolation.sampling, 'flat', 'projection choice is constant across each triangle');
    assert.equal(reference.axis.interpolation.mode, 'either');
  });
}

test('cardinal facades retain their original world-coordinate mapping', () => {
  for (const [normal, axis] of [[[1, 0, 0], 1], [[-1, 0, 0], 1], [[0, 0, 1], 0], [[0, 0, -1], 0]]) {
    const n = new Node(normal);
    const frame = buildFrame(n, matrix(identity), n, matrix(identity));
    assert.equal(scalar(frame.axis), axis);
    assert.equal(scalar(frame.project(false, n, position).uCoord), position.values[axis ? 2 : 0]);
  }
});

test('world projection includes object rotation and the inverse scale used for normals', () => {
  // A +Z wall rotated 90 degrees around Y becomes a +X wall.
  const local = new Node([0, 0, 1]);
  const rotation = [0, 0, 1, 0, 1, 0, -1, 0, 0];
  const rotated = buildFrame(local, matrix(rotation), local, matrix(identity));
  assert.equal(scalar(rotated.axis), 1);
  assert.equal(scalar(rotated.project(false, local, position).uCoord), position.values[2]);
  assert.equal(scalar(rotated.project(true, local, position).alongZ), 0, 'box-local facade layout still uses its own axes');

  // Scaling a model by (2, 3, 0.5) gives a normal matrix with inverse scales (0.5, 1/3, 2).
  const scale = [0.5, 0, 0, 0, 1 / 3, 0, 0, 0, 2];
  const scaled = buildFrame(new Node([1, 1, 1]), matrix(scale), local, matrix(identity));
  const length = Math.hypot(0.5, 1 / 3, 2);
  [0.5, 1 / 3, 2].forEach((v, i) => close(scaled.normal.values[i], v / length));
  assert.equal(scalar(scaled.axis), 0, 'the dominant world normal component must be selected after inverse scaling');
});

test('surveyed storefronts remain glazed above the sidewalk while cut-off storeys stay solid', () => {
  const masks = source.slice(source.indexOf('let partial =', projectionStart), source.indexOf('const solid =', projectionStart));
  const evaluate = vm.runInNewContext(`(function (vCoord, fromTop, wallH, floorHeight, gridV, footprintLocal) {
    const boxLocal = true, wall = float(1);
    ${masks}
    return partial;
  })`, {
    float: v => new Node(v), floor: unary(Math.floor),
    step: (edge, v) => binary(edge, v, (a, b) => b < a ? 0 : 1)
  });
  const partial = (y, bottom, height, footprintLocal) => scalar(evaluate(
    new Node(y), new Node(bottom + height - y), new Node(height), new Node(3.5), new Node(y / 3.5), footprintLocal));

  assert.equal(partial(2, 0.22, 10, true), 0, 'the sidewalk offset must not blank the ground floor');
  assert.equal(partial(5, 0.22, 10, true), 0, 'complete upper storeys retain their windows');
  assert.equal(partial(8, 0.22, 10, true), 1, 'the roof still masks an incomplete top storey');
  assert.equal(partial(6, 5.4, 10, false), 1, 'a raised authored box masks its incomplete bottom storey');
  assert.equal(partial(8, 5.4, 10, false), 0, 'complete storeys in raised boxes remain glazed');
});

// A wall's counts: its window bays, its whole-bay offset, its entrances and its shopfronts. Worked out in every pixel from the
// interpolated wall width, a wall whose sum landed on a half (11.5 m of sandstone: 9.1 m between its piers, 3.5 bays of 2.6 m)
// rounded one way or the other pixel by pixel, and showed two window layouts at once.
const countsSource = source.match(/function facadeCounts\([\s\S]*?\n}\n/);
const facadeCounts = countsSource && vm.runInNewContext(`(function () { ${countsSource[0]} return facadeCounts; })()`, {
  float: v => new Node(v), floor: unary(Math.floor), abs: unary(Math.abs),
  max: (a, b) => binary(a, b, Math.max), min: (a, b) => binary(a, b, Math.min),
  step: (edge, v) => binary(edge, v, (a, b) => b < a ? 0 : 1),
  mix: (a, b, t) => binary(binary(a, t, (v, t) => v * (1 - t)), binary(b, t, (v, t) => v * t), (a, b) => a + b),
  dot: (a, b) => new Node(values(a).reduce((sum, v, i) => f(sum + f(v * values(b)[i])), 0)),
  vec3: (...v) => new Node(v.flatMap(values)), vec4: (...v) => new Node(v.flatMap(values))
});
// One float32 step up or down
function nextFloat(x, steps) {
  const buffer = new Float32Array([x]), bits = new Int32Array(buffer.buffer);
  bits[0] += steps;
  return buffer[0];
}
// [bays, wall seed, entrances, shopfronts] for a footprint wall `width` long, as the vertex stage gets them
function countsOf(width, windowWidth, cornerPier, { seed = 140.5, normal = [0, 0, -1], footprintLocal = true, depth = 30 } = {}) {
  assert.ok(facadeCounts, 'facadeCounts() must work out each wall\'s counts once, from its own attributes');
  return facadeCounts(new Node([width, 34, depth, seed]), new Node(normal), new Node(windowWidth), cornerPier, footprintLocal).values;
}
// What exact arithmetic gives, a half rounding up: in tenths of a metre, so every length here is a whole number
const exactCount = (length10, spacing10) => Math.max(Math.floor((2 * length10 + spacing10) / (2 * spacing10)), 1);
function exactBays(width, windowWidth, cornerPier) {
  const w10 = Math.round(width * 10), ww10 = Math.round(windowWidth * 10), pier10 = Math.round(cornerPier * 10);
  const inner10 = cornerPier > 0 ? w10 - 2 * Math.min(pier10, w10 / 5) : w10;
  return { bays: exactCount(inner10, ww10), tie: (2 * inner10 + ww10) % (2 * ww10) === 0 };
}
// The bays as every pixel worked them out before, in float32
function perPixelBays(width, windowWidth, cornerPier) {
  const pier = Math.min(f(cornerPier), f(width * f(0.2)));
  const inner = cornerPier > 0 ? f(width - f(pier * 2)) : width;
  return Math.max(Math.floor(f(f(inner / f(windowWidth)) + 0.5)), 1);
}
const facades = [...readFileSync(join(__dirname, '../js/buildings.js'), 'utf8').matchAll(/\[(create\w+Material), \{([\s\S]*?)\}\]/g)]
  .map(([, material, body]) => ({
    windowWidth: Number(body.match(/windowWidth: ([\d.]+)/)[1]),
    // createPreWarBuildingMaterial()'s piers are 1.2 m unless a facade says otherwise; curtain walls have none
    cornerPier: material === 'createCurtainWallMaterial' ? 0 : Number(body.match(/cornerPier: ([\d.]+)/)?.[1] ?? 1.2)
  }));

test('a wall\'s counts are worked out once, in the vertex stage, and every pixel gets them unchanged', () => {
  assert.ok(countsSource, 'facadeCounts() must exist');
  const cell = source.slice(projectionStart, source.indexOf('\n}\n', projectionStart));
  assert.match(cell, /varying\(\s*facadeCounts\([^;]*?\)\s*,\s*'\w+'\s*\)\s*\.setInterpolation\(\s*THREE\.InterpolationSamplingType\.FLAT,\s*THREE\.InterpolationSamplingMode\.EITHER\s*\)/,
    'facadeCell() must pass the counts with flat interpolation, as facadeAlongZ is');
  // Nothing rounds a wall's width to a count in the pixels any more
  assert.doesNotMatch(source, /floor\(\s*(inner|wallWidth|wallW)\.div\(/, 'a count worked out per pixel can tie');
});

test('the George St wall, 11.5 m of sandstone, has one window layout: 4 bays', () => {
  const steps = [-2, -1, 0, 1, 2];
  // The fixture: every pixel worked it out from a width a step or so either side, and got 3 bays or 4
  assert.deepEqual(new Set(steps.map(s => perPixelBays(nextFloat(11.5, s), 2.6, 1.2))), new Set([3, 4]));
  for (const s of steps) assert.equal(countsOf(nextFloat(11.5, s), 2.6, 1.2)[0], 4, `11.5 m ${s} float32 steps off`);
});

test('every facade\'s bays, entrances and shopfronts are what exact arithmetic gives, a half rounding up', () => {
  assert.ok(facades.length >= 9, 'js/buildings.js FACADES');
  let ties = 0;
  for (const { windowWidth, cornerPier } of facades) {
    for (let width = 0.5; width <= 300; width += 0.5) {
      const { bays, tie } = exactBays(width, windowWidth, cornerPier);
      const w10 = Math.round(width * 10);
      for (const s of [-1, 0, 1]) {
        const [count, , entrances, shopfronts] = countsOf(nextFloat(width, s), windowWidth, cornerPier);
        assert.equal(count, bays, `${width} m of ${windowWidth} m bays (piers ${cornerPier} m), ${s} steps off`);
        assert.equal(entrances, exactCount(w10, 280), `entrances on ${width} m`);
        assert.equal(shopfronts, exactCount(w10, 75), `shopfronts on ${width} m`);
      }
      // Off a tie, a wall keeps the layout it always had
      if (tie) ties++;
      else assert.equal(bays, perPixelBays(width, windowWidth, cornerPier), `${width} m of ${windowWidth} m bays, off a tie`);
    }
  }
  assert.ok(ties > 0, 'the lengths must include ties');
});

test('a wall\'s whole-bay offset, and a box\'s walls along either axis', () => {
  // floor(seed + n . (17, 0, 37)), from the wall's own normal
  const normal = [Math.SQRT1_2, 0, -Math.SQRT1_2].map(f);
  assert.equal(countsOf(11.5, 2.6, 1.2, { seed: 140.5, normal })[1], Math.floor(f(140.5 + f(f(normal[0] * 17) + f(normal[2] * 37)))));
  // A box's walls facing x run along z, and measure its depth
  assert.equal(countsOf(11.5, 2.6, 1.2, { normal: [1, 0, 0], footprintLocal: false, depth: 24.5 })[0], exactBays(24.5, 2.6, 1.2).bays);
  assert.equal(countsOf(11.5, 2.6, 1.2, { normal: [0, 0, 1], footprintLocal: false, depth: 24.5 })[0], 4);
});
