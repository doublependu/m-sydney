import assert from 'node:assert/strict';
import test from 'node:test';
import { RANGES as RENDERED } from '../js/audio-instruments.js';
import { RANGES, TUNE, arrange, nextAfter, placeAt, soundingAt } from '../js/concert-arranger.js';

// The concert's arranger (js/concert-arranger.js) makes a new Waltzing Matilda duet for piano and trumpet from each seed. Its rules,
// over 200 seeds: every note in its instrument's range; both playing in every section, neither silent for more than two bars; the
// piano out of the trumpet's band while the trumpet sounds; 3.5-4.5 minutes; the same seed, the same score. And fast: well under a
// second, in the worker, while the notes render.

const SEEDS = Array.from({ length: 200 }, (_, k) => (k * 2654435761 + 12345) >>> 0);
const scores = SEEDS.map((seed) => arrange(seed));

test('the tune: Waltzing Matilda in B♭, verse and chorus, 16 bars and a pickup', () => {
  assert.equal(TUNE[0].b, -1, 'the pickup ("Once a") is the beat before the first bar');
  assert.equal(Math.max(...TUNE.map((n) => n.b + n.d)), 64);
  const pcs = new Set(TUNE.map((n) => ((n.p % 12) + 12) % 12));
  for (const pc of pcs) assert.ok([10, 0, 2, 3, 5, 7, 9].includes(pc), `pitch class ${pc} isn't in B♭ major`);
  assert.equal(TUNE[TUNE.length - 1].p % 12, 10, 'it ends on B♭');
});

test('every note is in its instrument\'s range, which the instruments render', () => {
  assert.ok(RANGES.piano[0] >= RENDERED.piano[0] && RANGES.piano[1] <= RENDERED.piano[1]);
  assert.ok(RANGES.trumpet[0] >= RENDERED.trumpet[0] && RANGES.trumpet[1] <= RENDERED.trumpet[1]);
  for (const s of scores) {
    for (const n of s.notes) {
      const [lo, hi] = RANGES[n.i];
      assert.ok(n.p >= lo && n.p <= hi, `seed ${s.seed}: ${n.i} ${n.p} at ${n.t}`);
      assert.ok(n.d > 0 && Number.isFinite(n.t) && n.v > 0 && n.v <= 1, `seed ${s.seed}: a note at ${n.t}`);
    }
  }
});

test('both play in every section, neither silent for more than two bars', () => {
  for (const s of scores) {
    s.sections.forEach((sec, k) => {
      const bar = sec.meter * 60 / sec.bpm;
      for (const i of ['piano', 'trumpet']) {
        const mine = s.notes.filter((n) => n.i === i && n.t < sec.end && n.t + n.d > sec.start);
        assert.ok(mine.length, `seed ${s.seed}: no ${i} in the ${sec.kind}`);
        let from = sec.start;
        for (const n of mine) {
          // the coda's ritardando stretches its bars: measured at its slowest
          const most = 2 * bar * (sec.kind === 'coda' ? 1 / 0.55 : 1) + 0.01;
          assert.ok(n.t - from <= most, `seed ${s.seed}: ${i} silent ${(n.t - from).toFixed(2)} s from ${from.toFixed(2)} in the ${sec.kind} (${k})`);
          from = Math.max(from, n.t + n.d);
        }
        if (sec.kind !== 'coda') assert.ok(sec.end - from <= 2 * bar + 0.01, `seed ${s.seed}: ${i} silent at the end of the ${sec.kind}`);
      }
    });
  }
});

test('while the trumpet sounds, the piano keeps out of its band', () => {
  for (const s of scores) {
    const parts = s.sections.flatMap((sec) => sec.parts);
    const partAt = (t) => parts.find((p) => t >= p.start - 1e-6 && t < p.end) ?? parts[parts.length - 1];
    const piano = s.notes.filter((n) => n.i === 'piano');
    for (const t of s.notes.filter((n) => n.i === 'trumpet')) {
      const [lo, hi] = partAt(t.t).trumpet;
      assert.ok(hi - lo >= 4, `seed ${s.seed}: a band of ${hi - lo + 1}`);
      assert.ok(t.p >= lo && t.p <= hi, `seed ${s.seed}: the trumpet's ${t.p} at ${t.t} outside its band ${lo}-${hi}`);
      for (const p of piano) {
        if (p.t >= t.t + t.d - 1e-3 || t.t >= p.t + p.d - 1e-3) continue;
        assert.ok(p.p < lo || p.p > hi, `seed ${s.seed}: piano ${p.p} (${p.role}) at ${p.t} in the trumpet's band ${lo}-${hi} while it plays ${t.p} at ${t.t}`);
      }
    }
    // and one note at a time on the trumpet, which breathes: no phrase of it longer than 16 s
    const horn = s.notes.filter((n) => n.i === 'trumpet');
    for (let k = 1; k < horn.length; k++) assert.ok(horn[k].t >= horn[k - 1].t + horn[k - 1].d - 1e-3, `seed ${s.seed}: two trumpet notes at ${horn[k].t}`);
    for (const p of s.phrases.filter((x) => x.i === 'trumpet')) assert.ok(p.end - p.start < 16, `seed ${s.seed}: the trumpet plays ${(p.end - p.start).toFixed(1)} s from ${p.start} without a breath`);
  }
});

test('each of the pianist\'s hands within its reach: the notes it holds at once within a tenth and a bit', () => {
  for (const s of scores.slice(0, 60)) {
    for (const hand of ['l', 'r']) {
      const mine = s.notes.filter((n) => n.i === 'piano' && n.hand === hand);
      for (const n of mine) {
        const held = mine.filter((m) => m.t <= n.t + 0.03 && m.t + m.d > n.t + 0.03).map((m) => m.p);
        if (held.length) assert.ok(Math.max(...held) - Math.min(...held) <= 17, `seed ${s.seed}: the ${hand} hand holds ${held} at ${n.t}`);
      }
    }
  }
});

