// What a building's model says about walking in it (README, "Building models"): its floors, walls, doors, seats and rooms, as the
// model's JSON has them, in the model's own frame. Nothing here draws anything, so the tests can use it as the game does.
//   Model frame: x across, z along, y up from the model's ground floor; a site turns it by `yaw` and puts it at (x, y, z).

const STEP_UP = 0.45; // m a walker steps up onto a floor without thinking about it: a stair's tread, a threshold
const DOOR_TIME = 0.6; // s for a door to swing all the way
const REACH = 1.5; // m from a door you can open it
const SEAT_REACH = 1.2;
const LOOKING = Math.cos(1.0); // within this of where you face or look, a door's in front of you
const WALKER = 0.22; // m round a walker inside, or on a model's floors: through a 0.7-0.9 m doorway, and between the furniture, with room
// The camera inside: the ball it's kept in, clear of walls, so its near plane (0.1 m, js/main.js) never reaches into one; and how far over
// a floor and under the one above (a slab, and a margin) it stays
const EYE_PAD = 0.25;
const EYE_OVER_FLOOR = 0.25;
const EYE_UNDER_FLOOR = 0.7;

function inPoly(poly, x, z) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[j];
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) c = !c;
  }
  return c;
}

const toWorld = (site, x, z) => {
  const c = Math.cos(site.yaw), s = Math.sin(site.yaw);
  return { x: site.x + x * c + z * s, z: site.z - x * s + z * c };
};
const toLocal = (site, x, z) => {
  const c = Math.cos(site.yaw), s = Math.sin(site.yaw), dx = x - site.x, dz = z - site.z;
  return { x: dx * c - dz * s, z: dx * s + dz * c };
};

/** The height of a floor at (x, z), or null if it isn't there */
function floorHeight(f, x, z) {
  if (!inPoly(f.poly, x, z)) return null;
  if (f.holes) for (const h of f.holes) if (inPoly(h, x, z)) return null;
  return f.plane ? f.plane[0] + f.plane[1] * x + f.plane[2] * z : f.y;
}

/**
 * The floor under (x, z) for someone standing at height `ref`: the highest no more than a step above it, so a stair climbs and the
 * floor above doesn't take you; with none that low, the lowest. Null where there's no floor at all.
 */
function floorAt(floors, x, z, ref) {
  let best = null, lowest = null;
  for (const f of floors) {
    const y = floorHeight(f, x, z);
    if (y === null) continue;
    if (y <= ref + STEP_UP && (best === null || y > best)) best = y;
    if (lowest === null || y < lowest) lowest = y;
  }
  return best ?? lowest;
}

/** A box in the world along a -> b (model frame), t thick, from y0 to y1 over the model's floor: the game's collider, at its heights */
function segmentCollider(site, a, b, t, y0, y1) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-6;
  const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, nx = -uz * t / 2, nz = ux * t / 2;
  const outer = [[a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz]].map(([x, z]) => toWorld(site, x, z));
  const xs = outer.map((p) => p.x), zs = outer.map((p) => p.z);
  // `level`: its heights are the world's, not over the ground (js/controllers.js colliderBottom)
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs),
    minY: site.y + y0, maxY: site.y + y1, baseY: 0, level: true, polygon: { outer, holes: [] }
  };
}
const wallCollider = (site, w) => segmentCollider(site, w.a, w.b, w.t, w.y0, w.y1);

/**
 * The doorway a door shuts, through the wall it's in (model frame): { a, b, t }, from jamb to jamb along the wall's line and as thick as
 * the wall, or null if no wall ends at it. Its leaf hangs near one face, so a shut door as thin as its leaf would leave a recess on
 * the other side that a walker sliding along the wall catches in.
 */
function doorway(d, walls) {
  const ex = d.latch[0] - d.hinge[0], ez = d.latch[1] - d.hinge[1], W = Math.hypot(ex, ez);
  if (W < 1e-6) return null;
  const ux = ex / W, uz = ez / W;
  let best = null;
  for (const w of walls) {
    if (w.y1 < d.y0 + 0.3 || w.y0 > d.y1 - 0.3) continue;
    const wx = w.b[0] - w.a[0], wz = w.b[1] - w.a[1], L = Math.hypot(wx, wz);
    // along the door's line, and the door within its thickness
    if (L < 1e-6 || Math.abs(wx * uz - wz * ux) / L > 0.01) continue;
    const across = (d.hinge[0] - w.a[0]) * -uz + (d.hinge[1] - w.a[1]) * ux;
    if (Math.abs(across) > w.t / 2 + 0.01) continue;
    // ending at a jamb: one of its ends where the hinge or the latch is, along the door's line
    const at = (p) => (p[0] - d.hinge[0]) * ux + (p[1] - d.hinge[1]) * uz;
    if (![w.a, w.b].some((p) => Math.abs(at(p)) < 0.02 || Math.abs(at(p) - W) < 0.02)) continue;
    if (!best || w.t > best.t) best = { t: w.t, across };
  }
  if (!best) return null;
  // the hinge and latch moved onto the wall's middle line
  const shift = (p) => [p[0] + uz * best.across, p[1] - ux * best.across];
  return { a: shift(d.hinge), b: shift(d.latch), t: best.t };
}
/** A shut door, as a wall: filling its doorway through the wall it's in, or just its leaf if there's no wall to find (`walls`) */
function doorCollider(site, d, walls = []) {
  const box = doorway(d, walls);
  return box ? segmentCollider(site, box.a, box.b, box.t, d.y0, d.y1) : segmentCollider(site, d.hinge, d.latch, 0.08, d.y0, d.y1);
}

