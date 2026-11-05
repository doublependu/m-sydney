// tools/tiles/stable-ids.mjs: every road, node and structure keeps the id the last build gave it.
//
// The generators number nodes in the order they meet OSM's ways, roads by their place in the list of all of them, and
// structures by their first road. Every tile stores those ids, so a road added or taken away anywhere shifted every id after
// it, and a change near the Harbour Bridge rewrote nearly every tile on the map. Here the new road graph is matched to the
// last build's tiles before they're replaced: a road drawn through the same points under the same name keeps its id, a node
// at the same place keeps its id, and a structure keeps the id most of its roads' old structure had. What's new takes the
// next id past the last build's; what's gone leaves a gap, which the game skips.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { tileFile } from '../../js/tiles/paths.js';

const linkKey = (name, dir, flat) => `${name}|${dir}|${flat.join(',')}`;
const posKey = (x, z) => `${x},${z}`;

// Only the JSON part of a tile: its nodes and road records
function tileJson(file) {
  const data = zlib.gunzipSync(fs.readFileSync(file));
  const length = data.readUInt32LE(0);
  return JSON.parse(data.subarray(20, 20 + length).toString('utf8'));
}

/** The last build's roads, nodes and structures, from its tiles in `outDir`; null where there's no whole build there */
export function previousIds(outDir) {
  const worldFile = path.join(outDir, 'world.json');
  if (!fs.existsSync(worldFile)) return null;
  const world = JSON.parse(fs.readFileSync(worldFile, 'utf8'));
  const records = new Map(), nodes = new Map(), blocks = [];
  for (const [key, hash] of Object.entries(world.tiles)) {
    const file = path.join(outDir, tileFile(key, hash));
    if (!fs.existsSync(file)) return null;
    const tile = tileJson(file);
    for (let i = 0; i < tile.nodes.length; i += 3) nodes.set(tile.nodes[i], [tile.nodes[i + 1], tile.nodes[i + 2]]);
    for (const r of tile.links) if (!records.has(r[0])) records.set(r[0], r);
    for (const b of tile.blocks || []) blocks.push({ id: b[4], key: JSON.stringify([b[0], b[1]]) });
  }
  const links = [];
  for (const [id, r] of [...records].sort((a, b) => a[0] - b[0])) {
    const [, a, b, name, , , dir, inner] = r;
    const flat = [...nodes.get(a), ...inner, ...nodes.get(b)];
    links.push({ id, a, b, sid: r[14] || 0, key: linkKey(name, dir, flat) });
  }
  return { links, nodes, blocks, nodeCount: world.nodeCount, structureCount: world.structures.length };
}

/**
 * Ids for the kerb islands (GEO.blocks, in the generator's order), the last build's where one has the same outline: islands are
 * numbered across the map too, so one more anywhere shifted all the rest
 */
export function stableBlockIds(blocks, prev) {
  const oldByKey = new Map();
  for (const o of [...prev.blocks].sort((a, b) => a.id - b.id)) (oldByKey.get(o.key) || oldByKey.set(o.key, []).get(o.key)).push(o.id);
  let next = prev.blocks.reduce((m, o) => Math.max(m, o.id + 1), 0);
  const ids = blocks.map((b) => oldByKey.get(JSON.stringify([b[0], b[1]]))?.shift());
  let added = 0;
  for (let i = 0; i < ids.length; i++) if (ids[i] === undefined) { ids[i] = next++; added++; }
  return { ids, report: `kerb islands ${blocks.length - added} kept, ${added} new` };
}

/**
 * Renumbers the road graph `RG` ({ nodes, links, names }, as tools/build-geodata.mjs writes it) in place to the ids of `prev`
 * (previousIds()). Returns { sidFor(linkIds), report }: sidFor gives a structure, by the (new) ids of its roads, the id it had.
 */
