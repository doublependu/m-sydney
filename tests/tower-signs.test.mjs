import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { TOWER_SIGNS, placeTowerSign } = await import('../js/tower-signs.js');
const { groundHeight } = await import('../js/surfaces.js');

test('the two names, once each, spelled as they are', () => {
  assert.deepEqual(TOWER_SIGNS.map((s) => s.text), ['MAN & BOT', 'MAIZE.LIVE']);
});

test('each sign is on its own tower, near the top, facing the harbour', () => {
  for (const sign of TOWER_SIGNS) {
    const p = placeTowerSign(sign);
    assert.equal(p.towerHeight, sign.height, sign.tower);
    assert.ok(p.roof - p.y < 12 && p.roof - p.y > sign.h / 2, `${sign.text} is ${(p.roof - p.y).toFixed(1)} m below the roof`);
    assert.ok(p.y - groundHeight(p.x, p.z) > 150, `${sign.text} stands well above the street`);
    assert.ok(sign.out.z < -0.9, `${sign.text} faces north`);
    // PlaneGeometry faces +z: after turning by yaw it faces along `out`
    assert.ok(Math.abs(Math.sin(p.yaw) - sign.out.x) < 0.01 && Math.abs(Math.cos(p.yaw) - sign.out.z) < 0.01);
  }
});

test('a sign fits the wall it is on', () => {
  const walls = { 'Salesforce Tower': 47.5, 'Governor Phillip Tower': 52.1 };
  for (const sign of TOWER_SIGNS) assert.ok(sign.w < walls[sign.tower], sign.text);
});
