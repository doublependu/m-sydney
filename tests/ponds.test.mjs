import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import zlib from 'node:zlib';
import { cutPond, loadPonds } from '../tools/pond-pieces.mjs';
import { POND_GRADE, pondGrading } from '../tools/tiles/pond-grade.mjs';

// Still water outside the gardens: how tools/build-ponds.mjs cuts a pond to the ground and finds its level (cutPond()), how
// tools/tiles/grade-ground.mjs grades the ground to a pond the ponds' rule draws (tools/tiles/pond-grade.mjs), so it lies flat, and how the
// game draws and stands you on it (js/garden.js, tile.lakes; js/drawn-ground.js).

const area = (r) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return Math.abs(a / 2);
};
const heightIn = ([a, b, c], x, z) => {
  const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
  if (Math.abs(d) < 1e-9) return null;
  const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d, l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
  return l1 < -1e-6 || l2 < -1e-6 || 1 - l1 - l2 < -1e-6 ? null : l1 * a[1] + l2 * b[1] + (1 - l1 - l2) * c[1];
};
const ones = (box) => {
  const w = box.x1 - box.x0, h = box.z1 - box.z0;
  return { w, h, d: new Uint8Array(w * h).fill(1) };
};

test('a pond is cut to the ground, in the lawns\' 240 m squares, at the lowest ground round its edge but its seams', () => {
  // 40 by 30 m across the seam at x = 240; ground only north of z = 125, so the road south of it takes 5 m off; the ground rising east
  const pond = [{ outer: [[[220, 100], [260, 100], [260, 130], [220, 130], [220, 100]]], inner: [] }];
  const ground = [[[[0, 0], [480, 0], [480, 125], [0, 125], [0, 0]]]];
  // ...and a dip along the seam, which isn't the pond's edge
  const terrainAt = (x, z) => (x === 240 && z > 101 && z < 124 ? 0 : 3 + (x - 200) / 100);
  const cut = cutPond(pond, { groundIn: () => ground, landIn: ones, terrainAt });
  assert.equal(cut.pieces.length, 2, 'not split at the seam');
  for (const [outer] of cut.pieces) {
    const xs = outer.map((p) => p[0]);
    assert.ok(Math.max(...xs) <= 240 || Math.min(...xs) >= 240, 'a piece across the seam');
    assert.ok(outer.every(([, z]) => z >= 100 && z <= 125), 'water off the ground');
  }
  // Traced through the cells' middles and smoothed, as the lawns are: its corners half a metre in
  const total = cut.pieces.reduce((t, [outer]) => t + area(outer), 0);
  assert.ok(total > 40 * 25 * 0.93 && total <= 40 * 25, `${total} m² of water`);
  // The lowest ground on its edges is at its west end: not on the seam
  assert.ok(Math.abs(cut.level - 3.2) < 0.011, `its level ${cut.level}`);
  // Where the last build's land still has it as the sea, it's left out
  const sea = cutPond(pond, { groundIn: () => ground, landIn: (box) => ({ ...ones(box), d: new Uint8Array((box.x1 - box.x0) * (box.z1 - box.z0)) }), terrainAt });
  assert.deepEqual(sea, { sea: true });
});

