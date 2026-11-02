// Downloads NSW's 5 m elevation model (NSW_5M_Elevation, © State of NSW, Spatial Services) as blocks of 32-bit heights in Web Mercator,
// at the resolution asked for. Each block is one file, kept once it has arrived, so a run can stop and go on later.
//   node tools/fetch-elevation.mjs --cell=100                  the whole box
//   node tools/fetch-elevation.mjs --cell=5 --box=w,s,e,n      a part of it, in degrees
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = 'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_5M_Elevation/ImageServer/exportImage';
export const WHOLE_BOX = { west: 150.29, south: -34.08, east: 151.34, north: -33.56 };
// To a request. The service gets slower the further it has to look, not with the pixels: 5 km at 5 m takes 3 s, 25 km at 100 m takes 21 s,
// and 50 km at 100 m takes over 100 s.
const pixelsFor = (cell) => (cell >= 50 ? 256 : 1024);
const R = 20037508.342789244;

export const mercatorX = (lon) => (lon * R) / 180;
export const mercatorY = (lat) => (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * R) / Math.PI;

// An uncompressed or deflated TIFF, of one band of 32-bit floats, as the service sends it
export function readTiff(buffer) {
  const data = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const little = data.getUint16(0) === 0x4949;
  const u16 = (at) => data.getUint16(at, little), u32 = (at) => data.getUint32(at, little);
  if (u16(2) !== 42) throw new Error('Not a TIFF');
  const ifd = u32(4), tags = new Map();
  for (let i = 0; i < u16(ifd); i++) {
    const at = ifd + 2 + i * 12;
    const type = u16(at + 2), count = u32(at + 4);
    const size = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8 }[type] ?? 4;
    const where = size * count <= 4 ? at + 8 : u32(at + 8);
    const values = [];
    for (let k = 0; k < Math.min(count, 100000); k++) values.push(type === 3 ? u16(where + k * 2) : type === 4 ? u32(where + k * 4) : data.getUint8(where + k));
    tags.set(u16(at), values);
  }
  const width = tags.get(256)[0], height = tags.get(257)[0], compression = tags.get(259)?.[0] ?? 1;
  if (tags.get(258)[0] !== 32 || tags.get(339)?.[0] !== 3) throw new Error('Not 32-bit floats');
  if (compression !== 1) throw new Error(`TIFF compression ${compression}: not handled`);
  const heights = new Float32Array(width * height);
  const offsets = tags.get(273) ?? tags.get(324), counts = tags.get(279) ?? tags.get(325);
  const tileWidth = tags.get(322)?.[0], tileHeight = tags.get(323)?.[0];
  offsets.forEach((offset, s) => {
    if (tileWidth) {
      const across = Math.ceil(width / tileWidth);
      const x0 = (s % across) * tileWidth, y0 = Math.floor(s / across) * tileHeight;
      for (let y = 0; y < tileHeight && y0 + y < height; y++) {
        for (let x = 0; x < tileWidth && x0 + x < width; x++) heights[(y0 + y) * width + x0 + x] = data.getFloat32(offset + (y * tileWidth + x) * 4, little);
      }
    } else {
      const rowsPerStrip = tags.get(278)?.[0] ?? height;
      const start = s * rowsPerStrip * width;
      for (let i = 0; i < counts[s] / 4; i++) heights[start + i] = data.getFloat32(offset + i * 4, little);
    }
  });
  return { width, height, heights };
}

