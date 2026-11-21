import * as THREE from 'three/webgpu';
import { attribute, clamp, color, float, max, mix, smoothstep, texture, uv } from 'three/tsl';

// November's carpets of fallen jacaranda flowers: under each jacaranda near you, a disc about as wide as its crown, dense in the middle and
// thinning to scattered flowers at its edge, lying on whatever is under it, road, footpath and lawn alike, as real ones do.
// - Each carpet is a small grid laid on what's drawn (js/drawn-ground.js drawnTop(), or the road where there's nothing), LIFT over it.
//   Where a cell crosses a step (a kerb), it's cut in two along the step, each piece at its own level, so the carpet never ramps from the
//   gutter up onto the footpath.
// - All of them near you are one mesh, one draw, refilled as you move, as the lots' verges are (js/lot-details.js).
// - The flowers are a texture made in code once: each texel holds a flower's rank, tone and shade, premultiplied by its coverage, so its
//   mipmaps stay right. The carpet's thinning keeps a flower where its rank clears the carpet's density there.

const CELLS = 7; // the grid's cells a side
const LIFT = 0.02; // m over what's drawn
const LOOK = 0.03; // m: an edge whose ends differ by this much is searched for a step
const STEP = 0.025; // m: a jump this big within 2 cm along an edge is a step
const SPREAD = 1.15; // the carpet reaches this far past the crown's edge, as a share of the crown's reach
const PATTERN = 1.5; // m: the texture's repeat
const DEPTH = 2; // how many times a cell with a step that doesn't simply cross it is split in four, before it's left out

// mulberry32: the same flowers and carpets on every load
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A whole number from a place, for a carpet's own pattern */
const seedAt = (x, z) => (Math.imul(Math.round(x * 10) | 0, 73856093) ^ Math.imul(Math.round(z * 10) | 0, 19349663)) >>> 0;

/**
 * Where along the edge from a to b the height steps, if it does: bisected to 2 cm on a metre or so. { t, ha, hb } (the heights on a's side
 * and b's), or null where it's a slope, not a step.
 */
function findStep(ax, az, ha, bx, bz, hb, heightAt) {
  let lo = 0, hi = 1, hlo = ha, hhi = hb;
  const steps = Math.max(3, Math.ceil(Math.log2(Math.hypot(bx - ax, bz - az) / 0.02)));
  for (let k = 0; k < steps; k++) {
    const t = (lo + hi) / 2;
    const hm = heightAt(ax + (bx - ax) * t, az + (bz - az) * t);
    if (Math.abs(hm - hlo) < Math.abs(hhi - hm)) {
      lo = t;
      hlo = hm;
    } else {
      hi = t;
      hhi = hm;
    }
  }
  return Math.abs(hhi - hlo) < STEP ? null : { t: (lo + hi) / 2, ha: hlo, hb: hhi };
}

/**
 * A carpet's triangles under a tree at (x, z) whose crown reaches `crown` m from its trunk. `heightAt(x, z)`: the top of what's drawn there.
 * Returns { position (x and z from the trunk, y in the world), normal, uv, petals (how dense the flowers are, 0-1), index }, or null if
 * nothing of it is left. A row of cells a step: on a phone a whole carpet can take 10 ms.
 */