test('3.5 to 4.5 minutes, the form as the seed picks it', () => {
  const kinds = new Set();
  const orders = new Set();
  for (const s of scores) {
    assert.ok(s.duration >= 210 && s.duration <= 270, `seed ${s.seed}: ${s.duration.toFixed(1)} s`);
    const names = s.sections.map((sec) => sec.kind);
    assert.equal(names[0], 'intro');
    assert.ok(['head', 'waltz'].includes(names[1]), `seed ${s.seed}: starts with ${names[1]}`);
    assert.deepEqual(names.slice(-2), ['out', 'coda'], `seed ${s.seed}: ends ${names.slice(-2)}`);
    const middle = names.slice(2, -2);
    assert.ok(middle.length >= 2 && middle.length <= 3, `seed ${s.seed}: ${middle}`);
    for (let k = 1; k < names.length; k++) assert.notEqual(names[k], names[k - 1], `seed ${s.seed}: ${names[k]} twice running`);
    for (const k of middle) kinds.add(k);
    orders.add(s.sections.map((sec) => `${sec.kind}${sec.parts.length}`).join(' '));
    // sections one after another, and the leads swapping from chorus to chorus
    for (let k = 1; k < s.sections.length; k++) assert.ok(Math.abs(s.sections[k].start - s.sections[k - 1].end) < 1e-3);
    const leads = s.sections.flatMap((sec) => sec.parts).filter((p) => p.mode === 'fills' || p.mode === 'counter' || p.mode === 'answers').map((p) => p.lead);
    let swaps = 0;
    for (let k = 1; k < leads.length; k++) swaps += leads[k] !== leads[k - 1];
    assert.ok(swaps >= leads.length - 1 - 1, `seed ${s.seed}: the lead swapped ${swaps} times in ${leads.length} choruses`);
    assert.ok(leads.includes('trumpet') && leads.includes('piano'), `seed ${s.seed}: one lead all through`);
  }
  assert.deepEqual([...kinds].sort(), ['ballad', 'swing', 'waltz']);
  assert.ok(orders.size > 20, `only ${orders.size} forms in 200 seeds`);
});

test('a conversation: answers, counter-lines and fills, and trading where they swing', () => {
  let trades = 0;
  for (const s of scores) {
    const roles = new Set(s.notes.map((n) => `${n.i}:${n.role}`));
    assert.ok(roles.has('trumpet:melody') && roles.has('piano:melody'), `seed ${s.seed}: both carry the tune`);
    assert.ok(roles.has('trumpet:counter') || roles.has('trumpet:answer'), `seed ${s.seed}: the trumpet never answers`);
    assert.ok(roles.has('piano:comp') && roles.has('piano:bass'));
    const swing = s.sections.find((sec) => sec.kind === 'swing' && sec.parts.some((p) => p.mode === 'trade'));
    if (!swing) continue;
    trades++;
    // each traded phrase starts on or near the note the other's ended on
    const traded = s.notes.filter((n) => n.role === 'trade' && n.t >= swing.start && n.t < swing.end);
    for (const part of swing.parts.filter((p) => p.mode === 'trade').slice(1)) {
      const before = traded.filter((n) => n.t < part.start - 1e-3).pop();
      const first = traded.find((n) => n.t >= part.start - 1e-3);
      if (!before || !first || before.i === first.i) continue;
      assert.ok(Math.abs(first.p - before.p) <= 7 || Math.abs(Math.abs(first.p - before.p) - 12) <= 7, `seed ${s.seed}: a trade from ${before.p} to ${first.p}`);
      assert.ok(first.t >= before.t + before.d - 0.02, `seed ${s.seed}: a trade over the other's last note`);
    }
  }
  assert.ok(trades > 40, `only ${trades} of 200 trade`);
});

test('the same seed, the same score; another seed, another', () => {
  for (const seed of SEEDS.slice(0, 20)) assert.deepEqual(arrange(seed), scores[SEEDS.indexOf(seed)]);
  assert.notDeepEqual(scores[0].notes, scores[1].notes);
  const firsts = new Set(scores.map((s) => s.notes.slice(0, 40).map((n) => n.p).join()));
  assert.ok(firsts.size > 150, `only ${firsts.size} different openings`);
});

test('fast: well under a second a score', () => {
  const t0 = performance.now();
  for (let k = 0; k < 20; k++) arrange(1000 + k);
  const each = (performance.now() - t0) / 20;
  assert.ok(each < 100, `${each.toFixed(1)} ms a score`);
});

test('the score\'s beats, phrases, and asking it what\'s sounding', () => {
  const s = scores[0];
  for (let k = 1; k < s.beats.length; k++) assert.ok(s.beats[k].t > s.beats[k - 1].t);
  assert.ok(s.beats.every((b) => b.beat < s.sections[b.s].meter));
  for (let k = 1; k < s.notes.length; k++) assert.ok(s.notes[k].t >= s.notes[k - 1].t);
  assert.ok(s.phrases.some((p) => p.i === 'trumpet') && s.phrases.some((p) => p.i === 'piano'));
  const n = s.notes.find((x) => x.i === 'trumpet' && x.d > 0.3);
  assert.ok(soundingAt(s, 'trumpet', n.t + 0.1).includes(n));
  const next = nextAfter(s, 'trumpet', n.t - 0.01);
  assert.ok(next.includes(n));
  const place = placeAt(s, n.t + 0.01, 'trumpet');
  assert.ok(place.section && place.part && place.beat && place.phrase);
  assert.ok(place.phrase.start <= n.t && place.phrase.end >= n.t);
});
