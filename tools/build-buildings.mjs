// tools/build-buildings.mjs: writes js/building-geodata.js and its gzip asset from the Overture snapshot.
// Height comes from the first of: a surveyed height, floors, the hand table below, the median of neighbours of the same
// sort. The City of Sydney's "height in storeys" layer is a planning control, not a measurement, so it only caps guesses.
// A tower's real height and shape are often only in its building parts, the building record holding just its podium: each
// part taller than the building's own record comes out as a piece stacked on top of it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { dataPath, jsonLines, Raster, DETAIL_BOUNDS as B, inDetail, load, rdpRing, ringArea, toWorld } from './geo-common.mjs';
import { USE, ZONE, loadPlaces } from './population/places.mjs';
import { HOUSE_STYLES, STOREY, STYLE, pick } from '../js/house-styles.js';
import { localAreas } from './local-edits.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = process.argv[2] || path.join(ROOT, 'tools/data/generated/building-geodata.js');
const PRECISION = 0.5;
const SKIP = new Set(['roof', 'carport', 'parking', 'canopy', 'shelter', 'bridge_structure', 'stadium_roof']);
const HOUSE = new Set(['house', 'terrace', 'detached', 'semidetached_house', 'bungalow', 'cabin', 'residential']);
const FLATS = new Set(['apartments', 'dormitory']);
const WORK = new Set(['commercial', 'office', 'retail', 'hotel', 'supermarket', 'kiosk']);
const SHED = new Set(['garage', 'garages', 'shed', 'industrial', 'warehouse', 'service', 'boathouse', 'greenhouse', 'toilets', 'barn', 'hut']);
const CIVIC = new Set(['church', 'cathedral', 'chapel', 'school', 'university', 'college', 'hospital', 'train_station', 'civic', 'government', 'public', 'library', 'museum', 'theatre']);
const KIND = { other: 0, house: 1, flats: 2, work: 3, shed: 4, civic: 5 };

// Large buildings the survey has no height for (roof heights in metres, checked by eye against neighbours)
const HEIGHTS = {
  'International Convention Centre Sydney': 40, 'ICC Sydney Theatre': 40, 'Paddy\'s Markets': 18, 'Market City': 35, 'Sydney Fish Market': 12,
  'Australian Museum': 24, 'Art Gallery of New South Wales': 20, 'State Library of New South Wales': 26, 'Queen Victoria Building': 34,
  'Sydney Town Hall': 42, 'Central Station': 18, 'Sydney Terminal': 18, 'Star City': 38, 'The Star': 38
};

// What the parts get wrong, in metres, checked against published heights
const TOP_FIXES = { 'Chifley Tower': 244, 'The Galeries': 243, 'One Circular Quay': 222, 'World Square': 170 };
// Sydney Tower is modelled by js/landmarks.js, standing in Westfield's parts
const SYDNEY_TOWER = { x: 143, z: -311, reach: 30 };
// Storeys of a part that gives only a count: apartments, mostly. World Tower's 83 come to 230 m.
const PART_STOREY = 2.8;

const rows = [...jsonLines(dataPath('overture_syd.json'))];
const partRows = fs.existsSync(dataPath('overture_parts.json')) ? [...jsonLines(dataPath('overture_parts.json'))] : [];
const digest = (() => {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(dataPath('overture_syd.json'), 'r');
  const chunk = Buffer.alloc(16 * 1048576);
  for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0;) hash.update(chunk.subarray(0, n));
  fs.closeSync(fd);
  return hash.digest('hex');
})();
const storeys = new Raster(B.x0, B.z0, B.x1, B.z1, 4);
for (const f of load('cos_storeys.json')) {
  const n = parseInt(f.properties.Storeys, 10);
  if (!n || !f.geometry) continue;
  for (const poly of f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates) storeys.fillRing(poly[0].map(([lon, lat]) => toWorld(lon, lat)), n);
}

const quantized = (ring) => {
  const pts = [];
  for (const [x, z] of ring) {
    const p = [Math.round(x / PRECISION), Math.round(z / PRECISION)];
    if (!pts.length || pts[pts.length - 1][0] !== p[0] || pts[pts.length - 1][1] !== p[1]) pts.push(p);
  }
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  return pts;
};
const kindOf = (b) => {
  const c = b.class || '';
  if (HOUSE.has(c)) return KIND.house;
  if (FLATS.has(c)) return KIND.flats;
  if (WORK.has(c)) return KIND.work;
  if (SHED.has(c) || b.subtype === 'outbuilding') return KIND.shed;
  if (CIVIC.has(c) || ['civic', 'education', 'religious', 'medical', 'transportation', 'entertainment'].includes(b.subtype)) return KIND.civic;
  if (b.subtype === 'residential') return KIND.house;
  if (b.subtype === 'commercial') return KIND.work;
  return KIND.other;
};

