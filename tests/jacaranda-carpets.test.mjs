import assert from 'node:assert/strict';
import test from 'node:test';
import { LIFT, SPREAD, carpetGeometry, createCarpets, flowerTextureSteps } from '../js/jacaranda-carpets.js';

const tree = { x: 100, z: -40, crown: 4 };
const KERB = 0.22;

/** Each triangle's three corners, in the world: [[x, y, z] x 3] */
function triangles(g) {
  const out = [];
  for (let t = 0; t < g.index.length; t += 3) {
    out.push([0, 1, 2].map((k) => {
      const v = g.index[t + k] * 3;
      return [g.position[v] + g.x, g.position[v + 1], g.position[v + 2] + g.z];
    }));
  }
  return out;
}
const area = (tri) => {
  const [a, b, c] = tri;
  return Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])) / 2;
};

test('on flat ground a carpet lies LIFT over it, faces up, and fills the disc it thins out to', () => {
  const g = carpetGeometry(tree, () => 3);
  for (const [a, b, c] of triangles(g)) {
    for (const v of [a, b, c]) assert.ok(Math.abs(v[1] - (3 + LIFT)) < 1e-5);
    // Wound to face up: the normal of (b - a) x (c - a) points to +y
    const ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - a[0], vz = c[2] - a[2];
    assert.ok(uz * vx - ux * vz > 0, 'faces up');
  }
  for (let v = 0; v < g.normal.length; v += 3) assert.ok(g.normal[v + 1] > 0.999);
  // As dense as it gets under the trunk, none of it left at the square's corners
  const reach = tree.crown * SPREAD;
  let middle = 0, edge = 1;
  for (let v = 0; v < g.petals.length; v++) {
    const r = Math.hypot(g.position[v * 3], g.position[v * 3 + 2]);
    if (r < tree.crown * 0.3) middle = Math.max(middle, g.petals[v]);
    if (r > reach * 1.2) edge = Math.min(edge, g.petals[v]);
    assert.ok(g.petals[v] >= 0 && g.petals[v] <= 1);
  }
  assert.equal(middle, 1);
  assert.equal(edge, 0);
  // Cells wholly past the disc are left out: less than the whole square, more than the disc
  const total = triangles(g).reduce((sum, t) => sum + area(t), 0);
  assert.ok(total < (2 * reach) ** 2 && total > Math.PI * reach ** 2, `${total.toFixed(1)} m²`);
});

test('across a kerb the carpet is cut along the step, each side at its own level, with nothing ramping between', () => {
  for (const kerbAt of [100.3, 97.15, 102.9]) {
    const heightAt = (x) => (x < kerbAt ? 2 : 2 + KERB);
    const g = carpetGeometry(tree, heightAt);
    let low = 0, high = 0;
    for (const tri of triangles(g)) {
      const ys = tri.map((v) => v[1]);
      assert.ok(Math.max(...ys) - Math.min(...ys) < 1e-5, `a triangle spans the step at ${kerbAt}: ${ys}`);
      const side = ys[0] > 2 + KERB / 2 ? 'high' : 'low';
      for (const v of tri) {
        // On its own side of the step, to within the 2 cm it's found to
        if (side === 'low') assert.ok(v[0] <= kerbAt + 0.02, `${v[0]} is past the kerb at ${kerbAt}`);
        else assert.ok(v[0] >= kerbAt - 0.02, `${v[0]} is short of the kerb at ${kerbAt}`);
        assert.ok(Math.abs(v[1] - heightAt(side === 'low' ? kerbAt - 1 : kerbAt + 1) - LIFT) < 1e-5);
      }
      if (side === 'low') low += area(tri);
      else high += area(tri);
    }
    // Nothing is lost at a straight kerb: both sides together cover what the flat carpet does
    const flat = triangles(carpetGeometry(tree, () => 2)).reduce((sum, t) => sum + area(t), 0);
    assert.ok(Math.abs(low + high - flat) < 0.01, `${(low + high).toFixed(3)} against ${flat.toFixed(3)}`);
    assert.ok(low > 0 && high > 0);
  }
});

