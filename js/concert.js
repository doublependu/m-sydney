// The concert in the Opera House's Concert Hall: fetched when you sit in one of its seats (js/main.js), a new performance each time,
// playing on while you stay in the hall and fading out when you leave it.
//   - its score is made from a seed (js/concert-arranger.js) in a worker (js/concert-worker.js), which then renders the notes it plays
//     once (js/audio-instruments.js: BeepBox's grand piano and trumpet), the first few seconds' first; they're kept while you're in the
//     hall, and let go of when you leave it;
//   - the score is played on the audio clock, each note scheduled a second ahead, with a touch's small variations in time and loudness;
//   - from the stage: the piano and the trumpet each where they stand on it, heard through the hall's own reverb, a longer and fuller
//     impulse than the city's, made at the context's own rate (hallImpulse()); louder nearer the front;
//   - with no sound (muted, or none to be had) it keeps time all the same, on the game's clock, for the players on the stage to follow.
//
// What's sounding when, for whatever follows the music (the performers): now() is the score's time (s) as it's heard; sounding(i) and
// next(i) the notes of 'piano' or 'trumpet' sounding now and starting next; place() the section, its part (who leads), the beat and the
// phrase now. Each takes a score time too. Where they stand on the stage, the hall's reverb and how a note is played: js/concert-sound.js.
// The performers on the stage who play it (js/concert-stage.js) come in this module's chunk too: the music waits for them (`hold`).
import ConcertWorker from './concert-worker.js?worker&inline';
import { bufferFor, renderBuffer } from './audio-instruments.js';
import { STAGE, concertGraph, playNote, stagePoint, toAudio, touch } from './concert-sound.js';
import { arrange, nextAfter, placeAt, soundingAt } from './concert-arranger.js';
import { createConcertStage } from './concert-stage.js';

const AHEAD = 1.0; // s: notes are scheduled this far ahead on the audio clock
const LEAD_IN = 0.8; // s: from the first notes being ready to the first played
const FADE = 2.5; // s: out, on leaving the hall
const RING = 4; // s: after the last note, before a performance is over

/**
 * The concert. `sound`: the game's (js/main.js: { context(), output(), live() }); `frame`: the Concert Hall's (js/opera-house.js
 * hallFrame()), to place the stage; `seed`: the first performance's, or a new one each time. update(dt, { inHall, seated, hold }) each
 * frame: sitting in the hall starts a performance if none is playing; leaving the hall fades it. `hold`: s the music, once it's ready,
 * may still wait to start (for the performers to take their places).
 */
