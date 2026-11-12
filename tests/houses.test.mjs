import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import zlib from 'node:zlib';

// The houses drawn from models (js/model-sites.js), read from the tiles' and the models' own files: the tiles the other tests hold
// (SYDNEY_TILES) don't reach them.
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { unpackTile } = await import('../js/tiles/tile-file.js');
const { tileFile } = await import('../js/tiles/paths.js');
const { MODEL_SITES, toWorldOf } = await import('../js/model-sites.js');
const { STYLE } = await import('../js/house-styles.js');

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
const inRing = (ring, x, z) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    const [ax, az] = Array.isArray(a) ? a : [a.x, a.z], [bx, bz] = Array.isArray(b) ? b : [b.x, b.z];
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) c = !c;
  }
  return c;
};
const model = (name) => JSON.parse(fs.readFileSync(new URL(`../public/models/${name}.json`, import.meta.url), 'utf8'));
const size = (name) => fs.statSync(new URL(`../public/models/${name}.glb.gz`, import.meta.url)).size;
function cost(name) {
  const glb = zlib.gunzipSync(fs.readFileSync(new URL(`../public/models/${name}.glb.gz`, import.meta.url)));
  const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  const primitives = gltf.meshes.flatMap((m) => m.primitives);
  return { draws: primitives.length, triangles: primitives.reduce((n, p) => n + gltf.accessors[p.indices].count / 3, 0) };
}
/** The floor of the outside's JSON at (x, z) nearest to y, or null */
function floorNear(floors, x, z, y) {
  let best = null;
  for (const f of floors) {
    if (!inRing(f.poly, x, z) || (f.holes ?? []).some((h) => inRing(h, x, z))) continue;
    const h = f.plane ? f.plane[0] + f.plane[1] * x + f.plane[2] * z : f.y;
    if (best === null || Math.abs(h - y) < Math.abs(best - y)) best = h;
  }
  return best;
}

/** The ground's height (js/surfaces.js groundHeight()) at world points, from the tiles round them, asked of the game in a process of its own:
 * this one holds no tiles */
function groundAt(points) {
  const t = (v) => Math.floor(v / world.tileSize);
  const xs = points.map((p) => p[0]), zs = points.map((p) => p[1]);
  const code = `await import('./js/geodata.js'); const S = await import('./js/surfaces.js');
    process.stdout.write(JSON.stringify(${JSON.stringify(points)}.map(([x, z]) => S.groundHeight(x, z))))`;
  const out = execFileSync('node', ['--input-type=module', '-e', code], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, SYDNEY_TILES: `${t(Math.min(...xs))},${t(Math.min(...zs))},${t(Math.max(...xs))},${t(Math.max(...zs))}` }
  });
  return JSON.parse(out.toString());
}

// Each house: the doors that lead in, and whether the ground's left undrawn under it (a cut)
const HOUSES = {
  'bronte-pacific': { doors: ['front', 'garage-side'], cut: true },
  'quarry-rd': { doors: ['front', 'living-deck'], cut: true },
  'parklea-close': { doors: ['front', 'lounge-balcony', 'lounge-verandah', 'garage', 'office'], cut: false },
  'parklea-cottage': { doors: ['front', 'patio'], cut: false },
  'parklea-shed': { doors: [], cut: false },
  'cove-st-41': { doors: ['front', 'back'], cut: false },
  'cove-st-43': { doors: ['front', 'back'], cut: false },
  'school-st': { doors: ['front', 'side', 'courtyard', 'balcony-1', 'balcony-2', 'balcony-3'], cut: false }
};

for (const [id, want] of Object.entries(HOUSES)) {
  test(`${id}: its model stands in place of the map's buildings, its doors lead in from a step outside, and it keeps to its budgets`, () => {
    const site = MODEL_SITES.find((s) => s.id === id);
    assert.ok(site?.far, `no site or far version for ${id}`);
    assert.equal(!!site.cut, want.cut, `${id}'s cut`);
    // The map's buildings it takes the place of are gone from their tiles (tools/tiles/derive.mjs)
    for (const [lx, lz] of site.replaces) {
      const { x, z } = toWorldOf(site, lx, lz);
      const left = tileAt(x, z).buildings.filter((b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && b.polygons.some((p) => inRing(p.outer, x, z)));
      assert.equal(left.length, 0, `the map still has a building at (${x.toFixed(1)}, ${z.toFixed(1)})`);
    }
    const file = site.file.replace('models/', '');
    const out = model(file);
    // Its doors lead in, each from a floor outside it at its sill (a verandah, a deck, a patio or a step), or the ground there
    const into = out.doors.filter((d) => d.inside);
    for (const door of want.doors) assert.ok(into.some((d) => d.id === door), `its ${door} door doesn't lead in`);
    const sides = into.map((d) => {
      const [hx, hz] = d.hinge, [lx, lz] = d.latch;
      const mx = (hx + lx) / 2, mz = (hz + lz) / 2, L = Math.hypot(lx - hx, lz - hz);
      // either side of the doorway, 0.6 m out: one is a room inside, the other outside
      return [1, -1].map((s) => [mx + (s * -(lz - hz) / L) * 0.6, mz + (s * (lx - hx) / L) * 0.6]);
    });
    const ground = into.length ? groundAt(sides.flat().map(([x, z]) => { const w = toWorldOf(site, x, z); return [w.x, w.z]; })) : [];
    into.forEach((d, i) => {
      const found = sides[i].map(([x, z], k) => floorNear(out.floors, x, z, d.y0) ?? ground[2 * i + k] - site.y);
      assert.ok(found.some((y) => Math.abs(y - d.y0) < 0.3), `${id}'s ${d.id} door has no step outside it (${found.map((y) => y.toFixed(2))})`);
    });
    // Budgets: the outside drawn with its tile, the inside fetched at a door, the far version from afar
    assert.ok(size(file) < 300_000, `its outside is ${size(file)} bytes`);
    const far = cost(`${file}-far`);
    assert.ok(far.triangles <= 2000 && far.draws <= 2, `its far version is ${far.triangles} triangles in ${far.draws} draws`);
    const inside = [...new Set(into.map((d) => d.inside))];
    assert.ok(inside.length <= 1, `${id} has more than one inside: ${inside}`);
    for (const name of inside) {
      assert.ok(size(name) < 2_000_000, `its inside is ${size(name)} bytes`);
      assert.ok(cost(name).triangles < 40_000, `its inside is ${cost(name).triangles} triangles`);
    }
  });
}

test('499 Bronte Rd\'s street: the flats round it in red brick under tiled roofs', () => {
  const flats = tileAt(6100, 2790).buildings.filter((b) => b.houseStyle === STYLE['Red-brick flats']);
  assert.ok(flats.length >= 20, `only ${flats.length} of its neighbours are red-brick flats`);
});
