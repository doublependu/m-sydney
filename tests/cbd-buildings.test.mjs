import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import zlib from 'node:zlib';
import { readModel, triangles } from './helpers/glb.mjs';

// Salesforce Tower, the EY Centre, Customs House and Crown Sydney (js/model-sites.js): models of their own in place of the map's boxes,
// each with a foyer behind a door off the street. Built by scripts outside this repo, in its public/models/; these hold them to the
// map they stand on.
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { MODEL_SITES, clearOfSites, cutsOf, toWorldOf } = await import('../js/model-sites.js');
const { heldTiles } = await import('../js/geodata.js');
const { groundHeight, structuresAt, STRUCTURES, KIND, TUNNEL_HEIGHT } = await import('../js/surfaces.js');
const { floorAt } = await import('../js/interior-data.js');
const { TOWER_SIGNS, placeTowerSign } = await import('../js/tower-signs.js');

const IDS = ['salesforce-tower', 'ey-centre', 'customs-house', 'crown-sydney', 'st-marys', 'art-gallery', 'art-gallery-new', 'qvb', 'circular-quay',
  'central-station'];
// Those whose doors stand up steps from the street, and those with budgets of their own: a big inside is up to 2 MB and 40,000
// triangles a file, its outside 20 draws
// (Circular Quay Station's doors are its gates, in its hall, a step up from the quay)
const UP_STEPS = new Set(['customs-house', 'st-marys', 'art-gallery', 'art-gallery-new', 'circular-quay', 'central-station']);
const BIG = { draws: 20, inBytes: 2_000_000, inTris: 40_000 };
const BUDGETS = { 'st-marys': BIG, 'art-gallery': BIG, 'art-gallery-new': BIG, qvb: BIG, 'circular-quay': BIG, 'central-station': BIG };
// An inside of more than one file (a gallery a level), and how many rooms its first has: the rest a foyer of one room
const FIRST_ROOMS = { 'art-gallery': 16, 'art-gallery-new': 5, 'circular-quay': 3, 'central-station': 4 };
const sites = IDS.map((id) => MODEL_SITES.find((s) => s.id === id));
const read = (name) => JSON.parse(fs.readFileSync(new URL(`../public/models/${name}.json`, import.meta.url), 'utf8'));
function gltf(name) {
  const bytes = zlib.gunzipSync(fs.readFileSync(new URL(`../public/models/${name}.glb.gz`, import.meta.url)));
  return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
}
/** A model's inside's files: what its doors name, and what their doors name (and the files each says come with it), in turn */
function insideFiles(name) {
  const files = [], todo = read(name).doors.map((d) => d.inside).filter(Boolean);
  while (todo.length) {
    const file = todo.shift();
    if (files.includes(file)) continue;
    files.push(file);
    const data = read(file);
    todo.push(...data.doors.map((d) => d.inside).filter(Boolean), ...(data.then ?? []));
  }
  return files;
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
    const out = read(name);
    const [door] = out.doors;
    const inside = door?.inside && read(door.inside);
    assert.ok(inside && door.inside.startsWith(`${name}-`), `${site.id}: its door leads nowhere`);
    // the step in front of it, the model's floor outside the door: out is the side its inside's rooms aren't (most face +z)
    const mid = [(door.hinge[0] + door.latch[0]) / 2, (door.hinge[1] + door.latch[1]) / 2];
    const L = Math.hypot(door.latch[0] - door.hinge[0], door.latch[1] - door.hinge[1]);
    const n = [-(door.latch[1] - door.hinge[1]) / L, (door.latch[0] - door.hinge[0]) / L];
    const inRoom = (x, z) => inside.rooms.some((r) => inRing(r.poly.map(([px, pz]) => ({ x: px, z: pz })), x, z));
    const out1 = inRoom(mid[0] + n[0], mid[1] + n[1]) ? [-n[0], -n[1]] : n;
    const at = (d) => [mid[0] + out1[0] * d, mid[1] + out1[1] * d];
    const front = toWorldOf(site, ...at(1.5));
    assert.ok(Math.abs(floorAt(out.floors, ...at(1.0), door.y0) - door.y0) < 0.05, `${site.id}: no floor at its door`);
    const ground = groundHeight(front.x, front.z) - site.y;
    // Customs House stands up steps from the square, St Mary's from its forecourt
    const step = UP_STEPS.has(site.id) ? 0 : ground;
    assert.ok(Math.abs(step) < 0.35, `${site.id}: the street at its door is ${ground.toFixed(2)} m from its floor`);
    assert.equal(clearOfSites(front.x, front.z), false, `${site.id}: a street tree could stand at its door`);
    assert.equal(inside.rooms.length, FIRST_ROOMS[site.id] ?? 1, `${site.id}: ${FIRST_ROOMS[site.id] ?? 1} room(s) inside`);
    assert.ok(Math.abs(floorAt(inside.floors, ...at(-2.0), door.y0) - door.y0) < 0.05, `${site.id}: no floor just inside its door`);
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
    // each of its inside's files: the one its door names, and those that one's doors name in turn
    for (const file of insideFiles(name)) {
      assert.ok(size(file) < b.inBytes && tris(file) <= b.inTris, `${file}: ${size(file)} bytes, ${tris(file)} triangles`);
    }
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
  const cuts = cutsOf(nsp).map((c) => c.poly);
  const inPoly = (poly, x, z) => inRing(poly.map(([px, pz]) => ({ x: px, z: pz })), x, z);
  const [olympic] = out.pools;
  const deck = out.floors.find((f) => f.holes?.length);
  let water = 0, onDeck = 0;
  for (let x = -40; x <= 50; x += 0.5) {
    for (let z = -20; z <= 18; z += 0.5) {
      if (cuts.some((cut) => inPoly(cut, x, z))) continue;
      const p = toWorldOf(nsp, x, z);
      // (where two 240 m squares' pieces meet, each cut stops 5 mm short of the edge, in its own piece)
      if (Math.abs(p.x - Math.round(p.x / 240) * 240) < 0.01 || Math.abs(p.z - Math.round(p.z / 240) * 240) < 0.01) continue;
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
  // the water is cut out all over: from under it (swimming, js/swimming.js) nothing of the map's shows
  assert.ok(water === 0 && onDeck > 1000, `${water} points of water and ${onDeck} of deck outside the cut`);
});

test('North Sydney Pool\'s pools: the 50 m pool in eight lanes, deep at its blocks and shallow at its steps, its ladders on its edges, swum in', () => {
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
  // swum in (js/swimming.js), its steps a stair a walker steps down and up (risers within 0.3 m, js/controllers.js FALLING), outside the
  // last lane rope; the kids' pool only still water
  assert.ok(olympic.swim && !pools.find((p) => p.id === 'kids').swim, 'which pool is swum in');
  let tread = 0;
  for (const st of steps) {
    assert.ok(tread - st.y <= 0.3 + 1e-9, `a riser of ${(tread - st.y).toFixed(2)} m down the steps`);
    tread = st.y;
    assert.ok(Math.min(...st.poly.map(([, z]) => z)) > Math.max(...olympic.ropes) + 0.1, 'the steps under a lane rope');
  }
  assert.ok(tread - (olympic.surface - depth.at(-1)[1]) <= 0.3 + 1e-9, 'the last step down to the floor');
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

test('the Art Gallery stands up its steps from the forecourt, its paving on the ground round it', () => {
  const site = MODEL_SITES.find((s) => s.id === 'art-gallery');
  const out = read('art-gallery');
  // the portico at its floor, and the steps down from it to the paving at their foot
  assert.equal(floorAt(out.floors, 0, 55.0, 0), 0, 'the portico is at its floor');
  const steps = out.floors.find((f) => f.plane && f.poly.some((p) => Math.abs(p[0]) < 11) && Math.max(...f.poly.map((p) => p[1])) < 63.5 && f.plane[2] < -0.2);
  assert.ok(steps, 'no steps');
  const foot = Math.max(...steps.poly.map((p) => p[1]));
  const atFoot = steps.plane[0] + steps.plane[2] * foot;
  const paving = floorAt(out.floors.filter((f) => f !== steps), 0, foot + 0.3, atFoot);
  assert.ok(paving !== null && Math.abs(atFoot - paving) < 0.3, `the steps come down to ${atFoot.toFixed(2)} m, the paving is at ${paving}`);
  // the paving over the ground (and its lawn) everywhere, by a little
  for (const f of out.floors.filter((f) => f.plane && f !== steps)) {
    const [x, z] = [f.poly.reduce((s, p) => s + p[0], 0) / f.poly.length, f.poly.reduce((s, p) => s + p[1], 0) / f.poly.length];
    if (z < 50) continue;
    const y = f.plane[0] + f.plane[1] * x + f.plane[2] * z;
    const w = toWorldOf(site, x, z);
    const ground = groundHeight(w.x, w.z) - site.y;
    assert.ok(y - ground > 0.22 && y - ground < 0.9, `the paving at (${x.toFixed(1)}, ${z.toFixed(1)}) is ${(y - ground).toFixed(2)} m over the ground`);
  }
});

test('the Art Gallery\'s levels: each fetched by the door at the head of the stair down to it, which comes down into its lobby', () => {
  const files = insideFiles('art-gallery');
  assert.deepEqual(files, ['art-gallery-g', 'art-gallery-l1', 'art-gallery-l2', 'art-gallery-l3']);
  const levels = files.map((f) => read(f));
  for (let k = 0; k + 1 < levels.length; k++) {
    const upper = levels[k], lower = levels[k + 1];
    const door = upper.doors.find((d) => d.inside === files[k + 1]);
    assert.ok(door, `${files[k]}: no door to ${files[k + 1]}`);
    // the stair's room, behind the door, is the upper file's, down to the lower level
    const stair = upper.rooms.find((r) => door.rooms.includes(r.id) && r.id.startsWith('stair'));
    const y = lower.rooms.find((r) => r.id.endsWith('-lobby')).y0;
    assert.ok(stair && stair.y0 === y, `${files[k]}: its stair doesn't come down to ${y}`);
    // its foot opens into the lower lobby: a link to it, and the floor at its foot level with the lobby's across the doorway
    const link = upper.links.find((l) => l.a === stair.id && l.b.endsWith('-lobby') && !l.door);
    assert.ok(link && lower.rooms.some((r) => r.id === link.b), `${files[k]}: its stair's foot opens into no lobby below`);
    const lobby = lower.rooms.find((r) => r.id === link.b);
    const x = lobby.poly[0][0];
    for (const dx of [-0.3, 0.3]) {
      const zs = upper.floors.concat(lower.floors).map((f) => floorAt([f], x + dx, (stair.poly[0][1] + stair.poly[2][1]) / 2 - 1.2, y)).filter((v) => v !== null);
      assert.ok(zs.some((v) => Math.abs(v - y) < 0.01), `${files[k]}: no floor at ${y} m beside the stair's foot (${dx})`);
    }
  }
});

test('the Art Gallery\'s cut takes in every room under the ground', () => {
  const site = MODEL_SITES.find((s) => s.id === 'art-gallery');
  const cut = site.cut.poly;
  const inCut = (x, z) => {
    let c = false;
    for (let i = 0, j = cut.length - 1; i < cut.length; j = i++) {
      const [ax, az] = cut[i], [bx, bz] = cut[j];
      if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) c = !c;
    }
    return c;
  };
  for (const file of insideFiles('art-gallery')) {
    for (const r of read(file).rooms) {
      const cx = r.poly.reduce((s, p) => s + p[0], 0) / r.poly.length, cz = r.poly.reduce((s, p) => s + p[1], 0) / r.poly.length;
      for (const [x, z] of r.poly) {
        const w = toWorldOf(site, x, z);
        const under = groundHeight(w.x, w.z) - site.y + 0.22 > r.y0;
        // its corner, a little in towards its middle: the cut is 0.3 m inside the building's faces, the rooms' edges 0.6
        const px = x + Math.sign(cx - x) * 0.2, pz = z + Math.sign(cz - z) * 0.2;
        if (under) assert.ok(inCut(px, pz), `${file}: ${r.id}'s corner (${x}, ${z}) is under the ground and outside the cut`);
      }
    }
    assert.ok(site.cut.y <= Math.min(...read(file).rooms.map((r) => r.y0)), `${file}: a room under the cut's depth`);
  }
});

// The Art Gallery's new building, Naala Badu (js/model-sites.js `art-gallery-new`): a file a level, each fetched at the door at the head of
// the way down to it (two escalators, walked as stairs, and a spiral stair down to the Tank); two cuts, one a 240 m square.
const badu = MODEL_SITES.find((s) => s.id === 'art-gallery-new');
const inPoly = (poly, x, z) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[j];
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) c = !c;
  }
  return c;
};

