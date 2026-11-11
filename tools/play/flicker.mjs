// Looks for flicker: holds a view still, grabs frames, and counts the pixels that jump back and forth between frames.
// Waves, clouds and traffic change pixels too, but they drift or pass once; flicker flips the same pixel back and forth.
// Writes a map of where it flickered (white) over the first frame, for each view.
// usage: node tools/play/flicker.mjs out-dir [--browser=firefox] [--frames=40] [--query=...] [--drift=mm] [--dist=dir] [name@x,y,z>tx,ty,tz ...]
//   --dist=dir: another build to look at, for pictures from before a change
//   name@x,y,z>tx,ty,tz: views of your own, the camera at (x, y, z) looking at (tx, ty, tz), in place of the three below
//   --drift=mm: the camera moves this far sideways and up each frame. Surfaces that fight for the same depth flip as it moves, where
//   a still camera draws them the same every frame; what's really there only slides one way. Leaves moving in the wind flip too, so
//   aim it where there are no trees.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, openGame, serveDist } from './lib.mjs';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--')) || 'recordings/flicker';
const option = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;
const browserName = option('browser', 'chrome');
const frames = Number(option('frames', 40));
const drift = Number(option('drift', 0)) / 1000;
mkdirSync(out, { recursive: true });

// Views with sky, horizon and distant land: [name, x, z, heading, mode, climbSeconds]
const OWN = args.filter((a) => !a.startsWith('--') && a.includes('@')).map((a) => {
  const [name, rest] = a.split('@');
  const [from, to] = rest.split('>').map((p) => p.split(',').map(Number));
  return [name, from, to];
});
const VIEWS = OWN.length ? OWN : [
  ['harbour-east', 300, -1900, 1.75, 'helicopter', 5], // across the harbour to the Heads
  ['street-north', 397, -1000, 3.14, 'car', 0], // the spawn view: a street, the Opera House, the north shore
  ['high-west', -400, -1200, -1.6, 'helicopter', 12] // high over the CBD, west into the sun
];

const server = await serveDist(0, ...(option('dist', '') ? [option('dist', '')] : []));
const browser = await launchBrowser({ browser: browserName });
const game = await openGame(browser, server.url, { profile: 'laptop', query: option('query', '') });
const { page } = game;
await page.waitForFunction(() => window.__gameDebug.worldCompleteAt() !== null, null, { timeout: 300000, polling: 500 });
const info = await page.evaluate(() => window.__gameDebug.renderInfo());
const depth = await page.evaluate(() => window.__gameDebug.depthMode?.());
console.log(`${browserName}: ${info.backend}, depth ${JSON.stringify(depth)}`);

const report = {};
for (const view of VIEWS) {
  const [name, x, z, heading, mode, climb] = view;
  const own = Array.isArray(x);
  // The camera moved `drift` across and up for frame i, along the line at right angles to where it looks
  const at = (i) => {
    const [from, to] = [view[1], view[2]];
    const dx = to[0] - from[0], dz = to[2] - from[2], L = Math.hypot(dx, dz) || 1;
    return [[from[0] - (dz / L) * drift * i, from[1] + drift * i, from[2] + (dx / L) * drift * i], to];
  };
  if (own) await page.evaluate(([from, to]) => window.__gameDebug.view(from, to), at(0));
  else await page.evaluate(([a, b, c, m]) => window.__gameDebug.goto(a, b, c, m), [x, z, heading, mode]);
  if (!own && climb) {
    await page.keyboard.down('Space');
    await page.waitForTimeout(climb * 1000);
    await page.keyboard.up('Space');
  }
  await page.evaluate(() => window.__gameDebug.holdStill?.(true));
  await page.waitForTimeout(2500);
  const dir = join(out, name);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < frames; i++) {
    if (own && drift && i) await page.evaluate(([from, to]) => window.__gameDebug.view(from, to), at(i));
    const url = await page.evaluate(() => window.__gameDebug.grab());
    writeFileSync(join(dir, `${String(i).padStart(3, '0')}.jpg`), Buffer.from(url.split(',')[1], 'base64'));
  }
  await page.evaluate(() => window.__gameDebug.holdStill?.(false));
  if (own) await page.evaluate(() => window.__gameDebug.view(null));
  // Every frame as raw grey levels, through ffmpeg
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', join(dir, '000.jpg')]).toString().trim().split(',').map(Number);
  const [w, h] = probe;
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, '%03d.jpg'), '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 30 });
  const n = Math.floor(raw.length / (w * h));
  const flips = new Uint16Array(w * h);
  for (let p = 0; p < w * h; p++) {
    let last = 0;
    for (let f = 1; f < n; f++) {
      const d = raw[f * w * h + p] - raw[(f - 1) * w * h + p];
      if (Math.abs(d) < 24) continue;
      const sign = Math.sign(d);
      if (last && sign !== last) flips[p]++;
      last = sign;
    }
  }
  let flickering = 0, rows = new Uint32Array(h);
  const map = Buffer.alloc(w * h);
  for (let p = 0; p < w * h; p++) {
    const bad = flips[p] >= 3;
    if (bad) { flickering++; rows[Math.floor(p / w)]++; }
    map[p] = bad ? 255 : raw[p] >> 2; // the first frame, dimmed, under white flicker
  }
  writeFileSync(join(dir, 'map.gray'), map);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-i', join(dir, 'map.gray'), join(out, `${name}-flicker.png`)]);
  // Where in the picture: the band of rows with most of it
  let top = -1, bottom = -1;
  for (let r = 0; r < h; r++) if (rows[r] > w * 0.01) { if (top < 0) top = r; bottom = r; }
  report[name] = { frames: n, flickeringPixels: flickering, share: +(flickering / (w * h) * 100).toFixed(3), rows: top < 0 ? null : [top, bottom], height: h };
  console.log(name, JSON.stringify(report[name]));
}
writeFileSync(join(out, 'report.json'), JSON.stringify({ browser: browserName, backend: info.backend, depth, report }, null, 1));
console.log('errors', game.errors.length, game.errors.slice(0, 5).join('\n').slice(0, 1200));
void readFileSync;
await browser.close();
await server.close();
