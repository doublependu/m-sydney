// Lawn and footpath outlines that cross themselves, untangled where the tiles are written (tools/build-tiles.mjs). The outlines are
// traced and simplified a 240 m square at a time (tiledPolygons(), tools/geo-common.mjs), and simplifying two edges that run within a
// metre of each other can push one past the other: an inner corner out through the outer edge, or a hole out through the outline. A
// triangulator given such a ring lays triangles over each other and out over the road.
//
// A piece is [outer, ...holes], each ring flat [x0, z0, x1, z1, ...]. What it should cover is where its outline winds round once more
// than its holes do: the outer ring's own way round counts +1, a hole's -1 (whichever way it was written). Every crossing is cut into
// the rings as a point, and at each the two paths through it are joined the other way round, which keeps the winding and leaves loops
// that only touch. The loops that bound what's covered are kept: the outlines, and the holes, each hole with the outline round it.
// Loops wound the wrong way (an inverted sliver where a corner went past an edge) bound nothing covered and are dropped. A piece with
// no crossing comes back as it was, the same arrays.

const q1 = (v) => Math.round(v * 10) / 10;

const orient = (ax, az, bx, bz, cx, cz) => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);

/** Twice a ring's signed area, of [[x, z], ...] */
function area2(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a;
}

const toPoints = (flat) => {
  const pts = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const p = pts[pts.length - 1];
    if (!p || p[0] !== flat[i] || p[1] !== flat[i + 1]) pts.push([flat[i], flat[i + 1]]);
  }
  while (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  return pts;
};

/**
 * Every pair of edges among `rings` ([[x, z], ...] each) that cross each other, as [ring, edge, ring, edge, t, u, x, z]: edge i runs
 * from point i to point i + 1, t and u are how far along each the crossing is. Only edges that pass through each other count: two
 * that touch, end to end or a point on an edge, don't. A grid of cells, so the cost follows the rings' length.
 */
export function crossings(rings, cell = 4) {
  const edges = [];
  rings.forEach((r, ri) => r.forEach((p, i) => edges.push([ri, i, p, r[(i + 1) % r.length]])));
  const grid = new Map(), found = [], seen = new Set();
  edges.forEach((e, k) => {
    const [ri, i, a, b] = e;
    for (let gx = Math.floor(Math.min(a[0], b[0]) / cell); gx <= Math.floor(Math.max(a[0], b[0]) / cell); gx++) {
      for (let gz = Math.floor(Math.min(a[1], b[1]) / cell); gz <= Math.floor(Math.max(a[1], b[1]) / cell); gz++) {
        const key = gx * 1e7 + gz;
        let list = grid.get(key);
        if (!list) grid.set(key, list = []);
        for (const j of list) {
          const [rj, jj, c, d] = edges[j];
          if (seen.has(j * edges.length + k)) continue;
          seen.add(j * edges.length + k);
          // Edges next to each other in a ring share a point, and that isn't a crossing
          if (rj === ri) {
            const n = rings[ri].length, gap = Math.abs(jj - i);
            if (gap <= 1 || gap === n - 1) continue;
          }
          const o1 = orient(a[0], a[1], b[0], b[1], c[0], c[1]), o2 = orient(a[0], a[1], b[0], b[1], d[0], d[1]);
          const o3 = orient(c[0], c[1], d[0], d[1], a[0], a[1]), o4 = orient(c[0], c[1], d[0], d[1], b[0], b[1]);
          if (!(((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0)))) continue;
          const t = o3 / (o3 - o4), u = o1 / (o1 - o2);
          found.push([rj, jj, ri, i, u, t, c[0] + (d[0] - c[0]) * u, c[1] + (d[1] - c[1]) * u]);
        }
        list.push(k);
      }
    }
  });
  return found;
}

/** Whether any ring of a piece (flat rings) crosses itself or another */
export function piecesCross(rings) {
  return crossings(rings.map(toPoints).filter((r) => r.length >= 3)).length > 0;
}

