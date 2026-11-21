import * as THREE from 'three/webgpu';
import { Fn, If, Loop, attribute, cameraPosition, cameraProjectionMatrix, clamp, cos, cross, exp, float, floor, fract, int, length, max, min, mix,
  modelWorldMatrix, mrt, normalize, pow, screenSize, select, sin, smoothstep, sqrt, step, uniform, uniformArray, varyingProperty, vec3, vec4
} from 'three/tsl';

// The fireworks themselves (js/season-new-year.js): shells launched, rising and bursting into sparks, worked out on the GPU from a few
// numbers each, with nothing simulated on the CPU.
// - Per shell, in a ring of slots: where it's launched and where it bursts, when, its kind, its colours, how fast its sparks leave, and two
//   numbers its kind reads. 64 bytes a shell, written once when it's launched (addUpdateRange), never a buffer refilled every frame.
// - Per spark: a ribbon facing you from its head back along its trail, its path worked out in the vertex shader from its index and the
//   time: its direction (a sphere, a ring, a fan, a crossette's arms splitting in four, a curtain falling off the bridge's deck), then
//   gravity and the air's drag, in closed form. Its colour fades and reddens as it dies; a strobe's flickers, a willow's twinkles.
//   Added to what's behind it, as wide as a spark near and never under MIN_PX on screen far off (dimmer as it's spread wider).
// - The smoke each burst leaves: a few soft puffs drifting on the wind, faint against the night sky, lit from within by the brightest
//   bursts going off near them.
// - The brightest bursts, a short list worked out on the CPU each frame from the slots: what the harbour's water reflects, what lights the
//   smoke and the Opera House's sails (js/new-year-harbour.js).
//
// Everything is drawn from BASE, the harbour's middle, so what reaches the GPU stays small.

const BASE = { x: 0, z: -1800 };
const MIN_PX = 1.4;
const SMOKE_LIFE = 16; // s a puff lasts after its burst
const WIND = [0.86, 0.51]; // the way the smoke drifts: the wind the trees lean in (js/tsl-materials.js)
const WIND_SPEED = 2.2; // m/s

// What each level draws at most: shells at once, sparks a shell, sections along a trail, smoke puffs a shell, and bright bursts the
// water and the smoke see
const LEVELS = {
  low: { shells: 32, sparks: 80, trail: 2, puffs: 0, bright: 6, widen: 1.35 },
  medium: { shells: 56, sparks: 140, trail: 3, puffs: 3, bright: 10, widen: 1.1 },
  high: { shells: 112, sparks: 220, trail: 4, puffs: 4, bright: 16, widen: 1 }
};

// How a spark leaves its burst: from a sphere, a ring, a crossette's arms (split in four), a fan of comets, or a curtain falling
const MODE = { sphere: 0, ring: 1, crossette: 2, fan: 3, curtain: 4 };
// Each kind: the air's drag (1/s) and gravity's share, s of trail behind each spark, its width (m), how many sparks (a share of the level's
// up to 1, or a number over it), its mode, how long a spark burns (s), how bright, and whether its colour changes as it burns (else half its sparks are the
// second colour), strobes, twinkles, or splits (at that share of its life)
const KINDS = {
  peony: { id: 0, drag: 1.3, gravity: 1, trail: 0.22, width: 1.5, count: 1, mode: MODE.sphere, life: 2.4, peak: 3.6, change: 1 },
  chrysanthemum: { id: 1, drag: 1.0, gravity: 1, trail: 0.75, width: 1.2, count: 1, mode: MODE.sphere, life: 2.9, peak: 3.2 },
  willow: { id: 2, drag: 2.1, gravity: 1, trail: 1.6, width: 1.1, count: 0.75, mode: MODE.sphere, life: 5.5, peak: 2.4, twinkle: 1 },
  palm: { id: 3, drag: 0.85, gravity: 1, trail: 1.0, width: 2.8, count: 22, mode: MODE.sphere, life: 3.6, peak: 4.2 },
  ring: { id: 4, drag: 1.3, gravity: 1, trail: 0.25, width: 1.5, count: 0.5, mode: MODE.ring, life: 2.4, peak: 3.8, change: 1 },
  crossette: { id: 5, drag: 1.1, gravity: 1, trail: 0.4, width: 1.3, count: 1, mode: MODE.crossette, life: 2.8, peak: 3.4, split: 0.4 },
  strobe: { id: 6, drag: 1.7, gravity: 0.6, trail: 0, width: 1.8, count: 0.8, mode: MODE.sphere, life: 3.2, peak: 5.0, strobe: 1 },
  comet: { id: 7, drag: 0.5, gravity: 1, trail: 0.8, width: 1.8, count: 7, mode: MODE.fan, life: 2.6, peak: 4.4 },
  waterfall: { id: 8, drag: 0.7, gravity: 1, trail: 0.6, width: 1.2, count: 1, mode: MODE.curtain, life: 5.0, peak: 3.0 }
};
const KIND_LIST = Object.entries(KINDS).sort((a, b) => a[1].id - b[1].id);
const COMET_SPEED = 55; // m/s off the bridge
const RISE_TRAIL = 0.35; // s of trail behind a rising shell

