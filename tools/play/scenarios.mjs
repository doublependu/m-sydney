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
  while (Date.now() - started < 210000) { // at the traffic's pace, about 12 m/s, a crossing is a little over 3 minutes
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
    minutes: 8,
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
      await page.evaluate(([a, b, c]) => window.__gameDebug.goto(a, b, c, 'car'), [x, z, heading]);
      await human.wait(600);
      expect(await page.evaluate(() => window.__gameDebug.onDeck()), 'the way back did not start on the deck');
      const south = await crossBridge(human, page, expect, -1);
      metric('deckBackToMetre', south.near);
      expect(south.near < 200 || south.left, `turned back and stopped at metre ${south.near} of the bridge`);
      const home = await human.state();
      expect(home.z > -1700, `ended short of the CBD, at z ${Math.round(home.z)}`);
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
