// The areas tools/build-garden.mjs lays gardens out in: parks by their name in OSM, and boxes (x0, z0, x1, z1) with any boxes left out.
// tools/build-geodata.mjs reads them too: still water in them is the garden's to draw (js/garden.js), not the sea's.
// Each says its kind, checked by hand against photos, which overrides the rule (parkKind()):
// - formal: a park or garden, its paved paths kerbed (asphalt, paving, concrete, timber, a footway that doesn't say), its dirt, gravel,
//   sand and trodden grass tracks: strips worn into the lawn, with no kerb;
// - bush: every path a track.
// `kerbedGravel`: its gravel paths are edged as its paved ones are, not tracks (the Royal Botanic Garden's, in the photos). `kerb`: what its
// raised lawn's kerbs are, concrete or sandstone (the Royal Botanic Garden's, in the photos).
// `register`: its trees are the City of Sydney's register's, every one surveyed, which tools/build-trees.mjs plants wherever the garden is:
// the garden plants no trees of its own there (OSM's are the same trees again), only the small plants in its beds, kept off the register's.
// `rockShore`: its shore is sandstone blocks stepping down to the water (OSM's bare rock, tools/build-sand.mjs), with no parapet along it.
// `natives`: planted with natives only: its woods are bush (natives and grasses, a few gums), and OSM's trees that don't say what they are
// gums, figs, small trees and palms, not the Royal Botanic Garden's exotics.
// `surfaces`: what some of OSM's surfaces are drawn as there, from the aerial imagery ({ concrete: 'concrete', paved: 'paving' }): elsewhere
// concrete and paved are drawn as asphalt, as the older gardens' have always been.
// `woods`: what its woods are planted with (tools/build-garden.mjs MIX), in place of the big trees of the Royal Botanic Garden's `wood`.
// `ground`: what its ground between the paths is planted with, one bed over all its raised lawn, in place of grass (a garden with little
// lawn: the Chinese Garden of Friendship's rockeries and shrubberies).
// `pondEdge`: 'rock' for its ponds edged with rocks (boulders along the water) rather than a sandstone coping.
// `way` (or `relation`): which of OSM's parks of that name it is, by its id, where there's more than one (four are called Moore Park).
import { bbox, elementRings, pointInRing, ringArea, toWorld } from './geo-common.mjs';

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
  { name: 'Bronte Park', osm: 'Bronte Park', kind: 'formal' },
  // The CBD's parks. Hyde Park's halves either side of Park St: paved paths between kerbed lawns, the Archibald Fountain and the Pool of
  // Reflection (OSM's natural=water, a fountain and a reflecting pool, drawn as its ponds), its figs the register's. None of their water is
  // the sea's (small, or tagged as a pool or fountain), so adding them needed no whole build.
  { name: 'Hyde Park North', osm: 'Hyde Park North', kind: 'formal', register: true },
  { name: 'Hyde Park South', osm: 'Hyde Park South', kind: 'formal', register: true },
  // Its lawns on the headland's terraces, kerbed in sandstone; the sandstone blocks themselves are OSM's bare rock (tools/build-sand.mjs),
  // which OSM draws as areas, not as walls
  { name: 'Barangaroo Reserve', osm: 'Barangaroo Reserve', kind: 'formal', kerb: 'sandstone', rockShore: true, natives: true },
  { name: 'Observatory Hill Park', osm: 'Observatory Hill Park', kind: 'formal', register: true },
  { name: 'Wynyard Park', osm: 'Wynyard Park', kind: 'formal', register: true },
  // Under the Harbour Bridge's north end, either side of its approach, down to the pylons and the shore at Milsons Point. OSM's relation
  // holds Bradfield Park North as its fourth ring, so it's one area. North Sydney's: no register. Its sea wall along Milsons Point's shore
  // is the garden's parapet. The bridge's pylons and piers stand in it (js/harbour-bridge.js bridgeFeet()): its plants keep off them.
  { name: 'Bradfield Park', osm: 'Bradfield Park', kind: 'formal' },
  // South of Central: its shared paths pale concrete in the aerial, its trees the register's; its pool and courts stay the map's
  { name: 'Prince Alfred Park', osm: 'Prince Alfred Park', kind: 'formal', register: true, surfaces: { concrete: 'concrete' } },
  // Darling Harbour's, so not in the City's register: their trees are OSM's. Tumbalong Park's lawn is ringed and crossed by concrete paths.
  // The Chinese Garden of Friendship has little lawn: rockeries and shrubberies round its lake, under small ornamental trees, its paths
  // stone, its ponds edged with rocks. Its lake (1,511 m², tagged a pond) isn't the sea's.
  { name: 'Tumbalong Park', osm: 'Tumbalong Park', kind: 'formal', surfaces: { concrete: 'concrete' } },
  { name: 'Chinese Garden of Friendship', osm: 'Chinese Garden of Friendship', kind: 'formal', surfaces: { paved: 'paving', concrete: 'concrete' },
    woods: 'chinese', ground: 'oriental', pondEdge: 'rock' },
  // The eastern suburbs' great park: its avenues and lawns, paved paths between them, gravel and dirt paths through its woods and the
  // bridle track round Grand Drive (OSM's dirt and gravel: tracks), and 12 ponds, five of them lakes with islands. All its water is tagged a
  // pond (or is under 1,500 m²), so none is the sea's and adding it needed no whole build. Greater Sydney Parklands', not the City's: its
  // trees are OSM's, its woods planted as `parkland` (tools/build-garden.mjs MIX).
  { name: 'Centennial Park', osm: 'Centennial Park', kind: 'formal', woods: 'parkland' },
  // Its piece between South Dowling St and Anzac Parade, south of Moore Park Rd, its shared paths asphalt: OSM's way 12281514, not the
  // three other parks of that name
  { name: 'Moore Park', osm: 'Moore Park', way: 12281514, kind: 'formal' }
];

