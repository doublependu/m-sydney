// tools/garden/rule-parks.mjs: the gardens of the parks by rule (tools/garden-areas.mjs ruleParks()), for tools/build-garden.mjs: every
// park on the map with paths that isn't a hand-made area, laid out a 240 m square at a time. What one gets: its paths (paved ones kerbed where
// it's formal, the rest tracks; in the bush every path a track), steps, and where it's formal the raised lawn with its kerbs, traced a
// 240 m square at a time (tools/garden/raised-lawn.mjs). Each point by the kind there (kindAt()): a park its tags or an override say is
// bush (or formal) is that all over; otherwise it's bush where OSM has wood or scrub or NSW's zoning has bush land (tools/garden-areas.mjs
// pockets()), and formal elsewhere, so a park's bush along its creek has tracks and its lawns are raised. Not what the hand-made areas get
// by hand: no beds, hedges, plants, gates, ponds or sea walls; its trees are tools/build-trees.mjs's, and its still water
// tools/build-ponds.mjs's (the lakes), which its raised lawn and paths keep out of, as they do roads.
import { Raster, bbox, flat, q1, rdp } from '../geo-common.mjs';
import { pathKind } from '../garden-areas.mjs';
import { SQUARE, traceRaised } from './raised-lawn.mjs';

export const REACH = 4; // m past a park's outline a path still counts, as an area's (tools/build-garden.mjs)
export const MIN_PATHS = 10; // m of path kept in a park for it to have a garden
export const BANK = 0.3; // m: half a lake's bank (js/garden.js BANK), astride its edge, which the raised lawn keeps off
const STEP = 1; // m between the points a path is tested at, as an area's
const MARGIN = 2; // m round a square its raised lawn is worked out on too
const CELL = 16; // m: the cells a park's outline is looked up in
const GRID = 250; // m: the cells the parks are found in

const segDist = (x, z, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
  return Math.hypot(ax + dx * t - x, az + dz * t - z);
};
// Whether segments p-q and a-b cross
const crosses = (px, pz, qx, qz, ax, az, bx, bz) => {
  const d1 = (bx - ax) * (pz - az) - (bz - az) * (px - ax), d2 = (bx - ax) * (qz - az) - (bz - az) * (qx - ax);
  const d3 = (qx - px) * (az - pz) - (qz - pz) * (ax - px), d4 = (qx - px) * (bz - pz) - (qz - pz) * (bx - px);
  return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0);
};

/**
 * A park's outline, looked up fast: inside (its outer rings less its holes, even-odd) and how near its outer edge, for a park of thousands
 * of points as for one of four. The middle of each CELL square is known inside or out (a raster), and a point is that, flipped once for each
 * of its rings' edges between it and the middle; its edges are listed by the squares within REACH of them.
 */
