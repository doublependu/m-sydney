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

const IDS = ['salesforce-tower', 'ey-centre', 'customs-house', 'crown-sydney'];
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
    // Customs House stands up steps from the square
    const step = site.id === 'customs-house' ? 0 : ground;
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
    assert.ok(size(name) < 300_000 && draws <= 15, `${name}: ${size(name)} bytes, ${draws} draws`);
    assert.ok(size(`${name}-in`) < 1_000_000 && tris(`${name}-in`) <= 30_000, `${name}-in: ${size(`${name}-in`)} bytes, ${tris(`${name}-in`)} triangles`);
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
