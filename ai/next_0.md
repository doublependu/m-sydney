# Next 0: what shipped from plan 0, and what to do next

Answers `ai/plan_0.md`. Phases 1-9 are implemented, with the gaps listed under "Not done". Nothing is committed or deployed.

## Results

Measured on an i5-11400F with an RTX 3060, Chrome 156, cold profile, local server. There is no integrated GPU here, and the New York numbers come from a different machine (i7-13620H with Intel UHD), so they are a reference, not a comparison. The phone profile is Chrome throttled on this desktop, not a phone.

| Measure | Spec or budget | New York | Sydney |
|---|---|---|---|
| Time to interaction, desktop | 2-3 s, 4 s max, bench budget 2.5 s | 1.61 s | **2.25 s** at High (3 runs, 2.22-2.26) |
| Time to interaction, phone profile | 2-3 s, 4 s max, bench budget 4 s | 3.55 s | **3.63 s** at Low (3 runs, 3.62-3.65) |
| Frames, desktop | "plays well" | | 60 FPS, 95th percentile 16.8 ms |
| Frames, phone profile | main thread under 33 ms | about 21 ms | 40 FPS, 95th percentile 33.3 ms, main thread about 19 ms |
| 1080p on Intel UHD, default level | 30 FPS, 50 ms | 30.6 FPS, 46.6 ms | **not measured** |
| Download | no more than New York | 1.4 MB | 1,383 KB |
| Memory | no more than New York | about 1.7 GB | **not measured** whole-process. JS heap peaks at 626 MB, then holds at 350-420 MB for the 10-minute soak |
| Offline file | under 25 MiB | 3.7 MB | 4.19 MB |

The phone profile sits 0.37 s under its budget. That is thin for a throttled desktop standing in for a real phone.

The rest of the city arrives behind the game: 8.5 s later on desktop, 22.7 s later on the phone profile at 34 FPS, with a worst stall of 397 ms there.

242 unit tests pass and `npm run viewports` is clean at all 9 sizes. `wrangler deploy --dry-run` passes. Of the 20 play scenarios, 19 pass in the full run, including the 10-minute soak. **`harbour-bridge` does not pass reliably:** 5 of 8 runs on this build. See "Known limits".

## What shipped

| Phase | Result |
|---|---|
| 1 Import | New York code at `c6e6a3f`, `LICENSE-slop-newyork-MIT` beside the GPL-3.0 licence, renamed to Sydney throughout. Worker `m-sydney`, offline file `sydney.html` |
| 2 Data | `npm run data:fetch`, `npm run data:build`, Node only. Snapshots stay in `tools/data/`, which is ignored. Output: `js/geodata.js`, 15,785 buildings, 23,760 surveyed trees, a height grid |
| 3 Streets | The grid and the island are gone. `js/city-config.js`, `js/road-network.js` and `js/city-grid.js` work from real centrelines, with curb islands, pavements and lawns from the data |
| 4 Left-hand traffic | `DRIVE_SIDE = -1`. Traffic, buses, doors, the cockpit, plates, road paint and crossings at any shape of junction |
| 5 Terrain | Real heights as a render-only lift over a flat simulation. Works on WebGL2 |
| 6 Harbour Bridge | Drivable corridor, arch, pylons, a separate level for deck traffic. Elevated motorways as scenery with ambient traffic |
| 7 Sydney content | Opera House, Sydney Tower, Town Hall, Central, QVB, St Mary's, Luna Park, ferries, light rail, Australian signals and their ticking, post boxes, bus shelters, species-mapped trees, pitched roofs |
| 8 Map, HUD | Atlas on real roads, search, teleports, cinematic cameras, km/h and metres |
| 9 Play | 20 scenarios through real input. New: `under-the-bridge` and `device-lost`. `harbour-bridge` now crosses both ways in traffic. `npm run bench` and `npm run viewports` clean |

## The bug worth reading about

Until the last day, **no car could reach the Harbour Bridge or anywhere north of The Rocks**, and every check passed. The network held 3,967 edges, all in the CBD. The bridge and all 1,176 edges north of it were discarded by the filter that keeps the largest strongly connected set. I had reported "connected network, about 4,000 edges", which was true and hid the problem: nothing measured *where* those edges were. It surfaced only because a new scenario asserted that traffic had passed overhead, rather than only that nothing went wrong.

It was six separate breaks in a chain, each hiding the next:

1. **`covered=yes` was treated as a tunnel.** Argyle, George and Cumberland Sts under the bridge's approach and Hickson Rd under the Walsh Bay wharves are ordinary streets with something built over them, and the only ways out of The Rocks. The repair step for missing links was undirected, so it saw the area as already joined by one-way streets. This was the root cause.
2. **Curves between deck edges were tested against the ground plan** 45 m below them.
3. **The deck meets Upper Fort St at a hairpin**, which the no-U-turn rule refused.
4. **A kerb corner in the way of every curve made a dead end.** Now the straightest move goes ahead and clips it.
5. **17% of all candidate roads were closed by one sample.** Simplified block outlines lap over narrow streets, and `laneOpen` failed a whole road on one hit. A kerb now closes a lane only if it covers over 70% of it. Anything solid still closes it on one sample.
6. **A two-way street could survive in one direction only**, and a road could have no way in. Both are repaired.

