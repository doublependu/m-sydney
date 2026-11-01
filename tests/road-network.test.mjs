import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
console.info = () => {};
const { buildRoadNetworkSteps } = await import('../js/road-network.js');
const { BRIDGE_LENGTH, bridgeAt } = await import('../js/bridge.js');
const steps = buildRoadNetworkSteps([], []);
let step;
do step = steps.next(); while (!step.done);
const { edges } = step.value;

const near = (x, z, radius) => edges.filter((e) => {
  const s = Math.max(0, Math.min(e.len, (x - e.sx) * e.dx + (z - e.sz) * e.dz));
  return Math.hypot(e.sx + e.dx * s - x, e.sz + e.dz * s - z) < radius;
});

// Traffic only exists on this network, so a place missing from it is empty of cars: it once ended at the CBD, with the
// bridge and everything north of it thrown away by the strongly connected filter, while every other check still passed.
test('traffic can reach both sides of the harbour', () => {
  assert.ok(edges.length > 5000, `${edges.length} edges`);
  for (const [name, x, z, least] of [['Town Hall', 3, 30, 80], ['The Rocks', -155, -1839, 30], ['North Sydney', -100, -3300, 40]]) {
    assert.ok(near(x, z, 350).length >= least, `${name}: ${near(x, z, 350).length} edges`);
  }
});

test('the Harbour Bridge carries traffic both ways, end to end', () => {
  const deck = edges.filter((e) => e.deck);
  assert.ok(deck.length >= 10, `${deck.length} deck edges`);
  for (const e of deck) assert.ok(e.moves.length > 0, `a deck edge leads nowhere at ${Math.round(e.sx)}, ${Math.round(e.sz)}`);
  const sides = new Set(deck.map((e) => Math.sign(e.dz)));
  assert.equal(sides.size, 2, 'both directions');
  assert.ok(Math.min(...deck.map((e) => e.sz)) < -3300 && Math.max(...deck.map((e) => e.sz)) > -1500, 'from The Rocks to North Sydney');
});

// The span curves gently, and a road only takes a node at a sharp bend: drawn as one 1,342 m chord, the deck's traffic ran
// 10.8 m off the bridge, so a driver keeping left by the bridge's centre line met it head on
test('deck traffic follows the bridge, not a chord across its curve', () => {
  for (const e of edges.filter((x) => x.deck)) {
    for (let t = 0; t <= e.len; t += 5) {
      const here = bridgeAt(e.sx + e.dx * t, e.sz + e.dz * t);
      // Within half a lane over the harbour and its approaches. Where the corridor turns onto the Pacific Hwy at its
      // north end, a 23 m road can't follow a corner that tight with edges long enough to keep (about 25 m): a lane.
      const limit = here && here.s > BRIDGE_LENGTH - 150 ? 4.5 : 2.5;
      assert.ok(here && Math.abs(here.off) < limit, `${here ? here.off.toFixed(1) : 'off the corridor'} m out at ${Math.round(e.sx)}, ${Math.round(e.sz)}`);
    }
  }
});

test('every edge kept has a way on and a way in', () => {
  const entered = new Set();
  for (const e of edges) for (const m of e.moves) entered.add(m.to);
  for (const e of edges) {
    assert.ok(e.moves.length, `dead end at ${Math.round(e.sx)}, ${Math.round(e.sz)}`);
    assert.ok(entered.has(e), `no way in at ${Math.round(e.sx)}, ${Math.round(e.sz)}`);
  }
});
