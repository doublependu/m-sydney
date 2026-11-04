// Who lives where, and what the land is for, as tools/build-population.mjs works it out from the ABS's Mesh Blocks and NSW's
// land zoning. A 10 m raster of which Mesh Block each spot is in and how it's zoned, and a table of the Mesh Blocks with their
// counts. tools/build-buildings.mjs asks it what a building stands in; tools/build-tiles.mjs sums it into each tile's 100 m grid.
import fs from 'node:fs';
import zlib from 'node:zlib';

// Mesh Block land use, as the ABS names it (MB_CATEGORY_NAME_2021)
export const USES = ['', 'Residential', 'Commercial', 'Industrial', 'Parkland', 'Education', 'Hospital/Medical', 'Transport', 'Primary Production', 'Water', 'Other'];
export const USE = Object.fromEntries(USES.map((name, i) => [name, i]));
// Zoning, from the councils' plans, in fewer classes
export const ZONES = ['', 'houses', 'medium', 'flats', 'centre', 'office', 'industry', 'park', 'special', 'water', 'rural'];
export const ZONE = Object.fromEntries(ZONES.map((name, i) => [name, i]));
const ZONE_CODES = {
  houses: ['R1', 'R2', 'R5'],
  medium: ['R3'],
  flats: ['R4'],
  centre: ['E1', 'MU1', 'B1', 'B2', 'B4'],
  office: ['E2', 'SP4', 'SP5', 'B3', 'B8'],
  industry: ['E3', 'E4', 'E5', 'IN1', 'IN2', 'IN3', 'IN4', 'B5', 'B6', 'B7'],
  park: ['RE1', 'RE2', 'C1', 'C2', 'C3', 'C4'],
  special: ['SP1', 'SP2', 'SP3'],
  water: ['W1', 'W2', 'W3', 'W4'],
  rural: ['RU1', 'RU2', 'RU3', 'RU4', 'RU5', 'RU6']
};
export const zoneOfCode = (code) => {
  for (const [zone, codes] of Object.entries(ZONE_CODES)) if (codes.includes(code)) return ZONE[zone];
  return 0;
};

export const FINE = 10; // m, the raster's cell
export const CELL = 100; // m, the tiles' grid

/**
 * Fills polygons into a raster, even-odd, by the centre of each cell: `rings` in world metres as [[x, z], ...] lists,
 * `set(i)` for each cell index inside. Only rows and columns inside the raster.
 */
export function fillRings(raster, rings, set) {
  const { x0, z0, cell, w, h } = raster;
  let minZ = Infinity, maxZ = -Infinity;
  for (const ring of rings) for (const [, z] of ring) { if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
  const j0 = Math.max(0, Math.ceil((minZ - z0) / cell - 0.5)), j1 = Math.min(h - 1, Math.floor((maxZ - z0) / cell - 0.5));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const z = z0 + (j + 0.5) * cell;
    xs.length = 0;
    for (const ring of rings) {
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const [ax, az] = ring[a], [bx, bz] = ring[b];
        if ((az > z) !== (bz > z)) xs.push(ax + ((z - az) / (bz - az)) * (bx - ax));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - x0) / cell - 0.5)), i1 = Math.min(w - 1, Math.floor((xs[k + 1] - x0) / cell - 0.5));
      for (let i = i0; i <= i1; i++) set(j * w + i);
    }
  }
}

/** Writes what tools/build-population.mjs made: { frame, blocks, mb: Int32Array, zone: Uint8Array } */
export function savePlaces(file, { frame, blocks, mb, zone }) {
  const head = Buffer.from(JSON.stringify({ frame, blocks }));
  const lead = Buffer.alloc(4);
  lead.writeUInt32LE(head.length, 0);
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat([lead, head, Buffer.from(mb.buffer, mb.byteOffset, mb.byteLength), Buffer.from(zone)]), { level: 6 }));
}

/**
 * Reads it back, with lookups: blockAt(x, z) gives the Mesh Block's record { code, use, dwellings, persons, cells, sa1 } or null,
 * zoneAt(x, z) the zone class. Each block's `cells` is how many 10 m cells of the raster it has.
 */
export function loadPlaces(file) {
  const data = zlib.gunzipSync(fs.readFileSync(file));
  const length = data.readUInt32LE(0);
  const { frame, blocks } = JSON.parse(data.subarray(4, 4 + length).toString());
  const n = frame.w * frame.h;
  const start = 4 + length;
  const mb = new Int32Array(data.buffer.slice(data.byteOffset + start, data.byteOffset + start + n * 4));
  const zone = new Uint8Array(data.buffer.slice(data.byteOffset + start + n * 4, data.byteOffset + start + n * 5));
  const index = (x, z) => {
    const i = Math.floor((x - frame.x0) / frame.cell), j = Math.floor((z - frame.z0) / frame.cell);
    return i < 0 || j < 0 || i >= frame.w || j >= frame.h ? -1 : j * frame.w + i;
  };
  return {
    frame, blocks, mb, zone,
    blockAt(x, z) {
      const i = index(x, z);
      return i < 0 || mb[i] < 0 ? null : blocks[mb[i]];
    },
    blockIdAt(x, z) {
      const i = index(x, z);
      return i < 0 ? -1 : mb[i];
    },
    zoneAt(x, z) {
      const i = index(x, z);
      return i < 0 ? 0 : zone[i];
    }
  };
}
