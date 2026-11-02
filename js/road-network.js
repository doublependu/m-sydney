import { CITY_BOUNDS, DRIVE_SIDE, BLOCKS, blockAt, landAt } from './city-config.js';
import { GEO } from './geodata.js';
import { polygonBoxOverlaps } from './building-collision.js';
import { linkById } from './surfaces.js';

// How far either side of the Harbour Bridge's line a lane counts as on the bridge (its own height, nothing in its way)
const DECK_REACH = 15;

// Drivable road graph from the street centreline (GEO.roadGraph, tools/build-geodata.mjs): the lanes that keep clear of
// medians and obstacles, intersections (signalised where street-details.js mounts signal heads) and the lane-to-lane
// curves used to drive straight through them or turn.
//
// Conventions: north = -z, east = +x. Every directed edge has a unit direction (dx, dz) and a kerb-side normal (rx, rz),
// the side traffic keeps to (DRIVE_SIDE). Lanes are lateral offsets towards it from the centreline, sorted centre to kerb.
// Move kinds: 'R' is the near turn, which stays on the kerb side, and 'L' the far turn, which crosses oncoming traffic.
// Those are the real left and the real right when driving on the left.

const CELL = 32;
const LANE_CLEAR = 1.2; // half width each lane keeps free of obstacles
// Simplified block outlines lap over narrow streets, so a kerb closes only a lane that mostly runs on it (plazas do).
// One sample on anything else in the way closes it. 17% of all roads fell to a single sample before this.
const MAX_ON_KERB = 0.7;
const CROSSWALK = 2.5; // depth between an intersection box and its stop lines
const RIM = 0.85; // of an area's radius
const MAX_STRAY = 1; // m a straight lane may leave the curve of its road