// A footprint in world coordinates, simplified, as quantized rings: { polygons, area, cx, cz } or null
function footprintOf(g) {
  g = typeof g === 'string' ? JSON.parse(g) : g;
  const polygons = [];
  let area = 0, sx = 0, sz = 0, n = 0;
  for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.coordinates) {
    const rings = poly.map((ring) => ring.map(([lon, lat]) => toWorld(lon, lat)).slice(0, -1));
    const outer = rdpRing(rings[0], 0.4);
    if (outer.length < 3) continue;
    const a = Math.abs(ringArea(outer));
    area += a;
    for (const [x, z] of outer) { sx += x; sz += z; n++; }
    if (ringArea(outer) < 0) outer.reverse();
    const holes = rings.slice(1).filter((r) => Math.abs(ringArea(r)) > 6).map((r) => {
      const s = rdpRing(r, 0.4);
      if (ringArea(s) > 0) s.reverse();
      return quantized(s);
    }).filter((r) => r.length >= 3);
    const q = quantized(outer);
    if (q.length >= 3) polygons.push([q, ...holes]);
  }
  if (!polygons.length || area < 12 || !n) return null;
  return { polygons, area, cx: sx / n, cz: sz / n };
}

const buildings = [];
for (const b of rows) {
  if (b.is_underground || SKIP.has(b.class)) continue;
  const shape = footprintOf(b.g);
  if (!shape || !inDetail(shape.cx, shape.cz)) continue;
  buildings.push({ b, ...shape, kind: kindOf(b) });
}

