import { isHeld, tileKeyAt } from '../js/geodata.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Roads on more than one level: the stacks the game once drew at one height, what the road graph's heights now make of
// them (tools/build-heights.mjs), and how something moving through them picks its surface (js/surfaces.js).
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { DECK_DEPTH, KIND, LINKS, PORTALS, STRUCTURES, TUNNEL_HEIGHT, ceilingOver, chooseSurface, groundHeight, inTunnel, roadHeight, roadRoute, structuresAt, surfaceHeight, tunnelCovered } = await import('../js/surfaces.js');
const { STACK_CLEARANCE } = await import('../js/ground-geometry.js');

// Tests under SYDNEY_TILES hold only a part of the map
const nearEdgeOfHeld = (p) => [[-1100, -1100], [1100, -1100], [-1100, 1100], [1100, 1100]].some(([a, b]) => !isHeld(tileKeyAt(p.x + a, p.z + b)));
const heightOn = (link, x, z) => {
  if (!link.kind) return link.cut ? roadHeight(link, x, z) : groundHeight(x, z);
  let best = null;
  for (let i = 1; i < link.pts.length; i++) {
    const a = link.pts[i - 1], b = link.pts[i];
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
    const d = Math.hypot(a.x + dx * t - x, a.z + dz * t - z);
    if (!best || d < best.d) best = { d, y: a.y + (b.y - a.y) * t };
  }
  return best.y;
};
const crossing = (p, q, r, s) => {
  const d = (q.x - p.x) * (s.z - r.z) - (q.z - p.z) * (s.x - r.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((r.x - p.x) * (s.z - r.z) - (r.z - p.z) * (s.x - r.x)) / d;
  const u = ((r.x - p.x) * (q.z - p.z) - (r.z - p.z) * (q.x - p.x)) / d;
  return t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99 ? { x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t } : null;
};
// Every place two links cross with no shared node, and how far apart their surfaces are there
const crossings = [];
for (let i = 0; i < LINKS.length; i++) {
  const A = LINKS[i];
  for (let j = i + 1; j < LINKS.length; j++) {
    const B = LINKS[j];
    if (A.a === B.a || A.a === B.b || A.b === B.a || A.b === B.b) continue;
    for (let k = 1; k < A.pts.length; k++) {
      for (let m = 1; m < B.pts.length; m++) {
        const X = crossing(A.pts[k - 1], A.pts[k], B.pts[m - 1], B.pts[m]);
        if (X) crossings.push({ A, B, ...X, apart: Math.abs(heightOn(A, X.x, X.z) - heightOn(B, X.x, X.z)) });
      }
    }
  }
}
const stack = (over, under) => crossings.filter((c) => (c.A.name.startsWith(over) && c.B.name.startsWith(under)) || (c.B.name.startsWith(over) && c.A.name.startsWith(under)));

test('the stacks once drawn at one height are on two levels', () => {
  for (const [over, under] of [
    ['Cumberland Street', 'Argyle Street'], // the Argyle Cut
    ['Pier Street', 'Zollner Circuit'], // Pier St over Darling Harbour
    ['Railway Colonnade Drive', 'Eddy Avenue'], // Central
    ['Western Distributor', 'Sussex Street'],
    ['Western Distributor', 'Kent Street'],
    ['Western Distributor', 'Harris Street']
  ]) {
    const found = stack(over, under);
    assert.ok(found.length, `${over} doesn't cross ${under}`);
    for (const c of found) {
      const top = c.A.name.startsWith(over) ? c.A : c.B, bottom = top === c.A ? c.B : c.A;
      assert.ok(top.kind === KIND.BRIDGE, `${over} is a bridge`);
      assert.ok(heightOn(top, c.x, c.z) - heightOn(bottom, c.x, c.z) > STACK_CLEARANCE - 0.6,
        `${over} is ${c.apart.toFixed(1)} m over ${under} at ${Math.round(c.x)}, ${Math.round(c.z)}`);
    }
  }
});

test('William St runs under Kings Cross in a tunnel', () => {
  const tunnel = LINKS.filter((l) => l.name === 'William Street' && l.kind === KIND.TUNNEL);
  assert.ok(tunnel.length, 'no tunnel on William St');
  const deepest = Math.max(...tunnel.flatMap((l) => l.pts.map((p) => groundHeight(p.x, p.z) - p.y)));
  assert.ok(deepest > 6, `William St is only ${deepest.toFixed(1)} m under the ground`);
});

test('every crossing without a junction clears, but for a few right at a tunnel mouth', () => {
  assert.ok(crossings.length > 300, `${crossings.length} crossings`);
  const short = crossings.filter((c) => c.apart < STACK_CLEARANCE - 0.6);
  // A tunnel that passes under a street a few metres from its mouth can't be deep enough there: its approach would have
  // to be a cutting the height grid doesn't know about (Fig St under Jones St, Pyrmont)
  assert.ok(short.length <= crossings.length * 0.03, `${short.length} of ${crossings.length} are short: ${short.slice(0, 6).map((c) => `${c.A.name} x ${c.B.name} ${c.apart.toFixed(1)} m`).join('; ')}`);
  const touching = crossings.filter((c) => c.apart <= 2);
  assert.ok(touching.length <= Math.max(0, crossings.length * 0.003), `${touching.length} of ${crossings.length} touch: ${touching.slice(0, 6).map((c) => `${c.A.name} x ${c.B.name} at ${Math.round(c.x)}, ${Math.round(c.z)}`).join('; ')}`);
});

test('every structure meets the road it joins on the ground at that road\'s height, but for a very few to within half a metre', () => {
  const groundAt = new Map();
  for (const l of LINKS) if (!l.kind) for (const n of [l.a, l.b]) { if (!groundAt.has(n)) groundAt.set(n, []); groundAt.get(n).push(l); }
  let joins = 0, off = 0;
  for (const l of LINKS) {
    if (!l.kind || l.deck) continue;
    for (const [n, p] of [[l.a, l.pts[0]], [l.b, l.pts[l.pts.length - 1]]]) {
      for (const road of groundAt.get(n) || []) {
        const by = p.y - roadHeight(road, p.x, p.z);
        joins++;
        if (Math.abs(by) >= 0.2) off++;
        assert.ok(Math.abs(by) < 0.5, `${l.name} is ${by.toFixed(2)} m off ${road.name} at ${Math.round(p.x)}, ${Math.round(p.z)}`);
      }
    }
  }
  assert.ok(off <= Math.max(1, joins * 0.005), `${off} of ${joins} joins are over 0.2 m off`);
});

test('three levels, where one viaduct crosses another over a street, and each keeps to its own', () => {
  // Where one viaduct crosses another high over the ground: three surfaces over one point
  const three = crossings.find((c) => {
    if (c.A.kind !== KIND.BRIDGE || c.B.kind !== KIND.BRIDGE) return false;
    const g = groundHeight(c.x, c.z), ya = heightOn(c.A, c.x, c.z), yb = heightOn(c.B, c.x, c.z);
    return Math.min(ya, yb) - g > STACK_CLEARANCE - 0.6 && Math.abs(ya - yb) > STACK_CLEARANCE - 0.6;
  });
  assert.ok(three, 'no viaduct crosses another high over the ground');
  const levels = [{ sid: 0, y: groundHeight(three.x, three.z) }, ...structuresAt(three.x, three.z)].sort((a, b) => a.y - b.y);
  for (const level of levels) {
    // Arriving at the crossing from a metre away on the same surface, nothing changes level
    const here = chooseSurface(level.sid, level.y, three.x, three.z, 1);
    assert.ok(here, `level at ${level.y.toFixed(1)} m has no way on`);
    assert.equal(here.sid, level.sid, `a car at ${level.y.toFixed(1)} m jumped to ${here.y.toFixed(1)} m`);
  }
  for (let i = 1; i < levels.length; i++) assert.ok(levels[i].y - levels[i - 1].y > STACK_CLEARANCE - 0.6, 'two levels too close together');
});

test('structures are joined up: a deck that meets the ground has a way on and off', () => {
  for (const s of STRUCTURES.slice(1).filter((held) => held?.links.length)) {
    // A structure cut off by the play area's edge may end in the air; any other meets the ground somewhere
    const ends = s.links.flatMap((l) => [l.pts[0], l.pts[l.pts.length - 1]]);
    const touches = ends.some((p) => Math.abs(p.y - groundHeight(p.x, p.z)) < 0.5);
    const atEdge = ends.some(nearEdgeOfHeld) || ends.some((p) => p.x < -2050 || p.x > 2650 || p.z < -4450 || p.z > 2050 || (p.z < -2300 && (p.x < -1450 || p.x > 950)));
    assert.ok(touches || atEdge, `structure ${s.id} (${s.links[0].name}) never comes down to the ground`);
  }
});

test('a tunnel opens only where it comes to the surface, never under a street\'s cutting', () => {
  // The Cross City Tunnel, under the William St cutting: 6 m of cover there, and no hole in the street. Found by its nearest point,
  // since tunnels side by side are moved apart a little (tools/tiles/separate-tubes.mjs)
  let cross = null, at = null;
  for (const l of LINKS) {
    if (l.name !== 'Cross City Tunnel') continue;
    for (const p of l.pts) if (!at || Math.hypot(p.x - 1385, p.z - 63) < Math.hypot(at.x - 1385, at.z - 63)) { cross = l; at = p; }
  }
  assert.ok(cross && Math.hypot(at.x - 1385, at.z - 63) < 12, 'no Cross City Tunnel at Kings Cross');
  assert.ok(inTunnel(cross.sid, at.x, at.z), 'the Cross City Tunnel is open under William St');
  // A link's open stretches run in from its ends; between them, all tube
  for (const l of LINKS) {
    if (l.kind !== KIND.TUNNEL) continue;
    assert.ok(l.openA >= 0 && l.openB >= 0, `${l.name}: ${l.openA}, ${l.openB}`);
    if (l.openA + l.openB < l.length) {
      assert.equal(tunnelCovered(l, l.openA + (l.length - l.openA - l.openB) / 2), true);
      assert.ok(l.length - l.openA - l.openB >= 5, `${l.name} has a roof only ${(l.length - l.openA - l.openB).toFixed(1)} m long`);
    }
  }
});

test('every tunnel mouth faces into its tube, with the cutting behind it', () => {
  assert.ok(PORTALS.length > 20, `${PORTALS.length} mouths`);
  const tunnels = new Set(STRUCTURES.slice(1).filter((s) => s?.kind === KIND.TUNNEL).map((s) => s.id));
  for (const m of PORTALS) {
    if (nearEdgeOfHeld(m)) continue; // its tube may not be held
    const inside = [...tunnels].some((sid) => inTunnel(sid, m.x + m.ux * 6, m.z + m.uz * 6));
    assert.ok(inside, `the mouth at ${Math.round(m.x)}, ${Math.round(m.z)} doesn't face a tube`);
    assert.ok(m.open > 0);
  }
  // Both of William St's, at the Kings Cross end
  assert.equal(PORTALS.filter((m) => Math.hypot(m.x - 1405, m.z - 75) < 12).length, 2);
});

test('a street overlapping a cutting alongside leaves its road alone, and digs no pit beside it', () => {
  // William St's cutting, under the edge of the wide William St beside it
  const road = LINKS.find((l) => l.cut && l.name === 'William Street' && l.pts.some((p) => Math.hypot(p.x - 1383, p.z - 58) < 1));
  assert.ok(road, 'no cutting on William St');
  assert.ok(Math.abs(groundHeight(1385, 55) - roadHeight(road, 1385, 55)) < 0.1, `the ground is ${groundHeight(1385, 55).toFixed(1)} on a road at ${roadHeight(road, 1385, 55).toFixed(1)}`);
});

test('the camera has a ceiling inside a tunnel and under a deck, and none under the sky', () => {
  const tube = LINKS.find((l) => l.name === 'William Street' && l.kind === KIND.TUNNEL && l.pts.some((p) => Math.hypot(p.x - 1550, p.z - 112) < 1));
  const y = tube.pts.find((p) => Math.hypot(p.x - 1550, p.z - 112) < 1).y;
  assert.ok(Math.abs(ceilingOver(tube.sid, y, 1550, 112) - (y + TUNNEL_HEIGHT)) < 1e-6);
  // Argyle St under Cumberland St
  const under = crossings.find((c) => stack('Cumberland Street', 'Argyle Street').includes(c));
  const top = under.A.name.startsWith('Cumberland') ? under.A : under.B;
  const g = groundHeight(under.x, under.z);
  assert.ok(Math.abs(ceilingOver(0, g, under.x, under.z) - (heightOn(top, under.x, under.z) - DECK_DEPTH)) < 0.5);
  // On that deck, and high above it, the sky
  assert.equal(ceilingOver(top.sid, heightOn(top, under.x, under.z), under.x, under.z), Infinity);
  assert.equal(ceilingOver(0, g + 100, under.x, under.z), Infinity);
  assert.equal(ceilingOver(0, groundHeight(397, -1000), 397, -1000), Infinity);
});

test('a way through the road graph keeps to one-way streets and knows its levels', () => {
  const east = roadRoute([{ x: 1217, z: 27 }, { x: 1400, z: 66 }, { x: 1705, z: 115 }, { x: 1901, z: 97 }]);
  assert.ok(east.length > 50, 'no way east through the tunnel');
  assert.ok(east.some((p) => p.tunnel), 'it never goes inside');
  assert.equal(east[0].sid, 0, 'it starts on the ground');
  assert.equal(east.at(-1).sid, 0, 'it ends on the ground');
  for (let i = 1; i < east.length; i++) {
    assert.ok(Math.hypot(east[i].x - east[i - 1].x, east[i].z - east[i - 1].z) < 8.5, 'a gap in the way');
    assert.ok(Math.abs(east[i].y - east[i - 1].y) < 2, `a step in its height at ${Math.round(east[i].x)}, ${Math.round(east[i].z)}`);
  }
});

test('roads off the ground climb gently: only where a tunnel must dive under another, a few metres from its mouth, are they steep', () => {
  const steep = [];
  for (const l of LINKS) {
    if (!l.kind) continue;
    for (let i = 1; i < l.pts.length; i++) {
      const p = l.pts[i - 1], q = l.pts[i], run = Math.hypot(q.x - p.x, q.z - p.z);
      if (run < 3 || Math.abs(q.y - p.y) < 0.3) continue;
      const grade = Math.abs(q.y - p.y) / run;
      if (grade > 0.12) steep.push({ l, grade });
    }
  }
  const offGround = LINKS.filter((l) => l.kind).length;
  assert.ok(new Set(steep.map((v) => v.l)).size <= Math.max(10, offGround * 0.02), `steeper than 12%: ${[...new Set(steep.map((v) => v.l.name))].join(', ')}`);
  for (const { l, grade } of steep) assert.ok(grade < 0.37, `${l.name} climbs ${(grade * 100).toFixed(0)}%`);
});

// The deck carries OSM's own carriageways (plan 5): the northbound on the corridor's structure, the southbound and the Cahill's
// lanes on their own. Each ramp leaving one of them is part of its structure.
test('a ramp leaving the Harbour Bridge keeps its own level, and the deck keeps its', () => {
  const deckLinks = LINKS.filter((l) => l.deck);
  const deckSids = new Set(deckLinks.map((l) => l.sid));
  const deckNodes = new Map();
  for (const l of deckLinks) {
    deckNodes.set(l.a, l.pts[0]);
    deckNodes.set(l.b, l.pts[l.pts.length - 1]);
  }
  const ramps = LINKS.filter((l) => !l.deck && deckSids.has(l.sid) && (deckNodes.has(l.a) || deckNodes.has(l.b)));
  assert.ok(ramps.some((l) => l.name === 'Cahill Expressway'), 'the Cahill leaves the deck at its south end');
  for (const ramp of ramps) {
    // Where it leaves the deck it's at the deck's height, and it doesn't drop away at once: nothing to fall into
    const fromA = deckNodes.has(ramp.a), pts = fromA ? ramp.pts : [...ramp.pts].reverse();
    const at = deckNodes.get(fromA ? ramp.a : ramp.b);
    assert.ok(Math.abs(pts[0].y - at.y) < 0.05, `${ramp.name} starts ${(pts[0].y - at.y).toFixed(2)} m off the deck at ${Math.round(at.x)}, ${Math.round(at.z)}`);
    const run = Math.hypot(pts[1].x - pts[0].x, pts[1].z - pts[0].z);
    assert.ok(Math.abs(pts[0].y - pts[1].y) < Math.max(0.5, run * 0.08), `${ramp.name} drops ${(pts[0].y - pts[1].y).toFixed(1)} m in ${run.toFixed(0)} m off the deck`);
  }
  // Further along, wherever two levels of one overlap, something on one stays on that one
  for (const sid of deckSids) {
    for (const l of LINKS.filter((o) => o.sid === sid && !o.deck)) {
      for (let i = 1; i < l.pts.length; i++) {
        const p = l.pts[i];
        const levels = structuresAt(p.x, p.z).filter((s) => s.sid === sid);
        for (const level of levels) assert.ok(Math.abs(surfaceHeight(sid, p.x, p.z, level.y) - level.y) < 1e-6, 'a level lost at ' + Math.round(p.x) + ', ' + Math.round(p.z));
      }
    }
  }
});

test('wheels stay on the level the car is on, where sunk roads overlap at different heights', async () => {
  const { wheelContacts } = await import('../js/ground-geometry.js');
  // Between the Cahill's cutting at 17 m and the Harbour Tunnel's approach at 14 m, on the ground at 17 m: inside the Cahill's own
  // carriageway, a metre past the approach's. Each road's carriageway is its own level, whichever centre line is nearer (js/surfaces.js)
  const x = 450.7, z = -1285.8, y = groundHeight(x, z);
  assert.ok(Math.abs(y - 17.4) < 0.5, `the ground here is at ${y}`);
  const rest = wheelContacts(x, z, 3.1, 0, y);
  assert.ok(Math.abs(rest.y - y) < 0.6, `a car on the ground at ${y.toFixed(2)} is drawn at ${rest.y.toFixed(2)}`);
  // ...and 4 cm inside the approach's, where the Cahill's centre line is nearer: the approach's level
  assert.ok(Math.abs(groundHeight(452, -1286) - 13.55) < 0.5, `the ground on the approach's edge is at ${groundHeight(452, -1286)}`);
});

test('a car over the crest of a cutting\'s bank rests on it, not drawn into the ground', async () => {
  const { wheelContacts } = await import('../js/ground-geometry.js');
  // The bank between the Cahill and the Harbour Tunnel's approach, where the tunnel's mouth meets it: the wheels' mean was 0.73 m under the
  // ground at the car's middle, and the soak's check is 0.6
  const x = 446.5, z = -1308.5, y = groundHeight(x, z);
  for (let k = 0; k < 16; k++) {
    const rest = wheelContacts(x, z, (k / 16) * Math.PI * 2, 0, y);
    assert.ok(rest.y >= y - 0.21, `heading ${k}/16: drawn at ${rest.y.toFixed(2)} on ground at ${y.toFixed(2)}`);
  }
});

test('a car down a cutting stops at its edge where the ground beside it is another road\'s, at another height', () => {
  // 0.2 m past the Harbour Tunnel's approach's west edge, at 13 m, where the ground is the Cahill's at 17.5 m. A car held there at its
  // own road's height was drawn 4 m under the ground, in the soak
  assert.equal(chooseSurface(0, 13.07, 451, -1292, 1.0), null, 'a car on the approach drives out over its edge');
  // ...and on its lanes it drives on
  const on = chooseSurface(0, 13.6, 456, -1285, 1.0);
  assert.ok(on && Math.abs(on.y - 13.64) < 0.3, `on the approach's lanes: ${JSON.stringify(on)}`);
});

test('a road over a creek with no bridge on the map doesn\'t stop you, and the water beside it still does', async () => {
  const { landAt } = await import('../js/city-config.js');
  const { clearOfWater } = await import('../js/surfaces.js');
  // Centenary Drive, which crosses water here with no bridge
  const [x, z] = [1774, -4373];
  assert.equal(landAt(x, z) && landAt(x + 2.5, z) && landAt(x - 2.5, z) && landAt(x, z + 2.5) && landAt(x, z - 2.5), false, 'the map has changed: pick another crossing');
  assert.equal(clearOfWater(x, z), true);
  assert.equal(clearOfWater(1000, -1700), false, 'the middle of the harbour');
});

// Roads drawn as one deck (js/structures.js, from js/surfaces.js linkEdges()) are one deck to whatever stands on them. Each body
// is driven as js/controllers.js moves the player, 0.1 m a step (js/surfaces.js moveOver()), with a car's margin and the room it
// needs under a deck, a cyclist's and a walker's
const MARGINS = [['a car', 1.0, 2.0], ['a cyclist', 0.39, 2.3], ['a walker', 0.29, 2.3]];
// Where a link's centre line crosses x
const centreAt = (id, x) => {
  const l = LINKS.find((o) => o.id === id);
  for (let i = 1; i < l.pts.length; i++) {
    const a = l.pts[i - 1], b = l.pts[i];
    if ((a.x - x) * (b.x - x) <= 0 && a.x !== b.x) return a.z + ((b.z - a.z) * (x - a.x)) / (b.x - a.x);
  }
  return null;
};
// `each(x, z, sid, y)` after every step
async function drive(sid, y, points, margin, room = 0, each = null) {
  const { moveOver } = await import('../js/surfaces.js');
  let [x, z] = points[0], held = 0, lowest = Infinity, ground = false;
  for (const [tx, tz] of points.slice(1)) {
    for (let i = 0; i < 2000; i++) {
      const dx = tx - x, dz = tz - z, L = Math.hypot(dx, dz);
      if (L < 0.05) break;
      const m = moveOver(sid, y, x, z, x + (dx / L) * Math.min(0.1, L), z + (dz / L) * Math.min(0.1, L), margin, room);
      if (m.held) held++;
      const stopped = Math.hypot(m.x - x, m.z - z) < 0.002;
      ({ x, z, sid, y } = m);
      each?.(x, z, sid, y);
      lowest = Math.min(lowest, y);
      if (!sid) ground = true;
      if (stopped) break;
    }
  }
  const [ex, ez] = points[points.length - 1];
  return { x, z, sid, y, held, lowest, ground, left: Math.hypot(ex - x, ez - z) };
}

test('the Cahill\'s westbound deck past the on-ramp\'s island is one deck, as drawn: nothing drops through the middle of it', async () => {
  // The first video's place: past the island's nose the ramp (link 94751) and the Cahill (94748) are 7-8 m apart, drawn as one deck,
  // with the top of Macquarie St's cutting bank 0.1-1.5 m under the middle. A car steered into the middle sank down the bank onto
  // Macquarie St at 11 m
  for (const [body, margin, room] of MARGINS) {
    assert.equal(chooseSurface(94, 16.95, 402.5, -1333.4, margin)?.sid, 94, `${body} in the middle by the island's nose`);
    const r = await drive(0, groundHeight(409, -1325.5), [[409, -1325.5], [402.8, -1333.2], [400, -1334.7], [397, -1335.75], [394, -1336.5], [390, -1337.75]], margin, room);
    assert.equal(r.sid, 94, `${body} steered into the middle ends on ${r.sid} at ${r.y.toFixed(1)} m`);
    assert.ok(r.lowest > 16.5, `${body} steered into the middle sank to ${r.lowest.toFixed(1)} m`);
    // ...and across it, from the ramp's centre line to the Cahill's, where the middle was an invisible wall
    for (const x of [396, 390]) {
      const from = centreAt(94751, x);
      const across = await drive(94, surfaceHeight(94, x, from), [[x, from], [x, centreAt(94748, x)]], margin, room);
      assert.equal(across.held, 0, `${body} held ${across.held} times crossing at x ${x}`);
      assert.ok(across.sid === 94 && across.left < 0.1, `${body} crossing at x ${x} ends ${across.left.toFixed(1)} m short, on ${across.sid}`);
    }
  }
});

test('a deck\'s start takes a body on across its whole width: the Cahill\'s on-ramp, along its kerbs', async () => {
  // 2.5 m off the ramp's centre line a car never got onto the deck, and rolled 6 m down the bank beside it
  const ramp = LINKS.find((l) => l.id === 94751);
  const [a, b] = ramp.pts, L = Math.hypot(b.x - a.x, b.z - a.z), ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
  for (const [body, margin, room] of MARGINS) {
    for (const off of [-2.5, 2.5]) {
      const P = [-15, 0, 25].map((s) => [a.x + ux * s - uz * off, a.z + uz * s + ux * off]);
      const r = await drive(0, groundHeight(...P[0]), P, margin, room);
      assert.equal(r.sid, 94, `${body} ${off} m off the ramp's line ends on ${r.sid}`);
      assert.ok(r.lowest > 16.5, `${body} ${off} m off the ramp's line dropped to ${r.lowest.toFixed(1)} m`);
    }
  }
});

test('a median holds: between the Cahill\'s two carriageways, nothing drops through it or gets past it', async () => {
  // At (400, -1341) the ground under the median is within a step of the decks: a car dropped through to it
  for (const [body, margin, room] of MARGINS) {
    for (const [sid, from, to] of [[94, [400, -1338.5], [400, -1344]], [355, [400, -1346], [400, -1338]]]) {
      const r = await drive(sid, surfaceHeight(sid, ...from), [from, to], margin, room);
      assert.equal(r.ground, false, `${body} from structure ${sid} dropped through the median`);
      assert.equal(r.sid, sid, `${body} from structure ${sid} got past the median onto ${r.sid}`);
      assert.ok(r.left > 1, `${body} from structure ${sid} got past the median`);
    }
  }
});

test('the gap between two roads drawn as one is drawn, and filled, right up to where they meet', async () => {
  const { linkEdges } = await import('../js/surfaces.js');
  // By the island's nose, the Cahill's deck starts 0.6 m from the ramp's and meets it 4.6 m on: that stretch was left unfilled, a
  // triangle of nothing at the deck's level between the two (the first video, 27.5 s)
  const cahill = LINKS.find((l) => l.id === 94748);
  assert.equal(linkEdges(cahill).sides.get(-1).filled[0], true);
  assert.equal(chooseSurface(94, 16.95, 402.6, -1334.0, 0)?.sid, 94);
});

test('two tunnels\' roads drawn as one are one road: across from the M4 East Tunnel to the Iron Cove Link\'s, under cover', async () => {
  // Links 79226 and 117856, 1.7-2 m apart, no wall between them as drawn. The middle was a wall, or a way down to the ground
  const m4 = LINKS.find((l) => l.id === 79226), link = LINKS.find((l) => l.id === 117856);
  if (!m4 || !link) return; // not held
  const p = m4.pts.reduce((best, q) => (Math.hypot(q.x + 3063.4, q.z - 26.9) < Math.hypot(best.x + 3063.4, best.z - 26.9) ? q : best));
  const o = link.pts.reduce((best, q) => (Math.hypot(q.x - p.x, q.z - p.z) < Math.hypot(best.x - p.x, best.z - p.z) ? q : best));
  for (const [body, margin, room] of MARGINS) {
    const r = await drive(m4.sid, p.y, [[p.x, p.z], [o.x, o.z]], margin, room);
    assert.ok(!r.ground && r.left < 0.5 && r.held === 0, `${body}: ${JSON.stringify(r)}`);
  }
});

// Under a deck as drawn, the ground is solid where there's less room under the deck's underside than a body needs (2 m for a car, 2.3
// for a cyclist or a walker): from the ground, a body stops at the deck's side, or gets on where the two meet, within 0.6 m of its top.
// On the Harbour Bridge that's its whole cross-section, its railway, cycleway and footway too, which aren't anything to stand on
const SWITCH = 0.6;
// The point `off` m east of the Harbour Bridge's corridor (to the right of travel north), `s` m along it
const across = (B, s, off) => { const p = B.bridgePoint(s); return [p.x - p.uz * off, p.z + p.ux * off]; };
// A body on the ground at height y inside the Harbour Bridge's deck as drawn: more than SWITCH under its top, with less than `room` under
// its underside
const insideBridge = (B, x, z, y, room) => { const u = B.deckUndersideAt(x, z); return u !== null && u + DECK_DEPTH - y > SWITCH && u - y < room; };
// The nearest place on a link's centre line to (x, z): { x, z, y, d, ux, uz }
const nearestOn = (link, x, z) => {
  let best = null;
  for (let i = 1; i < link.pts.length; i++) {
    const a = link.pts[i - 1], b = link.pts[i], dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (L * L)));
    const px = a.x + dx * t, pz = a.z + dz * t, d = Math.hypot(px - x, pz - z);
    if (!best || d < best.d) best = { x: px, z: pz, y: a.y + (b.y - a.y) * t, d, ux: dx / L, uz: dz / L };
  }
  return best;
};
// ...and inside a bridge link's own drawn width
const insideLink = (link, x, z, y, room) => { const p = nearestOn(link, x, z); return p.d <= link.half && p.y - y > SWITCH && p.y - DECK_DEPTH - y < room; };

