// The map is too big for one raster at 1 m, so what needs rasters is worked out a region at a time, each with a margin around it, in worker
// threads. Regions line up with the 240 m squares polygons are cut into, and with whole bytes of a shared bit raster.
import { Worker } from 'node:worker_threads';

export const REGION = 7200; // m
export const MARGIN = 1200; // m around one, so nearly everything that reaches over its edge is seen whole
const JOBS = 6; // Each holds up to about 1.5 GB

/** The regions that any of `rects` reaches into: { key, core, window } */
export function regionsOver(rects) {
  const x0 = Math.min(...rects.map((r) => r.x0)), x1 = Math.max(...rects.map((r) => r.x1));
  const z0 = Math.min(...rects.map((r) => r.z0)), z1 = Math.max(...rects.map((r) => r.z1));
  const out = [];
  for (let iz = Math.floor(z0 / REGION); iz * REGION < z1; iz++) {
    for (let ix = Math.floor(x0 / REGION); ix * REGION < x1; ix++) {
      const core = { x0: ix * REGION, z0: iz * REGION, x1: (ix + 1) * REGION, z1: (iz + 1) * REGION };
      if (!rects.some((r) => r.x0 < core.x1 && r.x1 > core.x0 && r.z0 < core.z1 && r.z1 > core.z0)) continue;
      out.push({ key: `${ix}_${iz}`, core, window: { x0: core.x0 - MARGIN, z0: core.z0 - MARGIN, x1: core.x1 + MARGIN, z1: core.z1 + MARGIN } });
    }
  }
  return out;
}

/** Runs each of `jobs` (one a message to tools/geodata/region-worker.mjs) on a pool of workers. Results come back in the order of `jobs`. */
export function runJobs(shared, jobs) {
  const results = new Array(jobs.length);
  let next = 0, done = 0;
  return new Promise((resolve, reject) => {
    if (!jobs.length) resolve(results);
    const workers = Array.from({ length: Math.min(JOBS, jobs.length) }, () => {
      const worker = new Worker(new URL('./region-worker.mjs', import.meta.url), { workerData: shared, resourceLimits: { maxOldGenerationSizeMb: 6000 } });
      let current = -1;
      const give = () => {
        if (next >= jobs.length) { worker.terminate(); return; }
        current = next++;
        worker.postMessage(jobs[current]);
      };
      worker.on('message', (result) => {
        results[current] = result;
        if (++done === jobs.length) { for (const w of workers) w.terminate(); resolve(results); return; }
        give();
      });
      worker.on('error', reject);
      give();
      return worker;
    });
  });
}

/** Whether a stretch of outline runs along the edge of a region: where a very big island was cut in two, and no kerb or shore */
export const onRegionEdge = (ax, az, bx, bz) => {
  const near = (v) => Math.abs(v - Math.round(v / REGION) * REGION) < 1.5;
  return (near(ax) && near(bx)) || (near(az) && near(bz));
};