// --- Homes, flats and shops ---------------------------------------------------------------------------------------------
// Most outlines in the suburbs come with no use: Microsoft's machine-learned ones. The Census says what each Mesh Block is for and how
// many homes it has, and the councils' zoning what may be built there (tools/build-population.mjs). A building of no use in a block of
// homes is a house, or flats if it's big and the block has more homes than buildings; in a block of shops and offices, a shop. Each
// home then gets a style of house by where it is (js/house-styles.js), the same along most of a street.
const PLACES_FILE = path.join(ROOT, 'tools/data/generated/places.bin.gz');
const places = fs.existsSync(PLACES_FILE) ? loadPlaces(PLACES_FILE) : null;
if (!places) console.warn('[buildings] no places.bin.gz (node tools/build-population.mjs): buildings of no use stay so');
const hash = (...values) => {
  let h = 2166136261;
  for (const v of values) { h ^= Math.round(v * 16) & 0xffffffff; h = Math.imul(h, 16777619); h ^= h >>> 13; }
  return (h >>> 0) / 4294967296;
};
// The mix of styles in each group of suburbs, by the ABS's SA4 (the first three digits of a Mesh Block's SA1): the period most of
// its houses were built in (ai/plan_4.md, "Sydney's houses")
const S = STYLE;
const HOUSE_MIX = {
  117: [[S['Victorian terrace'], 7], [S.Federation, 1], [S['Project home'], 2]], // City and Inner South
  118: [[S['Victorian terrace'], 3], [S.Federation, 3], [S['California bungalow'], 2], [S['Project home'], 2]], // Eastern Suburbs
  120: [[S['Victorian terrace'], 3], [S.Federation, 3.5], [S['California bungalow'], 2.5], [S['Project home'], 1]], // Inner West
  121: [[S.Federation, 3.5], [S['California bungalow'], 2], [S['Triple-fronted brick veneer'], 2.5], [S['Project home'], 2]], // North Sydney and Hornsby
  122: [[S['Post-war fibro'], 2], [S['Triple-fronted brick veneer'], 2.5], [S['Project home'], 2.5], [S['Beach house'], 2], [S['California bungalow'], 1]], // Northern Beaches
  119: [[S['California bungalow'], 3.5], [S['Post-war fibro'], 2.5], [S['Triple-fronted brick veneer'], 2], [S['Project home'], 2]], // Inner South West
  128: [[S['Post-war fibro'], 3], [S['Triple-fronted brick veneer'], 3.5], [S['Project home'], 2.5], [S['Beach house'], 1]], // Sutherland
  125: [[S['Post-war fibro'], 2.5], [S['California bungalow'], 1.5], [S['Triple-fronted brick veneer'], 3], [S['Project home'], 3]], // Parramatta
  126: [[S['Triple-fronted brick veneer'], 4], [S['Post-war fibro'], 2], [S['California bungalow'], 1.5], [S['Project home'], 2.5]] // Ryde
};
const OTHER_MIX = [[S['Triple-fronted brick veneer'], 3.5], [S['Project home'], 3.5], [S['Post-war fibro'], 1.5], [S['California bungalow'], 1.5]];
const OLD_FLATS = new Set(['117', '118', '120', '121', '122']); // where the walk-ups are as often inter-war as 1960s
const TERRACE_SUBURBS = new Set(['117', '118', '120', '121']);
const SAME_STREET = 0.65; // of a block's houses, how many share its style
// The CBD keeps the look it had: its buildings of no use stay as they were (ai/plan_4.md, Phase I)
const CBD = new Set(['Sydney (North) - Millers Point', 'Sydney (South) - Haymarket']);
// How wide and long a footprint is, along its longest wall
function shapeOf(r) {
  const ring = r.polygons[0][0].map(([x, z]) => [x * PRECISION, z * PRECISION]);
  let best = 0, ux = 1, uz = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    const L = Math.hypot(bx - ax, bz - az);
    if (L > best) { best = L; ux = (bx - ax) / L; uz = (bz - az) / L; }
  }
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [x, z] of ring) {
    const u = x * ux + z * uz, v = -x * uz + z * ux;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  return { long: Math.max(u1 - u0, v1 - v0), wide: Math.min(u1 - u0, v1 - v0) };
}
const placeStats = { houses: 0, flats: 0, shops: 0, civic: 0, sheds: 0, styled: {} };
if (places) {
  const homeSized = new Map(); // Mesh Block -> buildings of a home's size in it
  for (const r of buildings) {
    r.block = places.blockIdAt(r.cx, r.cz);
    r.zone = places.zoneAt(r.cx, r.cz);
    if (r.block >= 0 && r.area >= 40 && r.kind !== KIND.shed) homeSized.set(r.block, (homeSized.get(r.block) || 0) + 1);
  }
  for (const r of buildings) {
    const block = r.block >= 0 ? places.blocks[r.block] : null;
    const use = block?.use || 0;
    if (CBD.has(block?.sa2)) continue;
    if (r.kind === KIND.other) {
      const homesHere = use === USE.Residential || (!use && [ZONE.houses, ZONE.medium, ZONE.flats].includes(r.zone));
      if (homesHere) {
        const perBuilding = block ? block.dwellings / Math.max(1, homeSized.get(r.block) || 0) : 1;
        if (r.area < 30) { r.kind = KIND.shed; placeStats.sheds++; }
        else if (r.area >= 700 || (r.area >= 300 && (perBuilding > 1.8 || r.zone === ZONE.flats || r.zone === ZONE.medium))) { r.kind = KIND.flats; placeStats.flats++; }
        else { r.kind = KIND.house; placeStats.houses++; }
      } else if (use === USE.Commercial || r.zone === ZONE.centre || r.zone === ZONE.office) {
        if (r.area < 1500) { r.kind = KIND.work; placeStats.shops++; }
      } else if (use === USE.Education || use === USE['Hospital/Medical']) { r.kind = KIND.civic; placeStats.civic++; }
      else if ((use === USE.Parkland || use === USE.Transport || use === USE.Water) && r.area < 60) { r.kind = KIND.shed; placeStats.sheds++; }
    }
    // A style for homes and small shops of the size of a house or a walk-up, with no height that says they're something else
    if (r.b.height > 16 || r.b.num_floors > 4 || !block) continue;
    const sa4 = (block.sa1 || '').slice(0, 3);
    const t = hash(r.cx, r.cz, 7);
    if (r.kind === KIND.house) {
      const { long, wide } = shapeOf(r);
      if (wide < 7 && long > wide * 1.6) r.style = TERRACE_SUBURBS.has(sa4) ? S['Victorian terrace'] : S['Project home'];
      else {
        const mix = HOUSE_MIX[sa4] || OTHER_MIX;
        r.style = t < SAME_STREET ? pick(mix, hash(r.block, 11)) : pick(mix, hash(r.cx, r.cz, 13));
      }
    } else if (r.kind === KIND.flats && r.area < 1500) {
      r.style = hash(r.block, 17) < (OLD_FLATS.has(sa4) ? 0.5 : 0.2) ? S['Inter-war flats'] : S['Walk-up flats'];
    } else if (r.kind === KIND.work && r.area < 800 && (use === USE.Commercial || r.zone === ZONE.centre)) {
      r.style = S['Shop-top terrace'];
    }
    if (r.style) placeStats.styled[HOUSE_STYLES[r.style].name] = (placeStats.styled[HOUSE_STYLES[r.style].name] || 0) + 1;
  }
}

