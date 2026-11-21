import * as THREE from 'three/webgpu';
import { clearFloor, setFloor } from './surfaces.js';

// Swimming in a model's pool: one its JSON marks `swim` among its `pools` (North Sydney Pool's 50 m pool). Fetched with the first model
// that has one (js/interiors.js), never in the first download; the walker's controller (js/controllers.js) asks it while it's here.
// - The water's frame: a floor at the deck's level over the water's ring (the floor round it), so the walker's height there is over the
//   deck as it is beside it, and nothing jumps at the edge. What a walker stands on in it is the pool's own bottom: its steps' treads, or
//   its floor down the depth profile (bottomUnder(), js/controllers.js getGroundHeight()).
// - In: a walk off the edge (pushing straight at it for a moment: walked along, the edge still holds you), a jump over it, a jump at the
//   edge facing the water (a dive), down the steps (walked: they're treads under the water), or down a ladder (walked onto it).
// - In the water (`swim` on the walker): the body floats with its head out, the eye SWIM.out over the surface, and moves as walking does,
//   slower, with the same keys, touch and pad: a freestyle stroke moving, treading water still. The down key (Q, C) ducks under.
//   Standing depth (SWIM.wade) is walked in: the steps.
// - Out: a ladder (swum into), the steps (swum onto: you stand and walk up them), or a climb at the edge (the jump key or the use key,
//   facing it).
// - Each frame the swimmer leaves its drops and sounds in `swimEvents` (js/main.js stirs the water with them and plays them).
// Every place a pool's JSON gives is in its model's frame, y up from the deck; the swimmer's own height (the walker's `position.y`) is
// what its feet's would be standing upright with its eye where the swimmer's is: SWIM.eye under the eye.

const SWIM = {
  pace: 1.0, fast: 1.6, back: 0.45, aside: 0.55, // m/s: forward (Shift, or a stick pushed all the way, the faster), back and aside
  turn: 1.7, // rad/s
  accel: 1.3, // m/s² up to the pace, and slowing from it
  eye: 1.68, // m from the feet to the eye, standing (js/cameras.js STANDING_EYE)
  out: 0.12, // m the eye floats over the surface
  under: 1.0, // m the eye goes under, ducked
  glide: 0.7, // m it glides under, after a dive
  margin: 0.4, // m the body's middle keeps from the walls
  wade: 0.85, // m deep or less: walked in (the steps' treads)
  push: 0.3, // s pushing straight at the edge before stepping off it
  // The water holding the body at its level: /s², and /s going down (it carries on under, in off the edge) and coming up (it eases up)
  spring: 9, sink: 1.5, rise: 5.5
};
const IN_CONE = Math.cos(50 * Math.PI / 180); // heading or move within this of straight in: a dive, a step off
const OUT_CONE = Math.cos(55 * Math.PI / 180); // facing the wall within this: a climb out
const DIVE = { reach: 1.4, up: 3.0, out: 2.6, gravity: 9.8 }; // m from the edge it can be taken from; m/s up and out; m/s²
const LADDER = { along: 0.45, reach: 0.95, top: 0.45, onTop: 0.5 }; // m: along the wall, from it in the water, its top's spot on the deck
const STAND = 0.957; // m the pelvis stands over the feet (PersonRig standingHeight(0))
const LAND = 0.5; // m out on the deck a climb ends
const STROKE = 0.52; // stroke cycles a second for each m/s (js/pool-water.js's swimmers')
// The rig's bones and sizes (js/pedestrians.js PersonRig.SIZES), from the first rig posed
let BONE = null, THIGH, SHIN, ANKLE_H, UPPER_ARM, FOREARM, ARM_BIND_ABDUCTION, LIMB, SIDES;
const sizesOf = (rig) => {
  if (!BONE) ({ BONE, THIGH, SHIN, ANKLE_H, UPPER_ARM, FOREARM, ARM_BIND_ABDUCTION, LIMB, SIDES } = rig.constructor.SIZES);
};

// --- The pools here ----------------------------------------------------------------------------------------------------------------
const POOLS = new Map(); // key (a site's) -> [pool]

/**
 * A model's pools to swim in, while it's held: `site` { x, y, z, yaw } its place, `pools` its JSON's (those with `swim`), each in the site's
 * frame. Its water's frame is a floor over each ring at the deck's level.
 */
function addSwimPools(key, site, pools) {
  removeSwimPools(key);
  const list = pools.filter((p) => p.swim && p.ring?.length >= 3).map((p) => poolOf(site, p));
  if (!list.length) return false;
  POOLS.set(key, list);
  const xs = list.flatMap((e) => [e.world.minX, e.world.maxX]), zs = list.flatMap((e) => [e.world.minZ, e.world.maxZ]);
  setFloor(`swim:${key}`, {
    minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs),
    at: (x, z) => (list.some((e) => inside(e, toLocal(e, x, z), 0)) ? site.y : null)
  });
  return true;
}
function removeSwimPools(key) {
  if (!POOLS.delete(key)) return;
  clearFloor(`swim:${key}`);
}

function poolOf(site, p) {
  const xs = p.ring.map((q) => q[0]), zs = p.ring.map((q) => q[1]);
  const e = {
    id: p.id, site: { x: site.x, y: site.y, z: site.z, yaw: site.yaw }, c: Math.cos(site.yaw), s: Math.sin(site.yaw),
    box: { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) },
    surface: p.surface ?? 0, depth: p.depth ?? [[0, 1.5]],
    steps: (p.steps ?? []).map((st) => {
      const sx = st.poly.map((q) => q[0]), sz = st.poly.map((q) => q[1]);
      return { x0: Math.min(...sx), x1: Math.max(...sx), z0: Math.min(...sz), z1: Math.max(...sz), y: st.y };
    }),
    ladders: (p.ladders ?? []).map((l) => ({ at: l.at, into: l.into, rungs: l.rungs ?? [], top: l.top ?? 0 }))
  };
  const corners = [[e.box.x0, e.box.z0], [e.box.x1, e.box.z0], [e.box.x1, e.box.z1], [e.box.x0, e.box.z1]].map(([x, z]) => toWorld(e, x, z));
  e.world = { minX: Math.min(...corners.map((q) => q.x)), maxX: Math.max(...corners.map((q) => q.x)),
    minZ: Math.min(...corners.map((q) => q.z)), maxZ: Math.max(...corners.map((q) => q.z)) };
  return e;
}

// The pool's frame from the world's and back (js/model-sites.js toWorldOf()); a heading's direction there is its heading less the yaw
const toLocal = (e, x, z) => {
  const dx = x - e.site.x, dz = z - e.site.z;
  return { x: dx * e.c - dz * e.s, z: dx * e.s + dz * e.c };
};
const toWorld = (e, x, z) => ({ x: e.site.x + x * e.c + z * e.s, z: e.site.z - x * e.s + z * e.c });
const localDir = (e, heading) => ({ x: Math.sin(heading - e.site.yaw), z: Math.cos(heading - e.site.yaw) });
const worldHeading = (e, lx, lz) => Math.atan2(lx, lz) + e.site.yaw;
const inside = (e, l, margin) => l.x > e.box.x0 - margin && l.x < e.box.x1 + margin && l.z > e.box.z0 - margin && l.z < e.box.z1 + margin;

