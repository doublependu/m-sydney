const assert = require('node:assert/strict');
const test = require('node:test');

const buildings = import('../js/geodata.js').then((m) => m.heldTiles().flatMap((t) => t.buildings));

function area(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
  }
  return sum / 2;
}

test('the compressed survey retains every footprint, courtyard and quantized dimension', async () => {
  const REAL_BUILDINGS = await buildings;
  assert.ok(REAL_BUILDINGS.length > 15000);
  let holes = 0;
  for (const building of REAL_BUILDINGS) {
    assert.ok(Number.isInteger(building.height) && building.height >= 1 && building.height <= 320);
    assert.ok(Number.isInteger(building.kind) && building.kind >= 0 && building.kind <= 5);
    const points = [];
    assert.ok(building.polygons.length > 0);
    for (const polygon of building.polygons) {
      holes += polygon.holes.length;
      assert.ok(area(polygon.outer) > 0, 'Exterior winds counterclockwise in x/z.');
      for (const hole of polygon.holes) assert.ok(area(hole) < 0, 'Courtyards wind clockwise.');
      for (const ring of [polygon.outer, ...polygon.holes]) {
        assert.ok(ring.length >= 3);
        for (let i = 0; i < ring.length; i++) {
          const point = ring[i], next = ring[(i + 1) % ring.length];
          assert.ok(Number.isInteger(point.x * 2) && Number.isInteger(point.z * 2));
          assert.ok(point.x !== next.x || point.z !== next.z, 'No duplicate closing or adjacent vertices.');
          points.push(point);
        }
      }
    }
    assert.equal(building.minX, Math.min(...points.map(p => p.x)));
    assert.equal(building.maxX, Math.max(...points.map(p => p.x)));
    assert.equal(building.minZ, Math.min(...points.map(p => p.z)));
    assert.equal(building.maxZ, Math.max(...points.map(p => p.z)));
    assert.equal(building.cx, (building.minX + building.maxX) / 2);
    assert.equal(building.cz, (building.minZ + building.maxZ) / 2);
  }
  assert.ok(holes > 20, `courtyards survive: ${holes}`);
});

test('survey buildings align with the existing city coordinate frame', async () => {
  const REAL_BUILDINGS = await buildings;
  const tallest = [...REAL_BUILDINGS].sort((a, b) => b.height - a.height);
  assert.equal(tallest[0].height, 271, 'Crown Sydney, standing on its podium, tops the survey');
  assert.ok(tallest[0].cx > -800 && tallest[0].cx < -600 && tallest[0].cz > -1300 && tallest[0].cz < -1000, 'at Barangaroo');
  assert.ok(tallest[0].bottom > 0 && tallest[0].group > 0);
  const office = REAL_BUILDINGS.find((b) => b.height === 263);
  assert.ok(office.cx > -300 && office.cx < 400 && office.cz > -1400 && office.cz < -900, 'in the CBD, near Circular Quay');
  const northSydney = REAL_BUILDINGS.filter((b) => b.height > 100 && b.cz < -3000);
  assert.ok(northSydney.length >= 5, 'North Sydney keeps its towers');
});

test('the tallest towers stand as tall as they do in the real city', async () => {
  const REAL_BUILDINGS = await buildings;
  const towers = [
    ['Crown Sydney', -711, -1139, 271], ['Salesforce Tower', -13, -1201, 263], ['Chifley Tower', 326, -897, 244],
    ['World Tower', 41, 400, 230], ['55 Pitt', 13, -1149, 230], ['MLC Centre', 150, -516, 228],
    ['Governor Phillip Tower', 269, -1052, 227], ['International Tower One', -583, -951, 217],
    ['International Tower Two', -566, -877, 178], ['Australia Square', -43, -909, 170]
  ];
  for (const [name, x, z, height] of towers) {
    const here = REAL_BUILDINGS.filter((b) => x > b.minX - 3 && x < b.maxX + 3 && z > b.minZ - 3 && z < b.maxZ + 3);
    const top = Math.max(0, ...here.map((b) => b.height));
    assert.ok(Math.abs(top - height) <= 8, `${name}: ${top} m drawn, ${height} m real`);
  }
});
