import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The gardens (tools/build-garden.mjs, js/garden.js): the paths, beds and plants of the Royal Botanic Garden, the Domain and round the
// Opera House, and the parks since (the CBD's, Bradfield Park, Prince Alfred Park, Darling Harbour's), as the tiles have them; people
// walking the paths (js/pedestrian-routes.js); and The Ribbon's model at Darling Harbour.
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
  // A path is laid on the lawn's triangles and on the paving's (which runs under the lawn's edge): at each point, the top of what's laid
  const paths = drawn(tile, 'paths');
  const pathCells = new Map();
  for (const t of paths) {
    for (let cx = Math.floor(Math.min(t[0][0], t[1][0], t[2][0]) / 4); cx <= Math.floor(Math.max(t[0][0], t[1][0], t[2][0]) / 4); cx++) {
      for (let cz = Math.floor(Math.min(t[0][2], t[1][2], t[2][2]) / 4); cz <= Math.floor(Math.max(t[0][2], t[1][2], t[2][2]) / 4); cz++) {
        const k = cx * 100000 + cz;
        (pathCells.get(k) || pathCells.set(k, []).get(k)).push(t);
      }
    }
  }
  const pathTopAt = (x, z) => {
    let top = -Infinity;
    for (const t of pathCells.get(Math.floor(x / 4) * 100000 + Math.floor(z / 4)) || []) {
      const y = heightIn(t, x, z);
      if (y !== null) top = Math.max(top, y);
    }
    return top;
  };
  let over = 0, under = 0;
  for (const t of paths) {
    const x = (t[0][0] + t[1][0] + t[2][0]) / 3, z = (t[0][2] + t[1][2] + t[2][2]) / 3;
    const l = lawnAt(x, z);
    if (l === null) continue;
    // A track lies a centimetre over the lawn (js/drawn-ground.js TRACK_TOP), a path a little more; anything nearer would fight it
    if (pathTopAt(x, z) - l < 0.005) under++;
    else over++;
  }
  assert.ok(over > 1000, `only ${over} of the paths' triangles over a lawn`);
  assert.ok(under / (over + under) < 0.02, `${under} of ${over + under} path triangles within half a centimetre of the lawn, or under it`);
});

// A formal park's raised lawn (tools/build-garden.mjs): the map's lawn in it less a corridor along each kerbed path, its ponds left out
const raisedPieces = garden.flatMap((t) => (t.garden.lawns || []).map(([kerb, ...flats]) => {
  const rings = flats.map((f) => {
    const pts = [];
    for (let i = 0; i + 1 < f.length; i += 2) pts.push({ x: f[i], z: f[i + 1] });
    return pts;
  });
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of rings[0]) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  return { kerb, rings, x0, x1, z0, z1 };
}));
const ringArea = (r) => {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p.x * q.z - q.x * p.z; }
  return Math.abs(a) / 2;
};
const onRaised = (x, z) => raisedPieces.some((p) => {
  if (x < p.x0 || x > p.x1 || z < p.z0 || z > p.z1) return false;
  let k = false;
  for (const r of p.rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i], b = r[j];
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) k = !k;
    }
  }
  return k;
});
const kerbedPaths = paths.filter((p) => p.kind !== 3 && p.surface !== 4);
// A garden's paved areas (OSM's pedestrian areas, and those drawn by hand): cut out of the raised lawn, as its paths are
const piecesOf = (list) => list.map(([value, ...flats]) => {
  const rings = flats.map((f) => {
    const pts = [];
    for (let i = 0; i + 1 < f.length; i += 2) pts.push({ x: f[i], z: f[i + 1] });
    return pts;
  });
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of rings[0]) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  return { value, rings, x0, x1, z0, z1 };
});
const plazaPieces = piecesOf(garden.flatMap((t) => t.garden.plazas || []));
const inPiece = (p, x, z) => {
  if (x < p.x0 || x > p.x1 || z < p.z0 || z > p.z1) return false;
  let k = false;
  for (const r of p.rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i], b = r[j];
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) k = !k;
    }
  }
  return k;
};
const onPlaza = (x, z) => plazaPieces.some((p) => inPiece(p, x, z));
/** Points along a path every `step` m, with its way across there, `trim` m short of each end */
function along(p, step, trim = 0) {
  const out = [];
  let L = 0;
  for (let i = 1; i < p.pts.length; i++) L += Math.hypot(p.pts[i].x - p.pts[i - 1].x, p.pts[i].z - p.pts[i - 1].z);
  let s = 0;
  for (let i = 1; i < p.pts.length; i++) {
    const a = p.pts[i - 1], b = p.pts[i], d = Math.hypot(b.x - a.x, b.z - a.z);
    if (d < 1e-6) continue;
    for (let t = (Math.ceil(s / step) * step - s); t < d; t += step) {
      if (s + t < trim || s + t > L - trim) continue;
      out.push({ x: a.x + ((b.x - a.x) * t) / d, z: a.z + ((b.z - a.z) * t) / d, nx: -(b.z - a.z) / d, nz: (b.x - a.x) / d });
    }
    s += d;
  }
  return out;
}

