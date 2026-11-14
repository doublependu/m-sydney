// tools/stack-pieces.mjs: pieces of buildings that stand inside another piece, over the same heights, would draw their walls in its
// planes (z-fighting: two window grids at once, and the shorter one's coping through the taller one's wall). Overture draws most of a
// tower's parts as whole outlines from the podium up, one inside the next, and some buildings inside others. So, shortest first, a
// piece inside another that covers its bottom starts at that piece's top, again and again, and one inside a piece that covers all of
// its heights is left out: what's drawn takes up the same space as before, with no two walls in one plane.
// Used by tools/build-buildings.mjs; recordings and tests can run it over the generated data.

/** How far a corner may stand outside the other piece's outline and still count as inside: footprints are kept to 0.5 m */
export const INSIDE_TOLERANCE = 0.6;
/** Along an outline's edges, a point every this many metres must be inside too, not just its corners */
const SAMPLE = 1;
const CELL = 64;

function inRing(ring, x, z) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[j];
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) c = !c;
  }
  return c;
}
function nearRing(ring, x, z, reach) {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[j], [bx, bz] = ring[i];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
    if (Math.hypot(ax + dx * t - x, az + dz * t - z) <= reach) return true;
  }
  return false;
}
// In one of the polygons and not in its courtyards, or within reach of any of their rings
const covers = (polygons, x, z, reach) => polygons.some((rings) => (inRing(rings[0], x, z) && !rings.slice(1).some((h) => inRing(h, x, z)))
  || rings.some((ring) => nearRing(ring, x, z, reach)));

/** Points along each of a piece's outer rings, its corners among them */
function samples(polygons) {
  const out = [];
  for (const [outer] of polygons) {
    for (let i = 0; i < outer.length; i++) {
      const [ax, az] = outer[i], [bx, bz] = outer[(i + 1) % outer.length];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / SAMPLE));
      for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
    }
  }
  return out;
}

/** Whether two pieces have walls in one plane facing the same way, 1 m or more along: their rings wind the same way round */
function sharesWall(p, q) {
  const edges = (polygons) => polygons.flatMap((rings) => rings.flatMap((ring) => ring.map((a, k) => {
    const b = ring[(k + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return L < 1 ? null : [a[0], a[1], (b[0] - a[0]) / L, (b[1] - a[1]) / L, L];
  }).filter(Boolean)));
  const E = edges(q.polygons);
  for (const e of edges(p.polygons)) {
    for (const f of E) {
      // The shorter wall's ends on the longer one's line
      const [[ax, az, ux, uz, L], [cx, cz, vx, vz, M]] = e[4] >= f[4] ? [e, f] : [f, e];
      if (ux * vx + uz * vz < 0.9995) continue;
      const off = (x, z) => Math.abs((x - ax) * -uz + (z - az) * ux);
      if (off(cx, cz) > 0.05 || off(cx + vx * M, cz + vz * M) > 0.05) continue;
      const t1 = (cx - ax) * ux + (cz - az) * uz, t2 = t1 + M * (vx * ux + vz * uz);
      if (Math.min(L, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2)) >= 1) return true;
    }
  }
  return false;
}

/**
 * pieces: [{ polygons: [[outer, ...holes]] with rings of [x, z] in metres, outer rings counterclockwise and courtyards clockwise,
 * bottom, top }], heights in whole metres as they're written. `wallsOnly(i, j)`: whether piece i may be stacked on j or left out for
 * it only where their walls meet in a plane (separate buildings: one wholly inside another draws nothing in its planes).
 * `mayStack(i, j)`: whether piece i may stand on j; where it may not, it stays as it is, though it's still left out where j hides it.
 * Returns { bottom, out, on, splits }: each piece's new bottom; for a piece left out, the piece that hides it (else -1); the pieces
 * each was stacked on, in turn (else none). splits lists [i, j] where piece i is inside j and j starts partway up i: j
 * covers i's top but not its bottom, so they still share walls there. The order of `pieces` only breaks ties.
 */
export function stackPieces(pieces, { reach = INSIDE_TOLERANCE, wallsOnly = () => false, mayStack = () => true } = {}) {
  const n = pieces.length;
  const bottom = pieces.map((p) => p.bottom), top = pieces.map((p) => p.top);
  const out = new Array(n).fill(-1), on = pieces.map(() => []);
  const box = pieces.map(({ polygons }) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [outer] of polygons) for (const [x, z] of outer) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    return [x0, x1, z0, z1];
  });
  const grid = new Map();
  box.forEach(([x0, x1, z0, z1], i) => {
    for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) {
      for (let gz = Math.floor(z0 / CELL); gz <= Math.floor(z1 / CELL); gz++) {
        const k = gx * 100000 + gz;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    }
  });
  // The pieces each one is inside: they hold its first corner, so they're in that corner's cell
  const inside = pieces.map(({ polygons }, i) => {
    const [x0, x1, z0, z1] = box[i];
    const [fx, fz] = polygons[0][0][0];
    const list = (grid.get(Math.floor(fx / CELL) * 100000 + Math.floor(fz / CELL)) || []).filter((j) => j !== i
      && box[j][0] - reach <= x0 && box[j][1] + reach >= x1 && box[j][2] - reach <= z0 && box[j][3] + reach >= z1);
    if (!list.length) return list;
    const points = samples(polygons);
    return list.filter((j) => points.every(([x, z]) => covers(pieces[j].polygons, x, z, reach)) && (!wallsOnly(i, j) || sharesWall(pieces[i], pieces[j])));
  });
  const order = [...pieces.keys()].sort((p, q) => top[p] - top[q] || p - q);
  for (const i of order) {
    for (;;) {
      // The pieces it's inside that cover its bottom
      const under = inside[i].filter((j) => out[j] < 0 && bottom[j] <= bottom[i] && top[j] > bottom[i]);
      if (!under.length) break;
      const hides = under.find((j) => top[j] >= top[i]);
      if (hides !== undefined) { out[i] = hides; break; }
      const below = under.filter((j) => mayStack(i, j));
      if (!below.length) break;
      const j = below.reduce((a, c) => (top[c] > top[a] ? c : a));
      bottom[i] = top[j];
      on[i].push(j);
    }
  }
  const splits = [];
  for (let i = 0; i < n; i++) {
    if (out[i] >= 0) continue;
    for (const j of inside[i]) if (out[j] < 0 && bottom[j] > bottom[i] && bottom[j] < top[i]) splits.push([i, j]);
  }
  return { bottom, out, on, splits };
}
