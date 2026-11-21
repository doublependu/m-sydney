import assert from 'node:assert/strict';
import test from 'node:test';

// The cover over a model site's cut (js/city-grid.js): while the map's buildings stand in for the model (js/first-shapes.js), the ground
// cut out for what the model has under its floor is drawn again over the hole, as it was, and stood on. For the cuts in the tiles held
// (SYDNEY_TILES: 55's row on Lower Fort St and Customs House in the CBD's).
const { heldTiles } = await import('../js/geodata.js');
const { SITE_CUTS } = await import('../js/model-sites.js');
const { pointInPolygonXZ } = await import('../js/ground-geometry.js');

const area = (poly) => Math.abs(poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + p.x * q.z - q.x * p.z; }, 0) / 2);
const triArea = (t, k) => Math.abs((t[k + 3] - t[k]) * (t[k + 8] - t[k + 2]) - (t[k + 6] - t[k]) * (t[k + 5] - t[k + 2])) / 2;

for (const cut of SITE_CUTS) {
  // The tile whose lawn or paving holds the cut whole: the one that cuts it, and draws its cover
  const tile = heldTiles().find((t) => [...(t.placedLawns || []), ...(t.placedPavements || [])].some((rings) => cut.poly.every((q) => pointInPolygonXZ(rings[0], q.x, q.z))));
  if (!tile) continue; // not in the tiles held
  test(`${cut.id}: its cut has a cover, the ground that was cut out, its edge the hole's, stood on while it's drawn`, async () => {
    const THREE = await import('three/webgpu');
    const { buildTileGround, groundMaterials } = await import('../js/city-grid.js');
    const ground = new Set([groundMaterials().lawn, groundMaterials().sidewalk]);
    const group = new THREE.Group();
    const job = buildTileGround(tile, group);
    while (!job.next().done);
    const cover = group.children.find((o) => o.userData.firstShape === cut.id);
    assert.ok(cover, `no cover over ${cut.id}'s cut in tile ${tile.key}`);
    assert.equal(cover.name, `Cover_${cut.id}`);
    // Its ground for the lookup (js/drawn-ground.js): triangles over the whole cut, at the ground's height, and nothing outside it
    const tris = cover.userData.ground;
    assert.ok(tris?.length, 'no ground to stand on');
    let covered = 0;
    for (const t of tris) {
      for (let k = 0; k < t.length; k += 9) {
        covered += triArea(t, k);
        const mx = (t[k] + t[k + 3] + t[k + 6]) / 3, mz = (t[k + 2] + t[k + 5] + t[k + 8]) / 3;
        assert.ok(pointInPolygonXZ(cut.poly, mx, mz), `a triangle of the cover at (${mx.toFixed(1)}, ${mz.toFixed(1)}) outside the cut`);
      }
    }
    const want = area(cut.poly) * tris.length; // each piece the cut was taken from has its own cover
    assert.ok(Math.abs(covered - want) < want * 0.01, `the cover is ${covered.toFixed(1)} m² of the cut's ${want.toFixed(1)}`);
    // ...drawn: as many triangles in its meshes, in the ground's own materials
    let drawn = 0;
    cover.traverse((o) => {
      if (!o.isMesh) return;
      assert.ok(ground.has(o.material), 'a cover not in the lawn\'s or the paving\'s look');
      drawn += o.geometry.index.count / 3;
    });
    assert.equal(drawn, tris.reduce((n, t) => n + t.length / 9, 0));
    // ...and the tile's own lawn and paving still have the hole: none of their triangles in the cut
    const inside = [];
    group.traverse((o) => {
      if (!o.isMesh || !ground.has(o.material) || cover.getObjectById(o.id)) return;
      const P = o.geometry.attributes.position, I = o.geometry.index;
      for (let i = 0; i < I.count; i += 3) {
        const v = [I.getX(i), I.getX(i + 1), I.getX(i + 2)];
        const mx = v.reduce((s, j) => s + P.getX(j), 0) / 3, mz = v.reduce((s, j) => s + P.getZ(j), 0) / 3;
        if (pointInPolygonXZ(cut.poly, mx, mz)) inside.push([mx, mz]);
      }
    });
    assert.equal(inside.length, 0, `the tile's ground still has ${inside.length} triangles in the cut`);
  });
}