test('the raised lawn covers a kerbed path\'s middle at 2 points in 10,000 at most, and none of it is under a square metre', { skip: !raisedPieces.length && 'no raised lawn in the tiles held' }, () => {
  let samples = 0;
  const over = [];
  for (const p of kerbedPaths) {
    for (const q of along(p, 0.5)) {
      samples++;
      if (onRaised(q.x, q.z)) over.push([+q.x.toFixed(2), +q.z.toFixed(2)]);
    }
  }
  assert.ok(samples > 10000, `${samples} points on kerbed paths`);
  // Where a kerbed path ends on a track (worn into the raised lawn, not cut from it) the traced corner of its corridor's end can cut across
  // it: a few points in tens of thousands, at its very end
  assert.ok(over.length <= samples * 2e-4, `the raised lawn over the middle of a path at ${over.length} of ${samples} points: ${JSON.stringify(over.slice(0, 8))}`);
  for (const p of raisedPieces) {
    const area = ringArea(p.rings[0]) - p.rings.slice(1).reduce((t, r) => t + ringArea(r), 0);
    assert.ok(area >= 1, `a piece of ${area.toFixed(2)} m² at (${p.rings[0][0].x}, ${p.rings[0][0].z})`);
    for (const r of p.rings.slice(1)) assert.ok(ringArea(r) >= 1, `a hole of ${ringArea(r).toFixed(2)} m² at (${r[0].x}, ${r[0].z})`);
  }
});

test('a kerbed path has the raised lawn beside it, on one side at least, wherever there\'s lawn beside it', { skip: !raisedPieces.length && 'no raised lawn in the tiles held' }, async () => {
  const { lawnSurface } = await import('../js/garden.js');
  const lawnAt = new Map();
  const lawn = (x, z) => {
    const t = garden.find((g) => Math.floor(x / 1000) === g.ix && Math.floor(z / 1000) === g.iz);
    if (!t) return null;
    if (!lawnAt.has(t)) lawnAt.set(t, lawnSurface(t));
    return lawnAt.get(t)(x, z);
  };
  // Just past the kerb either side, a quarter metre into where the raised lawn starts: off any other path's corridor
  const inCorridor = (x, z) => kerbedPaths.some((p) => {
    for (let i = 1; i < p.pts.length; i++) if (segDist(x, z, p.pts[i - 1], p.pts[i]) < p.width / 2 + 0.1) return true;
    return false;
  });
  let beside = 0, bare = 0;
  const where = [];
  for (const p of kerbedPaths) {
    for (const q of along(p, 2, 3)) {
      // ...and off a paved area: a path across a plaza has the plaza beside it
      const sides = [1, -1].map((k) => ({ x: q.x + q.nx * k * (p.width / 2 + 0.35), z: q.z + q.nz * k * (p.width / 2 + 0.35) }))
        .filter((s) => lawn(s.x, s.z) !== null && !inCorridor(s.x, s.z) && !onPlaza(s.x, s.z));
      if (!sides.length) continue;
      if (sides.some((s) => onRaised(s.x, s.z))) beside++;
      else {
        bare++;
        if (where.length < 6) where.push([+q.x.toFixed(1), +q.z.toFixed(1)]);
      }
    }
  }
  assert.ok(beside > 3000, `${beside} points with the raised lawn beside them`);
  // Left bare: a path along an area's outline, with only the map's lawn outside it. Centennial Park's outline runs along the footpaths of
  // the streets round it (Alison Rd, Oxford St), a seventh of its paths' points
  assert.ok(bare / (beside + bare) < 0.04, `${bare} of ${beside + bare} points on a path with lawn beside it but none raised: ${JSON.stringify(where)}`);
});

