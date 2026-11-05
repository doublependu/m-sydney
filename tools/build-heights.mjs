// tools/build-heights.mjs: writes js/height-grid.bin.gz, the ground height of the play area and the land around it, from NSW's
// 5 m elevation model (tools/fetch-elevation.mjs), then every road's height. Global DEMs are no use here: they smear the CBD's towers
// into the ground.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { BitRaster, GRID, Raster, fromWorld, load, toWorld } from './geo-common.mjs';
import { heightSampler } from './fetch-elevation.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const { x0, z0, x1, z1, cell } = GRID;
const w = Math.round((x1 - x0) / cell) + 1, h = Math.round((z1 - z0) / cell) + 1;

// Water pulls the height to sea level at the shore
const { GEO } = await import('./data/generated/geodata.js');
const land = new Raster(x0, z0, x1, z1, cell);
for (const rings of GEO.surroundings) rings.forEach((flat, i) => { const ring = []; for (let k = 0; k < flat.length; k += 2) ring.push([flat[k], flat[k + 1]]); land.fillRing(ring, i ? 0 : 1); });
{
  const bits = BitRaster.load(fileURLToPath(new URL('./data/generated/land.bin', import.meta.url)));
  for (let j = 0; j < land.h; j++) {
    for (let i = 0; i < land.w; i++) {
      if (bits.at(land.x0 + (i + 0.5) * cell, land.z0 + (j + 0.5) * cell)) land.d[j * land.w + i] = 1;
    }
  }
}

const raw = new Float32Array(w * h);
const missing = [];
const fiveMetre = heightSampler(5);
for (let j = 0; j < h; j++) {
  for (let i = 0; i < w; i++) {
    const [lon, lat] = fromWorld(x0 + i * cell, z0 + j * cell);
    const y = fiveMetre(lon, lat);
    if (y === null) missing.push(j * w + i);
    else raw[j * w + i] = y;
  }
}
console.log('[heights] grid', w, 'x', h, 'no contour nearby:', missing.length);

// Holes in the contours: spread the nearest heights in. Then a light blur, and the shore eased down to the water.
const known = new Uint8Array(w * h).fill(1);
for (const k of missing) known[k] = 0;
for (let pass = 0; pass < 40; pass++) {
  const next = known.slice();
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (known[k]) continue;
      let s = 0, n = 0;
      for (const [a, b] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const q = (j + b) * w + i + a;
        if (i + a >= 0 && i + a < w && j + b >= 0 && j + b < h && known[q]) { s += raw[q]; n++; }
      }
      if (n) { raw[k] = s / n; next[k] = 1; }
    }
  }
  known.set(next);
}
const toWater = land.edt((v) => v === 0);
const blur = (src) => {
  const out = new Float32Array(src.length);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let s = 0, n = 0;
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
        if (i + a < 0 || i + a >= w || j + b < 0 || j + b >= h) continue;
        const weight = (a ? 1 : 2) * (b ? 1 : 2);
        s += src[(j + b) * w + i + a] * weight;
        n += weight;
      }
      out[j * w + i] = s / n;
    }
  }
  return out;
};
let smooth = blur(raw);
const SEAWALL = 0.2; // the ground at the seawalls: the game's water lies 2.2 m below 0
for (let k = 0; k < smooth.length; k++) {
  const d = Math.sqrt(toWater[Math.floor(k / w) * land.w + (k % w)] || 0) * cell;
  const t = Math.min(1, d / 40);
  const ease = t * t * (3 - 2 * t);
  smooth[k] = SEAWALL + (Math.max(SEAWALL, smooth[k]) - SEAWALL) * ease;
}
smooth = blur(smooth);

// 0.25 m steps, as differences along each row. Two bytes only where a step is too big for one (zigzag varints).
const out = [];
for (let j = 0; j < h; j++) {
  let prev = 0;
  for (let i = 0; i < w; i++) {
    const v = Math.max(0, Math.round(smooth[j * w + i] * 4));
    const d = v - prev;
    let z = d >= 0 ? d * 2 : -d * 2 - 1;
    while (z > 127) { out.push((z & 127) | 128); z >>= 7; }
    out.push(z);
    prev = v;
  }
}
const packed = zlib.gzipSync(Buffer.from(out), { level: 9 });
fs.writeFileSync(path.join(ROOT, 'tools/data/generated/height-grid.bin.gz'), packed);
const probe = (x, z) => smooth[Math.round((z - z0) / cell) * w + Math.round((x - x0) / cell)].toFixed(1);
console.log('[heights]', (packed.length / 1024).toFixed(0), 'KB gzip;', Object.entries({ quay: [174, -1357], townHall: [0, 0], hyde: [520, 100], central: [92, 1118], kingsCross: [1504, 1], taylor: [1200, 700], northSydney: [-502, -3636], milsons: [-60, -2780], obs: [-360, -1600], darling: [-430, 100] }).map(([k, [x, z]]) => `${k} ${probe(x, z)}`).join(', '));