/** The kinds as three vec4 each, for the shaders: [drag, gravity, trail, width], [count, mode, life, peak], [change, strobe, twinkle, split] */
function kindTable() {
  const out = [];
  for (const [, k] of KIND_LIST) {
    out.push(new THREE.Vector4(k.drag, k.gravity, k.trail, k.width));
    out.push(new THREE.Vector4(k.count, k.mode, k.life, k.peak));
    out.push(new THREE.Vector4(k.change ?? 0, k.strobe ?? 0, k.twinkle ?? 0, k.split ?? 0));
  }
  return out;
}

/** How many sparks a shell of a kind has, at a level's sparks a shell */
const sparksOf = (kind, sparks) => (kind.count <= 1 ? Math.max(1, Math.floor(kind.count * sparks)) : Math.min(kind.count, sparks));

/**
 * A spark's place and velocity `t` s after it left (x0, y0, z0) at (vx, vy, vz), under gravity (m/s²) and the air's drag (1/s): the
 * vertex shader's sparkPath(), here for the tests and the CPU's estimates
 */
function sparkPath(x0, y0, z0, vx, vy, vz, drag, gravity, t) {
  const f = Math.exp(-drag * t), e = (1 - f) / drag, fall = gravity / drag;
  return {
    x: x0 + vx * e, y: y0 + vy * e - fall * (t - e), z: z0 + vz * e,
    vx: vx * f, vy: vy * f - fall * (1 - f), vz: vz * f
  };
}

const unpackColour = (c) => [Math.floor(c / 65536) / 255, (Math.floor(c / 256) % 256) / 255, (c % 256) / 255];

// The same hash in every vertex of a spark: its index, the shell's seed and a salt
const hash = (a, b, salt) => fract(sin(a.mul(12.9898).add(b.mul(78.233)).add(salt)).mul(43758.5453));
const unpack = (c) => vec3(floor(c.div(65536.0)), floor(c.div(256.0)).mod(256.0), c.mod(256.0)).div(255.0);

/** Where a spark is `t` s after it left `from` at `v`: drag and gravity in closed form */
function pathAt(from, v, t, drag, gravity) {
  const e = float(1.0).sub(exp(drag.negate().mul(t))).div(drag);
  return from.add(v.mul(e)).add(vec3(0.0, gravity.div(drag).negate(), 0.0).mul(t.sub(e)));
}
function velocityAt(v, t, drag, gravity) {
  const f = exp(drag.negate().mul(t));
  return v.mul(f).add(vec3(0.0, gravity.div(drag).negate(), 0.0).mul(float(1.0).sub(f)));
}