export function stableIds(RG, prev) {
  const N = RG.nodes;
  const newKey = (l) => {
    const [a, b, ni, , , dir, inner] = l;
    return linkKey(RG.names[ni], dir, [N[a * 2], N[a * 2 + 1], ...inner, N[b * 2], N[b * 2 + 1]]);
  };
  // Roads: the same points under the same name, in order where two are alike
  const oldByKey = new Map();
  for (const o of prev.links) (oldByKey.get(o.key) || oldByKey.set(o.key, []).get(o.key)).push(o);
  const linkId = new Array(RG.links.length);
  const matched = new Array(RG.links.length);
  let next = prev.links.reduce((m, o) => Math.max(m, o.id), -1) + 1;
  RG.links.forEach((l, i) => {
    const o = oldByKey.get(newKey(l))?.shift();
    if (o) { linkId[i] = o.id; matched[i] = o; }
  });
  let added = 0;
  RG.links.forEach((l, i) => {
    if (linkId[i] === undefined) { linkId[i] = next++; added++; }
  });

  // Nodes: those of the roads that kept their ids, then any other at the same place
  const nodeId = new Map(), usedNode = new Set();
  const take = (n, old) => {
    if (nodeId.has(n) || usedNode.has(old)) return;
    nodeId.set(n, old);
    usedNode.add(old);
  };
  RG.links.forEach((l, i) => {
    if (!matched[i]) return;
    take(l[0], matched[i].a);
    take(l[1], matched[i].b);
  });
  const oldAt = new Map();
  for (const [id, [x, z]] of [...prev.nodes].sort((a, b) => a[0] - b[0])) (oldAt.get(posKey(x, z)) || oldAt.set(posKey(x, z), []).get(posKey(x, z))).push(id);
  let nextNode = Math.max(prev.nodeCount, [...prev.nodes.keys()].reduce((m, id) => Math.max(m, id + 1), 0));
  let newNodes = 0;
  for (const l of RG.links) {
    for (const n of [l[0], l[1]]) {
      if (nodeId.has(n)) continue;
      const free = (oldAt.get(posKey(N[n * 2], N[n * 2 + 1])) || []).find((id) => !usedNode.has(id));
      if (free !== undefined) take(n, free);
      else { take(n, nextNode++); newNodes++; }
    }
  }

  // The graph, renumbered: a road's id is its place in the list, so the list has gaps where roads went
  const links = [];
  links.length = Math.max(next, linkId.reduce((m, id) => Math.max(m, id + 1), 0));
  RG.links.forEach((l, i) => {
    const r = [...l];
    r[0] = nodeId.get(l[0]);
    r[1] = nodeId.get(l[1]);
    links[linkId[i]] = r;
  });
  const count = [...nodeId.values()].reduce((m, id) => Math.max(m, id + 1), 0);
  const nodes = new Array(count * 2).fill(0);
  for (const [n, id] of nodeId) {
    nodes[id * 2] = N[n * 2];
    nodes[id * 2 + 1] = N[n * 2 + 1];
  }
  RG.links = links;
  RG.nodes = nodes;

  // Structures: the id most of its roads' structure had, unless another has it already
  const oldSid = new Map(prev.links.map((o) => [o.id, o.sid]));
  const given = new Map(), takenSid = new Set();
  let nextSid = prev.structureCount, newStructures = 0;
  function sidFor(ids) {
    const key = [...ids].sort((a, b) => a - b).join(',');
    if (given.has(key)) return given.get(key);
    const votes = new Map();
    for (const id of ids) {
      const s = oldSid.get(id);
      if (s) votes.set(s, (votes.get(s) || 0) + 1);
    }
    let best = 0, most = 0;
    for (const [s, v] of votes) if (v > most || (v === most && s < best)) { best = s; most = v; }
    let sid = best && !takenSid.has(best) ? best : 0;
    if (!sid) { sid = nextSid++; newStructures++; }
    takenSid.add(sid);
    given.set(key, sid);
    return sid;
  }
  const gone = prev.links.length - (RG.links.filter(Boolean).length - added);
  return {
    sidFor,
    report: () => `roads ${RG.links.filter(Boolean).length - added} kept, ${added} new, ${gone} gone; nodes ${nodeId.size - newNodes} kept, ${newNodes} new`,
    // Once findStructures (tools/build-tiles.mjs) has asked for every structure's id
    structureReport: () => `structures ${takenSid.size - newStructures} kept, ${newStructures} new`
  };
}