// Hand edits (tools/local/): a style of house given to the buildings of an area, of the kinds and no taller than it says. The style then
// says how many storeys a building of no measured height has, and its roof. (Edits of one building, by a point in it, come later.)
{
  const inArea = (poly, x, z) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ax, az] = poly[i], [bx, bz] = poly[j];
      if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) c = !c;
    }
    return c;
  };
  const kindName = Object.fromEntries(Object.entries(KIND).map(([name, k]) => [k, name]));
  for (const area of localAreas()) {
    for (const edit of area.buildings || []) {
      if (!edit.style || !edit.area) continue;
      const style = STYLE[edit.style];
      if (!style) throw new Error(`tools/local/${area.file}: no house style called ${edit.style} (js/house-styles.js)`);
      let n = 0;
      for (const r of buildings) {
        if (r.part || !inArea(edit.area, r.cx, r.cz) || !edit.kinds.includes(kindName[r.kind])) continue;
        if ((r.b.height ?? 0) > edit.maxHeight || (r.b.num_floors ?? 0) > 4) continue;
        r.kind = KIND.house;
        r.style = style;
        n++;
      }
      console.log(`[buildings] tools/local/${area.file}: ${n} buildings given the ${edit.style} style`);
    }
  }
}

// Known heights, then neighbours for the rest
const CELL = 64;
const known = new Map();
const put = (r) => {
  const k = Math.floor(r.cx / CELL) * 100000 + Math.floor(r.cz / CELL);
  if (!known.has(k)) known.set(k, []);
  known.get(k).push(r);
};
const stats = { surveyed: 0, floors: 0, table: 0, neighbours: 0, typical: 0, capped: 0, withParts: 0, parts: 0 };
// The parts of each building that say how tall they are
const partsOf = new Map();
for (const p of partRows) {
  const top = p.height > 1 ? p.height : p.num_floors > 0 ? p.num_floors * PART_STOREY + 0.6 : 0;
  if (!top) continue;
  const shape = footprintOf(p.g);
  if (!shape || Math.hypot(shape.cx - SYDNEY_TOWER.x, shape.cz - SYDNEY_TOWER.z) < SYDNEY_TOWER.reach) continue;
  const bottom = p.min_height > 0 ? p.min_height : p.min_floor > 0 ? p.min_floor * PART_STOREY : 0;
  if (!partsOf.has(p.building_id)) partsOf.set(p.building_id, []);
  partsOf.get(p.building_id).push({ ...shape, top, bottom });
}
for (const r of buildings) {
  const { height, num_floors: floors, name } = r.b;
  // Whatever the building's own record says, or low enough to be its podium when it says nothing and its parts do
  if (!height && !floors && partsOf.has(r.b.id)) { r.height = Math.min(12, ...partsOf.get(r.b.id).map((p) => p.top)); }
  else if (height > 1) { r.height = height; stats.surveyed++; put(r); }
  else if (floors > 0) { r.height = floors * (r.kind === KIND.work ? 3.8 : 3.3) + 0.6; stats.floors++; put(r); }
  else if (HEIGHTS[name]) { r.height = HEIGHTS[name]; stats.table++; put(r); }
}
const median = (v) => v.sort((p, q) => p - q)[v.length >> 1];
const missingLarge = [];
for (const r of buildings) {
  if (r.height) continue;
  const near = [];
  const ix = Math.floor(r.cx / CELL), iz = Math.floor(r.cz / CELL);
  for (let i = ix - 2; i <= ix + 2; i++) {
    for (let j = iz - 2; j <= iz + 2; j++) {
      for (const o of known.get(i * 100000 + j) || []) {
        // Of about the same size and sort: a small outline among towers takes its height from small buildings, not from them
        if (Math.hypot(o.cx - r.cx, o.cz - r.cz) < 130 && o.area < r.area * 3 && o.area > r.area / 3
          && (o.kind === r.kind || (r.kind === KIND.other && o.kind !== KIND.shed))) near.push(o.height);
      }
    }
  }
  let h;
  const style = HOUSE_STYLES[r.style || 0];
  if (style) {
    // To its eaves, at its style's number of storeys: a pitched roof stands on top
    const storeys = style.storeys.length > 1 && r.style === STYLE['Project home'] && r.area < 160 ? 1 : pick(style.storeys, hash(r.cx, r.cz, 23));
    h = storeys * STOREY + (style.roofs ? 0.2 : 1.1);
    stats.styled = (stats.styled || 0) + 1;
  } else if (r.kind === KIND.shed || r.area < 28) h = 3.4;
  else if (near.length >= 3) { h = median(near); stats.neighbours++; }
  else { h = r.kind === KIND.house ? 7.4 : r.area < 180 ? 7.4 : r.area < 1500 ? 12 : 15; stats.typical++; }
  if (r.kind === KIND.house) h = Math.min(h, style ? 9.5 : 11);
  const cap = storeys.at(r.cx, r.cz);
  if (cap && h > cap * 3.6 + 0.6) { h = cap * 3.6 + 0.6; stats.capped++; }
  r.height = h;
  r.guess = true; // tools/tiles/derive.mjs may cut a guess down to fit under a deck
  if (r.area > 2500) missingLarge.push(`${Math.round(r.area)} m² ${Math.round(h)} m ${r.b.class || '-'} ${r.b.name || ''} @${Math.round(r.cx)},${Math.round(r.cz)}`);
}

