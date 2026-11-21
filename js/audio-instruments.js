// The concert's two instruments: BeepBox's "grand piano" and "trumpet" presets, their synthesis ported from BeepBox's own source
// (synth/synth.ts, synth/SynthConfig.ts and synth/filtering.ts, github.com/johnnesky/beepbox, © John Nesky and contributing authors,
// MIT: LICENSE-beepbox-MIT). Only the paths those two presets take are here:
//   grand piano  "Picked String": two strings of a Karplus-Strong loop with an all-pass for dispersion and a high shelf for the decay,
//                each plucked by an impulse from the preset's harmonics; a note filter whose low-pass follows the note's size and whose
//                high-pass falls away from the attack (two "twang 1" envelopes); the instrument's five-point EQ
//   trumpet      "FM": algorithm 1←(2 3 4), operator 1 feeding back on itself, the third operator's "flare 2" and the feedback's "swell 1"
//                envelopes; a resonant low-pass EQ at 2.8 kHz
// Each note is worked out as BeepBox's editor exports it, tick by tick (96 a second, 120 bpm: envelopes and filters are set per tick and
// slid across it), with BeepBox's own numbers. Left out: its reverb (the hall's convolver stands in) and its output limiter (the game's
// compressor does that job). Everything here is plain arithmetic on Float32Arrays, so it runs in a worker (js/concert-worker.js) and in
// node for the tests.
//
// A note's end isn't in its samples: a piano note keeps ringing for as long as its buffer, and a trumpet's holds on a loop; the player
// (js/concert.js) fades each out where the score ends it, as BeepBox does (releaseOf()).

const TAU = Math.PI * 2;
const TICKS_PER_SECOND = 96; // BeepBox: 2 ticks a part, 24 parts a beat, at 120 bpm
const SINE_LENGTH = 256;
const SINE = (() => {
  const wave = new Float32Array(SINE_LENGTH + 1);
  for (let i = 0; i <= SINE_LENGTH; i++) wave[i] = Math.sin(i * TAU / SINE_LENGTH);
  return wave;
})();
const EPSILON = 1.0e-24;

const LOW_PASS = 0, HIGH_PASS = 1, PEAK = 2;
// The presets as BeepBox's editor reads them (Instrument.fromJsonObject(settings, false, 1)): each filter point's frequency and gain
// settings (8 kHz * 2^((freq - 28) / 4); 2^((gain - 7) / 2)), the envelopes, and the settings the synth reads
const GRAND_PIANO = {
  harmonics: [7, 7, 6, 6, 6, 5, 5, 5, 0, 5, 5, 5, 5, 4, 4, 5, 4, 1, 4, 4, 4, 4, 4, 4, 4, 4, 2, 4],
  eq: [[HIGH_PASS, 5, 6], [PEAK, 19, 11], [LOW_PASS, 28, 2], [PEAK, 23, 11], [PEAK, 21, 3]],
  noteFilter: [[LOW_PASS, 25, 4], [HIGH_PASS, 4, 0]],
  stringSustain: 12, // of 14
  unison: { spread: 0.01, offset: 0, expression: 1.0, sign: 0.7 }, // "piano": two strings a hundredth of a semitone apart
  fadeOutTicks: 48 // after the note's end
};
const TRUMPET = {
  eq: [[LOW_PASS, 22, 8]],
  operators: [14, 8, 5, 0], // amplitudes, each "1×"
  feedback: 9, // "1⟲"
  fadeInSeconds: 0.0125 * (0.95 * 2 + 0.05 * 2 * 2), // setting 2: "soft"
  fadeOutTicks: -3 // before the note's end
};

// --- Filters (filtering.ts) ------------------------------------------------------------------------------------------------
const filterHz = (setting) => 8000 * Math.pow(2, (setting - 28) * 0.25);
const FILTER_MAX_HZ = 8000 * Math.pow(2, 0.25 * (34 - 1 - 28));