/** The pool to swim in whose ring is within `margin` m of (x, z) in the world, or null */
function poolAt(x, z, margin = 0) {
  for (const list of POOLS.values()) {
    for (const e of list) {
      if (x < e.world.minX - margin || x > e.world.maxX + margin || z < e.world.minZ - margin || z > e.world.maxZ + margin) continue;
      if (inside(e, toLocal(e, x, z), margin)) return e;
    }
  }
  return null;
}

/** The depth under the surface at x along the pool, down its profile */
function depthAt(e, x) {
  const d = e.depth;
  if (x <= d[0][0]) return d[0][1];
  for (let i = 1; i < d.length; i++) {
    if (x <= d[i][0]) return d[i - 1][1] + (d[i][1] - d[i - 1][1]) * (x - d[i - 1][0]) / Math.max(1e-6, d[i][0] - d[i - 1][0]);
  }
  return d.at(-1)[1];
}
/** What's under the water at (lx, lz) in the pool's frame, its height from the deck: a tread of the steps, or the floor */
function bottomAt(e, lx, lz) {
  for (const st of e.steps) if (lx >= st.x0 && lx <= st.x1 && lz >= st.z0 && lz <= st.z1) return st.y;
  return e.surface - depthAt(e, lx);
}
/** What a walker stands on at (x, z) in the world, over the water's frame (the deck's level), or null where there's no pool to swim in */
function bottomUnder(x, z) {
  const e = poolAt(x, z);
  if (!e) return null;
  const l = toLocal(e, x, z);
  return bottomAt(e, l.x, l.z);
}

/** The water's surface in the world's heights over (x, z), or null: for the camera, under the water or not */
function surfaceOver(x, z) {
  const e = poolAt(x, z);
  return e ? e.site.y + e.surface : null;
}

/**
 * Where a point on the deck beside a pool is against its nearest edge, in the pool's frame: { e, l, out (m out from the edge), n (the
 * edge's inward normal), edge (the nearest point on the edge) }, within `reach` m outside it; null in the water or further off.
 */
function edgeBeside(x, z, reach) {
  const e = poolAt(x, z, reach);
  if (!e) return null;
  const l = toLocal(e, x, z), b = e.box;
  if (inside(e, l, 0)) return null;
  const ox = Math.max(b.x0 - l.x, l.x - b.x1, 0), oz = Math.max(b.z0 - l.z, l.z - b.z1, 0);
  const n = ox >= oz ? { x: l.x < b.x0 ? 1 : -1, z: 0 } : { x: 0, z: l.z < b.z0 ? 1 : -1 };
  const edge = { x: Math.max(b.x0, Math.min(b.x1, l.x)), z: Math.max(b.z0, Math.min(b.z1, l.z)) };
  return { e, l, out: Math.hypot(ox, oz), n, edge };
}

/** The wall nearest a swimmer at `l` in the pool's frame: { d (m from it), n (its outward normal), edge (the point on it) } */
function wallNear(e, l) {
  const b = e.box;
  const walls = [[l.x - b.x0, -1, 0], [b.x1 - l.x, 1, 0], [l.z - b.z0, 0, -1], [b.z1 - l.z, 0, 1]];
  let best = walls[0];
  for (const w of walls) if (w[0] < best[0]) best = w;
  const n = { x: best[1], z: best[2] };
  return { d: best[0], n, edge: { x: n.x ? (n.x > 0 ? b.x1 : b.x0) : l.x, z: n.z ? (n.z > 0 ? b.z1 : b.z0) : l.z } };
}

/** A ladder a swimmer at `l` in the pool's frame, facing `dir`, is at and facing, or null */
function ladderAhead(e, l, dir) {
  for (const lad of e.ladders) {
    const nx = -lad.into[0], nz = -lad.into[1]; // out of the water
    const ax = l.x - lad.at[0], az = l.z - lad.at[1];
    const off = -(ax * nx + az * nz), along = Math.abs(ax * nz - az * nx);
    if (off >= 0 && off <= LADDER.reach && along <= LADDER.along && dir.x * nx + dir.z * nz >= Math.cos(Math.PI / 3)) return lad;
  }
  return null;
}
/** A ladder's top a walker on the deck at `l`, facing `dir`, stands at, facing the water, or null */
function ladderBelow(e, l, dir) {
  for (const lad of e.ladders) {
    const tx = lad.at[0] - lad.into[0] * LADDER.top, tz = lad.at[1] - lad.into[1] * LADDER.top;
    if (Math.hypot(l.x - tx, l.z - tz) <= LADDER.onTop && dir.x * lad.into[0] + dir.z * lad.into[1] >= Math.cos(Math.PI / 3)) return lad;
  }
  return null;
}

// --- Into the water ----------------------------------------------------------------------------------------------------------------

/** The swimming state, from now: `vy` how fast the body's going down or up, `glide` s gliding under after a dive, `splash` how big */
function enter(p, e, { vy = 0, glide = 0, dip = 0, splash = 0, dive = false } = {}) {
  blendFrom(p, glide ? 0.12 : 0.35);
  p.swim = {
    pool: e, mode: 'swim', vy, glide, dip, m: glide ? 1 : 0, phase: 0, tread: 0, time: 0, bow: 0, kick: 0, roll: 0, breathe: 0,
    climb: null, since: 0, plunge: splash > 0
  };
  p.speed = Math.max(-SWIM.back, Math.min(SWIM.fast, p.speed * (dive ? 0.8 : 0.4)));
  p.sideSpeed = (p.sideSpeed || 0) * 0.4;
  p.jumping = false;
  p.jumpPrep = 0;
  p.verticalVel = 0;
  p.heldBack = null;
  p.dive = null;
  p.swimPush = 0;
  if (splash > 0) {
    const { x, z } = p.position;
    const y = e.site.y + e.surface;
    event(p, { x, y, z, radius: dive ? 0.55 : 0.7, strength: dive ? -0.07 : -0.1, sound: 'splash', size: splash });
    // a ring of spray round where it went in
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + p.heading;
      event(p, { x: x + Math.sin(a) * 0.7, y, z: z + Math.cos(a) * 0.7, radius: 0.35, strength: 0.025 * splash });
    }
  }
}

function event(p, ev) {
  p.swimStirred = (p.swimStirred ?? 0) + 1;
  if (ev.sound === 'splash') p.swimSplashes = (p.swimSplashes ?? 0) + 1;
  (p.swimEvents ??= []).push(ev);
  if (p.swimEvents.length > 64) p.swimEvents.splice(0, p.swimEvents.length - 64);
}

/**
 * Before the walker's own step, near a pool: a ladder down, walked onto from its top, starts here (true: the step's done); a jump pressed
 * at the edge facing the water is a dive (its crouch the walker's, its flight diveStep()'s). How fast the walker goes, in the water: slower.
 */
function beforeWalk(cm, p) {
  const { x, z } = p.position;
  const near = edgeBeside(x, z, DIVE.reach);
  const grounded = p.position.y <= 0.02 && !p.jumping;
  if (near && grounded) {
    const dir = localDir(near.e, p.heading);
    const lad = cm.keys.forward ? ladderBelow(near.e, near.l, dir) : null;
    if (lad) {
      startClimb(p, near.e, 'down', lad);
      return { done: true };
    }
    const facing = dir.x * near.n.x + dir.z * near.n.z;
    if ((cm.keys.up || cm.jumpQueued > 0) && !(p.jumpPrep > 0) && facing >= IN_CONE && !p.dive) p.dive = { launched: false, t: 0, speed: 0 };
  }
  return { done: false, pace: poolAt(x, z) ? 0.6 : 1 };
}

