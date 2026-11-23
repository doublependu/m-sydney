import assert from 'node:assert/strict';
import test from 'node:test';
import { heldTiles, isHeld } from '../js/geodata.js';
import { insideSpans, squareLots } from '../js/house-lots.js';
import { squareWorkNow as squareWork, tilesFor } from '../js/lot-details.js';
import { lotFileOf } from '../js/real-lots.js';

// Houses' lots as the game works them out from the map (js/lot-details.js squareWork()), on a square of Woollahra's houses, east of the
// inner city's paving, where the map draws lawns: no fence through a building, none on a footpath, each house inside its lot.
const SQUARE = { x0: 3000, z0: 0, x1: 3500, z1: 500 };

test('the lots of a square of Woollahra: fences off the buildings and the footpaths, each house in its lot', { skip: !tilesFor(SQUARE).every(isHeld) && 'its tiles aren\'t held' }, () => {
  const tiles = new Map(heldTiles().map((t) => [t.key, t]));
  const { entries, env } = squareWork(SQUARE, tiles);
  const job = squareLots(entries, env, SQUARE);
  let step = job.next();
  while (!step.done) step = job.next();
  const { lots, fences, slabs } = step.value;
  assert.ok(lots.length > 50 && fences.length > 50 && slabs.length > 10, `${lots.length} lots, ${fences.length} fences, ${slabs.length} slabs`);
  const rings = entries.flatMap(({ b }) => b.polygons.map((p) => p.outer));
  let metres = 0;
  for (const f of fences) {
    const L = Math.hypot(f.b.x - f.a.x, f.b.z - f.a.z);
    metres += L;
    const near = rings.filter((r) => r.some((p) => Math.abs(p.x - f.a.x) < L + 40 && Math.abs(p.z - f.a.z) < L + 40));
    const inside = insideSpans(f.a, f.b, near).reduce((sum, [t0, t1]) => sum + (t1 - t0) * L, 0);
    assert.ok(inside < 0.01, `a fence from (${f.a.x.toFixed(1)}, ${f.a.z.toFixed(1)}) goes ${inside.toFixed(2)} m through a building`);
    // Every half metre of it on the lawn, not the footpath
    let off = 0;
    for (let s = 0.25; s < L - 0.2; s += 0.5) if (!env.onLawn(f.a.x + ((f.b.x - f.a.x) * s) / L, f.a.z + ((f.b.z - f.a.z) * s) / L)) off++;
    assert.ok(off <= 1, `a fence from (${f.a.x.toFixed(1)}, ${f.a.z.toFixed(1)}) has ${off} half metres on the footpath`);
  }
  assert.ok(metres > 1000, `${Math.round(metres)} m of fences`);
  for (const lot of lots) {
    let inside = false;
    for (let i = 0, j = lot.pts.length - 1; i < lot.pts.length; j = i++) {
      const a = lot.pts[i], b = lot.pts[j];
      if ((a.z > lot.home.cz) !== (b.z > lot.home.cz) && lot.home.cx < ((b.x - a.x) * (lot.home.cz - a.z)) / (b.z - a.z) + a.x) inside = !inside;
    }
    assert.ok(inside, `the house at (${lot.home.cx.toFixed(1)}, ${lot.home.cz.toFixed(1)}) is in its lot`);
  }
});