function lowPass2(c, radians, gain) {
  const alpha = Math.sin(radians) / (2 * gain), cos = Math.cos(radians), a0 = 1 + alpha;
  c.a1 = -2 * cos / a0; c.a2 = (1 - alpha) / a0; c.b0 = c.b2 = (1 - cos) / (2 * a0); c.b1 = (1 - cos) / a0;
}
function highPass2(c, radians, gain) {
  const alpha = Math.sin(radians) / (2 * gain), cos = Math.cos(radians), a0 = 1 + alpha;
  c.a1 = -2 * cos / a0; c.a2 = (1 - alpha) / a0; c.b0 = c.b2 = (1 + cos) / (2 * a0); c.b1 = -(1 + cos) / a0;
}
function peak2(c, radians, gain) {
  const sqrtGain = Math.sqrt(gain);
  const bandWidth = radians / (sqrtGain >= 1 ? sqrtGain : 1 / sqrtGain);
  const alpha = Math.tan(bandWidth * 0.5), a0 = 1 + alpha / sqrtGain;
  c.b0 = (1 + alpha * sqrtGain) / a0; c.b1 = c.a1 = -2 * Math.cos(radians) / a0; c.b2 = (1 - alpha * sqrtGain) / a0; c.a2 = (1 - alpha / sqrtGain) / a0;
}
function highShelf2(c, radians, gain, slope) {
  const A = Math.sqrt(gain), cos = Math.cos(radians), plus = A + 1, minus = A - 1;
  const alpha = Math.sin(radians) * 0.5 * Math.sqrt((plus / A) * (1 / slope - 1) + 2), k = 2 * Math.sqrt(A) * alpha;
  const a0 = plus - minus * cos + k;
  c.a1 = 2 * (minus - plus * cos) / a0; c.a2 = (plus - minus * cos - k) / a0;
  c.b0 = A * (plus + minus * cos + k) / a0; c.b1 = -2 * A * (minus + plus * cos) / a0; c.b2 = A * (plus + minus * cos - k) / a0;
}
/** A filter point's coefficients (FilterControlPoint.toCoefficients()) */
function pointCoefficients(c, [type, freq, gain], rate, freqMult = 1, peakMult = 1) {
  const radians = TAU * Math.max(8, Math.min(FILTER_MAX_HZ, freqMult * filterHz(freq))) / rate;
  const power = (gain - 7) * 0.5, neutral = type === PEAK ? 0 : -0.5;
  const linear = Math.pow(2, neutral + (power - neutral) * peakMult);
  if (type === LOW_PASS) lowPass2(c, radians, linear);
  else if (type === HIGH_PASS) highPass2(c, radians, linear);
  else peak2(c, radians, linear);
}
/** How much louder a note is played to make up for what a filter point takes away (getVolumeCompensationMult()) */
function compensation([type, freq, gain]) {
  const octave = (freq - 28) * 0.25, gainPow = (gain - 7) * 0.5;
  if (type === LOW_PASS) {
    const warped = (Math.sqrt(1 + 4 * Math.pow(2, octave)) - 1) / 2;
    return Math.pow(0.5, 0.2 * Math.max(0, gainPow + 1) + Math.min(0, Math.max(-3, 0.595 * Math.log2(warped) + 0.35 * Math.min(0, gainPow + 1))));
  }
  if (type === HIGH_PASS) {
    return Math.pow(0.5, 0.125 * Math.max(0, gainPow + 1) + Math.min(0, 0.3 * (-octave - Math.log2(8000 / 125)) + 0.2 * Math.min(0, gainPow + 1)));
  }
  const distance = octave + Math.log2(8000 / 2000);
  const loudness = Math.pow(1 / (1 + Math.pow(distance / 3, 2)), 2);
  return Math.pow(0.5, 0.125 * Math.max(0, gainPow) + 0.1 * loudness * Math.min(0, gainPow));
}
/** The phase of a filter's response at `radians` (FrequencyResponse.angle()), order 1 (b2 = a2 = 0) or 2 */
function responseAngle(c, radians) {
  const r1 = Math.cos(radians), i1 = -Math.sin(radians);
  const r2 = r1 * r1 - i1 * i1, i2 = 2 * r1 * i1;
  const rn = c.b0 + c.b1 * r1 + c.b2 * r2, inum = c.b1 * i1 + c.b2 * i2;
  const rd = 1 + c.a1 * r1 + c.a2 * r2, id = c.a1 * i1 + c.a2 * i2;
  return Math.atan2(inum * rd - rn * id, rn * rd + inum * id);
}