function sparkMaterial(u, table, level) {
  const { sparks, trail, widen } = level;
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  mat.fog = false; // the haze is worked out here: fog on a sheet added to the sky would light the whole of it
  // What's under it stays in the G-buffer: reflections see what's there, not the sparks' ribbons
  mat.mrtNode = mrt({ normal: vec4(0.0, 0.0, 0.0, 0.0), metalRough: vec4(0.0, 0.0, 0.0, 0.0) });
  const vLight = varyingProperty('vec3', 'vSparkLight');
  const vAcross = varyingProperty('float', 'vSparkAcross');
  mat.positionNode = Fn(() => {
    const A = attribute('aShellA', 'vec4'), B = attribute('aShellB', 'vec4'), C = attribute('aShellC', 'vec4'), D = attribute('aShellD', 'vec4');
    const rib = attribute('aRib', 'vec3');
    const i = rib.x, k = rib.y, side = rib.z;
    const kind = C.x, seed = C.y, speed = C.z, end = C.w;
    const row = int(kind.add(0.5)).mul(3);
    const k0 = table.element(row), k1 = table.element(row.add(1)), k2 = table.element(row.add(2));
    const drag = k0.x, gravity = k0.y.mul(9.81), trailSeconds = k0.z, width = k0.w.mul(widen);
    const mode = k1.y, sparkLife = k1.z, peak = k1.w;
    const count = select(k1.x.lessThanEqual(1.0), max(floor(k1.x.mul(sparks)), 1.0), min(k1.x, float(sparks))).toVar();
    const isMode = (m) => mode.greaterThan(m - 0.5).and(mode.lessThan(m + 0.5));
    const split = isMode(MODE.crossette);
    // A crossette's sparks are its arms' children, four to an arm: the arm's path is the same for all four
    // Values used in the branches below and after them are variables declared here: a value is written where it's first used
    const arms = select(split, floor(count.div(4.0)), count).toVar();
    const arm = select(split, floor(i.div(4.0)), i).toVar();
    const child = i.sub(arm.mul(4.0)).toVar();
    const h1 = hash(arm, seed, 0.13).toVar(), h2 = hash(arm, seed, 1.71).toVar(), h3 = hash(arm, seed, 3.37).toVar();
    const age = u.now.sub(A.w).toVar();
    const life = sparkLife.mul(h1.mul(0.3).add(0.7)).toVar();
    const v0 = speed.mul(h2.mul(0.14).add(0.88)).toVar();
    const dir = vec3(0.0, 1.0, 0.0).toVar();
    const from = A.xyz.toVar();
    const tau = age.toVar();
    const shown = step(arm, arms.sub(0.5)).mul(step(0.0, age)).toVar();
    If(isMode(MODE.ring), () => {
      // A ring in a plane tilted by p1 from level, turned p2 about the vertical
      const n = vec3(sin(D.z).mul(cos(D.w)), cos(D.z), sin(D.z).mul(sin(D.w)));
      const a = normalize(cross(n, vec3(0.31, 0.12, 0.94)));
      const b = cross(n, a);
      const theta = arm.div(arms).mul(6.2832).add(seed.mul(6.2832));
      dir.assign(a.mul(cos(theta)).add(b.mul(sin(theta))));
    }).ElseIf(isMode(MODE.fan), () => {
      // Comets in a fan p2 either side of straight up, spread along p1
      const alpha = arm.div(max(arms.sub(1.0), 1.0)).sub(0.5).mul(2.0).mul(D.w).add(h1.sub(0.5).mul(0.08));
      dir.assign(normalize(vec3(sin(alpha).mul(cos(D.z)), cos(alpha), sin(alpha).mul(sin(D.z)))));
    }).ElseIf(isMode(MODE.curtain), () => {
      // Off the deck's edge anywhere along its p2 m, and again each time it's burnt out, for as long as the waterfall lasts (`end`)
      from.assign(A.xyz.add(vec3(cos(D.z), 0.0, sin(D.z)).mul(h1.mul(D.w))));
      dir.assign(normalize(vec3(h2.sub(0.5).mul(0.6), -1.0, h3.sub(0.5).mul(0.6))));
      v0.assign(h2.mul(2.0).add(1.5));
      const since = age.sub(h3.mul(life));
      const cycles = floor(since.div(life));
      tau.assign(since.sub(cycles.mul(life)));
      shown.assign(step(0.0, since).mul(step(h3.mul(life).add(cycles.mul(life)), end)));
    }).Else(() => {
      // A sphere, its sparks spread evenly over it (a Fibonacci lattice), each a little off
      const y = float(1.0).sub(arm.add(0.5).div(arms).mul(2.0));
      const r = sqrt(max(float(1.0).sub(y.mul(y)), 0.0));
      const phi = arm.mul(2.39996).add(seed.mul(6.2832));
      dir.assign(normalize(vec3(r.mul(cos(phi)), y, r.mul(sin(phi))).add(vec3(h1, h2, h3).sub(0.5).mul(0.12))));
    });
    shown.mulAssign(step(tau, life));
    // This vertex's place along the trail: its section's time
    const along = k.div(trail).toVar();
    const tk = max(tau.sub(k.mul(trailSeconds).div(trail)), 0.0);
    const v = dir.mul(v0);
    const armAt = pathAt(from, v, tk, drag, gravity);
    const armVelocity = velocityAt(v, tk, drag, gravity);
    // A crossette's arm splits in four at its share of its life: each child kicked off square to the arm
    const ts = k2.w.mul(life);
    const splitAt = pathAt(from, v, ts, drag, gravity);
    const splitVelocity = velocityAt(v, ts, drag, gravity);
    const ahead = normalize(splitVelocity.add(vec3(0.0, 1e-4, 0.0)));
    const sideA = normalize(cross(ahead, vec3(0.0, 1.0, 0.0)).add(vec3(1e-4, 0.0, 0.0)));
    const sideB = cross(ahead, sideA);
    const angle = child.mul(1.5708).add(h3.mul(1.5708));
    const kick = sideA.mul(cos(angle)).add(sideB.mul(sin(angle))).mul(v0.mul(0.45));
    const childAt = pathAt(splitAt, splitVelocity.add(kick), max(tk.sub(ts), 0.0), drag, gravity);
    const childVelocity = velocityAt(splitVelocity.add(kick), max(tk.sub(ts), 0.0), drag, gravity);
    const parted = split.and(tk.greaterThan(ts));
    const at = select(parted, childAt, armAt).toVar();
    const velocity = select(parted, childVelocity, armVelocity).toVar();
    // Before the split only one of an arm's four is drawn
    shown.mulAssign(select(split.and(tau.lessThan(ts)), step(child, 0.5), float(1.0)));
    // How bright: a flash as it bursts, fading as it burns out, a strobe's flicker, a willow's twinkle, dimmer back along the trail
    const flash = exp(tau.mul(-7.0)).mul(2.2).add(1.0);
    const fade = smoothstep(life, life.mul(0.5), tau);
    const strobe = mix(float(1.0), step(0.42, fract(tau.mul(h2.mul(5.0).add(9.0)).add(h1))), k2.y.mul(step(life.mul(0.25), tau)));
    const twinkle = mix(float(1.0), sin(tau.mul(23.0).add(h1.mul(40.0))).mul(0.35).add(0.65), k2.z);
    const bright = peak.mul(flash).mul(fade).mul(strobe).mul(twinkle).mul(pow(float(1.0).sub(along), 1.5)).toVar();
    const a = unpack(D.x), b = unpack(D.y);
    const burnt = tau.div(life);
    const mixed = select(k2.x.greaterThan(0.5), smoothstep(0.25, 0.75, burnt), step(0.5, hash(i, seed, 5.9)));
    // Sparks redden as they cool
    const ember = mix(vec3(1.0), vec3(1.0, 0.5, 0.2), smoothstep(0.55, 1.0, burnt).mul(0.7));
    const colour = mix(a, b, mixed).mul(ember).toVar();
    const w = width.mul(mix(float(1.0), float(0.35), along)).toVar();
    // The shell rising, before its burst: the first spark's ribbon, from where it was fired, slowing as it climbs
    const climb = B.w.lessThan(A.w.sub(0.05)).and(u.now.greaterThanEqual(B.w)).and(age.lessThan(0.0)).and(i.lessThan(0.5));
    If(climb, () => {
      const span = A.w.sub(B.w);
      const s = clamp(u.now.sub(k.mul(RISE_TRAIL).div(trail)).sub(B.w).div(span), 0.0, 1.0);
      const eased = float(1.0).sub(float(1.0).sub(s).mul(float(1.0).sub(s)));
      at.assign(mix(B.xyz, A.xyz, eased));
      velocity.assign(A.xyz.sub(B.xyz).mul(float(1.0).sub(s).mul(2.0).div(span)));
      shown.assign(1.0);
      colour.assign(vec3(1.0, 0.62, 0.3));
      bright.assign(pow(float(1.0).sub(along), 1.5).mul(1.6));
      w.assign(float(0.9 * widen));
    });
    // Facing you, as wide as it is near and MIN_PX far off
    const world = modelWorldMatrix.mul(vec4(at, 1.0)).xyz;
    const toCamera = cameraPosition.sub(world);
    const distance = max(length(toCamera), 0.1);
    const pixel = distance.mul(2.0).div(cameraProjectionMatrix[1].y.mul(screenSize.y));
    const wide = max(w, pixel.mul(MIN_PX));
    const spread = clamp(w.div(wide), 0.2, 1.0);
    const forward = normalize(velocity.add(vec3(0.0, 1e-4, 0.0)));
    const across = normalize(cross(forward, toCamera.div(distance)).add(vec3(0.0, 0.0, 1e-5)));
    // The ribbon's head and tail stand out half a width, so a spark with no trail is still a soft point
    const reach = select(k.lessThan(0.5), float(0.5), select(k.greaterThan(trail - 0.5), float(-0.5), float(0.0)));
    const placed = at.add(across.mul(side.mul(wide).mul(0.5))).add(forward.mul(wide.mul(reach)));
    const haze = exp(distance.mul(u.haze).negate());
    vLight.assign(colour.mul(bright).mul(spread).mul(haze).mul(shown));
    vAcross.assign(side);
    return select(shown.greaterThan(0.5), placed, A.xyz);
  })();
  mat.colorNode = vec4(vLight.mul(exp(vAcross.mul(vAcross).mul(-3.0))), 1.0);
  return mat;
}

