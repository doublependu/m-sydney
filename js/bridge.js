import { GEO } from './geodata.js';
import { rawTerrainHeight as terrainHeight } from './terrain.js';
import { DECK_STRUCTURE, structureAt } from './surfaces.js';

// The Harbour Bridge's corridor: a road with its own height, one of the structures of js/surfaces.js. A car on the deck
// and a car on the street under its approach share (x, z); what tells them apart is the surface each is on. Its height
// comes from the road graph (tools/build-heights.mjs works out the deck's profile), so the model, the game and the
// roads that join it all agree. This module adds what the model and the scripts need: the line along it, and where
// along it a point is.

const PATH = [];
for (let i = 0; i < GEO.bridge.length; i += 2) PATH.push({ x: GEO.bridge[i], z: GEO.bridge[i + 1], s: 0 });
for (let i = 1; i < PATH.length; i++) PATH[i].s = PATH[i - 1].s + Math.hypot(PATH[i].x - PATH[i - 1].x, PATH[i].z - PATH[i - 1].z);
const LENGTH = PATH[PATH.length - 1].s;
const HALF_WIDTH = 12.5; // of the corridor anything can use, where the tiles don't say how far the deck reaches (deckSpanAt())
const DECK_SID = DECK_STRUCTURE;
// m from the corridor's line that any of the deck can be, either side
const DECK_REACH = 30;

/** Point on the corridor s metres from its south end, with its direction */
function bridgePoint(s) {
  let i = 1;
  while (i < PATH.length - 1 && PATH[i].s < s) i++;
  const a = PATH[i - 1], b = PATH[i];
  const L = b.s - a.s || 1;
  const t = (s - a.s) / L;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, ux: (b.x - a.x) / L, uz: (b.z - a.z) / L };
}

// Where the shore lies under the corridor, for the arch: the water runs between these
// Worked out with the whole map when the tiles are made (tools/tiles/derive.mjs), since the game may never hold all of the
// bridge at once
const SPAN = GEO.bridgeSpan || (() => {
  let south = 0, north = LENGTH;
  for (let s = 0; s < LENGTH; s += 5) {
    const p = bridgePoint(s);
    if (terrainHeight(p.x, p.z) < 2) { south = s; break; }
  }
  for (let s = LENGTH; s > 0; s -= 5) {
    const p = bridgePoint(s);
    if (terrainHeight(p.x, p.z) < 2) { north = s; break; }
  }
  return { south, north, middle: (south + north) / 2 };
})();

// The deck's height every 2 m along it, from the road graph
const DECK_STEP = 2;
const DECK_Y = new Float32Array(Math.ceil(LENGTH / DECK_STEP) + 1);
for (let i = 0; i < DECK_Y.length; i++) {
  const p = bridgePoint(Math.min(LENGTH, i * DECK_STEP));
  DECK_Y[i] = GEO.deckProfile?.[i] ?? structureAt(DECK_SID, p.x, p.z, 2)?.y ?? terrainHeight(p.x, p.z);
}

/** Deck height s metres along the corridor: ground at both ends, a long gentle climb to the arch, a slight crown over it */
function deckHeight(s) {
  const f = Math.max(0, Math.min(LENGTH, s)) / DECK_STEP;
  const i = Math.min(DECK_Y.length - 2, Math.floor(f));
  return DECK_Y[i] + (DECK_Y[i + 1] - DECK_Y[i]) * (f - i);
}

// How far the deck reaches across, west (negative) and east of the corridor's line, every so many metres along it: as far as any of
// its roads' lanes do (tools/build-tiles.mjs). The corridor is OSM's northbound carriageway; its southbound one, the bus lane and
// the Cahill's lane through the east pylons are east of it, on the same deck (plan 5).
const ACROSS = GEO.deckSpan;
/** The deck's roads across at s m along the corridor: { west, east }, m from its line, east positive */
function deckSpanAt(s) {
  if (!ACROSS) return { west: -HALF_WIDTH, east: HALF_WIDTH };
  const f = Math.max(0, Math.min(ACROSS.west.length - 1, s / ACROSS.step));
  const i = Math.min(ACROSS.west.length - 2, Math.floor(f)), t = f - i;
  return { west: ACROSS.west[i] + (ACROSS.west[i + 1] - ACROSS.west[i]) * t, east: ACROSS.east[i] + (ACROSS.east[i + 1] - ACROSS.east[i]) * t };
}

/**
 * Nearest place on the corridor to (x, z), or null when farther than `reach` from it:
 * { s, off (metres to the right of travel north), y }
 */
function bridgeAt(x, z, reach = HALF_WIDTH) {
  let best = null, bd = reach * reach;
  for (let i = 1; i < PATH.length; i++) {
    const a = PATH[i - 1], b = PATH[i];
    const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1;
    const u = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2));
    const px = a.x + dx * u, pz = a.z + dz * u;
    const d = (x - px) ** 2 + (z - pz) ** 2;
    if (d < bd) {
      bd = d;
      const L = Math.sqrt(L2);
      best = { s: a.s + u * L, off: (-(x - px) * dz + (z - pz) * dx) / L, px, pz };
    }
  }
  if (best) best.y = deckHeight(best.s);
  return best;
}

/** Where the deck's easternmost lane runs apart from the rest at s, [from, to] m east of the corridor's line: the Cahill's, through
 *  the east pylons. Null where it doesn't. */
function deckGapAt(s) {
  if (!ACROSS?.gap) return null;
  const k = Math.max(0, Math.min(ACROSS.gap.length - 1, Math.round(s / ACROSS.step)));
  const here = ACROSS.gap[k];
  if (!here) return null;
  // Between two bins that both have one, the nearer's
  return here;
}

/** Whether (x, z) is over the deck's roads, `margin` m past their edges counting */
function onDeckSpan(x, z, margin = 0) {
  const here = bridgeAt(x, z, DECK_REACH + margin);
  if (!here) return false;
  const span = deckSpanAt(here.s);
  return here.off >= span.west - margin && here.off <= span.east + margin;
}

export { DECK_REACH, DECK_STEP, DECK_SID, HALF_WIDTH, LENGTH as BRIDGE_LENGTH, SPAN as BRIDGE_SPAN, bridgeAt, bridgePoint, deckGapAt, deckHeight, deckSpanAt, onDeckSpan };
