import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import zlib from 'node:zlib';

// A model site's first shape (js/first-shapes.js): the map's buildings it replaces, kept apart in its tile as `standIns`
// (tools/tiles/derive.mjs), drawn till the model or its far version is. Read from the tiles' own files: the sites are up to 20 km apart.
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { unpackTile } = await import('../js/tiles/tile-file.js');
const { tileFile } = await import('../js/tiles/paths.js');
const { MODEL_SITES, toWorldOf } = await import('../js/model-sites.js');
const { addFirstShape, dropFirstShapes, drawnIn, hasFirstShape, showFirstShape } = await import('../js/first-shapes.js');

const world = JSON.parse(fs.readFileSync(new URL('../public/tiles/world.json', import.meta.url), 'utf8'));
const tiles = new Map();
const keyAt = (x, z) => `${Math.floor(x / world.tileSize)}_${Math.floor(z / world.tileSize)}`;
function tile(key) {
  if (!tiles.has(key)) {
    const bytes = zlib.gunzipSync(fs.readFileSync(new URL(`../public/tiles/${tileFile(key, world.tiles[key])}`, import.meta.url)));
    tiles.set(key, unpackTile(new Uint8Array(bytes), world.heights.size, world.ground.size));
  }
  return tiles.get(key);
}
const inRing = (ring, x, z) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) c = !c;
  }
  return c;
};
const holds = (b, x, z) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && b.polygons.some((p) => inRing(p.outer, x, z));
const outlineKey = (b) => JSON.stringify(b.polygons.map((p) => p.outer.map((q) => [q.x, q.z])));
const sites = MODEL_SITES.filter((s) => !s.debug);

test('every site that replaces the map\'s buildings has them in its tile as its stand-ins, and no building is in both lists', () => {
  for (const site of sites.filter((s) => s.replaces.length)) {
    const key = keyAt(site.x, site.z), here = tile(key);
    const list = here.standIns?.[site.id];
    assert.ok(list?.length, `${site.id}: no stand-ins in its tile ${key}`);
    for (const [lx, lz] of site.replaces) {
      const { x, z } = toWorldOf(site, lx, lz);
      assert.ok(list.some((b) => holds(b, x, z)), `${site.id}: none of its stand-ins holds its point (${lx}, ${lz})`);
    }
    assert.ok(list.length <= site.replaces.length, `${site.id}: ${list.length} stand-ins for ${site.replaces.length} buildings`);
    // ...and none of them in the map's own buildings, in its tile or round it: drawn twice, and seen by the lots, the colliders and the rest
    const [ix, iz] = key.split('_').map(Number);
    const outlines = new Set(list.map(outlineKey));
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const k = `${ix + dx}_${iz + dz}`;
        if (!world.tiles[k]) continue;
        const twice = tile(k).buildings.filter((b) => outlines.has(outlineKey(b)));
        assert.equal(twice.length, 0, `${site.id}: ${twice.length} of its stand-ins also in ${k}'s buildings`);
      }
    }
    for (const b of list) {
      assert.ok(b.height > 0 && b.polygons.length && Number.isFinite(b.floor), `${site.id}: a stand-in ${b.height} m high on a floor at ${b.floor}`);
    }
  }
});

test('only the tiles that have a site hold stand-ins, and only their own sites\'', () => {
  const keys = new Set(sites.flatMap((s) => {
    const [ix, iz] = keyAt(s.x, s.z).split('_').map(Number);
    return [-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dz) => `${ix + dx}_${iz + dz}`));
  }));
  for (const key of keys) {
    if (!world.tiles[key]) continue;
    const own = sites.filter((s) => s.replaces.length && keyAt(s.x, s.z) === key).map((s) => s.id).sort();
    assert.deepEqual(Object.keys(tile(key).standIns ?? {}).sort(), own, `tile ${key}`);
  }
});

test('one of the three at a time: the model, the far version, or the first shape, with what it says it\'s drawn with', () => {
  // A part as it is in each: a stand-in or a landmark's shape; Sydney Tower's shaft, drawn with its far version; its bare podium
  const plain = {}, far = { far: true }, bare = { bare: true };
  assert.deepEqual(['first', 'far', 'model'].map((s) => drawnIn(plain, s, true)), [true, false, false]);
  assert.deepEqual(['first', 'far', 'model'].map((s) => drawnIn(far, s, true)), [true, true, false]);
  assert.deepEqual(['first', 'far', 'model'].map((s) => drawnIn(bare, s, true)), [false, false, false]);
  assert.deepEqual(['first', 'far', 'model'].map((s) => drawnIn(bare, s, false)), [true, false, false]);

  // A site whose tile comes and goes: its bare part stands in till the map's building is there, and again once it's gone
  const shaft = { visible: true }, podium = { visible: true }, box = { visible: true }, cover = { visible: true };
  const ground = [];
  addFirstShape('test-site', shaft, { far: true });
  addFirstShape('test-site', podium, { bare: true });
  assert.equal(hasFirstShape('test-site'), false);
  assert.deepEqual([shaft.visible, podium.visible], [true, true]);
  addFirstShape('test-site', box, { standIn: true, tile: '0_0' });
  addFirstShape('test-site', cover, { standIn: true, tile: '0_0', show: (on) => ground.push(on) });
  assert.equal(hasFirstShape('test-site'), true);
  assert.deepEqual([shaft.visible, podium.visible, box.visible, cover.visible], [true, false, true, true]);
  showFirstShape('test-site', 'far');
  assert.deepEqual([shaft.visible, podium.visible, box.visible, cover.visible], [true, false, false, false]);
  showFirstShape('test-site', 'model');
  assert.deepEqual([shaft.visible, podium.visible, box.visible, cover.visible], [false, false, false, false]);
  showFirstShape('test-site', 'first');
  assert.deepEqual([shaft.visible, podium.visible, box.visible, cover.visible], [true, false, true, true]);
  dropFirstShapes('0_0');
  assert.equal(hasFirstShape('test-site'), false);
  assert.deepEqual([shaft.visible, podium.visible], [true, true]);
  // the cover's ground counted while it was drawn, and not once it was hidden or let go of
  assert.deepEqual(ground, [true, false, true, false]);
});
