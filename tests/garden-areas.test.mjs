import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { gateHeading, parkKind, pathKind, woodShare, woodsOf } from '../tools/garden-areas.mjs';

// What tools/build-garden.mjs decides for a garden's gates, its parks and its paths (tools/garden-areas.mjs)

const angle = (a, b) => Math.abs(((a - b + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);

test('a gate where three paths meet faces along the two most nearly in line, which way the first of them runs', () => {
  // A promenade along the water comes from the east (its way ends at the gate) and goes on north-north-west (another way, also ending at
  // the gate); a third path leaves west. The gate stands across the promenade, not across the path west
  const at = [0, 0];
  const promenade = { pt: [10, 7], after: false }, onward = { pt: [-4, -12], after: false }, west = { pt: [-9, 1], after: true };
  const through = gateHeading(at, [promenade, west, onward]);
  assert.deepEqual(through.used, [0, 2]);
  // From the promenade's point, the way its way runs, to the onward path's
  assert.ok(angle(through.heading, Math.atan2(-4 - 10, -12 - 7)) < 1e-9, `heading ${through.heading}`);
  // Found in another order, the same line
  const other = gateHeading(at, [west, onward, promenade]);
  assert.ok(angle(other.heading, through.heading) < 1e-9 || angle(other.heading, through.heading + Math.PI) < 1e-9);
});

test('a gate on one path faces along it, as it always did; at a path\'s end, along its last segment', () => {
  const at = [0, 0];
  // The way runs from (0, -5) through the gate to (1, 5)
  assert.ok(angle(gateHeading(at, [{ pt: [0, -5], after: false }, { pt: [1, 5], after: true }]).heading, Math.atan2(1, 10)) < 1e-9);
  // A way ending at the gate, coming from the south; one starting at it, going east
  assert.ok(angle(gateHeading(at, [{ pt: [0, 5], after: false }]).heading, Math.atan2(0, -5)) < 1e-9);
  assert.ok(angle(gateHeading(at, [{ pt: [5, 0], after: true }]).heading, Math.atan2(5, 0)) < 1e-9);
  assert.equal(gateHeading(at, []), null);
});

test('a park\'s kind by rule: nature reserves, protected areas and parks half wood are bush; the rest formal', () => {
  assert.equal(parkKind({ leisure: 'nature_reserve' }), 'bush');
  assert.equal(parkKind({ leisure: 'park', boundary: 'protected_area' }), 'bush');
  assert.equal(parkKind({ boundary: 'national_park' }), 'bush');
  assert.equal(parkKind({ leisure: 'park' }, 0.5), 'bush');
  assert.equal(parkKind({ leisure: 'park' }, 0.49), 'formal');
  assert.equal(parkKind({ leisure: 'garden' }), 'formal');
  // A park another boundary runs round (Sydney Park's is a hazard) goes by its wood
  assert.equal(parkKind({ leisure: 'park', boundary: 'hazard' }, 0.21), 'formal');
  // How much of a square is wood: half of it, by a wood on its west half
  const square = [[[0, 0], [100, 0], [100, 100], [0, 100]]];
  const wood = [{ ring: [[-10, -10], [50, -10], [50, 110], [-10, 110]], box: { x0: -10, x1: 50, z0: -10, z1: 110 } }];
  assert.ok(Math.abs(woodShare(square, wood) - 0.5) < 0.06, `${woodShare(square, wood)}`);
  assert.equal(woodShare(square, []), 0);
});

test('a path\'s kind: kerbed if paved in a formal park, a track if dirt, gravel, sand or trodden grass, or anything in the bush', () => {
  // Surfaces: 0 paving, 1 asphalt, 2 gravel, 3 timber, 4 trodden grass, 5 dirt, 6 sand. Kinds: 0 a footpath, 1 steps, 2 a cycleway, 3 a track
  for (const surface of [0, 1, 3]) assert.equal(pathKind(0, surface, 'formal'), 0);
  for (const surface of [2, 4, 5, 6]) assert.equal(pathKind(0, surface, 'formal'), 3);
  assert.equal(pathKind(2, 1, 'formal'), 2, 'a paved cycleway');
  assert.equal(pathKind(2, 5, 'formal'), 3, 'a dirt cycleway is a track');
  assert.equal(pathKind(0, 1, 'bush'), 3, 'in the bush, all of them');
  assert.equal(pathKind(1, 2, 'bush'), 1, 'steps stay steps');
  // The Royal Botanic Garden's gravel paths are edged as its paved ones; its trodden grass and dirt are still tracks
  assert.equal(pathKind(0, 2, 'formal', true), 0);
  assert.equal(pathKind(0, 4, 'formal', true), 3);
});

// Known parks, from OpenStreetMap's land (tools/data/east/land.json, fetched, not in the repository)
const LAND = new URL('../tools/data/east/land.json', import.meta.url);
test('known parks come out as the photos have them', { skip: !fs.existsSync(LAND) && 'no land.json' }, async () => {
  const { elementRings } = await import('../tools/geo-common.mjs');
  const land = JSON.parse(fs.readFileSync(LAND, 'utf8')).elements;
  const woods = woodsOf(land);
  const kindOf = (name) => {
    const e = land.find((el) => el.tags?.name === name && /^(park|garden|nature_reserve)$/.test(el.tags.leisure || ''));
    assert.ok(e, `no ${name} in OSM`);
    return parkKind(e.tags, woodShare(elementRings(e).outer.filter((r) => r.length > 3), woods));
  };
  for (const name of ['Royal Botanic Garden', 'Hyde Park North', 'Wynyard Park', 'Bronte Park', 'Sydney Park']) assert.equal(kindOf(name), 'formal', name);
  for (const name of ['Bradley Bushland Reserve', 'Parriwi Park', 'Watt Park']) assert.equal(kindOf(name), 'bush', name);
});
