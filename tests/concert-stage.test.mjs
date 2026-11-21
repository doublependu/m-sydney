import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import zlib from 'node:zlib';
import { arrange } from '../js/concert-arranger.js';
import { STAGE } from '../js/concert-sound.js';
import { FINGERING, handAt, handPlan, isBlack, keyAlong, valvesFor, whitesBelow } from '../js/concert-stage.js';

// The concert's stage (js/concert-stage.js): the performers' model (public/models/opera-house-concert, built by tools/models/
// opera_concert.py in the models' repo), the piano's keys, the trumpet's fingering and the pianist's hands, over the arranger's scores.

const data = JSON.parse(fs.readFileSync(new URL('../public/models/opera-house-concert.json', import.meta.url), 'utf8'));
function gltf(name) {
  const bytes = zlib.gunzipSync(fs.readFileSync(new URL(`../public/models/${name}.glb.gz`, import.meta.url)));
  const length = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + length).toString('utf8'));
}
const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);
const scores = SEEDS.map((seed) => arrange(seed));

test('the model has every part the game moves, and is small: under 15,000 triangles with its keys, and a small file', () => {
  const g = gltf('opera-house-concert');
  const names = new Set(g.nodes.map((n) => n.name));
  for (const b of data.robot.bones) assert.ok(names.has(b.node), b.node);
  for (const n of ['body', 'key_white', 'key_black', 'trumpet', 'valve_1', 'valve_2', 'valve_3']) assert.ok(names.has(n), n);
  // every bone's parent is a bone before it
  data.robot.bones.forEach((b, i) => assert.ok(b.parent === null || data.robot.bones.slice(0, i).some((p) => p.name === b.parent), b.name));
  const tris = (node) => {
    const mesh = g.nodes.filter((n) => n.name.startsWith(`${node}-`)).map((n) => g.meshes[n.mesh]);
    return mesh.flatMap((m) => m.primitives).reduce((sum, p) => sum + g.accessors[p.indices].count / 3, 0);
  };
  const all = g.meshes.flatMap((m) => m.primitives).reduce((sum, p) => sum + g.accessors[p.indices].count / 3, 0);
  const keys = 52 * tris('key_white') + 36 * tris('key_black');
  // the trumpeter's rig, near: 3,434
  assert.ok(all - tris('key_white') - tris('key_black') + keys + 3434 < 15000, `${all} triangles, ${keys} in the keys`);
  assert.ok(fs.statSync(new URL('../public/models/opera-house-concert.glb.gz', import.meta.url)).size < 60000);
});

test('the sound comes from where the model has the piano and the trumpeter', () => {
  assert.deepEqual(STAGE.piano, data.sound.piano);
  assert.deepEqual(STAGE.trumpet, data.sound.trumpet);
  assert.equal(STAGE.floor, data.stage.floor);
});

test('88 keys, 52 white and 36 black, in order along the keyboard and within it', () => {
  const { low, high, white } = data.keyboard;
  assert.equal(high - low + 1, 88);
  const keys = Array.from({ length: 88 }, (_, i) => low + i);
  assert.equal(keys.filter((p) => !isBlack(p)).length, 52);
  assert.equal(whitesBelow(108), 51);
  let last = -Infinity;
  for (const p of keys) {
    const a = keyAlong(p, white);
    assert.ok(a > last && a > 0 && a < 52 * white, `${p} at ${a}`);
    last = a;
  }
  // middle C is the 24th white key
  assert.ok(Math.abs(keyAlong(60, white) - 23.5 * white) < 1e-9);
});

test('every trumpet note has its fingering: the written note a tone up, as a B-flat trumpet is fingered', () => {
  for (const s of scores) {
    for (const n of s.notes) if (n.i === 'trumpet') assert.ok(FINGERING[n.p + 2] !== undefined, `seed ${s.seed}: ${n.p}`);
  }
  // concert B-flat is its open C; concert C its D (first and third); concert A-flat its B-flat (first); concert C-sharp its D-sharp
  // (second and third); concert B, low, its C-sharp (all three)
  assert.deepEqual(valvesFor(70), [false, false, false]);
  assert.deepEqual(valvesFor(60), [true, false, true]);
  assert.deepEqual(valvesFor(68), [true, false, false]);
  assert.deepEqual(valvesFor(61), [false, true, true]);
  assert.deepEqual(valvesFor(59), [true, true, true]);
});

