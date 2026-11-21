import * as THREE from 'three/webgpu';
import {
  Fn, Loop, abs, cameraPosition, cameraViewMatrix, clamp, color, cos, exp, float, floor, fract, instanceIndex, instancedArray, int, length,
  max, min, mix, normalize, positionLocal, positionWorld, refract, select, sin, smoothstep, storage, time, uniformArray, vec2,
  vec3, vec4
} from 'three/tsl';

// A pool's water that moves: a model's JSON names it among its `pools` with `sim` (North Sydney Pool's 50 m pool is the first). Fetched
// only near one (js/main.js), never in the first download. Ported from Evan Wallace's WebGL Water (MIT; LICENSE-webgl-water-MIT), as the
// battleship game's ocean ported it, from GLSL passes over render targets to TSL compute over storage buffers:
// - The ripples: a height field over the water, GRID cells, stepped at HZ by two compute passes: the velocity from the neighbours'
//   heights (their Laplacian), then the height from the velocity, and the drops queued for that step. The walls reflect (a pool's do):
//   a cell past the edge is the edge's own. The first pass also keeps each cell's slopes and curvature, for the surface and the caustics.
// - The surface: one quad at the water's level, its colour traced as WebGL Water traces it: the view refracted through the surface's
//   normal into the pool's box (its floor down the depth profile, its walls, the steps, the swimmers), the tiles and lane lines there,
//   the caustics on them (the curvature of the surface where the sun came in over them focuses its light), tinted by the water on the way;
//   the sky in it by Fresnel (the material's own reflection of the environment, a dielectric's); at night the pool's lights in its walls.
// - What stirs it: the wind (a few small drops a step, and fine waves of its own), the swimmers doing laps (their heads, hands and kicks),
//   and drop(), which anything may call: the player swimming, a splash.
// - Without compute (the WebGL2 fallback) or on low: no height field. The surface's normals are the fine waves alone, scrolling, and the
//   caustics are worked out from them.
// Everything is in the pool's own frame: its site's, moved to the water's middle, y up from its surface.

const GRID = [128, 64]; // cells along and across the pool
const HZ = 30; // steps a second
const MAX_DROPS = 24; // a step's drops
const COEF = 0.06; // (c dt / dx)^2: ripples at about 2.3 m/s over 0.39 m cells at 30 Hz
const DAMP = 0.994; // of the velocity, a step
const HEIGHT_DAMP = 0.9995; // of the height, a step, so nothing drifts
const IOR = 1.333;
const CAUSTIC = 12.0; // how strongly the surface's curvature focuses the light on the floor: more than water's own, for cells this big
const ABSORB = [1.15, 0.2, 0.12]; // per metre, red to blue: what turns the white tiles turquoise
const TINT = [0.02, 0.26, 0.33]; // the light the water scatters back
const ALBEDO = 0.52; // of what's seen through it, lit as the surface is: the sun's full light on it would wash its colour out
const SWIMMER = { half: [0.95, 0.15, 0.26], y: -0.22 }; // a swimmer's body under the surface, an ellipsoid for the trace
const SWIMMERS = { low: 3, medium: 4, high: 6 };
const STROKE = 0.52; // stroke cycles a second for each m/s
// The fine waves: [wavelength m, direction rad, amplitude m]; their speed from deep water's, sqrt(g / k)
const WAVES = [[3.1, 0.4, 0.0045], [1.7, 2.1, 0.003], [1.05, 4.0, 0.0018], [0.66, 5.4, 0.0012]];

/**
 * The water of one pool. `site`: { x, y, z, yaw } its model's place; `pool`: the JSON's entry (`ring`, `surface`, `depth`, `lanes`, `lane`,
 * `steps`), in the site's frame; `renderer` to step it; `reveal(group)` puts it in the scene with its shader ready; `uniforms`: the city's
 * (js/tsl-materials.js: the sun's direction, the night's glow); `simulate`: whether there's a height field; `level`: the graphics level,
 * for how many swimmers. Returns { group, update(dt, drawn), drop(x, z, radius, strength), surfaceAt(x, z), state(), dispose() }.
 */