/** A biquad whose coefficients slide from one tick's start to its end (DynamicBiquadFilter) */
function dynamicFilter() {
  return { a1: 0, a2: 0, b0: 1, b1: 0, b2: 0, da1: 0, da2: 0, db0: 0, db1: 0, db2: 0, out1: 0, out2: 0, mult: false };
}
function slide(f, s, e, rate, mult) {
  f.a1 = s.a1; f.a2 = s.a2; f.b0 = s.b0; f.b1 = s.b1; f.b2 = s.b2;
  f.da1 = (e.a1 - s.a1) * rate; f.da2 = (e.a2 - s.a2) * rate;
  if (mult) {
    f.db0 = Math.pow(e.b0 / s.b0, rate); f.db1 = Math.pow(e.b1 / s.b1, rate); f.db2 = Math.pow(e.b2 / s.b2, rate);
  } else {
    f.db0 = (e.b0 - s.b0) * rate; f.db1 = (e.b1 - s.b1) * rate; f.db2 = (e.b2 - s.b2) * rate;
  }
  f.mult = mult;
}
/** A sample through a chain of them (Synth.applyFilters(): each one's inputs are the one before's last outputs) */
function applyFilters(sample, input1, input2, filters) {
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    const out1 = f.out1, out2 = f.out2;
    sample = f.b0 * sample + f.b1 * input1 + f.b2 * input2 - f.a1 * out1 - f.a2 * out2;
    f.a1 += f.da1; f.a2 += f.da2;
    if (f.mult) { f.b0 *= f.db0; f.b1 *= f.db1; f.b2 *= f.db2; } else { f.b0 += f.db0; f.b1 += f.db1; f.b2 += f.db2; }
    f.out2 = out1; f.out1 = sample;
    input2 = out2; input1 = out1;
  }
  return sample;
}
function sanitize(filters) {
  if (filters.some((f) => !(Math.abs(f.out1) < 100) || !(Math.abs(f.out2) < 100))) {
    for (const f of filters) f.out1 = f.out2 = 0;
    return;
  }
  for (const f of filters) {
    if (Math.abs(f.out1) < EPSILON) f.out1 = 0;
    if (Math.abs(f.out2) < EPSILON) f.out2 = 0;
  }
}

const frequencyOf = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
const noteSizeMult = (size) => Math.pow(Math.max(0, size) / 3, 1.5);
const twang = (t, speed) => 1 / (1 + t * speed);
const swell = (t, speed) => 1 - 1 / (1 + t * speed);
const flare = (t, speed) => {
  const attack = 0.25 / Math.sqrt(speed);
  return t < attack ? t / attack : 1 / (1 + (t - attack) * speed);
};

/** The instrument's EQ: a filter per point, and how much it makes up for them (InstrumentState.compute()) */
function eqChain(points, rate) {
  const coefficients = { a1: 0, a2: 0, b0: 1, b1: 0, b2: 0 };
  const filters = points.map((p) => {
    const f = dynamicFilter();
    pointCoefficients(coefficients, p, rate);
    slide(f, coefficients, coefficients, 0, p[0] === LOW_PASS);
    return f;
  });
  let volume = 1;
  for (const p of points) volume *= compensation(p);
  return { filters, volume: Math.min(3, volume), in1: 0, in2: 0 };
}

/** Runs `tick(k)` at each tick's start and `run(from, to)` over its samples, as Synth.synthesize() steps through a song */
function byTicks(length, rate, tick, run) {
  const samplesPerTick = rate / TICKS_PER_SECOND;
  let countdown = samplesPerTick, at = 0, k = 0;
  while (at < length) {
    const rounded = Math.ceil(samplesPerTick);
    tick(k, rounded);
    const runLength = Math.min(Math.ceil(countdown), length - at);
    run(at, at + runLength);
    at += runLength;
    countdown -= runLength;
    if (countdown <= 0) {
      countdown += samplesPerTick;
      k++;
    }
  }
}

