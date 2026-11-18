// tools/heights/ease-profiles.mjs: eases roads' profiles where their grade changes sharply, for tools/build-heights.mjs. Its solve
// keeps every road within MAX_GRADE and clear of what it crosses, but where a slope meets a flat stretch, or a dip its floor, the
// grade can change by 10% or more within 10 m: a bump you feel in a car. Each such change is replaced by a smooth curve, as long as
// the change needs and no longer, so the rest of the road stays as it was.
//
// What never moves: a locked point (a road's ends, which other roads share, and the fixed heights: the Harbour Bridge's deck and
// what's given by hand). What never gets worse: a point's bounds, which carry the clearances over and under other roads and a
// tunnel's cover. Where a curve would break one, a curve on one side of the road as it was is tried: a crest held up by a clearance
// (a bridge's hump over a road) only rises, round its top, and a dip held down (a tunnel under a road, a cutting at the ground) only
// sinks. Those need about twice the length, and steepen the road beside the change a little, never past STEEPEST. A curve that still
// breaks a bound is shortened, and failing that, the change is left as it was.

/** How a change of grade is measured and eased */
export const EASE = {
  WINDOW: 10, // m back and ahead: the grade either side, as tools/check-roads.mjs measures a change of grade
  TRIGGER: 0.03, // a change over this is eased
  PER_GRADE: 6, // m of curve for each 1% of change: eased, the change reads under 2% (10 m / 6 m), about 2.2% between points 13 m apart
  MIN: 10, // m: a curve shorter than this does nothing a car would feel
  MAX: 100, // m: a change of 20% or more is eased over this, and no further
  ONE_SIDED: 10, // m for each 1% of change, on one side: its curve bends about three times as sharply for the same length
  MAX_ONE_SIDED: 160, // m
  ONE_SIDED_LEAVES: 0.06, // ...and kept only if it leaves no change over this near it: else it spreads a sharp change over a longer stretch
  STEEPEST: 0.12, // an eased road is no steeper than this, or than it was there
  SLOPE: 5, // m beyond each end of a curve that its grade there is taken over
  TOLERANCE: 0.01 // m a point may stray outside its bounds by rounding
};

/** The height at distance d along a profile, straight between its points */
function heightAt(s, y, d) {
  let lo = 0, hi = s.length - 1;
  if (d <= s[0]) return y[0];
  if (d >= s[hi]) return y[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid] <= d) lo = mid; else hi = mid;
  }
  const t = (d - s[lo]) / (s[hi] - s[lo] || 1);
  return y[lo] + (y[hi] - y[lo]) * t;
}

/** The change of grade at point i, over EASE.WINDOW back and ahead; 0 where either runs off the profile */
export function gradeChange(s, y, i) {
  const W = EASE.WINDOW;
  if (s[i] - W < s[0] - 1e-9 || s[i] + W > s[s.length - 1] + 1e-9) return 0;
  return Math.abs((heightAt(s, y, s[i] + W) - y[i]) / W - (y[i] - heightAt(s, y, s[i] - W)) / W);
}

const outside = (y, lo, hi) => Math.max(0, lo - y, y - hi);

/**
 * Eases one profile in place. s: distances along it, increasing; y: heights; lo, hi: each point's bounds (±Infinity where there's
 * none); locked: whether each point must stay as it is (the ends always do). Returns the curves made, each { from, to, before }: the
 * points it moved and their heights before, so a caller can put them back.
 */
