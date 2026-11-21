import * as THREE from 'three/webgpu';
import { texture, uniform, uv, vec4 } from 'three/tsl';

// The sun's light through a building's stained glass, drawn on its floor and pews rather than cast: no light is added to the scene.
// - Its model's inside JSON has each window's glass as a little picture (`windows`: where its bottom corner is, along and out of its
//   wall, how wide and high, and its rows of pixels, each a colour of `palette` or '.' where there's stone) and the surfaces its light
//   can fall on (`lit`: level convex pieces, the floors and the pews' seats).
// - When the time of day moves the sun, each window facing it is thrown along the sun's direction onto each surface, cut to it: a few
//   quads a window, textured with its picture, in its glass's colours, faint and added to what's lit there.
// - At night, and through the evening, there's none: the windows glow from inside instead, seen from outside (js/interiors.js).

const PAD = 1; // px of clear round each picture in the atlas, so its edge fades rather than bleeding into the next
const LOW_SUN = 0.05; // the sun's height (its direction's y) under which nothing comes through
const FACING = 0.03; // how square to the sun a window has to be, at least
const LIFT = 0.012; // m over its surface that a patch is drawn
const STRENGTH = 2.2; // times the sun's colour, at its highest: the floor it falls on is lit by the day already

/** Where each window's picture goes in one atlas: { width, height, rects: [{ x, y, w, h }] } in pixels, shelves packed */
function layout(data) {
  const items = data.windows.map((w, i) => ({ i, w: w.img[0].length + 2 * PAD, h: w.img.length + 2 * PAD }));
  const width = Math.min(1024, Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(...items.map((t) => t.w), Math.sqrt(items.reduce((s, t) => s + t.w * t.h, 0)) * 1.3)))));
  const rects = [];
  let x = 0, y = 0, shelf = 0;
  for (const t of [...items].sort((a, b) => b.h - a.h)) {
    if (x + t.w > width) {
      x = 0;
      y += shelf;
      shelf = 0;
    }
    rects[t.i] = { x: x + PAD, y: y + PAD, w: t.w - 2 * PAD, h: t.h - 2 * PAD };
    x += t.w;
    shelf = Math.max(shelf, t.h);
  }
  return { width, height: 2 ** Math.ceil(Math.log2(Math.max(1, y + shelf))), rects };
}

/** The sun's direction (towards it) in a site's frame, from the world's */
function sunIn(yaw, sun) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return { x: sun.x * c - sun.z * s, y: sun.y, z: sun.x * s + sun.z * c };
}

/** A convex polygon of { x, z, u, v } cut to another (anticlockwise, [[x, z]]), its texture coordinates carried along */
function cut(poly, clipper) {
  let out = poly;
  for (let i = 0; i < clipper.length && out.length; i++) {
    const [ax, az] = clipper[i], [bx, bz] = clipper[(i + 1) % clipper.length];
    const side = (p) => (bx - ax) * (p.z - az) - (bz - az) * (p.x - ax);
    const inp = out;
    out = [];
    for (let k = 0; k < inp.length; k++) {
      const p = inp[k], q = inp[(k + 1) % inp.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t, u: p.u + (q.u - p.u) * t, v: p.v + (q.v - p.v) * t });
      }
    }
  }
  return out;
}

/**
 * Each sunlit window thrown along the sun onto the surfaces its light falls on, in the site's frame: { positions, uvs, windows } (two
 * triangles' worth of corners each quad, flat arrays), `sun` its direction towards the sun in the site's frame, `atlas` from layout().
 */
