// For tests/building-geodata.test.cjs and the scripts that look for z-fighting: walls of two buildings (or two pieces of one) drawn in
// one plane, facing the same way, over the same heights. Walls back to back don't count: the facades draw only their front faces.

/**
 * buildings: [{ height, bottom, polygons: [{ outer, holes }] }] with points { x, z }, as the tiles have them. Returns the pairs that
 * share wall, [{ a, b, along, area, x, z }] with a < b their indices, along and area what they share (m, m²) and x, z on one wall.
 */
export function coplanarWalls(buildings, { along: minAlong = 1, up: minUp = 1, off = 0.05 } = {}) {
  const CELL = 50;
  const grid = new Map();
  const walls = []; // [building, ax, az, ux, uz, nx, nz, length]
  buildings.forEach((b, r) => {
    if (!(b.height > (b.bottom || 0))) return;
    for (const polygon of b.polygons) {
      [polygon.outer, ...(polygon.holes || [])].forEach((ring, k) => {
        let pts = ring.slice();
        if (pts.length > 1 && pts[0].x === pts.at(-1).x && pts[0].z === pts.at(-1).z) pts.pop();
        let area = 0;
        for (let p = pts.length - 1, q = 0; q < pts.length; p = q++) area += pts[p].x * pts[q].z - pts[q].x * pts[p].z;
        // Outer rings one way round, courtyards the other, as THREE.ShapeUtils winds them for the walls
        if ((area < 0) !== (k === 0)) pts = pts.reverse();
        for (let j = 0; j < pts.length; j++) {
          const a = pts[j], c = pts[(j + 1) % pts.length];
          const dx = c.x - a.x, dz = c.z - a.z, len = Math.hypot(dx, dz);
          if (len < minAlong) continue;
          const w = walls.length;
          walls.push([r, a.x, a.z, dx / len, dz / len, -dz / len, dx / len, len]);
          for (let gx = Math.floor(Math.min(a.x, c.x) / CELL); gx <= Math.floor(Math.max(a.x, c.x) / CELL); gx++) {
            for (let gz = Math.floor(Math.min(a.z, c.z) / CELL); gz <= Math.floor(Math.max(a.z, c.z) / CELL); gz++) {
              const key = gx * 100000 + gz;
              if (!grid.has(key)) grid.set(key, []);
              grid.get(key).push(w);
            }
          }
        }
      });
    }
  });
  const shared = new Map(); // "wall:wall" -> what they share, so walls in two cells count once
  for (const list of grid.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        // The shorter wall's ends on the longer one's line: the other way round, two walls a hair off parallel count or not by which
        // comes first
        let A = walls[list[i]], C = walls[list[j]];
        if (C[7] > A[7]) [A, C] = [C, A];
        if (A[0] === C[0] || A[3] * C[3] + A[4] * C[4] < 0.9995) continue;
        const cx1 = C[1] + C[3] * C[7], cz1 = C[2] + C[4] * C[7];
        const d1 = (C[1] - A[1]) * A[5] + (C[2] - A[2]) * A[6], d2 = (cx1 - A[1]) * A[5] + (cz1 - A[2]) * A[6];
        if (Math.abs(d1) > off || Math.abs(d2) > off) continue;
        const t1 = (C[1] - A[1]) * A[3] + (C[2] - A[2]) * A[4], t2 = (cx1 - A[1]) * A[3] + (cz1 - A[2]) * A[4];
        const along = Math.min(A[7], Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2));
        if (along < minAlong) continue;
        const a = buildings[A[0]], c = buildings[C[0]];
        const up = Math.min(a.height, c.height) - Math.max(a.bottom || 0, c.bottom || 0);
        if (up < minUp) continue;
        const t = (Math.max(0, Math.min(t1, t2)) + Math.min(A[7], Math.max(t1, t2))) / 2;
        shared.set(`${Math.min(list[i], list[j])}:${Math.max(list[i], list[j])}`, { a: A[0], b: C[0], along, area: along * up, x: A[1] + A[3] * t, z: A[2] + A[4] * t });
      }
    }
  }
  const pairs = new Map();
  for (const s of shared.values()) {
    const a = Math.min(s.a, s.b), b = Math.max(s.a, s.b), key = `${a}:${b}`;
    const p = pairs.get(key) || pairs.set(key, { a, b, along: 0, area: 0, x: s.x, z: s.z }).get(key);
    p.along += s.along;
    p.area += s.area;
  }
  return [...pairs.values()];
}
