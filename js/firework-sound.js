import { bakeFireworkSounds } from './firework-sound-bake.js';

// The fireworks' sound (js/season-new-year.js): each burst's boom, a crossette's or a strobe's crackle, a whistling shell going up, the
// mortar's thump and a comet's rush, each played as late as sound takes to reach you from where it happened (343 m/s), quieter and duller
// the further off. Baked once, in a worker, when the show first starts (js/firework-sound-bake.js); played through the game's own mix and
// compressor, as many at once as the device's events allow, the nearest first.

const SPEED_OF_SOUND = 343; // m/s
const RATE = 48000;
const AUDIBLE = 6000; // m: nothing from further off

// A worker made from the bake's own source: nothing more to fetch
function bakeInWorker() {
  return new Promise((resolve, reject) => {
    let url = null;
    try {
      const source = `const bake = ${bakeFireworkSounds.toString()};
self.onmessage = ({ data }) => {
  const sounds = bake(data.rate);
  const transfer = [];
  for (const list of Object.values(sounds)) if (Array.isArray(list)) for (const s of list) transfer.push(s.buffer);
  self.postMessage(sounds, transfer);
};`;
      url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const worker = new Worker(url);
      const done = () => {
        worker.terminate();
        URL.revokeObjectURL(url);
      };
      worker.onmessage = ({ data }) => {
        done();
        resolve(data);
      };
      worker.onerror = (e) => {
        done();
        reject(e);
      };
      worker.postMessage({ rate: RATE });
    } catch (e) {
      if (url) URL.revokeObjectURL(url);
      reject(e);
    }
  });
}

/** How loud a sound from `d` m off is, of its own level */
const loudness = (d) => Math.min(1, (250 / Math.max(d, 250)) ** 0.9);
/** Where the air has taken the highs off it, Hz */
const cutoff = (d) => 600 + 15000 * Math.exp(-d / 700);
/** When a sound made `ago` s ago `d` m off is heard: s from now */
const delayOf = (d, ago = 0) => Math.max(0, d / SPEED_OF_SOUND - ago);

/**
 * `env`: the game's sound (ctx.sound: context(), output(), live(), voices). { prepare(), play(name, variant, at, listener, level, ago),
 * stop(), state() }; `at` and `listener` in the same frame.
 */
function createFireworkSound(env) {
  let sounds = null, preparing = null, failed = null;
  let buffers = null, buffersOf = null; // AudioBuffers made for one context
  const voices = [];
  const most = Math.max(4, (env.voices ?? 8) + 2);
  const played = { voices: 0, dropped: 0 };

  function prepare() {
    if (sounds || preparing) return preparing;
    preparing = bakeInWorker().catch(() => new Promise((resolve) => setTimeout(() => resolve(bakeFireworkSounds(RATE)))))
      .then((baked) => {
        sounds = baked;
      }).catch((e) => {
        failed = String(e?.message || e);
      });
    return preparing;
  }

  function bufferFor(context, name, variant) {
    if (buffersOf !== context) {
      buffers = {};
      buffersOf = context;
    }
    const list = (buffers[name] ??= []);
    if (!list[variant]) {
      const samples = sounds[name][variant];
      const buffer = context.createBuffer(1, samples.length, sounds.rate ?? RATE);
      buffer.copyToChannel(samples, 0);
      list[variant] = buffer;
    }
    return list[variant];
  }

  function retire(voice) {
    const k = voices.indexOf(voice);
    if (k >= 0) voices.splice(k, 1);
    for (const node of voice.nodes) node.disconnect();
  }

  /**
   * A sound `name` (its `variant`) made at `at` ({ x, y, z }) `ago` s ago, heard at `listener`, at `level` of its own loudness. False if
   * it's not heard: no sound yet, too far, or quieter than all those playing when there's no room.
   */
  function play(name, variant, at, listener, level = 1, ago = 0) {
    const context = env.context();
    const output = env.output();
    if (!sounds || !context || !output || !env.live()) return false;
    const d = Math.hypot(at.x - listener.x, at.y - listener.y, at.z - listener.z);
    if (d > AUDIBLE) return false;
    const gain = level * loudness(d);
    if (gain < 0.01) return false;
    const now = context.currentTime;
    for (let i = voices.length - 1; i >= 0; i--) if (voices[i].ends < now) retire(voices[i]);
    if (voices.length >= most) {
      let quietest = voices[0];
      for (const v of voices) if (v.gain < quietest.gain) quietest = v;
      if (quietest.gain >= gain) {
        played.dropped++;
        return false;
      }
      quietest.source.stop();
      retire(quietest);
    }
    const buffer = bufferFor(context, name, variant % sounds[name].length);
    const source = context.createBufferSource();
    source.buffer = buffer;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = Math.min(cutoff(d), context.sampleRate * 0.45);
    filter.Q.value = 0.5;
    const volume = context.createGain();
    volume.gain.value = gain;
    // Its way from you, its distance worked out above
    const panner = context.createPanner();
    panner.panningModel = 'equalpower';
    panner.distanceModel = 'inverse';
    panner.rolloffFactor = 0;
    if (panner.positionX) {
      panner.positionX.value = at.x;
      panner.positionY.value = at.y;
      panner.positionZ.value = at.z;
    } else panner.setPosition(at.x, at.y, at.z);
    source.connect(filter).connect(volume).connect(panner).connect(output);
    const when = now + delayOf(d, ago);
    source.start(when);
    const voice = { source, nodes: [source, filter, volume, panner], gain, ends: when + buffer.duration };
    source.onended = () => retire(voice);
    voices.push(voice);
    played.voices++;
    return true;
  }

  /** Everything playing, or still to play, faded out at once and let go of: the show's stopped */
  function stop() {
    const context = env.context();
    const now = context?.currentTime ?? 0;
    for (const v of voices.splice(0)) {
      v.source.onended = null;
      try {
        v.nodes[2].gain.setTargetAtTime(0, now, 0.05);
        v.source.stop(now + 0.3);
      } catch { /* already stopped */ }
      setTimeout(() => {
        for (const node of v.nodes) node.disconnect();
      }, 400);
    }
  }

  return {
    prepare,
    play,
    stop,
    ready: () => !!sounds,
    state: () => ({ baked: !!sounds, failed, playing: voices.length, most, ...played })
  };
}

export { SPEED_OF_SOUND, createFireworkSound, cutoff, delayOf, loudness };
