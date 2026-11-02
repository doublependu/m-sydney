import { GEO, TILE, tileExists } from '../geodata.js';

// Which tiles to have: those in range of where the player is and of where they'll be in a few seconds, nearest first. Tiles
// are let go of a little further out than they're fetched, so nothing flickers on the line.

const LOOK_AHEAD = 5; // s
const KEEP_MARGIN = 500; // m past the range before a tile is let go

const BOUNDS = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
for (const key of Object.keys(GEO.tiles)) {
  const [ix, iz] = key.split('_').map(Number);
  BOUNDS.x0 = Math.min(BOUNDS.x0, ix);
  BOUNDS.x1 = Math.max(BOUNDS.x1, ix);
  BOUNDS.z0 = Math.min(BOUNDS.z0, iz);
  BOUNDS.z1 = Math.max(BOUNDS.z1, iz);
}

// From a point to a tile's square: nothing inside it
function distanceToTile(ix, iz, x, z) {
  const dx = Math.max(ix * TILE - x, 0, x - (ix + 1) * TILE), dz = Math.max(iz * TILE - z, 0, z - (iz + 1) * TILE);
  return Math.hypot(dx, dz);
}

/**
 * { load, drop }: `load` the keys of the tiles wanted and not `built`, in order; `drop` those `built` that aren't wanted any
 * more. (x, z) where the player is, (vx, vz) in m/s, `range` in m. `exists` is for tests.
 */
function planTiles({ x, z, vx = 0, vz = 0, range, built, exists = tileExists, keep = KEEP_MARGIN }) {
  const ax = x + vx * LOOK_AHEAD, az = z + vz * LOOK_AHEAD;
  const load = [];
  let x0 = Math.floor((Math.min(x, ax) - range) / TILE), x1 = Math.floor((Math.max(x, ax) + range) / TILE);
  let z0 = Math.floor((Math.min(z, az) - range) / TILE), z1 = Math.floor((Math.max(z, az) + range) / TILE);
  // No need to look where the map doesn't reach
  if (exists === tileExists) {
    x0 = Math.max(x0, BOUNDS.x0);
    x1 = Math.min(x1, BOUNDS.x1);
    z0 = Math.max(z0, BOUNDS.z0);
    z1 = Math.min(z1, BOUNDS.z1);
  }
  for (let ix = x0; ix <= x1; ix++) {
    for (let iz = z0; iz <= z1; iz++) {
      const key = `${ix}_${iz}`;
      if (built.has(key) || !exists(key)) continue;
      const here = distanceToTile(ix, iz, x, z), ahead = distanceToTile(ix, iz, ax, az);
      if (Math.min(here, ahead) <= range) load.push({ key, order: Math.min(here, ahead * 1.2) });
    }
  }
  load.sort((a, b) => a.order - b.order);
  const drop = [];
  for (const key of built) {
    const [ix, iz] = key.split('_').map(Number);
    if (Math.min(distanceToTile(ix, iz, x, z), distanceToTile(ix, iz, ax, az)) > range + keep) drop.push(key);
  }
  return { load: load.map((t) => t.key), drop };
}

export { KEEP_MARGIN, LOOK_AHEAD, distanceToTile, planTiles };
