import assert from 'node:assert/strict';
import test from 'node:test';
import { BLOCKS, ROADS, blockAt, getLocationLabel, landAt, nearestRoads, SPAWN, TELEPORT_LOCATIONS } from '../js/city-config.js';
import { GEO } from '../js/geodata.js';

// World positions of known places, from their real coordinates (tools/geo-common.mjs toWorld)
const LAND = { 'Town Hall': [0, 0], 'Martin Place': [240, -800], 'Observatory Hill': [-360, -1600], 'Hyde Park': [520, 100], 'North Sydney': [-500, -3640], 'Kings Cross': [1504, 1] };
const WATER = { 'Cockle Bay': [-524, -176], 'Sydney Cove': [260, -1800], 'Farm Cove': [960, -1820], 'Mid-harbour': [240, -2420], 'Woolloomooloo Bay': [1300, -1100] };

test('known places land on the right side of the shore', () => {
  for (const [name, [x, z]] of Object.entries(LAND)) assert.ok(landAt(x, z), `${name} is on land`);
  for (const [name, [x, z]] of Object.entries(WATER)) assert.ok(!landAt(x, z), `${name} is in the water`);
});

test('the road graph covers both sides of the harbour with real names', () => {
  const names = new Set(GEO.roadGraph.names);
  for (const name of ['George Street', 'Pitt Street', 'Macquarie Street', 'Oxford Street', 'William Street', 'Miller Street']) assert.ok(names.has(name), name);
  assert.ok(GEO.roadGraph.links.length > 4000);
  assert.ok(GEO.signals.length / 2 > 300);
});

test('curb islands sit on the land and roads run between them', () => {
  assert.ok(BLOCKS.length > 800);
  assert.equal(blockAt(SPAWN.x, SPAWN.z), null, 'the game starts on a road');
  assert.ok(nearestRoads(SPAWN.x, SPAWN.z, 12).some(({ road }) => road.name === 'Macquarie Street'));
});

test('every teleport lands on a road', () => {
  for (const [name, place] of Object.entries(TELEPORT_LOCATIONS)) {
    assert.ok(landAt(place.x, place.z), name);
    assert.ok(nearestRoads(place.x, place.z, 20).length > 0, name);
  }
});

test('location labels name the street corner', () => {
  assert.match(getLocationLabel(SPAWN.x, SPAWN.z), /Macquarie St/);
  assert.equal(getLocationLabel(2600, -2300), 'Sydney Harbour');
  assert.ok(ROADS.some((r) => r.highway), 'the motorways are named for the maps');
});

const distanceToLine = (flat, x, z) => {
  let best = Infinity;
  for (let i = 0; i + 3 < flat.length; i += 2) {
    const ax = flat[i], az = flat[i + 1], dx = flat[i + 2] - ax, dz = flat[i + 3] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-9)));
    best = Math.min(best, Math.hypot(ax + t * dx - x, az + t * dz - z));
  }
  return best;
};

test('the elevated motorways are there, and are not the Harbour Bridge', () => {
  assert.ok(GEO.viaducts.length > 10);
  for (const v of GEO.viaducts) {
    assert.equal(v.pts.length % 2, 0);
    assert.ok(v.pts.length >= 4);
    assert.ok(v.lanes >= 1 && v.lanes <= 4);
    assert.ok(v.layer >= 1 && v.layer <= 3);
    for (const value of v.pts) assert.ok(Number.isFinite(value));
  }
  const near = (x, z) => Math.min(...GEO.viaducts.map((v) => distanceToLine(v.pts, x, z)));
  assert.ok(near(200, -1343) < 15, 'the Cahill Expressway runs over Circular Quay');
  assert.ok(near(-467, 84) < 15, 'the Western Distributor runs past Darling Harbour');
  // All along the deck: the Cahill's lanes on the bridge once came through as a second, lower deck beside the arch
  for (let i = 0; i + 3 < GEO.bridge.length; i += 2) {
    const L = Math.hypot(GEO.bridge[i + 2] - GEO.bridge[i], GEO.bridge[i + 3] - GEO.bridge[i + 1]);
    for (let d = 0; d <= L; d += 20) {
      const x = GEO.bridge[i] + ((GEO.bridge[i + 2] - GEO.bridge[i]) * d) / (L || 1);
      const z = GEO.bridge[i + 1] + ((GEO.bridge[i + 3] - GEO.bridge[i + 1]) * d) / (L || 1);
      assert.ok(near(x, z) > 40, `a viaduct runs along the deck at ${Math.round(x)}, ${Math.round(z)}`);
    }
  }
});

test('street furniture comes as x, z pairs inside the map', () => {
  assert.ok(GEO.postBoxes.length / 2 > 80);
  assert.ok(GEO.busShelters.length / 2 > 150);
  for (const list of [GEO.postBoxes, GEO.busShelters]) {
    assert.equal(list.length % 2, 0);
    for (const value of list) assert.ok(Number.isFinite(value) && Math.abs(value) < 10000);
  }
});
