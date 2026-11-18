import assert from 'node:assert/strict';
import test from 'node:test';
import { separateDecks } from '../tools/tiles/separate-decks.mjs';

// Bridges side by side at different heights, moved apart in tools/build-tiles.mjs (tools/tiles/separate-decks.mjs), on made-up roads in
// the generated map's records: [a, b, name, width, lanes, dir, inner, major, deck, kind, layer, flags, ys]
const BRIDGE = 1, GROUND = 0;
function map(roads) {
  const nodes = [], links = [];
  const node = (x, z) => {
    for (let i = 0; i < nodes.length; i += 2) if (nodes[i] === x && nodes[i + 1] === z) return i / 2;
    nodes.push(x, z);
    return nodes.length / 2 - 1;
  };
  for (const { pts, width = 10, kind = BRIDGE, y = 0, deck = 0 } of roads) {
    const inner = pts.slice(1, -1).flat();
    links.push([node(...pts[0]), node(...pts[pts.length - 1]), 0, width, 2, 1, inner, 0, deck, kind, 1, 0, kind === BRIDGE ? pts.map(() => y) : null]);
  }
  return { nodes: Float32Array.from(nodes), links };
}
// A deck along z from 0 to 600, its points every 20 m, at x, joined to the ground at both ends
const along = (x, from = 0, to = 600) => Array.from({ length: (to - from) / 20 + 1 }, (_, i) => [x, from + i * 20]);
const xAt = (RG, l, z) => {
  const pts = [[RG.nodes[l[0] * 2], RG.nodes[l[0] * 2 + 1]]];
  for (let k = 0; k < l[6].length; k += 2) pts.push([l[6][k], l[6][k + 1]]);
  return pts.reduce((best, p) => (Math.abs(p[1] - z) < Math.abs(best[1] - z) ? p : best))[0];
};
const pair = (dy, gap = 8, extra = []) => map([
  { pts: [[0, -30], [0, 0]], kind: GROUND }, { pts: along(0) }, { pts: [[0, 600], [0, 630]], kind: GROUND },
  { pts: [[gap, -30], [gap, 0]], kind: GROUND }, { pts: along(gap), y: dy }, { pts: [[gap, 600], [gap, 630]], kind: GROUND },
  ...extra
]);

test('two decks side by side, 3 m apart in height and overlapping, move apart till their barriers are a wall apart', () => {
  const RG = pair(3);
  const r = separateDecks(RG);
  // Overlapping all along, both counted; after, only where a move eases in from the ends kept (40 m, then 60 m to all of it)
  assert.ok(r.before === 1200 && r.after <= 200, JSON.stringify(r));
  // 10 m wide each: their middles 10 + 2 x 0.6 + 0.6 = 11.8 m apart in the middle, each moved half
  const a = xAt(RG, RG.links[1], 300), b = xAt(RG, RG.links[4], 300);
  assert.ok(b - a >= 11.7 && b - a < 12.5, `${a} ${b}`);
  assert.ok(Math.abs(a + (b - 8)) < 0.3, 'each half the way');
  // Their ends, where they meet the ground, stay where they are
  assert.equal(RG.nodes[RG.links[1][0] * 2], 0);
  assert.equal(RG.nodes[RG.links[4][1] * 2], 8);
});

test('decks at one level, one over the other with room, or crossing, stay where they are', () => {
  for (const [dy, why] of [[1, 'one level: one road surface'], [6, 'a truck\'s room under the higher']]) {
    const RG = pair(dy);
    const r = separateDecks(RG);
    assert.equal(r.links, 0, why);
  }
  // Crossing at 3 m apart: not alongside
  const RG = map([{ pts: [[0, -30], [0, 0]], kind: GROUND }, { pts: along(0) }, { pts: [[0, 600], [0, 630]], kind: GROUND },
    { pts: [[-330, 300], [-300, 300]], kind: GROUND }, { pts: Array.from({ length: 31 }, (_, i) => [-300 + i * 20, 300]), y: 3 }, { pts: [[300, 300], [330, 300]], kind: GROUND }]);
  assert.equal(separateDecks(RG).links, 0);
  // Close but not overlapping: left as they are
  assert.equal(separateDecks(pair(3, 10.5)).links, 0);
});

test('a deck isn\'t moved over a street beside it, nor into a building, and moves 3 m at most', () => {
  // A street along the second deck's far side, its carriageway reaching under the deck: only the first deck moves, 3 m at most
  const RG = pair(3, 8, [{ pts: [[15, -30], [15, 630]], kind: GROUND, width: 8 }]);
  separateDecks(RG);
  assert.ok(Math.abs(xAt(RG, RG.links[4], 300) - 8) < 0.05, 'the deck over the street stays');
  const a = xAt(RG, RG.links[1], 300);
  assert.ok(a < -2.9 && a >= -3.05, `the other moves its most: ${a}`);
  // A building standing up into the first deck on its outer side: it can't move that way
  const RG2 = pair(3);
  separateDecks(RG2, { building: (x) => x < -0.5 });
  assert.ok(Math.abs(xAt(RG2, RG2.links[1], 300)) < 0.6, 'kept out of the building');
  // The Harbour Bridge's own structure (its deck's links) is left as it is
  const RG3 = map([{ pts: [[0, -30], [0, 0]], kind: GROUND }, { pts: along(0), deck: 1 }, { pts: [[0, 600], [0, 630]], kind: GROUND },
    { pts: [[8, -30], [8, 0]], kind: GROUND }, { pts: along(8), y: 3 }, { pts: [[8, 600], [8, 630]], kind: GROUND }]);
  assert.equal(separateDecks(RG3).links, 0);
});
