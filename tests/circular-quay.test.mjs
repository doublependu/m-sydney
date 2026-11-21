// Circular Quay Station (js/model-sites.js `circular-quay`): fitted under the Cahill Expressway, which is the game's own deck
// (js/structures.js), its piers standing through the station; the hall's floor over the map's paving; escalators that carry you up.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import { readModel, triangles } from './helpers/glb.mjs';

globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { MODEL_SITES, toWorldOf } = await import('../js/model-sites.js');
const { heldTiles } = await import('../js/geodata.js');
const { DECK_DEPTH, KIND, LINKS, STRUCTURES, groundHeight, structuresAt } = await import('../js/surfaces.js');
const { blockAt } = await import('../js/city-config.js');
const { buildStructures } = await import('../js/structures.js');

const site = MODEL_SITES.find((s) => s.id === 'circular-quay');
const read = (name) => JSON.parse(fs.readFileSync(new URL(`../public/models/${name}.json`, import.meta.url), 'utf8'));
const toLocal = (x, z) => {
  const c = Math.cos(site.yaw), s = Math.sin(site.yaw), dx = x - site.x, dz = z - site.z;
  return { x: dx * c - dz * s, z: dx * s + dz * c };
};
const held = () => heldTiles().some((t) => t.key === '0_-2');
// The station as its model has it: the platforms' floors, the tracks between them (each a train's width), its ends
const inside = read('circular-quay-in');
const platforms = inside.floors.filter((f) => f.y > 7);
const EDGES = { s: -1.85, n: 6.75 }, TRACKS = [-0.3, 5.2], ENDS = [-84, 83.6];

test('the deck\'s piers stand through the station: between its tracks, or on its south platform, clear of the trains', (t) => {
  if (!held()) return t.skip('not held');
  const cahill = LINKS.filter((l) => l && l.name === 'Cahill Expressway' && l.kind === KIND.BRIDGE
    && l.pts.some((p) => Math.abs(toLocal(p.x, p.z).x) < 90 && Math.abs(toLocal(p.x, p.z).z) < 15));
  assert.equal(cahill.length, 2, 'the two carriageways over it');
  const job = buildStructures(new THREE.Group(), new THREE.MeshBasicNodeMaterial(), cahill, LINKS);
  let r = job.next();
  while (!r.done) r = job.next();
  const piers = r.value.colliders.filter((c) => c.maxY > 8 && Math.abs(c.maxX - c.minX - (c.maxZ - c.minZ)) < 1e-6)
    .map((c) => ({ ...toLocal((c.minX + c.maxX) / 2, (c.minZ + c.maxZ) / 2), r: (c.maxX - c.minX) / 2 }))
    .filter((p) => p.x > ENDS[0] && p.x < ENDS[1]);
  assert.ok(piers.length >= 10, `${piers.length} piers through it`);
  for (const p of piers) {
    const between = p.z > EDGES.s && p.z < EDGES.n;
    const where = `the pier at (${p.x.toFixed(1)}, ${p.z.toFixed(2)})`;
    if (between) {
      // a train is 3.05 m wide: half of it, and a little more, from each track's middle
      for (const t0 of TRACKS) assert.ok(Math.abs(p.z - t0) - p.r > 1.6, `${where} is in a train's way`);
    } else {
      assert.ok(p.z < EDGES.s - p.r - 2, `${where} isn't on the south platform, 2 m back from its edge`);
      assert.ok(platforms.some((f) => f.poly[0][0] <= p.x && f.poly[1][0] >= p.x && Math.min(f.poly[0][1], f.poly[2][1]) <= p.z
        && Math.max(f.poly[0][1], f.poly[2][1]) >= p.z), `${where} stands on no platform`);
      // nobody's seat in it
      for (const s of inside.seats) assert.ok(Math.hypot(s.at[0] - p.x, s.at[2] - p.z) > p.r + 0.5, `${where} is in a seat`);
    }
  }
});

