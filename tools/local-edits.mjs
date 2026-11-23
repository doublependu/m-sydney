// tools/local-edits.mjs: hand edits to the map, one file per area in tools/local/, applied where the generators read OSM, so every
// later step sees them as if they were OSM's own. tools/data/ isn't in git and OSM changes under us: these are.
//
// An area's file: { name, box: [x0, z0, x1, z1] (the game's frame: where its edits may change tiles, tools/tile-diff.mjs),
//   ways: [{ ids: [OSM way id, ...], expect: { tag: value }, tags: { tag: value | null }, remove: true, why }],
//   buildings: [{ area: [[x, z], ...], kinds: [...], maxHeight, style, why }]: a style of house (js/house-styles.js) for the buildings in
//   an area of those kinds (tools/build-buildings.mjs KIND) and no taller (tools/build-buildings.mjs); or [{ at: [x, z], expect: [lo, hi],
//   height, style, numbers: false, why }]: the one building with that point inside it, which the build has between lo and hi m tall, made
//   `height` m, given that house style, and with no street numbers' plates (js/street-numbers.js; its streets still give its doors and
//   floor), each if it says;
//   plants: [{ kind, height: [lo, hi], every, line: [[x, z], ...] | at: [[x, z], ...], apart, why }]: trees planted by hand in a garden's
//   area (tools/garden-areas.mjs, tools/build-garden.mjs), of the tree system's kinds, in a row every `every` m or at points, none nearer
//   another tree than `apart` m (4 unless it says);
//   rock: [{ ring: [[x, z], ...], why }]: bare rock where OSM has none (tools/build-sand.mjs): on the land, or a shelf in the sea;
//   paving: [{ ring: [[x, z], ...] | circle: [x, z, r], surface: 'paving' | 'asphalt' | 'gravel', why }]: a paved area in a garden's area
//   where OSM has none, paved as OSM's paved areas are there (tools/build-garden.mjs);
//   levels: [{ ids: [OSM way id, ...], at: [[x, z, y], ...], expect: { tag: value }, why }]: a long section of a tunnel or bridge drawn by
//   hand, the ways it runs along in order (tools/build-heights.mjs, tools/heights/levels.mjs): the road passes through each point at its
//   height y and runs at a straight grade between two, and the solve fits the roads round it. Each point lies on one of the ways;
//   water: [{ id: 'way/1' | 'relation/1', sea: true | false, expect: { tag: value }, why }]: a water area the sea's rule
//   (tools/sea-water.mjs seaWaters()) reads wrong, put in the sea (drawn at its level, tools/build-geodata.mjs) or taken out of it (a pond,
//   tools/build-ponds.mjs); or [{ id, pond: true | false, expect, why }]: still water the ponds' rule (pondWaters()) reads wrong, drawn as
//   a pond (a quarry's settling pond, a lake tagged as coming and going) or not (a basin that's dry ground, a tank);
//   move: [{ id: OSM way id, points: [[x, z], ...], expect: { from: [x, z], to: [x, z] }, why }]: a road OSM draws where it overlaps
//   another, moved: each of the way's nodes, in OSM's order and ends included, to its point. A node moves for every way through it, so
//   a junction takes its other roads with it; two edits moving one node must agree. `expect` is where its first and last nodes are in
//   OSM: if they've moved more than half a metre, or the way has another number of nodes, the build stops;
//   streets: [{ address, road, expect: [lo, hi], why }]: a street G-NAF's addresses name (`address`) that OSM spells otherwise (`road`),
//   for a building whose addresses' street isn't found under its own name near it (tools/addresses.mjs). The build stops if the number
//   of buildings that find their street by it isn't between lo and hi;
//   cover: [{ ring: [[x, z], ...], top, why }]: an area where a tunnel is under cover whatever the ground over it (a land bridge, a lid),
//   read when the tiles are made (tools/tiles/derive.mjs, deriveTunnels() in js/surfaces.js): a tunnel open at an end is open only till
//   its road goes under the ring, and one whose end is under it keeps a metre open there for its mouth. Draw it clear of every other
//   tunnel's open ends, which it would close: over a stretch the ground already covers, it changes nothing. With `top` (m), the ground
//   inside it is raised to at least that much over the ceiling of each tunnel under it, away from their ends
//   (tools/tiles/grade-ground.mjs), where the tube would otherwise be seen into from above }
// `expect` is what the ways' tags were when the edit was made: if OSM has changed them since, the build stops and says so, as the
// edit may no longer be right. A tag set to null is taken away. Each way an edit names is marked `local` (its area's file): the
// build takes in some ways only where an area has been looked at by hand, as bus-only roads (tools/build-geodata.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromWorld, toWorld } from './geo-common.mjs';