export function easeProfile(s, y, lo, hi, locked) {
  const n = s.length, curves = [];
  if (n < 5 || s[n - 1] - s[0] < 2 * EASE.WINDOW) return curves;
  const fixedAt = (i) => i === 0 || i === n - 1 || locked[i];
  const tried = new Uint8Array(n);
  // The sharpest change between two points of [i0, i1]
  const sharpest = (i0, i1) => {
    let worst = 0;
    for (let i = Math.max(1, i0); i <= Math.min(n - 2, i1); i++) worst = Math.max(worst, gradeChange(s, y, i));
    return worst;
  };
  const indexAt = (d) => { let i = 0; while (i < n - 1 && s[i + 1] <= d) i++; return i; };
  // The grade just beyond a curve's end, as the road comes into it: from outside where there's room, else from inside
  const slopeBeyond = (d, dir) => {
    const D = EASE.SLOPE;
    const far = dir < 0 ? Math.max(s[0], d - D) : Math.min(s[n - 1], d + D);
    if (Math.abs(far - d) > 1) return dir < 0 ? (heightAt(s, y, d) - heightAt(s, y, far)) / (d - far) : (heightAt(s, y, far) - heightAt(s, y, d)) / (far - d);
    const inner = dir < 0 ? Math.min(s[n - 1], d + D) : Math.max(s[0], d - D);
    return (heightAt(s, y, inner) - heightAt(s, y, d)) / (inner - d);
  };
  // The steepest grade between points i0 and i1
  const steepest = (i0, i1) => {
    let worst = 0;
    for (let k = Math.max(1, i0); k <= Math.min(n - 1, i1); k++) worst = Math.max(worst, Math.abs(y[k] - y[k - 1]) / (s[k] - s[k - 1] || 1));
    return worst;
  };
  const tryAt = (c, change) => {
    // Room either side: up to the nearest locked point
    let left = c, right = c;
    while (left > 0 && !fixedAt(left)) left--;
    while (right < n - 1 && !fixedAt(right)) right++;
    const W = EASE.WINDOW, crest = (heightAt(s, y, s[c] + W) - y[c]) / W < (y[c] - heightAt(s, y, s[c] - W)) / W;
    for (const oneSided of [false, true]) {
      const [per, most] = oneSided ? [EASE.ONE_SIDED, EASE.MAX_ONE_SIDED] : [EASE.PER_GRADE, EASE.MAX];
      let half = Math.min(Math.max(EASE.MIN, Math.min(most, per * change * 100)) / 2, s[c] - s[left], s[right] - s[c]);
      for (; 2 * half >= EASE.MIN; half *= 0.7) {
        const a = s[c] - half, b = s[c] + half, h = b - a;
        const ya = heightAt(s, y, a), yb = heightAt(s, y, b), ma = slopeBeyond(a, -1), mb = slopeBeyond(b, 1);
        const from = indexAt(a) + 1;
        let to = from;
        while (to < n && s[to] < b - 1e-9) to++;
        to--;
        if (to < from) return false;
        const before = y.slice(from, to + 1);
        const i0 = indexAt(a - EASE.WINDOW), i1 = indexAt(b + EASE.WINDOW) + 1;
        const worstBefore = sharpest(i0, i1), steepBefore = steepest(from, to + 1);
        // A cubic from the road's height and grade at one end to its height and grade at the other...
        const eased = new Float64Array(to - from + 1), bump = new Float64Array(to - from + 1);
        for (let k = from; k <= to; k++) {
          const t = (s[k] - a) / h, t2 = t * t, t3 = t2 * t;
          eased[k - from] = (2 * t3 - 3 * t2 + 1) * ya + (t3 - 2 * t2 + t) * h * ma + (-2 * t3 + 3 * t2) * yb + (t3 - t2) * h * mb;
          bump[k - from] = 16 * t2 * (1 - t) * (1 - t);
        }
        // ...and on one side, as little of a bump as keeps it over the road as it was at a crest, under it at a dip: a bump that's level
        // with the road at both ends, so the curve still meets it there
        if (oneSided) {
          let lift = 0;
          for (let k = 0; k < eased.length; k++) {
            if (bump[k] < 0.05) continue;
            const need = (before[k] - eased[k]) / bump[k];
            lift = crest ? Math.max(lift, need) : Math.min(lift, need);
          }
          for (let k = 0; k < eased.length; k++) eased[k] += lift * bump[k];
        }
        let fits = true;
        for (let k = from; k <= to; k++) {
          if (outside(eased[k - from], lo[k], hi[k]) > outside(y[k], lo[k], hi[k]) + EASE.TOLERANCE) { fits = false; break; }
        }
        if (fits) {
          for (let k = from; k <= to; k++) y[k] = eased[k - from];
          // Better where it was, nothing near it worse than the worst there was (a sharper change nearby that couldn't be eased doesn't
          // stop this one), and no steeper than STEEPEST, or than it was
          const worstAfter = sharpest(i0, i1);
          if (gradeChange(s, y, c) < change - 0.002 && worstAfter <= (oneSided ? Math.min(worstBefore, EASE.ONE_SIDED_LEAVES) : worstBefore) + 1e-6 && steepest(from, to + 1) <= Math.max(EASE.STEEPEST, steepBefore) + 1e-9) {
            curves.push({ from, to, before });
            for (let k = from; k <= to; k++) tried[k] = 1;
            return true;
          }
          before.forEach((v, k) => { y[from + k] = v; });
        }
      }
    }
    return false;
  };
  for (;;) {
    let c = -1, change = EASE.TRIGGER;
    for (let i = 1; i < n - 1; i++) {
      if (tried[i] || fixedAt(i)) continue;
      const g = gradeChange(s, y, i);
      if (g > change) { change = g; c = i; }
    }
    if (c < 0) break;
    if (!tryAt(c, change)) tried[c] = 1;
  }
  return curves;
}

