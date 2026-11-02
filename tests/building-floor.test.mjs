import assert from 'node:assert/strict';
import test from 'node:test';
import { buildingFloor } from '../js/building-floor.js';

const square = [{ x: 0, z: 0 }, { x: 20, z: 0 }, { x: 20, z: 20 }, { x: 0, z: 20 }];

test('a floor goes at the highest ground along the walls, and reports the lowest', () => {
  const { floor, low } = buildingFloor([{ outer: square, holes: [] }], (x, z) => x * 0.1 + z * 0.05);
  assert.equal(floor, 3);
  assert.equal(low, 0);
});

test('a rise between the corners still lifts the floor', () => {
  const ridge = (x) => Math.max(0, 5 - Math.abs(x - 10) * 0.2); // the ground is a 20 m lattice: it has no spikes
  assert.ok(buildingFloor([{ outer: square, holes: [] }], ridge).floor >= 4);
});

test('courtyard walls count as well as outer ones', () => {
  const court = [{ x: 8, z: 8 }, { x: 12, z: 8 }, { x: 12, z: 12 }, { x: 8, z: 12 }];
  const hill = (x, z) => (Math.hypot(x - 10, z - 10) < 3.5 ? 6 : 0);
  assert.equal(buildingFloor([{ outer: square, holes: [court] }], hill).floor, 6);
});
