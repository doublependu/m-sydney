// Finds a lane position on a named road near a point: node tools/where.mjs "Macquarie Street" x z
import { GEO } from '../js/geodata.js';
const RG = GEO.roadGraph;
const [name, x, z] = [process.argv[2], +process.argv[3], +process.argv[4]];
const out = [];
for (const [a, b, ni, w, lanes, dir, inner] of RG.links) {
  if (RG.names[ni] !== name) continue;
  const pts = [[RG.nodes[a * 2], RG.nodes[a * 2 + 1]]];
  for (let i = 0; i < inner.length; i += 2) pts.push([inner[i], inner[i + 1]]);
  pts.push([RG.nodes[b * 2], RG.nodes[b * 2 + 1]]);
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    out.push({ d: Math.hypot(mx - x, mz - z), x: Math.round(mx), z: Math.round(mz), L: Math.round(L), ux: +((bx - ax) / L).toFixed(2), uz: +((bz - az) / L).toFixed(2), w, lanes, dir });
  }
}
console.log(name, JSON.stringify(out.sort((p, q) => p.d - q.d).slice(0, 3)));
