import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_POINTS, outlineOf } from '../js/building-outlines.js';

test('a simple footprint keeps its shape', () => {
  const ring = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }];
  assert.equal(outlineOf(ring), ring);
});

test('a complicated footprint comes down to a few points, keeping its size', () => {
  const ring = [];
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2, r = i % 2 ? 40 : 35;
    ring.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
  }
  const out = outlineOf(ring);
  assert.ok(out.length <= MAX_POINTS && out.length >= 3);
  const reach = Math.max(...out.map((p) => Math.hypot(p.x, p.z)));
  assert.ok(reach > 35 && reach <= 40.01);
});