// A house with a pitched roof of its style stands its roof on its storeys: a measured height is to the top of the roof, so it
// says how many storeys there are under it, and a guess already is
for (const r of buildings) {
  const style = HOUSE_STYLES[r.style || 0];
  if (!style?.roofs || r.guess) continue;
  const storeys = Math.max(1, Math.min(3, Math.round((r.height - 2) / STOREY)));
  r.height = storeys * STOREY + 0.2;
  stats.storeys = (stats.storeys || 0) + 1;
}

// Hand edits (tools/local/), one building each: found by a point inside it, given the height the photos show, where the build has the
// height the edit expects there. If it hasn't, or there's no building there, the build stops: the data has changed under the edit.
{
  const inRing = (ring, x, z) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[j];
      if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) c = !c;
    }
    return c;
  };
  for (const area of localAreas()) {
    for (const edit of area.buildings || []) {
      if (!edit.at) continue;
      const [x, z] = edit.at;
      const r = buildings.find((b) => !b.part && b.polygons.some(([outer]) => inRing(outer.map(([px, pz]) => [px * PRECISION, pz * PRECISION]), x, z)));
      if (!r) throw new Error(`tools/local/${area.file}: no building at (${x}, ${z}) (${edit.why})`);
      const [lo, hi] = edit.expect;
      if (r.height < lo || r.height > hi) {
        throw new Error(`tools/local/${area.file}: the building at (${x}, ${z}) is ${r.height.toFixed(1)} m, not ${lo}-${hi}: check the edit (${edit.why})`);
      }
      console.log(`[buildings] tools/local/${area.file}: (${x}, ${z}) from ${r.height.toFixed(1)} m to ${edit.height} m${edit.style ? `, ${edit.style}` : ''}`);
      // ...and a house style (js/house-styles.js) for its walls and roof, if it says
      if (edit.style) {
        if (STYLE[edit.style] === undefined) throw new Error(`tools/local/${area.file}: no house style called ${edit.style} (js/house-styles.js)`);
        r.style = STYLE[edit.style];
        r.styledByHand = true;
      }
      // A building that had parts over it keeps its group number though they're under it now, so no other building's changes
      if ((partsOf.get(r.b.id) || []).some((q) => q.top > r.height + 1)) r.keepGroup = true;
      r.height = edit.height;
      r.guess = false;
    }
  }
}

