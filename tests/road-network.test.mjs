import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
console.info = () => {};
const { buildRoadNetworkSteps } = await import('../js/road-network.js');
const { BRIDGE_LENGTH, DECK_REACH, bridgeAt, onDeckSpan } = await import('../js/bridge.js');
const { linkById } = await import('../js/surfaces.js');
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
// 10.8 m off the bridge, so a driver keeping left by the bridge's centre line met it head on. The deck carries OSM's own
// carriageways side by side now (plan 5): each one's traffic keeps to its own road, and to the deck
const offLine = (pts, x, z) => {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], L2 = (b.x - a.x) ** 2 + (b.z - a.z) ** 2 || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * (b.x - a.x) + (z - a.z) * (b.z - a.z)) / L2));
    best = Math.min(best, Math.hypot(a.x + (b.x - a.x) * t - x, a.z + (b.z - a.z) * t - z));
  }
  return best;
};
test('deck traffic follows its own road on the bridge, not a chord across its curve', () => {
  for (const e of edges.filter((x) => x.deck)) {
    const road = linkById.get(e.link);
    for (let t = 0; t <= e.len; t += 5) {
      const x = e.sx + e.dx * t, z = e.sz + e.dz * t;
      const here = bridgeAt(x, z, DECK_REACH);
      // Within half a lane over the harbour and its approaches. Where the corridor turns onto the Pacific Hwy at its
      // north end, a road can't follow a corner that tight with edges long enough to keep (about 25 m): a lane. So too
      // by a junction, whose nodes a few metres apart are one (js/road-network.js, links under 14 m)
      const ends = [road.pts[0], road.pts[road.pts.length - 1]];
      const byJunction = ends.some((p) => Math.hypot(p.x - x, p.z - z) < 25);
      const limit = (here && here.s > BRIDGE_LENGTH - 150) || byJunction ? 4.5 : 2.5;
      const off = offLine(road.pts, x, z);
      assert.ok(off < limit, `${off.toFixed(1)} m off ${road.name} at ${Math.round(x)}, ${Math.round(z)}`);
      assert.ok(onDeckSpan(x, z, 1), `${road.name} off the deck at ${Math.round(x)}, ${Math.round(z)}`);
    }
  }
});

// The two main ways up from the city, the Western Distributor and the Clarence St ramp, meet and run on to where the corridor's first
// way becomes the bridge's four lanes (OSM 1097892516). Plan 5 dropped that last stretch as running along the bridge: both ended in
// the air, and traffic lost them to the strongly connected filter
test('the Western Distributor and the Clarence St ramp lead onto the bridge', () => {
  const up = (name) => edges.filter((e) => e.dz < 0 && linkById.get(e.link)?.name === name && Math.hypot(e.sx - -285, e.sz - -1450) < 80);
  assert.ok(up('Western Distributor').length, 'the Western Distributor northbound, short of the bridge');
  assert.ok(up('Bradfield Highway Onramp').length, 'the Clarence St ramp, short of the bridge');
});

test('every edge kept has a way on and a way in', () => {
  const entered = new Set();
  for (const e of edges) for (const m of e.moves) entered.add(m.to);
  for (const e of edges) {
    assert.ok(e.moves.length, `dead end at ${Math.round(e.sx)}, ${Math.round(e.sz)}`);
    assert.ok(entered.has(e), `no way in at ${Math.round(e.sx)}, ${Math.round(e.sz)}`);
  }
});
