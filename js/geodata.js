// The map, in the game's world frame: 1 unit = 1 m, x = grid east, z = grid south, origin at Town Hall, axes turned 8° from
// true north. It comes in 1 km tiles (tools/build-tiles.mjs), and only the tiles near the player are held. tiles/world.json
// has what the whole map shares. Modules with an index of the map register with onMap(), and get told as tiles come and go.
// Under Node (tools and tests), the whole map is held from the start.
// Sources: © OpenStreetMap contributors (ODbL), City of Sydney open data (CC BY 4.0), Overture Maps.
import { unpackFarFile, unpackTile } from './tiles/tile-file.js';
import { farFile, tileFile } from './tiles/paths.js';

const inNode = typeof document === 'undefined';
// Put together at run time, so the bundler doesn't take it for a file to include
const BASE = inNode ? new URL(['..', 'public', 'tiles', ''].join('/'), import.meta.url) : new URL('tiles/', document.baseURI);
const INLINE = import.meta.env?.MODE === 'offline' ? (await import('virtual:offline-tiles')).default : null;

async function fileBody(name) {
  if (inNode) return new Uint8Array(process.getBuiltinModule('node:fs').readFileSync(new URL(name, BASE)));
  const response = await fetch(INLINE ? INLINE[name] : new URL(name, BASE));
  if (!response.ok) throw new Error(`Map data request failed: ${response.status} ${name}`);
  return new Uint8Array(await response.arrayBuffer());
}
async function fileBytes(name) {
  const body = await fileBody(name);
  // Servers that send .gz files as Content-Encoding: gzip hand over bytes the browser has already inflated
  return body[0] === 0x1f && body[1] === 0x8b
    ? new Uint8Array(await new Response(new Response(body).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
    : body;
}
const fileText = async (name) => new TextDecoder().decode(await fileBytes(name));

const world = JSON.parse(await fileText('world.json'));
// The offline file has only a part of the map in it
if (INLINE) {
  for (const key of Object.keys(world.tiles)) if (!INLINE[tileFile(key, world.tiles[key])]) delete world.tiles[key];
  for (const key of Object.keys(world.farFiles)) if (!INLINE[farFile(key, world.farFiles[key])]) delete world.farFiles[key];
}

// What the whole map shares, and the road graph of the tiles held
const GEO = { ...world, roadGraph: { nodes: new Float32Array(world.nodeCount * 2), links: [], names: [] } };
const RG = GEO.roadGraph;

const TILE = world.tileSize;
const tileKey = (ix, iz) => `${ix}_${iz}`;
const tileKeyAt = (x, z) => tileKey(Math.floor(x / TILE), Math.floor(z / TILE));
const tileExists = (key) => Object.hasOwn(world.tiles, key);
/** The tiles there are within `radius` of (x, z), nearest first */
function tilesNear(x, z, radius) {
  const found = [];
  for (let ix = Math.floor((x - radius) / TILE); ix <= Math.floor((x + radius) / TILE); ix++) {
    for (let iz = Math.floor((z - radius) / TILE); iz <= Math.floor((z + radius) / TILE); iz++) {
      const key = tileKey(ix, iz);
      if (!tileExists(key)) continue;
      const dx = Math.max(ix * TILE - x, 0, x - (ix + 1) * TILE), dz = Math.max(iz * TILE - z, 0, z - (iz + 1) * TILE);
      const d = Math.hypot(dx, dz);
      if (d <= radius) found.push({ key, ix, iz, d });
    }
  }
  return found.sort((a, b) => a.d - b.d).map((t) => t.key);
}

const held = new Map(); // key -> tile
const listeners = [];
const nameIds = new Map();
const linkRefs = new Map(); // link id -> [record, how many held tiles have it]
const linkSlot = new Map(); // link id -> its place in RG.links

function addLinkRecord(record) {
  const name = record[3];
  let ni = nameIds.get(name);
  if (ni === undefined) {
    ni = RG.names.length;
    RG.names.push(name);
    nameIds.set(name, ni);
  }
  const [id, ...fields] = record;
  fields[2] = ni;
  fields.id = id;
  linkSlot.set(id, RG.links.length);
  RG.links.push(fields);
  return fields;
}
function removeLinkRecord(id) {
  const slot = linkSlot.get(id);
  const last = RG.links.pop();
  if (last.id !== id) {
    RG.links[slot] = last;
    linkSlot.set(last.id, slot);
  }
  linkSlot.delete(id);
}

function absorb(tile) {
  held.set(tile.key, tile);
  for (let i = 0; i < tile.nodes.length; i += 3) {
    RG.nodes[tile.nodes[i] * 2] = tile.nodes[i + 1];
    RG.nodes[tile.nodes[i] * 2 + 1] = tile.nodes[i + 2];
  }
  for (const l of listeners) l.addTile?.(tile);
  for (const record of tile.links) {
    const known = linkRefs.get(record[0]);
    if (known) { known[1]++; continue; }
    const link = addLinkRecord(record);
    linkRefs.set(record[0], [link, 1]);
    for (const l of listeners) l.addLink?.(link);
  }
}

const fetching = new Map();
function fetchTile(key) {
  if (!fetching.has(key)) {
    const file = tileFile(key, world.tiles[key]);
    const [ix, iz] = key.split('_').map(Number);
    fetching.set(key, fileBytes(file).then((data) => Object.assign(unpackTile(data, world.heights.size, world.ground?.size), { key, ix, iz, bytes: data.length })));
  }
  return fetching.get(key);
}

/** Fetches a tile if it has to, and adds it to every index. Resolves to the tile. */
async function holdTile(key) {
  if (held.has(key)) return held.get(key);
  const tile = await fetchTile(key);
  fetching.delete(key);
  if (!held.has(key)) absorb(tile);
  return tile;
}
// A few at a time: a browser runs out of requests somewhere past a thousand at once
async function holdTiles(keys) {
  const tiles = new Array(keys.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(16, keys.length) }, async () => {
    while (next < keys.length) {
      const i = next++;
      tiles[i] = await holdTile(keys[i]);
    }
  }));
  return tiles;
}