Edges went from 3,967 to about 5,500. `tests/road-network.test.mjs` now pins this, and the network builds in under a second in Node, so it costs nothing to run.

Traffic reaching the bridge for the first time then exposed three more bugs that an empty deck had hidden:

7. **Deck traffic ran 10.8 m off the bridge.** A road takes a node only at a bend over 12°, so the gently curving span was one 1,342 m chord, and its lanes missed the corridor's own centre line. A driver keeping left by the bridge's centre line met everything head on, which looked for a long time like a traffic jam and then like a badly written bot. The deck now has a node at every point of its path (48 edges, 1.2 m at worst).
8. **A second deck stood beside the arch.** The Cahill's lanes on the bridge came through as a 340 m viaduct, because "near the bridge" measured distance to vertices and the span has none for a kilometre. My test of this used a guessed coordinate that wasn't on the bridge, so it passed. It now samples the whole deck. I first blamed its piers for cars stopping near the south pylon. That was wrong: cars on the deck never test colliders. Bug 7 fits those stops, since its error was largest around there.
9. **Every car in the pool landed on the deck.** Cars are placed around the player, and in mid-span there's nothing else around: 160 within 350 m, one each 26 m of lane, at 34 km/h. The deck now spawns with a 60 m gap and runs at 1.5 times street pace.

## Worth knowing when working in this code

- **The simulation is flat.** Everything runs at y = 0, and terrain and the deck are applied at render time (`liftStage` in `js/main.js`, `groundAt` in `js/traffic.js`). So hills don't change how a car drives, and two levels share x and z: anything comparing positions must also compare levels (`onPlayersLevel`, `onDeck`).
- **Assert that the thing happened, not only that nothing bad did.** The first version of `under-the-bridge` found no deck traffic and would have passed. Its "overhead > 0" check is what exposed the empty bridge, and a mutation run proved the rest of it: with the level check disabled a deck car stops dead for a car parked 45 m below.
- **Distance to a simplified line means distance to its segments.** `rdp` leaves long stretches with no vertices. Measuring to vertices caused bug 8 here, and a false alarm about the Cahill while looking at it.
- **A test scenario's driver must drive.** The bridge's centre line was a fine path while the deck was empty. `crossBridge` now keeps left, changes lanes and lifts off, by lateral position against the deck's own tangent. A car that sees you coming stops for you, for ever, if you keep pressing into it.
- **Cars on the deck don't test colliders.** `resolveHorizontalCollision` returns early there: the rails are the only limit. So a pylon's 28 m collision box, which reaches the centre line on paper, is no wall on the deck. The deck is boarded only within 45 m of an end, so a teleport to mid-span leaves a car on the flat level below it.
- **Traffic joins the game after the city finishes,** about 10 s in on desktop. `trafficSystem` is null until then, so a scenario looking for cars must wait for `worldCompleteAt`.
- **The sky bake and the compile target collide.** `selectTime` must release the compile target around the bake, or WGSL fails with "structures must have at least one member".
- **`DoubleSide` turns a back face's normal over.** A surface wound the wrong way is lit from the wrong side, which is how the viaducts' undersides came out sunlit. Winding matters even when both sides draw.
- **One-sided road material.** A deck seen from below needs its own underside, or it isn't there.
- **Road polygons are tiled** (`tiledPolygons`), and `blockAt` is an index of curb outlines. Change an outline's row layout and the index must follow.
- **OSM's coastline trap:** `natural=coastline` leaves Port Jackson's bays open. Land is the detail rectangles minus the harbour relation, plus piers.
- **The global DEM trap:** a 30 m DEM puts the harbour's edges on the wrong side of the seawalls. Heights come from local contours, and are 2 m contours north of the harbour.
- **A load time means nothing without its graphics level.** Auto guesses from the GPU's reported vendor, so one machine can land on different levels. One bench read 1.69 s and looked like a win, but its draw count and stage times were those of a lighter level. `npm run bench` now prints the level of every run and leaves 3 s between browsers, and six runs since have held steady. I didn't confirm what caused the odd one.
- **`WebGL2 right after a closed WebGPU browser` loses its context.** `npm run play` waits 3 s between browsers for this. It failed every time with no gap and passed every time with one. Chrome logs "GPU state invalid" within a second of launch, before the game does any work, and the kernel log shows no GPU error. I didn't find the mechanism below the browser. A player can't reach this state.

## Bugs that play-testing and looking at the game found

- **A tap between two frames did nothing.** Jump read whether the key was held on that frame, and whether the feet were on the ground to 2 cm. It failed once in a full run and never alone. A same-task keydown and keyup reproduced it every time, then a 150 ms queue in game time fixed it, for touch too.
- **A lost GPU left a frozen picture,** and only a console message. New York has this too. Phones do this under memory pressure, so there's now a dialog with Reload, your position is saved, and it can't be dismissed. It never reloads by itself, which would loop on a device that keeps losing it. `device-lost` kills the context for real and checks all of that.
- **Viaducts had no undersides,** so cars floated across a gap of sky, and then had sunlit undersides.
- **An MTA disc on every bus front,** and New York's Select Bus Service as a 25% variant, both surviving the rename. Now gone, the variant being a yellow express with no logo.

