import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The gardens (tools/build-garden.mjs, js/garden.js): the paths, beds and plants of the Royal Botanic Garden, the Domain and round the
// Opera House, as the tiles have them; people walking the paths (js/pedestrian-routes.js); and The Ribbon's model at Darling Harbour.
const { heldTiles, heldTrees } = await import('../js/geodata.js');
const { groundRoadAt } = await import('../js/surfaces.js');
const { createPedestrianRoutes } = await import('../js/pedestrian-routes.js');
const { MODEL_SITES } = await import('../js/model-sites.js');

const garden = heldTiles().filter((t) => t.garden);
const paths = garden.flatMap((t) => t.garden.paths.map(([kind, surface, width, ...line]) => {
  const pts = [];
  for (let i = 0; i + 1 < line.length; i += 2) pts.push({ x: line[i], z: line[i + 1] });
  return { kind, surface, width, pts };
}));
const segDist = (x, z, a, b) => {
  const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2));
  return Math.hypot(a.x + dx * t - x, a.z + dz * t - z);
};

test('the Royal Botanic Garden and the Domain have their footpaths, from OpenStreetMap', () => {
  let metres = 0;
  for (const p of paths) for (let i = 1; i < p.pts.length; i++) metres += Math.hypot(p.pts[i].x - p.pts[i - 1].x, p.pts[i].z - p.pts[i - 1].z);
  assert.ok(metres > 20000, `${(metres / 1000).toFixed(1)} km of path`);
  // The garden's middle, between the Palm House and the Herb Garden, and its walk along Farm Cove
  for (const [x, z] of [[760, -1000], [700, -1350]]) {
    assert.ok(paths.some((p) => p.pts.some((q) => Math.hypot(q.x - x, q.z - z) < 60)), `no path near (${x}, ${z})`);
  }
  assert.ok(garden.some((t) => t.garden.gates.length), 'no gates');
  assert.ok(garden.some((t) => t.garden.ponds.length), 'no ponds');
});

test('no path runs along a road on the ground: the footpaths beside streets are drawn already', () => {
  let on = 0, all = 0;
  for (const p of paths) {
    for (const q of p.pts) {
      all++;
      const road = groundRoadAt(q.x, q.z);
      if (road && !road.sid) on++;
    }
  }
  assert.ok(on / all < 0.01, `${on} of ${all} path points on a road`);
});

test('no garden plant stands on a path, and the small ones are planted close', () => {
  const { points, kinds } = heldTrees();
  const CELL = 16, cells = new Map();
  for (const p of paths) {
    for (let i = 1; i < p.pts.length; i++) {
      const a = p.pts[i - 1], b = p.pts[i];
      for (let x = Math.floor(Math.min(a.x, b.x) / CELL) - 1; x <= Math.floor(Math.max(a.x, b.x) / CELL) + 1; x++) {
        for (let z = Math.floor(Math.min(a.z, b.z) / CELL) - 1; z <= Math.floor(Math.max(a.z, b.z) / CELL) + 1; z++) {
          const k = x * 100000 + z;
          (cells.get(k) || cells.set(k, []).get(k)).push({ a, b, r: p.width / 2 });
        }
      }
    }
  }
  let planted = 0, small = 0;
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] < 6) continue;
    planted++;
    if (kinds[i] >= 12) small++;
    const x = points[i * 2], z = points[i * 2 + 1];
    for (const s of cells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || []) {
      assert.ok(segDist(x, z, s.a, s.b) > s.r + 0.1, `a plant of kind ${kinds[i]} at (${x}, ${z}) on a path`);
    }
  }
  assert.ok(planted > 5000 && small > planted / 2, `${planted} plants, ${small} of them small`);
});

test('paths join where they meet, and to a street\'s footpath where one ends beside it', () => {
  // A street along z = 0, 10 m wide, and two paths in the park north of it: one from beside the street to a junction, one across it
  const block = { park: 1 };
  const edge = { sx: -100, sz: 0, dx: 1, dz: 0, len: 200, rx: 0, rz: -1, half: 5, from: { in: [], out: [] }, to: { in: [], out: [] }, general: true };
  const network = {
    walkable: () => true, onSidewalk: () => true, edges: [edge],
    paths: [
      { kind: 0, surface: 1, width: 3, pts: [{ x: 0, z: -12 }, { x: 0, z: -40 }] },
      { kind: 0, surface: 1, width: 3, pts: [{ x: -30, z: -40.8 }, { x: 30, z: -40.8 }] }
    ]
  };
  const routes = createPedestrianRoutes(network, () => block);
  assert.ok(routes.paths.length >= 3, `${routes.paths.length} path tracks`);
  // Walking north up the first path, at the junction both ways along the second are there
  const up = routes.paths.find((t) => t.uz < -0.9);
  let leg = up;
  while (leg.after) leg = leg.after;
  const onward = routes.next(leg, 1, 30, -40);
  assert.ok(onward && onward[onward.length - 1].track.path, 'no way on at the junction');
  // Walking back south, it ends beside the street, and joins its footpath
  const back = routes.next(up, -1, 80, 5);
  assert.ok(back, 'the path\'s end beside the street goes nowhere');
  const last = back[back.length - 1].track;
  assert.ok(last.edge === edge, 'it doesn\'t join the street\'s footpath');
  // ...and from the footpath, the way into the park is there at the split
  const split = routes.along(edge).find((t) => t.joinAfter);
  assert.ok(split, 'the footpath isn\'t split where the path meets it');
});

