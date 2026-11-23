// Houses' real lots, on NSW's cadastre (tools/build-lots.mjs): each tile's lot file (js/tiles/lot-file.js), named in lots/index.json.
// js/lot-details.js asks for a square's tiles' files before it works out the square's lots (lotsReady()), and lets them go with their
// tiles (releaseLots()); realLotsOf() puts a square's together for js/house-lots.js. A build without lot files asks for nothing
// (vite.config.js says whether public/lots/index.json is there), and a tile without a file, or a file that doesn't come, leaves its houses
// the lots worked out from the map alone.
// Under Node (tools and tests) the files are read as they're wanted, from public/lots/, or from the folder SYDNEY_LOTS names.
/* global __SYDNEY_LOTS__ */
import { unpackLots } from './tiles/lot-file.js';
import { lotFile } from './tiles/paths.js';

const inNode = typeof document === 'undefined';
const SHIPPED = inNode || (typeof __SYDNEY_LOTS__ !== 'undefined' && __SYDNEY_LOTS__ === true);
const TILE = 1000; // m: the tiles' size, as the lot files count from their corners
const ON_EDGE = 0.02; // m: another lot's corner this near an edge is on it
const CELL = 40; // m: the lots' cells, for the lots near a point

function lotsBase() {
  if (!inNode) return new URL('lots/', document.baseURI);
  const dir = process.env.SYDNEY_LOTS;
  if (dir) return process.getBuiltinModule('node:url').pathToFileURL(`${process.getBuiltinModule('node:path').resolve(dir)}/`);
  // Put together at run time, so the bundler doesn't take it for a file to include
  return new URL(['..', 'public', 'lots', ''].join('/'), import.meta.url);
}

