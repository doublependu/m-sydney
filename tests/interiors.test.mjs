import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Walking into buildings (js/interiors.js) stands on js/interior-data.js and on the JSON each model comes with. These read the committed
// test interior (public/models/test-interior*.json): a hall with a stair up to a landing, three doors, two arches and some chairs.
const {
  clearOf, doorCollider, doorInReach, doorway, eyeReach, floorAt, leafAt, lineToWalls, roomAt, seatInReach, segmentCollider, standSpot,
  toLocal, toWorld, visibleRooms, wallCollider
} = await import('../js/interior-data.js');
const { MODEL_SITES } = await import('../js/model-sites.js');

const read = (name) => JSON.parse(fs.readFileSync(new URL(`../public/models/${name}.json`, import.meta.url), 'utf8'));
const outside = read('test-interior');
const inside = read('test-interior-in');
const floors = [...outside.floors, ...inside.floors];
const walls = [...outside.walls, ...inside.walls];
const doors = new Map([...outside.doors, ...inside.doors].map((d) => [d.id, d]));
const room = (id) => inside.rooms.find((r) => r.id === id);
const centre = (poly) => [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];
const stair = inside.floors.find((f) => f.plane);

/** The node names in a binary glTF */
function nodeNames(name) {
  const bytes = fs.readFileSync(new URL(`../public/models/${name}.glb`, import.meta.url));
  const length = bytes.readUInt32LE(12);
  return new Set(JSON.parse(bytes.subarray(20, 20 + length).toString('utf8')).nodes.map((n) => n.name));
}

test('every site has its model, and the test house is only for ?debug=1', () => {
  for (const site of MODEL_SITES) {
    for (const ext of ['glb', 'json']) assert.ok(fs.existsSync(new URL(`../public/${site.file}.${ext}`, import.meta.url)), `${site.file}.${ext}`);
  }
  assert.equal(MODEL_SITES.find((s) => s.id === 'test-interior').debug, true);
});

test('the JSON names only nodes its model has: each room, each door', () => {
  const outNodes = nodeNames('test-interior'), inNodes = nodeNames('test-interior-in');
  for (const d of outside.doors) assert.ok(outNodes.has(d.node), d.node);
  for (const d of inside.doors) assert.ok(inNodes.has(d.node), d.node);
  for (const r of inside.rooms) assert.ok(inNodes.has(r.node), r.node);
  // the way in names the inside, and nothing in the outside says more than that
  assert.deepEqual(outside.doors.map((d) => d.inside), ['test-interior-in']);
  assert.ok(!('rooms' in outside) && !('seats' in outside));
});

test('every model\'s JSON names only nodes it has, and every door that leads in names an inside that is there', () => {
  for (const site of MODEL_SITES) {
    const name = site.file.replace('models/', '');
    const out = read(name);
    const nodes = nodeNames(name);
    for (const d of out.doors) {
      assert.ok(nodes.has(d.node), `${name}: ${d.node}`);
      if (d.leaves === 2) assert.ok(nodes.has(`${d.node}_b`), `${name}: ${d.node}_b`);
    }
    for (const file of new Set(out.doors.map((d) => d.inside).filter(Boolean))) {
      const inner = read(file), innerNodes = nodeNames(file);
      for (const d of inner.doors) assert.ok(innerNodes.has(d.node) && (d.leaves !== 2 || innerNodes.has(`${d.node}_b`)), `${file}: ${d.node}`);
      for (const r of inner.rooms) assert.ok(innerNodes.has(r.node) || out.walls.length, `${file}: ${r.node}`);
      // and a floor under the middle of every room, at its level
      const floors = [...out.floors, ...inner.floors];
      for (const r of inner.rooms) {
        const [x, z] = centre(r.poly);
        const y = floorAt(floors, x, z, r.y0);
        assert.ok(y !== null && y >= r.y0 - 0.01, `${file}: no floor under ${r.id}`);
      }
    }
  }
});

test('every room has a floor at its level under its middle', () => {
  for (const r of inside.rooms) {
    const [x, z] = centre(r.poly);
    assert.equal(floorAt(floors, x, z, r.y0), r.y0, r.id);
  }
});

