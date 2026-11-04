// npm run viewports: checks the HUD at each screen size for panels that overflow or overlap. Saves a screenshot of each.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome, PROFILES, ROOT, openGame, screenshot, serveDist } from './lib.mjs';

const SIZES = {
  touch: [[360, 640], [390, 844], [412, 915], [844, 390], [640, 360], [768, 1024], [1024, 768]],
  mouse: [[1024, 768], [1366, 768], [1920, 1080], [2560, 1080]]
};
PROFILES.touchSizes = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, touch: true };
PROFILES.mouseSizes = { viewport: { width: 1366, height: 768 } };

const PANELS = [
  '.repo-link', '#hud-toolbar', '#hud-cluster', '#mode-switch', '#minimap-card', '#hud-location', '#hud-controls-hint',
  '.touch-action', '#app-version', '#btn-phone-menu', '#hud-mini', '#hud-progress'
];
// On a phone, driving: how much of the screen the HUD may cover, and none of the middle of it
const PHONES = new Set(['360x640', '390x844', '412x915', '844x390', '640x360']);
const MAX_COVERED = 0.1;
const covered = (boxes, width, height) => {
  let on = 0, all = 0, middle = 0;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      all++;
      if (!boxes.some((b) => x >= b.left && x < b.right && y >= b.top && y < b.bottom)) continue;
      on++;
      if (y > height * 0.2 && y < height * 0.8 && x > width * 0.2 && x < width * 0.8) middle++;
    }
  }
  return { share: on / all, middle };
};

const measure = (selectors) => selectors.flatMap((selector) => [...document.querySelectorAll(selector)].flatMap((element) => {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return [];
  return [{ selector, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }];
}));

const outDir = join(ROOT, 'recordings/viewports');
mkdirSync(outDir, { recursive: true });
const server = await serveDist();
const browser = await launchChrome();
const problems = [];
for (const [input, sizes] of Object.entries(SIZES)) {
  const game = await openGame(browser, server.url, { profile: `${input}Sizes` });
  for (const [width, height] of sizes) {
    await game.page.setViewportSize({ width, height });
    await game.page.waitForTimeout(700);
    const boxes = await game.page.evaluate(measure, PANELS);
    const label = `${input} ${width}x${height}`;
    await screenshot(game.page, join(outDir, `${input}-${width}x${height}.png`));
    if (input === 'touch' && PHONES.has(`${width}x${height}`)) {
      const { share, middle } = covered(boxes, width, height);
      console.log(`${label}: the HUD covers ${(share * 100).toFixed(1)}% of the screen`);
      if (share > MAX_COVERED) problems.push(`${label}: the HUD covers ${(share * 100).toFixed(1)}% of the screen, limit ${MAX_COVERED * 100}%`);
      if (middle) problems.push(`${label}: the HUD is in the middle of the screen`);
    }
    // The eye button hides the HUD: a phone's HUD fades by itself, so there it's gone, even with the menu open
    const eyeShown = await game.page.evaluate(() => {
      const phoneMenu = document.getElementById('btn-phone-menu');
      const menuShown = phoneMenu && getComputedStyle(phoneMenu).display !== 'none';
      if (menuShown && !document.body.classList.contains('phone-menu-open')) phoneMenu.click();
      const eye = document.getElementById('btn-toggle-hud');
      const shown = !!eye && getComputedStyle(eye).display !== 'none' && eye.getBoundingClientRect().width > 0;
      if (menuShown && document.body.classList.contains('phone-menu-open')) phoneMenu.click();
      return shown;
    });
    const phone = input === 'touch' && PHONES.has(`${width}x${height}`);
    if (phone && eyeShown) problems.push(`${label}: the eye button shows on a phone`);
    if (!phone && !eyeShown) problems.push(`${label}: no eye button`);
    for (const box of boxes) {
      if (box.left < -0.5 || box.top < -0.5 || box.right > width + 0.5 || box.bottom > height + 0.5) {
        problems.push(`${label}: ${box.selector} off-screen (${Math.round(box.left)}, ${Math.round(box.top)} to ${Math.round(box.right)}, ${Math.round(box.bottom)})`);
      }
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]];
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) {
          problems.push(`${label}: ${a.selector} overlaps ${b.selector}`);
        }
      }
    }
  }
  await game.context.close();
}
await browser.close();
await server.close();
for (const problem of problems) console.log(problem);
console.log(problems.length ? `${problems.length} problems` : 'All viewports clean');
process.exit(problems.length ? 1 : 0);
