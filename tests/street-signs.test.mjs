import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { heldList } = await import('../js/geodata.js');
const SIGNALS = heldList('signals');
const { SignAtlas, bladesOnPole, junctionRoads, namedJunctions } = await import('../js/street-signs.js');

const junctionOf = (...names) => namedJunctions().find((j) => names.every((n) => j.roads.some((r) => r.name === n)));

test('real junctions name the roads that meet there', () => {
  for (const [a, b] of [['George Street', 'Market Street'], ['Macquarie Street', 'Bridge Street'], ['Pitt Street', 'Park Street']]) {
    const j = junctionOf(a, b);
    assert.ok(j, `${a} meets ${b}`);
    const names = junctionRoads(j.x, j.z).map((r) => r.name);
    assert.ok(names.includes(a) && names.includes(b), `${a} and ${b} in ${names}`);
  }
});

test('names are short, as signs write them', () => {
  const j = junctionOf('George Street', 'Market Street');
  const shorts = junctionRoads(j.x, j.z).map((r) => r.short);
  assert.ok(shorts.includes('George St') && shorts.includes('Market St'), shorts.join());
});

test('nearly every signal has a name, and George St only appears on its own', () => {
  let george = 0, none = 0;
  for (let i = 0; i < SIGNALS.length; i += 2) {
    const roads = junctionRoads(SIGNALS[i], SIGNALS[i + 1]);
    if (!roads.length) none++;
    if (roads.some((r) => r.name === 'George Street')) george++;
  }
  assert.ok(none < SIGNALS.length / 2 / 20, `${none} signals with no street`);
  assert.ok(george > 3 && george < SIGNALS.length / 4, `George St at ${george} of ${SIGNALS.length / 2} signals`);
});

test('tunnels and ramps are not named at a street corner', () => {
  for (let i = 0; i < SIGNALS.length; i += 2) {
    for (const r of junctionRoads(SIGNALS[i], SIGNALS[i + 1])) assert.ok(!/(ramp|tunnel)\b/i.test(r.name), r.name);
  }
});

test('a blade runs parallel to the road it names, reaching towards the junction', () => {
  const roads = [{ short: 'George St', ux: 0, uz: 1 }, { short: 'Market St', ux: 1, uz: 0 }, { short: 'Third St', ux: 1, uz: 1 }];
  const blades = bladesOnPole(roads, 10, 10, 0, 0, 4.65);
  assert.equal(blades.length, 2);
  assert.equal(blades[0].text, 'George St');
  assert.ok(blades[0].z < 10 && blades[0].x === 10);
  // The blade's local x axis after turning by yaw is (cos yaw, -sin yaw): along the road
  assert.ok(Math.abs(Math.cos(blades[0].yaw)) < 1e-9 && Math.abs(Math.abs(Math.sin(blades[0].yaw)) - 1) < 1e-9);
  assert.ok(blades[1].y < blades[0].y, 'the second blade hangs under the first');
  assert.ok(blades[1].x < 10);
});

test('the sign texture keeps names in use and replaces the longest unused', () => {
  const drawn = [];
  const atlas = new SignAtlas(2, (cell, text) => drawn.push([cell, text]));
  atlas.begin();
  const a = atlas.cellFor('A');
  const b = atlas.cellFor('B');
  assert.notEqual(a, b);
  assert.equal(atlas.cellFor('C'), -1, 'nothing to spare while both are wanted this round');
  atlas.begin();
  assert.equal(atlas.cellFor('A'), a);
  assert.equal(atlas.drawn, false);
  assert.equal(atlas.cellFor('C'), b, 'B has not been wanted for longest');
  assert.equal(atlas.drawn, true);
  assert.deepEqual(drawn.at(-1), [b, 'C']);
});