test('Naala Badu\'s levels: each fetched by the door at the head of the way down to it, which comes down into a room of its own', () => {
  const files = insideFiles('art-gallery-new');
  assert.deepEqual(files, ['art-gallery-new-g', 'art-gallery-new-l1', 'art-gallery-new-l2', 'art-gallery-new-l4']);
  const levels = files.map((f) => read(f));
  for (let k = 0; k + 1 < levels.length; k++) {
    const upper = levels[k], lower = levels[k + 1];
    const door = upper.doors.find((d) => d.inside === files[k + 1]);
    assert.ok(door, `${files[k]}: no door to ${files[k + 1]}`);
    // the way down is the upper file's room, from the lower level's floor; its foot opens into a room of the lower file, at its floor
    const way = upper.rooms.filter((r) => door.rooms.includes(r.id)).sort((a, b) => a.y0 - b.y0)[0];
    // (the lower file's level: its rooms' floor, but its own way down's, which reaches lower still)
    const y = Math.max(...lower.rooms.map((r) => r.y0));
    assert.ok(way && Math.abs(way.y0 - y) < 0.01, `${files[k]}: its way down doesn't come down to ${y}`);
    const link = upper.links.find((l) => l.a === way.id && !l.door && lower.rooms.some((r) => r.id === l.b));
    assert.ok(link, `${files[k]}: its way down's foot opens into no room below`);
    const below = lower.rooms.find((r) => r.id === link.b);
    const reach = upper.floors.filter((f) => f.y !== undefined && Math.abs(f.y - below.y0) < 0.01 && f.poly.some(([x, z]) => inPoly(way.poly, x, z)));
    assert.ok(reach.length, `${files[k]}: no landing at ${below.y0} at its way down's foot`);
    // ...and the door at its head is on the upper level's floor
    assert.equal(floorAt(upper.floors, (door.hinge[0] + door.latch[0]) / 2, (door.hinge[1] + door.latch[1]) / 2, door.y0), door.y0);
  }
  // the Tank: a forest of columns, as tall as it is, in the dark
  const tank = levels[3].rooms.find((r) => r.id === 'tank');
  const columns = levels[3].walls.filter((w) => Math.abs(w.y0 - tank.y0) < 0.01 && Math.abs(w.y1 - tank.y1) < 0.01 && w.t < 0.6);
  assert.ok(columns.length >= 100, `the Tank has ${columns.length} columns`);
  assert.ok(tank.y1 - tank.y0 > 7 && tank.glow < 0.1, `the Tank is ${tank.y1 - tank.y0} m high, its glow ${tank.glow}`);
});