function* carpetGeometrySteps({ x, z, crown }, heightAt) {
  const reach = crown * SPREAD;
  const size = (2 * reach) / CELLS;
  const rnd = random(seedAt(x, z));
  // Its own pattern: the texture turned and moved, and an edge that wanders in and out
  const turn = rnd() * Math.PI * 2, cs = Math.cos(turn), sn = Math.sin(turn), u0 = rnd(), v0 = rnd();
  const w1 = rnd() * 6.28, w2 = rnd() * 6.28, w3 = rnd() * 6.28, lean = rnd() * 6.28;
  const P = [], I = [];
  const add = (px, py, pz) => {
    P.push(px - x, py + LIFT, pz - z);
    return P.length / 3 - 1;
  };
  // The grid's corners, made when a cell first uses one
  const n = CELLS + 1;
  const H = new Float64Array(n * n);
  const corner = new Int32Array(n * n).fill(-1);
  const x0 = x - reach, z0 = z - reach;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) H[j * n + i] = heightAt(x0 + i * size, z0 + j * size);
    if (j % 3 === 2) yield;
  }
  const gridVertex = (i, j) => {
    const k = j * n + i;
    if (corner[k] < 0) corner[k] = add(x0 + i * size, H[k], z0 + j * size);
    return corner[k];
  };
  // A polygon, its corners in order round it (as the cell's are, x then z): a fan, wound to face up
  const fan = (vs) => {
    for (let k = 1; k + 1 < vs.length; k++) I.push(vs[0], vs[k + 1], vs[k]);
  };

  // A cell from (ax, az), `s` a side, its corners' heights h (round it: (ax, az), (ax + s, az), (ax + s, az + s), (ax, az + s)), and the
  // grid's own vertices for its corners where it is a whole cell of the grid
  function cell(ax, az, s, h, depth, grid) {
    const cx = [ax, ax + s, ax + s, ax], cz = [az, az, az + s, az + s];
    const steps = [];
    for (let k = 0; k < 4; k++) {
      const m = (k + 1) & 3;
      steps.push(Math.abs(h[k] - h[m]) > LOOK ? findStep(cx[k], cz[k], h[k], cx[m], cz[m], h[m], heightAt) : null);
    }
    const crossed = steps.filter(Boolean).length;
    const own = (k) => (grid ? grid[k] : add(cx[k], h[k], cz[k]));
    if (crossed === 0) {
      fan([0, 1, 2, 3].map(own));
      return;
    }
    if (crossed === 2) {
      // One step across it: a piece either side, each at its own level, meeting along the step
      const pieces = [[], []];
      let side = 0;
      for (let k = 0; k < 4; k++) {
        pieces[side].push(own(k));
        const st = steps[k];
        if (!st) continue;
        const m = (k + 1) & 3;
        const px = cx[k] + (cx[m] - cx[k]) * st.t, pz = cz[k] + (cz[m] - cz[k]) * st.t;
        pieces[side].push(add(px, st.ha, pz));
        side ^= 1;
        pieces[side].push(add(px, st.hb, pz));
      }
      for (const piece of pieces) if (piece.length >= 3) fan(piece);
      return;
    }
    // A step that ends in it, a corner of a kerb, or two steps: in four, and again, then left out
    if (depth >= DEPTH) return;
    const half = s / 2;
    const mid = (px, pz) => heightAt(px, pz);
    const e = [mid(ax + half, az), mid(ax + s, az + half), mid(ax + half, az + s), mid(ax, az + half)];
    const c = mid(ax + half, az + half);
    cell(ax, az, half, [h[0], e[0], c, e[3]], depth + 1, null);
    cell(ax + half, az, half, [e[0], h[1], e[1], c], depth + 1, null);
    cell(ax + half, az + half, half, [c, e[1], h[2], e[2]], depth + 1, null);
    cell(ax, az + half, half, [e[3], c, e[2], h[3]], depth + 1, null);
  }

  for (let j = 0; j < CELLS; j++) {
    yield;
    for (let i = 0; i < CELLS; i++) {
      const ax = x0 + i * size, az = z0 + j * size;
      // Cells wholly past the disc's furthest reach are left out
      const dx = Math.max(ax - x, 0, x - ax - size), dz = Math.max(az - z, 0, z - az - size);
      if (Math.hypot(dx, dz) > reach) continue;
      const k = [j * n + i, j * n + i + 1, (j + 1) * n + i + 1, (j + 1) * n + i];
      cell(ax, az, size, k.map((q) => H[q]), 0, [gridVertex(i, j), gridVertex(i + 1, j), gridVertex(i + 1, j + 1), gridVertex(i, j + 1)]);
    }
  }
  if (!I.length) return null;

  // Normals from the triangles round each vertex; the texture's coordinates and the flowers' density from where each is
  const count = P.length / 3;
  const position = new Float32Array(P);
  const normal = new Float32Array(count * 3);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = position[b] - position[a], uy = position[b + 1] - position[a + 1], uz = position[b + 2] - position[a + 2];
    const vx = position[c] - position[a], vy = position[c + 1] - position[a + 1], vz = position[c + 2] - position[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      normal[v] += nx;
      normal[v + 1] += ny;
      normal[v + 2] += nz;
    }
  }
  const uvs = new Float32Array(count * 2);
  const petals = new Float32Array(count);
  for (let v = 0; v < count; v++) {
    const px = position[v * 3], pz = position[v * 3 + 2];
    const l = Math.hypot(normal[v * 3], normal[v * 3 + 1], normal[v * 3 + 2]) || 1;
    for (let q = 0; q < 3; q++) normal[v * 3 + q] /= l;
    uvs[v * 2] = (px * cs - pz * sn) / PATTERN + u0;
    uvs[v * 2 + 1] = (px * sn + pz * cs) / PATTERN + v0;
    // Thick under the crown, thinning past its edge; the edge wanders, and the carpet leans a little the way the wind took it
    const angle = Math.atan2(pz, px);
    const edge = crown * (1 + 0.13 * Math.sin(angle * 3 + w1) + 0.08 * Math.sin(angle * 5 + w2) + 0.05 * Math.sin(angle * 2 + w3));
    const r = Math.hypot(px - Math.cos(lean) * crown * 0.12, pz - Math.sin(lean) * crown * 0.12) / edge;
    petals[v] = 1 - smoothstepJs(0.5, SPREAD, r);
  }
  return { position, normal, uv: uvs, petals, index: Uint32Array.from(I), x, z };
}

