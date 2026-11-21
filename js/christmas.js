// Which houses have Christmas lights in December (js/season-december.js), and how many:
// - The streets known for them, from the 2025-26 lists (Ella's List, Neighbourhood Media, Urban List, Time Out), STREETS: almost every
//   house, most of them heavily. The houses known for them, HOUSES: that house heavily, and some of its neighbours with it.
// - Every other street with houses: one or two of its houses, at spots along it picked by a hash of its name and its link, so the same
//   houses every load, whichever of the street's squares of lots happen to be worked out.
// - Some suburbs more than others, SUBURBS: a weight that brings more houses to a street and more of them heavy.
// Nothing here knows the game: it's handed a lot's street (a link of js/surfaces.js: its id, name, points and width) and the lot's outline,
// so js/season-december.js can use it without importing the game's modules.

// The streets: [name as the map has it, suburb, middle x, z, m from the middle the street reaches]. Each was geocoded (OSM's Nominatim)
// and matched to the road graph's links of that name; its middle and reach are its links' within 1.2 km.
const STREETS = [
  ['Prince Albert Street', 'Mosman', 2759, -4495, 514],
  ['Magic Grove', 'Mosman', 2557, -4545, 140],
  ['Second Street', 'Ashbury', -7341, 4341, 244],
  ['Elizabeth Street', 'Paddington', 2536, 1036, 361],
  ['First Avenue', 'Willoughby', -1322, -8120, 418],
  ['Second Avenue', 'Willoughby', -1135, -8011, 271],
  ['Third Avenue', 'Willoughby', -1025, -8043, 286],
  ['Fourth Avenue', 'Willoughby', -953, -8142, 493],
  ['Emmett Street', 'Crows Nest', -872, -4698, 129],
  ['Bishop Street', 'Cabarita', -8987, -1683, 130],
  ['Frederick Street', 'Randwick', 4471, 5116, 79],
  ['Kemp Street', 'Mortdale', -10741, 12033, 243],
  ['Rainbow Parade', 'Peakhurst Heights', -12324, 13633, 299],
  ['Grosvenor Road', 'South Hurstville', -7548, 12878, 269],
  ['Bernard Avenue', 'Bardwell Park', -6976, 8104, 82],
  ['Murrumba Place', 'Castle Hill', -21456, -14367, 108],
  ['Panaview Crescent', 'North Rocks', -17698, -8351, 185],
  ['Borgnis Street', 'Davidson', -2830, -14662, 356],
  ['Kambora Avenue', 'Davidson', -2936, -14458, 595],
  ['Sydney Road', 'Hornsby Heights', -13554, -20417, 499],
  ['Strickland Road', 'Guildford', -18778, 1724, 252],
  ['Earl Street', 'Merrylands', -19444, -200, 261],
  ['Hall Road', 'Hornsby', -12734, -16397, 341],
  ['Gondola Road', 'Narrabeen', 5266, -19381, 541]
].map(([name, suburb, x, z, reach]) => ({ name, suburb, x, z, reach }));

