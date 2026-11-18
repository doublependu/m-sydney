// tools/heights/levels.mjs: heights given by hand to tunnels and bridges (tools/local/*.json `levels`, read by tools/local-edits.mjs), for
// tools/build-heights.mjs, which takes them into its fixed points as it takes the Harbour Bridge's deck. Where a dozen tunnels meet near
// their mouths, three or four deep (Woolloomooloo), no set of heights its solve finds keeps them all apart, so a long section is drawn by
// hand and the solve fits everything else round it.
//
// A level is a list of points [x, z, y] along one or more ways (a tunnel and the ways it carries on into): the road passes through each
// point at its height, and runs at a straight grade between two of them. Every point of the tunnels and bridges along the ways between a
// level's first and last point is fixed; never a road on the ground. Points off their ways or their tunnels and bridges, or two points
// with none between them along the ways, stop the build.
//
// The solve doesn't keep a fixed road's crossings for it: only bridges rise and tunnels sink, and two tunnels of one OSM layer are put in
// the order they stand in, which can flip as it goes. Each crossing between a levelled road and another is the levels' to keep 6.8 m
// apart, and the tunnels round a level's end may need levels of their own, keeping them as they were, or the solve sinks them.

/** How a level is matched to the roads worked out from OSM */
export const LEVELS = {
  ON_WAY: 1, // m: a road worked out from OSM whose every point is this near one of the level's ways is that way's
  NEAR: 4 // m: each of a level's points has a point of its road this near it
};

const segDistance = (x, z, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
  return { d: Math.hypot(ax + dx * t - x, az + dz * t - z), t };
};
const lineDistance = (pts, x, z) => {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, segDistance(x, z, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]).d);
  return best;
};

/** The shortest road from sample a to sample b through the samples allowed, as a list of samples; null if there's none */
function pathBetween(a, b, allowed, nbr) {
  const dist = new Map([[a, 0]]), from = new Map();
  const open = [[0, a]];
  while (open.length) {
    let k = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[k][0]) k = i;
    const [d, i] = open.splice(k, 1)[0];
    if (i === b) break;
    if (d > dist.get(i)) continue;
    for (const [j, step] of nbr[i]) {
      if (!allowed.has(j)) continue;
      const next = d + step;
      if (next < (dist.get(j) ?? Infinity)) { dist.set(j, next); from.set(j, i); open.push([next, j]); }
    }
  }
  if (!dist.has(b)) return null;
  const path = [b];
  while (path[0] !== a) path.unshift(from.get(path[0]));
  return path;
}

/**
 * The height each level fixes, by sample.
 * levels: [{ name, ways: [[[x, z], ...], ...], at: [[x, z, y], ...] }] (tools/local-edits.mjs localLevels()): each way's points in the
 * game's frame. samples: [{ x, z }]; links: [{ pts: [[x, z], ...], chain: [sample, ...], structure }], each road's points and its
 * samples in order; nbr: each sample's neighbours along the roads, [[sample, m], ...]. Returns a Map sample -> height.
 */
export function levelSamples(levels, { samples, links, nbr }) {
  const out = new Map();
  for (const level of levels) {
    const xs = level.ways.flatMap((w) => w.map((p) => p[0])), zs = level.ways.flatMap((w) => w.map((p) => p[1]));
    const box = [Math.min(...xs) - 5, Math.min(...zs) - 5, Math.max(...xs) + 5, Math.max(...zs) + 5];
    // The roads along the level's ways, and their samples
    const allowed = new Set();
    for (const l of links) {
      if (!l.pts.every(([x, z]) => x > box[0] && x < box[2] && z > box[1] && z < box[3])) continue;
      // Tunnels and bridges only: where a way comes out onto the ground, a level stops short of it
      if (!l.structure || !l.pts.every(([x, z]) => level.ways.some((w) => lineDistance(w, x, z) <= LEVELS.ON_WAY))) continue;
      for (const idx of l.chain) allowed.add(idx);
    }
    if (!allowed.size) throw new Error(`${level.name}: no tunnel or bridge of the map lies along its ways`);
    const nearest = ([x, z]) => {
      let best = -1, bd = Infinity;
      for (const idx of allowed) {
        const d = Math.hypot(samples[idx].x - x, samples[idx].z - z);
        if (d < bd) { bd = d; best = idx; }
      }
      if (bd > LEVELS.NEAR) throw new Error(`${level.name}: its point (${x}, ${z}) is ${bd.toFixed(1)} m from its road`);
      return best;
    };
    // The road from the first point to the last, through each in turn
    const ends = level.at.map(nearest);
    const path = [ends[0]];
    for (let k = 1; k < ends.length; k++) {
      if (ends[k] === path[path.length - 1]) continue;
      const leg = pathBetween(path[path.length - 1], ends[k], allowed, nbr);
      if (!leg) throw new Error(`${level.name}: no road along its ways from (${level.at[k - 1].slice(0, 2).join(', ')}) to (${level.at[k].slice(0, 2).join(', ')})`);
      path.push(...leg.slice(1));
    }
    if (new Set(path).size !== path.length) throw new Error(`${level.name}: its road comes back on itself: its points are out of order`);
    // Distance along it, each point placed on it where it's nearest (by the leg its nearest sample ends or starts)
    const along = [0];
    for (let k = 1; k < path.length; k++) along.push(along[k - 1] + Math.hypot(samples[path[k]].x - samples[path[k - 1]].x, samples[path[k]].z - samples[path[k - 1]].z));
    const placed = level.at.map(([x, z, y], k) => {
      const i = path.indexOf(ends[k]);
      let best = { d: Infinity, s: along[i] };
      for (const j of [i - 1, i]) {
        if (j < 0 || j + 1 >= path.length) continue;
        const p = samples[path[j]], q = samples[path[j + 1]];
        const { d, t } = segDistance(x, z, p.x, p.z, q.x, q.z);
        if (d < best.d) best = { d, s: along[j] + t * (along[j + 1] - along[j]) };
      }
      return [best.s, y];
    });
    for (let k = 1; k < placed.length; k++) {
      if (placed[k][0] < placed[k - 1][0] - 1e-6) throw new Error(`${level.name}: its points are out of order at (${level.at[k].slice(0, 2).join(', ')})`);
    }
    // Each sample's height: straight between the points either side of it, the first and last grades carried on to the path's ends
    const heightAt = (s) => {
      let k = 1;
      while (k < placed.length - 1 && placed[k][0] < s) k++;
      const [s0, y0] = placed[Math.max(0, k - 1)], [s1, y1] = placed[Math.min(placed.length - 1, k)];
      return s1 - s0 > 1e-6 ? y0 + ((y1 - y0) * (s - s0)) / (s1 - s0) : y0;
    };
    path.forEach((idx, k) => {
      const y = heightAt(along[k]);
      if (out.has(idx) && Math.abs(out.get(idx) - y) > 0.05) {
        throw new Error(`${level.name}: at (${samples[idx].x.toFixed(1)}, ${samples[idx].z.toFixed(1)}) it gives ${y.toFixed(2)} m, another level ${out.get(idx).toFixed(2)} m`);
      }
      out.set(idx, y);
    });
  }
  return out;
}
