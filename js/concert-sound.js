// The concert's sound (js/concert.js): where the piano and the trumpet stand on the Concert Hall's stage, the hall's reverb, and how each
// note of the score is played on an audio context. Also a whole performance rendered offline (renderPerformance()), for listening to.
import { bufferFor, releaseOf } from './audio-instruments.js';

// BeepBox's raw levels to the duet's balance: its piano is as loud as its trumpet is soft
const LEVELS = { piano: 1.2, trumpet: 2.8 };

// The stage in the Concert Hall's own frame (js/opera-house.js hallFrame(): s north along the hall, v east, y over the harbour), as
// tools/models/opera_ch.py builds it: 12.3 m deep (s 49-61.3), its front to the north, the audience beyond; its floor 17.5 m up. Where
// the performers' model (tools/models/opera_concert.py, its JSON's `sound`) has them.
const STAGE = {
  hall: 'concert', floor: 17.5, front: 61.3, back: 49.0, width: 14.5,
  piano: [55.6, -0.12], // s, v: the piano's middle, its keyboard to the east, its lid open to the audience
  trumpet: [57.8, -0.95] // where the trumpeter stands, in the piano's curve
};
/** A place on the stage in the world: [x, y, z] from (s, v) and a height over its floor; `frame` the hall's (hallFrame()) */
const stagePoint = (frame, [s, v], up = 0) => frame(s, v, STAGE.floor + up);

/**
 * The hall's reverb: about 2.2 s, stereo, its early reflections off the stage's shell and the hall's walls in the first 90 ms, then a
 * diffuse tail falling 60 dB in 2 s, its highs dying sooner. Made at the context's own rate (a convolver takes no other), as loud at
 * any rate (js/audio-synthesis.js impulseBuffer()).
 */
function hallImpulse(context) {
  const rate = context.sampleRate;
  const scale = 48000 / rate;
  const level = Math.sqrt(scale);
  const length = Math.round(rate * 2.2);
  const impulse = context.createBuffer(2, length, rate);
  const reflections = [[0.013, 0.42], [0.021, 0.36], [0.029, 0.33], [0.037, 0.3], [0.046, 0.26], [0.055, 0.24], [0.067, 0.2], [0.079, 0.18], [0.088, 0.15]];
  const rt60 = 2.0;
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    let seed = 0x68616c6c + channel * 7919;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296 * 2 - 1;
    };
    let low = 0;
    for (let i = 0; i < length; i++) {
      const t = i / rate;
      // the tail's low-pass, from 9 kHz to 2.5 kHz as it dies: its pole at the same frequency at any rate
      const cutoff = 9000 * Math.pow(2500 / 9000, Math.min(1, t / 1.6));
      low += (rand() - low) * (1 - Math.exp(-2 * Math.PI * cutoff / rate));
      const fadeIn = Math.min(1, Math.max(0, (t - 0.018) / 0.06));
      const fadeOut = Math.min(1, (length - 1 - i) / (rate * 0.15));
      data[i] = low * Math.pow(10, -3 * t / rt60) * fadeIn * fadeOut * 0.05 * level;
    }
    reflections.forEach(([at, gain], k) => {
      const start = Math.round((at + channel * (k % 2 ? 0.0019 : -0.0013)) * rate);
      const width = Math.max(2, Math.round(rate * 0.0006));
      for (let i = 0; i < width; i++) data[start + i] += rand() * Math.sin(Math.PI * i / width) * gain * level * 0.9;
    });
  }
  return impulse;
}