test('the second video\'s crossing: from the Harbour Bridge\'s railway into its lanes, nothing ends on the ground under the deck', async () => {
  const B = await import('../js/bridge.js');
  // 85 m along and 14 m west of the corridor's line: the railway, drawn on the deck, the ground 1.1-1.3 m under its top. A car on the
  // ground there drove on into the lanes under the deck, and down under the approach spans
  const from = across(B, 85, -14), to = across(B, 120, -3);
  for (const [body, margin, room] of MARGINS) {
    let inside = 0;
    const r = await drive(0, groundHeight(...from), [from, to], margin, room, (x, z, sid, y) => { if (!sid && insideBridge(B, x, z, y, room)) inside++; });
    assert.equal(inside, 0, `${body} was on the ground inside the deck for ${inside} steps`);
    assert.ok(r.sid === B.DECK_SID || (!r.sid && r.left > 1), `${body} ends on ${r.sid} at ${r.y.toFixed(1)} m, ${r.left.toFixed(1)} m short`);
  }
});

test('off Upper Fort St\'s east side, 120-130 m along the Harbour Bridge, a body stops at the deck\'s drawn west side', async () => {
  const B = await import('../js/bridge.js');
  const street = LINKS.find((l) => l.id === 108218);
  if (!street) return;
  const [a, b] = [street.pts[0], street.pts[street.pts.length - 1]];
  // 120-127 m along: further on, the ground falls away under the cycleway, and a body can go a metre or two in under it with room
  for (const t of [0.1, 0.3, 0.5]) {
    const x0 = a.x + (b.x - a.x) * t, z0 = a.z + (b.z - a.z) * t, here = B.bridgeAt(x0, z0, 60);
    const west = B.deckEdges(here.s).west;
    for (const [body, margin, room] of MARGINS) {
      let inside = 0;
      const r = await drive(0, roadHeight(street, x0, z0), [[x0, z0], across(B, here.s, 0)], margin, room, (x, z, sid, y) => { if (!sid && insideBridge(B, x, z, y, room)) inside++; });
      assert.equal(inside, 0, `${body} from ${here.s.toFixed(0)} m along was on the ground inside the deck for ${inside} steps`);
      const end = B.bridgeAt(r.x, r.z, 60);
      assert.ok(!r.sid && r.left > 1 && end.off < west, `${body} from ${here.s.toFixed(0)} m along ends on ${r.sid}, ${end.off.toFixed(1)} m off the corridor (its west side ${west.toFixed(1)})`);
    }
  }
});

