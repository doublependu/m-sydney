// tools/check-traffic.mjs: how well traffic moves, without a browser. The real js/traffic.js with nothing drawn, about 50 times
// faster than real time and with a seeded random number generator, so a change can be compared with what came before it. It runs
// on the whole map's roads with no pedestrians, and its numbers stay within about 20% of the game's.
//   stopped   share of the cars within 500 m of the place that are standing still
//   speed     their mean speed
//   queues    what holds each queue up, by what's holding the car at its front
//   no room   for the queues held by "no room ahead", what's at the end of that chain
//   red       how long the car at the front of a red has waited, median and 95th percentile
//   unused    how often, when a car waits at a red, nobody at all is using the green: no car within 60 m, none in the junction
//   recycled  cars a minute stuck long enough for the safety valve to take them away
//   wanted    how many cars the roads within 350 m want, by who lives and works there (js/places.js), at most --cars; and how many there were
//   people    how many people the place wants out walking, before the level's cap
// Traffic is chaotic enough that one seed can swing a result by 5%: use --seeds=3 to compare two versions.
// usage: node tools/check-traffic.mjs [--json] [--strict] [--seconds=240] [--warm=60] [--cars=200] [--seed=1] [--seeds=1] [--at=name,name]
console.info = () => {};
console.warn = () => {};
const argument = (name, fallback) => {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : fallback;
};
const json = process.argv.includes('--json');
const strict = process.argv.includes('--strict');
const SECONDS = Number(argument('seconds', 240));
const WARM = Number(argument('warm', 60));
const CARS = Number(argument('cars', 200));
const SEED = Number(argument('seed', 1));
const SEEDS = Number(argument('seeds', 1));
export const PLACES = {
  northSydney: [-100, -3300], townHall: [3, 30], bridgeDeck: [-120, -2600],
  burwood: [-9368, 1753], bondiJunction: [4088, 1430], chatswood: [-3548, -8025], m5: [-1741, 5498],
  deeWhy: [5309, -14416], parramatta: [-19517, -3772], hornsby: [-12477, -17210], sutherland: [-11279, 19282], cronulla: [-2105, 20668], palmBeach: [6476, -31602], seaforth: [2128, -8680],
  // Streets of houses near the centres: the most zoned R2 within 300 m, near the teleport
  cronullaHouses: [-3205, 20518], deeWhyHouses: [5009, -14566], bankstownHouses: [-16054, 7045], hornsbyHouses: [-12777, -16210]
};
const places = argument('at', 'northSydney,townHall').split(',');
const DT = 1 / 30;
const TRAFFIC_RADIUS = 1000; // js/main.js

// Same each time: mulberry32
function seedRandom(seed) {
  let state = seed >>> 0;
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const { heldList } = await import('../js/geodata.js');
// Only the textures on the cars want a document. js/geodata.js has already seen there isn't one: it holds the whole map under Node.
const nothing = () => new Proxy(function () {}, {
  get: (_, key) => (key === Symbol.toPrimitive ? () => 0 : key === 'width' || key === 'height' ? 256 : nothing()),
  set: () => true,
  apply: () => nothing()
});
globalThis.document = { createElement: () => ({ width: 256, height: 256, getContext: () => nothing(), style: {} }), baseURI: 'file:///' };
const { createTrafficSystem } = await import('../js/traffic.js');
const { buildRoadNetworkSteps } = await import('../js/road-network.js');
const THREE = await import('three/webgpu');

const points = heldList('signals');
const signals = [];
for (let i = 0; i < points.length; i += 2) signals.push({ x: points[i], z: points[i + 1] });

const CAUSES = [
  [/light red/, 'red light'], [/light amber/, 'amber'], [/box busy/, 'box busy'], [/no room/, 'no room ahead'], [/merging/, 'merging'],
  [/alongside/, 'alongside'], [/oncoming/, 'oncoming'], [/cross traffic/, 'cross traffic'], [/people/, 'people'],
  [/changing lane/, 'changing lane'], [/crossing/, 'in a junction'], [/lead|following/, 'following'], [/nowhere|no move/, 'no move']
];
const causeOf = (why) => (CAUSES.find(([pattern]) => pattern.test(why)) ?? [null, 'other'])[1];
const STOPPED = 0.5, NEAR = 500;
const share = (counts) => {
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round((v / total) * 100)]));
};
const quantile = (values, f) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? +sorted[Math.floor(sorted.length * f)].toFixed(1) : null;
};

