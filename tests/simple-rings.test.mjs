import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import zlib from 'node:zlib';
import { ShapeUtils, Vector2 } from 'three';
import { Raster, tiledPolygons } from '../tools/geo-common.mjs';
import { crossings, piecesCross, untangle } from '../tools/tiles/simple-rings.mjs';
import { unpackTile } from '../js/tiles/tile-file.js';
import { tileFile } from '../js/tiles/paths.js';

// Lawn and footpath outlines that cross themselves, untangled where the tiles are written (tools/tiles/simple-rings.mjs). A footpath at
// Coogee was triangulated into shards over the road, where simplifying its outline had pushed an inner corner out through its outer
// edge; three more pieces on the map crossed. Here: made-up rings, those four as they were, random land traced as the map's is,
// and every tile on the map.

const points = (flat) => Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i], flat[2 * i + 1]]);
const area = (flat) => {
  let a = 0;
  for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) a += flat[j] * flat[i + 1] - flat[i] * flat[j + 1];
  return a / 2;
};
const covers = ([outer, ...holes]) => Math.abs(area(outer)) - holes.reduce((t, h) => t + Math.abs(area(h)), 0);

function windingAt(flat, x, z) {
  let n = 0;
  for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) {
    const ax = flat[j], az = flat[j + 1], bx = flat[i], bz = flat[i + 1];
    const side = (bx - ax) * (z - az) - (bz - az) * (x - ax);
    if (az <= z) { if (bz > z && side > 0) n++; } else if (bz <= z && side < 0) n--;
  }
  return n;
}
const inside = (flat, x, z) => windingAt(flat, x, z) !== 0;
const inPiece = ([outer, ...holes], x, z) => inside(outer, x, z) && !holes.some((h) => inside(h, x, z));

// Where a piece should cover: its outline wound round once more than its holes, the outer ring's way counting +1 and a hole's -1
function meant([outer, ...holes], x, z) {
  const way = Math.sign(area(outer));
  return windingAt(outer, x, z) * way - holes.reduce((t, h) => t + windingAt(h, x, z) * Math.sign(area(h)), 0) > 0;
}

function nearAnEdge(rings, x, z, within) {
  for (const flat of rings) {
    for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) {
      const ax = flat[j], az = flat[j + 1], dx = flat[i] - ax, dz = flat[i + 1] - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      if (Math.hypot(ax + dx * t - x, az + dz * t - z) < within) return true;
    }
  }
  return false;
}

// The untangled pieces cover what the piece meant, once, away from the edges (the new points are rounded to 0.1 m)
function assertCovers(rings, pieces, what) {
  const all = points(rings.flat());
  const x0 = Math.min(...all.map((p) => p[0])), x1 = Math.max(...all.map((p) => p[0]));
  const z0 = Math.min(...all.map((p) => p[1])), z1 = Math.max(...all.map((p) => p[1]));
  // A quarter of a metre apart, or 40,000 points over a big piece
  const step = Math.max(0.25, Math.sqrt((x1 - x0) * (z1 - z0) / 40000));
  let checked = 0;
  for (let x = x0 + step / 2; x < x1; x += step) {
    for (let z = z0 + step / 2; z < z1; z += step) {
      if (nearAnEdge([...rings, ...pieces.flat()], x, z, 0.12)) continue;
      const count = pieces.filter((p) => inPiece(p, x, z)).length;
      assert.ok(count <= 1, `${what}: (${x}, ${z}) covered ${count} times`);
      assert.equal(count === 1, meant(rings, x, z), `${what}: (${x}, ${z}) ${count ? 'covered' : 'left out'}`);
      checked++;
    }
  }
  return checked;
}

// As the game draws a piece: three's triangulator (js/drape.js). Its triangles add up to the piece's own area where none lie over another.
function triangulated([outer, ...holes]) {
  const rings = [outer, ...holes].map(points);
  const all = rings.flat();
  let sum = 0;
  for (const [a, b, c] of ShapeUtils.triangulateShape(rings[0].map(([x, z]) => new Vector2(x, z)), rings.slice(1).map((h) => h.map(([x, z]) => new Vector2(x, z))))) {
    sum += Math.abs((all[b][0] - all[a][0]) * (all[c][1] - all[a][1]) - (all[b][1] - all[a][1]) * (all[c][0] - all[a][0])) / 2;
  }
  return sum;
}

