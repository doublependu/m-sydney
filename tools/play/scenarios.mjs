// Each scenario plays one stretch of the game. `metric` records feel numbers; `expect` fails the run.
const MPH_60 = 26.82;

async function teleportAndSettle(human, place, mode) {
  if (mode) {
    await human.press({ person: 'Digit1', car: 'Digit2', cyclist: 'Digit3', helicopter: 'Digit4' }[mode]);
    await human.react();
  }
  await human.clickTeleport(place);
  const state = await human.state();
  // A jump can land beyond the tiles held: wait for the map there, and the traffic on it
  await human.page.evaluate(([x, z]) => window.__gameDebug.mapReady(x, z), [state.x, state.z]);
  return human.state();
}

const wrapTurn = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function orbitFollowScenario(profile) {
  return {
    profile,
    async run({ human, game, page, metric, expect }) {
      const framing = () => page.evaluate(() => window.__gameDebug.framing());
      const size = page.viewportSize();
      // A drag where the camera takes it: the middle of a laptop's screen; the right half of a phone's, as the left is the stick's
      const from = profile === 'phone' ? { x: size.width * 0.75, y: size.height * 0.45 } : { x: size.width * 0.5, y: size.height * 0.45 };
      const touch = (type, points) => game.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
      let finger = 10;
      const drag = async (path, sample) => {
        const id = finger++;
        if (profile === 'phone') await touch('touchStart', [{ x: from.x, y: from.y, id }]);
        else { await page.mouse.move(from.x, from.y); await page.mouse.down(); }
        for (const [dx, dy] of path) {
          if (profile === 'phone') await touch('touchMove', [{ x: from.x + dx, y: from.y + dy, id }]);
          else await page.mouse.move(from.x + dx, from.y + dy, { steps: 2 });
          await human.wait(60);
          if (sample) await sample(await framing());
        }
        if (profile === 'phone') await touch('touchEnd', []);
        else await page.mouse.up();
      };
      const worst = {};
      await human.wait(800);
      for (const mode of ['person', 'cyclist', 'car', 'helicopter']) {
        // Macquarie St, facing the Opera House: wide and open. Put there directly, as a phone's teleport button is behind its menu
        await page.evaluate((m) => window.__gameDebug.goto(397, -1000, Math.PI, m), mode);
        if (mode === 'helicopter') await human.hold('Space', 1800);
        await human.wait(600);
        // Round the whole way in strokes a finger could make, going up and down as it goes
        const seen = { across: 0, up: 0, behind: 0 };
        const sample = (f) => {
          if (f.depth <= 0.3) seen.behind++;
          else {
            seen.across = Math.max(seen.across, Math.abs(f.x));
            seen.up = Math.max(seen.up, Math.abs(f.y));
          }
        };
        const stroke = (profile === 'phone' ? 0.42 : 1) * 160; // px, about 60 degrees on a laptop
        for (let k = 0; k < (profile === 'phone' ? 14 : 6); k++) {
          await drag(Array.from({ length: 8 }, (_, i) => [stroke * (i + 1) / 8, 90 * Math.sin(((i + 1) / 8) * Math.PI) * (k % 2 ? -1 : 1)]), sample);
        }
        worst[mode] = { across: Number(seen.across.toFixed(2)), up: Number(seen.up.toFixed(2)), behind: seen.behind };
        expect(seen.behind === 0, `${mode}: the camera lost you behind it ${seen.behind} times going round`);
        expect(seen.across < 1 / 3, `${mode}: ${seen.across.toFixed(2)} across from the middle going round`);
        expect(seen.up < 0.95, `${mode}: ${seen.up.toFixed(2)} up or down from the middle going round`);

        // Turned about 50 degrees round and let go: forward turns you there, and the camera stays where it was put
        await human.wait(400);
        const start = await framing();
        await drag([[-50, 0], [-100, 0], [-150, 0]]); // back across, which a phone's narrow screen has room for
        await human.wait(900); // the camera eases into where it's been put
        const turned = await framing();
        expect(Math.abs(wrapTurn(turned.orbit)) > 0.5, `${mode}: the drag turned the camera only ${(wrapTurn(turned.orbit) * 57.3).toFixed(0)} degrees`);
        await human.down('KeyW');
        // A car can only turn as fast as its tyres grip, from a standstill
        const done = await human.until((s) => Math.abs(wrapTurn(s.orbit)) < 0.052, { timeout: mode === 'car' ? 6000 : 3000, every: 50, read: framing });
        await human.up('KeyW');
        const after = done || await framing();
        metric(`${mode}TurnedToView`, { left: Number((wrapTurn(after.orbit) * 57.3).toFixed(1)), viewMoved: Number((wrapTurn(after.viewYaw - turned.viewYaw) * 57.3).toFixed(1)) });
        expect(done, `${mode}: still ${(wrapTurn(after.orbit) * 57.3).toFixed(1)} degrees from the view`);
        expect(Math.abs(wrapTurn(after.viewYaw - turned.viewYaw)) < 0.035, `${mode}: the camera turned ${(wrapTurn(after.viewYaw - turned.viewYaw) * 57.3).toFixed(1)} degrees with you`);
        expect(Math.abs(wrapTurn(start.heading - after.heading)) > 0.5, `${mode}: you didn't turn`);
        // The rider sits on the bike: it floated 22.5 m less the bike's own height off it
        if (mode === 'cyclist') {
          metric('riderHelmetOverBike', Number(after.riderUp.toFixed(2)));
          expect(after.riderUp > 1.3 && after.riderUp < 2.1, `the rider's helmet is ${after.riderUp.toFixed(2)} m over the bike`);
        }
        await human.wait(800);
      }
      metric('framing', worst);
    }
  };
}

// The city builds behind the game; this waits for all of it, which is what the first scripted minute can't show
async function expectCityCompletes(human, page, expect, minutes = 2.5) {
  const done = await human.page.waitForFunction(() => window.__gameDebug.worldCompleteAt() !== null, null, { timeout: minutes * 60000, polling: 500 }).catch(() => null);
  expect(done, `the city was not finished after ${minutes} min`);
  return page.evaluate(() => window.__gameDebug.renderInfo());
}

// Along the bridge's corridor, 1 from the south end, -1 from the north end, as a person would: in a lane of its own
// carriageway, out to whichever has room, lifting off when all of them are full. Northbound is the corridor itself, OSM's four
// lanes; southbound the two east of it (plan 5).
const DECK_LANES = { 1: [4.95, 1.65, -1.65, -4.95], [-1]: [10.3, 7.0] }; // m left of the corridor's line, travelling that way
// In the southbound carriageway on the deck, 1,700 m along it from the south end
const DECK_NORTH_END = { x: 88, z: -2997, heading: 0.46 };