/**
 * Eases every road's profile in a solved network, keeping each clearance. samples: [{ x, z, y, lo, hi, fixed }]; chains: each road's
 * points, as indices into samples, in order along it; partners: index -> indices of the points whose heights its bounds are worked out
 * from (the roads it crosses or runs over or under), both ways; rebound(): works out every point's lo and hi again from everyone's
 * heights; held: points that stay as they are, as fixed ones do. Each road is eased within its bounds as they were. Then, with every
 * road's new heights, a point pushed further outside its bounds than it was (two roads eased towards each other where they cross) puts
 * back the stretches that moved it or its partners, until none is. A stretch is a road's curves that overlap, put back together to the
 * heights before any easing.
 * dump(), if given, is called once the bounds are worked out, before anything moves. Returns { curves, stretches, undone, moved }:
 * curves made, stretches they make, stretches put back, points left moved.
 */
export function easeRoads({ samples, chains, partners, rebound, held = new Set(), dump }) {
  rebound();
  dump?.();
  const y0 = Float64Array.from(samples, (q) => q.y);
  const out0 = Float64Array.from(samples, (q) => outside(q.y, q.lo, q.hi));
  const stretchAt = new Map(); // point -> the stretch that moved it
  const stretches = [];
  let curves = 0;
  for (const chain of chains) {
    const n = chain.length;
    if (n < 5) continue;
    const s = new Float64Array(n), y = new Float64Array(n), lo = new Float64Array(n), hi = new Float64Array(n), locked = new Uint8Array(n);
    chain.forEach((idx, k) => {
      const q = samples[idx];
      s[k] = k ? s[k - 1] + Math.hypot(q.x - samples[chain[k - 1]].x, q.z - samples[chain[k - 1]].z) : 0;
      y[k] = q.y;
      lo[k] = q.lo;
      hi[k] = q.hi;
      locked[k] = q.fixed || held.has(idx) ? 1 : 0;
    });
    const made = easeProfile(s, y, lo, hi, locked).sort((p, q) => p.from - q.from);
    curves += made.length;
    let last = null;
    for (const c of made) {
      if (!last || c.from > last.to + 1) stretches.push((last = { from: c.from, to: c.to, chain }));
      else last.to = Math.max(last.to, c.to);
    }
    chain.forEach((idx, k) => { samples[idx].y = y[k]; });
  }
  for (const st of stretches) {
    st.points = st.chain.slice(st.from, st.to + 1);
    for (const idx of st.points) stretchAt.set(idx, st);
  }
  let undone = 0;
  for (let round = 0; round < 20; round++) {
    rebound();
    const blamed = new Set();
    for (const [idx] of stretchAt) {
      for (const k of [idx, ...(partners.get(idx) || [])]) {
        if (outside(samples[k].y, samples[k].lo, samples[k].hi) <= out0[k] + EASE.TOLERANCE) continue;
        for (const j of [k, ...(partners.get(k) || [])]) {
          const st = stretchAt.get(j);
          if (st && !st.undone) blamed.add(st);
        }
      }
    }
    if (!blamed.size) break;
    for (const st of blamed) {
      st.undone = true;
      undone++;
      for (const idx of st.points) samples[idx].y = y0[idx];
    }
  }
  let moved = 0;
  for (const [idx] of stretchAt) if (samples[idx].y !== y0[idx]) moved++;
  return { curves, stretches: stretches.length, undone, moved };
}