// --- The grand piano: a picked string -------------------------------------------------------------------------------------
let pianoWave = null;
/** The impulse that plucks a string: the preset's harmonics, integrated (HarmonicsWaveState.getCustomWave(), picked string) */
function pickedImpulse() {
  if (pianoWave) return pianoWave;
  const LENGTH = 2048, RENDERED = 256, POINTS = 28, MAX = 7;
  // BeepBox's "retro" noise (a linear feedback shift register), whose signs scatter the harmonics' phases
  const retro = new Float32Array(1 << 15);
  let lfsr = 1;
  for (let i = 0; i < retro.length; i++) {
    retro[i] = (lfsr & 1) * 2 - 1;
    let next = lfsr >> 1;
    if (((lfsr + next) & 1) === 1) next += 1 << 14;
    lfsr = next;
  }
  const amplitudes = new Float64Array(RENDERED + 1);
  let combined = 1;
  for (let h = 0; h < RENDERED; h++) {
    let control = h < POINTS ? GRAND_PIANO.harmonics[h] : GRAND_PIANO.harmonics[POINTS - 1];
    if (h >= POINTS) control *= 1 - (h - POINTS) / (RENDERED - POINTS);
    let amplitude = Math.pow(2, control - MAX + 1) * Math.sqrt(control / MAX);
    if (h < POINTS) combined += amplitude;
    amplitude *= Math.pow(h + 1, -0.25);
    amplitudes[h + 1] = amplitude * retro[h + 589];
  }
  // BeepBox writes each into the sine half of a real inverse FFT (which doubles it); the same sum, done directly
  const wave = new Float32Array(LENGTH + 1);
  const mult = 1 / Math.pow(combined, 0.7);
  const sines = new Float64Array(LENGTH);
  for (let h = 1; h <= RENDERED; h++) {
    const a = 2 * amplitudes[h];
    if (!a) continue;
    for (let i = 0; i < LENGTH; i++) sines[i] += a * Math.sin(TAU * h * i / LENGTH);
  }
  let sum = 0;
  for (let i = 0; i < LENGTH; i++) {
    const v = sines[i] * mult;
    wave[i] = sum;
    sum += v;
  }
  wave[LENGTH] = wave[0];
  pianoWave = wave;
  return wave;
}

const coefficients = () => ({ a1: 0, a2: 0, b0: 1, b1: 0, b2: 0 });
/** One string's state (PickedString) */
function pickedString() {
  return {
    line: null, index: -1, allPass: 0, allPassIn: 0, sustain: 0, sustainOut2: 0, sustainIn1: 0, sustainIn2: 0, fractional: 0,
    delay: -1, dDelay: 0, resetOffset: 0, g: 0, dg: 0, a1: 0, da1: 0, a2: 0, da2: 0, b0: 0, db0: 0, b1: 0, db1: 0, b2: 0, db2: 0
  };
}
const tempStart = coefficients(), tempEnd = coefficients(), allPassC = coefficients();

/** A string's loop for one tick (PickedString.update(), "bright" sustain) */
function updateString(str, phaseDelta, rate, rounded, decay, wave) {
  const allPassCenter = TAU * 6000 / rate;
  const radians = TAU * phaseDelta;
  const centerHarmonic = radians * 2;
  const allPassRadians = Math.min(Math.PI, radians * 4 * Math.pow(allPassCenter / radians, 0.3));
  const shelfRadians = TAU * 4000 / rate;
  const decayCurve = (Math.pow(100, decay) - 1) / 99;
  const decayRate = Math.pow(0.5, decayCurve * Math.pow(shelfRadians / (radians * 15.6), 1) * 15.6);
  const expressionDecay = Math.pow(decayRate, 0.002);
  // the all-pass, inverting its phase above its corner
  const g = (Math.sin(allPassRadians) - 1) / Math.cos(allPassRadians);
  allPassC.a1 = g; allPassC.b0 = g; allPassC.b1 = 1; allPassC.a2 = 0; allPassC.b2 = 0;
  const allPassDelay = -responseAngle(allPassC, centerHarmonic) / centerHarmonic;
  highShelf2(tempStart, shelfRadians, Math.pow(decayRate, 0.12), 0.5);
  const sustainDelay = -responseAngle(tempStart, centerHarmonic) / centerHarmonic;
  const period = 1 / phaseDelta;
  const delayLength = period - allPassDelay - sustainDelay;
  // The pitch is the same all through: each tick's end is its start
  str.delay = delayLength; str.dDelay = 0;
  str.g = g; str.dg = 0;
  str.a1 = tempStart.a1; str.a2 = tempStart.a2;
  str.b0 = tempStart.b0 * expressionDecay; str.b1 = tempStart.b1 * expressionDecay; str.b2 = tempStart.b2 * expressionDecay;
  str.da1 = str.da2 = str.db0 = str.db1 = str.db2 = 0;
  const minLength = Math.ceil(period * 2);
  if (!str.line || str.line.length <= minLength) {
    const likely = Math.ceil(2 * rate / frequencyOf(12));
    str.line = new Float32Array(1 << (32 - Math.clz32(Math.ceil(Math.max(likely, minLength)) - 1)));
  }
  if (str.index === -1) {
    // The pluck: the impulse wave laid into the line over one period, faded in and out
    const line = str.line, mask = line.length - 1;
    str.index = 0;
    str.allPass = str.allPassIn = str.sustain = str.sustainOut2 = str.sustainIn1 = str.sustainIn2 = str.fractional = 0;
    const startImpulseFrom = -delayLength;
    const startZerosFrom = Math.floor(startImpulseFrom - period / 2);
    const stopZerosAt = Math.ceil(startZerosFrom + period * 2);
    str.resetOffset = stopZerosAt;
    for (let i = startZerosFrom; i <= stopZerosAt; i++) line[i & mask] = 0;
    const waveLength = wave.length - 1;
    const impulseDelta = waveLength / period;
    const fade = Math.min(period * 0.2, rate * 0.003);
    const from = Math.ceil(startImpulseFrom);
    const stop = startImpulseFrom + period + fade;
    let phase = (from - startImpulseFrom) * impulseDelta;
    let prev = 0;
    for (let i = from; i <= stop; i++) {
      const whole = phase | 0;
      const index = whole % waveLength;
      let next = wave[index];
      next += (wave[index + 1] - next) * (phase - whole);
      const sample = (next - prev) / impulseDelta;
      const fadeIn = Math.min(1, (i - startImpulseFrom) / fade), fadeOut = Math.min(1, (stop - i) / fade);
      const f = fadeIn * fadeOut;
      line[i & mask] += sample * f * f * (3 - 2 * f);
      prev = next;
      phase += impulseDelta;
    }
  }
}