test('the CBD\'s parks are gardens: Hyde Park\'s paths, the Archibald Fountain in its plaza and the Pool of Reflection, Barangaroo Reserve, Observatory Hill and Wynyard Park', { skip: !garden.some((t) => t.key === '0_-1') && 'Hyde Park\'s tiles not held' }, () => {
  for (const [x, z, what] of [[415, -150, 'the fig avenue'], [413, 60, 'Hyde Park South'], [-720, -1409, 'Barangaroo Reserve'], [-366, -1462, 'Observatory Hill'], [-190, -734, 'Wynyard Park']]) {
    assert.ok(paths.some((p) => p.pts.some((q, i) => i && segDist(x, z, p.pts[i - 1], q) < p.width / 2 + 1)), `no path at ${what} (${x}, ${z})`);
  }
  const fountain = garden.flatMap((t) => t.garden.fountains || []).find(([x, z]) => Math.hypot(x - 415.7, z + 297.1) < 2);
  assert.ok(fountain && fountain[2] > 8, `the Archibald Fountain: ${JSON.stringify(fountain)}`);
  const ponds = garden.flatMap((t) => t.garden.ponds);
  for (const [x, z, what] of [[415.7, -297.1, 'the Archibald Fountain'], [412.5, 170.3, 'the Pool of Reflection']]) {
    assert.ok(ponds.some((f) => {
      let k = false;
      for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) if ((f[i + 1] > z) !== (f[j + 1] > z) && x < ((f[j] - f[i]) * (z - f[i + 1])) / (f[j + 1] - f[i + 1]) + f[i]) k = !k;
      return k;
    }), `no pond at ${what}`);
  }
  // The fountain stands in its plaza: paved all round it, between its rim and 20 m out, not raised lawn
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
    const x = 415.7 + Math.cos(a) * 16, z = -297.1 + Math.sin(a) * 16;
    assert.ok(onPlaza(x, z) && !onRaised(x, z), `the fountain's plaza at (${x.toFixed(1)}, ${z.toFixed(1)})`);
  }
});

test('a paved area has no raised lawn over it, and none is under a square metre', { skip: !plazaPieces.length && 'no paved areas in the tiles held' }, () => {
  let samples = 0;
  const over = [];
  for (const p of plazaPieces) {
    const area = ringArea(p.rings[0]) - p.rings.slice(1).reduce((t, r) => t + ringArea(r), 0);
    assert.ok(area >= 1, `a paved area of ${area.toFixed(2)} m² at (${p.rings[0][0].x}, ${p.rings[0][0].z})`);
    // On a half-metre grid, 0.2 m in from its edges: the raised lawn's kerb stands on its edge
    for (let x = Math.ceil(p.x0 * 2) / 2; x < p.x1; x += 0.5) {
      for (let z = Math.ceil(p.z0 * 2) / 2; z < p.z1; z += 0.5) {
        if (!inPiece(p, x, z) || [[0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2]].some(([dx, dz]) => !inPiece(p, x + dx, z + dz))) continue;
        samples++;
        if (onRaised(x, z)) over.push([x, z]);
      }
    }
  }
  assert.ok(samples > 1000, `${samples} points on paved areas`);
  assert.ok(over.length <= samples * 0.005, `the raised lawn over a paved area at ${over.length} of ${samples} points: ${JSON.stringify(over.slice(0, 8))}`);
});

