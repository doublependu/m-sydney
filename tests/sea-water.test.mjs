import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fromWorld, load } from '../tools/geo-common.mjs';
import { localWater } from '../tools/local-edits.mjs';
import { POND_AREA, pondWaters, seaWaters, shoreLines } from '../tools/sea-water.mjs';

// Which water is the sea's, at its one level (tools/build-geodata.mjs riversAndPiers()), and which is still water drawn as a pond
// (tools/build-ponds.mjs): one rule, tools/sea-water.mjs, and the hand edits that correct it (tools/local/, `water`). Then the ponds' rule
// (pondWaters()): which of the still water the sea's rule never reads is drawn as a pond too.

const way = (id, tags, ring) => ({
  type: 'way', id, tags: { natural: 'water', ...tags }, geometry: ring.map(([x, z]) => { const [lon, lat] = fromWorld(x, z); return { lon, lat }; })
});
const square = (x, z, s = 50) => [[x, z], [x + s, z], [x + s, z + s], [x, z + s], [x, z]];
// A shore along x = 0; the survey 5 m up east of x = 800, 1 m elsewhere; a garden from x 1000 to 1100
const shore = [[[0, -1000], [0, 3000]]];
const heightAt = (x) => (x > 800 && x < 1000 ? 5 : 1);
const inGarden = (ring) => ring.every(([x]) => x >= 1000 && x <= 1100);
const elements = [
  way(1, {}, square(5, 0)), // on the shore
  way(2, {}, square(75, 0)), // 20 m from 1: beside it
  way(3, {}, square(160, 0)), // 35 m from 2: still
  way(4, {}, square(225, 0)), // 15 m from 3
  way(5, { water: 'river' }, square(500, 0)),
  way(6, { tidal: 'yes' }, square(500, 200)),
  way(7, { water: 'pond' }, square(500, 400)), // never the sea's
  way(8, {}, square(500, 600, 30)), // too small
  way(9, {}, square(900, 0)), // too high
  way(10, {}, square(1020, 0)) // in a garden
];
const keys = (list) => list.map((c) => c.key).sort();
const rule = (edits = []) => seaWaters(elements, { heightAt, inGarden, shore, edits });

test('the sea takes water on the shore, flowing or tidal, and whatever reaches them; still water is left out', () => {
  const { sea, still } = rule();
  assert.deepEqual(keys(sea), ['way/1', 'way/2', 'way/5', 'way/6']);
  assert.deepEqual(keys(still), ['way/3', 'way/4']);
  const why = Object.fromEntries(sea.map((c) => [c.key, c.why]));
  assert.equal(why['way/1'], 'on the shore');
  assert.equal(why['way/2'], 'beside way/1');
  assert.equal(why['way/5'], 'flowing');
  assert.equal(why['way/6'], 'flowing');
});

test('a hand edit puts water in the sea, and what meets it reaches it too; or takes it out, and what only it reached is still', () => {
  const into = rule([{ key: 'way/3', sea: true, file: 'test.json', why: 'a channel' }]);
  assert.deepEqual(keys(into.sea), ['way/1', 'way/2', 'way/3', 'way/4', 'way/5', 'way/6']);
  assert.equal(into.sea.find((c) => c.key === 'way/3').why, 'by hand (test.json)');
  assert.equal(into.sea.find((c) => c.key === 'way/4').why, 'beside way/3');
  const out = rule([{ key: 'way/1', sea: false, file: 'test.json', why: 'a lake' }]);
  assert.deepEqual(keys(out.still), ['way/1', 'way/2', 'way/3', 'way/4']);
});

test('a hand edit stops the build if its water is gone or isn\'t what it was', () => {
  assert.throws(() => rule([{ key: 'way/7', sea: true, file: 'test.json', why: 'a pond' }]), /isn't water the sea's rule reads/);
  assert.throws(() => rule([{ key: 'way/99', sea: true, file: 'test.json', why: 'gone' }]), /isn't water the sea's rule reads/);
  assert.throws(() => rule([{ key: 'way/3', sea: true, expect: { name: 'Whites Creek' }, file: 'test.json', why: 'renamed' }]), /has name=undefined in OSM now/);
});