// Gates a model draws itself (js/model-sites.js; its script in m-sydney-private's tools/models/), which the garden leaves out: the Queen
// Elizabeth II Gate, the Opera House's
export const MODEL_GATES = [[572, -1721]];

// --- A park's kind, by rule: for parks no one has looked at --------------------------------------------------------------------------
const BUSH_SHARE = 0.5; // of a park that's wood or scrub, for it to be bush
// ...and for a park by rule to be bush all over: the edges of the zoning's bush and of OSM's wood miss a reserve's own by metres, which
// would leave strips of raised lawn in the forest
const BUSH_ALL = 0.75;

/** Whether an OSM element is wood or scrub */
export const isWood = (t = {}) => /^(wood|scrub|shrubbery)$/.test(t.natural || '') || t.landuse === 'forest';

/**
 * A park's kind by rule, from its tags and how much of it is wood or scrub (0 to 1), or bush land as NSW's zoning has it (pockets()): bush
 * for a nature reserve, a protected area or a national park, or a park half or more wood; formal otherwise. Hand-picked areas say their own
 * kind (AREAS). The parks by rule are laid out by the kind at each point (tools/garden/rule-parks.mjs kindAt()): this is the most of it.
 */
export function parkKind(tags = {}, woodShare = 0) {
  if (bushByTags(tags)) return 'bush';
  return woodShare >= BUSH_SHARE ? 'bush' : 'formal';
}
/** Whether a park's tags say it's bush all over: a nature reserve, a protected area or a national park */
export const bushByTags = (tags = {}) => tags.leisure === 'nature_reserve' || tags.boundary === 'protected_area' || tags.boundary === 'national_park';

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

// NSW's zoning (tools/data/nsw_zoning.json, the councils' plans): the classes that are bush land, where a park is kept as bush. A bushland
// reserve OSM draws no wood in (Hunts Creek Reserve, Lake Parramatta Reserve) is zoned C2 for its bush, and a park's bush along a river
// (Bicentennial Park's mangroves) too, while its lawns and ovals are RE1, public recreation.
const BUSH_ZONES = /^(National Parks and Nature Reserves|Environmental Conservation|Environmental Management)$/;
/**
 * Where a park by rule is bush, whatever its kind: OSM's wood and scrub in `land`, and the land NSW's zoning (`zoning`, its features as
 * fetched) has as bush. Each { outer: [ring, ...], holes: [ring, ...], box, ring (its biggest outer ring, for woodShare()), what }.
 */