function assertUntangled(rings, what) {
  const result = untangle(rings);
  assert.ok(result.changed, `${what}: changed`);
  for (const piece of result.pieces) {
    assert.ok(!piecesCross(piece), `${what}: still crosses`);
    assert.ok(Math.sign(area(piece[0])) === Math.sign(area(rings[0])), `${what}: an outline wound the other way`);
    for (const h of piece.slice(1)) assert.ok(Math.sign(area(h)) === -Math.sign(area(rings[0])), `${what}: a hole wound as its outline`);
    const own = covers(piece), drawn = triangulated(piece);
    assert.ok(Math.abs(drawn - own) <= Math.max(0.01, own * 0.001), `${what}: triangles ${drawn.toFixed(2)} m² for ${own.toFixed(2)} m²`);
  }
  assertCovers(rings, result.pieces, what);
  return result;
}

test('a ring that doesn\'t cross itself comes back as it was, the same arrays', () => {
  const square = [0, 0, 10, 0, 10, 10, 0, 10], hole = [4, 4, 4, 6, 6, 6, 6, 4];
  const rings = [square, hole];
  const result = untangle(rings);
  assert.equal(result.changed, false);
  assert.equal(result.pieces.length, 1);
  assert.equal(result.pieces[0], rings);
  // Touching itself at a point isn't crossing: two squares corner to corner, traced as one ring
  const touching = [[0, 0, 4, 0, 4, 4, 8, 4, 8, 8, 4, 8, 4, 4, 0, 4]];
  assert.equal(crossings(touching.map(points)).length, 0);
  assert.equal(untangle(touching).pieces[0], touching);
  // ...nor a point on another edge
  const onEdge = [[0, 0, 10, 0, 10, 10, 6, 10, 5, 0, 4, 10, 0, 10]];
  assert.equal(untangle(onEdge).pieces[0], onEdge);
});

test('a bow-tie keeps the bigger loop, the one wound as the ring is', () => {
  // (0, 0) to (10, 10) crosses (10, 0) to (0, 4) at (2.857, 2.857): a small loop one way round, a big one the other
  const rings = [[0, 0, 10, 10, 10, 0, 0, 4]];
  const result = assertUntangled(rings, 'bow-tie');
  assert.equal(result.pieces.length, 1);
  const x = 20 / 7;
  // The crossing is rounded to 0.1 m, as the map's points are
  assert.ok(Math.abs(covers(result.pieces[0]) - (10 - x) * 10 / 2) < 0.5, `kept ${covers(result.pieces[0])}`);
  assert.ok(Math.abs(result.dropped - x * 4 / 2) < 0.05, `dropped ${result.dropped}`);
});

test('a corner past an edge: the sliver goes, and the strip either side stays', () => {
  // A footpath 1 m wide, its inner edge's corner pushed 0.3 m out through its outer edge, as at Coogee
  const rings = [[0, 0, 20, 0, 20, 1, 11, 1, 10, -0.3, 9, 1, 0, 1]];
  const result = assertUntangled(rings, 'corner');
  assert.equal(result.pieces.length, 2, 'cut in two where the corner went through');
  // The sliver: from (9.77, 0) to (10.23, 0) and down to (10, -0.3)
  assert.ok(Math.abs(result.dropped - (2 * 0.3 / 1.3) * 0.3 / 2) < 0.01, `dropped ${result.dropped}`);
});

test('a hole across its outline is clipped to it', () => {
  const rings = [[0, 0, 10, 0, 10, 10, 0, 10], [8, 4, 8, 6, 12, 6, 12, 4]];
  const result = assertUntangled(rings, 'hole');
  assert.equal(result.pieces.length, 1);
  assert.equal(result.pieces[0].length, 1, 'the hole is a notch in the outline now');
  assert.ok(Math.abs(covers(result.pieces[0]) - (100 - 4)) < 1e-9);
  // ...and a hole written the same way round as its outline counts as a hole all the same
  const same = [[0, 0, 10, 0, 10, 10, 0, 10], [8, 4, 12, 4, 12, 6, 8, 6]];
  assert.ok(Math.abs(covers(assertUntangled(same, 'hole the same way').pieces[0]) - 96) < 1e-9);
});