// `area`: { x, z, radius }, the roads to take in. All those held if there's none.
function* buildRoadNetworkSteps(obstacles, signalIntersections = [], area = null) {
  yield;
  // 1. Spatial hash of ground footprints that block lanes and pedestrians
  const hash = new Map();
  const cellKey = (ix, iz) => (ix + 512) * 1024 + iz + 512;

  function insert(r) {
    for (let ix = Math.floor(r.minX / CELL); ix <= Math.floor(r.maxX / CELL); ix++) {
      for (let iz = Math.floor(r.minZ / CELL); iz <= Math.floor(r.maxZ / CELL); iz++) {
        const k = cellKey(ix, iz);
        if (!hash.has(k)) hash.set(k, []);
        hash.get(k).push(r);
      }
    }
  }
  for (const r of obstacles) insert(r);

  // Calls fn(rect) for every footprint overlapping the box until fn returns true
  function query(minX, maxX, minZ, maxZ, fn) {
    for (let ix = Math.floor(minX / CELL); ix <= Math.floor(maxX / CELL); ix++) {
      for (let iz = Math.floor(minZ / CELL); iz <= Math.floor(maxZ / CELL); iz++) {
        const list = hash.get(cellKey(ix, iz));
        if (!list) continue;
        for (const r of list) {
          if (r.minX < maxX && r.maxX > minX && r.minZ < maxZ && r.maxZ > minZ && fn(r)
            && (!r.polygon || polygonBoxOverlaps(r.polygon, (minX + maxX) / 2, (minZ + maxZ) / 2, (maxX - minX) / 2, (maxZ - minZ) / 2))) return true;
        }
      }
    }
    return false;
  }

  const curbAt = (x, z) => { const b = blockAt(x, z); return !!b && !b.median; };
  const onLand = (minX, maxX, minZ, maxZ) => landAt(minX, minZ) && landAt(maxX, minZ) && landAt(minX, maxZ) && landAt(maxX, maxZ);
  const blocked = (minX, maxX, minZ, maxZ) => !onLand(minX, maxX, minZ, maxZ) || query(minX, maxX, minZ, maxZ, (r) => !r.pedestrianOnly);
  const walkable = (minX, maxX, minZ, maxZ) => onLand(minX, maxX, minZ, maxZ) && !query(minX, maxX, minZ, maxZ, () => true);
  const onSidewalk = curbAt;
  // A lane is clear when no curb stands right at (x, z), no median comes within `clear`, and no obstacle under 50 m across
  // reaches it (a whole park's bounds take in the streets around it)
  const MEDIANS = BLOCKS.filter((b) => b.median);
  const medianBox = (r) => MEDIANS.some((b) => Math.abs(b.minX - r.minX) < 0.6 && Math.abs(b.maxX - r.maxX) < 0.6 && Math.abs(b.minZ - r.minZ) < 0.6 && Math.abs(b.maxZ - r.maxZ) < 0.6);
  const medianCells = new Map(); // 64 m cells -> the medians reaching into them
  for (const b of MEDIANS) {
    for (let ix = Math.floor((b.minX - 2) / 64); ix <= Math.floor((b.maxX + 2) / 64); ix++) {
      for (let iz = Math.floor((b.minZ - 2) / 64); iz <= Math.floor((b.maxZ + 2) / 64); iz++) {
        const k = ix * 100000 + iz;
        if (!medianCells.has(k)) medianCells.set(k, []);
        medianCells.get(k).push(b);
      }
    }
  }
  function nearMedian(x, z, clear) {
    for (const b of medianCells.get(Math.floor(x / 64) * 100000 + Math.floor(z / 64)) || []) {
      if (x < b.minX - clear || x > b.maxX + clear || z < b.minZ - clear || z > b.maxZ + clear) continue;
      let inside = false;
      const P = b.poly;
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
        const a = P[i];
        const c = P[j];
        if ((a.z > z) !== (c.z > z) && x < ((c.x - a.x) * (z - a.z)) / (c.z - a.z) + a.x) inside = !inside;
        const ex = c.x - a.x;
        const ez = c.z - a.z;
        const t = Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / (ex * ex + ez * ez || 1)));
        if (Math.hypot(a.x + ex * t - x, a.z + ez * t - z) < clear) return true;
      }
      if (inside) return true;
    }
    return false;
  }
  const deckLine = [];
  for (let i = 0; i + 1 < (GEO.bridge?.length ?? 0); i += 2) deckLine.push([GEO.bridge[i], GEO.bridge[i + 1]]);
  const onDeckLine = (x, z) => {
    for (let i = 1; i < deckLine.length; i++) {
      const [ax, az] = deckLine[i - 1], [bx, bz] = deckLine[i];
      const dx = bx - ax, dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      if (Math.hypot(ax + dx * t - x, az + dz * t - z) < DECK_REACH) return true;
    }
    return false;
  };
  const blockedOnStreet = (x, z, clear) => !landAt(x, z) && !onDeckLine(x, z) || curbAt(x, z) || nearMedian(x, z, clear) ||
    query(x - clear, x + clear, z - clear, z + clear, (r) => !r.pedestrianOnly && (r.maxX - r.minX < 50 || r.maxZ - r.minZ < 50) && !medianBox(r));

  const laneOffsets = (half) => (half >= 10.0 ? [-7.2, -3.6, 0, 3.6, 7.2]
    : half >= 8.5 ? [-5.4, -1.8, 1.8, 5.4]
      : half >= 6.8 ? [-3.6, 0, 3.6]
        : half >= 3.9 ? [-1.8, 1.8] : null);
  let nodes = [];
  // Near the edge of the area taken in, a road carries on beyond it. Without this the Harbour Bridge and the motorways would
  // count as dead ends, unless the area took in the whole of their way round.
  const onRim = (n) => !!area && (n.x - area.x) ** 2 + (n.z - area.z) ** 2 > (area.radius * RIM) ** 2;
  const offTheRim = area ? { leaves: (e) => onRim(e.to), enters: (e) => onRim(e.from) } : null;

  yield;
  // 2. Streets from the centreline graph. Bends get shape nodes, so every edge stays straight.
  const genRuns = centrelineStreets();
  function centrelineStreets() {
    const RG = GEO.roadGraph;
    const runs = [];
    const pos = new Proxy({}, { get: (_, i) => ({ x: RG.nodes[i * 2], z: RG.nodes[i * 2 + 1] }) });
    const inArea = (record) => {
      if (!area) return true;
      const near = (x, z) => (x - area.x) ** 2 + (z - area.z) ** 2 < area.radius ** 2;
      const inner = record[6];
      if (near(RG.nodes[record[0] * 2], RG.nodes[record[0] * 2 + 1]) || near(RG.nodes[record[1] * 2], RG.nodes[record[1] * 2 + 1])) return true;
      for (let k = 0; k < inner.length; k += 2) if (near(inner[k], inner[k + 1])) return true;
      return false;
    };
    // Points every 4 m along a polyline, 7 m clear of its ends, with the direction there
    function samples(pts, fn) {
      let total = 0;
      for (let k = 0; k + 1 < pts.length; k++) total += Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].z - pts[k].z);
      const from = Math.min(7, total / 2);
      let s0 = 0;
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k];
        const b = pts[k + 1];
        const L = Math.hypot(b.x - a.x, b.z - a.z);
        if (L < 1e-6) continue;
        for (let s = Math.max(from, Math.ceil(s0 / 4) * 4); s <= Math.min(s0 + L, total - from); s += 4) {
          const t = (s - s0) / L;
          fn(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, (b.x - a.x) / L, (b.z - a.z) / L);
        }
        s0 += L;
      }
      return total;
    }
    // In a set order, whichever order the tiles arrived in: the same roads make the same network
    const links = RG.links.filter(inArea).sort((p, q) => p.id - q.id).map((record) => {
      const [a, b, ni, w, lanes, dir, inner, major, deck] = record, id = record.id;
      const pts = [pos[a]];
      for (let k = 0; k < inner.length; k += 2) pts.push({ x: inner[k], z: inner[k + 1] });
      pts.push(pos[b]);
      let len = 0;
      for (let k = 0; k + 1 < pts.length; k++) len += Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].z - pts[k].z);
      // sid: the structure it's on (js/surfaces.js), 0 on the ground
      return { id, a, b, name: RG.names[ni], w, lanes, dir, major: !!major, deck: !!deck, sid: linkById.get(id).sid, pts, len };
    });
    // Junctions a few metres apart (divided roads, offset corners) are one: collapse links under 14 m
    const parent = new Map();
    const find = (i) => {
      if (!parent.has(i)) return i;
      const r = find(parent.get(i));
      parent.set(i, r);
      return r;
    };
    for (const l of links) {
      if (l.len >= 14) continue;
      const a = find(l.a), b = find(l.b);
      if (a !== b) parent.set(a, b);
    }
    const sum = new Map();
    const counted = new Set();
    for (const l of links) {
      for (const i of [l.a, l.b]) {
        if (counted.has(i)) continue;
        counted.add(i);
        const r = find(i);
        const s = sum.get(r) || { x: 0, z: 0, n: 0 };
        const at = pos[i];
        s.x += at.x;
        s.z += at.z;
        s.n++;
        sum.set(r, s);
      }
    }
    const junctions = new Map();
    function junction(r) {
      if (!junctions.has(r)) {
        const s = sum.get(r);
        const node = { x: s.x / s.n, z: s.z / s.n, hx: 0, hz: 0, signal: false, in: [], out: [], general: true };
        nodes.push(node);
        junctions.set(r, node);
      }
      return junctions.get(r);
    }
    // Lanes by the street's real width and direction of travel: two from ~8 m one way, two each way from 13 m or when
    // tagged so and wide enough. Wide or major roads take precedence at junctions.
    function lanesOf(l) {
      const half = l.w / 2;
      const axis = l.major || l.w >= 14.5 || l.lanes >= 3 ? 'ave' : 'st';
      if (l.dir !== 0) {
        const lanes = laneOffsets(half) || [0];
        return { half, axis, fwd: l.dir > 0 ? lanes : [], back: l.dir < 0 ? lanes : [] };
      }
      const each = half >= 10.8 || l.lanes >= 6 && half >= 9.5 ? [1.8, 5.4, 9.0] : half >= 6.6 ? [1.8, 5.4] : [1.8];
      return { half, axis, fwd: each, back: each };
    }
    const DEG = Math.PI / 180;
    for (const l of links) {
      const A = junction(find(l.a));
      const B = junction(find(l.b));
      if (A === B) continue;
      const pts = [{ x: A.x, z: A.z }, ...l.pts.slice(1, -1), { x: B.x, z: B.z }];
      // stations along it: the ends and every bend over 12° at least 15 m from the last station and from the far end
      const stations = [A];
      let last = pts[0];
      let lastAt = 0;
      let rest = l.len;
      for (let k = 1; k < pts.length - 1; k++) {
        const p1 = pts[k];
        const p2 = pts[k + 1];
        const d0 = Math.hypot(p1.x - last.x, p1.z - last.z);
        rest -= Math.hypot(p1.x - pts[k - 1].x, p1.z - pts[k - 1].z);
        let turn = Math.abs(Math.atan2(p2.z - p1.z, p2.x - p1.x) - Math.atan2(p1.z - last.z, p1.x - last.x));
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        // (every bend off the ground: a long gentle curve isn't a sharp one, but a chord across it misses the deck, and
        // its height changes along it. On the ground too, once a chord would stray over a metre from the road: lanes would leave it)
        let strays = false;
        const cx = p2.x - last.x, cz = p2.z - last.z, cl = Math.hypot(cx, cz) || 1;
        for (let m = lastAt + 1; m <= k && !strays; m++) strays = Math.abs((pts[m].x - last.x) * cz - (pts[m].z - last.z) * cx) / cl > MAX_STRAY;
        if ((turn < 12 * DEG && !l.sid && !strays) || d0 < 15 || rest < 15) continue;
        const s = { x: p1.x, z: p1.z, hx: 0, hz: 0, signal: false, in: [], out: [], general: true, shape: true };
        nodes.push(s);
        stations.push(s);
        last = p1;
        lastAt = k;
      }
      stations.push(B);
      const lanes = lanesOf(l);
      for (let k = 0; k + 1 < stations.length; k++) runs.push({ from: stations[k], to: stations[k + 1], deck: l.deck, sid: l.sid, link: l.id, ...lanes });
    }
    console.info(`[roads] centreline streets: ${links.length} links, ${runs.length} straight runs`);
    return runs;
  }

  yield;
  // 3. Directed edges between intersections, keeping only the lanes clear of obstacles node to node
  let edges = [];
  // Centreline streets: any direction, so their lanes are checked for obstacles every 2.5 m (clear of the junctions,
  // where neighbouring corners would get in the way of the test) instead of over one bounding box
  const laneOpen = (x0, z0, dx, dz, span, o, maxOnKerb = MAX_ON_KERB) => {
    const rx = -dz * DRIVE_SIDE, rz = dx * DRIVE_SIDE;
    const clear = Math.min(12, span / 2);
    let samples = 0, onKerb = 0;
    for (let t = clear; t <= span - clear + 1e-6; t += 2.5) {
      const x = x0 + dx * t + rx * o, z = z0 + dz * t + rz * o;
      samples++;
      if (curbAt(x, z)) onKerb++;
      else if (blockedOnStreet(x, z, LANE_CLEAR)) return false;
    }
    return onKerb <= samples * maxOnKerb;
  };
  // A lane off the ground (a bridge, a tunnel) has nothing of the ground plan in its way: it's above it or under it
  function addEdgeGeneral(from, to, axis, lanes, half, divided, run, maxOnKerb) {
    const x0 = from.x;
    const z0 = from.z;
    const span = Math.hypot(to.x - x0, to.z - z0);
    if (span < 8) return false;
    const dx = (to.x - x0) / span;
    const dz = (to.z - z0) / span;
    const open = run.sid ? lanes.slice() : lanes.filter((o) => laneOpen(x0, z0, dx, dz, span, o, maxOnKerb));
    if (!open.length) return false;
    edges.push({ from, to, axis, x0, z0, dx, dz, rx: -dz * DRIVE_SIDE, rz: dx * DRIVE_SIDE, span, half, lanes: open.sort((p, q) => p - q), moves: [], general: true, cand: lanes, divided: !!divided, deck: !!run.deck, sid: run.sid || 0, link: run.link });
    return true;
  }
  // A divided road drawn as two one-way roadways between the same two junctions (most of the Bowery) runs both ways
  // along one centreline here: each way keeps to the right of it, as on a two-way street, and the road is as wide as
  // both roadways
  const travel = (r) => (r.fwd.length ? [r.from, r.to] : [r.to, r.from]);
  const oneWays = new Map(); // node -> next node -> the one-way run from one to the other
  for (const r of genRuns) {
    if (!r.fwd.length === !r.back.length) continue;
    const [a, b] = travel(r);
    if (!oneWays.has(a)) oneWays.set(a, new Map());
    oneWays.get(a).set(b, r);
  }
  for (const r of genRuns) {
    if (!r.fwd.length === !r.back.length || r.divided) continue;
    const [a, b] = travel(r);
    const o = oneWays.has(b) && oneWays.get(b).get(a);
    if (!o || o.divided) continue;
    for (const q of [r, o]) {
      const lanes = q.fwd.length ? q.fwd : q.back;
      const right = lanes.map((x) => x - lanes[0] + 1.8); // as on a two-way street, from 1.8 m right of the centreline
      if (q.fwd.length) q.fwd = right;
      else q.back = right;
      q.divided = true;
    }
    r.half = o.half = r.half + o.half;
    if (r.half >= 7.25) r.axis = o.axis = 'ave'; // as wide as a major road (see lanesOf)
  }
  let sliced = 0;
  for (const r of genRuns) {
    const there = r.fwd.length > 0 && addEdgeGeneral(r.from, r.to, r.axis, r.fwd, r.half, r.divided, r);
    const back = r.back.length > 0 && addEdgeGeneral(r.to, r.from, r.axis, r.back, r.half, r.divided, r);
    // A kerb lapping over one side only leaves a two-way street one way, against the map: if one way is open, both are
    if (r.fwd.length && r.back.length && there !== back) {
      if (there) addEdgeGeneral(r.to, r.from, r.axis, r.back, r.half, r.divided, r, 1);
      else addEdgeGeneral(r.from, r.to, r.axis, r.fwd, r.half, r.divided, r, 1);
    }
    if (++sliced % 60 === 0) yield;
  }
  // Two edges from one node to the same next one (a service road whose ends were drawn onto its main road's junctions)
  // would drive through each other: keep the grid's, else the one with the most lanes
  const keptEdge = new Map();
  const edgeRank = (e) => (e.general ? 0 : 1000) + e.lanes.length * 10 + e.half / 100;
  for (const e of edges) {
    let to = keptEdge.get(e.from);
    if (!to) keptEdge.set(e.from, (to = new Map()));
    const o = to.get(e.to);
    if (!o || edgeRank(e) > edgeRank(o)) to.set(e.to, e);
  }
  edges = edges.filter((e) => keptEdge.get(e.from).get(e.to) === e);
  // ...and where only some of the junctions on both sides of its median became one (Pike St), the stretches of its two
  // roadways that run on top of each other the same way
  {
    const oneWay = edges.filter((e) => e.general && !e.divided && e.cand[0] <= 0); // lanes about its centreline
    const cells = new Map(); // 16 m cells -> the one-way edges passing within 4 m
    oneWay.forEach((e, i) => {
      e.oneWay = i;
      for (let t = 0; t <= e.span; t += 8) {
        const x = e.x0 + e.dx * t;
        const z = e.z0 + e.dz * t;
        for (let ix = Math.floor((x - 4) / 16); ix <= Math.floor((x + 4) / 16); ix++) {
          for (let iz = Math.floor((z - 4) / 16); iz <= Math.floor((z + 4) / 16); iz++) {
            const k = (ix + 4096) * 8192 + (iz + 4096);
            const list = cells.get(k);
            if (!list) cells.set(k, [e]);
            else if (list[list.length - 1] !== e) list.push(e);
          }
        }
      }
    });
    // metres of e along f whose lanes come within 3 m of f's (e's right is f's left)
    const onTop = (e, f) => {
      let hits = 0;
      for (let t = 0; t <= e.span; t += 2) {
        const px = e.x0 + e.dx * t - f.x0;
        const pz = e.z0 + e.dz * t - f.z0;
        const u = px * f.dx + pz * f.dz;
        if (u < 0 || u > f.span) continue;
        const side = px * f.rx + pz * f.rz;
        if (e.lanes.some((a) => f.lanes.some((b) => Math.abs(side - a - b) < 3))) hits += 2;
      }
      return hits;
    };
    const partner = new Map(); // edge -> half width of the widest roadway running the other way on top of it
    const tested = new Set();
    for (const list of cells.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const e = list[i];
          const f = list[j];
          if (e.dx * f.dx + e.dz * f.dz > -0.94) continue; // the other way, within 20°
          const key = Math.min(e.oneWay, f.oneWay) * 65536 + Math.max(e.oneWay, f.oneWay);
          if (tested.has(key)) continue;
          tested.add(key);
          if (Math.max(onTop(e, f), onTop(f, e)) < 6) continue;
          partner.set(e, Math.max(partner.get(e) || 0, f.half));
          partner.set(f, Math.max(partner.get(f) || 0, e.half));
        }
      }
    }
    for (const [e, other] of partner) {
      e.lanes = e.cand.map((o) => o - e.cand[0] + 1.8).filter((o) => laneOpen(e.x0, e.z0, e.dx, e.dz, e.span, o));
      e.half += other;
      if (e.half >= 7.25) e.axis = 'ave'; // as wide as a major road (see lanesOf)
      e.divided = true;
    }
    edges = edges.filter((e) => e.lanes.length);
  }
  // No U-turns, nor anything close to one. The deck is the exception: at its south end it meets Upper Fort St at a
  // hairpin, the only way between them, and so the only way between the CBD and the north shore.
  const canFollow = (e, f) => f.to !== e.from && (e.dx * f.dx + e.dz * f.dz >= -0.5 || !!e.deck !== !!f.deck);

  // Edges no vehicle could both reach and leave (dead ends, and roads reached only from them) are dropped once the
  // moves are known (7.); know them already, so that no road keeps clear of a dead one merging with it or forking off it
  {
    const outsOf = new Map();
    for (const e of edges) {
      if (!outsOf.has(e.from)) outsOf.set(e.from, []);
      outsOf.get(e.from).push(e);
    }
    const live = largestComponent(edges, (e) => (outsOf.get(e.to) || []).filter((f) => canFollow(e, f)), offTheRim);
    for (const e of edges) e.live = live.has(e);
  }
  const liveArm = (a) => !!((a.in && a.in.live) || (a.out && a.out.live));

  // The roads meeting at each node ("arms": one per direction a road leaves it in), from the edges into and out of it:
  // { ux, uz } (unit, away from the node), half (the widest roadway's half width), ave (a major road's), and its edge
  // `in` and edge `out`, if any. The two ways of a two-way street share an arm, and so do the two one-way roadways of a
  // divided road (within 20° of each other); a second road arriving or leaving within 20° of another (where streets
  // merge or fork) gets an arm of its own. With `only`, for just the nodes in that set.
  function computeArms(list, only = null) {
    for (const n of only || nodes) n.arms = [];
    const ends = new Map(); // node -> the edge ends there, in the order the edges come
    list.forEach((e, i) => {
      for (const [n, role, ux, uz] of [[e.from, 'out', e.dx, e.dz], [e.to, 'in', -e.dx, -e.dz]]) {
        if (only && !only.has(n)) continue;
        if (role === 'out') e.outArm = null;
        else e.inArm = null;
        if (!ends.has(n)) ends.set(n, []);
        ends.get(n).push({ e, role, ux, uz, order: 2 * i + (role === 'in' ? 1 : 0) });
      }
    });
    const armed = (q) => (q.role === 'out' ? q.e.outArm : q.e.inArm);
    for (const [n, at] of ends) {
      // arms in the order of their first edge end, each pointing along it
      const newArm = (q) => {
        const a = { ux: q.ux, uz: q.uz, half: 0, ave: false, in: null, out: null, order: q.order };
        n.arms.push(a);
        return a;
      };
      const join = (a, q) => {
        a[q.role] = q.e;
        if (q.role === 'out') q.e.outArm = a;
        else q.e.inArm = a;
        a.half = Math.max(a.half, q.e.half);
        a.ave = a.ave || q.e.axis === 'ave';
        a.order = Math.min(a.order, q.order);
      };
      // both ways of a two-way street
      for (const q of at) {
        if (q.role !== 'out') continue;
        const r = at.find((p) => p.role === 'in' && p.e.from === q.e.to);
        if (!r) continue;
        const a = newArm(q.order < r.order ? q : r);
        join(a, q);
        join(a, r);
      }
      // one-way roadways within 20°, one each way: a divided road's, the best aligned first
      const pairs = [];
      for (const q of at) {
        if (q.role !== 'out' || armed(q)) continue;
        for (const r of at) {
          const d = q.ux * r.ux + q.uz * r.uz;
          if (r.role === 'in' && !armed(r) && d > 0.94) pairs.push([d, q, r]);
        }
      }
      pairs.sort((p, q) => q[0] - p[0]);
      for (const [, q, r] of pairs) {
        if (armed(q) || armed(r)) continue;
        const a = newArm(q.order < r.order ? q : r);
        join(a, q);
        join(a, r);
      }
      // and every other road alone
      for (const q of at) if (!armed(q)) join(newArm(q), q);
      n.arms.sort((a, b) => a.order - b.order);
      // an arm within 20° of an earlier one (where roads merge or fork) crosses the other roads as one with it (its
      // lead), as wide as the widest of them
      for (const a of n.arms) {
        a.lead = n.arms.find((b) => b.lead === b && b.ux * a.ux + b.uz * a.uz > 0.94) || a;
        a.lead.wide = Math.max(a.lead === a ? 0 : a.lead.wide, a.half);
      }
    }
  }
  computeArms(edges);
  // A centreline node where just one road goes on, bending less than 35°, is a shape node: no corner to stop at (nor a
  // fork: a road splitting in two live ones within 20°)
  const bends = (n) => {
    const leads = n.arms.filter((a) => a.lead === a);
    const forks = leads.some((l) => n.arms.filter((a) => a.lead === l && liveArm(a)).length > 1);
    return leads.length === 2 && leads[0].ux * leads[1].ux + leads[0].uz * leads[1].uz < -0.82 && !forks;
  };
  for (const n of nodes) if (n.general && !n.shape && bends(n)) n.shape = true;
  // Where two roads leave a node within 20° of each other (they merge or fork there), how far out every lane of one
  // first keeps 3 m (a car's width and some) from every lane of the other
  const lanesOut = (a, r, out) => {
    out.length = 0;
    for (const e of [a.in, a.out]) {
      if (!e || !e.live) continue;
      const t = e === a.out ? r : e.span - r; // r from its start leaving, r before its end arriving
      for (const o of e.lanes) out.push(e.x0 + e.dx * t + e.rx * o, e.z0 + e.dz * t + e.rz * o);
    }
    return out;
  };
  const lanesA = [];
  const lanesB = [];
  function apart(a, b) {
    for (let r = 2; r < 45; r++) {
      lanesOut(a, r, lanesA);
      lanesOut(b, r, lanesB);
      let near = Infinity;
      for (let i = 0; i < lanesA.length; i += 2) {
        for (let j = 0; j < lanesB.length; j += 2) near = Math.min(near, Math.hypot(lanesA[i] - lanesB[j], lanesA[i + 1] - lanesB[j + 1]));
      }
      if (near >= 3) return r;
    }
    return 45;
  }
  // How far before node n an edge arriving along `arm` stops: clear of every road crossing it (at whatever angle: its
  // curb corner reaches past the crossing road's far side by half its own width over the tangent) plus the crosswalk,
  // and clear of the lanes of a road merging with it or forking off it
  const goesOn = (p, q) => p.ux * q.ux + p.uz * q.uz < 0 && Math.abs(p.ux * q.uz - p.uz * q.ux) < 0.26; // q within 15° of straight on from p
  function stopBack(n, arm) {
    if (n.shape) return 1;
    const a = arm.lead;
    let ext = 0;
    let fork = 0;
    for (const b of n.arms) {
      if (b === arm) continue;
      if (b.lead === a) {
        if (liveArm(arm) && liveArm(b)) fork = Math.max(fork, apart(arm, b) + 1); // side by side rather than across
        continue;
      }
      if (b.lead !== b) continue; // crossing as one with its lead
      // the same road going on (into either of two roads forking there, or out of either of two merging)
      if (n.arms.some((p) => p.lead === a && n.arms.some((q) => q.lead === b && goesOn(p, q)))) continue;
      const cos = a.ux * b.ux + a.uz * b.uz;
      const sin = Math.abs(a.ux * b.uz - a.uz * b.ux);
      ext = Math.max(ext, (b.wide + a.wide * Math.abs(cos)) / sin);
    }
    return Math.max(ext > 0 ? Math.min(ext, 20) + CROSSWALK : 2, fork);
  }
  // nodes where grid and centreline roads meet: grid edges stop no closer than the centreline arms need either
  for (const e of edges) if (e.general) e.from.mixed = e.to.mixed = true;

  // Edges run between stop lines: past the intersection box and its crosswalk at both ends (grid edges by the box,
  // centreline ones by the roads crossing them; where both meet, the further of the two). On a short centreline link
  // between acute corners the two pull in together, keeping at least 10 m (or half the link) to queue on.
  function place(e) {
    const back = (n, arm) => {
      if (e.general) return stopBack(n, arm);
      const grid = (e.axis === 'ave' ? n.hz : n.hx) + CROSSWALK;
      return n.mixed && !n.general ? Math.max(grid, stopBack(n, arm)) : grid;
    };
    let b0 = back(e.from, e.outArm);
    let b1 = back(e.to, e.inArm);
    const keep = Math.min(10, e.span * 0.5);
    e.squeezed = false;
    if (e.general && e.span - b0 - b1 < keep) {
      const k = (e.span - keep) / (b0 + b1);
      b0 *= k;
      b1 *= k;
      e.squeezed = !e.to.shape; // its stop line closer to the roads crossing ahead than they need (see the end of 6.)
    }
    e.sx = e.x0 + e.dx * b0;
    e.sz = e.z0 + e.dz * b0;
    e.len = e.span - b0 - b1;
  }
  for (const e of edges) {
    place(e);
    if (++sliced % 200 === 0) yield;
  }
  const placed = edges; // (see 7.)
  const genCreated = edges.filter((e) => e.general).length;
  edges = edges.filter((e) => e.len > (e.general ? 4 : 6));

  // Paint describes the physical streets, including dead ends and roads AI traffic cannot circulate through.
  // Snapshot their geometry before routing moves stop lines, drops edges and renumbers the surviving junctions.
  const paintNodes = new Map(nodes.map((n, id) => [n, { id, x: n.x, z: n.z, shape: n.shape }]));
  const paintEdges = edges.map(({ from, to, axis, x0, z0, sx, sz, dx, dz, rx, rz, span, len, half, lanes, deck, sid, link }) => ({
    from: paintNodes.get(from), to: paintNodes.get(to), axis, x0, z0, sx, sz, dx, dz, rx, rz, span, len, half, lanes, deck, sid, link
  }));

  yield;
  // 6. Movements at each intersection (no U-turns) and the lane each lane leads to, along obstacle-free curves:
  //    straight on, lane i keeps to lane i + k ahead, k chosen to use as many lanes there as possible with the least
  //    sideways shift; turns go from the lane nearest the turn into the lane nearest it. Lanes left with no way on
  //    (where the road ends or narrows) turn alongside the turn lane, or merge. Across the road, lanes always run
  //    left turns, straight on, right turns, into lanes in the same order, so no two paths from one approach cross.
  const lateral = (e, i) => e.x0 * e.rx + e.z0 * e.rz + e.lanes[i];
  const ORDER = { L: 0, S: 1, R: 2 };
  function pathClear(e, i, f, j) {
    const c = makeCurve(e, i, f, j);
    const p = { x: 0, z: 0, dx: 0, dz: 0 };
    const street = e.general || f.general; // through a centreline junction: tested like its lanes
    if (e.sid && f.sid) return true; // a junction off the ground: up in the air, or under it, clear of the ground plan
    const deck = e.deck || f.deck;
    for (let k = 1; k < 10; k++) {
      curvePoint(c, c.len * k / 10, p);
      if (deck && onDeckLine(p.x, p.z)) continue; // up in the air, over whatever the ground plan has there
      if (street ? blockedOnStreet(p.x, p.z, 0.8) : blocked(p.x - 1, p.x + 1, p.z - 1, p.z + 1)) return false;
    }
    return true;
  }
  function inOrder(e, m, i, j) {
    for (const o of e.moves) {
      for (let k = 0; k < e.lanes.length; k++) {
        if (k === i || o.out[k] < 0) continue;
        // o from k is right of m from i: by its kind of turn, then (two of a kind, where a road forks) by how far right
        // it bends
        const right = ORDER[o.turn] - ORDER[m.turn] || (o === m ? o.out[k] - j : Math.sign(o.cross - m.cross));
        if (k < i ? right > 0 : right < 0) return false;
      }
    }
    return true;
  }
  function nearestLane(e, i, f) {
    let j = 0;
    for (let k = 1; k < f.lanes.length; k++) {
      if (Math.abs(lateral(f, k) - lateral(e, i)) < Math.abs(lateral(f, j) - lateral(e, i))) j = k;
    }
    return j;
  }
  // Let lane i of e make move m into lane j of its edge (clamped to the lanes there), if the way is clear
  function link(e, m, i, j) {
    j = Math.max(0, Math.min(m.to.lanes.length - 1, j));
    if (m.out[i] < 0 && inOrder(e, m, i, j) && pathClear(e, i, m.to, j)) m.out[i] = j;
    return m.out[i] >= 0;
  }
  function serveEveryLane(e) {
    const n = e.lanes.length;
    for (let i = 0; i < n; i++) {
      if (e.moves.some((m) => m.out[i] >= 0)) continue;
      const turnLane = (m, k) => link(e, m, i, m.turn === 'L' ? k : m.to.lanes.length - 1 - k);
      const side = (m) => (m.turn === 'L' ? i : n - 1 - i); // lanes between i and the turn's side of the road
      e.moves.some((m) => m.turn !== 'S' && side(m) <= (n - 1) / 2 && turnLane(m, side(m))) ||
        e.moves.some((m) => m.turn === 'S' && link(e, m, i, nearestLane(e, i, m.to))) ||
        e.moves.some((m) => m.turn !== 'S' && turnLane(m, side(m))) ||
        e.moves.some((m) => m.to.lanes.some((_, j) => link(e, m, i, j)));
    }
    // A kerb corner in the way of every curve: clip it. The alternative is a dead end here, and every road that only
    // leads through it lost to the strongly connected set in 7.
    if (e.moves.length && !e.moves.some((m) => m.out.some((j) => j >= 0))) {
      const ahead = (m) => e.dx * m.to.dx + e.dz * m.to.dz;
      const m = e.moves.reduce((p, q) => (ahead(q) > ahead(p) ? q : p));
      for (let i = 0; i < n; i++) m.out[i] = Math.min(i, m.to.lanes.length - 1);
    }
    e.moves = e.moves.filter((m) => m.out.some((j) => j >= 0));
  }
  for (const e of edges) e.from.out.push(e);
  for (const e of edges) {
    if (++sliced % 40 === 0) yield;
    const n = e.lanes.length;
    for (const f of e.to.out) {
      if (!canFollow(e, f)) continue;
      const cross = (e.dx * f.dz - e.dz * f.dx) * DRIVE_SIDE;
      e.moves.push({ to: f, turn: cross > 0.5 ? 'R' : cross < -0.5 ? 'L' : 'S', cross, out: new Array(n).fill(-1) });
    }
    // the straightest first: where a road forks, the branch going most nearly straight on keeps most of its lanes
    const ahead = (m) => e.dx * m.to.dx + e.dz * m.to.dz;
    for (const m of e.moves.slice().sort((p, q) => ahead(q) - ahead(p))) {
      const f = m.to;
      if (m.turn === 'L') link(e, m, 0, 0);
      else if (m.turn === 'R') link(e, m, n - 1, f.lanes.length - 1);
      else {
        let best = 0;
        let bestScore = -Infinity;
        for (let k = 1 - n; k < f.lanes.length; k++) {
          const used = new Set();
          let score = 0;
          for (let i = 0; i < n; i++) {
            const j = Math.max(0, Math.min(f.lanes.length - 1, i + k));
            used.add(j);
            score -= Math.abs(lateral(f, j) - lateral(e, i));
          }
          score += 100 * used.size;
          if (score > bestScore) {
            bestScore = score;
            best = k;
          }
        }
        for (let i = 0; i < n; i++) link(e, m, i, i + best);
      }
    }
    serveEveryLane(e);
  }
  // And the mirror of that: a road every way into which clips a kerb has no traffic and is lost the same way, even
  // though the roads arriving have somewhere else to go. It gets the straightest of them.
  const entered = new Set();
  for (const e of edges) for (const m of e.moves) entered.add(m.to);
  for (const f of edges) {
    if (entered.has(f)) continue;
    let from = null;
    let best = -Infinity;
    for (const e of edges.filter((x) => x.to === f.from && canFollow(x, f))) {
      const ahead = e.dx * f.dx + e.dz * f.dz;
      if (ahead > best) { best = ahead; from = e; }
    }
    if (!from) continue;
    const n = from.lanes.length;
    const cross = (from.dx * f.dz - from.dz * f.dx) * DRIVE_SIDE;
    const turn = cross > 0.5 ? 'R' : cross < -0.5 ? 'L' : 'S';
    const out = new Array(n).fill(-1);
    if (turn === 'R') out[n - 1] = f.lanes.length - 1;
    else out[0] = 0;
    from.moves.push({ to: f, turn, cross, out });
  }

  // Sides & right-of-way groups of node n's arms (see 9.)
  const CARD = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  function sidesAndGroups(n) {
    const arms = n.arms;
    let next = 4;
    for (const a of arms) a.side = -1;
    if (!n.general) {
      // each compass side goes to the arm best aligned with it, within 15°
      CARD.forEach(([cx, cz], c) => {
        let best = null;
        let bd = 0.966;
        for (const a of arms) {
          const d = a.ux * cx + a.uz * cz;
          if (a.side < 0 && d > bd) {
            bd = d;
            best = a;
          }
        }
        if (best) best.side = c;
      });
    }
    for (const a of arms) if (a.side < 0) a.side = next++;
    n.sideCount = Math.max(4, next);
    // roads: arms paired with the one most nearly opposite (beyond 145°), the likeliest pairs first: the straightest,
    // and of two about as straight, the one about as wide (a side street merging into a road nearly head on doesn't
    // take over the road's other side)
    const pairs = [];
    for (let i = 0; i < arms.length; i++) {
      for (let j = i + 1; j < arms.length; j++) {
        const d = arms[i].ux * arms[j].ux + arms[i].uz * arms[j].uz;
        if (d < -0.82) pairs.push([d + 0.02 * Math.abs(arms[i].half - arms[j].half), arms[i], arms[j]]);
      }
    }
    pairs.sort((p, q) => p[0] - q[0]);
    const mates = new Map();
    for (const [, a, b] of pairs) {
      if (mates.has(a) || mates.has(b)) continue;
      mates.set(a, b);
      mates.set(b, a);
    }
    const roads = [];
    const done = new Set();
    for (const a of arms) {
      if (done.has(a)) continue;
      done.add(a);
      const mate = mates.get(a);
      if (mate) done.add(mate);
      const members = mate ? [a, mate] : [a];
      roads.push({ members, group: -1, rank: Math.max(...members.map((m) => (m.ave ? 100 : 0) + m.half)) });
    }
    let groups = 0;
    if (!n.general) {
      // on the grid the road with a north-south arm is the avenue (0), the one with an east-west arm the street (1)
      for (const r of roads) {
        if (r.members.some((m) => m.side === 2 || m.side === 3)) r.group = 0;
        else if (r.members.some((m) => m.side === 0 || m.side === 1)) r.group = 1;
      }
      groups = 2;
    }
    roads.sort((p, q) => q.rank - p.rank);
    for (const r of roads) if (r.group < 0) r.group = groups++;
    for (const r of roads) for (const m of r.members) m.group = r.group;
    n.groupCount = Math.max(2, groups);
  }

  // A short link squeezed between two corners may leave its stop line inside the road crossing ahead, where whoever
  // waits on it stands in the way of the traffic crossing there (of other roads, which share the junction with it).
  // Where the link comes off a bend (a shape node: nothing crosses there), its stop line goes back as far as that
  // takes, as long as a car waiting there still stands on the link (not around the bend, in the way of the next);
  // a link that can't keep clear even so is dropped.
  const inOf = new Map();
  for (const e of edges) {
    if (!inOf.has(e.to)) inOf.set(e.to, []);
    inOf.get(e.to).push(e);
  }
  const HALF_CAR = 2.3;
  const HALF_WIDE = 0.95;
  const pathPt = { x: 0, z: 0, dx: 0, dz: 1 };
  function inTheWay(e) {
    const n = e.to;
    sidesAndGroups(n);
    // a car standing at each of its lanes' stop line
    const cars = e.lanes.map((o) => [e.sx + e.dx * (e.len - HALF_CAR) + e.rx * o, e.sz + e.dz * (e.len - HALF_CAR) + e.rz * o]);
    for (const o of inOf.get(n)) {
      if (o === e || o.inArm.group === e.inArm.group) continue;
      for (const m of o.moves) {
        for (let i = 0; i < o.lanes.length; i++) {
          if (m.out[i] < 0) continue;
          const c = makeCurve(o, i, m.to, m.out[i]);
          for (let s = 0; s <= c.len; s += 1) {
            curvePoint(c, s, pathPt);
            for (const [cx, cz] of cars) {
              const dx = pathPt.x - cx;
              const dz = pathPt.z - cz;
              if (dx * dx + dz * dz > 36) continue;
              // how deep a car on the path overlaps it (separating axes)
              let depth = Infinity;
              for (const [ax, az] of [[e.dx, e.dz], [e.rx, e.rz], [pathPt.dx, pathPt.dz], [-pathPt.dz, pathPt.dx]]) {
                const ra = HALF_CAR * Math.abs(e.dx * ax + e.dz * az) + HALF_WIDE * Math.abs(e.rx * ax + e.rz * az);
                const rb = HALF_CAR * Math.abs(pathPt.dx * ax + pathPt.dz * az) + HALF_WIDE * Math.abs(pathPt.dz * ax - pathPt.dx * az);
                depth = Math.min(depth, ra + rb - Math.abs(dx * ax + dz * az));
              }
              if (depth > 0.25) return true;
            }
          }
        }
      }
    }
    return false;
  }
  const inTheWayOut = new Set();
  for (const e of edges) {
    if (!e.squeezed || !e.from.shape || !inTheWay(e)) continue;
    while (e.len > 6 && inTheWay(e)) e.len = Math.max(5.5, e.len - 1);
    if (inTheWay(e)) inTheWayOut.add(e); // even so
  }
  if (inTheWayOut.size) {
    edges = edges.filter((e) => !inTheWayOut.has(e));
    for (const e of edges) e.moves = e.moves.filter((m) => !inTheWayOut.has(m.to));
  }

  yield;
  // 7. Keep the largest strongly connected set of edges so no vehicle can ever reach a dead end
  const kept = largestComponent(edges, (e) => e.moves.map((m) => m.to), offTheRim);
  const genShortKept = edges.filter((e) => e.general).length;
  const genLost = edges.filter((e) => e.general && !kept.has(e));
  edges = edges.filter((e) => kept.has(e));
  // Roads kept clear of a road merging with them or forking off them that is gone now (too short, or no way on from it
  // after all) get their stop lines placed again without it
  const dropped = placed.filter((e) => e.live && !kept.has(e));
  if (dropped.length) {
    const redo = new Set();
    for (const e of dropped) {
      e.live = false;
      redo.add(e.from).add(e.to);
    }
    computeArms(placed, redo);
    for (const n of redo) if (n.general && !n.shape && bends(n)) n.shape = true;
    for (const e of edges) if (redo.has(e.from) || redo.has(e.to)) place(e);
  }
  console.info(`[roads] centreline edges: ${genCreated} with clear lanes, ${genShortKept} long enough, ${genShortKept - genLost.length} connected`);
  for (const e of edges) {
    e.moves = e.moves.filter((m) => kept.has(m.to));
    serveEveryLane(e);
    // Lanes still leading nowhere (every curve out of them grazes a curb or obstacle): send them on to the nearest lane
    // of the straightest move anyway, so every lane always has a way on
    for (let i = 0; i < e.lanes.length; i++) {
      if (!e.moves.length || e.moves.some((m) => m.out[i] >= 0)) continue;
      const m = e.moves.find((q) => q.turn === 'S') || e.moves[0];
      m.out[i] = nearestLane(e, i, m.to);
    }
    // Off the rim: nowhere to go here. Vehicles are recycled by distance well before this (js/traffic.js), and a road always
    // has a way on as far as the rest of the code knows, so this one is its own.
    if (!e.moves.length && onRim(e.to)) e.moves.push({ to: e, turn: 'S', cross: 0, out: e.lanes.map((_, i) => i) });
  }
  edges.forEach((e, i) => (e.id = i));

  for (const n of nodes) n.in = n.out = null;
  for (const e of edges) {
    (e.from.out || (e.from.out = [])).push(e);
    (e.to.in || (e.to.in = [])).push(e);
  }
  nodes = nodes.filter((n) => n.in || n.out);
  for (const n of nodes) {
    n.in ||= [];
    n.out ||= [];
  }
  nodes.forEach((n, i) => (n.id = i));

  yield;
  // 8. Signalized intersections are exactly the ones with signal heads (street-details.js)
  for (const s of signalIntersections) {
    let n = null, best = 16; // OSM's junction nodes merge into one here, so its signals land a little off centre
    for (const m of nodes) {
      const d = Math.hypot(m.x - s.x, m.z - s.z);
      if (d < best && !m.shape) { best = d; n = m; }
    }
    if (n) {
      n.signal = true;
      (n.points ||= []).push(s); // the heads drawn for it (js/street-details.js)
    }
  }

  yield;
  // 9. Sides & right of way at each node, for traffic.js. Its arms are its sides (one crosswalk and approach each): a
  //    grid intersection keeps east 0, west 1, south 2, north 3, any other arm counts from 4. The arms of one road (on
  //    opposite sides) form a group: vehicles of different groups never share the intersection box, and group 0 has
  //    the right of way at unsignalised corners (and the avenue phase at signals): the avenue on the grid (north-south
  //    arms 0, east-west 1), the widest road at a centreline junction.
  computeArms(edges);
  for (const n of nodes) sidesAndGroups(n);
  for (const e of edges) {
    e.inSide = e.inArm.side; // the side of e.to it arrives over
    e.outSide = e.outArm.side; // the side of e.from it leaves over
    e.axisIndex = e.inArm.group; // its right-of-way group at e.to
    // lateral axis of its road, the same both ways (+x across north-south roads, +z across east-west ones)
    const flip = e.rx < -1e-6 || (Math.abs(e.rx) <= 1e-6 && e.rz < 0);
    e.clx = flip ? -e.rx : e.rx;
    e.clz = flip ? -e.rz : e.rz;
  }
  for (const e of edges) {
    e.opposite = e.to.in.find((o) => o !== e && o.axisIndex === e.axisIndex && o.dx * e.dx + o.dz * e.dz < -0.7) || null;
  }

  // Lane-to-lane curves are built on first use and cached
  const curves = new Map();
  function connector(e, i, f, j) {
    const k = ((e.id * 8 + i) * 16384 + f.id) * 8 + j;
    let c = curves.get(k);
    if (!c) curves.set(k, (c = makeCurve(e, i, f, j)));
    return c;
  }

  const isRoadClear = (x, z, clear = 0.15) => !blockedOnStreet(x, z, clear);
  return { nodes, edges, paintEdges, connector, curvePoint, walkable, onSidewalk, isRoadClear };
}