/** Where a door's leaf is, swung `angle` (0 shut .. d.turn open): its hinge and latch in the model's frame */
function leafAt(d, angle) {
  const dx = d.latch[0] - d.hinge[0], dz = d.latch[1] - d.hinge[1];
  const W = Math.hypot(dx, dz);
  const a = Math.atan2(-dz, dx) + angle;
  return { hinge: d.hinge, latch: [d.hinge[0] + Math.cos(a) * W, d.hinge[1] - Math.sin(a) * W] };
}

/** The room (x, y, z) is in: its plan holds (x, z) and y is between its floor and the next */
function roomAt(rooms, x, y, z) {
  for (const r of rooms) if (y >= r.y0 - 0.3 && y < r.y1 - 0.3 && inPoly(r.poly, x, z)) return r;
  return null;
}

/**
 * The rooms seen from `from` (a room's id, or 'out'): it, and those through open doorways from it, `depth` rooms deep. `open(id)`
 * says whether a door is open; links with no door are always open.
 */
function visibleRooms(links, from, open, depth = 2) {
  const seen = new Set([from]);
  let edge = [from];
  for (let k = 0; k < depth; k++) {
    const next = [];
    for (const l of links) {
      if (l.door && !open(l.door)) continue;
      for (const [p, q] of [[l.a, l.b], [l.b, l.a]]) {
        if (edge.includes(p) && !seen.has(q)) {
          seen.add(q);
          next.push(q);
        }
      }
    }
    edge = next;
  }
  return seen;
}

/**
 * How far along the line from (ax, az) to (bx, bz) (model frame), 0..1, it first comes within `pad` of a wall standing anywhere
 * between heights y0 and y1, or 1. A wall it starts nearer than `pad` to only keeps it from coming any nearer.
 */
function lineToWalls(walls, ax, az, bx, bz, y0, y1, pad = EYE_PAD) {
  let t = 1;
  const dx = bx - ax, dz = bz - az;
  for (const w of walls) {
    if (y1 < w.y0 || y0 > w.y1) continue;
    const ex = w.b[0] - w.a[0], ez = w.b[1] - w.a[1];
    const L = Math.hypot(ex, ez);
    if (L < 1e-6) continue;
    const ux = ex / L, uz = ez / L, nx = -uz, nz = ux;
    // in the wall's frame: s along it, d across it
    const s0 = (ax - w.a[0]) * ux + (az - w.a[1]) * uz, d0 = (ax - w.a[0]) * nx + (az - w.a[1]) * nz;
    const p = Math.min(pad, Math.max(0, Math.max(-s0, s0 - L, Math.abs(d0) - w.t / 2) - 0.005));
    const half = w.t / 2 + p;
    const ds = dx * ux + dz * uz, dd = dx * nx + dz * nz;
    // the box |d| < half, s in [-p, L + p]: where the line enters it
    let lo = 0, hi = 1;
    for (const [q, v, min, max] of [[d0, dd, -half, half], [s0, ds, -p, L + p]]) {
      if (Math.abs(v) < 1e-9) {
        if (q < min || q > max) { lo = 2; break; }
        continue;
      }
      let t0 = (min - q) / v, t1 = (max - q) / v;
      if (t0 > t1) [t0, t1] = [t1, t0];
      lo = Math.max(lo, t0);
      hi = Math.min(hi, t1);
    }
    if (lo <= hi && lo < t) t = lo;
  }
  return Math.max(0, t);
}

/** At (x, z), how low and how high a camera can be, for one whose middle is at `from` (its height): over the floor under that, and a
 * slab and a margin under the one over it, or under `roof` where there's none */
function headroom(floors, x, z, from, roof = Infinity) {
  let lo = -Infinity, hi = roof;
  for (const f of floors) {
    const h = floorHeight(f, x, z);
    if (h === null) continue;
    if (h <= from + 0.1) lo = Math.max(lo, h + EYE_OVER_FLOOR);
    else hi = Math.min(hi, h - EYE_UNDER_FLOOR);
  }
  return { lo, hi };
}

/**
 * Where a camera can be on the line from `from` to `to` (model frame, { x, y, z }), looking on from `from`: { t, y }, how far along
 * it, 0..1, short of the walls and of the floors over and under it, and the height the line ends at, lowered under the ceiling there.
 * `roof`: how high it can go where there's no floor over it.
 */