test('the floor upstairs is out of reach downstairs, and the one downstairs is under you upstairs', () => {
  // the landing, over the hall
  const [x, z] = centre(room('hall').poly);
  assert.equal(floorAt(floors, x + 1, z, 0), 0);
  assert.equal(floorAt(floors, x + 1, z, 3.3), 3.3);
  // a step up is taken without a thought, the floor above isn't
  assert.equal(floorAt(floors, x + 1, z, 0.2), 0);
});

test('the stair climbs from the hall to the landing a step at a time, and back down', () => {
  const [bl, , , tl] = stair.poly;
  const x = (stair.poly[0][0] + stair.poly[1][0]) / 2;
  const z0 = bl[1] + 0.6, z1 = tl[1] - 0.8; // from in front of its foot to past its top
  let y = 0;
  const heights = [];
  for (let z = z0; z >= z1; z -= 0.08) {
    const next = floorAt(floors, x, z, y);
    assert.ok(next - y <= 0.45 + 1e-9, `a step of ${(next - y).toFixed(2)} m at z ${z.toFixed(2)}`);
    heights.push((y = next));
  }
  assert.equal(y, 3.3);
  assert.ok(heights.every((h, i) => !i || h >= heights[i - 1] - 1e-9), 'it never went down on the way up');
  for (let z = z1; z <= z0; z += 0.08) y = floorAt(floors, x, z, y);
  assert.equal(y, 0);
});

test('a wall upstairs is over your head downstairs', () => {
  const site = { x: 100, z: 200, y: 30, yaw: 0.4 };
  const upstairs = inside.walls.find((w) => w.y0 > 3);
  const c = wallCollider(site, upstairs);
  assert.equal(c.level, true);
  assert.equal(c.minY, 30 + upstairs.y0);
  assert.equal(c.maxY, 30 + upstairs.y1);
  // the collider's box holds its wall's ends, in the world
  for (const p of [upstairs.a, upstairs.b]) {
    const w = toWorld(site, p[0], p[1]);
    assert.ok(w.x >= c.minX - 1e-9 && w.x <= c.maxX + 1e-9 && w.z >= c.minZ - 1e-9 && w.z <= c.maxZ + 1e-9);
  }
  const back = toLocal(site, ...Object.values(toWorld(site, 3, -2)));
  assert.ok(Math.abs(back.x - 3) < 1e-9 && Math.abs(back.z + 2) < 1e-9);
  const shut = doorCollider(site, doors.get('front'));
  assert.ok(shut.maxY - shut.minY > 2);
  assert.deepEqual(segmentCollider(site, [0, 0], [1, 0], 0.2, 0, 1).polygon.outer.length, 4);
});

test('a shut door fills its doorway through the wall, flush with both its faces, so nothing catches in it', () => {
  for (const site of MODEL_SITES) {
    const name = site.file.replace('models/', '');
    const out = read(name);
    const insides = [...new Set(out.doors.map((d) => d.inside).filter(Boolean))].map(read);
    const walls = [...out.walls, ...insides.flatMap((i) => i.walls)];
    for (const d of [...out.doors, ...insides.flatMap((i) => i.doors)]) {
      const box = doorway(d, walls);
      assert.ok(box, `${name}: no wall found for door ${d.id}`);
      // as thick as the wall beside it, and on its line: a jamb wall ends where the box does
      const jamb = walls.find((w) => w.t === box.t && [w.a, w.b].some((p) => Math.hypot(p[0] - box.a[0], p[1] - box.a[1]) < 0.02 || Math.hypot(p[0] - box.b[0], p[1] - box.b[1]) < 0.02));
      assert.ok(jamb, `${name}: door ${d.id}'s box isn't on its wall's line`);
      // the leaf, shut, inside the box
      const w = Math.hypot(d.latch[0] - d.hinge[0], d.latch[1] - d.hinge[1]);
      assert.ok(Math.abs(Math.hypot(box.b[0] - box.a[0], box.b[1] - box.a[1]) - w) < 1e-9);
    }
  }
  // the test house's front door: 0.15 m in from the middle of a 0.4 m wall, filled across all of it
  const front = doorway(doors.get('front'), walls);
  assert.ok(front.t > 0.3 && Math.abs(front.a[1] - 4) < 1e-9, JSON.stringify(front));
});

