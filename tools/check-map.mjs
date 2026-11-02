// The road check over all of the map, by block in parallel, since one process holding it all takes too long and too much memory. Each block
// holds its own tiles and one more all round, and reports only on its own. Says how many tiles pass, and which don't.
// usage: node tools/check-map.mjs [--json]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BLOCK = 8, JOBS = 6;
const world = JSON.parse(fs.readFileSync(new URL('public/tiles/world.json', `file://${ROOT}`), 'utf8'));
const blocks = new Map();
for (const key of Object.keys(world.tiles)) {
  const [ix, iz] = key.split('_').map(Number);
  const b = `${Math.floor(ix / BLOCK)}_${Math.floor(iz / BLOCK)}`;
  if (!blocks.has(b)) blocks.set(b, []);
  blocks.get(b).push(key);
}
function checkBlock(name, keys) {
  const [bx, bz] = name.split('_').map(Number);
  const env = { ...process.env, SYDNEY_TILES: [bx * BLOCK - 1, bz * BLOCK - 1, (bx + 1) * BLOCK, (bz + 1) * BLOCK].join(',') };
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--max-old-space-size=5000', 'tools/check-roads.mjs', '--json', '--by-tile', `--tiles=${keys.join(',')}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', (status) => (status ? reject(new Error(`block ${name}: ${status}`)) : resolve(JSON.parse(out))));
  });
}
const names = [...blocks.keys()];
const results = [];
let next = 0;
const started = Date.now();
await Promise.all(Array.from({ length: JOBS }, async () => {
  while (next < names.length) {
    const name = names[next++];
    results.push(await checkBlock(name, blocks.get(name)));
  }
}));

// Shares by the distance they're of, totals added, and the worst of the worsts
const share = (get, km) => {
  const total = results.reduce((t, r) => t + km(r), 0);
  return +(results.reduce((t, r) => t + get(r) * km(r), 0) / total).toFixed(2);
};
const sum = (get) => results.reduce((t, r) => t + get(r), 0);
const worst = (get) => Math.max(...results.map(get));
const places = (get) => results.flatMap((r) => get(r).where || []).sort((a, b) => b[0] - a[0]).slice(0, 12);
const failing = results.flatMap((r) => r.byTile.failing);
const tiles = Object.keys(world.tiles).length;
const report = {
  tiles, passing: tiles - failing.length, share: +((1 - failing.length / tiles) * 100).toFixed(1), failing,
  lean: { km: Math.round(sum((r) => r.lean.km)), over4: share((r) => r.lean.over4, (r) => r.lean.km), over6: share((r) => r.lean.over6, (r) => r.lean.km), over10: share((r) => r.lean.over10, (r) => r.lean.km), worst: worst((r) => r.lean.worst) },
  grade: { over3: share((r) => r.grade.over3, (r) => r.grade.km), over6: share((r) => r.grade.over6, (r) => r.grade.km), worst: worst((r) => r.grade.worst) },
  lanes: {
    km: sum((r) => r.lanes.km),
    stops: { metres: sum((r) => r.lanes.stops.metres), places: sum((r) => r.lanes.stops.places), where: places((r) => r.lanes.stops) },
    step: { over5cm: sum((r) => r.lanes.step.over5cm), over25cm: sum((r) => r.lanes.step.over25cm), worst: worst((r) => r.lanes.step.worst) },
    roll: { over2: sum((r) => r.lanes.roll.over2), over4: sum((r) => r.lanes.roll.over4), worst: worst((r) => r.lanes.roll.worst) },
    buildings: { metres: sum((r) => r.lanes.buildings.metres), places: sum((r) => r.lanes.buildings.places) },
    kerbs: { metres: sum((r) => r.lanes.kerbs.metres), places: sum((r) => r.lanes.kerbs.places), middle: sum((r) => r.lanes.kerbs.middle) }
  },
  paving: { share: share((r) => r.paving.areaShare, (r) => r.lean.km), centreLine: sum((r) => r.paving.centreLine.places) },
  traffic: { offRoad: share((r) => r.traffic.offRoad, (r) => r.traffic.km), overKerb: share((r) => r.traffic.overKerb, (r) => r.traffic.km) },
  seconds: Math.round((Date.now() - started) / 1000)
};
if (process.argv.includes('--json')) console.log(JSON.stringify(report));
else {
  const l = report.lanes;
  console.log(`tiles     ${report.passing} of ${tiles} pass, ${report.share}%, in ${report.seconds} s`);
  console.log(`lean      ${report.lean.km} km: ${report.lean.over4}% over 4%, ${report.lean.over6}% over 6%, ${report.lean.over10}% over 10%, worst ${report.lean.worst}%`);
  console.log(`grade     ${report.grade.over3}% change over 3%, ${report.grade.over6}% over 6%, worst ${report.grade.worst}%`);
  console.log(`stops     ${l.km} lane km: ${l.stops.metres} m at ${l.stops.places} places  ${l.stops.where.map(([, x, z, n]) => `${n} (${x}, ${z})`).join('; ')}`);
  console.log(`step      ${l.step.over5cm} m over 5 cm, ${l.step.over25cm} m over 25 cm, worst ${l.step.worst} m`);
  console.log(`roll      ${l.roll.over2} m over 2% a metre, ${l.roll.over4} m over 4%, worst ${l.roll.worst}%`);
  console.log(`buildings ${l.buildings.metres} m at ${l.buildings.places} places`);
  console.log(`kerbs     ${l.kerbs.metres} m at ${l.kerbs.places} places, the car's middle on one for ${l.kerbs.middle} m`);
  console.log(`paving    ${report.paving.share}% of road area, centre line ${report.paving.centreLine} places`);
  console.log(`traffic   ${report.traffic.offRoad}% off every carriageway, ${report.traffic.overKerb}% over a kerb island`);
  for (const t of failing.sort((a, b) => b.stops + b.step - a.stops - a.step)) console.log(`          ${t.key}: stops ${t.stops}, steps ${t.step}, buildings ${t.buildings}, kerbs ${t.kerbs}`);
}
