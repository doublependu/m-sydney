import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The modules fetch their binary data at import: serve it from disk
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { terrainHeight, terrainSlope } = await import('../js/terrain.js');
const { BRIDGE_LENGTH, BRIDGE_SPAN, HALF_WIDTH, bridgeAt, bridgePoint, deckHeight, updateDeckState } = await import('../js/bridge.js');

test('the ground matches surveyed heights at known places', () => {
  const places = { 'Circular Quay': [174, -1357, 1], 'Town Hall': [0, 0, 22], 'Hyde Park': [520, 100, 30], Central: [92, 1118, 21], 'Kings Cross': [1504, 1, 41] };
  for (const [name, [x, z, height]] of Object.entries(places)) {
    assert.ok(Math.abs(terrainHeight(x, z) - height) < 2.5, `${name}: ${terrainHeight(x, z).toFixed(1)} m, surveyed ${height} m`);
  }
});

test('the ground is continuous, and flat beyond the grid', () => {
  for (let x = -2000; x < 2000; x += 137) {
    for (let z = -3000; z < 2000; z += 151) {
      const a = terrainHeight(x, z), b = terrainHeight(x + 1, z + 1);
      assert.ok(Math.abs(a - b) < 1.2, `jump of ${Math.abs(a - b).toFixed(2)} m at ${x}, ${z}`);
    }
  }
  assert.equal(terrainHeight(50000, 50000), 0);
  assert.ok(Math.abs(terrainSlope(1100, 20, 1, 0)) < 0.2, 'William St climbs gently');
});

test('the deck meets the ground at both ends and clears the harbour', () => {
  const south = bridgePoint(0), north = bridgePoint(BRIDGE_LENGTH);
  assert.ok(Math.abs(deckHeight(0) - terrainHeight(south.x, south.z)) < 0.01);
  assert.ok(Math.abs(deckHeight(BRIDGE_LENGTH) - terrainHeight(north.x, north.z)) < 0.01);
  assert.ok(deckHeight(BRIDGE_SPAN.middle) > 50, 'ships pass under it');
  assert.ok(BRIDGE_SPAN.north - BRIDGE_SPAN.south > 400, 'the arch spans the water');
  for (let s = 0; s < BRIDGE_LENGTH; s += 20) {
    assert.ok(Math.abs(deckHeight(s + 20) - deckHeight(s)) / 20 < 0.06, `a steep stretch at ${s} m`);
  }
});

test('you only get on the deck at its ends, and stay on until you leave', () => {
  const mid = bridgePoint(BRIDGE_LENGTH / 2);
  const walker = {};
  assert.equal(updateDeckState(walker, mid.x, mid.z), null, 'walking under the bridge stays under it');
  assert.ok(!walker.deck);

  const car = {};
  const start = bridgePoint(20);
  assert.ok(updateDeckState(car, start.x, start.z), 'driving on at the end');
  for (let s = 40; s < BRIDGE_LENGTH - 2; s += 11) {
    const p = bridgePoint(s);
    assert.ok(updateDeckState(car, p.x, p.z), `fell off the deck at ${s} m`);
  }
  updateDeckState(car, north(1000).x, north(1000).z);
  assert.ok(!car.deck, 'off the deck past its end');
  function north(extra) {
    const p = bridgePoint(BRIDGE_LENGTH);
    return { x: p.x + p.ux * extra, z: p.z + p.uz * extra };
  }
});

test('the corridor has a width, and nothing outside it is on the bridge', () => {
  const p = bridgePoint(600);
  const nx = -p.uz, nz = p.ux;
  assert.ok(bridgeAt(p.x + nx * (HALF_WIDTH - 1), p.z + nz * (HALF_WIDTH - 1)));
  assert.equal(bridgeAt(p.x + nx * (HALF_WIDTH + 1), p.z + nz * (HALF_WIDTH + 1)), null);
});
