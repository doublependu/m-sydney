// Where the ground runs up a building's wall over its floor: a floor at its door has its uphill walls cut into the slope
// (js/building-floor.js doorFloor()), and the ground isn't moved. The facade draws no window whose sill is under the ground there plus
// CLEAR (js/tsl-materials.js facadeCell()), so those walls read as solid where the hill meets them, and no entrance where the ground is
// over its foot by more than that.
// A wall the ground runs up is drawn in pieces at its window bays' edges, as the facade lays them out (and an entrance's, which spans
// bays), each piece carrying the most the ground rises over the floor's ground along it: a bay either has its window or doesn't. The
// piece's kind carries it (packKind()), so the walls need no new attribute.

const LINE_STEP = 0.5; // m: how often the ground is read along a wall it comes near the top of
const BURIED = 0.3; // m over the floor's ground: a stretch the ground rises no higher on is as any wall at its foot (0.22 up)
const LINE_UNIT = 0.1; // m: the line is carried in steps of this, rounded up
const CLEAR = 0.3; // m: a window's sill is at least this over the ground beside it
const CITY_SILL = 0.6; // m over its storey's floor: the lowest a city facade's window starts (js/tsl-materials.js facadeCell())
const ENTRANCE_HALF = 1.25; // m either side of an entrance's middle: its widest door and frame (createBuildingEntrance())
// A wall whose ground stays NEAR under BURIED (0.05 m over its floor's ground) at every STEP is read no closer: a floor at the highest
// ground along its walls (js/building-floor.js), most of the map's, has none buried but on a crest between reads. Its walls' close reads
// were half the line's work as the tiles came in.
const NEAR = 0.25; // m
const STEP = 5; // m

/**
 * The pack the facade unpacks (js/tsl-materials.js wallKind()): a wall's kind (0 to 4.125: WALL_KINDS and ONE_HOUSE), and the ground's
 * line over its floor's ground along it (m), where that's over BURIED: -(8 * steps of LINE_UNIT + kind + 2), which no kind is.
 */
function packKind(kind, line) {
  if (!(line > BURIED)) return kind;
  return -(8 * Math.ceil(line / LINE_UNIT - 1e-6) + kind + 2);
}

/** A line rounded up to LINE_UNIT, as packKind() carries it */
const unitUp = (line) => Math.ceil(line / LINE_UNIT - 1e-6) * LINE_UNIT;

/** { kind, line } from packKind()'s, as the facade unpacks it: line 0 where it isn't packed */
function unpackKind(z) {
  if (!(z < -0.5)) return { kind: z, line: 0 };
  const raw = -z, steps = Math.floor(raw / 8);
  return { kind: raw - 8 * steps - 2, line: steps * LINE_UNIT };
}

/**
 * The edges of a wall's window bays as the facade lays them out (js/tsl-materials.js facadeCounts(), houseWall()), in metres from where
 * its bays start: `bays` of them between a `pier` at each end, and the ends.
 */
function bayEdges(width, bays, pier) {
  const bay = (width - 2 * pier) / bays;
  const edges = [0];
  for (let k = 0; k <= bays; k++) edges.push(pier + k * bay);
  edges.push(width);
  return edges.filter((s, i, all) => i === 0 || s > all[i - 1] + 1e-6);
}

/** How many window bays a wall `width` m long has between its piers, at `spacing` (facadeCounts()' count()) */
const bayCount = (width, spacing) => Math.max(Math.floor(width / spacing + 0.50005), 1);

// As js/tsl-materials.js has them (tests/facade-projection.test.cjs holds them together)
const FRONT = 1; // WALL_KINDS.front
const ONE_HOUSE = 0.125;
const HOUSE_PIER = 0.45; // m
const TERRACE_HOUSE = 5.5; // m

/**
 * A house's wall laid out as houseWall() lays it out: { bays, pier, sill }, its window bays between a pier at each end, and its windows'
 * sill over its storey's floor (its style's, front or side, and the 0.22 the wall starts over its floor's ground). `kind` its WALL_KINDS
 * (a front of one house: front + ONE_HOUSE, never a row of terraces); `look` its style's (js/house-styles.js)
 */
function houseBays(width, kind, look) {
  const front = Math.abs(kind - FRONT) <= 0.25;
  const pier = Math.min(HOUSE_PIER, width * 0.2);
  const houses = Math.max(Math.floor(width / TERRACE_HOUSE + 0.50005), 1);
  const terraces = !!look.terrace && front && houses >= 2 && Math.abs(kind - FRONT) < ONE_HOUSE * 0.5;
  const bays = terraces ? houses * 2 : bayCount(width - 2 * pier, front ? look.bay[0] : look.bay[1]);
  return { bays, pier, sill: (front ? look.window[2] : look.side[2]) + 0.22 };
}