test('each door swings into its room, clear of every wall but those beside it', () => {
  for (const d of doors.values()) {
    const open = leafAt(d, Math.abs(d.turn) * Math.sign(d.turn));
    const shut = leafAt(d, 0);
    assert.deepEqual(shut.latch.map((v) => +v.toFixed(6)), d.latch.map((v) => +v.toFixed(6)), d.id);
    // swung open, the leaf's far end is in the room it opens into: not the outside, not back through the wall
    const into = roomAt(inside.rooms, open.latch[0], d.y0 + 0.1, open.latch[1]);
    assert.ok(into && d.rooms.includes(into.id), `${d.id} opens into ${into?.id}`);
    for (const w of walls) {
      if (w.y1 <= d.y0 + 0.1 || w.y0 >= d.y1) continue;
      for (let k = 1; k <= 8; k++) {
        const leaf = leafAt(d, (d.turn * k) / 8);
        assert.ok(clearOf([w], leaf.latch[0], leaf.latch[1], d.y0, -0.005), `${d.id} swings into a wall at ${leaf.latch.map((v) => v.toFixed(2))}`);
      }
    }
  }
});

test('only the rooms you can see are drawn: through open doorways, two rooms deep', () => {
  const shut = () => false;
  const fromHall = visibleRooms(inside.links, 'hall', shut);
  // through its arch, up its stair, and through the arches beyond those, but not through a shut door
  assert.deepEqual([...fromHall].sort(), ['dining', 'hall', 'landing', 'living', 'study']);
  assert.ok(!visibleRooms(inside.links, 'landing', shut).has('bedroom'));
  assert.ok(visibleRooms(inside.links, 'landing', (id) => id === 'bedroom').has('bedroom'));
  assert.ok(!visibleRooms(inside.links, 'hall', shut, 1).has('living'), 'two rooms deep, at one deep');
  // from outside, with the front door shut, none of it
  assert.deepEqual([...visibleRooms(inside.links, 'out', shut)], ['out']);
  assert.ok(visibleRooms(inside.links, 'out', (id) => id === 'front').has('hall'));
});

test('the camera stays a ball\'s width short of the walls, and of a wall it starts near, comes no nearer', () => {
  // at the back of the hall, past the foot of the stair
  const x = -3, z = -3;
  assert.equal(lineToWalls(walls, x, z, x + 0.5, z + 1, 1.5, 2.1), 1, 'across the hall, something in the way');
  // out through the west wall: stopped 0.25 m short of its face, 1.8 m along
  const t = lineToWalls(walls, x, z, x - 4, z, 1.5, 2.1);
  assert.ok(Math.abs(t - 0.3875) < 0.01, `t ${t}`);
  // the stair's balustrade holds it too
  assert.ok(lineToWalls(walls, -3, 0, -6, 0, 1.5, 2.1) < 0.25);
  // a wall that stops at 1 m doesn't hold a camera over it
  const low = [{ a: [0, -1], b: [0, 1], t: 0.2, y0: 0, y1: 1 }];
  assert.equal(lineToWalls(low, -1, 0, 1, 0, 1.5, 2.1), 1);
  // 0.15 m from a wall's face: along it, or away from it, it isn't held; into it, it is, at once
  const wall = [{ a: [0, 0], b: [10, 0], t: 0.2, y0: 0, y1: 3 }];
  assert.equal(lineToWalls(wall, 5, 0.25, 8, 0.25, 1.5, 2.1), 1);
  assert.equal(lineToWalls(wall, 5, 0.25, 5, 2, 1.5, 2.1), 1);
  assert.ok(lineToWalls(wall, 5, 0.25, 5, -1, 1.5, 2.1) < 0.01);
});