test('each of the pianist\'s hands is at its keys as it strikes them, and never moves faster than a hand can', () => {
  for (const s of scores.slice(0, 60)) {
    const plan = handPlan(s, data.keyboard);
    for (const h of ['l', 'r']) {
      const strikes = plan[h];
      assert.ok(strikes.length > 20, `seed ${s.seed}: the ${h} hand strikes ${strikes.length} times`);
      let k = -1;
      for (const strike of strikes) {
        const at = handAt(strikes, strike.t + 0.001, k);
        k = at.k;
        assert.ok(Math.abs(at.along - strike.along) < 0.003, `seed ${s.seed} ${h} at ${strike.t}: ${at.along} for ${strike.along}`);
        assert.ok(at.lift < 0.02, `lifted ${at.lift} as it strikes`);
      }
      // along the whole performance at 60 frames a second: no jump of over 20 cm a frame (12 m/s; its quickest leaps, a chord to a run
      // up an octave or two an eighth later, are 7 m/s at their fastest)
      let was = null;
      k = -1;
      for (let t = 0; t < s.duration; t += 1 / 60) {
        const at = handAt(strikes, t, k);
        k = at.k;
        if (was !== null && at.along !== null) assert.ok(Math.abs(at.along - was) < 0.2, `seed ${s.seed} ${h} at ${t.toFixed(2)}: ${Math.abs(at.along - was)}`);
        was = at.along;
      }
    }
  }
});

test('the pianist\'s hands stay within its arms\' reach of its seat on the bench', () => {
  const bone = (n) => data.robot.bones.find((b) => b.name === n).at;
  const reach = Math.hypot(...bone('upper_l').map((c, i) => c - bone('fore_l')[i])) + Math.hypot(...bone('fore_l').map((c, i) => c - bone('hand_l')[i]));
  const { bench } = data.robot;
  const kb = data.keyboard;
  // seated, leaning in a little: its shoulders over the bench's front, the keys' tops a hand's length beyond its wrists
  const f = [Math.sin(bench.facing), Math.cos(bench.facing)], left = [Math.cos(bench.facing), -Math.sin(bench.facing)];
  const up = bone('upper_l')[1] - bone('pelvis')[1] + bench.top + 0.065 + (bone('pelvis')[1] - bone('thigh_l')[1]);
  let worst = 0, over = 0, all = 0;
  for (const s of scores) {
    const plan = handPlan(s, kb);
    for (const [h, side] of [['l', 1], ['r', -1]]) {
      for (const strike of plan[h]) {
        const sh = [bench.at[0] + f[0] * 0.12 + left[0] * side * 0.205, up - 0.02, bench.at[1] + f[1] * 0.12 + left[1] * side * 0.205];
        const tip = [kb.start[0] + kb.along[0] * strike.along - kb.out[0] * strike.depth, kb.start[1], kb.start[2] + kb.along[2] * strike.along - kb.out[2] * strike.depth];
        const wrist = [tip[0] + kb.out[0] * 0.16 * Math.cos(0.55), tip[1] + 0.16 * Math.sin(0.55), tip[2] + kb.out[2] * 0.16 * Math.cos(0.55)];
        const d = Math.hypot(wrist[0] - sh[0], wrist[1] - sh[1], wrist[2] - sh[2]);
        worst = Math.max(worst, d - reach);
        all++;
        // its body turns towards its hands and leans to the side, about 0.1 m at the shoulder
        if (d > reach + 0.1) over++;
      }
    }
  }
  assert.ok(over / all < 0.002, `${over} of ${all} strikes out of reach, the worst ${worst.toFixed(3)} m beyond ${reach.toFixed(3)}`);
});
