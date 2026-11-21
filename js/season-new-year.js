import * as THREE from 'three/webgpu';
import { KINDS, MODE, createFireworks } from './fireworks.js';
import { LOOP, cuesBetween, firingPlaces, lookAt, newYearOf, showCues } from './firework-show.js';
import { createHarbourDressing } from './new-year-harbour.js';
import { createFireworkSound } from './firework-sound.js';

// New Year, 27 December - 15 January (js/seasons.js): fireworks over the harbour, at midnight only (the time of day's midnight look). One
// show of 6 minutes, round and round, fired from the Harbour Bridge, five barges, three platforms in the air, four of the CBD's rooftops
// and Darling Harbour's own barge (js/firework-show.js), drawn on the GPU (js/fireworks.js). Round them the bridge's arch outlined, the
// message on its east pylons, the Opera House's sails washed in colour and the bursts' colours in the water (js/new-year-harbour.js),
// and the booms, each as late as the sound takes to reach you (js/firework-sound.js).
//
// Golden hour, midday and twilight have none of it: nothing is made, drawn or played until the first time it's midnight. Switched away from
// midnight the show stops and everything of it is hidden; switched back, it starts again from wherever its loop is then (its clock is the
// game's). The set-up is a few steps of the world's spare time (work()), the shaders compiled between frames.

const PREFILL = 6; // s of the show already in the air when it starts
const LONGEST = 70; // s: the longest a cue lasts (a waterfall)

