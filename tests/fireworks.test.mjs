import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import { landAt } from '../js/city-config.js';
import { bridgeOutline } from '../js/harbour-bridge.js';
import { KINDS, LEVELS, MODE, createFireworks, sparkPath, sparksOf } from '../js/fireworks.js';
import { BARGES, COLOURS, DARLING, LOOP, ROOFTOPS, cuesBetween, firingPlaces, lookAt, newYearOf, pack, showCues, unpack } from '../js/firework-show.js';
import { bakeFireworkSounds } from '../js/firework-sound-bake.js';
import { cutoff, delayOf, loudness } from '../js/firework-sound.js';

// New Year's fireworks (js/season-new-year.js): where they're fired from and the show's script (js/firework-show.js), the shells in their
// ring and the brightest bursts (js/fireworks.js), the sounds (js/firework-sound-bake.js, js/firework-sound.js), and the season itself:
// nothing made until it's midnight, and nothing of it drawn at any other time of day.

const outline = bridgeOutline();
const places = firingPlaces(outline);
const cues = showCues(places);

test('the firing places: the barges on the water, the rooftops on land, the bridge\'s on the bridge', () => {
  for (const b of [...BARGES, DARLING]) {
    // The barge and the water round it, 25 m each way
    for (const [dx, dz] of [[0, 0], [25, 0], [-25, 0], [0, 25], [0, -25]]) assert.ok(!landAt(b.x + dx, b.z + dz), `${b.id} at (${b.x + dx}, ${b.z + dz}) on land`);
  }
  for (const r of ROOFTOPS) assert.ok(landAt(r.x, r.z) && r.y > 200, `${r.id}'s roof`);
  assert.equal(places.barges.length, 5);
  assert.equal(places.platforms.length, 3);
  assert.equal(places.rooftops.length, 4);
  // The arch's top near its crown, the deck's sides at its height, the waterfall the whole span under the arch
  assert.ok(places.arch.length >= 20 && places.arch.every((p) => p.y > 100 && p.y < outline.crown + 4), 'the arch\'s places');
  assert.ok(places.west.length >= 10 && places.west.every((p) => p.y > 45 && p.y < 58), 'the deck\'s west side');
  assert.ok(places.deck.length >= 15 && places.deck.every((p) => p.y > 45 && p.y < 58), 'the deck\'s fountains');
  assert.ok(Math.abs(places.waterfall.length - 500) < 20, `the waterfall is ${places.waterfall.length} m long`);
  // The message's faces: the two east pylons, facing east
  assert.equal(outline.faces.length, 2);
  for (const f of outline.faces) assert.ok(f.normal[0] > 0.9 && f.deck > 45 && f.top > 80, JSON.stringify(f));
  assert.ok(outline.faces[0].z > outline.faces[1].z, 'the south pylon first');
});

test('the show: six minutes of cues, every one a kind and two colours, busiest in the finale', () => {
  assert.ok(cues.length > 800, `${cues.length} cues`);
  for (let i = 1; i < cues.length; i++) assert.ok(cues[i].t >= cues[i - 1].t, 'in order');
  for (const cue of cues) {
    assert.ok(cue.t >= 0 && cue.t < LOOP, `at ${cue.t}`);
    assert.ok(KINDS[cue.kind], cue.kind);
    for (const c of cue.colours) assert.ok(Number.isInteger(c) && c >= 0 && c < 2 ** 24);
    assert.ok(cue.to[1] >= cue.from[1], 'bursts above where it was fired');
    assert.ok(cue.keep > 0 && cue.keep <= 1);
    if (KINDS[cue.kind].mode === MODE.curtain) assert.ok(cue.life > 30 && cue.p2 > 80, 'a waterfall lasts and is long');
  }
  const between = (a, b) => cues.filter((c) => c.t >= a && c.t < b).length;
  assert.ok(between(270, 300) > 3 * between(180, 210), `the finale ${between(270, 300)} cues in 30 s, the quiet part ${between(180, 210)}`);
  assert.equal(between(340, 360), 0, 'a breath before it goes round again');
  // Every firing place used
  const fromPlace = (p) => cues.some((c) => Math.hypot(c.from[0] - p.x, c.from[2] - p.z) < 1);
  for (const p of [...places.barges, places.darling, ...places.platforms, ...places.rooftops]) assert.ok(fromPlace(p), p.id);
  assert.ok(places.west.some(fromPlace) && places.arch.some(fromPlace) && places.deck.some(fromPlace), 'the bridge\'s');
  // The same show every time
  assert.deepEqual(showCues(places).slice(0, 20), cues.slice(0, 20));
});