function createConcert({ sound, frame, seed: firstSeed = null }) {
  const positions = { piano: stagePoint(frame, STAGE.piano, 1.0), trumpet: stagePoint(frame, STAGE.trumpet, 1.55) };
  let state = 'idle'; // 'loading' | 'playing' | 'fading' | 'ended'
  let seed = null, score = null, worker = null, graph = null, graphContext = null;
  const buffers = new Map(); // key -> { audio, loop } on graphContext; or its samples, till there's a context to make them on
  let ready = false; // the first batch in
  let next = 0; // the next note to schedule
  let t0 = null; // the context's time of the score's 0
  let gameClock = 0, gameT0 = null; // the score on the game's clock while there's no sound
  let fadeAt = null, endedAt = null;
  let readyFor = 0; // s the music has been ready to start
  let scheduled = 0, skipped = 0, voices = [];
  let firstScheduledAt = null, sittingAt = null, arrangedMs = null, renderMs = null, rendered = 0;
  let count = 0;
  let wasSeated = false;
  let recording = null;

  const context = () => sound.context();
  const live = () => sound.live() && !!context();

  function ensureGraph() {
    const ctx = context();
    if (!ctx) return null;
    if (graphContext !== ctx) {
      graph?.dispose();
      graph = concertGraph(ctx, sound.output(), positions);
      graphContext = ctx;
      // samples kept from before there was a context (or another one), made into this one's buffers
      for (const [key, b] of buffers) if (b.samples) buffers.set(key, toAudio(ctx, b));
    }
    return graph;
  }

  function begin(newSeed) {
    stopVoices();
    seed = newSeed ?? ((Math.random() * 4294967296) >>> 0);
    state = 'loading';
    score = null;
    ready = false;
    next = 0;
    t0 = gameT0 = null;
    fadeAt = endedAt = null;
    readyFor = 0;
    scheduled = skipped = 0;
    firstScheduledAt = null;
    sittingAt = performance.now();
    count++;
    const run = count;
    const have = [...buffers.keys()];
    const take = (data) => {
      if (run !== count) return;
      if (data.score) {
        score = data.score;
        arrangedMs = data.arrangedMs ?? null;
      }
      if (data.buffers) {
        for (const b of data.buffers) {
          if (graphContext) buffers.set(b.key, toAudio(graphContext, b));
          else buffers.set(b.key, b);
        }
        rendered += data.buffers.length;
      }
      if (data.ready) ready = true;
      if (data.done) {
        renderMs = data.ms ?? null;
        ready = true;
        worker?.terminate();
        worker = null;
      }
    };
    try {
      worker?.terminate();
      worker = new ConcertWorker();
      worker.onmessage = ({ data }) => take(data);
      worker.onerror = () => {
        worker?.terminate();
        worker = null;
        renderHere(run, have, take);
      };
      worker.postMessage({ seed, have });
    } catch {
      renderHere(run, have, take);
    }
  }

  // Without a worker: the same, on this thread, a few buffers a frame
  function renderHere(run, have, take) {
    setTimeout(() => {
      if (run !== count) return;
      const s = arrange(seed);
      take({ score: s });
      const seen = new Set(have);
      const keys = [];
      for (const n of s.notes) {
        const { key } = bufferFor(n.i, n.p, n.v);
        if (!seen.has(key)) {
          seen.add(key);
          keys.push({ key, t: n.t });
        }
      }
      const step = () => {
        if (run !== count) return;
        const batch = keys.splice(0, 3);
        // ready once the first 12 s have theirs
        if (batch.length) take({ buffers: batch.map(({ key }) => renderBuffer(key)), ready: !keys.length || keys[0].t > 12 });
        if (keys.length) setTimeout(step, 0);
        else take({ done: true });
      };
      step();
    });
  }

  function stopVoices(at = null) {
    for (const v of voices) {
      try {
        if (at !== null) v.source.stop(at);
        else v.source.stop();
      } catch { /* already stopped */ }
    }
    if (at === null) voices = [];
  }

  /** The score's time now, s: as heard, on the audio clock, or on the game's while there's no sound */
  function now() {
    if (state === 'idle' || state === 'ended' || state === 'loading') return null;
    if (t0 !== null && live()) {
      const ctx = context();
      const heard = ctx.getOutputTimestamp?.().contextTime;
      return (Number.isFinite(heard) && heard > 0 ? heard : ctx.currentTime - (ctx.outputLatency || 0)) - t0;
    }
    if (gameT0 !== null) return gameClock - gameT0;
    return null;
  }

  function schedule() {
    const ctx = context();
    const g = ensureGraph();
    if (!g || !score) return;
    const horizon = ctx.currentTime + AHEAD;
    while (next < score.notes.length) {
      const n = score.notes[next];
      const tn = touch(seed, next);
      const when = t0 + n.t + tn.dt;
      if (when > horizon) break;
      next++;
      if (when < ctx.currentTime - 0.02) {
        skipped++;
        continue;
      }
      const sec = score.sections[n.s];
      const v = playNote(ctx, g.input(n.i), buffers, n, Math.max(when, ctx.currentTime), sec.bpm, tn.dv);
      if (!v) {
        skipped++;
        continue;
      }
      voices.push(v);
      scheduled++;
      if (firstScheduledAt === null) firstScheduledAt = performance.now();
    }
    // let go of those that have ended
    const t = ctx.currentTime;
    if (voices.length > 64) voices = voices.filter((v) => v.ends > t);
  }

  function update(dt, { inHall, seated, hold = 0 }) {
    gameClock += dt;
    // sitting down (or seated when this first runs) starts one, unless one's playing: staying seated after it ends doesn't
    const sat = seated && inHall && !wasSeated;
    wasSeated = seated && inHall;
    if (sat && (state === 'idle' || state === 'ended' || state === 'fading')) begin(state === 'idle' ? firstSeed : null);
    if (!inHall && (state === 'loading' || state === 'playing')) fade();
    if (!inHall && state === 'ended' && buffers.size) buffers.clear();
    if (state === 'loading' && score && ready) readyFor += dt;
    if (state === 'loading' && score && ready && readyFor >= hold) {
      // started on both clocks; the audio's if there's sound
      state = 'playing';
      gameT0 = gameClock + LEAD_IN;
      const ctx = context();
      if (ctx && live()) {
        ensureGraph();
        t0 = ctx.currentTime + LEAD_IN;
        graph.out.gain.cancelScheduledValues(ctx.currentTime);
        graph.out.gain.setValueAtTime(0, ctx.currentTime);
        graph.out.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.3);
      }
    }
    if (state === 'playing') {
      const ctx = context();
      if (live() && ctx) {
        if (t0 === null) {
          // the sound came on mid-performance: the audio clock takes over where the game's had got to
          ensureGraph();
          t0 = ctx.currentTime - (gameClock - gameT0) + 0.1;
          next = score.notes.findIndex((n) => n.t >= ctx.currentTime + 0.1 - t0);
          if (next < 0) next = score.notes.length;
          graph.out.gain.setValueAtTime(1, ctx.currentTime);
        }
        schedule();
      } else if (t0 !== null && ctx) {
        // the sound went off (muted, paused, hidden): the game's clock takes over where the audio's was, and what was scheduled ahead is
        // let go of, to be scheduled again when it's back
        gameT0 = gameClock - (ctx.currentTime - t0);
        t0 = null;
        stopVoices();
      }
      const at = now();
      if (at !== null && at > score.duration + RING) {
        state = 'ended';
        endedAt = performance.now();
      }
    }
    if (state === 'fading' && performance.now() - fadeAt > (FADE + 0.6) * 1000) {
      stopVoices();
      // out of the hall: its notes let go of
      buffers.clear();
      state = 'ended';
      endedAt = performance.now();
    }
  }

  /** Faded out over FADE s, and stopped */
  function fade() {
    if (state !== 'loading' && state !== 'playing') return;
    count++; // a worker still rendering is let go of
    worker?.terminate();
    worker = null;
    const ctx = graphContext;
    if (ctx && graph) {
      const t = ctx.currentTime;
      graph.out.gain.cancelScheduledValues(t);
      graph.out.gain.setValueAtTime(graph.out.gain.value, t);
      graph.out.gain.linearRampToValueAtTime(0, t + FADE);
      stopVoices(t + FADE + 0.05);
    }
    next = score?.notes.length ?? 0;
    state = 'fading';
    fadeAt = performance.now();
  }

  function info() {
    const t = now();
    const place = score && t !== null && t >= 0 ? placeAt(score, Math.min(t, score.duration)) : null;
    const ctx = context();
    return {
      state, seed, t: t === null ? null : +t.toFixed(3), duration: score?.duration ?? null, notes: score?.notes.length ?? 0,
      section: place?.section.kind ?? null, lead: place?.part.lead ?? null, scheduled, skipped,
      playing: graphContext ? voices.filter((v) => v.ends > graphContext.currentTime).length : 0,
      buffers: buffers.size, rendered, arrangedMs: arrangedMs === null ? null : +arrangedMs.toFixed(1), renderMs: renderMs === null ? null : Math.round(renderMs),
      firstNoteAfter: firstScheduledAt === null || sittingAt === null ? null : +((firstScheduledAt - sittingAt) / 1000).toFixed(2),
      rate: ctx?.sampleRate ?? null, reverb: graph?.reverb ?? null, live: live(), gain: graph ? +graph.out.gain.value.toFixed(3) : null,
      endedAgo: endedAt === null ? null : +((performance.now() - endedAt) / 1000).toFixed(1)
    };
  }

  return {
    update,
    fade,
    now,
    get score() { return score; },
    get state() { return state; },
    sounding: (i, t = now()) => (score && t !== null ? soundingAt(score, i, t) : []),
    next: (i, t = now()) => (score && t !== null ? nextAfter(score, i, t) : []),
    place: (t = now()) => (score && t !== null ? placeAt(score, t) : null),
    stage: { ...STAGE, at: (sv, up) => stagePoint(frame, sv, up), positions },
    /**
     * For the scripts: state(), or { seed } a new performance with that seed, { at } jump to a score time (s); { record: true } starts
     * recording the game's sound as it goes into its mix, { record: false } stops it and resolves to it (a data URL)
     */
    debug(command = null) {
      if (command?.record === true) {
        const ctx = context();
        const r = { dest: ctx.createMediaStreamDestination(), chunks: [] };
        sound.output().connect(r.dest);
        r.recorder = new MediaRecorder(r.dest.stream);
        r.recorder.ondataavailable = (e) => r.chunks.push(e.data);
        r.recorder.start(1000);
        recording = r;
        return info();
      }
      if (command?.record === false && recording) {
        const r = recording;
        recording = null;
        return new Promise((done) => {
          r.recorder.onstop = () => {
            sound.output().disconnect(r.dest);
            const reader = new FileReader();
            reader.onload = () => done(reader.result);
            reader.readAsDataURL(new Blob(r.chunks, { type: r.recorder.mimeType }));
          };
          r.recorder.stop();
        });
      }
      if (command?.seed !== undefined) begin(command.seed >>> 0);
      if (command?.at !== undefined && state === 'playing') {
        stopVoices();
        const ctx = context();
        if (t0 !== null && ctx) t0 = ctx.currentTime - command.at;
        if (gameT0 !== null) gameT0 = gameClock - command.at;
        next = score.notes.findIndex((n) => n.t >= command.at);
        if (next < 0) next = score.notes.length;
      }
      return info();
    },
    dispose() {
      count++;
      worker?.terminate();
      stopVoices();
      graph?.dispose();
      buffers.clear();
    }
  };
}

export { createConcert, createConcertStage };
