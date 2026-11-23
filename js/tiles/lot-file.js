// One tile's houses' lots on NSW's cadastre (tools/build-lots.mjs, tools/lots/pack.mjs writes them): the houses whose middle is in the
// tile, each with how its real lot fits it, and the real lots they're on, each ring's points in 0.1 m from the tile's corner and each
// edge's kind. A house is found by its middle (js/house-lots.js wholesOf()'s cx, cz, in 0.1 m from the tile's corner), never by its
// place in the tile, so a file built on other buildings matches none of them.

/** How a house's real lot fits it (tools/lots/fit.mjs) */
const HOME_RULES = ['in', 'moved', 'wall', 'several', 'fallback'];
/** A lot's kind: one house's, or several houses' (a strata scheme, or one big lot), which the game divides */
const LOT_KINDS = ['fitted', 'several'];
/**
 * An edge's kind, from the point before it to the next: `side`, shared with another lot; `front`, along a road; `wall`, the line between
 * two lots one house stands on (a pair or a row drawn as one), or between two houses drawn into each other; `moved`, shared with another
 * lot and moved into the gap between the houses; `bound`, no lot and no road beyond (a railway, a creek, land with no lot)
 */
const EDGE_KINDS = ['side', 'front', 'wall', 'moved', 'bound'];
const VERSION = 1;

function reader(data, start, end) {
  let cursor = start;
  return {
    uint() {
      let value = 0, scale = 1, byte;
      do {
        if (cursor >= end) throw new Error('Lot data ended early.');
        byte = data[cursor++];
        value += (byte & 127) * scale;
        scale *= 128;
      } while (byte & 128);
      return value;
    },
    sint() {
      const v = this.uint();
      return v % 2 ? -(v + 1) / 2 : v / 2;
    },
    done: () => cursor === end
  };
}

/** The tile's middle key of a house's middle (x, z), as the file has it: its 0.1 m steps from the tile's corner */
const homeKey = (ix, iz, x, z) => `${Math.round((x - ix * 1000) * 10)},${Math.round((z - iz * 1000) * 10)}`;

/**
 * A lot file's bytes, unzipped, for tile (ix, iz): { homes: [{ x, z, key, rule, lots }], lots: [{ kind, homes, rings, edges }] }, points in
 * the world's metres. A home's `lots` are the lots it stands on (one, or each of a pair's or row's); a lot's `homes` its homes' indexes.
 * Rings: the outer one counter-clockwise in (x, z) as js/house-lots.js ringSigned() counts it (positive), holes the other way round.
 */
function unpackLots(data, ix, iz) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint8(0) !== VERSION) throw new Error(`Lot file version ${view.getUint8(0)}, not ${VERSION}.`);
  const metaEnd = 13 + view.getUint32(1, true), xsEnd = metaEnd + view.getUint32(5, true), zsEnd = xsEnd + view.getUint32(9, true);
  const meta = reader(data, 13, metaEnd), xs = reader(data, metaEnd, xsEnd), zs = reader(data, xsEnd, zsEnd);
  const x0 = ix * 1000, z0 = iz * 1000;
  let px = 0, pz = 0;
  const point = () => {
    px += xs.sint();
    pz += zs.sint();
    return { x: x0 + px / 10, z: z0 + pz / 10 };
  };
  const homes = [];
  for (let i = meta.uint(); i > 0; i--) {
    const p = point();
    homes.push({ ...p, key: `${px},${pz}`, rule: HOME_RULES[meta.uint()], lots: [] });
  }
  const lots = [];
  for (let i = meta.uint(); i > 0; i--) {
    const lot = { kind: LOT_KINDS[meta.uint()], homes: [], rings: [], edges: [] };
    for (let k = meta.uint(); k > 0; k--) {
      const h = meta.uint();
      lot.homes.push(h);
      homes[h].lots.push(lots.length);
    }
    for (let r = meta.uint(); r > 0; r--) {
      const n = meta.uint(), ring = [], edges = [];
      for (let k = 0; k < n; k++) ring.push(point());
      for (let k = 0; k < n; k++) edges.push(EDGE_KINDS[meta.uint()]);
      lot.rings.push(ring);
      lot.edges.push(edges);
    }
    lots.push(lot);
  }
  if (!meta.done() || !xs.done() || !zs.done()) throw new Error('Lot data has more than it says.');
  return { homes, lots };
}

export { EDGE_KINDS, HOME_RULES, LOT_KINDS, VERSION, homeKey, unpackLots };