test('the cues between two times on the show\'s clock, round the loop\'s end', () => {
  const at = (a, b) => cuesBetween(cues, a, b);
  assert.deepEqual(at(10, 20), cues.filter((c) => c.t > 10 && c.t <= 20));
  // Across the loop's end, and the same a whole loop later
  const round = at(LOOP - 5, LOOP + 5);
  assert.deepEqual(round, cues.filter((c) => c.t > LOOP - 5 || c.t <= 5));
  assert.deepEqual(at(LOOP * 3 + 10, LOOP * 3 + 20), at(10, 20));
  assert.equal(at(0, LOOP * 2).length, cues.length);
});

test('the message\'s year, and the show\'s colours', () => {
  assert.equal(newYearOf({ y: 2026, m: 12, d: 27 }), 2027);
  assert.equal(newYearOf({ y: 2026, m: 12, d: 31 }), 2027);
  assert.equal(newYearOf({ y: 2027, m: 1, d: 1 }), 2027);
  assert.equal(newYearOf({ y: 2027, m: 1, d: 15 }), 2027);
  assert.deepEqual(unpack(pack(COLOURS.pink)), COLOURS.pink);
  for (let t = -10; t < LOOP + 10; t += 0.7) {
    for (const c of lookAt(t)) assert.ok(c.length === 3 && c.every((v) => v >= 0 && v <= 1), `${t}: ${c}`);
  }
  assert.deepEqual(lookAt(5), lookAt(5 + LOOP));
});

test('a spark\'s path: gravity and drag in closed form, as stepped through in small steps', () => {
  for (const [drag, gravity] of [[1.3, 9.81], [0.5, 9.81], [2.1, 5]]) {
    let x = 0, y = 0, vx = 60, vy = 40;
    const dt = 1e-4;
    for (let t = 0; t < 2; t += dt) {
      vx += -drag * vx * dt;
      vy += (-drag * vy - gravity) * dt;
      x += vx * dt;
      y += vy * dt;
    }
    const p = sparkPath(0, 0, 0, 60, 40, 0, drag, gravity, 2);
    assert.ok(Math.abs(p.x - x) < 0.05 && Math.abs(p.y - y) < 0.05, `${drag}: (${p.x}, ${p.y}) against (${x}, ${y})`);
    assert.ok(Math.abs(p.vx - vx) < 0.05 && Math.abs(p.vy - vy) < 0.05);
  }
  // Long after, falling at the air's terminal speed
  const late = sparkPath(0, 0, 0, 0, 0, 0, 2, 9.81, 30);
  assert.ok(Math.abs(late.vy + 9.81 / 2) < 1e-6);
});