test('nothing of the station is in the deck, but its end walls and the Cahill Walk\'s edge, and nothing through its road', async (t) => {
  if (!held()) return t.skip('not held');
  let worst = null;
  for (const tri of triangles(await readModel('circular-quay'))) {
    for (const v of [tri.a, tri.b, tri.c]) {
      const w = toWorldOf(site, v[0], v[2]);
      const y = site.y + v[1];
      // through its road: never
      for (const s of structuresAt(w.x, w.z)) {
        if (STRUCTURES[s.sid]?.kind === KIND.BRIDGE) assert.ok(y < s.y - 0.1, `(${v.map((q) => q.toFixed(1))}) is through the deck's road at ${s.y.toFixed(2)}`);
      }
      // into it over its soffit, half a metre in from its edges (where the Walk's surface reaches under its barrier): only the end walls
      const end = Math.min(...ENDS.map((x) => Math.abs(v[0] - x))) < 0.45;
      for (const s of end ? [] : structuresAt(w.x, w.z, 0.5)) {
        if (STRUCTURES[s.sid]?.kind !== KIND.BRIDGE) continue;
        if (y > s.y - DECK_DEPTH + 0.01 && (!worst || y - (s.y - DECK_DEPTH) > worst.d)) worst = { d: y - (s.y - DECK_DEPTH), v };
      }
    }
  }
  assert.ok(!worst, `(${worst?.v.map((q) => q.toFixed(1))}) is ${worst?.d.toFixed(2)} m into the deck over its soffit`);
});

test('the hall\'s and the concourse\'s floor over the map\'s paving everywhere, so it never shows through', (t) => {
  if (!held()) return t.skip('not held');
  const out = read('circular-quay');
  const floors = [...out.floors, ...inside.floors].filter((f) => f.plane && Math.abs(f.plane[1]) < 1e-6);
  assert.equal(floors.length, 2, 'the hall and the paid concourse');
  let low = Infinity, at = null;
  for (const f of floors) {
    const xs = f.poly.map((p) => p[0]), zs = f.poly.map((p) => p[1]);
    for (let x = Math.min(...xs) + 0.5; x < Math.max(...xs); x += 1) {
      for (let z = Math.min(...zs) + 0.25; z < Math.max(...zs); z += 1) {
        const y = f.plane[0] + f.plane[2] * z;
        const w = toWorldOf(site, x, z);
        const map = groundHeight(w.x, w.z) + (blockAt(w.x, w.z) ? 0.22 : 0) - site.y;
        if (y - map < low) { low = y - map; at = [x, z]; }
      }
    }
  }
  assert.ok(low > 0.05, `the floor is ${low.toFixed(2)} m over the map's paving at (${at})`);
});

test('its escalators carry you up them, at an escalator\'s speed, and each has a stair beside it', () => {
  const slopes = inside.floors.filter((f) => f.plane && Math.abs(f.plane[1]) > 0.3);
  const escalators = slopes.filter((f) => f.flow), stairs = slopes.filter((f) => !f.flow);
  assert.equal(escalators.length, 2, 'one up to each platform');
  assert.equal(stairs.length, 2);
  for (const f of escalators) {
    const [k, g] = [f.plane[1], f.plane[2]];
    const up = (f.flow[0] * k + f.flow[1] * g) / Math.hypot(...f.flow);
    const along = Math.hypot(...f.flow) * Math.hypot(1, Math.hypot(k, g));
    assert.ok(up > 0, 'it carries you up it');
    assert.ok(along > 0.5 && along < 0.8, `${along.toFixed(2)} m/s along its slope`);
    const z = (f.poly[0][1] + f.poly[2][1]) / 2;
    const beside = stairs.find((s) => Math.abs((s.poly[0][1] + s.poly[2][1]) / 2 - z) < 2.0 && Math.abs(s.poly[0][0] - f.poly[0][0]) < 0.01);
    assert.ok(beside, `no stair beside the escalator at z ${z.toFixed(1)}`);
    // from the concourse's floor at its foot to the platform at its head
    const x0 = Math.min(...f.poly.map((p) => p[0])), x1 = Math.max(...f.poly.map((p) => p[0]));
    const foot = f.plane[0] + k * x0 + g * z, head = f.plane[0] + k * x1 + g * z;
    assert.ok(Math.abs(head - 7.5) < 0.01 && foot < 0.05, `from ${foot.toFixed(2)} to ${head.toFixed(2)} m`);
  }
});
