// New Year's fireworks over the harbour (js/season-new-year.js): where they're fired from, and the show, a script of cues 6 minutes long
// that goes round again.
//
// The firing places, as the City of Sydney's releases have them: the Harbour Bridge (the top of its arch, its deck's waterfall and its
// west side, the most of any), five barges on the water between Goat Island and Garden Island, three platforms in the air between the
// Opera House and the bridge (drone-carried), four of the CBD's rooftops, and Darling Harbour's own barge for its own show. Each is in the
// game's frame (x east, z south, y over the sea), found on the map by name: the barges on water, the rooftops on the towers' roofs as the
// map has them. The bridge's come from its own lines (js/harbour-bridge.js bridgeOutline(), handed in).
//
// A cue is a shell: when it's launched (s into the loop), from where, where it bursts, its kind (js/fireworks.js KINDS), its two colours,
// how big it bursts (m), a seed, and two numbers its kind reads (a fan's way and spread, a ring's tilt, a waterfall's way and length).

const LOOP = 360; // s

const BARGES = [
  { id: 'goat', name: 'east of Goat Island', x: -1000, z: -2250 },
  { id: 'dawes', name: 'west of the bridge, off Dawes Point', x: -560, z: -2370 },
  { id: 'kirribilli', name: 'off Bennelong Point and Kirribilli', x: 640, z: -2120 },
  { id: 'farm-cove', name: "off Mrs Macquarie's Point", x: 1300, z: -2150 },
  { id: 'garden', name: 'off Garden Island', x: 1750, z: -2200 }
];
const DARLING = { id: 'darling', name: 'Darling Harbour, Cockle Bay', x: -610, z: -320 };
// In the air between the Opera House and the bridge, along the line from one to the other
const PLATFORMS = [
  { id: 'platform-1', x: 360, y: 150, z: -2006 },
  { id: 'platform-2', x: 264, y: 165, z: -2102 },
  { id: 'platform-3', x: 168, y: 150, z: -2198 }
];
// Roofs, as the map's buildings have them: Chifley Tower, Governor Phillip Tower, Salesforce Tower (its model's) and Crown Sydney
const ROOFTOPS = [
  { id: 'chifley', x: 327, y: 242, z: -890 },
  { id: 'governor-phillip', x: 269, y: 249, z: -1053 },
  { id: 'salesforce', x: -13, y: 264, z: -1191 },
  { id: 'crown', x: -710, y: 271, z: -1138 }
];
const BARGE_DECK = -1.0; // m: where a barge's mortars are, over the sea's level of -2.2

// Colours, in linear light out of 255: what a firework's stars burn
const COLOURS = {
  red: [255, 18, 10], orange: [255, 80, 8], gold: [255, 150, 35], yellow: [255, 220, 60], white: [255, 240, 215], silver: [200, 215, 255],
  green: [40, 255, 60], cyan: [30, 210, 255], blue: [25, 70, 255], purple: [140, 30, 255], pink: [255, 50, 140], magenta: [255, 20, 220]
};
const pack = ([r, g, b]) => r * 65536 + g * 256 + b;
const unpack = (c) => [Math.floor(c / 65536), Math.floor(c / 256) % 256, c % 256];

/** The firing places, by name: the fixed ones above, and the bridge's from its outline */
function firingPlaces(outline) {
  const east = outline.deck.east, west = outline.deck.west;
  // The top chords near the crown, where the arch is highest: both trusses, every other point
  const arch = [];
  for (const chord of outline.chords) {
    const n = chord.length;
    for (let i = Math.round(n * 0.18); i <= Math.round(n * 0.82); i += 2) arch.push({ x: chord[i][0], y: chord[i][1] + 2, z: chord[i][2] });
  }
  arch.sort((a, b) => a.z - b.z); // north to south, each pair of trusses side by side
  const last = east.length - 1;
  const along = [east[last][0] - east[0][0], east[last][2] - east[0][2]];
  const length = Math.hypot(...along);
  return {
    barges: BARGES.map((b) => ({ ...b, y: BARGE_DECK })),
    darling: { ...DARLING, y: BARGE_DECK },
    platforms: PLATFORMS,
    rooftops: ROOFTOPS,
    arch,
    // The deck's west side, at the deck's height, every 30 m
    west: west.filter((_, i) => i % 3 === 1).map(([x, y, z]) => ({ x, y: y + 3, z })),
    // Fountains along the deck's east side, every 20 m
    deck: east.filter((_, i) => i % 2 === 1).map(([x, y, z]) => ({ x, y: y + 3, z })),
    // The waterfall hangs off the deck's east edge, the whole span under the arch
    waterfall: { x: east[0][0], y: east[0][1] - 0.5, z: east[0][2], yaw: Math.atan2(along[1], along[0]), length },
    bridgeYaw: Math.atan2(along[1], along[0])
  };
}