// Each part taller than its building stands on top of it, starting where the building's own walls stop, so no two walls
// share a plane. Parts of a building share its floor and its group number.
const pieces = [];
let groups = 0;
for (const r of buildings) {
  const parts = (partsOf.get(r.b.id) || []).filter((p) => p.top > r.height + 1);
  if (!parts.length && r.keepGroup) groups++;
  if (parts.length) {
    r.group = ++groups;
    stats.withParts++;
    const fix = TOP_FIXES[r.b.name];
    if (fix) parts.reduce((a, c) => (c.top > a.top ? c : a)).top = fix;
    for (const p of parts) {
      stats.parts++;
      pieces.push({ b: { name: r.b.name }, polygons: p.polygons, area: p.area, cx: p.cx, cz: p.cz, kind: r.kind, height: p.top,
        bottom: Math.max(p.bottom, r.height), group: r.group, part: true });
    }
  }
}
buildings.push(...pieces);

// Roads win. Footprints and road centre lines come from different surveys and don't always agree, and a corner in a lane stops a car
// dead for no reason a driver can see, so a footprint gives up whatever it has on a carriageway. One that would lose most of itself goes.
{
  const { GEO } = await import(path.join(path.dirname(OUT), 'geodata.js'));
  const RG = GEO.roadGraph;
  const CLEAR = 0.8; // m past a road's edge, as tracing a raster and simplifying what's traced can bring it back a little
  const CELL = 40;
  const segments = new Map();
  for (const l of RG.links) {
    const [a, b, , width, , , inner, , , kind = 0] = l;
    if (kind && kind !== 3) continue; // off the ground: nothing to run into
    const pts = [[RG.nodes[a * 2], RG.nodes[a * 2 + 1]]];
    for (let k = 0; k < inner.length; k += 2) pts.push([inner[k], inner[k + 1]]);
    pts.push([RG.nodes[b * 2], RG.nodes[b * 2 + 1]]);
    const r = width / 2 + CLEAR;
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
      const seg = [ax, az, bx, bz, r];
      for (let ix = Math.floor((Math.min(ax, bx) - r) / CELL); ix <= Math.floor((Math.max(ax, bx) + r) / CELL); ix++) {
        for (let iz = Math.floor((Math.min(az, bz) - r) / CELL); iz <= Math.floor((Math.max(az, bz) + r) / CELL); iz++) {
          const k = ix * 100000 + iz;
          if (!segments.has(k)) segments.set(k, []);
          segments.get(k).push(seg);
        }
      }
    }
  }
  const FOOT = 0.5;
  let trimmed = 0, dropped = 0;
  for (const r of buildings) {
    if ((r.bottom || 0) > 2) continue; // up above the road, out of its way
    const kept = [];
    for (const polygon of r.polygons) {
      // Rings are kept in whole steps of PRECISION
      const [outer, ...holes] = polygon.map((ring) => ring.map(([qx, qz]) => [qx * PRECISION, qz * PRECISION]));
      const xs = outer.map((p) => p[0]), zs = outer.map((p) => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
      const near = new Set();
      for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++) {
        for (let iz = Math.floor(z0 / CELL); iz <= Math.floor(z1 / CELL); iz++) {
          for (const seg of segments.get(ix * 100000 + iz) || []) {
            if (Math.max(seg[0], seg[2]) + seg[4] >= x0 && Math.min(seg[0], seg[2]) - seg[4] <= x1 && Math.max(seg[1], seg[3]) + seg[4] >= z0 && Math.min(seg[1], seg[3]) - seg[4] <= z1) near.add(seg);
          }
        }
      }
      if (!near.size) { kept.push(polygon); continue; }
      const raster = new Raster(x0 - 1, z0 - 1, x1 + 1, z1 + 1, FOOT);
      raster.fillRing(outer, 1);
      for (const hole of holes) raster.fillRing(hole, 0);
      const before = raster.d.reduce((sum, v) => sum + v, 0);
      for (const [ax, az, bx, bz, rr] of near) raster.stampSegment(ax, az, bx, bz, rr, 0);
      const after = raster.d.reduce((sum, v) => sum + v, 0);
      if (after === before) { kept.push(polygon); continue; }
      trimmed++;
      if (after < before * 0.5 || after * FOOT * FOOT < 12) { dropped++; continue; }
      const { labels, comps } = raster.label();
      const largest = comps.reduce((best, c) => (!best || c.n > best.n ? c : best), null);
      const rings = raster.traceRings(labels, largest).map((ring) => rdpRing(ring, 0.4)).filter((ring) => ring.length >= 3);
      rings.sort((p, q) => Math.abs(ringArea(q)) - Math.abs(ringArea(p)));
      const main = rings[0];
      if (!main) { dropped++; continue; }
      if (ringArea(main) < 0) main.reverse();
      const inner = rings.slice(1).filter((ring) => Math.abs(ringArea(ring)) > 6).map((ring) => {
        if (ringArea(ring) > 0) ring.reverse();
        return quantized(ring);
      });
      const q = quantized(main);
      if (q.length >= 3) kept.push([q, ...inner]);
    }
    r.polygons = kept;
  }
  const whole = buildings.length;
  for (let i = buildings.length - 1; i >= 0; i--) if (!buildings[i].polygons.length) buildings.splice(i, 1);
  console.log(`[buildings] ${trimmed} footprints trimmed clear of a road, ${dropped} of them dropped, ${whole - buildings.length} buildings gone`);
}

