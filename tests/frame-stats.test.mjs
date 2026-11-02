import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameStats } from '../js/frame-stats.js';

const run = (stats, from, gaps) => {
  let now = from;
  for (const gap of gaps) {
    now += gap;
    stats.frame(now);
  }
  return now;
};

test('the worst frame since load outlives the second it happened in', () => {
  const stats = new FrameStats(0);
  stats.frame(0);
  let now = run(stats, 0, [16, 16, 212, 16]);
  stats.lines(now);
  now = run(stats, now, [16, 16, 16]);
  const [second, session] = stats.lines(now).split('\n');
  assert.match(second, /0 slow, worst 16 ms/);
  assert.match(session, /worst 212 ms at 0:00, 1 of 7 slow/);
});

test('time out of view is not a slow frame, and does not count towards the session', () => {
  const stats = new FrameStats(0);
  stats.frame(0);
  let now = run(stats, 0, Array(120).fill(16));
  stats.pause(now);
  now += 600000;
  stats.frame(now); // the first frame back
  now = run(stats, now, [16, 16]);
  const session = stats.lines(now).split('\n')[1];
  assert.match(session, /since load 0:02: worst 16 ms/);
  assert.match(session, /0 of 122 slow/);
});

test('says when a second has gone by', () => {
  const stats = new FrameStats(0);
  stats.frame(0);
  assert.equal(stats.frame(16), false);
  assert.equal(stats.frame(1001), true);
});
