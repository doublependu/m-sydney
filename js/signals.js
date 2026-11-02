// Each signalled junction runs its own lights, by who's there, instead of everyone sharing one clock. A direction keeps its green
// until someone else is waiting and nobody is still coming through, within a minimum and a maximum. Nothing here draws: js/traffic.js
// says who is waiting, and js/street-details.js shows the result.

const TIMING = { minGreen: 6, maxGreen: 24, amber: 3, allRed: 1, peopleRed: 3 };
const CLUSTER = 45; // m: junctions this close, the two halves of a divided road say, share one set of lights

class JunctionLights {
  /** `groups`: the right-of-way groups with traffic arriving. `start`: seconds into its first green, so they don't all change together */
  constructor(groups, start = 0) {
    this.groups = groups.length ? groups : [0];
    this.group = this.groups[0];
    this.phase = 'green'; // 'green', 'amber', 'allRed'
    this.t = start;
    this.hold = 0; // seconds into this phase it can't end before: people are on the crossing
    this.waiting = false; // somebody needs this green to end
  }

  /** 'green', 'amber' or 'red' for traffic in group `g` */
  phaseOf(g) {
    if (g !== this.group || this.phase === 'allRed') return 'red';
    return this.phase;
  }

  /** May someone step off to cross the road of group `crossed`, taking `seconds` to get across? */
  mayWalk(crossed, seconds = 12) {
    if (this.phase === 'allRed') return this.groups.length === 1 && crossed === this.group && this.t < TIMING.peopleRed;
    if (this.phase !== 'green' || crossed === this.group) return false;
    return !this.waiting || this.t + seconds <= TIMING.maxGreen;
  }

  /** Someone has stepped off, and this phase holds until they're across */
  walking(seconds = 12) {
    this.hold = Math.max(this.hold, this.t + seconds);
  }

  /** What the walk light says: 'walk', 'flash' while people finish crossing, or 'stop' */
  walkState(crossed, seconds = 12) {
    if (this.mayWalk(crossed, seconds)) return 'walk';
    return this.t < this.hold && crossed !== this.group ? 'flash' : 'stop';
  }

  /** `ask`: demand(g) someone's waiting or coming on group g; flowing(g) someone's still coming through on it; people(g) someone waits to cross its road */
  update(dt, ask) {
    this.t += dt;
    if (this.phase === 'green') {
      let cars = false;
      for (const g of this.groups) if (g !== this.group && ask.demand(g)) cars = true;
      this.waiting = cars || ask.people(this.group);
      if (!this.waiting || this.t < Math.max(TIMING.minGreen, this.hold)) return;
      if (this.t >= TIMING.maxGreen || !ask.flowing(this.group)) {
        this.phase = 'amber';
        this.t = 0;
      }
    } else if (this.phase === 'amber') {
      if (this.t >= TIMING.amber) {
        this.phase = 'allRed';
        this.t = 0;
        this.hold = 0;
      }
    } else {
      const people = ask.people(this.group);
      const least = this.groups.length === 1 && people ? TIMING.peopleRed : TIMING.allRed;
      if (this.t < Math.max(least, this.hold)) return;
      this.group = this.nextGroup(ask, people);
      this.phase = 'green';
      this.t = 0;
      this.hold = 0;
      this.waiting = false;
    }
  }

  nextGroup(ask, people) {
    const at = this.groups.indexOf(this.group);
    const n = this.groups.length;
    for (let k = 1; k < n; k++) {
      const g = this.groups[(at + k) % n];
      if (ask.demand(g)) return g;
    }
    // Nobody driving wants it, but someone has to cross this road: any other direction's green gets them over
    return people && n > 1 ? this.groups[(at + 1) % n] : this.group;
  }
}

/** Signal nodes close enough to run as one: arrays of nodes */
function clusterSignals(nodes, within = CLUSTER) {
  const signals = nodes.filter((n) => n.signal);
  const parent = signals.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let i = 0; i < signals.length; i++) {
    for (let j = i + 1; j < signals.length; j++) {
      const a = signals[i], b = signals[j];
      if (Math.abs(a.x - b.x) <= within && Math.abs(a.z - b.z) <= within && Math.hypot(a.x - b.x, a.z - b.z) <= within) parent[find(i)] = find(j);
    }
  }
  const out = new Map();
  signals.forEach((n, i) => {
    const r = find(i);
    if (!out.has(r)) out.set(r, []);
    out.get(r).push(n);
  });
  return [...out.values()];
}

const junctionKey = (x, z) => `${Math.round(x)},${Math.round(z)}`;

/**
 * Gives every signal node its lights: n.lights, e.lightGroup for what arrives there, n.sideLight[side] for the road on each side
 * (-1: nothing arrives over it, so its crossing conflicts with no one). `known` keeps lights from one road network to the next, or
 * they'd reset in view of the player as the network is rebuilt. `heads` says, by signal point, what the drawn heads should show.
 * `random`: where a junction's lights start. Returns each set of lights with its nodes.
 */
function assignLights(nodes, known, heads, random = Math.random) {
  const out = [];
  for (const cluster of clusterSignals(nodes)) {
    const key = cluster.map((n) => junctionKey(n.x, n.z)).sort()[0];
    const approaches = cluster.flatMap((n) => n.in);
    // One junction: its own right-of-way groups. Several: by which way the traffic runs, against the widest road
    let groupOf = (e) => e.axisIndex;
    if (cluster.length > 1) {
      const widest = approaches.reduce((best, e) => (!best || e.lanes.length > best.lanes.length ? e : best), null);
      groupOf = (e) => (!widest || Math.abs(e.dx * widest.dx + e.dz * widest.dz) >= Math.SQRT1_2 ? 0 : 1);
    }
    for (const e of approaches) e.lightGroup = groupOf(e);
    const groups = [...new Set(approaches.map((e) => e.lightGroup))].sort((a, b) => a - b);
    let lights = known.get(key);
    if (!lights || lights.groups.join() !== (groups.length ? groups : [0]).join()) {
      lights = new JunctionLights(groups, random() * TIMING.minGreen);
      known.set(key, lights);
    }
    for (const n of cluster) {
      n.lights = lights;
      n.cluster = cluster;
      n.sideLight = (n.approach || []).map((e) => (e ? e.lightGroup : -1));
      n.askedAt = (n.approach || []).map(() => -Infinity);
      if (!heads) continue;
      const main = n.in.find((e) => e.axisIndex === 0);
      const side = n.in.find((e) => e.axisIndex !== 0);
      for (const point of n.points || []) {
        heads.set(junctionKey(point.x, point.z), { lights, main: main ? main.lightGroup : -1, side: side ? side.lightGroup : -1 });
      }
    }
    out.push({ lights, nodes: cluster });
  }
  return out;
}

export { JunctionLights, TIMING, assignLights, clusterSignals, junctionKey };
