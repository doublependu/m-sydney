import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { dataPath, fromWorld, load, toWorld } from '../tools/geo-common.mjs';
import { editWays, localAreas, localMoves, moveNodes } from '../tools/local-edits.mjs';

// Roads OSM draws overlapping, moved by hand (tools/local/*.json move): each of a way's nodes to a point, checked against OSM

// OSM's elements at points in the game's frame
const way = (id, nodes, pts, tags = { highway: 'primary' }) => ({ type: 'way', id, nodes, tags, geometry: pts.map(([x, z]) => { const [lon, lat] = fromWorld(x, z); return { lon, lat }; }) });
const at = (e) => e.geometry.map((g) => toWorld(g.lon, g.lat).map((v) => Math.round(v * 100) / 100 + 0));
const area = (move) => [{ file: 'test.json', name: 'test', box: [-100, -100, 100, 100], move }];

test('a move puts each node of its way where it says, and every way through a moved node goes with it', () => {
  // A street along z = 0 and a side street joining it at (50, 0), with a crossing on it at (20, 0)
  const street = way(1, [11, 12, 13, 14], [[0, 0], [20, 0], [50, 0], [80, 0]]);
  const side = way(2, [13, 21], [[50, 0], [50, 40]]);
  const [lon, lat] = fromWorld(20, 0);
  const crossing = { type: 'node', id: 12, lon, lat, tags: { highway: 'crossing' } };
  const move = { id: 1, points: [[0, 0], [20, -2], [50, -2], [80, 0]], expect: { from: [0, 0], to: [80, 0] }, why: 'a test' };
  const elements = [street, side];
  const moved = localMoves(elements, area([move]));
  assert.deepEqual([...moved.keys()], [12, 13], 'the nodes left where OSM has them are not moved');
  assert.equal(moveNodes(elements, moved), 3);
  assert.deepEqual(at(street), [[0, 0], [20, -2], [50, -2], [80, 0]]);
  assert.deepEqual(at(side), [[50, -2], [50, 40]], 'the junction takes the side street with it');
  moveNodes([crossing], moved);
  assert.deepEqual(toWorld(crossing.lon, crossing.lat).map((v) => Math.round(v * 100) / 100), [20, -2], 'and a crossing on the street');
  // A second edit moving the junction agrees with the first, to 5 cm
  const both = localMoves([way(1, [11, 12, 13, 14], [[0, 0], [20, 0], [50, 0], [80, 0]]), way(2, [13, 21], [[50, 0], [50, 40]])],
    area([move, { id: 2, points: [[50, -2.03], [50, 40]], expect: { from: [50, 0], to: [50, 40] }, why: 'the side street' }]));
  assert.equal(both.size, 2);
});

test('a move stops the build where OSM has changed since it was made', () => {
  const fresh = () => [way(1, [11, 12, 13], [[0, 0], [20, 0], [50, 0]]), way(2, [13, 21], [[50, 0], [50, 40]])];
  const move = { id: 1, points: [[0, 0], [20, -2], [50, 0]], expect: { from: [0, 0], to: [50, 0] }, why: 'a test' };
  assert.equal(localMoves(fresh(), area([move])).size, 1);
  assert.throws(() => localMoves(fresh().slice(1), area([move])), /way 1 .* is gone from the snapshot/);
  // A node added to the way, or one taken out
  assert.throws(() => localMoves([way(1, [11, 12, 15, 13], [[0, 0], [20, 0], [30, 0], [50, 0]])], area([move])), /4 nodes on it now and the edit 3 points/);
  // Its ends somewhere else
  assert.throws(() => localMoves([way(1, [11, 12, 13], [[0, 0], [20, 0], [52, 0]])], area([move])), /its last node is at \(52\.0, -?0\.0\) in OSM now, 2\.0 m from/);
  assert.throws(() => localMoves(fresh(), area([{ ...move, expect: undefined }])), /needs expect/);
  // Two edits moving one node to different places
  const other = { id: 2, points: [[50, 3], [50, 40]], expect: { from: [50, 0], to: [50, 40] }, why: 'the other' };
  assert.throws(() => localMoves(fresh(), area([{ ...move, points: [[0, 0], [20, -2], [50, -1]] }, other])), /moves node 13 to \(50, 3\)/);
});

test('editWays moves the ways with its other edits, and says how many nodes', () => {
  const elements = [way(1, [11, 12, 13], [[0, 0], [20, 0], [50, 0]]), way(2, [13, 21], [[50, 0], [50, 40]])];
  const areas = [{ file: 'test.json', name: 'test', box: [-100, -100, 100, 100], ways: [{ ids: [2], tags: { lanes: '2' }, why: 'lanes' }], move: [{ id: 1, points: [[0, 0], [20, -2], [50, -2]], expect: { from: [0, 0], to: [50, 0] }, why: 'a test' }] }];
  const edited = editWays(elements, areas);
  assert.match(edited.summary, /1 ways edited by hand, 0 taken out, 2 nodes moved/);
  assert.equal(edited.moved.size, 2);
  assert.deepEqual(at(edited.elements[1]), [[50, -2], [50, 40]]);
  assert.equal(edited.elements[1].tags.lanes, '2');
});

const SNAPSHOT = fs.existsSync(dataPath('all_roads.json'));
test('every move in tools/local/ matches today\'s snapshot and stays in its area\'s box', { skip: !SNAPSHOT && 'no OSM snapshot' }, () => {
  const areas = localAreas().filter((a) => a.move);
  assert.ok(areas.length);
  const roads = load('all_roads.json').elements.filter((e) => e.type === 'way' && e.geometry);
  const moved = localMoves(roads, areas);
  assert.ok(moved.size);
  // Each node it moves inside its area's box, and by a few metres at most: the edits move a road off another, not somewhere new
  const byId = new Map(roads.map((w) => [w.id, w]));
  for (const a of areas) {
    assert.ok(a.box, `${a.file} has a box, for tools/tile-diff.mjs`);
    for (const m of a.move) {
      assert.ok(m.why, `${a.file}: way ${m.id} says why`);
      const w = byId.get(m.id);
      w.nodes.forEach((n, i) => {
        const [ox, oz] = toWorld(w.geometry[i].lon, w.geometry[i].lat), [x, z] = m.points[i], d = Math.hypot(x - ox, z - oz);
        if (d < 0.02) return;
        assert.ok(x >= a.box[0] && x <= a.box[2] && z >= a.box[1] && z <= a.box[3], `${a.file}: way ${m.id}'s node ${n} moves to (${x}, ${z}), outside its box`);
        assert.ok(d < 7, `${a.file}: way ${m.id}'s node ${n} moves ${d.toFixed(1)} m`);
      });
    }
  }
});
