import * as THREE from 'three/webgpu';
import { float, texture, uv } from 'three/tsl';
import { paintAtlas } from './art-paint.js';
import { ARTWORKS } from './artworks.js';

// A gallery's art (js/interiors.js fetchInside(), for an inside whose JSON lists `hangs` and `plinths`): the works js/artworks.js puts
// on those walls and plinths, made here, nothing downloaded for the made-up ones.
// - Paintings: one picture (an atlas) for the inside's file, painted in a worker from each work's seed (js/art-paint.js) with each label
//   beside it, and shown when it's done; till then a plain canvas. Each work a quad on its wall, in its frame (gilt, timber, black,
//   white, the canvas's edge, or a scroll's roller and stick), its label to its right at eye height.
// - A real work (`image`) is fetched and drawn on its own quad, with its own label.
// - Sculptures: turned (a figure, a vessel) or lofted (a bronze's bending form), or painted steel's beams, made from the seed on its plinth.
// Everything is added to its room's node, so it's drawn only when its room is (js/interiors.js), and in as few draws as it can be: a room's
// paintings in one, its frames in one or two (gilt is metal), its sculptures in one a material.
// All in the model's frame: x across, z along, y up from its ground floor.

const PX = 120; // px a metre a painting is painted at, on medium and high (art's `detail` scales it)
const ATLAS = 2048; // px: the most an atlas is each way
const LABEL_PX = [160, 64];
const LABEL_M = [0.2, 0.08];
const LABEL_Y = 1.35; // m over the floor
const FRAMES = {
  // width, depth, colour, material
  gilt: [0.1, 0.085, 0xb08a3e, 'metal'], timber: [0.055, 0.05, 0x5c3a1e, 'timber'], black: [0.032, 0.042, 0x161616, 'timber'],
  white: [0.045, 0.045, 0xefede6, 'timber'], none: [0, 0.036, 0xe6e1d4, 'timber'], scroll: [0, 0.012, 0x3a2a1c, 'timber']
};
const SCULPTURE = { bronze: 'metal', marble: 'ceramic', steel: 'paint', vessel: 'ceramic' };

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const linear = (hex) => new THREE.Color(hex).convertSRGBToLinear();

/** Triangles, their colours and (for the atlas's) their picture's coordinates, gathered into one geometry */
class Build {
  constructor(uvs = false) {
    this.pos = [];
    this.col = [];
    this.uv = uvs ? [] : null;
  }
  /** A quad a-b-c-d (in order round it), facing n, coloured c, and its picture's corners in the same order */
  quad(p, n, c, uvs = null) {
    const [a, b, , d] = p;
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const order = cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
    for (const i of order) {
      this.pos.push(...p[i]);
      this.col.push(c.r, c.g, c.b);
      if (this.uv) this.uv.push(...(uvs ? uvs[i] : [0, 0]));
    }
  }
  tri(a, b, c, colour) {
    for (const p of [a, b, c]) {
      this.pos.push(...p);
      this.col.push(colour.r, colour.g, colour.b);
      if (this.uv) this.uv.push(0, 0);
    }
  }
  get empty() {
    return this.pos.length === 0;
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return g;
  }
}

/** A frame of reference on a wall: s along it from its start, t up, d out from it into the room */
function wallFrame(hang) {
  const [ax, az] = hang.a, [bx, bz] = hang.b;
  const L = Math.hypot(bx - ax, bz - az);
  const u = [(bx - ax) / L, (bz - az) / L], n = hang.n;
  // which way along it is to the right, for someone looking at it from the room: its pictures run that way
  const right = u[0] * n[1] - u[1] * n[0] >= 0;
  return {
    L, n: [n[0], 0, n[1]], u: [u[0], 0, u[1]], right,
    at: (s, t, d) => [ax + u[0] * s + n[0] * d, t, az + u[1] * s + n[1] * d]
  };
}

