import assert from 'node:assert/strict';
import test from 'node:test';

// A building's door to its address street (js/building-door.js) and the floor the build puts at the ground there (js/building-floor.js
// doorFloor(), tools/tiles/derive.mjs), against where the game draws it: its front wall (js/building-footprints.js `frontWall`) and the
// door on it (js/house-entry.js).
globalThis.fetch = async (url) => new Response((await import('node:fs')).readFileSync(new URL(url)));
const { DOOR_KEEP, MAX_CUT, buildingFloor, doorFloor } = await import('../js/building-floor.js');
const { doorOf, houseDigits } = await import('../js/building-door.js');
const { outerWalls } = await import('../js/addresses.js');
const { houseEntry, oneHouse } = await import('../js/house-entry.js');
const { HOUSE_STYLES } = await import('../js/house-styles.js');
const { buildingLook } = await import('../js/building-look.js');
const { createBuildingFootprints } = await import('../js/building-footprints.js');
const { heldTiles, isHeld } = await import('../js/geodata.js');
const { groundHeight } = await import('../js/surfaces.js');

test('a house uphill of its street has its floor at its door; one below its street, or with its door near the ground, keeps the highest ground\'s', () => {
  // Uphill of its street: the door's side the lowest
  assert.equal(doorFloor(12, 10.5), 10.5);
  // Below its street: the door on the high side already
  assert.equal(doorFloor(12, 12), 12);
  assert.equal(doorFloor(12, 12.4), 12);
  // A door within DOOR_KEEP of the ground keeps today's floor: one step
  assert.equal(DOOR_KEEP, 0.3);
  assert.equal(doorFloor(12, 11.75), 12);
  assert.equal(doorFloor(12, 11.6), 11.6);
});

test('a floor is never cut more than MAX_CUT into the slope', () => {
  assert.equal(MAX_CUT, 3);
  assert.equal(doorFloor(12, 7), 9);
  assert.equal(doorFloor(12, 9), 9);
  const square = [{ x: 0, z: 0 }, { x: 20, z: 0 }, { x: 20, z: 20 }, { x: 0, z: 20 }];
  const { floor } = buildingFloor([{ outer: square, holes: [] }], (x, z) => z * 0.4);
  assert.equal(doorFloor(floor, 0), floor - MAX_CUT);
});

test('a house\'s door is where its facade draws it on the wall its address gives; a shop\'s, the entrance nearest its address', () => {
  const style = HOUSE_STYLES.findIndex((s) => s?.look && !s.look.terrace);
  const polygons = [{ outer: [{ x: 0, z: 0 }, { x: 12, z: 0 }, { x: 12, z: 9 }, { x: 0, z: 9 }], holes: [] }];
  const walls = outerWalls(polygons);
  const south = walls.findIndex((w) => (w.b.x - w.a.x) / w.width < -0.99);
  const house = { polygons, houseStyle: style, address: [{ x: 6, z: -8, wall: south, number: '7' }] };
  const door = doorOf(house, 4321);
  const entry = houseEntry(door.front, style);
  assert.deepEqual([door.x, door.z], [entry.door.x, entry.door.z]);
  assert.ok(Math.abs(door.z) < 1e-9 && door.x > 0 && door.x < 12, `on its south wall: ${door.x}, ${door.z}`);
  assert.equal(door.front.digits, houseDigits(4321));
  assert.equal(houseDigits(-4321), 679);
  // No wall to its street: none
  assert.equal(doorOf({ ...house, address: [{ ...house.address[0], wall: -1 }] }, 1), null);
  assert.equal(doorOf({ ...house, address: null }, 1), null);
  // A shop 70 m along its street, its address 50 m along it: of its three entrances (at 11.7, 35 and 58.3 m), the last
  const long = [{ outer: [{ x: 0, z: 0 }, { x: 70, z: 0 }, { x: 70, z: 15 }, { x: 0, z: 15 }], holes: [] }];
  const front = outerWalls(long).findIndex((w) => (w.b.x - w.a.x) / w.width < -0.99);
  const shop = doorOf({ polygons: long, houseStyle: 0, address: [{ x: 35, z: -8, wall: front, at: { x: 50, z: -2 } }] }, 1);
  assert.ok(Math.abs(shop.x - 70 * 5 / 6) < 1e-9 && Math.abs(shop.z) < 1e-9, `${shop.x}, ${shop.z}`);
});