test('the camera comes no nearer a ceiling or a floor than it can see from, and not under a stair', () => {
  // up behind you in the hall: lowered to 0.7 m under the landing's floor
  const up = eyeReach(walls, floors, { x: -3, y: 1.8, z: -3 }, { x: -3, y: 3.5, z: -1.5 });
  assert.equal(up.t, 1);
  assert.ok(Math.abs(up.y - 2.6) < 1e-9, `y ${up.y}`);
  // back towards the stair from the middle of the hall: its balustrade keeps it out from under it
  const under = eyeReach(walls, floors, { x: -3, y: 1.8, z: 0 }, { x: -4.6, y: 1.9, z: 0 });
  assert.ok(-3 + (-4.6 + 3) * under.t > -3.85, `t ${under.t}`);
  // half way up a stair, just past the edge of the floor over its foot (55's): back down it, ducking under that floor
  const flight = [
    { poly: [[0.5, -0.175], [0.5, 0.775], [-4.6, 0.775], [-4.6, -0.175]], plane: [0.38235, -0.76471, 0], holes: [] },
    { poly: [[-5.6, -1.19], [3.3, -1.19], [3.3, 0.88], [-5.6, 0.88]], y: 3.9, holes: [[[-1.591, -0.175], [-1.591, 0.775], [-4.6, 0.775], [-4.6, -0.175]]] }
  ];
  const stairUp = eyeReach([], flight, { x: -1.73, y: 3.51, z: 0.32 }, { x: 0.77, y: 3.85, z: 0.32 }, 6.9);
  assert.equal(stairUp.t, 1);
  assert.ok(Math.abs(stairUp.y - 3.2) < 1e-9, `y ${stairUp.y}`);
  // ...but not when your head's up in that floor: the line to it would go through its edge
  assert.ok(eyeReach([], flight, { x: -1.73, y: 3.8, z: 0.32 }, { x: 0.77, y: 3.85, z: 0.32 }, 6.9).t < 0.1);
  // on the landing, down towards the hall: not through the floor
  const down = eyeReach(walls, floors, { x: -2, y: 5.1, z: -3 }, { x: -2, y: 2.4, z: -1 });
  assert.ok(5.1 + (2.4 - 5.1) * down.t >= 3.3 + 0.25 - 1e-9, `t ${down.t}`);
  // out of the front doorway behind you: held by the shut door, and through it once it's open
  const front = doors.get('front');
  const from = { x: -3, y: 1.8, z: 2.5 }, to = { x: -3, y: 1.9, z: 6.5 };
  const shut = eyeReach([...walls, { a: front.hinge, b: front.latch, t: 0.06, y0: front.y0, y1: front.y1 }], floors, from, to);
  assert.ok(shut.t < 0.3, `shut ${shut.t}`);
  const leaf = leafAt(front, front.turn);
  const open = eyeReach([...walls, { a: leaf.hinge, b: leaf.latch, t: 0.06, y0: front.y0, y1: front.y1 }], floors, from, to);
  assert.equal(open.t, 1);
});

test('a door is offered within reach, in front of you, and a seat at its height', () => {
  const front = doors.get('front');
  const cx = (front.hinge[0] + front.latch[0]) / 2, cz = (front.hinge[1] + front.latch[1]) / 2;
  const list = [...doors.values()];
  // the house's front faces +z: coming up to it, you face -z (heading pi)
  assert.equal(doorInReach(list, cx, cz + 1.1, Math.PI)?.door.id, 'front');
  assert.equal(doorInReach(list, cx, cz + 2.2, Math.PI), null);
  assert.equal(doorInReach(list, cx, cz + 1.1, 0), null, 'offered with your back to it');
  assert.equal(doorInReach(list, cx, cz + 1.1, 0, { x: 0, z: -1 })?.door.id, 'front', 'not offered looking at it');
  const chair = inside.seats.find((s) => s.room === 'study');
  assert.ok(seatInReach(inside.seats, chair.at[0], 3.3, chair.at[2] + 0.8));
  assert.notEqual(seatInReach(inside.seats, chair.at[0], 0, chair.at[2] + 0.8)?.seat.room, 'study', 'a chair upstairs offered from downstairs');
});

test('somewhere to stand up next to every seat', () => {
  for (const s of inside.seats) {
    const spot = standSpot(walls, inside.rooms, s);
    assert.ok(spot, `nowhere to stand by the ${s.kind} in ${s.room}`);
    assert.equal(roomAt(inside.rooms, spot.x, s.at[1] - 0.4, spot.z)?.id, s.room, `standing up from the ${s.kind} in ${s.room} takes you out of it`);
  }
});
