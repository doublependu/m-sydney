// Draws the generated map data from above, for checking it against the real city. usage: node tools/debug-map.mjs out.png [x0 z0 x1 z1]
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { GEO, heldTiles } from '../js/geodata.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const [out = 'recordings/map.png', x0 = -2200, z0 = -4600, x1 = 2800, z1 = 2200] = process.argv.slice(2).map((v, i) => (i ? +v : v));
const S = Math.min(1600 / (x1 - x0), 1800 / (z1 - z0));
const W = Math.round((x1 - x0) * S), H = Math.round((z1 - z0) * S);
const P = (x, z) => `${((x - x0) * S).toFixed(1)},${((z - z0) * S).toFixed(1)}`;
const ring = (f) => { let s = ''; for (let i = 0; i < f.length; i += 2) s += `${i ? 'L' : 'M'}${P(f[i], f[i + 1])}`; return `${s}Z`; };
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#2a4a6a"/>`;
for (const rings of GEO.surroundings) svg += `<path d="${rings.map(ring).join('')}" fill="#3a4a3a" fill-rule="evenodd"/>`;
for (const rings of GEO.shores) svg += `<path d="${rings.map(ring).join('')}" fill="#555" fill-rule="evenodd"/>`;
for (const [flat, holes, park] of heldTiles().flatMap((t) => t.blocks)) svg += `<path d="${[flat, ...holes].map(ring).join('')}" fill="${park > 0.6 ? '#4c8a4c' : park > 0.2 ? '#7f9f6a' : '#c8bda8'}" fill-rule="evenodd" stroke="#000" stroke-width="0.3"/>`;
// Roads by level: ground red, bridges and viaducts orange and thicker, tunnels blue and dashed
const n = GEO.roadGraph.nodes;
const levels = { ground: '', bridges: '', tunnels: '' };
for (const [a, b, , , , , inner, , , kind = 0] of GEO.roadGraph.links) {
  const pts = [n[a * 2], n[a * 2 + 1], ...inner, n[b * 2], n[b * 2 + 1]];
  levels[kind === 1 ? 'bridges' : kind === 2 ? 'tunnels' : 'ground'] += ring(pts).slice(0, -1);
}
svg += `<path d="${levels.ground}" fill="none" stroke="#e33" stroke-width="0.6"/>`;
svg += `<path d="${levels.tunnels}" fill="none" stroke="#29c4ff" stroke-width="1.2" stroke-dasharray="4 3"/>`;
svg += `<path d="${levels.bridges}" fill="none" stroke="#ff9a1f" stroke-width="1.6"/>`;
for (let i = 0; i < GEO.signals.length; i += 2) svg += `<circle cx="${(GEO.signals[i] - x0) * S}" cy="${(GEO.signals[i + 1] - z0) * S}" r="1.6" fill="#ff0"/>`;
svg += '</svg>';
fs.mkdirSync('recordings', { recursive: true });
await sharp(Buffer.from(svg)).png().toFile(out);
console.log(out, W, H);