/** A box on a wall, from s0 to s1, t0 to t1 and d0 to d1 out from it: all but its back */
function wallBox(b, f, s0, s1, t0, t1, d0, d1, c, shade = 1) {
  const P = f.at;
  const dim = (k) => c.clone().multiplyScalar(k * shade);
  b.quad([P(s0, t0, d1), P(s1, t0, d1), P(s1, t1, d1), P(s0, t1, d1)], f.n, dim(1));
  b.quad([P(s0, t1, d0), P(s1, t1, d0), P(s1, t1, d1), P(s0, t1, d1)], [0, 1, 0], dim(1.08));
  b.quad([P(s0, t0, d0), P(s1, t0, d0), P(s1, t0, d1), P(s0, t0, d1)], [0, -1, 0], dim(0.7));
  b.quad([P(s0, t0, d0), P(s0, t1, d0), P(s0, t1, d1), P(s0, t0, d1)], f.u.map((v) => -v), dim(0.85));
  b.quad([P(s1, t0, d0), P(s1, t1, d0), P(s1, t1, d1), P(s1, t0, d1)], f.u, dim(0.85));
}

// --- Sculptures --------------------------------------------------------------------------------------------------------------------
/** A surface turned about the vertical: `profile` [[r, y], ...] from the bottom up, `col(y, k)` its colour; `shape(x, y, z)` moves each
 * point (a lean, a flattening) */
function turned(b, profile, segs, col, shape) {
  for (let i = 0; i + 1 < profile.length; i++) {
    const [r0, y0] = profile[i], [r1, y1] = profile[i + 1];
    for (let k = 0; k < segs; k++) {
      const a0 = (k / segs) * Math.PI * 2, a1 = ((k + 1) / segs) * Math.PI * 2;
      const p = [shape(r0 * Math.cos(a0), y0, r0 * Math.sin(a0)), shape(r0 * Math.cos(a1), y0, r0 * Math.sin(a1)),
        shape(r1 * Math.cos(a1), y1, r1 * Math.sin(a1)), shape(r1 * Math.cos(a0), y1, r1 * Math.sin(a0))];
      const am = (a0 + a1) / 2;
      const n = [Math.cos(am) * (y1 - y0), -(r1 - r0), Math.sin(am) * (y1 - y0)];
      if (r0 < 1e-4) b.tri(...(n[1] < 0 ? [p[0], p[2], p[3]] : [p[0], p[3], p[2]]), col((y0 + y1) / 2, k));
      else b.quad(p, n, col((y0 + y1) / 2, k));
    }
  }
}

/** A form lofted along a bending spine: rings of `segs` round each of its points, radius `rad(t)` */
function lofted(b, spine, rad, segs, col) {
  const rings = [];
  for (let i = 0; i < spine.length; i++) {
    const p = spine[i], q = spine[Math.min(i + 1, spine.length - 1)], o = spine[Math.max(i - 1, 0)];
    let t = [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
    const L = Math.hypot(...t) || 1;
    t = t.map((v) => v / L);
    // two directions across it
    let a = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let c = [t[1] * a[2] - t[2] * a[1], t[2] * a[0] - t[0] * a[2], t[0] * a[1] - t[1] * a[0]];
    const Lc = Math.hypot(...c);
    c = c.map((v) => v / Lc);
    a = [c[1] * t[2] - c[2] * t[1], c[2] * t[0] - c[0] * t[2], c[0] * t[1] - c[1] * t[0]];
    const [r1, r2] = rad(i / (spine.length - 1));
    rings.push(Array.from({ length: segs }, (_, k) => {
      const ang = (k / segs) * Math.PI * 2;
      return [p[0] + (a[0] * Math.cos(ang) * r1 + c[0] * Math.sin(ang) * r2), p[1] + (a[1] * Math.cos(ang) * r1 + c[1] * Math.sin(ang) * r2),
        p[2] + (a[2] * Math.cos(ang) * r1 + c[2] * Math.sin(ang) * r2)];
    }));
  }
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let k = 0; k < segs; k++) {
      const p = [rings[i][k], rings[i][(k + 1) % segs], rings[i + 1][(k + 1) % segs], rings[i + 1][k]];
      const m = spine[i];
      const mid = p.reduce((s, v) => [s[0] + v[0] / 4, s[1] + v[1] / 4, s[2] + v[2] / 4], [0, 0, 0]);
      b.quad(p, [mid[0] - m[0], mid[1] - m[1], mid[2] - m[2]], col(i / rings.length, k));
    }
  }
  // its ends shut
  for (const [i, s] of [[0, -1], [rings.length - 1, 1]]) {
    const c = spine[i];
    for (let k = 0; k < segs; k++) {
      const a = rings[i][k], d = rings[i][(k + 1) % segs];
      const away = [(a[0] + d[0]) / 2 - c[0], (a[1] + d[1]) / 2 - c[1], (a[2] + d[2]) / 2 - c[2]];
      const tip = spine[Math.min(Math.max(i + s, 0), spine.length - 1)];
      const out = [c[0] - tip[0], c[1] - tip[1], c[2] - tip[2]];
      const n = [out[0] + away[0] * 0.01, out[1] + away[1] * 0.01, out[2] + away[2] * 0.01];
      const e1 = [a[0] - c[0], a[1] - c[1], a[2] - c[2]], e2 = [d[0] - c[0], d[1] - c[1], d[2] - c[2]];
      const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] >= 0) b.tri(c, a, d, col(i ? 1 : 0, k));
      else b.tri(c, d, a, col(i ? 1 : 0, k));
    }
  }
}

