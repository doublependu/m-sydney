// Each scenario plays one stretch of the game. `metric` records feel numbers; `expect` fails the run.
const MPH_60 = 26.82;

async function teleportAndSettle(human, place, mode) {
  if (mode) {
    await human.press({ person: 'Digit1', car: 'Digit2', cyclist: 'Digit3', helicopter: 'Digit4' }[mode]);
    await human.react();
  }
  await human.clickTeleport(place);
  return human.state();
}

// The city builds behind the game; this waits for all of it, which is what the first scripted minute can't show
async function expectCityCompletes(human, page, expect, minutes = 2.5) {
  const done = await human.page.waitForFunction(() => window.__gameDebug.worldCompleteAt() !== null, null, { timeout: minutes * 60000, polling: 500 }).catch(() => null);
  expect(done, `the city was not finished after ${minutes} min`);
  return page.evaluate(() => window.__gameDebug.renderInfo());
}

// Along the bridge's corridor, 1 from the south end, -1 from the north end, as a person would: left of the double line,
// out to whichever lane has room, lifting off when all of them are full. The centre line was fine on an empty bridge;
// with traffic it's nose to nose with whatever is coming, and a car that sees you coming stops for you.
const DECK_LANES = [5.4, 9, 1.8]; // m left of the centre line
// In the southbound lanes, 28 m from the end: the deck is boarded only in its last 45 m, and a car turned round on the
// very last metre leaves the corridor at once
const DECK_NORTH_END = { x: -169, z: -3438, heading: 0.94 };

async function crossBridge(human, page, expect, direction) {
  let highest = -Infinity, far = 0, near = Infinity, left = false, blocked = 0, last = null;
  let lane = DECK_LANES[0];
  const started = Date.now();
  await human.down('KeyW');
  while (Date.now() - started < 330000) { // at the traffic's pace, 8 to 12 m/s, a crossing takes 3 to 5 minutes
    const state = await human.state();
    const aim = await page.evaluate(([x, z, d]) => window.__gameDebug.bridgeAim(x, z, d), [state.x, state.z, direction]);
    const deck = await page.evaluate(() => window.__gameDebug.onDeck());
    if (!aim) {
      left = true;
      break;
    }
    highest = Math.max(highest, aim.y);
    far = Math.max(far, aim.s);
    near = Math.min(near, aim.s);
    last = { x: state.x, z: state.z, h: direction > 0 ? aim.h : aim.h + Math.PI };
    if (deck) expect(state.y < 3, `on the deck the simulation stays flat, got y ${state.y}`);

    // The cars around, in metres ahead along the deck and to the left of its centre line, as the deck's own lanes are
    const fx = Math.sin(aim.tangent), fz = Math.cos(aim.tangent), lx = fz, lz = -fx;
    const mine = -aim.off * direction;
    const cars = (await page.evaluate(([x, z]) => window.__gameDebug.trafficNear(x, z, 45), [state.x, state.z]))
      .filter((v) => v.deck)
      .map((v) => ({ ahead: (v.x - state.x) * fx + (v.z - state.z) * fz, left: (v.x - state.x) * lx + (v.z - state.z) * lz + mine }));
    const clear = (at, range) => !cars.some((v) => v.ahead > -6 && v.ahead < range && Math.abs(v.left - at) < 2.6);
    if (!clear(lane, 34)) lane = DECK_LANES.find((at) => clear(at, 34)) ?? lane;
    const boxedIn = !clear(lane, 16);
    await human.setKey('KeyW', !boxedIn);
    await human.setKey('KeyS', boxedIn && Math.abs(state.speed) > 4);
    await human.steerTowards(state, { x: aim.aheadX + lx * lane, z: aim.aheadZ + lz * lane }, 0.03);

    if (Math.abs(state.speed) < 1 && !boxedIn && far > 40) blocked++;
    else blocked = 0;
    // Stopped with nothing to wait for: pressed against something. Reverse a little and go round
    if (blocked > 24) {
      blocked = 0;
      await human.backUp('KeyA');
      await human.down('KeyW');
    }
    await human.wait(120);
  }
  await human.releaseAll();
  return { highest, far, near, left, last };
}