// A seeded random number, the same show every time
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The script, a phrase a line: [from s, to s, where, kinds, colour pairs, every s, size m, how]. `where`: barges (one after another, round
// them), barges-sweep (west to east and back), barges-all (all five at once), darling, platforms, rooftops, arch (fountains along its top,
// sweeping), deck (fountains along the deck), west (the deck's west side), waterfall (the curtain off the deck, in five lengths). Kinds and colours are taken in turn.
const PAIRS = {
  warm: [['red', 'gold'], ['gold', 'gold'], ['orange', 'red'], ['gold', 'white']],
  cool: [['blue', 'silver'], ['cyan', 'white'], ['purple', 'blue'], ['green', 'cyan']],
  party: [['pink', 'cyan'], ['purple', 'gold'], ['green', 'pink'], ['magenta', 'yellow'], ['red', 'white'], ['blue', 'gold']],
  gold: [['gold', 'gold'], ['yellow', 'gold']],
  white: [['white', 'silver'], ['silver', 'white']],
  rainbow: [['red', 'red'], ['orange', 'orange'], ['yellow', 'yellow'], ['green', 'green'], ['cyan', 'cyan'], ['blue', 'blue'], ['purple', 'purple']]
};
const SCRIPT = [
  // The opening: fountains along the arch, and the barges together
  [0, 12, 'arch', ['comet'], PAIRS.gold, 0.35, 0],
  [1.5, 12, 'barges-all', ['peony'], PAIRS.white, 3.2, 85],
  // The barges one after another, west to east and back; the rooftops answer, then the platforms
  [12, 50, 'barges-sweep', ['chrysanthemum', 'peony', 'peony'], PAIRS.warm.concat(PAIRS.cool), 0.55, 80],
  [30, 60, 'rooftops', ['crossette'], PAIRS.party, 1.6, 55],
  [40, 60, 'platforms', ['strobe', 'peony'], PAIRS.white.concat(PAIRS.cool), 1.2, 38],
  // Rings and two-colour peonies; palms off the bridge's west side
  [60, 95, 'barges', ['ring', 'peony', 'ring', 'chrysanthemum'], PAIRS.party, 0.8, 75],
  [62, 95, 'west', ['palm'], PAIRS.gold, 1.5, 70],
  // A canopy of willows; palms from the rooftops, small shells from the platforms
  [95, 135, 'barges', ['willow'], PAIRS.gold, 0.9, 90],
  [97, 135, 'rooftops', ['palm', 'chrysanthemum'], PAIRS.gold.concat(PAIRS.warm), 2.0, 60],
  [100, 135, 'platforms', ['peony'], PAIRS.cool, 1.0, 35],
  // The bridge's waterfall, comets fanned up off its west side, strobes on the barges
  [135, 136, 'waterfall', ['waterfall'], PAIRS.white, 1, 36],
  [137, 172, 'west', ['comet'], PAIRS.gold.concat(PAIRS.white), 0.6, 0],
  [140, 170, 'deck', ['comet'], PAIRS.white, 0.3, 0],
  [138, 172, 'barges', ['strobe', 'chrysanthemum'], PAIRS.white.concat(PAIRS.warm), 1.0, 80],
  // Quieter: single shells, a ring now and then
  [175, 215, 'barges', ['peony', 'chrysanthemum', 'crossette'], PAIRS.rainbow, 1.4, 85],
  [178, 215, 'rooftops', ['ring'], PAIRS.party, 3.0, 55],
  // Building up
  [215, 260, 'barges-sweep', ['peony', 'chrysanthemum', 'ring', 'crossette', 'strobe'], PAIRS.party.concat(PAIRS.warm), 0.42, 80],
  [220, 260, 'platforms', ['crossette', 'peony'], PAIRS.cool.concat(PAIRS.party), 0.7, 40],
  [225, 260, 'rooftops', ['crossette', 'chrysanthemum'], PAIRS.warm, 1.0, 60],
  [245, 260, 'arch', ['comet'], PAIRS.white, 0.4, 0],
  // The finale: the bridge all together, a canopy of shells off its west side over the arch, fountains along its top and the waterfall
  // under it; the barges at once, the rooftops' strobes, the platforms
  [260, 261, 'waterfall', ['waterfall'], PAIRS.gold, 1, 58],
  [260, 318, 'arch', ['comet'], PAIRS.gold.concat(PAIRS.white), 0.28, 0],
  [261, 305, 'west', ['chrysanthemum', 'peony', 'palm', 'chrysanthemum', 'peony'], PAIRS.gold.concat(PAIRS.party), 0.2, 120],
  [262, 318, 'deck', ['comet'], PAIRS.white, 0.14, 0],
  [262, 305, 'barges-all', ['peony', 'chrysanthemum'], PAIRS.party.concat(PAIRS.rainbow), 2.4, 95],
  [264, 305, 'rooftops', ['strobe', 'crossette'], PAIRS.white.concat(PAIRS.party), 0.9, 60],
  [266, 305, 'platforms', ['crossette', 'strobe'], PAIRS.party, 0.9, 42],
  // ...a canopy of gold to end it
  [305, 318, 'barges-all', ['willow'], PAIRS.gold, 1.4, 105],
  [306, 318, 'west', ['willow'], PAIRS.gold, 1.2, 90],
  // Quiet, a few big white shells, and the smoke drifting off before it goes round again
  [322, 333, 'barges', ['peony', 'chrysanthemum'], PAIRS.white, 3.6, 110],
  // Darling Harbour's own show, all the way through, with its own two finales
  [2, 160, 'darling', ['peony', 'chrysanthemum', 'ring', 'willow'], PAIRS.party.concat(PAIRS.warm), 2.2, 55],
  [160, 176, 'darling', ['peony', 'crossette', 'chrysanthemum'], PAIRS.rainbow, 0.6, 55],
  [176, 290, 'darling', ['chrysanthemum', 'peony', 'strobe', 'palm'], PAIRS.cool.concat(PAIRS.gold), 2.2, 55],
  [290, 310, 'darling', ['peony', 'willow', 'crossette'], PAIRS.party, 0.6, 60]
];

// How high a shell bursts over where it's fired from, by where and how big
function burstHeight(where, size, r) {
  if (where === 'rooftops') return 45 + size * 0.7 + r * 20;
  if (where === 'platforms') return 22 + size * 0.5 + r * 15;
  if (where === 'darling') return 95 + size * 1.1 + r * 25;
  if (where === 'west') return 40 + size * 1.0 + r * 90; // a canopy from just over the arch up
  return 130 + size * 1.3 + r * 40; // the barges
}
// Seconds a shell takes to rise that far: quick off the mortar, slowing towards the top
const riseTime = (height) => Math.min(3.4, Math.max(0.7, Math.sqrt(height) * 0.19));

/** The show's cues, launch time first, for every firing place: [{ t, kind, from, to, size, colours: [a, b] (packed), seed, p1, p2, life? }] */
function showCues(places) {
  const cues = [];
  const rand = random(20270101);
  for (const [from, to, where, kinds, pairs, every, size] of SCRIPT) {
    let n = 0;
    for (let t = from; t < to - 1e-6; t += every, n++) {
      const kind = kinds[n % kinds.length];
      const [ca, cb] = pairs[n % pairs.length].map((c) => pack(COLOURS[c]));
      const jitter = () => (rand() - 0.5) * 0.15 * every;
      const shell = (at, x, y, z, burstY, extra = {}) => {
        const s = size * (0.85 + rand() * 0.3);
        const height = burstY - y;
        const dx = (rand() - 0.5) * 30, dz = (rand() - 0.5) * 30;
        // A ring is tilted, each its own way
        const tilt = kind === 'ring' ? [0.3 + rand() * 0.9, rand() * 6.2832] : [0, 0];
        cues.push({ t: Math.max(0, at), kind, from: [x, y, z], to: [x + dx, burstY, z + dz], rise: riseTime(height), size: s, colours: [ca, cb],
          seed: rand(), p1: tilt[0], p2: tilt[1], ...extra });
      };
      if (where === 'barges' || where === 'barges-sweep') {
        const k = where === 'barges' ? n % 5 : [0, 1, 2, 3, 4, 3, 2, 1][n % 8];
        const b = places.barges[k];
        shell(t + jitter(), b.x, b.y, b.z, b.y + burstHeight('barges', size, rand()));
      } else if (where === 'barges-all') {
        for (const b of places.barges) shell(t + rand() * 0.25, b.x, b.y, b.z, b.y + burstHeight('barges', size, rand()));
      } else if (where === 'darling') {
        const b = places.darling;
        shell(t + jitter(), b.x, b.y, b.z, b.y + burstHeight('darling', size, rand()));
      } else if (where === 'platforms' || where === 'rooftops') {
        const list = places[where];
        const p = list[n % list.length];
        shell(t + jitter(), p.x, p.y, p.z, p.y + burstHeight(where, size, rand()));
      } else if (where === 'west') {
        const list = places.west;
        const p = list[(n * 7) % list.length];
        if (kind === 'comet') {
          // A fan off the side of the deck, spread along it
          cues.push({ t: t + jitter(), kind, from: [p.x, p.y, p.z], to: [p.x, p.y, p.z], rise: 0, size: 0, colours: [ca, cb], seed: rand(),
            p1: places.bridgeYaw, p2: 0.55 });
        } else shell(t + jitter(), p.x, p.y, p.z, p.y + burstHeight('west', size, rand()));
      } else if (where === 'arch' || where === 'deck') {
        // Fountains along the arch's top or the deck, sweeping from one end to the other and back
        const list = places[where];
        const m = list.length, k = n % (2 * m - 2);
        const p = list[k < m ? k : 2 * m - 2 - k];
        cues.push({ t: t + jitter(), kind, from: [p.x, p.y, p.z], to: [p.x, p.y, p.z], rise: 0, size: 0, colours: [ca, cb], seed: rand(),
          p1: places.bridgeYaw, p2: where === 'deck' ? 0.1 : 0.18 });
      } else if (where === 'waterfall') {
        // Five lengths of curtain, side by side along the deck, for as long as the phrase says (`size`: s)
        const w = places.waterfall, part = w.length / 5;
        for (let k = 0; k < 5; k++) {
          const x = w.x + Math.cos(w.yaw) * part * k, z = w.z + Math.sin(w.yaw) * part * k;
          cues.push({ t, kind, from: [x, w.y, z], to: [x, w.y, z], rise: 0, size: 0, colours: [ca, cb], seed: rand(), p1: w.yaw, p2: part, life: size });
        }
      }
    }
  }
  // What matters most when a level has room for fewer: the barges' and the bridge's shells, then Darling Harbour's, the rooftops' and the
  // platforms', then the fountains
  for (const cue of cues) {
    const fountain = cue.kind === 'comet', high = cue.from[1] > 100, low = cue.from[1] < 0;
    cue.keep = fountain ? 0.5 : cue.kind === 'waterfall' ? 1 : low && Math.abs(cue.from[0] - DARLING.x) < 1 ? 0.8 : high ? 0.75 : 1;
  }
  cues.sort((a, b) => a.t - b.t);
  return cues;
}

/** The cues launched after `from` and up to `to`, s into the loop, round the loop's end if `to` is past it */
function cuesBetween(cues, from, to) {
  const out = [];
  if (to - from >= LOOP) return cues.slice();
  const a = ((from % LOOP) + LOOP) % LOOP, b = a + (to - from);
  for (const cue of cues) {
    if ((cue.t > a && cue.t <= b) || (b > LOOP && cue.t + LOOP > a && cue.t + LOOP <= b)) out.push(cue);
  }
  return out;
}

// The colours the bridge's outline and the Opera House's sails are washed in, from each time on (s into the loop), with the show's sections
const LOOKS = [
  [0, 'gold', 'white'], [12, 'red', 'gold'], [30, 'pink', 'cyan'], [60, 'purple', 'pink'], [95, 'gold', 'orange'], [135, 'white', 'cyan'],
  [175, 'blue', 'purple'], [215, 'magenta', 'cyan'], [260, 'purple', 'pink'], [322, 'blue', 'white']
];
const BLEND = 3; // s from one look to the next
const linear = (name) => COLOURS[name].map((v) => v / 255);
/** The show's two colours `t` s into the loop, [r, g, b] each in linear light, blended from one section's to the next */
function lookAt(t) {
  t = ((t % LOOP) + LOOP) % LOOP;
  let k = LOOKS.length - 1;
  while (k > 0 && LOOKS[k][0] > t) k--;
  const now = LOOKS[k], before = LOOKS[(k + LOOKS.length - 1) % LOOKS.length];
  const f = Math.min(1, (t - now[0]) / BLEND);
  return [1, 2].map((j) => linear(before[j]).map((v, i) => v + (linear(now[j])[i] - v) * f));
}

/** The year a New Year's message wishes: the one just begun, or about to (27 December 2026 to 15 January 2027: 2027) */
const newYearOf = (date) => (date.m === 12 ? date.y + 1 : date.y);

export { BARGES, COLOURS, DARLING, LOOKS, LOOP, PLATFORMS, ROOFTOPS, cuesBetween, firingPlaces, lookAt, newYearOf, pack, showCues, unpack };
