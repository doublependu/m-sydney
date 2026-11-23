import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { BIKE_SIDES, CAR_DOORS, FOOTWAY, arrivalFor, besideVehicle, flyingHeight, footwayNear, holdOnFootway, nearestFootpath, nearestLane, walkable } = await import('../js/arrivals.js');
const { bridgePoint, BRIDGE_LENGTH, DECK_SID, deckSpanAt } = await import('../js/bridge.js');
const { ROAD_CLASS, groundHeight, structureAt, structuresAt, KIND, LINKS } = await import('../js/surfaces.js');

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

// Out of a vehicle, beside it: a spot in its frame, metres to its right and ahead of its middle
const inFrame = (v, a) => {
  const fx = Math.sin(v.heading), fz = Math.cos(v.heading), dx = a.x - v.x, dz = a.z - v.z;
  return { right: -fz * dx + fx * dz, ahead: fx * dx + fz * dz };
};
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} for ${b}`);
const macquarieCar = () => {
  const y = groundHeight(SPAWN.x, SPAWN.z);
  return { ...nearestLane(SPAWN.x, SPAWN.z, Math.PI, y), y, surface: 0 };
};

test('out of the car on Macquarie St: beside its driver\'s door, on its right, facing its way', () => {
  const car = macquarieCar();
  const a = besideVehicle(car, CAR_DOORS, world);
  const f = inFrame(car, a);
  near(f.right, 1.5, 'to its right');
  near(f.ahead, 0.3, 'ahead of its middle');
  assert.equal(a.heading, car.heading);
  assert.equal(a.surface, 0);
  assert.ok(!walkable(a.x, a.z), 'in the road beside it, not on the footpath');
  assert.ok(Math.abs(a.y - car.y) < 0.5, 'on its level');
});

test('out of the car where its doors are blocked: the passenger\'s side, then behind it, then in front, then nowhere', () => {
  const car = macquarieCar();
  const side = (blocked) => {
    const a = besideVehicle(car, CAR_DOORS, { isClear: (x, z) => !blocked(inFrame(car, { x, z })) });
    return a && inFrame(car, a);
  };
  const right = (f) => f.right > 1, left = (f) => f.right < -1, behind = (f) => f.ahead < -1;
  const passenger = side(right);
  near(passenger.right, -1.5, 'its left');
  near(side((f) => right(f) || left(f)).ahead, -3, 'behind it');
  near(side((f) => right(f) || left(f) || behind(f)).ahead, 3, 'in front of it');
  assert.equal(side(() => true), null);
});

test('out of the car in a residential street\'s kerbside lane, cars parked at the kerb: the driver\'s side, or the passenger\'s by traffic', () => {
  const link = LINKS.find((l) => !l.kind && l.dir === 0 && l.cls === ROAD_CLASS.residential && l.pts.length === 2 && l.width >= 8
    && Math.hypot(l.pts[1].x - l.pts[0].x, l.pts[1].z - l.pts[0].z) > 80);
  const [p, q] = link.pts, mx = (p.x + q.x) / 2, mz = (p.z + q.z) / 2;
  const y = groundHeight(mx, mz);
  const car = { ...nearestLane(mx, mz, Math.atan2(q.x - p.x, q.z - p.z), y), y, surface: 0 };
  // A car parked at the kerb on its left, alongside, as js/traffic.js parks them (its middle 0.95 m in from the road's edge, 0.92 by
  // 2.3 m), and the walker's body (0.48 m and a margin) kept off it
  const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
  const kerbFromCar = link.width / 2 - 0.95 - Math.hypot(car.x - mx, car.z - mz);
  const kerbCar = (x, z) => { const f = inFrame(car, { x, z }); return Math.abs(f.right + kerbFromCar) < 0.92 + 0.58 && Math.abs(f.ahead) < 2.3 + 0.58; };
  assert.ok(kerbFromCar > 0.5 && kerbFromCar < 2.5, `the kerb's cars ${kerbFromCar.toFixed(2)} m to the car's left`);
  assert.ok(kerbCar(car.x + fz * 1.5, car.z - fx * 1.5), 'the parked car is beside its passenger\'s door');
  const out = besideVehicle(car, CAR_DOORS, { isClear: (x, z) => !kerbCar(x, z) });
  near(inFrame(car, out).right, 1.5, `${link.name}: the driver's side`);
  // Traffic passing on its right, and no car at the kerb there
  const passing = (x, z) => inFrame(car, { x, z }).right > 1;
  near(inFrame(car, besideVehicle(car, CAR_DOORS, { isClear: (x, z) => !passing(x, z) })).right, -1.5, 'the passenger\'s side');
});

