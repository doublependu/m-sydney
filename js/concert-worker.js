// The concert's worker (js/concert.js): a performance's score from its seed, then the notes it plays rendered once, in the order the
// score first wants them, a few at a time, so the first can be played while the rest are still being made. Buffers the page already
// holds (`have`, from the performance before, in the same visit to the hall) aren't made again.
//   in:  { seed, have: [key] }
//   out: { score }, then { buffers: [{ key, rate, samples, loop }], ready } as they're made (their samples transferred; `ready` once the
//        first 12 s have all theirs), then { done: true }
import { arrange } from './concert-arranger.js';
import { bufferFor, renderBuffer } from './audio-instruments.js';

/** The buffer keys a score plays, by the time it first plays each */
function wanted(score, have = []) {
  const seen = new Set(have);
  const out = [];
  for (const n of score.notes) {
    const { key } = bufferFor(n.i, n.p, n.v);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, t: n.t });
  }
  return out;
}

self.onmessage = ({ data }) => {
  const started = performance.now();
  const score = arrange(data.seed);
  self.postMessage({ score, arrangedMs: performance.now() - started });
  // the first 12 s of the performance in the first batch; the rest in batches of 6
  const keys = wanted(score, data.have);
  let batch = [], transfer = [];
  const flush = () => {
    if (!batch.length) return;
    self.postMessage({ buffers: batch, ready: true }, transfer);
    batch = [];
    transfer = [];
  };
  for (const { key, t } of keys) {
    const buffer = renderBuffer(key);
    batch.push(buffer);
    transfer.push(buffer.samples.buffer);
    if (t > 12 && batch.length >= 6) flush();
  }
  flush();
  self.postMessage({ done: true, ms: performance.now() - started, rendered: keys.length });
};