/** One string's samples for a run, added to `data` before the note filter (pickedStringSynth()'s loop, one voice at a time) */
function runString(str, from, to, voice) {
  const line = str.line, mask = line.length - 1;
  let index = (str.index & mask) + line.length;
  let fractional = str.fractional, allPass = str.allPass, allPassIn = str.allPassIn;
  let sustain = str.sustain, sustainOut2 = str.sustainOut2, sustainIn1 = str.sustainIn1, sustainIn2 = str.sustainIn2;
  const g = str.g, a1 = str.a1, a2 = str.a2, b0 = str.b0, b1 = str.b1, b2 = str.b2, delay = str.delay, reset = str.resetOffset | 0;
  for (let i = from; i < to; i++) {
    const target = index - delay;
    const lower = (target + 0.125) | 0, upper = lower + 1;
    const frac = upper - target;
    const fg = (1 - frac) / (1 + frac);
    const prevIn = line[lower & mask], input = line[upper & mask];
    fractional = fg * input + prevIn - fg * fractional;
    allPass = fractional * g + allPassIn - g * allPass;
    allPassIn = fractional;
    const sustainOut1 = sustain;
    sustain = b0 * allPass + b1 * sustainIn1 + b2 * sustainIn2 - a1 * sustain - a2 * sustainOut2;
    sustainOut2 = sustainOut1;
    sustainIn2 = sustainIn1;
    sustainIn1 = allPass;
    line[index & mask] += sustain;
    line[(index + reset) & mask] = 0;
    index++;
    voice[i] = fractional;
  }
  const clean = (v) => (!Number.isFinite(v) || Math.abs(v) < EPSILON ? 0 : v);
  str.allPass = clean(allPass); str.allPassIn = clean(allPassIn); str.sustain = clean(sustain); str.sustainOut2 = clean(sustainOut2);
  str.sustainIn1 = clean(sustainIn1); str.sustainIn2 = clean(sustainIn2); str.fractional = clean(fractional); str.index = index;
}

