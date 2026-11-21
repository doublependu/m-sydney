// The fireworks' sounds, worked out in code as the game's others are (js/audio-events.js), at 48 kHz: the browser resamples them to its
// own rate. bakeFireworkSounds() is whole in itself, nothing from outside it, so it can be run in a worker made from its own source
// (js/firework-sound.js), as well as here for the tests.
//   boom      a shell's burst: the crack, a low thump with its pitch falling, the rumble, and its echoes off the city (big, middling, small)
//   crackle   the crackling a crossette's or a strobe's stars make as they burn
//   whistle   a whistling shell going up
//   thump     the mortar firing, as a shell leaves the barge
//   hiss      a comet's rush

/** { rate, boom: [3], crackle: [2], whistle: [2], thump: [1], hiss: [1] }: Float32Arrays at `rate` samples a second */
function bakeFireworkSounds(rate = 48000) {
  const TAU = Math.PI * 2;
  const random = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const pole = (hz) => 1 - Math.exp((-TAU * hz) / rate);
  // Its mean taken out, faded in and out over a few ms, scaled to `peak`
  const finish = (s, peak) => {
    let mean = 0, max = 0;
    for (let i = 0; i < s.length; i++) mean += s[i];
    mean /= s.length;
    const fadeIn = rate * 0.002, fadeOut = rate * 0.03;
    for (let i = 0; i < s.length; i++) {
      s[i] = (s[i] - mean) * Math.min(1, i / fadeIn, (s.length - 1 - i) / fadeOut);
      max = Math.max(max, Math.abs(s[i]));
    }
    const k = max > 0 ? peak / max : 0;
    for (let i = 0; i < s.length; i++) s[i] *= k;
    return s;
  };

  function boom(seed, size) {
    const r = random(seed);
    const n = Math.ceil(rate * (2.4 + size * 1.0));
    const dry = new Float32Array(n);
    const body = pole(260 + (1 - size) * 420), body2 = pole(520 + (1 - size) * 600), crack = pole(2600);
    const f0 = 38 + (1 - size) * 34 + r() * 8;
    let b1 = 0, b2 = 0, c = 0, phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const noise = r() * 2 - 1;
      b1 += (noise - b1) * body;
      b2 += (b1 - b2) * body2;
      c += (noise - c) * crack;
      const rumble = b2 * 3.2 * ((1 - Math.exp(-t * 300)) * (Math.exp(-t * 7) + 0.3 * Math.exp(-t * 1.6)));
      phase += (TAU * f0 * (1 + 1.4 * Math.exp(-t * 18))) / rate;
      const thump = Math.sin(phase) * Math.exp(-t * (6 + (1 - size) * 6)) * (1 - Math.exp(-t * 900));
      const snap = (noise - c) * Math.exp(-t * 160) * 0.5;
      dry[i] = rumble + thump * 0.9 + snap;
    }
    // Echoes off the city's walls and the far shore: later, quieter and duller each time
    const out = Float32Array.from(dry);
    for (const [delay, gain, hz] of [[0.32 + r() * 0.1, 0.32, 900], [0.75 + r() * 0.2, 0.2, 600], [1.3 + r() * 0.3, 0.12, 420]]) {
      const d = Math.floor(delay * rate), k = pole(hz);
      let lp = 0;
      for (let i = 0; i + d < n; i++) {
        lp += (dry[i] - lp) * k;
        out[i + d] += lp * gain;
      }
    }
    return finish(out, 0.8);
  }

  function crackle(seed) {
    const r = random(seed);
    const n = Math.ceil(rate * 2.2);
    const s = new Float32Array(n);
    const hp = pole(1800);
    let env = 0, amp = 0, low = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      // Pops come thick and fast, then thin out as the stars burn out
      const density = 340 * Math.min(1, t / 0.25) * Math.max(0, 1 - t / 1.9);
      if (r() < density / rate) {
        amp = 0.3 + r() * 0.7;
        env = 1;
      }
      const noise = r() * 2 - 1;
      low += (noise - low) * hp;
      s[i] = (noise - low) * env * amp;
      env *= Math.exp(-1 / (rate * (0.0004 + r() * 0.0006)));
    }
    return finish(s, 0.7);
  }

  function whistle(seed) {
    const r = random(seed);
    const n = Math.ceil(rate * 1.9);
    const s = new Float32Array(n);
    const from = 1300 + r() * 400, to = 2900 + r() * 700;
    let phase = 0, wob = r() * TAU, low = 0;
    const k = pole(5000);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const f = from + (to - from) * Math.min(1, t / 1.7) ** 0.7;
      phase += (TAU * f * (1 + 0.006 * Math.sin(wob + t * 37))) / rate;
      const noise = r() * 2 - 1;
      low += (noise - low) * k;
      const env = Math.min(1, t / 0.08) * Math.min(1, (1.9 - t) / 0.12);
      s[i] = (Math.sin(phase) + 0.25 * Math.sin(phase * 2) + low * 0.35) * env;
    }
    return finish(s, 0.45);
  }

  function thump(seed) {
    const r = random(seed);
    const n = Math.ceil(rate * 0.7);
    const s = new Float32Array(n);
    const k = pole(380);
    let phase = 0, lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      phase += (TAU * 70 * (1 + Math.exp(-t * 30))) / rate;
      lp += (r() * 2 - 1 - lp) * k;
      s[i] = (Math.sin(phase) * 0.8 + lp * 2.5) * Math.exp(-t * 11) * (1 - Math.exp(-t * 1200));
    }
    return finish(s, 0.7);
  }

  function hiss(seed) {
    const r = random(seed);
    const n = Math.ceil(rate * 2.0);
    const s = new Float32Array(n);
    const lo = pole(2500), hi = pole(7000);
    let a = 0, b = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const noise = r() * 2 - 1;
      a += (noise - a) * lo;
      b += (noise - b) * hi;
      s[i] = (b - a) * Math.min(1, t / 0.05) * Math.exp(-t * 1.6);
    }
    return finish(s, 0.4);
  }

  return {
    rate,
    boom: [boom(11, 1), boom(23, 0.6), boom(37, 0.25)],
    crackle: [crackle(41), crackle(53)],
    whistle: [whistle(61), whistle(73)],
    thump: [thump(83)],
    hiss: [hiss(97)]
  };
}

export { bakeFireworkSounds };