/** A sculpture on its plinth: into `b`, h high, in the plinth's footprint, turned by its seed */
function sculpture(b, work, plinth) {
  const r = rng(work.seed);
  const [px, py, pz] = plinth.at;
  const yaw = r() * Math.PI * 2, cy = Math.cos(yaw), sy = Math.sin(yaw);
  const h = work.h, foot = plinth.size * 0.42;
  const place = (x, y, z) => [px + x * cy + z * sy, py + y, pz - x * sy + z * cy];
  if (work.kind === 'vessel') {
    const glazes = [[0x8fae94, 0x6f9078], [0xece8dc, 0x2b4a8a], [0x3a2a22, 0x7a4a2a], [0x8a2a24, 0x5a1a18], [0xd8cdb0, 0xa88a5a]];
    const [g0, g1] = glazes[Math.floor(r() * glazes.length)].map(linear);
    const R = Math.min(foot, h * (0.28 + r() * 0.22));
    const kind = Math.floor(r() * 4);
    const prof = kind === 0 ? [[0, 0], [0.55, 0], [0.62, 0.05], [0.95, 0.4], [1, 0.55], [0.8, 0.82], [0.45, 0.92], [0.48, 1], [0, 1]] // a jar
      : kind === 1 ? [[0, 0], [0.45, 0], [0.5, 0.05], [0.9, 0.35], [0.75, 0.6], [0.3, 0.8], [0.25, 0.92], [0.4, 1], [0, 0.98]] // a vase
        : kind === 2 ? [[0, 0], [0.4, 0], [0.45, 0.06], [1, 0.75], [1.04, 0.8], [0.95, 0.8], [0, 0.3]] // a bowl
          : [[0, 0], [0.6, 0], [0.65, 0.05], [0.9, 0.3], [0.85, 0.5], [0.3, 0.65], [0.18, 0.85], [0.22, 1], [0, 1]]; // a bottle
    const height = kind === 2 ? Math.min(h, R * 0.9) : h;
    turned(b, prof.map(([pr, py_]) => [pr * R, py_ * height]), 16, (y, k) => (Math.floor((y / height) * 9) % 3 === 1 && kind !== 2 ? g1 : g0)
      .clone().multiplyScalar(0.92 + 0.08 * (k % 2)), (x, y, z) => place(x, y, z));
    return;
  }
  if (work.kind === 'steel') {
    // painted steel: beams and plates, leaning on each other
    const c = linear([0xb3261e, 0x1a1a1a, 0xd9a520, 0x1f4e8c, 0xe8e4da][Math.floor(r() * 5)]);
    const n = 3 + Math.floor(r() * 5);
    for (let i = 0; i < n; i++) {
      const L = h * (0.4 + r() * 0.8), w = 0.05 + r() * 0.25, t = 0.03 + r() * 0.05;
      const a = (r() - 0.5) * 1.6, spin = r() * Math.PI;
      const ox = (r() - 0.5) * foot, oz = (r() - 0.5) * foot;
      const dir = [Math.sin(a) * Math.cos(spin), Math.cos(a), Math.sin(a) * Math.sin(spin)];
      const side = [Math.cos(spin + 1.2), 0, Math.sin(spin + 1.2)];
      const thick = [dir[1] * side[2] - dir[2] * side[1], dir[2] * side[0] - dir[0] * side[2], dir[0] * side[1] - dir[1] * side[0]];
      const P = (l, s, k) => place(ox + dir[0] * l + side[0] * s + thick[0] * k, Math.max(0, dir[1] * l + side[1] * s + thick[1] * k),
        oz + dir[2] * l + side[2] * s + thick[2] * k);
      const box = [[0, -w, -t], [L, -w, -t], [L, w, -t], [0, w, -t], [0, -w, t], [L, -w, t], [L, w, t], [0, w, t]].map(([l, s, k]) => P(l * 0.999, s / 2, k / 2));
      const faces = [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [3, 2, 6, 7], [0, 3, 7, 4], [1, 5, 6, 2]];
      const mid = box.reduce((s, v) => [s[0] + v[0] / 8, s[1] + v[1] / 8, s[2] + v[2] / 8], [0, 0, 0]);
      for (const f of faces) {
        const q = f.map((k) => box[k]);
        const m = q.reduce((s, v) => [s[0] + v[0] / 4, s[1] + v[1] / 4, s[2] + v[2] / 4], [0, 0, 0]);
        b.quad(q, [m[0] - mid[0], m[1] - mid[1], m[2] - mid[2]], c.clone().multiplyScalar(0.85 + 0.15 * r()));
      }
    }
    return;
  }
  const base = work.kind === 'marble' ? linear(0xe4e0d8) : linear(0x5a4a30);
  const col = (t, k) => base.clone().multiplyScalar((work.kind === 'marble' ? 0.9 : 0.75) + 0.12 * Math.sin(t * 7 + k) * 0.5 + (k % 2) * 0.04);
  if (work.kind === 'bronze' && r() < 0.5) {
    // a bending form, thick and thin along its length, as a reclining figure is
    const n = 9, spine = [];
    let x = -foot * 0.8, y = h * 0.15, z = 0, a = 0.3 + r() * 0.5;
    for (let i = 0; i < n; i++) {
      spine.push([x, y, z]);
      a += (r() - 0.5) * 1.2;
      x += (foot * 1.8) / n;
      y = Math.max(h * 0.12, Math.min(h * 0.9, y + Math.sin(a) * h * 0.35));
      z += (r() - 0.5) * foot * 0.3;
    }
    const thick = h * (0.12 + r() * 0.1);
    lofted(b, spine.map((p) => place(...p)), (t) => [thick * (0.6 + 0.6 * Math.sin(t * Math.PI) ** 2), thick * (0.5 + 0.4 * Math.sin(t * 9))], 10, col);
    return;
  }
  // a figure, standing: feet and robe, waist, chest and shoulders, neck and head; leaning, flattened front to back
  const k = 0.85 + r() * 0.3, lean = (r() - 0.5) * 0.25;
  const w = (work.kind === 'marble' ? 0.17 : 0.13) * k;
  const prof = [[0, 0], [w * 1.2, 0], [w * 1.15, 0.04], [w * 0.95, 0.12], [w * 0.8, 0.45], [w * 0.7, 0.52], [w * 0.85, 0.62], [w * 1.05, 0.74],
    [w * 1.0, 0.8], [w * 0.4, 0.83], [w * 0.32, 0.86], [w * 0.48, 0.9], [w * 0.5, 0.95], [w * 0.38, 0.99], [0, 1.0]];
  const flat = 0.55 + r() * 0.15;
  turned(b, prof.map(([pr, py_]) => [pr * h, py_ * h]), 12, (y) => col(y / h, 0), (x, y, z) => place(x + lean * (y / h) ** 2 * h * 0.3, y, z * flat));
}