async function crossBridge(human, page, expect, direction) {
  let highest = -Infinity, far = 0, near = Infinity, left = false, blocked = 0, standoff = 0, last = null, stuck = null;
  const lanes = DECK_LANES[direction];
  let lane = lanes[0];
  const started = human.now();
  await human.down('KeyW');
  while (human.now() - started < 330000) { // at the traffic's pace, 8 to 12 m/s, a crossing takes 3 to 5 minutes
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
    // Only what's ahead: a car behind isn't in the way, and it may well be waiting for this one to move
    const clear = (at, range) => !cars.some((v) => v.ahead > 0 && v.ahead < range && Math.abs(v.left - at) < 2.6);
    if (!clear(lane, 34)) lane = lanes.find((at) => clear(at, 34)) ?? lane;
    const boxedIn = !clear(lane, 16);
    // What it was last doing, for the message if it never arrives
    stuck = { s: Math.round(aim.s), off: +aim.off.toFixed(1), lane, speed: +state.speed.toFixed(1), boxedIn, surface: state.surface,
      x: Math.round(state.x), z: Math.round(state.z), ahead: cars.filter((v) => v.ahead > -6 && v.ahead < 40).map((v) => [Math.round(v.ahead), +v.left.toFixed(1)]) };
    await human.setKey('KeyW', !boxedIn);
    await human.setKey('KeyS', boxedIn && Math.abs(state.speed) > 4);
    await human.steerTowards(state, { x: aim.aheadX + lx * lane, z: aim.aheadZ + lz * lane }, 0.03);

    if (Math.abs(state.speed) < 1 && !boxedIn && far > 40) blocked++;
    else blocked = 0;
    // Waiting for a car alongside that's waiting for this one: a person would back off and let it go
    if (Math.abs(state.speed) < 1 && boxedIn) standoff++;
    else standoff = 0;
    if (standoff > 100) {
      standoff = 0;
      await human.backUp('KeyA');
      await human.down('KeyW');
    }
    // Stopped with nothing to wait for: pressed against something. Reverse a little and go round
    if (blocked > 24) {
      blocked = 0;
      await human.backUp('KeyA');
      await human.down('KeyW');
    }
    await human.wait(120);
  }
  await human.releaseAll();
  return { highest, far, near, left, last, stuck };
}

// Drives a way through the road graph (__gameDebug.route), steering for a point a little ahead on it, and checks at
// every step that the car is on the level the road is: on the structure (or the ground) the way runs on there, at its
// height. Near a change of level either is fine. Inside a tunnel the camera must stay under the roof, and the sky's
// light turned down. Traffic on the way is waited for, or backed away from as driveTo() does.
const TUNNEL_HEIGHT = 5.6; // js/surfaces.js
async function followRoute(human, page, waypoints, { limit = 14, resume = false } = {}) {
  const route = await page.evaluate((w) => window.__gameDebug.route(w), waypoints);
  if (route) console.log(`[route] ${route.length} points from ${Math.round(route[0].x)}, ${Math.round(route[0].z)} to ${Math.round(route.at(-1).x)}, ${Math.round(route.at(-1).z)}: ${[...new Set(route.map((p) => p.name))].slice(0, 6).join(', ')}`);
  // At walking pace at worst, for the queues at the lights
  const timeout = Math.max(120000, (route?.length ?? 0) * 8 / 3 * 1000);
  const out = { found: !!route, points: route?.length ?? 0, samples: 0, offLevel: 0, worst: null, tunnelSamples: 0, cameraOut: 0, cameraThrough: 0, otherLevelHits: 0, levelJumps: 0, restarts: 0, restartsAt: [], darkest: 0, seaInTube: 0, reached: false, seconds: 0 };
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
  let at = 0, last = await human.state(), lastMoved = human.now(), lastY = last.surfaceY, lost = 0, thisTry = { samples: 0, offLevel: 0 };
  const started = human.now();
  let readyAt = last;
  while (human.now() - started < timeout) {
    const state = await human.state();
    // On the fast clock nothing's built between steps, so the map has to be given the time as the car goes, or it drives off the end of it
    if (human.fast && Math.hypot(state.x - readyAt.x, state.z - readyAt.z) > 300) {
      readyAt = state;
      await human.releaseAll();
      await page.evaluate(async ([x, z]) => {
        const debug = window.__gameDebug;
        // It's the real clock's frames that build it
        debug.setFast(false);
        await debug.mapReady(x, z);
        debug.setFast(true);
      }, [state.x, state.z]);
    }
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
    // On a long way, it picks up from where it was knocked off, rather than going all the way back
    if (resume && lost > 25 && out.restarts < 12) {
      out.restarts++;
      out.restartsAt.push([Math.round(state.x), Math.round(state.z)]); // where it was knocked off, to look at afterwards
      await human.releaseAll();
      const from = route[Math.max(0, at - 1)], onward = route[Math.min(route.length - 1, at + 2)];
      await page.evaluate(([x, z, h]) => window.__gameDebug.goto(x, z, h, 'car'), [from.x, from.z, Math.atan2(onward.x - from.x, onward.z - from.z)]);
      await human.wait(700);
      lost = 0;
      last = await human.state();
      lastMoved = human.now();
      continue;
    }
    if (!resume && lost > 25 && out.restarts < 3) {
      out.restarts++;
      out.restartsAt.push([Math.round(state.x), Math.round(state.z)]);
      out.samples -= thisTry.samples;
      out.offLevel -= thisTry.offLevel;
      thisTry = { samples: 0, offLevel: 0 };
      await toStart();
      at = 0;
      lost = 0;
      last = await human.state();
      lastY = last.surfaceY;
      lastMoved = human.now();
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
        // The sea runs through a tunnel that dips below it, so it mustn't be drawn while the camera's in one
        if (cam.shelter > 0.5 && await page.evaluate(() => window.__gameDebug.seaShown())) out.seaInTube++;
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
      lastMoved = human.now();
    } else if (human.now() - lastMoved > 3000) {
      await human.backUp(error > 0 ? 'KeyD' : 'KeyA');
      last = await human.state();
      lastMoved = human.now();
    }
    await human.wait(100);
  }
  await human.releaseAll();
  out.seconds = Math.round((human.now() - started) / 1000);
  return out;
}

