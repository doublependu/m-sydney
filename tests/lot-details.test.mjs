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