async function fetchBlock(x0, y0, x1, y1, width, height, file) {
  const query = new URLSearchParams({
    bbox: `${x0},${y0},${x1},${y1}`, bboxSR: 102100, imageSR: 102100, size: `${width},${height}`, format: 'tiff', compression: 'NONE',
    pixelType: 'F32', interpolation: 'RSP_BilinearInterpolation', noData: -9999, f: 'image'
  });
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${SERVICE}?${query}`, { signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error(`${response.status}`);
      const { width: w, height: h, heights } = readTiff(new Uint8Array(await response.arrayBuffer()));
      if (w !== width || h !== height) throw new Error(`${w} x ${h} for ${width} x ${height}`);
      writeFileSync(`${file}.part`, new Uint8Array(heights.buffer));
      renameSync(`${file}.part`, file);
      return;
    } catch (e) {
      if (attempt === 5) throw e;
      console.log(`  ${e.message}, trying again in ${attempt * 5} s`);
      await new Promise((done) => setTimeout(done, attempt * 5000));
    }
  }
}

/** What a download at this cell size holds: { x0, y0, cell, blocks: [{ column, row, width, height, file }] } */
export function layout(cell, box = WHOLE_BOX) {
  const BLOCK_PIXELS = pixelsFor(cell);
  const folder = join(HERE, 'data/elevation', `${cell}m`);
  // Lines every block in step wherever a box starts, so blocks can be shared between runs
  const X0 = Math.floor(mercatorX(box.west) / (cell * BLOCK_PIXELS)) * cell * BLOCK_PIXELS;
  const Y1 = Math.ceil(mercatorY(box.north) / (cell * BLOCK_PIXELS)) * cell * BLOCK_PIXELS;
  const columns = Math.ceil((mercatorX(box.east) - X0) / (cell * BLOCK_PIXELS));
  const rows = Math.ceil((Y1 - mercatorY(box.south)) / (cell * BLOCK_PIXELS));
  const blocks = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const bx = X0 + column * cell * BLOCK_PIXELS, by = Y1 - row * cell * BLOCK_PIXELS;
      blocks.push({ bx, by, width: BLOCK_PIXELS, height: BLOCK_PIXELS, file: join(folder, `${Math.round(bx)}_${Math.round(by)}.f32`) });
    }
  }
  return { folder, cell, blocks };
}

/** A function from (lon, lat) to metres above sea level, or null where there's no data, from what's been downloaded */
export function heightSampler(cell) {
  const BLOCK_PIXELS = pixelsFor(cell);
  const blocks = new Map();
  const size = cell * BLOCK_PIXELS;
  const folder = join(HERE, 'data/elevation', `${cell}m`);
  const blockAt = (bx, by) => {
    const key = `${bx}_${by}`;
    if (!blocks.has(key)) {
      const file = join(folder, `${Math.round(bx)}_${Math.round(by)}.f32`);
      const bytes = existsSync(file) ? readFileSync(file) : null;
      blocks.set(key, bytes ? new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4) : null);
    }
    return blocks.get(key);
  };
  const pixel = (px, py) => {
    const column = Math.floor(px / BLOCK_PIXELS), row = Math.floor(py / BLOCK_PIXELS);
    const block = blockAt(column * size, (row + 1) * size);
    if (!block) return null;
    const value = block[(BLOCK_PIXELS - 1 - (py - row * BLOCK_PIXELS)) * BLOCK_PIXELS + (px - column * BLOCK_PIXELS)];
    return value > -1000 ? value : null;
  };
  return (lon, lat) => {
    const fx = mercatorX(lon) / cell - 0.5, fy = mercatorY(lat) / cell - 0.5;
    const px = Math.floor(fx), py = Math.floor(fy), u = fx - px, v = fy - py;
    const a = pixel(px, py), b = pixel(px + 1, py), c = pixel(px, py + 1), d = pixel(px + 1, py + 1);
    if (a === null || b === null || c === null || d === null) return null;
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const option = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const cell = Number(option('cell') ?? 100);
  const box = option('box') ? Object.fromEntries(['west', 'south', 'east', 'north'].map((k, i) => [k, Number(option('box').split(',')[i])])) : WHOLE_BOX;
  const { folder, blocks } = layout(cell, box);
  const BLOCK_PIXELS = pixelsFor(cell);
  mkdirSync(folder, { recursive: true });
  const missing = blocks.filter((b) => !existsSync(b.file));
  console.log(`${blocks.length} blocks at ${cell} m, ${missing.length} to fetch: ${Math.round((missing.length * BLOCK_PIXELS * BLOCK_PIXELS * 4) / 1048576)} MB`);
  const JOBS = 3; // The service is NSW's, and shared: a few at a time
  let next = 0;
  await Promise.all(Array.from({ length: JOBS }, async () => {
    while (next < missing.length) {
      const b = missing[next++];
      await fetchBlock(b.bx, b.by - cell * BLOCK_PIXELS, b.bx + cell * BLOCK_PIXELS, b.by, b.width, b.height, b.file);
      if (next % 10 === 0 || next === missing.length) console.log(`  ${next} of ${missing.length}`);
    }
  }));
}