export function pockets(land, zoning = []) {
  const out = [];
  for (const e of land) {
    if (!isWood(e.tags)) continue;
    const { outer, inner } = elementRings(e);
    const rings = outer.filter((r) => r.length > 3);
    if (rings.length) out.push({ outer: rings, holes: inner.filter((r) => r.length > 3), what: `wood ${e.type}/${e.id}` });
  }
  for (const f of zoning) {
    if (!BUSH_ZONES.test(f.properties?.LAY_CLASS || '')) continue;
    const polys = f.geometry?.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates : [];
    for (const poly of polys) {
      const [outer, ...holes] = poly.map((r) => r.map(([lon, lat]) => toWorld(lon, lat)));
      if (outer.length > 3) out.push({ outer: [outer], holes: holes.filter((r) => r.length > 3), what: `zone ${f.properties.SYM_CODE}` });
    }
  }
  for (const p of out) {
    p.box = bbox(p.outer.flat());
    p.ring = p.outer.reduce((a, b) => (Math.abs(ringArea(b)) > Math.abs(ringArea(a)) ? b : a));
  }
  return out;
}

// --- A garden path's kind ----------------------------------------------------------------------------------------------------------
// Surfaces, as js/garden.js draws them: 0 paving, 1 asphalt, 2 gravel, 3 timber, 4 trodden grass, 5 dirt, 6 sand, 7 concrete. Kinds: 0 a
// footpath, 1 steps, 2 a cycleway, 3 a track.
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

// --- The parks by rule: every other park with paths -----------------------------------------------------------------------------------
// Which of OSM's parks are: leisure=park and nature_reserve, boundary=protected_area and national_park, and a leisure=garden that's public
// (named, or open to all: access yes, public or permissive). Not a garden tagged private or residential, an unnamed garden with no access
// tag (a house's), a roof garden, or a park named a golf course or a school (the map has none of those of its own). tools/build-garden.mjs
// lays them out by rule (tools/garden/rule-parks.mjs): only it reads them. The sea's rule and tools/build-ponds.mjs read AREAS alone.
/** Whether a park is one by rule, by its tags: { in, why } */
export function parkRule(t = {}) {
  const name = t.name || '';
  const park = /^(park|garden|nature_reserve)$/.test(t.leisure || '') || /^(protected_area|national_park)$/.test(t.boundary || '');
  if (!park) return { in: false, why: 'not a park' };
  if (/golf|school|college|university/i.test(name)) return { in: false, why: 'named a golf course or school' };
  if (t.leisure === 'park') return { in: true, why: 'park' };
  if (t.leisure === 'nature_reserve') return { in: true, why: 'nature reserve' };
  if (t.leisure !== 'garden') return { in: true, why: t.boundary };
  if (/^(private|no)$/.test(t.access || '')) return { in: false, why: 'garden, private' };
  if (/^(residential|private|roof_garden|green_wall)$/.test(t['garden:type'] || '')) return { in: false, why: `garden, ${t['garden:type']}` };
  if (name || /^(yes|public|permissive)$/.test(t.access || '')) return { in: true, why: 'garden, public' };
  return { in: false, why: 'garden, unnamed with no access' };
}

