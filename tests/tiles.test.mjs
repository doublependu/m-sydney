import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import zlib from 'node:zlib';
import { tileFile } from '../js/tiles/paths.js';

// The map in tiles (tools/build-tiles.mjs, js/geodata.js): it's all there, and a tile can come and go without trace.
const { GEO, TILE, heldTiles, holdTile, isHeld, releaseTile, tileExists, tileKeyAt, tilesNear } = await import('../js/geodata.js');
const { BLOCKS, LAWNS, PAVEMENTS, ROADS, blockAt, nearestRoads } = await import('../js/city-config.js');
const { LINKS, SEGMENTS, STRUCTURES, groundHeight, linkById, structuresAt } = await import('../js/surfaces.js');
const { rawTerrainHeight, terrainHeight } = await import('../js/terrain.js');
const { unpackTile } = await import('../js/tiles/tile-file.js');

const DIR = new URL('../public/tiles/', import.meta.url);
const generated = new URL('../tools/data/generated/', import.meta.url);

test('a tile on the map is found by where it is, nearest first', () => {
  const near = tilesNear(397, -1010, 450);
  assert.equal(near[0], tileKeyAt(397, -1010));
  for (const key of near) assert.ok(tileExists(key), key);
  assert.ok(!tileExists('500_500'));
  assert.deepEqual(tilesNear(50000, 50000, 100), []);
});

test('each file is named for its contents and stays small', () => {
  for (const [key, hash] of Object.entries(GEO.tiles)) {
    const bytes = fs.readFileSync(new URL(tileFile(key, hash), DIR));
    assert.ok(bytes.length < 200 * 1024, `${key} is ${bytes.length} bytes`);
  }
});

test('a road across tiles is one link', () => {
  const ids = LINKS.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length);
  const multi = heldTiles().flatMap((t) => t.links.map((r) => r[0]));
  assert.ok(multi.length > ids.length, 'some links are in several tiles');
  for (const l of LINKS) assert.equal(linkById.get(l.id), l);
});

test('the structures table agrees with the links', () => {
  for (const l of LINKS) {
    if (!l.kind) assert.equal(l.sid, 0);
    else assert.ok(STRUCTURES[l.sid]?.links.includes(l), `link ${l.id}`);
  }
  assert.ok(STRUCTURES.some((s) => s?.deck));
});

test('a tile can be let go of and fetched again, leaving every index as it was', async () => {
  const key = tileKeyAt(397, -1000);
  const counts = () => ({ links: LINKS.length, segments: SEGMENTS.length, blocks: BLOCKS.length, lawns: LAWNS.length, pavements: PAVEMENTS.length, roads: ROADS.length, tiles: heldTiles().length });
  const samples = [[397, -1000], [420, -700], [100, -900], [350, -1200]];
  const read = () => samples.map(([x, z]) => [terrainHeight(x, z), groundHeight(x, z), blockAt(x, z)?.id ?? null, nearestRoads(x, z, 40).map((r) => r.road.name).sort().join(), structuresAt(x, z).length]);
  const before = counts(), values = read();
  releaseTile(key);
  assert.ok(!isHeld(key));
  assert.ok(LINKS.length < before.links && BLOCKS.length < before.blocks, 'its roads and blocks went with it');
  assert.ok(heldTiles().length === before.tiles - 1);
  // Roads it shared with a neighbour are still there
  assert.ok(LINKS.length > 0);
  await holdTile(key);
  assert.ok(isHeld(key));
  assert.deepEqual(counts(), before);
  assert.deepEqual(read(), values);
});

test('with no tile there, the coarse grid answers, near the fine one', async () => {
  const x = 410, z = -1010, key = tileKeyAt(x, z);
  const fine = terrainHeight(x, z);
  releaseTile(key);
  const coarse = terrainHeight(x + TILE / 2 - 120, z);
  const heldAround = terrainHeight(x, z);
  await holdTile(key);
  assert.ok(Number.isFinite(coarse) && Number.isFinite(heldAround));
  assert.ok(Math.abs(heldAround - fine) < 6, `${heldAround} against ${fine}`);
});

test('a damaged tile is an error', () => {
  const [key, hash] = Object.entries(GEO.tiles)[0];
  const data = zlib.gunzipSync(fs.readFileSync(new URL(tileFile(key, hash), DIR)));
  assert.throws(() => unpackTile(new Uint8Array(data.subarray(0, data.length - 40)), GEO.heights.size));
});

// Only where the generated data is on this machine: it's not in the repo
test('the tiles hold the same ground and trees as the generated map', { skip: !fs.existsSync(generated) }, async () => {
  const H = GEO.frame.heights;
  const data = zlib.gunzipSync(fs.readFileSync(new URL('height-grid.bin.gz', generated)));
  const grid = new Float32Array(H.w * H.h);
  let cursor = 0;
  for (let j = 0; j < H.h; j++) {
    let v = 0;
    for (let i = 0; i < H.w; i++) {
      let q = 0, shift = 0, byte;
      do { byte = data[cursor++]; q |= (byte & 127) << shift; shift += 7; } while (byte & 128);
      v += (q >>> 1) ^ -(q & 1);
      grid[j * H.w + i] = v * 0.25;
    }
  }
  const source = (x, z) => {
    const fx = (x - H.x0) / H.cell, fz = (z - H.z0) / H.cell, i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, k = j * H.w + i;
    const a = grid[k] + (grid[k + 1] - grid[k]) * tx, b = grid[k + H.w] + (grid[k + H.w + 1] - grid[k + H.w]) * tx;
    return a + (b - a) * tz;
  };
  let checked = 0;
  for (const t of heldTiles()) {
    for (let i = 0; i < 40; i++) {
      const x = (t.ix + ((i * 0.618) % 1)) * TILE, z = (t.iz + ((i * 0.381) % 1)) * TILE;
      assert.ok(Math.abs(rawTerrainHeight(x, z) - source(x, z)) < 1e-3, `ground at ${x}, ${z}`);
      checked++;
    }
  }
  assert.ok(checked > 1000);
});

// A module reading the map as it loads sees nothing in the browser, where no tile is held yet
test('the bridge knows its deck before any of it is held', async () => {
  const { BRIDGE_LENGTH, BRIDGE_SPAN, deckHeight } = await import('../js/bridge.js');
  assert.ok(GEO.deckProfile.length > BRIDGE_LENGTH / 2, 'a height every 2 m');
  assert.ok(Math.max(...GEO.deckProfile) > 45 && Math.max(...GEO.deckProfile) < 65, 'over the harbour, as high as the real deck');
  assert.ok(deckHeight(BRIDGE_SPAN.middle) > 45);
  assert.deepEqual(BRIDGE_SPAN, GEO.bridgeSpan);
});
