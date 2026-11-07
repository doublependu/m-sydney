import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The Harbour Bridge's lanes are laid out once (js/bridge.js deckLanes()), and traffic, the lines, the lane numbers and the gantries'
// signals all stand on them. They once each worked the lanes out their own way: traffic drove three lanes north under four signals,
// two of them over the lines, and nothing was painted where two of the deck's roads met.
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
console.info = () => {};
const { BRIDGE_LENGTH, DECK_REACH, bridgeAt, bridgePoint, deckHeight, deckLanes, deckLines, deckRoadPoint, deckSpanAt } = await import('../js/bridge.js');
const { edgeHeight, linkById } = await import('../js/surfaces.js');
const { buildRoadNetworkSteps } = await import('../js/road-network.js');
const { buildRoadPaintSteps } = await import('../js/road-paint.js');
const { GANTRIES, gantryLights } = await import('../js/harbour-bridge.js');

const steps = buildRoadNetworkSteps([], []);
let step;
do step = steps.next(); while (!step.done);
const network = step.value;
const laid = network.edges.filter((e) => e.laidOut);

// Traffic's lanes across the deck s m along it, m east of the corridor's line, with where they are: every edge over the deck there,
// each of its lanes, `reach` m past its ends counting, as the curves between edges are. `strays`: how far the edge's own line is from
// its road's line as the deck has it (deckRoadPoint()), where junctions a few metres apart are drawn into one.
function trafficAt(s, reach = 1) {
  const out = [];
  for (const e of laid) {
    const a = bridgeAt(e.sx, e.sz, DECK_REACH), b = bridgeAt(e.sx + e.dx * e.len, e.sz + e.dz * e.len, DECK_REACH);
    if (!a || !b || s < Math.min(a.s, b.s) - reach || s > Math.max(a.s, b.s) + reach) continue;
    const t = ((s - a.s) / (b.s - a.s)) * e.len;
    const x = e.sx + e.dx * t, z = e.sz + e.dz * t, road = deckRoadPoint(e.link, x, z);
    const strays = road ? Math.hypot(road.x - x, road.z - z) : Infinity;
    for (const o of e.lanes) {
      const here = bridgeAt(x + e.rx * o, z + e.rz * o, DECK_REACH);
      if (here) out.push({ off: here.off, north: b.s > a.s, link: e.link, strays, x: x + e.rx * o, z: z + e.rz * o });
    }
  }
  return out;
}
// How far (x, z) is from the middle of lane `number` of the deck near s: on the ground, not across the corridor, which turns a
// couple of degrees at each of its corners and so measures 16 m out from it a little askew there
function fromLane(x, z, number, s) {
  let best = Infinity;
  for (let t = s - 6; t <= s + 6; t += 0.5) {
    const lane = deckLanes(t).find((l) => l.number === number), p = bridgePoint(t);
    if (lane) best = Math.min(best, Math.hypot(p.x - p.uz * lane.off - x, p.z + p.ux * lane.off - z));
  }
  return best;
}

// Where the bus lane forks from the Cahill's, OSM's line for it curves 3 m across in 15 m, and the lanes either side ease over 30 m: they
// come to 2.88 m apart there, room for a bus and a car side by side with half a metre between
test('the deck\'s lanes are in order across it, at least 2.85 m apart (3 m but where the bus lane forks), and numbered from the west', () => {
  for (let s = 0; s <= BRIDGE_LENGTH; s += 2) {
    const lanes = deckLanes(s);
    lanes.forEach((l, i) => assert.equal(l.number, i + 1));
    const least = s > 640 && s < 700 ? 2.85 : 3;
    for (let i = 0; i + 1 < lanes.length; i++) assert.ok(lanes[i + 1].off - lanes[i].off >= least, `lanes ${i + 1} and ${i + 2} at ${s} m: ${(lanes[i + 1].off - lanes[i].off).toFixed(2)} m apart`);
  }
  // Four lanes north on the span, as OSM has them: lanes 1-4
  const span = deckLanes(BRIDGE_LENGTH / 2);
  assert.deepEqual(span.slice(0, 4).map((l) => l.north), [true, true, true, true]);
  assert.ok(span.length >= 7 && span.slice(4).every((l) => !l.north), `${span.length} lanes`);
});

