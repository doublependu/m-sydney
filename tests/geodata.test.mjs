import { isHeld, tileKeyAt } from '../js/geodata.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BLOCKS, ROADS, blockAt, getLocationLabel, landAt, nearestRoads, SPAWN, TELEPORT_LOCATIONS } from '../js/city-config.js';
import { GEO, heldList } from '../js/geodata.js';

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
  assert.ok(heldList('signals').length / 2 > 300);
});

test('curb islands sit on the land and roads run between them', () => {
  assert.ok(BLOCKS.length > 800);
  assert.equal(blockAt(SPAWN.x, SPAWN.z), null, 'the game starts on a road');
  assert.ok(nearestRoads(SPAWN.x, SPAWN.z, 12).some(({ road }) => road.name === 'Macquarie Street'));
});

test('every teleport lands on a road', () => {
  for (const [name, place] of Object.entries(TELEPORT_LOCATIONS)) {
    if (!isHeld(tileKeyAt(place.x, place.z))) continue; // tests may hold only a part of the map
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

test('the elevated motorways are roads off the ground, and none runs along the Harbour Bridge', () => {
  // Links are [a, b, name, width, lanes, dir, inner, major, deck, kind, layer, flags, heights]: kind 1 a bridge
  const N = GEO.roadGraph.nodes;
  const structures = GEO.roadGraph.links.filter((l) => l[9] === 1 && !l[8]).map((l) => {
    const pts = [N[l[0] * 2], N[l[0] * 2 + 1], ...l[6], N[l[1] * 2], N[l[1] * 2 + 1]];
    return { name: GEO.roadGraph.names[l[2]], pts, ys: l[12] };
  });
  assert.ok(structures.length > 50, `${structures.length} links on bridges`);
  for (const s of structures) assert.equal(s.ys.length * 2, s.pts.length, `${s.name} has a height at every point`);
  const near = (x, z, name) => Math.min(...structures.filter((s) => !name || s.name.startsWith(name)).map((s) => distanceToLine(s.pts, x, z)));
  assert.ok(near(200, -1343, 'Cahill') < 15, 'the Cahill Expressway runs over Circular Quay');
  assert.ok(near(-467, 84, 'Western Distributor') < 20, 'the Western Distributor runs past Darling Harbour');
  // All along the deck: the Cahill's lanes on the bridge once came through as a second, lower deck beside the arch.
  // A ramp that joins the deck comes near it for a moment; nothing else may keep it company for long.
  const alongside = new Map();
  for (let i = 0; i + 3 < GEO.bridge.length; i += 2) {
    const L = Math.hypot(GEO.bridge[i + 2] - GEO.bridge[i], GEO.bridge[i + 3] - GEO.bridge[i + 1]);
    for (let d = 0; d <= L; d += 20) {
      const x = GEO.bridge[i] + ((GEO.bridge[i + 2] - GEO.bridge[i]) * d) / (L || 1);
      const z = GEO.bridge[i + 1] + ((GEO.bridge[i + 3] - GEO.bridge[i + 1]) * d) / (L || 1);
      for (const s of structures) if (distanceToLine(s.pts, x, z) < 12) alongside.set(s, (alongside.get(s) || 0) + 1);
    }
  }
  // Every 20 m along the deck
  for (const [s, near20] of alongside) assert.ok(near20 <= 5, `${s.name} runs along the deck for ${near20 * 20} m`);
});

test('street furniture comes as x, z pairs inside the map', () => {
  assert.ok(heldList('postBoxes').length / 2 > 80);
  assert.ok(heldList('busShelters').length / 2 > 150);
  for (const list of [heldList('postBoxes'), heldList('busShelters')]) {
    assert.equal(list.length % 2, 0);
    for (const value of list) assert.ok(Number.isFinite(value) && Math.abs(value) < 12000);
  }
});
