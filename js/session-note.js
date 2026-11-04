// A note of how the session is going, written every few seconds, so that if the browser kills the tab (iOS does when a page holds
// too much memory, and reloads it) the next load can say where and at what size it happened. A page closed or reloaded the normal
// way says so on the way out; one killed in view doesn't get the chance. ?stats=1 shows what the last session left (js/main.js).

const KEY = 'sydney-session';
const EVERY_MS = 5000;

/** What the last session left, if it ended without closing while in view: { seconds, x, z, mode, memoryMB, tiles } or null */
function lastSessionNote(storage) {
  try {
    const note = JSON.parse(storage.getItem(KEY) || 'null');
    return note && !note.closed && !note.hidden ? note : null;
  } catch {
    return null;
  }
}

/** Starts writing this session's note. `read()` gives { x, z, mode, memoryMB, tiles } when asked. */
function startSessionNote(storage, read, now = () => performance.now()) {
  const started = now();
  let hidden = false;
  const write = (extra = {}) => {
    try {
      storage.setItem(KEY, JSON.stringify({ seconds: Math.round((now() - started) / 1000), ...read(), hidden, closed: false, ...extra }));
    } catch {
      // Storage full or blocked: nothing to note
    }
  };
  write();
  const timer = setInterval(write, EVERY_MS);
  // Out of view a tab can be let go for reasons that have nothing to do with the game
  document.addEventListener('visibilitychange', () => {
    hidden = document.hidden;
    write();
  });
  window.addEventListener('pagehide', () => write({ closed: true }));
  return () => clearInterval(timer);
}

/** The readout's line for a note */
function noteText(note) {
  const clock = `${Math.floor(note.seconds / 60)}:${String(note.seconds % 60).padStart(2, '0')}`;
  const doing = { car: 'driving', helicopter: 'flying', person: 'walking', cyclist: 'cycling' }[note.mode] || note.mode;
  return `last session ended without closing at ${clock}, ${doing} at (${Math.round(note.x)}, ${Math.round(note.z)}), about ${note.memoryMB} MB held, ${note.tiles} tiles`;
}

export { lastSessionNote, noteText, startSessionNote };