test('the shells\' ring: a shell written once into its slot, slots taken again once burnt out, fewer kept on a lower level', () => {
  const fw = createFireworks({ level: 'medium' });
  const cue = cues.find((c) => c.kind === 'chrysanthemum');
  assert.ok(fw.launch(cue, 100));
  assert.equal(fw.slots.filter(Boolean).length, 1);
  const s = fw.slots.find(Boolean);
  assert.equal(s.burst, 100 + cue.rise);
  assert.equal(s.speed, cue.size * KINDS.chrysanthemum.drag);
  // Burning: among the brightest, where it burst
  const now = s.burst + 0.5;
  const [first] = fw.brightest(now);
  assert.ok(first && Math.hypot(first.x - cue.to[0], first.z - cue.to[2]) < 1, JSON.stringify(first));
  assert.equal(fw.brightest(s.burst + KINDS.chrysanthemum.life + 0.1).length, 0, 'burnt out');
  // Full: the fountains left out first, the shells while there's room
  const many = createFireworks({ level: 'low' });
  const fountain = cues.find((c) => c.kind === 'comet');
  let shells = 0, fountains = 0;
  for (let k = 0; k < LEVELS.low.shells; k++) {
    if (many.launch(fountain, 200)) fountains++;
    if (many.launch(cue, 200)) shells++;
  }
  assert.ok(fountains < shells && shells + fountains <= LEVELS.low.shells, `${fountains} fountains, ${shells} shells`);
  // ...and the slots taken again once those have burnt out
  assert.ok(many.launch(cue, 260));
  // Each level draws less than the next
  for (const [a, b] of [['low', 'medium'], ['medium', 'high']]) {
    assert.ok(LEVELS[a].shells * LEVELS[a].sparks * (LEVELS[a].trail + 1) < LEVELS[b].shells * LEVELS[b].sparks * (LEVELS[b].trail + 1));
  }
  assert.equal(sparksOf(KINDS.peony, 220), 220);
  assert.equal(sparksOf(KINDS.palm, 220), 22);
  assert.equal(sparksOf(KINDS.palm, 10), 10);
});

test('a shell\'s numbers reach the GPU once, and the clock stays small', () => {
  const fw = createFireworks({ level: 'low' });
  fw.show();
  const sparks = fw.group.children.find((m) => m.name === 'FireworkSparks');
  const A = sparks.geometry.attributes.aShellA;
  const cue = cues.find((c) => c.kind === 'peony');
  fw.launch(cue, 10);
  const slot = fw.slots.findIndex(Boolean);
  assert.deepEqual(A.updateRanges, [{ start: slot * 4, count: 4 }]);
  assert.ok(Math.abs(A.array[slot * 4 + 3] - (10 + cue.rise)) < 1e-4);
  // Every half hour of the show's clock its slots are written again from a later start
  fw.update(5000, { x: 0, z: 0 });
  assert.ok(fw.u.now.value < 1800, `the shader's clock at ${fw.u.now.value}`);
  assert.ok(Math.abs(A.array[slot * 4 + 3] - (10 + cue.rise - 3600)) < 1e-3);
  fw.dispose();
});

test('the sounds: baked at 48 kHz, whole in themselves for a worker, heard later and duller the further off', () => {
  const sounds = bakeFireworkSounds(48000);
  assert.equal(sounds.rate, 48000);
  for (const [name, count] of [['boom', 3], ['crackle', 2], ['whistle', 2], ['thump', 1], ['hiss', 1]]) {
    assert.equal(sounds[name].length, count, name);
    for (const s of sounds[name]) {
      assert.ok(s instanceof Float32Array && s.length > 48000 * 0.5, name);
      let peak = 0;
      for (const v of s) {
        assert.ok(Number.isFinite(v));
        peak = Math.max(peak, Math.abs(v));
      }
      assert.ok(peak > 0.3 && peak <= 0.81, `${name}'s peak ${peak}`);
    }
  }
  // A boom is low: its samples change slowly next to a crackle's
  const roughness = (s) => {
    let d = 0, e = 0;
    for (let i = 1; i < s.length; i++) {
      d += (s[i] - s[i - 1]) ** 2;
      e += s[i] ** 2;
    }
    return d / e;
  };
  assert.ok(roughness(sounds.boom[0]) * 20 < roughness(sounds.crackle[0]));
  // Its own source, with nothing from outside it, makes the same sounds
  const again = new Function(`return (${bakeFireworkSounds.toString()})`)()(8000);
  assert.equal(again.boom[0].length, Math.ceil(8000 * 3.4));
  // 343 m/s; quieter and duller further off
  assert.equal(delayOf(343), 1);
  assert.equal(delayOf(686, 0.5), 1.5);
  assert.equal(delayOf(100, 2), 0);
  assert.ok(loudness(200) === 1 && loudness(500) > loudness(1500) && loudness(1500) > loudness(4000));
  assert.ok(cutoff(300) > cutoff(1500) && cutoff(5000) > 600);
});

