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

// A house's wall (js/tsl-materials.js houseWall()): its style rides on its seed, 1000 times it, and its own counts are worked out once in
// the vertex stage, as a city wall's are. The table and the hash as the shader has them, in float32.
const houseSource = source.match(/function houseWall\([\s\S]*?\n}\n/);
const { HOUSE_STYLES } = require('./helpers/house-styles.cjs');
const kindsSource = source.match(/const WALL_KINDS = (\{[^}]*\})/);
const WALL_KINDS = kindsSource && vm.runInNewContext(`(${kindsSource[1]})`);
const ONE_HOUSE = Number(source.match(/const ONE_HOUSE = ([\d.]+);/)?.[1]);
const fract = (x) => f(x - Math.floor(x));
const hash = (p) => fract(f(Math.sin(f(f(p[0] * f(127.1)) + f(p[1] * f(311.7)))) * f(43758.5453)));
const ROWS = (look) => look ? [
  [look.bay[0], look.bay[1], look.share[0], look.share[1]], look.window.slice(0, 4), look.side.slice(0, 4),
  [look.window[4], look.side[4], look.frame, look.door], [look.painted, look.garage ? 1 : 0, look.terrace ? 1 : 0, 1]
] : Array.from({ length: 5 }, () => [0, 0, 0, 0]);
const table = { element: (i) => new Node(Array.from({ length: 16 }, (_, s) => ROWS(HOUSE_STYLES[s]?.look)).flat()[scalar(i)]) };
Node.prototype.toInt = function () { return new Node(this.values.map(Math.trunc)); };
Node.prototype.greaterThanEqual = function (v) { return new Node(binary(this, v, (a, b) => (a >= b ? 1 : 0))); };
Node.prototype.assign = function (v) { this.values = values(v).map(f); return this; };
const tsl = {
  float: v => new Node(v), floor: unary(Math.floor), abs: unary(Math.abs), fract: unary((v) => v - Math.floor(v)),
  max: (a, b) => binary(a, b, Math.max), min: (a, b) => binary(a, b, Math.min),
  step: (edge, v) => binary(edge, v, (a, b) => b < a ? 0 : 1),
  mix: (a, b, t) => binary(binary(a, t, (v, t) => v * (1 - t)), binary(b, t, (v, t) => v * t), (a, b) => a + b),
  dot: (a, b) => new Node(values(a).reduce((sum, v, i) => f(sum + f(v * values(b)[i])), 0)),
  vec2: (...v) => new Node(v.flatMap(values)), vec3: (...v) => new Node(v.flatMap(values)), vec4: (...v) => new Node(v.flatMap(values)),
  hash2D: (p) => new Node(hash(values(p))), HOUSE_TABLE: table, HOUSE_ROWS: 5, HOUSE_PIER: 0.45, TERRACE_HOUSE: 5.5, WALL_KINDS, ONE_HOUSE,
  Fn: (fn) => () => fn(), If: (cond, fn) => { if (scalar(cond)) fn(); }
};
const houseWall = houseSource && vm.runInNewContext(`(function () { ${houseSource[0]} return houseWall; })()`, tsl);
const rowDoorSource = source.match(/function rowDoor\([\s\S]*?\n}\n/);
const rowDoor = rowDoorSource && vm.runInNewContext(`(function () { ${rowDoorSource[0]} return rowDoor; })()`, tsl);
const houseCounts = countsSource && vm.runInNewContext(`(function () { ${houseSource?.[0] ?? ''} ${countsSource[0]} return facadeCounts; })()`, tsl);
// A house's wall as the vertex stage gets it: [bays, wall seed, window width, door + 1 + 64 (garage + 1) + 4096 style + 65536 row],
// decoded. On a row of terraces, `door` is which bay of each house has its door (rowDoor()) rather than a bay.
function houseOf(width, style, kind, { seed = 140.5, normal = [0, 0, -1] } = {}) {
  const [bays, wallSeed, windowWidth, all] = houseWall(new Node([width, 6, 6, 1000 * style + seed]), new Node([0.5, 3, kind]), new Node(normal)).values;
  const row = Math.floor(all / 65536), packed = all - row * 65536;
  const rest = packed % 4096, garage = Math.floor(rest / 64) - 1;
  return { bays, wallSeed, windowWidth, style: Math.floor(packed / 4096), garage, door: rest - (garage + 1) * 64 - 1, row };
}
const HOUSES = HOUSE_STYLES.map((s, i) => [i, s]).filter(([, s]) => s?.look);

