// Shared by the play scenarios and the benchmark: serve the production build, drive system Chrome, record video.
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, brotliCompressSync } from 'node:zlib';
import { chromium, firefox, webkit } from 'playwright-core';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const PROFILES = {
  desktop: { viewport: { width: 1920, height: 1080 } },
  laptop: { viewport: { width: 1280, height: 720 } },
  wide: { viewport: { width: 2560, height: 1440 } },
  // Slows the CPU only, so its FPS flatters a real phone.
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, touch: true, cpuThrottle: 4, mbps: 50 }
};

const CONTENT_TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.gz': 'application/gzip', '.woff2': 'font/woff2'
};

// Stands in for Cloudflare: brotli on text, already-compressed files as they are.
// `root`: a copy of the build, so a run isn't disturbed by the next rebuild
export function serveDist(port = 0, root = join(ROOT, 'dist')) {
  if (!existsSync(join(root, 'index.html'))) throw new Error('No build found: run "npm run build" first.');
  const compressed = new Map();
  const server = http.createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = join(root, path);
    if (!file.startsWith(root + sep) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    const ext = extname(file);
    const headers = { 'content-type': CONTENT_TYPES[ext] || 'application/octet-stream', 'cache-control': 'no-store' };
    let body = readFileSync(file);
    if (['.html', '.js', '.css'].includes(ext) && /\bbr\b/.test(req.headers['accept-encoding'] || '')) {
      if (!compressed.has(file)) {
        compressed.set(file, brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }));
      }
      body = compressed.get(file);
      headers['content-encoding'] = 'br';
    }
    res.writeHead(200, headers).end(body);
  });
  return new Promise((done) => server.listen(port, '127.0.0.1', () => done({
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((closed) => { server.close(closed); server.closeAllConnections(); })
  })));
}

export function launchChrome({ headed = false } = {}) {
  return chromium.launch({
    channel: 'chrome',
    headless: !headed,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--js-flags=--expose-gc']
  });
}

// Playwright's own Firefox build: no WebGPU, and no EXT_clip_control, so the game runs WebGL2 with standard depth there.
// WebKit is Safari's engine, here a Linux build that draws WebGL2 in software: the nearest thing to an iPhone this machine
// has, for what Safari does differently and for how much memory its web process holds (webProcessMemory()).
export function launchBrowser({ browser = 'chrome', headed = false } = {}) {
  if (browser === 'firefox') return firefox.launch({ headless: !headed, firefoxUserPrefs: { 'webgl.force-enabled': true } });
  if (browser === 'webkit') return webkit.launch({ headless: !headed });
  return launchChrome({ headed });
}

/** MB held by WebKit's web processes (WebKit has no performance.memory), or null if none are running */
export function webProcessMemory() {
  try {
    const kb = execSync("ps -eo rss,comm | awk '/WPEWebProcess|WebKitWebProces/ {s+=$1} END {print s+0}'").toString();
    return Number(kb) ? Math.round(Number(kb) / 1024) : null;
  } catch {
    return null;
  }
}

/**
 * A picture of the page as a player sees it. The browser's own screenshot can't read a WebGPU canvas and comes back black
 * behind the HUD, so the game's own picture of the world goes in under the HUD for the moment the screenshot takes.
 */
export async function screenshot(page, path) {
  const world = await page.evaluate(() => Promise.race([window.__gameDebug?.grab?.(), new Promise((done) => setTimeout(done, 2000))])).catch(() => null);
  if (world) {
    await page.evaluate((url) => {
      const canvas = document.querySelector('#canvas-container canvas');
      if (!canvas) return;
      const img = document.createElement('img');
      img.id = 'screenshot-world';
      img.src = url;
      const box = canvas.getBoundingClientRect();
      img.style.cssText = `position:fixed;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;z-index:0;pointer-events:none`;
      canvas.after(img);
      return img.decode();
    }, world).catch(() => {});
  }
  const shot = await page.screenshot().catch(() => null);
  await page.evaluate(() => document.getElementById('screenshot-world')?.remove()).catch(() => {});
  if (shot) writeFileSync(path, shot);
  return !!shot;
}

const warmedUp = new WeakSet();
// Fresh profile each time, so nothing is cached and no saved player position carries over.
export async function openGame(browser, url, { profile = 'laptop', query = '', storage = null, initScript = null, setup = null, offline = false, timeout = 120000, stayThrottled = false } = {}) {
  const { viewport, deviceScaleFactor = 1, touch = false, cpuThrottle, mbps } = PROFILES[profile];
  const context = await browser.newContext({ viewport, deviceScaleFactor, hasTouch: touch, isMobile: touch });
  // A browser that has only just started loses any WebGL context made in the GPU process's first few hundred milliseconds
  // (0-100 ms: 3 of 3 lost; 400 ms and over: none). A player's browser is already running when they open the page.
  if (!warmedUp.has(browser)) {
    warmedUp.add(browser);
    const warm = await context.newPage();
    await warm.goto('data:text/html,<!doctype html><body style="background:%23000"><canvas></canvas>');
    await warm.waitForTimeout(600);
    await warm.close();
  }
  const page = await context.newPage();
  await setup?.(page);
  const errors = [];
  const warnings = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
    else if (message.type() === 'warning') warnings.push(message.text());
  });
  if (storage) await page.addInitScript((saved) => localStorage.setItem('sydney-player-state', saved), storage);
  if (initScript) await page.addInitScript(initScript);
  if (offline) await context.setOffline(true);
  // Throttling goes through the Chrome DevTools Protocol, which Firefox doesn't speak: it runs unthrottled
  const cdp = browser.browserType().name() === 'chromium' ? await context.newCDPSession(page) : null;
  if (cpuThrottle && cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
  if (mbps && cdp) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 40, downloadThroughput: mbps * 125000, uploadThroughput: mbps * 40000
    });
  }
  await page.goto(`${url}?debug=1${query ? `&${query}` : ''}`, { waitUntil: offline ? 'domcontentloaded' : 'commit' });
  await page.waitForFunction(() => document.getElementById('loading-overlay')?.classList.contains('hidden'), null, { timeout, polling: 100 });
  if (cpuThrottle && cdp && !stayThrottled) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  return { context, page, cdp, errors, warnings };
}

// Frames grabbed inside the game's own frame into ffmpeg, stamped by arrival time. A screencast comes back black where
// headless Chrome can't read a WebGPU canvas; this shows the game itself, without the HUD.
export async function startRecording(game, file) {
  mkdirSync(dirname(file), { recursive: true });
  const ffmpeg = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-use_wallclock_as_timestamps', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-i', '-',
    '-fps_mode', 'vfr', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file
  ], { stdio: ['pipe', 'ignore', 'inherit'] });
  ffmpeg.stdin.on('error', () => {});
  let recording = true;
  const frames = (async () => {
    while (recording) {
      const url = await game.page.evaluate(() => Promise.race([window.__gameDebug?.grab(), new Promise((done) => setTimeout(done, 1000))])).catch(() => null);
      if (url) ffmpeg.stdin.write(Buffer.from(url.split(',')[1], 'base64'));
      await new Promise((done) => setTimeout(done, 90));
    }
  })();
  return async () => {
    recording = false;
    await frames;
    ffmpeg.stdin.end();
    await new Promise((done) => ffmpeg.on('close', done));
  };
}