/**
 * Whether the walker's move from `last` to `pos` may go into a pool's water, which holds it at its edge otherwise (js/still-water.js): in
 * the air over it, already in it (wading), or pushing straight at its edge for SWIM.push
 */
function letsIn(p, last, pos) {
  if (!poolAt(pos.x, pos.z, 0.35)) return false;
  if (p.jumping || p.dive?.launched || poolAt(last.x, last.z)) return true;
  const near = edgeBeside(last.x, last.z, 0.8);
  if (near) {
    const mx = pos.x - last.x, mz = pos.z - last.z, L = Math.hypot(mx, mz);
    if (L > 1e-5) {
      const dir = localDir(near.e, Math.atan2(mx, mz));
      if (dir.x * near.n.x + dir.z * near.n.z >= IN_CONE) p.swimPushing = true;
    }
  }
  return (p.swimPush ?? 0) >= SWIM.push;
}

/**
 * In the water, a walker standing on a tread can step out over the edge only where it's a step up (the top tread), and anywhere else the
 * pool's walls hold it in: (fromX, fromZ) where it was, `pos` where its move took it
 */
function holdWader(p, fromX, fromZ) {
  const e = poolAt(fromX, fromZ);
  if (!e) return;
  const pos = p.position;
  if (poolAt(pos.x, pos.z)) return;
  const l0 = toLocal(e, fromX, fromZ);
  if (bottomAt(e, l0.x, l0.z) >= -0.3) return;
  const l = toLocal(e, pos.x, pos.z), m = 0.22, b = e.box;
  const w = toWorld(e, Math.max(b.x0 + m, Math.min(b.x1 - m, l.x)), Math.max(b.z0 + m, Math.min(b.z1 - m, l.z)));
  pos.x = w.x;
  pos.z = w.z;
  if (pos.landed) {
    pos.landed.x = w.x;
    pos.landed.z = w.z;
  }
}

/** After the walker's step: its dive taking off, and into the water if it's now in it, deep enough to swim */
function afterWalk(cm, p, dt) {
  p.swimPush = p.swimPushing ? (p.swimPush ?? 0) + dt : 0;
  p.swimPushing = false;
  if (p.dive && !p.dive.launched) {
    if (p.jumping) {
      // Off the edge in an arc, further out than up
      p.dive.launched = true;
      p.dive.speed = Math.max(0, p.speed) + DIVE.out;
      p.verticalVel = DIVE.up;
      p.rig.placed = false;
      blendFrom(p, 0.15);
    } else if (!(p.jumpPrep > 0) && !cm.jumpQueued) p.dive = null;
  }
  const e = poolAt(p.position.x, p.position.z);
  if (!e) return;
  const l = toLocal(e, p.position.x, p.position.z);
  const bottom = bottomAt(e, l.x, l.z);
  if (e.surface - bottom > SWIM.wade && p.position.y < e.surface) {
    enter(p, e, { vy: p.jumping ? p.verticalVel : 0, splash: p.jumping ? Math.min(1, Math.abs(p.verticalVel) / 3) : 0 });
  }
}

/** A dive's flight, in place of the walker's step: out along its heading, under gravity, into the water head first */
function diveStep(cm, p, dt) {
  const d = p.dive;
  d.t += dt;
  p.position.x += Math.sin(p.heading) * d.speed * dt;
  p.position.z += Math.cos(p.heading) * d.speed * dt;
  p.verticalVel -= DIVE.gravity * dt;
  p.position.y += p.verticalVel * dt;
  p.speed = d.speed;
  const e = poolAt(p.position.x, p.position.z);
  p.position.landed = { x: p.position.x, z: p.position.z };
  if (!e) {
    // Still over the deck (taken from too far back, or along the edge): it comes down on it, as a jump does
    if (p.position.y <= 0) {
      p.position.y = 0;
      p.verticalVel = 0;
      p.jumping = false;
      p.dive = null;
    }
    return;
  }
  // In once the hands and the head are, the pelvis a little over the surface (a dive's 2 m or so out: off the walls, where it swims)
  if (p.position.y + STAND <= e.surface + 0.35) {
    const pitch = diveArc(d.t);
    // (the water takes most of its fall: a dive glides on along under the surface, more than it goes down)
    enter(p, e, { vy: p.verticalVel * 0.4, glide: 0.9, dip: Math.max(0, pitch - Math.PI / 2), splash: 0.75, dive: true });
  }
}
const diveArc = (t) => 0.25 + 1.85 * smooth(Math.min(1, t / 0.78)); // rad forward: in at 30 degrees under level

// --- In the water ------------------------------------------------------------------------------------------------------------------

/** A frame of swimming, in place of the walker's step: `cm` the controller (its keys, steering by the view, spotClear()) */
function swimStep(cm, p, dt) {
  const st = p.swim, e = st.pool, k = cm.keys;
  // Its model let go of meanwhile: out, where it is
  if (!poolAt(p.position.x, p.position.z, 1)) {
    leave(p, { y: 0 });
    return;
  }
  st.time += dt;
  st.since += dt;
  if (st.mode === 'climb') {
    climbStep(cm, p, dt);
    return;
  }
  // Turning as on foot, slower; in first person the view turned you already (js/controllers.js updatePerson()). Off a ladder's foot,
  // turned round from it to face the pool first
  if (st.turn) {
    st.turn.t += dt;
    const k2 = smooth(Math.min(1, st.turn.t / st.turn.length));
    p.heading = st.turn.from + (st.turn.to - st.turn.from) * k2;
    p.followingView = false;
    if (st.turn.t >= st.turn.length) st.turn = null;
  } else {
    if (k.left) p.heading += SWIM.turn * dt * k.left;
    if (k.right) p.heading -= SWIM.turn * dt * k.right;
    if (cm.firstPerson) p.followingView = false;
    else p.heading += SWIM.turn * dt * cm.steerToView(p);
  }

  const held = (v) => (v === true ? 1 : Math.min(1, v / 0.6));
  let target = 0, side = 0;
  if (k.forward) target = (k.run || (k.forward !== true && k.forward > 0.95) ? SWIM.fast : SWIM.pace) * held(k.forward);
  else if (k.backward) target = -SWIM.back * held(k.backward);
  if (k.sideLeft) side += SWIM.aside * held(k.sideLeft);
  if (k.sideRight) side -= SWIM.aside * held(k.sideRight);
  if (st.glide > 0) {
    // Gliding on from a dive, the arms out ahead
    st.glide -= dt;
    target = Math.max(target, p.speed);
  }
  const towards = (v, t) => v + Math.max(-SWIM.accel * dt, Math.min(SWIM.accel * dt, t - v));
  p.speed = towards(p.speed, target);
  p.sideSpeed = towards(p.sideSpeed || 0, side);

  // Along, held off the walls
  const sin = Math.sin(p.heading), cos = Math.cos(p.heading);
  const x = p.position.x + (sin * p.speed + cos * p.sideSpeed) * dt;
  const z = p.position.z + (cos * p.speed - sin * p.sideSpeed) * dt;
  const l = toLocal(e, x, z), b = e.box, m = SWIM.margin;
  const cl = { x: Math.max(b.x0 + m, Math.min(b.x1 - m, l.x)), z: Math.max(b.z0 + m, Math.min(b.z1 - m, l.z)) };
  const atWall = cl.x !== l.x || cl.z !== l.z;
  const w = toWorld(e, cl.x, cl.z);
  p.position.x = w.x;
  p.position.z = w.z;
  if (atWall) {
    // Into the wall: what was going at it stops
    const moved = Math.hypot(cl.x - l.x, cl.z - l.z);
    p.speed *= Math.max(0, 1 - moved / Math.max(1e-4, Math.abs(p.speed) * dt + 1e-4));
  }
  p.position.landed = { x: p.position.x, z: p.position.z };

  // How much it's swimming, from treading water: by how fast it's going forward
  const swimming = st.glide > 0 || k.down ? 1 : Math.min(1, Math.max(0, p.speed - 0.15) / 0.45);
  st.m += (swimming - st.m) * Math.min(1, dt * 2.2);

  // Up and down: the water holds the eye just out of it, or under, ducked (the down key) or gliding; never the body through the floor
  const bottom = bottomAt(e, cl.x, cl.z);
  // (fallen or dived in, it carries on down under its own weight before it comes up; walked in, or ducking, it's eased there)
  const eye = k.down ? Math.max(bottom + 0.45, e.surface - SWIM.under) : st.glide > 0 ? Math.max(bottom + 0.45, e.surface - SWIM.glide)
    : e.surface + SWIM.out;
  if (st.vy >= 0) st.plunge = false;
  st.vy += (SWIM.spring * (eye - SWIM.eye - p.position.y) - (st.vy < 0 && st.plunge ? SWIM.sink : SWIM.rise) * st.vy) * dt;
  p.position.y += st.vy * dt;
  const lowest = bottom - 1.33 * st.m; // upright, the feet on the bottom; flat, the belly over it
  if (p.position.y < lowest) {
    p.position.y = lowest;
    st.vy = Math.max(0, st.vy);
  }
  // Out of the dive's dip, level again
  st.dip *= Math.exp(-dt * (st.glide > 0 ? 1.6 : 4));
  p.verticalVel = 0;

  // On the steps, shallow enough: standing, a walker again, up them
  if (e.surface - bottom <= SWIM.wade && st.since > 0.4) {
    leave(p, { y: Math.max(p.position.y, bottom) });
    return;
  }

  const dir = localDir(e, p.heading);
  // Swum into a ladder: up it. The jump key or the use key at the wall, facing it: out over the edge
  if (k.forward && p.speed >= -0.05 && !st.turn) {
    const lad = ladderAhead(e, cl, dir);
    if (lad) {
      startClimb(p, e, 'up', lad);
      return;
    }
  }
  if (cm.jumpQueued > 0 || st.useQueued) {
    cm.jumpQueued = 0;
    st.useQueued = false;
    const out = climbOut(cm, p);
    if (out) {
      startClimb(p, e, out.kind, out.ladder, out.edge);
      return;
    }
  }

  stir(p, st, e, dt);
}

