import assert from 'node:assert/strict';
import test from 'node:test';
import { EASE, easeProfile, easeRoads, gradeChange } from '../tools/heights/ease-profiles.mjs';

// Roads' profiles eased where their grade changes sharply (tools/heights/ease-profiles.mjs, run by tools/build-heights.mjs)
const profile = (length, at) => {
  const s = [], y = [];
  for (let d = 0; d <= length; d += 5) { s.push(d); y.push(at(d)); }
  return { s: Float64Array.from(s), y: Float64Array.from(y), lo: new Float64Array(s.length).fill(-Infinity), hi: new Float64Array(s.length).fill(Infinity), locked: new Uint8Array(s.length) };
};
const worst = (p) => Math.max(...Array.from(p.s, (_, i) => gradeChange(p.s, p.y, i)));
const index = (p, d) => p.s.indexOf(d);

test('a ramp meeting a flat stretch is eased over a length that grows with the change, and nowhere else', () => {
  for (const grade of [0.05, 0.08, 0.12]) {
    const p = profile(400, (d) => (d < 200 ? 10 + grade * (200 - d) : 10)); // down into the flat: a sag
    const before = p.y.slice();
    assert.ok(worst(p) > grade - 1e-9);
    const curves = easeProfile(p.s, p.y, p.lo, p.hi, p.locked);
    assert.equal(curves.length, 1);
    assert.ok(worst(p) < 0.025, `${grade}: ${worst(p)} left`);
    // The curve's own length, PER_GRADE m for each 1% of change, and the road as it was either side of it
    const half = (EASE.PER_GRADE * grade * 100) / 2;
    p.s.forEach((d, i) => {
      if (Math.abs(d - 200) >= half) assert.equal(p.y[i], before[i], `${grade}: moved at ${d} m`);
    });
    assert.ok(p.y.some((v, i) => v !== before[i]));
    // A sag rises, never sinks below the lines it eases
    p.y.forEach((v, i) => assert.ok(v >= before[i] - 1e-9));
  }
});

test('a fixed point and the ends stay as they were, and the curve is kept off them', () => {
  const p = profile(300, (d) => (d < 150 ? 20 - 0.08 * (150 - d) : 20));
  const fixed = index(p, 160);
  p.locked[fixed] = 1;
  const before = p.y.slice();
  easeProfile(p.s, p.y, p.lo, p.hi, p.locked);
  assert.equal(p.y[fixed], before[fixed]);
  assert.equal(p.y[0], before[0]);
  assert.equal(p.y[p.y.length - 1], before[before.length - 1]);
  p.s.forEach((d, i) => { if (d >= 160 || d <= 140) assert.equal(p.y[i], before[i], `moved at ${d} m`); });
  assert.ok(gradeChange(p.s, p.y, index(p, 150)) < 0.08 - 0.01, 'eased what room there was');
});

const steepest = (p) => Math.max(...Array.from(p.s, (_, i) => (i ? Math.abs(p.y[i] - p.y[i - 1]) / (p.s[i] - p.s[i - 1]) : 0)));

test('a crest held up by a clearance is rounded by rising round its top, never under the road as it was', () => {
  // A bridge's hump over a road: up at 8%, down at 8%, its top held at 8 m by the clearance over the road under it
  const p = profile(400, (d) => Math.max(0, 8 - 0.08 * Math.abs(d - 200)));
  for (const d of [195, 200, 205]) p.lo[index(p, d)] = p.y[index(p, d)];
  const before = p.y.slice();
  easeProfile(p.s, p.y, p.lo, p.hi, p.locked);
  p.y.forEach((v, i) => { if (Math.abs(p.s[i] - 200) < 60) assert.ok(v >= before[i] - 1e-9, `under the road as it was at ${p.s[i]} m`); });
  assert.ok(worst(p) < EASE.ONE_SIDED_LEAVES, `${worst(p)} left`);
  assert.ok(gradeChange(p.s, p.y, index(p, 100)) < 0.03 && gradeChange(p.s, p.y, index(p, 300)) < 0.03, 'its feet eased');
  assert.ok(steepest(p) <= EASE.STEEPEST + 1e-9, `${steepest(p)} steep`);
  // Too short to round without going steeper than STEEPEST: left as it was
  const q = profile(40, (d) => 1.6 - 0.08 * Math.abs(d - 20));
  q.lo[index(q, 20)] = q.y[index(q, 20)];
  const short = q.y.slice();
  easeProfile(q.s, q.y, q.lo, q.hi, q.locked);
  assert.ok(q.y[index(q, 20)] >= short[index(q, 20)] - EASE.TOLERANCE);
});

