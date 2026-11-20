import assert from 'node:assert/strict';
import test from 'node:test';
import { impulseBuffer } from '../js/audio-synthesis.js';

// The reverb's impulse (js/audio-synthesis.js) is made at the audio context's own rate, which is the output's: 48 kHz on many PCs,
// 44.1 kHz on others and in Safari. A convolver refuses any other, and the game was silent where the rate wasn't 48 kHz. The
// impulse should be the same reverb at every rate: as long, its reflections when they were, and as loud.

const RATES = [22050, 44100, 48000, 96000];
const REFLECTIONS = [0.017, 0.034, 0.061, 0.097, 0.153, 0.231];

// A stand-in context, as the worker's (js/audio-worker.js)
function context(sampleRate) {
  return {
    sampleRate,
    createBuffer(count, length, rate) {
      const channels = Array.from({ length: count }, () => new Float32Array(length));
      return { numberOfChannels: count, length, sampleRate: rate, getChannelData: (i) => channels[i] };
    }
  };
}

// How loud a convolver makes a tone at f is |H(f)|², its impulse's spectrum there. Averaged over what the reverb is heard through
// (the reflections' low-pass is at 2.4 kHz, attachSounds()), from a sample on.
function loudness(data, rate, from = 0) {
  let sum = 0, count = 0;
  for (let f = 100; f <= 2400; f += 20, count++) {
    const w = 2 * Math.PI * f / rate;
    let re = 0, im = 0;
    for (let i = from; i < data.length; i++) {
      re += data[i] * Math.cos(w * i);
      im -= data[i] * Math.sin(w * i);
    }
    sum += re * re + im * im;
  }
  return sum / count;
}

const impulses = new Map(RATES.map((rate) => [rate, impulseBuffer(context(rate))]));

test('the impulse is 0.7 s of stereo at the context\'s own rate', () => {
  for (const [rate, impulse] of impulses) {
    assert.equal(impulse.sampleRate, rate);
    assert.equal(impulse.numberOfChannels, 2);
    assert.ok(Math.abs(impulse.length / rate - 0.7) <= 1 / rate, `${rate} Hz: ${impulse.length / rate} s`);
    for (let channel = 0; channel < 2; channel++) {
      assert.ok(impulse.getChannelData(channel).every(Number.isFinite), `${rate} Hz, channel ${channel}`);
    }
  }
});

test('its reflections come at the same times at every rate', () => {
  for (const [rate, impulse] of impulses) {
    const data = impulse.getChannelData(0);
    REFLECTIONS.forEach((time, tap) => {
      // The middle of the energy within 3 ms of where the reflection starts
      let sum = 0, moment = 0;
      for (let i = Math.round((time - 0.003) * rate); i < Math.round((time + 0.003) * rate); i++) {
        sum += data[i] * data[i];
        moment += data[i] * data[i] * i / rate;
      }
      const middle = time + (0.0008 + tap * 0.0002) / 2;
      assert.ok(Math.abs(moment / sum - middle) < 0.0003, `${rate} Hz, reflection ${tap}: ${(moment / sum * 1000).toFixed(2)} ms`);
    });
  }
});

test('it is as loud at every rate as at 48 kHz', () => {
  const tail = (rate) => Math.round(0.3 * rate);
  const data48 = impulses.get(48000).getChannelData(0);
  const tail48 = loudness(data48, 48000, tail(48000)), whole48 = loudness(data48, 48000);
  for (const [rate, impulse] of impulses) {
    const data = impulse.getChannelData(0);
    // The tail is thousands of samples of noise: as loud to a few percent (without the rate in its level, half as loud at
    // 22.05 kHz, twice at 96). The reflections are each a few dozen random samples, whose sum at a low pitch is a throw of the dice.
    const tailRatio = loudness(data, rate, tail(rate)) / tail48;
    const wholeRatio = loudness(data, rate) / whole48;
    assert.ok(Math.abs(tailRatio - 1) < 0.15, `${rate} Hz: the tail ${tailRatio.toFixed(3)} of 48 kHz's`);
    assert.ok(wholeRatio > 0.6 && wholeRatio < 1.7, `${rate} Hz: the whole ${wholeRatio.toFixed(3)} of 48 kHz's`);
  }
});