// The ponds' rule: still water the sea's never reads (too small, tagged still, or high), over POND_AREA m², tagged a pond, lake, basin or
// reservoir, or untagged; there most of the year and open; not in a garden's area
const ponds = [
  way(21, {}, square(2000, 0, 20)), // 400 m², untagged: in
  way(22, { water: 'pond' }, square(2000, 100, 20)),
  way(23, { water: 'lake' }, square(2000, 200, 20)),
  way(24, { water: 'basin' }, square(2000, 300, 20)),
  way(25, { water: 'reservoir' }, square(2000, 400, 20)), // a farm dam
  way(26, { water: 'wastewater' }, square(2000, 500, 20)), // out: a works' tanks
  way(27, { water: 'stream_pool' }, square(2000, 600, 20)),
  way(28, {}, square(2000, 700, 12)), // 144 m²: too small
  way(29, { water: 'river' }, square(2000, 800, 20)), // flowing, but too small for the sea: neither
  way(30, { tidal: 'yes' }, square(2000, 900, 20)),
  way(31, {}, square(1020, 300, 20)), // in a garden
  way(32, { water: 'basin', intermittent: 'yes' }, square(2100, 0, 20)), // out: dry most of the year
  way(33, { water: 'basin', basin: 'detention' }, square(2100, 100, 20)),
  way(34, { water: 'reservoir', covered: 'yes' }, square(2100, 200, 20)), // out: under a roof
  way(35, { sport: 'swimming' }, square(2100, 300, 20)), // a pool
  way(36, { water: 'pond', intermittent: 'no', covered: 'no' }, square(2100, 400, 20)) // in
];
const all = [...elements, ...ponds];
const pondRule = (edits = []) => {
  const seaRule = seaWaters(all, { heightAt, inGarden, shore, edits });
  return pondWaters(all, { seaRule, inGarden, edits });
};

test('the ponds\' rule draws the sea\'s still water, and of the rest what\'s over 200 m² tagged a pond, lake, basin or reservoir, or untagged', () => {
  assert.equal(POND_AREA, 200);
  const drawn = pondRule();
  // way/8 is too small for the sea, way/9 too high: ponds by rule; way/10 is in a garden's area
  assert.deepEqual(keys(drawn), ['way/21', 'way/22', 'way/23', 'way/24', 'way/25', 'way/3', 'way/36', 'way/4', 'way/7', 'way/8', 'way/9']);
  const why = Object.fromEntries(drawn.map((c) => [c.key, c.why]));
  assert.equal(why['way/3'], 'out of the sea');
  assert.equal(why['way/7'], 'by rule', 'a pond the sea never reads');
  assert.equal(why['way/9'], 'by rule', 'water too high for the sea');
  assert.equal(why['way/21'], 'by rule');
  // The sea's still water comes first, as tools/build-ponds.mjs drew it before
  assert.deepEqual(drawn.slice(0, 2).map((c) => c.key).sort(), ['way/3', 'way/4']);
});

