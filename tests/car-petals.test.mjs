import assert from 'node:assert/strict';
import test from 'node:test';
import { BODY_SPECS, buildCarGeometry } from '../js/cars.js';
import { CARDS, flight, landing, nextLoad, restingSpots } from '../js/car-petals.js';

test("the flowers lie on the taxi's bonnet, roof and boot, facing up, never on its roof light", () => {
  const spec = BODY_SPECS.taxi;
  const spots = restingSpots(buildCarGeometry(spec, false), CARDS.high);
  assert.equal(spots.length, CARDS.high);
  const where = { bonnet: 0, roof: 0, boot: 0 };
  for (const s of spots) {
    assert.ok(s.ny > 0.9, `facing ${s.ny.toFixed(2)} up`);
    assert.ok(s.z < spec.zFront && s.z > spec.zRear && Math.abs(s.x) < 0.95);
    // The roof light stands about 1.5-1.6 m up; the roof under it is about 1.44 m
    assert.ok(s.y < 1.47, `${s.y.toFixed(3)} m up: on the roof light`);
    if (s.z > spec.cabin.cowl) where.bonnet++;
    else if (s.z < spec.cabin.roofFront && s.z > spec.cabin.roofRear) where.roof++;
    else if (s.z < spec.cabin.deck) where.boot++;
  }
  for (const [part, n] of Object.entries(where)) assert.ok(n > CARDS.high * 0.08, `${part}: ${n}`);
  // The same spots every load
  assert.deepEqual(restingSpots(buildCarGeometry(spec, false), 50), restingSpots(buildCarGeometry(spec, false), 50));
});

test('a flower lands where its flight meets the ground, after it has risen off the roof', () => {
  const cases = [[16.7, 0, 2.1, 1.45, 0], [0, 0, 0.6, 1.45, 0.3], [-5, 12, 1.4, 1.2, -0.8]];
  for (const [vx, vz, vy, y0, ground] of cases) {
    const floorAt = (x, z) => ground + 0.002 * x - 0.001 * z;
    const { T, floor } = landing(10, y0, 20, vx, vy, vz, floorAt);
    const at = flight(10, y0, 20, vx, vy, vz, T);
    assert.ok(T > 0.5, `in the air ${T.toFixed(2)} s`);
    assert.ok(Math.abs(at.y - floor) < 0.02, `${at.y.toFixed(3)} at ${floor.toFixed(3)}`);
    assert.ok(Math.abs(floor - floorAt(at.x, at.z)) < 0.01);
    // Over the ground all the way down
    for (let t = 0; t < T * 0.98; t += T / 50) assert.ok(flight(10, y0, 20, vx, vy, vz, t).y > floor - 0.01);
    // Slowed by the air: never further than the speed it left with would take it in a second
    assert.ok(Math.hypot(at.x - 10, at.z - 20) < Math.hypot(vx, vz) * 1.0 + T * 0.5 + 0.1);
  }
  // Already on the ground: lands at once
  assert.equal(landing(0, 0.5, 0, 3, 0, 0, () => 1).T, 0);
});

test('they blow off in about a minute at 60 km/h, faster the faster, never at a crawl, and settle under a jacaranda', () => {
  const emptyAt = (kmh) => {
    let load = 1, t = 0;
    while (load > 0 && t < 3600) {
      load = nextLoad(load, kmh / 3.6, 0.05);
      t += 0.05;
    }
    return t;
  };
  const at60 = emptyAt(60);
  assert.ok(at60 > 50 && at60 < 70, `${at60.toFixed(1)} s at 60 km/h`);
  assert.ok(emptyAt(100) < 25);
  assert.ok(emptyAt(30) > 200);
  assert.equal(nextLoad(1, 9 / 3.6, 60), 1, 'none at 9 km/h');
  // Stopped under one: full again in about a minute and a half; creeping through its carpet, slower; not under one, never
  let load = 0;
  for (let t = 0; t < 60; t += 0.1) load = nextLoad(load, 0, 0.1, true);
  assert.ok(load > 0.6 && load < 0.9, `${load.toFixed(2)} after a minute stopped`);
  let creeping = 0;
  for (let t = 0; t < 60; t += 0.1) creeping = nextLoad(creeping, 3.5, 0.1, true);
  assert.ok(creeping > 0.05 && creeping < load);
  assert.equal(nextLoad(0, 0, 60, false), 0);
});