test('the wall kinds keep their values, and a house\'s sides come before what\'s under the floor', () => {
  assert.deepEqual({ ...WALL_KINDS }, { shop: 0, front: 1, rear: 2, lotLine: 3, side: 4, below: 5 });
});

test('a house\'s wall splits its style off its seed, and hashes the rest as a city wall would', () => {
  assert.ok(houseWall, 'houseWall() must work out a house\'s wall once, from its own attributes');
  for (const [style] of HOUSES) {
    for (const seed of [0.1, 140.5, 999.9]) {
      const normal = [Math.SQRT1_2, 0, -Math.SQRT1_2].map(f);
      const house = houseOf(10, style, WALL_KINDS.front, { seed, normal });
      assert.equal(house.style, style);
      assert.equal(house.wallSeed, Math.floor(f(f(f(1000 * style + seed) - f(1000 * style)) + f(f(normal[0] * 17) + f(normal[2] * 37)))));
    }
  }
  // A city wall's seed never reaches 1000, and facadeCounts() leaves it as it was
  const city = countsOf(11.5, 2.6, 1.2);
  assert.deepEqual(houseCounts(new Node([11.5, 34, 30, 140.5]), new Node([0, 0, -1]), new Node(2.6), 1.2, true, new Node([0.5, 3, 1])).values, city);
});

// A row of terraces' houses as exact arithmetic gives them, a half rounding up: its length over the nearest whole number of 5.5 m
const exactHouses = (w100) => Math.max(Math.floor((2 * w100 + 550) / 1100), 1);

test('each house style\'s bays are what exact arithmetic gives, a half rounding up, on its fronts and its sides', () => {
  let ties = 0;
  for (const [style, { look }] of HOUSES) {
    for (const [kind, spacing] of [[WALL_KINDS.front, look.bay[0]], [WALL_KINDS.side, look.bay[1]]]) {
      const s100 = Math.round(spacing * 100);
      for (let width = 0.5; width <= 300; width += 0.5) {
        const w100 = Math.round(width * 100), inner100 = w100 - 2 * Math.min(45, w100 / 5);
        // A terrace's front of two houses or more is two bays a house (the next test)
        const row = look.terrace && kind === WALL_KINDS.front && exactHouses(w100) >= 2;
        const exact = row ? 2 * exactHouses(w100) : Math.max(Math.floor((2 * inner100 + s100) / (2 * s100)), 1);
        if (!row && (2 * inner100 + s100) % (2 * s100) === 0) ties++;
        for (const s of [-1, 0, 1]) assert.equal(houseOf(nextFloat(width, s), style, kind).bays, exact, `${HOUSE_STYLES[style].name}: ${width} m of ${spacing} m bays, ${s} steps off`);
      }
    }
  }
  assert.ok(ties > 0, 'the lengths must include ties');
});