test('Naala Badu\'s cuts take in every room under the ground, each in one of the map\'s 240 m squares', () => {
  const cuts = [badu.cut].flat();
  assert.ok(cuts.length >= 2, 'one cut');
  for (const cut of cuts) {
    const w = cut.poly.map(([x, z]) => toWorldOf(badu, x, z));
    for (const k of ['x', 'z']) {
      const lo = Math.min(...w.map((p) => p[k])), hi = Math.max(...w.map((p) => p[k]));
      assert.equal(Math.floor(lo / 240), Math.floor(hi / 240), `a cut over the line ${k} ${Math.floor(hi / 240) * 240}`);
    }
  }
  for (const file of insideFiles('art-gallery-new')) {
    for (const r of read(file).rooms) {
      const cx = r.poly.reduce((s, p) => s + p[0], 0) / r.poly.length, cz = r.poly.reduce((s, p) => s + p[1], 0) / r.poly.length;
      for (const [x, z] of r.poly) {
        const px = x + Math.sign(cx - x) * 0.4, pz = z + Math.sign(cz - z) * 0.4;
        const at = toWorldOf(badu, px, pz);
        const ground = groundHeight(at.x, at.z) - badu.y + 0.22;
        if (ground <= r.y0) continue;
        const cut = cuts.find((c) => inPoly(c.poly, px, pz));
        assert.ok(cut, `${file}: ${r.id}'s corner (${x}, ${z}) is under the ground and outside the cuts`);
        assert.ok(cut.y <= r.y0, `${file}: ${r.id} is under its cut's depth`);
      }
    }
  }
});

