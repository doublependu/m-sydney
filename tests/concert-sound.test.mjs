import assert from 'node:assert/strict';
import test from 'node:test';
import { RANGES, bufferFor, describe, releaseOf, renderBuffer, renderPiano, renderTrumpet } from '../js/audio-instruments.js';
import { hallImpulse, stagePoint, STAGE } from '../js/concert-sound.js';
import { OPERA_HOUSE, hallFrame } from '../js/opera-house.js';

// The concert's instruments (js/audio-instruments.js) are BeepBox's "grand piano" and "trumpet", ported from its source. These numbers
// are BeepBox's own: its synth, bundled from github.com/johnnesky/beepbox (2026-08-07, 355e510) and run as its editor's WAV export
// does, one note at 120 bpm, the output limiter taken out (its source, and how it was run, are kept beside this repo, not in it).
// Samples at a few places, and the RMS of 0.1 s from a few times (s).
const BEEPBOX = {
  piano60s3: { midi: 60, size: 3, rate: 48000, at: [-0.03916724, 0.1133796, -0.01190064, -0.04593371, -0.02805552, -0.01870664],
    rms: [0.05212124, 0.05087175, 0.04240298, 0.03094356, 0.03373331, 0.02926791] },
  piano60s1: { midi: 60, size: 1, rate: 48000, at: [0.00345327, 0.06307612, 0.04640364, -0.03610199, -0.02116037, 0.007404748],
    rms: [0.03339635, 0.03696708, 0.03095847, 0.02096695, 0.01955116, 0.01832397] },
  piano40s2: { midi: 40, size: 2, rate: 32000, at: [0.005155116, -0.0328613, -0.03928399, 0.001000683, -0.01356457, -0.0008512823],
    rms: [0.0394222, 0.04768447, 0.0435795, 0.03367228, 0.02781244, 0.02639302] },
  trumpet70: { midi: 70, size: 3, rate: 48000, at: [-0.001575411, 0.01686066, -0.007747708, 0.02750733, 0.005069745, 0.03340057],
    rms: [0.01607131, 0.01499043, 0.0142404, 0.01380821, 0.01363733, 0.01355175] },
  trumpet58: { midi: 58, size: 3, rate: 48000, at: [-0.005691786, -0.02587264, -0.02683602, 0.00452389, 0.0305731, 0.04250141],
    rms: [0.0178745, 0.01671445, 0.01592178, 0.01553356, 0.01536006, 0.01525588] }
};
const AT = [500, 4800, 12345, 24000, 48000, 69000];
const TIMES = [0, 0.25, 0.5, 1, 1.5, 2];

test('the port plays each note as BeepBox does, sample for sample', () => {
  for (const [name, ref] of Object.entries(BEEPBOX)) {
    const ours = name.startsWith('trumpet') ? renderTrumpet(ref.midi, 2.2, ref.rate) : renderPiano(ref.midi, ref.size, 2.2, ref.rate);
    AT.forEach((i, k) => assert.ok(Math.abs(ours[i] - ref.at[k]) < 1e-6, `${name}: sample ${i} is ${ours[i]}, BeepBox's ${ref.at[k]}`));
    TIMES.forEach((t, k) => {
      let s = 0;
      const a = Math.round(t * ref.rate), n = Math.round(0.1 * ref.rate);
      for (let i = a; i < a + n; i++) s += ours[i] * ours[i];
      const rms = Math.sqrt(s / n);
      assert.ok(Math.abs(rms / ref.rms[k] - 1) < 1e-4, `${name}: RMS at ${t} s ${rms}, BeepBox's ${ref.rms[k]}`);
    });
  }
});

test('every note in range has a buffer within reach: a semitone and a half for the piano, one for the trumpet', () => {
  for (const i of ['piano', 'trumpet']) {
    for (let p = RANGES[i][0]; p <= RANGES[i][1]; p++) {
      for (const v of [0.1, 0.5, 0.9]) {
        const b = bufferFor(i, p, v);
        assert.ok(Math.abs(p - b.base) <= (i === 'piano' ? 1.5 : 1), `${i} ${p}: ${b.key}`);
        assert.ok(Math.abs(b.rate - Math.pow(2, (p - b.base) / 12)) < 1e-9);
        assert.ok(b.gain > 0 && b.gain <= 1);
        assert.equal(describe(b.key).midi, b.base);
      }
    }
  }
  // louder is louder, and for the piano brighter: its size
  assert.ok(bufferFor('trumpet', 70, 0.9).gain > bufferFor('trumpet', 70, 0.3).gain);
  assert.notEqual(bufferFor('piano', 70, 0.9).key, bufferFor('piano', 70, 0.1).key);
});

