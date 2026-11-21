// The concert's duet: a new arrangement of Waltzing Matilda for piano and trumpet from a seed, made when you sit in the Concert Hall
// (js/concert.js, in its worker). The tune is Marie Cowan's of 1903 (public domain), in B♭, its verse and chorus written once as data
// below; the arrangement is made by rules, not taste:
//   the form    an intro, then the head (4/4) or the tune as a jazz waltz (3/4), then two or three of a jazz waltz, a minor ballad
//               reharmonised and a faster swing, picked and ordered by the seed, then the head out and a coda, about 4 minutes
//   leading     who carries the tune swaps from chorus to chorus; the other answers in its gaps or plays a counter-line under it
//               (the trumpet), or comps and fills round it (the piano); in a swing chorus they trade two-bar phrases, each starting
//               where the other's ended
//   the lines   the tune's own motifs, varied; chord tones on the strong beats, steps and chromatic approaches between them
//   registers   while the trumpet sounds, the piano keeps out of its band (each part's `trumpet` [lo, hi])
// Both play all the way through: neither is left silent for more than two bars.
//
// The score (arrange(seed)): {
//   seed, title, key, duration (s, to the last note's end),
//   sections: [{ kind, start, end (s), meter (3|4), bpm, bars, swing (0.5 straight - 0.67), lead ('trumpet'|'piano'|'trade'|'both'),
//                parts: [{ start, end (s), lead, mode, trumpet: [lo, hi] }] }],
//   notes:    [{ t (s), d (s), p (MIDI), v (0-1), i ('piano'|'trumpet'), role, hand ('l'|'r', the piano's), s (section) }], by t,
//   phrases:  [{ i, start, end (s), role }]: each instrument's runs of notes with no rest of nearly half a beat or more (the trumpet
//             breathes between them, at least every 10 s or so),
//   beats:    [{ t (s), bar, beat, s }]: every beat, its bar (in its section, from 0) and its place in the bar (0 the downbeat)
// }
// Its timing at the audio clock and what's sounding when: js/concert.js.

const TITLE = 'Waltzing Matilda';
const RANGES = { piano: [27, 95], trumpet: [53, 86] }; // MIDI: what js/audio-instruments.js renders
const TRUMPET_LEAD = [60, 86]; // the trumpet's band leading or soloing: the piano keeps below it while it sounds
const TRUMPET_UNDER = [53, 64]; // under the piano's tune: the piano's tune and solos above it, its left hand below
const PIANO_ABOVE = 65; // the piano's tune and solo lines, over the trumpet's low band
const LOW_HAND_TOP = 52; // the piano's left hand while the trumpet's in its low band
const BREATH = 0.45; // beats: a rest as long as this is a breath, and ends a phrase

// --- The tune ---------------------------------------------------------------------------------------------------------------
// Waltzing Matilda (Cowan, 1903) in B♭, a bar a line, each note its MIDI pitch and its length in eighths; '^' marks a pickup into
// the next phrase ("Once a", "and he"). The first line is the pickup alone, at the end of a bar.
const TUNE_BARS = [
  '^70/1 ^72/1', //                               Once a
  '74/2 74/2 72/2 72/2', //                       jol-ly swag-man
  '70/1 72/1 74/1 70/1 67/1 69/1 70/2', //        camped by a bil-la-bong,
  '65/2 70/1 74/1 77/2 77/1 77/1', //             Un-der the shade of a
  '77/2 75/1 74/1 72/2 ^70/1 ^72/1', //           coo-li-bah tree, and he
  '74/2 74/1 74/1 72/2 72/2', //                  sang as he watched and
  '70/1 72/1 74/1 70/1 67/1 69/1 70/2', //        wait-ed till his bil-ly boiled,
  '65/2 70/1 74/1 77/2 75/1 74/1', //             You'll come a-waltz-ing Ma-
  '72/2 72/1 72/1 70/4', //                       til-da with me.
  '77/2 77/1 77/1 77/2 74/2', //                  Waltz-ing Ma-til-da,
  '82/2 82/1 82/1 81/2 79/2', //                  waltz-ing Ma-til-da,
  '77/2 77/1 77/1 79/2 77/1 77/1', //             You'll come a-waltz-ing Ma-
  '77/2 75/1 74/1 72/2 ^70/1 ^72/1', //           til-da with me, and he
  '74/2 74/1 74/1 72/2 72/2', //                  sang as he watched and
  '70/1 72/1 74/1 70/1 67/1 69/1 70/2', //        wait-ed till his bil-ly boiled,
  '65/2 70/1 74/1 77/2 75/1 74/1', //             You'll come a-waltz-ing Ma-
  '72/2 72/1 72/1 70/4' //                        til-da with me.
];
// Its chords, half a bar each (or a bar), the head's
const HEAD_CHORDS = ['Bb F7', 'Gm7 Ebmaj7', 'Bb Bb7', 'Eb F7', 'Bb F7', 'Gm7 Ebmaj7', 'Bb Ebmaj7', 'F7 Bb',
  'Bb Bb7', 'Ebmaj7 F7', 'Bb G7', 'Cm7 F7', 'Bb F7', 'Gm7 Ebmaj7', 'Bb Ebmaj7', 'F7 Bb'];
// The swing's: the same, with turnarounds into the chorus and back to the top, and a ii-V into the IV
const SWING_CHORDS = ['Bb6 F7', 'Gm7 Ebmaj7', 'Bb6 Fm7 Bb7', 'Ebmaj7 F7', 'Bb6 F7', 'Gm7 Ebmaj7', 'Bb6 Ebmaj7', 'Cm7 F7 Bb6 G7',
  'Bb6 Bb7', 'Ebmaj7 F7', 'Bb6 G7', 'Cm7 F7', 'Bb6 F7', 'Gm7 Ebmaj7', 'Bb6 Ebmaj7', 'Cm7 F7 Dm7 G7'];
// The ballad's: B♭ minor, reharmonised
const BALLAD_CHORDS = ['Bbm F7', 'Gbmaj7 Ebm7', 'Bbm Bbm7', 'Ebm7 F7', 'Bbm F7', 'Gbmaj7 Ebm7', 'Bbm Ebm7', 'F7b9 Bbm',
  'Bbm Gm7b5', 'Ebm7 Ab7', 'Dbmaj7 Gbmaj7', 'Cm7b5 F7b9', 'Bbm F7', 'Gbmaj7 Ebm7', 'Bbm Ebm7', 'F7b9 Bbm6'];
const INTRO_CHORDS = ['Bb6 Gm7', 'Cm7 F7', 'Bb6 Gm7', 'Cm7 F7'];
const CODA_CHORDS = ['Bb6 Ebmaj7', 'Cm7 F7', 'Dm7 G7', 'Cm7 F7', 'Bb6 Ebmaj7', 'Cm7 F7', 'Bb6', 'Bb6'];
// The intro as a waltz, a bar of 3/4 for each half bar
const WALTZ_INTRO_CHORDS = ['Bb6', 'Gm7', 'Cm7', 'F7', 'Bb6', 'Gm7', 'Cm7', 'F7'];
// The tune's two-bar phrases, in beats from its first bar (the pickups before them)
const PHRASES = [[-1, 8], [8, 15], [15, 24], [24, 32], [32, 40], [40, 47], [47, 56], [56, 64]];