test('Naala Badu: up the steps to its doors from the forecourt\'s paving, and the stair to the bay down to Lincoln Crescent', () => {
  const out = read('art-gallery-new');
  const sloped = out.floors.filter((f) => f.plane);
  // the forecourt's paving: on the ground, by a little, everywhere (the map's lawn never through it)
  const paths = sloped.filter((f) => f.poly.every(([x]) => x < -40) && Math.abs(f.plane[1]) < 0.2 && Math.abs(f.plane[2]) < 0.2);
  assert.ok(paths.length > 20, `${paths.length} path cells`);
  for (const f of paths) {
    const [x, z] = [f.poly.reduce((s, p) => s + p[0], 0) / f.poly.length, f.poly.reduce((s, p) => s + p[1], 0) / f.poly.length];
    const y = f.plane[0] + f.plane[1] * x + f.plane[2] * z;
    const w = toWorldOf(badu, x, z);
    const over = y - (groundHeight(w.x, w.z) - badu.y);
    assert.ok(over > 0.22 && over < 0.9, `the path at (${x.toFixed(1)}, ${z.toFixed(1)}) is ${over.toFixed(2)} m over the ground`);
  }
  // the stair to the bay: from lower level 2's floor at the door down to the paving at its foot, on the ground by the street
  const bay = out.doors.find((d) => d.id === 'bay');
  assert.ok(bay, 'no door to the stair to the bay');
  const stair = sloped.find((f) => f.poly.every(([x]) => x > 42) && Math.abs(f.plane[2]) > 0.4);
  assert.ok(stair, 'no stair to the bay');
  const zs = stair.poly.map((p) => p[1]), top = Math.max(...zs), foot = Math.min(...zs), x = stair.poly[0][0] + 0.5;
  const at = (z) => stair.plane[0] + stair.plane[1] * x + stair.plane[2] * z;
  assert.ok(Math.abs(at(top) - bay.y0) < 0.15, `the stair's head is at ${at(top).toFixed(2)}, the door's floor ${bay.y0}`);
  const paving = floorAt(out.floors.filter((f) => f !== stair), x, foot - 1.0, at(foot));
  assert.ok(paving !== null && Math.abs(paving - at(foot)) < 0.15, `the stair comes down to ${at(foot).toFixed(2)}, the paving's at ${paving}`);
  const w = toWorldOf(badu, x, foot - 1.0);
  const over = paving - (groundHeight(w.x, w.z) - badu.y);
  assert.ok(over > 0.1 && over < 0.6, `the paving at the stair's foot is ${over.toFixed(2)} m over the ground`);
});

// Its south-west half, on the land bridge over the motorway's tunnels (tools/local/art-gallery.json's `cover`): the forecourt under its
// canopy, walked from Art Gallery Road; and nothing of the outside down in a tunnel, here or on tiles where the land bridge's tunnel is
// still open (its road the same)
test('Naala Badu: from Art Gallery Road across the forecourt under its canopy to the front doors, a step at a time', () => {
  const out = read('art-gallery-new'), ground = read('art-gallery-new-g');
  const floors = [...out.floors, ...ground.floors];
  const street = (x, z) => {
    const w = toWorldOf(badu, x, z);
    return groundHeight(w.x, w.z) + 0.22 - badu.y;
  };
  const front = out.doors.find((d) => d.id === 'front');
  const [dx, dz] = [(front.hinge[0] + front.latch[0]) / 2, (front.hinge[1] + front.latch[1]) / 2];
  // the forecourt's west edge, by the road's footpath (its sloped cells reaching furthest west); from the lawn 4 m out, east across it,
  // then north to the doors and in
  const west = Math.min(...out.floors.filter((f) => f.plane).flatMap((f) => f.poly.map((p) => p[0])));
  assert.ok(west < -60, `the forecourt reaches ${west} m west, not out towards Art Gallery Road`);
  const path = [[west - 4.0, 4.0], [west + 2.0, 4.0], [dx, 4.0], [dx, dz + 3.0], [dx, dz], [dx, dz - 3.0]];
  const ys = walkHeights(floors, path, street(...path[0]), street);
  const steps = ys.slice(1).map((y, i) => y - ys[i]);
  // a kerb up onto the paving from the lawn, and otherwise no step over a stair's
  const big = steps.filter((d) => Math.abs(d) >= 0.3);
  assert.ok(big.length <= 1 && big.every((d) => d > 0 && d < 0.6), `steps of ${big.map((d) => d.toFixed(2)).join(', ')} m on the way in`);
  assert.equal(ys.at(-1), 0, `${ys.at(-1)} m in, not on the ground floor`);
});

