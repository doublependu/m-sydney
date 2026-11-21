import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import zlib from 'node:zlib';

// Salesforce Tower, the EY Centre, Customs House and Crown Sydney (js/model-sites.js): models of their own in place of the map's boxes,
// each with a foyer behind a door off the street. Built by scripts outside this repo, in its public/models/; these hold them to the
// map they stand on.
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { MODEL_SITES, clearOfSites, toWorldOf } = await import('../js/model-sites.js');
const { heldTiles } = await import('../js/geodata.js');
const { groundHeight } = await import('../js/surfaces.js');
const { floorAt } = await import('../js/interior-data.js');
const { TOWER_SIGNS, placeTowerSign } = await import('../js/tower-signs.js');

const IDS = ['salesforce-tower', 'ey-centre', 'customs-house', 'crown-sydney', 'st-marys'];
// Those whose doors stand up steps from the street, and those with budgets of their own: a big inside is up to 2 MB and 40,000
// triangles, its outside 20 draws
const UP_STEPS = new Set(['customs-house', 'st-marys']);
const BUDGETS = { 'st-marys': { draws: 20, inBytes: 2_000_000, inTris: 40_000 } };
const sites = IDS.map((id) => MODEL_SITES.find((s) => s.id === id));
const read = (name) => JSON.parse(fs.readFileSync(new URL(`../public/models/${name}.json`, import.meta.url), 'utf8'));
function gltf(name) {
  const bytes = zlib.gunzipSync(fs.readFileSync(new URL(`../public/models/${name}.glb.gz`, import.meta.url)));
  return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
}
const inRing = (ring, x, z) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) c = !c;
  }
  return c;
};

