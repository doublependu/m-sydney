// tools/tiles/pond-grade.mjs: the ground graded to the levels of the ponds tools/build-ponds.mjs marks `graded` (the ponds' rule's), for
// tools/tiles/grade-ground.mjs. The 20 m height grid can't hold a lake flat: across a narrow one it has the banks, round a dam the valley
// past it, and a pond's water, laid on the lawn as drawn (js/garden.js), follows the lawn up wherever it's over the level. So under a
// pond's water the ground is at its level, and DIP under it from DIP_FROM in, over DIP_OVER; past its edge it's at the level for SHELF m,
// then blends back to the ground over a metre for every 1/BLEND_PER_M m it moved (BLEND_MIN to BLEND_MAX), as the ground blends to a road.
// Its water then lies flat, and meets its bank at its edge: lowered where the grid had the bank over the water, raised where the grid had
// the valley under it (a dam's wall). The lawn is drawn through the 20 m grid's points, and the 10 m ones between where the ground was
// moved (js/ground-geometry.js addSurface()), not through the edge: the ground at the level for DIP_FROM in and SHELF out keeps the
// triangles across the edge at the level there, so the water neither stands over the lawn at its edge (the bank's middle would sink under
// it) nor climbs it far. Each piece has its own level ([level, outer, ...holes], a pond's water a step up among them). The edges along the
// 240 m squares' seams, between a pond's pieces, aren't its edges.
import { loadPonds } from '../pond-pieces.mjs';

const DIP = 0.3;
const DIP_FROM = 10;
const DIP_OVER = 5;
const SHELF = 6;
const BLEND_PER_M = 4;
const BLEND_MIN = 4;
const BLEND_MAX = 20;
const REACH = SHELF + BLEND_MAX;
const CELL = 32;
const SEAM = 240;

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const keyOf = (x, z) => Math.floor(x / CELL) * 100000 + Math.floor(z / CELL);
const inFlatRing = (f, x, z) => {
  let c = false;
  for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) {
    if ((f[i + 1] > z) !== (f[j + 1] > z) && x < ((f[j] - f[i]) * (z - f[i + 1])) / (f[j + 1] - f[i + 1]) + f[i]) c = !c;
  }
  return c;
};

/**
 * The graded ponds of `{ pieces, ponds }` (ponds.json, loadPonds()), as a function (x, z, ground) => the ground graded to them there, or
 * null where none reaches; null if none is graded. `ground` is the ground before (the roads' grading in it), which sets how far the bank
 * blends back to it.
 */
export function pondGrading({ pieces, ponds }) {
  const graded = [];
  for (const p of ponds) if (p.graded) for (let i = p.first; i < p.first + p.pieces; i++) graded.push(pieces[i]);
  if (!graded.length) return null;
  const edges = new Map(), boxes = new Map();
  const add = (map, x0, z0, x1, z1, item) => {
    for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++) {
      for (let iz = Math.floor(z0 / CELL); iz <= Math.floor(z1 / CELL); iz++) {
        const k = ix * 100000 + iz;
        (map.get(k) || map.set(k, []).get(k)).push(item);
      }
    }
  };
  for (const [level, outer, ...holes] of graded) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < outer.length; k += 2) {
      x0 = Math.min(x0, outer[k]); x1 = Math.max(x1, outer[k]); z0 = Math.min(z0, outer[k + 1]); z1 = Math.max(z1, outer[k + 1]);
    }
    const piece = { level, outer, holes, x0, x1, z0, z1 };
    add(boxes, x0, z0, x1, z1, piece);
    for (const f of [outer, ...holes]) {
      for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) {
        const ax = f[j], az = f[j + 1], bx = f[i], bz = f[i + 1];
        if ((ax === bx && ax % SEAM === 0) || (az === bz && az % SEAM === 0)) continue;
        add(edges, Math.min(ax, bx) - REACH, Math.min(az, bz) - REACH, Math.max(ax, bx) + REACH, Math.max(az, bz) + REACH, [ax, az, bx, bz, level]);
      }
    }
  }
  return (x, z, ground) => {
    const key = keyOf(x, z);
    // In a piece's water: a grid node can lie on a seam, so it's tested a hair off it
    const tx = x + 0.0137, tz = z + 0.0173;
    const into = (boxes.get(key) || []).find((p) => tx >= p.x0 && tx <= p.x1 && tz >= p.z0 && tz <= p.z1
      && inFlatRing(p.outer, tx, tz) && !p.holes.some((h) => inFlatRing(h, tx, tz)));
    let d = Infinity, level = null;
    for (const [ax, az, bx, bz, lv] of edges.get(key) || []) {
      const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
      const e = Math.hypot(ax + dx * t - x, az + dz * t - z);
      if (e < d) { d = e; level = lv; }
    }
    if (into) return into.level - DIP * smooth((d - DIP_FROM) / DIP_OVER);
    if (level === null || d > REACH) return null;
    if (d <= SHELF) return level;
    const moved = ground - level;
    const blend = Math.max(BLEND_MIN, Math.min(BLEND_MAX, Math.abs(moved) * BLEND_PER_M));
    const t = (d - SHELF) / blend;
    return t >= 1 ? null : level + moved * smooth(t);
  };
}

/** The graded ponds in tools/data/generated/ponds.json, as pondGrading() has them */
export function generatedPondGrading() {
  return pondGrading(loadPonds(new URL('../data/generated/', import.meta.url).pathname));
}

export const POND_GRADE = { DIP, DIP_FROM, DIP_OVER, SHELF, BLEND_PER_M, BLEND_MIN, BLEND_MAX, REACH };