test('Naala Badu over the land bridge: nothing of its outside down in a tunnel under it, nor its walls for the game', async () => {
  const tube = (x, z, margin) => {
    let top = null;
    for (const st of structuresAt(x, z, margin)) if (STRUCTURES[st.sid]?.kind === KIND.TUNNEL) top = Math.max(top ?? -Infinity, st.y + TUNNEL_HEIGHT);
    return top;
  };
  const low = [];
  for (const t of triangles(await readModel('art-gallery-new'))) {
    for (const v of [t.a, t.b, t.c]) {
      const w = toWorldOf(badu, v[0], v[2]), c = tube(w.x, w.z, 0);
      if (c !== null && badu.y + v[1] < c - 0.02) low.push(`(${v[0].toFixed(1)}, ${v[1].toFixed(2)}, ${v[2].toFixed(1)}) under ${(c - badu.y).toFixed(2)}`);
    }
  }
  assert.deepEqual([...new Set(low)].slice(0, 6), [], `${new Set(low).size} of its points down in a tunnel`);
  // its walls for the game: over a tunnel's ceiling, so a car in it never meets them
  const walls = [];
  for (const w of read('art-gallery-new').walls) {
    const n = Math.max(1, Math.ceil(Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1])));
    for (let i = 0; i <= n; i++) {
      const p = toWorldOf(badu, w.a[0] + ((w.b[0] - w.a[0]) * i) / n, w.a[1] + ((w.b[1] - w.a[1]) * i) / n), c = tube(p.x, p.z, 0);
      if (c !== null && badu.y + w.y0 < c - 0.02) walls.push(`${JSON.stringify(w.a)}-${JSON.stringify(w.b)} from ${w.y0} under ${(c - badu.y).toFixed(2)}`);
    }
  }
  assert.deepEqual([...new Set(walls)].slice(0, 6), [], `${new Set(walls).size} of its walls down in a tunnel`);
});

// Both galleries' openings between rooms, arches and doorways: the sides drawn through each wall where the wall stops for it (its walls
// for the game in the JSON), and nowhere else along a wall; and their doors out's sides, in the outside
test('the Art Gallery\'s and Naala Badu\'s openings and doors out: their sides in them, where their walls stop, none anywhere else', async () => {
  const lineOf = (a, b) => (Math.abs(a[0] - b[0]) < 1e-6 ? { axis: 'x', at: a[0], s0: Math.min(a[1], b[1]), s1: Math.max(a[1], b[1]) }
    : Math.abs(a[1] - b[1]) < 1e-6 ? { axis: 'z', at: a[1], s0: Math.min(a[0], b[0]), s1: Math.max(a[0], b[0]) } : null);
  const on = (a, b) => a.axis === b.axis && Math.abs(a.at - b.at) < 1e-3;
  for (const id of ['art-gallery', 'art-gallery-new']) {
    const files = insideFiles(id);
    const walls = files.flatMap((f) => read(f).walls).map((w) => ({ ...w, ...lineOf(w.a, w.b) })).filter((w) => w.axis);
    // an opening: a wall over a gap in its line's walls, those under it stopping at its ends; not a door out (the outside draws those)
    const out = read(id).doors.map((d) => lineOf(d.hinge, d.latch)).filter(Boolean);
    const under = (w, v) => on(v, w) && v.y0 < w.y0 - 0.5 && v.y1 > w.y0;
    const openings = walls.filter((w) => walls.some((v) => under(w, v) && Math.abs(v.s1 - w.s0) < 1e-3)
      && walls.some((v) => under(w, v) && Math.abs(v.s0 - w.s1) < 1e-3)
      && !out.some((d) => d.axis === w.axis && Math.abs(d.at - w.at) < 0.3 && Math.abs(d.s0 - w.s0) < 0.05 && Math.abs(d.s1 - w.s1) < 0.05));
    assert.ok(openings.length > 20, `${id}: ${openings.length} openings`);
    // a side: a face a metre or more tall across a wall, through its thickness, facing along its line
    const sides = [];
    for (const file of files) {
      for (const t of triangles(await readModel(file))) {
        const u = t.b.map((v, i) => v - t.a[i]), v = t.c.map((q, i) => q - t.a[i]);
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], L = Math.hypot(...n);
        const ys = [t.a[1], t.b[1], t.c[1]];
        if (L < 1e-9 || Math.max(...ys) - Math.min(...ys) < 1) continue;
        for (const [axis, across, along] of [['x', 0, 2], ['z', 2, 0]]) {
          if (Math.abs(n[along] / L) < 0.999) continue;
          const cs = [t.a[across], t.b[across], t.c[across]];
          const wall = walls.find((w) => w.axis === axis && Math.min(...cs) > w.at - w.t / 2 - 0.01 && Math.max(...cs) < w.at + w.t / 2 + 0.01
            && Math.max(...cs) - Math.min(...cs) > w.t - 0.02);
          if (wall) sides.push({ file, axis, at: wall.at, s: t.a[along], y0: Math.min(...ys), y1: Math.max(...ys) });
        }
      }
    }
    const stops = (f) => walls.some((w) => on(w, f) && w.y0 <= f.y0 + 0.01 && w.y1 > f.y0 + 0.5 && (Math.abs(w.s0 - f.s) < 0.01 || Math.abs(w.s1 - f.s) < 0.01));
    const stray = [...new Set(sides.filter((f) => !stops(f)).map((f) => `${f.file}: ${f.axis} = ${f.at} at ${f.s.toFixed(2)}, y ${f.y0.toFixed(1)}-${f.y1.toFixed(1)}`))];
    assert.deepEqual(stray.slice(0, 8), [], `${id}: ${stray.length} faces across a wall where it doesn't stop`);
    const missing = openings.flatMap((o) => [o.s0, o.s1].filter((s) => !sides.some((f) => on(f, o) && Math.abs(f.s - s) < 0.01))
      .map((s) => `${o.axis} = ${o.at} at ${s}, under ${o.y0}`));
    assert.deepEqual(missing.slice(0, 8), [], `${id}: ${missing.length} sides of openings not drawn`);
    // the doors out: their sides in the outside, at each jamb, through the wall from the room's face to the building's
    const outside = [...triangles(await readModel(id))];
    for (const d of read(id).doors) {
      const o = lineOf(d.hinge, d.latch), [across, along] = o.axis === 'x' ? [0, 2] : [2, 0];
      for (const s of [o.s0, o.s1]) {
        const side = outside.some((t) => {
          const u = t.b.map((v, i) => v - t.a[i]), v = t.c.map((q, i) => q - t.a[i]);
          const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], L = Math.hypot(...n);
          const cs = [t.a[across], t.b[across], t.c[across]], ys = [t.a[1], t.b[1], t.c[1]];
          return L > 1e-9 && Math.abs(n[along] / L) > 0.999 && Math.abs(t.a[along] - s) < 0.06 && Math.min(...cs) < o.at + 0.3
            && Math.max(...cs) > o.at - 0.3 && Math.max(...cs) - Math.min(...cs) > 0.7 && Math.max(...ys) - Math.min(...ys) > 1;
        });
        assert.ok(side, `${id}: the door out ${d.id} has no side through its wall at ${s}`);
      }
    }
  }
});

