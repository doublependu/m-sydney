import { GEO } from './geodata.js';

// The ground's height. Sydney has about 50 m of relief, which the simulation never hears about: colliders, traffic and
// people all live on a flat plane, and this lifts what is drawn. Static geometry is lifted once as it is built, moving
// things where their transforms are written. Grades are gentle (86% of road under 6%), so distances stay honest.

const { x0, z0, cell, w, h } = GEO.frame.heights;

const response = await fetch(new URL('./height-grid.bin.gz', import.meta.url));
if (!response.ok) throw new Error(`Height data request failed: ${response.status}`);
// Servers that send .gz files as Content-Encoding: gzip hand over bytes the browser has already inflated
const body = new Uint8Array(await response.arrayBuffer());
const data = body[0] === 0x1f && body[1] === 0x8b
  ? new Uint8Array(await new Response(new Response(body).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  : body;

// 0.25 m steps as zigzag varint differences along each row
const heights = new Float32Array(w * h);
{
  let cursor = 0;
  for (let j = 0; j < h; j++) {
    let v = 0;
    for (let i = 0; i < w; i++) {
      let z = 0, shift = 0, byte;
      do {
        byte = data[cursor++];
        z |= (byte & 127) << shift;
        shift += 7;
      } while (byte & 128);
      v += (z >>> 1) ^ -(z & 1);
      heights[j * w + i] = v * 0.25;
    }
  }
}

function terrainHeight(x, z) {
  const fx = (x - x0) / cell, fz = (z - z0) / cell;
  if (fx < 0 || fz < 0 || fx >= w - 1 || fz >= h - 1) return 0;
  const i = fx | 0, j = fz | 0;
  const tx = fx - i, tz = fz - j;
  const k = j * w + i;
  const a = heights[k] + (heights[k + 1] - heights[k]) * tx;
  const b = heights[k + w] + (heights[k + w + 1] - heights[k + w]) * tx;
  return a + (b - a) * tz;
}

/** Rise per metre at (x, z) heading along (sin, cos) */
function terrainSlope(x, z, sin, cos) {
  return (terrainHeight(x + sin * 2.5, z + cos * 2.5) - terrainHeight(x - sin * 2.5, z - cos * 2.5)) / 5;
}

export { terrainHeight, terrainSlope };
