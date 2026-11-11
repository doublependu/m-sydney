// How smoothly the walker moves: walks at a few places and logs every frame where its head and pelvis are drawn, in the world and on
// the screen, and where the camera is. Jitter is what's left of each after a smooth curve through the 7 frames round it (a quadratic,
// by the game's own clock), so a stride's bob and sway don't count; a step back and forth from one frame to the next does.
// usage: node tools/play/walk-trace.mjs out.json [--profile=laptop] [--only=straight,turn] [--shift] [--query=...]
//   --shift holds Shift with W, for the run
import { writeFileSync } from 'node:fs';
import { launchBrowser, openGame, serveDist, PROFILES } from './lib.mjs';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--')) || 'recordings/walk-trace.json';
const option = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;
const profile = option('profile', 'laptop');
const only = option('only', '')?.split(',').filter(Boolean);
const shift = args.includes('--shift');

// Each walk: where it starts, which way it faces, and what's held when (ms from the start, key, down or up)
const WALKS = [
  { name: 'straight', x: 9, z: -42, heading: 0, seconds: 7, keys: [[0, 'KeyW', 1]] },
  { name: 'turn', x: 9, z: -42, heading: 0, seconds: 7, keys: [[0, 'KeyW', 1], [0, 'KeyA', 1]] },
  { name: 'kerb', x: 9, z: -42, heading: 0, seconds: 7, keys: [[0, 'KeyW', 1], [1500, 'KeyA', 1], [2200, 'KeyA', 0], [4000, 'KeyD', 1], [4900, 'KeyD', 0]] },
  { name: 'park', x: 283, z: -39, heading: Math.PI, seconds: 7, keys: [[0, 'KeyW', 1]] },
  { name: 'slope', x: 700, z: -1000, heading: Math.PI, seconds: 7, keys: [[0, 'KeyW', 1]] },
  { name: 'stand', x: 9, z: -42, heading: 0, seconds: 4, keys: [] }
].filter((w) => !only.length || only.includes(w.name));

/** The value at the middle of each 7 samples less a quadratic fitted through them by time: the frame-to-frame jitter */
function residuals(ts, vs) {
  const r = [];
  for (let i = 3; i + 3 < vs.length; i++) {
    const t0 = ts[i];
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, y0 = 0, y1 = 0, y2 = 0;
    for (let k = i - 3; k <= i + 3; k++) {
      const t = ts[k] - t0, y = vs[k];
      s0 += 1; s1 += t; s2 += t * t; s3 += t * t * t; s4 += t * t * t * t;
      y0 += y; y1 += y * t; y2 += y * t * t;
    }
    // Normal equations for y = a + b t + c t^2; only a, the fit at t = 0, is needed
    const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
    const a = (y0 * (s2 * s4 - s3 * s3) - s1 * (y1 * s4 - s3 * y2) + s2 * (y1 * s3 - s2 * y2)) / det;
    r.push(vs[i] - a);
  }
  return r;
}
const rms = (a) => Math.sqrt(a.reduce((t, v) => t + v * v, 0) / Math.max(1, a.length));
const p95 = (a) => { const s = a.map(Math.abs).sort((x, y) => x - y); return s[Math.floor(s.length * 0.95)] ?? 0; };
// For several axes at once: the length of the residual vector each frame
const jitter = (ts, axes) => {
  const rs = axes.map((vs) => residuals(ts, vs));
  const len = rs[0].map((_, i) => Math.hypot(...rs.map((r) => r[i])));
  return { rms: +rms(len).toFixed(3), p95: +p95(len).toFixed(3) };
};

const server = await serveDist();
const browser = await launchBrowser({});
const game = await openGame(browser, server.url, { profile, query: option('query', '') });
const { page } = game;
await page.waitForFunction(() => window.__gameDebug.worldCompleteAt() !== null, null, { timeout: 240000, polling: 500 });
const { width, height } = PROFILES[profile].viewport;
const results = [];
for (const walk of WALKS) {
  await page.evaluate(({ x, z, heading }) => window.__gameDebug.goto(x, z, heading, 'person'), walk);
  await page.waitForTimeout(2000);
  if (shift) await page.keyboard.down('ShiftLeft');
  // Sampled each frame in the page, by the game's clock, once per simulated frame
  const sampling = page.evaluate((ms) => new Promise((resolve) => {
    const rows = [];
    const until = performance.now() + ms;
    let last = -1;
    const tick = () => {
      const pose = window.__gameDebug.personPose();
      if (pose && pose.frame !== last) {
        last = pose.frame;
        rows.push({ ...pose, clock: window.__gameDebug.clock() });
      }
      if (performance.now() < until) requestAnimationFrame(tick);
      else resolve(rows);
    };
    requestAnimationFrame(tick);
  }), walk.seconds * 1000);
  const started = Date.now();
  for (const [at, key, down] of walk.keys) {
    const wait = at - (Date.now() - started);
    if (wait > 0) await page.waitForTimeout(wait);
    if (down) await page.keyboard.down(key);
    else await page.keyboard.up(key);
  }
  const rows = await sampling;
  for (const [, key] of walk.keys) await page.keyboard.up(key);
  if (shift) await page.keyboard.up('ShiftLeft');
  // From the first second on, once it's up to speed
  const used = rows.filter((r) => r.clock - rows[0].clock >= (walk.keys.length ? 1 : 0));
  const ts = used.map((r) => r.clock);
  const dts = ts.slice(1).map((t, i) => (t - ts[i]) * 1000).sort((a, b) => a - b);
  const result = {
    walk: walk.name, frames: used.length,
    dtMs: { median: +dts[Math.floor(dts.length / 2)]?.toFixed(1), p95: +dts[Math.floor(dts.length * 0.95)]?.toFixed(1), over25: dts.filter((d) => d > 25).length },
    speed: +(used.reduce((t, r) => t + Math.abs(r.speed), 0) / Math.max(1, used.length)).toFixed(2),
    gait: +(used.reduce((t, r) => t + r.gait, 0) / Math.max(1, used.length)).toFixed(2),
    run: +(used.reduce((t, r) => t + r.run, 0) / Math.max(1, used.length)).toFixed(2),
    // On the screen, in pixels: what you see
    headOnScreenPx: jitter(ts, [used.map((r) => r.head.screen[0] * width / 2), used.map((r) => r.head.screen[1] * height / 2)]),
    pelvisOnScreenPx: jitter(ts, [used.map((r) => r.pelvis.screen[0] * width / 2), used.map((r) => r.pelvis.screen[1] * height / 2)]),
    // In the world, in mm: the body, and the camera, apart
    headMm: jitter(ts, [0, 1, 2].map((k) => used.map((r) => r.head.world[k] * 1000))),
    pelvisMm: jitter(ts, [0, 1, 2].map((k) => used.map((r) => r.pelvis.world[k] * 1000))),
    rootMm: jitter(ts, [used.map((r) => r.x * 1000), used.map((r) => r.z * 1000)]),
    cameraMm: jitter(ts, [0, 1, 2].map((k) => used.map((r) => r.camera[k] * 1000))),
    cameraUpMm: jitter(ts, [used.map((r) => r.camera[1] * 1000)]),
    headUpMm: jitter(ts, [used.map((r) => r.head.world[1] * 1000)])
  };
  console.log(JSON.stringify(result));
  results.push({ ...result, rows });
}
writeFileSync(out, JSON.stringify({ profile, shift, results }, null, 1));
if (game.errors.length) console.log('errors', game.errors.length, game.errors.slice(0, 5).join('\n').slice(0, 1200));
await browser.close();
await server.close();