// Real awnings: the City of Sydney's plan of them. A building fronted by one gets it (js/street-details.js), not a made-up one
const AWNING_REACH = 4;
const awningCells = new Map();
for (const f of load('cos_awnings.json')) {
  if (!f.geometry) continue;
  for (const line of f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates) {
    const pts = line.map(([lon, lat]) => toWorld(lon, lat));
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
      const steps = Math.ceil(Math.hypot(bx - ax, bz - az) / 8) + 1;
      for (let k = 0; k <= steps; k++) {
        const key = `${Math.floor((ax + ((bx - ax) * k) / steps) / 16)},${Math.floor((az + ((bz - az) * k) / steps) / 16)}`;
        if (!awningCells.has(key)) awningCells.set(key, []);
        awningCells.get(key).push([ax, az, bx, bz]);
      }
    }
  }
}
function frontsAwning(r) {
  for (const [ring] of r.polygons) {
    for (const [qx, qz] of ring) {
      const x = qx * PRECISION, z = qz * PRECISION;
      for (let ix = Math.floor((x - AWNING_REACH) / 16); ix <= Math.floor((x + AWNING_REACH) / 16); ix++) {
        for (let iz = Math.floor((z - AWNING_REACH) / 16); iz <= Math.floor((z + AWNING_REACH) / 16); iz++) {
          for (const [ax, az, bx, bz] of awningCells.get(`${ix},${iz}`) || []) {
            const L2 = (bx - ax) ** 2 + (bz - az) ** 2 || 1;
            const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / L2));
            if (Math.hypot(ax + (bx - ax) * t - x, az + (bz - az) * t - z) < AWNING_REACH) return true;
          }
        }
      }
    }
  }
  return false;
}