test('traffic drives four lanes north, along the middles of the deck\'s lanes', () => {
  const north = laid.filter((e) => linkById.get(e.link)?.name === 'Sydney Harbour Bridge');
  assert.ok(north.length > 20, `${north.length} northbound edges`);
  for (const e of north) assert.equal(e.lanes.length, 4, `northbound edge at ${Math.round(e.sx)}, ${Math.round(e.sz)}`);
  // Where roads share a roadway, traffic keeps to the lanes it's laid out in, not each road's own: within 0.4 m of the middle of one.
  // Each edge's lanes are straight, and the layout's ease over 30 m where a road joins or forks. Not in the 15 m either side of where
  // one does, where the roads come together or apart at an angle. A road alone between its barriers keeps
  // its own lanes, which its edges, straight across its curves, follow as they did. Not at the corridor's very ends, where OSM's line
  // bends inside an edge.
  let worst = 0, checked = 0;
  const roadsAt = (s) => [...new Set(deckLanes(s).map((l) => l.link))].sort().join();
  for (let s = 20; s < BRIDGE_LENGTH - 20; s += 5) {
    if (roadsAt(s - 15) !== roadsAt(s + 15)) continue;
    const lanes = deckLanes(s);
    const shared = lanes.filter((l) => lanes.filter((m) => m.way === l.way).length > 1);
    for (const t of trafficAt(s)) {
      // Junctions a few metres apart are drawn into one (the Warringah Fwy's short link at the north end): the edges bend to it
      if (!(t.strays < 0.3)) continue;
      const nearest = lanes.filter((l) => l.north === t.north).sort((p, q) => Math.abs(p.off - t.off) - Math.abs(q.off - t.off))[0];
      if (!shared.includes(nearest)) continue;
      const d = fromLane(t.x, t.z, nearest.number, s);
      worst = Math.max(worst, d);
      checked++;
      assert.ok(d < 0.4, `traffic ${d.toFixed(2)} m from the middle of a lane at ${s} m, ${t.off.toFixed(2)} m across`);
    }
  }
  assert.ok(checked > 1500, `traffic in ${checked} lanes checked on the deck`);
});

// Traffic's lanes are straight along each edge, so where a road's lanes ease over they can be a little off the light's
test('each gantry has a light over the middle of each of lanes 1-6 and no others, with traffic under each', () => {
  for (const g of GANTRIES) {
    // (Not over roads beside the deck that the bridge's model stands a barrier between: at its south end)
    const lights = gantryLights(g), lanes = deckLanes(g).filter((l) => l.deck), traffic = trafficAt(g, 5);
    assert.equal(lights.length, Math.min(6, lanes.length), `gantry at ${g} m`);
    lights.forEach((light, i) => {
      assert.ok(Math.abs(light.off - lanes[i].off) < 1e-6, `light ${i + 1} at ${g} m is over lane ${i + 1}`);
      const near = Math.min(...traffic.filter((t) => t.north === light.north).map((t) => fromLane(t.x, t.z, i + 1, g)));
      assert.ok(near < 0.4, `light ${i + 1} at ${g} m is ${near.toFixed(2)} m from traffic's lane`);
    });
    for (let i = 0; i + 1 < lights.length; i++) assert.ok(lights[i + 1].off - lights[i].off >= 3, `lights ${i + 1} and ${i + 2} at ${g} m`);
  }
});

