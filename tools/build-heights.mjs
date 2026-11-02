// tools/build-heights.mjs: writes js/height-grid.bin.gz, the ground height of the play area and the land around it, from
// surveyed contours: City of Sydney's 1 m contours, then the NSW 2 m contours for everything north of the harbour and
// beyond the City's boundary. Global DEMs are no use here: they smear the CBD's towers into the ground.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { GRID, Raster, load, toWorld } from './geo-common.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const { x0, z0, x1, z1, cell } = GRID;
const w = Math.round((x1 - x0) / cell) + 1, h = Math.round((z1 - z0) / cell) + 1;

// Contour samples in a coarse hash; each grid point is the inverse-distance mean of the nearest ones
const BUCKET = 40;
const buckets = new Map();
const put = (x, z, y, fine) => {
  const k = Math.floor(x / BUCKET) * 100000 + Math.floor(z / BUCKET);
  let b = buckets.get(k);
  if (!b) buckets.set(k, (b = []));
  b.push(x, z, y, fine ? 1 : 0);
};
function addLines(features, heightOf, fine, step) {
  for (const f of features) {
    const y = heightOf(f.properties);
    const g = f.geometry;
    if (!g || !Number.isFinite(y) || y < -3) continue;
    for (const line of g.type === 'LineString' ? [g.coordinates] : g.coordinates) {
      const pts = line.map(([lon, lat]) => toWorld(lon, lat));
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
        if (Math.max(ax, bx) < x0 - 200 || Math.min(ax, bx) > x1 + 200 || Math.max(az, bz) < z0 - 200 || Math.min(az, bz) > z1 + 200) continue;
        const n = Math.max(1, Math.floor(Math.hypot(bx - ax, bz - az) / step));
        for (let k = 0; k < n; k++) put(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n, y, fine);
      }
    }
  }
}
addLines(load('cos_contours.json'), (p) => p.Contour, true, 10);
addLines(load('nsw_contours.json'), (p) => p.elevation, false, 14);
console.log('[heights] contour buckets', buckets.size);

// Water pulls the height to sea level at the shore
const { GEO } = await import('./data/generated/geodata.js');
const land = new Raster(x0, z0, x1, z1, cell);
for (const rings of GEO.surroundings) rings.forEach((flat, i) => { const ring = []; for (let k = 0; k < flat.length; k += 2) ring.push([flat[k], flat[k + 1]]); land.fillRing(ring, i ? 0 : 1); });
for (const rings of GEO.shores) rings.forEach((flat, i) => { const ring = []; for (let k = 0; k < flat.length; k += 2) ring.push([flat[k], flat[k + 1]]); land.fillRing(ring, i ? 0 : 1); });

const raw = new Float32Array(w * h);
const missing = [];
for (let j = 0; j < h; j++) {
  for (let i = 0; i < w; i++) {
    const x = x0 + i * cell, z = z0 + j * cell;
    let sw = 0, sy = 0, near = Infinity, fineNear = false;
    const reach = 160;
    for (let a = Math.floor((x - reach) / BUCKET); a <= Math.floor((x + reach) / BUCKET); a++) {
      for (let b = Math.floor((z - reach) / BUCKET); b <= Math.floor((z + reach) / BUCKET); b++) {
        const list = buckets.get(a * 100000 + b);
        if (!list) continue;
        for (let k = 0; k < list.length; k += 4) {
          const d2 = (list[k] - x) ** 2 + (list[k + 1] - z) ** 2;
          if (d2 > reach * reach) continue;
          const weight = (list[k + 3] ? 3 : 1) / (d2 * d2 + 16);
          sw += weight;
          sy += weight * list[k + 2];
          if (d2 < near) near = d2;
          if (list[k + 3] && d2 < 3600) fineNear = true;
        }
      }
    }
    void fineNear;
    if (sw > 0) raw[j * w + i] = sy / sw;
    else missing.push(j * w + i);
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
  const DECK_WIDTH = 25; // m between its barriers (js/bridge.js)
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
    const [px, pz] = pointAt(sOf(x, z));
    return Math.hypot(px - x, pz - z) < DECK_WIDTH / 2;
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

  const src = fs.readFileSync(path.join(ROOT, 'tools/data/generated/geodata.js'), 'utf8');
  const head = src.slice(0, src.indexOf('export const GEO = '));
  // A string for JSON.parse, as tools/build-geodata.mjs writes it
  const text = JSON.stringify(GEO).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  fs.writeFileSync(path.join(ROOT, 'tools/data/generated/geodata.js'), `${head}export const GEO = JSON.parse('${text}');\n`);
  console.log('[heights] road profiles written into the generated geodata');
}
