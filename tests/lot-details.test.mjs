import assert from 'node:assert/strict';
import test from 'node:test';
import { heldTiles, isHeld } from '../js/geodata.js';
import { insideSpans, squareLots } from '../js/house-lots.js';
import { squareWorkNow as squareWork, tilesFor } from '../js/lot-details.js';

// Houses' lots as the game works them out from the map (js/lot-details.js squareWork()), on a square of Woollahra's houses, east of the
// inner city's paving, where the map draws lawns: no fence through a building, none on a footpath, each house inside its lot.
const SQUARE = { x0: 3000, z0: 0, x1: 3500, z1: 500 };

test('the lots of a square of Woollahra: fences off the buildings and the footpaths, each house in its lot', { skip: !tilesFor(SQUARE).every(isHeld) && 'its tiles aren\'t held' }, () => {
  const tiles = new Map(heldTiles().map((t) => [t.key, t]));
  const { entries, env } = squareWork(SQUARE, tiles);
  const job = squareLots(entries, env, SQUARE);
  let step = job.next();
  while (!step.done) step = job.next();
  const { lots, fences, slabs } = step.value;
  assert.ok(lots.length > 50 && fences.length > 50 && slabs.length > 10, `${lots.length} lots, ${fences.length} fences, ${slabs.length} slabs`);
  const rings = entries.flatMap(({ b }) => b.polygons.map((p) => p.outer));
  let metres = 0;
  for (const f of fences) {
    const L = Math.hypot(f.b.x - f.a.x, f.b.z - f.a.z);
    metres += L;
    const near = rings.filter((r) => r.some((p) => Math.abs(p.x - f.a.x) < L + 40 && Math.abs(p.z - f.a.z) < L + 40));
    const inside = insideSpans(f.a, f.b, near).reduce((sum, [t0, t1]) => sum + (t1 - t0) * L, 0);
    assert.ok(inside < 0.01, `a fence from (${f.a.x.toFixed(1)}, ${f.a.z.toFixed(1)}) goes ${inside.toFixed(2)} m through a building`);
    // Every half metre of it on the lawn, not the footpath
    let off = 0;
    for (let s = 0.25; s < L - 0.2; s += 0.5) if (!env.onLawn(f.a.x + ((f.b.x - f.a.x) * s) / L, f.a.z + ((f.b.z - f.a.z) * s) / L)) off++;
    assert.ok(off <= 1, `a fence from (${f.a.x.toFixed(1)}, ${f.a.z.toFixed(1)}) has ${off} half metres on the footpath`);
  }
  assert.ok(metres > 1000, `${Math.round(metres)} m of fences`);
  for (const lot of lots) {
    let inside = false;
    for (let i = 0, j = lot.pts.length - 1; i < lot.pts.length; j = i++) {
      const a = lot.pts[i], b = lot.pts[j];
      if ((a.z > lot.home.cz) !== (b.z > lot.home.cz) && lot.home.cx < ((b.x - a.x) * (lot.home.cz - a.z)) / (b.z - a.z) + a.x) inside = !inside;
    }
    assert.ok(inside, `the house at (${lot.home.cx.toFixed(1)}, ${lot.home.cz.toFixed(1)}) is in its lot`);
  }
});

// The same square's verges (js/verge.js) and the lots' things (js/lot-things.js): every bit of the strips over the paving as drawn, the
// highest of it where two pieces overlap, and the footpath over the front yards' lawn where that comes out over it; nothing of a lot's
// things inside a building
test('the verges of a square of Woollahra lie over its paving, and the lots\' things stand out of the buildings', { skip: !tilesFor(SQUARE).every(isHeld) && 'its tiles aren\'t held' }, async () => {
  const { squareVerge } = await import('../js/verge.js');
  const tiles = new Map(heldTiles().map((t) => [t.key, t]));
  const { entries, env } = squareWork(SQUARE, tiles);
  const run = (job) => { let step = job.next(); while (!step.done) step = job.next(); return step.value; };
  const result = run(squareLots(entries, env, SQUARE));
  const verge = run(squareVerge(result.fronting, env, SQUARE));
  assert.ok(verge.sides.some((s) => s.strip), 'some sides have a nature strip');
  const height = (t, x, z) => {
    const [a, b, c] = t, d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d, l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
    return l1 >= -1e-6 && l2 >= -1e-6 && 1 - l1 - l2 >= -1e-6 ? l1 * a[1] + l2 * b[1] + (1 - l1 - l2) * c[1] : null;
  };
  const top = (tris, x, z) => Math.max(-Infinity, ...tris.map((t) => height(t, x, z)).filter((y) => y !== null));
  const all = [];
  for (const c of [...verge.lawn, ...verge.path]) for (let i = 0; i < c.pos.length; i += 9) all.push([0, 3, 6].map((k) => [c.pos[i + k] + c.x, c.pos[i + k + 1], c.pos[i + k + 2] + c.z]));
  assert.ok(all.length > 500, `${all.length} triangles of verge`);
  let checked = 0;
  for (let i = 0; i < all.length; i += 7) {
    const t = all[i], x = (t[0][0] + t[1][0] + t[2][0]) / 3, z = (t[0][2] + t[1][2] + t[2][2]) / 3;
    const paving = top(env.pavingTris(x - 0.01, z - 0.01, x + 0.01, z + 0.01), x, z);
    if (paving === -Infinity) continue;
    const near = all.filter((u) => Math.abs(u[0][0] - x) < 12 && Math.abs(u[0][2] - z) < 12);
    assert.ok(top(near, x, z) - (paving + 0.22) >= 0.009, `the verge at (${x.toFixed(1)}, ${z.toFixed(1)}) is over the paving`);
    checked++;
  }
  assert.ok(checked > 50);
  const rings = entries.flatMap(({ b }) => b.polygons.map((p) => p.outer));
  const inside = (ring, x, z) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) c = !c;
    }
    return c;
  };
  assert.ok(result.things.length > 100, `${result.things.length} things`);
  for (const b of result.things) assert.ok(!rings.some((r) => inside(r, b.x, b.z)), `a thing at (${b.x.toFixed(1)}, ${b.z.toFixed(1)}) is out of the buildings`);
});
