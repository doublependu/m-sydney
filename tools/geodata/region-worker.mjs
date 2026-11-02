// One region of the map's rasters at a time: its land, then its kerb islands, lawns and pavements. tools/build-geodata.mjs sends the jobs.
import { parentPort, workerData } from 'node:worker_threads';
import { BitRaster, DETAIL_RECTS, Raster, flat, rdpRing, ringArea, tiledPolygons } from '../geo-common.mjs';
import { MARGIN } from './regions.mjs';

const RES = 1;
const ISLAND_EPS = 0.5; // m a kerb island's outline may stray when simplified
const FOOTPATH = 3.5; // m back from the road that's paved, outside the area below
const PAVED_AREA = { x0: -2100, x1: 2700, z0: -4500, z1: 2100 }; // the CBD and the streets around it are paved right through
const LAND_MASS = 4000; // m²: smaller scraps of land are dropped, unless the region's edge cuts them off

const { landFrame, landBuffer, water } = workerData;
const landBits = new BitRaster(landFrame.x0, landFrame.z0, landFrame.x1, landFrame.z1, RES, landBuffer);
const rasterOf = (w, Type) => new Raster(w.x0, w.z0, w.x1, w.z1, RES, Type);
const touchesEdge = (c, r) => c.i0 === 0 || c.j0 === 0 || c.i1 === r.w - 1 || c.j1 === r.h - 1;

function landJob({ core, window }) {
  const land = rasterOf(window);
  for (const r of DETAIL_RECTS) {
    for (let j = 0; j < land.h; j++) {
      const z = land.z0 + (j + 0.5) * RES;
      if (z < r.z0 || z > r.z1) continue;
      for (let i = 0; i < land.w; i++) {
        const x = land.x0 + (i + 0.5) * RES;
        if (x >= r.x0 && x <= r.x1) land.d[j * land.w + i] = 1;
      }
    }
  }
  {
    const wet = rasterOf(window);
    wet.fillRing(water.sea, 1);
    for (const r of water.islands) wet.fillRing(r, 0);
    for (const r of water.harbourOuter) wet.fillRing(r, 1);
    for (const r of water.harbourInner) wet.fillRing(r, 0);
    for (const { outer, inner } of water.rivers) {
      for (const r of outer) wet.fillRing(r, 1);
      for (const r of inner) wet.fillRing(r, 0);
    }
    for (let i = 0; i < land.d.length; i++) if (wet.d[i]) land.d[i] = 0;
  }
  for (const { ring, closed, width } of water.piers) {
    if (closed) land.fillRing(ring, 1);
    else for (let i = 0; i + 1 < ring.length; i++) land.stampSegment(...ring[i], ...ring[i + 1], width / 2, 1);
  }
  land.open(1.2);
  const { labels, comps } = land.label();
  for (let i = 0; i < land.d.length; i++) {
    const c = comps[labels[i] - 1];
    if (!c || (c.n < LAND_MASS && !touchesEdge(c, land))) land.d[i] = 0;
  }
  landBits.setFrom(land, core);
  // The outlines of what's in this region
  const own = rasterOf(core);
  const oi = Math.round((core.x0 - land.x0) / RES), oj = Math.round((core.z0 - land.z0) / RES);
  let cells = 0;
  for (let j = 0; j < own.h - 1; j++) {
    for (let i = 0; i < own.w - 1; i++) {
      if (land.d[(j + oj) * land.w + i + oi]) { own.d[j * own.w + i] = 1; cells++; }
    }
  }
  const pieces = own.label();
  const shores = [];
  for (const c of pieces.comps) {
    if (c.n < 16) continue;
    const rings = own.traceRings(pieces.labels, c).map((r) => rdpRing(r, 1.2)).filter((r) => r.length >= 3);
    rings.sort((p, q) => Math.abs(ringArea(q)) - Math.abs(ringArea(p)));
    shores.push(rings.map(flat));
  }
  return { cells, shores };
}

