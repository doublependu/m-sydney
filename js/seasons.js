// The seasons: what Sydney's calendar brings to the city. The date is Sydney's (Australia/Sydney), whatever the player's own time zone:
// - November, 1-30 November: the jacarandas' carpets of fallen flowers, and petals on your car (js/season-november.js);
// - December, 1-26 December: Christmas, the city's big trees and the houses' lights and decorations (js/season-december.js);
// - New Year, 27 December - 15 January: fireworks over the harbour at midnight, the bridge's arch outlined and its message, the Opera
//   House's sails washed in colour (js/season-new-year.js).
// ?date=2026-12-10 sets the date (for tests and pictures) and ?season=off turns them off.
//
// Nothing here is in the first download: js/main.js imports this file once the city round you is complete, and the season's own module
// (SEASON_MODULES in js/main.js) only in its season. Out of season nothing more is fetched and nothing is drawn. A season's module
// imports nothing of the game's but three.js: what it needs comes in `ctx`, so the first download's files stay as they are.
//
// A season's module exports start(ctx), which returns (or resolves to) the season as it runs:
//   { update(dt, elapsed), *work(x, z), state(), stop() }
// - update(): each frame, once the player and the camera have moved, before the frame is drawn;
// - work(): a generator, one step of background work near (x, z) when the world's jobs have room (js/main.js), as the houses' lots are
//   worked out. It returns true if it did something, false if there was nothing to do;
// - state(): what it has and draws, for __gameDebug.season() and the scripts (and debug(command), if it takes any from them);
// - stop(): everything it added taken out of the scene and let go of: the day has moved into another season, or out of them all.
// `ctx` is what the game hands every season (createSeasons() below takes it from js/main.js):
//   season, date        its name and the date ({ y, m, d }) it was started for
//   scene, reveal(group), remove(group)
//                       the scene; reveal() compiles a group's shaders and then adds it (a promise); remove() takes it out and lets go
//                       of its geometry
//   quality             the graphics level (js/quality.js LEVELS): level, houseDetail, bloom, shadowTile...
//   treeField()         the tree field round you now (js/trees.js), made again as you move: null until the street furniture is out
//   lots()              the houses' lots near you (js/lot-details.js), or null
//   player              the controllers (js/controllers.js): entities.car, activeMode, getActiveEntity()
//   glow                the night's glow uniform (cityUniforms.uInteriorGlow): 0.24 at midday to 1.55 at midnight
//   look()              the time of day's look: 'golden', 'midday', 'twilight' or 'midnight'
//   camera()            the camera
//   flying()            whether the player is flying high, when nothing near the ground needs doing
//   ground.top(x, z)    the top of what's drawn on the ground there: paving, lawn, verge, driveway, or the road where there's none
//   ground.prepare(x, z, r)
//                       makes the triangles of one of the map's surfaces within r of (x, z), for ground.top() to see; true if it did one
//                       (js/drawn-ground.js buildNear(): 5-20 ms, so one a step of work())
//   origin, anchor(object)
//                       the world's origin ({ x, z }, js/world-origin.js), and anchorToOrigin(): an anchored group's vertices are
//                       written from the origin, and written again when it moves
//   houses              what a house's shape is worked out with: look(b, whole) (js/building-look.js buildingLook(): its pitch,
//                       gabled, eaves), roofFrame(ring, record) (js/building-footprints.js) and entry(front, style) (js/house-entry.js
//                       houseEntry(): its door and bays)
//   water               the sea's level (m)
//   clear(circles)      room for what the season stands in the city ([{ x, z, r }]): no street tree planted in them, from now (the
//                       street furniture put out again if one stands in one); gives back a function that takes the room away again
//   colliders           { add(list), remove(list) }: what the player can't walk or drive through (js/controllers.js colliders); the
//                       walkers near you keep off them once their paths are made again
//   compile(objects)    objects not yet drawn, with materials meant for what's drawn already, compiled between frames as a stage's are
//                       (a promise): a material copied and changed for a season, ready before it's swapped in
//   harbour             sea() the sea's one sheet (js/city-grid.js buildWater()), sails() the Opera House's shells (js/opera-house.js),
//                       bridge() the Harbour Bridge's lines (js/harbour-bridge.js bridgeOutline())
//   sound               the game's sound (js/audio-system.js): context() and output() (its mix, through its compressor) once there's a
//                       context, live() whether it's playing now (on, unmuted, unpaused, the page shown), voices: the device's events
//   spots(kind)         the spots the model insides held now keep for a season's things (js/interiors.js spots()): [{ kind, id, site,
//                       x, y, z, h, r }] in the world's frame, the QVB's tree under its dome while its ground floor is held

const ZONE = 'Australia/Sydney';

// Each season's first and last day, as [month, day]. New Year runs across the year's end.
const SEASONS = [
  { id: 'november', from: [11, 1], to: [11, 30] },
  { id: 'december', from: [12, 1], to: [12, 26] },
  { id: 'new-year', from: [12, 27], to: [1, 15] }
];