// The houses: [street, suburb, number, x, z, exact]. `exact`: the geocoder found the house itself; otherwise it found the street, and the
// point is the street's (the house is guessed there).
const HOUSES = [
  ['Burwood Road', 'Concord', 191, -8761, -288, true],
  ['Braddon Street', 'Concord', 25, -9900, -1708, true],
  ['South Street', 'Tempe', 7, -3255, 6455],
  ['Hixson Street', 'Bankstown', 28, -15203, 8423],
  ['Mitchell Street', 'Glebe', 53, -1320, 1009],
  ['Cameron Street', 'Birchgrove', 48, -2510, -1721],
  ['Boundary Street', 'Darlington', 15, -818, 1932],
  ['Kent Street', 'Newtown', 20, -2357, 3558],
  ['Westbourne Street', 'Stanmore', 59, -3905, 2535],
  ['Beauchamp Road', 'Hillsdale', 48, 3409, 8764],
  ['Hargraves Place', 'Maroubra', 22, 4930, 8263],
  ['Knowles Avenue', 'Matraville', 46, 4131, 8989],
  ['Westminster Road', 'Gladesville', 12, -7972, -4639, true],
  ['Earnshaw Street', 'Gladesville', 27, -7539, -3769, true],
  ['Norfolk Place', 'Carlingford', 27, -17544, -8057, true],
  ['Ashford Avenue', 'Castle Hill', 12, -22308, -12744],
  ['Jenner Road', 'Dural', 1, -18616, -14818, true],
  ['Bettina Place', 'Dural', 6, -20296, -17572, true],
  ['Grasmere Avenue', 'Northmead', 46, -19919, -7477],
  ['Hugh Street', 'Belmore', 34, -11094, 5560],
  ['Fifth Avenue', 'Condell Park', 18, -17625, 8425],
  ['Whittle Avenue', 'Milperra', 15, -19631, 9788],
  ['Karne Street North', 'Roselands', 124, -11921, 8951],
  ['Carter Crescent', 'Padstow', 6, -14517, 12953],
  ['Chamberlain Road', 'Padstow', 81, -14661, 12010],
  ['Stephenson Street', 'Birrong', 17, -16858, 4250],
  ['Faversham Crescent', 'Chipping Norton', 12, -22131, 7580],
  ['Mera Street', 'Guildford', 4, -21498, 826],
  ['Mountford Avenue', 'Guildford', 51, -19930, 558],
  ['Hennessy Avenue', 'Moorebank', 91, -21753, 11206],
  ['Lockwood Street', 'Asquith', 28, -11936, -18444],
  ['Biralee Crescent', 'Beacon Hill', 1, 3645, -13892],
  ['Egan Place', 'Beacon Hill', 12, 3049, -14251],
  ['Childs Circuit', 'Belrose', 36, -520, -15756],
  ['William Street', 'Hornsby', 49, -13075, -17159, true],
  ['Ryan Avenue', 'Hornsby Heights', 18, -13121, -19988, true],
  ['Ingleside Road', 'Ingleside', 2, 3501, -21440],
  ['Bradfield Road', 'Lindfield', 22, -6683, -9586, true],
  ['Chelmsford Avenue', 'Lindfield', 86, -3848, -10562, true],
  ['Baranbali Avenue', 'Seaforth', 4, 2144, -9639],
  ['Nicholson Avenue', 'St Ives', 26, -5142, -13354],
  ['Bimburra Avenue', 'St Ives', 43, -6992, -15761],
  ['Barnardo Close', 'Wahroonga', 4, -11599, -14974, true],
  ['Bella Vista Court', 'Warriewood', 3, 5146, -21939],
  ['Slade Road', 'Bardwell Park', 95, -6784, 7750, true],
  ['Jubilee Avenue', 'Beverley Park', 101, -4958, 12290],
  ['Dunmore Street', 'Bexley', 13, -6080, 9674, true],
  ['Aero Street', 'Brighton-le-Sands', 18, -3994, 9940],
  ['Anglo Square', 'Carlton', 16, -6177, 11941],
  ['Ventura Avenue', 'Narwee', 5, -11827, 10000, true],
  ['Bunbury Avenue', 'Sutherland', 18, -11719, 18252],
  ['Prince Charles Parade', 'Kurnell', 208, 2170, 14872]
].map(([name, suburb, number, x, z, exact = false]) => ({ name, suburb, number, x, z, exact }));

// Suburbs where more houses join in: [name, middle x, z (the map's place), m round it, weight]
const SUBURBS = [
  ['Concord', -9443, -625, 1400, 2.5],
  ['Mosman', 2806, -5207, 1600, 2],
  ['Bankstown', -15198, 7075, 1600, 2],
  ['Castle Hill', -20504, -12951, 2000, 2.5],
  ['Tempe', -3064, 6217, 800, 2]
].map(([name, x, z, r, weight]) => ({ name, x, z, r, weight }));

const ON_STREET = 0.9; // of a known street's houses decorated
const HEAVY_ON_STREET = 0.75; // of those, heavily
const NEAR_HOUSE = 70; // m along its street from a known house that its neighbours join in
const JOIN = 0.45, HEAVY_JOIN = 0.4; // of those neighbours, and of those that do, heavily
const HOUSE_AT = 15; // m from a known house's point to a house's middle, where no lot holds the point
const DENSITY = 1 / 220; // spots a metre of an ordinary street, each a house on one side: one or two to a street of a few blocks
const HEAVY = 0.12; // of an ordinary street's houses, heavily (times the suburb's weight, at most HEAVY_MOST)
const HEAVY_MOST = 0.5;
const MULTI = 0.45; // of houses, multicoloured; the rest warm white
const INTO_LOT = 8; // m past the road's edge that a spot is looked for: into the front yard

/** A number from 0 to 1 for a text and a number, the same every time (FNV-1a, then mixed) */
function hash(text, n = 0) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  h = Math.imul(h ^ (n | 0), 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** The same for a place, to half a metre */
const hashAt = (x, z, n = 0) => hash(`${Math.round(x * 2)},${Math.round(z * 2)}`, n);

/** The suburb's weight at (x, z): 1 outside the suburbs that decorate more */
function suburbWeight(x, z) {
  let w = 1;
  for (const s of SUBURBS) if (Math.hypot(x - s.x, z - s.z) < s.r) w = Math.max(w, s.weight);
  return w;
}

function inRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** How far along a line of points (x, z) is nearest, and how far from it: { s, d } */
function alongLine(pts, x, z) {
  let best = { s: 0, d: Infinity }, run = 0;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i], dx = q.x - p.x, dz = q.z - p.z, L = Math.hypot(dx, dz);
    if (L < 1e-6) continue;
    const t = Math.max(0, Math.min(L, ((x - p.x) * dx + (z - p.z) * dz) / L));
    const d = Math.hypot(p.x + (dx * t) / L - x, p.z + (dz * t) / L - z);
    if (d < best.d) best = { s: run + t, d };
    run += L;
  }
  return best;
}

