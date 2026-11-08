import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The Opera House (js/opera-house.js): its shells, drawn by the game, and the two models drawn on them (js/model-sites.js, 'opera-house':
// its outside near it, and the Concert Hall with its foyers). These read the committed models' JSON, as the game does.
const { OPERA_HOUSE, archLine, shellHalves, surfaceLookup } = await import('../js/opera-house.js');
const { floorAt, roomAt, standSpot } = await import('../js/interior-data.js');
const { MODEL_SITES } = await import('../js/model-sites.js');

const read = (name) => JSON.parse(fs.readFileSync(new URL(`../public/models/${name}.json`, import.meta.url), 'utf8'));
const site = MODEL_SITES.find((s) => s.id === 'opera-house');
const outside = read('opera-house');
const inside = read('opera-house-ch');
const floors = [...outside.floors, ...inside.floors];
const walls = [...outside.walls, ...inside.walls];
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
// The game's frame to the models': the site stands unturned, its heights the world's
const toModel = ([x, y, z]) => [x - site.x, y, z - site.z];

test('the site stands unturned, with the world\'s heights, so its models are drawn where the game\'s shells are', () => {
  assert.equal(site.yaw, 0);
  assert.equal(site.y, 0);
});

test('each shell\'s two halves meet along its ridge, and two shells back to back along their valley', () => {
  for (const hall of OPERA_HOUSE.halls) {
    for (const shell of hall.shells) {
      const [west, east] = shellHalves(hall, shell);
      for (let k = 0; k <= 10; k++) {
        const a = west.at(k / 10, 0).position, b = east.at(k / 10, 0).position;
        assert.ok(dist(a, b) < 0.01, `${shell.id}: its ridge ${dist(a, b).toFixed(3)} m apart`);
      }
    }
    const pairs = hall.shells.filter((s) => hall.shells.some((o) => o !== s && o.ridge.join() === s.ridge.join() && o.valley.join() === s.valley.join()));
    assert.ok(pairs.length >= 2, `${hall.id}: no two shells back to back`);
    const [p, q] = pairs;
    for (let side = 0; side < 2; side++) {
      const a = shellHalves(hall, p)[side], b = shellHalves(hall, q)[side];
      for (let k = 0; k <= 10; k++) {
        const d = dist(a.at(1, k / 10).position, b.at(1, k / 10).position);
        assert.ok(d < 0.01, `${hall.id}: ${p.id} and ${q.id}'s valley ${d.toFixed(3)} m apart`);
      }
    }
  }
});

test('the models were built on the shells the game draws: their arches haven\'t moved since', () => {
  for (const hall of OPERA_HOUSE.halls) {
    for (const shell of hall.shells) {
      const line = archLine(hall, shell);
      const built = outside.builtOn[shell.id];
      assert.ok(built, `${shell.id}: not in the model`);
      [0, line.length >> 1, line.length - 1].forEach((k, i) => {
        const d = dist(toModel(line[k]), built[i]);
        assert.ok(d < 0.05, `${shell.id}'s arch is ${d.toFixed(2)} m from where its model was built: build the models again (README)`);
      });
    }
  }
});

test('there\'s headroom under the shells over every floor of the Concert Hall and its foyers', () => {
  // the shells as the game draws them: each half a grid of 20 by 20 cells
  const shells = surfaceLookup(OPERA_HOUSE.halls.flatMap((hall) => hall.shells.flatMap((shell) => shellHalves(hall, shell).map((half) => {
    const n = 20, positions = [], index = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push(...half.at(i / n, j / n).position);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i; index.push(a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1); }
    return { mesh: { positions, index } };
  }))));
  let looked = 0;
  for (const f of inside.floors) {
    const xs = f.poly.map((p) => p[0]), zs = f.poly.map((p) => p[1]);
    for (let x = Math.min(...xs) + 0.3; x < Math.max(...xs); x += 1.5) {
      for (let z = Math.min(...zs) + 0.3; z < Math.max(...zs); z += 1.5) {
        const y = floorAt([f], x, z, 100);
        if (y === null) continue;
        looked++;
        const over = shells.heightsAt(x + site.x, z + site.z).filter((h) => h > y - 0.4);
        assert.ok(over.length && Math.min(...over) > y + 2.2, `only ${over.length ? (Math.min(...over) - y).toFixed(2) : 'no'} m over the floor at (${x.toFixed(1)}, ${y}, ${z.toFixed(1)})`);
      }
    }
  }
  assert.ok(looked > 500, `only ${looked} points looked at`);
});

test('the hall\'s seats: one drawn for each, standing on its row\'s floor, with somewhere to stand up beside it', () => {
  const drawn = inside.instances.find((i) => i.node === 'seat').at;
  const seats = inside.seats.filter((s) => s.kind === 'seat' || s.kind === 'box');
  assert.equal(drawn.length, seats.length);
  assert.ok(seats.length > 1500, `only ${seats.length} seats`);
  for (const [x, y, z] of drawn) {
    const under = floorAt(floors, x, z, y + 0.1);
    assert.ok(Math.abs(under - y) < 0.06, `a seat at (${x}, ${z}) stands ${(y - under).toFixed(2)} m over its floor`);
  }
  // every tenth seat, and every one of the rest
  for (const [i, s] of inside.seats.entries()) {
    if (s.kind === 'seat' && i % 10) continue;
    const spot = standSpot(walls, inside.rooms, s);
    assert.ok(spot, `nowhere to stand by the ${s.kind} at (${s.at.join(', ')})`);
    assert.equal(roomAt(inside.rooms, spot.x, s.at[1] - 0.4, spot.z)?.id, s.room);
  }
});

test('the way in: the south doors lead to the Concert Hall, which is fetched only then; and its rooms open into each other', () => {
  const doors = outside.doors.filter((d) => d.inside);
  assert.ok(doors.length >= 1);
  for (const d of doors) assert.equal(d.inside, 'opera-house-ch');
  const ids = new Set(inside.rooms.map((r) => r.id));
  for (const id of ['south-foyer', 'landing', 'hall', 'north-foyer']) assert.ok(ids.has(id), id);
  // every room linked to the outside through the others
  const reach = new Set(['out']);
  for (let k = 0; k < 6; k++) for (const l of inside.links) if (reach.has(l.a) || reach.has(l.b)) { reach.add(l.a); reach.add(l.b); }
  for (const id of ids) assert.ok(reach.has(id), `${id} isn't linked to the way in`);
  // the hall shuts out the sky, its foyers under the glass less
  assert.ok(inside.rooms.find((r) => r.id === 'hall').shelter >= 0.95);
  assert.ok(inside.rooms.find((r) => r.id === 'north-foyer').shelter < 0.5);
});
