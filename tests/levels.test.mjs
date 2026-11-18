import assert from 'node:assert/strict';
import test from 'node:test';
import { LEVELS, levelSamples } from '../tools/heights/levels.mjs';
import { localAreas, localLevels } from '../tools/local-edits.mjs';

// Long sections given by hand (tools/local/*.json levels), matched to the roads tools/build-heights.mjs works out from OSM
// (tools/heights/levels.mjs) and checked against OSM by tools/local-edits.mjs

// Roads as build-heights samples them: points every 5 m along each, the samples shared where two meet
function network(roads) {
  const samples = [], nbr = [], at = new Map();
  const node = (key, x, z) => {
    if (!at.has(key)) { at.set(key, samples.length); samples.push({ x, z }); nbr.push([]); }
    return at.get(key);
  };
  const links = roads.map(({ pts, structure = true }) => {
    const chain = [node(pts[0].join(), ...pts[0])];
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i], L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 5));
      for (let k = 1; k <= n; k++) {
        const idx = i === pts.length - 1 && k === n ? node(pts[i].join(), bx, bz) : (samples.push({ x: ax + ((bx - ax) * k) / n, z: az + ((bz - az) * k) / n }), nbr.push([]), samples.length - 1);
        const prev = chain[chain.length - 1];
        nbr[prev].push([idx, L / n]);
        nbr[idx].push([prev, L / n]);
        chain.push(idx);
      }
    }
    return { pts, chain, structure };
  });
  return { samples, links, nbr };
}

test('a level fixes every point of its road between its first and last point, at a straight grade between each two', () => {
  // A tunnel 200 m long in two links, and a street it crosses under
  const net = network([{ pts: [[0, 0], [100, 0]] }, { pts: [[100, 0], [200, 0]] }, { pts: [[50, -50], [50, 50]], structure: false }]);
  const level = { name: 'test', ways: [[[0, 0], [200, 0]]], at: [[20, 0.5, -2], [120, 0, -10], [180, -0.5, -10]] };
  const given = levelSamples([level], net);
  for (const [idx, y] of given) {
    const { x, z } = net.samples[idx];
    assert.equal(z, 0, 'only the tunnel');
    assert.ok(x >= 20 - 1e-9 && x <= 180 + 1e-9, `${x} is outside the level`);
    const want = x <= 120 ? -2 - (8 * (x - 20)) / 100 : -10;
    assert.ok(Math.abs(y - want) < 1e-9, `${y} at ${x}, not ${want}`);
  }
  assert.equal(given.size, 33); // 20 to 180 m, every 5 m
});

test('two levels that meet at a node must give it the same height', () => {
  const net = network([{ pts: [[0, 0], [100, 0]] }, { pts: [[100, 0], [100, 100]] }]);
  const a = { name: 'a', ways: [[[0, 0], [100, 0]]], at: [[50, 0, 0], [100, 0, -4]] };
  const b = { name: 'b', ways: [[[100, 0], [100, 100]]], at: [[100, 0, -4], [100, 50, -6]] };
  assert.equal(levelSamples([a, b], net).size, 21); // 11 along each, the node shared
  assert.throws(() => levelSamples([a, { ...b, at: [[100, 0, -3], [100, 50, -6]] }], net), /another level/);
});

test('a level stops the build when its points are off its tunnel or bridge, or out of order', () => {
  const net = network([{ pts: [[0, 0], [100, 0]] }, { pts: [[100, 0], [200, 0]], structure: false }]);
  const ways = [[[0, 0], [100, 0]]];
  assert.throws(() => levelSamples([{ name: 'off', ways, at: [[50, LEVELS.NEAR + 1, 0], [90, 0, 0]] }], net), /from its road/);
  assert.throws(() => levelSamples([{ name: 'order', ways, at: [[60, 0, 0], [20, 0, 0], [90, 0, 0]] }], net), /order|back on itself/);
  // Where the way comes out onto the ground, the level has no road to fix
  assert.throws(() => levelSamples([{ name: 'ground', ways: [[[0, 0], [200, 0]]], at: [[50, 0, 0], [150, 0, 0]] }], net), /from its road/);
  assert.equal(levelSamples([{ name: 'short of it', ways: [[[0, 0], [200, 0]]], at: [[50, 0, 0], [90, 0, -2]] }], net).size, 9);
  assert.throws(() => levelSamples([{ name: 'none', ways: [[[0, 500], [100, 500]]], at: [[50, 500, 0]] }], net), /no tunnel or bridge/);
});

test('tools/local-edits.mjs checks a level against OSM: its ways, their tags and its points on them', () => {
  const toWorld = (lon, lat) => [lon, lat];
  const way = (id, tags, pts) => ({ id, tags, geometry: pts.map(([lon, lat]) => ({ lon, lat })) });
  const edit = { ids: [1, 2], at: [[10, 0, -5], [90, 1, -6], [150, 0, -6]], expect: { tunnel: 'yes' }, why: 'a test' };
  const areas = [{ file: 'test.json', name: 'test', box: [0, -10, 200, 10], levels: [edit] }];
  const ok = [way(1, { tunnel: 'yes' }, [[0, 0], [100, 0]]), way(2, { tunnel: 'yes' }, [[100, 0], [200, 0]])];
  const [got] = localLevels(ok, toWorld, areas);
  assert.deepEqual(got.at, edit.at);
  assert.deepEqual(got.ways, [[[0, 0], [100, 0]], [[100, 0], [200, 0]]]);
  assert.throws(() => localLevels(ok.slice(0, 1), toWorld, areas), /way 2 is gone from the snapshot/);
  assert.throws(() => localLevels([ok[0], way(2, { tunnel: 'no' }, [[100, 0], [200, 0]])], toWorld, areas), /tunnel=no in OSM now/);
  assert.throws(() => localLevels([ok[0], way(2, { tunnel: 'yes' }, [[100, 20], [200, 20]])], toWorld, areas), /\(150, 0\) is .* off its ways/);
});

test('every level in tools/local/ names its ways, what their tags were, and points [x, z, y] inside its area\'s box', () => {
  const areas = localAreas().filter((a) => a.levels);
  assert.ok(areas.length);
  for (const area of areas) {
    assert.ok(area.box, `${area.file} has a box, for tools/tile-diff.mjs`);
    for (const level of area.levels) {
      assert.ok(level.ids.length && level.ids.every(Number.isInteger), `${area.file}: ${level.why}`);
      assert.ok(Object.keys(level.expect || {}).length, `${area.file}: ${level.why} expects its ways' tags`);
      assert.ok(level.why);
      assert.ok(level.at.length >= 1);
      for (const [x, z, y] of level.at) {
        assert.ok([x, z, y].every(Number.isFinite));
        assert.ok(x >= area.box[0] && x <= area.box[2] && z >= area.box[1] && z <= area.box[3], `${area.file}: (${x}, ${z}) is outside its box`);
      }
    }
  }
});
