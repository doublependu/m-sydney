// What ?stats=1 reports about frames: the last second, and everything since the game became playable. One good second says
// little about a whole session, and iOS gives no other way to see how it went.

const SLOW_MS = 34;

class FrameStats {
  constructor(now) {
    this.started = now;
    this.last = now;
    this.mark = now;
    this.hidden = 0; // ms of the session spent with the tab hidden
    this.resuming = true;
    this.second = { frames: 0, slow: 0, worst: 0 };
    this.frames = 0;
    this.slow = 0;
    this.worst = 0;
    this.worstAt = 0;
  }

  /** The tab went out of view: the next frame's long gap is that, not a slow frame */
  pause(now) {
    if (this.pausedAt === undefined) this.pausedAt = now;
  }

  /** A frame at time `now`. Returns true when a second has gone by, so the readout should be rewritten. */
  frame(now) {
    if (this.pausedAt !== undefined) {
      this.hidden += now - this.pausedAt;
      this.pausedAt = undefined;
      this.resuming = true;
    }
    if (this.resuming) {
      this.resuming = false;
      this.last = now;
      this.mark = now;
      return false;
    }
    const gap = now - this.last;
    this.last = now;
    const { second } = this;
    second.frames++;
    second.worst = Math.max(second.worst, gap);
    this.frames++;
    if (gap > SLOW_MS) {
      second.slow++;
      this.slow++;
    }
    if (gap > this.worst) {
      this.worst = gap;
      this.worstAt = now - this.started - this.hidden;
    }
    return now - this.mark >= 1000;
  }

  /** The readout's two lines on frames, and starts a new second */
  lines(now) {
    const { second } = this;
    const fps = Math.round((second.frames * 1000) / Math.max(1, now - this.mark));
    const text = `${fps} fps, ${second.slow} slow, worst ${Math.round(second.worst)} ms\n`
      + `since load ${clockText(now - this.started - this.hidden)}: worst ${Math.round(this.worst)} ms at ${clockText(this.worstAt)}, ${this.slow.toLocaleString('en')} of ${this.frames.toLocaleString('en')} slow`;
    this.second = { frames: 0, slow: 0, worst: 0 };
    this.mark = now;
    return text;
  }
}

function clockText(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export { FrameStats };