function buildRoadNetwork(obstacles, signalIntersections = []) {
  const job = buildRoadNetworkSteps(obstacles, signalIntersections);
  let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
}

// The largest strongly connected set of `list` (a Set), going on from item e to the items next(e)
// `open`: { leaves(item), enters(item) }, what runs off the area taken in or comes into it: all the road beyond it counts as
// one more item that they connect through, so a road through the area isn't a dead end for leaving it.
function largestComponent(list, next, open = null) {
  const index = new Map(list.map((e, i) => [e, i]));
  const count = list.length + (open ? 1 : 0);
  const succ = list.map((e, i) => {
    const out = next(e).map((f) => index.get(f)).filter((j) => j !== undefined);
    if (open?.leaves(e)) out.push(list.length);
    return out;
  });
  if (open) succ.push(list.flatMap((e, i) => (open.enters(e) ? [i] : [])));
  const pred = Array.from({ length: count }, () => []);
  succ.forEach((s, i) => {
    for (const j of s) pred[j].push(i);
  });
  // Kosaraju: finishing order going forwards, then components going backwards from the last finished
  const visited = new Uint8Array(count);
  const order = [];
  for (let root = 0; root < count; root++) {
    if (visited[root]) continue;
    visited[root] = 1;
    const stack = [[root, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top[1] < succ[top[0]].length) {
        const j = succ[top[0]][top[1]++];
        if (!visited[j]) {
          visited[j] = 1;
          stack.push([j, 0]);
        }
      } else {
        order.push(top[0]);
        stack.pop();
      }
    }
  }
  const comp = new Int32Array(count).fill(-1);
  let best = -1;
  let bestSize = 0;
  for (let k = order.length - 1, c = 0; k >= 0; k--) {
    if (comp[order[k]] >= 0) continue;
    const stack = [order[k]];
    comp[order[k]] = c;
    let size = 0;
    while (stack.length) {
      const i = stack.pop();
      size++;
      for (const p of pred[i]) {
        if (comp[p] < 0) {
          comp[p] = c;
          stack.push(p);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = c;
    }
    c++;
  }
  return new Set(list.filter((_, i) => comp[i] === best));
}

// Cubic Bézier from the end of lane i on edge e to the start of lane j on edge f: a quarter-circle-like
// arc around the corner for turns, an S-bend for straight lane shifts. Includes an arc-length table and
// the sharpest curvature along it (1 / tightest radius).
function makeCurve(e, i, f, j) {
  const x0 = e.sx + e.dx * e.len + e.rx * e.lanes[i];
  const z0 = e.sz + e.dz * e.len + e.rz * e.lanes[i];
  const x3 = f.sx + f.rx * f.lanes[j];
  const z3 = f.sz + f.rz * f.lanes[j];
  const cross = e.dx * f.dz - e.dz * f.dx;
  let k0;
  let k3;
  if (Math.abs(cross) < 0.5) {
    k0 = k3 = Math.hypot(x3 - x0, z3 - z0) / 3;
  } else {
    const t = ((x3 - x0) * f.dz - (z3 - z0) * f.dx) / cross;
    k0 = 0.552 * Math.abs(t);
    k3 = 0.552 * Math.hypot(x3 - (x0 + e.dx * t), z3 - (z0 + e.dz * t));
  }
  const c = {
    x0, z0, x3, z3,
    x1: x0 + e.dx * k0, z1: z0 + e.dz * k0,
    x2: x3 - f.dx * k3, z2: z3 - f.dz * k3,
    lut: new Float32Array(17),
    len: 0,
    curv: 0
  };
  let px = x0;
  let pz = z0;
  for (let k = 0; k <= 16; k++) {
    const t = k / 16;
    const u = 1 - t;
    const x = u * u * u * x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * x3;
    const z = u * u * u * z0 + 3 * u * u * t * c.z1 + 3 * u * t * t * c.z2 + t * t * t * z3;
    c.len += Math.hypot(x - px, z - pz);
    c.lut[k] = c.len;
    px = x;
    pz = z;
    const dx = 3 * u * u * (c.x1 - x0) + 6 * u * t * (c.x2 - c.x1) + 3 * t * t * (x3 - c.x2);
    const dz = 3 * u * u * (c.z1 - z0) + 6 * u * t * (c.z2 - c.z1) + 3 * t * t * (z3 - c.z2);
    const ddx = 6 * u * (c.x2 - 2 * c.x1 + x0) + 6 * t * (x3 - 2 * c.x2 + c.x1);
    const ddz = 6 * u * (c.z2 - 2 * c.z1 + z0) + 6 * t * (z3 - 2 * c.z2 + c.z1);
    c.curv = Math.max(c.curv, Math.abs(dx * ddz - dz * ddx) / Math.max(1e-6, Math.hypot(dx, dz) ** 3));
  }
  return c;
}

// Position and unit tangent at arc length s along a curve
function curvePoint(c, s, out) {
  let k = 1;
  while (k < 16 && c.lut[k] < s) k++;
  const s0 = c.lut[k - 1];
  const s1 = c.lut[k];
  const t = (k - 1 + Math.min(1, Math.max(0, (s - s0) / (s1 - s0 || 1)))) / 16;
  const u = 1 - t;
  out.x = u * u * u * c.x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x3;
  out.z = u * u * u * c.z0 + 3 * u * u * t * c.z1 + 3 * u * t * t * c.z2 + t * t * t * c.z3;
  const dx = 3 * u * u * (c.x1 - c.x0) + 6 * u * t * (c.x2 - c.x1) + 3 * t * t * (c.x3 - c.x2);
  const dz = 3 * u * u * (c.z1 - c.z0) + 6 * u * t * (c.z2 - c.z1) + 3 * t * t * (c.z3 - c.z2);
  const l = Math.hypot(dx, dz) || 1;
  out.dx = dx / l;
  out.dz = dz / l;
  return out;
}

export { buildRoadNetwork, buildRoadNetworkSteps, CROSSWALK };