test('where the garden\'s trees are the City\'s register\'s (Hyde Park, Prince Alfred Park), it plants none of its own over them', { skip: !garden.some((t) => t.key === '0_-1') && 'Hyde Park\'s tiles not held' }, () => {
  const { points, kinds } = heldTrees();
  // Hyde Park North and South, less their edges along the streets; Prince Alfred Park; not the small plants (cycads and up)
  for (const [x0, x1, z0, z1, least, what] of [[300, 505, -395, 345, 400, 'Hyde Park'], [-120, 175, 1430, 1805, 200, 'Prince Alfred Park']]) {
    const trees = [];
    for (let i = 0; i < kinds.length; i++) {
      const x = points[i * 2], z = points[i * 2 + 1];
      if (x > x0 && x < x1 && z > z0 && z < z1 && kinds[i] < 10) trees.push([x, z]);
    }
    assert.ok(trees.length > least, `${trees.length} trees in ${what}`);
    let doubled = 0;
    for (let i = 0; i < trees.length; i++) for (let j = i + 1; j < trees.length; j++) if (Math.hypot(trees[i][0] - trees[j][0], trees[i][1] - trees[j][1]) < 1) doubled++;
    assert.ok(doubled <= 2, `${doubled} pairs of trees within a metre of each other in ${what}`);
  }
});

const inFlatRing = (f, x, z) => {
  let k = false;
  for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) if ((f[i + 1] > z) !== (f[j + 1] > z) && x < ((f[j] - f[i]) * (z - f[i + 1])) / (f[j + 1] - f[i + 1]) + f[i]) k = !k;
  return k;
};

test('Bradfield Park, Prince Alfred Park, Tumbalong Park and the Chinese Garden of Friendship are gardens: their paths, pale concrete only where a park says so, and the Chinese Garden\'s lake edged with rocks', { skip: !garden.some((t) => t.key === '-1_0') && 'Darling Harbour\'s tile not held' }, () => {
  for (const [x, z, what] of [[140, -2694.2, 'Bradfield Park, under the bridge'], [-53, 1726, 'Prince Alfred Park'], [-441, 359, 'Tumbalong Park'], [-305, 442.9, 'the Chinese Garden']]) {
    assert.ok(paths.some((p) => p.pts.some((q, i) => i && segDist(x, z, p.pts[i - 1], q) < p.width / 2 + 1)), `no path at ${what} (${x}, ${z})`);
  }
  // Concrete (7) in Prince Alfred Park, Tumbalong Park and the Chinese Garden alone: the older gardens' concrete is drawn as asphalt still
  const concrete = paths.filter((p) => p.surface === 7);
  assert.ok(concrete.length > 20, `${concrete.length} concrete paths`);
  for (const p of concrete) {
    const { x, z } = p.pts[0];
    assert.ok((x > -150 && x < 200 && z > 1400 && z < 1840) || (x > -500 && x < -270 && z > 290 && z < 500), `a concrete path at (${x}, ${z})`);
  }
  // The Chinese Garden's ponds are edged with rocks, the Lake of Brightness and the Lotus Pond among them; no other garden's are
  const rocky = garden.flatMap((t) => (t.garden.rockPonds || []).map((f) => ({ f, tile: t.key })));
  assert.equal(rocky.length, 5);
  assert.ok(rocky.every(({ tile }) => tile === '-1_0'), 'rock-edged ponds outside the Chinese Garden');
  for (const [x, z, what] of [[-339, 437, 'the Lake of Brightness'], [-361, 461, 'the Lotus Pond']]) {
    assert.ok(rocky.some(({ f }) => inFlatRing(f, x, z)), `no rock-edged pond at ${what}`);
  }
  assert.ok(!garden.find((t) => t.key === '-1_0').garden.ponds.length, 'a pond with a coping in the Chinese Garden');
});

