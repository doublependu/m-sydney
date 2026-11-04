// tools/tiles/derive.mjs: what needs the whole map at once, worked out by the game's own code over the tiles just written:
// where each tunnel is open to the sky, the mouths, each building's floor, and which buildings the landmarks replace. And what
// stands under a deck without room for it: a building whose height is a guess is cut down to fit, and a tree is left out.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { GEO } = await import('../../js/geodata.js');
const { blockAt } = await import('../../js/city-config.js');
const { MAX_POINTS, TALL, TALL_POINTS, outlineOf } = await import('../../js/building-outlines.js');
const { buildingLook } = await import('../../js/building-look.js');
const { DECK_DEPTH, KIND, LINKS, deriveTunnels, groundHeight, roomUnderDeck } = await import('../../js/surfaces.js');
const { buildingFloor } = await import('../../js/building-floor.js');
const { polygonBoxOverlaps } = await import('../../js/building-collision.js');
const { landmarkColliders } = await import('../../js/landmarks.js');
const GENERATED = fileURLToPath(new URL('../data/generated/', import.meta.url));
const { REAL_BUILDINGS } = await import(path.join(GENERATED, 'building-geodata.js'));
const { REAL_TREES, TREE_HEIGHTS } = await import(path.join(GENERATED, 'tree-geodata.js'));

const { tunnels, portals } = deriveTunnels();

// The Harbour Bridge's deck and span, whichever tiles are held (js/bridge.js)
const { BRIDGE_LENGTH, BRIDGE_SPAN, DECK_STEP, deckHeight } = await import('../../js/bridge.js');
const deckProfile = [];
for (let s = 0; s <= BRIDGE_LENGTH + DECK_STEP; s += DECK_STEP) deckProfile.push(Math.round(deckHeight(s) * 100) / 100);

const boxes = landmarkColliders();
const underLandmarks = [];
REAL_BUILDINGS.forEach((b, i) => {
  if (boxes.some((c) => b.minX < c.maxX && b.maxX > c.minX && b.minZ < c.maxZ && b.maxZ > c.minZ
    && b.polygons.some((p) => polygonBoxOverlaps(p, (c.minX + c.maxX) / 2, (c.minZ + c.maxZ) / 2, (c.maxX - c.minX) / 2, (c.maxZ - c.minZ) / 2)))) underLandmarks.push(i);
});

// Floors in 0.1 m. The pieces of a building share one, over all of them
const skip = new Set(underLandmarks);
const wholes = new Map();
REAL_BUILDINGS.forEach((b, i) => {
  if (b.group && !skip.has(i)) (wholes.get(b.group) || wholes.set(b.group, []).get(b.group)).push(...b.polygons);
});
const groupFloor = new Map();
const floors = {};
REAL_BUILDINGS.forEach((b, i) => {
  if (skip.has(i)) return;
  let f;
  if (b.group) {
    f = groupFloor.get(b.group);
    if (!f) groupFloor.set(b.group, (f = buildingFloor(wholes.get(b.group), groundHeight)));
  } else f = buildingFloor(b.polygons, groundHeight);
  // Up, never down: a floor stays above the ground it was worked out for
  floors[i] = [Math.ceil(f.floor * 10), Math.floor(f.low * 10)];
});
// --- Under decks ---------------------------------------------------------------------------------------------------------
// Where a deck passes over, what's under it has to fit. Decks are indexed by 50 m cell, so only what's near one is looked at.
const DECK_CELL = 50;
const deckCells = new Set();
for (const l of LINKS) {
  if (l.kind !== KIND.BRIDGE) continue;
  for (let i = 1; i < l.pts.length; i++) {
    const a = l.pts[i - 1], b = l.pts[i], pad = l.half + 2;
    for (let x = Math.floor((Math.min(a.x, b.x) - pad) / DECK_CELL); x <= Math.floor((Math.max(a.x, b.x) + pad) / DECK_CELL); x++) {
      for (let z = Math.floor((Math.min(a.z, b.z) - pad) / DECK_CELL); z <= Math.floor((Math.max(a.z, b.z) + pad) / DECK_CELL); z++) deckCells.add(x * 100000 + z);
    }
  }
}
const nearDeck = (minX, minZ, maxX, maxZ) => {
  for (let x = Math.floor(minX / DECK_CELL); x <= Math.floor(maxX / DECK_CELL); x++) {
    for (let z = Math.floor(minZ / DECK_CELL); z <= Math.floor(maxZ / DECK_CELL); z++) if (deckCells.has(x * 100000 + z)) return true;
  }
  return false;
};
const inRing = (ring, x, z) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) c = !c;
  }
  return c;
};
// Buildings: the lowest underside of a deck over any part of the outline, every 2 m. A guessed height is cut to leave a metre under
// it, and a building with less than 2.5 m left goes. One with a measured height is listed, not changed: the deck may be wrong.
const caps = {}, dropped = [], tooTall = [];
REAL_BUILDINGS.forEach((b, i) => {
  if (skip.has(i) || (b.bottom || 0) > 0 || !nearDeck(b.minX, b.minZ, b.maxX, b.maxZ)) return;
  const floor = floors[i][0] / 10;
  let underside = Infinity;
  for (let x = b.minX + 1; x < b.maxX; x += 2) {
    for (let z = b.minZ + 1; z < b.maxZ; z += 2) {
      if (!b.polygons.some((p) => inRing(p.outer, x, z) && !p.holes.some((h) => inRing(h, x, z)))) continue;
      const room = roomUnderDeck(x, z);
      if (room < Infinity) underside = Math.min(underside, groundHeight(x, z) + room);
    }
  }
  if (underside === Infinity || floor + b.height <= underside) return;
  if (!b.guess) { tooTall.push(`${Math.round(b.cx)},${Math.round(b.cz)} ${b.height} m by ${(floor + b.height - underside).toFixed(1)} m`); return; }
  const fits = Math.floor(underside - 1 - floor);
  if (fits < 2.5) dropped.push(i);
  else caps[i] = fits;
});
for (const [i, h] of Object.entries(caps)) REAL_BUILDINGS[i].height = h;
for (const i of dropped) skip.add(i);
console.log(`[derive] under decks: ${Object.keys(caps).length} buildings cut to fit, ${dropped.length} left out, ${tooTall.length} with a measured height in the way${tooTall.length ? `: ${tooTall.slice(0, 8).join('; ')}` : ''}`);
// Trees: one taller than the room under a deck is left out. A tree with no height on record counts as 8 m.
const treesUnder = [];
for (let i = 0; i < TREE_HEIGHTS.length; i++) {
  const x = REAL_TREES[i * 2], z = REAL_TREES[i * 2 + 1];
  if (!nearDeck(x - 3, z - 3, x + 3, z + 3)) continue;
  if (roomUnderDeck(x, z, 2) < (TREE_HEIGHTS[i] || 8)) treesUnder.push(i);
}
console.log(`[derive] ${treesUnder.length} trees left out from under decks`);
void DECK_DEPTH;