/** Takes a tile out of every index. Roads it shares with another tile stay. */
function releaseTile(key) {
  const tile = held.get(key);
  if (!tile) return;
  held.delete(key);
  for (const record of tile.links) {
    const entry = linkRefs.get(record[0]);
    if (--entry[1] > 0) continue;
    linkRefs.delete(record[0]);
    for (const l of listeners) l.removeLink?.(entry[0]);
    removeLinkRecord(record[0]);
  }
  for (const l of listeners) l.removeTile?.(tile);
}

/** Registers an index of the map: { addTile, removeTile, addLink, removeLink }, told at once of whatever is already held */
function onMap(listener) {
  listeners.push(listener);
  for (const tile of held.values()) listener.addTile?.(tile);
  if (listener.addLink) for (const link of RG.links) listener.addLink(link);
}

// In a set order, whichever order they arrived in: the same tiles build the same things
const heldTiles = () => [...held.values()].sort((a, b) => a.ix - b.ix || a.iz - b.iz);
const isHeld = (key) => held.has(key);
/** Bytes of the tiles held, unpacked: as JavaScript objects they take about three times that (js/memory-estimate.js) */
const heldBytes = () => [...held.values()].reduce((sum, t) => sum + (t.bytes || 0), 0);
/** One of each tile's lists, for all the tiles held together */
const heldList = (field) => heldTiles().flatMap((t) => t[field]);
const TAG_LISTS = ['buses', 'cycles', 'cycleways', 'speeds', 'oneways', 'zebras', 'directions'];
/** What the map says is painted on the road and signed beside it, for all the tiles held */
const heldTags = () => Object.fromEntries(TAG_LISTS.map((name) => [name, heldTiles().flatMap((t) => t.tags[name])]));
/** The trees of all the tiles held, as one set of arrays */
function heldTrees() {
  const tiles = heldTiles();
  const count = tiles.reduce((sum, t) => sum + t.trees.kinds.length, 0);
  const out = { points: new Float32Array(count * 2), kinds: new Uint8Array(count), heights: new Uint8Array(count) };
  let n = 0;
  for (const { trees } of tiles) {
    out.points.set(trees.points, n * 2);
    out.kinds.set(trees.kinds, n);
    out.heights.set(trees.heights, n);
    n += trees.kinds.length;
  }
  return out;
}

// A file for the far land and the map screen, fetched when something first needs it
let farData = null;
const loadFar = () => (farData ||= fileText('far.json.gz').then((text) => Object.assign(GEO, JSON.parse(text))));
const farHeightBytes = await fileBytes('far-heights.bin.gz');
/** One of the far files, by its key in GEO.farFiles */
const fetchFarFile = async (key) => unpackFarFile(await fileBytes(farFile(key, world.farFiles[key])));
let mapData = null;
/** All the roads and blocks for the map screen, fetched when it's first opened */
const loadMapData = () => (mapData ||= fileText('map.json.gz').then((text) => JSON.parse(text)));

if (inNode) {
  await loadFar();
  // Under Node the whole map, unless SYDNEY_TILES says which part: x0,z0,x1,z1 in tiles
  const part = process.env.SYDNEY_TILES?.split(',').map(Number);
  const keys = Object.keys(world.tiles).filter((key) => {
    if (!part) return true;
    const [ix, iz] = key.split('_').map(Number);
    return ix >= part[0] && iz >= part[1] && ix <= part[2] && iz <= part[3];
  });
  for (const tile of await Promise.all(keys.map(fetchTile))) absorb(tile);
  fetching.clear();
}

export { GEO, TILE, farHeightBytes, fetchFarFile, fileBytes, loadMapData, heldBytes, heldList, heldTags, heldTiles, heldTrees, holdTile, holdTiles, isHeld, loadFar, onMap, releaseTile, tileExists, tileKey, tileKeyAt, tilesNear };
