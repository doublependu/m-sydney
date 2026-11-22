import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fromWorld, pointInRing, ringArea } from '../tools/geo-common.mjs';
import { parkRule, ruleParks } from '../tools/garden-areas.mjs';
import { BANK, Outline, ParkIndex, Pockets, kindAt, parkLawns, parkPaths } from '../tools/garden/rule-parks.mjs';
import { pondTest } from '../tools/pond-pieces.mjs';

// The parks by rule (tools/garden-areas.mjs ruleParks(), tools/garden/rule-parks.mjs): which parks, and what tools/build-garden.mjs lays
// out in them, on parks made up for it. The hand-made areas are tools/build-garden.mjs's as they were, checked on the map's own data
// against the last build's garden.json.

const square = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
const flatOf = (ring) => ring.flat();
// A park, bush all over as its tags say a reserve is, or formal where it isn't in a pocket of bush
const park = (kind, ring = square(20, 20, 220, 220), extra = {}) => ({ id: `way/${kind}`, name: kind, kind, forced: kind === 'bush' ? 'bush' : null,
  rings: [ring], holes: [], area: Math.abs(ringArea(ring)), ...extra });
const pocket = (ring) => ({ outer: [ring], holes: [], box: { x0: Math.min(...ring.map((p) => p[0])), x1: Math.max(...ring.map((p) => p[0])),
  z0: Math.min(...ring.map((p) => p[1])), z1: Math.max(...ring.map((p) => p[1])) } });
// The map's lawn over the whole square, less what `gaps` (rings) leave out, as pieces [outer, ...holes] of flat rings
const lawnOver = (...gaps) => [[flatOf(square(0, 0, 240, 240)), ...gaps.map(flatOf)]];
// OSM's path across the park from west to east at z, past its edges, asphalt, 2.4 m wide
const across = (z, kind = 0, surface = 1) => ({ tags: {}, pts: [[0, z], [240, z]], kind, surface, width: () => 2.4 });
const lay = (parks, ways, { clear = () => true, inArea = () => false, lawns = lawnOver(), lakes = [], areas = [], sand = [], bush = [], mapTile } = {}) => {
  const index = new ParkIndex(parks);
  const found = parkPaths(ways, index, { inArea, clear, pockets: new Pockets(bush) });
  const raised = parkLawns([[0, 0]], { parks, pockets: bush, areas, lawns, paths: found.paths, lakes, sand, mapTile, tile: 100 });
  return { ...found, raised };
};
const ringsOf = (piece) => piece.slice(1).map((f) => { const r = []; for (let k = 0; k < f.length; k += 2) r.push([f[k], f[k + 1]]); return r; });
const inPiece = (piece, x, z) => { const [outer, ...holes] = ringsOf(piece); return pointInRing(outer, x, z) && !holes.some((h) => pointInRing(h, x, z)); };
const raisedAt = (lawns, x, z) => lawns.some((p) => inPiece(p, x, z));
const lawnArea = (lawns) => lawns.reduce((t, p) => { const [o, ...h] = ringsOf(p); return t + Math.abs(ringArea(o)) - h.reduce((s, r) => s + Math.abs(ringArea(r)), 0); }, 0);

test('which parks are laid out by rule: parks, reserves and public gardens; not private gardens, golf courses or schools', () => {
  assert.equal(parkRule({ leisure: 'park' }).in, true);
  assert.equal(parkRule({ leisure: 'nature_reserve' }).in, true);
  assert.equal(parkRule({ boundary: 'protected_area' }).in, true);
  assert.equal(parkRule({ leisure: 'garden', name: 'Community Garden' }).in, true);
  assert.equal(parkRule({ leisure: 'garden', access: 'public' }).in, true);
  assert.equal(parkRule({ leisure: 'garden' }).in, false, 'an unnamed garden with no access: a house\'s');
  assert.equal(parkRule({ leisure: 'garden', name: 'Villa', access: 'private' }).in, false);
  assert.equal(parkRule({ leisure: 'garden', name: 'Villa', 'garden:type': 'residential' }).in, false);
  assert.equal(parkRule({ leisure: 'garden', name: 'Rooftop', 'garden:type': 'roof_garden' }).in, false);
  assert.equal(parkRule({ leisure: 'park', name: 'Moore Park Golf Course' }).in, false);
  assert.equal(parkRule({ leisure: 'park', name: 'Fort Street Public School' }).in, false);
  assert.equal(parkRule({ leisure: 'pitch' }).in, false);
});