// How many times the rings wind round (x, z): +1 for each that goes round it the way area2 counts positive, -1 the other way
function winding(rings, x, z) {
  let w = 0;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [ax, az] = r[j], [bx, bz] = r[i];
      if (az <= z) {
        if (bz > z && orient(ax, az, bx, bz, x, z) > 0) w++;
      } else if (bz <= z && orient(ax, az, bx, bz, x, z) < 0) w--;
    }
  }
  return w;
}

function pointInRing(r, x, z) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [ax, az] = r[i], [bx, bz] = r[j];
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}

// Points just either side of a loop, off the middle of its longest edge: [left, right]
function besideLoop(loop) {
  let best = 0, bestLength = -1;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > bestLength) { best = i; bestLength = length; }
  }
  const a = loop[best], b = loop[(best + 1) % loop.length];
  const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, off = Math.min(1e-3, bestLength / 4) / bestLength;
  const nx = -(b[1] - a[1]) * off, nz = (b[0] - a[0]) * off;
  return [[mx + nx, mz + nz], [mx - nx, mz - nz]];
}

/**
 * A piece's rings untangled: { pieces, changed, area, dropped }. `pieces` is [[outer, ...holes], ...], flat and rounded to 0.1 m as the
 * map's are, the outlines wound as the piece's outer ring was and the holes as its holes were (or the other way where it had none).
 * Splitting can make two pieces of one, where a crossing cut it in two. Where it changed: `area` is what the pieces cover, `dropped`
 * the area of the loops left out (wound the wrong way, or inside an outline already). `depth` is for its own use.
 */
