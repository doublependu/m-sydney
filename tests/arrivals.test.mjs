import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { FOOTWAY, arrivalFor, flyingHeight, footwayNear, holdOnFootway, nearestFootpath, nearestLane, walkable } = await import('../js/arrivals.js');
const { bridgePoint, BRIDGE_LENGTH, DECK_SID, deckSpanAt } = await import('../js/bridge.js');
const { groundHeight, structuresAt, KIND, LINKS } = await import('../js/surfaces.js');

const world = { isClear: () => true, roofs: () => [] };
const SPAWN = { x: 397, z: -1000 };
const on = (x, z, heading = 0, extra = {}) => ({ x, z, heading, y: groundHeight(x, z), surface: 0, flying: false, ...extra });

test('a walker already on a footpath stays exactly there', () => {
  let spot = null;
  for (let x = SPAWN.x - 40; x < SPAWN.x + 40 && !spot; x += 1) if (walkable(x, SPAWN.z)) spot = x;
  assert.ok(spot !== null, 'a footpath near the spawn');
  const a = nearestFootpath(spot, SPAWN.z);
  assert.deepEqual([a.x, a.z, a.d], [spot, SPAWN.z, 0]);
});

test('a walker in the road goes to the nearest footpath, which is not far', () => {
  const lane = nearestLane(SPAWN.x, SPAWN.z, Math.PI, groundHeight(SPAWN.x, SPAWN.z));
  const a = nearestFootpath(lane.x, lane.z);
  assert.ok(walkable(a.x, a.z));
  assert.ok(a.d > 0 && a.d < 30, `${a.d} m away`);
});

test('someone over the harbour goes to the nearest shore, not into the water', () => {
  const a = nearestFootpath(300, -2200);
  assert.ok(a && walkable(a.x, a.z));
  assert.ok(a.d > 50 && a.d < 1500, `${a.d} m away`);
});

test('a footpath in a building is passed over', () => {
  const blocked = (x, z) => Math.hypot(x - SPAWN.x, z - SPAWN.z) > 25;
  const a = nearestFootpath(SPAWN.x, SPAWN.z, blocked);
  assert.ok(blocked(a.x, a.z) && a.d >= 25);
});

test('a driver arrives on the road, in the left lane, heading the way they were', () => {
  const y = groundHeight(SPAWN.x, SPAWN.z);
  for (const heading of [Math.PI, 0]) {
    const a = nearestLane(SPAWN.x + 2, SPAWN.z, heading, y);
    assert.ok(a && a.d < 30, `${a?.d} m away`);
    assert.ok(Math.cos(a.heading - heading) > 0.5, `heading ${a.heading} for ${heading}`);
    assert.equal(a.surface, 0);
  }
});

test('one-way streets are only ever driven one way', () => {
  const oneWay = LINKS.find((l) => l.dir === 1 && !l.kind && l.pts.length === 2 && Math.hypot(l.pts[1].x - l.pts[0].x, l.pts[1].z - l.pts[0].z) > 60);
  const [p, q] = oneWay.pts, mx = (p.x + q.x) / 2, mz = (p.z + q.z) / 2;
  const along = Math.atan2(q.x - p.x, q.z - p.z);
  const a = nearestLane(mx, mz, along + Math.PI, groundHeight(mx, mz));
  assert.ok(Math.cos(a.heading - along) > 0.9, 'kept to its direction though the driver faced the other way');
});

test('on the Harbour Bridge a driver stays on the deck, and a walker goes to its footway', () => {
  const p = bridgePoint(BRIDGE_LENGTH / 2);
  const deck = structuresAt(p.x, p.z).find((s) => s.sid === DECK_SID);
  const from = on(p.x, p.z, 0, { y: deck.y, surface: DECK_SID });
  const car = arrivalFor('car', from, world);
  assert.equal(car.surface, DECK_SID);
  const walker = arrivalFor('person', from, world);
  assert.equal(walker.surface, DECK_SID);
  assert.equal(walker.footway, true);
  const held = holdOnFootway(walker.x, walker.z);
  assert.ok(Math.hypot(held.x - walker.x, held.z - walker.z) < 0.01);
});