test('out of the car on a deck by its barrier: on the deck, inside its road', () => {
  // The Western Distributor at Pyrmont, one way, 14.7 m wide
  const link = LINKS.filter((l) => l.kind === KIND.BRIDGE && l.name === 'Western Distributor' && l.width > 14)
    .sort((a, b) => Math.hypot(a.pts[0].x + 806, a.pts[0].z - 304) - Math.hypot(b.pts[0].x + 806, b.pts[0].z - 304))[0];
  assert.ok(link && Math.hypot(link.pts[0].x + 806, link.pts[0].z - 304) < 300, 'the Western Distributor at Pyrmont');
  const i = Math.floor(link.pts.length / 2), p = link.pts[i], q = link.pts[i + 1];
  const L = Math.hypot(q.x - p.x, q.z - p.z), ux = (q.x - p.x) / L, uz = (q.z - p.z) / L;
  for (const left of [1, -1]) {
    // In its outer lane, beside the barrier: its left, or its right
    const off = link.half - 1.2, x = (p.x + q.x) / 2 + left * uz * off, z = (p.z + q.z) / 2 - left * ux * off;
    const car = { x, z, heading: Math.atan2(ux, uz), y: structureAt(link.sid, x, z).y, surface: link.sid };
    const a = besideVehicle(car, CAR_DOORS, world);
    near(inFrame(car, a).right, 1.5 * left, left > 0 ? 'by its left barrier, the driver\'s side' : 'by its right barrier, the passenger\'s side');
    assert.equal(a.surface, link.sid);
    const on = structureAt(link.sid, a.x, a.z);
    assert.ok(on.inside && on.d < link.half - 0.25, `${on.d.toFixed(2)} m from its middle line, ${link.half} to its edge`);
    assert.ok(Math.abs(a.y - car.y) < 0.2);
  }
});

test('out of the car in a tunnel: in the tunnel, inside its road', () => {
  // The Eastern Distributor's tunnel, where tools/play's mode-switch gets out
  const tube = structuresAt(1550, 112).find((st) => LINKS.some((l) => l.sid === st.sid && l.kind === KIND.TUNNEL));
  assert.ok(tube, 'a tunnel at (1550, 112)');
  const car = { ...nearestLane(1550, 112, 1.43, tube.y, tube.sid), y: tube.y, surface: tube.sid };
  const a = besideVehicle(car, CAR_DOORS, world);
  assert.equal(a.surface, tube.sid);
  assert.ok(structureAt(tube.sid, a.x, a.z).inside);
  // Against its wall: the other side
  const link = structureAt(tube.sid, car.x, car.z).link;
  const fx = Math.sin(car.heading), fz = Math.cos(car.heading), off = link.half - 1.2;
  for (const left of [1, -1]) {
    const by = { ...car, x: car.x + left * fz * off, z: car.z - left * fx * off };
    const b = besideVehicle(by, CAR_DOORS, world);
    assert.equal(b?.surface, tube.sid);
    near(inFrame(by, b).right, 1.5 * left, 'away from the wall');
  }
});

test('out of the car on the Harbour Bridge\'s deck: onto its footway', () => {
  const p = bridgePoint(1100);
  const deck = structuresAt(p.x, p.z).find((s) => s.sid === DECK_SID);
  const a = besideVehicle({ x: p.x, z: p.z, heading: 0.5, y: deck.y, surface: DECK_SID }, CAR_DOORS, world);
  assert.equal(a.footway, true);
  assert.equal(a.surface, DECK_SID);
  assert.equal(a.heading, 0.5);
  const held = holdOnFootway(a.x, a.z);
  assert.ok(Math.hypot(held.x - a.x, held.z - a.z) < 0.01, 'where the footway holds a walker');
});

test('off the bike: on its left, where its stand is, level with its saddle, facing its way; its right where the left is blocked', () => {
  const bike = macquarieCar();
  const f = inFrame(bike, besideVehicle(bike, BIKE_SIDES, world));
  near(f.right, -0.85, 'to its left');
  near(f.ahead, -0.28, 'level with its saddle');
  assert.equal(besideVehicle(bike, BIKE_SIDES, world).heading, bike.heading);
  const right = inFrame(bike, besideVehicle(bike, BIKE_SIDES, { isClear: (x, z) => inFrame(bike, { x, z }).right > 0 }));
  near(right.right, 0.85, 'to its right');
  near(inFrame(bike, besideVehicle(bike, BIKE_SIDES, { isClear: (x, z) => Math.abs(inFrame(bike, { x, z }).right) < 0.1 })).ahead, -1.5, 'behind it');
});
