import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Roads on more than one level: the stacks the game once drew at one height, what the road graph's heights now make of
// them (tools/build-heights.mjs), and how something moving through them picks its surface (js/surfaces.js).
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { DECK_DEPTH, KIND, LINKS, PORTALS, STRUCTURES, TUNNEL_HEIGHT, ceilingOver, chooseSurface, groundHeight, inTunnel, roadHeight, roadRoute, structuresAt, surfaceHeight, tunnelCovered } = await import('../js/surfaces.js');
const { STACK_CLEARANCE } = await import('../js/ground-geometry.js');

const heightOn = (link, x, z) => {
  if (!link.kind) return groundHeight(x, z);
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
  for (const c of crossings) assert.ok(c.apart > 2, `${c.A.name} x ${c.B.name} only ${c.apart.toFixed(1)} m apart at ${Math.round(c.x)}, ${Math.round(c.z)}`);
});

test('every structure meets the road it joins on the ground at that road\'s height, to the 0.1 m heights are kept to', () => {
  const groundAt = new Map();
  for (const l of LINKS) if (!l.kind) for (const n of [l.a, l.b]) { if (!groundAt.has(n)) groundAt.set(n, []); groundAt.get(n).push(l); }
  for (const l of LINKS) {
    if (!l.kind || l.deck) continue;
    for (const [n, p] of [[l.a, l.pts[0]], [l.b, l.pts[l.pts.length - 1]]]) {
      for (const road of groundAt.get(n) || []) {
        const off = p.y - roadHeight(road, p.x, p.z);
        assert.ok(Math.abs(off) < 0.1, `${l.name} is ${off.toFixed(2)} m off ${road.name} at ${Math.round(p.x)}, ${Math.round(p.z)}`);
      }
    }
  }
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
  for (const s of STRUCTURES.slice(1)) {
    // A structure cut off by the play area's edge may end in the air; any other meets the ground somewhere
    const ends = s.links.flatMap((l) => [l.pts[0], l.pts[l.pts.length - 1]]);
    const touches = ends.some((p) => Math.abs(p.y - groundHeight(p.x, p.z)) < 0.5);
    const atEdge = ends.some((p) => p.x < -2050 || p.x > 2650 || p.z < -4450 || p.z > 2050 || (p.z < -2300 && (p.x < -1450 || p.x > 950)));
    assert.ok(touches || atEdge, `structure ${s.id} (${s.links[0].name}) never comes down to the ground`);
  }
});

test('a tunnel opens only where it comes to the surface, never under a street\'s cutting', () => {
  // The Cross City Tunnel, under the William St cutting: 6 m of cover there, and no hole in the street
  const cross = LINKS.find((l) => l.name === 'Cross City Tunnel' && l.pts.some((p) => Math.hypot(p.x - 1385, p.z - 63) < 1));
  assert.ok(cross, 'no Cross City Tunnel at Kings Cross');
  assert.ok(inTunnel(cross.sid, 1385, 63), 'the Cross City Tunnel is open under William St');
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
  const tunnels = new Set(STRUCTURES.slice(1).filter((s) => s.kind === KIND.TUNNEL).map((s) => s.id));
  for (const m of PORTALS) {
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
      if (run < 0.5 || Math.abs(q.y - p.y) < 0.3) continue;
      const grade = Math.abs(q.y - p.y) / run;
      if (grade > 0.12) steep.push({ l, grade });
    }
  }
  assert.ok(new Set(steep.map((v) => v.l)).size <= 3, `steeper than 12%: ${[...new Set(steep.map((v) => v.l.name))].join(', ')}`);
  for (const { l, grade } of steep) assert.ok(grade < 0.35, `${l.name} climbs ${(grade * 100).toFixed(0)}%`);
});

test('a ramp leaving the Harbour Bridge keeps its own level, and the deck keeps its', () => {
  const ramp = LINKS.find((l) => l.name === 'Cahill Expressway' && l.pts.some((p) => Math.hypot(p.x + 273, p.z + 1515) < 1) && !l.deck);
  const deck = LINKS.find((l) => l.deck);
  assert.equal(ramp.sid, deck.sid, 'the ramp is part of the bridge\'s structure');
  // Across the deck's own width the ramp is at the deck's height: nothing to fall into
  const start = ramp.pts[0], next = ramp.pts[1];
  assert.ok(Math.abs(start.y - next.y) < 0.5, `it drops ${(start.y - next.y).toFixed(1)} m across the deck`);
  // Further along, wherever two levels of it overlap, something on one stays on that one
  for (const l of LINKS.filter((o) => o.sid === deck.sid && !o.deck)) {
    for (let i = 1; i < l.pts.length; i++) {
      const p = l.pts[i];
      const levels = structuresAt(p.x, p.z).filter((s) => s.sid === deck.sid);
      for (const level of levels) assert.ok(Math.abs(surfaceHeight(deck.sid, p.x, p.z, level.y) - level.y) < 1e-6, 'a level lost at ' + Math.round(p.x) + ', ' + Math.round(p.z));
    }
  }
});

test('wheels stay on the level the car is on, where sunk roads overlap at different heights', async () => {
  const { wheelContacts } = await import('../js/ground-geometry.js');
  // Between the Cahill's cutting at 17 m and the Harbour Tunnel's approach at 14 m, on the ground at 17 m
  const x = 452, z = -1286, y = groundHeight(x, z);
  assert.ok(Math.abs(y - 17.25) < 0.5, `the ground here is at ${y}`);
  const rest = wheelContacts(x, z, 3.1, 0, y);
  assert.ok(Math.abs(rest.y - y) < 0.6, `a car on the ground at ${y.toFixed(2)} is drawn at ${rest.y.toFixed(2)}`);
});
