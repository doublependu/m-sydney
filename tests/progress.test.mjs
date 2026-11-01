import assert from 'node:assert/strict';
import test from 'node:test';
import { HIDE_AFTER_MS, ProgressModel, SHOW_AFTER_MS } from '../js/progress.js';

const clock = () => {
  let t = 0;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
};

test('the bar moves by weight, and names the first step unfinished', () => {
  const now = clock();
  const progress = new ProgressModel(now);
  const [a, b] = progress.plan([['Streets', 3], ['Traffic', 1]]);
  now.advance(SHOW_AFTER_MS);
  assert.deepEqual(progress.state(), { visible: true, value: 0, label: 'Streets' });
  a.set(0.5);
  assert.equal(progress.state().value, 0.375);
  a.done();
  assert.equal(progress.state().label, 'Traffic');
  assert.equal(progress.state().value, 0.75);
  b.done();
  assert.equal(progress.state().value, 1);
});

test('work done quickly never shows, and finished work lingers a moment', () => {
  const now = clock();
  const progress = new ProgressModel(now);
  const quick = progress.start('Changing the light');
  now.advance(SHOW_AFTER_MS - 50);
  quick.done();
  assert.equal(progress.state().visible, false);

  const slow = progress.start('Compiling shaders');
  now.advance(SHOW_AFTER_MS + 10);
  assert.equal(progress.state().visible, true);
  slow.done();
  assert.equal(progress.state().visible, true, 'gone the instant it finished');
  now.advance(HIDE_AFTER_MS);
  assert.equal(progress.state().visible, false);
});

test('a new task after the bar has gone starts a new count', () => {
  const now = clock();
  const progress = new ProgressModel(now);
  const first = progress.start('Streets');
  first.done();
  now.advance(HIDE_AFTER_MS * 2);
  const second = progress.start('Changing the light');
  now.advance(SHOW_AFTER_MS);
  assert.equal(progress.state().value, 0);
  assert.equal(progress.tasks.length, 1);
  second.done();
});
