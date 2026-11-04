import assert from 'node:assert/strict';
import test from 'node:test';

// Who lives and works where (js/places.js, from each tile's 100 m grid: tools/tiles/place-grid.mjs), on the tiles the tests hold
const { heldTiles, holdTile, releaseTile } = await import('../js/geodata.js');
const { busyAt, placeAt, placesNear } = await import('../js/places.js');
const { ROAD_CLASS, LINKS } = await import('../js/surfaces.js');

test('every tile has its grid, and the CBD is offices and workers', () => {
  for (const t of heldTiles()) {
    assert.equal(t.place.res.length, 100, t.key);
    assert.equal(t.place.zone.length, 100, t.key);
  }
  const townHall = placesNear(0, 0, 350);
  assert.equal(townHall.known, townHall.cells);
  assert.ok(townHall.jobs > 30000, `${townHall.jobs} workers within 350 m of Town Hall`);
  assert.ok(townHall.jobs > townHall.res * 5);
  assert.equal(busyAt(0, 0), 1, 'as busy as it gets');
  assert.equal(placeAt(50, -150).zone, 'office');
});

test('a street of houses is quiet, and a tile that goes takes its grid with it', async () => {
  // Woollahra, south of Paddington's terraces
  const houses = placesNear(2600, 1400, 350);
  assert.ok(houses.res > houses.jobs, `${houses.res} residents, ${houses.jobs} workers`);
  assert.ok(busyAt(2600, 1400) < busyAt(0, 0) / 2);
  const key = heldTiles()[0].key;
  const [ix, iz] = key.split('_').map(Number);
  releaseTile(key);
  assert.equal(placeAt(ix * 1000 + 50, iz * 1000 + 50), null);
  assert.equal(busyAt(ix * 1000 + 500, iz * 1000 + 500) === null || placesNear(ix * 1000 + 500, iz * 1000 + 500, 100).known === 0, true);
  await holdTile(key);
  assert.notEqual(placeAt(ix * 1000 + 50, iz * 1000 + 50), null);
});

test('roads carry their OSM class', () => {
  const classes = new Set(LINKS.map((l) => l.cls));
  for (const cls of ['primary', 'residential', 'service']) assert.ok(classes.has(ROAD_CLASS[cls]), cls);
  assert.ok(LINKS.filter((l) => l.cls === 0).length < LINKS.length * 0.01, 'nearly every link has one');
});
