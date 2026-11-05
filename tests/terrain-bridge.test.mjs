import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The modules fetch their binary data at import: serve it from disk
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { rawTerrainHeight, terrainHeight, terrainSlope } = await import('../js/terrain.js');
const { BRIDGE_LENGTH, BRIDGE_SPAN, DECK_SID, HALF_WIDTH, bridgeAt, bridgePoint, deckHeight, deckSpanAt } = await import('../js/bridge.js');
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

// The deck carries several roads side by side (plan 5): the northbound on the corridor, the southbound and the Cahill's lanes east of
// it. Across them a car can move, past the deck's outer barriers it can't.
test('mid-span, nothing past the barrier is in reach: the car stays on the deck', () => {
  const s = BRIDGE_LENGTH / 2, mid = bridgePoint(s), y = deckHeight(s), span = deckSpanAt(s);
  const nx = -mid.uz, nz = mid.ux;
  const at = (off) => chooseSurface(DECK_SID, y, mid.x + nx * off, mid.z + nz * off, 1);
  assert.ok(at(span.west + 2), 'inside the west barrier');
  assert.equal(at(span.west - 3), null, 'past the west barrier');
  assert.ok(at(span.east - 2), 'the deck\'s easternmost road');
  assert.equal(at(span.east + 3), null, 'past the east barrier');
});

// Each pylon collides as its granite either side of its arched opening (plan 5): the railway and cycleway go through the west
// pair, the Cahill's lane and the footway through the east pair. No road, on the deck or under it, runs into the granite.
test('the pylons stand clear of the deck and of the streets beneath, and collide only where they are drawn', async () => {
  const THREE = await import('three/webgpu');
  const { GEO } = await import('../js/geodata.js');
  const { buildHarbourBridge, harbourBridgeColliders } = await import('../js/harbour-bridge.js');
  const colliders = [];
  harbourBridgeColliders(colliders);
  buildHarbourBridge(new THREE.Group());
  const pieces = colliders.filter((c) => c.obb && c.maxY > 60);
  const pylons = new Map();
  for (const c of pieces) {
    const here = bridgeAt(c.obb.cx, c.obb.cz, 60);
    const key = `${Math.round(here.s / 50)}${here.off < 0 ? 'w' : 'e'}`;
    pylons.set(key, (pylons.get(key) || 0) + 1);
  }
  assert.equal(pylons.size, 4, `four pylons: ${[...pylons.keys()]}`);
  for (const [key, n] of pylons) assert.equal(n, 2, `pylon ${key}: granite either side of its opening`);
  const RG = GEO.roadGraph, N = RG.nodes;
  for (const c of pieces) {
    const o = c.obb;
    const inside = (x, z) => Math.abs((x - o.cx) * o.cs - (z - o.cz) * o.sn) < o.hx && Math.abs((x - o.cx) * o.sn + (z - o.cz) * o.cs) < o.hz;
    for (const record of RG.links) {
      if (!record) continue;
      const [a, b, name, width, , , inner] = record;
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
            assert.ok(!inside(x + nx * side * width / 2, z + nz * side * width / 2), `${RG.names[name]} runs into a pylon at ${Math.round(x)}, ${Math.round(z)}`);
          }
        }
      }
    }
  }
});
