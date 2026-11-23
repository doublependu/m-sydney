// tools/build-ponds.mjs: still water outside the gardens, drawn at a level of its own (js/garden.js): the lakes and ponds the sea's rule
// (tools/sea-water.mjs) leaves out of the sea, which tools/build-geodata.mjs makes land, and the still water the ponds' rule picks of what
// the sea's never reads (pondWaters(): lakes, dams and golf courses' hazards; not dry basins, tanks or wastewater), on the land already.
// Writes tools/data/generated/ponds.json; tools/build-tiles.mjs puts each piece in its tile (`lakes`), and tools/build-trees.mjs plants no
// tree in them. tools/build-garden.mjs lays a park by rule's paths and raised lawn round them.
//   node --max-old-space-size=8000 tools/build-ponds.mjs [--also=way/1,relation/2,...] [--out=file]
// Each is cut to the curb islands' ground (the lawns and paving tools/build-geodata.mjs made, on the land): never on a road. Pieces are
// cut to the lawns' 240 m squares, so each lies on a square's lawn, cheap to lay on its triangles, and built only near the player. Waters
// that meet are one pond, at one level. The sea's rule's still water: the lowest of the surveyed ground (the height grid,
// tools/build-heights.mjs) round its edge, where it would spill, so the water lies flat over a hollow and never stands over its bank. The
// ponds' rule's (`graded`): where most of its water lies in NSW's 5 m elevation model, which has a lake flat at its height where the 20 m
// grid has its banks across it and its valley past a dam, and cut back off the ground the model has over that (a dune or a bank its outline
// takes in); or, where the model hasn't it lying flat (`untrusted`: on a slope, under trees or reeds), the lowest ground round its edge.
// tools/tiles/pond-grade.mjs grades the ground under and round it to its level, so its water lies flat and meets the bank.
// A still water the last build's land still has as the sea (land.bin: a build from before the rule) is left out: there's no ground there
// to lay it on. --also draws more still water than the rule's, under lawn in the last build, for trying the drawing out.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { BitRaster, elementRings, flat, fromWorld, load, ringArea } from './geo-common.mjs';
import { heightSampler } from './fetch-elevation.mjs';
import { gardenAreas, inGardenArea } from './garden-areas.mjs';
import { localWater } from './local-edits.mjs';
import { SQUARE, cutPond } from './pond-pieces.mjs';
import { pondWaters, seaWaters, shoreLines } from './sea-water.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GENERATED = path.join(ROOT, 'tools/data/generated');
const OUT = process.argv.find((a) => a.startsWith('--out='))?.slice(6) || path.join(GENERATED, 'ponds.json');
const ALSO = new Set(process.argv.find((a) => a.startsWith('--also='))?.slice(7).split(',').filter(Boolean) || []);
const log = (...args) => console.log('[ponds]', ...args);
const started = Date.now();

const MEET = 2; // m: waters this close are one pond

globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { GEO } = await import(path.join(GENERATED, 'geodata.js'));
const landBits = BitRaster.load(path.join(GENERATED, 'land.bin'));

// --- Which waters: the rule's still water, as tools/build-geodata.mjs reads it --------------------------------------------------
const osmLand = load('land.json').elements;
const dem = heightSampler(5);
const gardens = gardenAreas(osmLand);
const inGarden = (ring) => inGardenArea(gardens, ring.reduce((t, p) => t + p[0], 0) / ring.length, ring.reduce((t, p) => t + p[1], 0) / ring.length);
const edits = localWater();
const seaRule = seaWaters(osmLand, { heightAt: (x, z) => dem(...fromWorld(x, z)), inGarden, shore: shoreLines(), edits });
const waters = pondWaters(osmLand, { seaRule, inGarden, edits }).map((c) => ({ key: c.key, name: c.e.tags?.name || null, outer: c.outer, inner: c.inner, why: c.why }));
const byWhy = waters.reduce((m, w) => (m[w.why] = (m[w.why] || 0) + 1, m), {});
log(`still water: ${Object.entries(byWhy).map(([why, n]) => `${n} ${why}`).join(', ')}`);
for (const key of ALSO) {
  if (waters.some((w) => w.key === key)) continue;
  const [type, id] = key.split('/');
  const e = osmLand.find((el) => el.type === type && el.id === Number(id));
  if (!e || e.tags?.natural !== 'water') throw new Error(`--also: ${key} isn't water in OSM's land`);
  const { outer, inner } = elementRings(e);
  waters.push({ key, name: e.tags?.name || null, outer: outer.filter((r) => r.length > 3), inner, also: true });
}