test('north along Upper Fort St, a body stops at the railway\'s end, 60 m along the Harbour Bridge: the second video at 64 s', async () => {
  const B = await import('../js/bridge.js');
  const street = LINKS.find((l) => l.id === 23208);
  if (!street) return;
  // The street runs on under the railway, 0.6-0.8 m under the deck's top: that's in the map's data. The railway isn't anything to stand on
  const pts = street.pts.filter((p) => { const h = B.bridgeAt(p.x, p.z, 60); return h && h.s > 30 && h.s < 80; }).map((p) => [p.x, p.z]);
  for (const [body, margin, room] of MARGINS) {
    let under = 0;
    const r = await drive(0, roadHeight(street, ...pts[0]), pts, margin, room, (x, z, sid) => { if (!sid && B.deckIsFull(B.bridgeAt(x, z, 60).s) && B.deckUndersideAt(x, z) !== null) under++; });
    assert.equal(under, 0, `${body} was under the railway for ${under} steps`);
    assert.ok(!r.sid && r.left > 1 && B.bridgeAt(r.x, r.z, 60).s < 60, `${body} ends on ${r.sid}, ${B.bridgeAt(r.x, r.z, 60).s.toFixed(1)} m along`);
  }
});

test('a ramp\'s low deck is solid from the lawn beside it, and taken where the two meet: the Western Distributor at (-1088, 274)', async () => {
  const link = LINKS.find((l) => l.id === 108988);
  if (!link) return;
  // The ground falls away under it to the west: 1.3 m under its top at its west edge, 1.9 m 14 m out. From the east it's 0.4 m
  const p = nearestOn(link, -1088, 274), at = (o) => [p.x - p.uz * o, p.z + p.ux * o];
  for (const [body, margin, room] of MARGINS) {
    let inside = 0;
    const r = await drive(0, groundHeight(...at(-14)), [at(-14), at(3)], margin, room, (x, z, sid, y) => { if (!sid && insideLink(link, x, z, y, room)) inside++; });
    assert.equal(inside, 0, `${body} from the west was on the ground inside the deck for ${inside} steps`);
    assert.ok(!r.sid && r.left > 1, `${body} from the west ends on ${r.sid}, ${r.left.toFixed(1)} m short`);
    const east = await drive(0, groundHeight(...at(12)), [at(12), at(0)], margin, room);
    assert.equal(east.sid, link.sid, `${body} from the east ends on ${east.sid}`);
  }
});

