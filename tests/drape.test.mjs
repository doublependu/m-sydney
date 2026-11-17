import assert from 'node:assert/strict';
import test from 'node:test';
import { areaOf, drape, drapePolygon, triangulate } from '../js/drape.js';

// Laying things flat on the ground's triangles as drawn (js/drape.js): a garden's raised lawn and paths, the nature strips

// A folded surface: a 40 m square, its triangles bent along their shared edges, like ground laid on the height grid's nodes
const surface = [];
const hill = (x, z) => 0.3 * Math.sin(x / 7) + 0.2 * Math.cos(z / 5) + 0.01 * x;
for (let i = 0; i < 4; i++) {
  for (let j = 0; j < 4; j++) {
    const x0 = i * 10, z0 = j * 10, p = (x, z) => [x, hill(x, z), z];
    surface.push([p(x0, z0), p(x0 + 10, z0), p(x0 + 10, z0 + 10)], [p(x0, z0), p(x0 + 10, z0 + 10), p(x0, z0 + 10)]);
  }
}
const planeAt = (x, z) => {
  for (const [a, b, c] of surface) {
    const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d, l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
    if (l1 >= -1e-9 && l2 >= -1e-9 && 1 - l1 - l2 >= -1e-9) return l1 * a[1] + l2 * b[1] + (1 - l1 - l2) * c[1];
  }
  return null;
};
const trisOf = (out) => {
  const tris = [];
  for (let i = 0; i < out.length; i += 9) tris.push([0, 1, 2].map((k) => ({ x: out[i + k * 3], y: out[i + k * 3 + 1], z: out[i + k * 3 + 2] })));
  return tris;
};
const inside = (rings, x, z) => {
  let k = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i], b = r[j];
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) k = !k;
    }
  }
  return k;
};
const nearEdge = (rings, x, z) => rings.some((r) => r.some((a, i) => {
  const b = r[(i + 1) % r.length], dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1e-12;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2));
  return Math.hypot(a.x + dx * t - x, a.z + dz * t - z) < 1e-4;
}));
/** Over a grid of points in the box: how many laid triangles hold each, inside the rings and out of them */
function coverage(tris, rings, step = 0.3719) {
  const count = { missing: 0, once: 0, more: 0, outside: 0 };
  // Off the surface's lines and its triangles' diagonals, so no point is on an edge
  for (let i = 0; i * step < 40; i++) {
    for (let j = 0; j * step < 40; j++) {
      const x = 0.0731 + i * step, z = 0.1597 + j * step;
      if (nearEdge(rings, x, z)) continue;
      const n = tris.filter(([a, b, c]) => {
        const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
        const l1 = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / d, l2 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d;
        return l1 > 1e-7 && l2 > 1e-7 && 1 - l1 - l2 > 1e-7;
      }).length;
      if (inside(rings, x, z)) count[n === 0 ? 'missing' : n === 1 ? 'once' : 'more']++;
      else if (n) count.outside++;
    }
  }
  return count;
}

test('a polygon with holes laid on a folded surface: all of it, once, in each triangle\'s plane, facing up', () => {
  // A lawn between paths: an outline that isn't convex, a pond in it and a hole across a fold
  const rings = [
    [{ x: 2, z: 3 }, { x: 37, z: 1.5 }, { x: 38, z: 22 }, { x: 21, z: 18 }, { x: 24, z: 37 }, { x: 3, z: 38 }],
    [{ x: 6, z: 6 }, { x: 9, z: 6.5 }, { x: 8, z: 9 }],
    [{ x: 13, z: 11 }, { x: 27, z: 9 }, { x: 25, z: 15 }, { x: 14, z: 14 }]
  ];
  const out = [];
  const n = drapePolygon(rings, surface, 0.32, out, 0, 0);
  const tris = trisOf(out);
  assert.equal(n, tris.length);
  const c = coverage(tris, rings);
  assert.equal(c.missing, 0, 'part of it not laid');
  assert.equal(c.more, 0, 'part of it laid twice');
  assert.equal(c.outside, 0, 'laid outside it, or over a hole');
  for (const t of tris) {
    assert.ok(areaOf(t) > 0, 'a triangle facing down');
    const mx = (t[0].x + t[1].x + t[2].x) / 3, mz = (t[0].z + t[1].z + t[2].z) / 3, my = (t[0].y + t[1].y + t[2].y) / 3;
    assert.ok(Math.abs(my - (planeAt(mx, mz) + 0.32)) < 1e-6, `off the surface at (${mx.toFixed(2)}, ${mz.toFixed(2)})`);
  }
  // A surface triangle it covers whole is laid as one triangle: about as many as the surface and its own outline, not the two multiplied
  assert.ok(tris.length < 120, `${tris.length} triangles`);
});

test('a ring that repeats its first point at its end is laid as it is', () => {
  const rings = [[{ x: 5, z: 5 }, { x: 30, z: 5 }, { x: 30, z: 30 }, { x: 5, z: 30 }, { x: 5, z: 5 }], [{ x: 12, z: 12 }, { x: 20, z: 12 }, { x: 16, z: 20 }]];
  const faces = triangulate(rings);
  const area = faces.reduce((t, f) => t + Math.abs(areaOf(f)) / 2, 0);
  assert.ok(Math.abs(area - (625 - 32)) < 1e-6, `${area} m²`);
  const out = [];
  drapePolygon(rings, surface, 0, out, 0, 0);
  const c = coverage(trisOf(out), [rings[0].slice(0, -1), rings[1]]);
  assert.equal(c.missing + c.more + c.outside, 0, JSON.stringify(c));
});

test('a flat piece laid on the surface: cut to each triangle under it, in its plane', () => {
  const quad = [{ x: 3, z: 4 }, { x: 33, z: 9 }, { x: 32, z: 12 }, { x: 2, z: 7 }];
  const out = [];
  drape(quad, surface, 0.0175, out, 0, 0);
  const tris = trisOf(out);
  const c = coverage(tris, [quad], 0.2113);
  assert.equal(c.missing + c.more + c.outside, 0, JSON.stringify(c));
  for (const t of tris) {
    for (const p of t) assert.ok(Math.abs(p.y - (planeAt(p.x, p.z) + 0.0175)) < 1e-6);
  }
});