function throwLight(data, sun, atlas) {
  const positions = [], uvs = [];
  let windows = 0;
  if (sun.y < LOW_SUN) return { positions, uvs, windows };
  const lit = data.lit.map((l) => {
    const xs = l.poly.map((p) => p[0]), zs = l.poly.map((p) => p[1]);
    return { ...l, minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
  });
  data.windows.forEach((w, i) => {
    if (w.n[0] * sun.x + w.n[1] * sun.z < FACING) return;
    const r = atlas.rects[i];
    // its corners on the glass, and where each is in the atlas: the picture's top row is the window's top
    const corners = [[0, 0], [w.w, 0], [w.w, w.h], [0, w.h]].map(([s, y]) => ({
      x: w.o[0] + w.u[0] * s, y: w.o[1] + y, z: w.o[2] + w.u[1] * s,
      u: (r.x + (s / w.w) * r.w) / atlas.width, v: 1 - (r.y + (1 - y / w.h) * r.h) / atlas.height
    }));
    let any = false;
    for (const l of lit) {
      if (corners.some((c) => c.y <= l.y)) continue;
      // along the sun from each corner down to the surface's height
      const quad = corners.map((c) => {
        const t = (c.y - l.y) / sun.y;
        return { x: c.x - sun.x * t, z: c.z - sun.z * t, u: c.u, v: c.v };
      });
      const xs = quad.map((q) => q.x), zs = quad.map((q) => q.z);
      if (Math.max(...xs) < l.minX || Math.min(...xs) > l.maxX || Math.max(...zs) < l.minZ || Math.min(...zs) > l.maxZ) continue;
      const poly = cut(quad, l.poly);
      if (poly.length < 3) continue;
      any = true;
      const y = l.y + LIFT;
      for (let k = 1; k + 1 < poly.length; k++) {
        for (const p of [poly[0], poly[k], poly[k + 1]]) {
          positions.push(p.x, y, p.z);
          uvs.push(p.u, p.v);
        }
      }
    }
    if (any) windows++;
  });
  return { positions, uvs, windows };
}

/** How much of the sun comes through, and its colour: none from evening on (the interiors' glow then is the city's lit windows') */
function strength(sun, glow) {
  const t = Math.min(1, Math.max(0, (glow - 0.6) / 0.7));
  const daylight = 1 - t * t * (3 - 2 * t);
  return sun.y < LOW_SUN ? 0 : STRENGTH * daylight * Math.sqrt(sun.y);
}

/**
 * The light through an inside's windows (its JSON, `data`), for a site turned by `yaw`: { mesh, update(), state(), dispose() }. update()
 * works it out again if the sun or the time of day has moved since (each frame is fine: it compares a few numbers). `city`: the city's
 * uniforms (js/tsl-materials.js cityUniforms), the sun's direction and colour and the interiors' glow, which the time of day sets.
 */
function createSunlight(data, yaw, city) {
  const atlas = layout(data);
  const canvas = document.createElement('canvas');
  canvas.width = atlas.width;
  canvas.height = atlas.height;
  const ctx = canvas.getContext('2d');
  const pixels = ctx.createImageData(atlas.width, atlas.height);
  // Each glass's colour as its light: the coloured glass a little deeper, and the pale (grisaille, borders) faint, or a window's light
  // on a light floor is mostly white
  const colours = data.palette.map((hex) => {
    const c = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
    const hi = Math.max(...c), lo = Math.min(...c), grey = (c[0] + c[1] + c[2]) / 3;
    const sat = hi ? (hi - lo) / hi : 0;
    return [...c.map((v) => Math.max(0, Math.min(255, Math.round(grey + (v - grey) * 1.3)))), Math.round(255 * (0.25 + 0.75 * sat))];
  });
  const KEYS = '0123456789abcdefghijklmnopqrstuvwxyz';
  data.windows.forEach((w, i) => {
    const r = atlas.rects[i];
    w.img.forEach((row, j) => {
      for (let k = 0; k < row.length; k++) {
        if (row[k] === '.') continue;
        const at = ((r.y + j) * atlas.width + r.x + k) * 4;
        pixels.data.set(colours[KEYS.indexOf(row[k])], at);
      }
    });
  });
  ctx.putImageData(pixels, 0, 0);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.minFilter = THREE.LinearFilter; // a few pixels a window: soft as light through glass is, no mipmaps to blur it to nothing
  map.generateMipmaps = false;
  const tint = uniform(new THREE.Color(0, 0, 0));
  const glass = texture(map, uv());
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
  material.colorNode = vec4(glass.rgb.mul(tint), glass.a);
  material.fog = false;
  const geometry = new THREE.BufferGeometry();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Sunlight';
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.userData.lifted = true;
  let key = '';
  let shown = { windows: 0, triangles: 0 };

  function update() {
    const sunWorld = city.uSkySunDir.value, glow = city.uInteriorGlow.value, colour = city.uSunColor.value;
    const now = `${sunWorld.x.toFixed(4)},${sunWorld.y.toFixed(4)},${sunWorld.z.toFixed(4)},${glow.toFixed(3)},${colour.getHexString()}`;
    if (now === key) return false;
    key = now;
    const sun = sunIn(yaw, sunWorld);
    const k = strength(sun, glow);
    const { positions, uvs, windows } = k > 0 ? throwLight(data, sun, atlas) : { positions: [], uvs: [], windows: 0 };
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    tint.value.copy(colour).multiplyScalar(k);
    mesh.visible = positions.length > 0;
    shown = { windows, triangles: positions.length / 9, strength: +k.toFixed(3) };
    return true;
  }

  function dispose() {
    geometry.dispose();
    material.dispose();
    map.dispose();
  }

  return { mesh, update, dispose, state: () => shown };
}

export { createSunlight, layout, strength, sunIn, throwLight };
