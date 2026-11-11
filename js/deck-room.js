import { DECK_DEPTH, KIND, STRUCTURES, groundHeight, inTunnel, roomUnderDeck, structuresAt } from './surfaces.js';
import { DECK_REACH, bridgeAt, deckUndersideAt } from './bridge.js';

// What stands on the ground under a deck or beside one: trees, street lights, signs, buildings. The Harbour Bridge's deck is wider than
// its roads (its railway and cycleway on the west, its footway on the east: js/bridge.js deckEdges()), and all of it counts.

/** Room between the ground at (x, z) and the underside of the lowest deck over it, reaching `r` past the deck's edge: Infinity under
 *  open sky */
function roomOver(x, z, r = 0) {
  const bridge = deckUndersideAt(x, z, r);
  return Math.min(roomUnderDeck(x, z, r), bridge === null ? Infinity : bridge - groundHeight(x, z));
}

// Where a crown is looked at, as fractions of its radius: its middle, and two rings round it, close enough that a deck can't reach in
// between two of the outer ring's by more than 10 cm
const CROWN = [[0, 0]];
for (let k = 0; k < 16; k++) CROWN.push([Math.sin((k * Math.PI) / 8), Math.cos((k * Math.PI) / 8)]);
for (let k = 0; k < 8; k++) CROWN.push([0.5 * Math.sin(((k + 0.5) * Math.PI) / 4), 0.5 * Math.cos(((k + 0.5) * Math.PI) / 4)]);

/** A crown's reach from its trunk, m, for a tree `tall` m high */
const crownRadius = (tall) => Math.min(5, 0.33 * tall);

/** Whether a tree `tall` m high at (x, z) keeps its crown off the decks beside it: a crown that reaches over a deck standing off the
 *  ground there, and up past the deck's road, pokes through it. A deck over the whole tree is roomOver()'s. */
function crownClear(x, z, tall) {
  const base = groundHeight(x, z), r = crownRadius(tall), top = base + tall;
  const nearBridge = !!bridgeAt(x, z, DECK_REACH + r + 1);
  for (const [fx, fz] of CROWN) {
    const px = x + fx * r, pz = z + fz * r;
    for (const s of structuresAt(px, pz)) {
      if (STRUCTURES[s.sid]?.kind === KIND.BRIDGE && s.y > base + 0.5 && top > s.y && top - tall * 0.65 < s.y + 4.3) return false;
    }
    if (!nearBridge) continue;
    const under = deckUndersideAt(px, pz);
    if (under !== null && under + DECK_DEPTH > base + 0.5 && top > under + DECK_DEPTH) return false;
  }
  return true;
}

/** Whether no road off the ground runs where a trunk at (x, z) would stand: a tunnel's approach open to the sky, or a ramp low over the
 *  ground. A tunnel under the ground is out of the way, and a deck high over it is roomOver()'s */
function trunkClear(x, z) {
  const base = groundHeight(x, z);
  for (const s of structuresAt(x, z, -0.6)) {
    const kind = STRUCTURES[s.sid]?.kind;
    if (kind === KIND.TUNNEL && !inTunnel(s.sid, x, z)) return false;
    if (kind === KIND.BRIDGE && s.y < base + 0.5 + DECK_DEPTH) return false;
  }
  return true;
}

/** Whether a tree `tall` m high can stand at (x, z) for what's beside it: nothing's road through its trunk, its crown off the decks */
const treeClear = (x, z, tall) => trunkClear(x, z) && crownClear(x, z, tall);

export { crownClear, crownRadius, roomOver, treeClear, trunkClear };
