import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as THREE from 'three/webgpu';

// The corridors at tunnels' mouths (js/tunnel-mouths.js): what of the ground they leave out, how far into a tube, along a cutting's own
// line, and the roof and the decks' abutments drawn with them (js/structures.js). On the real map, where it's held.
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { heldTiles, isHeld, tileKeyAt } = await import('../js/geodata.js');
const { GroundCells, addBase, baseHeight } = await import('../js/ground-geometry.js');
const { DECK_DEPTH, LINKS, PORTALS, TUNNEL_HEIGHT, groundHeight, linkById, tunnelAtPortal } = await import('../js/surfaces.js');
const { mouthHides, mouthReach, mouthShape, portalOf } = await import('../js/tunnel-mouths.js');
const { buildStructures } = await import('../js/structures.js');
const { STONE_FACE } = await import('../js/tsl-materials.js');
const held = (x, z) => [-60, 60].every((d) => isHeld(tileKeyAt(x + d, z + d)));
const portalNear = (x, z) => PORTALS.find((p) => Math.hypot(p.x - x, p.z - z) < 1);
// The road `d` m into a mouth along its tube's own line (tunnelAtPortal()), or null past the link's end
const inTube = (at, d) => {
  const pts = at.link.pts, s = at.s + at.dir * d;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], L = Math.hypot(b.x - a.x, b.z - a.z);
    if (acc + L >= s && s >= acc) { const k = L ? (s - acc) / L : 0; return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, y: a.y + (b.y - a.y) * k }; }
    acc += L;
  }
  return null;
};
const heightIn = (a, b, c, x, z) => {
  const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
  if (Math.abs(d) < 1e-9) return null;
  const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d, l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
  return l1 < -1e-6 || l2 < -1e-6 || 1 - l1 - l2 < -1e-6 ? null : l1 * a[1] + l2 * b[1] + (1 - l1 - l2) * c[1];
};

test('the base\'s height by its formula is the base as drawn', (t) => {
  const tile = heldTiles().find((k) => k.key === '-1_-2');
  if (!tile) return t.skip('not held');
  const cells = new GroundCells(1e6);
  const box = { x0: -300, x1: -150, z0: -1400, z1: -1250 };
  const job = addBase(cells, () => true, undefined, box);
  while (!job.next().done);
  const tris = [];
  for (const c of cells.cells.values()) {
    for (let i = 0; i < c.index.length; i += 3) tris.push([0, 1, 2].map((k) => c.position.slice(c.index[i + k] * 3, c.index[i + k] * 3 + 3)));
  }
  let checked = 0;
  for (let x = -290.3; x < -160; x += 7.1) {
    for (let z = -1390.7; z < -1260; z += 6.3) {
      const drawn = tris.map(([a, b, c]) => heightIn(a, b, c, x, z)).find((y) => y !== null);
      if (drawn === undefined) continue;
      assert.ok(Math.abs(drawn - baseHeight(x, z)) < 1e-3, `at (${x.toFixed(1)}, ${z.toFixed(1)}): drawn ${drawn.toFixed(3)}, by formula ${baseHeight(x, z).toFixed(3)}`);
      checked++;
    }
  }
  assert.ok(checked > 200, `only ${checked} points checked`);
});

test('in the Cahill\'s tube under Cumberland St, the ground climbing from the cutting to over the tube is left out, the ground over it isn\'t', (t) => {
  // The westbound Cahill goes in at (-229.75, -1322.62); the base climbs through the tube 10-24 m in, rising from the road to the ceiling
  const p = portalNear(-229.75, -1322.62);
  if (!p || !held(p.x, p.z)) return t.skip('not held');
  const reach = mouthReach(p);
  assert.ok(reach >= 20 && reach <= 40, `reaches ${reach} m in`);
  const at = tunnelAtPortal(p);
  for (const d of [12, 16, 20]) {
    const { x, z, y } = inTube(at, d);
    const base = baseHeight(x, z);
    assert.ok(base - y > 0.5 && base - y < TUNNEL_HEIGHT - 0.6, `the base ${(base - y).toFixed(2)} m over the road ${d} m in: not the climb this test is about`);
    assert.ok(mouthHides(p, x, base, z), `the base at ${base.toFixed(2)}, ${d} m in, is drawn in the tube`);
    const over = groundHeight(x, z) + 0.22;
    assert.ok(!mouthHides(p, x, over, z), `the ground over the tube ${d} m in is left out`);
  }
});

test('over a curved cutting the corridor follows it: the lawn that sloped into the Cahill\'s cutting by Cumberland St is left out', (t) => {
  // 17 m out from the mouth the cutting has turned; the lawn's triangle in front of its north wall was at 25.91 m
  const p = portalNear(-229.75, -1322.62);
  if (!p || !held(p.x, p.z)) return t.skip('not held');
  assert.ok(mouthHides(p, -212, 25.91, -1324), 'the lawn in front of the wall is drawn');
  // ...and the ground behind the wall's top, outside the cutting, is drawn
  assert.ok(!mouthHides(p, -212, groundHeight(-212, -1328), -1328), 'the ground behind the north wall is left out');
});

