// tools/build-population.mjs: who lives where and what the land is for, from the ABS 2021 Census's Mesh Blocks (an area of
// 30-60 homes each, with its residents, dwellings and land use) and NSW's land zoning. Writes tools/data/generated/places.bin.gz
// (tools/population/places.mjs), which tools/build-buildings.mjs and tools/build-tiles.mjs read.
// Sources: ABS Mesh Block Counts and ASGS Edition 3 (CC BY 4.0); NSW Department of Planning, Housing and Infrastructure,
// land zoning (CC BY 4.0). Downloaded by `node tools/fetch-data.mjs abs_counts,abs_meshblocks,nsw_zoning`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA, DETAIL_BOUNDS, toWorld } from './geo-common.mjs';
import { FINE, USE, fillRings, savePlaces, zoneOfCode } from './population/places.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = path.join(ROOT, 'tools/data/generated/places.bin.gz');
const started = Date.now();
const log = (...args) => console.log('[places]', ...args);

// Residents and dwellings of each Mesh Block in NSW, from the spreadsheet once, then from its JSON copy
async function counts() {
  const cache = path.join(DATA, 'abs/meshblock-counts-2021.json');
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  await c.run('INSTALL excel; LOAD excel;');
  const file = path.join(DATA, 'abs/meshblock-counts-2021.xlsx');
  const out = {};
  // NSW's table is Table 1, in two sheets of up to 60,000 rows; each row is code, land use, area, dwellings, persons, state
  for (const sheet of ['Table 1', 'Table 1.1']) {
    const rows = (await c.runAndReadAll(`SELECT * FROM read_xlsx('${file}', sheet='${sheet}', all_varchar=true, header=false, range='A1:F70000', stop_at_empty=false)`)).getRows();
    let nsw = 0;
    for (const [code, , , dwellings, persons, state] of rows) {
      if (state !== '1' || !/^\d{11}$/.test(code || '')) continue;
      out[code] = [Number(dwellings) || 0, Number(persons) || 0];
      nsw++;
    }
    log(`${sheet}: ${nsw} NSW Mesh Blocks`);
  }
  fs.writeFileSync(cache, JSON.stringify(out));
  return out;
}

const COUNTS = await counts();
const MARGIN = 2000;
const frame = {
  x0: DETAIL_BOUNDS.x0 - MARGIN, z0: DETAIL_BOUNDS.z0 - MARGIN, cell: FINE,
  w: (DETAIL_BOUNDS.x1 - DETAIL_BOUNDS.x0 + 2 * MARGIN) / FINE, h: (DETAIL_BOUNDS.z1 - DETAIL_BOUNDS.z0 + 2 * MARGIN) / FINE
};
const mb = new Int32Array(frame.w * frame.h).fill(-1);
const zone = new Uint8Array(frame.w * frame.h);
const ringsOf = (geometry) => {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.map((rings) => rings.map((ring) => ring.map(([lon, lat]) => toWorld(lon, lat))));
};

// Mesh Blocks: each one's cells
const blocks = [];
let unmatched = 0;
for (const f of JSON.parse(fs.readFileSync(path.join(DATA, 'abs_meshblocks.json'), 'utf8'))) {
  const p = f.properties;
  const [dwellings, persons] = COUNTS[p.mb_code_2021] || [0, 0];
  if (!COUNTS[p.mb_code_2021]) unmatched++;
  const id = blocks.length;
  const block = { code: p.mb_code_2021, use: USE[p.mb_category_2021] ?? USE.Other, dwellings, persons, cells: 0, sa1: p.sa1_code_2021, sa2: p.sa2_name_2021 };
  blocks.push(block);
  for (const rings of ringsOf(f.geometry)) fillRings(frame, rings, (i) => { if (mb[i] < 0) block.cells++; mb[i] = id; });
}
// A Mesh Block cut by the raster's edge, or too thin for a cell's centre, keeps its count in the cells it has
let persons = 0, dwellings = 0, lost = 0;
for (const b of blocks) {
  persons += b.persons;
  dwellings += b.dwellings;
  if (!b.cells) lost += b.persons;
}

// Zoning: each zone's cells, in its class
const zoneCells = {};
for (const f of JSON.parse(fs.readFileSync(path.join(DATA, 'nsw_zoning.json'), 'utf8'))) {
  const z = zoneOfCode(f.properties.SYM_CODE);
  if (!z) continue;
  for (const rings of ringsOf(f.geometry)) fillRings(frame, rings, (i) => { zone[i] = z; zoneCells[z] = (zoneCells[z] || 0) + 1; });
}

savePlaces(OUT, { frame, blocks, mb, zone });
log(`${blocks.length} Mesh Blocks, ${unmatched} with no counts; ${persons.toLocaleString()} residents and ${dwellings.toLocaleString()} dwellings, ${lost} residents in blocks too small for a cell`);
log(`zoned cells: ${Object.entries(zoneCells).map(([z, n]) => `${z}:${(n / 1e4).toFixed(1)}km²`).join(' ')}`);
log(`${path.relative(ROOT, OUT)} ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB, in ${((Date.now() - started) / 1000).toFixed(1)} s`);