async function createPoolWater({ site, pool, renderer, reveal, uniforms, simulate, level = 'medium', seed = 1 }) {
  const xs = pool.ring.map((p) => p[0]), zs = pool.ring.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, hx = (x1 - x0) / 2, hz = (z1 - z0) / 2;
  const [W, H] = GRID;
  const N = W * H;
  const cellX = (2 * hx) / W, cellZ = (2 * hz) / H;
  const c = Math.cos(site.yaw), s = Math.sin(site.yaw);
  // The pool's frame from the world's, and back (the site's rotation.y, then the water's middle)
  const toPool = (x, z) => {
    const dx = x - site.x, dz = z - site.z;
    return { x: dx * c - dz * s - cx, z: dx * s + dz * c - cz };
  };
  let rnd = seed >>> 0 || 1;
  const random = () => ((rnd = (Math.imul(rnd, 1664525) + 1013904223) >>> 0) / 4294967296);

  // --- The height field ----------------------------------------------------------------------------------------------------------
  const heights = simulate ? instancedArray(N, 'float') : null;
  const motion = simulate ? instancedArray(N, 'vec4') : null; // the velocity, the slopes along x and z, the curvature
  const drops = simulate ? uniformArray(Array.from({ length: MAX_DROPS }, () => new THREE.Vector4(0, 0, 1, 0)), 'vec4') : null;
  let velocityStep = null, heightStep = null;
  if (simulate) {
    const at = (x, z) => heights.element(clamp(z, 0, H - 1).mul(W).add(clamp(x, 0, W - 1)));
    velocityStep = Fn(() => {
      const i = int(instanceIndex);
      const x = i.mod(W), z = i.div(W);
      const h = heights.element(i);
      const hl = at(x.sub(1), z), hr = at(x.add(1), z), hu = at(x, z.sub(1)), hd = at(x, z.add(1));
      const lap = hl.add(hr).add(hu).add(hd).sub(h.mul(4));
      const v = motion.element(i).x.add(lap.mul(COEF)).mul(DAMP);
      motion.element(i).assign(vec4(v, hr.sub(hl).div(2 * cellX), hd.sub(hu).div(2 * cellZ), lap.div(cellX * cellZ)));
    })().compute(N);
    heightStep = Fn(() => {
      const i = int(instanceIndex);
      // the cell's middle, in metres from the water's middle
      const px = float(i.mod(W)).add(0.5).mul(cellX).sub(hx), pz = float(i.div(W)).add(0.5).mul(cellZ).sub(hz);
      const h = heights.element(i).add(motion.element(i).x).toVar();
      Loop(MAX_DROPS, ({ i: k }) => {
        const d = drops.element(k);
        const f = max(float(0), float(1).sub(length(vec2(px, pz).sub(d.xy)).div(d.z)));
        h.addAssign(float(0.5).sub(cos(f.mul(Math.PI)).mul(0.5)).mul(d.w));
      });
      heights.element(i).assign(h.mul(HEIGHT_DAMP));
    })().compute(N);
  }
  // The surface's shader reads them as they are, each frame
  const heightsRead = simulate ? storage(heights.value, 'float', N).toReadOnly() : null;
  const motionRead = simulate ? storage(motion.value, 'vec4', N).toReadOnly() : null;
  /** The height field's `store` between its cells' middles at (px, pz), in the pool's frame */
  const sample = (store, px, pz) => {
    const gx = px.add(hx).div(cellX).sub(0.5), gz = pz.add(hz).div(cellZ).sub(0.5);
    const ix = clamp(floor(gx), 0, W - 2), iz = clamp(floor(gz), 0, H - 2);
    const fx = clamp(gx.sub(ix), 0, 1), fz = clamp(gz.sub(iz), 0, 1);
    const i = int(iz).mul(W).add(int(ix));
    return mix(mix(store.element(i), store.element(i.add(1)), fx), mix(store.element(i.add(W)), store.element(i.add(W + 1)), fx), fz);
  };

  // --- The fine waves, the wind's: slopes and curvature at (px, pz), as nodes --------------------------------------------------------
  const fine = (px, pz, k) => {
    let sx = float(0), sz = float(0), lap = float(0);
    for (const [L, dir, a] of WAVES) {
      const kk = (2 * Math.PI) / L, w = Math.sqrt(9.81 * kk);
      const kx = kk * Math.cos(dir), kz = kk * Math.sin(dir);
      const phase = px.mul(kx).add(pz.mul(kz)).sub(time.mul(w));
      const ca = cos(phase).mul(a * k), sa = sin(phase).mul(a * k);
      sx = sx.add(ca.mul(kx));
      sz = sz.add(ca.mul(kz));
      lap = lap.sub(sa.mul(kk * kk));
    }
    return { sx, sz, lap };
  };
  const waveScale = simulate ? 0.35 : 1.0;

  // --- The pool's box, for the trace ----------------------------------------------------------------------------------------------
  // The depth under the surface along x: each stretch of the profile adds its change across it
  const depth = pool.depth.map(([x, d]) => [x - cx, d]);
  const depthAt = (px) => {
    let d = float(depth[0][1]);
    for (let i = 0; i + 1 < depth.length; i++) {
      const [xa, da] = depth[i], [xb, db] = depth[i + 1];
      if (xb - xa > 1e-6) d = d.add(clamp(px.sub(xa).div(xb - xa), 0, 1).mul(db - da));
    }
    return d;
  };
  // Steps down into it: boxes from the floor up to each tread, under the surface
  const surface = pool.surface;
  const steps = (pool.steps ?? []).map((st) => {
    const sx = st.poly.map((p) => p[0] - cx), sz = st.poly.map((p) => p[1] - cz);
    return { min: [Math.min(...sx), -4, Math.min(...sz)], max: [Math.max(...sx), st.y - surface, Math.max(...sz)] };
  });
  const lanes = pool.lanes ?? 0, laneW = pool.lane ?? 2.5, laneZ0 = -hz + (2 * hz - lanes * laneW) / 2;
  const swimmerBoxes = uniformArray(Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 1, 0)), 'vec4');

  /** Where a ray from P along R first leaves the box [lo, hi] it's in, or enters [lo, hi] from outside: (near, far) */
  const slab = (P, R, lo, hi) => {
    const inv = vec3(1).div(R);
    const ta = vec3(...lo).sub(P).mul(inv), tb = vec3(...hi).sub(P).mul(inv);
    const t1 = min(ta, tb), t2 = max(ta, tb);
    return vec2(max(max(t1.x, t1.y), t1.z), min(min(t2.x, t2.y), t2.z));
  };

  // --- The surface's material -----------------------------------------------------------------------------------------------------
  const sun = uniforms.uSkySunDir, glow = uniforms.uInteriorGlow;
  // water's own reflectance (2% straight on, its index of refraction's), not a dielectric's usual 4%
  const material = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.04, metalness: 0.0, ior: IOR });
  const P2 = positionLocal.xz; // the mesh is at the water's middle, unturned in the site's frame
  const fineHere = fine(P2.x, P2.y, waveScale);
  const simHere = simulate ? sample(motionRead, P2.x, P2.y) : null;
  const slopeX = simulate ? simHere.y.add(fineHere.sx) : fineHere.sx;
  const slopeZ = simulate ? simHere.z.add(fineHere.sz) : fineHere.sz;
  // Further off, the fine waves would shimmer in a pixel: they fade into a calm surface
  const seen = length(cameraPosition.sub(positionWorld));
  const calm = smoothstep(60, 200, seen);
  const nLocal = normalize(mix(vec3(slopeX.negate(), 1, slopeZ.negate()), vec3(0, 1, 0), calm.mul(0.7)));
  // ...turned into the world's frame and the camera's
  const nWorld = vec3(nLocal.x.mul(c).add(nLocal.z.mul(s)), nLocal.y, nLocal.z.mul(c).sub(nLocal.x.mul(s)));
  material.normalNode = cameraViewMatrix.transformDirection(nWorld);

  const traced = Fn(() => {
    const Vw = normalize(cameraPosition.sub(positionWorld));
    const V = vec3(Vw.x.mul(c).sub(Vw.z.mul(s)), Vw.y, Vw.x.mul(s).add(Vw.z.mul(c)));
    const P = vec3(P2.x, 0, P2.y);
    const R = refract(V.negate(), nLocal, 1 / IOR).toVar();
    R.y.assign(min(R.y, -0.02));
    // the walls: the first side the ray reaches
    const tx = select(R.x.greaterThan(0), float(hx).sub(P.x), float(-hx).sub(P.x)).div(select(abs(R.x).lessThan(1e-4), float(1e-4), R.x));
    const tz = select(R.z.greaterThan(0), float(hz).sub(P.z), float(-hz).sub(P.z)).div(select(abs(R.z).lessThan(1e-4), float(1e-4), R.z));
    const tWall = min(abs(tx), abs(tz));
    // the floor down its profile: three steps towards where the ray meets it
    const t = depthAt(P.x).div(R.y.negate()).toVar();
    for (let i = 0; i < 3; i++) t.assign(depthAt(P.x.add(R.x.mul(t))).div(R.y.negate()));
    const what = float(0).toVar(); // 0 the floor, 1 a wall, 2 a step, 3 a swimmer
    const tHit = t.toVar();
    const onWall = tWall.lessThan(tHit);
    tHit.assign(min(tHit, tWall));
    what.assign(select(onWall, float(1), float(0)));
    for (const st of steps) {
      const hit = slab(P, R, st.min, st.max);
      const nearer = hit.x.lessThan(hit.y).and(hit.x.greaterThan(0)).and(hit.x.lessThan(tHit));
      what.assign(select(nearer, float(2), what));
      tHit.assign(select(nearer, hit.x, tHit));
    }
    const swimmers = SWIMMERS[level] ?? 4;
    // the swimmers: an ellipsoid each, the ray scaled to meet a unit sphere
    const across = float(0).toVar(); // where along the body it was met, -1 to 1 from the feet to the head
    for (let k = 0; k < swimmers; k++) {
      const b = swimmerBoxes.element(k);
      const O = P.sub(vec3(b.x, SWIMMER.y, b.y)).div(vec3(...SWIMMER.half)), D = R.div(vec3(...SWIMMER.half));
      const a = D.dot(D), hb = O.dot(D), cc = O.dot(O).sub(1);
      const disc = hb.mul(hb).sub(a.mul(cc));
      const near = hb.negate().sub(disc.max(0).sqrt()).div(a);
      const nearer = disc.greaterThan(0).and(near.greaterThan(0)).and(near.lessThan(tHit)).and(b.w.greaterThan(0.5));
      what.assign(select(nearer, float(3), what));
      tHit.assign(select(nearer, near, tHit));
      across.assign(select(nearer, O.x.add(D.x.mul(near)).mul(b.z), across));
    }
    const Hp = P.add(R.mul(tHit));
    // The tiles: white-blue, their joints a little darker near to; a lane line down each lane's middle, a T at each end, a target on the
    // end walls; the steps' nosings
    const near = float(1).sub(smoothstep(6, 18, length(cameraPosition.sub(positionWorld))));
    const jx = abs(fract(Hp.x.mul(4)).sub(0.5)), jz = abs(fract(Hp.z.mul(4)).sub(0.5)), jy = abs(fract(Hp.y.mul(4)).sub(0.5));
    const joints = smoothstep(0.44, 0.49, max(select(what.equal(1), max(jy, select(abs(abs(Hp.x).sub(hx)).lessThan(0.01), jz, jx)), max(jx, jz)), float(0)));
    const tile = color(0x92d4ea).mul(float(1).sub(joints.mul(near).mul(0.12)));
    const li = floor(Hp.z.sub(laneZ0).div(laneW));
    const mid = laneZ0 + laneW / 2;
    const lc = li.mul(laneW).add(mid);
    const inLanes = li.greaterThanEqual(0).and(li.lessThan(lanes));
    const along = abs(Hp.x), off = abs(Hp.z.sub(lc));
    const lineFloor = what.equal(0).and(inLanes).and(off.lessThan(0.125).and(along.lessThan(hx - 2 + 0.125))
      .or(off.lessThan(0.5).and(abs(along.sub(hx - 2)).lessThan(0.125))));
    const lineWall = what.equal(1).and(inLanes).and(abs(along.sub(hx)).lessThan(0.02)).and(
      off.lessThan(0.125).and(Hp.y.lessThan(-0.6)).and(Hp.y.greaterThan(depthAt(Hp.x).negate().add(0.3)))
        .or(off.lessThan(0.25).and(Hp.y.lessThan(-0.225)).and(Hp.y.greaterThan(-0.475))));
    // a step's nosing: the top 6 cm of any tread's edge
    let edge = float(0).greaterThan(1);
    for (const st of steps) edge = edge.or(abs(Hp.y.sub(st.max[1])).lessThan(0.06));
    const nosing = what.equal(2).and(edge);
    const base = select(lineFloor.or(lineWall).or(nosing), color(0x1c2f6e), tile).toVar();
    // a swimmer: skin, a dark suit round the middle
    base.assign(select(what.equal(3), select(abs(across.add(0.05)).lessThan(0.22), color(0x1d2433), color(0xa8775d)), base));
    // The caustics: where the sun's light that reaches this point came in through the surface, and how that focused it
    const S = vec3(sun.x.mul(c).sub(sun.z.mul(s)), sun.y, sun.x.mul(s).add(sun.z.mul(c)));
    const Rs = refract(S.negate(), vec3(0, 1, 0), 1 / IOR);
    const back = Hp.y.div(min(Rs.y, -0.05));
    const Q = Hp.xz.sub(Rs.xz.mul(back));
    const fineQ = fine(Q.x, Q.y, waveScale);
    const curve = simulate ? sample(motionRead, Q.x, Q.y).w.add(fineQ.lap) : fineQ.lap;
    const focus = clamp(float(1).div(max(float(0.25), float(1).add(Hp.y.negate().mul(CAUSTIC * 0.25).mul(curve)))), 0.55, 2.0);
    const day = smoothstep(0.02, 0.25, sun.y);
    const lit = mix(float(1), focus, day.mul(select(what.equal(1), float(0.45), float(1))).mul(select(what.equal(3), float(0.3), float(1))));
    const col = base.mul(lit).toVar();
    // ...and the water on the way, out to it
    const path = tHit;
    const keep = exp(vec3(...ABSORB).mul(path).negate());
    col.assign(col.mul(keep).add(vec3(...TINT).mul(float(1).sub(exp(path.mul(-0.12))))).mul(ALBEDO));
    return vec4(col, Hp.z);
  })();
  material.colorNode = traced.xyz;
  // At night the pool's lights in its long walls, every 5 m under the surface: what they light, more near the walls
  const night = smoothstep(0.4, 1.1, glow);
  const fromWall = float(hz).sub(abs(traced.w));
  material.emissiveNode = traced.xyz.mul(night.mul(float(0.3).add(exp(fromWall.div(-2.6)).mul(0.9))));
  material.name = 'pool-water';

  const geometry = new THREE.PlaneGeometry(2 * hx, 2 * hz, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'PoolWater';
  mesh.position.set(cx, surface, cz);
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  // --- The swimmers ---------------------------------------------------------------------------------------------------------------
  const count = Math.min(SWIMMERS[level] ?? 4, lanes || 0);
  const skin = new THREE.MeshStandardNodeMaterial({ color: 0xb98466, roughness: 0.55 });
  const capMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.4 });
  skin.name = 'pool-swimmer';
  capMaterial.name = 'pool-swimmer-cap';
  const torso = new THREE.SphereGeometry(1, 10, 6);
  torso.scale(0.62, 0.12, 0.21);
  const legs = new THREE.BoxGeometry(0.75, 0.08, 0.24);
  legs.translate(-0.95, -0.1, 0);
  const body = mergeParts([torso, legs]);
  const head = new THREE.SphereGeometry(0.115, 10, 6);
  head.translate(0.76, 0.03, 0);
  const arm = new THREE.CylinderGeometry(0.045, 0.04, 0.68, 6);
  arm.translate(0, -0.34, 0);
  const bodies = new THREE.InstancedMesh(body, skin, Math.max(1, count));
  const heads = new THREE.InstancedMesh(head, capMaterial, Math.max(1, count));
  const arms = new THREE.InstancedMesh(arm, skin, Math.max(1, count * 2));
  for (const m of [bodies, heads, arms]) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); // a few dozen numbers a frame
    m.castShadow = false;
    m.receiveShadow = true;
    m.frustumCulled = false;
  }
  bodies.name = 'PoolSwimmers';
  heads.name = 'PoolSwimmerCaps';
  arms.name = 'PoolSwimmerArms';
  const caps = [0xd2302c, 0xffffff, 0x1f56c2, 0x202020, 0xf2c84b, 0x3e8c5a];
  // Lanes for them, spread out, and each its own pace
  const laneOrder = [1, 6, 3, 4, 2, 5, 0, 7].filter((k) => k < lanes);
  const swimmers = Array.from({ length: count }, (_, i) => {
    heads.setColorAt(i, new THREE.Color(caps[i % caps.length]));
    const lane = laneOrder[i];
    const speed = 1.05 + random() * 0.5;
    return { lane, z: laneZ0 + laneW * (lane + 0.5), x: (random() - 0.5) * (2 * hx - 6), dir: random() < 0.5 ? -1 : 1, speed, phase: random(), turn: 0, kick: 0 };
  });
  if (count) heads.instanceColor.needsUpdate = true;
  bodies.count = heads.count = count;
  arms.count = count * 2;

  const group = new THREE.Group();
  group.name = `PoolWater_${pool.id}`;
  group.position.set(site.x, site.y, site.z);
  group.rotation.y = site.yaw;
  group.add(mesh, bodies, heads, arms);
  group.traverse((o) => { o.userData.lifted = true; });

  // --- Each frame ---------------------------------------------------------------------------------------------------------------
  let acc = 0, stepCount = 0, dropCount = 0;
  const queued = []; // [x, z, radius, strength] in the pool's frame
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), at = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const arm4 = new THREE.Matrix4(), body4 = new THREE.Matrix4();
  placeSwimmers(0);
  await reveal(group);

  function placeSwimmers(dt) {
    swimmers.forEach((sw, i) => {
      if (sw.turn > 0) {
        sw.turn -= dt;
      } else {
        sw.x += sw.dir * sw.speed * dt;
        if (Math.abs(sw.x) > hx - 1.1) {
          // a turn at the wall: under for a moment, then back the other way
          sw.x = Math.sign(sw.x) * (hx - 1.1);
          sw.dir = -sw.dir;
          sw.turn = 0.9;
          queued.push([sw.x + sw.dir * -0.6, sw.z, 0.8, 0.03]);
        }
      }
      const was = sw.phase;
      sw.phase = (sw.phase + dt * sw.speed * STROKE) % 1;
      const under = sw.turn > 0;
      // the body rolls with the stroke; the swimmer faces along x one way or the other
      const roll = Math.sin(sw.phase * 2 * Math.PI) * 0.55;
      e.set(roll, sw.dir > 0 ? 0 : Math.PI, 0, 'YXZ');
      q.setFromEuler(e);
      at.set(cx + sw.x, surface + (under ? -0.6 : -0.07) + Math.sin(sw.phase * 4 * Math.PI) * 0.015, cz + sw.z);
      body4.compose(at, q, one);
      bodies.setMatrixAt(i, body4);
      heads.setMatrixAt(i, body4);
      // each arm round its shoulder, opposite the other: under the water pulling back, over it reaching forward
      for (const side of [0, 1]) {
        const phi = ((sw.phase + side * 0.5) % 1) * 2 * Math.PI;
        arm4.makeTranslation(0.5, 0.05, side ? 0.21 : -0.21).multiply(m4.makeRotationZ(Math.PI / 2 - phi));
        arms.setMatrixAt(i * 2 + side, m4.multiplyMatrices(body4, arm4));
        // a hand in at the front once a stroke
        const entry = ((was + side * 0.5) % 1) > 0.9 && ((sw.phase + side * 0.5) % 1) < 0.1;
        if (entry && !under) queued.push([sw.x + sw.dir * 0.75, sw.z + (side ? 0.22 : -0.22) * sw.dir, 0.35, -0.022]);
      }
      if (!under) swimmerBoxes.array[i].set(sw.x, sw.z, sw.dir, 1);
      else swimmerBoxes.array[i].set(0, 0, 1, 0);
    });
    for (const m of [bodies, heads, arms]) m.instanceMatrix.needsUpdate = true;
  }

  function step() {
    // this step's drops: the swimmers' heads and kicks, the wind's few, and what was asked for
    const list = queued.splice(0, queued.length);
    for (const sw of swimmers) {
      if (sw.turn > 0) continue;
      sw.kick = -sw.kick || 1;
      list.push([sw.x + sw.dir * 0.95, sw.z, 0.5, 0.009], [sw.x - sw.dir * 1.05, sw.z + sw.kick * 0.1, 0.35, sw.kick * 0.006]);
    }
    for (let k = 0; k < 2; k++) list.push([(random() - 0.5) * 2 * hx, (random() - 0.5) * 2 * hz, 0.6 + random() * 0.6, (random() - 0.5) * 0.004]);
    const n = Math.min(MAX_DROPS, list.length);
    for (let k = 0; k < MAX_DROPS; k++) {
      const d = list[k];
      if (k < n) drops.array[k].set(d[0], d[1], Math.max(0.05, d[2]), d[3]);
      else drops.array[k].set(0, 0, 1, 0);
    }
    dropCount += n;
    renderer.compute(velocityStep);
    renderer.compute(heightStep);
    stepCount++;
  }

  /** `drawn`: whether the pool's model is drawn now: nothing moves while it isn't */
  function update(dt, drawn) {
    group.visible = drawn;
    if (!drawn) return;
    placeSwimmers(Math.min(dt, 0.1));
    if (!simulate) {
      queued.length = 0;
      return;
    }
    // one step a frame at most: two in a frame would share one frame's drops
    acc = Math.min(acc + dt, 2 / HZ);
    if (acc >= 1 / HZ) {
      acc -= 1 / HZ;
      step();
    }
  }

  /** A drop into the water at (x, z) in the world's frame: `strength` m up (down if less than 0), spread over `radius` m */
  function drop(x, z, radius = 0.4, strength = 0.02) {
    const p = toPool(x, z);
    if (Math.abs(p.x) > hx + radius || Math.abs(p.z) > hz + radius) return false;
    if (queued.length < MAX_DROPS * 2) queued.push([p.x, p.z, radius, strength]);
    return true;
  }

  /** The water's level at (x, z) in the world's frame, or null outside it (its still level: the ripples are on the GPU) */
  function surfaceAt(x, z) {
    const p = toPool(x, z);
    return Math.abs(p.x) <= hx && Math.abs(p.z) <= hz ? site.y + surface : null;
  }

  function state() {
    return {
      pool: pool.id, simulate, grid: simulate ? GRID : null, hz: HZ, steps: stepCount, drops: dropCount, visible: group.visible,
      swimmers: swimmers.map((sw) => ({ lane: sw.lane, x: +sw.x.toFixed(2), z: +sw.z.toFixed(2), dir: sw.dir, speed: +sw.speed.toFixed(2), turning: sw.turn > 0 }))
    };
  }

  /** The height field read back from the GPU, for the scripts: its heights' and slopes' spread, and how many aren't numbers */
  async function probe() {
    if (!simulate) return null;
    const h = new Float32Array(await renderer.getArrayBufferAsync(heights.value));
    const m = new Float32Array(await renderer.getArrayBufferAsync(motion.value));
    const spread = (a, k, n) => {
      let lo = Infinity, hi = -Infinity, bad = 0, sum = 0;
      for (let i = k; i < a.length; i += n) {
        const v = a[i];
        if (!Number.isFinite(v)) { bad++; continue; }
        lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v * v;
      }
      return { lo: +lo.toFixed(5), hi: +hi.toFixed(5), rms: +Math.sqrt(sum / (a.length / n)).toFixed(5), bad };
    };
    return { height: spread(h, 0, 1), velocity: spread(m, 0, 4), slopeX: spread(m, 1, 4), slopeZ: spread(m, 2, 4), curve: spread(m, 3, 4) };
  }

  function dispose() {
    group.removeFromParent();
    for (const m of [bodies, heads, arms]) m.dispose();
    mesh.dispatchEvent({ type: 'dispose' });
    for (const g of [geometry, body, head, arm]) g.dispose();
    for (const m of [material, skin, capMaterial]) m.dispose();
    heights?.value.dispose?.();
    motion?.value.dispose?.();
  }

  return { group, update, drop, surfaceAt, state, probe, dispose };
}

/** Geometries with the same attributes as one */
function mergeParts(parts) {
  const out = new THREE.BufferGeometry();
  const names = ['position', 'normal'];
  for (const name of names) {
    const total = parts.reduce((n, g) => n + g.attributes[name].count, 0);
    const array = new Float32Array(total * 3);
    let offset = 0;
    for (const g of parts) {
      array.set(g.attributes[name].array.subarray(0, g.attributes[name].count * 3), offset);
      offset += g.attributes[name].count * 3;
    }
    out.setAttribute(name, new THREE.BufferAttribute(array, 3));
  }
  const index = [];
  let base = 0;
  for (const g of parts) {
    const idx = g.index ? g.index.array : [...Array(g.attributes.position.count).keys()];
    for (const i of idx) index.push(i + base);
    base += g.attributes.position.count;
  }
  out.setIndex(index);
  for (const g of parts) g.dispose();
  return out;
}

export { createPoolWater };