/** The swimmer's strokes and its wake: drops into the water, and the strokes' sounds */
function stir(p, st, e, dt) {
  const speed = Math.abs(p.speed);
  const was = st.phase;
  if (st.glide <= 0) st.phase = (st.phase + dt * STROKE * Math.max(0.5, speed) * st.m) % 1;
  st.tread = (st.tread + dt * 0.75) % 1;
  st.roll = Math.sin(st.phase * 2 * Math.PI) * 0.55 * st.m;
  const y = e.site.y + e.surface;
  const sin = Math.sin(p.heading), cos = Math.cos(p.heading);
  const { x, z } = p.position;
  if (st.m > 0.5 && st.glide <= 0 && p.position.y > e.surface - SWIM.eye - 0.25) {
    // a hand in, ahead of each shoulder, once a stroke
    for (const [side, at] of [[1, 0], [-1, 0.5]]) {
      const a = (was - at + 1) % 1, b = (st.phase - at + 1) % 1;
      if (b < a) {
        const ox = Math.cos(p.heading) * 0.2 * side, oz = -Math.sin(p.heading) * 0.2 * side;
        event(p, { x: x + sin * 0.85 + ox, y, z: z + cos * 0.85 + oz, radius: 0.35, strength: -0.022, sound: 'stroke', size: 0.5 + speed * 0.3 });
      }
    }
    // the kick, six beats a stroke
    const kicks = Math.floor(st.phase * 6) !== Math.floor(was * 6) || st.phase < was;
    if (kicks) {
      st.kick = -st.kick || 1;
      event(p, { x: x - sin * 1.05, y, z: z - cos * 1.05, radius: 0.35, strength: st.kick * 0.006 });
    }
  }
  // the head pushing its bow wave, a few times a second while it goes, and treading water's hands
  st.bow -= dt;
  if (st.bow <= 0 && p.position.y > e.surface - SWIM.eye - 0.25) {
    st.bow = 1 / 15;
    if (speed > 0.2) event(p, { x: x + sin * 0.55, y, z: z + cos * 0.55, radius: 0.5, strength: 0.008 * Math.min(1.5, speed) });
    else if (st.m < 0.5 && Math.floor(st.time * 3) !== Math.floor((st.time - dt) * 3)) {
      event(p, { x, y, z, radius: 0.6, strength: (Math.floor(st.time * 3) % 2 ? 1 : -1) * 0.004 });
    }
  }
}

/**
 * Out over the edge or up a ladder from where the swimmer is now, facing the wall at it: { kind: 'edge' | 'up', edge, ladder }, or null.
 * The deck where it'd stand must be clear (the starting blocks, the flags' poles)
 */
function climbOut(cm, p) {
  const st = p.swim, e = st?.pool;
  if (!e || st.mode !== 'swim') return null;
  const l = toLocal(e, p.position.x, p.position.z), dir = localDir(e, p.heading);
  const lad = ladderAhead(e, l, dir);
  if (lad) return { kind: 'up', ladder: lad };
  const wall = wallNear(e, l);
  if (wall.d > SWIM.margin + 0.2 || dir.x * wall.n.x + dir.z * wall.n.z < OUT_CONE) return null;
  const land = toWorld(e, wall.edge.x + wall.n.x * LAND, wall.edge.z + wall.n.z * LAND);
  if (cm.spotClear && !cm.spotClear('person', land.x, land.z, worldHeading(e, wall.n.x, wall.n.z))) return null;
  return { kind: 'edge', edge: wall };
}

/** Back on its feet, a walker: on the deck after a climb, or standing on the steps */
function leave(p, { y = 0 } = {}) {
  blendFrom(p, 0.3);
  p.swim = null;
  p.position.y = y;
  p.verticalVel = 0;
  p.jumping = false;
  p.jumpPrep = 0;
  p.heldBack = null;
  p.dive = null;
  p.speed = Math.max(0, Math.min(p.speed, 1));
  p.sideSpeed = 0;
  p.rig.placed = false;
  p.position.landed = { x: p.position.x, z: p.position.z };
}

/** Out of the water at once, wherever it's put (a teleport, another way to travel) */
function stop(p) {
  p.swim = null;
  p.dive = null;
  p.swimPush = 0;
  p.poseBlend = null;
  if (p.swimEvents) p.swimEvents.length = 0;
  p.rig.placed = false;
}

