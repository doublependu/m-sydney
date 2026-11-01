const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { Script } = require('node:vm');

const compressed = readFileSync(join(__dirname, '../js/tree-geodata.bin.gz'));
const source = readFileSync(join(__dirname, '../js/tree-geodata.js'), 'utf8')
  .replace('import.meta.url', JSON.stringify('https://example.test/city/js/tree-geodata.js'))
  .replace('export const REAL_TREES', 'const REAL_TREES')
  .replace('export const TREE_KINDS', 'const TREE_KINDS')
  .replace('export const TREE_HEIGHTS', 'const TREE_HEIGHTS');
const script = new Script(`(async () => { ${source}\nreturn { REAL_TREES, TREE_KINDS, TREE_HEIGHTS }; })()`);
const load = (bytes = compressed, status = 200) => script.runInNewContext({
  URL, Response, DecompressionStream, Float32Array, Uint8Array,
  fetch: async (url) => {
    assert.equal(url.href, 'https://example.test/city/js/tree-geodata.bin.gz');
    return new Response(bytes, { status });
  }
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

test('a failed tree request is an error', async () => {
  await assert.rejects(load(compressed, 404), /Tree data request failed: 404/);
});
