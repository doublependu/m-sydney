const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

// The street a house faces (js/street-front.js): footpathFrom()'s streets, from a tile's own roads
const linkById = new Map();
const { streetFront, streetIndex, tileStreets } = loadModule(readFileSync(join(__dirname, '../js/street-front.js'), 'utf8'), {
  imports: { './surfaces.js': { linkById } }
});
const CLASS = { residential: 7, service: 9, primary: 3 };
const road = (pts, extra = {}) => ({ pts: pts.map(([x, z]) => ({ x, z })), kind: 0, deck: false, motorway: false, cls: CLASS.residential, name: 'A St', ...extra });

test('a house faces the nearest street, not a nearer lane behind it, named or not', () => {
  // The street 14 m south of the house's middle, a named service lane 6 m north
  const street = road([[-50, -14], [50, -14]]), lane = road([[-50, 6], [50, 6]], { cls: CLASS.service, name: 'A Lane' });
  const found = streetFront(streetIndex([lane, street]), 0, 0);
  assert.equal(found.link, street);
  assert.deepEqual([found.x, found.z, found.d], [0, -14, 14]);
  // An unnamed street counts
  const unnamed = road([[-50, 9], [50, 9]], { name: '' });
  assert.equal(streetFront(streetIndex([lane, street, unnamed]), 0, 0).link, unnamed);
});

test('a tunnel, a deck or a motorway is no house\'s street, nor anything past 60 m', () => {
  const near = [road([[-50, 5], [50, 5]], { kind: 2 }), road([[-50, -5], [50, -5]], { deck: true }), road([[-5, -50], [-5, 50]], { motorway: true })];
  assert.equal(streetFront(streetIndex(near), 0, 0), null);
  const far = road([[-100, 61], [100, 61]]);
  assert.equal(streetFront(streetIndex([...near, far]), 0, 0), null);
  assert.equal(streetFront(streetIndex([...near, far]), 0, 0, 70).link, far);
});

test('a corner house faces the nearer of its streets, and the end of a street counts', () => {
  const east = road([[20, -50], [20, 50]]), south = road([[-50, -12], [50, -12]], { cls: CLASS.primary });
  assert.equal(streetFront(streetIndex([east, south]), 0, 0).link, south);
  assert.equal(streetFront(streetIndex([east, south]), 10, 0).link, east);
  // A cul-de-sac ending 8 m west of the house
  const end = streetFront(streetIndex([road([[-100, 0], [-8, 0]])]), 0, 0);
  assert.deepEqual([end.x, end.z, end.d], [-8, 0, 8]);
});

test('a tile\'s streets are its own roads, looked up by id, and worked out once', () => {
  const a = road([[0, 10], [100, 10]]);
  linkById.set(17, a);
  const tile = { links: [[17], [99]] };
  const index = tileStreets(tile);
  assert.equal(tileStreets(tile), index);
  assert.equal(streetFront(index, 50, 0).link, a);
});
