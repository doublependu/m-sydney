import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as THREE from 'three/webgpu';

// What stands on the ground by roads off it, on the real map: trees by decks and in cuttings, buildings under the Harbour Bridge's
// railway, piers over other roads, and the fences along cuttings' tops (js/deck-room.js, js/structures.js, tools/tiles/derive.mjs).
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { heldTiles, isHeld, tileKeyAt } = await import('../js/geodata.js');
const { DECK_REACH, bridgeAt, deckUndersideAt } = await import('../js/bridge.js');
const { treeClear, trunkClear } = await import('../js/deck-room.js');
const { KIND, LINKS, linkById, structuresAt, tunnelCovered } = await import('../js/surfaces.js');
const held = (x, z) => [-60, 60].every((d) => isHeld(tileKeyAt(x + d, z + d)));

test('a tall tree beside a deck keeps its crown off it; a short one there is clear of it', (t) => {
  // By the Cahill's viaduct at the Harbour Bridge's south end, the deck 14 m over the tree's foot
  if (!held(-184.5, -1674)) return t.skip('not held');
  assert.equal(treeClear(-184.5, -1674, 18.5), false, 'an 18 m tree\'s crown reaches up through the deck');
  assert.equal(treeClear(-184.5, -1674, 6), true, 'a 6 m tree stands under it, beside it');
});

test('no tree stands in a tunnel\'s road where it\'s open to the sky, and one may over it where it\'s under the ground', () => {
  let open = 0, covered = 0;
  for (const l of LINKS) {
    if (l.kind !== KIND.TUNNEL || l.length < 120) continue;
    const at = (s) => {
      let acc = 0;
      for (let i = 1; i < l.pts.length; i++) {
        const a = l.pts[i - 1], b = l.pts[i], L = Math.hypot(b.x - a.x, b.z - a.z);
        if (acc + L >= s) return { x: a.x + ((b.x - a.x) * (s - acc)) / L, z: a.z + ((b.z - a.z) * (s - acc)) / L };
        acc += L;
      }
      return l.pts[l.pts.length - 1];
    };
    if (l.openA > 10 && !tunnelCovered(l, 5)) {
      const p = at(5);
      if (held(p.x, p.z)) { assert.equal(trunkClear(p.x, p.z), false, `${l.name || l.id}, open at ${p.x.toFixed(0)}, ${p.z.toFixed(0)}`); open++; }
    }
    const mid = l.length / 2;
    if (tunnelCovered(l, mid)) {
      const p = at(mid);
      // Under another road off the ground, it's that one's
      const others = structuresAt(p.x, p.z, -1).filter((o) => o.sid !== l.sid);
      if (held(p.x, p.z) && !others.length) { assert.equal(trunkClear(p.x, p.z), true, `${l.name || l.id}, covered at ${p.x.toFixed(0)}, ${p.z.toFixed(0)}`); covered++; }
    }
  }
  assert.ok(open > 5, `${open} open cuttings looked at`);
  assert.ok(covered >= 1, `${covered} covered tunnels looked at`);
});

test('nothing built reaches up into the Harbour Bridge\'s deck beyond its roads, under its railway and footway', (t) => {
  if (!held(-280, -1533)) return t.skip('not held');
  const inRing = (ring, x, z) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) c = !c;
    }
    return c;
  };
  let looked = 0;
  for (const b of heldTiles().flatMap((tile) => tile.buildings)) {
    if (!bridgeAt(b.cx, b.cz, DECK_REACH + Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ))) continue;
    looked++;
    for (let x = b.minX + 0.5; x < b.maxX; x += 1) {
      for (let z = b.minZ + 0.5; z < b.maxZ; z += 1) {
        const under = deckUndersideAt(x, z);
        if (under === null || !b.polygons.some((p) => inRing(p.outer, x, z))) continue;
        assert.ok(b.floor + b.height <= under, `the building at ${b.cx.toFixed(0)}, ${b.cz.toFixed(0)} is ${(b.floor + b.height - under).toFixed(1)} m into the deck at ${x}, ${z}`);
      }
    }
  }
  assert.ok(looked > 30, `${looked} buildings by the bridge`);
});

// A tile's structures as drawn: their piers, and the colliders along cuttings' tops
const structures = (() => {
  let built = null;
  return async () => {
    if (built) return built;
    console.info = () => {};
    const { buildStructures } = await import('../js/structures.js');
    const group = new THREE.Group();
    const job = buildStructures(group, new THREE.MeshStandardNodeMaterial());
    let step;
    do step = job.next(); while (!step.done);
    const piers = [], m = new THREE.Matrix4();
    for (const mesh of group.children) {
      if (!mesh.isInstancedMesh || !mesh.geometry.parameters?.radiusTop) continue;
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        piers.push({ x: m.elements[12], z: m.elements[14], r: m.elements[0], top: m.elements[13] + m.elements[5] });
      }
    }
    built = { piers, colliders: step.value.colliders, group };
    return built;
  };
})();

test('High St\'s piers stand out of the Harbour Tunnel\'s lanes in the cutting under it', async (t) => {
  if (!held(-164, -3492)) return t.skip('not held');
  const { piers } = await structures();
  const tunnel = [1011, 1014].map((id) => linkById.get(id)).filter(Boolean);
  assert.ok(tunnel.length, 'the tunnel\'s approach is there');
  const near = piers.filter((p) => Math.hypot(p.x + 164, p.z + 3492) < 60);
  assert.ok(near.length, 'High St\'s bridge has piers there');
  for (const p of near) {
    for (const l of tunnel) {
      for (let i = 1; i < l.pts.length; i++) {
        const a = l.pts[i - 1], b = l.pts[i], dx = b.x - a.x, dz = b.z - a.z;
        const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
        const d = Math.hypot(a.x + dx * u - p.x, a.z + dz * u - p.z);
        // Under the bridge, not a pier of the tunnel's own
        if (p.top > (a.y + (b.y - a.y) * u) + 4) assert.ok(d > l.width / 2 + p.r, `a pier at ${p.x.toFixed(1)}, ${p.z.toFixed(1)} is ${d.toFixed(1)} m from the middle of ${l.name}`);
      }
    }
  }
});

test('a fence stands along the Cahill\'s cutting at Upper Fort St, and holds you at its top', async (t) => {
  if (!held(-355, -1388)) return t.skip('not held');
  const { colliders } = await structures();
  const fence = colliders.filter((c) => c.obb && c.maxY === 2.2 && Math.hypot(c.obb.cx + 370, c.obb.cz + 1395) < 40);
  assert.ok(fence.length >= 4, `${fence.length} lengths of fence there`);
  for (const c of fence) assert.equal(c.minY, 0, 'from the ground up');
  const palisade = [];
  (await structures()).group.traverse((o) => { if (o.isMesh && o.material?.alphaTest > 0) palisade.push(o); });
  assert.ok(palisade.length >= 1, 'the palisade is drawn, its bars cut out of one strip a tile');
});
