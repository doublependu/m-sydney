// The areas tools/build-garden.mjs lays gardens out in: parks by their name in OSM, and boxes (x0, z0, x1, z1) with any boxes left out.
// tools/build-geodata.mjs reads them too: still water in them is the garden's to draw (js/garden.js), not the sea's.
// Each says its kind, checked by hand against photos, which overrides the rule (parkKind()):
// - formal: a park or garden, its paved paths kerbed (asphalt, paving, concrete, timber, a footway that doesn't say), its dirt, gravel,
//   sand and trodden grass tracks: strips worn into the lawn, with no kerb;
// - bush: every path a track.
// `kerbedGravel`: its gravel paths are edged as its paved ones are, not tracks (the Royal Botanic Garden's, in the photos). `kerb`: what its
// raised lawn's kerbs are, concrete or sandstone (the Royal Botanic Garden's, in the photos).
import { bbox, elementRings, pointInRing, ringArea } from './geo-common.mjs';

export const AREAS = [
  { name: 'Royal Botanic Garden', osm: 'Royal Botanic Garden', kind: 'formal', kerbedGravel: true, kerb: 'sandstone' },
  { name: 'The Domain', osm: 'The Domain', kind: 'formal' },
  { name: 'Domain Crescent Precinct', osm: 'Domain Crescent Precinct', kind: 'formal' },
  { name: 'Mrs Macquaries Point', osm: 'Domain Yurong Precinct', kind: 'formal' },
  { name: 'Tarpeian Precinct', osm: 'Domain Tarpeian Precinct', kind: 'formal' },
  // Round the Opera House: not on its podium, which its own model draws (js/model-sites.js)
  { name: 'Bennelong Point', box: [330, -2060, 730, -1640], except: [[448, -1955, 574, -1752]], kind: 'formal' },
  { name: 'Circular Quay', box: [-40, -1720, 470, -1330], kind: 'formal' },
  // Behind Bronte Beach: its promenade and paths, palms and pines (tools/local/bronte.json). No still water in it, so adding it needed no
  // whole build
  { name: 'Bronte Park', osm: 'Bronte Park', kind: 'formal' }
];

// Gates a model draws itself (js/model-sites.js; its script in m-sydney-private's tools/models/), which the garden leaves out: the Queen
// Elizabeth II Gate, the Opera House's
export const MODEL_GATES = [[572, -1721]];

// --- A park's kind, by rule: for parks no one has looked at --------------------------------------------------------------------------
const BUSH_SHARE = 0.5; // of a park that's wood or scrub, for it to be bush

/** Whether an OSM element is wood or scrub */
export const isWood = (t = {}) => /^(wood|scrub|shrubbery)$/.test(t.natural || '') || t.landuse === 'forest';

/**
 * A park's kind by rule, from its tags and how much of it is wood or scrub (0 to 1): bush for a nature reserve, a protected area or a
 * national park, or a park half or more wood; formal otherwise. Hand-picked areas say their own kind (AREAS).
 */
export function parkKind(tags = {}, woodShare = 0) {
  if (tags.leisure === 'nature_reserve' || tags.boundary === 'protected_area' || tags.boundary === 'national_park') return 'bush';
  return woodShare >= BUSH_SHARE ? 'bush' : 'formal';
}

/**
 * How much of a park (its outer rings, [[x, z], ...]) the wood rings cover, 0 to 1: sampled on a grid of about `samples` points in it.
 * `woods`: [{ ring, box }] from OSM's wood and scrub (isWood()).
 */
export function woodShare(rings, woods, samples = 400) {
  const box = bbox(rings.flat());
  const area = rings.reduce((t, r) => t + Math.abs(ringArea(r)), 0);
  const step = Math.max(1, Math.sqrt(area / samples));
  const near = woods.filter((w) => w.box.x1 >= box.x0 && w.box.x0 <= box.x1 && w.box.z1 >= box.z0 && w.box.z0 <= box.z1);
  let inside = 0, wooded = 0;
  for (let x = box.x0 + step / 2; x < box.x1; x += step) {
    for (let z = box.z0 + step / 2; z < box.z1; z += step) {
      if (!rings.some((r) => pointInRing(r, x, z))) continue;
      inside++;
      if (near.some((w) => x >= w.box.x0 && x <= w.box.x1 && z >= w.box.z0 && z <= w.box.z1 && pointInRing(w.ring, x, z))) wooded++;
    }
  }
  return inside ? wooded / inside : 0;
}

/** OSM's wood and scrub in `land`, for woodShare() */
export function woodsOf(land) {
  const out = [];
  for (const e of land) {
    if (!isWood(e.tags)) continue;
    for (const ring of elementRings(e).outer) if (ring.length > 3) out.push({ ring, box: bbox(ring) });
  }
  return out;
}

// --- A garden path's kind ----------------------------------------------------------------------------------------------------------
// Surfaces, as js/garden.js draws them: 0 paving, 1 asphalt, 2 gravel, 3 timber, 4 trodden grass, 5 dirt, 6 sand. Kinds: 0 a footpath, 1
// steps, 2 a cycleway, 3 a track.
const TRACK_SURFACES = new Set([2, 4, 5, 6]);
/** A path's kind in an area of `kind` (formal or bush), from what it is in OSM (0 a footpath, 1 steps, 2 a cycleway) and its surface */
export function pathKind(osmKind, surface, kind, kerbedGravel = false) {
  if (osmKind === 1) return 1;
  if (kind === 'bush') return 3;
  if (surface === 2 && kerbedGravel) return osmKind;
  return TRACK_SURFACES.has(surface) ? 3 : osmKind;
}

// --- A gate's heading ---------------------------------------------------------------------------------------------------------------
/**
 * Which way a gate on a garden's paths faces: the heading (atan2 of x, z) along the path through it. `at`: where it stands, [x, z]; `arms`:
 * the next point out of it along each path that passes it, in the order they were found, each { pt: [x, z], after } (`after`: further
 * along its way than the gate, not before it). Of two or more, the two most nearly in line: where paths meet at a gate, the one that runs
 * straight through it, which way its first arm's way runs. One alone: along its way. Returns { heading, used: the arms it went by, the
 * first first }, or null with none.
 */
export function gateHeading([x, z], arms) {
  if (!arms.length) return null;
  if (arms.length === 1) {
    const { pt: [ax, az], after } = arms[0];
    return { heading: after ? Math.atan2(ax - x, az - z) : Math.atan2(x - ax, z - az), used: [0] };
  }
  const dirs = arms.map(({ pt: [ax, az] }) => {
    const L = Math.hypot(ax - x, az - z) || 1;
    return [(ax - x) / L, (az - z) / L];
  });
  let best = null, straightest = Infinity;
  for (let i = 0; i < arms.length; i++) {
    for (let j = i + 1; j < arms.length; j++) {
      // Two arms in line point opposite ways from the gate: the cosine between them nearest -1
      const cos = dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1];
      if (cos < straightest - 1e-9) {
        straightest = cos;
        best = [i, j];
      }
    }
  }
  // Along the first arm's way: towards it if the way goes on to it from the gate, from it if the way comes from it
  const [a, b] = (arms[best[0]].after ? [best[1], best[0]] : best).map((k) => arms[k].pt);
  return { heading: Math.atan2(b[0] - a[0], b[1] - a[1]), used: best };
}

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