const order = (r) => {
  let o = 0;
  const x = Math.floor(r.cx + 8192), z = Math.floor(r.cz + 8192);
  for (let i = 0; i < 14; i++) o += ((x >> i) & 1) * 2 ** (2 * i) + ((z >> i) & 1) * 2 ** (2 * i + 1);
  return o;
};
buildings.sort((p, q) => order(p) - order(q));
const meta = [], xs = [], zs = [];
const uint = (out, v) => { while (v > 127) { out.push((v & 127) | 128); v = Math.floor(v / 128); } out.push(v); };
const sint = (out, v) => uint(out, v >= 0 ? v * 2 : -v * 2 - 1);
let px = 0, pz = 0, vertices = 0;
uint(meta, buildings.length);
for (const r of buildings) {
  const shape = r.b.roof_shape;
  const style = HOUSE_STYLES[r.style || 0];
  // A style given by hand says its roof, whatever the data does
  const pitched = !r.group && (r.styledByHand ? !!style?.roofs : shape ? /gabled|hipped|pyramidal|mansard|gambrel|half/.test(shape)
    : style ? !!style.roofs : (r.kind === KIND.house && r.height < 13) || (r.kind === KIND.shed && r.area > 30) || (r.height < 10 && r.kind === KIND.civic));
  uint(meta, Math.max(1, Math.round(r.height)));
  uint(meta, r.kind | (pitched ? 8 : 0) | (r.group ? 16 : 0) | (!r.part && frontsAwning(r) ? 32 : 0) | (r.guess ? 64 : 0) | ((r.part ? 0 : r.style || 0) << 7));
  if (r.group) {
    uint(meta, r.group);
    uint(meta, Math.round(r.bottom || 0));
  }
  uint(meta, r.polygons.length);
  for (const polygon of r.polygons) {
    uint(meta, polygon.length);
    for (const ring of polygon) {
      uint(meta, ring.length);
      vertices += ring.length;
      for (const [x, z] of ring) { sint(xs, x - px); sint(zs, z - pz); px = x; pz = z; }
    }
  }
}
const header = Buffer.alloc(12);
header.write('SYB2', 0, 'latin1');
header.writeUInt32LE(meta.length, 4);
header.writeUInt32LE(xs.length, 8);
const packed = zlib.gzipSync(Buffer.concat([header, Buffer.from(meta), Buffer.from(xs), Buffer.from(zs)]), { level: 9 });
const asset = OUT.replace(/\.js$/, '.bin.gz');
fs.writeFileSync(asset, packed);
fs.writeFileSync(OUT, `// Generated by tools/build-buildings.mjs; do not edit.
// Overture Maps buildings (OpenStreetMap and Microsoft ML footprints). Snapshot SHA-256: ${digest}
// ${buildings.length.toLocaleString('en-US')} buildings. Coordinates: 0.5 m; roof heights: 1 m.
const response = await fetch(new URL('./${path.basename(asset)}', import.meta.url));
if (!response.ok) throw new Error(\`Building data request failed: \${response.status}\`);
// Servers that send .gz files as Content-Encoding: gzip hand over bytes the browser has already inflated
const body = new Uint8Array(await response.arrayBuffer());
const data = body[0] === 0x1f && body[1] === 0x8b
  ? new Uint8Array(await new Response(new Response(body).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  : body;
const invalidData = () => new Error('Invalid building data.');
if (data.length < 12) throw invalidData();
const header = new DataView(data.buffer);
const xStart = 12 + header.getUint32(4, true), zStart = xStart + header.getUint32(8, true);
if (header.getUint32(0, true) !== 0x32425953 || zStart > data.length) throw invalidData();

// SYB2 stores separate metadata, X and Z streams; signed coordinate deltas use zigzag varints.
function stream(start, end) {
  let cursor = start;
  return {
    uint() {
      let value = 0, shift = 0, byte;
      do {
        if (cursor >= end || shift >= 28) throw invalidData();
        byte = data[cursor++];
        value |= (byte & 127) << shift;
        shift += 7;
      } while (byte & 128);
      return value;
    },
    done: () => cursor === end
  };
}
const metadata = stream(12, xStart), xs = stream(xStart, zStart), zs = stream(zStart, data.length);
const uint = () => metadata.uint();
const delta = stream => { const value = stream.uint(); return (value >>> 1) ^ -(value & 1); };
const count = uint();
if (count > (xStart - 12) / 5) throw invalidData();
let x = 0, z = 0;

// kind: 0 other, 1 house, 2 flats, 3 shops and offices, 4 shed, 5 civic
export const REAL_BUILDINGS = Array.from({ length: count }, () => {
  const height = uint(), style = uint(), polygons = [];
  // A building in several pieces: which, and how far up this piece starts
  const group = style & 16 ? uint() : 0, bottom = style & 16 ? uint() : 0;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let n = uint(); n > 0; n--) {
    const rings = [];
    for (let n = uint(); n > 0; n--) {
      const ring = [];
      for (let n = uint(); n > 0; n--) {
        x += delta(xs); z += delta(zs);
        const point = { x: x * 0.5, z: z * 0.5 };
        minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
        ring.push(point);
      }
      rings.push(ring);
    }
    polygons.push({ outer: rings[0], holes: rings.slice(1) });
  }
  // guess: nothing measured or counted its height. houseStyle: js/house-styles.js, 0 for none
  return { height, kind: style & 7, pitched: !!(style & 8), group, bottom, realAwning: !!(style & 32), guess: !!(style & 64), houseStyle: (style >> 7) & 15, polygons,
    minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
});
if (!metadata.done() || !xs.done() || !zs.done()) throw invalidData();
`);
console.log('[buildings]', buildings.length, 'buildings,', vertices, 'vertices,', (packed.length / 1024).toFixed(0), 'KB gzip');
console.log('[buildings]', JSON.stringify(stats));
console.log('[buildings] from the Census and zoning:', JSON.stringify(placeStats));
console.log('[buildings] tallest', buildings.slice().sort((p, q) => q.height - p.height).slice(0, 30).map((r) => `${r.b.name || '?'} ${Math.round(r.height)}`).join(', '));
console.log('[buildings] large guesses:\n  ' + missingLarge.sort((p, q) => parseInt(q, 10) - parseInt(p, 10)).slice(0, 30).join('\n  '));