function smokeMaterial(u, bright) {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor
  });
  mat.fog = false;
  mat.mrtNode = mrt({ normal: vec4(0.0, 0.0, 0.0, 0.0), metalRough: vec4(0.0, 0.0, 0.0, 0.0) });
  const vLight = varyingProperty('vec3', 'vSmokeLight');
  const vAlpha = varyingProperty('float', 'vSmokeAlpha');
  const vCorner = varyingProperty('vec2', 'vSmokeCorner');
  mat.positionNode = Fn(() => {
    const A = attribute('aShellA', 'vec4'), C = attribute('aShellC', 'vec4');
    const puff = attribute('aPuff', 'vec3');
    const p = puff.x, corner = puff.yz;
    const kind = C.x, seed = C.y, speed = C.z;
    const row = int(kind.add(0.5)).mul(3);
    const drag = u.table.element(row).x;
    const age = u.now.sub(A.w);
    // None from the comets or the waterfall: they leave no shell's worth of smoke in one place
    const shown = step(0.2, age).mul(step(age, SMOKE_LIFE)).mul(step(kind, KINDS.strobe.id + 0.5));
    const radius = speed.div(drag);
    const h1 = hash(p, seed, 7.1), h2 = hash(p, seed, 8.3), h3 = hash(p, seed, 9.7);
    const off = normalize(vec3(h1, h2, h3).sub(0.5).add(vec3(0.0, 1e-3, 0.0)));
    const drift = vec3(WIND[0] * WIND_SPEED, -0.4, WIND[1] * WIND_SPEED).mul(age);
    const middle = A.xyz.add(off.mul(radius.mul(h1.mul(0.6).add(0.35)))).add(drift);
    const size = radius.mul(float(1.0).sub(exp(age.div(-5.0))).mul(0.35).add(0.3)).mul(h2.mul(0.5).add(0.75));
    const alpha = smoothstep(0.6, 3.0, age).mul(smoothstep(SMOKE_LIFE, SMOKE_LIFE * 0.35, age)).mul(0.1);
    const world = modelWorldMatrix.mul(vec4(middle, 1.0)).xyz.toVar();
    const toCamera = normalize(cameraPosition.sub(world)).toVar();
    const right = normalize(cross(vec3(0.0, 1.0, 0.0), toCamera).add(vec3(1e-4, 0.0, 0.0)));
    const up = cross(toCamera, right);
    // Lit from within by the brightest bursts near it, and a little by the moon
    const light = vec3(0.004, 0.005, 0.008).toVar();
    Loop({ start: int(0), end: u.brightCount, type: 'int', condition: '<' }, ({ i }) => {
      const at = bright.element(i.mul(2)), glow = bright.element(i.mul(2).add(1));
      const d = length(at.xyz.sub(world)).div(at.w.mul(1.5).add(20.0));
      light.addAssign(glow.xyz.mul(0.035).div(d.mul(d).add(1.0)));
    });
    const haze = exp(length(cameraPosition.sub(world)).mul(u.haze).negate());
    vLight.assign(light.mul(haze));
    vAlpha.assign(alpha.mul(shown).mul(haze));
    vCorner.assign(corner);
    const placed = middle.add(right.mul(corner.x.mul(size))).add(up.mul(corner.y.mul(size)));
    return select(shown.greaterThan(0.5), placed, A.xyz);
  })();
  mat.colorNode = Fn(() => {
    const r = length(vCorner);
    const a = vAlpha.mul(smoothstep(1.0, 0.15, r));
    return vec4(vLight.mul(a), a);
  })();
  return mat;
}

