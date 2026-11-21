import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The sun through St Mary's stained glass (js/stained-light.js): each window facing the sun thrown along it onto the floors and pews
// (the inside's JSON, `windows` and `lit`), for the time of day.
const { layout, strength, sunIn, throwLight } = await import('../js/stained-light.js');
const { MODEL_SITES } = await import('../js/model-sites.js');

const data = JSON.parse(fs.readFileSync(new URL('../public/models/st-marys-in.json', import.meta.url), 'utf8'));
const site = MODEL_SITES.find((s) => s.id === 'st-marys');
// The sun's direction (towards it) and the interiors' glow at each time of day, as js/lighting.js's TIME_PRESETS have them
const norm = ([x, y, z]) => {
  const L = Math.hypot(x, y, z);
  return { x: x / L, y: y / L, z: z / L };
};
const TIMES = {
  golden: { sun: norm([-0.44, 0.58, -0.68]), glow: 0.48 },
  midday: { sun: norm([-0.34, 0.82, -0.46]), glow: 0.24 },
  twilight: { sun: norm([-0.52, 0.36, -0.77]), glow: 1.25 },
  midnight: { sun: norm([0.42, 0.68, -0.6]), glow: 1.55 }
};
const atlas = layout(data);
const inPoly = (poly, x, z, pad = 0.01) => {
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
    const L = Math.hypot(bx - ax, bz - az);
    if (((bx - ax) * (z - az) - (bz - az) * (x - ax)) / L < -pad) return false;
  }
  return true;
};
const centre = (positions) => {
  let x = 0, z = 0;
  for (let i = 0; i < positions.length; i += 3) {
    x += positions[i];
    z += positions[i + 2];
  }
  return { x: (x * 3) / positions.length, z: (z * 3) / positions.length };
};

test('every window\'s picture has its own place in the atlas', () => {
  const r = atlas.rects;
  assert.equal(r.length, data.windows.length);
  for (let i = 0; i < r.length; i++) {
    assert.equal(r[i].w, data.windows[i].img[0].length);
    assert.ok(r[i].x >= 1 && r[i].y >= 1 && r[i].x + r[i].w < atlas.width && r[i].y + r[i].h < atlas.height, `picture ${i} is off the atlas`);
    for (let j = 0; j < i; j++) {
      const a = r[i], b = r[j];
      assert.ok(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y, `pictures ${i} and ${j} overlap`);
    }
  }
});

test('by day the sun comes through the windows facing it, onto the surfaces it falls on, and none of the others', () => {
  for (const name of ['golden', 'midday']) {
    const { sun: world, glow } = TIMES[name];
    const sun = sunIn(site.yaw, world);
    assert.ok(strength(sun, glow) > 0.2, `${name}: no sun through the glass`);
    const { positions, uvs, windows } = throwLight(data, sun, atlas);
    const facing = data.windows.filter((w) => w.n[0] * sun.x + w.n[1] * sun.z > 0.03).length;
    // the sun's in the north-west: through the west and north windows, some of them onto nothing they reach
    assert.ok(windows >= 0.5 * facing && windows > 10, `${name}: ${windows} windows of the ${facing} facing the sun throw light`);
    assert.equal(uvs.length / 2, positions.length / 3);
    // every corner on one of the surfaces, just over it
    for (let i = 0; i < positions.length; i += 3) {
      const [x, y, z] = [positions[i], positions[i + 1], positions[i + 2]];
      const on = data.lit.some((l) => Math.abs(l.y + 0.012 - y) < 1e-6 && inPoly(l.poly, x, z));
      assert.ok(on, `${name}: a patch at (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) on no surface`);
    }
    // and in its window's picture
    assert.ok(uvs.every((v) => v >= 0 && v <= 1));
  }
});

test('it moves with the sun: further into the building at golden than at midday, and none from evening on', () => {
  const at = (name) => throwLight(data, sunIn(site.yaw, TIMES[name].sun), atlas);
  const golden = at('golden'), midday = at('midday');
  const a = centre(golden.positions), b = centre(midday.positions);
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > 2, `the light's middle moves ${Math.hypot(a.x - b.x, a.z - b.z).toFixed(2)} m`);
  // the sun's lower at golden: the patches of one window, the great north window, reach further from it
  const north = data.windows.findIndex((w) => w.n[1] < -0.99 && w.w > 6);
  assert.ok(north >= 0, 'no great north window');
  const reach = (name) => {
    const one = throwLight({ ...data, windows: [data.windows[north]] }, sunIn(site.yaw, TIMES[name].sun), layout({ ...data, windows: [data.windows[north]] }));
    return Math.max(...one.positions.filter((_, i) => i % 3 === 2)) - data.windows[north].o[2];
  };
  assert.ok(reach('golden') > reach('midday') + 2, `the north window's light reaches ${reach('golden').toFixed(1)} m at golden, ${reach('midday').toFixed(1)} at midday`);
  assert.ok(strength(sunIn(site.yaw, TIMES.twilight.sun), TIMES.twilight.glow) < 0.05, 'the sun still through the glass at twilight');
  assert.equal(strength(sunIn(site.yaw, TIMES.midnight.sun), TIMES.midnight.glow), 0, 'sun through the glass at midnight');
});