const dayOf = (m, d) => m * 100 + d;

/** The season a date ({ y, m, d }) is in: 'november', 'december', 'new-year', or null */
function seasonOf(date) {
  if (!date) return null;
  const day = dayOf(date.m, date.d);
  for (const s of SEASONS) {
    const from = dayOf(...s.from), to = dayOf(...s.to);
    if (from <= to ? day >= from && day <= to : day >= from || day <= to) return s.id;
  }
  return null;
}

let formatter = null;
/** The date and time in Sydney at `now` (a Date): { y, m, d, hour, minute, second } */
function sydneyClock(now = new Date()) {
  formatter ??= new Intl.DateTimeFormat('en-AU', {
    timeZone: ZONE, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23'
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((p) => [p.type, p.value]));
  return { y: +parts.year, m: +parts.month, d: +parts.day, hour: +parts.hour % 24, minute: +parts.minute, second: +parts.second };
}

/** The date in Sydney at `now`: { y, m, d } */
function sydneyDate(now = new Date()) {
  const { y, m, d } = sydneyClock(now);
  return { y, m, d };
}

/** A date written 2026-12-10, or null if it isn't one */
function parseDate(text) {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const [y, m, d] = match.slice(1).map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return { y, m, d };
}

/**
 * Today, as the seasons see it: { date, season, fixed }. `search`: the page's query (?date=, ?season=off); `now`: the moment. `fixed`:
 * the date was given, so it doesn't change at midnight.
 */
function today({ search = typeof location === 'undefined' ? '' : location.search, now = new Date() } = {}) {
  const query = new URLSearchParams(search);
  const given = parseDate(query.get('date'));
  const date = given ?? sydneyDate(now);
  const off = query.get('season') === 'off';
  return { date, season: off ? null : seasonOf(date), fixed: !!given, off };
}

/** Milliseconds from `now` to the next midnight in Sydney (on the days the clocks change, up to an hour out: it's checked again then) */
function untilSydneyMidnight(now = new Date()) {
  const { hour, minute, second } = sydneyClock(now);
  const left = 86400 - (hour * 3600 + minute * 60 + second);
  return Math.max(1000, left * 1000 - now.getMilliseconds());
}

const dateText = (date) => `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;

/**
 * The season of the day, run: its module imported and started, updated each frame, and given the world's spare time. Read now, and again
 * at each midnight in Sydney while the page stays open. `ctx`: what each season is handed (see the top of this file). `load(id)`: a
 * season's name to its module, a promise, or null where it has none.
 */
function createSeasons(ctx, { search, now = () => new Date(), load = () => null, timers = globalThis } = {}) {
  let current = null; // { id, date, running (once started), starting (a promise) }
  let wanted = null;
  let timer = null;
  let error = null;

  async function begin(day) {
    const { season, date } = day;
    if (current?.id === season) return;
    end();
    if (!season) return;
    const entry = { id: season, date, running: null };
    current = entry;
    try {
      const pending = load(season);
      if (!pending) return; // no module for it (yet)
      const module = await pending;
      if (current !== entry) return; // the day changed while it was fetched
      const running = await module.start({ ...ctx, season, date });
      if (current !== entry) {
        running?.stop?.();
        return;
      }
      entry.running = running;
    } catch (e) {
      error = String(e?.stack || e);
      console.error('[seasons]', e);
    }
  }

  function end() {
    current?.running?.stop?.();
    current = null;
  }

  function check() {
    const day = today({ search, now: now() });
    wanted = day;
    console.log(`[seasons] ${dateText(day.date)} in Sydney${day.fixed ? ' (given)' : ''}: ${day.season ?? (day.off ? 'off' : 'none')}`);
    begin(day);
    if (day.fixed || day.off) return;
    // Again at midnight; early on the day the clocks change, it finds the same date and waits again
    if (timer !== null) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = null;
      check();
    }, untilSydneyMidnight(now()) + 2000);
  }
  check();

  return {
    update(dt, elapsed) {
      current?.running?.update?.(dt, elapsed);
    },
    *work(x, z) {
      const running = current?.running;
      if (!running?.work) return false;
      return yield* running.work(x, z);
    },
    state: () => ({
      date: wanted && dateText(wanted.date), season: wanted?.season ?? null, fixed: !!wanted?.fixed, off: !!wanted?.off,
      running: !!current?.running, error, ...(current?.running?.state?.() ?? {})
    }),
    /** For the scripts: whatever the running season takes (js/season-november.js: { load }) */
    debug: (command) => current?.running?.debug?.(command) ?? null,
    stop() {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      end();
    }
  };
}

export { SEASONS, createSeasons, dateText, parseDate, seasonOf, sydneyClock, sydneyDate, today, untilSydneyMidnight };