/**
 * The fireworks for a graphics level ('low', 'medium', 'high'): { group, launch(cue, at), update(now, origin), bright, state() }.
 * `now`: the show's clock (s); a cue's times are on it. Its materials are made by show(), once there's a first frame to draw them in.
 */
function createFireworks({ level = 'high' } = {}) {
  const L = LEVELS[level] ?? LEVELS.high;
  const group = new THREE.Group();
  group.name = 'Fireworks';
  const u = {
    now: uniform(0),
    haze: uniform(0.00011),
    table: uniformArray(kindTable(), 'vec4'),
    brightCount: uniform(0, 'int')
  };
  // The brightest bursts now: [place (from the origin), radius], [colour times brightness, 0]
  const bright = uniformArray(Array.from({ length: L.bright * 2 }, () => new THREE.Vector4()), 'vec4');
  const brightList = []; // what's in it, for the state and the tests

  // Per shell, shared by the sparks and the smoke
  const attributes = ['aShellA', 'aShellB', 'aShellC', 'aShellD'].map((name) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(L.shells * 4), 4);
    a.name = name;
    return a;
  });
  // A slot never written lies far below the sea, long burnt out
  for (let s = 0; s < L.shells; s++) {
    attributes[0].array[s * 4 + 1] = -5000;
    attributes[0].array[s * 4 + 3] = -1e6;
    attributes[1].array[s * 4 + 3] = -1e6;
  }

  // The sparks' ribbons: for each spark, trail + 1 sections of two vertices
  const sparkGeometry = new THREE.InstancedBufferGeometry();
  {
    const sections = L.trail + 1, per = sections * 2;
    const rib = new Float32Array(L.sparks * per * 3);
    const index = [];
    for (let i = 0; i < L.sparks; i++) {
      for (let k = 0; k < sections; k++) {
        for (let s = 0; s < 2; s++) rib.set([i, k, s ? 1 : -1], (i * per + k * 2 + s) * 3);
        if (k < L.trail) {
          const v = i * per + k * 2;
          index.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
        }
      }
    }
    sparkGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(L.sparks * per * 3), 3));
    sparkGeometry.setAttribute('aRib', new THREE.BufferAttribute(rib, 3));
    sparkGeometry.setIndex(index);
  }
  const smokeGeometry = new THREE.InstancedBufferGeometry();
  if (L.puffs) {
    const puff = new Float32Array(L.puffs * 4 * 3);
    const index = [];
    for (let p = 0; p < L.puffs; p++) {
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([x, y], c) => puff.set([p, x, y], (p * 4 + c) * 3));
      index.push(p * 4, p * 4 + 1, p * 4 + 2, p * 4 + 1, p * 4 + 3, p * 4 + 2);
    }
    smokeGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(L.puffs * 4 * 3), 3));
    smokeGeometry.setAttribute('aPuff', new THREE.BufferAttribute(puff, 3));
    smokeGeometry.setIndex(index);
  }
  for (const g of [sparkGeometry, smokeGeometry]) {
    attributes.forEach((a) => g.setAttribute(a.name, a));
    g.instanceCount = L.shells;
  }

  let sparks = null, smoke = null;
  /** The meshes and their materials, made once they're wanted */
  function show() {
    if (sparks) return;
    sparks = new THREE.Mesh(sparkGeometry, sparkMaterial(u, u.table, L));
    sparks.name = 'FireworkSparks';
    sparks.renderOrder = 2;
    const meshes = [sparks];
    if (L.puffs) {
      smoke = new THREE.Mesh(smokeGeometry, smokeMaterial(u, bright));
      smoke.name = 'FireworkSmoke';
      smoke.renderOrder = 1;
      meshes.push(smoke);
    }
    for (const mesh of meshes) {
      mesh.position.set(BASE.x, 0, BASE.z); // placed, so it's drawn from here (js/world-origin.js leaves it be)
      mesh.frustumCulled = false; // what's in it is worked out on the GPU
      mesh.castShadow = mesh.receiveShadow = false;
      mesh.userData.lifted = true;
      mesh.userData.ownMaterial = true;
      group.add(mesh);
    }
  }

  // The slots as the CPU knows them, for the bright list and the state
  const slots = Array.from({ length: L.shells }, () => null);
  let next = 0;
  let epoch = 0; // what the clock counted from when the slots' times were last written: they're kept small, for the GPU's floats
  const launched = { shells: 0, skipped: 0 };

  /** How full the ring is at `at`: the share of its slots with a shell still in them */
  function fill(at) {
    let used = 0;
    for (const slot of slots) if (slot && at <= slot.end) used++;
    return used / L.shells;
  }

  /** A slot free for a shell launched at `at`: the next in the ring if its shell has burnt out, else the first that has, else null */
  function freeSlot(at) {
    for (let n = 0; n < L.shells; n++) {
      const s = (next + n) % L.shells;
      const slot = slots[s];
      if (!slot || at > slot.end) {
        next = (s + 1) % L.shells;
        return s;
      }
    }
    return null;
  }

  function write(s) {
    const slot = slots[s];
    const [A, B, C, D] = attributes.map((a) => a.array);
    const o = s * 4;
    A.set([slot.to[0] - BASE.x, slot.to[1], slot.to[2] - BASE.z, slot.burst - epoch], o);
    B.set([slot.from[0] - BASE.x, slot.from[1], slot.from[2] - BASE.z, slot.launch - epoch], o);
    C.set([slot.kind.id, slot.seed, slot.speed, slot.life], o);
    D.set([slot.colours[0], slot.colours[1], slot.p1, slot.p2], o);
    for (const a of attributes) {
      a.addUpdateRange(o, 4);
      a.needsUpdate = true;
    }
  }

  /**
   * A cue's shell launched at `at` on the show's clock (s): { t, kind, from, to, rise, size, colours, seed, p1, p2, life?, keep? }. False if
   * there was no room for it. `keep` (0-1): how much it matters to the show; when the ring is filling up, the least of them are left out
   * first (the fountains before the shells), so a lower level's fewer slots go to the shells that make the show.
   */
  function launch(cue, at) {
    const kind = KINDS[cue.kind] ?? KINDS.peony;
    const keep = cue.keep ?? 1, full = fill(at);
    if ((full > 0.7 && keep < 0.6) || (full > 0.85 && keep < 0.9)) {
      launched.skipped++;
      return false;
    }
    const burst = at + (cue.rise || 0);
    // How long it lasts after its burst: its sparks, or the waterfall's length and its last sparks. Its smoke goes on, but doesn't keep its
    // slot: the ring takes the oldest slot first, so a shell's smoke is cut short only when the show's at its busiest, late in its life
    const life = kind.mode === MODE.curtain ? cue.life ?? 30 : kind.life;
    const end = burst + life + (kind.mode === MODE.curtain ? kind.life : 0);
    const s = freeSlot(at);
    if (s === null) {
      launched.skipped++;
      return false;
    }
    const speed = kind.mode === MODE.fan ? COMET_SPEED * (0.9 + cue.seed * 0.2) : kind.mode === MODE.curtain ? 0 : cue.size * kind.drag;
    slots[s] = { kind, launch: at, burst, end, from: cue.from, to: cue.to, speed, life, seed: cue.seed, colours: cue.colours, p1: cue.p1 ?? 0,
      p2: cue.p2 ?? 0, size: cue.size };
    write(s);
    launched.shells++;
    return true;
  }

  /** The brightest bursts at `now`: [{ x, y, z (the game's frame), radius, colour: [r, g, b] times brightness, brightness }] */
  function brightest(now, n = L.bright) {
    const out = [];
    for (const slot of slots) {
      if (!slot) continue;
      const t = now - slot.burst;
      const { kind } = slot;
      if (t < 0) continue;
      let b, radius, x = slot.to[0], y = slot.to[1], z = slot.to[2];
      if (kind.mode === MODE.curtain) {
        if (t > slot.life + kind.life) continue;
        b = kind.peak * 0.5 * Math.min(1, t / 2, (slot.life + kind.life - t) / 2);
        radius = slot.p2 / 2;
        x += Math.cos(slot.p1) * radius;
        z += Math.sin(slot.p1) * radius;
        y -= 18;
      } else {
        if (t > kind.life) continue;
        const sparks = sparksOf(kind, LEVELS.high.sparks);
        b = kind.peak * (1 + 2.2 * Math.exp(-7 * t)) * smooth(kind.life, kind.life * 0.5, t) * Math.min(1.5, sparks / 90);
        radius = kind.mode === MODE.fan ? 40 : (slot.speed / kind.drag) * (1 - Math.exp(-kind.drag * t));
        if (kind.mode === MODE.fan) y += 45;
        else y -= 0.5 * 9.81 * kind.gravity * t * t * 0.25;
      }
      if (b <= 0.01) continue;
      const [ca, cb] = [unpackColour(slot.colours[0]), unpackColour(slot.colours[1])];
      const colour = ca.map((c, i) => ((c + cb[i]) / 2) * b);
      out.push({ x, y, z, radius: Math.max(radius, 8), colour, brightness: b * (1 + radius / 60) });
    }
    out.sort((p, q) => q.brightness - p.brightness);
    return out.slice(0, n);
  }

  /** Each frame: the clock, and the bright list from the slots. `origin`: the world's (js/world-origin.js) */
  function update(now, origin) {
    // Every half hour the slots' times are written again from a later epoch, so the GPU's 32-bit floats keep their milliseconds
    if (now - epoch > 1800) {
      epoch = Math.floor(now / 1800) * 1800;
      for (let s = 0; s < L.shells; s++) if (slots[s]) write(s);
    }
    u.now.value = now - epoch;
    const list = brightest(now);
    brightList.length = 0;
    list.forEach((p, i) => {
      bright.array[i * 2].set(p.x - origin.x, p.y, p.z - origin.z, p.radius);
      bright.array[i * 2 + 1].set(p.colour[0], p.colour[1], p.colour[2], 0);
      brightList.push(p);
    });
    u.brightCount.value = list.length;
  }

  /** Nothing in the air: every slot emptied (the show starting again from another place in its loop) */
  function clear() {
    for (let s = 0; s < L.shells; s++) {
      if (!slots[s]) continue;
      slots[s] = { ...slots[s], launch: -1e6, burst: -1e6, end: -1e6 };
      write(s);
    }
  }

  /** What's in the air at `now`: shells launched and not yet burnt out, and the sparks of those that have burst */
  function state(now) {
    let live = 0, sparksNow = 0;
    for (const slot of slots) {
      if (!slot || now < slot.launch || now > slot.end) continue;
      live++;
      if (now >= slot.burst) sparksNow += sparksOf(slot.kind, L.sparks);
    }
    return { level, shells: L.shells, sparksPerShell: L.sparks, live, sparks: sparksNow, launched: launched.shells, skipped: launched.skipped,
      bright: brightList.length };
  }

  function dispose() {
    sparkGeometry.dispose();
    smokeGeometry.dispose();
    sparks?.material.dispose();
    smoke?.material.dispose();
  }

  return { group, u, bright, level: L, show, launch, update, clear, state, brightest, dispose, slots };
}

function smooth(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export { BASE, KINDS, LEVELS, MODE, createFireworks, sparkPath, sparksOf, unpackColour };