test('a park is left out where it\'s a hand-made area\'s or on a model site; an override gives its kind, and checks its tags', () => {
  const way = (id, tags, ring) => ({ type: 'way', id, tags, geometry: ring.map(([x, z]) => { const [lon, lat] = fromWorld(x, z); return { lon, lat }; }) });
  const land = [
    way(1, { leisure: 'park', name: 'The Area' }, square(0, 0, 100, 100)),
    way(2, { leisure: 'garden', name: 'Rose Garden' }, square(10, 10, 30, 30)),
    way(3, { leisure: 'park', name: 'Suburb Park' }, square(500, 0, 600, 100)),
    way(4, { leisure: 'park', name: 'On The Site' }, square(1000, 0, 1050, 50)),
    way(5, { leisure: 'park', name: 'Bushy Park' }, square(2000, 0, 2100, 100)),
    way(6, { leisure: 'garden' }, square(3000, 0, 3020, 20))
  ];
  const areas = [{ name: 'The Area', element: 'way/1', rings: [square(0, 0, 100, 100)], box: { x0: 0, z0: 0, x1: 100, z1: 100 }, except: [] }];
  const cuts = [square(990, -10, 1060, 60)];
  const overrides = [{ id: 'way/5', expect: { name: 'Bushy Park' }, kind: 'bush', why: 'the aerial' }];
  const { parks, left } = ruleParks(land, areas, { cuts, overrides });
  assert.deepEqual(parks.map((p) => [p.id, p.kind, p.forced]), [['way/3', 'formal', null], ['way/5', 'bush', 'bush']]);
  assert.deepEqual(left.map((l) => [l.id, l.why.split(':')[0]]),
    [['way/1', 'a hand-made area'], ['way/2', 'a hand-made area'], ['way/4', 'on a model site'], ['way/6', 'garden, unnamed with no access']]);
  // Bush in most of it: its kind; three quarters or more, bush all over (no strips of raised lawn where the bush's edge misses the park's)
  const woods = (share) => [{ ring: square(500, 0, 500 + 100 * share, 100), box: { x0: 500, z0: 0, x1: 500 + 100 * share, z1: 100 } }];
  for (const [share, kind, forced] of [[0.4, 'formal', null], [0.6, 'bush', null], [0.8, 'bush', 'bush']]) {
    const p = ruleParks(land, areas, { cuts, overrides, woods: woods(share) }).parks.find((q) => q.id === 'way/3');
    assert.deepEqual([p.kind, p.forced], [kind, forced], `${share} of it bush`);
  }
  assert.throws(() => ruleParks(land, areas, { overrides: [{ id: 'way/5', expect: { name: 'Bushy Reserve' }, kind: 'bush', why: 'x' }] }), /Bushy Reserve/);
  assert.throws(() => ruleParks(land, areas, { overrides: [{ id: 'way/9', kind: 'bush', why: 'x' }] }), /no way\/9/);
});

test('a park\'s outline is looked up as pointInRing() has it, with its holes, and how near its edge', () => {
  // A ring of many points with a hole: the lookup against pointInRing() on a grid over it
  const outer = Array.from({ length: 300 }, (_, k) => { const a = (k / 300) * 2 * Math.PI, r = 300 + 40 * Math.sin(7 * a); return [r * Math.cos(a), r * Math.sin(a)]; });
  const hole = square(-50, -50, 60, 40);
  const o = new Outline([outer], [hole]);
  let wrong = 0, n = 0;
  for (let x = -360; x <= 360; x += 3.7) {
    for (let z = -360; z <= 360; z += 3.3) {
      n++;
      if (o.inside(x, z) !== (pointInRing(outer, x, z) && !pointInRing(hole, x, z))) wrong++;
    }
  }
  assert.equal(wrong, 0, `${wrong} of ${n}`);
  assert.equal(o.near(302, 0, 4), true);
  assert.equal(o.near(306, 0, 4), false);
  assert.equal(o.near(200, 0, 4), false);
  // The smallest park a point is in
  const big = park('formal', square(0, 0, 400, 400)), small = park('bush', square(100, 100, 200, 200));
  const index = new ParkIndex([big, small]);
  assert.equal(index.at(150, 150), small);
  assert.equal(index.at(50, 50), big);
  assert.equal(index.at(-3, 50, 4), big, 'within its reach');
  assert.equal(index.at(-5, 50, 4), null);
});