export class Outline {
  constructor(outer, holes = [], reach = REACH) {
    const all = [...outer, ...holes];
    const b = bbox(all.flat());
    this.reach = reach;
    this.box = { x0: b.x0 - reach, z0: b.z0 - reach, x1: b.x1 + reach, z1: b.z1 + reach };
    const r = new Raster(this.box.x0 - CELL, this.box.z0 - CELL, this.box.x1 + CELL, this.box.z1 + CELL, CELL);
    const one = new Raster(r.x0, r.z0, r.x0 + (r.w - 1) * CELL, r.z0 + (r.h - 1) * CELL, CELL);
    for (const ring of all) {
      one.d.fill(0);
      one.fillRing(ring, 1);
      for (let i = 0; i < r.d.length; i++) r.d[i] ^= one.d[i];
    }
    this.cells = r;
    this.edges = new Map(); // cell -> [ax, az, bx, bz, outer, ...]
    for (const [k, ring] of all.entries()) {
      const isOuter = k < outer.length ? 1 : 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [ax, az] = ring[j], [bx, bz] = ring[i];
        for (let ci = Math.floor((Math.min(ax, bx) - reach - r.x0) / CELL); ci <= Math.floor((Math.max(ax, bx) + reach - r.x0) / CELL); ci++) {
          for (let cj = Math.floor((Math.min(az, bz) - reach - r.z0) / CELL); cj <= Math.floor((Math.max(az, bz) + reach - r.z0) / CELL); cj++) {
            if (ci < 0 || cj < 0 || ci >= r.w || cj >= r.h) continue;
            const key = cj * r.w + ci;
            (this.edges.get(key) || this.edges.set(key, []).get(key)).push(ax, az, bx, bz, isOuter);
          }
        }
      }
    }
  }
  /** Whether (x, z) is in it */
  inside(x, z) {
    const r = this.cells;
    const i = Math.floor((x - r.x0) / CELL), j = Math.floor((z - r.z0) / CELL);
    if (i < 0 || j < 0 || i >= r.w || j >= r.h) return false;
    let inside = r.d[j * r.w + i] === 1;
    const cx = r.x0 + (i + 0.5) * CELL, cz = r.z0 + (j + 0.5) * CELL;
    const e = this.edges.get(j * r.w + i);
    if (e) for (let k = 0; k < e.length; k += 5) if (crosses(cx, cz, x, z, e[k], e[k + 1], e[k + 2], e[k + 3])) inside = !inside;
    return inside;
  }
  /** Whether (x, z) is within `reach` of its outer edge */
  near(x, z, reach = this.reach) {
    const r = this.cells;
    const i = Math.floor((x - r.x0) / CELL), j = Math.floor((z - r.z0) / CELL);
    const e = i < 0 || j < 0 || i >= r.w || j >= r.h ? null : this.edges.get(j * r.w + i);
    if (e) for (let k = 0; k < e.length; k += 5) if (e[k + 4] && segDist(x, z, e[k], e[k + 1], e[k + 2], e[k + 3]) <= reach) return true;
    return false;
  }
}

/** The parks by rule, to be found by where they are: at(x, z, reach), the smallest a point is in (or within `reach` of the outline of) */
export class ParkIndex {
  constructor(parks) {
    this.parks = parks;
    this.grid = new Map();
    for (const p of parks) {
      p.outline ||= new Outline(p.rings, p.holes);
      const b = p.outline.box;
      for (let i = Math.floor(b.x0 / GRID); i <= Math.floor(b.x1 / GRID); i++) {
        for (let j = Math.floor(b.z0 / GRID); j <= Math.floor(b.z1 / GRID); j++) {
          const key = i * 100000 + j;
          (this.grid.get(key) || this.grid.set(key, []).get(key)).push(p);
        }
      }
    }
  }
  /** Whether a park's outline (REACH wider) is in or touches box `b` */
  touches(b) {
    for (let i = Math.floor(b.x0 / GRID); i <= Math.floor(b.x1 / GRID); i++) {
      for (let j = Math.floor(b.z0 / GRID); j <= Math.floor(b.z1 / GRID); j++) {
        for (const p of this.grid.get(i * 100000 + j) || []) {
          const o = p.outline.box;
          if (o.x1 >= b.x0 && o.x0 <= b.x1 && o.z1 >= b.z0 && o.z0 <= b.z1) return true;
        }
      }
    }
    return false;
  }
  at(x, z, reach = 0) {
    let best = null, nearBest = null;
    for (const p of this.grid.get(Math.floor(x / GRID) * 100000 + Math.floor(z / GRID)) || []) {
      const b = p.outline.box;
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      if (p.outline.inside(x, z)) { if (!best || p.area < best.area) best = p; } else if (reach && (!nearBest || p.area < nearBest.area) && p.outline.near(x, z, reach)) nearBest = p;
    }
    return best || nearBest;
  }
}

/** Where a park by rule is bush (tools/garden-areas.mjs pockets(): [{ outer, holes, box }]), to be found by where they are */
export class Pockets {
  constructor(list) {
    this.list = list;
    this.grid = new Map();
    for (const p of list) {
      p.outline ||= new Outline(p.outer, p.holes, 0);
      const b = p.box;
      for (let i = Math.floor(b.x0 / GRID); i <= Math.floor(b.x1 / GRID); i++) {
        for (let j = Math.floor(b.z0 / GRID); j <= Math.floor(b.z1 / GRID); j++) {
          const key = i * 100000 + j;
          (this.grid.get(key) || this.grid.set(key, []).get(key)).push(p);
        }
      }
    }
  }
  /** Whether (x, z) is in one */
  at(x, z) {
    for (const p of this.grid.get(Math.floor(x / GRID) * 100000 + Math.floor(z / GRID)) || []) {
      const b = p.box;
      if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && p.outline.inside(x, z)) return true;
    }
    return false;
  }
}
/** A park's kind at (x, z): its own all over where it's `forced` (by hand or its tags), or bush in a pocket and formal elsewhere */
export const kindAt = (park, x, z, pockets) => park.forced ?? (pockets?.at(x, z) ? 'bush' : 'formal');
/** Whether a park is formal anywhere: not bush all over */
const anyFormal = (p) => (p.forced ?? 'formal') === 'formal';

