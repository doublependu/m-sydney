// A tile's houses' lots, as js/tiles/lot-file.js unpackLots() reads them: a version byte and the three streams' lengths, then the homes
// and the lots in one stream, and the points' x and z in streams of their own, in 0.1 m from the tile's corner as differences, the homes'
// middles first and then each lot's rings in turn.
import { EDGE_KINDS, HOME_RULES, LOT_KINDS, VERSION } from '../../js/tiles/lot-file.js';

const uint = (out, v) => { while (v > 127) { out.push((v & 127) | 128); v = Math.floor(v / 128); } out.push(v); };
const sint = (out, v) => uint(out, v >= 0 ? v * 2 : -v * 2 - 1);

/**
 * `file`: { homes: [{ x, z, rule }], lots: [{ kind, homes: [index], rings: [[{ x, z }]], edges: [[kind]] }] } for tile (ix, iz), in the
 * world's metres, the kinds by name. Homes' middles round to 0.1 m as js/tiles/lot-file.js homeKey() does. Returns the bytes, unzipped.
 */
export function packLots(file, ix, iz) {
  const meta = [], xs = [], zs = [];
  const x0 = ix * 1000, z0 = iz * 1000;
  let px = 0, pz = 0;
  const point = (p) => {
    const x = Math.round((p.x - x0) * 10), z = Math.round((p.z - z0) * 10);
    sint(xs, x - px);
    sint(zs, z - pz);
    px = x;
    pz = z;
  };
  const code = (list, name) => {
    const i = list.indexOf(name);
    if (i < 0) throw new Error(`No such kind: ${name}`);
    return i;
  };
  uint(meta, file.homes.length);
  for (const h of file.homes) {
    point(h);
    uint(meta, code(HOME_RULES, h.rule));
  }
  uint(meta, file.lots.length);
  for (const lot of file.lots) {
    uint(meta, code(LOT_KINDS, lot.kind));
    uint(meta, lot.homes.length);
    for (const h of lot.homes) uint(meta, h);
    uint(meta, lot.rings.length);
    lot.rings.forEach((ring, r) => {
      uint(meta, ring.length);
      for (const p of ring) point(p);
      for (const e of lot.edges[r]) uint(meta, code(EDGE_KINDS, e));
    });
  }
  const head = new Uint8Array(13);
  const view = new DataView(head.buffer);
  view.setUint8(0, VERSION);
  view.setUint32(1, meta.length, true);
  view.setUint32(5, xs.length, true);
  view.setUint32(9, zs.length, true);
  return Buffer.concat([head, Buffer.from(meta), Buffer.from(xs), Buffer.from(zs)]);
}