test('each stands where the map had what it replaces, and the map leaves those out', () => {
  const buildings = [...heldTiles().values()].flatMap((t) => t.buildings);
  for (const site of sites) {
    assert.ok(site.far, `${site.id} has a far version`);
    for (const [lx, lz] of site.replaces) {
      const { x, z } = toWorldOf(site, lx, lz);
      const left = buildings.filter((b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && b.polygons.some((p) => inRing(p.outer, x, z)));
      assert.equal(left.length, 0, `${site.id}: the map still has a building ${Math.round(left[0]?.height)} m high at (${x.toFixed(1)}, ${z.toFixed(1)})`);
    }
  }
});

test('each door opens off the street at the street\'s height, no street tree before it, and leads into a foyer', () => {
  for (const site of sites) {
    const name = site.file.replace('models/', '');
    const out = read(name), inside = read(`${name}-in`);
    const [door] = out.doors;
    assert.ok(door?.inside === `${name}-in`, `${site.id}: its door leads nowhere`);
    // the step in front of it, the model's floor outside the door
    const mid = [(door.hinge[0] + door.latch[0]) / 2, (door.hinge[1] + door.latch[1]) / 2];
    const front = toWorldOf(site, mid[0], mid[1] + 1.5);
    assert.equal(floorAt(out.floors, mid[0], mid[1] + 1.0, 0), 0, `${site.id}: no floor at its door`);
    const ground = groundHeight(front.x, front.z) - site.y;
    // Customs House stands up steps from the square, St Mary's from its forecourt
    const step = UP_STEPS.has(site.id) ? 0 : ground;
    assert.ok(Math.abs(step) < 0.35, `${site.id}: the street at its door is ${ground.toFixed(2)} m from its floor`);
    assert.equal(clearOfSites(front.x, front.z), false, `${site.id}: a street tree could stand at its door`);
    assert.equal(inside.rooms.length, 1, `${site.id}: one room inside`);
    assert.equal(floorAt(inside.floors, mid[0], mid[1] - 2.0, 0), 0, `${site.id}: no floor just inside its door`);
  }
});

test('Customs House stands up its steps, from the square to its loggia', () => {
  const site = MODEL_SITES.find((s) => s.id === 'customs-house');
  const out = read('customs-house');
  const steps = out.floors.find((f) => f.plane);
  assert.ok(steps, 'no steps');
  const foot = Math.max(...steps.poly.map((p) => p[1]));
  const bottom = toWorldOf(site, 0, foot + 0.5);
  const square = groundHeight(bottom.x, bottom.z) - site.y;
  const atFoot = steps.plane[0] + steps.plane[2] * foot;
  assert.ok(Math.abs(atFoot - square) < 0.35, `the steps come down to ${atFoot.toFixed(2)} m, the square is at ${square.toFixed(2)} m`);
  assert.equal(floorAt(out.floors, 0, 19.0, 0), 0, 'the loggia is at its floor');
});

test('Customs House\'s atrium has the city under glass, and you walk on the glass', () => {
  const inside = read('customs-house-in');
  const [atrium] = inside.rooms;
  // the room's own floor has a hole where the glass is: a floor of its own is the glass, at the room's level
  const own = inside.floors.find((f) => f.holes?.length);
  assert.ok(own, 'the atrium\'s floor has no hole for the glass');
  const hole = own.holes[0];
  const [hx, hz] = [hole.reduce((s, p) => s + p[0], 0) / hole.length, hole.reduce((s, p) => s + p[1], 0) / hole.length];
  assert.equal(floorAt([own], hx, hz, 0), null, 'the room\'s floor runs over the pit');
  assert.equal(floorAt(inside.floors, hx, hz, 0), 0, 'nothing to walk on over the pit');
  // the atrium is open up to its glass roof, so the camera may rise in it
  assert.ok(atrium.y1 > 15, `the atrium's top is ${atrium.y1} m`);
});

test('within their budgets: outside, inside and far', () => {
  for (const site of sites) {
    const name = site.file.replace('models/', '');
    const size = (n) => fs.statSync(new URL(`../public/models/${n}.glb.gz`, import.meta.url)).size;
    const tris = (n) => {
      const g = gltf(n);
      return g.meshes.flatMap((m) => m.primitives).reduce((s, p) => s + g.accessors[p.indices].count / 3, 0);
    };
    // from the street, its doors as their one shut piece: the draws of every node but the leaves
    const g = gltf(name);
    const shown = g.nodes.filter((n) => n.mesh !== undefined && !/^door_/.test(n.name) && !/^door_/.test(g.nodes.find((p) => p.children?.includes(g.nodes.indexOf(n)))?.name ?? ''));
    const draws = shown.reduce((s, n) => s + g.meshes[n.mesh].primitives.length, 0);
    const b = { draws: 15, inBytes: 1_000_000, inTris: 30_000, ...BUDGETS[site.id] };
    assert.ok(size(name) < 300_000 && draws <= b.draws, `${name}: ${size(name)} bytes, ${draws} draws`);
    assert.ok(size(`${name}-in`) < b.inBytes && tris(`${name}-in`) <= b.inTris, `${name}-in: ${size(`${name}-in`)} bytes, ${tris(`${name}-in`)} triangles`);
  }
});

test('Salesforce Tower\'s sign is on its model\'s crown', () => {
  const sign = TOWER_SIGNS.find((s) => s.site === 'salesforce-tower');
  const site = MODEL_SITES.find((s) => s.id === 'salesforce-tower');
  const p = placeTowerSign(sign);
  assert.equal(p.roof, site.y + sign.height);
  // the crown's glass runs from 244 m over the site up to its top
  assert.ok(p.y - sign.h / 2 > site.y + 244 && p.y + sign.h / 2 < p.roof, `the sign spans ${(p.y - sign.h / 2).toFixed(1)}-${(p.y + sign.h / 2).toFixed(1)} m`);
});

test('a tower\'s site says how high it stands and how far it reaches, as its model has it, for a helicopter arriving beside it', () => {
  for (const site of sites.filter((s) => s.top)) {
    const name = site.file.replace('models/', '');
    const { walls } = read(name);
    assert.ok(Math.abs(Math.max(...walls.map((w) => w.y1)) - site.top) < 0.5, `${site.id}: its site says ${site.top} m`);
    // the tower (the walls that reach its top) is all within the site's radius, and not much less: a helicopter arriving near it may
    // come in a little higher than it need, never lower
    const tall = walls.filter((w) => w.y1 > site.top - 1);
    const reach = Math.max(...tall.flatMap((w) => [w.a, w.b]).map(([x, z]) => Math.hypot(x, z)));
    assert.ok(reach <= site.radius && reach >= site.radius - 3, `${site.id}: reaches ${reach.toFixed(1)} m, its site says ${site.radius}`);
  }
});

// Luna Park (js/model-sites.js `luna-park`): no inside, and no door. Its way in is the face's mouth, walked through onto the midway.
const luna = MODEL_SITES.find((s) => s.id === 'luna-park');

test('Luna Park stands where the map had its gate, its halls and its rides, and the map leaves those out', () => {
  assert.ok(luna.far, 'it has a far version');
  const buildings = [...heldTiles().values()].flatMap((t) => t.buildings);
  for (const [lx, lz] of luna.replaces) {
    const { x, z } = toWorldOf(luna, lx, lz);
    const left = buildings.filter((b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && b.polygons.some((p) => inRing(p.outer, x, z)));
    assert.equal(left.length, 0, `the map still has a building ${Math.round(left[0]?.height)} m high at (${x.toFixed(1)}, ${z.toFixed(1)})`);
  }
});

test('Luna Park\'s way in is the face\'s mouth: nothing across it, its teeth over a walker\'s head, the street at its height', () => {
  const out = read('luna-park');
  assert.deepEqual(out.doors, [], 'it has a door');
  // No wall within a walker's height crosses the line through the mouth, from in front of the gate to the midway behind it
  const crosses = (w, x) => {
    const [ax, az] = w.a, [bx, bz] = w.b;
    if (Math.abs(bx - ax) < 1e-9) return Math.abs(ax - x) <= w.t / 2 + 0.25 && Math.min(az, bz) < 3 && Math.max(az, bz) > -6;
    const t = (x - ax) / (bx - ax);
    if (t < 0 || t > 1) return false;
    const z = az + (bz - az) * t;
    return z > -6 && z < 3;
  };
  for (const x of [-2.5, -1, 0, 1, 2.5]) {
    const across = out.walls.filter((w) => w.y0 < 2.2 && w.y1 > 0.3 && crosses(w, x));
    assert.equal(across.length, 0, `a wall across the mouth at x = ${x}: ${JSON.stringify(across[0])}`);
  }
  // The street in front of it and the midway behind it, as the map has them, under the teeth (2.78 m over the site's height and up)
  for (const [x, z] of [[0, 2.0], [-2.5, 0.5], [2.5, 0.5], [0, -3.0], [2.5, -3.0]]) {
    const p = toWorldOf(luna, x, z);
    const y = groundHeight(p.x, p.z) - luna.y;
    assert.ok(y > -0.6 && y + 1.8 < 2.78, `at (${x}, ${z}) the ground is ${y.toFixed(2)} m from the site's height`);
  }
  const front = toWorldOf(luna, 0, 4.0);
  assert.equal(clearOfSites(front.x, front.z), false, 'a street tree could stand in front of the mouth');
});

test('Luna Park within its budgets: its outside, and its far version', () => {
  const size = fs.statSync(new URL('../public/models/luna-park.glb.gz', import.meta.url)).size;
  const g = gltf('luna-park');
  const draws = g.nodes.filter((n) => n.mesh !== undefined).reduce((s, n) => s + g.meshes[n.mesh].primitives.length, 0);
  assert.ok(size < 300_000 && draws <= 20, `${size} bytes, ${draws} draws`);
  const far = gltf('luna-park-far');
  const tris = far.meshes.flatMap((m) => m.primitives).reduce((s, p) => s + far.accessors[p.indices].count / 3, 0);
  assert.ok(far.meshes.flatMap((m) => m.primitives).length <= 2 && tris <= 2000, `its far version: ${tris} triangles`);
});

test('Luna Park\'s wheel stands on the ground where OSM has its fence, its lowest gondola clear of it', () => {
  const [wheel] = read('luna-park').spin;
  const [cx, cy, cz] = wheel.centre;
  const at = toWorldOf(luna, cx, cz);
  // OSM's fence round it (way 581526818) has its middle at (-85.4, -2726.6)
  assert.ok(Math.hypot(at.x + 85.4, at.z + 2726.6) < 1.0, `its hub over (${at.x.toFixed(1)}, ${at.z.toFixed(1)})`);
  const ground = groundHeight(at.x, at.z) - luna.y;
  const lowest = cy - 15 - 2.0;
  assert.ok(lowest - ground > 0.4 && lowest - ground < 2.0, `its lowest gondola's floor ${(lowest - ground).toFixed(2)} m over the ground`);
});

// St Mary's Cathedral: its forecourt's steps meet the ground, its pews are drawn from one and sat in, and its windows' glass is there for
// the sun to throw through (js/stained-light.js)
test('St Mary\'s stands up its steps from the forecourt, and its west porch\'s from the ground', () => {
  const site = MODEL_SITES.find((s) => s.id === 'st-marys');
  const out = read('st-marys');
  const at = (x, z) => floorAt(out.floors, x, z, 0.5);
  const groundAt = (x, z) => {
    const w = toWorldOf(site, x, z);
    return groundHeight(w.x, w.z) - site.y + 0.22; // the lawn, a kerb's height up
  };
  // from the terrace at the doors down the stair to the podium; off its far end to the lawn
  assert.equal(floorAt(out.floors, 0, 56, 0), 0, 'no terrace at the doors');
  const flights = out.floors.filter((f) => f.plane);
  assert.equal(flights.length, 3, 'the stair, the podium\'s steps and the porch\'s');
  // the stair down from the terrace, then the steps off the podium's far end
  const [stair, end] = flights.filter((f) => f.plane[1] === 0).sort((a, b) => Math.min(...a.poly.map((p) => p[1])) - Math.min(...b.poly.map((p) => p[1])));
  const foot = Math.max(...stair.poly.map((p) => p[1]));
  const podium = out.floors.find((f) => f.holes.length);
  assert.ok(Math.abs(stair.plane[0] + stair.plane[2] * foot - podium.y) < 0.02, 'the stair doesn\'t come down to the podium');
  for (const [x, z] of [[-12, 80], [0, 95], [12, 100]]) assert.ok(podium.y > groundAt(x, z), `the lawn stands through the podium at (${x}, ${z})`);
  const last = Math.max(...end.poly.map((p) => p[1]));
  const bottom = end.plane[0] + end.plane[2] * last;
  assert.ok(Math.abs(bottom - groundAt(0, last + 0.5)) < 0.35, `the podium's steps come down to ${bottom.toFixed(2)} m, the lawn is at ${groundAt(0, last + 0.5).toFixed(2)}`);
  // the porch: its floor through the west door, its steps out to the lawn
  const porch = flights.find((f) => f.plane[1] !== 0);
  const outer = Math.min(...porch.poly.map((p) => p[0])), z = (porch.poly[0][1] + porch.poly[2][1]) / 2;
  const low = porch.plane[0] + porch.plane[1] * outer;
  assert.ok(Math.abs(low - groundAt(outer - 0.5, z)) < 0.35, `the porch's steps come down to ${low.toFixed(2)} m, the lawn is at ${groundAt(outer - 0.5, z).toFixed(2)}`);
  const west = out.doors.find((d) => d.id === 'west');
  assert.ok(west?.inside === 'st-marys-in', 'the west porch\'s door leads nowhere');
  assert.equal(at(west.hinge[0] - 1.0, (west.hinge[1] + west.latch[1]) / 2), 0, 'no floor in the porch at its door');
});

test('St Mary\'s pews: one node drawn many times, every seat on a pew over the floor, and room between the rows', () => {
  const inside = read('st-marys-in');
  const [pews] = inside.instances;
  assert.equal(pews.node, 'pew');
  assert.ok(pews.at.length >= 80, `${pews.at.length} pews`);
  const seats = inside.seats.filter((s) => s.kind === 'pew');
  assert.equal(seats.length, pews.at.length * 6);
  for (const s of seats) {
    assert.equal(floorAt(inside.floors, s.at[0], s.at[2], 0), 0, `a pew's seat at (${s.at[0]}, ${s.at[2]}) over no floor`);
    assert.ok(Math.abs(s.at[1] - 0.47) < 0.01);
  }
  // the nave's rows: a walker (0.22 m round) fits between one's low wall and the next's
  const rows = [...new Set(pews.at.filter((p) => Math.abs(p[3] - Math.PI) < 0.01).map((p) => p[2]))].sort((a, b) => a - b);
  const pitch = rows[1] - rows[0];
  assert.ok(pitch - 0.55 >= 0.48, `the nave's rows are ${pitch.toFixed(2)} m apart`);
});

test('St Mary\'s windows: their glass as pictures in the palette\'s colours, on the walls, and the surfaces their light can fall on', () => {
  const inside = read('st-marys-in');
  const keys = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, inside.palette.length);
  assert.ok(inside.windows.length >= 50, `${inside.windows.length} windows`);
  for (const w of inside.windows) {
    assert.ok(w.img.length >= 5 && w.img.every((r) => r.length === w.img[0].length), 'a picture\'s rows aren\'t all as long');
    assert.ok(w.img.join('').split('').every((c) => c === '.' || keys.includes(c)), 'a pixel not in the palette');
    assert.ok(w.img.join('').replace(/\./g, '').length > 0.3 * w.img.length * w.img[0].length, 'a window with little glass');
    assert.ok(Math.abs(Math.hypot(...w.u) - 1) < 1e-3 && Math.abs(w.u[0] * w.n[0] + w.u[1] * w.n[1]) < 1e-3, 'its axes aren\'t square');
  }
  // the lit surfaces: convex, anticlockwise, on a floor
  for (const l of inside.lit) {
    const p = l.poly;
    for (let i = 0; i < p.length; i++) {
      const [a, b, c] = [p[i], p[(i + 1) % p.length], p[(i + 2) % p.length]];
      assert.ok((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) >= -1e-6, 'a lit surface isn\'t convex and anticlockwise');
    }
  }
});

// North Sydney Pool (js/model-sites.js `north-sydney-pool`): no inside, no door; its deck walked on, its pools still water to walkers, the 50 m
// pool's water moving near it (js/pool-water.js). The map's ground rises across it: the site's cut takes it out where it's over the deck.
const nsp = MODEL_SITES.find((s) => s.id === 'north-sydney-pool');
const DRAWN = 0.22; // m the map draws its paving over the ground (js/ground-geometry.js SIDEWALK_TOP)

test('North Sydney Pool stands where the map had its stand, its buildings and the terrace\'s, and the map leaves those out', () => {
  assert.ok(nsp.far, 'it has a far version');
  const buildings = [...heldTiles().values()].flatMap((t) => t.buildings);
  for (const [lx, lz] of nsp.replaces) {
    const { x, z } = toWorldOf(nsp, lx, lz);
    const left = buildings.filter((b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && b.polygons.some((p) => inRing(p.outer, x, z)));
    assert.equal(left.length, 0, `the map still has a building ${Math.round(left[0]?.height)} m high at (${x.toFixed(1)}, ${z.toFixed(1)})`);
  }
  // ...and none of them is Luna Park's, next door
  const luna = MODEL_SITES.find((s) => s.id === 'luna-park');
  const theirs = luna.replaces.map(([x, z]) => toWorldOf(luna, x, z));
  for (const [lx, lz] of nsp.replaces) {
    const p = toWorldOf(nsp, lx, lz);
    assert.ok(theirs.every((q) => Math.hypot(q.x - p.x, q.z - p.z) > 10), `(${p.x.toFixed(1)}, ${p.z.toFixed(1)}) is by one of Luna Park's`);
  }
});

test('North Sydney Pool within its budgets: its outside, and its far version', () => {
  const size = fs.statSync(new URL('../public/models/north-sydney-pool.glb.gz', import.meta.url)).size;
  const g = gltf('north-sydney-pool');
  const draws = g.nodes.filter((n) => n.mesh !== undefined).reduce((s, n) => s + g.meshes[n.mesh].primitives.length, 0);
  assert.ok(size < 300_000 && draws <= 20, `${size} bytes, ${draws} draws`);
  const far = gltf('north-sydney-pool-far');
  const tris = far.meshes.flatMap((m) => m.primitives).reduce((s, p) => s + far.accessors[p.indices].count / 3, 0);
  assert.ok(far.meshes.flatMap((m) => m.primitives).length <= 2 && tris <= 2000, `its far version: ${tris} triangles`);
});

test('North Sydney Pool: the map\'s paving under its deck and its water where it isn\'t cut out, so it never shows through', () => {
  const out = read('north-sydney-pool');
  const cut = nsp.cut.poly;
  const inPoly = (poly, x, z) => inRing(poly.map(([px, pz]) => ({ x: px, z: pz })), x, z);
  const [olympic] = out.pools;
  const deck = out.floors.find((f) => f.holes?.length);
  let water = 0, onDeck = 0;
  for (let x = -40; x <= 50; x += 0.5) {
    for (let z = -20; z <= 18; z += 0.5) {
      if (inPoly(cut, x, z)) continue;
      const p = toWorldOf(nsp, x, z);
      const paving = groundHeight(p.x, p.z) + DRAWN - nsp.y;
      if (inPoly(olympic.ring, x, z)) {
        water++;
        assert.ok(paving < olympic.surface - 0.05, `the paving at (${x}, ${z}) ${paving.toFixed(2)} m, over the water at ${olympic.surface}`);
      } else if (inPoly(deck.poly, x, z) && !deck.holes.some((h) => inPoly(h, x, z)) && x > -27.3) {
        // (nearer the old building than that, its planter stands over it)
        onDeck++;
        assert.ok(paving < -0.05, `the paving at (${x}, ${z}) ${paving.toFixed(2)} m, over the deck`);
      }
    }
  }
  assert.ok(water > 100 && onDeck > 1000, `${water} points of water and ${onDeck} of deck outside the cut`);
});

test('North Sydney Pool\'s pools: the 50 m pool in eight lanes, deep at its blocks and shallow at its steps, its ladders on its edges', () => {
  const { pools, floors } = read('north-sydney-pool');
  const olympic = pools.find((p) => p.id === 'olympic');
  assert.ok(olympic.sim, 'its water doesn\'t move');
  const xs = olympic.ring.map((p) => p[0]), zs = olympic.ring.map((p) => p[1]);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  assert.ok(Math.abs(x1 - x0 - 50) < 0.01 && Math.abs(z1 - z0 - 21) < 0.01, `${x1 - x0} by ${z1 - z0} m`);
  assert.ok(olympic.lanes * olympic.lane <= z1 - z0, 'its lanes are wider than it');
  // its depth down the profile: deepest at the blocks' end, never deeper towards the steps
  const depth = olympic.depth;
  for (let i = 1; i < depth.length; i++) assert.ok(depth[i][0] > depth[i - 1][0] && depth[i][1] <= depth[i - 1][1], 'its depth profile');
  assert.ok(Math.abs(olympic.blocks - depth[0][0]) < 0.01 && depth[0][1] >= 1.8, 'its blocks aren\'t at its deep end');
  // the steps: a stair down from the shallow end's wall, each tread lower and further out than the one before
  const steps = [...olympic.steps].sort((a, b) => b.y - a.y);
  let from = x1;
  for (const st of steps) {
    for (const [x, z] of st.poly) assert.ok(x >= x0 - 0.01 && x <= x1 + 0.01 && z >= z0 - 0.01 && z <= z1 + 0.01, 'a step outside the water');
    assert.ok(Math.abs(Math.max(...st.poly.map(([x]) => x)) - from) < 0.01, 'a tread not on from the one over it, or the wall');
    from = Math.min(...st.poly.map(([x]) => x));
    assert.ok(st.y < olympic.surface && st.y > olympic.surface - depth.at(-1)[1], `a tread at ${st.y}`);
  }
  for (const l of olympic.ladders) {
    assert.ok(Math.abs(Math.abs(l.at[1]) - (z1 - z0) / 2) < 0.01 && l.at[0] > x0 && l.at[0] < x1, `a ladder at ${l.at} isn't on a long edge`);
    assert.ok(l.rungs.every((y) => y < olympic.surface), 'a ladder\'s rung over the water');
  }
  // the deck's floor has the pools as holes, its water's ring
  const deck = floors.find((f) => f.holes?.length);
  for (const p of pools) assert.ok(deck.holes.some((h) => JSON.stringify(h) === JSON.stringify(p.ring)), `the deck has no hole for ${p.id}`);
  // the still sheet of water the game hides for its own is a node of its own
  assert.ok(gltf('north-sydney-pool').nodes.some((n) => n.name === olympic.node), `no node ${olympic.node}`);
});
