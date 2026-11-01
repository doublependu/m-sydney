// The loading bar at the top left (#hud-progress in index.html): whatever leaves the scene short of what it will be.
// The rest of the city building behind the game, shaders compiling, code arriving, the sky being baked again. Work is a
// list of tasks with weights, so a long step moves the bar further than a short one; the bar shows their weighted sum
// and the label of the first one unfinished.
//
// Work that's done within SHOW_AFTER_MS never shows (a change of light is usually that quick), and the bar lingers at
// 100% for HIDE_AFTER_MS before it goes. It repaints at most every PAINT_MS, so it costs nothing per frame.

const SHOW_AFTER_MS = 300;
const HIDE_AFTER_MS = 700;
const PAINT_MS = 250;

// The bookkeeping, with no DOM, so it can be tested
class ProgressModel {
  constructor(now = () => performance.now()) {
    this.now = now;
    this.tasks = [];
    this.batchStart = 0;
    this.finishedAt = null;
  }

  /** A task in the current batch: { set(fraction), done(), rename(label) } */
  start(label, weight = 1) {
    if (!this.busy) {
      if (this.finishedAt !== null || !this.tasks.length) this.tasks = [];
      this.batchStart = this.now();
      this.finishedAt = null;
    }
    const task = { label, weight, fraction: 0, done: false, began: null, ended: null };
    this.tasks.push(task);
    return {
      set: (fraction) => {
        if (task.done) return;
        if (task.began === null) task.began = this.now();
        task.fraction = Math.max(task.fraction, Math.min(1, Math.max(0, fraction)));
      },
      begin: () => {
        if (task.began === null) task.began = this.now();
      },
      done: () => {
        if (task.done) return;
        if (task.began === null) task.began = this.now();
        task.done = true;
        task.fraction = 1;
        task.ended = this.now();
        if (!this.busy) this.finishedAt = this.now();
      },
      rename: (name) => { task.label = name; },
      task
    };
  }

  /** Several steps at once, so the bar knows the whole of the work from the start */
  plan(steps) {
    return steps.map(([label, weight]) => this.start(label, weight));
  }

  get busy() {
    return this.tasks.some((t) => !t.done);
  }

  /** What the bar shows now: { visible, value (0-1), label } */
  state() {
    const total = this.tasks.reduce((sum, t) => sum + t.weight, 0) || 1;
    const value = this.tasks.reduce((sum, t) => sum + t.weight * t.fraction, 0) / total;
    const current = this.tasks.find((t) => !t.done);
    const now = this.now();
    let visible;
    if (this.busy) visible = now - this.batchStart >= SHOW_AFTER_MS;
    else visible = this.finishedAt !== null && this.finishedAt - this.batchStart >= SHOW_AFTER_MS && now - this.finishedAt < HIDE_AFTER_MS;
    return { visible, value: this.busy ? value : 1, label: current ? current.label : 'Ready' };
  }

  /** How long each finished task took, for setting the weights */
  timings() {
    return this.tasks.filter((t) => t.done && t.began !== null).map((t) => [t.label, Math.round(t.ended - t.began)]);
  }
}

// The bar itself
class Progress extends ProgressModel {
  constructor(root) {
    super();
    this.root = root;
    this.fill = root?.querySelector('.hud-progress-fill');
    this.labelEl = root?.querySelector('.hud-progress-label');
    this.valueEl = root?.querySelector('.hud-progress-value');
    this.timer = null;
    this.shown = false;
  }

  start(label, weight) {
    const handle = super.start(label, weight);
    this.wake();
    const done = handle.done;
    handle.done = () => {
      done();
      this.wake();
    };
    return handle;
  }

  wake() {
    if (this.timer || !this.root) return;
    this.timer = setInterval(() => this.paint(), PAINT_MS);
  }

  paint() {
    const { visible, value, label } = this.state();
    if (visible !== this.shown) {
      this.shown = visible;
      this.root.hidden = false;
      this.root.classList.toggle('is-shown', visible);
      this.root.setAttribute('aria-hidden', String(!visible));
    }
    if (visible) {
      const percent = Math.round(value * 100);
      if (this.fill) this.fill.style.transform = `scaleX(${value.toFixed(3)})`;
      if (this.labelEl && this.labelEl.textContent !== label) this.labelEl.textContent = label;
      if (this.valueEl) this.valueEl.textContent = `${percent}%`;
      this.root.setAttribute('aria-valuenow', String(percent));
      this.root.setAttribute('aria-valuetext', `${label}, ${percent}%`);
    }
    // Nothing left to show: stop the timer until the next task
    if (!this.busy && !visible) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export { HIDE_AFTER_MS, Progress, ProgressModel, SHOW_AFTER_MS };