const DIR = fileURLToPath(new URL('./local/', import.meta.url));

/** Every area's edits: [{ file, name, box, ways }] */
export function localAreas() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort().map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) }));
}

/** Stops the build if a way an edit names is gone from the snapshot, or its tags aren't what the edit says they were */
function checkWay(area, edit, way, id) {
  if (!way) throw new Error(`tools/local/${area.file}: way ${id} is gone from the snapshot (${edit.why})`);
  for (const [tag, value] of Object.entries(edit.expect || {})) {
    if ((way.tags?.[tag] ?? null) !== value) {
      throw new Error(`tools/local/${area.file}: way ${id} has ${tag}=${way.tags?.[tag]} in OSM now, not ${value}: check the edit (${edit.why})`);
    }
  }
}

const ON_WAY = 3; // m: a level's point further than this from all its ways means OSM has moved them since the level was drawn
/**
 * Every area's levels, checked against OSM's road elements: [{ name, ways: [[[x, z], ...], ...], at: [[x, z, y], ...] }], each way's
 * points in the game's frame by toWorld(lon, lat). The build stops if a way named is gone, its `expect` fails, or a point is off its ways.
 */
export function localLevels(elements, toWorld, areas = localAreas()) {
  moveNodes(elements, localMoves(elements, areas));
  const byId = new Map(elements.map((e) => [e.id, e]));
  const out = [];
  for (const area of areas) {
    for (const [n, edit] of (area.levels || []).entries()) {
      const ways = edit.ids.map((id) => {
        const way = byId.get(id);
        checkWay(area, edit, way, id);
        return way.geometry.map((g) => toWorld(g.lon, g.lat));
      });
      const name = `tools/local/${area.file}, level ${n + 1} (${edit.why})`;
      for (const [x, z] of edit.at) {
        let d = Infinity;
        for (const pts of ways) {
          for (let i = 1; i < pts.length; i++) {
            const [ax, az] = pts[i - 1], [bx, bz] = pts[i], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
            d = Math.min(d, Math.hypot(ax + dx * t - x, az + dz * t - z));
          }
        }
        if (d > ON_WAY) throw new Error(`${name}: its point (${x}, ${z}) is ${d.toFixed(1)} m off its ways in OSM now: check the edit`);
      }
      out.push({ name, ways, at: edit.at });
    }
  }
  return out;
}

const RING_POINTS = 3;
const MAX_TOP = 3; // m: more over a tube's ceiling than a land bridge's soil and slab
/** Every area's covers, checked: [{ ring: [[x, z], ...], top, why, file }]. The build stops on a ring that isn't one, a top that isn't
 *  a few metres, or one with no `why` */
export function localCovers(areas = localAreas()) {
  return areas.flatMap((area) => (area.cover || []).map((edit, n) => {
    const name = `tools/local/${area.file}, cover ${n + 1}`;
    if (!edit.why) throw new Error(`${name}: needs a why`);
    if (!Array.isArray(edit.ring) || edit.ring.length < RING_POINTS || !edit.ring.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) {
      throw new Error(`${name}: its ring needs ${RING_POINTS} or more points [x, z] in the game's frame (${edit.why})`);
    }
    if (edit.top !== undefined && !(edit.top >= 0 && edit.top <= MAX_TOP)) throw new Error(`${name}: its top is m over a tube's ceiling, 0 to ${MAX_TOP} (${edit.why})`);
    return { ring: edit.ring, top: edit.top || 0, why: edit.why, file: area.file };
  }));
}

/** Every area's water edits: [{ key: 'way/1' | 'relation/1', sea or pond, expect, why, file }]. tools/sea-water.mjs checks them against OSM. */
export function localWater(areas = localAreas()) {
  return areas.flatMap((area) => (area.water || []).map((edit) => {
    if (!/^(way|relation)\/\d+$/.test(edit.id) || (typeof edit.sea === 'boolean') === (typeof edit.pond === 'boolean')) {
      throw new Error(`tools/local/${area.file}: a water edit needs an id ('way/1' or 'relation/1') and one of sea or pond, true or false (${edit.why})`);
    }
    if (!edit.why) throw new Error(`tools/local/${area.file}: the water edit for ${edit.id} needs a why`);
    return { key: edit.id, ...(typeof edit.sea === 'boolean' ? { sea: edit.sea } : { pond: edit.pond }), expect: edit.expect, why: edit.why, file: area.file };
  }));
}