function carpetGeometry(tree, heightAt) {
  const steps = carpetGeometrySteps(tree, heightAt);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

function smoothstepJs(e0, e1, v) {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * The flowers' texture, `size` texels a side over PATTERN m, repeating: RGBA, each texel (rank, tone, shade) x coverage and the coverage.
 * Made a few hundred flowers a step. A fallen jacaranda flower is a trumpet about 4.5 cm long, narrow at its foot and flaring to its mouth.
 */
function* flowerTextureSteps(size = 512, seed = 7) {
  const data = new Float32Array(size * size * 4);
  const rnd = random(seed);
  const perM = size / PATTERN;
  // About four in five of the ground covered where every flower is kept
  const flowers = Math.round((1.7 * PATTERN * PATTERN) / (0.045 * 0.017 * 0.72));
  for (let f = 0; f < flowers; f++) {
    if (f % 120 === 119) yield;
    const len = (0.038 + rnd() * 0.016) * perM, wide = (0.014 + rnd() * 0.007) * perM;
    const angle = rnd() * Math.PI * 2, ca = Math.cos(angle), sa = Math.sin(angle);
    const cx = rnd() * size, cy = rnd() * size;
    const rank = rnd();
    // Most fresh violet to lavender; one in eight older, faded towards mauve and brown
    const tone = rnd() < 0.125 ? 0.88 + rnd() * 0.12 : rnd() * 0.8;
    const shade = 0.35 + rnd() * 0.65;
    const r = Math.ceil(len / 2 + 2);
    for (let py = Math.floor(cy - r); py <= Math.ceil(cy + r); py++) {
      for (let px = Math.floor(cx - r); px <= Math.ceil(cx + r); px++) {
        const dx = px + 0.5 - cx, dy = py + 0.5 - cy;
        // Along the flower from its foot (0) to its mouth (1), and across it
        const u = (dx * ca + dy * sa) / len + 0.5, v = Math.abs(-dx * sa + dy * ca);
        if (u < -0.05 || u > 1.05) continue;
        const uu = Math.min(1, Math.max(0, u));
        let half = (wide / 2) * (0.32 + 0.68 * uu ** 0.8);
        if (uu > 0.86) half *= Math.sqrt(Math.max(0, 1 - ((uu - 0.86) / 0.14) ** 2));
        // Soft by about a texel at its edges and ends
        const across = half - v;
        const ends = Math.min(u * len, (1 - u) * len + 0.5);
        const a = Math.min(1, Math.max(0, 0.5 + Math.min(across, ends)));
        if (a <= 0) continue;
        // Lighter towards the mouth, a darker line down its throat and edges
        const s = shade * (0.78 + 0.22 * uu) * (1 - 0.25 * Math.max(0, 1 - v / Math.max(0.6, half * 0.35)) * (uu < 0.7 ? 1 : 0))
          * (0.85 + 0.15 * Math.min(1, across / 1.5));
        const k = (((py % size) + size) % size * size + (((px % size) + size) % size)) * 4;
        // Over what's there, premultiplied
        data[k] = rank * a + data[k] * (1 - a);
        data[k + 1] = tone * a + data[k + 1] * (1 - a);
        data[k + 2] = Math.min(1, s) * a + data[k + 2] * (1 - a);
        data[k + 3] = a + data[k + 3] * (1 - a);
      }
    }
  }
  yield;
  // As bytes, a quarter of a million at a step: all at once it's 40 ms on a phone
  const bytes = new Uint8Array(size * size * 4);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.round(data[i] * 255);
    if ((i & 0x3ffff) === 0x3ffff) yield;
  }
  return bytes;
}

/** The texture from flowerTextureSteps()'s bytes, repeating, mipmapped */
function flowerTexture(bytes, size = 512) {
  const tex = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace; // numbers, not colours
  tex.needsUpdate = true;
  return tex;
}

// The flowers' colours, as the trees' crowns are drawn (js/trees.js): violet to lavender, and the older ones mauve going brown
const VIOLET = 0x6342aa, LAVENDER = 0x8566c8, FADED = 0x76546f;

/** A flower's colour from its tone (0-1) and shade */
const flowerColour = (tone, shade) => mix(mix(color(VIOLET), color(LAVENDER), clamp(tone.mul(1.25), 0.0, 1.0)), color(FADED), smoothstep(0.84, 0.9, tone))
  .mul(shade.mul(0.4).add(0.55));

/**
 * The carpets' material: the flowers from the texture, a flower kept where its rank clears the carpet's density there (`petals`, from its
 * vertices), alpha-tested (to coverage on the MSAA levels), over the ground as the garden's paths are
 */
function createCarpetMaterial(map) {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: 0.85, alphaToCoverage: true });
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  mat.polygonOffsetUnits = -2;
  const texel = texture(map, uv());
  const cover = texel.a;
  const inverse = float(1.0).div(max(cover, 0.004));
  const rank = texel.r.mul(inverse), tone = texel.g.mul(inverse), shade = texel.b.mul(inverse);
  const thin = float(1.0).sub(attribute('petals', 'float'));
  mat.colorNode = flowerColour(tone, shade);
  mat.opacityNode = cover.mul(smoothstep(thin.sub(0.05), thin.add(0.05), rank));
  mat.alphaTest = 0.5;
  return mat;
}