function start(ctx) {
  const { quality, origin } = ctx;
  const year = newYearOf(ctx.date);
  let wanted = false, ready = false, active = false, setting = null;
  let fireworks = null, dressing = null, sound = null, stage = null, places = null, cues = null;
  let sea = null, sails = null; // { mesh, own, show }: the material it's drawn with, and the show's copy
  let offset = 0; // s added to the game's clock: the scripts' { at }
  let clock = 0, last = null; // the show's clock now, and where it was when the cues were last launched
  const setup = { ms: 0, steps: 0, longest: 0 };
  const heard = { bursts: 0, launches: 0 };
  let lastCrackle = new Map(); // a waterfall's slot: when it last crackled

  function* setUp() {
    const outline = ctx.harbour.bridge();
    places = firingPlaces(outline);
    cues = showCues(places);
    yield;
    fireworks = createFireworks({ level: quality.level });
    fireworks.show();
    yield;
    dressing = createHarbourDressing({ outline, places, year, now: fireworks.u.now });
    yield;
    stage = new THREE.Group();
    stage.name = 'NewYear';
    stage.add(fireworks.group, dressing.group);
    yield ctx.reveal(stage);
    stage.visible = false;
    // The sea's and the sails' copies, compiled between frames before they're drawn
    const proxies = [];
    const copy = (mesh, made) => {
      if (!mesh) return null;
      const show = made(mesh.material);
      const proxy = new THREE.Mesh(mesh.geometry, show);
      proxy.castShadow = mesh.castShadow;
      proxy.receiveShadow = mesh.receiveShadow;
      proxies.push(proxy);
      return { mesh, own: mesh.material, show };
    };
    const brightGain = quality.level === 'low' ? 0.5 : 0.6;
    sea = copy(ctx.harbour.sea(), (m) => dressing.sea(m, fireworks.bright, fireworks.u.brightCount, brightGain));
    sails = copy(ctx.harbour.sails(), (m) => dressing.sails(m));
    if (proxies.length) yield ctx.compile(proxies);
    sound = createFireworkSound(ctx.sound);
    sound.prepare();
    ready = true;
  }

  // The show on or off: what's drawn, the sea's and sails' materials, and the sound
  function setActive(on) {
    active = on;
    stage.visible = on;
    for (const m of [sea, sails]) if (m) m.mesh.material = on ? m.show : m.own;
    if (!on) {
      fireworks.clear();
      sound.stop();
      last = null;
    }
  }

  // The cues from `from` to `to` on the show's clock launched, each at its own time on it
  function launchBetween(from, to, wanted = () => true) {
    for (const cue of cuesBetween(cues, from, to)) {
      const at = to - ((((to - cue.t) % LOOP) + LOOP) % LOOP);
      if (wanted(cue, at)) fireworks.launch(cue, at);
    }
  }

  // What's heard: each shell that bursts or is fired between `from` and `to`, from where it happened, as late as it takes
  function listen(from, to) {
    if (!sound.ready()) return;
    const camera = ctx.camera().position;
    const listener = { x: camera.x, y: camera.y, z: camera.z };
    const here = (p) => ({ x: p[0] - origin.x, y: p[1], z: p[2] - origin.z });
    for (const [s, slot] of fireworks.slots.entries()) {
      if (!slot) continue;
      const { kind } = slot;
      if (slot.launch > from && slot.launch <= to) {
        heard.launches++;
        if (kind.mode === MODE.fan) sound.play('hiss', 0, here(slot.from), listener, 0.5, to - slot.launch);
        else if (slot.burst > slot.launch) {
          sound.play('thump', 0, here(slot.from), listener, 0.55, to - slot.launch);
          if (slot.seed < 0.22) sound.play('whistle', Math.floor(slot.seed * 10), here(slot.from), listener, 0.35, to - slot.launch);
        }
      }
      if (kind.mode === MODE.curtain) {
        // The waterfall crackles all along while it falls
        const at = lastCrackle.get(s) ?? -Infinity;
        if (to >= slot.burst && to < slot.burst + slot.life && to - at > 1.6) {
          lastCrackle.set(s, to);
          const k = Math.random();
          const p = [slot.to[0] + Math.cos(slot.p1) * slot.p2 * k, slot.to[1] - 10, slot.to[2] + Math.sin(slot.p1) * slot.p2 * k];
          sound.play('crackle', s, here(p), listener, 0.35, 0);
        }
        continue;
      }
      if (slot.burst > from && slot.burst <= to && kind.mode !== MODE.fan) {
        heard.bursts++;
        const big = slot.size > 85 ? 0 : slot.size > 55 ? 1 : 2;
        sound.play('boom', big, here(slot.to), listener, [1, 0.8, 0.6][big], to - slot.burst);
        if (kind === KINDS.crossette || kind === KINDS.strobe || kind === KINDS.willow) {
          sound.play('crackle', s, here(slot.to), listener, kind === KINDS.willow ? 0.25 : 0.45, to - slot.burst - 0.4);
        }
      }
    }
  }

  return {
    update(dt, elapsed) {
      clock = elapsed + offset;
      const midnight = ctx.look() === 'midnight';
      if (!ready) {
        wanted ||= midnight;
        return;
      }
      if (midnight !== active) setActive(midnight);
      if (!active) return;
      // Started, or back after a long gap (a hidden tab): the last few seconds of the show already in the air, and a waterfall still falling
      if (last === null || clock - last > 2 || clock < last) {
        fireworks.clear();
        launchBetween(clock - LONGEST, clock, (cue, at) => at > clock - PREFILL || (cue.life && at + cue.life > clock));
      } else {
        launchBetween(last, clock);
        listen(last, clock);
      }
      last = clock;
      fireworks.update(clock, origin);
      dressing.update(lookAt(clock));
    },
    *work() {
      if (ready || !wanted) return false;
      setting ??= setUp();
      for (;;) {
        const began = performance.now();
        const { value, done } = setting.next();
        const ms = performance.now() - began;
        setup.ms += ms;
        setup.steps++;
        setup.longest = Math.max(setup.longest, ms);
        if (done) break;
        yield value;
      }
      return true;
    },
    state: () => ({
      ready, wanted, active, year, loop: Math.round((((clock % LOOP) + LOOP) % LOOP) * 10) / 10,
      setup: { ms: Math.round(setup.ms), steps: setup.steps, longest: Math.round(setup.longest) },
      shells: fireworks?.state(clock) ?? null, sound: sound?.state() ?? null, heard: { ...heard },
      materials: { sea: !!sea && sea.mesh.material === sea.show, sails: !!sails && sails.mesh.material === sails.show },
      drawn: !!stage?.visible && !!stage.parent
    }),
    // For the scripts: { at: s } the show's loop put at that point; { bright: true } the brightest bursts now; { cues: true } how many
    // there are and the places; { shown } everything of it shown or hidden at once
    debug(command = {}) {
      if (command.at !== undefined) {
        const now = ((clock % LOOP) + LOOP) % LOOP;
        offset += command.at - now;
        last = null;
        return command.at;
      }
      if (command.bright) return fireworks?.brightest(clock) ?? null;
      if (command.cues) return cues && { count: cues.length, places };
      if (command.shown !== undefined && stage) {
        stage.visible = !!command.shown;
        return stage.visible;
      }
      return null;
    },
    stop() {
      if (ready && active) setActive(false);
      for (const m of [sea, sails]) {
        if (!m) continue;
        m.mesh.material = m.own;
        m.show.dispose();
      }
      sound?.stop();
      if (stage) ctx.remove(stage);
      dressing?.dispose();
      fireworks?.dispose();
      lastCrackle = new Map();
    }
  };
}

export { start };