/**
 * The paths of the parks by rule, from OSM's ways in their order, each { tags, pts: [[x, z], ...], kind (0 a footpath, 1 steps, 2 a
 * cycleway), surface, width(kind) } (tools/build-garden.mjs reads them as for the areas): kept in runs where a park is within REACH, a
 * hand-made area isn't (`inArea(x, z)`: its paths are the area's), and `clear(x, z)` (off the roads, out of buildings, on land, with room
 * to walk, out of the lakes and the model sites' cuts), in a tile `within(x, z)` says is laid out now. Each run is of one kind, the kind
 * at each point (kindAt(), in the smallest park a point is in, `pockets` the bush), a path's kind by it (tools/garden-areas.mjs
 * pathKind()). Where a run meets one of an area's, it starts or ends on the area's last point, so the two join. Adds each run's metres to
 * its park's `metres`. Returns { paths: [[kind, surface, width, x, z, ...]], metres, byKind }.
 */
export function parkPaths(ways, index, { inArea, clear, within = () => true, pockets = null }) {
  const paths = [];
  const byKind = [0, 0, 0, 0];
  let metres = 0;
  for (const way of ways) {
    const { pts } = way;
    // Every point it's tested at, as an area's are: each segment's, STEP apart, its first point once
    const xs = [], zs = [];
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / STEP));
      for (let k = i === 1 ? 0 : 1; k <= n; k++) {
        xs.push(ax + ((bx - ax) * k) / n);
        zs.push(az + ((bz - az) * k) / n);
      }
    }
    // ...and each one's: 0 left out, 1 a park's, 2 an area's (where its own path runs); and the park it's in (within REACH)
    const flag = new Uint8Array(xs.length);
    const parkOf = new Array(xs.length).fill(null);
    const kindOf = new Array(xs.length).fill(null);
    let any = false;
    for (let s = 0; s < xs.length; s++) {
      const x = xs[s], z = zs[s];
      if (!within(x, z)) continue;
      const area = inArea(x, z);
      const park = area ? null : index.at(x, z, REACH);
      if (!area && !park) continue;
      if (!clear(x, z)) continue;
      flag[s] = area ? 2 : 1;
      parkOf[s] = park;
      if (park) kindOf[s] = kindAt(park, x, z, pockets);
      if (!area) any = true;
    }
    if (!any) continue;
    // Its runs, a path's own corners kept, the points between them only where a run starts or ends
    const corner = new Uint8Array(xs.length);
    {
      let s = 0;
      for (let i = 1; i < pts.length; i++) {
        const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / STEP));
        if (i === 1) corner[s++] = 1;
        s += n - 1;
        corner[s++] = 1;
      }
    }
    // Stretches kept, each in runs through parks of one kind; where the kind changes, the next run starts on the last one's last point,
    // so the two join
    const runs = [];
    for (let s = 0; s < xs.length;) {
      if (flag[s] !== 1) { s++; continue; }
      let e = s;
      while (e + 1 < xs.length && flag[e + 1] === 1) e++;
      const first = runs.length;
      let start = s, kind = kindOf[s];
      for (let k = s + 1; k <= e; k++) {
        if (kindOf[k] === kind) continue;
        runs.push([start, k - 1, kind]);
        start = k - 1;
        kind = kindOf[k];
      }
      runs.push([start, e, kind]);
      // Joined to an area's path either side
      if (s > 0 && flag[s - 1] === 2) runs[first][0] = s - 1;
      if (e + 1 < xs.length && flag[e + 1] === 2) runs[runs.length - 1][1] = e + 1;
      s = e + 1;
    }
    for (const [from, to, kind] of runs) {
      const run = [];
      for (let k = from; k <= to; k++) if (k === from || k === to || corner[k]) run.push([xs[k], zs[k]]);
      if (run.length < 2) continue;
      const line = rdp(run, 0.25);
      let L = 0;
      for (let i = 1; i < line.length; i++) L += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
      if (L < 2) continue;
      // A track or a path laid with a kerb, by the parks it runs through; its metres the park's at its middle
      const mid = (from + to) >> 1;
      let park = null;
      for (let d = 0; !park && d <= to - from; d++) for (const k of [mid + d, mid - d]) if (!park && k >= from && k <= to && kindOf[k] === kind) park = parkOf[k];
      const k = pathKind(way.kind, way.surface, kind, false);
      paths.push([k, way.surface, q1(way.width(k)), ...flat(line)]);
      park.metres = (park.metres || 0) + L;
      metres += L;
      byKind[k] += L;
    }
  }
  return { paths, metres, byKind };
}

