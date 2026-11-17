import assert from 'node:assert/strict';
import test from 'node:test';
import { TILE, heldTiles, isHeld } from '../js/geodata.js';
import { groundHeight } from '../js/surfaces.js';
import { buildNear, drawnTop, drawnWhat, dropLayer, pathTop, setLayer } from '../js/drawn-ground.js';

// What the walker, the bike's wheels and the car's stand on (js/drawn-ground.js): the top of what's drawn on the ground, on real tiles. The
// Royal Botanic Garden's path and lawn and Macquarie St's footpath and road; a square of Woollahra's verges and driveways.

const held = (key) => heldTiles().some((t) => t.key === key);
const tileAt = (x, z) => heldTiles().find((t) => t.ix === Math.floor(x / TILE) && t.iz === Math.floor(z / TILE));
const built = (x, z) => {
  while (buildNear(x, z, 10));
  return drawnTop(x, z);
};

test('a garden\'s path, its lawn, a footpath\'s paving and the road, as each is drawn', { skip: !(held('1_-2') && held('0_-2')) && 'its tiles aren\'t held' }, async () => {
  const { buildTileGarden, lawnSurface, pavingSurface } = await import('../js/garden.js');
  // Each garden tile's paths, steps and beds, as its ground builds them
  for (const tile of heldTiles().filter((t) => t.garden)) {
    const it = buildTileGarden(tile, null, () => {});
    while (!it.next().done);
  }
  // Macquarie St's footpath: the paving's own triangles, 0.22 over them, which here lie 8 cm under the ground's height
  const footpath = built(389, -1000);
  assert.equal(drawnWhat(), 'paving');
  assert.ok(Math.abs(footpath - (pavingSurface(tileAt(389, -1000))(389, -1000) + 0.22)) < 1e-6, 'on the paving as drawn');
  assert.ok(footpath - groundHeight(389, -1000) < 0.2, 'under the paving\'s nominal height here');
  // Its road: nothing drawn over the ground
  assert.equal(built(397, -1000), null);
  // The garden's lawn, and an asphalt path over it: the path's top over the lawn as drawn by its lift, to within the bend of the lawn
  // between the ribbon's points (laid on the lawn's heights every 2 m along it and at its edges)
  const lawn = built(1101, -1003.2);
  assert.equal(drawnWhat(), 'lawn');
  assert.ok(Math.abs(lawn - (lawnSurface(tileAt(1101, -1003.2))(1101, -1003.2) + 0.24)) < 1e-6);
  const path = built(1097.3, -1003.2);
  assert.ok(drawnWhat().startsWith('garden:'), drawnWhat());
  const under = lawnSurface(tileAt(1097.3, -1003.2))(1097.3, -1003.2) + pathTop(0, 1);
  assert.ok(Math.abs(path - under) < 0.03 && path > lawn + 0.05, `the path ${path.toFixed(3)} against the lawn plus its lift ${under.toFixed(3)}`);
});

test('a strip\'s footpath and a driveway near you: what the lots handed over, the highest of it', { skip: !['3_0', '2_0', '3_-1', '2_-1'].every(isHeld) && 'its tiles aren\'t held' }, async () => {
  const { squareWorkNow, groundOf } = await import('../js/lot-details.js');
  const { squareLots } = await import('../js/house-lots.js');
  const { squareVerge } = await import('../js/verge.js');
  const SQUARE = { x0: 3000, z0: 0, x1: 3500, z1: 500 };
  const tiles = new Map(heldTiles().map((t) => [t.key, t]));
  const { entries, env } = squareWorkNow(SQUARE, tiles);
  const run = (job) => { let step = job.next(); while (!step.done) step = job.next(); return step.value; };
  const result = run(squareLots(entries, env, SQUARE));
  result.verge = run(squareVerge(result.fronting, env, SQUARE));
  const ground = groundOf(result);
  for (const [what, tris] of Object.entries(ground)) setLayer(`test:${what}`, tris);
  try {
    // A strip's footpath: the middle of one of its triangles
    const path = ground.path.find((t) => t.length >= 9);
    assert.ok(path, 'no strip with a footpath');
    const px = (path[0] + path[3] + path[6]) / 3, pz = (path[2] + path[5] + path[8]) / 3, py = (path[1] + path[4] + path[7]) / 3;
    const top = built(px, pz);
    assert.ok(top >= py - 1e-4 && top < py + 0.02, `the footpath at ${py.toFixed(3)}, the top ${top.toFixed(3)}`);
    // A driveway's slab: its middle
    const slab = result.slabs.find((s) => s.kind === 0);
    const slabTop = built(slab.x, slab.z);
    assert.equal(drawnWhat(), 'test:slabs');
    assert.ok(Math.abs(slabTop - slab.y) < 1e-4, `the slab's top ${slab.y.toFixed(3)}, the lookup's ${slabTop.toFixed(3)}`);
    // A layback, from the gutter up over the kerb: off the kerb's island, on the road, the car's wheel rides up it
    const lay = result.slabs.find((s) => s.kind === 2);
    const gutter = { x: lay.x - lay.ax * 0.4, z: lay.z - lay.az * 0.4 };
    assert.ok(built(gutter.x, gutter.z) !== null, 'nothing drawn at the layback');
  } finally {
    for (const what of ['lawn', 'path', 'slabs']) dropLayer(`test:${what}`);
  }
});

test('nothing stands on a triangle steeper than 45 degrees, or on one laid metres off the ground', { skip: !held('1_-2') && 'its tiles aren\'t held' }, () => {
  // On the garden's lawn: a steep ramp over it, and a platform 3 m up
  const x = 1101, z = -1003.2;
  const lawn = built(x, z);
  const g = groundHeight(x, z);
  setLayer('test:steep', new Float32Array([x - 1, g + 0.3, z - 1, x + 1, g + 2.8, z - 1, x - 1, g + 0.3, z + 1]));
  assert.equal(drawnTop(x - 0.5, z - 0.5), lawn === null ? null : drawnTop(x - 0.5, z - 0.5), 'the ramp is too steep to stand on');
  assert.notEqual(drawnWhat(), 'test:steep');
  dropLayer('test:steep');
  setLayer('test:high', new Float32Array([x - 1, g + 3.2, z - 1, x + 1, g + 3.2, z - 1, x - 1, g + 3.2, z + 1]));
  drawnTop(x - 0.5, z - 0.5);
  assert.notEqual(drawnWhat(), 'test:high', 'a platform 3 m over the ground isn\'t stood on');
  dropLayer('test:high');
  // Just over the lawn, it is
  setLayer('test:low', new Float32Array([x - 1, g + 0.6, z - 1, x + 1, g + 0.6, z - 1, x - 1, g + 0.6, z + 1]));
  drawnTop(x - 0.5, z - 0.5);
  assert.equal(drawnWhat(), 'test:low');
  dropLayer('test:low');
});