test('the four pieces on the map that crossed', () => {
  const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/crossing-footpaths.json', import.meta.url)));
  assert.equal(fixtures.length, 4);
  for (const { place, rings } of fixtures) {
    assert.ok(piecesCross(rings), `${place}: crosses as it was`);
    const result = assertUntangled(rings, place);
    // Each a sliver under a square metre and a half, of pieces of 200 m² to 12,000
    assert.ok(result.dropped < 1.5, `${place}: dropped ${result.dropped.toFixed(2)} m²`);
  }
});

test('random land traced as the map is, and its points moved up to 1.5 m: untangled, nothing crosses, each piece triangulates to its own area', () => {
  // recordings/plan8/scripts/tile-stress.mjs' land: discs of land and water, and thin strips like footpaths
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let pieces = 0, changed = 0, shaken = 0;
  for (let trial = 0; trial < 6; trial++) {
    const raster = new Raster(0, 0, 199, 199, 1);
    for (let k = 0; k < 40; k++) {
      const cx = rnd() * 200, cz = rnd() * 200, r = 3 + rnd() * 25, v = rnd() < 0.75 ? 1 : 0;
      for (let j = 0; j < raster.h; j++) for (let i = 0; i < raster.w; i++) if (Math.hypot(i + 0.5 - cx, j + 0.5 - cz) < r) raster.d[j * raster.w + i] = v;
    }
    for (let k = 0; k < 12; k++) {
      const i0 = Math.floor(rnd() * 190), j0 = Math.floor(rnd() * 190), across = rnd() < 0.5;
      for (let t = 0; t < 120; t++) {
        for (let w = 0; w < 4; w++) {
          const i = across ? i0 + t : i0 + w, j = across ? j0 + w : j0 + t;
          if (i < raster.w && j < raster.h) raster.d[j * raster.w + i] = 1;
        }
      }
    }
    for (const traced of tiledPolygons(raster, 40, 1, 6, 6)) {
      const rings = traced.map((r) => r.flat());
      const result = untangle(rings);
      pieces++;
      if (!result.changed) assert.equal(result.pieces[0], rings);
      else {
        changed++;
        assertUntangled(rings, `trial ${trial}`);
      }
      // The same piece with its points moved: a corner past an edge, a hole through its outline, now and then a loop or two
      const moved = rings.map((r) => r.map((v) => Math.round((v + (rnd() - 0.5) * 3) * 10) / 10));
      if (piecesCross(moved)) {
        shaken++;
        assertUntangled(moved, `trial ${trial}, moved, at ${moved[0][0]}, ${moved[0][1]}`);
      }
    }
  }
  assert.ok(pieces > 100, `${pieces} pieces`);
  assert.ok(changed < pieces / 10, `${changed} of ${pieces} changed as traced`);
  assert.ok(shaken > 20, `${shaken} moved pieces crossed`);
});

test('no lawn or footpath outline on the map crosses itself or another of its piece', () => {
  // Every tile, one at a time (a few seconds, and little memory: safe beside a map build)
  const root = new URL('../public/tiles/', import.meta.url);
  const world = JSON.parse(fs.readFileSync(new URL('world.json', root)));
  const found = [];
  let rings = 0;
  for (const [key, hash] of Object.entries(world.tiles)) {
    const tile = unpackTile(new Uint8Array(zlib.gunzipSync(fs.readFileSync(new URL(tileFile(key, hash), root)))), world.heights.size, world.ground?.size);
    for (const [kind, list] of [['footpath', tile.pavements], ['lawn', tile.lawns]]) {
      for (const piece of list) {
        rings += piece.length;
        if (piecesCross(piece)) found.push(`${kind} in ${key} at ${piece[0][0]}, ${piece[0][1]}`);
      }
    }
  }
  assert.ok(rings > 150000, `${rings} rings`);
  assert.deepEqual(found, []);
});