// --- Climbing ----------------------------------------------------------------------------------------------------------------------
// A climb's frames: [t (s), along (m out of the water from the edge, at the pelvis), pelvis (m over the deck), pitch (rad forward),
// hands [along, up, out] or null hanging, the left foot and the right [along, up]], facing the wall
const CLIMBS = {
  edge: [
    [0.0, -0.36, -0.8, 0.1, [-0.12, -0.12, 0.26], [-0.42, -1.62], [-0.38, -1.58]],
    [0.28, -0.3, -0.72, 0.12, [0.14, 0.02, 0.27], [-0.4, -1.55], [-0.36, -1.5]],
    [0.58, -0.22, 0.06, 0.3, [0.14, 0.02, 0.27], [-0.3, -0.8], [-0.28, -0.85]],
    [0.84, 0.06, 0.36, 0.72, [0.26, 0.02, 0.27], [0.12, 0.0], [-0.26, -0.36]],
    [1.12, LAND, STAND, 0.02, null, [LAND + 0.03, 0.0], [LAND - 0.03, 0.0]]
  ],
  // up a ladder, its hands on its rails and its feet on its rungs (['rung', i]: the i-th from the lowest)
  ladder: [
    [0.0, -0.44, -0.8, 0.02, [-0.16, 0.32, 0.25], [-0.46, -1.62], [-0.42, -1.58]],
    [0.42, -0.4, -0.52, 0.04, [-0.14, 0.45, 0.25], ['rung', 0], [-0.42, -1.3]],
    [0.84, -0.38, -0.16, 0.06, [-0.14, 0.6, 0.25], ['rung', 1], ['rung', 0]],
    [1.26, -0.36, 0.22, 0.1, [-0.13, 0.75, 0.25], ['rung', 2], ['rung', 1]],
    [1.66, -0.08, 0.62, 0.34, [0.12, 0.88, 0.25], [0.08, 0.0], ['rung', 2]],
    [2.06, LAND, STAND, 0.02, null, [LAND + 0.03, 0.0], [LAND - 0.03, 0.0]]
  ]
};

/**
 * A climb, in place of swimming or walking: 'edge' out over it, 'up' a ladder, 'down' a ladder (from the deck, its frames backwards, then
 * turned to face the pool). `wall` the edge's point and outward normal in the pool's frame, for 'edge'.
 */
function startClimb(p, e, kind, ladder = null, wall = null) {
  let edge, n;
  if (ladder) {
    n = { x: -ladder.into[0], z: -ladder.into[1] };
    edge = { x: ladder.at[0], z: ladder.at[1] };
  } else {
    n = wall.n;
    edge = wall.edge;
  }
  const keys = kind === 'edge' ? CLIMBS.edge : CLIMBS.ladder;
  if (!p.swim) {
    // From the deck, down a ladder: the swimmer's state with it
    enter(p, e, {});
    p.position.y = keys.at(-1)[2] - STAND;
  }
  blendFrom(p, 0.3);
  const st = p.swim;
  st.mode = 'climb';
  st.climb = {
    kind, keys, ladder, edge, n, t: kind === 'down' ? keys.at(-1)[0] : 0, length: keys.at(-1)[0],
    heading: worldHeading(e, n.x, n.z), from: p.heading, turned: 0
  };
  p.speed = 0;
  p.sideSpeed = 0;
}

function climbStep(cm, p, dt) {
  const st = p.swim, e = st.pool, c = st.climb;
  const down = c.kind === 'down';
  c.t = down ? Math.max(0, c.t - dt) : Math.min(c.length, c.t + dt);
  c.turned = Math.min(1, c.turned + dt / 0.3);
  const f = climbFrame(c.keys, c.t, c.ladder);
  const at = toWorld(e, c.edge.x + c.n.x * f.along, c.edge.z + c.n.z * f.along);
  p.position.x = at.x;
  p.position.z = at.z;
  p.position.y = f.pelvis - STAND;
  // Round to face the wall as it starts (going down, the ladder is behind the walker: it turns to it)
  const turn = Math.atan2(Math.sin(c.heading - c.from), Math.cos(c.heading - c.from));
  p.heading = c.from + turn * smooth(c.turned);
  p.speed = 0;
  p.verticalVel = 0;
  p.position.landed = { x: p.position.x, z: p.position.z };
  // Water off it as it comes out, and the splash of going in
  if (Math.floor(c.t * 5) !== Math.floor((c.t + (down ? dt : -dt)) * 5) && f.pelvis < 0.4) {
    const ew = toWorld(e, c.edge.x - c.n.x * 0.3, c.edge.z - c.n.z * 0.3);
    event(p, { x: ew.x, y: e.site.y + e.surface, z: ew.z, radius: 0.4, strength: down ? -0.008 : 0.006, sound: down ? 'stroke' : null, size: 0.4 });
  }
  if (!down && c.t >= c.length) {
    p.heading = c.heading;
    leave(p, { y: 0 });
    p.speed = 0;
  } else if (down && c.t <= 0) {
    // In: turned round from the ladder to face the pool, swimming
    st.mode = 'swim';
    st.climb = null;
    st.vy = 0;
    st.since = 0;
    p.heading = c.heading;
    st.turn = { from: c.heading, to: c.heading + Math.PI, t: 0, length: 0.8 };
    const w = toWorld(e, c.edge.x - c.n.x * (SWIM.margin + 0.05), c.edge.z - c.n.z * (SWIM.margin + 0.05));
    p.position.x = w.x;
    p.position.z = w.z;
    blendFrom(p, 0.4);
  }
}

/** A climb's frame at t s: { along, pelvis, pitch, hands, feet } */
function climbFrame(keys, t, ladder) {
  const rungs = ladder ? [...ladder.rungs].sort((a, b) => a - b) : [];
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
  const a = keys[i], b = keys[i + 1];
  const k = smooth(Math.max(0, Math.min(1, (t - a[0]) / Math.max(1e-6, b[0] - a[0]))));
  const mix = (u, v) => u + (v - u) * k;
  const foot = (fa, fb) => {
    const at = (q) => (q[0] === 'rung' ? [-0.2, rungs[Math.min(rungs.length - 1, q[1])] ?? -0.75] : q);
    const qa = at(fa), qb = at(fb);
    return [mix(qa[0], qb[0]), mix(qa[1], qb[1])];
  };
  const hands = a[4] && b[4] ? a[4].map((v, j) => mix(v, b[4][j])) : a[4] && !b[4] ? (k < 0.5 ? a[4] : null) : b[4] && !a[4] ? (k > 0.5 ? b[4] : null) : null;
  return { along: mix(a[1], b[1]), pelvis: mix(a[2], b[2]), pitch: mix(a[3], b[3]), hands, feet: [foot(a[5], b[5]), foot(a[6], b[6])] };
}

// --- What it can do here: the prompt, and the use key ------------------------------------------------------------------------------

/** The use key's label for the walker now, near a pool: 'Climb out' swimming at a wall or a ladder, 'Climb down' at a ladder's top */
function prompt(cm, p) {
  if (p.swim) return p.swim.mode === 'swim' && climbOut(cm, p) ? 'Climb out' : null;
  const near = edgeBeside(p.position.x, p.position.z, 1);
  if (!near || p.jumping) return null;
  return ladderBelow(near.e, near.l, localDir(near.e, p.heading)) ? 'Climb down' : null;
}
/** The use key, near a pool: true if it did something */
function use(cm, p) {
  if (p.swim) {
    if (p.swim.mode !== 'swim' || !climbOut(cm, p)) return false;
    p.swim.useQueued = true;
    return true;
  }
  const near = edgeBeside(p.position.x, p.position.z, 1);
  const lad = near && !p.jumping ? ladderBelow(near.e, near.l, localDir(near.e, p.heading)) : null;
  if (!lad) return false;
  startClimb(p, near.e, 'down', lad);
  return true;
}