test('a pond edit draws what the rule leaves out, or leaves out what it draws; and stops the build if it\'s wrong', () => {
  const edits = [
    { key: 'way/26', pond: true, file: 'test.json', why: 'an open lagoon' },
    { key: 'way/32', pond: true, file: 'test.json', why: 'full all year' },
    { key: 'way/24', pond: false, expect: { water: 'basin' }, file: 'test.json', why: 'dry grass' },
    { key: 'way/3', pond: false, file: 'test.json', why: 'a car park now' }
  ];
  const drawn = pondRule(edits);
  assert.deepEqual(keys(drawn), ['way/21', 'way/22', 'way/23', 'way/25', 'way/26', 'way/32', 'way/36', 'way/4', 'way/7', 'way/8', 'way/9']);
  assert.equal(drawn.find((c) => c.key === 'way/26').why, 'by hand (test.json)');
  // ...and the sea's rule doesn't read them
  assert.deepEqual(keys(seaWaters(all, { heightAt, inGarden, shore, edits }).sea), keys(rule().sea));
  const one = (edit) => () => pondRule([{ file: 'test.json', why: 'a test', ...edit }]);
  assert.throws(one({ key: 'way/27', pond: false }), /isn't water drawn as a pond/);
  assert.throws(one({ key: 'way/22', pond: true }), /is drawn as a pond already \(by rule\)/);
  assert.throws(one({ key: 'way/1', pond: true }), /is the sea's/);
  assert.throws(one({ key: 'way/99', pond: true }), /isn't water in OSM's land/);
  assert.throws(one({ key: 'way/24', pond: false, expect: { water: 'pond' } }), /has water=basin in OSM now, not pond/);
});

test('a water edit says sea or pond, not both', () => {
  const area = (edit) => [{ file: 'test.json', water: [{ id: 'way/1', why: 'a test', ...edit }] }];
  assert.deepEqual(localWater(area({ pond: false })), [{ key: 'way/1', pond: false, expect: undefined, why: 'a test', file: 'test.json' }]);
  assert.deepEqual(localWater(area({ sea: true })), [{ key: 'way/1', sea: true, expect: undefined, why: 'a test', file: 'test.json' }]);
  assert.throws(() => localWater(area({ sea: true, pond: true })), /one of sea or pond/);
  assert.throws(() => localWater(area({})), /one of sea or pond/);
});

// The 66 still waters the sea's rule takes out of the sea in today's OpenStreetMap snapshot (tools/data/east/land.json, fetched, not in the
// repository), read one by one against NSW's aerial: golf courses' water hazards, park lakes, ponds in the bush and Sydney Olympic Park's
// managed ponds. The rule alone reads 67: Whites Creek, a tidal channel, is kept in the sea by hand (tools/local/whites-creek.json). A new
// snapshot that changes the list fails here: read the new ones before the build takes them out of the sea.
const STILL = [
  'relation/1301121', 'relation/4024521', 'relation/4024523', 'relation/4024524', 'relation/4024525', 'relation/7600631',
  'relation/8385157', 'relation/8385158', 'relation/15087297', 'way/4388447', 'way/14115359', 'way/16162218', 'way/21009834',
  'way/22882146', 'way/22882147', 'way/22882148', 'way/24041827', 'way/26538925', 'way/64401510', 'way/84909010', 'way/172397470',
  'way/174594093', 'way/174618950', 'way/175621833', 'way/175621854', 'way/175730246', 'way/175772936', 'way/175772945', 'way/175772947',
  'way/218548441', 'way/237087882', 'way/252680387', 'way/252680389', 'way/252680392', 'way/252680398', 'way/253258728', 'way/265321845',
  'way/429900357', 'way/429900358', 'way/429900455', 'way/429900464', 'way/429900466', 'way/443595320', 'way/447939374', 'way/527137936',
  'way/552511338', 'way/632478311', 'way/679195137', 'way/815830824', 'way/834680654', 'way/843920821', 'way/843932813', 'way/843952076',
  'way/843952086', 'way/852344580', 'way/852344581', 'way/955893425', 'way/966763736', 'way/1081640470', 'way/1081640478',
  'way/1081640481', 'way/1081640482', 'way/1081640483', 'way/1081640488', 'way/1081640491', 'way/1210173510'
];
const LAND = new URL('../tools/data/east/land.json', import.meta.url);
const ELEVATION = new URL('../tools/data/elevation/', import.meta.url);
test('today\'s snapshot: the 66 out of the sea, by name, and Whites Creek kept in it by hand', { skip: !(fs.existsSync(LAND) && fs.existsSync(ELEVATION)) && 'no OSM snapshot or elevation' }, async () => {
  const { heightSampler } = await import('../tools/fetch-elevation.mjs');
  const { gardenAreas, inGardenArea } = await import('../tools/garden-areas.mjs');
  const land = load('land.json').elements;
  const dem = heightSampler(5);
  const gardens = gardenAreas(land);
  const { sea, still } = seaWaters(land, {
    heightAt: (x, z) => dem(...fromWorld(x, z)), shore: shoreLines(), edits: localWater(),
    inGarden: (ring) => inGardenArea(gardens, ring.reduce((t, p) => t + p[0], 0) / ring.length, ring.reduce((t, p) => t + p[1], 0) / ring.length)
  });
  assert.deepEqual(keys(still), [...STILL].sort());
  const names = new Set(still.map((c) => c.e.tags?.name).filter(Boolean));
  for (const name of ['Lake Belvedere', 'Lake Gillawarna', 'Bennelong Pond']) assert.ok(names.has(name), `${name} not still water`);
  const whites = sea.find((c) => c.e.tags?.name === 'Whites Creek');
  assert.equal(whites?.why, 'by hand (whites-creek.json)');
  // The sea keeps its rivers and bays
  for (const name of ['Cooks River', 'Parramatta River', 'Georges River', 'Alexandra Canal']) assert.ok(sea.some((c) => c.e.tags?.name === name), `${name} not the sea's`);
});

// The ponds' rule on today's snapshot: 581 waters by rule and 14 by hand (tools/local/ponds.json), beside the sea's rule's 66, read against
// NSW's aerial: its 40 biggest, 40 of those under 1,000 m², every reservoir and wastewater it read, and every one tagged as coming and
// going. A new snapshot that changes the list fails here: read the new ones on NSW's aerial before a build draws them (a dry basin or a tank
// gets a `pond: false` edit in tools/local/ponds.json), then write the list again.
const POND_WATERS = JSON.parse(fs.readFileSync(new URL('fixtures/pond-waters.json', import.meta.url), 'utf8'));
test('today\'s snapshot: the ponds\' rule, by id, and the hand\'s edits', { skip: !(fs.existsSync(LAND) && fs.existsSync(ELEVATION)) && 'no OSM snapshot or elevation' }, async () => {
  const { heightSampler } = await import('../tools/fetch-elevation.mjs');
  const { gardenAreas, inGardenArea } = await import('../tools/garden-areas.mjs');
  const land = load('land.json').elements;
  const dem = heightSampler(5);
  const gardens = gardenAreas(land);
  const inGarden = (ring) => inGardenArea(gardens, ring.reduce((t, p) => t + p[0], 0) / ring.length, ring.reduce((t, p) => t + p[1], 0) / ring.length);
  const edits = localWater();
  const seaRule = seaWaters(land, { heightAt: (x, z) => dem(...fromWorld(x, z)), shore: shoreLines(), edits, inGarden });
  const drawn = pondWaters(land, { seaRule, inGarden, edits });
  const count = (why) => drawn.filter((c) => why.test(c.why)).length;
  assert.equal(count(/^out of the sea$/), 66);
  assert.equal(count(/^by rule$/), 581);
  assert.equal(count(/^by hand \(ponds\.json\)$/), 14);
  const ours = drawn.filter((c) => c.why !== 'out of the sea');
  assert.equal(ours.length, POND_WATERS.count);
  assert.deepEqual(keys(ours), POND_WATERS.keys);
  const names = new Set(ours.map((c) => c.e.tags?.name).filter(Boolean));
  for (const name of ['Manly Dam', 'Lake Parramatta', 'Kippax Lake', 'Mill Pond', 'Engine Pond']) assert.ok(names.has(name), `${name} not a pond`);
  // Not water most of the year, or not open: Potts Hill's drained reservoir, a pool, a splash pad, a tank under a roof
  for (const key of ['way/25157768', 'way/172383885', 'way/1464459924', 'way/585326174']) assert.ok(!ours.some((c) => c.key === key), `${key} a pond`);
});