/**
 * The art for one of a gallery's insides. `data`: its JSON; `scene`: its model, its rooms' nodes in it; `materialFor(name)`: the insides'
 * own materials (frames, sculptures); `glow`: the inside's glow, a uniform; `detail`: 1 on medium and high, less on low. Returns
 * { dispose(), state() }.
 */
function createArt({ site, data, scene, materialFor, glow, detail = 1 }) {
  const works = ARTWORKS[site] ?? [];
  const hangs = new Map((data.hangs ?? []).map((h) => [h.id, h]));
  const plinths = new Map((data.plinths ?? []).map((p) => [p.id, p]));
  const paintings = works.filter((w) => w.wall && hangs.has(w.wall));
  const sculptures = works.filter((w) => w.plinth && plinths.has(w.plinth));
  const rooms = new Map();
  const roomOf = (id) => {
    if (!rooms.has(id)) rooms.set(id, { paint: new Build(true), frames: { metal: new Build(), timber: new Build() }, sculpt: {}, real: [] });
    return rooms.get(id);
  };
  const floorOf = (hang) => hang.y0 - 0.6;

  // The atlas: each made-up painting and each label a rectangle in it, packed in shelves, smaller all round till they fit
  const items = [];
  for (const w of paintings) {
    if (!w.image) items.push({ work: w, kind: w.kind, seed: w.seed, wm: w.w, hm: w.h });
    if (w.title && w.y - w.h / 2 < floorOf(hangs.get(w.wall)) + 2.3) items.push({ work: w, kind: 'label', title: w.title, artist: w.artist, year: w.year, label: true });
  }
  let scale = PX * detail, packed = null;
  for (let tries = 0; tries < 12 && !packed; tries++, scale *= 0.85) {
    const sized = items.map((it) => (it.label ? { ...it, w: Math.round(LABEL_PX[0] * Math.min(1, detail)), h: Math.round(LABEL_PX[1] * Math.min(1, detail)) }
      : { ...it, w: Math.max(8, Math.min(420, Math.round(it.wm * scale))), h: Math.max(8, Math.min(420, Math.round(it.hm * scale))) }));
    const order = sized.map((s, i) => i).sort((a, b) => sized[b].h - sized[a].h);
    let x = 0, y = 0, row = 0, ok = true;
    for (const i of order) {
      const s = sized[i];
      if (x + s.w > ATLAS) {
        x = 0;
        y += row + 2;
        row = 0;
      }
      if (y + s.h > ATLAS) {
        ok = false;
        break;
      }
      s.x = x;
      s.y = y;
      x += s.w + 2;
      row = Math.max(row, s.h);
    }
    if (ok) packed = { items: sized, height: Math.min(ATLAS, 2 ** Math.ceil(Math.log2(y + row + 1))) };
  }
  const W = ATLAS, H = packed?.height ?? 1;
  const rectOf = new Map(); // a work's (and its label's) place in the atlas
  for (const s of packed?.items ?? []) rectOf.set(s.label ? `${s.work.id}:label` : s.work.id, s);
  const uvOf = (rect, right) => {
    const u0 = rect.x / W, u1 = (rect.x + rect.w) / W, v0 = rect.y / H, v1 = (rect.y + rect.h) / H;
    // round the quad from its bottom left (seen from the room): the picture's top row is v0 (an atlas not flipped on its way up)
    const [l, r] = right ? [u0, u1] : [u1, u0];
    return [[l, v1], [r, v1], [r, v0], [l, v0]];
  };

  // Each painting on its wall: the picture, its frame, its label
  for (const w of paintings) {
    const hang = hangs.get(w.wall);
    const f = wallFrame(hang);
    const room = roomOf(hang.room);
    const [fw, fd, fc, fmat] = FRAMES[w.frame] ?? FRAMES.black;
    const s0 = w.at - w.w / 2, s1 = w.at + w.w / 2, t0 = w.y - w.h / 2, t1 = w.y + w.h / 2;
    const d = Math.max(0.006, fd - 0.012);
    const surface = [f.at(s0, t0, d), f.at(s1, t0, d), f.at(s1, t1, d), f.at(s0, t1, d)];
    if (w.image) room.real.push({ work: w, corners: surface, n: f.n, right: f.right });
    else {
      const rect = rectOf.get(w.id);
      room.paint.quad(surface, f.n, new THREE.Color(1, 1, 1), rect ? uvOf(rect, f.right) : null);
    }
    const c = linear(fc);
    const into = room.frames[fmat];
    if (w.frame === 'none') {
      // the canvas's edge: its front a little behind the picture, or the two would be one plane and flicker
      wallBox(into, f, s0, s1, t0, t1, 0, d - 0.004, c, 0.9);
    } else if (w.frame === 'scroll') {
      // the roller under it and the stick over it, a little wider
      wallBox(into, f, s0 - 0.05, s1 + 0.05, t0 - 0.03, t0, 0.0, 0.03, c);
      wallBox(into, f, s0 - 0.01, s1 + 0.01, t1, t1 + 0.02, 0.0, 0.02, c);
    } else {
      wallBox(into, f, s0 - fw, s1 + fw, t1, t1 + fw, 0, fd, c);
      wallBox(into, f, s0 - fw, s1 + fw, t0 - fw, t0, 0, fd, c);
      wallBox(into, f, s0 - fw, s0, t0, t1, 0, fd, c);
      wallBox(into, f, s1, s1 + fw, t0, t1, 0, fd, c);
      if (w.frame === 'gilt') {
        // a dark slip inside the gilt
        const k = fw * 0.25;
        wallBox(into, f, s0 - k, s1 + k, t1, t1 + k, d, fd - 0.01, c, 0.55);
        wallBox(into, f, s0 - k, s1 + k, t0 - k, t0, d, fd - 0.01, c, 0.55);
      }
    }
    // the label, to its right at eye height (to its left at the wall's end); a painting high on a salon wall has none
    const lr = rectOf.get(`${w.id}:label`);
    if (lr) {
      const floor = floorOf(hang);
      let ls = s1 + fw + 0.18;
      if (ls + LABEL_M[0] > f.L) ls = s0 - fw - 0.18 - LABEL_M[0];
      const ly = Math.min(floor + LABEL_Y, t0 - fw - 0.05 - LABEL_M[1] / 2) > floor + 0.9 ? Math.min(floor + LABEL_Y, w.y) : floor + LABEL_Y;
      const q = [f.at(ls, ly - LABEL_M[1] / 2, 0.004), f.at(ls + LABEL_M[0], ly - LABEL_M[1] / 2, 0.004), f.at(ls + LABEL_M[0], ly + LABEL_M[1] / 2, 0.004),
        f.at(ls, ly + LABEL_M[1] / 2, 0.004)];
      room.paint.quad(q, f.n, new THREE.Color(1, 1, 1), uvOf(lr, f.right));
    }
  }
  for (const w of sculptures) {
    const p = plinths.get(w.plinth);
    const room = roomOf(p.room);
    const mat = SCULPTURE[w.kind] ?? 'metal';
    room.sculpt[mat] ??= new Build();
    sculpture(room.sculpt[mat], w, p);
  }

  // The meshes, in their rooms' nodes
  const blank = new THREE.DataTexture(new Uint8Array([214, 206, 190, 255]), 1, 1);
  blank.colorSpace = THREE.SRGBColorSpace;
  blank.needsUpdate = true;
  const picture = texture(blank, uv());
  const paintMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.72, metalness: 0, flatShading: true });
  paintMaterial.colorNode = picture.rgb;
  // lit as a gallery lights its walls: the room's own glow, and more
  paintMaterial.emissiveNode = picture.rgb.mul(glow.add(float(0.12)));
  paintMaterial.name = 'art:paintings';
  const meshes = [], geometries = [], realTextures = [], realMaterials = [];
  const add = (roomId, geometry, material, name) => {
    const node = scene.getObjectByName(`room_${roomId}`) ?? scene;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.userData.lifted = true;
    node.add(mesh);
    meshes.push(mesh);
    geometries.push(geometry);
  };
  for (const [id, room] of rooms) {
    if (!room.paint.empty) add(id, room.paint.geometry(), paintMaterial, `Art_paintings_${id}`);
    for (const [mat, b] of Object.entries(room.frames)) if (!b.empty) add(id, b.geometry(), materialFor(mat), `Art_frames_${mat}_${id}`);
    for (const [mat, b] of Object.entries(room.sculpt)) if (!b.empty) add(id, b.geometry(), materialFor(mat), `Art_sculptures_${mat}_${id}`);
    for (const real of room.real) {
      // a real work: its own picture, fetched
      const b = new Build(true);
      b.quad(real.corners, real.n, new THREE.Color(1, 1, 1), [[0, 1], [1, 1], [1, 0], [0, 0]].map(([u, v]) => (real.right ? [u, v] : [1 - u, v])));
      const tex = new THREE.TextureLoader().load(new URL(real.work.image, document.baseURI).href);
      tex.colorSpace = THREE.SRGBColorSpace;
      const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.72, metalness: 0, flatShading: true });
      const node = texture(tex, uv());
      m.colorNode = node.rgb;
      m.emissiveNode = node.rgb.mul(glow.add(float(0.12)));
      realTextures.push(tex);
      realMaterials.push(m);
      add(id, b.geometry(), m, `Art_real_${real.work.id}`);
    }
  }

  // The pictures, painted in a worker (or here, where a worker can't paint), then shown
  let atlas = null, painted = false, worker = null, gone = false;
  const show = (image) => {
    if (gone) {
      image.close?.();
      return;
    }
    atlas = typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap ? new THREE.Texture(image) : new THREE.CanvasTexture(image);
    atlas.flipY = false;
    atlas.colorSpace = THREE.SRGBColorSpace;
    atlas.anisotropy = 4;
    atlas.generateMipmaps = true;
    atlas.minFilter = THREE.LinearMipmapLinearFilter;
    atlas.needsUpdate = true;
    picture.value = atlas;
    painted = true;
  };
  const spec = { width: W, height: H, items: (packed?.items ?? []).map(({ work, wm, hm, label, ...rest }) => rest) };
  const paintHere = () => setTimeout(() => {
    if (gone) return;
    try {
      show(paintAtlas(spec));
    } catch (e) {
      console.warn('[art] painting', e);
    }
  }, 0);
  if (packed && spec.items.length) {
    try {
      if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') throw new Error('no worker to paint in');
      const source = `${paintAtlas.toString()}
self.onmessage = ({ data }) => {
  const canvas = paintAtlas(data);
  const bitmap = canvas.transferToImageBitmap();
  self.postMessage(bitmap, [bitmap]);
};`;
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      worker = new Worker(url);
      const done = () => {
        worker?.terminate();
        worker = null;
        URL.revokeObjectURL(url);
      };
      worker.onmessage = ({ data: bitmap }) => {
        done();
        show(bitmap);
      };
      worker.onerror = (e) => {
        e.preventDefault?.();
        done();
        paintHere();
      };
      worker.postMessage(spec);
    } catch {
      paintHere();
    }
  }

  return {
    dispose() {
      gone = true;
      worker?.terminate();
      for (const m of meshes) m.removeFromParent();
      for (const g of geometries) g.dispose();
      paintMaterial.dispose();
      blank.dispose();
      atlas?.dispose();
      for (const t of realTextures) t.dispose();
      for (const m of realMaterials) m.dispose();
    },
    state() {
      let drawn = 0;
      for (const m of meshes) {
        let shown = true;
        for (let o = m; o; o = o.parent) shown &&= o.visible;
        if (shown && m.name.startsWith('Art_paintings_')) drawn++;
      }
      return { paintings: paintings.length, sculptures: sculptures.length, painted, atlas: [W, H], scale: +(scale / 0.85).toFixed(1), rooms: rooms.size,
        meshes: meshes.length, paintingRoomsDrawn: drawn };
    }
  };
}

export { createArt };