const PC = { C: 0, Db: 1, D: 2, Eb: 3, E: 4, F: 5, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
const QUALITIES = {
  '': { tones: [0, 4, 7], color: [9, 2], scale: [0, 2, 4, 5, 7, 9, 11] },
  6: { tones: [0, 4, 7, 9], color: [2], scale: [0, 2, 4, 5, 7, 9, 11] },
  maj7: { tones: [0, 4, 7, 11], color: [2, 9], scale: [0, 2, 4, 5, 7, 9, 11] },
  7: { tones: [0, 4, 7, 10], color: [2, 9], scale: [0, 2, 4, 5, 7, 9, 10] },
  '7b9': { tones: [0, 4, 7, 10], color: [1, 8], scale: [0, 1, 4, 5, 7, 8, 10] },
  m: { tones: [0, 3, 7], color: [2, 10], scale: [0, 2, 3, 5, 7, 8, 10] },
  m6: { tones: [0, 3, 7, 9], color: [2], scale: [0, 2, 3, 5, 7, 9, 11] },
  m7: { tones: [0, 3, 7, 10], color: [2, 5], scale: [0, 2, 3, 5, 7, 9, 10] },
  m7b5: { tones: [0, 3, 6, 10], color: [5], scale: [0, 1, 3, 5, 6, 8, 10] }
};
const chordCache = new Map();
function chordOf(name) {
  if (!chordCache.has(name)) {
    const m = name.match(/^([A-G]b?)(.*)$/);
    const q = QUALITIES[m[2]];
    if (!q) throw new Error(`no chord ${name}`);
    const root = PC[m[1]];
    chordCache.set(name, { name, root, tones: q.tones.map((t) => (root + t) % 12), color: q.color.map((t) => (root + t) % 12),
      scale: q.scale.map((t) => (root + t) % 12), seventh: q.tones.length > 3 ? (root + q.tones[3]) % 12 : (root + q.tones[2]) % 12 });
  }
  return chordCache.get(name);
}
/** A bar's chords to one a beat */
function gridOf(lines, meter) {
  return lines.map((line) => {
    const names = line.split(' ');
    return Array.from({ length: meter }, (_, k) => chordOf(names[Math.min(names.length - 1, Math.floor(k * names.length / meter))]));
  });
}

/** The tune as notes: { b, d (beats from its first bar), p, pk (a pickup), ph (its phrase) } */
const TUNE = (() => {
  const notes = [];
  TUNE_BARS.forEach((line, bar) => {
    const tokens = line.split(' ').map((t) => ({ pk: t[0] === '^', p: Number(t.replace('^', '').split('/')[0]), e: Number(t.split('/')[1]) }));
    const total = tokens.reduce((s, t) => s + t.e, 0);
    let at = (bar - 1) * 8 + (8 - total) * (bar === 0 ? 1 : 0);
    for (const t of tokens) {
      notes.push({ b: at / 2, d: t.e / 2, p: t.p, pk: t.pk });
      at += t.e;
    }
  });
  for (const n of notes) n.ph = PHRASES.findIndex(([a, b]) => n.b >= a && n.b < b);
  return notes;
})();
// Its motifs, as steps along the chord's scale from their first note, and their rhythms in beats: "Waltzing Matilda", "camped by a
// billabong", "coolibah tree", "under the shade", "jolly swagman"
const MOTIFS = [
  [[0, 1], [0, 0.5], [0, 0.5], [0, 1], [-2, 1]],
  [[0, 0.5], [1, 0.5], [2, 0.5], [0, 0.5], [-2, 0.5], [-1, 0.5], [0, 1]],
  [[0, 1], [-1, 0.5], [-2, 0.5], [-3, 1]],
  [[0, 1], [3, 0.5], [5, 0.5], [7, 1]],
  [[0, 1], [0, 1], [-1, 1], [-1, 1]]
];

// --- Pitches ----------------------------------------------------------------------------------------------------------------
const pcOf = (p) => ((p % 12) + 12) % 12;
const clampTo = (p, [lo, hi]) => {
  while (p < lo) p += 12;
  while (p > hi) p -= 12;
  return p;
};
/** The nearest pitch to `p` whose class is in `pcs`, in a direction (+1 up, -1 down, 0 either), within [lo, hi] */
function nearestIn(p, pcs, dir = 0, [lo, hi] = [0, 127]) {
  let best = null;
  for (let q = Math.max(lo, p - 12); q <= Math.min(hi, p + 12); q++) {
    if (!pcs.includes(pcOf(q))) continue;
    if (dir > 0 && q <= p) continue;
    if (dir < 0 && q >= p) continue;
    if (best === null || Math.abs(q - p) < Math.abs(best - p)) best = q;
  }
  return best ?? (dir ? nearestIn(p, pcs, 0, [lo, hi]) : clampTo(p, [lo, hi]));
}
/** `steps` along a scale from `p` (itself on it or not) */
function scaleStep(p, scale, steps) {
  let q = nearestIn(p, scale);
  const dir = Math.sign(steps);
  for (let k = 0; k < Math.abs(steps); k++) q = nearestIn(q, scale, dir);
  return q;
}
/**
 * A chord voiced within [lo, hi]: its 3rd and 7th first, then its colour and 5th, as many as `count`, each where it moves least from
 * `prev` (the last voicing), sorted
 */
function voicing(chord, [lo, hi], count, prev = null) {
  const wanted = [chord.tones[1], chord.seventh, ...chord.color, chord.tones[2], chord.root].filter((v, k, a) => a.indexOf(v) === k).slice(0, count);
  const centre = prev?.length ? prev.reduce((s, p) => s + p, 0) / prev.length : (lo + hi) / 2;
  const notes = [];
  for (const pc of wanted) {
    let best = null;
    for (let q = lo; q <= hi; q++) {
      if (pcOf(q) !== pc || notes.includes(q)) continue;
      // two notes a semitone apart only at the top of the voicing
      if (notes.some((n) => Math.abs(n - q) === 1 && Math.max(n, q) !== hi)) continue;
      if (best === null || Math.abs(q - centre) < Math.abs(best - centre)) best = q;
    }
    if (best !== null) notes.push(best);
  }
  return notes.sort((a, b) => a - b);
}

// --- Seeded random ------------------------------------------------------------------------------------------------------
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
const pickOne = (r, list) => list[Math.floor(r() * list.length) % list.length];
const between = (r, lo, hi) => lo + (hi - lo) * r();

// --- The form ------------------------------------------------------------------------------------------------------------
const KINDS = {
  intro: { meter: 4, bpm: [100, 118], swing: 0.6 },
  head: { meter: 4, bpm: [100, 118], swing: 0.6 },
  waltz: { meter: 3, bpm: [138, 164], swing: 0.6 },
  ballad: { meter: 4, bpm: [60, 70], swing: 0.64 },
  swing: { meter: 4, bpm: [176, 204], swing: 0.58 },
  out: { meter: 4, bpm: [100, 118], swing: 0.6 },
  coda: { meter: 4, bpm: [100, 118], swing: 0.6 }
};
const AIM = [228, 252]; // s: the whole
const MOST_CHORUSES = { waltz: 2, ballad: 1, swing: 3 };

/** Which sections, how many choruses of each, and their tempos: { first, middle: [{ kind, choruses }], bpm: { kind: bpm } } */
function plan(r) {
  const first = r() < 0.7 ? 'head' : 'waltz';
  const pool = ['waltz', 'ballad', 'swing'].filter((k) => k !== first || r() < 0.4);
  // two or three of them, in an order of the seed's (a shuffle of its own, the same in every browser), never the same twice running
  for (let k = pool.length - 1; k > 0; k--) {
    const j = Math.floor(r() * (k + 1));
    [pool[k], pool[j]] = [pool[j], pool[k]];
  }
  const count = pool.length > 2 && r() < 0.45 ? 3 : 2;
  const middle = pool.slice(0, count).map((kind) => ({ kind, choruses: kind === 'swing' ? 2 : 1 }));
  if (middle[0]?.kind === first) middle.push(middle.shift());
  const bpm = {};
  for (const [kind, k] of Object.entries(KINDS)) bpm[kind] = Math.round(between(r, ...k.bpm));
  bpm.intro = bpm.out = bpm.coda = bpm.head;
  if (first === 'waltz') bpm.intro = bpm.waltz;
  return { first, middle, bpm };
}
function beatsOf(kind, choruses = 1) {
  if (kind === 'intro') return 16;
  if (kind === 'coda') return 32 + 6; // and its ritardando: about 6 beats more
  return (KINDS[kind].meter === 3 ? 96 : 64) * choruses;
}
function lengthOf({ first, middle, bpm }) {
  const s = (kind, beats) => beats * 60 / bpm[kind];
  let total = s('intro', first === 'waltz' ? 24 : 16) + s(first, beatsOf(first)) + s('out', 64) + s('coda', beatsOf('coda'));
  for (const m of middle) total += s(m.kind, beatsOf(m.kind, m.choruses));
  return total + 4; // the last chord's ring
}
/** The plan fitted to AIM: choruses added or taken off, then the tempos nudged within their ranges */
function fit(r, p) {
  for (let guard = 0; guard < 12; guard++) {
    const t = lengthOf(p);
    if (t >= AIM[0] && t <= AIM[1]) break;
    const long = t > AIM[1];
    const m = [...p.middle].sort((a, b) => (long ? b.choruses - a.choruses : a.choruses - b.choruses))
      .find((x) => (long ? x.choruses > 1 : x.choruses < MOST_CHORUSES[x.kind]));
    const step = m ? beatsOf(m.kind) * 60 / p.bpm[m.kind] : 0;
    if (m && Math.abs((long ? t - step : t + step) - (AIM[0] + AIM[1]) / 2) < Math.abs(t - (AIM[0] + AIM[1]) / 2)) m.choruses += long ? -1 : 1;
    else {
      // tempos: all faster or slower together, within their ranges
      const k = Math.max(0.85, Math.min(1.15, t / ((AIM[0] + AIM[1]) / 2)));
      for (const kind of Object.keys(p.bpm)) {
        const [lo, hi] = KINDS[kind].bpm;
        p.bpm[kind] = Math.round(Math.max(lo, Math.min(hi, p.bpm[kind] * k)));
      }
      if (lengthOf(p) === t) break;
    }
  }
  return p;
}

// --- Sections, and writing into them ------------------------------------------------------------------------------------
function makeSection(kind, bpm, chordLines, extra = {}) {
  const meter = KINDS[kind].meter;
  const grid = gridOf(chordLines, meter);
  return { kind, meter, bpm, swing: KINDS[kind].swing, bars: grid.length, grid, beats: grid.length * meter, parts: [], ...extra };
}
const chordAt = (sec, b) => {
  const bar = Math.max(0, Math.min(sec.bars - 1, Math.floor(b / sec.meter)));
  return sec.grid[bar][Math.max(0, Math.min(sec.meter - 1, Math.floor(b - bar * sec.meter)))];
};
const strong = (sec, b) => Math.abs(b - Math.round(b)) < 1e-6 && (sec.meter === 3 ? Math.round(b) % 3 === 0 : Math.round(b) % 2 === 0);
const onBeat = (b) => Math.abs(b - Math.round(b)) < 1e-6;

function writer(sec) {
  const notes = [];
  return {
    notes,
    put(i, b, d, p, v, role, hand) {
      if (d <= 0.01 || b < -2 || b >= sec.beats + 8) return;
      notes.push({ i, b, d, p: Math.round(p), v: Math.max(0.05, Math.min(1, v)), role, hand: i === 'piano' ? hand ?? 'r' : undefined });
    }
  };
}

// --- The lines -----------------------------------------------------------------------------------------------------------
/** The tune for a section: as written, as a waltz (each half bar a bar of 3/4, its first note held a beat more), or in B♭ minor */
function tuneFor(kind) {
  let notes = TUNE.map((n) => ({ ...n }));
  if (kind === 'waltz') {
    const out = [];
    for (const n of notes) {
      const half = Math.floor(n.b / 2), at = n.b - half * 2;
      const firstOfHalf = !n.pk && !notes.some((m) => !m.pk && m.b < n.b && Math.floor(m.b / 2) === half);
      if (n.pk) out.push({ ...n, b: half * 3 + 1 + at });
      else out.push({ ...n, b: half * 3 + at + (firstOfHalf ? 0 : 1), d: n.d + (firstOfHalf ? 1 : 0) });
    }
    notes = out;
  }
  if (kind === 'ballad') {
    const grid = gridOf(BALLAD_CHORDS, 4);
    for (const n of notes) {
      const bar = Math.max(0, Math.floor(n.b / 4)), c = grid[Math.min(15, bar)][Math.max(0, Math.floor(n.b - bar * 4))];
      // D, G and A lowered, unless the chord under it holds the raised one (A over F7)
      if ([2, 7, 9].includes(pcOf(n.p)) && !(c.tones.includes(pcOf(n.p)) && !c.tones.includes(pcOf(n.p - 1)))) n.p -= 1;
    }
  }
  return notes;
}

/**
 * The tune or a variation of it, as the lead plays it: `amount` 0-1 of its phrases varied (an anticipation, an approach into a long
 * note, a repeated note turned into a neighbour, its end an improvised run), moved into `band`. Writes into `w` from beat `at`.
 */
function leadLine(r, sec, w, i, at, amount, band, v0) {
  const tune = tuneFor(sec.kind);
  const shift = band[0] > 70 ? 12 : 0;
  const out = [];
  for (let ph = 0; ph < PHRASES.length; ph++) {
    const notes = tune.filter((n) => n.ph === ph).map((n) => ({ ...n, p: n.p + shift }));
    const vary = r() < amount;
    if (vary && notes.length > 3) {
      const how = pickOne(r, ['push', 'approach', 'neighbour', 'run', 'octave']);
      if (how === 'push' && sec.kind !== 'waltz') {
        // the phrase's first downbeat note an eighth early
        const k = notes.findIndex((n) => !n.pk && onBeat(n.b));
        if (k > 0) { notes[k].b -= 0.5; notes[k].d += 0.5; notes[k - 1].d = Math.min(notes[k - 1].d, notes[k].b - notes[k - 1].b); }
      } else if (how === 'approach') {
        // a chromatic note from below into each long note
        for (let k = notes.length - 1; k > 0; k--) {
          const n = notes[k];
          if (n.d >= 1.5 && notes[k - 1].d >= 1) {
            notes[k - 1].d -= 0.5;
            notes.splice(k, 0, { ...n, b: n.b - 0.5, d: 0.5, p: n.p - 1 });
          }
        }
      } else if (how === 'neighbour') {
        // the second of repeated notes up a step
        for (let k = 1; k < notes.length - 1; k++) {
          if (notes[k].p === notes[k - 1].p && notes[k].d <= 0.5) notes[k].p = scaleStep(notes[k].p, chordAt(sec, at + notes[k].b).scale, pickOne(r, [1, -1]));
        }
      } else if (how === 'run') {
        // its last held note turned into a run down to a chord tone
        const last = notes[notes.length - 1];
        if (last.d >= 1.5) {
          const c = chordAt(sec, at + last.b);
          let p = last.p;
          const steps = Math.floor(last.d * 2) - 1;
          last.d = 0.5;
          for (let k = 1; k <= steps; k++) {
            p = k === steps ? nearestIn(p, c.tones, -1) : scaleStep(p, c.scale, -1);
            notes.push({ ...last, b: last.b + k * 0.5, d: k === steps ? 1 : 0.5, p, pk: false });
          }
        }
      } else if (how === 'octave') {
        const last = notes[notes.length - 1];
        if (last.p + 12 <= band[1]) last.p += 12;
        else if (last.p - 12 >= band[0]) last.p -= 12;
      }
    }
    out.push(...notes);
  }
  // Shaped: louder to each phrase's top note, the downbeats leaning
  for (const n of out) {
    const top = Math.max(...out.filter((m) => m.ph === n.ph).map((m) => m.p));
    const v = v0 + 0.08 * (n.p === top ? 1 : 0) + (strong(sec, at + n.b) ? 0.04 : 0) + (n.pk ? -0.06 : 0) + (r() - 0.5) * 0.04;
    w.put(i, at + n.b, n.d * 0.97, clampTo(n.p, band), v, 'melody');
  }
  return out.map((n) => ({ ...n, b: at + n.b }));
}

/**
 * An improvised phrase from `from` to `to` (beats) in `band`, starting at `start`: a tune motif at its head (sometimes upside down), then
 * chord tones on the strong beats with steps and chromatic approaches between, ending on a chord tone. Returns its notes, written into `w`.
 */
function improvise(r, sec, w, i, { from, to, band, start, density = 0.6, v = 0.7, role = 'solo', motif = r() < 0.6 }) {
  const notes = [];
  let b = from, p = clampTo(start ?? Math.round((band[0] + band[1]) / 2), band);
  let dir = p > (band[0] + band[1]) / 2 ? -1 : 1;
  const add = (beat, d, pitch, vel) => {
    const q = Math.max(band[0], Math.min(band[1], pitch));
    notes.push({ b: beat, d, p: q });
    w.put(i, beat, d * 0.92, q, vel, role);
    p = q;
  };
  if (motif) {
    const m = pickOne(r, MOTIFS), squeeze = sec.kind === 'swing' && r() < 0.5 ? 0.5 : 1;
    let flip = r() < 0.3 ? -1 : 1;
    const c = chordAt(sec, b);
    let base = nearestIn(p, c.tones);
    // where it starts is kept (a phrase starts where the other's ended): the motif turned over sooner than moved an octave
    const fits = (k) => base + Math.max(...m.map(([s]) => s * k)) * 2 <= band[1] && base + Math.min(...m.map(([s]) => s * k)) * 2 >= band[0];
    if (!fits(flip) && fits(-flip)) flip = -flip;
    else if (!fits(flip)) base += base > (band[0] + band[1]) / 2 ? -12 : 12;
    for (const [s, d] of m) {
      if (b + d * squeeze > to) break;
      add(b, d * squeeze, scaleStep(base, chordAt(sec, b).scale, s * flip), v + (r() - 0.5) * 0.06);
      b += d * squeeze;
    }
  }
  while (b < to - 0.01) {
    const left = to - b;
    // a rest now and then, never at the start or the end
    if (notes.length && left > 1.5 && r() < (1 - density) * 0.25) {
      b += 0.5;
      continue;
    }
    let d = r() < density ? 0.5 : r() < 0.7 ? 1 : 1.5;
    if (sec.kind === 'ballad' && d === 0.5 && r() < 0.5) d = 1;
    if (left - d < 0.5) d = left;
    const c = chordAt(sec, b);
    let q;
    const last = left - d < 0.01;
    if (last) q = nearestIn(p, c.tones);
    else if (strong(sec, b) || (onBeat(b) && r() < 0.5)) q = nearestIn(p, c.tones, dir);
    else {
      // a step, or a semitone into the next strong beat's chord tone
      const next = chordAt(sec, b + d);
      q = strong(sec, b + d) && r() < 0.35 ? nearestIn(p + dir * 2, next.tones, 0) - dir : scaleStep(p, c.scale, dir * (r() < 0.8 ? 1 : 2));
    }
    if (q > band[1] - 1 || q < band[0] + 1) dir = -dir;
    else if (r() < 0.18) dir = -dir;
    add(b, d, q, v + (strong(sec, b) ? 0.05 : 0) + (r() - 0.5) * 0.08);
    b += d;
  }
  return notes;
}

/** The piano's left hand and comping for a section's stretch of beats [from, to), under `top` (its highest note) */
function comp(r, sec, w, from, to, { style, top, v = 0.34, sparse = () => false }) {
  let voiced = null, bass = 41;
  const bassBand = [Math.min(34, top - 12), Math.min(48, top - 4)];
  const chordBand = [Math.max(bassBand[0] + 10, top - 11), top];
  const rootNear = (c, near) => nearestIn(near, [c.root], 0, bassBand);
  const chordHit = (b, d, c, vel, count = 3, hand = 'r') => {
    voiced = voicing(c, chordBand, count, voiced);
    for (const p of voiced) w.put('piano', b, d, p, vel + (r() - 0.5) * 0.05, 'comp', hand);
  };
  for (let bar = Math.floor(from / sec.meter); bar * sec.meter < to; bar++) {
    const b0 = bar * sec.meter;
    if (b0 < from - 1e-6) continue;
    const c = (k) => chordAt(sec, b0 + k);
    if (style === 'stride') {
      bass = rootNear(c(0), bass);
      w.put('piano', b0, 0.9, bass, v + 0.07, 'bass', 'l');
      const fifth = c(2).root === c(0).root ? nearestIn(bass + 7, [c(2).tones[2]], 0, [bassBand[0], bassBand[1] + 5]) : rootNear(c(2), bass);
      w.put('piano', b0 + 2, 0.9, fifth, v + 0.08, 'bass', 'l');
      // the left hand's both: the bass, then the chord
      for (const k of [1, 3]) if (!sparse(b0 + k)) chordHit(b0 + k, 0.55, c(k), v, 3, 'l');
    } else if (style === 'walk') {
      // a walking bass, a note a beat, into the next bar's root, and the right hand on 2 (and 3 sometimes)
      for (let k = 0; k < sec.meter; k++) {
        const cc = c(k), next = chordAt(sec, b0 + k + 1);
        let p;
        if (k === 0 || cc !== c(k - 1)) p = rootNear(cc, bass);
        else if (next !== cc || k === sec.meter - 1) p = nearestIn(nearestIn(bass, [next.root], 0, bassBand) + (r() < 0.5 ? 1 : -1), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 0, bassBand);
        else p = nearestIn(bass + (r() < 0.5 ? 2 : -2), cc.tones, 0, bassBand);
        bass = p;
        w.put('piano', b0 + k, 0.92, p, v + (k === 0 ? 0.14 : 0.08), 'bass', 'l');
      }
      if (!sparse(b0 + 1)) chordHit(b0 + 1, sec.meter === 3 ? 0.9 : 0.6, c(1), v, 3);
      if (sec.meter === 3 && r() < 0.35 && !sparse(b0 + 2)) chordHit(b0 + 2, 0.5, c(2), v - 0.05, 3);
      if (sec.meter === 4 && !sparse(b0 + 2.5)) chordHit(b0 + 2.5, 0.5, c(3), v - 0.04, 3);
    } else if (style === 'two') {
      // a two-feel bass and Charleston comping, sometimes pushed
      bass = rootNear(c(0), bass);
      w.put('piano', b0, 1.6, bass, v + 0.07, 'bass', 'l');
      w.put('piano', b0 + 2, 1.6, c(2).root === c(0).root ? nearestIn(bass + 7, [c(0).tones[2]], 0, [bassBand[0], bassBand[1] + 5]) : rootNear(c(2), bass), v + 0.06, 'bass', 'l');
      const hits = pickOne(r, [[0, 1.5], [1.5, 3.5], [0, 2.5], [1, 3], [0.5, 2]]);
      for (const h of hits) if (!sparse(b0 + h) && b0 + h < to) chordHit(b0 + h, 0.45, chordAt(sec, b0 + Math.ceil(h)), v, 3);
    } else if (style === 'ballad') {
      // broken chords in the left hand, root, fifth and tenth, and a held chord over them on each change
      for (let k = 0; k < sec.meter; k += 2) {
        const cc = c(k);
        const root = rootNear(cc, bass);
        bass = root;
        const fifth = nearestIn(root + 7, [cc.tones[2]], 0, [root + 5, root + 8]);
        const tenth = nearestIn(root + 15, [cc.tones[1]], 0, [root + 14, Math.min(top, root + 17)]);
        const arp = [root, fifth, tenth, fifth];
        arp.forEach((p, j) => w.put('piano', b0 + k + j * 0.5, 2 - j * 0.5, Math.min(p, top), v + (j === 0 ? 0.04 : -0.08), 'bass', 'l'));
        if (!sparse(b0 + k)) chordHit(b0 + k, 1.9, cc, v - 0.1, 3);
      }
    } else if (style === 'shell') {
      // the left hand alone, low: a root and a shell (3rd and 7th) under the piano's own tune
      bass = rootNear(c(0), Math.min(bass, 40));
      w.put('piano', b0, sec.meter === 3 ? 0.95 : 1.8, bass, v + 0.06, 'bass', 'l');
      const shellBand = [top - 11, top];
      for (const k of sec.meter === 3 ? [1] : [1, 3]) {
        const cc = c(k);
        for (const pc of [cc.tones[1], cc.seventh]) w.put('piano', b0 + k, 0.7, nearestIn(top - 4, [pc], 0, shellBand), v - 0.04, 'comp', 'l');
      }
      if (sec.meter === 4 && c(2).root !== c(0).root) w.put('piano', b0 + 2, 1.8, rootNear(c(2), bass), v + 0.06, 'bass', 'l');
      if (sec.meter === 3) w.put('piano', b0 + 2, 0.9, nearestIn(bass + 7, [c(2).tones[2]], 0, [bassBand[0], bassBand[1] + 5]), v, 'bass', 'l');
    }
  }
}

/** The trumpet's counter-line under the piano's tune: a guide tone (3rd or 7th) for each chord, the nearest to the last, held */
function counterLine(r, sec, w, from, to, band, v = 0.5) {
  let p = Math.round((band[0] + band[1]) / 2);
  for (let b = from; b < to - 0.5;) {
    const c = chordAt(sec, b);
    let d = 0;
    while (b + d < to && chordAt(sec, b + d) === c && d < sec.meter * 2) d += 1;
    if (r() < 0.12 && d >= 2) {
      b += d; // a breath
      continue;
    }
    p = nearestIn(p, [c.tones[1], c.seventh], 0, band);
    // held to half a beat before the next: a breath
    w.put('trumpet', b, d >= 2 ? d - 0.5 : d * 0.94, p, v + (r() - 0.5) * 0.06, 'counter');
    b += d;
  }
}

// --- Sections -----------------------------------------------------------------------------------------------------------
/**
 * Where the one not leading can answer: from half a beat into each phrase's last note to just before the next phrase's first strong note
 * (over the next one's pickup: they're in different registers), three quarters of a beat or more. [{ last, from, to }]
 */
function answerWindows(line, at, length) {
  const windows = [];
  for (let ph = 0; ph < PHRASES.length; ph++) {
    const mine = line.filter((n) => n.ph === ph);
    if (!mine.length) continue;
    const next = line.find((n) => n.ph > ph && !n.pk);
    const last = mine.filter((n) => !n.pk).pop() ?? mine[mine.length - 1];
    // the last before the chorus's end, which may have the next one's pickup in its last beat
    const from = last.b + Math.min(0.5, last.d), to = (next ? next.b : at + length - 1) - 0.25;
    if (to - from >= 0.75) windows.push({ last, from, to });
  }
  return windows;
}

/** A chorus with one lead: the tune (varied) and the other's answers or counter-line, and the piano's comping round it */
function leadChorus(r, sec, w, at, lead, amount) {
  const styles = { head: 'stride', out: 'stride', waltz: 'walk', ballad: 'ballad', swing: 'two' };
  const length = sec.meter === 3 ? 96 : 64;
  const part = { from: at, to: at + length, lead, mode: null, trumpet: lead === 'trumpet' ? TRUMPET_LEAD : TRUMPET_UNDER };
  if (lead === 'trumpet') {
    const line = leadLine(r, sec, w, 'trumpet', at, amount, TRUMPET_LEAD, sec.kind === 'ballad' ? 0.76 : 0.8);
    // the piano comps under it, lighter while it plays, and fills where it breathes (the trumpet's held note cut to a beat to let it)
    const busy = (b) => line.some((n) => b >= n.b - 0.01 && b < n.b + n.d);
    comp(r, sec, w, at, at + length, { style: styles[sec.kind], top: TRUMPET_LEAD[0] - 1, sparse: (b) => busy(b) && r() < 0.25 });
    part.mode = 'fills';
    for (const { last, from, to } of answerWindows(line, at, length)) {
      if (r() < 0.25) continue;
      // over the trumpet's held note, low; or up where it was, the note cut to a beat to let it
      const high = last.d >= 2 && r() < 0.5;
      if (high) {
        const cut = w.notes.find((n) => n.i === 'trumpet' && n.role === 'melody' && Math.abs(n.b - last.b) < 1e-6);
        if (cut) cut.d = Math.min(cut.d, 0.95);
      }
      const start = high ? last.b + 1 : from;
      if (to - start < 0.75) continue;
      improvise(r, sec, w, 'piano', { from: start, to, band: high ? [TRUMPET_LEAD[0], 84] : [47, TRUMPET_LEAD[0] - 1], start: high ? last.p : last.p - 12,
        density: 0.75, v: 0.56, role: 'fill', motif: r() < 0.4 });
    }
  } else {
    const line = leadLine(r, sec, w, 'piano', at, amount, [PIANO_ABOVE, RANGES.piano[1]], sec.kind === 'ballad' ? 0.8 : 0.86);
    // its long notes with a third or sixth under them
    for (const n of line) {
      if (n.d < 1.5) continue;
      const c = chordAt(sec, n.b);
      const under = nearestIn(n.p - 3, c.tones, -1, [PIANO_ABOVE, n.p - 3]);
      if (under >= PIANO_ABOVE && under < n.p) w.put('piano', n.b, n.d * 0.95, under, 0.5, 'melody', 'r');
    }
    comp(r, sec, w, at, at + length, { style: 'shell', top: LOW_HAND_TOP, v: 0.3 });
    part.mode = r() < 0.5 ? 'counter' : 'answers';
    if (part.mode === 'counter') counterLine(r, sec, w, at, at + length, TRUMPET_UNDER);
    else {
      for (const { last, from, to } of answerWindows(line, at, length)) {
        improvise(r, sec, w, 'trumpet', { from, to, band: TRUMPET_UNDER, start: last.p - 12, density: 0.55, v: 0.6, role: 'answer' });
      }
    }
  }
  return part;
}

/**
 * A chorus of trading: two bars each (one in a third chorus), the trumpet and the piano in turn, each phrase starting on the note the
 * other's ended on; the one not soloing comps (the piano) or punctuates low (the trumpet)
 */
function tradeChorus(r, sec, w, at, first, barsEach) {
  const length = sec.meter === 3 ? 96 : 64;
  const parts = [];
  let who = first, last = 74;
  for (let b = at; b < at + length - 0.01; b += barsEach * sec.meter) {
    const to = Math.min(at + length, b + barsEach * sec.meter);
    // the next phrase starts where this one's last note ends: it holds till then
    if (who === 'trumpet') {
      const line = improvise(r, sec, w, 'trumpet', { from: b, to: to - 0.5, band: TRUMPET_LEAD, start: last, density: 0.7, v: 0.74, role: 'trade' });
      comp(r, sec, w, b, to, { style: sec.kind === 'waltz' ? 'walk' : 'two', top: TRUMPET_LEAD[0] - 1, v: 0.32, sparse: () => r() < 0.3 });
      last = line.length ? line[line.length - 1].p : last;
      parts.push({ from: b, to, lead: 'trumpet', mode: 'trade', trumpet: TRUMPET_LEAD });
    } else {
      const line = improvise(r, sec, w, 'piano', { from: b, to: to - 0.5, band: [PIANO_ABOVE, 88], start: Math.max(PIANO_ABOVE, last), density: 0.75, v: 0.66, role: 'trade' });
      comp(r, sec, w, b, to, { style: 'shell', top: LOW_HAND_TOP, v: 0.3 });
      // the trumpet's punctuation: a low guide tone or two
      const hits = barsEach > 1 ? [b + sec.meter + (sec.meter === 3 ? 0 : 0.5)] : [b + 1];
      for (const h of hits) {
        const c = chordAt(sec, h);
        w.put('trumpet', h, sec.meter === 3 ? 1.8 : 1.4, nearestIn(58, [c.tones[1], c.seventh], 0, TRUMPET_UNDER), 0.5, 'punctuation');
      }
      last = line.length ? line[line.length - 1].p : last;
      parts.push({ from: b, to, lead: 'piano', mode: 'trade', trumpet: TRUMPET_UNDER });
    }
    who = who === 'trumpet' ? 'piano' : 'trumpet';
  }
  return parts;
}

/** The intro: the piano's turnaround with the tune's last line high, the trumpet under it, then the trumpet's "Waltzing Matilda" over it */
function intro(r, sec, w) {
  const bars = sec.bars, m = sec.meter;
  const half = Math.floor(bars / 2) * m;
  // the piano: the last line's tune, high, over its left hand; the trumpet holding guide tones low
  const last = TUNE.filter((n) => n.ph === 7).map((n) => ({ ...n, b: n.b - 56 }));
  const k = sec.meter === 3 ? 1.5 : 1;
  for (const n of last) if (n.b * k < half) w.put('piano', n.b * k, n.d * k * 0.95, n.p + 12 <= 88 ? n.p + 12 : n.p, 0.62, 'melody', 'r');
  comp(r, sec, w, 0, half, { style: 'shell', top: LOW_HAND_TOP, v: 0.3 });
  counterLine(r, sec, w, 0, half, TRUMPET_UNDER, 0.46);
  // then the trumpet's motif, the piano comping under it, both ending on the dominant for the head
  improvise(r, sec, w, 'trumpet', { from: half, to: sec.beats - 1.5, band: TRUMPET_LEAD, start: 77, density: 0.5, v: 0.66, role: 'intro', motif: true });
  comp(r, sec, w, half, sec.beats, { style: m === 3 ? 'walk' : 'two', top: TRUMPET_LEAD[0] - 1, v: 0.32 });
  return [{ from: 0, to: half, lead: 'piano', mode: 'intro', trumpet: TRUMPET_UNDER }, { from: half, to: sec.beats, lead: 'trumpet', mode: 'intro', trumpet: TRUMPET_LEAD }];
}

/**
 * The coda: the last line twice, the second time slowing, with the other's answer between, and the last chord held, the trumpet on its
 * third or fifth over the piano's rolled chord
 */
function coda(r, sec, w, lead) {
  const tag = TUNE.filter((n) => n.ph === 7).map((n) => ({ ...n, b: n.b - 56 }));
  const other = lead === 'trumpet' ? 'piano' : 'trumpet';
  const leadBand = lead === 'trumpet' ? TRUMPET_LEAD : [PIANO_ABOVE, 88];
  // 1-2: the lead's tag, its end left open (C, not B♭)
  for (const n of tag) w.put(lead, n.b, n.b >= 6 ? 2 : n.d * 0.96, clampTo(n.b >= 6 ? 72 : n.p, leadBand), 0.74, 'melody');
  // 3-4: the other answers with "Waltzing Matilda" over the turnaround
  improvise(r, sec, w, other, { from: 8, to: 15.5, band: other === 'trumpet' ? TRUMPET_UNDER : [PIANO_ABOVE, 88], start: other === 'trumpet' ? 62 : 74,
    density: 0.5, v: 0.62, role: 'answer', motif: true });
  // 5-6: the tag again, slowing, and home: the trumpet up to the third (D) on its last note, the piano on B♭
  const final = lead === 'trumpet' ? 74 : 70;
  for (const n of tag) w.put(lead, 16 + n.b, n.b >= 6 ? 8 : n.d * 0.96, n.b >= 6 ? final : clampTo(n.p, leadBand), n.b >= 6 ? 0.8 : 0.76, 'melody');
  if (lead === 'piano') {
    // the trumpet under the piano's tune, then on the last chord's third
    counterLine(r, sec, w, 0, 22, TRUMPET_UNDER, 0.48);
    w.put('trumpet', 24, 6, 62, 0.62, 'melody');
  }
  comp(r, sec, w, 0, 24, { style: lead === 'trumpet' ? 'stride' : 'shell', top: lead === 'trumpet' ? TRUMPET_LEAD[0] - 1 : LOW_HAND_TOP, v: 0.32 });
  // the last chord, rolled up from the bottom, clear of the trumpet's held note
  const roll = [34, 41, 50, ...voicing(chordOf('Bb6'), lead === 'trumpet' ? [53, 71] : [65, 81], 3)];
  roll.forEach((p, j) => w.put('piano', 24 + j * 0.12, 8 - j * 0.12, p, 0.62 - j * 0.02, 'comp', j < 3 ? 'l' : 'r'));
  return [
    { from: 0, to: 22, lead, mode: 'coda', trumpet: lead === 'trumpet' ? TRUMPET_LEAD : TRUMPET_UNDER },
    { from: 22, to: sec.beats, lead: 'both', mode: 'end', trumpet: lead === 'trumpet' ? [72, 76] : [60, 64] }
  ];
}

// --- Time ---------------------------------------------------------------------------------------------------------------
/** Each beat's start in s, from the section's start, its tempo (and a coda's ritardando over its last 4 bars) */
function timeSection(sec, start) {
  const times = new Float64Array(sec.beats + 9);
  times[0] = start;
  for (let b = 0; b < times.length - 1; b++) {
    let bpm = sec.bpm;
    if (sec.kind === 'coda' && b >= 16) bpm *= Math.max(0.55, 1 - (b - 16) * 0.055);
    times[b + 1] = times[b] + 60 / bpm;
  }
  sec.times = times;
  sec.start = start;
  sec.end = times[sec.beats];
}
/** A beat place's time, its off-beat eighths swung (a pickup before the section's start at its tempo) */
function timeOf(sec, b) {
  const beat = 60 / sec.bpm;
  const k = Math.min(sec.times.length - 2, Math.floor(b));
  const f = b - k, s = sec.swing;
  const g = f <= 0.5 ? f / 0.5 * s : s + (f - 0.5) / 0.5 * (1 - s);
  if (k < 0) return sec.times[0] + (k + g) * beat;
  return sec.times[k] + (sec.times[k + 1] - sec.times[k]) * g;
}

// --- After: both always playing, and out of each other's register -----------------------------------------------------
/** Anywhere either instrument would be silent for over 1.75 bars, a quiet note of it: a guide tone (the trumpet), a chord (the piano) */
function fillSilences(sec, w, parts) {
  const most = sec.meter * 1.75;
  for (const i of ['piano', 'trumpet']) {
    const mine = w.notes.filter((n) => n.i === i).sort((a, b) => a.b - b.b);
    let from = 0;
    const gaps = [];
    for (const n of mine) {
      if (n.b - from > most) gaps.push([from, n.b]);
      from = Math.max(from, n.b + n.d);
    }
    if (sec.beats - from > most && sec.kind !== 'coda') gaps.push([from, sec.beats]);
    for (const [a, b] of gaps) {
      for (let at = Math.ceil(a + 0.5); at < b - 0.5; at += sec.meter) {
        const part = parts.find((p) => at >= p.from && at < p.to) ?? parts[parts.length - 1];
        const c = chordAt(sec, at);
        const d = Math.min(sec.meter, b - at - 0.25);
        if (i === 'trumpet') w.put('trumpet', at, d - 0.5, nearestIn(Math.round((part.trumpet[0] + part.trumpet[1]) / 2), [c.tones[1], c.seventh], 0, part.trumpet), 0.45, 'counter');
        else {
          const top = part.trumpet[0] - 1;
          for (const p of voicing(c, [Math.max(36, top - 11), top], 3)) w.put('piano', at, d, p, 0.3, 'comp', 'r');
        }
      }
    }
  }
}

/**
 * While the trumpet sounds, no piano note in its band: where one does (a lead's last note running into the other's first), the one that
 * started first gives way, or a comping note goes down an octave
 */
function keepRegisters(notes, partAt) {
  const trumpet = notes.filter((n) => n.i === 'trumpet');
  for (const t of trumpet) {
    const band = partAt(t.t).trumpet;
    for (const p of notes) {
      if (p.i !== 'piano' || p.t >= t.t + t.d - 1e-4 || t.t >= p.t + p.d - 1e-4) continue;
      if (p.p < band[0] || p.p > band[1]) continue;
      if (p.role === 'comp' || p.role === 'bass') {
        while (p.p >= band[0]) p.p -= 12;
      } else if (p.t < t.t) p.d = Math.max(0, t.t - p.t - 0.01);
      else t.d = Math.max(0, p.t - t.t - 0.01);
    }
  }
  return notes.filter((n) => n.d > 0.04);
}

/**
 * A new performance from a seed (a 32-bit integer): its score, as at the top of this file. The same seed, the same score.
 */
function arrange(seed = 1) {
  const r = random(seed);
  const p = fit(r, plan(r));
  const sections = [];
  const leadFirst = r() < 0.5 ? 'trumpet' : 'piano';
  let lead = leadFirst;
  const flip = () => (lead = lead === 'trumpet' ? 'piano' : 'trumpet');
  // the intro, in the first section's metre
  const introLines = p.first === 'waltz' ? WALTZ_INTRO_CHORDS : INTRO_CHORDS;
  const order = [{ kind: 'intro', choruses: 1 }, { kind: p.first, choruses: 1 }, ...p.middle, { kind: 'out', choruses: 1 }, { kind: 'coda', choruses: 1 }];
  for (const { kind, choruses } of order) {
    const lines = kind === 'intro' ? introLines : kind === 'coda' ? CODA_CHORDS : kind === 'ballad' ? BALLAD_CHORDS : kind === 'swing' ? SWING_CHORDS : HEAD_CHORDS;
    // a waltz has a bar of 3/4 for each half bar of 4/4
    const chorusLines = kind === 'waltz' ? lines.flatMap((l) => {
      const names = l.split(' ');
      const half = Math.ceil(names.length / 2);
      return [names.slice(0, half).join(' ') || names[0], names.slice(half).join(' ') || names[0]].map((x) => x.split(' ')[0]);
    }) : lines;
    const all = kind === 'intro' || kind === 'coda' ? chorusLines : Array.from({ length: choruses }, () => chorusLines).flat();
    const sec = makeSection(kind === 'intro' && p.first === 'waltz' ? 'waltz' : kind, p.bpm[kind], all, { name: kind });
    sec.kind = kind === 'intro' ? (p.first === 'waltz' ? 'waltz' : 'intro') : kind;
    sec.label = kind;
    const w = writer(sec);
    let parts = [];
    if (kind === 'intro') {
      parts = intro(r, sec, w);
      sec.lead = 'both';
    } else if (kind === 'coda') {
      parts = coda(r, sec, w, lead);
      sec.lead = lead;
    } else {
      const length = sec.meter === 3 ? 96 : 64;
      const amounts = { head: 0.25, waltz: 0.45, ballad: 0.4, swing: 0.7, out: 0.3 };
      for (let c = 0; c < choruses; c++) {
        if (kind === 'swing' && c > 0) {
          parts.push(...tradeChorus(r, sec, w, c * length, lead, c === 1 ? 2 : 1));
          flip();
        } else if (kind === 'ballad') {
          // the ballad's lead changes at its refrain
          const verse = leadChorus(r, sec, w, c * length, lead, amounts.ballad);
          const keep = w.notes.filter((n) => n.b < c * length + 32 || n.b >= c * length + length);
          w.notes.splice(0, w.notes.length, ...keep);
          verse.to = c * length + 32;
          flip();
          const sub = writer(sec);
          const refrain = leadChorus(r, sec, sub, c * length, lead, amounts.ballad);
          w.notes.push(...sub.notes.filter((n) => n.b >= c * length + 32));
          refrain.from = c * length + 32;
          parts.push(verse, refrain);
          flip();
        } else {
          parts.push(leadChorus(r, sec, w, c * length, lead, amounts[kind]));
          flip();
        }
      }
      sec.lead = kind === 'swing' && choruses > 1 ? 'trade' : parts[0].lead;
    }
    fillSilences(sec, w, parts);
    sec.parts = parts;
    sec.notes = w.notes;
    sections.push(sec);
  }
  // Times: each section after the one before
  let t = 0;
  for (const sec of sections) {
    timeSection(sec, t);
    t = sec.end;
  }
  // A chorus's part starts with its lead's pickup (the beat before it), and each part ends where the next starts
  const partList = sections.flatMap((sec, s) => sec.parts.map((part) => {
    const pickup = (part.mode === 'fills' || part.mode === 'counter' || part.mode === 'answers') && (part.from % (sec.meter === 3 ? 96 : 64)) === 0 && !(s === 0);
    return { s, start: timeOf(sec, part.from - (pickup ? 1 : 0)), end: timeOf(sec, part.to), lead: part.lead, mode: part.mode, trumpet: part.trumpet };
  }));
  partList.sort((a, b) => a.start - b.start);
  for (let k = 0; k + 1 < partList.length; k++) partList[k].end = partList[k + 1].start;
  const partAt = (time) => partList.find((x) => time >= x.start - 1e-6 && time < x.end) ?? partList[partList.length - 1];
  let notes = [];
  sections.forEach((sec, s) => {
    for (const n of sec.notes) {
      const t0 = timeOf(sec, n.b), t1 = timeOf(sec, n.b + n.d);
      notes.push({ t: t0, d: t1 - t0, p: n.p, v: +n.v.toFixed(3), i: n.i, role: n.role, ...(n.hand ? { hand: n.hand } : {}), s });
    }
  });
  // Every note in its instrument's range, the piano's no longer than its buffers ring
  for (const n of notes) {
    const [lo, hi] = RANGES[n.i];
    while (n.p < lo) n.p += 12;
    while (n.p > hi) n.p -= 12;
    if (n.i === 'piano') n.d = Math.min(n.d, n.p <= 55 ? 3.0 : n.p <= 75 ? 2.3 : 1.6);
  }
  // The trumpet in its part's band (a guide tone written near a part's edge), then the piano out of it
  for (const n of notes) if (n.i === 'trumpet') n.p = clampTo(n.p, partAt(n.t).trumpet);
  notes = keepRegisters(notes, partAt);
  // Each hand within its reach: the right hand's comping gives way to a line it plays at the same time, more than an octave away, and
  // of two lines (a fill running into the next chorus's tune) the first ends where the second starts
  const lines = notes.filter((n) => n.i === 'piano' && n.hand === 'r' && n.role !== 'comp').sort((a, b) => a.t - b.t);
  for (let k = 0; k < lines.length; k++) {
    for (let j = k + 1; j < lines.length && lines[j].t < lines[k].t + lines[k].d; j++) {
      if (lines[j].role !== lines[k].role && Math.abs(lines[j].p - lines[k].p) > 12) lines[k].d = Math.min(lines[k].d, lines[j].t - lines[k].t - 0.01);
    }
  }
  for (const c of notes) {
    if (c.i !== 'piano' || c.hand !== 'r' || c.role !== 'comp') continue;
    if (lines.some((l) => l.t < c.t + c.d - 1e-3 && c.t < l.t + l.d - 1e-3 && Math.abs(l.p - c.p) > 12)) c.d = 0;
  }
  // One note at a time on the trumpet: each ends before the next starts
  const horn = notes.filter((n) => n.i === 'trumpet').sort((a, b) => a.t - b.t);
  for (let k = 0; k + 1 < horn.length; k++) {
    if (horn[k].d <= 0) continue;
    // two at once: the tune's (or the louder) kept
    let j = k + 1;
    while (j < horn.length && horn[j].d <= 0) j++;
    if (j >= horn.length) break;
    if (horn[j].t - horn[k].t < 0.06) {
      const keepFirst = horn[k].role === 'melody' || (horn[j].role !== 'melody' && horn[k].v >= horn[j].v);
      if (keepFirst) { horn[j].d = 0; k--; continue; }
      horn[k].d = 0;
    } else if (horn[k].t + horn[k].d > horn[j].t - 0.02) horn[k].d = horn[j].t - 0.02 - horn[k].t;
  }
  // A breath at least every 10 s: the note before it ends half a beat sooner
  const blown = notes.filter((n) => n.i === 'trumpet' && n.d > 0.04).sort((a, b) => a.t - b.t);
  let since = blown[0]?.t ?? 0;
  for (let k = 0; k + 1 < blown.length; k++) {
    const a = blown[k], b = blown[k + 1], beat = 60 / sections[b.s].bpm;
    const gap = b.t - (a.t + a.d);
    if (gap >= BREATH * beat) since = b.t;
    else if (b.t - since > 10 && a.d > 0.6 * beat) {
      a.d -= BREATH * beat - gap;
      since = b.t;
    }
  }
  notes = notes.filter((n) => n.d > 0.04).sort((a, b) => a.t - b.t || a.p - b.p);
  for (const n of notes) {
    n.t = +n.t.toFixed(4);
    n.d = +n.d.toFixed(4);
  }
  const duration = Math.max(...notes.map((n) => n.t + n.d));
  const beats = [];
  sections.forEach((sec, s) => {
    for (let b = 0; b < sec.beats; b++) beats.push({ t: +sec.times[b].toFixed(4), bar: Math.floor(b / sec.meter), beat: b % sec.meter, s });
  });
  return {
    seed, title: TITLE, key: 'B♭', duration: +duration.toFixed(3),
    sections: sections.map((sec, s) => ({ kind: sec.label, start: +sec.start.toFixed(4), end: +sec.end.toFixed(4), meter: sec.meter, bpm: sec.bpm,
      bars: sec.bars, swing: sec.swing, lead: sec.lead,
      parts: partList.filter((x) => x.s === s).sort((a, b) => a.start - b.start).map(({ start, end, lead, mode, trumpet }) => ({ start: +start.toFixed(4), end: +end.toFixed(4), lead, mode, trumpet })) })),
    notes,
    phrases: phrasesOf(notes, sections),
    beats
  };
}

/** Each instrument's runs of notes with no rest of BREATH beats or more between: when the trumpet breathes, or the piano's hands rest */
function phrasesOf(notes, sections) {
  const phrases = [];
  for (const i of ['trumpet', 'piano']) {
    const mine = notes.filter((n) => n.i === i && n.role !== 'bass' && n.role !== 'comp');
    let cur = null;
    for (const n of mine) {
      const beat = 60 / sections[n.s].bpm;
      if (cur && n.t - cur.end < beat * BREATH - 1e-3) {
        cur.end = Math.max(cur.end, n.t + n.d);
        continue;
      }
      if (cur) phrases.push(cur);
      cur = { i, start: n.t, end: n.t + n.d, role: n.role };
    }
    if (cur) phrases.push(cur);
  }
  return phrases.sort((a, b) => a.start - b.start).map((x) => ({ ...x, start: +x.start.toFixed(4), end: +x.end.toFixed(4) }));
}

// --- Asking a score what's sounding -------------------------------------------------------------------------------------
/** The notes of instrument `i` sounding at score time `t` (s) */
function soundingAt(score, i, t) {
  const out = [];
  for (const n of score.notes) {
    if (n.t > t) break;
    if (n.i === i && t < n.t + n.d) out.push(n);
  }
  return out;
}
/** The next note(s) of `i` to start after `t`: all those starting together, or [] at the end */
function nextAfter(score, i, t) {
  let first = null;
  const out = [];
  for (const n of score.notes) {
    if (n.i !== i || n.t <= t) continue;
    if (first === null) first = n.t;
    if (n.t > first + 1e-3) break;
    out.push(n);
  }
  return out;
}
/** The section, its part (who leads), the beat and the phrase of `i` at `t` */
function placeAt(score, t, i = 'trumpet') {
  const section = score.sections.findLast?.((x) => x.start <= t) ?? [...score.sections].reverse().find((x) => x.start <= t) ?? score.sections[0];
  const part = section.parts.find((x) => t >= x.start && t < x.end) ?? section.parts[section.parts.length - 1];
  let beat = null;
  for (const b of score.beats) {
    if (b.t > t) break;
    beat = b;
  }
  const phrase = score.phrases.find((x) => x.i === i && t >= x.start && t < x.end) ?? null;
  return { section, part, beat, phrase };
}

export { RANGES, TITLE, TUNE, arrange, chordOf, nextAfter, placeAt, soundingAt };