// At the south end, from where the southbound's and the Cahill's ramps meet the deck at 170 m, those roads were beside the deck, not on it:
// the deck stopped at the northbound's edge, its east barrier stood in the southbound's lanes, and the gantry at 200 m had lights over the
// four lanes north only
test('the deck takes in every lane at its south end, the barrier clear of them and a light over each of lanes 1-6 at 200 m', () => {
  for (let s = 176; s <= 240; s += 2) {
    const lanes = deckLanes(s), span = deckSpanAt(s);
    assert.ok(lanes.length === 8 && lanes.every((l) => l.deck), `${lanes.length} lanes at ${s} m, ${lanes.filter((l) => l.deck).length} the deck's`);
    const east = Math.max(...lanes.map((l) => l.off + l.width / 2));
    assert.ok(span.east + 0.5 - east >= 0.5, `the east barrier ${(span.east + 0.5 - east).toFixed(2)} m from the outermost lane at ${s} m`);
  }
  assert.equal(gantryLights(200).length, 6);
});

test('a line between every two lanes side by side on the deck, solid between the directions and beside the bus lane', () => {
  const busOnly = (id) => !!linkById.get(id)?.busOnly;
  const lines = deckLines(0, BRIDGE_LENGTH, busOnly);
  // Where each line is across the deck at s, by walking its points
  const linesAt = (s) => {
    const out = [];
    for (const line of lines) {
      for (let i = 0; i + 1 < line.pts.length; i++) {
        const [ax, az, as] = line.pts[i], [bx, bz, bs] = line.pts[i + 1];
        if (s < as || s > bs) continue;
        const t = (s - as) / (bs - as || 1);
        out.push({ off: bridgeAt(ax + (bx - ax) * t, az + (bz - az) * t, DECK_REACH).off, solid: line.solid });
      }
    }
    return out;
  };
  let checked = 0, solid = 0;
  for (let s = 20; s < BRIDGE_LENGTH - 20; s += 5) {
    const lanes = deckLanes(s), here = linesAt(s);
    for (let i = 0; i + 1 < lanes.length; i++) {
      const a = lanes[i], c = lanes[i + 1], mid = (a.off + c.off) / 2;
      const line = here.find((l) => Math.abs(l.off - mid) < 0.25);
      if (a.way !== c.way || a.deck !== c.deck) {
        assert.equal(line, undefined, `a line between roadways ${a.way} and ${c.way} at ${s} m`);
        continue;
      }
      // Where two lanes fork or merge, they're side by side for only a few metres: not painted
      const apart = (t) => { const l = deckLanes(t); return !l[i] || !l[i + 1] || l[i].way !== l[i + 1].way; };
      if (!line && (apart(s - 15) || apart(s + 15))) continue;
      assert.ok(line, `no line between lanes ${a.number} and ${c.number} at ${s} m`);
      assert.equal(line.solid, a.north !== c.north || busOnly(a.link) !== busOnly(c.link), `the line between lanes ${a.number} and ${c.number} at ${s} m`);
      checked++;
      if (line.solid) solid++;
    }
    // And nothing painted at the kerbs
    for (const l of here) assert.ok(l.off > lanes[0].off && l.off < lanes[lanes.length - 1].off, `a line outside the lanes at ${s} m`);
  }
  assert.ok(checked > 2000 && solid > 300, `${checked} boundaries, ${solid} solid`);
});