test('the Chinese Garden\'s ponds are edged with rocks all round, but not where two of them meet and the water runs on', { skip: !garden.some((t) => t.key === '-1_0') && 'Darling Harbour\'s tile not held' }, async () => {
  const { POND_ROCKS, buildTileGarden, gardenMaterials } = await import('../js/garden.js');
  const tile = garden.find((t) => t.key === '-1_0');
  const stone = [];
  const it = buildTileGarden(tile, null, (cells, target, material) => { if (material === gardenMaterials().stone) stone.push(cells); });
  while (!it.next().done);
  // The rocks' points (the stone in their tones, not the raised lawn's kerbs), by 1 m cell
  const isRock = (c, i) => POND_ROCKS.tones.some((t) => t.every((v, k) => Math.abs(c.color[i * 3 + k] - v) < 1e-6));
  const near = new Map();
  for (const cells of stone) {
    for (const c of cells.cells.values()) {
      for (let i = 0; i < c.position.length; i += 3) {
        if (!isRock(c, i / 3)) continue;
        const key = `${Math.floor(c.position[i])},${Math.floor(c.position[i + 2])}`;
        (near.get(key) || near.set(key, []).get(key)).push([c.position[i], c.position[i + 2]]);
      }
    }
  }
  const stoneWithin = (x, z, r) => {
    for (let i = Math.floor(x - r); i <= Math.floor(x + r); i++) {
      for (let k = Math.floor(z - r); k <= Math.floor(z + r); k++) if ((near.get(`${i},${k}`) || []).some(([px, pz]) => Math.hypot(px - x, pz - z) < r)) return true;
    }
    return false;
  };
  const rings = tile.garden.rockPonds.map((f) => { const r = []; for (let i = 0; i + 1 < f.length; i += 2) r.push({ x: f[i], z: f[i + 1] }); return r; });
  const ringDist = (r, x, z) => Math.min(...r.map((a, i) => segDist(x, z, r[(i + r.length - 1) % r.length], a)));
  let along = 0, bare = 0, shared = 0, rocked = 0;
  for (const r of rings) {
    const others = rings.filter((o) => o !== r);
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length], L = Math.hypot(b.x - a.x, b.z - a.z);
      for (let s = 0; s < L; s += 2) {
        const x = a.x + ((b.x - a.x) * s) / L, z = a.z + ((b.z - a.z) * s) / L;
        const d = Math.min(...others.map((o) => ringDist(o, x, z)));
        if (d < 0.1) {
          // On another pond's edge too: the water runs on, no rock across it
          shared++;
          if (stoneWithin(x, z, 0.15)) rocked++;
        } else if (d > 1.5) {
          along++;
          if (!stoneWithin(x, z, 1.2)) bare++;
        }
      }
    }
  }
  assert.ok(along > 300, `${along} points along the ponds' edges`);
  assert.ok(bare <= along * 0.02, `no rock within 1.2 m at ${bare} of ${along} points along the ponds' edges`);
  assert.ok(shared > 5 && rocked === 0, `rocks at ${rocked} of ${shared} points where two ponds meet`);
});