// The Queen Victoria Building: 190 m along George St, a door on each of its four streets, three levels of shops round its atrium
const qvb = () => MODEL_SITES.find((s) => s.id === 'qvb');
/** Heights walked along a path in a model's frame, a step at a time, as the walker's floor finds them: [from the street where its floors end] */
function walkHeights(floors, path, start, street = null) {
  const ys = [];
  let y = start;
  for (let k = 0; k + 1 < path.length; k++) {
    const [a, b] = [path[k], path[k + 1]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.1));
    for (let i = 0; i <= n; i++) {
      const x = a[0] + ((b[0] - a[0]) * i) / n, z = a[1] + ((b[1] - a[1]) * i) / n;
      const f = floorAt(floors, x, z, y);
      y = f ?? street?.(x, z) ?? y;
      ys.push(y);
    }
  }
  return ys;
}

test('the QVB\'s doors: one or more on each of its four streets, each a walk from the street with no step over a stair\'s', () => {
  const site = qvb();
  const out = read('qvb'), ground = read('qvb-g');
  const floors = [...out.floors, ...ground.floors];
  const faces = { g: 0, y: 0, s: 0, n: 0 };
  for (const d of out.doors) {
    assert.equal(d.inside, 'qvb-g', `${d.id} leads nowhere`);
    const mid = [(d.hinge[0] + d.latch[0]) / 2, (d.hinge[1] + d.latch[1]) / 2];
    const alongX = Math.abs(d.hinge[1] - d.latch[1]) < 1e-6; // a long front's door: its leaves along x, out is +-z
    const out_ = alongX ? [0, Math.sign(mid[1])] : [Math.sign(mid[0]), 0];
    faces[alongX ? (mid[1] > 0 ? 'g' : 'y') : (mid[0] > 0 ? 'n' : 's')]++;
    // from 3 m out in the street to 4 m in, a step at a time: off the model's floors, the footpath (a kerb over the ground)
    const street = (x, z) => {
      const w = toWorldOf(site, x, z);
      return groundHeight(w.x, w.z) + 0.22 - site.y;
    };
    const from = [mid[0] + out_[0] * 3.0, mid[1] + out_[1] * 3.0], to = [mid[0] - out_[0] * 4.0, mid[1] - out_[1] * 4.0];
    const ys = walkHeights(floors, [from, mid, to], street(...from), street);
    for (let i = 1; i < ys.length; i++) assert.ok(Math.abs(ys[i] - ys[i - 1]) < 0.3, `${d.id}: a step of ${(ys[i] - ys[i - 1]).toFixed(2)} m on the way in`);
    assert.equal(ys.at(-1), 0, `${d.id}: 4 m in, not on the ground floor`);
    assert.ok(Math.abs(floorAt(floors, mid[0], mid[1], d.y0) - d.y0) < 0.01, `${d.id}: its threshold isn't its floor`);
  }
  assert.ok(faces.g >= 1 && faces.y >= 1 && faces.s >= 1 && faces.n >= 1, `its doors on each street: ${JSON.stringify(faces)}`);
});