// Ways across the levels, each starting on the ground (or the bridge deck) a little before the structure it's about
const LEVEL_ROUTES = {
  // William St under Kings Cross, a tube each way
  williamEast: [{ x: 1217, z: 27 }, { x: 1400, z: 66 }, { x: 1705, z: 115 }, { x: 1901, z: 97 }],
  williamWest: [{ x: 1951, z: 136 }, { x: 1707, z: 130 }, { x: 1396, z: 78 }, { x: 1219, z: 34 }],
  // The Sydney Harbour Tunnel each way, from the Cahill Expressway's end to North Sydney and back: two tubes side by side under the
  // harbour, its road below sea level for over a kilometre
  harbourTunnelNorth: [{ x: 452, z: -1200, name: 'Sydney Harbour Tunnel Northbound' }, { x: 453, z: -1315, name: 'Sydney Harbour Tunnel' },
    { x: -172, z: -3507, name: 'Sydney Harbour Tunnel' }],
  harbourTunnelSouth: [{ x: -133, z: -3511, name: 'Sydney Harbour Tunnel' }, { x: 463, z: -1307, name: 'Sydney Harbour Tunnel' },
    { x: 462, z: -1199, name: 'Sydney Harbour Tunnel Southbound' }],
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
  // Off the bridge by the York St ramp, from its southbound carriageway (plan 5: the corridor is northbound only)
  yorkStreetOff: [{ x: 149, z: -2805, name: 'Bradfield Highway' }, { x: -285, z: -1288, name: 'York Street Offramp' }, { x: -294, z: -1055 }],
  // The Cahill Expressway over Circular Quay, and back through its tunnel under the Domain end
  cahillEast: [{ x: -250, z: -1503 }, { x: -246, z: -1365 }, { x: 405, z: -1345 }, { x: 475, z: -1215 }],
  cahillWest: [{ x: 452, z: -1200 }, { x: 405, z: -1337 }, { x: -345, z: -1382 }],
  // Plan 5: the video's drive (ref/, "Driving across the Sydney Harbour Bridge"): up Clarence St, its tidal-flow ramp onto the bridge,
  // over it and on to North Sydney
  bridgeClarence: [{ x: -280, z: -700, name: 'Clarence Street' }, { x: -338, z: -1083, name: 'Bradfield Highway Onramp' },
    { x: -185, z: -1758, name: 'Sydney Harbour Bridge' }, { x: 141, z: -2803, name: 'Sydney Harbour Bridge' }, { x: -55, z: -3261, name: 'Sydney Harbour Bridge' }],
  // The other ways up at the CBD end: from Bridge St by Grosvenor St, and round the Cahill's loop in its cutting
  grosvenorUp: [{ x: -60, z: -1047, name: 'Bridge Street' }, { x: -170, z: -1066, name: 'Grosvenor Street' }, { x: -185, z: -1758, name: 'Sydney Harbour Bridge' }],
  cahillLoopUp: [{ x: 200, z: -1330, name: 'Cahill Expressway' }, { x: -420, z: -1345, name: 'Cahill Expressway' }, { x: -185, z: -1758, name: 'Sydney Harbour Bridge' }],
  // And the ways off, from the southbound carriageway and the Cahill's lane
  westernSuburbsOff: [{ x: 149, z: -2805, name: 'Bradfield Highway' }, { x: -362, z: -1078, name: 'Western Distributor' }, { x: -459, z: -587, name: 'Western Distributor' }],
  grosvenorOff: [{ x: 149, z: -2805, name: 'Bradfield Highway' }, { x: -200, z: -1062, name: 'Grosvenor Street' }],
  cahillOff: [{ x: 157, z: -2806, name: 'Cahill Expressway' }, { x: -246, z: -1365 }, { x: 405, z: -1345 }]
};