// --- Every road's height --------------------------------------------------------------------------------------------
// Roads on the ground stand on the grid above, like everything else on the ground, so they keep no heights of their own.
// Bridges, viaducts and tunnels (KIND 1 and 2 in js/geodata.js) get a height at every point, written into each link as
// its profile [y at a, y at each inner point..., y at b]. Each starts as a straight line between the heights where it
// meets the ground, then rises (or, in a tunnel, sinks) wherever it must clear what it crosses, by STACK_CLEARANCE,
// never steeper than MAX_GRADE. The Harbour Bridge's corridor keeps the profile of its own deck (js/bridge.js).
{
  const STACK_CLEARANCE = 6.8; // surface to surface: 5.3 m of headroom and 1.5 m of deck (js/ground-geometry.js)
  const MAX_GRADE = 0.08;
  const WATER_DECK = 3; // a bridge over the harbour stays this far above the game's zero (the water is at -2.2)
  const TUNNEL_COVER = 6.5;
  const MAX_CUT = 8; // m a street may sink below the ground: a cutting, not a tunnel
  const UNDER_WATER = -20; // m a tunnel's road lies at under the harbour
  const SAMPLE = 5; // m between the points heights are worked out at
  const DECK_SHOULDER = 2; // m past a structure's carriageway that the ground under it is lowered (js/surfaces.js)
  const grid = (x, z) => {
    const fx = (x - x0) / cell, fz = (z - z0) / cell;
    if (fx < 0 || fz < 0 || fx >= w - 1 || fz >= h - 1) return 0;
    const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, k = j * w + i;
    // As the game reads it: 0.25 m steps
    const at = (q) => Math.max(0, Math.round(smooth[q] * 4)) / 4;
    const a = at(k) + (at(k + 1) - at(k)) * tx, b = at(k + w) + (at(k + w + 1) - at(k + w)) * tx;
    return a + (b - a) * tz;
  };
  const RG = GEO.roadGraph, N = RG.nodes;
  const links = RG.links.map((l, id) => {
    const [a, b, , width, , , inner, , deck, given = 0, layer = 0] = l;
    const kind = given === 3 ? 0 : given; // a cutting from an earlier run is a street on the ground, worked out again
    const pts = [[N[a * 2], N[a * 2 + 1]]];
    for (let k = 0; k < inner.length; k += 2) pts.push([inner[k], inner[k + 1]]);
    pts.push([N[b * 2], N[b * 2 + 1]]);
    return { id, a, b, width, deck: !!deck, kind, layer, pts, raw: l };
  });

  // The corridor's deck: the same profile as js/bridge.js draws and drives
  const corridor = links.filter((l) => l.deck);
  const deckPath = [];
  for (let i = 0; i < GEO.bridge.length; i += 2) deckPath.push({ x: GEO.bridge[i], z: GEO.bridge[i + 1], s: 0 });
  for (let i = 1; i < deckPath.length; i++) deckPath[i].s = deckPath[i - 1].s + Math.hypot(deckPath[i].x - deckPath[i - 1].x, deckPath[i].z - deckPath[i - 1].z);
  const LENGTH = deckPath[deckPath.length - 1].s;
  const sOf = (x, z) => {
    let best = 0, bd = Infinity;
    for (let i = 1; i < deckPath.length; i++) {
      const p = deckPath[i - 1], q = deckPath[i], dx = q.x - p.x, dz = q.z - p.z, L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - p.x) * dx + (z - p.z) * dz) / L2));
      const d = Math.hypot(p.x + dx * t - x, p.z + dz * t - z);
      if (d < bd) { bd = d; best = p.s + t * Math.sqrt(L2); }
    }
    return best;
  };
  const pointAt = (s) => {
    let i = 1;
    while (i < deckPath.length - 1 && deckPath[i].s < s) i++;
    const p = deckPath[i - 1], q = deckPath[i], t = (s - p.s) / (q.s - p.s || 1);
    return [p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t];
  };
  const DECK = 49, CROWN = 3;
  // m across the deck, from its west edge to its east, measured from the corridor (js/bridge.js DECK_SPAN): east is + (plan 5)
  const DECK_WEST = -25, DECK_EAST = 28;
  const offOf = (x, z) => {
    let best = null;
    for (let i = 1; i < deckPath.length; i++) {
      const p = deckPath[i - 1], q = deckPath[i], dx = q.x - p.x, dz = q.z - p.z, L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - p.x) * dx + (z - p.z) * dz) / L2));
      const px = p.x + dx * t, pz = p.z + dz * t, d = Math.hypot(px - x, pz - z);
      if (!best || d < best.d) best = { d, off: (-(x - px) * dz + (z - pz) * dx) / Math.sqrt(L2) };
    }
    return best.off;
  };
  const startY = grid(deckPath[0].x, deckPath[0].z), endY = grid(deckPath[deckPath.length - 1].x, deckPath[deckPath.length - 1].z);
  let south = 0, north = LENGTH;
  for (let s = 0; s < LENGTH; s += 5) if (grid(...pointAt(s)) < 2) { south = s; break; }
  for (let s = LENGTH; s > 0; s -= 5) if (grid(...pointAt(s)) < 2) { north = s; break; }
  const ease = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
  const deckHeight = (s) => {
    if (s < south) return startY + (DECK - startY) * ease(s / south);
    if (s > north) return endY + (DECK - endY) * ease((LENGTH - s) / (LENGTH - north));
    return DECK + CROWN * Math.sin(((s - south) / (north - south)) * Math.PI);
  };
  // Only the corridor's own nodes are fixed. A road on the ground starts on the grid and may sink below it, never rise:
  // into a cutting where something must pass over it that can't rise any further (Cumberland St over the Argyle Cut),
  // or where a tunnel must already be deep a few metres from its mouth.
  const fixed = new Map(); // node -> height it must have
  for (const l of corridor) for (const n of [l.a, l.b]) fixed.set(n, deckHeight(sOf(N[n * 2], N[n * 2 + 1])));

  // Ramps off the deck come down at no more than MAX_GRADE. Where the road a ramp lands on is too close for that, the
  // motorway carries on as part of the ramp, a low viaduct or an embankment, until it has room.
  const lengthOfLink = (l) => l.pts.reduce((t, p, i) => (i ? t + Math.hypot(p[0] - l.pts[i - 1][0], p[1] - l.pts[i - 1][1]) : 0), 0);
  const linksAt = new Map();
  for (const l of links) for (const n of [l.a, l.b]) (linksAt.get(n) || linksAt.set(n, []).get(n)).push(l);
  let lifted = 0;
  for (const ramp of links) {
    if (ramp.deck || ramp.kind !== 1 || fixed.has(ramp.a) === fixed.has(ramp.b)) continue;
    const top = fixed.get(fixed.has(ramp.a) ? ramp.a : ramp.b);
    ramp.ramp = true;
    const open = [[fixed.has(ramp.a) ? ramp.b : ramp.a, lengthOfLink(ramp)]];
    while (open.length) {
      const [node, run] = open.pop();
      if (top - grid(N[node * 2], N[node * 2 + 1]) <= MAX_GRADE * run) continue;
      for (const next of linksAt.get(node)) {
        if (next.deck || next.ramp || next.kind === 2) continue;
        if (!next.kind) {
          if (!((next.raw[11] || 0) & 1)) continue; // a motorway's, not a street's
          next.kind = 1;
          next.lifted = true; // still a road on the ground wherever the ramp doesn't need it higher
          lifted++;
        }
        next.ramp = true;
        open.push([next.a === node ? next.b : next.a, run + lengthOfLink(next)]);
      }
    }
  }
  console.log(`[heights] ${lifted} motorway links lifted to give the deck's ramps room`);
  // A ramp stays at the deck's height across the deck's own width
  const inDeck = (x, z) => {
    const off = offOf(x, z);
    return off > DECK_WEST && off < DECK_EAST;
  };

  // Samples along every link but the corridor's, linked to their neighbours along it and through shared nodes
  const samples = []; // { x, z, y, lo, hi, kind, layer, fixed, ground }
  const nodeSample = new Map();
  const nbr = [];
  const order = (kind) => (kind === 2 ? 0 : kind === 0 ? 1 : 2); // tunnel under ground under bridge
  const sampleNode = (n) => {
    if (!nodeSample.has(n)) {
      nodeSample.set(n, samples.length);
      const x = N[n * 2], z = N[n * 2 + 1];
      samples.push({ x, z, y: fixed.get(n) ?? grid(x, z), fixed: fixed.has(n), lo: -Infinity, hi: Infinity, grid: grid(x, z), kinds: 0 });
      nbr.push([]);
    }
    return nodeSample.get(n);
  };
  const others = links.filter((l) => !l.deck);
  for (const l of others) {
    l.chain = [sampleNode(l.a)];
    l.at = [0];
    for (let i = 1; i < l.pts.length; i++) {
      const [ax, az] = l.pts[i - 1], [bx, bz] = l.pts[i];
      const L = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(L / SAMPLE));
      for (let k = 1; k <= n; k++) {
        let idx;
        if (i === l.pts.length - 1 && k === n) idx = sampleNode(l.b);
        else {
          idx = samples.length;
          const x = ax + ((bx - ax) * k) / n, z = az + ((bz - az) * k) / n;
          samples.push({ x, z, y: grid(x, z), fixed: false, lo: -Infinity, hi: Infinity, grid: grid(x, z), kinds: 0 });
          nbr.push([]);
        }
        const prev = l.chain[l.chain.length - 1];
        nbr[prev].push([idx, L / n]);
        nbr[idx].push([prev, L / n]);
        l.chain.push(idx);
      }
      l.at.push(l.chain.length - 1);
    }
    for (const idx of l.chain) {
      const smp = samples[idx];
      if (l.ramp && !smp.fixed && inDeck(smp.x, smp.z)) {
        smp.fixed = true;
        smp.y = deckHeight(sOf(smp.x, smp.z));
      }
      smp.kinds |= 1 << l.kind; // a node shared by a bridge and a street is on the ground
      if (l.lifted) smp.lifted = true;
      smp.layer = Math.max(smp.layer ?? -9, l.layer);
    }
  }
  for (const smp of samples) {
    smp.ground = !!(smp.kinds & 1);
    smp.kind = smp.ground ? 0 : smp.kinds & 4 ? 2 : 1;
  }
  const structures = others.filter((l) => l.kind);

  // Start: structures as straight lines between where they meet the ground, free nodes from their neighbours
  const nodeY = new Map([...fixed]);
  for (const n of nodeSample.keys()) if (!fixed.has(n)) nodeY.set(n, samples[nodeSample.get(n)].y);
  const freeNodes = [...nodeSample.keys()].filter((n) => !fixed.has(n) && !samples[nodeSample.get(n)].ground);
  const linkLen = (l) => l.pts.reduce((t, p, i) => (i ? t + Math.hypot(p[0] - l.pts[i - 1][0], p[1] - l.pts[i - 1][1]) : 0), 0);
  const around = new Map();
  for (const l of structures) {
    const L = linkLen(l) || 1;
    for (const [p, q] of [[l.a, l.b], [l.b, l.a]]) {
      if (!around.has(p)) around.set(p, []);
      around.get(p).push([q, L]);
    }
  }
  for (let round = 0; round < 400; round++) {
    for (const n of freeNodes) {
      let sw = 0, sy = 0;
      for (const [q, L] of around.get(n) || []) { sw += 1 / L; sy += nodeY.get(q) / L; }
      if (sw) nodeY.set(n, sy / sw);
    }
  }
  for (const l of structures) {
    const ya = nodeY.get(l.a), yb = nodeY.get(l.b);
    const total = l.chain.length - 1;
    l.chain.forEach((idx, k) => {
      const smp = samples[idx];
      if (!smp.fixed && !smp.ground) smp.y = ya + ((yb - ya) * k) / total;
    });
  }

  // Distance along the network to a road on the ground, for easing a structure's bounds in near its ends
  const toAnchor = new Float64Array(samples.length).fill(Infinity);
  {
    const queue = [];
    // ...and where a viaduct runs straight into a tunnel: neither can be at its full height or depth right there
    const meetsOtherKind = (smp, i) => (smp.kind === 1 || smp.kind === 2) && nbr[i].some(([j]) => (samples[j].kind === 1 || samples[j].kind === 2) && samples[j].kind !== smp.kind);
    samples.forEach((smp, i) => { if (smp.fixed || smp.ground || meetsOtherKind(smp, i)) { toAnchor[i] = 0; queue.push(i); } });
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      for (const [j, d] of nbr[i]) if (toAnchor[i] + d < toAnchor[j]) { toAnchor[j] = toAnchor[i] + d; queue.push(j); }
    }
  }

  // Segments of every link, indexed, for crossings; railways and the corridor stand where they are
  const CELLS = 40;
  const segs = [];
  for (const l of others) for (let k = 1; k < l.chain.length; k++) segs.push({ l, i: l.chain[k - 1], j: l.chain[k] });
  const segCells = new Map();
  for (const sg of segs) {
    const p = samples[sg.i], q = samples[sg.j];
    for (let ix = Math.floor(Math.min(p.x, q.x) / CELLS); ix <= Math.floor(Math.max(p.x, q.x) / CELLS); ix++) {
      for (let iz = Math.floor(Math.min(p.z, q.z) / CELLS); iz <= Math.floor(Math.max(p.z, q.z) / CELLS); iz++) {
        const k = ix * 100000 + iz;
        if (!segCells.has(k)) segCells.set(k, []);
        segCells.get(k).push(sg);
      }
    }
  }
  const fixedLines = [];
  const railLines = load('rail.json').elements.filter((e) => e.type === 'way' && e.geometry && /^(rail|light_rail|subway)$/.test(e.tags?.railway || '')
    && !(e.tags.tunnel && e.tags.tunnel !== 'no') && !(e.tags.bridge && e.tags.bridge !== 'no'));
  for (const r of railLines) {
    const pts = r.geometry.map((g) => toWorld(g.lon, g.lat));
    for (let i = 1; i < pts.length; i++) fixedLines.push({ rail: true, a: pts[i - 1], b: pts[i] });
  }
  for (const l of corridor) for (let i = 1; i < l.pts.length; i++) fixedLines.push({ deck: true, l, a: l.pts[i - 1], b: l.pts[i] });
  const fixedCells = new Map();
  for (const o of fixedLines) {
    for (let ix = Math.floor(Math.min(o.a[0], o.b[0]) / CELLS); ix <= Math.floor(Math.max(o.a[0], o.b[0]) / CELLS); ix++) {
      for (let iz = Math.floor(Math.min(o.a[1], o.b[1]) / CELLS); iz <= Math.floor(Math.max(o.a[1], o.b[1]) / CELLS); iz++) {
        const k = ix * 100000 + iz;
        if (!fixedCells.has(k)) fixedCells.set(k, []);
        fixedCells.get(k).push(o);
      }
    }
  }
  const crossAt = (p, q, r, t) => {
    const d = (q[0] - p[0]) * (t[1] - r[1]) - (q[1] - p[1]) * (t[0] - r[0]);
    if (Math.abs(d) < 1e-9) return null;
    const u = ((r[0] - p[0]) * (t[1] - r[1]) - (r[1] - p[1]) * (t[0] - r[0])) / d;
    const v = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d;
    return u > 0 && u < 1 && v > 0 && v < 1 ? { u, v } : null;
  };
  const landMask = (x, z) => land.at(x, z) === 1;
  const shares = (a, b) => a.a === b.a || a.a === b.b || a.b === b.a || a.b === b.b;
  // Pairs of crossing segments, found once
  const pairs = [];
  const fixedPairs = [];
  for (const sg of segs) {
    const p = samples[sg.i], q = samples[sg.j];
    const seen = new Set();
    for (let ix = Math.floor(Math.min(p.x, q.x) / CELLS); ix <= Math.floor(Math.max(p.x, q.x) / CELLS); ix++) {
      for (let iz = Math.floor(Math.min(p.z, q.z) / CELLS); iz <= Math.floor(Math.max(p.z, q.z) / CELLS); iz++) {
        const k = ix * 100000 + iz;
        for (const sh of segCells.get(k) || []) {
          if (sh === sg || sh.l === sg.l || seen.has(sh) || shares(sh.l, sg.l)) continue;
          seen.add(sh);
          if (sh.l.id < sg.l.id) continue; // each pair once
          const r = samples[sh.i], t = samples[sh.j];
          const X = crossAt([p.x, p.z], [q.x, q.z], [r.x, r.z], [t.x, t.z]);
          if (X) pairs.push({ a: sg, b: sh, u: X.u, v: X.v });
        }
        for (const o of fixedCells.get(k) || []) {
          if (seen.has(o) || (o.l && shares(o.l, sg.l))) continue;
          seen.add(o);
          const X = crossAt([p.x, p.z], [q.x, q.z], o.a, o.b);
          if (X) fixedPairs.push({ a: sg, o, u: X.u, v: X.v });
        }
      }
    }
  }
  const heightAlong = (sg, u) => samples[sg.i].y + (samples[sg.j].y - samples[sg.i].y) * u;
  const fixedHeight = (o, v) => {
    const x = o.a[0] + (o.b[0] - o.a[0]) * v, z = o.a[1] + (o.b[1] - o.a[1]) * v;
    return o.deck ? deckHeight(sOf(x, z)) : grid(x, z);
  };
  // Which of two crossing links is on top: by level (tunnel, ground, bridge), then OSM layer, then as they stand
  const levelOf = (l) => (l.lifted ? 0 : l.kind);
  const onTop = (a, b, ya, yb) => order(levelOf(a)) !== order(levelOf(b)) ? order(levelOf(a)) > order(levelOf(b)) : a.layer !== b.layer ? a.layer > b.layer : ya >= yb;

  const lower = (idx, y) => { const smp = samples[idx]; if (!smp.fixed) smp.hi = Math.min(smp.hi, y); };
  const raise = (idx, y) => { const smp = samples[idx]; if (!smp.fixed && !smp.ground) smp.lo = Math.max(smp.lo, y); };
  const bound = (sinkGround) => {
    samples.forEach((smp, i) => {
      smp.lo = smp.ground ? smp.grid - MAX_CUT : -Infinity;
      smp.hi = smp.ground ? smp.grid : Infinity; // the ground never rises
      if (smp.fixed || smp.ground) return;
      const near = Math.min(toAnchor[i], 120);
      if (smp.kind === 1) {
        smp.lo = smp.lifted ? smp.grid - MAX_CUT : smp.grid + Math.min(1, near * MAX_GRADE);
        if (!landMask(smp.x, smp.z)) smp.lo = Math.max(smp.lo, Math.min(WATER_DECK, near * MAX_GRADE));
      } else {
        smp.hi = smp.grid - Math.min(TUNNEL_COVER, near * MAX_GRADE);
        // Under the harbour, well under its floor: the game's water lies at -2.2 m and the grid knows nothing below it
        if (!landMask(smp.x, smp.z)) smp.hi = Math.min(smp.hi, Math.max(UNDER_WATER, -2.2 - near * MAX_GRADE));
      }
    });
    for (const { a, b, u, v } of pairs) {
      const ya = heightAlong(a, u), yb = heightAlong(b, v);
      const [top, bottom, yTop, yBottom] = onTop(a.l, b.l, ya, yb) ? [a, b, ya, yb] : [b, a, yb, ya];
      if (order(levelOf(top.l)) === 1 && order(levelOf(bottom.l)) === 1) continue; // two roads on the ground cross at a junction
      // The upper rises clear if it's a bridge; the lower sinks clear if it's a tunnel, or a street that's still too
      // close once the bridge over it has risen all it can
      if (levelOf(top.l) === 1) { raise(top.i, yBottom + STACK_CLEARANCE); raise(top.j, yBottom + STACK_CLEARANCE); }
      if (bottom.l.kind === 2 || (sinkGround && levelOf(bottom.l) === 0)) { lower(bottom.i, yTop - STACK_CLEARANCE); lower(bottom.j, yTop - STACK_CLEARANCE); }
    }
    for (const { a, o, v } of fixedPairs) {
      const other = fixedHeight(o, v);
      if (a.l.kind === 1) { raise(a.i, other + STACK_CLEARANCE); raise(a.j, other + STACK_CLEARANCE); }
      else if (a.l.kind === 2 || (sinkGround && o.deck)) { lower(a.i, other - STACK_CLEARANCE); lower(a.j, other - STACK_CLEARANCE); }
    }
    // A bridge climbs from where it meets the ground no steeper than MAX_GRADE: a short one can't rise far, and what it
    // can't clear, the street under it has to (sinkGround above)
    const reach = new Float64Array(samples.length).fill(Infinity);
    const queue = [];
    samples.forEach((smp, i) => { if (smp.fixed || smp.ground) { reach[i] = smp.y; queue.push(i); } });
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      for (const [j, d] of nbr[i]) {
        if (samples[j].kind !== 1 || samples[j].fixed || samples[j].ground) continue;
        if (reach[i] + MAX_GRADE * d < reach[j] - 1e-6) { reach[j] = reach[i] + MAX_GRADE * d; queue.push(j); }
      }
    }
    samples.forEach((smp, i) => { if (smp.kind === 1 && !smp.fixed && !smp.ground) smp.lo = Math.min(smp.lo, reach[i]); });
  };

  // Whatever still climbs faster than MAX_GRADE, where neither side's own rule reached the other: the high side comes down
  // and the low side up, as far as their bounds let them. What's left is a clearance that can't be had in the distance, or
  // a road pinned at both ends.
  const limitGrades = () => {
    for (let pass = 0; pass < 300; pass++) {
      let changed = false;
      for (let i = 0; i < samples.length; i++) {
        for (const [j, d] of nbr[i]) {
          if (j < i) continue;
          const high = samples[i].y > samples[j].y ? samples[i] : samples[j];
          const low = high === samples[i] ? samples[j] : samples[i];
          const excess = high.y - low.y - MAX_GRADE * d;
          if (excess <= 0.02) continue;
          // (a bound may be infinite)
          const down = high.fixed || high.ground ? 0 : Math.min(excess, Math.max(0, high.y - high.lo));
          const up = low.fixed || low.ground ? 0 : Math.min(excess, Math.max(0, low.hi - low.y));
          if (down + up < 0.005) continue;
          const take = Math.min(excess, down + up);
          high.y -= (take * down) / (down + up);
          low.y += (take * up) / (down + up);
          changed = true;
        }
      }
      if (!changed) break;
    }
  };

  // Rise to every lower bound and sink to every upper one, then spread each change along the roads at MAX_GRADE, so a
  // crossing lifts a smooth hump, or cuts a smooth dip, rather than a spike
  const settle = () => {
    for (const smp of samples) if (!smp.fixed) smp.y = Math.min(smp.hi, Math.max(smp.lo, smp.y));
    for (let pass = 0; pass < 80; pass++) {
      let changed = false;
      for (let i = 0; i < samples.length; i++) {
        const a = samples[i];
        for (const [j, d] of nbr[i]) {
          const b = samples[j];
          if (b.fixed) continue;
          // A raised bridge lifts its neighbours on the bridge; a sunk tunnel takes its neighbours down. A cutting is a
          // depth below the ground, and tapers back to it at MAX_GRADE: a street steeper than that is no cutting.
          if (b.kind === 1 && b.y < a.y - MAX_GRADE * d && b.y < b.hi) { b.y = Math.min(b.hi, a.y - MAX_GRADE * d); changed = true; }
          if (b.kind === 2 && b.y > a.y + MAX_GRADE * d && b.y > b.lo) { b.y = Math.max(b.lo, a.y + MAX_GRADE * d); changed = true; }
          if (b.ground) {
            const depth = Math.max(0, a.grid - a.y - MAX_GRADE * d);
            if (depth > 0 && b.y > b.grid - depth + 1e-6 && b.y > b.lo) { b.y = Math.max(b.lo, b.grid - depth); changed = true; }
          }
        }
      }
      if (!changed) break;
    }
    // A light smoothing of what was moved, keeping to the bounds
    for (let pass = 0; pass < 8; pass++) {
      const next = samples.map((smp, i) => {
        if (smp.fixed || !nbr[i].length || (smp.ground && smp.y > smp.grid - 0.05)) return smp.y;
        let sy = smp.y * 2, n = 2;
        for (const [j] of nbr[i]) { sy += samples[j].y; n++; }
        return Math.min(smp.hi, Math.max(smp.lo, sy / n));
      });
      next.forEach((y, i) => { samples[i].y = y; });
    }
    limitGrades();
  };
  // Bridges rise first; only what they couldn't clear then sinks into the ground
  for (let round = 0; round < 6; round++) {
    bound(round >= 2);
    settle();
  }

  // Report what couldn't be met
  bound(true);
  let short = 0;
  for (const smp of samples) if (!smp.fixed && (smp.y < smp.lo - 0.3 || smp.y > smp.hi + 0.3)) short++;

  // Leaving a structure, a road eases away from it: the land under the end of a ramp can fall away far quicker than anyone could drive
  const easeFromStructures = (movable, field) => {
    const GRADE = 0.14; // as steep as the approach to a real bridge gets. It goes on as far as it has to, or it would leave a cliff where it stopped.
    const LEVEL = 0.03; // ...and hardly at all while the structure is still under you, as its end runs its own half-width past the last point
    let frontier = [];
    const seed = (idx, half) => frontier.push({ i: idx, left: half + 1 });
    for (const l of structures) { seed(l.chain[0], l.width / 2); seed(l.chain[l.chain.length - 1], l.width / 2); }
    for (const l of corridor) for (const n of [l.a, l.b]) if (nodeSample.has(n)) seed(nodeSample.get(n), l.width / 2);
    while (frontier.length) {
      const next = [];
      for (const { i, left } of frontier) {
        const a = samples[i];
        for (const [j, d] of nbr[i]) {
          if (!movable(j)) continue;
          const b = samples[j];
          const grade = left > 0 ? LEVEL : GRADE;
          const limited = Math.max(a[field] - grade * d, Math.min(a[field] + grade * d, b[field]));
          if (Math.abs(limited - b[field]) < 1e-4) continue;
          b[field] = limited;
          next.push({ i: j, left: left - d });
        }
      }
      frontier = next;
    }
  };
  easeFromStructures((idx) => samples[idx].ground && !samples[idx].fixed, 'y');

  // Profiles into the links: [y at a, y at each inner point..., y at b]. A street sunk into a cutting becomes KIND 3: on
  // the ground (js/surfaces.js lowers the ground along it), with a point every SAMPLE m so the cut keeps its shape.
  const q10 = (v) => Math.round(v * 10) / 10;
  let cuttings = 0;
  for (const l of structures) {
    l.raw[9] = l.kind;
    l.raw[12] = l.at.map((k) => q10(samples[l.chain[k]].y));
  }
  for (const l of corridor) l.raw[12] = l.pts.map(([x, z]) => q10(deckHeight(sOf(x, z))));
  for (const l of others) {
    if (l.kind) continue;
    const sunk = l.chain.some((idx) => samples[idx].grid - samples[idx].y > 0.05);
    l.raw[9] = 0;
    if (!sunk) {
      l.raw.length = Math.min(l.raw.length, 12);
      continue;
    }
    l.raw[6] = l.chain.slice(1, -1).flatMap((idx) => [q10(samples[idx].x), q10(samples[idx].z)]);
    l.raw[9] = 3;
    l.raw[12] = l.chain.map((idx) => q10(samples[idx].y));
    cuttings++;
  }
  console.log(`[heights] roads: ${structures.length} structure links, ${cuttings} streets sunk into cuttings, ${samples.length} samples, ${short} short of their clearance`);

  // Every other road on the ground gets a shape of its own: its height smoothed along it, with the bumps of the lattice gone but its
  // grade true to the hill, and no more than a little lean across it. The ground then follows the road, not the other way round
  // (tools/tiles/grade-ground.mjs). A road across a hillside would otherwise lean with the hillside, up to 39% on some streets.
  {
    const SMOOTH = 40; // m each way along the road
    const MAX_LEAN = 0.04;
    const LEAN_FADE = 12; // m: down to level by the junction
    const PROFILE_STEP = 10; // m between the heights kept
    const plain = others.filter((l) => !l.kind && l.raw[9] !== 3);
    const isPlain = new Set(plain);
    const at = new Map();
    for (const l of others) {
      if (l.kind && l.raw[9] === 0) continue;
      for (const n of [l.a, l.b]) (at.get(n) || at.set(n, []).get(n)).push(l);
    }
    // The height of each point of each road, all solved together: near the land, smooth along the road, shared at junctions, and level
    // with any road it overlaps. A divided road's two sides are often mapped closer together than they're wide, and on a hillside
    // each would otherwise sit at its own height, a metre or more apart, on the same piece of road.
    {
      const LAND = 0.02, ALONG = 1, OVERLAP = 1, ROUNDS = 300;
      const free = new Set();
      const ownerOf = new Map(); // sample -> { links, half }
      for (const l of plain) {
        for (const idx of l.chain) {
          free.add(idx);
          const o = ownerOf.get(idx);
          if (o) { o.links.push(l); o.half = Math.max(o.half, l.width / 2); } else ownerOf.set(idx, { links: [l], half: l.width / 2 });
        }
      }
      // Pinned where a structure or cutting meets the road, and where a road passes under or over one: they've been solved already
      for (const l of others) if (!isPlain.has(l)) for (const idx of l.chain) free.delete(idx);
      const heldClear = (sg) => {
        if (!isPlain.has(sg.l)) return;
        for (const idx of [sg.i, sg.j]) free.delete(idx);
      };
      for (const { a, b } of pairs) if (!isPlain.has(a.l) || !isPlain.has(b.l)) { heldClear(a); heldClear(b); }
      for (const { a } of fixedPairs) heldClear(a);
      const OCELL = 30;
      const cells = new Map();
      for (const idx of ownerOf.keys()) {
        const q = samples[idx];
        const k = Math.floor(q.x / OCELL) * 100000 + Math.floor(q.z / OCELL);
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(idx);
      }
      const overlaps = new Map();
      for (const idx of free) {
        const q = samples[idx], mine = ownerOf.get(idx);
        const bestOf = new Map(); // nearest point of each other road
        const cx = Math.floor(q.x / OCELL), cz = Math.floor(q.z / OCELL);
        for (let a = -1; a <= 1; a++) {
          for (let c = -1; c <= 1; c++) {
            for (const other of cells.get((cx + a) * 100000 + cz + c) || []) {
              if (other === idx) continue;
              const theirs = ownerOf.get(other);
              if (theirs.links.some((l) => mine.links.includes(l))) continue;
              const o = samples[other], d = Math.hypot(o.x - q.x, o.z - q.z);
              if (d >= (mine.half + theirs.half) * 0.9) continue;
              const road = theirs.links[0];
              const known = bestOf.get(road);
              if (!known || d < known.d) bestOf.set(road, { d, other });
            }
          }
        }
        if (bestOf.size) overlaps.set(idx, [...bestOf.values()].map((b) => b.other));
      }
      const ids = [...free];
      for (const idx of ids) samples[idx].shape = samples[idx].grid;
      for (const q of samples) if (q.shape === undefined) q.shape = q.y;
      for (let round = 0; round < ROUNDS; round++) {
        for (const idx of ids) {
          const q = samples[idx];
          let sum = LAND * q.grid, weight = LAND;
          for (const [j] of nbr[idx]) { sum += ALONG * samples[j].shape; weight += ALONG; }
          for (const j of overlaps.get(idx) || []) { sum += OVERLAP * samples[j].shape; weight += OVERLAP; }
          q.shape = sum / weight;
        }
      }
      easeFromStructures((idx) => free.has(idx), 'shape');
      const moved = ids.map((idx) => Math.abs(samples[idx].shape - samples[idx].grid)).sort((p, q) => p - q);
      console.log(`[heights] road shape: ${overlaps.size} points share a surface with another road; off the land by ${moved[moved.length >> 1].toFixed(2)} m median, ${moved[Math.floor(moved.length * 0.99)].toFixed(2)} m at the 99th percentile`);
    }
    // Roads that simply continue into each other are one run, so nothing kinks where they join
    const continues = (n) => (at.get(n) || []).length === 2 && at.get(n).every((l) => isPlain.has(l));
    const seen = new Set();
    let runs = 0, worstLean = 0;
    for (const start of plain) {
      if (seen.has(start)) continue;
      // Back to where this run begins
      const run = [];
      let l = start, from = start.a;
      const visited = new Set([start]);
      for (;;) {
        if (!continues(from)) break;
        const next = at.get(from).find((o) => o !== l);
        if (!next || visited.has(next)) break;
        visited.add(next);
        from = next.a === from ? next.b : next.a;
        l = next;
      }
      // ...and along it: `from` is where l starts in this run's direction
      for (let n = from, link = l; link && !seen.has(link);) {
        seen.add(link);
        const forward = link.a === n;
        run.push({ link, forward });
        n = forward ? link.b : link.a;
        link = continues(n) ? at.get(n).find((o) => o !== link) : null;
      }
      runs++;
      // Stations along the run
      const st = [];
      let s = 0;
      for (const { link, forward } of run) {
        const chain = forward ? link.chain : [...link.chain].reverse();
        chain.forEach((idx, k) => {
          const q = samples[idx];
          if (k) s += Math.hypot(q.x - samples[chain[k - 1]].x, q.z - samples[chain[k - 1]].z);
          if (!k && st.length) return;
          st.push({ x: q.x, z: q.z, s, shape: q.shape, half: link.width / 2, ux: 0, uz: 0, link });
        });
      }
      for (let i = 0; i < st.length; i++) {
        const a = st[Math.max(0, i - 1)], b = st[Math.min(st.length - 1, i + 1)], L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        st[i].ux = (b.x - a.x) / L;
        st[i].uz = (b.z - a.z) / L;
      }
      const total = s || 1;
      const leanRaw = st.map((q) => (grid(q.x + q.uz * q.half, q.z - q.ux * q.half) - grid(q.x - q.uz * q.half, q.z + q.ux * q.half)) / (2 * q.half));
      const smooth = (values, i) => {
        let sum = 0, weight = 0;
        for (let j = i; j >= 0 && st[i].s - st[j].s < SMOOTH; j--) { const w = 1 - (st[i].s - st[j].s) / SMOOTH; sum += values[j] * w; weight += w; }
        for (let j = i + 1; j < st.length && st[j].s - st[i].s < SMOOTH; j++) { const w = 1 - (st[j].s - st[i].s) / SMOOTH; sum += values[j] * w; weight += w; }
        return sum / weight;
      };
      st.forEach((q, i) => {
        const end = Math.min(q.s, total - q.s);
        q.profile = q.shape;
        q.lean = Math.max(-MAX_LEAN, Math.min(MAX_LEAN, smooth(leanRaw, i))) * Math.min(1, end / LEAN_FADE);
        worstLean = Math.max(worstLean, Math.abs(q.lean));
      });
      // Into each link, its own way round: heights and lean at even steps from its a to its b
      let cursor = 0;
      for (const { link, forward } of run) {
        const length = linkLen(link);
        const startS = cursor;
        const count = Math.max(2, Math.ceil(length / PROFILE_STEP) + 1);
        const heights = [], leans = [];
        let previous = 0;
        for (let k = 0; k < count; k++) {
          const along = (length * k) / (count - 1);
          const target = startS + (forward ? along : length - along);
          let i = 1;
          while (i < st.length - 1 && st[i].s < target) i++;
          const a = st[i - 1], b = st[i] ?? a;
          const t = b.s > a.s ? Math.max(0, Math.min(1, (target - a.s) / (b.s - a.s))) : 0;
          const y = a.profile + (b.profile - a.profile) * t;
          const lean = (a.lean + (b.lean - a.lean) * t) * (forward ? 1 : -1);
          // Whole 5 cm as differences, which pack to almost nothing; lean in 0.1%
          const q = Math.round(y * 20);
          heights.push(q - previous);
          previous = q;
          leans.push(Math.round(lean * 1000));
        }
        link.raw[12] = null;
        link.raw[13] = heights;
        link.raw[14] = leans;
        cursor += length;
      }
    }
    console.log(`[heights] ${plain.length} roads shaped in ${runs} runs, worst lean ${(worstLean * 100).toFixed(1)}%`);
  }

  // Where a ramp or viaduct is low over the ground, the footpaths have to stop at its sides, or they'd be drawn over it. Only
  // roads on the ground cut the kerb islands in tools/build-geodata.mjs, and it can't know this until heights are solved, so
  // it reads this file on its second run. Past LOW_DECK (js/surfaces.js) there's room for the ground to run on underneath.
  const LOW_DECK = 3;
  const lowDecks = [];
  const lowSegment = (ax, az, ay, bx, bz, by, r) => {
    if (Math.min(ay - grid(ax, az), by - grid(bx, bz)) < LOW_DECK) lowDecks.push([ax, az, bx, bz, r].map(q10));
  };
  for (const l of structures) {
    if (l.kind !== 1) continue;
    for (let k = 1; k < l.chain.length; k++) {
      const p = samples[l.chain[k - 1]], q = samples[l.chain[k]];
      lowSegment(p.x, p.z, p.y, q.x, q.z, q.y, l.width / 2 + DECK_SHOULDER);
    }
  }
  // Each of the deck's carriageways, and the whole deck, rail and footway too, along its middle
  for (const l of corridor) {
    for (let k = 1; k < l.pts.length; k++) {
      const [ax, az] = l.pts[k - 1], [bx, bz] = l.pts[k];
      lowSegment(ax, az, deckHeight(sOf(ax, az)), bx, bz, deckHeight(sOf(bx, bz)), l.width / 2 + DECK_SHOULDER);
    }
  }
  {
    const mid = (DECK_WEST + DECK_EAST) / 2, half = (DECK_EAST - DECK_WEST) / 2;
    const shifted = (i) => {
      const p = deckPath[Math.max(0, i - 1)], q = deckPath[Math.min(deckPath.length - 1, i + 1)], L = Math.hypot(q.x - p.x, q.z - p.z) || 1;
      return [deckPath[i].x - ((q.z - p.z) / L) * mid, deckPath[i].z + ((q.x - p.x) / L) * mid];
    };
    for (let i = 1; i < deckPath.length; i++) {
      const [ax, az] = shifted(i - 1), [bx, bz] = shifted(i);
      lowSegment(ax, az, deckHeight(deckPath[i - 1].s), bx, bz, deckHeight(deckPath[i].s), half + 1.4);
    }
  }
  fs.writeFileSync(path.join(ROOT, 'tools/data/generated/low-decks.json'), JSON.stringify(lowDecks));
  console.log(`[heights] ${lowDecks.length} stretches of structure low over the ground`);

  const src = fs.readFileSync(path.join(ROOT, 'tools/data/generated/geodata.js'), 'utf8');
  const head = src.slice(0, src.indexOf('export const GEO = '));
  // A string for JSON.parse, as tools/build-geodata.mjs writes it
  const text = JSON.stringify(GEO).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  fs.writeFileSync(path.join(ROOT, 'tools/data/generated/geodata.js'), `${head}export const GEO = JSON.parse('${text}');\n`);
  console.log('[heights] road profiles written into the generated geodata');
}
