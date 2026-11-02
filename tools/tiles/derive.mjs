// tools/tiles/derive.mjs: what needs the whole map at once, worked out by the game's own code over the tiles just written:
// where each tunnel is open to the sky, the mouths, each building's floor, and which buildings the landmarks replace.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { GEO } = await import('../../js/geodata.js');
const { blockAt } = await import('../../js/city-config.js');
const { MAX_POINTS, TALL, TALL_POINTS, outlineOf } = await import('../../js/building-outlines.js');
const { buildingLook } = await import('../../js/building-look.js');
const { deriveTunnels, groundHeight } = await import('../../js/surfaces.js');
const { buildingFloor } = await import('../../js/building-floor.js');
const { polygonBoxOverlaps } = await import('../../js/building-collision.js');
const { landmarkColliders } = await import('../../js/landmarks.js');
const { REAL_BUILDINGS } = await import(path.join(fileURLToPath(new URL('../data/generated/', import.meta.url)), 'building-geodata.js'));

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
  tunnels, portals, floors, underLandmarks, looks, farParks, deckProfile, bridgeSpan: BRIDGE_SPAN,
  landmarkBoxes: boxes.map((c) => ({ minX: round(c.minX), maxX: round(c.maxX), minZ: round(c.minZ), maxZ: round(c.maxZ), maxY: round(c.maxY ?? 1e4) }))
}));