test('a house\'s front has one door, in one of its bays, and a project home\'s garage door beside it; its sides have neither', () => {
  for (const [style, { look }] of HOUSES) {
    for (let width = 2; width <= 40; width += 0.7) {
      for (const seed of [3.5, 140.5, 517.3, 888.9]) {
        const front = houseOf(width, style, WALL_KINDS.front, { seed });
        if (front.row) {
          // A row of terraces: which of each house's two bays has its door, as rowDoor() takes it
          assert.ok(look.terrace && front.bays >= 4 && front.bays % 2 === 0, `${HOUSE_STYLES[style].name} ${width} m: a row of ${front.bays / 2}`);
          assert.ok([0, 1, 2, 3].includes(front.door), `the row's pattern: ${front.door}`);
          assert.equal(front.garage, -1);
          continue;
        }
        assert.ok(front.door >= 0 && front.door < front.bays, `${HOUSE_STYLES[style].name} ${width} m: door ${front.door} of ${front.bays}`);
        if (look.terrace) assert.ok(front.door === 0 || front.door === front.bays - 1, 'a terrace\'s door is at an end');
        if (look.garage && front.bays >= 3) {
          assert.ok(front.garage >= 0 && front.garage + 1 < front.bays, 'two bays of garage');
          assert.ok(front.door !== front.garage && front.door !== front.garage + 1 && Math.min(Math.abs(front.door - front.garage), Math.abs(front.door - front.garage - 1)) === 1, 'the door beside it');
        } else assert.equal(front.garage, -1);
        assert.ok(front.windowWidth <= look.window[0] + 1e-6 && front.windowWidth >= look.window[0] * 0.85 - 1e-6);
        const side = houseOf(width, style, WALL_KINDS.side, { seed });
        assert.deepEqual([side.door, side.garage], [-1, -1]);
        assert.ok(side.windowWidth <= look.side[0] + 1e-6);
      }
    }
  }
});

test('the game finds a house\'s door and garage door where its facade draws them (js/house-entry.js)', async () => {
  const { houseEntry } = await import('../js/house-entry.js');
  let garages = 0;
  for (const [style, { look }] of HOUSES) {
    for (let width = 2; width <= 40; width += 0.37) {
      for (const seed of [0.5, 3.5, 63.7, 64.2, 140.5, 517.3, 888.9, 999.9]) {
        const shader = houseOf(width, style, WALL_KINDS.front, { seed });
        const cpu = houseEntry({ ax: 0, az: 0, bx: width, bz: 0, reverse: false, width, digits: Math.floor(seed) }, style);
        assert.equal(cpu.bays, shader.bays, `${look ? HOUSE_STYLES[style].name : style} ${width} m: bays`);
        assert.equal(!!cpu.row, !!shader.row, `${HOUSE_STYLES[style].name} ${width} m: a row or not`);
        if (cpu.row) {
          assert.equal(cpu.row.pattern, shader.door, `${HOUSE_STYLES[style].name} ${width} m, seed ${seed}: the row's pattern`);
          assert.deepEqual(cpu.row.units.map((u) => u.doorBay), cpu.row.units.map((u, k) => scalar(rowDoor(new Node(2 * k + 1), new Node(shader.door)))));
          continue;
        }
        assert.equal(cpu.doorBay, shader.door, `${HOUSE_STYLES[style].name} ${width} m, seed ${seed}: the door's bay`);
        assert.equal(cpu.garageBay, shader.garage, `${HOUSE_STYLES[style].name} ${width} m, seed ${seed}: the garage door's`);
        if (cpu.garage) garages++;
      }
    }
  }
  assert.ok(garages > 0, 'some have garage doors');
  // Reversed, its bays count from b
  const cpu = houseEntry({ ax: 10, az: 0, bx: 0, bz: 0, reverse: true, width: 10, digits: 140 }, HOUSES[0][0]);
  assert.ok(Math.abs(cpu.door.x - cpu.door.s) < 1e-9, 'a reversed wall\'s bays start at b');
});