test('a slope is not a step: the carpet follows it without being cut', () => {
  const heightAt = (x, z) => 5 + 0.12 * (x - 100) - 0.05 * (z + 40);
  const g = carpetGeometry(tree, heightAt);
  const flat = carpetGeometry(tree, () => 5);
  assert.equal(g.position.length, flat.position.length);
  for (const tri of triangles(g)) for (const v of tri) assert.ok(Math.abs(v[1] - heightAt(v[0], v[2]) - LIFT) < 1e-4);
});

test("a kerb's corner: no triangle spans the step, and little is left out", () => {
  // A footpath's corner: high where x > 99 and z > -41
  const heightAt = (x, z) => (x > 99 && z > -41 ? 1.22 : 1);
  const g = carpetGeometry(tree, heightAt);
  let total = 0;
  for (const tri of triangles(g)) {
    const ys = tri.map((v) => v[1]);
    assert.ok(Math.max(...ys) - Math.min(...ys) < 1e-5, `a triangle spans the step: ${ys}`);
    total += area(tri);
  }
  const flat = triangles(carpetGeometry(tree, () => 1)).reduce((sum, t) => sum + area(t), 0);
  assert.ok(total > flat - 0.2, `${(flat - total).toFixed(3)} m² left out`);
});

test("the flowers' texture is the same every time, and covers about four fifths where they're all kept", () => {
  const make = () => {
    const steps = flowerTextureSteps(128);
    let s = steps.next();
    while (!s.done) s = steps.next();
    return s.value;
  };
  const a = make(), b = make();
  assert.deepEqual(a, b);
  let cover = 0, ranks = 0;
  for (let i = 0; i < a.length; i += 4) {
    cover += a[i + 3] / 255;
    // Premultiplied: what's in each colour is never more than the coverage
    assert.ok(a[i] <= a[i + 3] + 1 && a[i + 1] <= a[i + 3] + 1 && a[i + 2] <= a[i + 3] + 1);
    if (a[i + 3] > 250) ranks += a[i] / a[i + 3];
  }
  cover /= a.length / 4;
  assert.ok(cover > 0.7 && cover < 0.9, `${cover.toFixed(3)}`);
  // The flowers' ranks spread evenly from 0 to 1, so a carpet thins evenly
  const solid = a.filter((_, i) => i % 4 === 3 && a[i] > 250).length;
  assert.ok(Math.abs(ranks / solid - 0.5) < 0.06, `${(ranks / solid).toFixed(3)}`);
});

test('the carpets near you: laid nearest first, a surface made a step before each, drawn in one mesh, written again when the origin moves', () => {
  const origin = { x: 0, z: 0 };
  const jacarandas = [{ x: 4000, z: 30, crown: 3 }, { x: 4050, z: -20, crown: 4 }, { x: 4400, z: 0, crown: 4 }];
  let surfaces = 2; // the ground's triangles still to make under them
  const carpets = createCarpets({
    level: 'low', reach: () => 100, origin, heightAt: () => 1,
    trees: (x, z, r) => jacarandas.filter((t) => Math.hypot(t.x - x, t.z - z) <= r),
    prepare: () => surfaces-- > 0
  });
  const run = () => {
    const job = carpets.work(4010, 0);
    let step = job.next();
    while (!step.done) step = job.next();
    return step.value;
  };
  let steps = 0;
  while (run() && steps < 50) steps++;
  assert.ok(surfaces < 0, 'every surface made first');
  const state = carpets.state();
  assert.deepEqual([state.wanted, state.made, state.drawn, state.pending], [2, 2, 2, 0], JSON.stringify(state));
  assert.deepEqual(carpets.carpets().map((t) => t.x), [4000, 4050], 'nearest first, the one out of reach left out');
  // Its vertices from the origin, around each trunk
  const g = carpets.mesh.geometry, pos = g.attributes.position.array;
  const first = g.index.array[0];
  assert.ok(Math.abs(pos[first * 3] - 4000) < 4 * SPREAD + 0.1 && Math.abs(pos[first * 3 + 1] - (1 + LIFT)) < 1e-5);
  const before = pos[first * 3];
  assert.equal(run(), false, 'nothing more to do');
  origin.x = 4096;
  assert.equal(run(), true, 'written again from the new origin');
  assert.ok(Math.abs(pos[first * 3] - (before - 4096)) < 1e-3);
  assert.equal(g.drawRange.count, state.triangles * 3);
});
