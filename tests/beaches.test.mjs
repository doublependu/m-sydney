import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import zlib from 'node:zlib';

// The beaches (tools/build-sand.mjs, js/city-grid.js), read from the tiles' own files: the tiles the other tests hold (SYDNEY_TILES)
// don't reach the eastern beaches. The house over Bronte's is tests/houses.test.mjs'.
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { unpackTile } = await import('../js/tiles/tile-file.js');
const { tileFile } = await import('../js/tiles/paths.js');

const world = JSON.parse(fs.readFileSync(new URL('../public/tiles/world.json', import.meta.url), 'utf8'));
const tiles = new Map();
function tileAt(x, z) {
  const key = `${Math.floor(x / world.tileSize)}_${Math.floor(z / world.tileSize)}`;
  if (!tiles.has(key)) {
    const bytes = zlib.gunzipSync(fs.readFileSync(new URL(`../public/tiles/${tileFile(key, world.tiles[key])}`, import.meta.url)));
    const [ix, iz] = key.split('_').map(Number);
    tiles.set(key, { key, ix, iz, ...unpackTile(new Uint8Array(bytes), world.heights.size, world.ground.size) });
  }
  return tiles.get(key);
}
const inFlat = (f, x, z) => {
  let c = false;
  for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) {
    if ((f[i + 1] > z) !== (f[j + 1] > z) && x < ((f[j] - f[i]) * (z - f[i + 1])) / (f[j + 1] - f[i + 1]) + f[i]) c = !c;
  }
  return c;
};
/** The kinds of sand or rock at (x, z), from the pieces of its tile and the tiles round it (a piece is its middle's tile's) */
function sandAt(x, z) {
  const kinds = [];
  for (const dx of [-1, 0, 1]) {
    for (const dz of [-1, 0, 1]) {
      const key = `${Math.floor(x / world.tileSize) + dx}_${Math.floor(z / world.tileSize) + dz}`;
      if (!world.tiles[key]) continue;
      for (const [kind, outer, ...holes] of tileAt((Math.floor(x / world.tileSize) + dx + 0.5) * world.tileSize, (Math.floor(z / world.tileSize) + dz + 0.5) * world.tileSize).sand || []) {
        if (inFlat(outer, x, z) && !holes.some((h) => inFlat(h, x, z))) kinds.push(kind);
      }
    }
  }
  return kinds;
}

// A point on each beach's sand, from its middle in OSM
const BEACHES = { Bronte: [6124, 2563], Bondi: [6801, 1080], Tamarama: [6236, 2270], Clovelly: [6060, 3665], Coogee: [5429, 4550],
  Manly: [6400, -9286], Cronulla: [-1940, 20660] };

test('the beaches are sand', () => {
  for (const [name, [x, z]] of Object.entries(BEACHES)) assert.ok(sandAt(x, z).includes(0), `${name}: no sand at (${x}, ${z})`);
  // ...and their headlands' bare rock, and a shelf in the sea at the Bogey Hole, at Bronte's south end
  assert.ok(sandAt(6185, 2668).includes(2), 'no rock shelf round the Bogey Hole');
});

test('a beach runs down into the water, not to a sea wall, and its sand comes down to meet it', () => {
  const t = tileAt(6124, 2563);
  const beach = t.shore.filter((s) => s[5] === 1 && Math.hypot((s[1] + s[3]) / 2 - 6135, (s[2] + s[4]) / 2 - 2560) < 130);
  const walled = t.shore.filter((s) => s[5] !== 1 && Math.hypot((s[1] + s[3]) / 2 - 6130, (s[2] + s[4]) / 2 - 2560) < 60);
  assert.ok(beach.length >= 8, `only ${beach.length} stretches of Bronte's shore are its beach's`);
  assert.equal(walled.length, 0, `${walled.length} stretches of Bronte beach's middle have a sea wall`);
  // The ground's moved down at the water's edge (tools/tiles/grade-ground.mjs): the survey has the sand a metre or two over the sea
  const { size, cell, unit } = world.ground;
  const [, ax, az, bx, bz] = beach[beach.length >> 1];
  const x = (ax + bx) / 2, z = (az + bz) / 2;
  const i = Math.round((x - t.ix * world.tileSize) / cell), j = Math.round((z - t.iz * world.tileSize) / cell);
  const moved = t.ground[j * size + i] * unit;
  assert.ok(moved < -1, `the ground at Bronte's water's edge (${x.toFixed(0)}, ${z.toFixed(0)}) is moved ${moved.toFixed(2)} m, not down to the sea`);
});

