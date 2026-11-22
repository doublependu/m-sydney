import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { localCovers } from '../tools/local-edits.mjs';

// Covers drawn by hand over tunnels (tools/local/*.json `cover`: a land bridge, a lid), read when the tiles are made: a tunnel is under
// cover inside the ring whatever the ground over it (openTunnels(), js/surfaces.js). On made-up roads, not the map's.
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { KIND, openTunnels, tunnelCovered } = await import('../js/surfaces.js');

// A street from x -50 to 0, a tunnel on to x 200 a few metres under it, and a street on to x 250: each as the map's links are
const road = (id, a, b, xs, kind = KIND.GROUND) => ({ id, a, b, kind, openCutting: false, pts: xs.map((x) => ({ x, z: 0, y: kind ? -3 : NaN })) });
const made = () => [road(1, 1, 2, [-50, 0]), road(2, 2, 3, [0, 100, 200], KIND.TUNNEL), road(3, 3, 4, [200, 250])];
const tube = (links) => links.find((l) => l.kind === KIND.TUNNEL);
const box = (x0, x1) => [[x0, -20], [x1, -20], [x1, 20], [x0, 20]];
const shallow = () => false; // the ground never 6.3 m over its road

test('a shallow tunnel is open all along, and covered inside a ring drawn over it, from where its road goes under the ring', () => {
  const open = tube(openTunnels(made(), [], shallow));
  assert.equal(open.length, 200);
  for (const s of [0, 50, 100, 150, 200]) assert.equal(tunnelCovered(open, s), false, `open at ${s} m with no ring`);
  const lid = tube(openTunnels(made(), [box(49, 151)], shallow));
  assert.deepEqual([lid.openA, lid.openB], [50, 50], 'open from each mouth to the ring\'s edge');
  for (const s of [60, 100, 140]) assert.equal(tunnelCovered(lid, s), true, `covered at ${s} m`);
  for (const s of [10, 40, 160, 190]) assert.equal(tunnelCovered(lid, s), false, `open at ${s} m`);
});

test('a tunnel whose end is under a ring keeps a metre open at its node, for its mouth', () => {
  const end = tube(openTunnels(made(), [box(149, 260)], shallow));
  assert.deepEqual([end.openA, end.openB], [150, 1]);
  assert.equal(tunnelCovered(end, 198), true);
});

test('a ring over a stretch the ground already covers changes nothing', () => {
  const deep = (x) => x > 20 && x < 180; // 6.3 m of ground over it from 20 m in at each end
  const without = tube(openTunnels(made(), [], deep)), withRing = tube(openTunnels(made(), [box(60, 140)], deep));
  assert.deepEqual([withRing.openA, withRing.openB], [without.openA, without.openB]);
  assert.deepEqual([without.openA, without.openB], [22, 22]);
  // ...nor one beside the tunnel, off its road
  const beside = tube(openTunnels(made(), [[[50, 10], [150, 10], [150, 30], [50, 30]]], shallow));
  assert.equal(tunnelCovered(beside, 100), false, 'open all along');
});

test('each cover in tools/local/ is a ring with a why and a top of a few metres at most, and the build stops on one that isn\'t', () => {
  const covers = localCovers();
  assert.ok(covers.some((c) => c.file === 'art-gallery.json'), 'Naala Badu\'s land bridge');
  for (const c of covers) assert.ok(c.ring.length >= 3 && c.why);
  const area = (cover) => [{ file: 'test.json', name: 'test', box: [0, 0, 1, 1], cover }];
  assert.throws(() => localCovers(area([{ ring: [[0, 0], [1, 0]], why: 'a test' }])), /3 or more points/);
  assert.throws(() => localCovers(area([{ ring: [[0, 0], [1, 0], [1, 1]] }])), /needs a why/);
  assert.throws(() => localCovers(area([{ ring: [[0, 0], [1, 0], [1, 1]], top: 8, why: 'a test' }])), /its top is m over a tube's ceiling/);
  assert.deepEqual(localCovers(area([{ ring: [[0, 0], [1, 0], [1, 1]], why: 'a test' }])).map((c) => c.top), [0]);
  assert.deepEqual(localCovers(area([{ ring: [[0, 0], [1, 0], [1, 1]], top: 0.3, why: 'a test' }])).map((c) => c.top), [0.3]);
});