// Drives a way through the road graph (__gameDebug.route), steering for a point a little ahead on it, and checks at
// every step that the car is on the level the road is: on the structure (or the ground) the way runs on there, at its
// height. Near a change of level either is fine. Inside a tunnel the camera must stay under the roof, and the sky's
// light turned down. Traffic on the way is waited for, or backed away from as driveTo() does.
const TUNNEL_HEIGHT = 5.6; // js/surfaces.js
async function followRoute(human, page, waypoints, { limit = 14 } = {}) {
  const route = await page.evaluate((w) => window.__gameDebug.route(w), waypoints);
  // At walking pace at worst, for the queues at the lights
  const timeout = Math.max(120000, (route?.length ?? 0) * 8 / 3 * 1000);
  const out = { found: !!route, points: route?.length ?? 0, samples: 0, offLevel: 0, worst: null, tunnelSamples: 0, cameraOut: 0, cameraThrough: 0, otherLevelHits: 0, levelJumps: 0, restarts: 0, darkest: 0, reached: false, seconds: 0 };
  if (!route) return out;
  const first = route[0], next = route[Math.min(2, route.length - 1)];
  const toStart = async () => {
    await human.releaseAll();
    await page.evaluate(([x, z, h, deck]) => window.__gameDebug.goto(x, z, h, 'car', deck), [first.x, first.z, Math.atan2(next.x - first.x, next.z - first.z), first.sid !== 0]);
    await human.wait(700);
  };
  await toStart();
  // Within this many points of a change of surface, either level will do
  const settled = route.map((p, i) => route.slice(Math.max(0, i - 2), i + 3).every((q) => q.sid === p.sid));
  let at = 0, last = await human.state(), lastMoved = Date.now(), lastY = last.surfaceY, lost = 0, thisTry = { samples: 0, offLevel: 0 };
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const state = await human.state();
    // At driving pace nothing gains or loses 3 m of height between two looks, on any road, unless it has jumped a level
    if (Math.abs(state.surfaceY - lastY) > 3) out.levelJumps++;
    lastY = state.surfaceY;
    // Nearest point a little behind to well ahead of the last: never a point on another level of the same ground plan
    let best = at;
    for (let i = Math.max(0, at - 3); i < Math.min(route.length, at + 12); i++) {
      if (Math.hypot(route[i].x - state.x, route[i].z - state.z) < Math.hypot(route[best].x - state.x, route[best].z - state.z)) best = i;
    }
    at = best;
    if (at >= route.length - 2) { out.reached = true; break; }
    const p = route[at];
    // Traffic can knock the car off the way where it's still at the ground's height, and it carries on along the streets
    // under it: no way back from there. That's no fault of the levels, so that try doesn't count.
    lost = Math.hypot(p.x - state.x, p.z - state.z) > 12 || (settled[at] && Math.abs(state.surfaceY - p.y) > 3) ? lost + 1 : 0;
    if (lost > 25 && out.restarts < 3) {
      out.restarts++;
      out.samples -= thisTry.samples;
      out.offLevel -= thisTry.offLevel;
      thisTry = { samples: 0, offLevel: 0 };
      await toStart();
      at = 0;
      lost = 0;
      last = await human.state();
      lastY = last.surfaceY;
      lastMoved = Date.now();
      continue;
    }
    if (settled[at] && Math.hypot(p.x - state.x, p.z - state.z) < 6) {
      out.samples++;
      thisTry.samples++;
      const off = Math.abs(state.surfaceY - p.y);
      if (state.surface !== p.sid || off > 1.5) {
        out.offLevel++;
        thisTry.offLevel++;
        if (!out.worst || off > out.worst.off) out.worst = { at: `${Math.round(state.x)},${Math.round(state.z)}`, surface: state.surface, want: p.sid, y: +state.surfaceY.toFixed(1), wantY: +p.y.toFixed(1), off: +off.toFixed(1), road: p.name };
      }
      const { cam, near } = await page.evaluate(([x, z]) => ({ cam: window.__gameDebug.camera(), near: window.__gameDebug.trafficNear(x, z, 6) }), [state.x, state.z]);
      if (cam.y > cam.ceiling) out.cameraThrough++;
      // Whatever is on another level just overhead or underneath can't touch the car
      out.otherLevelHits += near.filter((v) => v.struck && Math.abs(v.y - state.surfaceY) > 3).length;
      if (p.tunnel && route[Math.max(0, at - 3)].tunnel) {
        out.tunnelSamples++;
        if (cam.y > p.y + TUNNEL_HEIGHT - 0.2) out.cameraOut++;
        out.darkest = Math.max(out.darkest, cam.shelter);
      }
    }
    // On a two-way road, the left of it, as a driver would: the middle is nose to nose with whatever is coming
    const aim = route[Math.min(route.length - 1, at + 2)], after = route[Math.min(route.length - 1, at + 3)];
    const dx = after.x - aim.x, dz = after.z - aim.z, along = Math.hypot(dx, dz) || 1;
    const keep = aim.twoWay ? 2.8 : 0;
    const error = await human.steerTowards(state, { x: aim.x + (dz / along) * keep, z: aim.z - (dx / along) * keep }, 0.05);
    const speed = Math.abs(state.speed);
    await human.setKey('KeyW', speed < limit && (Math.abs(error) < 0.9 || speed < 4));
    await human.setKey('KeyS', speed > limit + 3 || (Math.abs(error) > 0.9 && speed > 6));
    if (Math.hypot(state.x - last.x, state.z - last.z) > 1.5) {
      last = state;
      lastMoved = Date.now();
    } else if (Date.now() - lastMoved > 3000) {
      await human.backUp(error > 0 ? 'KeyD' : 'KeyA');
      last = await human.state();
      lastMoved = Date.now();
    }
    await human.wait(100);
  }
  await human.releaseAll();
  out.seconds = Math.round((Date.now() - started) / 1000);
  return out;
}

// Ways across the levels, each starting on the ground (or the bridge deck) a little before the structure it's about
const LEVEL_ROUTES = {
  // William St under Kings Cross, a tube each way
  williamEast: [{ x: 1217, z: 27 }, { x: 1400, z: 66 }, { x: 1705, z: 115 }, { x: 1901, z: 97 }],
  williamWest: [{ x: 1951, z: 136 }, { x: 1707, z: 130 }, { x: 1396, z: 78 }, { x: 1219, z: 34 }],
  // Cumberland St over the Argyle Cut, and Argyle St through it, under Cumberland St
  cumberland: [{ x: -148, z: -1790 }, { x: -195, z: -1568 }, { x: -235, z: -1366 }],
  argyleEast: [{ x: -500, z: -1590, name: 'Argyle Street' }, { x: -112, z: -1548, name: 'Argyle Street' }],
  // Pier St over Darling Harbour, and Zollner Circuit under it
  pierStreet: [{ x: -700, z: 620, name: 'Pier Street' }, { x: -300, z: 500, name: 'Pier Street' }],
  zollnerCircuit: [{ x: -433, z: 535, name: 'Zollner Circuit' }, { x: -526, z: 679, name: 'Zollner Circuit' }],
  // Railway Colonnade Dr over Eddy Ave at Central, and Eddy Ave under it
  colonnade: [{ x: 133, z: 789 }, { x: 118, z: 865 }, { x: 59, z: 990 }, { x: 52, z: 996 }],
  eddyAvenue: [{ x: 196, z: 1023, name: 'Eddy Avenue' }, { x: 35, z: 946, name: 'Eddy Avenue' }],
  // The Western Distributor up from Darling Harbour and onto the bridge
  distributorNorth: [{ x: -420, z: -397 }, { x: -465, z: -584 }, { x: -362, z: -1078 }, { x: -312, z: -1348 }, { x: -120, z: -2100, name: 'Sydney Harbour Bridge' }],
  // Off the bridge by the York St ramp
  yorkStreetOff: [{ x: -150, z: -2100, name: 'Sydney Harbour Bridge' }, { x: -285, z: -1288, name: 'York Street Offramp' }, { x: -294, z: -1055 }],
  // The Cahill Expressway over Circular Quay, and back through its tunnel under the Domain end
  cahillEast: [{ x: -250, z: -1503 }, { x: -246, z: -1365 }, { x: 405, z: -1345 }, { x: 475, z: -1215 }],
  cahillWest: [{ x: 452, z: -1200 }, { x: 405, z: -1337 }, { x: -345, z: -1382 }]
};

async function driveLevels(human, page, metric, expect, names) {
  for (const name of names) {
    const r = await followRoute(human, page, LEVEL_ROUTES[name]);
    metric(name, { reached: r.reached, seconds: r.seconds, samples: r.samples, offLevel: r.offLevel, tunnelSamples: r.tunnelSamples, cameraOut: r.cameraOut, cameraThrough: r.cameraThrough, otherLevelHits: r.otherLevelHits, levelJumps: r.levelJumps, restarts: r.restarts, darkest: +r.darkest.toFixed(2), worst: r.worst });
    expect(r.found, `${name}: no way through the road graph`);
    expect(r.reached, `${name}: didn't get to the end in ${r.seconds} s`);
    expect(r.offLevel <= Math.max(1, r.samples * 0.03), `${name}: off its level ${r.offLevel} times of ${r.samples}, worst ${JSON.stringify(r.worst)}`);
    expect(r.cameraThrough === 0, `${name}: the camera went through what's overhead ${r.cameraThrough} times of ${r.samples}`);
    expect(r.otherLevelHits === 0, `${name}: traffic on another level was hit ${r.otherLevelHits} times`);
    expect(r.levelJumps === 0, `${name}: the car jumped a level ${r.levelJumps} times`);
    if (r.tunnelSamples) {
      expect(r.cameraOut === 0, `${name}: the camera was above the tunnel's roof ${r.cameraOut} times of ${r.tunnelSamples}`);
      expect(r.darkest > 0.8, `${name}: the light inside the tunnel only went down to ${r.darkest.toFixed(2)}`);
    }
  }
}