// A pond the ponds' rule draws, 120 m square: the 20 m grid has its banks smeared across it, up 2 m to the west and down 4 m past a dam to
// the south (a valley the grid has in it), and 2 m up to the east; the 5 m survey has its water flat at 10 m, a dune its outline takes in
// at the north-east, and a pond a step up at 11.5 m at the south-east, that OSM draws as one with it
const smeared = (x, z) => 10 + Math.max(0, 25 - x) * 0.08 - Math.max(0, z - 105) * 0.2 + (x > 60 && z > 60 ? 2 : 0);
const surveyed = (x, z) => (x >= 95 && z < 60 ? 12 + (x - 95) * 0.3 + Math.sin(z) : x >= 70 && z >= 70 ? 11.5 : 10);
const pond120 = [{ outer: [[[5, 5], [125, 5], [125, 125], [5, 125], [5, 5]]], inner: [] }];
const inPieces = (pieces, x, z) => pieces.some(([outer, ...holes]) => {
  const inside = (r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > z) !== (r[j][1] > z) && x < ((r[j][0] - r[i][0]) * (z - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c; return c; };
  return inside(outer) && !holes.some(inside);
});

test('a pond of the ponds\' rule: its level the survey\'s water, cut back off a dune, with water a step up at its own level', () => {
  const ground = [[[[0, 0], [240, 0], [240, 240], [0, 240], [0, 0]]]];
  const cut = cutPond(pond120, { groundIn: () => ground, landIn: ones, terrainAt: smeared, surveyAt: surveyed });
  assert.equal(cut.level, 10, `its level ${cut.level}`);
  assert.equal(cut.survey, 10);
  // The dune isn't its water; the rest is
  assert.ok(!inPieces(cut.pieces, 110, 30), 'water on the dune');
  assert.ok(inPieces(cut.pieces, 40, 40) && inPieces(cut.pieces, 60, 110), 'no water where the survey has it');
  assert.ok(Math.abs(cut.clipped - 31 * 55) < 120, `${cut.clipped} m² cut back`);
  // The pond a step up: its own pieces at its own level, and none of the first's
  assert.equal(cut.steps.length, 1);
  assert.equal(cut.steps[0].level, 11.5);
  assert.ok(inPieces(cut.steps[0].pieces, 100, 100) && !inPieces(cut.pieces, 100, 100), 'the step not apart');
  // The sea's rule's ponds keep the lowest ground round the edge: the dam's valley
  const old = cutPond(pond120, { groundIn: () => ground, landIn: ones, terrainAt: smeared });
  assert.ok(old.level < 7.1 && !old.steps, `its level ${old.level}`);
  // ...and so does one the survey hasn't lying flat (most of it on a slope, under a flat strip at the top), cut back off nothing: at the
  // strip's height most of its bank would be raised to it
  const sloped = cutPond(pond120, { groundIn: () => ground, landIn: ones, terrainAt: smeared, surveyAt: (x) => (x > 95 ? 12 : 6 + x * 0.05) });
  assert.equal(sloped.untrusted, true);
  assert.equal(sloped.level, old.level);
  assert.equal(sloped.clipped, 0);
  assert.ok(inPieces(sloped.pieces, 110, 30) && inPieces(sloped.pieces, 100, 100), 'cut back');
});

test('the ground under a graded pond at its level less a hollow, at its level past its edge, then back to the ground', () => {
  const { DIP, DIP_FROM, DIP_OVER, SHELF, REACH } = POND_GRADE;
  // A pond across the seam at x = 240, in two pieces, at 10 m, with an island; and one of the sea's rule's, not graded, beside it
  const pieces = [
    [10, [200, 100, 240, 100, 240, 200, 200, 200]],
    [10, [240, 100, 300, 100, 300, 200, 240, 200], [260, 140, 280, 140, 280, 160, 260, 160]],
    [4, [400, 100, 440, 100, 440, 140, 400, 140]]
  ];
  const ponds = [{ keys: ['way/1'], level: 10, pieces: 2, graded: true, first: 0 }, { keys: ['way/2'], level: 4, pieces: 1 }];
  const at = pondGrading({ pieces, ponds });
  const bank = 13;
  // In the water, deeper than DIP_FROM + DIP_OVER from its edges: its level less DIP; and the seam isn't an edge
  assert.equal(at(230, 150, bank), 10 - DIP);
  assert.equal(at(240, 150, bank), 10 - DIP, 'graded as an edge along the seam');
  // Near its edge, at its level, down to the hollow
  assert.equal(at(200 + DIP_FROM / 2, 150, bank), 10);
  const mid = at(200 + DIP_FROM + DIP_OVER / 2, 150, bank);
  assert.ok(mid < 10 && mid > 10 - DIP, `${mid}`);
  // Past its edge: its level for SHELF m, whether the bank's over it or under it (a dam's valley), then back to the ground
  for (const ground of [bank, 6]) {
    assert.equal(at(200 - 0.5, 150, ground), 10);
    assert.equal(at(200 - SHELF + 0.1, 150, ground), 10);
    const past = at(200 - SHELF - 3, 150, ground);
    assert.ok(Math.min(10, ground) < past && past < Math.max(10, ground), `${past} with the ground at ${ground}`);
    assert.equal(at(200 - REACH - 1, 150, ground), null);
  }
  // An island is a bank too
  assert.equal(at(261, 150, bank), 10);
  assert.ok(at(270, 150, bank) > 10, "the island's middle graded down to the level");
  // The sea's rule's pond isn't graded
  assert.equal(at(420, 120, 4.5), null);
  assert.equal(pondGrading({ pieces: [pieces[2]], ponds: [ponds[1]] }), null);
});

// On the last build's data, where its ponds are graded (tools/data/generated/ponds.json): the ground under each graded pond's water, as
// tools/tiles/grade-ground.mjs grades it (the roads' grading aside), within 0.5 m of its level over most of it. Before the grading, the
// ponds' rule's water was within 0.5 m of its middle height over 69% of it, and 45% of it more than 1 m over its level (Manly Dam's 5 m).
const GENERATED = new URL('../tools/data/generated/', import.meta.url).pathname;
const built = fs.existsSync(`${GENERATED}ponds.json`) && fs.existsSync(`${GENERATED}height-grid.bin.gz`) ? loadPonds(GENERATED) : null;
const WORLD = new URL('../public/tiles/world.json', import.meta.url);
test('the last build\'s graded ponds lie flat at their levels', { skip: !(built?.ponds.some((p) => p.graded) && fs.existsSync(WORLD)) && 'no graded ponds built' }, () => {
  const H = JSON.parse(fs.readFileSync(WORLD, 'utf8')).frame.heights;
  const grid = new Float32Array(H.w * H.h);
  const data = zlib.gunzipSync(fs.readFileSync(`${GENERATED}height-grid.bin.gz`));
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
  const terrainAt = (x, z) => {
    const fx = (x - H.x0) / H.cell, fz = (z - H.z0) / H.cell, i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, k = j * H.w + i;
    const a = grid[k] + (grid[k + 1] - grid[k]) * tx, b = grid[k + H.w] + (grid[k + H.w + 1] - grid[k + H.w]) * tx;
    return a + (b - a) * tz;
  };
  const at = pondGrading(built);
  const inRing = (f, x, z) => { let c = false; for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) if ((f[i + 1] > z) !== (f[j + 1] > z) && x < ((f[j] - f[i]) * (z - f[i + 1])) / (f[j + 1] - f[i + 1]) + f[i]) c = !c; return c; };
  let all = 0, allFlat = 0;
  const share = new Map();
  for (const p of built.ponds.filter((q) => q.graded)) {
    let n = 0, flat = 0;
    for (const [level, outer, ...holes] of built.pieces.slice(p.first, p.first + p.pieces)) {
      const xs = outer.filter((_, k) => k % 2 === 0), zs = outer.filter((_, k) => k % 2 === 1);
      for (let x = Math.min(...xs) + 2; x < Math.max(...xs); x += 4) {
        for (let z = Math.min(...zs) + 2; z < Math.max(...zs); z += 4) {
          if (!inRing(outer, x, z) || holes.some((h) => inRing(h, x, z))) continue;
          const h = terrainAt(x, z), g = at(x, z, h) ?? h;
          n++;
          if (Math.abs(g - level) <= 0.5) flat++;
        }
      }
    }
    all += n;
    allFlat += flat;
    for (const k of p.keys) share.set(k, n ? flat / n : 1);
  }
  assert.ok(allFlat / all >= 0.95, `${(100 * allFlat / all).toFixed(1)}% of the graded ponds' water lies flat`);
  // Manly Dam, Kurnell's sand-mining lake, Lake Parramatta and the 17 ha lake at Eastlakes
  for (const key of ['relation/18849912', 'way/179719048', 'way/8654596', 'way/172842340']) {
    if (share.has(key)) assert.ok(share.get(key) >= 0.95, `${key}: ${(100 * share.get(key)).toFixed(1)}% flat`);
  }
});