test('a formal park by rule: its paved path kerbed, the raised lawn either side of it in the park and not on its corridor', () => {
  const p = park('formal');
  const { paths, raised } = lay([p], [across(120)]);
  assert.equal(paths.length, 1);
  const [kind, surface, width, ...line] = paths[0];
  assert.deepEqual([kind, surface, width], [0, 1, 2.4], 'a footpath, asphalt, kerbed');
  // From REACH past the park's west edge to REACH past its east
  assert.ok(Math.abs(line[0] - 16) <= 1 && Math.abs(line[line.length - 2] - 224) <= 1, `${line[0]} to ${line[line.length - 2]}`);
  assert.ok(Math.abs(p.metres - 208) < 2, `${p.metres} m`);
  const lawns = raised.lawns;
  assert.ok(lawns.length >= 2, `${lawns.length} pieces`);
  assert.ok(lawns.every(([kerb]) => kerb === 0), 'kerbed in concrete');
  // The park, less the corridor (half the path and the kerb, 1.3 m, either side of its line)
  const want = 200 * 200 - 200 * 2.6;
  assert.ok(Math.abs(lawnArea(lawns) - want) < 0.01 * want, `${lawnArea(lawns).toFixed(0)} m² against ${want}`);
  for (const [x, z] of [[50, 120], [120, 119], [200, 121.2]]) assert.equal(raisedAt(lawns, x, z), false, `raised on the path at (${x}, ${z})`);
  for (const [x, z] of [[50, 60], [120, 180], [200, 122]]) assert.equal(raisedAt(lawns, x, z), true, `not raised at (${x}, ${z})`);
  // Nothing raised outside the park
  for (const [x, z] of [[10, 60], [230, 60], [120, 10], [120, 230]]) assert.equal(raisedAt(lawns, x, z), false, `raised outside at (${x}, ${z})`);
  // A gravel path is a track, worn into the lawn: no corridor
  const gravel = lay([park('formal')], [across(120, 0, 2)]);
  assert.equal(gravel.paths[0][0], 3);
  assert.ok(Math.abs(lawnArea(gravel.raised.lawns) - 200 * 200) < 0.01 * 200 * 200);
});

test('a path straight across a square, both its ends outside it, has its corridor cut there too', () => {
  // One segment from far west of the square to far east, a park over it all: the square from (0, 0) is laid out alone
  const p = park('formal', square(-300, 20, 540, 220));
  const way = { tags: {}, pts: [[-290, 120], [530, 125]], kind: 0, surface: 1, width: () => 2.4 };
  const index = new ParkIndex([p]);
  const found = parkPaths([way], index, { inArea: () => false, clear: () => true });
  assert.equal(found.paths.length, 1);
  assert.equal(found.paths[0].length, 3 + 4, 'one straight segment');
  const raised = parkLawns([[0, 0]], { parks: [p], lawns: lawnOver(), paths: found.paths });
  for (const x of [5, 60, 120, 235]) assert.equal(raisedAt(raised.lawns, x, 120 + (5 * (x + 290)) / 820), false, `raised on the path at x ${x}`);
  assert.equal(raisedAt(raised.lawns, 120, 60), true);
});

test('a bush park by rule: every path a track, steps still steps, no raised lawn; a bush park inside a formal one isn\'t raised', () => {
  const { paths, raised } = lay([park('bush')], [across(120), across(60, 1, 0)]);
  assert.deepEqual(paths.map(([kind]) => kind), [3, 1]);
  assert.equal(raised.lawns.length, 0);
  // A formal park round a bush pocket: raised but in the pocket
  const pocket = park('bush', square(100, 100, 160, 160), { id: 'way/pocket' });
  const both = lay([park('formal'), pocket], [across(40), across(130)]);
  assert.deepEqual(both.paths.map(([kind]) => kind), [0, 0, 3, 0], 'the path across the pocket a track there, kerbed either side');
  // ...in three runs that meet: each starts where the last one ends
  const [, a, b, c] = both.paths.map(([, , , ...line]) => line);
  assert.deepEqual(a.slice(-2), b.slice(0, 2));
  assert.deepEqual(b.slice(-2), c.slice(0, 2));
  assert.ok(Math.abs(b[0] - 100) <= 1 && Math.abs(b[b.length - 2] - 160) <= 1, `the track from ${b[0]} to ${b[b.length - 2]}`);
  assert.equal(raisedAt(both.raised.lawns, 130, 110), false);
  assert.equal(raisedAt(both.raised.lawns, 60, 110), true);
});