/** Somewhere dry beside the pool a swimmer's in: on the deck LAND m out from its nearest wall, facing away from the water */
function poolside(p) {
  const e = p.swim?.pool;
  if (!e) return null;
  const wall = wallNear(e, toLocal(e, p.position.x, p.position.z));
  const w = toWorld(e, wall.edge.x + wall.n.x * (LAND + 0.3), wall.edge.z + wall.n.z * (LAND + 0.3));
  return { x: w.x, z: w.z, heading: worldHeading(e, wall.n.x, wall.n.z) };
}

/** For the scripts: what the swimmer's doing, in the pool's frame; how many drops it's made, and splashes, since the page loaded */
function state(p) {
  const st = p.swim;
  const counts = { stirred: p.swimStirred ?? 0, splashes: p.swimSplashes ?? 0 };
  if (!st) return { swimming: false, dive: !!p.dive?.launched, pushing: +(p.swimPush ?? 0).toFixed(2), ...counts };
  const e = st.pool, l = toLocal(e, p.position.x, p.position.z);
  return {
    swimming: true, pool: e.id, mode: st.mode, climb: st.climb?.kind ?? null, x: +l.x.toFixed(3), z: +l.z.toFixed(3), y: +p.position.y.toFixed(3),
    eye: +(p.position.y + SWIM.eye - e.surface).toFixed(3), stroke: +st.m.toFixed(2), phase: +st.phase.toFixed(3), glide: st.glide > 0,
    speed: +p.speed.toFixed(2), ...counts
  };
}

/** The swimmer at (lx, lz) in a pool's frame, for the scripts: in the water there, floating, facing `heading` (world) */
function place(p, x, z, heading) {
  const e = poolAt(x, z);
  if (!e) return false;
  p.position.x = x;
  p.position.z = z;
  p.heading = heading;
  p.speed = 0;
  p.sideSpeed = 0;
  enter(p, e, {});
  p.position.y = e.surface + SWIM.out - SWIM.eye;
  p.position.landed = { x, z };
  p.poseBlend = null;
  return true;
}

/**
 * The swimmer's body under the surface, for the pool's trace (js/pool-water.js setPlayer()): an ellipsoid round its middle, in the world,
 * its axes `u` along the body (to the head), `v` through it (front to back) and `w` across (to the left) with their half lengths; null out
 * of the water
 */
function traceBody(p) {
  const st = p.swim;
  // Wading on the steps: upright, its legs under the water
  const wading = st ? null : poolAt(p.position.x, p.position.z);
  if (!st && !wading) return null;
  const rig = p.rig, pose = rig.pose;
  if (!rig.placed && !st) return null;
  sizesOf(rig);
  // the body's middle between its pelvis and its chest as the rig drew them, and the line between them
  const at = (b) => {
    const o = b * 8;
    return { x: pose[o + 4] + rig.poseOriginX, y: pose[o + 5], z: pose[o + 6] + rig.poseOriginZ };
  };
  _tq.set(pose[0], pose[1], pose[2], pose[3]);
  const up = _tu.set(0, 1, 0).applyQuaternion(_tq), front = _tv.set(0, 0, 1).applyQuaternion(_tq);
  const left = _tw.crossVectors(up, front);
  const pool = st?.pool ?? wading, pelvis = at(BONE.PELVIS), base = pool.site.y;
  // (a bone's stored place is its bind joint's, less where the bind pose puts it: the joint itself is that plus its turned bind offset).
  // Its middle: swimming, between the pelvis and the chest; standing, lower, for its legs
  const pj = _tj.copy(rig.bind[BONE.PELVIS]).applyQuaternion(_tq).multiplyScalar(pose[7]);
  const off = st ? 0.22 : -0.1;
  const middle = { x: pelvis.x + pj.x + up.x * off, y: pelvis.y + pj.y + up.y * off + base, z: pelvis.z + pj.z + up.z * off };
  // Climbing out, its legs over the edge: nothing of it under the water to trace
  if (st?.mode === 'climb' && middle.y > base + pool.surface - 0.1) return null;
  return { at: middle, u: [up.x, up.y, up.z, st ? 0.88 : 0.9], v: [front.x, front.y, front.z, 0.14], w: [left.x, left.y, left.z, 0.22] };
}

const _tq = new THREE.Quaternion(), _tu = new THREE.Vector3(), _tv = new THREE.Vector3(), _tw = new THREE.Vector3(), _tj = new THREE.Vector3();

// --- The rig's poses ---------------------------------------------------------------------------------------------------------------
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
const _qBody = new THREE.Quaternion(), _qPelvis = new THREE.Quaternion(), _qChest = new THREE.Quaternion(), _qHead = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _pelvis = new THREE.Vector3(), _chest = new THREE.Vector3(), _head = new THREE.Vector3();
const _shoulder = new THREE.Vector3(), _hip = new THREE.Vector3(), _target = new THREE.Vector3(), _target2 = new THREE.Vector3();
const _pole = new THREE.Vector3(), _pole2 = new THREE.Vector3(), _front = new THREE.Vector3(), _ankle = new THREE.Vector3();
const _fwd = new THREE.Vector3(), _left = new THREE.Vector3(), _axis = new THREE.Vector3(), _belly = new THREE.Vector3();
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
const qX = (out, a) => out.setFromAxisAngle(AX, a);
const qY = (out, a) => out.setFromAxisAngle(AY, a);
const smooth = (t) => t * t * (3 - 2 * t);

// The hand's way round a freestyle stroke, from its shoulder: [phase, forward, up, out]. In ahead of the shoulder, on out under the surface,
// the catch, the pull under the chest and the push past the hip, out at the hip, and over the water, its elbow high, to go in again
const STROKE_KEYS = [
  [0.0, 0.5, -0.1, 0.06], [0.1, 0.62, -0.18, 0.08], [0.25, 0.42, -0.5, 0.04], [0.42, 0.0, -0.52, -0.06], [0.55, -0.42, -0.28, 0.06],
  [0.62, -0.5, -0.05, 0.12], [0.75, -0.24, 0.24, 0.3], [0.88, 0.2, 0.22, 0.22]
];
function strokeAt(phi, out) {
  const n = STROKE_KEYS.length;
  let i = n - 1;
  while (i > 0 && phi < STROKE_KEYS[i][0]) i--;
  const p1 = STROKE_KEYS[i], p2 = STROKE_KEYS[(i + 1) % n], p0 = STROKE_KEYS[(i - 1 + n) % n], p3 = STROKE_KEYS[(i + 2) % n];
  const end = i + 1 < n ? p2[0] : 1;
  const t = (phi - p1[0]) / Math.max(1e-6, end - p1[0]), t2 = t * t, t3 = t2 * t;
  for (let j = 1; j <= 3; j++) {
    out[j - 1] = 0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3);
  }
  return out;
}
const _stroke = [0, 0, 0];

/** The rig posed for the walker in the water: swimming, treading water, or climbing */
function pose(p, dt) {
  const st = p.swim, rig = p.rig;
  sizesOf(rig);
  if (st.mode === 'climb') poseClimb(rig, p, st);
  else poseSwim(rig, p, st, dt);
  rig.x = p.position.x;
  rig.z = p.position.z;
  rig.yaw = p.heading;
  rig.speed = Math.abs(p.speed);
  rig.gait = rig.run = 0;
  applyBlend(p, dt);
}