// How many carpets each level draws, nearest first, and the room for their vertices and triangles
const MOST = { low: 60, medium: 120, high: 200 };
const VERTS_EACH = 110, INDICES_EACH = 360;
const REFILL = 16; // m moved before what's drawn is chosen again
const AGAIN = 2000; // ms before the jacarandas near you are looked for again, if you haven't moved

/**
 * The carpets near you. `level`, `reach()`: the graphics level and how far they're drawn (houseDetail); `trees(x, z, r)`: the jacarandas
 * within r ({ x, z, crown }); `heightAt(x, z)`: the top of what's drawn; `prepare(x, z, r)`: makes one surface's triangles within r of
 * (x, z) for heightAt(), true if it did one (js/drawn-ground.js buildNear()); `squares()`: the boxes the houses' lots have laid their
 * verges and driveways in, each { key, x0, z0, x1, z1 } (a carpet there is laid again when one comes or goes); `origin`: the world's origin.
 */
function createCarpets({ level = 'high', reach = () => 260, trees, heightAt, prepare = () => false, squares = () => [], origin }) {
  const most = MOST[level] ?? MOST.high;
  const capacity = { verts: most * VERTS_EACH, indices: most * INDICES_EACH };
  const geometry = new THREE.BufferGeometry();
  // Static usage: a refill uploads what it wrote (js/lot-details.js vergeMesh() says why)
  const attrs = {
    position: new THREE.BufferAttribute(new Float32Array(capacity.verts * 3), 3),
    normal: new THREE.BufferAttribute(new Float32Array(capacity.verts * 3), 3),
    uv: new THREE.BufferAttribute(new Float32Array(capacity.verts * 2), 2),
    petals: new THREE.BufferAttribute(new Float32Array(capacity.verts), 1)
  };
  for (const [name, attr] of Object.entries(attrs)) geometry.setAttribute(name, attr);
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(capacity.indices), 1));
  geometry.setDrawRange(0, 0);
  const mesh = new THREE.Mesh(geometry, null);
  mesh.name = 'JacarandaCarpets';
  mesh.frustumCulled = false; // what's in it is chosen near you
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.userData.lifted = true;

  const made = new Map(); // a tree's key -> its carpet's triangles (none, where nothing of it was left)
  const stale = new Set(); // keys to lay again: a lot's layer came or went under them
  const keyOf = (t) => `${Math.round(t.x * 10)},${Math.round(t.z * 10)}`;
  let wanted = [], wantedAt = null, wantedWhen = -Infinity, filledAt = null, filledFrom = null, changed = true;
  let seenSquares = new Map();

  // Lots' squares come and go as you move: the carpets in one are laid again on what it adds or takes away
  function lotsChanged() {
    const now = new Map(squares().map((s) => [s.key, s]));
    const moved = [];
    for (const [key, s] of now) if (!seenSquares.has(key)) moved.push(s);
    for (const [key, s] of seenSquares) if (!now.has(key)) moved.push(s);
    seenSquares = now;
    if (!moved.length) return;
    for (const [key, carpet] of made) {
      if (moved.some((s) => carpet.x >= s.x0 - 15 && carpet.x <= s.x1 + 15 && carpet.z >= s.z0 - 15 && carpet.z <= s.z1 + 15)) stale.add(key);
    }
  }

  /** One step of work near (x, z): a carpet laid, or what's drawn chosen again. Whether it did anything. */
  function* work(x, z) {
    const r = reach();
    // The jacarandas near you, again as you move, and every few seconds where you stand: the tree field is made again round you after a
    // jump, and the verges' trees come and go
    const now = performance.now();
    if (!wantedAt || Math.hypot(x - wantedAt.x, z - wantedAt.z) > REFILL || now - wantedWhen > AGAIN) {
      const near = trees(x, z, r) ?? [];
      const next = near.map((t) => [Math.hypot(t.x - x, t.z - z), t]).sort((a, b) => a[0] - b[0]).slice(0, most).map(([, t]) => t);
      if (next.map(keyOf).join() !== wanted.map(keyOf).join()) changed = true;
      wanted = next;
      wantedAt = { x, z };
      wantedWhen = now;
      // Forget those well out of reach
      for (const [key, carpet] of made) if (Math.hypot(carpet.x - x, carpet.z - z) > r + 150) made.delete(key);
    }
    lotsChanged();
    for (const t of wanted) {
      const key = keyOf(t);
      if (made.has(key) && !stale.has(key)) continue;
      // The ground's triangles under it first, a surface a step
      if (prepare(t.x, t.z, t.crown * SPREAD + 1)) return true;
      made.set(key, (yield* carpetGeometrySteps(t, heightAt)) ?? { x: t.x, z: t.z, index: [] });
      stale.delete(key);
      changed = true;
      return true;
    }
    // Written again when the origin they're written from has moved, as the lots are (js/lot-details.js)
    const moved = !filledFrom || filledFrom.x !== origin.x || filledFrom.z !== origin.z;
    if (changed || moved || !filledAt || Math.hypot(x - filledAt.x, z - filledAt.z) > REFILL) {
      fill(x, z);
      return true;
    }
    return false;
  }

  const upload = (attr, n) => {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, Math.max(1, n) * attr.itemSize);
    attr.needsUpdate = true;
  };
  let drawn = 0, drawnTriangles = 0;
  function fill(x, z) {
    filledAt = { x, z };
    filledFrom = { x: origin.x, z: origin.z };
    changed = false;
    let v = 0, ix = 0, count = 0;
    const pos = attrs.position.array, nor = attrs.normal.array, uvs = attrs.uv.array, pet = attrs.petals.array;
    const idx = geometry.index.array;
    for (const t of wanted) {
      const c = made.get(keyOf(t));
      if (!c?.index.length) continue;
      const nv = c.position.length / 3;
      if (v + nv > capacity.verts || ix + c.index.length > capacity.indices) break;
      const ox = c.x - origin.x, oz = c.z - origin.z;
      for (let i = 0; i < nv; i++) {
        pos[(v + i) * 3] = c.position[i * 3] + ox;
        pos[(v + i) * 3 + 1] = c.position[i * 3 + 1];
        pos[(v + i) * 3 + 2] = c.position[i * 3 + 2] + oz;
      }
      nor.set(c.normal, v * 3);
      uvs.set(c.uv, v * 2);
      pet.set(c.petals, v);
      for (let i = 0; i < c.index.length; i++) idx[ix + i] = c.index[i] + v;
      v += nv;
      ix += c.index.length;
      count++;
    }
    for (const attr of Object.values(attrs)) upload(attr, v);
    upload(geometry.index, ix);
    geometry.setDrawRange(0, ix);
    mesh.visible = ix > 0;
    drawn = count;
    drawnTriangles = ix / 3;
  }

  return {
    mesh,
    work,
    /** What's drawn chosen again at the next step: after the mesh was used to compile its shaders */
    refill: () => { changed = true; },
    setMaterial: (material) => { mesh.material = material; },
    state: () => ({ wanted: wanted.length, made: [...made.values()].filter((c) => c.index.length).length, stale: stale.size,
      pending: wanted.filter((t) => !made.has(keyOf(t)) || stale.has(keyOf(t))).length, drawn, triangles: drawnTriangles,
      at: filledAt && { x: Math.round(filledAt.x), z: Math.round(filledAt.z) } }),
    carpets: () => wanted.filter((t) => made.get(keyOf(t))?.index.length),
    clear() {
      made.clear();
      wanted = [];
      geometry.setDrawRange(0, 0);
      mesh.visible = false;
    }
  };
}

export { CELLS, LIFT, PATTERN, SPREAD, STEP, carpetGeometry, carpetGeometrySteps, createCarpetMaterial, createCarpets, findStep, flowerColour, flowerTexture, flowerTextureSteps, random };