const squareKey = (i, j) => i * 100000 + j;
/** Each item's 240 m squares, by its box `pad` m wider: Map(squareKey() -> [items]) */
function bySquare(items, boxOf, pad) {
  const out = new Map();
  for (const it of items) {
    const b = boxOf(it);
    for (let i = Math.floor((b.x0 - pad) / SQUARE); i <= Math.floor((b.x1 + pad) / SQUARE); i++) {
      for (let j = Math.floor((b.z0 - pad) / SQUARE); j <= Math.floor((b.z1 + pad) / SQUARE); j++) {
        const key = i * 100000 + j;
        (out.get(key) || out.set(key, []).get(key)).push(it);
      }
    }
  }
  return out;
}
const flatBox = (f) => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let k = 0; k + 1 < f.length; k += 2) { x0 = Math.min(x0, f[k]); x1 = Math.max(x1, f[k]); z0 = Math.min(z0, f[k + 1]); z1 = Math.max(z1, f[k + 1]); }
  return { x0, x1, z0, z1 };
};
const ringOf = (f) => { const out = []; for (let k = 0; k + 1 < f.length; k += 2) out.push([f[k], f[k + 1]]); return out; };

/**
 * The raised lawn of the parks by rule (those formal anywhere with `metres` of path, MIN_PATHS or more), a 240 m square at a time, in
 * the squares `squares` ([i, j], the square from (i, j) * SQUARE, in the order they're laid out). In each: raised where the park is
 * formal (kindAt(), the smaller of two parks over each other saying, `pockets` the bush, each { outer, holes, box }), and nothing in a
 * hand-made area (`areas`, its rings) or a model site's cut (`cuts`, rings); on the map's lawn (`lawns`, its pieces), less the paved areas
 * (`plazas`, [{ surface, rings }], traced as its own), the kerbed paths' corridors (`paths`, the areas' and the parks', so an area's path
 * that reaches into a park has its corridor there too), the lakes (`lakes`, tools/build-ponds.mjs's pieces [level, outer, ...holes]) with
 * BANK round their edges, and the sand and rock (`sand`); and not in a tile the map hasn't (`mapTile(ix, iz)`, `tile` m). Kerbed in concrete.
 * Returns { lawns, plazas, stats }.
 */
