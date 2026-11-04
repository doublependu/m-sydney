import assert from 'node:assert/strict';
import test from 'node:test';

// A page's document and window, enough for the note
const listeners = {};
globalThis.document = { hidden: false, addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); } };
globalThis.window = { addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); } };
const fire = (type) => (listeners[type] || []).forEach((fn) => fn());
const { lastSessionNote, noteText, startSessionNote } = await import('../js/session-note.js');

const memoryStorage = () => {
  const items = new Map();
  return { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, String(v)) };
};
const read = () => ({ x: -100, z: -5900, mode: 'helicopter', memoryMB: 690, tiles: 11 });

test('a session the browser killed in view is reported by the next one', () => {
  const storage = memoryStorage();
  let t = 0;
  const stop = startSessionNote(storage, read, () => t);
  t = 192000;
  fire('visibilitychange'); // a write, still in view
  stop();
  const note = lastSessionNote(storage);
  assert.ok(note);
  assert.equal(noteText(note), 'last session ended without closing at 3:12, flying at (-100, -5900), about 690 MB held, 11 tiles');
});

test('a page closed the normal way, or let go while out of view, leaves nothing to report', () => {
  const closed = memoryStorage();
  const stop = startSessionNote(closed, read, () => 0);
  fire('pagehide');
  stop();
  assert.equal(lastSessionNote(closed), null);

  const hidden = memoryStorage();
  const stop2 = startSessionNote(hidden, read, () => 0);
  document.hidden = true;
  fire('visibilitychange');
  document.hidden = false;
  stop2();
  assert.equal(lastSessionNote(hidden), null);
});
