import { ROAD_CLASS, linkById } from './surfaces.js';

// The street a house faces: the nearest street on the ground to its middle. A street is what js/arrivals.js footpathFrom() walks out to
// from a door: any road on the ground, named or not, but not in a tunnel, on a deck or a motorway, and never a service lane (OSM's
// `service`: driveways and the lanes behind a row of houses). Only the tile's own roads are asked, which are every road within about
// 40 m of it (tools/build-tiles.mjs), so a house faces the same way whichever tiles round it happen to be held.

const REACH = 60; // m: no street nearer than this, and a house has none (in the bush, say)
const CELL = 32; // m

const isStreet = (link) => !link.kind && !link.deck && !link.motorway && link.cls !== ROAD_CLASS.service;

/** The streets among `links` (js/surfaces.js LINKS), in cells, for streetFront() */
function streetIndex(links) {
  const cells = new Map();
  for (const link of links) {
    if (!link || !isStreet(link)) continue;
    for (let i = 1; i < link.pts.length; i++) {
      const p = link.pts[i - 1], q = link.pts[i];
      const L = Math.hypot(q.x - p.x, q.z - p.z);
      if (L < 0.01) continue;
      const seg = { link, x: p.x, z: p.z, ux: (q.x - p.x) / L, uz: (q.z - p.z) / L, L };
      for (let ix = Math.floor(Math.min(p.x, q.x) / CELL); ix <= Math.floor(Math.max(p.x, q.x) / CELL); ix++) {
        for (let iz = Math.floor(Math.min(p.z, q.z) / CELL); iz <= Math.floor(Math.max(p.z, q.z) / CELL); iz++) {
          const key = ix * 100000 + iz;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(seg);
        }
      }
    }
  }
  return cells;
}

/** The nearest point of a street in `index` to (x, z), within `limit`: { x, z, d, link }, or null */
function streetFront(index, x, z, limit = REACH) {
  let best = null;
  const r = Math.ceil(limit / CELL), cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  for (let i = -r; i <= r; i++) {
    for (let j = -r; j <= r; j++) {
      for (const seg of index.get((cx + i) * 100000 + cz + j) || []) {
        const t = Math.max(0, Math.min(seg.L, (x - seg.x) * seg.ux + (z - seg.z) * seg.uz));
        const px = seg.x + seg.ux * t, pz = seg.z + seg.uz * t, d = Math.hypot(px - x, pz - z);
        // Ties go to the first found, whichever order the cells hold them in: nearer by a millimetre to win
        if (d <= limit && (!best || d < best.d - 1e-3)) best = { x: px, z: pz, d, link: seg.link };
      }
    }
  }
  return best;
}

// A tile's index, made once: its buildings come in more than one go
const indices = new WeakMap();
/** The streets of a held tile (js/geodata.js), from its own roads */
function tileStreets(tile) {
  if (!indices.has(tile)) indices.set(tile, streetIndex(tile.links.map((r) => linkById.get(r[0]))));
  return indices.get(tile);
}

export { REACH, isStreet, streetFront, streetIndex, tileStreets };