test('nothing of a garden stands in the Harbour Bridge\'s pylons or piers: Bradfield Park\'s trees, plants and gates', { skip: !garden.some((t) => t.key === '0_-3') && 'Bradfield Park\'s tiles not held' }, async () => {
  const { bridgeFeet } = await import('../js/harbour-bridge.js');
  const feet = bridgeFeet();
  assert.ok(feet.length > 20, `${feet.length} feet`);
  const inFoot = (x, z, m) => feet.some((f) => {
    const dx = x - f.x, dz = z - f.z;
    return Math.abs(dx * f.ux + dz * f.uz) <= f.along + m && Math.abs(dz * f.ux - dx * f.uz) <= f.across + m;
  });
  const { points, kinds } = heldTrees();
  let n = 0;
  for (let i = 0; i < kinds.length; i++) {
    const x = points[i * 2], z = points[i * 2 + 1];
    if (x < -110 || x > 270 || z < -3280 || z > -2500) continue;
    n++;
    // A tree's trunk 1.5 m clear, a small plant's half a metre (each kept to the half metre)
    assert.ok(!inFoot(x, z, kinds[i] >= 10 ? 0.25 : 1.25), `a plant (kind ${kinds[i]}) in the bridge's foot at (${x}, ${z})`);
  }
  assert.ok(n > 300, `${n} trees and plants round Bradfield Park`);
  for (const [x, z] of garden.flatMap((t) => t.garden.gates)) assert.ok(!inFoot(x, z, 0.5), `a gate in the bridge's foot at (${x}, ${z})`);
});

test('no garden sea wall stands where a region\'s edge cut the land: Hyde Park South is on one', async () => {
  const { onRegionEdge } = await import('../tools/geodata/regions.mjs');
  for (const t of garden) {
    for (const [, ...line] of t.garden.seawalls || []) {
      for (let i = 2; i + 1 < line.length; i += 2) assert.ok(!onRegionEdge(line[i - 2], line[i - 1], line[i], line[i + 1]), `a sea wall along a region's edge at (${line[i]}, ${line[i + 1]})`);
    }
  }
});

test('Centennial Park and Moore Park are gardens: Centennial\'s paved paths and its tracks, the bridle track 4 m wide, its lakes and their islands, and the Moore Park by Anzac Parade', { skip: !garden.some((t) => t.key === '2_2') && 'Centennial Park\'s tiles not held' }, () => {
  const inBox = (p, x0, x1, z0, z1) => p.pts.some(({ x, z }) => x > x0 && x < x1 && z > z0 && z < z1);
  const km = (list) => list.reduce((t, p) => t + p.pts.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - p.pts[i].x, q.z - p.pts[i].z), 0), 0) / 1000;
  const centennial = paths.filter((p) => inBox(p, 1930, 3930, 1420, 3320));
  const kerbed = centennial.filter((p) => p.kind !== 3), tracks = centennial.filter((p) => p.kind === 3);
  assert.ok(km(kerbed) > 5, `${km(kerbed).toFixed(1)} km of Centennial Park's paved paths`);
  assert.ok(km(tracks) > 20, `${km(tracks).toFixed(1)} km of its tracks`);
  // The bridle track along Grand Drive: a track 4 m wide, OSM giving none
  assert.ok(tracks.some((p) => p.width === 4 && p.pts.some((q, i) => i && segDist(2627.7, 2100.6, p.pts[i - 1], q) < 1)), 'no 4 m bridle track by Grand Drive');
  // Moore Park's paths, by Anzac Parade: OSM's way 12281514, not the first park of the name it has (21 km west)
  assert.ok(km(paths.filter((p) => inBox(p, 1218, 1529, 1314, 1988))) > 1, 'too little path in Moore Park');
  // Its lakes: Busbys Pond and the Duck Pond 5.7 ha each, three more over 3 ha
  const ringArea = (f) => { let a = 0; for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) a += f[j] * f[i + 1] - f[i] * f[j + 1]; return Math.abs(a / 2); };
  const lakes = garden.flatMap((t) => t.garden.ponds).filter((f) => ringArea(f) > 30000);
  assert.equal(lakes.length, 5, `${lakes.length} lakes over 3 ha`);
  // Their islands are lawn: the raised lawn over them, and their water round them none
  const islands = [...new Set(garden.flatMap((t) => (t.garden.islands || []).map((f) => JSON.stringify(f))))].map((f) => JSON.parse(f));
  const inCentennial = islands.filter((f) => f[0] > 1930 && f[0] < 3930 && f[1] > 1420 && f[1] < 3320);
  assert.equal(inCentennial.length, 12, `${inCentennial.length} islands in Centennial Park's ponds`);
  for (const f of lakes) {
    let water = 0, raisedOver = 0, island = 0, onIsland = 0;
    const b = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    for (let i = 0; i + 1 < f.length; i += 2) { b.x0 = Math.min(b.x0, f[i]); b.x1 = Math.max(b.x1, f[i]); b.z0 = Math.min(b.z0, f[i + 1]); b.z1 = Math.max(b.z1, f[i + 1]); }
    for (let x = b.x0; x < b.x1; x += 4) {
      for (let z = b.z0; z < b.z1; z += 4) {
        if (!inFlatRing(f, x, z)) continue;
        const isle = islands.find((h) => inFlatRing(h, x, z));
        if (isle) { island++; if (onRaised(x, z)) onIsland++; } else { water++; if (onRaised(x, z)) raisedOver++; }
      }
    }
    assert.ok(water > 1000 && raisedOver === 0, `the raised lawn over a lake's water at ${raisedOver} of ${water} points`);
    if (island > 20) assert.ok(onIsland > island * 0.8, `the raised lawn on ${onIsland} of ${island} points on a lake's islands`);
  }
});

