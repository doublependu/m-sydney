import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The modules fetch their binary data at import: serve it from disk
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { rawTerrainHeight, terrainHeight, terrainSlope } = await import('../js/terrain.js');
const { BRIDGE_LENGTH, BRIDGE_SPAN, DECK_SID, HALF_WIDTH, bridgeAt, bridgePoint, deckHeight } = await import('../js/bridge.js');
const { chooseSurface, groundHeight } = await import('../js/surfaces.js');

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
  assert.ok(Math.abs(deckHeight(0) - rawTerrainHeight(south.x, south.z)) < 0.05);
  assert.ok(Math.abs(deckHeight(BRIDGE_LENGTH) - rawTerrainHeight(north.x, north.z)) < 0.05);
  assert.ok(deckHeight(BRIDGE_SPAN.middle) > 50, 'ships pass under it');
  assert.ok(BRIDGE_SPAN.north - BRIDGE_SPAN.south > 400, 'the arch spans the water');
  for (let s = 0; s < BRIDGE_LENGTH; s += 20) {
    assert.ok(Math.abs(deckHeight(s + 20) - deckHeight(s)) / 20 < 0.06, `a steep stretch at ${s} m`);
  }
});

// Steps a walker or a car along a line, picking its surface each step as js/controllers.js does
function walk(from, points) {
  let at = from;
  for (const [x, z] of points) {
    const next = chooseSurface(at.sid, at.y, x, z, 1);
    if (!next) return { ...at, blocked: true, x, z };
    at = { ...next, x, z };
  }
  return at;
}
const along = (s0, s1, off = -5, step = 4) => {
  const out = [];
  for (let s = s0; s0 < s1 ? s <= s1 : s >= s1; s += s0 < s1 ? step : -step) {
    const p = bridgePoint(s);
    out.push([p.x - p.uz * off, p.z + p.ux * off]);
  }
  return out;
};

test('you only get on the deck at its ends, and stay on until you leave', () => {
  const mid = bridgePoint(BRIDGE_LENGTH / 2);
  // Under the bridge's southern approach, on the ground: the deck is far overhead and stays there
  const under = bridgePoint(400);
  const walker = walk({ sid: 0, y: groundHeight(under.x, under.z) }, [[under.x, under.z]]);
  assert.equal(walker.sid, 0, 'walking under the bridge stays under it');

  // Driving on at the south end, along the whole deck and off the north end
  const start = bridgePoint(2);
  const car = walk({ sid: 0, y: groundHeight(start.x, start.z) }, along(2, BRIDGE_LENGTH / 2));
  assert.equal(car.sid, DECK_SID, `fell off the deck before mid-span: ${JSON.stringify(car)}`);
  assert.ok(car.y > 45, `mid-span at ${car.y} m`);
  const off = walk(car, along(BRIDGE_LENGTH / 2, BRIDGE_LENGTH + 30));
  assert.equal(off.sid, 0, 'still on the deck past its end');
  void mid;
});

test('the corridor has a width, and nothing outside it is on the bridge', () => {
  const p = bridgePoint(600);
  const nx = -p.uz, nz = p.ux;
  assert.ok(bridgeAt(p.x + nx * (HALF_WIDTH - 1), p.z + nz * (HALF_WIDTH - 1)));
  assert.equal(bridgeAt(p.x + nx * (HALF_WIDTH + 1), p.z + nz * (HALF_WIDTH + 1)), null);
});

test('mid-span, nothing past the barrier is in reach: the car stays on the deck', () => {
  const mid = bridgePoint(BRIDGE_LENGTH / 2);
  const y = deckHeight(BRIDGE_LENGTH / 2);
  const nx = -mid.uz, nz = mid.ux;
  assert.ok(chooseSurface(DECK_SID, y, mid.x + nx * (HALF_WIDTH - 2), mid.z + nz * (HALF_WIDTH - 2), 1), 'inside the barrier');
  assert.equal(chooseSurface(DECK_SID, y, mid.x + nx * (HALF_WIDTH + 3), mid.z + nz * (HALF_WIDTH + 3), 1), null, 'past the barrier');
});

test('the pylons stand clear of the deck and of the streets beneath, and collide only where they are drawn', async () => {
  const THREE = await import('three/webgpu');
  const { GEO } = await import('../js/geodata.js');
  const { buildHarbourBridge, harbourBridgeColliders } = await import('../js/harbour-bridge.js');
  const colliders = [];
  harbourBridgeColliders(colliders);
  buildHarbourBridge(new THREE.Group());
  const pylons = colliders.filter((c) => c.obb && c.maxY > 60);
  assert.equal(pylons.length, 4);
  const RG = GEO.roadGraph, N = RG.nodes;
  for (const c of pylons) {
    const o = c.obb;
    // Inner face from the corridor's centre line
    const here = bridgeAt(o.cx, o.cz, 60);
    assert.ok(Math.abs(here.off) - o.hx > 17, `a pylon's inner face is ${(Math.abs(here.off) - o.hx).toFixed(1)} m from the centre line`);
    // No street ribbon reaches into it
    const inside = (x, z) => Math.abs((x - o.cx) * o.cs - (z - o.cz) * o.sn) < o.hx && Math.abs((x - o.cx) * o.sn + (z - o.cz) * o.cs) < o.hz;
    for (const [a, b, name, width, , , inner, , deck] of RG.links) {
      if (deck) continue;
      const pts = [[N[a * 2], N[a * 2 + 1]]];
      for (let k = 0; k < inner.length; k += 2) pts.push([inner[k], inner[k + 1]]);
      pts.push([N[b * 2], N[b * 2 + 1]]);
      for (let i = 1; i < pts.length; i++) {
        const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
        const L = Math.hypot(bx - ax, bz - az);
        if (Math.hypot(ax - o.cx, az - o.cz) > L + 60) continue;
        for (let t = 0; t <= L; t += 1) {
          const x = ax + ((bx - ax) * t) / (L || 1), z = az + ((bz - az) * t) / (L || 1);
          const nx = -(bz - az) / (L || 1), nz = (bx - ax) / (L || 1);
          for (const side of [-1, 0, 1]) {
            assert.ok(!inside(x + nx * side * width / 2, z + nz * side * width / 2), `${RG.names[name]} runs into a pylon`);
          }
        }
      }
    }
  }
});
