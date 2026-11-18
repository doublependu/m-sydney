import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The Harbour Bridge's footway on its own stretch of the deck (js/bridge.js DECK_FOOTWAY): where OSM's footway is on it, clear of the
// roads that join the deck from the east, which run beside its roads at its level short of it at both ends.
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
console.info = () => {};
const B = await import('../js/bridge.js');
const { KIND, LINKS } = await import('../js/surfaces.js');
const { FOOTWAY, footwayNear, holdOnFootway } = await import('../js/arrivals.js');
const { rampOpenings } = await import('../js/harbour-bridge.js');
const { BRIDGE_LENGTH: L, DECK_BARRIER, DECK_FOOTWAY, RAIL_FROM } = B;

// Every other road's lanes at the deck's level across the corridor's line at s: [from, to] m east of it
const segs = LINKS.filter((l) => l.kind !== KIND.TUNNEL && !l.deck).flatMap((l) => l.pts.slice(1).map((b, i) => ({ l, a: l.pts[i], b })));
function lanesAcross(s) {
  const p = B.bridgePoint(s), y = B.deckHeight(s), out = [];
  for (const { l, a, b } of segs) {
    const da = (a.x - p.x) * p.ux + (a.z - p.z) * p.uz, db = (b.x - p.x) * p.ux + (b.z - p.z) * p.uz;
    if ((da > 0) === (db > 0)) continue;
    const t = da / (da - db), x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    if (!(Math.abs(a.y + (b.y - a.y) * t - y) < 1.5)) continue;
    const off = -(x - p.x) * p.uz + (z - p.z) * p.ux;
    out.push({ id: l.id, from: off - l.width / 2, to: off + l.width / 2 });
  }
  return out;
}
const held = LINKS.some((l) => l.deck);

test('the footway has its own stretch, the railway its 60 m from each end', () => {
  assert.ok(DECK_FOOTWAY.from > RAIL_FROM && DECK_FOOTWAY.to < L - RAIL_FROM, 'the footway starts after the railway and ends before it');
  assert.equal(B.footwayOn(DECK_FOOTWAY.from - 1), false);
  assert.equal(B.footwayOn(DECK_FOOTWAY.from), true);
  assert.equal(B.footwayOn(DECK_FOOTWAY.to + 1), false);
  assert.equal(B.railwayOn(RAIL_FROM - 1), false);
  assert.equal(B.railwayOn(RAIL_FROM + 1), true);
  assert.equal(B.railwayOn(L - RAIL_FROM + 1), false);
});

test('off the footway\'s stretch the deck\'s east side is its roads\' barrier, and nothing of it is past that', () => {
  for (const s of [80, 120, 160, DECK_FOOTWAY.to + 50, 1900, 2100]) {
    const lay = B.deckAcross(s), e = B.deckEdges(s), p = B.bridgePoint(s);
    assert.equal(e.east, lay.roadEast + DECK_BARRIER.width, `the east edge ${s} m along`);
    assert.equal(e.west, B.railwayOn(s) ? lay.edgeWest : lay.roadWest - DECK_BARRIER.width, `the west edge ${s} m along`);
    // Where the footway would be
    const off = (lay.footFrom + lay.footTo) / 2, x = p.x - p.uz * off, z = p.z + p.ux * off;
    assert.equal(B.deckOver(x, z), null, `the deck over the footway's place ${s} m along`);
    assert.equal(B.deckUndersideAt(x, z), null, `the deck's underside over the footway's place ${s} m along`);
  }
  // On it, the footway is the deck's, not its roads'
  const s = 1000, lay = B.deckAcross(s), p = B.bridgePoint(s), off = (lay.footFrom + lay.footTo) / 2;
  assert.equal(B.deckEdges(s).east, lay.edgeEast);
  const over = B.deckOver(p.x - p.uz * off, p.z + p.ux * off);
  assert.ok(over && !over.roads, 'over the footway in the middle of the bridge');
});

test('the footway lies on no other road\'s lanes, its ends among them', (t) => {
  if (!held) return t.skip('the bridge\'s tiles not held');
  for (let s = DECK_FOOTWAY.from; s <= DECK_FOOTWAY.to; s += 2) {
    const lay = B.deckAcross(s);
    for (const r of lanesAcross(s)) assert.ok(r.to <= lay.footFrom - 0.5 || r.from >= lay.footTo, `the footway ${s} m along is on road ${r.id}'s lanes`);
  }
  // Short of each end, where it was laid till now, it would have been
  for (const s of [100, 1900]) {
    const lay = B.deckAcross(s);
    assert.ok(lanesAcross(s).some((r) => r.to > lay.footFrom - 0.5 && r.from < lay.footTo), `no road where the footway was ${s} m along`);
  }
});

test('where a side of the deck is its roads alone, its barrier stands on no other road\'s lanes', (t) => {
  if (!held) return t.skip('the bridge\'s tiles not held');
  const opening = rampOpenings();
  let open = 0;
  for (let s = 2; s < L; s += 2) {
    const lay = B.deckAcross(s), lanes = lanesAcross(s);
    if (!lay.foot) {
      if (opening(s, 1)) open++;
      else for (const r of lanes) assert.ok(r.to <= lay.roadEast || r.from >= lay.roadEast + DECK_BARRIER.width, `the east barrier ${s} m along is on road ${r.id}'s lanes`);
    }
    if (!lay.rail && !opening(s, -1)) {
      for (const r of lanes) assert.ok(r.from >= lay.roadWest || r.to <= lay.roadWest - DECK_BARRIER.width, `the west barrier ${s} m along is on road ${r.id}'s lanes`);
    }
  }
  assert.ok(open > 50, `the east barrier open for ${open * 2} m: the roads joining the deck`);
});

test('a walker on the footway stops at its ends, and gets out onto it only on its stretch', () => {
  const at = (s, off) => { const p = B.bridgePoint(s); return [p.x - p.uz * off, p.z + p.ux * off]; };
  const along = (q) => B.bridgeAt(q.x, q.z, 40).s;
  for (const [end, past] of [[DECK_FOOTWAY.from, -3], [DECK_FOOTWAY.to, 3]]) {
    const east = B.deckSpanAt(end).east;
    const q = holdOnFootway(...at(end + past, east + FOOTWAY.MIDDLE));
    assert.ok(q && Math.abs(along(q) - (end - Math.sign(past) * FOOTWAY.END)) < 0.2, `held ${q && along(q).toFixed(2)} m along, at the end ${end}`);
    assert.ok(Math.abs(q.y - B.deckHeight(along(q))) < 0.05, 'at the deck\'s height');
    assert.equal(holdOnFootway(...at(end + 4 * past, east + FOOTWAY.MIDDLE)), null, `well past the end ${end}`);
    assert.equal(footwayNear(...at(end + past, east)), null, `out of a car past the end ${end}`);
    assert.ok(footwayNear(...at(end - 3 * past, east)), `out of a car inside the end ${end}`);
  }
});