function poseSwim(rig, p, st, dt) {
  const s = rig.s, e = st.pool, h = p.heading, m = st.m;
  const water = e.surface;
  const sinH = Math.sin(h), cosH = Math.cos(h);
  _fwd.set(sinH, 0, cosH);
  _left.set(cosH, 0, -sinH);
  // The body: upright treading, leaning a little; flat swimming, a little head up, rolling with the stroke (the hips less than the chest)
  const bob = Math.sin(st.tread * 2 * Math.PI) * 0.025 * (1 - m) + Math.sin(st.phase * 4 * Math.PI) * 0.012 * m;
  const flat = Math.PI / 2 - 0.06 + st.dip;
  qY(_qa, h).multiply(qX(_q, 0.12));
  qY(_qb, h).multiply(qX(_q, flat)).multiply(qY(_q2, st.roll * 0.6));
  _qPelvis.copy(_qa).slerp(_qb, m);
  qY(_qb, h).multiply(qX(_q, flat - 0.04)).multiply(qY(_q2, st.roll));
  qY(_qa, h).multiply(qX(_q, 0.14));
  _qChest.copy(_qa).slerp(_qb, m);
  // Its middle: the eye's height less what it is over the middle, upright or flat
  const y = p.position.y + 1.1 + 0.38 * m + bob;
  _axis.set(0, 1, 0).applyQuaternion(_qPelvis);
  _pelvis.set(p.position.x, y, p.position.z).addScaledVector(_axis, -0.14 * s);
  rig.writeBone(BONE.PELVIS, _qPelvis, _pelvis);
  rig.jointFrom(BONE.PELVIS, BONE.CHEST, _qPelvis, _pelvis, _chest);
  rig.writeBone(BONE.CHEST, _qChest, _chest);
  // The head: level treading; swimming, in line with the body, looking ahead and down, turned to the side to breathe as the right arm
  // comes over, once a stroke cycle
  const breathe = st.glide > 0 ? 0 : Math.max(0, Math.sin(st.phase * 2 * Math.PI + 0.3)) ** 3;
  st.breathe += (breathe * 1.15 * m - st.breathe) * Math.min(1, dt * 8);
  qY(_qa, h).multiply(qX(_q, 0.04));
  qY(_qb, h).multiply(qX(_q, flat - 0.42)).multiply(qY(_q2, -st.breathe));
  _qHead.copy(_qa).slerp(_qb, m);
  rig.jointFrom(BONE.CHEST, BONE.HEAD, _qChest, _chest, _head);
  rig.writeBone(BONE.HEAD, _qHead, _head);
  rig.pelvisY = _pelvis.y;

  _belly.set(0, 0, 1).applyQuaternion(_qChest);
  for (let i = 0; i < 2; i++) {
    const side = SIDES[i];
    rig.jointFrom(BONE.CHEST, LIMB.upperArm[i], _qChest, _chest, _shoulder);
    // Treading: the hands sculling in and out in front of the chest, under the water
    const scull = Math.sin((st.tread * 2 + i * 0.5) * 2 * Math.PI);
    _target.copy(_shoulder).addScaledVector(_fwd, 0.26).addScaledVector(_left, side * (0.2 + 0.12 * scull));
    _target.y = Math.min(_shoulder.y - 0.3, water - 0.12);
    _pole.copy(_left).multiplyScalar(side * 0.7).addScaledVector(_fwd, -0.5).add(_v.set(0, -0.3, 0));
    // Swimming: round the stroke, or reaching ahead gliding
    if (st.glide > 0) _stroke[0] = 0.66, _stroke[1] = -0.12, _stroke[2] = 0.02;
    else strokeAt((st.phase + i * 0.5) % 1, _stroke);
    _target2.copy(_shoulder).addScaledVector(_fwd, _stroke[0]).addScaledVector(_left, side * _stroke[2]);
    _target2.y += _stroke[1];
    const over = (st.phase + i * 0.5) % 1 > 0.6 && st.glide <= 0;
    _pole2.copy(_left).multiplyScalar(side * (over ? 0.4 : 1)).add(_v.set(0, over ? 1 : 0.35, 0)).addScaledVector(_fwd, over ? -0.2 : 0);
    _target.lerp(_target2, m);
    _pole.lerp(_pole2, m).normalize();
    _front.copy(_belly);
    rig.limb(LIMB.upperArm[i], LIMB.forearm[i], _shoulder, _target, UPPER_ARM * s, (FOREARM + 0.07) * s, _pole, _front, side * ARM_BIND_ABDUCTION);
  }
  const here = toLocal(e, p.position.x, p.position.z);
  const bottom = bottomAt(e, here.x, here.z);
  _axis.set(0, 1, 0).applyQuaternion(_qPelvis);
  _belly.set(0, 0, 1).applyQuaternion(_qPelvis);
  for (let i = 0; i < 2; i++) {
    const side = SIDES[i];
    rig.jointFrom(BONE.PELVIS, LIMB.thigh[i], _qPelvis, _pelvis, _hip);
    // Treading: the legs cycling under it, the knees forward
    const pedal = (st.tread * 2 + i * 0.5) * 2 * Math.PI;
    _target.copy(_hip).addScaledVector(_fwd, 0.14 + 0.12 * Math.sin(pedal));
    _target.y -= 0.72 * s - 0.08 * Math.cos(pedal);
    _pole.copy(_fwd).add(_v.set(0, 0.2, 0));
    // Swimming: straight back from the hips, kicking six beats a stroke
    const kick = Math.sin((st.phase * 3 + i * 0.5) * 2 * Math.PI) * 0.1 * (st.glide > 0 ? 0.2 : 1);
    _target2.copy(_hip).addScaledVector(_axis, -0.8 * s).addScaledVector(_belly, kick);
    _target.lerp(_target2, m);
    _target.y = Math.max(_target.y, bottom + ANKLE_H + 0.02);
    _pole.lerp(_pole2.copy(_belly), m).normalize();
    _front.copy(_belly).lerp(_fwd, 1 - m).normalize();
    const ankle = _ankle.copy(rig.limb(LIMB.thigh[i], LIMB.shin[i], _hip, _target, THIGH * s, SHIN * s, _pole, _front, 0, 0.012));
    // The feet pointed: down treading, back along the legs swimming, soles up
    qY(_qa, h).multiply(qX(_q, 0.7));
    rig.basis(_v.copy(_belly), _v2.copy(_axis).negate(), _qb);
    _qa.slerp(_qb, m);
    rig.writeFoot(i, ankle, _qa, 0);
  }
}