## Not done

From the plan, as written:

- **Landmarks:** Customs House, Hyde Park's Archibald Fountain and Anzac Memorial, Pyrmont Bridge. Crown Sydney exists only as a data building.
- **Surroundings:** Fort Denison.
- **Buildings:** terraces with iron lace. Awnings are the generic ones. `tools/data/cos_awnings.json` is fetched but not used.
- **Streets:** train and metro entrances.
- **Moving scenery:** trains on the bridge, gulls, ibis.
- **Audio:** ferry horns, gulls.
- **Play scripts:** George St on foot and Darling Harbour as routes, a "never below ground" check, a hill start. The last has little to test, since hills don't affect a flat simulation.
- **Tuning:** `js/quality.js` has New York's numbers, not values retuned for 5-year-old devices. Feel wasn't retuned either.

## Not verified

- **Intel UHD, or any integrated GPU.** This machine is an i5-11400F with an RTX 3060, so the plan's 30 FPS at 1080p budget is unmeasured, and traffic now reaches more of the map than when the desktop numbers were first taken. This is the biggest open risk against the Spec.
- **Real phones and iOS Safari.** The phone profile is Chrome throttled on a desktop.
- **WebGL2 frame rate.** It loads, plays and recovers, but its FPS hasn't been measured as a real target.
- **Production Cloudflare.** Only `wrangler deploy --dry-run`.
- **Overture's licence terms.** Review before shipping its data.
- **North-shore heights.** 2 m contours, not checked against survey points the way the CBD's are.
- **Whether it's fun.** That's your call, from the recordings and from playing it.
- **Memory.** The soak watches the JS heap only, not the plan's whole-process budget.

## Known limits

- **36% of candidate edges still have no traffic** (5,524 of 8,571 kept). Many are cul-de-sacs and fringe pieces, but only 323 of the north shore's 1,255 edges are kept, so large parts of it are quiet. They're drawn and the player can drive them. They just stay empty.
- **`harbour-bridge` is unreliable, 5 passes in 8 runs.** Two failures were limits in the script, both fixed: a restart on the bridge's last metre, and a time limit 7 m short. The third is open, and with both fixes in place the score is 1 of 2. That car sat at s = 1366, 6.5 m off centre on the oncoming side, until time ran out. Cars on the deck don't test colliders, so nothing fixed held it. Traffic must have, and a nose-to-nose standoff is the likely story, but I didn't prove it. When it works, it crosses both ways with real traffic, from the north end's boarding zone.
- **`crash-recovery` varies, and I don't know why.** It took about 2 s in every run until today, and now takes 2 s or about 8 s (1.9, 2.0, 8.2, 8.8). It stays under its limit, with no backing up needed. More traffic around the crash is a guess I didn't test.
- **`first-minute` braking went from 33 m to 37.5 m** with no change to car physics, steady over three runs. One full run read 21.7 m. Not explained.
- **A crossing in traffic takes about 3 minutes,** at about 12 m/s on average, and deck traffic at 1.5 times street pace is still under the signed 70 km/h for the slowest cars and buses.
- **Clipped kerbs.** Forced moves and the 70% rule mean some cars cut a corner or run partly over a slab on narrow streets. It's the price of those roads existing.
- **Viaducts are scenery.** The player can't drive on them, and the helicopter flies through them. Heights come from OSM `layer`, which is a guess at real clearance.
- **The Anzac Bridge is a plain viaduct,** with no pylons or cables.
- **Motorways at ground level aren't drawn** (the Warringah Freeway, for one), so a viaduct's ramp comes down into nothing.
- **The player can't leave the deck onto the York St ramp.** The real ramps are motorways, so the south end joins the city by Upper Fort St and Watson Rd, through a hairpin.
- **Dark straight-edged wedges on the water** from high altitude, cause unknown.
- **No shadow for the player's vehicle on the deck.**
- **Big unknown buildings** such as stadiums use a guessed height.

## What to do next

1. **Run it on a real Intel laptop and a real phone.** `npm run bench` and an hour of play. Everything about the Spec's device targets rests on this, and it's the only thing that can't be done here.
2. **Retune `js/quality.js`** from those numbers, including WebGL2.
3. **Play it, and watch `recordings/`.** Traffic on the bridge and north of it is new as of the last day, so it has had the least looking at. Watch the hairpin at the south end. Try to get stuck on the deck: if a person can, the `harbour-bridge` failure is a game bug and not a script one.
4. **Bring back more of the north shore's roads.** The edge-walking approach under "The bug worth reading about" shows what's still cut.
5. **Fill in the landmarks** a Sydney person would look for first: Pyrmont Bridge, then the Anzac Memorial and Archibald Fountain.
6. **Review Overture's licence,** then `npx wrangler login` and `npm run deploy`.