// Parks put right by hand, by OSM's id: `kind` formal or bush, or 'out' (not a park to lay out). `expect`: its tags when the override was
// made, which the build checks, as tools/local/'s edits are; `why`: from what (the aerial, NSW's imagery).
export const PARK_OVERRIDES = [
  // St Peters' old brickpit and tip: lawns on its hills and paved paths between them, its wetlands round the lakes, a few stands of trees.
  // Tagged boundary=hazard for the tip under it, which isn't a reserve: formal by the rule as well (21% wood), here so a later rule
  // can't make it bush
  { id: 'way/174137106', expect: { name: 'Sydney Park', leisure: 'park' }, kind: 'formal',
    why: 'NSW\'s aerial: open lawns over the old tip, its paths asphalt, wetlands round its lakes (tools/build-ponds.mjs\'s), trees in stands' },
  // Bushland OSM draws no wood in and the councils zone public recreation: the rule's bush can't see it
  { id: 'way/1075245506', expect: { name: 'Oatley Park', leisure: 'park' }, kind: 'bush',
    why: 'NSW\'s aerial: eucalypt forest down to Lime Kiln Bay and the Georges River, its one oval and a few clearings; zoned RE1, no wood in OSM' },
  { id: 'way/240278788', expect: { leisure: 'park' }, kind: 'bush',
    why: 'NSW\'s aerial: the forest of the gully west of Hunts Creek Reserve, Carlingford, at (-18820, -7560); unzoned, no wood in OSM' },
  // Read against the aerial over the whole map: forest from edge to edge, or nearly, that OSM draws no wood in and the zoning has as
  // public recreation, so every point of it was formal and its raised lawn ran under the trees, kerbed along its paths
  { id: 'way/23650384', expect: { name: 'Landsdowne Park', leisure: 'park' }, kind: 'bush',
    why: 'NSW\'s aerial: woodland from edge to edge, at (-20338, 5712), a few small clearings' },
  { id: 'relation/2975002', expect: { name: 'Little Salt Pan Reserve', leisure: 'park' }, kind: 'bush',
    why: 'NSW\'s aerial: forest down its creek, at (-15447, 12493), a strip of lawn at its north end' },
  { id: 'way/587216818', expect: { name: 'Galston Recreation Reserve', leisure: 'park' }, kind: 'bush',
    why: 'NSW\'s aerial: forest over about four fifths of it, at (-19014, -21361); its sports fields on its east side' },
  { id: 'way/675577142', expect: { name: 'Dog Pound Creek Conservation Reserve', leisure: 'park' }, kind: 'bush',
    why: 'NSW\'s aerial: forest from edge to edge down its creek, at (-14488, -16574), its tracks through it' },
  { id: 'way/41998477', expect: { name: 'Lieutenant Cantello Reserve', leisure: 'park' }, kind: 'bush',
    why: 'NSW\'s aerial: woodland by the Georges River, at (-20466, 11576), one grassy clearing at its south-west corner' },
  { id: 'way/24430042', expect: { name: 'Deepwater Park', leisure: 'park' }, kind: 'bush',
    why: 'NSW\'s aerial: woodland and scrub by the Georges River, at (-19873, 11399), its ponds and a few clearings in it' },
  { id: 'way/427180424', expect: { name: 'Fred Caterson Reserve', leisure: 'park' }, kind: 'bush',
    why: 'NSW\'s aerial: forest over about three quarters of it, at (-22860, -14131); a strip of sports fields down its middle' },
  { id: 'way/273185778', expect: { name: 'Currawong Reserve', leisure: 'park' }, kind: 'bush',
    why: 'NSW\'s aerial: a strip of forest between houses, at (-17236, -11261), one track through it' }
];

/** A point inside a ring: on its middle row, the middle of the widest stretch inside it */
function insidePoint(ring) {
  const b = bbox(ring), z = (b.z0 + b.z1) / 2;
  const xs = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[j], [bx, bz] = ring[i];
    if ((az > z) !== (bz > z)) xs.push(ax + ((z - az) * (bx - ax)) / (bz - az));
  }
  xs.sort((p, q) => p - q);
  let best = [(b.x0 + b.x1) / 2, z], wide = -1;
  for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1] - xs[k] > wide) { wide = xs[k + 1] - xs[k]; best = [(xs[k] + xs[k + 1]) / 2, z]; }
  return best;
}

/**
 * The parks by rule, from OSM's `land`: every park parkRule() takes, or an override does, but those that are a hand-made area's (the
 * area's own element, or one whose middle is in an area) or on a model site (its middle in one of `cuts`, rings [[x, z], ...]). Each
 * { id: 'way/1', name, kind (parkKind(), or by hand), forced, why, rings (outer), holes, area (m²), middle: [x, z], tags }, in OSM's order;
 * and `left`: [{ id, name, why }] those left out. `kind` is the most of it; `forced` its kind all over, where its tags or an override say,
 * or it's three quarters bush or more.
 * Throws if an override's park is gone or its tags have changed (`overrides`: PARK_OVERRIDES).
 */