function poseClimb(rig, p, st) {
  const s = rig.s, e = st.pool, c = st.climb;
  const f = climbFrame(c.keys, c.t, c.ladder);
  const h = p.heading;
  const n = { x: Math.sin(h), z: Math.cos(h) }; // facing the wall
  _fwd.set(n.x, 0, n.z);
  _left.set(Math.cos(h), 0, -Math.sin(h));
  // the edge's point in the world, and the deck's height over the water's frame there (its level: 0)
  const E = toWorld(e, c.edge.x, c.edge.z);
  const nw = { x: Math.sin(c.heading), z: Math.cos(c.heading) };
  const point = (along, up, out, out2) => _v.set(E.x + nw.x * along, up, E.z + nw.z * along).addScaledVector(_left, out).addScaledVector(_fwd, out2 ?? 0);
  qY(_qPelvis, h).multiply(qX(_q, f.pitch * 0.6));
  qY(_qChest, h).multiply(qX(_q, f.pitch));
  _pelvis.set(p.position.x, f.pelvis, p.position.z);
  rig.writeBone(BONE.PELVIS, _qPelvis, _pelvis);
  rig.jointFrom(BONE.PELVIS, BONE.CHEST, _qPelvis, _pelvis, _chest);
  rig.writeBone(BONE.CHEST, _qChest, _chest);
  qY(_qHead, h).multiply(qX(_q, 0.1 - f.pitch * 0.55));
  rig.jointFrom(BONE.CHEST, BONE.HEAD, _qChest, _chest, _head);
  rig.writeBone(BONE.HEAD, _qHead, _head);
  rig.pelvisY = _pelvis.y;
  _front.set(0, 0, 1).applyQuaternion(_qChest);
  for (let i = 0; i < 2; i++) {
    const side = SIDES[i];
    rig.jointFrom(BONE.CHEST, LIMB.upperArm[i], _qChest, _chest, _shoulder);
    if (f.hands) _target.copy(point(f.hands[0], f.hands[1], side * f.hands[2]));
    else _target.copy(_shoulder).addScaledVector(_left, side * 0.06).addScaledVector(_fwd, 0.06).add(_v2.set(0, -0.56 * s, 0));
    _pole.copy(_left).multiplyScalar(side * 0.6).addScaledVector(_fwd, -0.5).add(_v2.set(0, -0.6, 0)).normalize();
    rig.limb(LIMB.upperArm[i], LIMB.forearm[i], _shoulder, _target, UPPER_ARM * s, (FOREARM + 0.07) * s, _pole, _front, side * ARM_BIND_ABDUCTION);
  }
  for (let i = 0; i < 2; i++) {
    const side = SIDES[i];
    rig.jointFrom(BONE.PELVIS, LIMB.thigh[i], _qPelvis, _pelvis, _hip);
    const [along, up] = f.feet[i];
    _target.copy(point(along, up + ANKLE_H * s, side * 0.1));
    _pole.copy(_fwd).add(_v2.set(0, 0.25, 0)).normalize();
    const ankle = _ankle.copy(rig.limb(LIMB.thigh[i], LIMB.shin[i], _hip, _target, THIGH * s, SHIN * s, _pole, _fwd, 0, 0.012));
    // flat on the deck or a rung; hanging in the water, pointed down
    qY(_qa, h).multiply(qX(_q, up < -0.5 && along < 0 ? 0.6 : 0));
    rig.writeFoot(i, ankle, _qa, 0);
  }
}

/** The rig in a dive's flight: turning head down about its pelvis, the arms out over the head, the legs straight together */
function poseDive(p, dt) {
  const rig = p.rig, s = rig.s, d = p.dive, h = p.heading;
  sizesOf(rig);
  const pitch = diveArc(d.t);
  _fwd.set(Math.sin(h), 0, Math.cos(h));
  _left.set(Math.cos(h), 0, -Math.sin(h));
  qY(_qPelvis, h).multiply(qX(_q, pitch));
  _qChest.copy(_qPelvis).multiply(qX(_q, 0.06));
  _pelvis.set(p.position.x, p.position.y + STAND, p.position.z);
  rig.writeBone(BONE.PELVIS, _qPelvis, _pelvis);
  rig.jointFrom(BONE.PELVIS, BONE.CHEST, _qPelvis, _pelvis, _chest);
  rig.writeBone(BONE.CHEST, _qChest, _chest);
  _qHead.copy(_qChest).multiply(qX(_q, 0.25));
  rig.jointFrom(BONE.CHEST, BONE.HEAD, _qChest, _chest, _head);
  rig.writeBone(BONE.HEAD, _qHead, _head);
  _axis.set(0, 1, 0).applyQuaternion(_qChest);
  _belly.set(0, 0, 1).applyQuaternion(_qChest);
  for (let i = 0; i < 2; i++) {
    const side = SIDES[i];
    rig.jointFrom(BONE.CHEST, LIMB.upperArm[i], _qChest, _chest, _shoulder);
    // from the crouch's swing back to over the head as it leaves the edge
    const reach = smooth(Math.min(1, d.t / 0.25));
    _target.copy(_shoulder).addScaledVector(_axis, -0.5 + 1.08 * reach).addScaledVector(_left, side * (0.12 - 0.1 * reach)).addScaledVector(_belly, 0.12 * (1 - reach));
    _pole.copy(_left).multiplyScalar(side).addScaledVector(_belly, -0.4).normalize();
    rig.limb(LIMB.upperArm[i], LIMB.forearm[i], _shoulder, _target, UPPER_ARM * s, (FOREARM + 0.07) * s, _pole, _belly, side * ARM_BIND_ABDUCTION);
    rig.jointFrom(BONE.PELVIS, LIMB.thigh[i], _qPelvis, _pelvis, _hip);
    _target.copy(_hip).addScaledVector(_axis, -0.84 * s).addScaledVector(_left, -side * 0.03);
    const ankle = _ankle.copy(rig.limb(LIMB.thigh[i], LIMB.shin[i], _hip, _target, THIGH * s, SHIN * s, _belly, _belly, 0, 0.012));
    rig.basis(_v.copy(_belly), _v2.copy(_axis).negate(), _qa);
    rig.writeFoot(i, ankle, _qa, 0);
  }
  rig.x = p.position.x;
  rig.z = p.position.z;
  rig.yaw = h;
  rig.pelvisY = _pelvis.y;
  applyBlend(p, dt);
}

// --- From one pose to the next: the last one kept, and eased out of over a moment --------------------------------------------------
/** The rig's pose now, to be eased out of over `seconds` from the next pose on */
function blendFrom(p, seconds) {
  const rig = p.rig;
  const b = (p.poseBlend ??= { from: new Float32Array(rig.pose.length), t: 0, length: 0, ox: 0, oz: 0, on: false });
  b.from.set(rig.pose);
  b.ox = rig.poseOriginX;
  b.oz = rig.poseOriginZ;
  b.t = 0;
  b.length = seconds;
  b.on = true;
}
/** Eases the pose just written from the one kept (blendFrom()), if it's still being eased out of */
function applyBlend(p, dt) {
  const b = p.poseBlend;
  if (!b?.on) return;
  b.t += dt;
  const k = 1 - smooth(Math.min(1, b.t / Math.max(1e-6, b.length)));
  if (k <= 0) {
    b.on = false;
    return;
  }
  const a = p.rig.pose, f = b.from, dx = b.ox - p.rig.poseOriginX, dz = b.oz - p.rig.poseOriginZ;
  for (let bone = 0; bone < 15; bone++) {
    const o = bone * 8;
    // the shorter way round between the two turns
    const sign = a[o] * f[o] + a[o + 1] * f[o + 1] + a[o + 2] * f[o + 2] + a[o + 3] * f[o + 3] < 0 ? -1 : 1;
    let len = 0;
    for (let j = 0; j < 4; j++) {
      a[o + j] += (f[o + j] * sign - a[o + j]) * k;
      len += a[o + j] * a[o + j];
    }
    len = Math.sqrt(len) || 1;
    for (let j = 0; j < 4; j++) a[o + j] /= len;
    a[o + 4] += (f[o + 4] + dx - a[o + 4]) * k;
    a[o + 5] += (f[o + 5] - a[o + 5]) * k;
    a[o + 6] += (f[o + 6] + dz - a[o + 6]) * k;
  }
}

export {
  SWIM, addSwimPools, afterWalk, applyBlend, beforeWalk, bottomAt, bottomUnder, climbFrame, diveStep, holdWader, letsIn, place, poolAt,
  poolside, pose, poseDive, prompt, removeSwimPools, state, stop, surfaceOver, swimStep, toLocal, toWorld, traceBody, use
};