test('a lake is laid on the lawn\'s triangles: its water whole, round its islands, and cheap', { skip: !garden.some((t) => t.key === '2_2') && 'Centennial Park\'s tiles not held' }, async () => {
  const { buildTileGarden, gardenMaterials } = await import('../js/garden.js');
  const water = [];
  for (const t of garden.filter((t) => /^[23]_[23]$/.test(t.key))) {
    const it = buildTileGarden(t, null, (cells, target, material) => { if (material === gardenMaterials().pond) water.push(cells); });
    while (!it.next().done);
  }
  // Every pond's water in those tiles, with its islands: its area against what's laid
  const tris = [];
  for (const cells of water) {
    for (const c of cells.cells.values()) {
      const P = c.position, I = c.index;
      for (let i = 0; i < I.length; i += 3) tris.push([I[i], I[i + 1], I[i + 2]].map((k) => [P[k * 3], P[k * 3 + 2]]));
    }
  }
  assert.ok(tris.length < 12000, `${tris.length} triangles of water`);
  const islands = [...new Set(garden.flatMap((t) => (t.garden.islands || []).map((f) => JSON.stringify(f))))].map((f) => JSON.parse(f));
  // Busbys Pond: its points every 3 m are under the water but on its islands
  const busbys = garden.flatMap((t) => t.garden.ponds).find((f) => inFlatRing(f, 2614, 2538));
  assert.ok(busbys, 'no Busbys Pond');
  const covered = (x, z) => tris.some(([a, b, c]) => {
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (z - c[1])) / d, l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (z - c[1])) / d;
    return l1 >= -1e-6 && l2 >= -1e-6 && 1 - l1 - l2 >= -1e-6;
  });
  let n = 0, dry = 0, wet = 0;
  // (Off the half metre, where the islands' points are)
  for (let x = 2400.37; x < 2800; x += 3) {
    for (let z = 2380.37; z < 2700; z += 3) {
      if (!inFlatRing(busbys, x, z)) continue;
      const isle = islands.some((h) => inFlatRing(h, x, z));
      if (isle) { if (covered(x, z)) wet++; continue; }
      n++;
      if (!covered(x, z)) dry++;
    }
  }
  assert.ok(n > 3000 && dry <= n * 0.002, `Busbys Pond's water missing at ${dry} of ${n} points`);
  assert.equal(wet, 0, 'water over an island');
});
