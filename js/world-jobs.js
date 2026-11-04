// The city is too big to build before the first frame, so its builders are generators. They run until they yield
// Ready, which marks the point where the starting view is complete. WorldBuilder then resumes them a few milliseconds
// per frame while the game is already playable.

class Ready {
  constructor(value) {
    this.value = value;
  }
}

function runUntilReady(job) {
  for (;;) {
    const { value, done } = job.next();
    if (done || value instanceof Ready) return value instanceof Ready ? value.value : value;
  }
}

function runToEnd(job) {
  let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
}

// A job yields this when it has nothing to do this frame
const IDLE = Symbol('idle');

// What the jobs are doing, in a word or two, set by each as it starts something: so a slow frame can say what held it up
// (?stats=1, js/frame-stats.js)
const activity = { label: 'building' };

class WorldBuilder {
  constructor(job) {
    this.job = job;
    this.waiting = false;
    this.done = false;
  }

  // A job can yield a promise to wait for async work, such as shader compiles, without holding up any frames.
  // `longest` is the single longest piece of work in the last step, and what it was: { label, ms }
  step(budgetMs) {
    this.longest = { label: '', ms: 0 };
    if (this.done || this.waiting) return;
    const deadline = performance.now() + budgetMs;
    do {
      const started = performance.now();
      const { value, done } = this.job.next();
      const ms = performance.now() - started;
      if (ms > this.longest.ms) this.longest = { label: activity.label, ms };
      if (done) {
        this.done = true;
        return;
      }
      if (value === IDLE) return;
      if (typeof value?.then === 'function') {
        this.waiting = true;
        value.then(() => { this.waiting = false; });
        return;
      }
    } while (performance.now() < deadline);
  }
}

export { IDLE, Ready, WorldBuilder, activity, runToEnd, runUntilReady };