// On a real tile: a lake laid on a lawn of a tile with no garden, as tools/build-tiles.mjs hands it over
const { TILE, heldTiles } = await import('../js/geodata.js');
const { pointInPolygonXZ } = await import('../js/ground-geometry.js');
const { POND_TOP, buildTileGarden, gardenMaterials, lawnSurface } = await import('../js/garden.js');
const { drawnTop, drawnWhat } = await import('../js/drawn-ground.js');
/** A tile with no garden, and a 16 m square inside one of its lawns: the first found */
function lawnSquare() {
  for (const tile of heldTiles()) {
    if (tile.garden) continue;
    for (const [outer, ...holes] of tile.placedLawns) {
      const xs = outer.map((p) => p.x), zs = outer.map((p) => p.z);
      if (Math.max(...xs) - Math.min(...xs) < 40 || Math.max(...zs) - Math.min(...zs) < 40) continue;
      for (let x = Math.ceil(Math.min(...xs)); x + 16 < Math.max(...xs); x += 4) {
        for (let z = Math.ceil(Math.min(...zs)); z + 16 < Math.max(...zs); z += 4) {
          if (Math.floor(x / TILE) !== tile.ix || Math.floor((x + 16) / TILE) !== tile.ix || Math.floor(z / TILE) !== tile.iz || Math.floor((z + 16) / TILE) !== tile.iz) continue;
          let ok = true;
          for (let a = 0; a <= 16 && ok; a += 2) for (let b = 0; b <= 16 && ok; b += 2) {
            ok = pointInPolygonXZ(outer, x + a, z + b) && !holes.some((h) => pointInPolygonXZ(h, x + a, z + b));
          }
          if (ok) return { tile, x, z };
        }
      }
    }
  }
  return null;
}
const found = lawnSquare();
test('a lake lies on the lawn as drawn, flat at its level over a hollow, with a bank round it, and is stood on', { skip: !found && 'no lawn held' }, () => {
  const { tile, x, z } = found;
  const lawnAt = lawnSurface(tile);
  const heights = [];
  for (let a = 0; a <= 16; a += 2) for (let b = 0; b <= 16; b += 2) heights.push(lawnAt(x + a, z + b));
  heights.sort((p, q) => p - q);
  // Its level halfway up the lawn under it, so the water's flat over part of it and follows the lawn over the rest
  const level = heights[heights.length >> 1];
  const flat = [x, z, x + 16, z, x + 16, z + 16, x, z + 16];
  const lake = { ...tile, garden: undefined, lakes: [[level, flat]] };
  const mats = gardenMaterials();
  const water = [], bank = [];
  const it = buildTileGarden(lake, null, (cells, target, material) => {
    for (const c of cells.cells.values()) {
      if (!c.index.length) continue;
      if (material === mats.pond) water.push(c);
      if (material === mats.stone) bank.push(c);
    }
  });
  while (!it.next().done);
  assert.equal(water.length, 1, 'its water not one mesh');
  assert.equal(bank.length, 1, 'its bank not one mesh');
  // What's on top at points across it: the water, never under its level nor the lawn as drawn (laid on the paving too, where that runs
  // under the lawn's edge, a copy 2 cm lower)
  const tris = [];
  for (const c of water) for (let i = 0; i < c.index.length; i += 3) tris.push([0, 1, 2].map((k) => { const v = c.index[i + k] * 3; return [c.position[v], c.position[v + 1], c.position[v + 2]]; }));
  let onFlat = 0, onLawn = 0;
  for (let a = 0.5; a < 16; a += 1) {
    for (let b = 0.5; b < 16; b += 1) {
      const px = x + a, pz = z + b;
      const top = Math.max(...tris.map((t) => heightIn(t, px, pz) ?? -Infinity));
      assert.ok(Number.isFinite(top), `no water at (${px}, ${pz})`);
      assert.ok(top >= level + POND_TOP - 1e-5, `water under its level at (${px}, ${pz})`);
      assert.ok(top >= lawnAt(px, pz) + POND_TOP - 1e-4, `water under the lawn at (${px}, ${pz})`);
      // ...and exactly the higher of the two: never lifted over the lawn where that's over the level
      assert.ok(Math.abs(top - Math.max(lawnAt(px, pz) + POND_TOP, level + POND_TOP)) < 1e-4, `water ${(top - lawnAt(px, pz) - POND_TOP).toFixed(3)} m over the lawn at (${px}, ${pz})`);
      if (Math.abs(top - (level + POND_TOP)) < 1e-5) onFlat++;
      else onLawn++;
    }
  }
  assert.ok(onFlat && onLawn, `${onFlat} points flat, ${onLawn} on the lawn`);
  // The bank along its four sides, astride them, over the water
  const B = bank[0].position;
  for (let i = 0; i < B.length; i += 3) {
    const d = Math.min(Math.abs(B[i] - x), Math.abs(B[i] - x - 16), Math.abs(B[i + 2] - z), Math.abs(B[i + 2] - z - 16));
    assert.ok(d <= 0.31, `the bank ${d.toFixed(2)} m off the water's edge`);
  }
  // Stood on: the water's top, where it's flat over the lawn
  const cx = x + 8, cz = z + 8;
  const top = drawnTop(cx, cz);
  assert.ok(drawnWhat()?.startsWith('garden:'), drawnWhat());
  assert.ok(Math.abs(top - Math.max(lawnAt(cx, cz) + POND_TOP, level + POND_TOP)) < 1e-3, `stood on at ${top}`);
});
