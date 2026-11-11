import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Sydney Tower is drawn two ways from one shape (js/sydney-tower.js): the game's own, from anywhere, and its model near it
// (js/model-sites.js, built by scripts outside this repo from the same shape). These hold the two together.
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { TOWER, TOWER_AXIS, TOWER_STREET, TOWER_YAW, towerCables } = await import('../js/sydney-tower.js');
const { MODEL_SITES, clearOfSites, toWorldOf } = await import('../js/model-sites.js');
const site = MODEL_SITES.find((s) => s.id === 'sydney-tower');
const inRing = (ring, x, z) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[j];
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) c = !c;
  }
  return c;
};

test('the model stands where the game\'s own tower does, and takes the place of the podium round it', () => {
  assert.equal(site.x, TOWER_AXIS.x);
  assert.equal(site.z, TOWER_AXIS.z);
  assert.equal(site.yaw, TOWER_YAW);
  assert.equal(site.y, TOWER_STREET);
  for (const [lx, lz] of site.replaces) {
    const { x, z } = toWorldOf(site, lx, lz);
    assert.ok(inRing(TOWER.podium.outline, x, z), `the point it replaces, ${x.toFixed(1)}, ${z.toFixed(1)}, isn't in the podium`);
  }
  assert.ok(inRing(TOWER.podium.outline, site.x, site.z), 'the shaft stands on the podium');
});

test('its door is on the podium\'s front on Market St, no street tree before it', () => {
  const out = JSON.parse(fs.readFileSync(new URL('../public/models/sydney-tower.json', import.meta.url), 'utf8'));
  const [door] = out.doors;
  const front = Math.max(...TOWER.podium.outline.map(([x, z]) => (x - site.x) * Math.sin(site.yaw) + (z - site.z) * Math.cos(site.yaw)));
  assert.ok(Math.abs(door.hinge[1] - front) < 0.5, `the door at z ${door.hinge[1]}, the front at ${front.toFixed(2)}`);
  const outside = toWorldOf(site, (door.hinge[0] + door.latch[0]) / 2, door.hinge[1] + 1.5);
  assert.equal(clearOfSites(outside.x, outside.z), false, 'a street tree could stand at its door');
  assert.equal(clearOfSites(site.x + 40, site.z + 40), true);
});

test('the shape: profiles rising, the net in two families from the base to the collar to under the dish', () => {
  for (const part of TOWER.parts) {
    for (let i = 1; i < part.profile.length; i++) assert.ok(part.profile[i][0] >= part.profile[i - 1][0], `${part.name} goes down`);
  }
  assert.ok(Math.abs(TOWER.parts.find((p) => p.name === 'spire').profile.at(-1)[0] - 309) < 0.01, 'the spire\'s tip at 309 m');
  const cables = towerCables(12);
  assert.equal(cables.length, 12 * 2 * 2);
  for (const [a, b] of cables) assert.ok(b[1] > a[1], 'a cable runs up');
});

test('the game\'s own tower is three draws, with the podium', async () => {
  const THREE = await import('three/webgpu');
  const { buildLandmarks } = await import('../js/landmarks.js');
  const { towerPlain } = buildLandmarks(new THREE.Group());
  const meshes = [];
  towerPlain.traverse((o) => { if (o.isMesh) meshes.push(o); });
  assert.equal(meshes.length, 3);
  assert.ok(meshes.every((m) => m.frustumCulled === false), 'js/scene-culling.js would take them over');
});

test('its model was built on the shape the game has now: build it again if not (tools/models/, sydney_tower.py)', () => {
  const out = JSON.parse(fs.readFileSync(new URL('../public/models/sydney-tower.json', import.meta.url), 'utf8'));
  assert.deepEqual(out.builtOn, JSON.parse(JSON.stringify(TOWER)));
});
