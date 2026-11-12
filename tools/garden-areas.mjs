// The areas tools/build-garden.mjs lays gardens out in: parks by their name in OSM, and boxes (x0, z0, x1, z1) with any boxes left out.
// tools/build-geodata.mjs reads them too: still water in them is the garden's to draw (js/garden.js), not the sea's.
import { bbox, elementRings, pointInRing } from './geo-common.mjs';

export const AREAS = [
  { name: 'Royal Botanic Garden', osm: 'Royal Botanic Garden' },
  { name: 'The Domain', osm: 'The Domain' },
  { name: 'Domain Crescent Precinct', osm: 'Domain Crescent Precinct' },
  { name: 'Mrs Macquaries Point', osm: 'Domain Yurong Precinct' },
  { name: 'Tarpeian Precinct', osm: 'Domain Tarpeian Precinct' },
  // Round the Opera House: not on its podium, which its own model draws (js/model-sites.js)
  { name: 'Bennelong Point', box: [330, -2060, 730, -1640], except: [[448, -1955, 574, -1752]] },
  { name: 'Circular Quay', box: [-40, -1720, 470, -1330] },
  // Behind Bronte Beach: its promenade and paths, palms and pines (tools/local/bronte.json). No still water in it, so adding it needed no
  // whole build
  { name: 'Bronte Park', osm: 'Bronte Park' }
];

/** Each area with its rings ([[x, z], ...], from OSM's outline or its box), their bounding box, and the boxes left out of it */
export function gardenAreas(land) {
  const areas = AREAS.map((a) => {
    if (a.box) {
      const [x0, z0, x1, z1] = a.box;
      return { ...a, rings: [[[x0, z0], [x1, z0], [x1, z1], [x0, z1]]], except: (a.except || []).map(([ex0, ez0, ex1, ez1]) => ({ x0: ex0, z0: ez0, x1: ex1, z1: ez1 })) };
    }
    const e = land.find((el) => el.tags?.name === a.osm && /^(park|garden)$/.test(el.tags.leisure || ''));
    if (!e) throw new Error(`No park named ${a.osm} in OSM: has it been renamed?`);
    return { ...a, rings: elementRings(e).outer.filter((r) => r.length > 3), except: [] };
  });
  for (const a of areas) a.box = bbox(a.rings.flat());
  return areas;
}

/** Whether (x, z) is in one of `areas`, not counting the boxes left out */
export function inGardenArea(areas, x, z) {
  return areas.some((a) => x >= a.box.x0 && x <= a.box.x1 && z >= a.box.z0 && z <= a.box.z1
    && !a.except.some((b) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) && a.rings.some((r) => pointInRing(r, x, z)));
}
