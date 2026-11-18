// tools/sea-water.mjs: which of OpenStreetMap's water areas are the sea's, drawn at its one level, -2.2 m (tools/build-geodata.mjs
// riversAndPiers()), and which are still water, drawn at a level of their own (tools/build-ponds.mjs). One rule for both, so that whatever
// the sea no longer takes is drawn as a pond.
// The sea takes water OSM has as natural=water over MIN_AREA m², low (its outline LOW m or less over the survey's zero, on average) and not
// tagged as a pond, reservoir, basin and the like, outside the gardens' areas (tools/garden-areas.mjs: the garden draws its own ponds).
// Of those, only what reaches the sea: water tagged as flowing (a river, canal, lagoon...) or tidal, or within REACH m of the shore, or of
// water that's kept. A lake in a park by the river, like Lake Belvedere or Lake Gillawarna, meets neither, and isn't the sea's.
// A hand edit can say otherwise (tools/local/, `water`): Whites Creek is a channel into Rozelle Bay that OSM draws ending short of it.
import { chainRings, elementRings, inDetail, load, ringArea, toWorld } from './geo-common.mjs';

export const STILL_TAGS = /^(pond|basin|wastewater|reservoir|reflecting_pool|pool|stream_pool|fountain)$/;
export const FLOWING_TAGS = /^(river|canal|lagoon|stream|ditch|tidal|lock|harbour|bay|estuary)$/;
export const MIN_AREA = 1500; // m²
export const LOW = 3; // m
export const REACH = 25; // m

/** The shore's lines the rule measures from: the coast's, chained, and Sydney Harbour's outline and islands */
export function shoreLines() {
  const coast = chainRings(load('coast.json').elements.filter((e) => e.geometry).map((e) => e.geometry.map((g) => toWorld(g.lon, g.lat))));
  const harbour = elementRings(load('harbour.json').elements.find((e) => e.id === 15522136));
  return [...coast, ...harbour.outer, ...harbour.inner];
}

const segDist = (x, z, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
  return Math.hypot(ax + dx * t - x, az + dz * t - z);
};

/** (x, z, r) => whether a point is within r (no more than CELL) of any of the lines, found in CELL m cells */
function nearLines(lines) {
  const CELL = 50, cells = new Map();
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const [ax, az] = line[i - 1], [bx, bz] = line[i];
      for (let cx = Math.floor(Math.min(ax, bx) / CELL) - 1; cx <= Math.floor(Math.max(ax, bx) / CELL) + 1; cx++) {
        for (let cz = Math.floor(Math.min(az, bz) / CELL) - 1; cz <= Math.floor(Math.max(az, bz) / CELL) + 1; cz++) {
          const k = cx * 100000 + cz;
          (cells.get(k) || cells.set(k, []).get(k)).push([ax, az, bx, bz]);
        }
      }
    }
  }
  return (x, z, r) => (cells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || []).some((s) => segDist(x, z, ...s) < r);
}

const keyOf = (e) => `${e.type}/${e.id}`;

/**
 * The rule, over OSM's land elements. `heightAt(x, z)`: the survey's height there, or null; `inGarden(ring)`: whether a ring is in a
 * garden's area; `shore`: the lines (shoreLines()); `edits`: [{ key: 'way/1' | 'relation/1', sea, expect, why, file }] (local-edits.mjs
 * localWater()). Returns { sea, still }, each [{ e, key, outer, inner, why }]: `outer` the element's outer rings the sea would take, low and
 * big enough, and `why` what keeps it in the sea, or that nothing does.
 */
export function seaWaters(elements, { heightAt, inGarden = () => false, shore, edits = [] }) {
  const near = nearLines(shore);
  const candidates = [];
  for (const e of elements) {
    const t = e.tags || {};
    if (t.natural !== 'water' || STILL_TAGS.test(t.water || '')) continue;
    const { outer, inner } = elementRings(e);
    const low = outer.filter((ring) => {
      if (ring.length < 4 || Math.abs(ringArea(ring)) < MIN_AREA || !ring.some(([x, z]) => inDetail(x, z)) || inGarden(ring)) return false;
      const heights = ring.map(([x, z]) => heightAt(x, z)).filter((y) => y !== null);
      return !heights.length || heights.reduce((s, y) => s + y, 0) / heights.length <= LOW;
    });
    if (!low.length) continue;
    const flowing = FLOWING_TAGS.test(t.water || '') || !!t.tidal;
    const shoreline = low.some((r) => r.some(([x, z]) => near(x, z, REACH)));
    candidates.push({ e, key: keyOf(e), outer: low, inner, sea: flowing || shoreline, why: flowing ? 'flowing' : shoreline ? 'on the shore' : null });
  }
  // Hand edits first: what they put in the sea reaches it, and what they take out never does
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const fixed = new Set();
  for (const edit of edits) {
    const c = byKey.get(edit.key);
    const where = `tools/local/${edit.file}: ${edit.key}`;
    if (!c) throw new Error(`${where} isn't water the sea's rule reads (gone from the snapshot, or no longer low and over ${MIN_AREA} m²): check the edit (${edit.why})`);
    for (const [tag, value] of Object.entries(edit.expect || {})) {
      if ((c.e.tags?.[tag] ?? null) !== value) throw new Error(`${where} has ${tag}=${c.e.tags?.[tag]} in OSM now, not ${value}: check the edit (${edit.why})`);
    }
    c.sea = !!edit.sea;
    c.why = edit.sea ? `by hand (${edit.file})` : null;
    c.edited = edit.file;
    fixed.add(c);
  }
  // Water that meets water that reaches the sea, reaches it too: each ring's points against the kept's edges
  const edges = new Map();
  const reaches = (a, b) => {
    if (!edges.has(b)) edges.set(b, nearLines(b.outer.map((r) => [...r, r[0]])));
    const nearB = edges.get(b);
    return a.outer.some((r) => r.some(([x, z]) => nearB(x, z, REACH)));
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const c of candidates) {
      if (c.sea || fixed.has(c)) continue;
      const via = candidates.find((o) => o !== c && o.sea && reaches(c, o));
      if (via) {
        c.sea = true;
        c.why = `beside ${via.key}`;
        grew = true;
      }
    }
  }
  const strip = ({ e, key, outer, inner, why, edited }) => ({ e, key, outer, inner, why, ...(edited && { edited }) });
  return { sea: candidates.filter((c) => c.sea).map(strip), still: candidates.filter((c) => !c.sea).map(strip) };
}