function blocksJob({ core, window, capsules, parks }) {
  const curb = landBits.window(window);
  for (let k = 0; k < capsules.length; k += 5) curb.stampSegment(capsules[k], capsules[k + 1], capsules[k + 2], capsules[k + 3], capsules[k + 4]);
  const { labels, comps } = curb.label();
  const parkRaster = rasterOf(window, Uint16Array);
  parks.forEach((p, i) => parkRaster.fillRing(p.ring, i + 1));
  const inCore = (x, z) => x >= core.x0 && x < core.x1 && z >= core.z0 && z < core.z1;

  // `raster` and its labels may be a part of the window, starting (oi, oj) into it
  const blockOf = (raster, rasterLabels, c, oi = 0, oj = 0) => {
    const rings = raster.traceRings(rasterLabels, c).map((r) => rdpRing(r, ISLAND_EPS)).filter((r) => r.length >= 3);
    if (!rings.length) return null;
    rings.sort((p, q) => Math.abs(ringArea(q)) - Math.abs(ringArea(p)));
    const [outer, ...rest] = rings;
    const holes = rest.filter((r) => Math.abs(ringArea(r)) > 16);
    let inPark = 0;
    const hits = new Map();
    for (let j = c.j0; j <= c.j1; j++) {
      for (let i = c.i0; i <= c.i1; i++) {
        if (rasterLabels[j * raster.w + i] !== c.id) continue;
        const p = parkRaster.d[(j + oj) * parkRaster.w + i + oi];
        if (p) { inPark++; hits.set(p, (hits.get(p) || 0) + 1); }
      }
    }
    const top = [...hits].sort((p, q) => q[1] - p[1]).find(([p]) => parks[p - 1].name) || [0];
    return [flat(outer), holes.map(flat), Math.round((inPark / c.n) * 100) / 100, top[0] ? parks[top[0] - 1].name : ''];
  };

  const blocks = [], fills = [];
  const cutOff = new Set();
  for (const c of comps) {
    // As big as the margin, by what can be seen of it: every region it reaches agrees on that, and has its own part of it. Going by whether
    // it reaches this window's edge wouldn't do, since one region can see the whole of what its neighbour sees cut off.
    if ((c.i1 - c.i0 + 1) * RES >= MARGIN || (c.j1 - c.j0 + 1) * RES >= MARGIN) {
      if (c.n >= 24) cutOff.add(c.id);
      continue;
    }
    if (touchesEdge(c, curb)) continue;
    // Seen whole, here and by any region that also sees it: whichever has its corner has it
    if (!inCore(curb.x0 + c.i0 * RES, curb.z0 + c.j0 * RES)) continue;
    if (c.n >= 24) {
      const block = blockOf(curb, labels, c);
      if (block) blocks.push(block);
    } else {
      const ring = curb.traceRings(labels, c).sort((p, q) => Math.abs(ringArea(q)) - Math.abs(ringArea(p)))[0];
      if (ring && ring.length >= 3) fills.push(flat(ring));
    }
  }
  // Bigger than the margin, like a national park: this region has the part of it in its own square
  let cutPieces = 0;
  if (cutOff.size) {
    const part = rasterOf(core);
    const oi = Math.round((core.x0 - curb.x0) / RES), oj = Math.round((core.z0 - curb.z0) / RES);
    for (let j = 0; j < part.h - 1; j++) {
      for (let i = 0; i < part.w - 1; i++) {
        if (cutOff.has(labels[(j + oj) * curb.w + i + oi])) part.d[j * part.w + i] = 1;
      }
    }
    const pieces = part.label();
    for (const c of pieces.comps) {
      if (c.n < 24) continue;
      const block = blockOf(part, pieces.labels, c, oi, oj);
      if (block) { blocks.push(block); cutPieces++; }
    }
  }

  // Lawn wherever parkland lies on a curb island, whichever block it shares. Past the CBD and the streets around it, only the footpath is
  // paved, and further back from the road it's yards.
  const lawn = rasterOf(window);
  for (let i = 0; i < lawn.d.length; i++) lawn.d[i] = parkRaster.d[i] && curb.d[i] ? 1 : 0;
  {
    const toRoad = curb.edt((v) => v === 0);
    for (let j = 0; j < curb.h; j++) {
      const z = curb.z0 + (j + 0.5) * RES;
      const inPavedRows = z >= PAVED_AREA.z0 && z <= PAVED_AREA.z1;
      for (let i = 0; i < curb.w; i++) {
        const k = j * curb.w + i;
        if (!curb.d[k] || toRoad[k] <= (FOOTPATH / RES) ** 2) continue;
        const x = curb.x0 + (i + 0.5) * RES;
        if (inPavedRows && x >= PAVED_AREA.x0 && x <= PAVED_AREA.x1) continue;
        lawn.d[k] = 1;
      }
    }
  }
  lawn.open(1.5);
  const lawns = tiledPolygons(lawn, 240, 1, 40, 12, core).map((rings) => rings.map(flat));

  // Paving is the rest of each curb island. It runs a metre under the lawn's edge, so the two can't part where they meet.
  const paved = rasterOf(window);
  {
    const toEdge = lawn.edt((v) => v === 0);
    for (let i = 0; i < paved.d.length; i++) paved.d[i] = curb.d[i] && toEdge[i] <= 2.5 && comps[labels[i] - 1]?.n >= 24 ? 1 : 0;
  }
  const pavements = tiledPolygons(paved, 240, ISLAND_EPS, undefined, undefined, core).map((rings) => rings.map(flat));
  return { blocks, fills, lawns, pavements, cutPieces };
}

parentPort.on('message', (job) => parentPort.postMessage(job.kind === 'land' ? landJob(job) : blocksJob(job)));