test('the QVB\'s levels: the ground and the two over it, fetched together, and up each end\'s stair from the ground to level 2', () => {
  assert.deepEqual(insideFiles('qvb'), ['qvb-g', 'qvb-1', 'qvb-2']);
  assert.deepEqual(read('qvb-g').then, ['qvb-1', 'qvb-2']);
  const levels = ['qvb-g', 'qvb-1', 'qvb-2'].map(read);
  assert.deepEqual(levels.map((l) => l.rooms.map((r) => [r.id, r.y0])), [[['g', 0]], [['l1', 5.6]], [['l2', 10.6]]]);
  const floors = levels.flatMap((l) => l.floors);
  for (const sx of [-1, 1]) {
    // the switchback: onto its foot, up the flight by the wall, round the half landing, up the other back to its head; twice
    const low = -12.9, high = -9.98, foot = 74.8, half = 81.6;
    const lap = [[sx * foot, low], [sx * half, low], [sx * half, high], [sx * foot, high]];
    const ys = walkHeights(floors, [[sx * 70, -10.0], [sx * 72.4, low], ...lap, [sx * foot, low], ...lap.slice(1), [sx * 72.4, high]], 0);
    for (let i = 1; i < ys.length; i++) assert.ok(Math.abs(ys[i] - ys[i - 1]) < 0.3, `the stair at ${sx * foot}: a step of ${(ys[i] - ys[i - 1]).toFixed(2)} m`);
    assert.equal(ys.find((y) => Math.abs(y - 5.6) < 1e-6), 5.6, `the stair at ${sx * foot} never gets to level 1`);
    assert.equal(ys.at(-1), 10.6, `the stair at ${sx * foot} ends at ${ys.at(-1)}, not level 2`);
  }
});

test('the QVB\'s shops: one node drawn at each bay of each level, its goods inside it, and its galleries\' void walled by the balustrade', () => {
  for (const file of ['qvb-g', 'qvb-1', 'qvb-2']) {
    const data = read(file);
    const shops = data.instances.find((i) => i.node === 'shop').at;
    assert.ok(shops.length >= 60, `${file}: ${shops.length} shops`);
    // each its own bay, fronting the atrium from either side
    for (const [x, , z, yaw] of shops) assert.ok(Math.abs(Math.abs(z) - 7.7) < 1e-6 && Math.abs(Math.cos(yaw)) > 0.999, `${file}: a shop at (${x}, ${z})`);
    for (const inst of data.instances.filter((i) => !['shop', 'rail', 'globe', 'bench', 'cafe'].includes(i.node))) {
      for (const [x, , z] of inst.at) {
        assert.ok(shops.some(([sx, , sz]) => Math.abs(x - sx) < 2.0 && Math.sign(z) === Math.sign(sz) && Math.abs(z) > 7.7 && Math.abs(z) < 14.2),
          `${file}: a ${inst.node} at (${x}, ${z}) in no shop`);
      }
    }
    if (file === 'qvb-g') continue;
    // the void: a hole in the level's floor between the shopfronts, a wall a metre high along each of its edges
    const floor = data.floors.find((f) => f.holes?.length);
    const void_ = floor.holes.find((h) => h.length > 20);
    assert.ok(void_.every(([, z]) => Math.abs(z) < 7.7), `${file}: its void reaches the shops`);
    for (let i = 0; i < void_.length; i++) {
      const a = void_[i], b = void_[(i + 1) % void_.length];
      const wall = data.walls.find((w) => Math.hypot(w.a[0] - a[0], w.a[1] - a[1]) < 0.01 && Math.hypot(w.b[0] - b[0], w.b[1] - b[1]) < 0.01);
      assert.ok(wall && wall.y1 - wall.y0 >= 1.0, `${file}: no balustrade from (${a}) to (${b})`);
    }
    const rail = data.instances.find((i) => i.node === 'rail');
    assert.ok(rail.at.length >= void_.length && rail.at.every((r) => r[4] > 0.6 && r[4] < 1.4), `${file}: its balustrade's panels`);
  }
});

test('the QVB\'s clocks hang over the void, their hands turned to Sydney\'s time, and the dome\'s void open over the tree\'s spot', () => {
  const top = read('qvb-2'), ground = read('qvb-g');
  const hands = top.spin.filter((s) => s.clock);
  assert.equal(hands.length, 8);
  for (const h of hands) {
    // each about the axis out of its dial's face, along the atrium, at a clock over the void
    assert.equal(Math.abs(h.axis[0]), 1, `${h.node}'s axis`);
    assert.ok(Math.abs(h.centre[2]) < 0.01 && Math.abs(Math.abs(h.centre[0]) - 36) < 1.5 && h.centre[1] > 12 && h.centre[1] < 20, `${h.node} at ${h.centre}`);
    assert.ok(['hour', 'minute'].includes(h.clock) && h.room === 'l2');
  }
  assert.ok(top.spin.find((s) => s.node === 'hunter' && s.rpm > 0 && s.axis[1] === 1), 'no hunter going round');
  // the tree's spot: under the dome on the ground floor, with nothing on the floor within its plinth and the levels over it open
  const [spot] = ground.spots;
  assert.equal(spot.kind, 'christmas-tree');
  assert.equal(floorAt(ground.floors, spot.at[0], spot.at[2], 0), 0);
  const plinth = spot.r + 0.85;
  for (const file of ['qvb-g', 'qvb-1', 'qvb-2']) {
    for (const w of read(file).walls.filter((w) => w.y0 < 2.0)) {
      const d = Math.hypot((w.a[0] + w.b[0]) / 2 - spot.at[0], (w.a[1] + w.b[1]) / 2 - spot.at[2]);
      assert.ok(d > plinth + 1.0, `${file}: a wall ${d.toFixed(1)} m from the tree's middle, in its way`);
    }
  }
  for (const file of ['qvb-1', 'qvb-2']) {
    for (let a = 0; a < 2 * Math.PI; a += Math.PI / 8) {
      const x = spot.at[0] + Math.cos(a) * spot.r, z = spot.at[2] + Math.sin(a) * spot.r;
      assert.equal(read(file).floors.filter((f) => !f.plane).map((f) => floorAt([f], x, z, 20)).filter((y) => y !== null).length, 0,
        `${file}'s floor over the tree at (${x.toFixed(1)}, ${z.toFixed(1)})`);
    }
  }
});