const anchorCache = new Map(); // link id -> its spots
/**
 * The spots along an ordinary street's link where a house is decorated: each a point INTO_LOT past its edge on one side, and whether that
 * house is heavily decorated. By its name and id, so the same every load.
 */
function anchorsOf(link) {
  const key = `${link.name ?? ''}|${link.id}`;
  const cached = anchorCache.get(key);
  if (cached && cached.pts === link.pts) return cached.spots;
  const pts = link.pts;
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  const mid = pts[Math.floor(pts.length / 2)];
  const weight = suburbWeight(mid.x, mid.z);
  const n = Math.floor(L * DENSITY * weight + hash(key, 0));
  const spots = [];
  for (let k = 0; k < n; k++) {
    let s = hash(key, 3 * k + 1) * L;
    const side = hash(key, 3 * k + 2) < 0.5 ? -1 : 1;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i], seg = Math.hypot(q.x - p.x, q.z - p.z);
      if (s > seg && i < pts.length - 1) {
        s -= seg;
        continue;
      }
      const t = seg > 0 ? Math.min(1, s / seg) : 0, ux = seg > 0 ? (q.x - p.x) / seg : 1, uz = seg > 0 ? (q.z - p.z) / seg : 0;
      const out = (link.width || 6) / 2 + INTO_LOT;
      spots.push({ x: p.x + (q.x - p.x) * t - uz * side * out, z: p.z + (q.z - p.z) * t + ux * side * out,
        heavy: hash(key, 3 * k + 3) < Math.min(HEAVY_MOST, HEAVY * weight) });
      break;
    }
  }
  anchorCache.set(key, { pts, spots });
  if (anchorCache.size > 20000) anchorCache.delete(anchorCache.keys().next().value);
  return spots;
}

/**
 * How a house's lot is decorated: [{ unit, heavy, multi, seed, why }], one for each of its houses that is (a row of terraces drawn as
 * one footprint has a house for each of its `units`, and `unit` says which; a lone house is unit -1). Empty where none is.
 * `lot`: { x, z: its house's middle; pts: its outline ([{ x, z }]); units: null, or [{ pts }] each house's stretch of it; street: the link
 * it faces (js/surfaces.js: { id, name, pts, width }) }. `why`: 'street' (a known street), 'house' (a known house), 'near' (beside one),
 * or 'pick' (one of an ordinary street's).
 */
function decorationsOf(lot) {
  const street = lot.street;
  if (!street?.pts?.length) return [];
  const homes = lot.units?.length ? lot.units.map((u, k) => ({ pts: u.pts, unit: k })) : [{ pts: lot.pts, unit: -1 }];
  for (const h of homes) {
    let x = 0, z = 0;
    for (const p of h.pts) { x += p.x; z += p.z; }
    h.x = x / h.pts.length;
    h.z = z / h.pts.length;
  }
  const out = [];
  const add = (h, heavy, why) => {
    const seed = hashAt(h.x, h.z, 7);
    out.push({ unit: h.unit, heavy, multi: hashAt(h.x, h.z, 8) < MULTI, seed, why });
  };
  const name = street.name;
  // A known street: nine houses in ten
  const known = name && STREETS.find((s) => s.name === name && Math.hypot(lot.x - s.x, lot.z - s.z) < s.reach + 60);
  if (known) {
    for (const h of homes) if (hashAt(h.x, h.z, 1) < ON_STREET) add(h, hashAt(h.x, h.z, 2) < HEAVY_ON_STREET, 'street');
    return out;
  }
  // A known house, and its neighbours along its street
  const houses = name ? HOUSES.filter((s) => s.name === name && Math.hypot(lot.x - s.x, lot.z - s.z) < NEAR_HOUSE + 60) : [];
  if (houses.length) {
    for (const h of homes) {
      const at = houses.find((s) => inRing(h.pts, s.x, s.z)) || (lot.units?.length ? null : houses.find((s) => Math.hypot(h.x - s.x, h.z - s.z) < HOUSE_AT));
      if (at) {
        add(h, true, 'house');
        continue;
      }
      // Along the street from it, either side
      const here = alongLine(street.pts, h.x, h.z);
      const near = houses.some((s) => {
        const there = alongLine(street.pts, s.x, s.z);
        return there.d < 60 ? Math.abs(there.s - here.s) < NEAR_HOUSE : Math.hypot(h.x - s.x, h.z - s.z) < NEAR_HOUSE;
      });
      if (near && hashAt(h.x, h.z, 3) < JOIN) add(h, hashAt(h.x, h.z, 4) < HEAVY_JOIN, 'near');
    }
    if (out.length) return out;
  }
  // An ordinary street: the houses its spots fall in
  for (const spot of anchorsOf(street)) {
    const h = homes.find((c) => inRing(c.pts, spot.x, spot.z));
    if (h && !out.some((d) => d.unit === h.unit)) add(h, spot.heavy, 'pick');
  }
  return out;
}

export { HOUSES, STREETS, SUBURBS, anchorsOf, decorationsOf, hash, hashAt, suburbWeight };