// Where George St passes under the deck, and the way it runs there
const UNDER_THE_DECK = {
  x: -155.4, z: -1839, heading: 1.2,
  approach: { x: -173.8, z: -1844.9, heading: 1.32 }, // where this stretch of it starts
  target: { x: -117, z: -1810 }
};

// Elizabeth St to Liverpool St to George St
const ROUTE = [{ x: 289, z: 250 }, { x: 291, z: 376 }, { x: 70, z: 376 }];

export const SCENARIOS = {
  'harbour-bridge': {
    minutes: 13,
    async run({ human, page, metric, expect }) {
      await human.wait(1000);
      await teleportAndSettle(human, 'harbourBridge');
      const north = await crossBridge(human, page, expect, 1);
      metric('deckReachedMetres', north.far);
      metric('deckHighestMetres', Math.round(north.highest));
      expect(north.highest > 48, `the deck only reached ${north.highest} m`);
      expect(north.far > 2000 || north.left, `drove ${north.far} m of the bridge`);
      const end = await human.state();
      expect(end.z < -3000, `ended short of North Sydney, at z ${Math.round(end.z)}`);

      // And back into the CBD
      const { x, z, heading } = DECK_NORTH_END;
      await page.evaluate(([a, b, c]) => window.__gameDebug.goto(a, b, c, 'car', true), [x, z, heading]);
      await human.wait(600);
      expect(await page.evaluate(() => window.__gameDebug.onDeck()), 'the way back did not start on the deck');
      const south = await crossBridge(human, page, expect, -1);
      metric('deckBackToMetre', south.near);
      expect(south.near < 200 || south.left, `turned back and stopped at metre ${south.near} of the bridge`);
      const home = await human.state();
      expect(home.z > -1700, `ended short of the CBD, at z ${Math.round(home.z)}`);
    }
  },

  // Through the Kings Cross tunnel both ways: on the tunnel's road all the way, the camera inside, the daylight gone
  tunnel: {
    minutes: 6,
    async run({ human, page, metric, expect }) {
      await human.wait(1000);
      await driveLevels(human, page, metric, expect, ['williamEast', 'williamWest']);
    }
  },

  // Roads over roads, on each level: the Argyle Cut, Pier St, Central, and the Cahill over Circular Quay and back
  'stacked-roads': {
    minutes: 20,
    async run({ human, page, metric, expect }) {
      await human.wait(1000);
      await driveLevels(human, page, metric, expect, ['cumberland', 'argyleEast', 'pierStreet', 'zollnerCircuit', 'colonnade', 'eddyAvenue', 'cahillEast', 'cahillWest']);
    }
  },

  // The Western Distributor onto the bridge, and off it by the York St ramp
  motorways: {
    minutes: 12,
    async run({ human, page, metric, expect }) {
      await human.wait(1000);
      await driveLevels(human, page, metric, expect, ['distributorNorth', 'yorkStreetOff']);
    }
  },

  // Off from a standstill on a steep street, now that wheels follow the road: no rolling back, and away up the hill
  'hill-start': {
    async run({ human, page, metric, expect }) {
      await human.wait(1000);
      // William St, up towards Kings Cross
      await page.evaluate(() => window.__gameDebug.goto(1243, 29, 1.48, 'car'));
      await human.wait(1500);
      const start = await human.state();
      const ahead = { x: Math.sin(start.heading), z: Math.cos(start.heading) };
      const along = (s) => (s.x - start.x) * ahead.x + (s.z - start.z) * ahead.z;
      const climb = await page.evaluate(([x, z, ax, az]) => {
        const here = window.__gameDebug.route([{ x, z, name: 'William Street' }, { x: x + ax * 100, z: z + az * 100, name: 'William Street' }]);
        return here && here.length > 3 ? (here[here.length - 1].y - here[0].y) / (8 * (here.length - 1)) : null;
      }, [start.x, start.z, ahead.x, ahead.z]);
      metric('grade', climb === null ? null : +climb.toFixed(3));
      expect(start.surfaceY > 20, `not on the hill: road at ${start.surfaceY}`);
      expect(Math.abs(start.speed) < 0.3, `moving before the start: ${start.speed} m/s`);
      const rest = await human.state();
      expect(Math.abs(along(rest)) < 0.5, `rolled ${along(rest).toFixed(2)} m standing on the hill`);
      await human.down('KeyW');
      const started = Date.now();
      let lowest = 0, at8 = null, last = rest;
      while (Date.now() - started < 12000) {
        const s = await human.state();
        lowest = Math.min(lowest, along(s));
        if (at8 === null && s.speed >= 8) at8 = (Date.now() - started) / 1000;
        last = s;
        if (at8 !== null && along(s) > 60) break;
        await human.wait(60);
      }
      await human.releaseAll();
      metric('secondsTo8', at8);
      metric('rolledBack', +lowest.toFixed(2));
      metric('climbed', +(last.surfaceY - start.surfaceY).toFixed(1));
      expect(lowest > -0.3, `rolled back ${(-lowest).toFixed(2)} m pulling away`);
      expect(at8 !== null && at8 < 8, `took ${at8} s to reach 8 m/s up the hill`);
      expect(last.surfaceY - start.surfaceY > 1.5, `drove along the hill but only climbed ${(last.surfaceY - start.surfaceY).toFixed(1)} m`);
    }
  },

  'loading-bar': {
    async run({ page, metric, expect }) {
      const seen = [];
      const started = Date.now();
      let complete = null, hiddenAfter = null;
      while (Date.now() - started < 150000) {
        const [state, done] = await page.evaluate(() => [window.__gameDebug.progress(), window.__gameDebug.worldCompleteAt()]);
        seen.push({ t: Date.now() - started, ...state });
        if (done !== null && complete === null) complete = Date.now();
        if (complete !== null && !state.shown) { hiddenAfter = Date.now() - complete; break; }
        await page.waitForTimeout(150);
      }
      const shown = seen.filter((s) => s.shown);
      const labels = new Set(shown.map((s) => s.label));
      const values = shown.map((s) => s.value);
      metric('shownSeconds', +(shown.length * 0.15).toFixed(1));
      metric('labels', labels.size);
      metric('hiddenAfterCompleteMs', hiddenAfter);
      expect(shown.length > 3, 'the bar never showed while the city was building');
      expect(values.every((v, i) => !i || v >= values[i - 1] - 1e-6), 'the bar went backwards');
      expect(values[values.length - 1] > 0.9, `the bar ended at ${Math.round(values[values.length - 1] * 100)}%`);
      expect(labels.size >= 3, `the bar named only ${[...labels].join(', ')}`);
      expect(hiddenAfter !== null && hiddenAfter < 1500, `the bar stayed ${hiddenAfter} ms after the city was finished`);
      const timings = (await page.evaluate(() => window.__gameDebug.progress())).timings;
      metric('stepMs', Object.fromEntries(timings));
    }
  },

  // Along both barriers of the deck, past both pairs of pylons: nothing the driver can't see may stop the car. The
  // barriers are where the game holds cars, and the pylons stand outside the deck.
  'bridge-edges': {
    minutes: 5,
    async run({ human, page, metric, expect }) {
      await expectCityCompletes(human, page, expect);
      const legs = [
        { from: 640, to: 1360, direction: 1 }, // northbound along the west barrier
        { from: 1360, to: 640, direction: -1 } // southbound along the east barrier
      ];
      let invisibleStops = 0, closest = Infinity;
      const stops = [];
      for (const leg of legs) {
        const start = await page.evaluate(([s, d]) => {
          const at = window.__gameDebug.bridgePlace(s);
          return { x: at.x - at.nx * 11 * d, z: at.z - at.nz * 11 * d, h: d > 0 ? at.h : at.h + Math.PI };
        }, [leg.from, leg.direction]);
        await page.evaluate(([x, z, h]) => window.__gameDebug.goto(x, z, h, 'car', true), [start.x, start.z, start.h]);
        await human.wait(600);
        expect(await page.evaluate(() => window.__gameDebug.onDeck()), 'the leg did not start on the deck');
        await human.down('KeyW');
        const speeds = [];
        const started = Date.now();
        for (;;) {
          const state = await human.state();
          const aim = await page.evaluate(([x, z, d]) => window.__gameDebug.bridgeAim(x, z, d), [state.x, state.z, leg.direction]);
          expect(aim && await page.evaluate(() => window.__gameDebug.onDeck()), `left the deck at ${Math.round(state.x)}, ${Math.round(state.z)}`);
          if (!aim || (leg.direction > 0 ? aim.s > leg.to : aim.s < leg.to) || Date.now() - started > 100000) break;
          // Keep 11 m left of the centre line, hard against the barrier (the tangent points the way we're going)
          const fx = Math.sin(aim.tangent), fz = Math.cos(aim.tangent);
          const lx = fz, lz = -fx;
          await human.steerTowards(state, { x: aim.aheadX + lx * 11, z: aim.aheadZ + lz * 11 }, 0.02);
          closest = Math.min(closest, 12.5 - Math.abs(aim.off));
          // Traffic in the way explains a stop; anything else doesn't
          const ahead = (await page.evaluate(([x, z]) => window.__gameDebug.trafficNear(x, z, 20), [state.x, state.z]))
            .filter((v) => v.deck && (v.x - state.x) * Math.sin(state.heading) + (v.z - state.z) * Math.cos(state.heading) > 0);
          speeds.push(state.speed);
          const before = speeds[speeds.length - 9];
          if (before > 8 && state.speed < before * 0.5 && !ahead.length) {
            invisibleStops++;
            stops.push({ s: aim.s, off: aim.off, from: +before.toFixed(1), to: +state.speed.toFixed(1), near: (await page.evaluate(([x, z]) => window.__gameDebug.trafficNear(x, z, 12), [state.x, state.z])).length });
          }
          await human.wait(120);
        }
        await human.releaseAll();
        const end = await page.evaluate(() => window.__gameDebug.player());
        const reached = await page.evaluate(([x, z, d]) => window.__gameDebug.bridgeAim(x, z, d), [end.x, end.z, leg.direction]);
        expect(reached && (leg.direction > 0 ? reached.s > leg.to : reached.s < leg.to), `stopped at metre ${reached?.s} of the deck, short of ${leg.to}`);
      }
      metric('invisibleStops', invisibleStops);
      metric('stops', stops.slice(0, 8));
      metric('closestToBarrierMetres', +closest.toFixed(2));
      expect(invisibleStops === 0, `${invisibleStops} times the car lost half its speed with nothing in front of it`);
      expect(closest < 2.5, `never got within ${closest.toFixed(1)} m of a barrier, so this proved nothing`);
    }
  },

  // George St through The Rocks runs under the bridge's approach, with the deck's traffic straight overhead. The two
  // levels share x and z in a flat simulation: neither may see the other.
  'under-the-bridge': {
    async run({ human, page, metric, expect }) {
      await expectCityCompletes(human, page, expect); // traffic joins the game with the last of the city
      const { x, z, heading, approach, target } = UNDER_THE_DECK;
      await page.evaluate(([a, b, c]) => window.__gameDebug.goto(a, b, c, 'car'), [x, z, heading]);
      await human.wait(1500);
      const parked = await human.state();
      let overhead = 0, struck = 0, stalled = 0, above = false;
      const started = Date.now();
      while (Date.now() - started < 30000) {
        const near = await page.evaluate(([a, b]) => window.__gameDebug.trafficNear(a, b, 14), [parked.x, parked.z]);
        const deck = near.filter((v) => v.deck);
        if (deck.length && !above) overhead++;
        above = deck.length > 0;
        struck = Math.max(struck, deck.filter((v) => v.struck).length);
        stalled = Math.max(stalled, deck.filter((v) => v.speed < 1).length);
        expect(!(await page.evaluate(() => window.__gameDebug.onDeck())), 'a car on George St was lifted onto the deck');
        await human.wait(100);
      }
      metric('deckCarsOverhead', overhead);
      metric('deckCarsStruck', struck);
      metric('deckCarsStalled', stalled);
      expect(overhead > 0, 'no deck traffic passed overhead, so this proved nothing');
      expect(struck === 0, `${struck} deck cars hit a car parked 45 m below them`);
      expect(stalled === 0, `${stalled} deck cars stopped for a car parked 45 m below them`);

      // Through, at speed, and on foot
      await page.evaluate(([a, b, c]) => window.__gameDebug.goto(a, b, c, 'car'), [approach.x, approach.z, approach.heading]);
      await human.wait(500);
      await human.down('KeyW');
      for (let i = 0; i < 30; i++) {
        const state = await human.state();
        expect(state.y < 1.5, `driving under the deck reached y ${state.y.toFixed(1)}`);
        expect(!(await page.evaluate(() => window.__gameDebug.onDeck())), 'driving under the deck lifted the car onto it');
        await human.steerTowards(state, target, 0.05);
        await human.wait(100);
      }
      await human.releaseAll();
      await page.evaluate(([a, b, c]) => window.__gameDebug.goto(a, b, c, 'person'), [x, z, heading]);
      await human.wait(500);
      await human.hold('KeyW', 2500);
      const walked = await human.state();
      expect(walked.mode === 'person' && walked.y < 1.5, `walking under the deck reached y ${walked.y.toFixed(1)}`);
      expect(Math.hypot(walked.x - x, walked.z - z) > 5, 'could not walk through under the deck');
      expect(!(await page.evaluate(() => window.__gameDebug.onDeck())), 'walking under the deck lifted the walker onto it');
    }
  },

  'keeps-left': {
    async run({ human, page, metric, expect }) {
      await expectCityCompletes(human, page, expect);
      await human.wait(8000);
      const sides = await page.evaluate(() => window.__gameDebug.trafficSides());
      metric('trafficSides', sides);
      expect(sides.left + sides.right > 20, `only ${sides.left + sides.right} cars on two-way roads`);
      expect(sides.right <= (sides.left + sides.right) * 0.03, `${sides.right} of ${sides.left + sides.right} cars on the right`);
    }
  },

  'first-minute': {
    async run({ human, page, metric, expect }) {
      await human.wait(1500); // a new player takes in the screen first
      const start = await human.state();
      expect(start.mode === 'car', `first visit should start in the car, got ${start.mode}`);

      // Timed inside the page: a round trip from this script would add its own delay
      await page.evaluate(() => {
        window.__motion = new Promise((done) => {
          addEventListener('keydown', () => {
            const pressed = performance.now();
            const check = () => {
              if (Math.abs(window.__gameDebug.player().speed) > 0.01) done(performance.now() - pressed);
              else requestAnimationFrame(check);
            };
            check();
          }, { once: true });
        });
      });
      await human.down('KeyW');
      metric('inputToMotionMs', Math.round(await page.evaluate(() => window.__motion)));

      // Traffic can end a run, so try again from a standstill rather than report the crash as the car's pace.
      // Times come from the game clock: this is about the car, not the frame rate of this machine.
      let best = null;
      let peak = 0;
      for (let attempt = 0; attempt < 4 && best === null; attempt++) {
        const startClock = await human.clock();
        let previous = 0;
        let crashed = false;
        for (const deadline = Date.now() + 20000; Date.now() < deadline && !crashed;) {
          const speed = Math.abs((await human.state()).speed);
          peak = Math.max(peak, speed);
          if (speed >= MPH_60) {
            best = await human.clock() - startClock;
            break;
          }
          crashed = previous > 5 && speed < previous * 0.8;
          previous = speed;
          await human.wait(50);
        }
        if (best === null) {
          await human.up('KeyW');
          await human.down('KeyS');
          await human.until((s) => Math.abs(s.speed) < 0.5, { timeout: 5000 });
          await human.up('KeyS');
          await human.hold('KeyA', 450);
          await human.down('KeyW');
        }
      }
      metric('zeroToSixtySeconds', best === null ? null : Number(best.toFixed(1)));
      metric('peakSpeedMph', Math.round(peak * 2.237));

      await human.up('KeyW');
      await human.down('KeyS');
      const brakingFrom = await human.state();
      const stopped = await human.until((s) => Math.abs(s.speed) < 0.5, { timeout: 8000, every: 50 });
      await human.up('KeyS');
      if (stopped) {
        metric('brakingFromMph', Math.round(Math.abs(brakingFrom.speed) * 2.237));
        metric('brakingMetres', Number(Math.hypot(stopped.x - brakingFrom.x, stopped.z - brakingFrom.z).toFixed(1)));
      }

      // Turn radius at city speed, on full lock
      await human.down('KeyW');
      await human.until((s) => Math.abs(s.speed) > 9, { timeout: 5000, every: 50 });
      await human.down('KeyD');
      await human.wait(300);
      const a = await human.state();
      await human.wait(1200);
      const b = await human.state();
      await human.releaseAll();
      const turned = Math.abs(Math.atan2(Math.sin(b.heading - a.heading), Math.cos(b.heading - a.heading)));
      if (turned > 0.1) metric('turnRadiusMetres', Number((Math.hypot(b.x - a.x, b.z - a.z) / turned).toFixed(1)));
      await human.down('KeyS');
      await human.until((s) => Math.abs(s.speed) < 0.5, { timeout: 6000 });
      await human.releaseAll();
    }
  },

  'drive-route': {
    async run({ human, page, metric, expect }) {
      await human.wait(1000);
      await teleportAndSettle(human, 'hydePark');
      // Down Elizabeth St with Hyde Park alongside, then right into Liverpool St and on to George St
      const waypoints = ROUTE;
      const total = { seconds: 0, backups: 0, blockedSeconds: 0 };
      for (const waypoint of waypoints) {
        const leg = await human.driveTo(waypoint, { timeout: 80000 });
        expect(leg.reached, `did not reach waypoint ${Math.round(waypoint.x)}, ${Math.round(waypoint.z)}`);
        total.seconds += leg.seconds;
        total.backups += leg.backups;
        total.blockedSeconds += leg.blockedSeconds;
        if (!leg.reached) break;
      }
      metric('routeSeconds', Number(total.seconds.toFixed(1)));
      metric('routeBackups', total.backups);
      metric('blockedByTrafficShare', Number((total.blockedSeconds / Math.max(1, total.seconds)).toFixed(3)));
    }
  },

  'crash-recovery': {
    async run({ human, page, metric, expect }) {
      await human.wait(1000);
      const from = await teleportAndSettle(human, 'townHall');
      // Build up speed down George St, then swing into the wall of the next block.
      await human.down('KeyW');
      await human.until((state) => Math.hypot(state.x - from.x, state.z - from.z) > 110, { timeout: 12000 });
      const wall = await page.evaluate((x) => ({ x: x - 200 }), from.x);
      let hit = null;
      let previous = await human.state();
      const deadline = Date.now() + 12000;
      while (!hit && Date.now() < deadline) {
        const state = await human.state();
        await human.steerTowards(state, { x: wall.x, z: state.z + 120 });
        // Throttle held, so only an impact takes a quarter of the speed away between two looks.
        if (Math.abs(previous.speed) > 6 && Math.abs(state.speed) < Math.abs(previous.speed) * 0.75) hit = { before: previous, after: state };
        previous = state;
        await human.wait(60);
      }
      await human.releaseAll();
      expect(hit, 'never hit the wall');
      if (!hit) return;
      metric('impactMph', Math.round(Math.abs(hit.before.speed) * 2.237));

      const hitAt = Date.now();
      await human.react();
      await human.hold('KeyS', 1300);
      // Back the way it came, which is open by construction: this bot steers in straight lines and can't route around
      // a corner, and the crash can leave it rolling down a cross street
      const road = {
        x: hit.before.x - Math.sin(hit.before.heading) * 45,
        z: hit.before.z - Math.cos(hit.before.heading) * 45
      };
      const recovery = await human.driveTo(road, { timeout: 14000, arrive: 18 });
      expect(recovery.reached, `could not drive away after the crash: ended at speed ${(await human.state()).speed.toFixed(1)}, ${recovery.backups} backups`);
      metric('crashRecoverySeconds', recovery.reached ? Number(((Date.now() - hitAt) / 1000).toFixed(1)) : null);
      metric('crashRecoveryBackups', recovery.backups);
    }
  },

  'walk-cycle': {
    async run({ human, page, metric, expect }) {
      await human.wait(800);
      await teleportAndSettle(human, 'townHall', 'person');
      await human.down('KeyW');
      await human.wait(2500);
      const walking = await human.state();
      expect(Math.abs(walking.speed) > 3, `walking stayed at ${walking.speed.toFixed(1)} m/s`);
      metric('runSpeedMph', Math.round(Math.abs(walking.speed) * 2.237));

      const ground = walking.y;
      await human.down('Space');
      await human.wait(90);
      await human.up('Space');
      const air = await human.until((s) => s.y > ground + 0.3, { timeout: 1500, every: 30 });
      expect(air, 'jump never left the ground');
      const landed = await human.until((s) => s.y <= ground + 0.05, { timeout: 3000, every: 30 });
      expect(landed, 'never landed after the jump');

      // A tap that starts and ends between two frames, as a quick touch does on a slow phone or any press during a
      // loading hitch: nothing is held by the time the game looks, and it still has to jump.
      const before = await human.state();
      await page.evaluate(() => {
        for (const type of ['keydown', 'keyup']) window.dispatchEvent(new KeyboardEvent(type, { code: 'Space' }));
      });
      expect(await human.until((s) => s.y > before.y + 0.3, { timeout: 1500, every: 30 }), 'a tap between two frames was lost');
      await human.until((s) => s.y <= before.y + 0.05, { timeout: 3000, every: 30 });

      // Over the kerb and back
      await human.hold('KeyA', 700);
      await human.wait(1500);
      await human.hold('KeyD', 900);
      await human.wait(1500);
      await human.releaseAll();

      await human.press('Digit3');
      await human.react();
      await human.down('KeyW');
      await human.wait(3500);
      const cycling = await human.state();
      expect(cycling.mode === 'cyclist', 'did not switch to the bicycle');
      expect(Math.abs(cycling.speed) > 4, `cycling stayed at ${cycling.speed.toFixed(1)} m/s`);
      metric('cycleSpeedMph', Math.round(Math.abs(cycling.speed) * 2.237));
      await human.hold('KeyA', 600);
      await human.wait(1500);
      await human.hold('KeyD', 600);
      await human.wait(1000);
      await human.releaseAll();
    }
  },

  helicopter: {
    async run({ human, metric, expect }) {
      await human.wait(800);
      await teleportAndSettle(human, 'townHall', 'helicopter');
      await human.press('Digit4');
      await human.down('Space');
      await human.wait(2500);
      await human.up('Space');
      const climbed = await human.state();
      expect(climbed.y > 100, `climbed only to ${climbed.y.toFixed(0)} m`);

      await human.down('KeyW');
      await human.wait(4000);
      await human.hold('KeyA', 900);
      await human.wait(1500);
      await human.up('KeyW');
      const cruising = await human.state();
      expect(Math.abs(cruising.speed) > 15, `cruise speed only ${cruising.speed.toFixed(1)} m/s`);
      metric('heliCruiseMph', Math.round(Math.abs(cruising.speed) * 2.237));

      // Land on a street: straight down
      await human.until((s) => Math.abs(s.speed) < 2, { timeout: 8000 });
      await human.down('KeyQ');
      const started = Date.now();
      const down = await human.until((s) => s.y < 1, { timeout: 30000 });
      await human.up('KeyQ');
      metric('heliDescentSeconds', down ? Number(((Date.now() - started) / 1000).toFixed(1)) : null);
      metric('heliSettledAltitude', Number((await human.state()).y.toFixed(1)));

      // Roof landing: climb, fly on until there is a roof underneath, stop, and sink straight down onto it
      await human.down('Space');
      await human.wait(2600);
      await human.up('Space');
      await human.down('KeyW');
      const overRoof = await human.until((s) => s.roof > 12, { timeout: 12000, every: 60 });
      await human.up('KeyW');
      expect(overRoof, 'never flew over a roof');
      if (overRoof) {
        const stopped = await human.until((s) => Math.abs(s.speed) < 1.5, { timeout: 6000 });
        const target = stopped || overRoof;
        await human.down('KeyQ');
        const settled = await human.until((s) => Math.abs(s.y - (s.roof + 0.25)) < 0.2 && s.roof > 5, { timeout: 25000, every: 60 });
        await human.wait(700);
        await human.up('KeyQ');
        const end = await human.state();
        expect(settled, `did not settle on the roof: y ${end.y.toFixed(1)}, roof ${end.roof.toFixed(1)}`);
        const drift = Math.hypot(end.x - target.x, end.z - target.z);
        expect(drift < 8, `landing threw the helicopter ${drift.toFixed(1)} m sideways`);
        metric('heliRoofHeight', Number(end.roof.toFixed(1)));
      }

      await human.press('Digit1');
      await human.react();
      expect((await human.state()).mode === 'person', 'could not leave the helicopter');
      await human.press('Digit4');
      await human.down('KeyE');
      await human.wait(1200);
      await human.releaseAll();
    }
  },

  'mode-map': {
    async run({ human, page, expect }) {
      await human.wait(800);
      await human.down('KeyW');
      await human.wait(1800);
      for (const key of ['Digit1', 'Digit3', 'Digit4', 'Digit2']) {
        await human.press(key);
        await human.wait(human.between(500, 900));
      }
      await human.releaseAll();
      for (let i = 0; i < 12; i++) {
        await human.press('KeyV');
        await human.wait(human.between(250, 500));
      }
      await human.press('Digit5');
      for (const time of ['midday', 'twilight', 'midnight', 'golden']) {
        await page.locator(`[data-time="${time}"]`).click();
        await human.wait(700);
      }

      await human.press('KeyM');
      await human.wait(700);
      const open = () => page.evaluate(() => !document.getElementById('fullmap-modal').classList.contains('hidden'));
      expect(await open(), 'the map did not open');
      await page.locator('#fullmap-search').click();
      await page.keyboard.type('George Street', { delay: 70 });
      await human.wait(800);
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.keyboard.press('Escape');
      await human.wait(300);
      if (await open()) await page.keyboard.press('Escape');
      await human.wait(400);
      expect(!(await open()), 'the map did not close');

      await human.press('KeyM');
      await human.wait(600);
      const box = await page.locator('#fullmap-canvas').boundingBox();
      const before = await human.state();
      await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.5);
      await human.wait(900);
      if (await open()) await page.keyboard.press('Escape');
      const after = await human.state();
      expect(Math.hypot(after.x - before.x, after.z - before.z) > 5 || !(await open()), 'the map click did nothing');

      await human.clickTeleport('northSydney');
      await human.clickTeleport('circularQuay');
    }
  },

  touch: {
    profile: 'phone',
    async run({ human, game, page, metric, expect }) {
      const { cdp } = game;
      const fits = () => page.evaluate(() => {
        const canvas = document.querySelector('#canvas-container canvas');
        const rect = canvas.getBoundingClientRect();
        const { aspect } = window.__gameDebug.camera();
        return { width: innerWidth, height: innerHeight, cssWidth: rect.width, cssHeight: rect.height, aspect, scale: visualViewport.scale };
      });
      const expectFit = (fit, label) => {
        expect(Math.abs(fit.cssWidth - fit.width) < 1 && Math.abs(fit.cssHeight - fit.height) < 1, `${label}: canvas is ${fit.cssWidth}x${fit.cssHeight} in a ${fit.width}x${fit.height} window`);
        expect(Math.abs(fit.aspect - fit.width / fit.height) < 0.01, `${label}: camera aspect ${fit.aspect} for ${fit.width}x${fit.height}`);
        expect(fit.scale === 1, `${label}: page zoomed to ${fit.scale}`);
      };
      await human.wait(1000);
      expectFit(await fits(), 'portrait');

      const stick = await page.locator('#touch-stick').boundingBox();
      const center = { x: stick.x + stick.width / 2, y: stick.y + stick.height / 2 };
      const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
      await touch('touchStart', [{ x: center.x, y: center.y, id: 1 }]);
      await touch('touchMove', [{ x: center.x, y: center.y - 40, id: 1 }]);
      await human.wait(3000);
      const driving = await human.state();
      expect(Math.abs(driving.speed) > 3, `joystick drove at only ${driving.speed.toFixed(1)} m/s`);
      await touch('touchEnd', []);
      await human.wait(300);

      // Rotate mid-drive, with the car still rolling
      const rolling = await human.state();
      await page.setViewportSize({ width: 844, height: 390 });
      await human.wait(1000);
      const landscape = await fits();
      expectFit(landscape, 'landscape');
      const after = await human.state();
      metric('speedAcrossRotation', { before: Number(rolling.speed.toFixed(1)), after: Number(after.speed.toFixed(1)) });
      await human.wait(500);

      const stick2 = await page.locator('#touch-stick').boundingBox();
      const center2 = { x: stick2.x + stick2.width / 2, y: stick2.y + stick2.height / 2 };
      await touch('touchStart', [{ x: center2.x, y: center2.y, id: 2 }]);
      await touch('touchMove', [{ x: center2.x + 30, y: center2.y - 30, id: 2 }]);
      await human.wait(2000);
      await touch('touchEnd', []);

      await page.setViewportSize({ width: 390, height: 844 });
      await human.wait(1000);
      expectFit(await fits(), 'portrait again');
    }
  },

  pause: {
    async run({ human, page, expect }) {
      const snapshot = () => page.evaluate(() => {
        const debug = window.__gameDebug;
        const dialog = document.getElementById('pause-menu');
        return { paused: debug.paused(), open: dialog.open, clock: debug.clock(), audio: debug.audioState(), ...debug.player() };
      });
      await human.wait(800);
      await human.down('KeyW'); // also unlocks audio, which needs a gesture
      await human.wait(2500);
      await human.up('KeyW');

      for (const [label, opener] of [['P', () => human.press('KeyP')], ['Esc', () => human.press('Escape')], ['button', () => page.locator('#btn-pause').click()]]) {
        await opener();
        await human.wait(500);
        const start = await snapshot();
        expect(start.paused && start.open, `${label} did not open the pause screen`);
        expect(start.audio !== 'running', `${label}: audio still ${start.audio} while paused`);
        await page.keyboard.down('KeyW');
        await page.keyboard.press('Digit4');
        await page.keyboard.press('KeyM');
        await human.wait(5000);
        await page.keyboard.up('KeyW');
        const end = await snapshot();
        expect(end.clock === start.clock, `${label}: the game clock ran while paused`);
        expect(end.x === start.x && end.z === start.z, `${label}: the player moved while paused`);
        expect(end.mode === start.mode, `${label}: a shortcut changed the mode while paused`);
        expect(await page.locator('#fullmap-modal.hidden').count() === 1, `${label}: M opened the map while paused`);

        // Rotating while paused has to leave a picture behind the dialog
        await page.setViewportSize({ width: 720, height: 1280 });
        await human.wait(500);
        await page.setViewportSize({ width: 1280, height: 720 });
        await human.wait(500);

        await page.locator('#pause-resume').click();
        await human.wait(800);
        const resumed = await snapshot();
        expect(!resumed.paused && !resumed.open, `${label}: did not resume`);
        expect(resumed.clock > end.clock, `${label}: the clock stayed frozen after resuming`);
        expect(resumed.audio === 'running' || resumed.audio === 'none', `${label}: audio did not resume, ${resumed.audio}`);
      }

      await human.press('KeyM');
      await human.wait(500);
      await human.press('Escape');
      await human.wait(400);
      const afterMap = await snapshot();
      expect(!afterMap.paused, 'Esc on the map also opened the pause screen');
      await page.locator('[popovertarget="teleport-popover"]').first().click();
      await human.wait(300);
      await human.press('Escape');
      await human.wait(400);
      expect(!(await snapshot()).paused, 'Esc on a popover also opened the pause screen');
      await human.press('KeyP');
      await human.wait(300);
      await human.press('Escape');
      await human.wait(400);
      expect(!(await snapshot()).paused, 'Esc did not close the pause screen');
    }
  },

  // Too many pixels for integrated graphics, which is what Auto is there to correct
  'auto-steps-down': {
    profile: 'wide',
    async run({ human, page, metric, expect }) {
      await expectCityCompletes(human, page, expect);
      const before = await page.evaluate(() => window.__gameDebug.quality());
      const lowered = await page.waitForFunction((ratio) => window.__gameDebug.quality().pixelRatio < ratio, before.pixelRatio, { timeout: 40000, polling: 500 }).catch(() => null);
      const after = await page.evaluate(() => window.__gameDebug.quality());
      metric('pixelRatio', { before: before.pixelRatio, after: Number(after.pixelRatio.toFixed(3)) });
      await page.waitForTimeout(1000);
      await page.evaluate(() => window.__gameDebug.frameCost());
      await page.waitForTimeout(3000);
      metric('fpsAfter', (await page.evaluate(() => window.__gameDebug.frameCost())).fps);
      if (!lowered) metric('note', 'this GPU kept up at 1440p, so nothing needed lowering');
    }
  },

  'graphics-menu': {
    async run({ human, page, expect }) {
      await expectCityCompletes(human, page, expect);
      await human.down('KeyW');
      await human.wait(2000);
      await human.releaseAll();
      await human.wait(800);
      const before = await human.state();
      await human.press('KeyP');
      await human.wait(400);
      await Promise.all([page.waitForNavigation({ waitUntil: 'commit' }), page.locator('[data-quality="low"]').click()]);
      await page.waitForFunction(() => document.getElementById('loading-overlay')?.classList.contains('hidden'), null, { timeout: 60000, polling: 200 });
      const quality = await page.evaluate(() => window.__gameDebug.quality());
      expect(quality.choice === 'low' && quality.level === 'low', `the Low choice did not stick: ${JSON.stringify(quality)}`);
      const after = await human.state();
      expect(Math.hypot(after.x - before.x, after.z - before.z) < 12, `the reload lost the player: ${Math.round(Math.hypot(after.x - before.x, after.z - before.z))} m away`);

      await human.press('KeyP');
      await human.wait(400);
      await Promise.all([page.waitForNavigation({ waitUntil: 'commit' }), page.locator('[data-quality="auto"]').click()]);
      await page.waitForFunction(() => document.getElementById('loading-overlay')?.classList.contains('hidden'), null, { timeout: 60000, polling: 200 });
      expect((await page.evaluate(() => window.__gameDebug.quality())).choice === 'auto', 'Auto did not come back');
    }
  },

  'high-graphics': {
    query: 'quality=high',
    async run({ human, page, metric, expect }) {
      const { backend } = await expectCityCompletes(human, page, expect);
      expect(backend === 'webgpu', `expected WebGPU, got ${backend}`);
      await human.down('KeyW');
      await human.wait(2500);
      await human.releaseAll();
      metric('level', await page.evaluate(() => window.__gameDebug.quality().level));
    }
  },

  'low-graphics': {
    query: 'quality=low',
    async run({ human, page, expect }) {
      await expectCityCompletes(human, page, expect);
      await human.down('KeyW');
      await human.wait(2500);
      await human.releaseAll();
    }
  },

  'webgl2-fallback': {
    initScript: () => { delete Navigator.prototype.gpu; },
    async run({ human, page, metric, expect }) {
      const { backend } = await expectCityCompletes(human, page, expect, 3.5);
      expect(backend === 'webgl2', `expected the WebGL2 fallback, got ${backend}`);
      metric('level', await page.evaluate(() => window.__gameDebug.quality().level));
      await human.down('KeyW');
      await human.wait(2500);
      await human.releaseAll();
    }
  },

  // A phone drops the GPU under memory pressure: the player is told, their position survives, and Reload brings it back
  'device-lost': {
    initScript: () => { delete Navigator.prototype.gpu; },
    expectedErrors: /Device Lost|Shader Error|CONTEXT_LOST|Context Lost/i,
    async run({ human, page, expect }) {
      await expectCityCompletes(human, page, expect, 3.5);
      await teleportAndSettle(human, 'circularQuay', 'person');
      const at = await human.state();
      await page.evaluate(() => {
        document.querySelector('canvas').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext();
      });
      await page.waitForSelector('#graphics-lost[open]', { timeout: 5000 });
      await human.wait(1200); // be looked at, for the recording
      await page.keyboard.press('Escape');
      expect(await page.evaluate(() => document.getElementById('graphics-lost').open), 'Esc left a dead game behind the dialog');
      await page.click('#graphics-lost-reload');
      await page.waitForFunction(() => window.__gameDebug?.player, null, { timeout: 15000 });
      await expectCityCompletes(human, page, expect, 3.5);
      const back = await human.state();
      expect(Math.hypot(back.x - at.x, back.z - at.z) < 5, `came back ${Math.round(Math.hypot(back.x - at.x, back.z - at.z))} m away`);
    }
  },

  // Coming back far from the default start: the starting view has to form around the saved spot, not around Midtown
  'saved-position': {
    storage: JSON.stringify({
      version: 1,
      activeMode: 'car',
      entities: { car: { x: -538, y: 0, z: -3570, heading: 0 } }
    }),
    async run({ human, page, expect }) {
      const start = await human.state();
      expect(Math.hypot(start.x + 538, start.z + 3570) < 40, `restored at ${start.x.toFixed(0)}, ${start.z.toFixed(0)} instead of North Sydney`);
      await human.wait(500);
      await human.down('KeyW');
      await human.wait(2000);
      await human.releaseAll();
      await expectCityCompletes(human, page, expect);
    }
  },

  'offline-file': {
    file: 'sydney.html',
    async run({ human, page, expect }) {
      expect(await page.evaluate(() => location.protocol) === 'file:', 'not running from a file');
      expect(await page.evaluate(() => document.fonts.check('14px Inter')), 'the embedded font did not load');
      expect(await page.locator('#loading-overlay .offline-link').evaluate((link) => getComputedStyle(link).display) === 'none', 'the offline copy still offers itself');
      await expectCityCompletes(human, page, expect);
      await human.down('KeyW');
      await human.wait(2000);
      await human.releaseAll();
    }
  },

  soak: {
    memory: true,
    async run({ human, page, options, metric, expect, watchdog }) {
      const minutes = options.soakMinutes;
      const places = ['macquarie', 'circularQuay', 'townHall', 'hydePark', 'darlingHarbour', 'centralStation', 'kingsCross', 'northSydney', 'harbourBridge'];
      const pick = (list) => list[Math.floor(human.random() * list.length)];
      const end = Date.now() + minutes * 60000;
      let actions = 0;
      while (Date.now() < end) {
        const roll = human.random();
        const state = await human.state();
        if (roll < 0.5) {
          const angle = human.random() * Math.PI * 2;
          const reach = human.between(80, 260);
          await human.press('Digit2');
          await human.driveTo({ x: state.x + Math.sin(angle) * reach, z: state.z + Math.cos(angle) * reach }, { timeout: 15000, arrive: 20 });
        } else if (roll < 0.65) {
          await human.press(pick(['Digit1', 'Digit3']));
          await human.down('KeyW');
          // A player who walks into a wall turns away; a real trap still trips the stuck check
          let last = await human.state();
          for (const end = Date.now() + human.between(2000, 5000); Date.now() < end;) {
            await human.wait(800);
            const now = await human.state();
            if (Math.hypot(now.x - last.x, now.z - last.z) < 0.5) await human.hold('KeyA', 500);
            last = now;
          }
          await human.releaseAll();
        } else if (roll < 0.75) {
          await human.press('Digit4');
          await human.down('Space');
          await human.wait(1000);
          await human.up('Space');
          await human.down('KeyW');
          await human.wait(human.between(2000, 4000));
          await human.releaseAll();
        } else if (roll < 0.85) {
          await human.clickTeleport(pick(places));
        } else if (roll < 0.93) {
          await human.press('KeyV');
          await human.wait(1200);
          await human.press('Digit5');
        } else {
          await human.press('KeyM');
          await human.wait(1200);
          await page.keyboard.press('Escape');
        }
        actions++;
        await human.releaseAll();
      }
      metric('soakActions', actions);
      const memory = watchdog.memory;
      metric('heapMegabytes', memory);
      if (memory.length >= 6) {
        const settled = memory[2];
        const final = memory.at(-1);
        expect(final < settled * 1.25, `JS heap grew from ${settled} MB to ${final} MB`);
      }
    }
  }
};
