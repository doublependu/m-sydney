import { GEO } from './geodata.js';
import { terrainHeight } from './terrain.js';

// The Harbour Bridge's corridor: a road with its own height. The simulation is flat, so a car on the deck and a car on
// the street under its approach share (x, z); what tells them apart is whether they came on at the ends.

const PATH = [];
for (let i = 0; i < GEO.bridge.length; i += 2) PATH.push({ x: GEO.bridge[i], z: GEO.bridge[i + 1], s: 0 });
for (let i = 1; i < PATH.length; i++) PATH[i].s = PATH[i - 1].s + Math.hypot(PATH[i].x - PATH[i - 1].x, PATH[i].z - PATH[i - 1].z);
const LENGTH = PATH[PATH.length - 1].s;
const HALF_WIDTH = 12.5; // of the corridor anything can use
const ENTRY = 45; // m from each end where the deck meets the ground
const DECK = 49; // m above the game's zero over the water
const CROWN = 3; // m higher at mid-span

const startY = terrainHeight(PATH[0].x, PATH[0].z);
const endY = terrainHeight(PATH[PATH.length - 1].x, PATH[PATH.length - 1].z);
const smooth = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };

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
const SPAN = (() => {
  // The arch stands on the deepest part of the corridor's dip in the ground
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

/** Deck height s metres along the corridor: ground at both ends, a long gentle climb to the arch, a slight crown over it */
function deckHeight(s) {
  const a = SPAN.south, b = SPAN.north;
  if (s < a) return startY + (DECK - startY) * smooth(s / a);
  if (s > b) return endY + (DECK - endY) * smooth((LENGTH - s) / (LENGTH - b));
  return DECK + CROWN * Math.sin(((s - a) / (b - a)) * Math.PI);
}

/** Nearest place on the corridor to (x, z), or null when outside it: { s, off (metres to the right of travel north), y } */
function bridgeAt(x, z) {
  let best = null, bd = HALF_WIDTH * HALF_WIDTH;
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

// Whoever is on the deck stays on it until they leave at an end; anyone else passes beneath
function updateDeckState(entity, x, z) {
  const here = bridgeAt(x, z);
  if (entity.deck) entity.deck = !!here && here.s > 1 && here.s < LENGTH - 1;
  else if (here && (here.s < ENTRY || here.s > LENGTH - ENTRY)) entity.deck = true;
  return entity.deck ? here : null;
}

export { HALF_WIDTH, LENGTH as BRIDGE_LENGTH, SPAN as BRIDGE_SPAN, bridgeAt, bridgePoint, deckHeight, updateDeckState };
