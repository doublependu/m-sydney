import assert from 'node:assert/strict';
import test from 'node:test';
import { cutPond } from '../tools/pond-pieces.mjs';

// Still water outside the gardens: how tools/build-ponds.mjs cuts a pond to the ground and finds its level (cutPond()), and how the game
// draws and stands you on it (js/garden.js, tile.lakes; js/drawn-ground.js).

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