// The same square's lines before the cut (squareLots()'s env.lines): none 0.3 m or more inside a house, a building of 80 m² or more or a
// site, other than a terrace row's fences through its own row, a fence along a road behind a house that stands over its line (it meets
// the house's walls), and two buildings that no straight line separates; no lot over any of
// those or over another lot by 1 m² or more, other than such a pair (one the overlaps would have added, or neighbours whose outlines
// overlap, whose line can't clear both); and the square beside it works out the same lines along the edge they share. Where there are
// real lots (js/real-lots.js), their lines and lots are as surveyed: the next test has theirs
const EAST = { x0: 3500, z0: 0, x1: 4000, z1: 500 };
const REAL_KINDS = new Set(['side', 'moved', 'bound', 'wall']); // a real lot's lines' kinds (js/house-lots.js addReal())
test('the lines of a square of Woollahra before the cut: off the buildings, no lot over another or over a building, the same as the square beside it\'s', { skip: ![SQUARE, EAST].every((s) => tilesFor(s).every(isHeld)) && 'its tiles aren\'t held' }, () => {
  const tiles = new Map(heldTiles().map((t) => [t.key, t]));
  const linesOf = (square) => {
    const { entries, env } = squareWork(square, tiles);
    env.lines = true;
    const job = squareLots(entries, env, square);
    let step = job.next();
    while (!step.done) step = job.next();
    return step.value;
  };
  const here = linesOf(SQUARE), east = linesOf(EAST);
  const { obstacles, unseparated, pairs } = here.measure;
  const apart = (h, q) => unseparated.some((u) => (u.home === h && u.other === q) || (u.home === q && u.other === h))
    || pairs.get(h)?.has(q) || pairs.get(q)?.has(h);
  const real = (line) => REAL_KINDS.has(line.kind) || line.homes.some((h) => h.real);
  const partnerOf = (o) => o.partner;
  assert.ok(here.lines.filter((l) => l.own).length > 150, `${here.lines.filter((l) => l.own).length} lines of its own`);
  const into = [];
  for (const line of here.lines) {
    if (!line.own || real(line)) continue;
    const L = Math.hypot(line.b.x - line.a.x, line.b.z - line.a.z);
    for (const o of obstacles) {
      if (o.small || o.box.x1 < Math.min(line.a.x, line.b.x) - 1 || o.box.x0 > Math.max(line.a.x, line.b.x) + 1
        || o.box.z1 < Math.min(line.a.z, line.b.z) - 1 || o.box.z0 > Math.max(line.a.z, line.b.z) + 1) continue;
      if (line.kind === 'row' && line.homes.includes(o.whole)) continue;
      const f = line.homes[0].frame;
      if (line.kind === 'road' && line.homes.includes(o.whole) && Math.abs((line.b.x - line.a.x) * f.nx + (line.b.z - line.a.z) * f.nz) <= 0.3 * L) continue;
      if (line.homes.some((h) => apart(h, partnerOf(o)))) continue;
      const inside = insideSpans(line.a, line.b, o.rings).reduce((sum, [t0, t1]) => sum + (t1 - t0) * L, 0);
      if (inside >= 0.3) into.push(`a ${typeof line.kind === 'string' ? line.kind : 'pair'} line from (${line.a.x.toFixed(1)}, ${line.a.z.toFixed(1)}) runs ${inside.toFixed(2)} m inside the building at (${o.box.x0.toFixed(1)}, ${o.box.z0.toFixed(1)})`);
    }
  }
  assert.deepEqual(into, []);
  const area = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j].x - r[i].x) * (r[j].z + r[i].z); return s / 2; };
  const clipped = (subject, clip) => {
    let out = subject;
    const s = Math.sign(area(clip));
    for (let i = 0; i < clip.length && out.length; i++) {
      const a = clip[i], b = clip[(i + 1) % clip.length];
      const side = (p) => s * ((b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x));
      const inp = out;
      out = [];
      for (let k = 0; k < inp.length; k++) {
        const p = inp[k], q = inp[(k + 1) % inp.length], sp = side(p), sq = side(q);
        if (sp >= 0) out.push(p);
        if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t }); }
      }
    }
    return Math.abs(area(out));
  };
  const over = [];
  for (const lot of here.lots) {
    if (lot.real) continue;
    for (const o of obstacles) {
      if (o.small || o.whole === lot.home || apart(lot.home, partnerOf(o))) continue;
      const a = o.rings.reduce((sum, r) => sum + clipped(r, lot.pts), 0);
      if (a >= 1) over.push(`the lot of (${lot.home.cx.toFixed(1)}, ${lot.home.cz.toFixed(1)}) covers ${a.toFixed(1)} m² of the building at (${o.box.x0.toFixed(1)}, ${o.box.z0.toFixed(1)})`);
    }
  }
  for (let i = 0; i < here.lots.length; i++) {
    for (let j = i + 1; j < here.lots.length; j++) {
      const a = here.lots[i], b = here.lots[j];
      if (apart(a.home, b.home) || a.real || b.real) continue;
      const m2 = clipped(a.pts, b.pts);
      if (m2 >= 1) over.push(`the lots of (${a.home.cx.toFixed(1)}, ${a.home.cz.toFixed(1)}) and (${b.home.cx.toFixed(1)}, ${b.home.cz.toFixed(1)}) overlap by ${m2.toFixed(1)} m²`);
    }
  }
  assert.deepEqual(over, []);
  // Along x = 3500: each square's own lines within 40 m of it, among the other's, end to end within 2 cm
  const same = (f, g) => (Math.hypot(g.a.x - f.a.x, g.a.z - f.a.z) < 0.02 && Math.hypot(g.b.x - f.b.x, g.b.z - f.b.z) < 0.02)
    || (Math.hypot(g.a.x - f.b.x, g.a.z - f.b.z) < 0.02 && Math.hypot(g.b.x - f.a.x, g.b.z - f.a.z) < 0.02);
  let checked = 0;
  const differ = [];
  for (const [mine, theirs] of [[here, east], [east, here]]) {
    for (const f of mine.lines) {
      if (!f.own || Math.abs((f.a.x + f.b.x) / 2 - EAST.x0) > 40) continue;
      checked++;
      if (!theirs.lines.some((g) => same(f, g))) differ.push(`(${f.a.x.toFixed(1)}, ${f.a.z.toFixed(1)}) to (${f.b.x.toFixed(1)}, ${f.b.z.toFixed(1)})`);
    }
  }
  assert.ok(checked > 40, `${checked} lines along the edge`);
  assert.deepEqual(differ, []);
});

