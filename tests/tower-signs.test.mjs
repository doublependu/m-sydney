import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { TOWER_SIGNS, placeTowerSign } = await import('../js/tower-signs.js');
const { groundHeight } = await import('../js/surfaces.js');

test('the two names, once each, spelled as they are', () => {
  assert.deepEqual(TOWER_SIGNS.map((s) => s.name), ['MAN & BOT', 'maize.live']);
  // a sign is its text on a panel, or a wordmark from a file
  for (const sign of TOWER_SIGNS) assert.ok(!!sign.text !== !!sign.file, sign.name);
});

test('each sign is on its own tower, near the top, facing the harbour', () => {
  for (const sign of TOWER_SIGNS) {
    const p = placeTowerSign(sign);
    assert.equal(p.towerHeight, sign.height, sign.tower);
    assert.ok(p.roof - p.y < 12 && p.roof - p.y > sign.h / 2, `${sign.name} is ${(p.roof - p.y).toFixed(1)} m below the roof`);
    assert.ok(p.y - groundHeight(p.x, p.z) > 150, `${sign.name} stands well above the street`);
    assert.ok(sign.out.z < -0.9, `${sign.name} faces north`);
    // PlaneGeometry faces +z: after turning by yaw it faces along `out`
    assert.ok(Math.abs(Math.sin(p.yaw) - sign.out.x) < 0.01 && Math.abs(Math.cos(p.yaw) - sign.out.z) < 0.01);
  }
});

test('a sign fits the wall it is on', () => {
  // Salesforce Tower's: its model's glass crown's north face (tools/models/salesforce.py)
  const walls = { 'Salesforce Tower': 36.75, 'Governor Phillip Tower': 52.1 };
  for (const sign of TOWER_SIGNS) assert.ok(sign.w < walls[sign.tower], sign.name);
});

test('maize.live\'s sign is its wordmark: paths in its own colours, no font or picture to fetch, the sign in its proportions', () => {
  const sign = TOWER_SIGNS.find((s) => s.name === 'maize.live');
  const svg = fs.readFileSync(new URL(`../public/${sign.file}`, import.meta.url), 'utf8');
  // drawn from paths alone: nothing it would fetch, no text the browser would need a font for
  assert.ok(!/<text|<image|<use|href=|url\(|@import|font-family/i.test(svg), 'the wordmark fetches or needs something');
  // the favicon's green m and yellow dot, "aize" green, ".live" blue; and no dark ground behind them
  assert.deepEqual([...new Set(svg.match(/fill="#[0-9a-f]{6}"/g).map((f) => f.slice(6, 13)))].sort(), ['#5cb947', '#6ec6f2', '#ffd23f']);
  assert.ok(!/<rect/.test(svg) && !/#06190b/i.test(svg), 'a ground behind the letters');
  const [w, h] = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/).slice(1).map(Number);
  assert.ok(Math.abs(sign.w / sign.h - w / h) < 0.01 * (w / h), `the sign is ${(sign.w / sign.h).toFixed(3)} : 1, its wordmark ${(w / h).toFixed(3)} : 1`);
  // its own width and height attributes, which a browser needs to draw an SVG into a canvas
  assert.ok(/<svg[^>]* width="\d+" height="\d+"/.test(svg));
  assert.ok(svg.length < 4000, `${svg.length} bytes`);
});
