// Naala Badu (js/model-sites.js `art-gallery-new`) on the land bridge over the motorway (tools/local/art-gallery.json's `cover`): the
// Cowper Wharf Rd off-ramp runs in its tube under the building's floors. A model's floor is the ground where it is (js/surfaces.js
// modelFloor()), never a road's structure: a car in the tube stays on its road under them, and a walker on the land bridge stands on
// them, over the tube's ceiling. On tiles from before the cover the off-ramp is an open trench there, and these skip.
import { isHeld, tileKeyAt } from '../js/geodata.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { KIND, LINKS, ROOM, STRUCTURES, TUNNEL_HEIGHT, chooseSurface, clearFloor, edgeHeight, floorFlow, groundHeight, moveOver, onFloor, setFloor,
  structuresAt, surfaceHeight, tunnelCovered } = await import('../js/surfaces.js');
const { wheelContacts } = await import('../js/ground-geometry.js');
const { MODEL_SITES } = await import('../js/model-sites.js');
const { floorAt, floorUnder, toLocal, toWorld } = await import('../js/interior-data.js');

const site = MODEL_SITES.find((s) => s.id === 'art-gallery-new');
const read = (name) => JSON.parse(fs.readFileSync(new URL(`../public/models/${name}.json`, import.meta.url), 'utf8'));
// Every floor the site can have at once: its outside's, and each inside file's, as js/interiors.js joins them once they're fetched
function allFloors() {
  const out = read(site.file.split('/').pop());
  const floors = [...out.floors], seen = new Set(), todo = out.doors.map((d) => d.inside).filter(Boolean);
  while (todo.length) {
    const file = todo.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const data = read(file);
    floors.push(...data.floors);
    todo.push(...data.doors.map((d) => d.inside).filter(Boolean), ...(data.then ?? []));
  }
  return floors;
}
// The site's floors handed to js/surfaces.js as js/interiors.js placeFloors() hands them, for someone whose feet are at `ref`
function placeFloors(ref) {
  const floors = allFloors(), pts = floors.flatMap((f) => f.poly).map(([x, z]) => toWorld(site, x, z));
  const c = Math.cos(site.yaw), s = Math.sin(site.yaw);
  setFloor(site.id, {
    minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
    minZ: Math.min(...pts.map((p) => p.z)), maxZ: Math.max(...pts.map((p) => p.z)),
    at(x, z) {
      const p = toLocal(site, x, z), y = floorAt(floors, p.x, p.z, ref - site.y);
      return y === null ? null : y + site.y;
    },
    flow(x, z) {
      const p = toLocal(site, x, z), f = floorUnder(floors, p.x, p.z, ref - site.y)?.floor.flow;
      return f ? { x: f[0] * c + f[1] * s, z: -f[0] * s + f[1] * c } : null;
    }
  });
}

const passes = (l, x, z, r) => l.pts.some((a, i) => {
  const b = l.pts[i + 1];
  if (!b) return false;
  const dx = b.x - a.x, dz = b.z - a.z, t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(a.x + dx * t - x, a.z + dz * t - z) < r;
});
const offRamp = () => LINKS.find((l) => l.kind === KIND.TUNNEL && l.name === 'Cowper Wharf Road Offramp' && passes(l, 934, -726, 3));
// Points along a link every `step` m, `off` m to its left: { s, x, z, y (its road there), heading }
function along(l, step, off = 0) {
  const out = [];
  let acc = 0, next = 0;
  for (let i = 1; i < l.pts.length; i++) {
    const a = l.pts[i - 1], b = l.pts[i], L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 1e-6) continue;
    const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
    for (; next < acc + L; next += step) {
      const d = next - acc;
      out.push({ s: next, x: a.x + ux * d - uz * off, z: a.z + uz * d + ux * off, y: a.y + ((b.y - a.y) * d) / L, heading: Math.atan2(ux, uz) });
    }
    acc += L;
  }
  return out;
}
const skipWhy = () => {
  if (!isHeld(tileKeyAt(946, -720))) return 'the Domain isn\'t held';
  const ramp = offRamp();
  if (!ramp) return 'no Cowper Wharf Rd off-ramp under the Domain';
  // Tiles from before the cover have it open 90 m from its east end, a trench through Naala Badu's outline
  return ramp.openB > 50 ? 'the tiles are from before tools/local/art-gallery.json' : null;
};