test('the season: nothing made until midnight, drawn only at midnight, the sea and the sails given back', async () => {
  globalThis.document ??= {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({ createLinearGradient: () => ({ addColorStop() {} }), fillRect() {}, strokeRect() {}, fillText() {} })
    })
  };
  const { start } = await import('../js/season-new-year.js');
  let look = 'golden';
  const revealed = [], removed = [], compiled = [];
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardNodeMaterial());
  const sails = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardNodeMaterial());
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(1100, 6, -1700);
  const seaOwn = sea.material, sailsOwn = sails.material;
  const ctx = {
    season: 'new-year', date: { y: 2026, m: 12, d: 31 }, quality: { level: 'low' }, origin: { x: 0, z: 0 },
    look: () => look, camera: () => camera,
    reveal: async (group) => revealed.push(group), remove: (group) => removed.push(group),
    compile: async (objects) => compiled.push(...objects),
    harbour: { sea: () => sea, sails: () => sails, bridge: bridgeOutline },
    sound: { context: () => null, output: () => null, live: () => false, voices: 5 }
  };
  const season = await start(ctx);
  const run = async () => {
    const work = season.work(0, 0);
    for (let step = work.next(); !step.done; step = work.next()) await step.value;
  };
  // Golden: nothing to do, nothing made
  season.update(0.016, 10);
  await run();
  assert.equal(season.state().ready, false);
  assert.equal(revealed.length, 0);
  // Midnight: made, revealed, the sea's and sails' copies compiled; then the show's on
  look = 'midnight';
  season.update(0.016, 11);
  await run();
  assert.equal(season.state().ready, true);
  assert.equal(revealed.length, 1);
  assert.equal(compiled.length, 2);
  season.update(0.016, 12);
  const on = season.state();
  assert.ok(on.active && revealed[0].visible && on.year === 2027, JSON.stringify(on));
  assert.ok(sea.material !== seaOwn && sails.material !== sailsOwn, 'the show\'s sea and sails');
  season.debug({ at: 290 });
  season.update(0.016, 13);
  assert.ok(season.state().shells.live > 10, JSON.stringify(season.state().shells));
  // Back to golden: hidden, and the sea and sails as they were
  look = 'golden';
  season.update(0.016, 14);
  assert.ok(!season.state().active && !revealed[0].visible);
  assert.ok(sea.material === seaOwn && sails.material === sailsOwn);
  season.stop();
  assert.equal(removed[0], revealed[0]);
});

test('the cues between two times are those a walk through all of them finds, in their order, anywhere in the loop', () => {
  const walk = (a0, b0) => {
    const a = ((a0 % LOOP) + LOOP) % LOOP, b = a + (b0 - a0);
    return cues.filter((c) => (c.t > a && c.t <= b) || (b > LOOP && c.t + LOOP > a && c.t + LOOP <= b));
  };
  let seed = 3;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 3000; k++) {
    const from = random() * LOOP * 4 - LOOP, to = from + random() * (k % 10 === 0 ? 40 : 0.1);
    assert.deepEqual(cuesBetween(cues, from, to), walk(from, to), `from ${from} to ${to}`);
  }
  // ...and at a cue's own time, either side of it
  for (const c of cues.slice(0, 200)) {
    assert.deepEqual(cuesBetween(cues, c.t - 0.05, c.t), walk(c.t - 0.05, c.t));
    assert.deepEqual(cuesBetween(cues, c.t, c.t + 0.05), walk(c.t, c.t + 0.05));
  }
});