// What each building looks like from far away: which facade, which roof, and its outline in 0.5 m
const looks = {};
{
  const whole = new Map();
  for (const b of REAL_BUILDINGS) {
    if (!b.group) continue;
    const w = whole.get(b.group);
    if (!w) whole.set(b.group, { cx: b.cx, cz: b.cz, height: b.height });
    else {
      w.height = Math.max(w.height, b.height);
      if (!b.bottom) { w.cx = b.cx; w.cz = b.cz; }
    }
  }
  REAL_BUILDINGS.forEach((b, i) => {
    if (skip.has(i)) return;
    const { mat, roof } = buildingLook(b, b.group ? whole.get(b.group) : b);
    const points = b.height >= TALL ? TALL_POINTS : MAX_POINTS;
    const rings = b.polygons.map((p) => outlineOf(p.outer, points).flatMap((q) => [Math.round(q.x * 2), Math.round(q.z * 2)]));
    looks[i] = [mat, roof, rings];
  });
}

// How green each 100 m of the far ground is, as a string of digits for each 4 km square
const farParks = {};
{
  const box = GEO.farFile;
  const seen = new Set(Object.keys(GEO.tiles).map((k) => { const [x, z] = k.split('_').map(Number); return `${Math.floor((x * 1000) / box)}_${Math.floor((z * 1000) / box)}`; }));
  for (const key of seen) {
    const [fx, fz] = key.split('_').map(Number);
    let text = '';
    for (let j = 0; j < 40; j++) {
      for (let i = 0; i < 40; i++) {
        let green = 0;
        for (let a = 0; a < 4; a++) {
          for (let c = 0; c < 4; c++) {
            const block = blockAt(fx * box + (i + (a + 0.5) / 4) * 100, fz * box + (j + (c + 0.5) / 4) * 100);
            if (block && block.park > 0.6) green++;
          }
        }
        text += Math.round((green / 16) * 9);
      }
    }
    farParks[key] = text;
  }
}

const round = (v) => Math.round(v * 1000) / 1000;
fs.writeFileSync(process.argv[2], JSON.stringify({
  tunnels, portals, floors, underLandmarks, looks, farParks, deckProfile, bridgeSpan: BRIDGE_SPAN, caps, dropped, treesUnder,
  landmarkBoxes: boxes.map((c) => ({ minX: round(c.minX), maxX: round(c.maxX), minZ: round(c.minZ), maxZ: round(c.maxZ), maxY: round(c.maxY ?? 1e4) }))
}));