export function untangle(rings, depth = 0) {
  const pts = rings.map(toPoints);
  const kept = pts.map((r, i) => r.length >= 3 && (i === 0 || Math.abs(area2(r)) > 0));
  if (!kept[0] || !crossings(pts.filter((r, i) => kept[i])).length) return { pieces: [rings], changed: false, dropped: 0 };

  // Which way round counts: the outer ring's way, and a hole the other way whichever way it was written. The holes written the outer's
  // way are turned round first: joined at a crossing as they were written, the loops would mix the edges of what's covered with others.
  const outerSign = Math.sign(area2(pts[0])) || 1;
  const holeSign = rings.length > 1 ? Math.sign(area2(pts[1])) || -outerSign : -outerSign;
  const loopsIn = pts.filter((r, i) => kept[i]).map((r, i) => (i && Math.sign(area2(r)) === outerSign ? r.slice().reverse() : r));
  const found = crossings(loopsIn);

  // The points along each edge: its own start, then its crossings in order. A crossing is one node, met by two edges.
  const along = loopsIn.map((r) => r.map(() => []));
  found.forEach(([ra, ea, rb, eb, t, u, x, z], id) => {
    along[ra][ea].push([t, id, x, z]);
    along[rb][eb].push([u, id, x, z]);
  });
  // The nodes: each ring's own points, and the crossings, each met by two edges. The steps: from each node of a ring to its next.
  const nodes = [], outOf = [], inTo = [], steps = [];
  const node = (x, z) => { nodes.push([x, z]); outOf.push([]); inTo.push([]); return nodes.length - 1; };
  const crossingNode = found.map(() => -1);
  loopsIn.forEach((r, ri) => {
    const sequence = [];
    r.forEach((p, i) => {
      sequence.push(node(p[0], p[1]));
      for (const [, id, x, z] of along[ri][i].sort((m, n) => m[0] - n[0])) {
        if (crossingNode[id] < 0) crossingNode[id] = node(x, z);
        sequence.push(crossingNode[id]);
      }
    });
    const first = steps.length;
    sequence.forEach((from, k) => {
      const to = sequence[(k + 1) % sequence.length];
      outOf[from].push(steps.length);
      inTo[to].push(steps.length);
      steps.push({ from, to, next: k + 1 < sequence.length ? steps.length + 1 : first });
    });
  });
  // At a crossing each step in takes the other edge's step out, not its own edge's: the two paths through it then touch, not cross
  for (let k = 0; k < nodes.length; k++) {
    if (inTo[k].length !== 2) continue;
    const [a, b] = inTo[k];
    [steps[a].next, steps[b].next] = [steps[b].next, steps[a].next];
  }

  // The loops: follow the joins from each step not yet walked, in the rings' order, so a ring with no crossing comes back as it was
  const walked = new Uint8Array(steps.length);
  let loops = [];
  for (let k = 0; k < steps.length; k++) {
    if (walked[k]) continue;
    const loop = [];
    for (let s = k; !walked[s]; s = steps[s].next) {
      walked[s] = 1;
      loop.push(steps[s].from);
    }
    loops.push(loop);
  }
  // A loop through one crossing twice touches itself there: two loops
  const split = [];
  while (loops.length) {
    const loop = loops.pop();
    const first = new Map();
    let cut = null;
    for (let i = 0; i < loop.length && !cut; i++) {
      if (first.has(loop[i])) cut = [first.get(loop[i]), i];
      else first.set(loop[i], i);
    }
    if (!cut) split.push(loop);
    else loops.push(loop.slice(cut[0], cut[1]), [...loop.slice(cut[1]), ...loop.slice(0, cut[0])]);
  }
  loops = split.map((loop) => loop.map((n) => [nodes[n][0], nodes[n][1]])).filter((loop) => loop.length >= 3 && Math.abs(area2(loop)) > 1e-9);

  // The loops between covered and not: an outline has the covered side inside, a hole outside
  const outlines = [], holes = [];
  let dropped = 0;
  for (const loop of loops) {
    const [left, right] = besideLoop(loop);
    // Inside a loop is on its left where area2 > 0, the way round winding() counts +1
    const [inside, outside] = area2(loop) > 0 ? [left, right] : [right, left];
    const covered = (p) => winding(loopsIn, p[0], p[1]) * outerSign > 0;
    const a = covered(inside), b = covered(outside);
    if (a && !b) outlines.push(loop);
    else if (!a && b) holes.push(loop);
    else dropped += Math.abs(area2(loop)) / 2;
  }
  const wound = (loop, sign) => (Math.sign(area2(loop)) === sign ? loop : loop.slice().reverse());
  const flatOf = (loop) => {
    const out = [];
    for (const [x, z] of loop) {
      const rx = q1(x), rz = q1(z);
      if (out.length && out[out.length - 2] === rx && out[out.length - 1] === rz) continue;
      out.push(rx, rz);
    }
    while (out.length > 2 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2;
    return out;
  };
  outlines.sort((p, q) => Math.abs(area2(p)) - Math.abs(area2(q)));
  const pieces = outlines.map((o) => [o]);
  for (const h of holes) {
    const [p] = besideLoop(h);
    const home = pieces.find(([o]) => pointInRing(o, p[0], p[1]));
    if (home) home.push(h);
  }
  const result = pieces
    .map(([o, ...hs]) => [flatOf(wound(o, outerSign)), ...hs.map((h) => flatOf(wound(h, holeSign)))])
    .map(([o, ...hs]) => [o, ...hs.filter((h) => h.length >= 6)])
    .filter(([o]) => o.length >= 6)
    .sort((p, q) => Math.abs(area2(toPoints(q[0]))) - Math.abs(area2(toPoints(p[0]))))
    // Rounded to 0.1 m, a point can come to cross an edge again: once more
    .flatMap((piece) => (depth < 2 && piecesCross(piece) ? untangle(piece, depth + 1).pieces : [piece]));
  const covers = result.reduce((t, [o, ...hs]) => t + (Math.abs(area2(toPoints(o))) - hs.reduce((s, h) => s + Math.abs(area2(toPoints(h))), 0)) / 2, 0);
  return { pieces: result, changed: true, area: covers, dropped };
}