// --- The height grid, as the tiles have it (js/terrain.js rawTerrainHeight()): 20 m cells in 0.25 m steps -------------------------
const H = GEO.frame.heights;
const grid = new Float32Array(H.w * H.h);
{
  const data = zlib.gunzipSync(fs.readFileSync(path.join(GENERATED, 'height-grid.bin.gz')));
  let cursor = 0;
  for (let j = 0; j < H.h; j++) {
    let v = 0;
    for (let i = 0; i < H.w; i++) {
      let z = 0, shift = 0, byte;
      do { byte = data[cursor++]; z |= (byte & 127) << shift; shift += 7; } while (byte & 128);
      v += (z >>> 1) ^ -(z & 1);
      grid[j * H.w + i] = v * 0.25;
    }
  }
}
function terrainAt(x, z) {
  const fx = Math.max(0, Math.min(H.w - 1.001, (x - H.x0) / H.cell)), fz = Math.max(0, Math.min(H.h - 1.001, (z - H.z0) / H.cell));
  const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, k = j * H.w + i;
  const a = grid[k] + (grid[k + 1] - grid[k]) * tx, b = grid[k + H.w] + (grid[k + H.w + 1] - grid[k + H.w]) * tx;
  return a + (b - a) * tz;
}

// --- The curb islands' ground, by 240 m square: each lawn and pavement piece is a square's or less ---------------------------------
const groundBySquare = new Map();
for (const list of [GEO.lawns, GEO.pavements]) {
  for (const rings of list) {
    const outer = rings[0];
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < outer.length; k += 2) {
      x0 = Math.min(x0, outer[k]); x1 = Math.max(x1, outer[k]); z0 = Math.min(z0, outer[k + 1]); z1 = Math.max(z1, outer[k + 1]);
    }
    for (let ix = Math.floor(x0 / SQUARE); ix <= Math.floor(x1 / SQUARE); ix++) {
      for (let iz = Math.floor(z0 / SQUARE); iz <= Math.floor(z1 / SQUARE); iz++) {
        const key = ix * 100000 + iz;
        (groundBySquare.get(key) || groundBySquare.set(key, []).get(key)).push(rings);
      }
    }
  }
}
// --- Waters that meet are one pond -----------------------------------------------------------------------------------------------
const boxOf = (rings) => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const r of rings) for (const [x, z] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  return { x0, x1, z0, z1 };
};
const segDist = (x, z, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
  return Math.hypot(ax + dx * t - x, az + dz * t - z);
};
const meets = (a, b) => {
  if (a.box.x0 > b.box.x1 + MEET || b.box.x0 > a.box.x1 + MEET || a.box.z0 > b.box.z1 + MEET || b.box.z0 > a.box.z1 + MEET) return false;
  return a.outer.some((r) => r.some(([x, z]) => b.outer.some((s) => s.some((q, i) => i && segDist(x, z, ...s[i - 1], ...q) < MEET))));
};
for (const w of waters) w.box = boxOf(w.outer);
const up = waters.map((_, i) => i);
const root = (i) => { while (up[i] !== i) i = up[i] = up[up[i]]; return i; };
for (let i = 0; i < waters.length; i++) for (let j = i + 1; j < waters.length; j++) if (meets(waters[i], waters[j])) up[root(j)] = root(i);
const groups = new Map();
for (let i = 0; i < waters.length; i++) (groups.get(root(i)) || groups.set(root(i), []).get(root(i))).push(waters[i]);