test('a park with bush in it (OSM\'s wood, or bush land in the zoning): tracks and no raised lawn there, its paths kerbed either side', () => {
  const bush = [pocket(square(100, 100, 160, 160))];
  const p = park('formal');
  assert.equal(kindAt(p, 130, 130, new Pockets(bush)), 'bush');
  assert.equal(kindAt(p, 60, 130, new Pockets(bush)), 'formal');
  assert.equal(kindAt({ ...p, forced: 'formal' }, 130, 130, new Pockets(bush)), 'formal', 'an override\'s kind all over');
  const { paths, raised } = lay([p], [across(130)], { bush });
  assert.deepEqual(paths.map(([kind]) => kind), [0, 3, 0]);
  assert.equal(raisedAt(raised.lawns, 130, 110), false);
  assert.equal(raisedAt(raised.lawns, 60, 110), true);
  // A formal park by hand: raised in the bush too
  const forced = lay([{ ...park('formal'), forced: 'formal' }], [across(130)], { bush });
  assert.deepEqual(forced.paths.map(([kind]) => kind), [0]);
  assert.equal(raisedAt(forced.raised.lawns, 130, 110), true);
});

test('a park round a lake: the raised lawn stops at its bank, a path through the water is cut, and an island in it isn\'t raised', () => {
  const lake = [0, flatOf(square(60, 140, 180, 200)), flatOf(square(100, 160, 120, 180))];
  const inLake = pondTest([lake]);
  const { paths, raised } = lay([park('formal')], [across(170), across(60)], { clear: (x, z) => !inLake(x, z), lakes: [lake] });
  // The path across the lake in three runs, either side of it and over its island, and the one south of it whole
  const runs = paths.filter((p) => Math.abs(p[4] - 170) < 1);
  assert.equal(runs.length, 3, `${runs.length} runs`);
  assert.equal(paths.filter((p) => Math.abs(p[4] - 60) < 1).length, 1);
  for (const [, , , ...line] of runs) for (let k = 0; k < line.length; k += 2) assert.ok(!inLake(line[k], line[k + 1]), `a path in the lake at ${line[k]}`);
  const lawns = raised.lawns;
  // Not on the water, its bank or the island; raised up to the bank
  for (const [x, z] of [[80, 150], [61, 150], [60 - BANK + 0.1, 150], [110, 170], [80, 199]]) assert.equal(raisedAt(lawns, x, z), false, `raised at (${x}, ${z})`);
  for (const [x, z] of [[60 - BANK - 0.2, 150], [80, 139.5], [190, 150]]) assert.equal(raisedAt(lawns, x, z), true, `not raised at (${x}, ${z})`);
});

test('a park cut by a road: its path stops short of the road, and no raised lawn where the map has none, nor on the sand', () => {
  // A road north to south through the park, 10 m wide at x = 120: the map's lawn stops at its edges, a path keeps 0.6 m off them
  const road = square(115, 0, 125, 240);
  const clear = (x) => Math.abs(x - 120) > 5.6;
  // ...and a beach's sand by it, over the lawn at the park's west edge, and another just past the square's east edge
  const sand = [[0, flatOf(square(20, 30, 40, 60))], [0, flatOf(square(245, 30, 260, 60))]];
  const { paths, raised } = lay([park('formal')], [across(80)], { clear, lawns: lawnOver(road), sand });
  assert.equal(raisedAt(raised.lawns, 30, 45), false, 'raised on the sand');
  assert.equal(raisedAt(raised.lawns, 45, 45), true);
  // ...and none in a tile the map hasn't (here 100 m tiles, the one from (200, 200) left out)
  const edge = lay([park('formal')], [across(80)], { clear, lawns: lawnOver(road), mapTile: (ix, iz) => !(ix === 2 && iz === 2) });
  assert.equal(raisedAt(edge.raised.lawns, 210, 210), false);
  assert.equal(raisedAt(edge.raised.lawns, 190, 210), true);
  for (const [, outer] of edge.raised.lawns) for (let k = 0; k < outer.length; k += 2) assert.ok(!(outer[k] > 200.01 && outer[k + 1] > 200.01), `a point at ${outer[k]}, ${outer[k + 1]}`);
  assert.equal(paths.length, 2, `${paths.length} runs`);
  for (const [, , , ...line] of paths) for (let k = 0; k < line.length; k += 2) assert.ok(Math.abs(line[k] - 120) > 5.5, `a path at x ${line[k]}`);
  for (const z of [30, 120, 200]) assert.equal(raisedAt(raised.lawns, 120, z), false);
  assert.equal(raisedAt(raised.lawns, 112, 120), true);
});

