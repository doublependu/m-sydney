import assert from 'node:assert/strict';
import test from 'node:test';

const { Raster, ringArea, tiledPolygons } = await import('../tools/geo-common.mjs');

// The area a list of pieces covers more than once, and the area it covers at all, counted on a 0.25 m grid
function coverage(pieces, x0, z0, x1, z1) {
  const inRing = (r, x, z) => {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if ((r[i][1] > z) !== (r[j][1] > z) && x < ((r[j][0] - r[i][0]) * (z - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
    }
    return inside;
  };
  let once = 0, twice = 0;
  for (let x = x0 + 0.125; x < x1; x += 0.25) {
    for (let z = z0 + 0.125; z < z1; z += 0.25) {
      const n = pieces.filter(([outer, ...holes]) => inRing(outer, x, z) && !holes.some((h) => inRing(h, x, z))).length;
      if (n) once += 0.0625;
      if (n > 1) twice += 0.0625;
    }
  }
  return { once, twice };
}

test('a raster cut into squares comes back with no strip along the seams drawn twice, and no gap', () => {
  // 100 x 100 m at 1 m, in 40 m squares, with a 10 m hole across the seam at x = 40
  const raster = new Raster(0, 0, 99, 99, 1);
  for (let j = 0; j < 100; j++) for (let i = 0; i < 100; i++) raster.d[j * raster.w + i] = 1;
  for (let j = 20; j < 30; j++) for (let i = 35; i < 45; i++) raster.d[j * raster.w + i] = 0;
  const pieces = tiledPolygons(raster, 40, 0.5, 6, 6);
  assert.ok(pieces.length >= 9, `${pieces.length} pieces`);
  for (const [outer] of pieces) {
    const xs = outer.map((p) => p[0]), zs = outer.map((p) => p[1]);
    // Each within its own square
    assert.ok(Math.max(...xs) - Math.min(...xs) <= 40 + 1e-9 && Math.max(...zs) - Math.min(...zs) <= 40 + 1e-9, 'a piece past its square');
  }
  const { once, twice } = coverage(pieces, 0, 0, 100, 100);
  assert.equal(twice, 0, `${twice} m² drawn twice`);
  // The whole raster but the hole, to within the outline's own smoothing at the hole's corners
  const area = pieces.reduce((t, [outer, ...holes]) => t + Math.abs(ringArea(outer)) - holes.reduce((u, h) => u + Math.abs(ringArea(h)), 0), 0);
  assert.ok(Math.abs(once - 9900) < 30 && Math.abs(area - 9900) < 30, `covered ${once} m², ${area.toFixed(0)} m² by the rings, of 9900`);
});

test('a shape a square\'s edge cuts in two comes back as two pieces, which triangulate to their own area', async () => {
  const { ShapeUtils, Vector2 } = await import('three');
  // A U across the seam at x = 40, its arms joined just past it, where a square's tracing still reaches; and a hole across the seam at
  // z = 80
  const raster = new Raster(0, 0, 99, 99, 1);
  const fill = (i0, j0, i1, j1, v = 1) => { for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) raster.d[j * raster.w + i] = v; };
  fill(20, 10, 60, 18); // the U's arms, from x = 20 to 60
  fill(20, 22, 60, 30);
  fill(41, 10, 43, 30); // joined at x 41-42
  fill(5, 60, 35, 95);
  fill(15, 76, 25, 84, 0); // a hole across z = 80
  const filled = raster.d.reduce((t, v) => t + v, 0);
  const pieces = tiledPolygons(raster, 40, 0.5, 6, 6);
  let total = 0;
  for (const [outer, ...holes] of pieces) {
    const want = Math.abs(ringArea(outer)) - holes.reduce((t, h) => t + Math.abs(ringArea(h)), 0);
    const v2 = (r) => r.map(([x, z]) => new Vector2(x, z));
    const all = [...outer, ...holes.flat()];
    let got = 0;
    for (const [a, b, c] of ShapeUtils.triangulateShape(v2(outer), holes.map(v2))) {
      got += Math.abs((all[b][0] - all[a][0]) * (all[c][1] - all[a][1]) - (all[b][1] - all[a][1]) * (all[c][0] - all[a][0])) / 2;
    }
    assert.ok(Math.abs(got - want) < Math.max(0.5, want * 0.005), `a piece at ${outer[0]} triangulates to ${got.toFixed(1)} m², not ${want.toFixed(1)}`);
    total += want;
  }
  // The arms: in the first square, apart
  const arms = pieces.filter(([o]) => Math.max(...o.map((p) => p[0])) <= 40 && Math.min(...o.map((p) => p[1])) >= 10 && Math.max(...o.map((p) => p[1])) <= 30);
  assert.equal(arms.length, 2, `${arms.length} pieces for the U's two arms in the first square`);
  assert.ok(Math.abs(total - filled) < 25, `${total.toFixed(0)} m² of ${filled}`);
  const { twice } = coverage(pieces, 0, 0, 100, 100);
  assert.equal(twice, 0, `${twice} m² drawn twice`);
});

test('a footpath beside a square\'s edge, only touching it from outside, takes nothing of the square', async () => {
  const { ShapeUtils, Vector2 } = await import('three');
  // A strip from x = 40 to 45 (in the next square, where the first square's tracing still reaches) and a piece in the first square
  // that runs along x = 40 from the inside, then meets the strip only at that line
  const raster = new Raster(0, 0, 99, 99, 1);
  const fill = (i0, j0, i1, j1) => { for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) raster.d[j * raster.w + i] = 1; };
  fill(40, 0, 45, 40); // the strip, along the seam's far side
  fill(30, 10, 40, 14); // meeting it from inside the first square
  fill(10, 20, 20, 30); // apart
  const filled = raster.d.reduce((t, v) => t + v, 0);
  const pieces = tiledPolygons(raster, 40, 0.5, 6, 6);
  let total = 0;
  for (const [outer, ...holes] of pieces) {
    const want = Math.abs(ringArea(outer)) - holes.reduce((t, h) => t + Math.abs(ringArea(h)), 0);
    const all = [...outer, ...holes.flat()];
    let got = 0;
    for (const [a, b, c] of ShapeUtils.triangulateShape(outer.map(([x, z]) => new Vector2(x, z)), holes.map((h) => h.map(([x, z]) => new Vector2(x, z))))) {
      got += Math.abs((all[b][0] - all[a][0]) * (all[c][1] - all[a][1]) - (all[b][1] - all[a][1]) * (all[c][0] - all[a][0])) / 2;
    }
    assert.ok(Math.abs(got - want) < Math.max(0.5, want * 0.005), `a piece at ${outer[0]} triangulates to ${got.toFixed(1)} m², not ${want.toFixed(1)}`);
    total += want;
  }
  assert.ok(Math.abs(total - filled) < 6, `${total.toFixed(0)} m² of ${filled}`);
  assert.equal(coverage(pieces, 0, 0, 100, 100).twice, 0);
});