// --- Each pond: its water where the ground is, in 240 m squares, and its level ---------------------------------------------------
const pieces = [];
const ponds = [];
let leftOut = 0;
const pairsOf = (f) => {
  const out = [];
  for (let k = 0; k < f.length; k += 2) out.push([f[k], f[k + 1]]);
  return out;
};
const groundIn = (box) => {
  const out = new Set();
  for (let ix = box.x0 / SQUARE; ix < box.x1 / SQUARE; ix++) for (let iz = box.z0 / SQUARE; iz < box.z1 / SQUARE; iz++) for (const rings of groundBySquare.get(ix * 100000 + iz) || []) out.add(rings);
  return [...out].map((rings) => rings.map(pairsOf));
};
const landIn = (box) => landBits.window({ x0: box.x0, z0: box.z0, x1: box.x1 - 1, z1: box.z1 - 1 });
for (const group of groups.values()) {
  const b = group.map((w) => w.box).reduce((p, q) => ({ x0: Math.min(p.x0, q.x0), x1: Math.max(p.x1, q.x1), z0: Math.min(p.z0, q.z0), z1: Math.max(p.z1, q.z1) }));
  const record = { keys: group.map((w) => w.key), name: group.map((w) => w.name).filter(Boolean).join(', ') || null, box: [b.x0, b.z0, b.x1, b.z1].map(Math.round),
    area: Math.round(group.reduce((t, w) => t + w.outer.reduce((s, r) => s + Math.abs(ringArea(r)), 0) - w.inner.reduce((s, r) => s + Math.abs(ringArea(r)), 0), 0)),
    ...(group.some((w) => w.also) && { also: true }) };
  ponds.push(record);
  const graded = !group.some((w) => w.also || w.why === 'out of the sea');
  const cut = cutPond(group, { groundIn, landIn, terrainAt, ...(graded && { surveyAt: (x, z) => dem(...fromWorld(x, z)) }) });
  if (cut.sea) {
    record.sea = true;
    leftOut++;
    continue;
  }
  const steps = cut.steps ?? [];
  if (!cut.pieces.length && !steps.length) {
    record.none = true;
    continue;
  }
  record.level = Math.round(cut.level * 100) / 100;
  const all = [...cut.pieces.map((rings) => [record.level, rings]), ...steps.flatMap((step) => step.pieces.map((rings) => [step.level, rings]))];
  record.pieces = all.length;
  record.drawn = Math.round(all.reduce((t, [, rings]) => t + rings.reduce((s, r, k) => s + (k ? -1 : 1) * Math.abs(ringArea(r)), 0), 0));
  if (graded) {
    Object.assign(record, { graded: true, first: pieces.length, survey: cut.survey, clipped: Math.round(cut.clipped), ...(cut.untrusted && { untrusted: true }) });
    if (steps.length) record.steps = steps.map((step) => step.level);
  }
  for (const [level, rings] of all) pieces.push([level, ...rings.map(flat)]);
}
const drawn = ponds.filter((p) => p.pieces);
log(`${waters.length} still waters (${waters.filter((w) => w.also).length} more asked for) in ${ponds.length} ponds: ${drawn.length} drawn in ${pieces.length} pieces, ${(drawn.reduce((t, p) => t + p.drawn, 0) / 1e4).toFixed(1)} ha;`
  + ` ${leftOut} on the last build's water (land.bin: the sea's rule's, which tools/build-geodata.mjs takes out of it, or water the sea's outline has)${ponds.some((p) => p.none) ? `; ${ponds.filter((p) => p.none).length} on no ground` : ''}`);
const gradedPonds = drawn.filter((p) => p.graded);
log(`${gradedPonds.length} graded to their level (the 5 m survey's water): ${(gradedPonds.reduce((t, p) => t + p.drawn, 0) / 1e4).toFixed(1)} ha drawn,`
  + ` ${(gradedPonds.reduce((t, p) => t + p.clipped, 0) / 1e4).toFixed(1)} ha cut back off the ground over it; ${gradedPonds.filter((p) => p.steps).length}`
  + ` with water a step up, at a level of its own; ${gradedPonds.filter((p) => p.untrusted).length} (${(gradedPonds.filter((p) => p.untrusted).reduce((t, p) => t + p.drawn, 0) / 1e4).toFixed(1)} ha)`
  + ' not flat in the survey, at the lowest ground round their edges');
fs.writeFileSync(OUT, JSON.stringify({ pieces, ponds }));
log(`wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