// A note's small variation, the same each time a score plays: ±7 ms and ±4% loudness
function touch(seed, k) {
  let h = Math.imul(seed ^ (k * 0x9e3779b1), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  const a = (h & 0xffff) / 65535 - 0.5, b = (h >>> 16) / 65535 - 0.5;
  return { dt: a * 0.014, dv: 1 + b * 0.08 };
}

/**
 * The concert's sound on `context`, into `output`: its two instruments' buses from the stage (`positions`: { piano, trumpet } [x, y, z],
 * or none for a recording at a seat's distance), the hall's reverb, and a master to fade. { input(i), out, dispose() }
 */
function concertGraph(context, output, positions = null) {
  const out = context.createGain();
  out.gain.value = 0;
  out.connect(output);
  const send = context.createGain();
  send.gain.value = 0.55;
  const wet = context.createGain();
  wet.gain.value = 1;
  let reverb = null;
  try {
    reverb = context.createConvolver();
    reverb.normalize = false;
    reverb.buffer = hallImpulse(context);
    send.connect(reverb).connect(wet).connect(out);
  } catch (error) {
    console.warn('[concert] No hall reverb', error);
    reverb = null;
  }
  const buses = {};
  const nodes = [out, send, wet, reverb];
  for (const i of ['piano', 'trumpet']) {
    const bus = context.createGain();
    bus.gain.value = LEVELS[i];
    let dry = bus;
    if (positions) {
      const panner = context.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 8;
      panner.rolloffFactor = 0.9;
      panner.maxDistance = 80;
      const [x, y, z] = positions[i];
      if (panner.positionX) {
        panner.positionX.value = x;
        panner.positionY.value = y;
        panner.positionZ.value = z;
      } else panner.setPosition(x, y, z);
      bus.connect(panner);
      dry = panner;
      nodes.push(panner);
    } else {
      // a seat in the stalls, some 15 m from the stage: the piano a little to the left, the trumpet a little to the right
      const pan = context.createStereoPanner?.();
      if (pan) {
        pan.pan.value = i === 'piano' ? -0.3 : 0.25;
        bus.connect(pan);
        dry = pan;
        nodes.push(pan);
      }
    }
    const direct = context.createGain();
    direct.gain.value = positions ? 1 : 0.55;
    dry.connect(direct).connect(out);
    bus.connect(send);
    buses[i] = bus;
    nodes.push(bus, direct);
  }
  return {
    out, reverb: !!reverb, input: (i) => buses[i],
    dispose() {
      for (const node of nodes) node?.disconnect();
    }
  };
}

/**
 * One note: its buffer started at `when` (the context's time) through a gain, faded out as BeepBox ends it (releaseOf()), into `bus`.
 * Returns { source, ends } or null if there's no buffer for it.
 */
function playNote(context, bus, buffers, n, when, bpm, dv = 1) {
  const b = bufferFor(n.i, n.p, n.v);
  const buffer = buffers.get(b.key);
  if (!buffer) return null;
  const source = context.createBufferSource();
  source.buffer = buffer.audio;
  source.playbackRate.value = b.rate;
  const gain = context.createGain();
  const g = b.gain * dv;
  const release = releaseOf(n.i, bpm);
  const end = when + n.d;
  gain.gain.setValueAtTime(g, when);
  let ends;
  if (n.i === 'piano') {
    const curve = new Float32Array(9);
    for (let k = 0; k < curve.length; k++) curve[k] = g * Math.pow(1 - k / (curve.length - 1), 1.5);
    gain.gain.setValueCurveAtTime(curve, end, Math.max(0.02, release.after));
    ends = end + release.after + 0.02;
  } else {
    source.loop = true;
    source.loopStart = buffer.loop[0];
    source.loopEnd = buffer.loop[1];
    const fade = Math.min(release.before, n.d * 0.5);
    gain.gain.setValueAtTime(g, end - fade);
    gain.gain.linearRampToValueAtTime(0, end);
    ends = end + 0.01;
  }
  source.connect(gain).connect(bus);
  source.start(when);
  source.stop(ends);
  return { source, gain, ends };
}

/** An AudioBuffer of a rendered note on `context` */
function toAudio(context, { key, rate, samples, loop }) {
  const audio = context.createBuffer(1, samples.length, rate);
  audio.copyToChannel(samples, 0);
  return { key, audio, loop };
}

/**
 * A whole performance rendered offline, for listening to (the scripts' WAVs): `context` an OfflineAudioContext, the score's notes all
 * scheduled at once from a seat in the stalls (no panner: a little spread instead), through the same hall. Resolves to its AudioBuffer.
 */
function renderPerformance(context, score, rendered) {
  const buffers = new Map(rendered.map((b) => [b.key, toAudio(context, b)]));
  const graph = concertGraph(context, context.destination, null);
  graph.out.gain.value = 1;
  score.notes.forEach((n, k) => {
    const tn = touch(score.seed, k);
    playNote(context, graph.input(n.i), buffers, n, 0.25 + n.t + tn.dt, score.sections[n.s].bpm, tn.dv);
  });
  return context.startRendering();
}

export { LEVELS, STAGE, concertGraph, hallImpulse, playNote, renderPerformance, stagePoint, toAudio, touch };
