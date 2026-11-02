import assert from 'node:assert/strict';
import test from 'node:test';
import { COVERS, affectedScenarios, scenariosForTiles } from '../tools/play/affected.mjs';

test('a change that touches nothing special still runs the first minute', () => {
  assert.deepEqual(affectedScenarios(['README.md']), ['first-minute']);
});

test('a change to the bridge runs the bridge scenarios', () => {
  const names = affectedScenarios(['js/harbour-bridge.js']);
  for (const name of ['harbour-bridge', 'bridge-edges', 'under-the-bridge']) assert.ok(names.includes(name), name);
  assert.ok(!names.includes('touch'));
});

test('new map data runs every scenario tied to a place', () => {
  const names = affectedScenarios(['public/tiles/0_0.abc.bin.gz']);
  for (const [name, { area }] of Object.entries(COVERS)) if (area) assert.ok(names.includes(name), name);
});

test('a changed tile runs only the scenarios crossing it', () => {
  const names = scenariosForTiles(['1_0']);
  assert.ok(names.includes('tunnel'));
  assert.ok(!names.includes('saved-position'));
  assert.deepEqual(scenariosForTiles(['60_60']), []);
});