// The footway runs past the east edge of the deck's roads (plan 5: OSM's carriageways, the Cahill's lane furthest east)
test('the footway holds a walker to it, and ends before the corridor does', () => {
  const p = bridgePoint(BRIDGE_LENGTH / 2), east = deckSpanAt(BRIDGE_LENGTH / 2).east;
  const at = (off) => holdOnFootway(p.x - p.uz * off, p.z + p.ux * off);
  const offOf = (q) => Math.hypot(q.x - p.x, q.z - p.z);
  assert.ok(Math.abs(offOf(at(east + FOOTWAY.MAX + 2)) - (east + FOOTWAY.MAX)) < 0.2, 'not past the railing');
  assert.ok(Math.abs(offOf(at(east)) - (east + FOOTWAY.MIN)) < 0.2, 'not onto the road');
  assert.ok(Math.abs(offOf(at(east + FOOTWAY.MIDDLE)) - (east + FOOTWAY.MIDDLE)) < 0.2, 'free along it');
  const q = bridgePoint(10);
  assert.equal(holdOnFootway(q.x, q.z), null);
  assert.equal(footwayNear(q.x, q.z), null);
});

test('from the air, a road under a bridge is not chosen over the deck directly below', () => {
  const p = bridgePoint(BRIDGE_LENGTH / 2);
  const from = { x: p.x, z: p.z, heading: 0, y: 300, surface: 0, flying: true };
  assert.equal(arrivalFor('car', from, world).surface, DECK_SID);
});

test('in a tunnel you stay in it', () => {
  const link = LINKS.find((l) => l.kind === KIND.TUNNEL && l.name === 'William Street' && l.pts.length >= 2);
  const m = link.pts[Math.floor(link.pts.length / 2)];
  const from = on(m.x, m.z, 0, { y: m.y, surface: link.sid });
  assert.equal(arrivalFor('car', from, world).surface, link.sid);
  assert.equal(arrivalFor('person', from, world).surface, link.sid);
  assert.equal(arrivalFor('cyclist', from, world).surface, link.sid);
});

test('a helicopter never drops into a tunnel', () => {
  const link = LINKS.find((l) => l.kind === KIND.TUNNEL && l.name === 'William Street');
  const m = link.pts[0];
  const a = arrivalFor('car', { x: m.x, z: m.z, heading: 0, y: 200, surface: 0, flying: true }, world);
  assert.notEqual(a.surface, link.sid);
});

test('a rider takes whichever is nearer of the road and the footpath', () => {
  const y = groundHeight(SPAWN.x, SPAWN.z);
  const lane = nearestLane(SPAWN.x, SPAWN.z, Math.PI, y);
  const onRoad = arrivalFor('cyclist', on(lane.x, lane.z, Math.PI), world);
  assert.ok(Math.hypot(onRoad.x - lane.x, onRoad.z - lane.z) < 6, 'in the road, near where they were');
  const path = nearestFootpath(lane.x, lane.z);
  const inner = arrivalFor('cyclist', on(path.x, path.z), world);
  assert.deepEqual([inner.x, inner.z], [path.x, path.z], 'on a footpath, they stay');
});

test('flying height clears most of the roofs around, and anything right beside it', () => {
  const roofs = [...Array(10)].map((_, i) => ({ top: 40 + i, away: 150 }));
  assert.equal(flyingHeight(roofs, 20), 60);
  // Over open ground: 60 m up
  assert.equal(flyingHeight([], 25), 60);
  // Most roofs low, one tower beside you
  const tower = [...roofs, { top: 240, away: 30 }];
  assert.equal(flyingHeight(tower, 20), 240 + 15 - 20);
  // A tower far away doesn't count for much
  const far = [...Array(20)].map(() => ({ top: 30, away: 100 })).concat([{ top: 260, away: 180 }]);
  assert.equal(flyingHeight(far, 10), 60);
  // Never over the cap
  assert.equal(flyingHeight([{ top: 700, away: 5 }], 0), 380);
});

test('flying off the deck clears the arch', () => {
  const p = bridgePoint(BRIDGE_LENGTH / 2);
  const a = arrivalFor('helicopter', on(p.x, p.z, 1.2), world);
  assert.ok(a.altitude + groundHeight(p.x, p.z) >= 150);
  assert.deepEqual([a.x, a.z, a.heading], [p.x, p.z, 1.2]);
});
