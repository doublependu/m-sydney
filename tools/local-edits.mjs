// tools/local-edits.mjs: hand edits to the map, one file per area in tools/local/, applied where the generators read OSM, so every
// later step sees them as if they were OSM's own. tools/data/ isn't in git and OSM changes under us: these are.
//
// An area's file: { name, box: [x0, z0, x1, z1] (the game's frame: where its edits may change tiles, tools/tile-diff.mjs),
//   ways: [{ ids: [OSM way id, ...], expect: { tag: value }, tags: { tag: value | null }, remove: true, why }],
//   buildings: [{ area: [[x, z], ...], kinds: [...], maxHeight, style, why }]: a style of house (js/house-styles.js) for the buildings in
//   an area of those kinds (tools/build-buildings.mjs KIND) and no taller (tools/build-buildings.mjs) }
// `expect` is what the ways' tags were when the edit was made: if OSM has changed them since, the build stops and says so, as the
// edit may no longer be right. A tag set to null is taken away. Each way an edit names is marked `local` (its area's file): the
// build takes in some ways only where an area has been looked at by hand, as bus-only roads (tools/build-geodata.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('./local/', import.meta.url));

/** Every area's edits: [{ file, name, box, ways }] */
export function localAreas() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort().map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) }));
}

/** Applies every area's way edits to OSM's road elements, in place. Returns them, without those removed, and a line to log. */
export function editWays(elements) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const removed = new Set();
  let edited = 0;
  for (const area of localAreas()) {
    for (const edit of area.ways || []) {
      for (const id of edit.ids) {
        const way = byId.get(id);
        if (!way) throw new Error(`tools/local/${area.file}: way ${id} is gone from the snapshot (${edit.why})`);
        for (const [tag, value] of Object.entries(edit.expect || {})) {
          if ((way.tags?.[tag] ?? null) !== value) {
            throw new Error(`tools/local/${area.file}: way ${id} has ${tag}=${way.tags?.[tag]} in OSM now, not ${value}: check the edit (${edit.why})`);
          }
        }
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
  return { elements: removed.size ? elements.filter((e) => !removed.has(e.id)) : elements, summary: `${edited} ways edited by hand, ${removed.size} taken out (tools/local/)` };
}