test('the trumpet\'s sustain loops seamlessly, and a piano note rings out to silence', () => {
  for (const key of ['t53', 't71', 't87']) {
    const b = renderBuffer(key);
    const [ls, le] = b.loop.map((t) => Math.round(t * b.rate));
    assert.ok(le < b.samples.length && ls > 0.5 * b.rate);
    const step = Math.max(...Array.from({ length: 200 }, (_, k) => Math.abs(b.samples[ls + k + 1] - b.samples[ls + k])));
    // going round, from the loop's end back to its start, is a step like any other
    assert.ok(Math.abs(b.samples[le] - b.samples[ls]) <= step * 1.5 + 1e-4, `${key}: ${b.samples[le]} to ${b.samples[ls]}`);
    assert.ok(b.samples.every(Number.isFinite));
  }
  for (const key of ['p28s2', 'p67s0', 'p94s1']) {
    const b = renderBuffer(key);
    assert.equal(b.loop, null);
    assert.ok(Math.abs(b.samples[b.samples.length - 1]) === 0);
    assert.ok(b.samples.every(Number.isFinite));
    assert.ok(Math.max(...b.samples.subarray(0, 4000).map(Math.abs)) > 0.01);
  }
});

test('how a note ends, at the tempo it\'s played: the piano damped a beat after, the trumpet faded in its last 3 ticks', () => {
  assert.equal(releaseOf('piano', 120).after, 0.5);
  assert.equal(releaseOf('piano', 60).after, 1);
  assert.equal(releaseOf('trumpet', 120).before, 3 / 96);
  assert.equal(releaseOf('trumpet', 120).after, 0);
});

// A stand-in context, as the worker's
function context(sampleRate) {
  return {
    sampleRate,
    createBuffer(count, length, rate) {
      const channels = Array.from({ length: count }, () => new Float32Array(length));
      return { numberOfChannels: count, length, sampleRate: rate, getChannelData: (i) => channels[i] };
    }
  };
}
// The impulse's energy through the band the hall is mostly heard in (200 Hz - 2 kHz): |H(f)|² every 5 Hz (Goertzel), averaged, as a
// tone at f would be made louder by it
function band(data, rate) {
  let sum = 0, count = 0;
  for (let f = 200; f <= 2000; f += 5, count++) {
    const c = 2 * Math.cos(2 * Math.PI * f / rate);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < data.length; i++) {
      const s0 = data[i] + c * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    sum += s1 * s1 + s2 * s2 - c * s1 * s2;
  }
  return sum / count;
}

test('the hall\'s reverb: about 2.2 s, dying 60 dB in about 2, as loud at any output rate', () => {
  const loud = [];
  for (const rate of [22050, 44100, 48000, 96000]) {
    const impulse = hallImpulse(context(rate));
    assert.equal(impulse.numberOfChannels, 2);
    assert.ok(Math.abs(impulse.length / rate - 2.2) < 1 / rate * 2);
    const l = impulse.getChannelData(0), r = impulse.getChannelData(1);
    assert.ok(l.every(Number.isFinite) && r.every(Number.isFinite));
    // the two ears hear different reflections
    let same = 0;
    for (let i = 0; i < l.length; i++) same += l[i] * r[i];
    let el = 0;
    for (let i = 0; i < l.length; i++) el += l[i] * l[i];
    assert.ok(Math.abs(same / el) < 0.3);
    // energy in 0.1 s windows at 0.3 s and 1.3 s: about 30 dB apart for a 60 dB fall in 2 s
    const energy = (t) => {
      let s = 0;
      for (let i = Math.round(t * rate); i < Math.round((t + 0.1) * rate); i++) s += l[i] * l[i];
      return s;
    };
    const fall = 10 * Math.log10(energy(0.3) / energy(1.3));
    assert.ok(fall > 24 && fall < 36, `${rate}: ${fall.toFixed(1)} dB in a second`);
    loud.push(band(l, rate));
  }
  const db = loud.map((x) => 10 * Math.log10(x / loud[2]));
  for (const x of db) assert.ok(Math.abs(x) < 1.5, `the reverb's loudness by rate: ${db.map((v) => v.toFixed(2))}`);
});

test('the stage is on the Concert Hall\'s stage, in front of its audience', () => {
  const frame = hallFrame(OPERA_HOUSE.halls.find((h) => h.id === STAGE.hall));
  const piano = stagePoint(frame, STAGE.piano, 1), trumpet = stagePoint(frame, STAGE.trumpet, 1.55);
  const front = frame(STAGE.front, 0, 0), back = frame(STAGE.back, 0, 0);
  for (const [x, y, z] of [piano, trumpet]) {
    assert.ok(y > STAGE.floor && y < STAGE.floor + 2);
    const along = ((x - back[0]) * (front[0] - back[0]) + (z - back[2]) * (front[2] - back[2])) / ((front[0] - back[0]) ** 2 + (front[2] - back[2]) ** 2);
    assert.ok(along > 0.3 && along < 1, `${along} of the way to the stage's front`);
  }
  assert.ok(Math.hypot(piano[0] - trumpet[0], piano[2] - trumpet[2]) > 2);
});