const central = () => MODEL_SITES.find((s) => s.id === 'central-station');
test('Central Station: in from Eddy Ave through its arcade, along the passage and up the stair to the concourse; and up from the street onto the forecourt, in at its door and through the hall', () => {
  const site = central();
  const out = read('central-station'), inside = read('central-station-in');
  const floors = [...out.floors, ...inside.floors];
  const street = (x, z) => {
    const w = toWorldOf(site, x, z);
    return groundHeight(w.x, w.z) + 0.22 - site.y;
  };
  const doors = Object.fromEntries(out.doors.map((d) => [d.id, d]));
  assert.deepEqual(Object.keys(doors).sort(), ['eddy', 'forecourt']);
  for (const d of out.doors) assert.equal(d.inside, 'central-station-in', `${d.id} leads nowhere`);
  const mid = (d) => [(d.hinge[0] + d.latch[0]) / 2, (d.hinge[1] + d.latch[1]) / 2];
  // Eddy Ave's door, at the back of the arcade on the footpath's height: in, along under the forecourt, up through the north wing
  const [ex, ez] = mid(doors.eddy);
  assert.ok(Math.abs(street(ex, ez + 2.0) - doors.eddy.y0) < 0.12, `the footpath at the Eddy Ave door is ${street(ex, ez + 2.0).toFixed(2)}, its threshold ${doors.eddy.y0}`);
  let ys = walkHeights(floors, [[ex, 34.0], [ex, ez], [ex, 22.0], [ex, 17.0], [ex, 10.8], [ex, 3.0], [ex, -3.0]], street(ex, 34.0), street);
  for (let i = 1; i < ys.length; i++) assert.ok(Math.abs(ys[i] - ys[i - 1]) < 0.3, `from Eddy Ave: a step of ${(ys[i] - ys[i - 1]).toFixed(2)} m`);
  assert.ok(Math.min(...ys) < -4.0 && ys.at(-1) === 0, `from Eddy Ave: from ${Math.min(...ys).toFixed(2)} m to ${ys.at(-1)} m, not up to the concourse`);
  // the forecourt: up its stair at the east end from the street, along it to the door, through the hall into the concourse
  const [fx, fz] = mid(doors.forecourt);
  // (the stair's the sloped floor reaching furthest east; the arcade's bays are sloped floors too, with the footpath)
  const foot = Math.min(...out.floors.filter((f) => f.plane).flatMap((f) => f.poly.map((p) => p[0])));
  ys = walkHeights(floors, [[foot - 2.0, 24.0], [foot + 8.0, 24.0], [fx, 24.0], [fx, fz], [fx, 8.0], [fx, -3.0]], street(foot - 2.0, 24.0), street);
  for (let i = 1; i < ys.length; i++) assert.ok(Math.abs(ys[i] - ys[i - 1]) < 0.3, `onto the forecourt: a step of ${(ys[i] - ys[i - 1]).toFixed(2)} m`);
  assert.ok(ys[0] < -2.0 && ys.at(-1) === 0, `onto the forecourt: from ${ys[0].toFixed(2)} m to ${ys.at(-1)} m`);
  // the rooms walked through, in the one file the doors fetch
  assert.deepEqual(inside.rooms.map((r) => r.id).sort(), ['concourse', 'eddy-stair', 'eddy-way', 'hall']);
});

test('Central Station\'s clocks: the tower\'s four dials and the concourse\'s two, their hands turned to Sydney\'s time', () => {
  const out = read('central-station'), inside = read('central-station-in');
  const tower = out.spin.filter((s) => s.clock);
  assert.equal(tower.length, 8);
  for (const h of tower) {
    // about a level axis out of the dial, high on the tower at the west wing's north end
    assert.ok(Math.abs(Math.hypot(h.axis[0], h.axis[2]) - 1) < 1e-6 && h.axis[1] === 0, `${h.node}'s axis`);
    assert.ok(h.centre[1] > 45 && h.centre[1] < 60 && h.centre[0] > 55 && h.centre[0] < 72, `${h.node} at ${h.centre}`);
    assert.ok(['hour', 'minute'].includes(h.clock) && !h.room);
  }
  assert.equal(new Set(tower.map((h) => h.axis.join())).size, 4, 'not a dial on each face');
  const hall = inside.spin.filter((s) => s.clock);
  assert.equal(hall.length, 4);
  for (const h of hall) assert.ok(h.room === 'concourse' && Math.abs(Math.abs(h.centre[0]) - 53.3) < 0.5, `${h.node} at ${h.centre}, in ${h.room}`);
  // the lamps and benches drawn from one node each, the lamps over the floor under the roof, a seat on each bench
  const inst = Object.fromEntries(inside.instances.map((i) => [i.node, i.at]));
  assert.ok(inst.globe.length >= 20 && inst.globe.every(([x, y, z]) => y > 6 && z < 0 && z > -28.5), 'its lamps');
  assert.ok(inst.bench.length >= 8 && inside.seats.length === inst.bench.length * 3, 'its benches');
});

