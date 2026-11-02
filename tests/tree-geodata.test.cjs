const assert = require('node:assert/strict');
const test = require('node:test');

const load = () => import('../js/geodata.js').then((m) => {
  const { points, kinds, heights } = m.heldTrees();
  return { REAL_TREES: points, TREE_KINDS: kinds, TREE_HEIGHTS: heights };
});

test('surveyed trees are quantized to 0.5 m and carry a species class and a height', async () => {
  const { REAL_TREES, TREE_KINDS, TREE_HEIGHTS } = await load();
  const count = REAL_TREES.length / 2;
  assert.ok(count > 20000);
  assert.equal(TREE_KINDS.length, count);
  assert.equal(TREE_HEIGHTS.length, count);
  for (let i = 0; i < REAL_TREES.length; i++) assert.ok(Number.isInteger(REAL_TREES[i] * 2));
  for (const kind of TREE_KINDS) assert.ok(kind <= 5);
  for (const height of TREE_HEIGHTS) assert.ok(height <= 40);
  assert.ok(new Set(TREE_KINDS).size === 6, 'every species class is in use');
});