test('the paint has the deck\'s lines and no line to give way where roads join it', () => {
  const strips = [];
  let edge = null;
  const builder = {
    strip3D: (ax, ay, az, bx, by, bz, w, col, period = 1, duty = 1) => strips.push({ ax, az, bx, bz, w, dashed: duty < 1, edge }),
    build: () => ({ isGroup: true, children: [] }),
    setEdge(e) { edge = e; }
  };
  const job = buildRoadPaintSteps({ add() {} }, network, builder, null);
  while (!job.next().done);
  // Along the span, a strip at each line between lanes
  const s = 900, p = bridgePoint(s);
  const across = strips.filter((q) => {
    const a = bridgeAt(q.ax, q.az, DECK_REACH), b = bridgeAt(q.bx, q.bz, DECK_REACH);
    return a && b && Math.min(a.s, b.s) <= s && Math.max(a.s, b.s) >= s && Math.abs(a.off - b.off) < 0.5;
  }).map((q) => bridgeAt(q.ax, q.az, DECK_REACH).off);
  const lanes = deckLanes(s);
  for (let i = 0; i + 1 < lanes.length; i++) {
    if (lanes[i].way !== lanes[i + 1].way) continue;
    const mid = (lanes[i].off + lanes[i + 1].off) / 2;
    assert.ok(across.some((off) => Math.abs(off - mid) < 0.25), `no paint between lanes ${i + 1} and ${i + 2} at ${s} m`);
  }
  void p;
  // On the deck, not at the height of some other part of one of its roads: the lines along it once took theirs from the road they
  // started on, and from 170 m on were drawn under the deck
  let high = 0;
  for (const q of strips) {
    if (!q.edge || q.edge.from || !q.edge.link) continue; // the deck's lines: painted on a road, not an edge
    const a = bridgeAt(q.ax, q.az, DECK_REACH);
    if (!a || a.s < 1 || a.s > BRIDGE_LENGTH - 1) continue;
    const y = edgeHeight(q.edge, q.ax, q.az);
    assert.ok(Math.abs(y - deckHeight(a.s)) < 0.5, `a line at ${a.s.toFixed(0)} m, ${a.off.toFixed(1)} m across, is ${(y - deckHeight(a.s)).toFixed(1)} m off the deck`);
    high++;
  }
  assert.ok(high > 1000, `${high} strips of the deck's lines`);
  // Nothing painted across the lanes over the deck, on its roads or those joining it: no stop or give-way line, at the corridor's start
  // or anywhere
  const ontoDeck = new Set(network.paintEdges.filter((e) => e.laidOut).map((e) => e.from));
  const onDeck = (e) => e && (e.laidOut || ontoDeck.has(e.to) || (e.link && !e.from && linkById.get(e.link)?.sid));
  let barsChecked = 0;
  for (const q of strips) {
    if (!onDeck(q.edge)) continue;
    barsChecked++;
    const a = bridgeAt(q.ax, q.az, DECK_REACH), b = bridgeAt(q.bx, q.bz, DECK_REACH);
    if (!a || !b || Math.min(a.s, b.s) < 1 || Math.max(a.s, b.s) > BRIDGE_LENGTH - 1) continue; // past its ends: the ground's roads
    const span = deckLanes(a.s);
    if (!span.length || a.off < span[0].off - 1 || a.off > span[span.length - 1].off + 1) continue;
    const sideways = Math.abs(a.off - b.off) > 2 * Math.abs(a.s - b.s);
    assert.ok(!sideways, `a line across the deck at ${a.s.toFixed(0)} m, ${a.off.toFixed(1)} to ${b.off.toFixed(1)} m across`);
  }
  assert.ok(barsChecked > 500, `${barsChecked} strips on the deck`);
});

test('the red bus lane over the deck runs down the middle of its lane, where the lanes move over too', async () => {
  const { paintFromTags } = await import('../js/road-paint-tags.js');
  const red = [];
  paintFromTags((ax, az, bx, bz, w, color) => { if (color.r > color.g * 2) red.push({ ax, az, bx, bz }); }, (edge, paint) => paint(), { r: 1, g: 1 }, { r: 0, g: 1 });
  let ends = 0;
  for (const q of red) {
    for (const [x, z] of [[q.ax, q.az], [q.bx, q.bz]]) {
      const at = bridgeAt(x, z, DECK_REACH);
      if (!at || at.s < 1 || at.s > BRIDGE_LENGTH - 1) continue;
      const lanes = deckLanes(at.s);
      if (!lanes.length || at.off < lanes[0].off - 2 || at.off > lanes[lanes.length - 1].off + 2) continue;
      const nearest = Math.min(...lanes.map((l) => Math.abs(l.off - at.off)));
      assert.ok(nearest < 0.35, `the bus lane's red at ${at.s.toFixed(0)} m is ${nearest.toFixed(2)} m from the middle of a lane`);
      ends++;
    }
  }
  assert.ok(ends > 400, `${ends} ends of red over the deck`);
});
