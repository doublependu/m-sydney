import assert from 'node:assert/strict';
import test from 'node:test';

// Which tiles to have (js/tiles/tile-manager.js)
const { KEEP_MARGIN, LOOK_AHEAD, distanceToTile, planTiles } = await import('../js/tiles/tile-manager.js');

const everywhere = () => true;
const plan = (over) => planTiles({ x: 500, z: 500, range: 1000, built: new Set(), exists: everywhere, ...over });

test('a point inside a tile is no distance from it', () => {
  assert.equal(distanceToTile(0, 0, 500, 500), 0);
  assert.equal(distanceToTile(1, 0, 500, 500), 500);
  assert.ok(Math.abs(distanceToTile(1, 1, 500, 500) - Math.hypot(500, 500)) < 1e-9);
});

test('at rest, it wants the tiles in range, nearest first', () => {
  const { load, drop } = plan();
  assert.equal(load[0], '0_0');
  assert.deepEqual(drop, []);
  assert.ok(load.includes('1_0') && load.includes('-1_0') && load.includes('0_1') && load.includes('1_1'));
  assert.ok(!load.includes('2_0'), 'a tile 1.5 km away is out of a 1 km range');
});

test('only tiles there are', () => {
  const { load } = plan({ exists: (key) => key === '1_0' });
  assert.deepEqual(load, ['1_0']);
});

test('what is built is not asked for again', () => {
  const { load } = plan({ built: new Set(['0_0', '1_0']) });
  assert.ok(!load.includes('0_0') && !load.includes('1_0'));
});

test('moving fast, it reaches ahead', () => {
  const speed = 36;
  const reach = speed * LOOK_AHEAD;
  const atRest = plan({ range: 500 }).load;
  const moving = plan({ range: 500, vx: speed }).load;
  assert.ok(!atRest.includes('2_0'));
  assert.ok(reach > 100 && moving.includes('1_0'));
  // The tile it's heading for comes before the one behind it
  assert.ok(moving.indexOf('1_0') < moving.indexOf('-1_0') || moving.indexOf('-1_0') === -1);
});

test('a tile is kept until well past the range, so nothing flickers on the line', () => {
  const built = new Set(['2_0']);
  const away = 1500; // from (500, 500) to the near edge of tile 2_0... 2000 - 500
  assert.equal(distanceToTile(2, 0, 500, 500), away);
  assert.deepEqual(plan({ built, range: 1000 + (away - 1000 - KEEP_MARGIN) }).drop, []);
  assert.deepEqual(plan({ built, range: 1000 - 100 }).drop, ['2_0']);
});

test('heading back towards a tile keeps it', () => {
  const built = new Set(['3_0']);
  const still = plan({ built, range: 500 }).drop;
  const coming = plan({ built, range: 500, vx: 400 }).drop;
  assert.deepEqual(still, ['3_0']);
  assert.deepEqual(coming, []);
});