test('a terrace\'s front of two houses or more is cut into houses of its length over the nearest whole number of 5.5 m, a half rounding up', () => {
  const terraces = HOUSES.filter(([, { look }]) => look.terrace);
  assert.ok(terraces.length >= 2, 'Victorian and Millers Point terraces');
  let ties = 0, rows = 0;
  for (const [style] of terraces) {
    for (let width = 0.25; width <= 300; width += 0.25) {
      const w100 = Math.round(width * 100), houses = exactHouses(w100);
      if ((2 * w100 + 550) % 1100 === 0) ties++;
      for (const s of [-1, 0, 1]) {
        const front = houseOf(nextFloat(width, s), style, WALL_KINDS.front);
        assert.equal(front.row, houses >= 2 ? 1 : 0, `${HOUSE_STYLES[style].name}: ${width} m, ${s} steps off`);
        if (houses >= 2) assert.equal(front.bays, 2 * houses, `${HOUSE_STYLES[style].name}: ${width} m is ${houses} houses, ${s} steps off`);
        // Its sides, and any other style's front, are never a row
        assert.equal(houseOf(nextFloat(width, s), style, WALL_KINDS.side).row, 0);
      }
      if (houses >= 2) rows++;
    }
  }
  assert.ok(ties > 0 && rows > 0, 'the lengths must include ties and rows');
  // Under 8.25 m it's one house, as before; at 8.25 m two of 4.125 m
  assert.equal(houseOf(8.2, terraces[0][0], WALL_KINDS.front).row, 0);
  assert.equal(houseOf(8.25, terraces[0][0], WALL_KINDS.front).bays, 4);
  for (const [style] of HOUSES.filter(([, { look }]) => !look.terrace)) assert.equal(houseOf(30, style, WALL_KINDS.front).row, 0);
});

test('each house of a row has its door in one of its own two bays, every bay of it agreeing', () => {
  assert.ok(rowDoor, 'rowDoor() must say which bay of each house of a row has its door');
  for (const pattern of [0, 1, 2, 3]) {
    const doors = [];
    for (let unit = 0; unit < 12; unit++) {
      const a = scalar(rowDoor(new Node(2 * unit), new Node(pattern))), b = scalar(rowDoor(new Node(2 * unit + 1), new Node(pattern)));
      assert.equal(a, b, 'both its bays agree');
      assert.ok(a === 2 * unit || a === 2 * unit + 1, `house ${unit}: door in bay ${a}`);
      doors.push(a - 2 * unit);
    }
    // The first's in its second bay with pattern 1 or 3; the rest the same (0, 1), or each the other way to the last (2, 3)
    assert.equal(doors[0], pattern % 2);
    for (let k = 1; k < doors.length; k++) assert.equal(doors[k], pattern >= 2 ? 1 - doors[k - 1] : doors[0]);
  }
});

test('the game finds each house of a row, and its door, where the facade draws them (js/house-entry.js)', async () => {
  const { houseEntry } = await import('../js/house-entry.js');
  const style = HOUSES.find(([, { look }]) => look.terrace)[0];
  for (const width of [9, 13.75, 23, 61.3]) {
    for (const seed of [0.5, 40.5, 64.2, 100.5, 999.9]) {
      const cpu = houseEntry({ ax: 0, az: 0, bx: width, bz: 0, reverse: false, width, digits: Math.floor(seed) }, style);
      const n = cpu.row.houses;
      assert.equal(n, exactHouses(Math.round(width * 100)));
      // One after another along the wall, from end to end, each with its door in its own stretch
      assert.equal(cpu.row.units[0].s0, 0);
      assert.ok(Math.abs(cpu.row.units[n - 1].s1 - width) < 1e-9);
      for (const [k, u] of cpu.row.units.entries()) {
        if (k) assert.equal(u.s0, cpu.row.units[k - 1].s1);
        assert.ok(u.door.s > u.s0 + 0.5 && u.door.s < u.s1 - 0.5, `house ${k}'s door at ${u.door.s} in ${u.s0}-${u.s1}`);
        assert.ok(u.s1 - u.s0 > 4 && u.s1 - u.s0 < 7.5, `house ${k} is ${u.s1 - u.s0} m`);
      }
    }
  }
});