/** A piano note of MIDI pitch `midi`, BeepBox's note size `size` (0-3), held for `seconds`: its samples at `rate`, before its release */
function renderPiano(midi, size, seconds, rate) {
  const length = Math.round(seconds * rate);
  const out = new Float32Array(length);
  const wave = pickedImpulse();
  const strings = [pickedString(), pickedString()];
  const voiceA = new Float32Array(length), voiceB = new Float32Array(length);
  const noteFilters = GRAND_PIANO.noteFilter.map(() => dynamicFilter());
  let noteIn1 = 0, noteIn2 = 0;
  const eq = eqChain(GRAND_PIANO.eq, rate);
  const f = frequencyOf(midi);
  const u = GRAND_PIANO.unison;
  const phaseDeltaA = f / rate * Math.pow(2, (u.offset + u.spread) / 12);
  const phaseDeltaB = f / rate * Math.pow(2, (u.offset - u.spread) / 12);
  // Size sets the low-pass's cutoff ("note size" on its frequency), so no envelope is left over for the note's volume
  let noteExpression = 1;
  for (const p of GRAND_PIANO.noteFilter) noteExpression *= compensation(p);
  noteExpression = Math.min(3, noteExpression);
  const settings = 0.025 * noteExpression * Math.pow(2, 0.7 * (1 - GRAND_PIANO.stringSustain / 14)) * u.expression;
  const expression = settings * Math.pow(2, -(midi - 16) / 48);
  const decay = 1 - Math.min(1, GRAND_PIANO.stringSustain / 14);
  const sizeMult = noteSizeMult(size);
  let expr = expression;
  byTicks(length, rate, (k, rounded) => {
    const t0 = k / TICKS_PER_SECOND, t1 = (k + 1) / TICKS_PER_SECOND;
    const lowPass = GRAND_PIANO.noteFilter[0], highPass = GRAND_PIANO.noteFilter[1];
    pointCoefficients(tempStart, lowPass, rate, sizeMult);
    slide(noteFilters[0], tempStart, tempStart, 1 / rounded, true);
    pointCoefficients(tempStart, highPass, rate, twang(t0, 32) ** 2);
    pointCoefficients(tempEnd, highPass, rate, twang(t1, 32) ** 2);
    slide(noteFilters[1], tempStart, tempEnd, 1 / rounded, false);
    updateString(strings[0], phaseDeltaA, rate, rounded, decay, wave);
    updateString(strings[1], phaseDeltaB, rate, rounded, decay, wave);
  }, (from, to) => {
    runString(strings[0], from, to, voiceA);
    runString(strings[1], from, to, voiceB);
    for (let i = from; i < to; i++) {
      const input = (voiceA[i] + voiceB[i] * u.sign) * expr;
      const sample = applyFilters(input, noteIn1, noteIn2, noteFilters);
      noteIn2 = noteIn1;
      noteIn1 = input;
      const e = applyFilters(sample, eq.in1, eq.in2, eq.filters);
      eq.in2 = eq.in1;
      eq.in1 = sample;
      out[i] = e * eq.volume;
    }
    sanitize(noteFilters);
    sanitize(eq.filters);
  });
  return out;
}

// --- The trumpet: FM -----------------------------------------------------------------------------------------------------
const amplitudeCurve = (amplitude) => (Math.pow(16, amplitude / 15) - 1) / 15;