test('a street crossing over a cutting at its portal keeps its footpaths', (t) => {
  // Art Gallery Rd over the Cahill's eastbound mouth by the Domain: its footpath at 32.27 m, 6.6 m over the tunnel's road
  const p = portalNear(504.21, -887.08);
  if (!p || !held(p.x, p.z)) return t.skip('not held');
  assert.ok(!mouthHides(p, 503, 32.27, -885), 'the footpath over the portal is left out');
});

test('every mouth\'s corridor leaves out the base wherever it climbs through the tube within its reach, and its portal is the tiles\'', () => {
  let mouths = 0, points = 0;
  for (const p of PORTALS) {
    if (!held(p.x, p.z)) continue;
    const at = tunnelAtPortal(p);
    assert.ok(at, `no tunnel found at the portal (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`);
    const again = portalOf(at.link, at.dir > 0);
    assert.ok(again && Math.hypot(again.x - p.x, again.z - p.z) < 0.01, `the portal at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) isn't its link's`);
    const shape = mouthShape(p);
    // Along the tube's own line from the portal, every 2 m to the reach, its middle
    for (let d = 2; d <= shape.reach - 3; d += 2) {
      const q = inTube(at, d);
      if (!q) break;
      const base = baseHeight(q.x, q.z);
      if (base - q.y > 0.2 && base - q.y < TUNNEL_HEIGHT - 1.6) {
        assert.ok(mouthHides(p, q.x, base, q.z), `the base ${(base - q.y).toFixed(2)} m over the road, ${d} m into the mouth at (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`);
        points++;
      }
    }
    mouths++;
  }
  assert.ok(mouths > 20 && points > 50, `${mouths} mouths, ${points} points`);
});

test('a tube is roofed as far in as its corridor reaches', (t) => {
  const p = portalNear(-229.75, -1322.62);
  if (!p || !held(p.x, p.z)) return t.skip('not held');
  const at = tunnelAtPortal(p), link = at.link;
  const group = new THREE.Group();
  const job = buildStructures(group, new THREE.MeshBasicNodeMaterial(), [link], LINKS);
  while (!job.next().done);
  // The roof: upward faces at the ceiling's height plus ROOF (0.3 m), over the tube's middle
  const reach = mouthReach(p);
  const roofAt = (d) => {
    const q = inTube(at, d);
    if (!q) return null;
    const { x, z, y: road } = q;
    let found = false;
    group.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || found) return;
      const P = o.geometry.attributes.position.array, I = o.geometry.index.array;
      for (let i = 0; i < I.length && !found; i += 3) {
        const v = [0, 1, 2].map((k) => [P[I[i + k] * 3], P[I[i + k] * 3 + 1], P[I[i + k] * 3 + 2]]);
        const y = heightIn(...v, x, z);
        if (y !== null && y > road + TUNNEL_HEIGHT + 0.1 && y < road + TUNNEL_HEIGHT + 1.5) found = true;
      }
    });
    return found;
  };
  assert.equal(roofAt(reach - 4), true, `no roof ${reach - 4} m in`);
  // Its roof is drawn over the stations (every 6 m) within reach of the mouth's: none a station further on
  const past = [reach + 13, reach + 10, reach + 8].find((d) => roofAt(d) !== null);
  if (past !== undefined) assert.equal(roofAt(past), false, `a roof ${past} m in, past the corridor`);
});

test('where Syd Einfeld Dr\'s deck crosses Vernon St, an abutment\'s face hangs from its soffit over each bank', (t) => {
  // The eastbound deck leaves the ground at (3933, 1382) over Vernon St's cutting, 6.7 m under it
  if (!isHeld('3_1')) return t.skip('not held');
  const links = [linkById.get(22637), linkById.get(46488)].filter(Boolean);
  if (links.length < 2) return t.skip('links not held');
  const group = new THREE.Group();
  const job = buildStructures(group, new THREE.MeshBasicNodeMaterial(), links, LINKS);
  while (!job.next().done);
  // Upright faces in stone (uv.y STONE_FACE) whose top is at the soffit, between x 3934 and 3962
  const faces = [];
  group.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh) return;
    const P = o.geometry.attributes.position.array, U = o.geometry.attributes.uv.array, N = o.geometry.attributes.normal.array;
    for (let v = 0; v < P.length / 3; v++) {
      if (U[v * 2 + 1] !== STONE_FACE || Math.abs(N[v * 3 + 1]) > 0.01) continue;
      const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
      if (x < 3934 || x > 3962 || z < 1375 || z > 1395) continue;
      const deck = links.map((l) => l.pts).flat().reduce((best, q) => (Math.hypot(q.x - x, q.z - z) < Math.hypot(best.x - x, best.z - z) ? q : best));
      if (Math.abs(y - (deck.y - DECK_DEPTH)) < 0.6) faces.push({ x, z });
    }
  });
  assert.ok(faces.some((f) => f.x < 3944), 'no abutment over Vernon St\'s west bank');
  assert.ok(faces.some((f) => f.x > 3944), 'no abutment over Vernon St\'s east bank');
});