test('a terrace\'s front of one house (its address\'s one number) is never a row, and the game finds its one door where the facade draws it', async () => {
  const { houseEntry } = await import('../js/house-entry.js');
  assert.ok(ONE_HOUSE > 0 && ONE_HOUSE < 0.25, 'a front to everything else that reads the kind');
  let wide = 0;
  for (const [style, { look }] of HOUSES) {
    for (let width = 2; width <= 40; width += 0.37) {
      for (const seed of [0.5, 40.5, 64.2, 140.5, 999.9]) {
        const shader = houseOf(width, style, WALL_KINDS.front + ONE_HOUSE, { seed });
        assert.equal(shader.row, 0, `${HOUSE_STYLES[style].name} ${width} m: one house`);
        const cpu = houseEntry({ ax: 0, az: 0, bx: width, bz: 0, reverse: false, width, digits: Math.floor(seed), single: true }, style);
        assert.equal(cpu.row, null);
        assert.equal(cpu.bays, shader.bays, `${HOUSE_STYLES[style].name} ${width} m: bays`);
        assert.equal(cpu.doorBay, shader.door, `${HOUSE_STYLES[style].name} ${width} m, seed ${seed}: the door's bay`);
        assert.equal(cpu.garageBay, shader.garage);
        // Elsewhere as any front: a house of another style, or a terrace too short for a row, has the same counts either way
        const plain = houseOf(width, style, WALL_KINDS.front, { seed });
        if (!plain.row) assert.deepEqual(shader, plain);
        else wide++;
      }
    }
  }
  assert.ok(wide > 0, 'terraces long enough for a row');
});

test('the city\'s entrances along a wall are where the build finds the one nearest an address (js/addresses.js entranceNear())', async () => {
  const { ENTRANCE_EVERY, entranceNear, entrancesOn } = await import('../js/addresses.js');
  // createBuildingEntrance(): stretches of the wall's length over facadeCounts()' count, an entrance in the middle of each
  const entrance = source.slice(source.indexOf('function createBuildingEntrance('), source.indexOf('\n}\n', source.indexOf('function createBuildingEntrance(')));
  assert.match(entrance, /const width = local \? wallW\.div\(entrances\)/);
  assert.match(entrance, /const x = fract\(grid\)\.sub\(0\.5\)\.mul\(width\)/);
  assert.match(countsSource[0], new RegExp(`count\\(wallWidth, ${ENTRANCE_EVERY}\\.0\\)`));
  // ...and none on a wall that isn't to an address street (WALL_KINDS.side)
  assert.match(entrance, /\.mul\(float\(1\)\.sub\(step\(abs\(kind\.sub\(WALL_KINDS\.side\)\), 0\.25\)\)\)/);
  for (let width = 2.5; width <= 150; width += 0.5) {
    for (const s of [-1, 0, 1]) assert.equal(entrancesOn(nextFloat(width, s)), countsOf(nextFloat(width, s), 2.6, 1.2)[2], `entrances on ${width} m`);
    const n = entrancesOn(width), wall = { a: { x: 10, y: 5 }, b: { x: 10 + width * 0.6, y: 5 + width * 0.8 }, width };
    for (let k = 0; k < n; k++) {
      // The middle of each stretch, from either end: the facade measures from whichever end it reads the wall from
      const s0 = ((k + 0.5) * width) / n;
      const at = { x: 10 + s0 * 0.6 + 0.8 * 3, z: 5 + s0 * 0.8 - 0.6 * 3 };
      const door = entranceNear(wall, at.x, at.z);
      assert.ok(Math.abs(door.s - s0) < 1e-9 && Math.abs(width - door.s - ((n - 1 - k + 0.5) * width) / n) < 1e-9, `${width} m, entrance ${k}`);
    }
  }
});