// The same square with real lots (js/real-lots.js: the build's lot files, or a folder of them SYDNEY_LOTS names), where there are any:
// most houses on theirs, each house's lot its real one, cut at its front line or brought forward to it; no line up the side of a house
// of the lots either side of it through that house (on both sides of one it runs a metre or more inside: two outlines drawn into each
// other along it, a shared wall); each line once; and no lot worked out from the map over a real lot by 1 m² or more, but where its house stands
// over that lot. The square beside it works out the same lines along their edge in the test above. A line through another building is
// cut at its walls, as a real line runs where it's surveyed (the first test).
const PANEL = 2.4;
test('a square of Woollahra on its real lots: each house\'s lot its own, no fence line through a house, each line once, other lots off them', { skip: (!tilesFor(SQUARE).every(isHeld) && 'its tiles aren\'t held') || (!tilesFor(SQUARE).some(lotFileOf) && 'no lot files') }, () => {
  const tiles = new Map(heldTiles().map((t) => [t.key, t]));
  const { entries, env } = squareWork(SQUARE, tiles);
  env.lines = true;
  const job = squareLots(entries, env, SQUARE);
  let step = job.next();
  while (!step.done) step = job.next();
  const { lots, lines, measure } = step.value;
  const { rules, obstacles } = measure;
  assert.ok(rules.real + rules.several > 2 * (rules.fallback + rules.none) || rules.real > 150, JSON.stringify(rules));
  const near = (p, ring) => {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i], L2 = (b.x - a.x) ** 2 + (b.z - a.z) ** 2 || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.z - a.z) * (b.z - a.z)) / L2));
      if (Math.hypot(a.x + (b.x - a.x) * t - p.x, a.z + (b.z - a.z) * t - p.z) < 0.05) return true;
    }
    return false;
  };
  const inRing = (ring, x, z) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) c = !c;
    }
    return c;
  };
  const depth = (f, p) => (p.x - f.px) * f.nx + (p.z - f.pz) * f.nz;
  const off = [];
  for (const lot of lots) {
    const ring = lot.home.real?.ring;
    if (!ring) continue;
    for (const p of lot.pts) {
      if (inRing(ring, p.x, p.z) || near(p, ring) || depth(lot.frame, p) <= lot.front + 3.1) continue;
      off.push(`a corner of the lot of (${lot.home.cx}, ${lot.home.cz}) at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) is off its real lot`);
      break;
    }
  }
  assert.deepEqual(off, []);
  const through = [];
  for (const line of lines) {
    if (!line.own || !REAL_KINDS.has(line.kind)) continue;
    const L = Math.hypot(line.b.x - line.a.x, line.b.z - line.a.z);
    for (const o of obstacles) {
      // Up the side of the house it runs through, which has a street: along it, it's that house's back line, which it stands over
      const f = o.whole?.frame;
      if (!line.homes.includes(o.whole) || !f || Math.abs((line.b.x - line.a.x) * f.nx + (line.b.z - line.a.z) * f.nz) < 0.7 * L) continue;
      const spans = insideSpans(line.a, line.b, o.rings);
      if (spans.reduce((s, [t0, t1]) => s + (t1 - t0) * L, 0) < 1) continue;
      const t0 = Math.min(...spans.map((s) => s[0])), t1 = Math.max(...spans.map((s) => s[1]));
      if (t0 * L - 0.15 >= PANEL / 2 && (1 - t1) * L - 0.15 >= PANEL / 2) through.push(`a ${line.kind} line from (${line.a.x.toFixed(1)}, ${line.a.z.toFixed(1)}) goes through the house at (${o.whole.cx}, ${o.whole.cz})`);
    }
  }
  assert.deepEqual(through, []);
  // Each line once: no two of the square's real lines along each other for 0.3 m or more
  const real = lines.filter((l) => l.own && REAL_KINDS.has(l.kind));
  const twice = [];
  for (let i = 0; i < real.length; i++) {
    const a = real[i], L = Math.hypot(a.b.x - a.a.x, a.b.z - a.a.z), ux = (a.b.x - a.a.x) / L, uz = (a.b.z - a.a.z) / L;
    for (let j = i + 1; j < real.length; j++) {
      const b = real[j];
      const across = (p) => Math.abs((p.x - a.a.x) * uz - (p.z - a.a.z) * ux), along = (p) => (p.x - a.a.x) * ux + (p.z - a.a.z) * uz;
      if (across(b.a) > 0.02 || across(b.b) > 0.02) continue;
      const lo = Math.max(0, Math.min(along(b.a), along(b.b))), hi = Math.min(L, Math.max(along(b.a), along(b.b)));
      if (hi - lo >= 0.3) twice.push(`(${a.a.x.toFixed(1)}, ${a.a.z.toFixed(1)}) to (${a.b.x.toFixed(1)}, ${a.b.z.toFixed(1)}) twice, for ${(hi - lo).toFixed(1)} m`);
    }
  }
  assert.deepEqual(twice, []);
  // Lots worked out from the map off the real ones (each convex, so it clips a real lot's ring)
  const area = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j].x - r[i].x) * (r[j].z + r[i].z); return Math.abs(s / 2); };
  const clipped = (subject, clip) => {
    let out = subject;
    let s = 0;
    for (let i = 0, j = clip.length - 1; i < clip.length; j = i++) s += (clip[j].x - clip[i].x) * (clip[j].z + clip[i].z);
    for (let i = 0; i < clip.length && out.length; i++) {
      const a = clip[i], b = clip[(i + 1) % clip.length];
      const side = (p) => Math.sign(s) * ((b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x));
      const inp = out;
      out = [];
      for (let k = 0; k < inp.length; k++) {
        const p = inp[k], q = inp[(k + 1) % inp.length], sp = side(p), sq = side(q);
        if (sp >= 0) out.push(p);
        if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t }); }
      }
    }
    return area(out);
  };
  const over = [];
  for (const lot of lots) {
    if (lot.real) continue;
    for (const other of lots) {
      if (!other.home.real) continue;
      const m2 = clipped(other.pts, lot.pts);
      if (m2 < 1 || lot.home.pts.some((p) => inRing(other.home.real.ring, p.x, p.z))) continue;
      over.push(`the lot of (${lot.home.cx}, ${lot.home.cz}) covers ${m2.toFixed(1)} m² of the real lot of (${other.home.cx}, ${other.home.cz})`);
    }
  }
  assert.deepEqual(over, []);
});