test('a park\'s path meets a hand-made area\'s at the area\'s last point; an area\'s ground is never raised by rule', () => {
  // The area takes x < 104 (its outline at 100, its paths REACH past it); the park the rest
  const inArea = (x) => x < 104;
  const areas = [[square(0, 0, 100, 240)]];
  const { paths, raised } = lay([park('formal', square(0, 20, 220, 220))], [across(120)], { inArea, areas });
  assert.equal(paths.length, 1);
  const [, , , x0] = paths[0];
  assert.ok(Math.abs(x0 - 103) < 0.01, `starts at ${x0}`);
  assert.equal(raisedAt(raised.lawns, 50, 60), false);
  assert.equal(raisedAt(raised.lawns, 150, 60), true);
});

// Parks the trial read against NSW's aerial imagery, from OpenStreetMap's land and NSW's zoning (fetched, not in the repository)
const LAND = new URL('../tools/data/east/land.json', import.meta.url), ZONING = new URL('../tools/data/nsw_zoning.json', import.meta.url);
test('parks by rule come out as the aerial has them: the bush OSM draws no wood in is bush by the zoning or by hand', { skip: !(fs.existsSync(LAND) && fs.existsSync(ZONING)) && 'no land.json or nsw_zoning.json' }, async () => {
  const { elementRings } = await import('../tools/geo-common.mjs');
  const { PARK_OVERRIDES, parkKind, pockets, woodShare } = await import('../tools/garden-areas.mjs');
  const land = JSON.parse(fs.readFileSync(LAND, 'utf8')).elements;
  const bush = pockets(land, JSON.parse(fs.readFileSync(ZONING, 'utf8')));
  const kindOf = (type, id) => {
    const e = land.find((el) => el.type === type && el.id === id);
    assert.ok(e, `no ${type}/${id} in OSM`);
    return PARK_OVERRIDES.find((o) => o.id === `${type}/${id}`)?.kind ?? parkKind(e.tags, woodShare(elementRings(e).outer.filter((r) => r.length > 3), bush));
  };
  // Hunts Creek Reserve, Lake Parramatta Reserve, Seville Reserve: zoned C2 for their bush; Oatley Park by hand (zoned RE1, no wood in OSM)
  for (const [type, id] of [['way', 4755848], ['way', 1075245506], ['way', 240278788]]) assert.equal(kindOf(type, id), 'bush', `${type}/${id}`);
  for (const name of ['Lake Parramatta Reserve', 'Seville Reserve']) {
    const e = land.find((el) => el.tags?.name === name && el.tags.leisure === 'park');
    assert.equal(kindOf(e.type, e.id), 'bush', name);
  }
  // Forest the whole map's read found formal by the rule (no wood in OSM, zoned for recreation): bush by hand
  for (const name of ['Landsdowne Park', 'Little Salt Pan Reserve', 'Galston Recreation Reserve', 'Dog Pound Creek Conservation Reserve',
    'Lieutenant Cantello Reserve', 'Deepwater Park', 'Fred Caterson Reserve', 'Currawong Reserve']) {
    const e = land.find((el) => el.tags?.name === name && el.tags.leisure === 'park');
    assert.equal(kindOf(e.type, e.id), 'bush', name);
  }
  // Parramatta Park's lawns, Sydney Park, Heffron Park, Tempe Reserve: formal
  for (const [type, id] of [['relation', 2913327], ['way', 174137106]]) assert.equal(kindOf(type, id), 'formal', `${type}/${id}`);
  for (const name of ['Heffron Park', 'Tempe Reserve', 'Mackey Park']) {
    const e = land.find((el) => el.tags?.name === name && el.tags.leisure === 'park');
    assert.equal(kindOf(e.type, e.id), 'formal', name);
  }
});