test('a street under a deck too low for it stays open: Ennis Rd, 1.8 m under the Cahill\'s edge', async () => {
  // Its west lanes run under the Cahill's deck (link 46817), its road 1.8 m under the deck's: OSM's roads too close in height
  const road = LINKS.find((l) => l.id === 116686);
  if (!road) return;
  const [a, b] = [road.pts[0], road.pts[road.pts.length - 1]], L = Math.hypot(b.x - a.x, b.z - a.z), ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
  for (const [body, margin, room] of MARGINS) {
    for (const off of [0, 3]) {
      const P = [0.1, 0.9].map((t) => [a.x + (b.x - a.x) * t - uz * off, a.z + (b.z - a.z) * t + ux * off]);
      const r = await drive(0, roadHeight(road, ...P[0]), P, margin, room);
      assert.ok(!r.sid && r.held === 0 && r.left < 0.1, `${body} ${off} m west of Ennis Rd's line: ${JSON.stringify(r)}`);
    }
  }
});

test('a body left inside a deck, teleported or with a tile arriving round it, is lifted onto it or moved out beside it', async () => {
  const { moveOver } = await import('../js/surfaces.js');
  const B = await import('../js/bridge.js');
  const ramp = LINKS.find((l) => l.id === 108988);
  for (const [body, margin, room] of MARGINS) {
    // On the Harbour Bridge's railway, 85 m along: nothing of the deck's to stand on there, so onto its lanes or the ground beside it
    const [x, z] = across(B, 85, -14);
    const m = moveOver(0, groundHeight(x, z), x, z, x, z, margin, room);
    assert.ok(m.sid === B.DECK_SID || (!m.sid && !insideBridge(B, m.x, m.z, m.y, room)), `${body} on the railway: ${JSON.stringify(m)}`);
    if (!ramp) continue;
    // Under the Western Distributor's low deck, 3 m in from its west edge, 0.9 m under its road: lifted onto it
    const p = nearestOn(ramp, -1088, 274), qx = p.x + p.uz * 3, qz = p.z - p.ux * 3;
    const n = moveOver(0, groundHeight(qx, qz), qx, qz, qx, qz, margin, room);
    assert.equal(n.sid, ramp.sid, `${body} under the Western Distributor: ${JSON.stringify(n)}`);
  }
});