async function driveLevels(human, page, metric, expect, names) {
  for (const name of names) {
    const r = await followRoute(human, page, LEVEL_ROUTES[name]);
    metric(name, { reached: r.reached, seconds: r.seconds, samples: r.samples, offLevel: r.offLevel, tunnelSamples: r.tunnelSamples, cameraOut: r.cameraOut, cameraThrough: r.cameraThrough, otherLevelHits: r.otherLevelHits, levelJumps: r.levelJumps, restarts: r.restarts, restartsAt: r.restartsAt, darkest: +r.darkest.toFixed(2), seaInTube: r.seaInTube, worst: r.worst });
    expect(r.found, `${name}: no way through the road graph`);
    expect(r.reached, `${name}: didn't get to the end in ${r.seconds} s`);
    expect(r.offLevel <= Math.max(1, r.samples * 0.03), `${name}: off its level ${r.offLevel} times of ${r.samples}, worst ${JSON.stringify(r.worst)}`);
    expect(r.cameraThrough === 0, `${name}: the camera went through what's overhead ${r.cameraThrough} times of ${r.samples}`);
    expect(r.otherLevelHits === 0, `${name}: traffic on another level was hit ${r.otherLevelHits} times`);
    expect(r.levelJumps === 0, `${name}: the car jumped a level ${r.levelJumps} times`);
    if (r.tunnelSamples) {
      expect(r.cameraOut === 0, `${name}: the camera was above the tunnel's roof ${r.cameraOut} times of ${r.tunnelSamples}`);
      expect(r.darkest > 0.8, `${name}: the light inside the tunnel only went down to ${r.darkest.toFixed(2)}`);
      expect(r.seaInTube === 0, `${name}: the sea was drawn inside the tunnel ${r.seaInTube} times`);
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

// Walking into the one building with a model, and out again
function testBuildingScenario() {
  return {
    async run({ human, page, metric, expect }) {
      const debug = (fn, ...args) => page.evaluate(fn, ...args);
      const SITE = { x: 442.5, z: -528, yaw: 0.0353 };
      const toWorld = (x, z) => ({ x: SITE.x + x * Math.cos(SITE.yaw) + z * Math.sin(SITE.yaw), z: SITE.z - x * Math.sin(SITE.yaw) + z * Math.cos(SITE.yaw) });
      await page.waitForFunction(() => window.__gameDebug.worldCompleteAt() !== null, null, { timeout: 180000, polling: 500 });
      const loaded = await debug(() => performance.getEntriesByType('resource').map((r) => r.name));
      expect(!loaded.some((name) => /GLTFLoader|\.glb/.test(name)), 'the model or its loader came with the first view');
      const memoryBefore = await debug(() => window.__gameDebug.gpuMemory());

      // Outside the door, facing it (heading is towards +x, into the building)
      const door = toWorld(-11, 0);
      await debug(({ x, z, heading }) => window.__gameDebug.goto(x, z, heading, 'person'), { ...door, heading: Math.PI / 2 + SITE.yaw });
      await page.waitForFunction(() => window.__gameDebug.interior().held.length > 0, null, { timeout: 20000, polling: 200 });
      await human.wait(1000);
      const outside = await debug(() => window.__gameDebug.interior());
      expect(outside.inside === null, 'already inside, standing outside');

      await human.down('w');
      const entered = await human.until(async () => (await debug(() => window.__gameDebug.interior())).inside !== null, { timeout: 15000 });
      expect(entered, 'walked up to the door and never got in');
      await human.wait(1800);
      await human.up('w');
      const inside = await human.state();
      const room = await debug(() => window.__gameDebug.interior());
      expect(room.inside === 'test-lobby', 'not inside by the time they stopped');
      expect(Math.abs(inside.surfaceY - room.floor) < 0.01, `not standing on the floor: at ${inside.surfaceY}, the floor at ${room.floor}`);
      await debug(() => window.__gameDebug.frameCost());
      await human.wait(4000);
      const frames = await debug(() => window.__gameDebug.frameCost());
      metric('fpsInside', frames.fps);
      expect(frames.fps > 20, `only ${frames.fps} FPS inside`);

      // Into the far wall: it stops you, and it's only the door that lets you out
      await human.down('w');
      await human.wait(4500);
      await human.up('w');
      const atWall = await human.state();
      const wall = toWorld(14.4 / 2 - 0.3, 0);
      expect(atWall.x <= Math.max(wall.x, atWall.x) && (await debug(() => window.__gameDebug.interior())).inside === 'test-lobby', 'walked out through a wall');

      // Back out of the door
      await debug(({ x, z, heading }) => window.__gameDebug.goto(x, z, heading, 'person'), { ...toWorld(-5, 0), heading: -Math.PI / 2 + SITE.yaw });
      await human.wait(500);
      await human.down('w');
      const left = await human.until(async () => (await debug(() => window.__gameDebug.interior())).inside === null, { timeout: 10000 });
      await human.up('w');
      expect(left, 'never got back out of the door');

      // Far away, it's all let go of
      await debug(() => window.__gameDebug.goto(397, -1000, Math.PI, 'person'));
      await page.waitForFunction(() => window.__gameDebug.interior().held.length === 0, null, { timeout: 15000, polling: 200 });
      // Twice, since the first time more of the map came with it. The second has only the model to bring and let go of.
      const settled = async () => {
        await human.wait(4000);
        return (await debug(() => window.__gameDebug.gpuMemory())).geometries;
      };
      const first = await settled();
      await debug(({ x, z, heading }) => window.__gameDebug.goto(x, z, heading, 'person'), { ...door, heading: Math.PI / 2 + SITE.yaw });
      await page.waitForFunction(() => window.__gameDebug.interior().held.length > 0, null, { timeout: 20000, polling: 200 });
      await human.wait(1000);
      const near = (await debug(() => window.__gameDebug.gpuMemory())).geometries;
      await debug(() => window.__gameDebug.goto(397, -1000, Math.PI, 'person'));
      await page.waitForFunction(() => window.__gameDebug.interior().held.length === 0, null, { timeout: 15000, polling: 200 });
      const second = await settled();
      metric('geometries', { start: memoryBefore.geometries, away: first, near, awayAgain: second });
      expect(second <= first + 6, `the model's memory stayed: ${first} geometries to ${second}`);
    }
  };
}

// The origin moving can't be seen, and nothing big gets near a shader. Done on the line between two origins, where either one will do.
function originScenario(query) {
  return {
    query,
    async run({ page, metric, expect }) {
      const debug = (fn, ...args) => page.evaluate(fn, ...args);
      await debug(() => window.__gameDebug.goto(1916, 134, 1.6, 'car'));
      await page.waitForFunction(() => window.__gameDebug.worldCompleteAt() !== null, null, { timeout: 180000, polling: 500 });
      await page.waitForTimeout(1500);
      await debug(() => window.__gameDebug.holdStill(true));
      const look = async () => {
        await debug(() => window.__gameDebug.rewrite());
        await page.waitForTimeout(800);
        return debug(() => window.__gameDebug.grab());
      };
      const before = await look();
      const auditAt0 = await debug(() => window.__gameDebug.auditPrecision());
      await debug(() => window.__gameDebug.setOrigin(4096, 0));
      const moved = await look();
      const auditMoved = await debug(() => window.__gameDebug.auditPrecision());
      const difference = await page.evaluate(async ([a, b]) => {
        const pixels = async (url) => {
          const image = await createImageBitmap(await (await fetch(url)).blob());
          const canvas = new OffscreenCanvas(image.width, image.height);
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, image.width, image.height).data;
        };
        const [p, q] = await Promise.all([pixels(a), pixels(b)]);
        let sum = 0, big = 0;
        for (let i = 0; i < p.length; i += 4) {
          const d = (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2])) / 3;
          sum += d;
          if (d > 16) big++;
        }
        return { mean: sum / (p.length / 4), share: big / (p.length / 4) };
      }, [before, moved]);
      metric('picture', { mean: +difference.mean.toFixed(2), overSixteenPercent: +(difference.share * 100).toFixed(2) });
      metric('audit', auditMoved);
      // Shadows snap to their own texels and leaves keep moving, which is about all that's left
      expect(difference.mean < 3.5, `the picture changed when the origin moved: ${difference.mean.toFixed(2)} of 255 on average`);
      expect(difference.share < 0.015, `${(difference.share * 100).toFixed(2)}% of the picture changed when the origin moved`);
      for (const audit of [auditAt0, auditMoved]) {
        expect(audit.vertex < 16384, `a vertex ${Math.round(audit.vertex)} m from its mesh's zero, in ${audit.vertexIn}`);
        expect(audit.instance < 16384, `an instance ${Math.round(audit.instance)} m from its mesh's zero, in ${audit.instanceIn}`);
        expect(audit.model < 32768, `a mesh ${Math.round(audit.model)} m from zero, in ${audit.modelIn}`);
      }
      // The real thing: drive far enough and it moves on its own
      await debug(() => window.__gameDebug.holdStill(false));
      await debug(() => window.__gameDebug.goto(-1700, -2800, 0, 'car'));
      await page.waitForTimeout(1500);
      await debug(() => window.__gameDebug.goto(-2400, -600, 0, 'car'));
      await page.waitForFunction(() => window.__gameDebug.origin().x === -4096, null, { timeout: 15000, polling: 200 }).catch(() => expect(false, 'the origin stayed behind the player'));
    }
  };
}