/** A trumpet note of MIDI pitch `midi` at size 3 (its size only scales it: the player does that), held for `seconds` */
function renderTrumpet(midi, seconds, rate) {
  const length = Math.round(seconds * rate);
  const out = new Float32Array(length);
  const eq = eqChain(TRUMPET.eq, rate);
  const f = frequencyOf(midi);
  const ops = TRUMPET.operators;
  // Phases in sine-table steps; operators 2-4 modulate operator 1, which also hears its own last output
  const phase = [0, 0, 0, 0], delta = ops.map(() => f / rate * SINE_LENGTH);
  const pitchExpression = Math.pow(2, -(midi - 16) / 48);
  let boost = 1;
  for (let i = 1; i < 4; i++) boost *= 1 - Math.min(1, ops[i] / 15);
  boost *= (Math.pow(2, 2 - 1.4 * TRUMPET.feedback / 15) - 1) / 3;
  boost *= 1 - Math.min(1, Math.max(0, amplitudeCurve(ops[0]) - 1) / 2);
  boost = 1 + boost * 3;
  const feedbackAmplitude = SINE_LENGTH * 0.3 * TRUMPET.feedback / 15;
  let out0 = 0;
  const mult = [0, 0, 0, 0], dMult = [0, 0, 0, 0];
  let feedback = 0, dFeedback = 0, expression = 0, dExpression = 0;
  byTicks(length, rate, (k, rounded) => {
    const t0 = k / TICKS_PER_SECOND, t1 = (k + 1) / TICKS_PER_SECOND;
    for (let i = 0; i < 4; i++) {
      let s = amplitudeCurve(ops[i]), e = s;
      if (i === 0) { s *= pitchExpression; e *= pitchExpression; } else { s *= SINE_LENGTH * 1.5; e *= SINE_LENGTH * 1.5; }
      if (i === 2) { s *= flare(t0, 8); e *= flare(t1, 8); }
      mult[i] = s;
      dMult[i] = (e - s) / rounded;
    }
    feedback = feedbackAmplitude * swell(t0, 32);
    dFeedback = (feedbackAmplitude * swell(t1, 32) - feedback) / rounded;
    // its fade in, and its size (3) as the note's volume
    const fadeStart = Math.min(1, t0 / TRUMPET.fadeInSeconds), fadeEnd = Math.min(1, t1 / TRUMPET.fadeInSeconds);
    expression = 0.03 * boost * fadeStart;
    dExpression = (0.03 * boost * fadeEnd - expression) / rounded;
  }, (from, to) => {
    let p0 = (phase[0] / SINE_LENGTH % 1 + 1000) * SINE_LENGTH, p1 = (phase[1] / SINE_LENGTH % 1 + 1000) * SINE_LENGTH;
    let p2 = (phase[2] / SINE_LENGTH % 1 + 1000) * SINE_LENGTH, p3 = (phase[3] / SINE_LENGTH % 1 + 1000) * SINE_LENGTH;
    let m0 = mult[0], m1 = mult[1], m2 = mult[2], m3 = mult[3];
    for (let i = from; i < to; i++) {
      const s3 = m3 * lookup(p3), s2 = m2 * lookup(p2), s1 = m1 * lookup(p1);
      const mix = p0 + s1 + s2 + s3 + feedback * out0;
      out0 = lookup(mix);
      const fm = m0 * out0;
      feedback += dFeedback;
      m0 += dMult[0]; m1 += dMult[1]; m2 += dMult[2]; m3 += dMult[3];
      p0 += delta[0]; p1 += delta[1]; p2 += delta[2]; p3 += delta[3];
      const sample = fm * expression;
      expression += dExpression;
      const e = applyFilters(sample, eq.in1, eq.in2, eq.filters);
      eq.in2 = eq.in1;
      eq.in1 = sample;
      out[i] = e * eq.volume;
    }
    phase[0] = p0; phase[1] = p1; phase[2] = p2; phase[3] = p3;
    mult[0] = m0; mult[1] = m1; mult[2] = m2; mult[3] = m3;
    sanitize(eq.filters);
  });
  return out;
}
function lookup(phase) {
  const whole = phase | 0, index = whole & (SINE_LENGTH - 1);
  const s = SINE[index];
  return s + (SINE[index + 1] - s) * (phase - whole);
}

// --- What's rendered, and how a note finds its buffer --------------------------------------------------------------------
// The piano every 3 semitones (each buffer played up to 1.5 either way), at three sizes, as long as its pitch rings; the trumpet every
// 2, at its full size, with a loop in its steady sustain. Sample rates: the piano's EQ rolls off from 6 kHz, so 32 kHz holds all of it
// in two thirds of the memory; the trumpet's feedback is rich in harmonics, so it keeps BeepBox's 48 kHz.
const PIANO_RATE = 32000;
const TRUMPET_RATE = 48000;
const PIANO_LOW = 28, PIANO_HIGH = 94, PIANO_STEP = 3;
const PIANO_SIZES = [1, 2, 3]; // BeepBox's own: a note's size is 0-3
const TRUMPET_LOW = 53, TRUMPET_HIGH = 87, TRUMPET_STEP = 2;
const TRUMPET_SECONDS = 1.6;
const TRUMPET_LOOP = [1.0, 1.55]; // s: past the attack, where the flare's all but gone
const pianoSeconds = (midi) => (midi <= 55 ? 3.6 : midi <= 75 ? 2.8 : 2.0);

/** The piano's and the trumpet's ranges, as the arranger must keep to them (MIDI) */
const RANGES = { piano: [PIANO_LOW - 1, PIANO_HIGH + 1], trumpet: [TRUMPET_LOW, TRUMPET_HIGH - 1] };