test('a car in the Cowper Wharf Rd off-ramp\'s tube under Naala Badu\'s floors stays on its road, at its height', (t) => {
  const why = skipWhy();
  if (why) return t.skip(why);
  const ramp = offRamp(), sid = ramp.sid;
  assert.equal(STRUCTURES[sid].kind, KIND.TUNNEL);
  // with the walker's feet on the land bridge (the site's floor), and down at the road's height, so the lowest floor there is taken
  for (const ref of [site.y, ramp.pts.at(-1).y]) {
    placeFloors(ref);
    try {
      const lane = Math.max(0, ramp.width / 2 - 1.5);
      let under = 0;
      for (const off of [-lane, 0, lane]) {
        const pts = along(ramp, 0.5, off).filter((p) => p.s > ramp.openA + 2 && p.s < ramp.length - 3);
        let here = { x: pts[0].x, z: pts[0].z, sid, y: surfaceHeight(sid, pts[0].x, pts[0].z) };
        for (const p of pts) {
          // driven a step at a time, as the player's car is (js/controllers.js resolveHorizontalCollision())
          here = moveOver(here.sid, here.y, here.x, here.z, p.x, p.z, 1.0, ROOM.car, { heading: p.heading, length: 2.2 });
          const at = `${p.s.toFixed(1)} m along, ${off.toFixed(1)} m off its line, (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`;
          assert.equal(here.sid, sid, `the car left the off-ramp's tube ${at}, onto ${here.sid} at ${here.y.toFixed(2)}`);
          assert.ok(Math.abs(here.y - p.y) < 0.05, `the car at ${here.y.toFixed(2)} on a road at ${p.y.toFixed(2)}, ${at}`);
          assert.ok(Math.hypot(here.x - p.x, here.z - p.z) < 0.01, `the car held back ${at}`);
          if (!onFloor(p.x, p.z)) continue;
          under++;
          // what a car on the road asks there: its structure's height, the traffic's lane's, its wheels'
          assert.ok(Math.abs(surfaceHeight(sid, p.x, p.z, here.y) - p.y) < 0.05, `surfaceHeight() ${at}`);
          assert.ok(Math.abs(edgeHeight({ link: ramp.id, sid }, p.x, p.z) - p.y) < 0.05, `edgeHeight() ${at}`);
          const wheels = wheelContacts(p.x, p.z, p.heading, sid, here.y);
          assert.ok(Math.abs(wheels.y - p.y) < 0.08 && wheels.contacts.every((c) => Math.abs(c.y - p.y) < 0.15), `the wheels at ${wheels.y.toFixed(2)} ${at}`);
          assert.equal(chooseSurface(sid, p.y, p.x, p.z, 1.0, ROOM.car)?.sid, sid, `chooseSurface() ${at}`);
          // ...and the ground there is the model's floor over the tube, nothing that carries a car along
          assert.ok(groundHeight(p.x, p.z) > p.y + TUNNEL_HEIGHT + 0.3, `the floor ${(groundHeight(p.x, p.z) - p.y - TUNNEL_HEIGHT).toFixed(2)} m over the tube's ceiling ${at}`);
          assert.equal(floorFlow(p.x, p.z), null, `a floor that moves over the tube ${at}`);
        }
      }
      assert.ok(under >= 40, `${under} of the car's steps under the model's floors`);
    } finally {
      clearFloor(site.id);
    }
  }
});

test('a walker on Naala Badu\'s floors over the off-ramp\'s tube stays on them: the ground, not the road under it', (t) => {
  const why = skipWhy();
  if (why) return t.skip(why);
  const ramp = offRamp();
  placeFloors(site.y);
  try {
    let on = 0;
    for (const off of [-ramp.width / 2, 0, ramp.width / 2]) {
      for (const p of along(ramp, 1, off)) {
        if (p.s < ramp.openA + 2 || p.s > ramp.length - 3 || !onFloor(p.x, p.z) || !tunnelCovered(ramp, p.s)) continue;
        on++;
        const at = `${p.s.toFixed(1)} m along, ${off.toFixed(1)} m off its line, (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`;
        const g = groundHeight(p.x, p.z);
        const c = chooseSurface(0, g, p.x, p.z, 0.29, ROOM.foot);
        assert.ok(c && !c.sid && Math.abs(c.y - g) < 1e-6, `the walker on the floor at ${g.toFixed(2)} put on ${c?.sid} at ${c?.y.toFixed(2)}, ${at}`);
        // nothing of the tunnel's road within a step of the floor: a walker can't step down into the tube through it
        for (const st of structuresAt(p.x, p.z)) {
          if (STRUCTURES[st.sid]?.kind === KIND.TUNNEL) assert.ok(g - st.y > TUNNEL_HEIGHT + 0.3, `a tunnel's road ${(g - st.y).toFixed(2)} m under the floor ${at}`);
        }
      }
    }
    assert.ok(on >= 20, `${on} points of the tube under the model's floors`);
  } finally {
    clearFloor(site.id);
  }
});