export const SCENARIOS = {
  'harbour-bridge': {
    fast: true,
    query: 'wholeCity=1', // about the roads, not about fetching them, and too quick for fetching to keep up
    minutes: 13,
    async run({ human, page, metric, expect }) {
      await human.wait(1000);
      await teleportAndSettle(human, 'harbourBridge');
      const north = await crossBridge(human, page, expect, 1);
      metric('deckReachedMetres', north.far);
      metric('deckHighestMetres', Math.round(north.highest));
      expect(north.highest > 48, `the deck only reached ${north.highest} m`);
      expect(north.far > 2000 || north.left, `drove ${north.far} m of the bridge: ${JSON.stringify(north.stuck)}`);
      const end = await human.state();
      expect(end.z < -3000, `ended short of North Sydney, at z ${Math.round(end.z)}`);

      // And back into the CBD
      const { x, z, heading } = DECK_NORTH_END;
      await page.evaluate(([a, b, c]) => window.__gameDebug.goto(a, b, c, 'car', true), [x, z, heading]);
      await human.wait(600);
      expect(await page.evaluate(() => window.__gameDebug.onDeck()), 'the way back did not start on the deck');
      const south = await crossBridge(human, page, expect, -1);
      metric('deckBackToMetre', south.near);
      expect(south.near < 200 || south.left, `turned back and stopped at metre ${south.near} of the bridge: ${JSON.stringify(south.stuck)}`);
      const home = await human.state();
      expect(home.z > -1700, `ended short of the CBD, at z ${Math.round(home.z)}`);
    }
  },

  // Plan 5: every way on and off the Harbour Bridge at the CBD end, and the drive in the video: on its level all the way, nothing
  // overhead through the camera, no jump between levels, no traffic hit on another level
  'bridge-ways': {
    fast: true,
    query: 'wholeCity=1',
    minutes: 25,
    async run({ human, page, metric, expect }) {
      await human.wait(1000);
      await driveLevels(human, page, metric, expect, ['bridgeClarence', 'distributorNorth', 'grosvenorUp', 'cahillLoopUp', 'yorkStreetOff', 'westernSuburbsOff', 'grosvenorOff', 'cahillOff']);
    }
  },

  // Through the Kings Cross tunnel both ways: on the tunnel's road all the way, the camera inside, the daylight gone
  tunnel: {
    fast: true,
    query: 'wholeCity=1', // about the roads, not about fetching them, and too quick for fetching to keep up
    minutes: 6,
    async run({ human, page, metric, expect }) {
      await human.wait(1000);
      await driveLevels(human, page, metric, expect, ['williamEast', 'williamWest']);
    }
  },

  // The Harbour Tunnel's two tubes, end to end each way with no sea in view, and steering hard into each wall half way under the
  // harbour: a tube's walls hold, so the car never ends up in the other one
  'harbour-tunnel': {
    fast: true,
    query: 'wholeCity=1', // about the roads, not about fetching them, and too quick for fetching to keep up
    minutes: 10,
    async run({ human, page, metric, expect }) {
      await human.wait(1000);
      await driveLevels(human, page, metric, expect, ['harbourTunnelNorth', 'harbourTunnelSouth']);
      for (const [name, way] of [['northbound', 'harbourTunnelNorth'], ['southbound', 'harbourTunnelSouth']]) {
        // Half way along the tube as it is now: the generator moves tubes that ran too close (tools/tiles/separate-tubes.mjs)
        const route = await page.evaluate((w) => window.__gameDebug.route(w), LEVEL_ROUTES[way]);
        expect(!!route, `${name}: no way through the tunnel`);
        if (!route) continue;
        const i = route.length >> 1, p = route[i], q = route[i + 2];
        const [x, z, heading] = [p.x, p.z, Math.atan2(q.x - p.x, q.z - p.z)];
        await human.releaseAll();
        await page.evaluate(([a, b, c]) => window.__gameDebug.goto(a, b, c, 'car', true), [x, z, heading]);
        await human.wait(800);
        const start = await human.state();
        const surfaces = new Set([start.surface]);
        for (const side of ['KeyA', 'KeyD']) {
          await human.down('KeyW');
          await human.down(side);
          for (let t = 0; t < 20; t++) {
            await human.wait(150);
            surfaces.add((await human.state()).surface);
          }
          await human.releaseAll();
        }
        const end = await human.state();
        const moved = Math.round(Math.hypot(end.x - start.x, end.z - start.z));
        metric(`${name}Walls`, { from: [Math.round(x), Math.round(z)], surfaces: [...surfaces], moved });
        // Pressed against a wall it's held, as at a parapet: it only has to be able to move at all
        expect(moved > 3, `${name}: the car only moved ${moved} m with the accelerator down`);
        expect(surfaces.size === 1, `${name}: steering into the walls took the car from tube ${start.surface} to ${[...surfaces].filter((s) => s !== start.surface).join(', ')}`);
        expect(start.surface !== 0, `${name}: didn't start in the tunnel`);
      }
    }
  },

  // Roads over roads, on each level: the Argyle Cut, Pier St, Central, and the Cahill over Circular Quay and back
  'stacked-roads': {
    fast: true,
    query: 'wholeCity=1', // about the roads, not about fetching them, and too quick for fetching to keep up
    minutes: 20,
    async run({ human, page, metric, expect }) {
      await human.wait(1000);
      await driveLevels(human, page, metric, expect, ['cumberland', 'argyleEast', 'pierStreet', 'zollnerCircuit', 'colonnade', 'eddyAvenue', 'cahillEast', 'cahillWest']);
    }
  },

  // The Western Distributor onto the bridge, and off it by the York St ramp
  motorways: {
    fast: true,
    query: 'wholeCity=1', // about the roads, not about fetching them, and too quick for fetching to keep up
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
      const climb = await page.evaluate(async ([x, z, ax, az]) => {
        const here = await window.__gameDebug.route([{ x, z, name: 'William Street' }, { x: x + ax * 100, z: z + az * 100, name: 'William Street' }]);
        return here && here.length > 3 ? (here[here.length - 1].y - here[0].y) / (8 * (here.length - 1)) : null;
      }, [start.x, start.z, ahead.x, ahead.z]);
      metric('grade', climb === null ? null : +climb.toFixed(3));
      expect(climb !== null && climb > 0.03, `this is meant to be a hill, and it's a grade of ${climb}`);
      expect(start.surfaceY > 20, `not on the hill: road at ${start.surfaceY}`);
      expect(Math.abs(start.speed) < 0.3, `moving before the start: ${start.speed} m/s`);
      const rest = await human.state();
      expect(Math.abs(along(rest)) < 0.5, `rolled ${along(rest).toFixed(2)} m standing on the hill`);
      await human.down('KeyW');
      const started = human.now();
      let lowest = 0, at8 = null, last = rest;
      while (human.now() - started < 12000) {
        const s = await human.state();
        lowest = Math.min(lowest, along(s));
        if (at8 === null && s.speed >= 8) at8 = (human.now() - started) / 1000;
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

  // Teleports once the city's built: the bar comes up for each place that needs the map brought in, names it, gets to the end and
  // goes. It used to be there only for the first build, so a teleport faded to black and then the city arrived with nothing said.
  'teleport-bar': {
    minutes: 8,
    async run({ page, metric, expect }) {
      await page.waitForFunction(() => window.__gameDebug.worldCompleteAt() !== null, null, { timeout: 240000, polling: 500 });
      await page.waitForTimeout(1500);
      const results = {};
      for (const name of ['bondi', 'parramatta', 'manly', 'cronulla', 'hornsby', 'macquarie']) {
        await page.evaluate((key) => {
          // One watcher at a time: the last place's stops when this one starts
          const seen = (window.__barSeen = []);
          const started = performance.now();
          const watch = () => {
            if (window.__barSeen !== seen) return;
            const s = window.__gameDebug.progress();
            seen.push({ t: performance.now() - started, shown: s.shown, value: s.value, label: s.label });
            if (performance.now() - started < 90000) setTimeout(watch, 100);
          };
          // The menu's own button, as a player does: the debug goto() fetches the place's tiles before it moves you
          document.querySelector(`[data-teleport="${key}"]`).click();
          watch();
        }, name);
        // Till the map's in and the bar has gone
        await page.waitForFunction(() => {
          const seen = window.__barSeen;
          const first = seen.findIndex((s) => s.shown);
          return first >= 0 && seen.slice(first).some((s) => !s.shown) || (seen.length && seen.at(-1).t > 60000);
        }, null, { timeout: 120000, polling: 250 }).catch(() => {});
        const seen = await page.evaluate(() => window.__barSeen);
        const shown = seen.filter((s) => s.shown);
        const firstShown = shown[0]?.t ?? null;
        results[name] = { shownAfterMs: firstShown && Math.round(firstShown), shownMs: shown.length * 100, highest: Math.round(Math.max(0, ...shown.map((s) => s.value)) * 100), labels: [...new Set(shown.map((s) => s.label))] };
        expect(firstShown !== null && firstShown < 700, `${name}: the bar ${firstShown === null ? 'never showed' : `took ${Math.round(firstShown)} ms to show`}`);
        expect(shown.some((s) => s.value > 0.99) || seen.some((s, i) => i && seen[i - 1].shown && !s.shown), `${name}: the bar didn't get to the end`);
        expect(shown.some((s) => s.label.startsWith('Loading')), `${name}: the bar didn't say where it was loading`);
        await page.waitForTimeout(1000); // the city has to catch up a little before the next jump
      }
      metric('teleports', results);
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
        const started = human.now();
        for (;;) {
          const state = await human.state();
          const aim = await page.evaluate(([x, z, d]) => window.__gameDebug.bridgeAim(x, z, d), [state.x, state.z, leg.direction]);
          expect(aim && await page.evaluate(() => window.__gameDebug.onDeck()), `left the deck at ${Math.round(state.x)}, ${Math.round(state.z)}`);
          if (!aim || (leg.direction > 0 ? aim.s > leg.to : aim.s < leg.to) || human.now() - started > 100000) break;
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
    minutes: 6,
    async run({ human, page, metric, expect }) {
      await expectCityCompletes(human, page, expect); // traffic joins the game with the last of the city
      const { x, z, heading, approach, target } = UNDER_THE_DECK;
      await page.evaluate(([a, b, c]) => window.__gameDebug.goto(a, b, c, 'car'), [x, z, heading]);
      await human.wait(1500);
      const parked = await human.state();
      let overhead = 0, struck = 0, stalled = 0, above = false;
      const started = human.now();
      // At least half a minute, and however long it takes one to come along: the deck carries a few at a time
      while (human.now() - started < 30000 || (overhead === 0 && human.now() - started < 180000)) {
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

  // Alone at a red, nobody else about: the light has no reason to keep you waiting
  // Across Inner Sydney in the helicopter, at its own speed: the map keeps up, frames stay in budget, memory stays flat
  'long-flight': {
    memory: true,
    minutes: 9,
    async run({ human, page, metric, expect }) {
      await expectCityCompletes(human, page, expect);
      await page.evaluate(() => window.__gameDebug.goto(-9000, 1700, Math.PI / 2, 'helicopter', false, 220));
      await human.wait(3000);
      const from = await human.state();
      await page.evaluate(() => window.__gameDebug.frameCost());
      await human.down('KeyW');
      const heaps = [], fps = [], behind = [];
      const end = human.now() + 5 * 60000;
      while (human.now() < end) {
        await human.wait(30000);
        const look = await page.evaluate(async () => {
          // Garbage doesn't count: what's still reachable after collecting it twice
          for (let i = 0; i < 2; i++) {
            window.gc?.();
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          return {
            fps: window.__gameDebug.frameCost().fps,
            heap: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576),
            ready: window.__gameDebug.tileState().done.length
          };
        });
        heaps.push(look.heap);
        fps.push(Math.round(look.fps));
        behind.push(look.ready);
      }
      await human.releaseAll();
      const to = await human.state();
      metric('flown', Math.round(Math.hypot(to.x - from.x, to.z - from.z)));
      metric('fpsEach30s', fps);
      metric('heapEach30s', heaps);
      metric('tilesEach30s', behind);
      expect(Math.hypot(to.x - from.x, to.z - from.z) > 8000, 'barely got anywhere');
      expect(Math.min(...fps) > 20, `down to ${Math.min(...fps)} FPS`);
      if (heaps[1] > 0) expect(heaps.at(-1) < heaps[1] * 1.35, `the heap grew over the flight: ${heaps.join(', ')} MB`);
    }
  },

  // The long way, both ways: down the Northern Beaches to Palm Beach, and through Sutherland to Cronulla
  'long-drive-north': {
    memory: true,
    fast: true,
    minutes: 75,
    async run({ human, page, metric, expect }) {
      await human.wait(1000);
      const leg = await followRoute(human, page, [{ x: 1500, z: -8000 }, { x: 5300, z: -14400 }, { x: 6476, z: -31602 }], { limit: 18, resume: true });
      metric('drive', { found: leg.found, reached: leg.reached, points: leg.points, seconds: leg.seconds, restarts: leg.restarts, restartsAt: leg.restartsAt, levelJumps: leg.levelJumps });
      expect(leg.found, 'no way to Palm Beach on the map');
      expect(leg.reached, 'never reached Palm Beach');
    }
  },
  'long-drive-south': {
    memory: true,
    fast: true,
    minutes: 45,
    async run({ human, page, metric, expect }) {
      await human.wait(1000);
      const leg = await followRoute(human, page, [{ x: -1741, z: 5498 }, { x: -11279, z: 19282 }, { x: -2105, z: 20668 }], { limit: 18, resume: true });
      metric('drive', { found: leg.found, reached: leg.reached, points: leg.points, seconds: leg.seconds, restarts: leg.restarts, restartsAt: leg.restartsAt, levelJumps: leg.levelJumps });
      expect(leg.found, 'no way to Cronulla on the map');
      expect(leg.reached, 'never reached Cronulla');
    }
  },

  // From the CBD out to Bondi, by road, driving as a person does: the suburbs go by, and nothing stops the drive for long
  'long-drive': {
    memory: true,
    fast: true,
    minutes: 25,
    async run({ human, page, metric, expect }) {
      await human.wait(1000);
      const leg = await followRoute(human, page, [{ x: 1200, z: 200 }, { x: 4088, z: 1430 }, { x: 6200, z: 1150 }], { limit: 16 });
      metric('drive', { found: leg.found, reached: leg.reached, points: leg.points, seconds: leg.seconds, restarts: leg.restarts, restartsAt: leg.restartsAt, levelJumps: leg.levelJumps, offLevel: leg.offLevel });
      expect(leg.found, 'no way from the CBD to Bondi on the map');
      expect(leg.reached, 'never reached Bondi');
    }
  },

  'test-building': testBuildingScenario(),
  'test-building-phone': { ...testBuildingScenario(), profile: 'phone' },
  'origin-move': originScenario(''),
  'origin-far': originScenario('originTest=85000'),
  'signal-wait': {
    query: 'cars=1',
    async run({ human, page, metric, expect }) {
      await page.evaluate(() => window.__gameDebug.goto(3, 30, 0, 'car'));
      await page.waitForFunction(() => window.__gameDebug.worldCompleteAt() !== null, null, { timeout: 180000, polling: 500 });
      await page.waitForFunction(() => window.__gameDebug.signalApproaches(3, 30, 400).length > 0, null, { timeout: 60000, polling: 500 });
      const waits = [];
      const approaches = (await page.evaluate(() => window.__gameDebug.signalApproaches(3, 30, 500)))
        .filter((a) => !a.sid && a.groups > 1 && a.len > 25 && a.nodes === 1);
      expect(approaches.length >= 3, `only ${approaches.length} signalled approaches to try`);
      const showing = (a) => page.evaluate(({ x, z, junction, group }) => window.__gameDebug.signalApproaches(x, z, 40)
        .find((b) => b.junction === junction && b.group === group)?.showing, a);
      const tried = new Set();
      for (const a of approaches) {
        if (tried.size >= 3 || tried.has(a.junction) || (await showing(a)) !== 'red') continue;
        tried.add(a.junction);
        // Stopped 15 m short of the line, facing it
        const heading = Math.atan2(a.dx, a.dz);
        await page.evaluate(({ x, z, heading }) => window.__gameDebug.goto(x, z, heading, 'car'), { x: a.x - a.dx * 15, z: a.z - a.dz * 15, heading });
        const started = human.now();
        let light = await showing(a);
        while (light !== 'green' && human.now() - started < 40000) {
          await human.wait(250);
          light = await showing(a);
        }
        waits.push((human.now() - started) / 1000);
      }
      metric('secondsAtRed', waits.map((w) => +w.toFixed(1)));
      expect(waits.length >= 2, `only ${waits.length} reds to wait at`);
      for (const w of waits) expect(w <= 11, `waited ${w.toFixed(1)} s at a red with nobody else about`);
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
        for (const deadline = human.now() + 20000; human.now() < deadline && !crashed;) {
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
      const deadline = human.now() + 12000;
      while (!hit && human.now() < deadline) {
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

      const hitAt = human.now();
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
      metric('crashRecoverySeconds', recovery.reached ? Number(((human.now() - hitAt) / 1000).toFixed(1)) : null);
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

  // Dragging the camera round, by mouse or by a finger on the right half of a phone, never loses you; and moving forward turns
  // you to where it looks, with the camera staying put (js/cameras.js, steerToView() in js/controllers.js)
  'orbit-follow': orbitFollowScenario('laptop'),
  'orbit-follow-phone': orbitFollowScenario('phone'),

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
      const started = human.now();
      const down = await human.until((s) => s.y < 1, { timeout: 30000 });
      await human.up('KeyQ');
      metric('heliDescentSeconds', down ? Number(((human.now() - started) / 1000).toFixed(1)) : null);
      metric('heliSettledAltitude', Number((await human.state()).y.toFixed(1)));

      // Roof landing: climb clear of any tower it has landed beside (they stop a helicopter, as they should), fly on until
      // there is a roof underneath, stop, and sink straight down onto it
      await human.down('Space');
      const clearOfTowers = await human.until((s) => s.y > 150, { timeout: 15000, every: 100 });
      await human.up('Space');
      expect(clearOfTowers, 'could not climb above the towers');
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

  // Every travel mode starts where the last one left off (js/arrivals.js): on a street, on the bridge, in a tunnel, over
  // the harbour and beside the tallest towers
  'mode-switch': {
    async run({ human, page, metric, expect }) {
      const key = { person: 'Digit1', car: 'Digit2', cyclist: 'Digit3', helicopter: 'Digit4' };
      const go = async (mode) => {
        await human.press(key[mode]);
        await human.wait(350);
        return human.state();
      };
      const at = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
      const place = async (x, z, heading, mode, deck = false) => {
        await page.evaluate(([a, b, c, d, e]) => window.__gameDebug.goto(a, b, c, d, e), [x, z, heading, mode, deck]);
        await human.wait(500);
        return human.state();
      };
      await human.wait(800);
      await human.down('KeyW');
      await human.wait(1500);
      await human.releaseAll();
      await human.wait(600);

      // On a street: out onto the footpath, back into the car where it was left
      const car = await human.state();
      const walker = await go('person');
      expect(walker.mode === 'person' && walker.footpath, `a walker from the car isn't on a footpath, at ${walker.x.toFixed(0)}, ${walker.z.toFixed(0)}`);
      expect(at(walker, car) < 30, `the footpath was ${at(walker, car).toFixed(0)} m from the car`);
      const back = await go('car');
      expect(at(back, car) < 0.5, `back in the car ${at(back, car).toFixed(1)} m from where it was left`);
      const rider = await go('cyclist');
      expect(at(rider, back) < 25, `the bicycle started ${at(rider, back).toFixed(0)} m from the car`);
      const flyer = await go('helicopter');
      expect(at(flyer, rider) < 2, `the helicopter started ${at(flyer, rider).toFixed(0)} m across from the bicycle`);
      expect(flyer.y >= 58, `the helicopter arrived only ${flyer.y.toFixed(0)} m up`);
      metric('flyHeightOverMacquarieSt', Math.round(flyer.y));

      // Beside the tallest tower: it clears the roof
      const tower = await place(-13, -1240, 0, 'cyclist');
      const high = await go('helicopter');
      expect(at(high, tower) < 2, 'straight up, beside the tower');
      expect(high.y >= 240, `only ${high.y.toFixed(0)} m up, beside a tower 263 m tall`);
      metric('flyHeightBesideSalesforceTower', Math.round(high.y));

      // Out of the air over the harbour: to the shore, or a road
      await page.evaluate(() => window.__gameDebug.goto(300, -2200, 0, 'helicopter'));
      await human.wait(400);
      const shore = await go('person');
      expect(shore.footpath, `over the harbour, a walker should reach the shore, at ${shore.x.toFixed(0)}, ${shore.z.toFixed(0)}`);
      await place(300, -2200, 0, 'helicopter');
      const road = await go('car');
      expect(road.surface === 0 && road.surfaceY > -1, 'a car from over the harbour should reach a road');

      // On the deck: the walker on the footway stays on it, walking along; a car and a bicycle stay on the deck
      const deck = await page.evaluate(() => {
        const p = window.__gameDebug.bridgePlace(1100);
        return [p.x, p.z, p.h];
      });
      await place(deck[0], deck[1], deck[2], 'car', true);
      const onDeck = await human.state();
      expect(onDeck.surface !== 0, 'the car should start on the deck');
      const footway = await go('person');
      expect(footway.onFootway && footway.surface === onDeck.surface, `no footway: ${JSON.stringify(footway).slice(0, 180)}`);
      expect(Math.abs(footway.surfaceY - onDeck.surfaceY) < 3, 'got out of the car and fell off the bridge');
      await human.hold('KeyW', 2500);
      const walked = await human.state();
      expect(at(walked, footway) > 3 && walked.onFootway, `walking the footway went ${at(walked, footway).toFixed(1)} m`);
      const deckRider = await go('cyclist');
      expect(deckRider.surface === onDeck.surface, 'the bicycle left the deck');
      const overDeck = await go('helicopter');
      expect(overDeck.y + overDeck.surfaceY >= 150, `the helicopter would hit the arch at ${(overDeck.y + overDeck.surfaceY).toFixed(0)} m`);
      const backOnDeck = await go('car');
      expect(backOnDeck.surface === onDeck.surface, 'down from the air, the car should land on the deck under it');

      // In a tunnel
      await place(1550, 112, 1.43, 'car', true);
      const inTunnel = await human.state();
      expect(inTunnel.surface !== 0, 'should start in the tunnel');
      const tunnelWalker = await go('person');
      expect(tunnelWalker.surface === inTunnel.surface, 'out of the car in a tunnel, you stay in the tunnel');
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

      // The stick appears wherever the thumb lands on the left half of the screen
      const size = page.viewportSize();
      const center = { x: size.width * 0.25, y: size.height * 0.7 };
      const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
      await touch('touchStart', [{ x: center.x, y: center.y, id: 1 }]);
      await touch('touchMove', [{ x: center.x, y: center.y - 40, id: 1 }]);
      await human.wait(3000);
      const driving = await human.state();
      expect(Math.abs(driving.speed) > 3, `joystick drove at only ${driving.speed.toFixed(1)} m/s`);
      const ring = await page.locator('#touch-stick').boundingBox();
      expect(ring && Math.hypot(ring.x + ring.width / 2 - center.x, ring.y + ring.height / 2 - center.y) < 2, 'the stick did not appear under the thumb');
      await touch('touchEnd', []);
      await page.waitForTimeout(50);
      expect(await page.locator('#touch-stick').isHidden(), 'the stick is still drawn with no thumb on it');
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

      const center2 = { x: 844 * 0.25, y: 390 * 0.7 };
      await touch('touchStart', [{ x: center2.x, y: center2.y, id: 2 }]);
      await touch('touchMove', [{ x: center2.x + 30, y: center2.y - 30, id: 2 }]);
      await human.wait(2000);
      await touch('touchEnd', []);

      await page.setViewportSize({ width: 390, height: 844 });
      await human.wait(1000);
      expectFit(await fits(), 'portrait again');

      // Everything that went behind the menu can still be reached
      // Not the eye button: a phone's HUD fades by itself, so there's none (plan 4)
      const hidden = ['#btn-teleport', '#btn-open-map', '#btn-pause', '#btn-sound', '#cam-next', '.repo-link'];
      for (const selector of hidden) expect(await page.locator(selector).isHidden(), `${selector} shows with the menu closed`);
      await page.locator('#btn-phone-menu').click();
      for (const selector of hidden) expect(await page.locator(selector).isVisible(), `${selector} can't be reached from the menu`);
      expect(!(await page.locator('#btn-toggle-hud').isVisible()), 'the eye button is on the phone\'s menu');
      await touch('touchStart', [{ x: 300, y: 500, id: 3 }]);
      await touch('touchEnd', []);
      await human.wait(200);
      expect(await page.locator('#btn-pause').isHidden(), 'a touch elsewhere should close the menu');
      // The modes open from the current one
      expect(await page.locator('#mode-helicopter').isHidden(), 'other modes show with the mode button closed');
      await page.locator('#mode-car').click();
      expect(await page.locator('#mode-helicopter').isVisible(), 'the current mode should open the others');
      await page.locator('#mode-cyclist').click();
      await human.wait(400);
      expect((await human.state()).mode === 'cyclist', 'choosing a mode from the list should switch to it');
      expect(await page.locator('#mode-helicopter').isHidden(), 'choosing a mode should close the list');
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

  // The map comes in tiles around the player and goes again behind them (js/tiles/, js/main.js). Across the whole of it and
  // back: what's far is let go of, what's near is there with traffic on it, memory stays flat and nobody near is lost.
  'tile-streaming': {
    memory: true,
    minutes: 8,
    async run({ page, human, metric, expect }) {
      await expectCityCompletes(human, page, expect);
      const stops = [[-541, -3570], [1451, -8], [174, 1001], [-1500, 900], [397, -1000]];
      const heaps = [], colliders = [], tiles = [], gpu = [];
      for (let round = 0; round < 3; round++) {
        for (const [x, z] of stops) {
          const ready = await page.evaluate(([a, b]) => window.__gameDebug.goto(a, b, 0, 'car').then(() => window.__gameDebug.mapReady(a, b)), [x, z]);
          expect(ready, `the map never came at (${x}, ${z})`);
          await human.wait(1500);
          const state = await page.evaluate(([a, b]) => ({
            tiles: window.__gameDebug.tileState(),
            cars: window.__gameDebug.trafficNear(a, b, 400).length,
            heap: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576)
          }), [x, z]);
          tiles.push(state.tiles.done.length);
          colliders.push(state.tiles.colliders);
          expect(state.cars > 0, `no traffic near (${x}, ${z})`);
          // Nothing built more than the range and its margin away (2 km at most on any level, and the margin)
          for (const key of state.tiles.done) {
            const [ix, iz] = key.split('_').map(Number);
            const dx = Math.max(ix * 1000 - x, 0, x - (ix + 1) * 1000), dz = Math.max(iz * 1000 - z, 0, z - (iz + 1) * 1000);
            expect(Math.hypot(dx, dz) < 2600, `tile ${key} is still built, ${Math.round(Math.hypot(dx, dz))} m from (${x}, ${z})`);
          }
        }
        // Garbage doesn't count: what's still reachable after collecting it twice
        heaps.push(await page.evaluate(async () => {
          for (let i = 0; i < 2; i++) {
            window.gc?.();
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          return Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576);
        }));
        gpu.push(await page.evaluate(() => window.__gameDebug.tileState().gpu));
      }
      metric('gpuObjectsEachRound', gpu);
      expect(gpu.at(-1).geometries <= gpu[0].geometries * 1.3, `geometries on the GPU grew: ${gpu.map((g) => g.geometries).join(', ')}`);
      expect(gpu.at(-1).textures <= gpu[0].textures * 1.3, `textures on the GPU grew: ${gpu.map((g) => g.textures).join(', ')}`);
      // How long a jump across the map leaves the player waiting behind the fade
      const waits = await page.evaluate(() => window.__gameDebug.groundWaits());
      metric('groundWaitWorstMs', Math.max(0, ...waits));
      expect(Math.max(0, ...waits) < 10000, `a teleport waited ${Math.max(...waits)} ms for the ground`);
      metric('tilesBuilt', tiles);
      metric('colliders', colliders);
      metric('heapMegabytesEachRound', heaps);
      expect(Math.max(...tiles) < 120, `every tile stayed built: ${Math.max(...tiles)}`);
      if (heaps[0] > 0) expect(heaps.at(-1) < heaps[0] * 1.15, `the heap grew over three crossings: ${heaps.join(', ')} MB`);

      // A new network under moving traffic: everyone near keeps their place
      const handover = await page.evaluate(async () => {
        const before = window.__gameDebug.handover();
        for (let i = 0; i < 400 && window.__gameDebug.handover().count === before.count; i++) {
          if (i === 0) window.__gameDebug.goto(397 + 500, -1000, 0, 'car');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return window.__gameDebug.handover();
      });
      metric('handover', handover);
      expect(handover.count > 0, 'the road network never changed');
      expect(handover.kept > handover.lost * 2, `a new network lost too much traffic: ${JSON.stringify(handover)}`);
    }
  },

  soak: {
    memory: true,
    async run({ human, page, options, metric, expect, watchdog }) {
      const minutes = options.soakMinutes;
      // The CBD, and streets of houses, where cars are parked along the kerbs
      const places = ['macquarie', 'circularQuay', 'townHall', 'hydePark', 'darlingHarbour', 'centralStation', 'kingsCross', 'northSydney', 'harbourBridge',
        'bondiJunction', 'deeWhy', 'bankstown', 'cronulla', 'parramatta', 'chatswood'];
      const pick = (list) => list[Math.floor(human.random() * list.length)];
      const end = human.now() + minutes * 60000;
      let actions = 0;
      while (human.now() < end) {
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
          for (const end = human.now() + human.between(2000, 5000); human.now() < end;) {
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