/** BeepBox's note size for a loudness 0-1: the piano's sets its brightness, the trumpet's its volume */
const sizeOf = (instrument, v) => (instrument === 'piano' ? 1 + 2 * v : 0.6 + 2.4 * v);

/**
 * The buffer a note plays and how: { key, base (its MIDI), rate (playbackRate), gain }. The piano's nearest size sets its colour, and a
 * little of its loudness too (BeepBox's piano is as loud soft as hard, which a duet's comping can't be); the trumpet's size is its volume.
 */
function bufferFor(instrument, midi, v) {
  if (instrument === 'piano') {
    const base = Math.max(PIANO_LOW, Math.min(PIANO_HIGH, PIANO_LOW + Math.round((midi - PIANO_LOW) / PIANO_STEP) * PIANO_STEP));
    const size = sizeOf('piano', v);
    let s = 0;
    for (let i = 1; i < PIANO_SIZES.length; i++) if (Math.abs(PIANO_SIZES[i] - size) < Math.abs(PIANO_SIZES[s] - size)) s = i;
    return { key: `p${base}s${s}`, base, rate: Math.pow(2, (midi - base) / 12), gain: 0.1 + 0.9 * v * v };
  }
  const base = Math.max(TRUMPET_LOW, Math.min(TRUMPET_HIGH, TRUMPET_LOW + Math.round((midi - TRUMPET_LOW) / TRUMPET_STEP) * TRUMPET_STEP));
  return { key: `t${base}`, base, rate: Math.pow(2, (midi - base) / 12), gain: noteSizeMult(sizeOf('trumpet', v)) };
}

/** What a buffer `key` is: { instrument, midi, size, seconds, rate, loop } */
function describe(key) {
  if (key[0] === 'p') {
    const [, midi, s] = key.match(/^p(\d+)s(\d)$/).map(Number);
    return { instrument: 'piano', midi, size: PIANO_SIZES[s], seconds: pianoSeconds(midi), rate: PIANO_RATE, loop: null };
  }
  const midi = Number(key.slice(1));
  return { instrument: 'trumpet', midi, size: 3, seconds: TRUMPET_SECONDS, rate: TRUMPET_RATE, loop: TRUMPET_LOOP };
}

/**
 * A buffer's samples: the piano's whole ring, faded out over its last 0.3 s; the trumpet's start, and its sustain made into a loop (the
 * last 40 ms before the loop's end cross-faded with those before its start, so going round is seamless).
 */
function renderBuffer(key) {
  const d = describe(key);
  if (d.instrument === 'piano') {
    const samples = renderPiano(d.midi, d.size, d.seconds, d.rate);
    const fade = Math.round(0.3 * d.rate);
    for (let i = 0; i < fade; i++) samples[samples.length - 1 - i] *= i / fade;
    return { key, rate: d.rate, samples, loop: null };
  }
  const samples = renderTrumpet(d.midi, d.seconds, d.rate);
  // The loop a whole number of the note's periods long, so the two ends line up in phase
  const period = d.rate / frequencyOf(d.midi);
  const start = Math.round(d.loop[0] * d.rate);
  const end = start + Math.round(Math.round((d.loop[1] - d.loop[0]) * d.rate / period) * period);
  const fade = Math.round(0.04 * d.rate);
  for (let i = 0; i < fade; i++) {
    const k = (i + 1) / fade;
    samples[end - fade + i] = samples[end - fade + i] * (1 - k) + samples[start - fade + i] * k;
  }
  return { key, rate: d.rate, samples: samples.slice(0, end + 1), loop: [start / d.rate, end / d.rate] };
}

/**
 * How a note ends, s, at the tempo it's played: the piano's string damped over 48 of BeepBox's ticks after its end, (1 - t/T)^1.5; the
 * trumpet faded to nothing over the 3 ticks before its end. A tick is a 48th of a beat.
 */
function releaseOf(instrument, bpm) {
  const tick = 60 / bpm / 48;
  return instrument === 'piano' ? { after: GRAND_PIANO.fadeOutTicks * tick, before: 0 } : { after: 0, before: -TRUMPET.fadeOutTicks * tick };
}

export {
  PIANO_RATE, RANGES, TRUMPET_RATE, bufferFor, describe, frequencyOf, releaseOf, renderBuffer, renderPiano, renderTrumpet, sizeOf
};