/** A city wall laid out as facadeCounts() lays it out, with its material's `storey` { width, pier }: { bays, pier } */
function cityBays(width, storey) {
  const pier = storey.pier > 0 ? Math.min(storey.pier, width * 0.2) : 0;
  return { bays: bayCount(pier > 0 ? width - 2 * pier : width, storey.width), pier };
}

/**
 * A wall from a to b ({ x, y }: y is the world's z), `width` m, whose floor's ground is `floor` (the wall starts 0.22 over it): where the
 * ground (groundAt(x, z)) runs up it over BURIED, its pieces between `edges` (m from where its bays start, which is b where `reverse`),
 * joined where they hide the same: [{ t0, t1, line }] with t from a, `line` the most the ground rises over `floor` along it (0 where it's
 * under BURIED). `outcome(line)`: what a line hides on this wall (the same value, the same windows), to join pieces by. `spans`:
 * [s0, s1] that must be one piece each (an entrance), joined with the bays they cross. Null where the ground stays under BURIED.
 */
function wallLine(a, b, width, floor, groundAt, { edges = [0, width], reverse = false, spans = [], outcome = (line) => line } = {}) {
  if (!(width > 0)) return null;
  const at = (s) => {
    const t = reverse ? 1 - s / width : s / width;
    return groundAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) - floor;
  };
  // Most walls have the ground nowhere over their foot: a look every STEP first
  // (a read that isn't a number, as the ground can give on a seam, is passed over)
  let near = -Infinity;
  for (let k = 0, n = Math.max(1, Math.ceil(width / STEP)); k <= n; k++) { const y = at((width * k) / n); if (y > near) near = y; }
  if (near < BURIED - NEAR) return null;
  // Bays, and the bays an entrance crosses, as one
  const cuts = edges.slice();
  let pieces = [];
  for (let i = 1; i < cuts.length; i++) pieces.push([cuts[i - 1], cuts[i]]);
  for (const [s0, s1] of spans) {
    const lo = pieces.findIndex(([, e]) => e > s0 + 1e-6), hi = pieces.findLastIndex(([s]) => s < s1 - 1e-6);
    if (lo < 0 || hi < lo) continue;
    pieces.splice(lo, hi - lo + 1, [pieces[lo][0], pieces[hi][1]]);
  }
  let any = false;
  pieces = pieces.map(([s0, s1]) => {
    let line = -Infinity;
    const n = Math.max(1, Math.ceil((s1 - s0) / LINE_STEP));
    for (let k = 0; k <= n; k++) { const y = at(s0 + ((s1 - s0) * k) / n); if (y > line) line = y; }
    if (line > BURIED) any = true;
    return { s0, s1, line: line > BURIED ? unitUp(line) : 0 };
  });
  if (!any) return null;
  // Joined where they'd hide the same, each the most of its pieces' lines
  const joined = [];
  for (const p of pieces) {
    const last = joined.at(-1);
    if (last && outcome(last.line) === outcome(p.line)) { last.s1 = p.s1; last.line = Math.max(last.line, p.line); } else joined.push({ ...p });
  }
  return joined.map(({ s0, s1, line }) => {
    const t0 = reverse ? 1 - s1 / width : s0 / width, t1 = reverse ? 1 - s0 / width : s1 / width;
    return { t0, t1, line };
  }).sort((p, q) => p.t0 - q.t0);
}

/** The most the ground rises over `floor` along a wall from a to b, `width` m, read every LINE_STEP; -Infinity where it stays NEAR under
 * BURIED at every STEP */
function mostOver(a, b, width, floor, groundAt) {
  const at = (t) => groundAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) - floor;
  let near = -Infinity;
  for (let k = 0, n = Math.max(1, Math.ceil(width / STEP)); k <= n; k++) { const y = at(k / n); if (y > near) near = y; }
  if (near < BURIED - NEAR) return -Infinity;
  let most = -Infinity;
  for (let k = 0, n = Math.max(1, Math.ceil(width / LINE_STEP)); k <= n; k++) { const y = at(k / n); if (y > most) most = y; }
  return most;
}

/**
 * What a line hides on a wall (wallLine()'s `outcome`): how many of its storeys' windows (`storey` m apart, from its floor's ground; the
 * lowest window's sill `sill` m over its storey's floor), and whether an entrance at its foot (0.22 up) is buried by more than CLEAR
 */
function hides(line, storey, sill) {
  if (!(line > BURIED)) return 0;
  const rows = Math.max(0, Math.floor((line + CLEAR - sill) / storey) + 1);
  return rows * 2 + (line > 0.22 + CLEAR ? 1 : 0);
}

export { BURIED as WALL_BURIED, cityBays, houseBays, mostOver, CITY_SILL, CLEAR as WINDOW_CLEAR, ENTRANCE_HALF, LINE_STEP, LINE_UNIT, bayCount, bayEdges, hides, packKind, unpackKind, wallLine };