// Where the ground runs up a wall over its floor (js/wall-ground.js): the line rides in the wall's kind, and the CPU lays the wall out in
// pieces at the bays' edges the facade draws, so each bay has its window or doesn't
test('the facade unpacks a wall\'s kind and the ground\'s line along it as js/wall-ground.js packs them', async () => {
  const { packKind, unpackKind, WALL_BURIED, LINE_UNIT } = await import('../js/wall-ground.js');
  const kindSource = source.match(/function wallKind\([\s\S]*?\n}\n/);
  assert.ok(kindSource, 'js/tsl-materials.js wallKind() unpacks a footprint wall\'s kind');
  const wallKind = vm.runInNewContext(`(function () { ${kindSource[0]} return wallKind; })()`, tsl);
  for (const kind of [...Object.values(WALL_KINDS).filter((k) => k < WALL_KINDS.below), WALL_KINDS.front + ONE_HOUSE]) {
    for (const line of [0, 0.2, WALL_BURIED + 0.01, 0.8, 1.55, 2.95, 3.9, 6.2]) {
      const packed = packKind(kind, line);
      const cpu = unpackKind(packed);
      assert.equal(cpu.kind, kind);
      // ...rounded up to its unit, where it's over WALL_BURIED; 0 elsewhere
      const want = line > WALL_BURIED ? Math.ceil(line / LINE_UNIT - 1e-6) * LINE_UNIT : 0;
      assert.ok(Math.abs(cpu.line - want) < 1e-9 && cpu.line >= line - 1e-9 || !(line > WALL_BURIED), `${kind} ${line}: ${cpu.line}`);
      // In float32, and a little off, as a value interpolated over a triangle whose corners all have it comes out
      for (const nudge of [0, -3e-5, 3e-5]) {
        const gpu = wallKind(new Node(f(packed * (1 + nudge))));
        assert.ok(Math.abs(gpu.kind.values[0] - kind) < 0.02, `kind ${kind}, line ${line}, nudge ${nudge}: ${gpu.kind.values[0]}`);
        assert.ok(Math.abs(gpu.line.values[0] - cpu.line) < 1e-3, `line ${line}, nudge ${nudge}: ${gpu.line.values[0]}`);
      }
    }
  }
  // What's under a floor (WALL_KINDS.below and the metres clear) is never packed, and comes back as it went
  for (const below of [5, 5.4, 12.7, 60]) assert.deepEqual(wallKind(new Node(below)).kind.values, [f(below)]);
});

test('the CPU lays a wall\'s bays out as the facade does (js/wall-ground.js houseBays(), cityBays())', async () => {
  const { houseBays, cityBays } = await import('../js/wall-ground.js');
  for (const [style, s] of HOUSES) {
    for (let width = 2.3; width <= 24; width += 0.37) {
      for (const kind of [WALL_KINDS.front, WALL_KINDS.front + ONE_HOUSE, WALL_KINDS.side, WALL_KINDS.rear]) {
        assert.equal(houseBays(width, kind, s.look).bays, houseOf(width, style, kind).bays, `${s.name}, ${width} m, kind ${kind}`);
      }
    }
  }
  for (const [windowWidth, pier] of [[2.6, 1.2], [3.0, 1.2], [2.7, 0], [2.9, 0]]) {
    for (let width = 2.5; width <= 60; width += 0.43) {
      assert.equal(cityBays(width, { width: windowWidth, pier }).bays, countsOf(width, windowWidth, pier)[0], `${width} m at ${windowWidth}, pier ${pier}`);
    }
  }
  // Its sill: the style's window's, front or side, over the 0.22 the wall starts at, as the masonry draws a house's windows
  assert.match(source, /const sill = mix\(sideRow\.z, frontRow\.z, house\.front\);\n[^\n]*\n[^\n]*\n\s*hy0 = sill\.add\(0\.22\)/);
  assert.match(source, /underGround\(mix\(house\.rows\[2\]\.z, house\.rows\[1\]\.z, house\.front\)\.add\(0\.22\)\)/);
});