test('a dip held down by a tunnel\'s cover is rounded by sinking, never into the cover', () => {
  const t = profile(400, (d) => -Math.min(8, 0.08 * Math.min(d, 400 - d)));
  const dip = t.y.slice();
  for (let i = 0; i < t.y.length; i++) t.hi[i] = dip[i];
  easeProfile(t.s, t.y, t.lo, t.hi, t.locked);
  t.y.forEach((v, i) => assert.ok(v <= t.hi[i] + EASE.TOLERANCE, `into the cover at ${t.s[i]} m`));
  assert.ok(worst(t) < EASE.ONE_SIDED_LEAVES, `${worst(t)} left`);
  assert.ok(t.y.some((v, i) => v < dip[i] - 0.1), 'sunk to round it');
});

test('two roads eased towards each other where they cross are put back to their clearance', () => {
  // A bridge's crest over a tunnel's dip, 7.5 m apart where they cross: each alone may ease 0.4 m towards the other, both can't
  const CLEAR = 6.8;
  const samples = [], bridge = [], tunnel = [];
  for (let d = -150; d <= 150; d += 5) {
    bridge.push(samples.push({ x: d, z: 0, y: 20 - 0.04 * Math.abs(d), lo: -Infinity, hi: Infinity, fixed: false }) - 1);
  }
  for (let d = -150; d <= 150; d += 5) {
    tunnel.push(samples.push({ x: 0, z: d, y: 12.5 + 0.04 * Math.abs(d), lo: -Infinity, hi: Infinity, fixed: false }) - 1);
  }
  const top = bridge[30], under = tunnel[30];
  const partners = new Map([[top, [under]], [under, [top]]]);
  const rebound = () => {
    for (const q of samples) { q.lo = -Infinity; q.hi = Infinity; }
    samples[top].lo = samples[under].y + CLEAR;
    samples[under].hi = samples[top].y - CLEAR;
  };
  // Each on its own fits
  for (const [mine, other] of [[bridge, tunnel], [tunnel, bridge]]) {
    const copy = samples.map((q) => ({ ...q }));
    const result = easeRoads({ samples: copy, chains: [mine], partners, rebound: () => {
      for (const q of copy) { q.lo = -Infinity; q.hi = Infinity; }
      copy[top].lo = copy[under].y + CLEAR;
      copy[under].hi = copy[top].y - CLEAR;
    } });
    assert.equal(result.undone, 0);
    assert.ok(copy[top].y - copy[under].y >= CLEAR - EASE.TOLERANCE);
    assert.ok(copy[top].y - copy[under].y < 7.5 - 0.1, 'eased towards the other');
    assert.ok(other.every((idx) => copy[idx].y === samples[idx].y));
  }
  // Together they'd meet: put back
  const result = easeRoads({ samples, chains: [bridge, tunnel], partners, rebound });
  assert.ok(result.undone >= 1);
  assert.ok(samples[top].y - samples[under].y >= CLEAR - EASE.TOLERANCE, `${samples[top].y - samples[under].y} m apart`);
});

test('points held (where a ramp runs inside the road it joins) stay as they were, and the curve is kept off them', () => {
  const samples = [], ramp = [];
  for (let d = 0; d <= 300; d += 5) ramp.push(samples.push({ x: d, z: 0, y: d < 150 ? 10 + 0.08 * (150 - d) : 10, lo: -Infinity, hi: Infinity, fixed: false }) - 1);
  const held = new Set(ramp.filter((idx) => samples[idx].x >= 160 && samples[idx].x <= 200));
  const before = samples.map((q) => q.y);
  easeRoads({ samples, chains: [ramp], partners: new Map(), rebound: () => {}, held });
  for (const idx of held) assert.equal(samples[idx].y, before[idx]);
  assert.ok(samples.some((q, i) => q.y !== before[i]), 'eased where it may');
});