const MOVE_ENDS = 0.5; // m: a moved way's end further than this from where its edit expects it means OSM has moved it since
const SAME_PLACE = 0.05; // m two edits moving one node may differ by
/**
 * Every area's moves, checked against OSM's road elements as the snapshot has them (before any move): Map(node id -> { x, z, name }),
 * each moved node's new place in the game's frame. The build stops if a way is gone, has another number of nodes than the edit has
 * points, its ends aren't where the edit expects them, or two edits move one node to different places.
 */
export function localMoves(elements, areas = localAreas()) {
  const byId = new Map(elements.filter((e) => e.nodes).map((e) => [e.id, e]));
  const moved = new Map();
  for (const area of areas) {
    for (const edit of area.move || []) {
      const name = `tools/local/${area.file}, the move of way ${edit.id} (${edit.why})`;
      const way = byId.get(edit.id);
      if (!way) throw new Error(`${name}: the way is gone from the snapshot`);
      if (!Array.isArray(edit.points) || edit.points.length !== way.nodes.length) {
        throw new Error(`${name}: OSM has ${way.nodes.length} nodes on it now and the edit ${edit.points?.length} points: check the edit`);
      }
      const ends = [way.geometry[0], way.geometry[way.geometry.length - 1]].map((g) => toWorld(g.lon, g.lat));
      for (const [end, want, which] of [[ends[0], edit.expect?.from, 'first'], [ends[1], edit.expect?.to, 'last']]) {
        if (!Array.isArray(want)) throw new Error(`${name}: needs expect: { from: [x, z], to: [x, z] }, where its ends are in OSM`);
        const d = Math.hypot(end[0] - want[0], end[1] - want[1]);
        if (d > MOVE_ENDS) throw new Error(`${name}: its ${which} node is at (${end.map((v) => v.toFixed(1)).join(', ')}) in OSM now, ${d.toFixed(1)} m from where the edit expects it: check the edit`);
      }
      way.nodes.forEach((n, i) => {
        const [x, z] = edit.points[i];
        const [ox, oz] = toWorld(way.geometry[i].lon, way.geometry[i].lat);
        if (Math.hypot(x - ox, z - oz) < 0.02) return; // left where OSM has it
        const had = moved.get(n);
        if (had && Math.hypot(had.x - x, had.z - z) > SAME_PLACE) {
          throw new Error(`${name}: moves node ${n} to (${x}, ${z}), and ${had.name} to (${had.x}, ${had.z})`);
        }
        moved.set(n, { x, z, name });
      });
    }
  }
  return moved;
}

/** Puts each node `moved` names where it says, in every element that has it (ways' geometry, and OSM's nodes), in place. Returns how many */
export function moveNodes(elements, moved) {
  let n = 0;
  if (!moved.size) return n;
  for (const e of elements) {
    if (e.type === 'node') {
      const m = moved.get(e.id);
      if (m) {
        [e.lon, e.lat] = fromWorld(m.x, m.z);
        n++;
      }
      continue;
    }
    if (!e.nodes || !e.geometry) continue;
    for (let i = 0; i < e.nodes.length; i++) {
      const m = moved.get(e.nodes[i]);
      if (!m) continue;
      const [lon, lat] = fromWorld(m.x, m.z);
      e.geometry[i] = { lon, lat };
      n++;
    }
  }
  return n;
}

/**
 * Applies every area's way edits to OSM's road elements, in place: tags, ways taken out, and moves. Returns them, without those removed,
 * a line to log, and the nodes moved (localMoves()), for anything else that has them (OSM's nodes: moveNodes()).
 */
export function editWays(elements, areas = localAreas()) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const removed = new Set();
  let edited = 0;
  const moved = localMoves(elements, areas);
  moveNodes(elements, moved);
  for (const area of areas) {
    for (const edit of area.ways || []) {
      for (const id of edit.ids) {
        const way = byId.get(id);
        checkWay(area, edit, way, id);
        if (edit.remove) removed.add(id);
        way.tags = { ...way.tags };
        way.local = area.file;
        for (const [tag, value] of Object.entries(edit.tags || {})) {
          if (value === null) delete way.tags[tag];
          else way.tags[tag] = value;
        }
        edited++;
      }
    }
  }
  const summary = `${edited} ways edited by hand, ${removed.size} taken out, ${moved.size} nodes moved (tools/local/)`;
  return { elements: removed.size ? elements.filter((e) => !removed.has(e.id)) : elements, summary, moved };
}
