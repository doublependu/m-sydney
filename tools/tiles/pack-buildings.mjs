// A tile's buildings, as js/tiles/tile-file.js unpackBuildings() reads them (tools/build-tiles.mjs): a head of the three streams'
// lengths, then each building's height, style, group and bottom, floor and its ground's lowest (0.1 m), outline and streets, with the
// points of its outline in streams of their own, in 0.5 m as differences.
import { numberCodes } from '../../js/addresses.js';

const uint = (out, v) => { while (v > 127) { out.push((v & 127) | 128); v = Math.floor(v / 128); } out.push(v); };
const sint = (out, v) => uint(out, v >= 0 ? v * 2 : -v * 2 - 1);

/** `list` [{ b, i }]: the buildings (tools/build-buildings.mjs' records) and their indexes into `floors` ([floor, low] in 0.1 m) */
export function packBuildings(list, floors) {
  const meta = [], xs = [], zs = [];
  let px = 0, pz = 0;
  uint(meta, list.length);
  for (const { b, i } of list) {
    uint(meta, b.height);
    uint(meta, b.kind | (b.pitched ? 8 : 0) | (b.group ? 16 : 0) | (b.realAwning ? 32 : 0) | (b.address ? 64 : 0) | ((b.houseStyle || 0) << 7));
    if (b.group) { uint(meta, b.group); uint(meta, b.bottom || 0); }
    const [floor, low] = floors?.[i] || [0, 0];
    sint(meta, floor);
    sint(meta, low);
    uint(meta, b.polygons.length);
    for (const polygon of b.polygons) {
      const rings = [polygon.outer, ...polygon.holes];
      uint(meta, rings.length);
      for (const ring of rings) {
        uint(meta, ring.length);
        for (const p of ring) {
          const x = Math.round(p.x * 2), z = Math.round(p.z * 2);
          sint(xs, x - px);
          sint(zs, z - pz);
          px = x;
          pz = z;
        }
      }
    }
    // Its streets (tools/build-buildings.mjs), the one most of its addresses are on first: the point on each nearest its middle, in
    // 0.5 m from floor(its middle in 0.5 m); the wall of its outline facing it (js/addresses.js outerWalls(), +1, 0 for none) times 2,
    // and 1 more where another street follows; its numbers there (js/addresses.js numberCodes(), 0 for none)
    if (b.address) {
      const ox = Math.floor(b.cx * 2), oz = Math.floor(b.cz * 2);
      b.address.forEach((s, k) => {
        sint(meta, Math.round(s.x * 2) - ox);
        sint(meta, Math.round(s.z * 2) - oz);
        uint(meta, (s.wall + 1) * 2 + (k < b.address.length - 1 ? 1 : 0));
        for (const c of s.number ? numberCodes(s.number) : [0]) uint(meta, c);
      });
    }
  }
  const head = [];
  uint(head, meta.length);
  uint(head, xs.length);
  uint(head, zs.length);
  return Buffer.from([...head, ...meta, ...xs, ...zs]);
}