// The same square's verges (js/verge.js) and the lots' things (js/lot-things.js): every bit of the strips over the paving as drawn, the
// highest of it where two pieces overlap, and the footpath over the front yards' lawn where that comes out over it; nothing of a lot's
// things inside a building
test('the verges of a square of Woollahra lie over its paving, and the lots\' things stand out of the buildings', { skip: !tilesFor(SQUARE).every(isHeld) && 'its tiles aren\'t held' }, async () => {
  const { squareVerge } = await import('../js/verge.js');
  const tiles = new Map(heldTiles().map((t) => [t.key, t]));
  const { entries, env } = squareWork(SQUARE, tiles);
  const run = (job) => { let step = job.next(); while (!step.done) step = job.next(); return step.value; };
  const result = run(squareLots(entries, env, SQUARE));
  const verge = run(squareVerge(result.fronting, env, SQUARE));
  assert.ok(verge.sides.some((s) => s.strip), 'some sides have a nature strip');
  const height = (t, x, z) => {
    const [a, b, c] = t, d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d, l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
    return l1 >= -1e-6 && l2 >= -1e-6 && 1 - l1 - l2 >= -1e-6 ? l1 * a[1] + l2 * b[1] + (1 - l1 - l2) * c[1] : null;
  };
  const top = (tris, x, z) => Math.max(-Infinity, ...tris.map((t) => height(t, x, z)).filter((y) => y !== null));
  const all = [];
  for (const c of [...verge.lawn, ...verge.path]) for (let i = 0; i < c.pos.length; i += 9) all.push([0, 3, 6].map((k) => [c.pos[i + k] + c.x, c.pos[i + k + 1], c.pos[i + k + 2] + c.z]));
  assert.ok(all.length > 500, `${all.length} triangles of verge`);
  let checked = 0;
  for (let i = 0; i < all.length; i += 7) {
    const t = all[i], x = (t[0][0] + t[1][0] + t[2][0]) / 3, z = (t[0][2] + t[1][2] + t[2][2]) / 3;
    const paving = top(env.pavingTris(x - 0.01, z - 0.01, x + 0.01, z + 0.01), x, z);
    if (paving === -Infinity) continue;
    const near = all.filter((u) => Math.abs(u[0][0] - x) < 12 && Math.abs(u[0][2] - z) < 12);
    assert.ok(top(near, x, z) - (paving + 0.22) >= 0.009, `the verge at (${x.toFixed(1)}, ${z.toFixed(1)}) is over the paving`);
    checked++;
  }
  assert.ok(checked > 50);
  const rings = entries.flatMap(({ b }) => b.polygons.map((p) => p.outer));
  const inside = (ring, x, z) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) c = !c;
    }
    return c;
  };
  assert.ok(result.things.length > 100, `${result.things.length} things`);
  for (const b of result.things) assert.ok(!rings.some((r) => inside(r, b.x, b.z)), `a thing at (${b.x.toFixed(1)}, ${b.z.toFixed(1)}) is out of the buildings`);
});