export function parkLawns(squares, { parks, pockets = [], areas = [], cuts = [], lawns, plazas = [], paths, lakes = [], sand = [], mapTile = () => true, tile = 1000 }) {
  const out = { lawns: [], plazas: [], stats: { squares: 0, pieces: 0, area: 0, moved: 0, kept: 0, corners: 0, plazaArea: 0 } };
  // The bigger first, so a smaller park over it has its say; one formal anywhere only with its paths
  const shown = parks.filter((p) => !anyFormal(p) || (p.metres || 0) >= MIN_PATHS)
    .sort((p, q) => q.area - p.area || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  const pocketSq = bySquare(pockets, (p) => p.box, 10);
  const parkSq = bySquare(shown, (p) => bbox(p.rings.flat()), 10);
  const lawnSq = bySquare(lawns, (rings) => flatBox(rings[0]), 10);
  const plazaSq = bySquare(plazas, (p) => bbox(p.rings[0]), 10);
  const pathSq = bySquare(paths.filter(([kind, surface]) => kind !== 3 && surface !== 4), ([, , width, ...line]) => {
    const b = flatBox(line);
    return { x0: b.x0 - width, z0: b.z0 - width, x1: b.x1 + width, z1: b.z1 + width };
  }, 10);
  const lakeSq = bySquare(lakes, ([, outer]) => flatBox(outer), 10);
  const sandSq = bySquare(sand, ([, outer]) => flatBox(outer), 10);
  const areaSq = bySquare(areas, (rings) => bbox(rings.flat()), 10);
  const cutSq = bySquare(cuts, (ring) => bbox(ring), 10);
  for (const [i, j] of squares) {
    const key = squareKey(i, j);
    const here = parkSq.get(key) || [];
    if (!here.some(anyFormal) || !lawnSq.has(key)) continue;
    const box = { x0: i * SQUARE, z0: j * SQUARE, x1: (i + 1) * SQUARE, z1: (j + 1) * SQUARE };
    // Each cell's park (the smallest it's in), and whether it's in the bush: raised where that park is formal there (kindAt())
    const fill = (raised, ringLines) => {
      const grid = (Type) => new Raster(raised.x0, raised.z0, raised.x0 + (raised.w - 1) * raised.res, raised.z0 + (raised.h - 1) * raised.res, raised.res, Type);
      const owner = grid(Int32Array), bush = grid(Uint8Array);
      here.forEach((p, k) => {
        for (const ring of p.rings) { owner.fillRing(ring, k + 1); ringLines(ring); }
        if (anyFormal(p)) for (const ring of p.holes) { owner.fillRing(ring, 0); ringLines(ring); }
      });
      const one = grid(Uint8Array);
      for (const pk of pocketSq.get(key) || []) {
        one.d.fill(0);
        for (const ring of pk.outer) { one.fillRing(ring, 1); ringLines(ring); }
        for (const ring of pk.holes) { one.fillRing(ring, 0); ringLines(ring); }
        for (let c = 0; c < one.d.length; c++) bush.d[c] |= one.d[c];
      }
      for (let c = 0; c < raised.d.length; c++) {
        const p = owner.d[c] ? here[owner.d[c] - 1] : null;
        raised.d[c] = p && (p.forced ?? (bush.d[c] ? 'bush' : 'formal')) === 'formal' ? 1 : 0;
      }
      for (const rings of areaSq.get(key) || []) for (const ring of rings) { raised.fillRing(ring, 0); ringLines(ring); }
      for (const ring of cutSq.get(key) || []) { raised.fillRing(ring, 0); ringLines(ring); }
      // ...nor in a tile the map hasn't
      for (let ix = Math.floor((box.x0 - MARGIN) / tile); ix <= Math.floor((box.x1 + MARGIN) / tile); ix++) {
        for (let iz = Math.floor((box.z0 - MARGIN) / tile); iz <= Math.floor((box.z1 + MARGIN) / tile); iz++) {
          if (mapTile(ix, iz)) continue;
          const ring = [[ix * tile, iz * tile], [(ix + 1) * tile, iz * tile], [(ix + 1) * tile, (iz + 1) * tile], [ix * tile, (iz + 1) * tile]];
          raised.fillRing(ring, 0);
          ringLines(ring);
        }
      }
    };
    const wet = [];
    for (const [, outer, ...holes] of lakeSq.get(key) || []) {
      wet.push({ ring: ringOf(outer), val: 1, bank: BANK });
      for (const h of holes) wet.push({ ring: ringOf(h), val: 0, bank: BANK });
    }
    const traced = traceRaised({ box, margin: MARGIN, fill, lawns: lawnSq.get(key) || [], plazas: plazaSq.get(key) || [], paths: pathSq.get(key) || [],
      wet, sand: sandSq.get(key) || [], kerbOf: () => 0, crossing: true });
    out.lawns.push(...traced.lawns);
    out.plazas.push(...traced.plazas);
    out.stats.squares++;
    for (const k of ['pieces', 'area', 'moved', 'kept', 'corners', 'plazaArea']) out.stats[k] += traced.stats[k];
  }
  return out;
}
