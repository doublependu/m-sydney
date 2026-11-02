import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The surfaces laid on the ground: footpaths and lawns (js/ground-geometry.js). Ear clipping alone dropped a fifth of their
// points and left triangles the width of a park, metres under the ground: the base showed through them in dark wedges.
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { GroundCells, addSurface } = await import('../js/ground-geometry.js');
const { LAWNS, PAVEMENTS } = await import('../js/city-config.js');
const { groundHeight } = await import('../js/surfaces.js');

const ringArea = (r) => {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    a += p.x * q.z - q.x * p.z;
  }
  return Math.abs(a) / 2;
};
const triangles = (cells, each) => {
  for (const c of cells.cells.values()) {
    const P = c.position, I = c.index;
    for (let i = 0; i < I.length; i += 3) each(P, I[i] * 3, I[i + 1] * 3, I[i + 2] * 3);
  }
};
const planArea = (P, a, b, d) => Math.abs((P[b] - P[a]) * (P[d + 2] - P[a + 2]) - (P[b + 2] - P[a + 2]) * (P[d] - P[a])) / 2;

for (const [name, list] of [['footpaths', PAVEMENTS], ['lawns', LAWNS]]) {
  test(`${name} cover their whole area, with every point they keep in a triangle`, () => {
    for (const rings of list) {
      const cells = new GroundCells();
      addSurface(cells, rings, 0);
      let area = 0;
      triangles(cells, (P, a, b, d) => { area += planArea(P, a, b, d); });
      const want = ringArea(rings[0]) - rings.slice(1).reduce((sum, h) => sum + ringArea(h), 0);
      // Never short of it, which would show what's under it. A little over, where simplifying an outline makes it overlap itself, shows nothing.
      assert.ok(area - want > -Math.max(1, want * 0.01) && area - want < Math.max(1, want * 0.05), `${Math.round(area)} m2 of ${Math.round(want)} m2 at ${Math.round(rings[0][0].x)}, ${Math.round(rings[0][0].z)}`);
      for (const c of cells.cells.values()) {
        const used = new Set(c.index);
        assert.equal(used.size, c.position.length / 3, 'a point in no triangle');
      }
    }
  });

  test(`${name} face up and stay on the ground, not under it`, () => {
    const cells = new GroundCells();
    for (const rings of list) addSurface(cells, rings, 0);
    let total = 0, under = 0;
    triangles(cells, (P, a, b, d) => {
      // Up: the cross product of the edges points up the y axis
      const ux = P[b] - P[a], uz = P[b + 2] - P[a + 2], vx = P[d] - P[a], vz = P[d + 2] - P[a + 2];
      assert.ok(uz * vx - ux * vz >= -1e-6, 'a triangle facing down');
      const x = (P[a] + P[b] + P[d]) / 3, y = (P[a + 1] + P[b + 1] + P[d + 1]) / 3, z = (P[a + 2] + P[b + 2] + P[d + 2]) / 3;
      const area = planArea(P, a, b, d);
      total += area;
      if (groundHeight(x, z) - y > 0.5) under += area;
    });
    assert.ok(under / total < 0.015, `${((under / total) * 100).toFixed(1)}% of the area is over 0.5 m under the ground`);
  });
}
