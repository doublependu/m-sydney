import assert from 'node:assert/strict';
import test from 'node:test';
import { readModel, triangles } from './helpers/glb.mjs';

// The buildings drawn from models (js/model-sites.js), on the map: a site that replaces the map's buildings leaves them out of its tiles,
// so the map draws its outline instead (js/city-map.js), which must be where the model stands.
const { MODEL_SITES, SITE_OUTLINES, toWorldOf } = await import('../js/model-sites.js');

const NEAR = 0.5; // m: how far an outline can be from what it outlines
const inRing = (ring, x, z) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};
const toSegment = (x, z, a, b) => {
  const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
  const t = L ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L)) : 0;
  return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz);
};
const toRing = (ring, x, z) => (inRing(ring, x, z) ? 0 : Math.min(...ring.map((a, i) => toSegment(x, z, a, ring[(i + 1) % ring.length]))));
const toTriangle = (t, x, z) => {
  const P = [t.a, t.b, t.c].map((p) => [p[0], p[2]]);
  return toRing(P, x, z);
};

test('every site that replaces the map\'s buildings, or has a far version, has an outline for the map, and a far version', () => {
  for (const site of MODEL_SITES.filter((s) => (s.replaces.length || s.far) && !s.debug)) {
    assert.ok(site.outline?.length, `${site.id} has no outline: the map would have a hole where its buildings were`);
    assert.ok(site.far, `${site.id} has no far version to stand in for it`);
    for (const [h, ring] of site.outline) {
      assert.ok(h > 0 && ring.length >= 3, `${site.id}: a ring of ${ring.length} points, ${h} m high`);
    }
  }
});

test('the map has each outline in the world\'s frame', () => {
  const sites = MODEL_SITES.filter((s) => s.outline && !s.debug);
  assert.equal(SITE_OUTLINES.length, sites.reduce((n, s) => n + s.outline.length, 0));
  const site = MODEL_SITES.find((s) => s.id === 'salesforce-tower');
  const [h, ring] = site.outline.at(-1);
  const drawn = SITE_OUTLINES.find((f) => f.h === h);
  assert.deepEqual(drawn.pts[0], toWorldOf(site, ...ring[0]));
});

for (const site of MODEL_SITES.filter((s) => s.outline && s.far)) {
  test(`${site.id}: its outline holds its far version from above, to within ${NEAR} m, and outlines nothing else`, async () => {
    const tris = [...triangles(await readModel(`${site.file.replace('models/', '')}-far`))];
    const rings = site.outline.map(([, ring]) => ring);
    // ...but what a far version draws on the ground, which isn't a building: a deck, a pool, a pad or a lawn at the floor or under it;
    // the ground over its site's cut (the lawn's green in it); and a cutting's face, on the cut's edge
    const cut = site.cut?.poly;
    const onCut = (p) => cut && toRing(cut, p[0], p[2]) < 0.01;
    const edge = (p) => cut && cut.some((a, i) => toSegment(p[0], p[2], a, cut[(i + 1) % cut.length]) < 0.01);
    const upright = (t) => Math.abs((t.b[0] - t.a[0]) * (t.c[2] - t.a[2]) - (t.c[0] - t.a[0]) * (t.b[2] - t.a[2])) < 1e-4;
    const green = (t) => t.color && t.color[1] > 1.2 * t.color[0] && t.color[1] > 1.2 * t.color[2];
    const ground = (t) => Math.max(t.a[1], t.b[1], t.c[1]) <= 0.3 || (green(t) && [t.a, t.b, t.c].every(onCut))
      || (upright(t) && [t.a, t.b, t.c].every(edge));
    let worst = 0, at = null;
    for (const t of tris) {
      for (const p of [t.a, t.b, t.c]) {
        if (ground(t)) continue;
        const d = Math.min(...rings.map((r) => toRing(r, p[0], p[2])));
        if (d > worst) { worst = d; at = p; }
      }
    }
    assert.ok(worst <= NEAR, `${site.id}: its far version reaches ${worst.toFixed(2)} m past its outline at (${at?.map((v) => v.toFixed(1))})`);
    for (const ring of rings) {
      for (const [x, z] of ring) {
        const d = Math.min(...tris.map((t) => toTriangle(t, x, z)));
        assert.ok(d <= NEAR, `${site.id}: its outline's corner (${x}, ${z}) is ${d.toFixed(2)} m from its far version`);
      }
    }
  });
}