test('a terrace of one number is one house on a front the facade would draw as two at most; a range, or a longer front, is a row', () => {
  assert.equal(oneHouse([{ number: '43' }], 10), true);
  assert.equal(oneHouse([{ number: '399A' }], 13.7), true);
  assert.equal(oneHouse([{ number: '43' }], 13.75), false);
  assert.equal(oneHouse([{ number: '1-3' }], 10), false);
  assert.equal(oneHouse([{ number: null }], 10), false);
  assert.equal(oneHouse(null, 10), false);
  // As the build's records have it (js/addresses.js parseNumber())
  assert.equal(oneHouse([{ number: { n: 43, letter: 0, to: 0, toLetter: 0 } }], 10), true);
  assert.equal(oneHouse([{ number: { n: 43, letter: 0, to: 45, toLetter: 0 } }], 10), false);
});

// On tiles that have addresses: every house of a tile, its door as the build finds it and as the game draws its front
const KEY = '0_1';
const tile = heldTiles().find((t) => t.key === KEY);
const addressed = tile?.buildings.some((b) => b.address);
test(`the game's front and the build's door agree for every house in tile ${KEY}, and its floor is at its door`, { skip: (!tile && `tile ${KEY} isn't held`) || (!addressed && 'the tiles have no addresses yet') }, () => {
  const wholes = new Map();
  for (const b of tile.buildings) {
    if (!b.group) continue;
    const w = wholes.get(b.group);
    if (!w) wholes.set(b.group, { cx: b.cx, cz: b.cz, height: b.height, floor: b.floor, pieces: [b] });
    else { w.height = Math.max(w.height, b.height); w.pieces.push(b); if (!b.bottom) { w.cx = b.cx; w.cz = b.cz; } }
  }
  let houses = 0, atDoor = 0, cut = 0, kept = 0;
  for (const b of tile.buildings) {
    if (!HOUSE_STYLES[b.houseStyle || 0]?.look || !b.address || b.address[0].wall < 0) continue;
    const whole = b.group ? wholes.get(b.group) : b;
    const { seed } = buildingLook(b, whole);
    // As js/buildings.js gives it to its walls
    const item = { ...b, house: b.houseStyle, front: { x: b.address[0].x, z: b.address[0].z }, seed, base: whole.floor };
    createBuildingFootprints({}, [item]);
    const door = doorOf(b, seed);
    assert.deepEqual(item.frontWall, door.front, `the house at (${b.cx}, ${b.cz})`);
    const entry = houseEntry(item.frontWall, b.houseStyle);
    assert.deepEqual([entry.door.x, entry.door.z], [door.x, door.z]);
    houses++;
    if (b.group) continue;
    // Its floor, in the tiles' 0.1 m: at the ground at its door, or as before
    const { floor: highest } = buildingFloor(b.polygons, groundHeight);
    const want = Math.ceil(doorFloor(highest, groundHeight(door.x, door.z)) * 10) / 10;
    if (Math.abs(b.floor - want) > 0.11) continue; // raised over a road under it (tools/tiles/derive.mjs)
    atDoor++;
    if (want < highest - 0.15) cut++;
    else kept++;
  }
  assert.ok(houses > 500, `${houses} houses with an address in ${KEY}`);
  assert.ok(atDoor > houses * 0.98, `${atDoor} of ${houses} on the floor at their door`);
  assert.ok(cut > 50 && kept > 50, `${cut} cut into the slope, ${kept} kept`);
});