test('The Ribbon is a model of its own: the tiles leave the map\'s box of it out, the far level keeps it', () => {
  const site = MODEL_SITES.find((s) => s.id === 'ribbon');
  assert.ok(site && site.far, 'no site for The Ribbon');
  const json = JSON.parse(fs.readFileSync(new URL('../public/models/ribbon.json', import.meta.url), 'utf8'));
  assert.ok(json.walls.length > 40, `${json.walls.length} walls`);
  const inside = (ring, x, z) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) c = !c;
    }
    return c;
  };
  const held = heldTiles().flatMap((t) => t.buildings);
  if (!heldTiles().some((t) => t.key === '-1_0')) return;
  assert.ok(!held.some((b) => b.polygons.some((p) => inside(p.outer, site.x, site.z))), 'the map\'s box is still in the tile');
});

// What js/garden.js draws for a tile's garden, without a GPU: its paths' triangles, and the same of the lawn under them
const { buildTileGarden, gardenMaterials } = await import('../js/garden.js');
const { GroundCells, addSurface, SIDEWALK_TOP } = await import('../js/ground-geometry.js');
function drawn(tile, which) {
  const want = gardenMaterials()[which];
  const tris = [];
  const it = buildTileGarden(tile, null, (cells, target, material) => {
    if (material !== want) return;
    for (const c of cells.cells.values()) {
      const P = c.position, I = c.index;
      for (let i = 0; i < I.length; i += 3) tris.push([I[i], I[i + 1], I[i + 2]].map((v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]));
    }
  });
  while (!it.next().done);
  return tris;
}
const heightIn = ([a, b, c], x, z) => {
  const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
  if (Math.abs(d) < 1e-9) return null;
  const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d, l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
  return l1 < -1e-6 || l2 < -1e-6 || 1 - l1 - l2 < -1e-6 ? null : l1 * a[1] + l2 * b[1] + (1 - l1 - l2) * c[1];
};

test('a tile\'s ground draws every garden path the tile holds, though one may start over its edge: the walk along Farm Cove', async () => {
  const tile = garden.find((t) => t.key === '0_-2');
  if (!tile) return; // not in the tiles held
  // The walk starts at (1003, -1258), in the next tile east, and runs west along the water through (808, -1248)
  const THREE = await import('three/webgpu');
  const { buildTileGround } = await import('../js/city-grid.js');
  const group = new THREE.Group();
  const it = buildTileGround(tile, group);
  while (!it.next().done);
  group.updateMatrixWorld(true);
  const tris = [];
  group.traverse((o) => {
    if (!o.isMesh || o.material !== gardenMaterials().paths) return;
    const P = o.geometry.attributes.position, I = o.geometry.index;
    const v = (k) => new THREE.Vector3().fromBufferAttribute(P, k).applyMatrix4(o.matrixWorld).toArray();
    for (let i = 0; i < I.count; i += 3) tris.push([v(I.getX(i)), v(I.getX(i + 1)), v(I.getX(i + 2))]);
  });
  assert.ok(tris.some((t) => heightIn(t, 808, -1248) !== null), 'no path drawn at (808, -1248) on the walk along Farm Cove');
});

test('the garden\'s paths lie over the lawn as it\'s drawn, so the lawn doesn\'t come up through them on a slope', () => {
  const tile = garden.find((t) => t.key === '0_-2');
  if (!tile) return;
  // The lawn as js/city-grid.js lays it, in 4 m cells
  const lawn = new Map();
  const cells = new GroundCells(1e6);
  for (const rings of tile.placedLawns) addSurface(cells, rings, SIDEWALK_TOP + 0.02);
  for (const c of cells.cells.values()) {
    const P = c.position, I = c.index;
    for (let i = 0; i < I.length; i += 3) {
      const t = [I[i], I[i + 1], I[i + 2]].map((v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
      for (let cx = Math.floor(Math.min(t[0][0], t[1][0], t[2][0]) / 4); cx <= Math.floor(Math.max(t[0][0], t[1][0], t[2][0]) / 4); cx++) {
        for (let cz = Math.floor(Math.min(t[0][2], t[1][2], t[2][2]) / 4); cz <= Math.floor(Math.max(t[0][2], t[1][2], t[2][2]) / 4); cz++) {
          const k = cx * 100000 + cz;
          (lawn.get(k) || lawn.set(k, []).get(k)).push(t);
        }
      }
    }
  }
  const lawnAt = (x, z) => {
    for (const t of lawn.get(Math.floor(x / 4) * 100000 + Math.floor(z / 4)) || []) {
      const y = heightIn(t, x, z);
      if (y !== null) return y;
    }
    return null;
  };
  let over = 0, under = 0;
  for (const t of drawn(tile, 'paths')) {
    const x = (t[0][0] + t[1][0] + t[2][0]) / 3, z = (t[0][2] + t[1][2] + t[2][2]) / 3, y = (t[0][1] + t[1][1] + t[2][1]) / 3;
    const l = lawnAt(x, z);
    if (l === null) continue;
    if (y - l < 0.01) under++;
    else over++;
  }
  assert.ok(over > 1000, `only ${over} of the paths' triangles over a lawn`);
  assert.ok(under / (over + under) < 0.02, `${under} of ${over + under} path triangles within a centimetre of the lawn, or under it`);
});