export function ruleParks(land, areas, { cuts = [], woods = null, overrides: list = PARK_OVERRIDES } = {}) {
  // (`woods`: [{ ring, box }], the bush its kind is reckoned by: pockets() for the map, OSM's wood alone if not given)
  const own = new Set(areas.map((a) => a.element).filter(Boolean));
  const overrides = new Map(list.map((o) => [o.id, o]));
  const seen = new Set();
  const parks = [], left = [];
  let woodList = woods;
  for (const e of land) {
    const t = e.tags || {};
    const id = `${e.type}/${e.id}`;
    const by = overrides.get(id);
    const rule = parkRule(t);
    if (!by && rule.why === 'not a park') continue;
    if (by) {
      seen.add(id);
      for (const [tag, value] of Object.entries(by.expect || {})) {
        if (t[tag] !== value) throw new Error(`tools/garden-areas.mjs PARK_OVERRIDES: ${id} has ${tag}=${t[tag]} in OSM, not ${value}: check the override (${by.why})`);
      }
    }
    const { outer, inner } = elementRings(e);
    const rings = outer.filter((r) => r.length > 3), holes = inner.filter((r) => r.length > 3);
    if (!rings.length) continue;
    const name = t.name || '';
    const biggest = rings.reduce((p, q) => (Math.abs(ringArea(q)) > Math.abs(ringArea(p)) ? q : p));
    const middle = insidePoint(biggest);
    const out = (why) => left.push({ id, name, why });
    if (own.has(id) || inGardenArea(areas, middle[0], middle[1])) { out('a hand-made area'); continue; }
    if (cuts.some((c) => pointInRing(c, middle[0], middle[1]))) { out('on a model site'); continue; }
    if (by?.kind === 'out') { out(`by hand: ${by.why}`); continue; }
    if (!by && !rule.in) { out(rule.why); continue; }
    woodList ||= woodsOf(land);
    const share = woodShare(rings, woodList);
    const kind = by?.kind ?? parkKind(t, share);
    const area = rings.reduce((s, r) => s + Math.abs(ringArea(r)), 0) - holes.reduce((s, r) => s + Math.abs(ringArea(r)), 0);
    // `forced`: its kind all over, by hand, by its tags or three quarters of it bush; otherwise each point's by where the bush is (kindAt())
    const forced = by?.kind ?? (bushByTags(t) || share >= BUSH_ALL ? 'bush' : null);
    parks.push({ id, name, kind, forced, why: by ? `by hand: ${by.why}` : rule.why, rings, holes, area, middle, tags: t });
  }
  for (const o of list) if (!seen.has(o.id)) throw new Error(`tools/garden-areas.mjs PARK_OVERRIDES: no ${o.id} in OSM (${o.why}): has it gone?`);
  return { parks, left };
}

/** Each area with its rings ([[x, z], ...], from OSM's outline or its box), their bounding box, and the boxes left out of it */
export function gardenAreas(land) {
  const areas = AREAS.map((a) => {
    if (a.box) {
      const [x0, z0, x1, z1] = a.box;
      return { ...a, rings: [[[x0, z0], [x1, z0], [x1, z1], [x0, z1]]], except: (a.except || []).map(([ex0, ez0, ex1, ez1]) => ({ x0: ex0, z0: ez0, x1: ex1, z1: ez1 })) };
    }
    // The first park or garden of that name, or the one with that id
    const id = a.way ?? a.relation, type = a.way !== undefined ? 'way' : 'relation';
    const e = land.find((el) => el.tags?.name === a.osm && /^(park|garden)$/.test(el.tags.leisure || '') && (id === undefined || (el.type === type && el.id === id)));
    if (!e) throw new Error(`No park named ${a.osm}${id === undefined ? '' : ` (${type} ${id})`} in OSM: has it been renamed?`);
    return { ...a, element: `${e.type}/${e.id}`, rings: elementRings(e).outer.filter((r) => r.length > 3), except: [] };
  });
  for (const a of areas) a.box = bbox(a.rings.flat());
  return areas;
}

/** Whether (x, z) is in one of `areas`, not counting the boxes left out */
export function inGardenArea(areas, x, z) {
  return areas.some((a) => x >= a.box.x0 && x <= a.box.x1 && z >= a.box.z0 && z <= a.box.z1
    && !a.except.some((b) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) && a.rings.some((r) => pointInRing(r, x, z)));
}