function eyeReach(walls, floors, from, to, roof = Infinity, pad = EYE_PAD) {
  const y = Math.min(to.y, headroom(floors, to.x, to.z, from.y, roof).hi);
  const t = lineToWalls(walls, from.x, from.z, to.x, to.z, Math.min(from.y, y) - 0.15, Math.max(from.y, y) + 0.15, pad);
  // Along it, the line you're seen along goes through no floor, ceiling or stair (their undersides are at most 0.3 m down), and the
  // camera stops at the furthest point that has room for it: half way up a stair, back down it under the edge of the floor above
  const N = 16;
  let best = 0;
  for (let k = 1; k <= N; k++) {
    const u = (k / N) * t;
    const room = headroom(floors, from.x + (to.x - from.x) * u, from.z + (to.z - from.z) * u, from.y, roof);
    const at = from.y + (y - from.y) * u;
    if (at < room.lo - EYE_OVER_FLOOR + 0.05 || at > room.hi + EYE_UNDER_FLOOR - 0.35) break;
    if (at >= room.lo && at <= room.hi) best = u;
  }
  return { t: best, y };
}

/** Whether someone `r` round can stand at (x, z) on a floor at y without a wall in them (model frame) */
function clearOf(walls, x, z, y, r = 0.32) {
  for (const w of walls) {
    if (y + 1.7 <= w.y0 || y + 0.3 >= w.y1) continue;
    // to the wall's box, square-ended as the game's colliders are: along it past an end, and across it past its face
    const ex = w.b[0] - w.a[0], ez = w.b[1] - w.a[1], L = Math.hypot(ex, ez) || 1e-9;
    const s = ((x - w.a[0]) * ex + (z - w.a[1]) * ez) / L, d = ((z - w.a[1]) * ex - (x - w.a[0]) * ez) / L;
    if (Math.hypot(Math.max(0, -s, s - L), Math.max(0, Math.abs(d) - w.t / 2)) < r) return false;
  }
  return true;
}

/** Where to stand up from a seat (model frame): the nearest clear spot round it in its room, in front first, or null */
function standSpot(walls, rooms, seat) {
  const turns = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, (3 * Math.PI) / 4, (-3 * Math.PI) / 4, Math.PI];
  for (const out of [0.62, 0.85, 1.1]) {
    for (const turn of turns) {
      const x = seat.at[0] + Math.sin(seat.facing + turn) * out, z = seat.at[2] + Math.cos(seat.facing + turn) * out;
      if (clearOf(walls, x, z, seat.at[1] - 0.5) && roomAt(rooms, x, seat.at[1] - 0.4, z)?.id === seat.room) return { x, z };
    }
  }
  return null;
}

/** The nearest door within reach of (x, z), in front of you facing `heading` or looking along `look`: { door, d } or null */
function doorInReach(doors, x, z, heading, look = null, reach = REACH) {
  let best = null;
  for (const d of doors) {
    const cx = (d.hinge[0] + d.latch[0]) / 2, cz = (d.hinge[1] + d.latch[1]) / 2;
    // the nearest point of the doorway, so a wide pair of doors reaches as far as a single one
    const ex = d.latch[0] - d.hinge[0], ez = d.latch[1] - d.hinge[1], L2 = ex * ex + ez * ez;
    const t = Math.max(0, Math.min(1, ((x - d.hinge[0]) * ex + (z - d.hinge[1]) * ez) / L2));
    const px = d.hinge[0] + ex * t, pz = d.hinge[1] + ez * t;
    const dist = Math.hypot(px - x, pz - z);
    if (dist > reach) continue;
    const toX = cx - x, toZ = cz - z, toL = Math.hypot(toX, toZ) || 1;
    const facing = (Math.sin(heading) * toX + Math.cos(heading) * toZ) / toL;
    const looking = look ? (look.x * toX + look.z * toZ) / toL : -1;
    if (facing < LOOKING && looking < LOOKING && dist > 0.6) continue;
    if (!best || dist < best.d) best = { door: d, d: dist };
  }
  return best;
}

/** The nearest seat within reach, at about your height */
function seatInReach(seats, x, y, z, reach = SEAT_REACH) {
  let best = null;
  for (const s of seats) {
    if (Math.abs(s.at[1] - 0.5 - y) > 0.6) continue;
    const d = Math.hypot(s.at[0] - x, s.at[2] - z);
    if (d < reach && (!best || d < best.d)) best = { seat: s, d };
  }
  return best;
}

export {
  DOOR_TIME, REACH, SEAT_REACH, STEP_UP, WALKER, clearOf, doorCollider, doorInReach, doorway, eyeReach, floorAt, floorHeight, headroom, inPoly,
  leafAt, lineToWalls, roomAt, seatInReach, segmentCollider, standSpot, toLocal, toWorld, visibleRooms, wallCollider
};