async function measure(name, seed) {
  const [x, z] = PLACES[name];
  seedRandom(seed);
  // Roads as the game has them: a network around the player, whose rim counts as open road
  const roads = buildRoadNetworkSteps([], signals, { x, z, radius: TRAFFIC_RADIUS });
  let step;
  do step = roads.next(); while (!step.done);
  const job = createTrafficSystem(new THREE.Scene(), [], signals, { numCars: CARS, numBuses: Math.round(CARS * 0.06), numPeds: 0, lightPools: { headlights: [], policeLights: [] }, firstNetwork: step.value });
  do step = job.next(); while (!step.done);
  const system = step.value;
  const focus = new THREE.Vector3(x, 0, z);
  const fill = system.populate(focus);
  if (fill?.next) do step = fill.next(); while (!step.done);

  const t = { cars: 0, samples: 0, stopped: 0, speed: 0, queues: {}, chain: {}, redWaits: [], unused: 0, used: 0, active: 0, wanted: 0 };
  let time = 0, recycledAtStart = 0;
  const ticks = Math.round((WARM + SECONDS) / DT), warmTicks = Math.round(WARM / DT), every = Math.round(2 / DT);
  const started = performance.now();
  for (let i = 0; i < ticks; i++) {
    time += DT;
    system.update(DT, time, focus, null, 'helicopter', null);
    if (i === warmTicks) recycledAtStart = system.recycled();
    if (i <= warmTicks || i % every) continue;
    t.samples++;
    t.wanted += Math.min(CARS + Math.round(CARS * 0.06), system.roadRoom());
    for (const v of [...system.cars, ...system.buses]) if (v.edge) t.active++;
    for (const v of [...system.cars, ...system.buses]) {
      if (!v.edge || Math.hypot(v.x - x, v.z - z) > NEAR) continue;
      t.cars++;
      t.speed += v.speed;
      if (v.speed >= STOPPED) continue;
      t.stopped++;
      // The car at the front of this lane says why the queue is here
      let front = v, at = v.s;
      for (const o of v.edge.occ?.[v.lane] ?? []) if (o.s > at && o.v.speed < STOPPED) { front = o.v; at = o.s; }
      // Standing in the curve through a joint is only a queue going through it
      const cause = front.conn && front.edge.to.joint ? 'following' : causeOf(system.holdingBack(front));
      t.queues[cause] = (t.queues[cause] || 0) + 1;
      if (cause === 'no room ahead') {
        let u = front, end = 'a long chain';
        const seen = new Set();
        for (let hops = 0; hops < 40; hops++) {
          if (seen.has(u)) { end = 'a loop'; break; }
          seen.add(u);
          if (!u.move || u.conn) { end = 'a car in a junction'; break; }
          let last = null, lastS = -Infinity;
          for (const o of u.move.to.occ?.[u.move.out[u.lane]] ?? []) if (o.s > lastS) { lastS = o.s; last = o.v; }
          if (!last) { end = 'nothing there'; break; }
          if (last.speed >= STOPPED) { end = 'a moving car'; break; }
          const next = causeOf(system.holdingBack(last));
          if (next !== 'no room ahead') { end = next; break; }
          u = last;
        }
        t.chain[end] = (t.chain[end] || 0) + 1;
      }
      if (front === v && cause === 'red light') {
        t.redWaits.push(v.wait || 0);
        let busy = false;
        for (const n of v.edge.to.cluster) {
          if ((n.box || []).some((count, group) => count > 0 && group !== v.edge.axisIndex)) busy = true;
          for (const a of n.in) {
            if (a.lightGroup === v.edge.lightGroup) continue;
            for (const lane of a.occ) for (const o of lane) if (o.s > a.len - 60) busy = true;
          }
        }
        if (busy) t.used++;
        else t.unused++;
      }
    }
  }
  return {
    place: name,
    cars: Math.round(t.cars / t.samples),
    wanted: Math.round(t.wanted / t.samples),
    active: Math.round(t.active / t.samples),
    people: system.peopleWanted(),
    stopped: Math.round((t.stopped / (t.cars || 1)) * 100),
    speed: +(t.speed / (t.cars || 1)).toFixed(2),
    queues: share(t.queues),
    noRoomEndsAt: share(t.chain),
    redMedian: quantile(t.redWaits, 0.5),
    red95: quantile(t.redWaits, 0.95),
    unused: Math.round((t.unused / ((t.unused + t.used) || 1)) * 100),
    recycledPerMinute: +(((system.recycled() - recycledAtStart) / SECONDS) * 60).toFixed(1),
    seconds: +((performance.now() - started) / 1000).toFixed(1)
  };
}

const results = [];
for (const name of places) {
  const runs = [];
  for (let k = 0; k < SEEDS; k++) runs.push(await measure(name, SEED + k));
  // The mean of the numbers; what holds queues up, from the first
  const mean = (key) => +(runs.reduce((sum, r) => sum + (r[key] ?? 0), 0) / runs.length).toFixed(2);
  results.push({ ...runs[0], cars: mean('cars'), wanted: mean('wanted'), active: mean('active'), stopped: mean('stopped'), speed: mean('speed'), redMedian: mean('redMedian'), red95: mean('red95'), unused: mean('unused'), recycledPerMinute: mean('recycledPerMinute') });
}
if (json) console.log(JSON.stringify(results, null, 1));
else {
  for (const r of results) {
    console.log(`${r.place}: ${r.cars} cars within ${NEAR} m, ${r.active} out of ${r.wanted} wanted, ${r.people} people wanted, ${r.stopped}% stopped, ${r.speed} m/s, red ${r.redMedian} s median and ${r.red95} s 95th, green unused ${r.unused}%, ${r.recycledPerMinute} recycled a minute (${r.seconds} s)`);
    console.log(`  queues held by ${Object.entries(r.queues).slice(0, 6).map(([k, v]) => `${k} ${v}%`).join(', ')}`);
    console.log(`  no room ends at ${Object.entries(r.noRoomEndsAt).slice(0, 5).map(([k, v]) => `${k} ${v}%`).join(', ')}`);
  }
}

// What traffic reached after plan 3's Phases D and E, with a little room for how much one seed can swing. It can only get better.
if (strict) {
  const limits = { northSydney: { stopped: 42, speed: 3.0 }, townHall: { stopped: 35, speed: 4.4 } };
  let failed = false;
  for (const r of results) {
    const limit = limits[r.place];
    if (!limit) continue;
    if (r.stopped > limit.stopped) { console.error(`${r.place}: ${r.stopped}% stopped, limit ${limit.stopped}%`); failed = true; }
    if (r.speed < limit.speed) { console.error(`${r.place}: ${r.speed} m/s, limit ${limit.speed} m/s`); failed = true; }
  }
  if (failed) process.exit(1);
}