async function fetched(name) {
  const response = await fetch(new URL(name, lotsBase()));
  if (!response.ok) throw new Error(`Lot file request failed: ${response.status} ${name}`);
  const body = new Uint8Array(await response.arrayBuffer());
  // Servers that send .gz files as Content-Encoding: gzip hand over bytes the browser has already inflated (js/geodata.js)
  return body[0] === 0x1f && body[1] === 0x8b
    ? new Uint8Array(await new Response(new Response(body).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
    : body;
}
function read(name) {
  const fs = process.getBuiltinModule('node:fs');
  const url = new URL(name, lotsBase());
  if (!fs.existsSync(url)) return null;
  const body = fs.readFileSync(url);
  return new Uint8Array(body[0] === 0x1f && body[1] === 0x8b ? process.getBuiltinModule('node:zlib').gunzipSync(body) : body);
}

let index; // undefined before it's asked for; a promise while it comes; then { tiles: key -> hash } or null
const files = new Map(); // tile key -> its file unpacked, null where it didn't come, or a promise while it comes

function askIndex() {
  if (index !== undefined) return;
  if (!SHIPPED) { index = null; return; }
  if (inNode) {
    const bytes = read('index.json');
    index = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    return;
  }
  // A server that sends its own page for a file it hasn't got (a dev server does) sends no index either
  index = fetched('index.json').then((bytes) => JSON.parse(new TextDecoder().decode(bytes)))
    .then((v) => { index = v?.tiles ? v : null; }, () => { index = null; });
}

/** A tile's lot file, once it's here: { homes, lots } (js/tiles/lot-file.js unpackLots()), or null where it has none */
function lotFileOf(key) {
  askIndex();
  if (!index || index instanceof Promise || !index.tiles[key]) return null;
  let file = files.get(key);
  if (file === undefined && inNode) {
    const [ix, iz] = key.split('_').map(Number);
    const bytes = read(lotFile(key, index.tiles[key]));
    files.set(key, (file = bytes ? unpackLots(bytes, ix, iz) : null));
  }
  return file instanceof Promise ? null : file ?? null;
}

/** Whether every tile of `keys` has its lot file here, or has none: asking for those that haven't come yet */
function lotsReady(keys) {
  askIndex();
  if (index instanceof Promise) return false;
  if (!index || inNode) return true;
  let ready = true;
  for (const key of keys) {
    if (!index.tiles[key]) continue;
    const file = files.get(key);
    if (file instanceof Promise) ready = false;
    else if (file === undefined) {
      const [ix, iz] = key.split('_').map(Number);
      const asked = fetched(lotFile(key, index.tiles[key])).then((bytes) => unpackLots(bytes, ix, iz)).catch(() => null)
        .then((unpacked) => { if (files.get(key) === asked) files.set(key, unpacked); });
      files.set(key, asked);
      ready = false;
    }
  }
  return ready;
}

/** Lets go of the lot files of the tiles that `keep(key)` says aren't wanted */
function releaseLots(keep) {
  for (const key of [...files.keys()]) if (!keep(key)) files.delete(key);
}

const pointKey = (p) => `${Math.round(p.x * 100)},${Math.round(p.z * 100)}`;

/** The real lots of the tiles `keys` (their files that are here), put together: realLotsFrom()'s. In steps. */
function* realLotsOf(keys) {
  const here = [];
  for (const key of keys) {
    const file = lotFileOf(key);
    const [ix, iz] = key.split('_').map(Number);
    if (file) here.push({ ix, iz, ...file });
  }
  return yield* realLotsFrom(here);
}

/**
 * Tiles' lot files (each { ix, iz, homes, lots }, as js/tiles/lot-file.js unpackLots() gives them) put together for js/house-lots.js
 * squareLots(), or null where there are no lots: { homeAt(x, z), lotsIn(x0, z0, x1, z1) }. homeAt() gives the house whose middle is
 * (x, z) (js/house-lots.js wholesOf()'s), as the files have it: { x, z, rule, lots }, its lots each { kind, homes (the first its own
 * house), rings, edges, lines, box }. Each ring's edge runs from its point to the next; a corner on an edge splits it, so two
 * lots that share a line have the same edges along it, and the same `lines`: { key, ax, az, ux, uz, length }, the edge from its first
 * end by key. In steps.
 */
function* realLotsFrom(files) {
  const homes = new Map(); // the middle in 0.1 m -> the house
  const lots = [];
  for (const file of files) {
    const { ix, iz } = file;
    const here = file.homes.map((h) => {
      const k = `${Math.round(h.x * 10)},${Math.round(h.z * 10)}`;
      let home = homes.get(k);
      // A house on a lot in another tile's file is there too: its own tile's file says how it fits
      const own = Math.floor(h.x / TILE) === ix && Math.floor(h.z / TILE) === iz;
      if (!home) homes.set(k, (home = { x: h.x, z: h.z, rule: h.rule, lots: [] }));
      else if (own) home.rule = h.rule;
      return home;
    });
    for (const l of file.lots) {
      const lot = { kind: l.kind, homes: l.homes.map((i) => here[i]), rings: l.rings, edges: l.edges };
      for (const h of lot.homes) h.lots.push(lot);
      lots.push(lot);
    }
    yield;
  }
  if (!lots.length) return null;

  // Every lot's corners in cells, to split an edge where a corner is on it
  const corners = new Map();
  const cellKey = (ix, iz) => ix * 100003 + iz;
  for (const lot of lots) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const ring of lot.rings) {
      for (const p of ring) {
        if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
        const k = cellKey(Math.floor(p.x / CELL), Math.floor(p.z / CELL));
        (corners.get(k) || corners.set(k, []).get(k)).push({ p, lot });
      }
    }
    lot.box = { x0, x1, z0, z1 };
  }
  yield;
  let n = 0;
  for (const lot of lots) {
    if (++n % 200 === 0) yield;
    const rings = [], edges = [], lines = [];
    lot.rings.forEach((ring, r) => {
      const pts = [], kinds = [], ls = [];
      ring.forEach((a, i) => {
        const b = ring[(i + 1) % ring.length], L = Math.hypot(b.x - a.x, b.z - a.z);
        const on = [];
        if (L > 2 * ON_EDGE) {
          const seen = new Set();
          for (let cx = Math.floor(Math.min(a.x, b.x) / CELL); cx <= Math.floor(Math.max(a.x, b.x) / CELL); cx++) {
            for (let cz = Math.floor(Math.min(a.z, b.z) / CELL); cz <= Math.floor(Math.max(a.z, b.z) / CELL); cz++) {
              for (const c of corners.get(cellKey(cx, cz)) || []) {
                if (seen.has(c.p)) continue; // its own corners too: a lot that doubles back along a line
                const t = ((c.p.x - a.x) * (b.x - a.x) + (c.p.z - a.z) * (b.z - a.z)) / (L * L);
                if (t * L <= ON_EDGE || (1 - t) * L <= ON_EDGE) continue;
                if (Math.abs((c.p.x - a.x) * (b.z - a.z) - (c.p.z - a.z) * (b.x - a.x)) / L >= ON_EDGE) continue;
                seen.add(c.p);
                on.push({ t, p: c.p });
              }
            }
          }
          on.sort((u, v) => u.t - v.t);
        }
        for (const q of [a, ...on.map((o) => o.p)]) {
          pts.push(q);
          kinds.push(lot.edges[r][i]);
        }
      });
      // Each edge's line, by its ends' keys: the same object for the same edge in two lots isn't needed, the same key is
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const ka = pointKey(a), kb = pointKey(b);
        const [p, q] = ka < kb ? [a, b] : [b, a];
        const L = Math.hypot(q.x - p.x, q.z - p.z) || 1;
        ls.push({ key: ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`, ax: p.x, az: p.z, ux: (q.x - p.x) / L, uz: (q.z - p.z) / L, length: L });
      }
      rings.push(pts);
      edges.push(kinds);
      lines.push(ls);
    });
    Object.assign(lot, { rings, edges, lines });
  }
  yield;
  // The lots in cells, by their boxes
  const cells = new Map();
  for (const lot of lots) {
    const { x0, x1, z0, z1 } = lot.box;
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const k = cellKey(cx, cz);
        (cells.get(k) || cells.set(k, []).get(k)).push(lot);
      }
    }
  }
  return {
    homeAt: (x, z) => homes.get(`${Math.round(x * 10)},${Math.round(z * 10)}`) ?? null,
    lotsIn(x0, z0, x1, z1) {
      const out = new Set();
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
        for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
          for (const lot of cells.get(cellKey(cx, cz)) || []) {
            if (lot.box.x1 >= x0 && lot.box.x0 <= x1 && lot.box.z1 >= z0 && lot.box.z0 <= z1) out.add(lot);
          }
        }
      }
      return [...out];
    }
  };
}

export { lotFileOf, lotsReady, realLotsFrom, realLotsOf, releaseLots };
