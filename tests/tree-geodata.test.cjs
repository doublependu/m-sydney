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
  // Six classes of street and park tree, then the gardens' own (tools/build-garden.mjs), whose small ones' heights are in tenths of a metre
  const SMALL = new Set([10, 12, 13, 14, 15, 16, 17]);
  for (let i = 0; i < TREE_KINDS.length; i++) {
    assert.ok(TREE_KINDS[i] <= 17);
    assert.ok(TREE_HEIGHTS[i] <= (SMALL.has(TREE_KINDS[i]) ? 30 : 40), `kind ${TREE_KINDS[i]} ${TREE_HEIGHTS[i]} high`);
  }
  for (let k = 0; k <= 5; k++) assert.ok(TREE_KINDS.includes(k), `no trees of class ${k}`);
});
