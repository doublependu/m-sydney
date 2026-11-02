# Plan 3: roads you can drive smoothly, one road colour, lights that respond, phone buttons out of the way, then Inner Sydney and all of Sydney

Answers `ai/prompt_3.md`.

Nothing is implemented yet. The experiments ran from the scratchpad, against copies of the game, so the only change to this repo is this file. `dist/`, which git ignores, was rebuilt once.

## Disk space

You asked for this first. **Allow 15 GB. This disk has 1.5 TB free.** The downloads come to about 3 GB in all, and each is fetched only when a phase needs it.

| Item | Download | On disk | When | How sure |
|---|---|---|---|---|
| OSM, Geofabrik's Australia extract | 972 MB | 972 MB | Phase 15 | Exact, from the server |
| OSM cut to the box, with an index | | About 1 GB | Phase 15 | Estimate |
| Overture buildings and parts | About 0.7 GB | About 0.7 GB, 120 MB of it for Inner Sydney | Phases 15, 16 | Scaled from today's snapshot |
| NSW 5 m elevation, whole box | About 1.3 GB | About 1.3 GB, 120 MB of it for Inner Sydney | Phases 15, 16 | Worked out, and a 256 px sample came out at the expected 4 bytes a pixel |
| Generator results per tile | | Up to 8 GB | Phases 15, 16 | Estimate. No larger map has been built yet |
| Finished tiles | | About 150 MB | Phases 15, 16 | Estimate |

Plan 2 named the Australia and Oceania extract at 1.2 GB. It's now 1.58 GB, and the Australia-only file has everything needed.

## Short answers

**The slant is real, and it's how roads are built.** Every point on a road takes its height straight from the ground, so a road across a hillside leans with the hillside. 50% of road length leans over 4%, 16% over 10%, and the worst ordinary street 39%. Real streets usually fall about 2-3%. Giving each road its own smooth height and capping the lean at 4% moves the kerb line by 0.5 m or less on 90% of roads, and adds about 15% to the map's bytes in a prototype.

**The two road colours are two separate things.**

- **Your bridge ramp is footpath paving drawn over the road.** Only roads on the ground cut through the kerb islands, so a ramp doesn't, and the paving carries on over it. Near (-318, -1401) it stands 0.68 m above the deck and the car's wheels sink into it. It's the worst of 16 such places.
- **Everywhere else, the road changes colour with the way you face.** The same stretch of road is light brown looking towards the sun and dark grey looking away, so turning a corner switches it. Low graphics has no shadows, which makes it worse. On top of that, large blotches and rectangular patches in the asphalt make it look random.

**The lights don't look at traffic.** All 328 signalled junctions share one 60 s clock, with 30 s of red. 76 of them have no crossing traffic at all, so cars there sit through 30 s of red for nobody. In 36-43% of the moments a car waits at the front of a red, nobody is using the green. A prototype where each junction responds to who's there cut the median wait from 12-18 s to 6-10 s.

**The phone's controls cover 26-41% of the screen.** The plan takes that to 10% or less, and to nothing in the middle of the screen.

**Your smoothness idea works, and it finds problems play didn't.** A script walked all 942 km of lane positions by the game's own rules in 3.7 s. It found 12 places where a car stops dead, 168 with a building under the car, 624 with a wheel on a kerb, and 125 with a sudden step of up to 1.5 m. It becomes a check that runs on every change.

**Tests can run while I keep working.** A run reads `dist/` as it goes, so a rebuild breaks it. Running from a copy of the build fixes that. Running browsers side by side helps less than I hoped: 4 at once gave about 1.5 times the speed.

**The real traffic simulation also runs without a browser,** 50 times faster than real time, and its numbers are close to the real game's. That's what makes the traffic work practical.

**I don't have a proven fix for North Sydney's traffic.** The lights help Town Hall a lot and barely help North Sydney, where cars mostly stop because the next road looks full. See "Traffic". Plan 3 fixes what it can and reports the numbers, rather than promising a result.

## Prompt items

| Prompt item | Status | Phase |
|---|---|---|
| 1. Hold-ups at merges, before Phase 15 | Measured, causes listed, not fully solved | E |
| 2. Update phases for what 11 and 12 changed | Done below | 13, 15 |
| 3. Disk space first | Above | |
| 4. Phase 14: plain test building only | Scope cut | 14 |
| 5. Stop after Phase 15, and after Palm Beach and Cronulla | Two stops | 15, 16a |
| 6. Worst frame since loading in `?stats=1` | Small | A |
| Issue 1: roads slant left to right | Cause found, prototype measured | F |
| Issue 2: phone buttons block the view | Measured, design below | C |
| Issue 3: two road colours | Causes found and tested | B |
| Issue 4: lights take forever | Cause found, prototype measured | D |
| Issue 5: slow tests | Background runs, tested | A |
| Issue 5: smoothness criteria and bumps | Prototype run, criteria below | A, F |

## Measurements

### Road slant

Over 247 km of road on the ground, leaving out the ends where junctions take over. Lean is the height difference edge to edge, over the road's width.

| Lean over | Share of road | | Edge to edge over | Share of road |
|---|---|---|---|---|
| 4% | 50% | | 0.5 m | 33% |
| 6% | 35% | | 1 m | 12% |
| 10% | 16% | | 2 m | 2% |
| 20% | 3.4% | | 3 m | 0.4% |

Worst on ordinary streets: Clark Rd 39% at (240, -3620), Lavender Cres 39% at (-522, -3266), Bayview St 38% at (-514, -3043), Holdsworth St 37% at (233, -3844). Worst of all is the Macquarie St offramp, 56% at (478, -1231). Bayview St and Premier St average about 25% along their whole length.

The cause is `roadHeight()` (`js/surfaces.js:318`), which returns the terrain at the exact point asked, including at each edge of the road (`js/ground-geometry.js:383`).

Grade along the road is a different matter, and mostly true to life: 5.5% of road is over 10%, 0.9% over 15%. Sydney has steep streets, so the plan keeps them.

### A prototype of graded roads

A scratch script gave each road a height profile smoothed along its length, pinned where roads meet, with lean capped at 4%. It measures the road's shape and the bytes. It doesn't draw anything or handle junction surfaces and cuttings, so treat these as a guide.

| | Today | Smoothed over 40 m | Smoothed over 80 m |
|---|---|---|---|
| Worst lean | 39% (56% on a ramp) | 4% | 4% |
| Change of grade over 10 m + 10 m, 99th percentile | 5.4% | 4.9% | 3.7% |
| Share over 3% | 3.9% | 3.9% | 1.8% |
| Share over 6% | 0.7% | 0.5% | 0.2% |
| Worst | 21% | 13% | 12% |
| Road centre off the terrain, 99th percentile | | 0.3 m | 0.8 m |
| Kerb line off the terrain, 90th percentile | | 0.4 m | 0.5 m |
| Kerb line off the terrain by over 1 m | | 1.3% | 2.1% |
| Kerb line off the terrain by over 1.5 m | | 0.2% | 0.5% |
| Ground beside roads as a 5 m grid, total | | 188 KB | 197 KB |
| The same, median tile | | 4 KB | 4 KB |

Today's tiles total 1,227 KB, so that's about 15% more. The first view holds 8 or so tiles, the CBD's being the largest, so expect 30-100 KB more there. A 10 m grid costs 62 KB in all, and may not fit the kerbs closely enough. Where two roads simply continue into each other, the change of grade across the joint is 4.9% at the 90th percentile and 28% at worst, which is why a profile has to run across joints.

### What stops or jolts a car

A scratch script walked every road as drawn, at the lane positions a driver would use (942 lane km, 3.7 s), using the game's `chooseSurface()` and `wheelContacts()` and the real building polygons. I checked a sample by eye and they're real: at Systrum St (-524, 800) a wall is hard against the lane, at Napoleon St (-421, -856) a kerb corner cuts in, and on Moore Park Rd's ramp (1465, 1323) and Sir John Young Cres (972, -560) road surface swallows part of the car.

| What | Today | Where |
|---|---|---|
| Stops dead: no surface within reach | 173 m at 12 places | Warringah Fwy (-229, -3754), Cahill Expwy (-104, -3526), Argyle St (-194, -1552), Cross City Tunnel (1050, 27) |
| Building under the car | 1,570 m at 168 places, 189 buildings | Wallaringa Ave (871, -3630), Kurraba Rd (374, -3734), Munro St (-1052, -3194) |
| A wheel on a kerb island | 3,470 m at 624 places, the car's middle on 199 m | Bradly Ave, Aubin St |
| Sudden step, over 25 cm in 1 m | 801 m at 125 places, up to 1.5 m | Harbour St (-361, 142), Eastern Distributor (1216, 1172), Western Distributor (-1335, -10) |
| Roll changes by over 4% in 1 m | 4,784 m at 784 places, worst 36% | Munro St (-1011, -3111), Lance Lane (-543, -1409) |
| Paving or lawn at or over the road | 16 places on the centre line of a ramp or bridge. As area: ground roads 0.9%, cuttings 1.1%, ramps and bridges 1.5%. Ground road centre lines: none | See "Road colour" |

Why, where the code says:

- **Buildings:** `tools/build-geodata.mjs:287` holds a two-way road at 6.4 m even where the walls are closer, so the wall ends up in the road. OSM's centre line also isn't always midway between the walls.
- **Steps of up to 1.5 m:** that's the limit in `chooseSurface()` (`js/surfaces.js:17`), so a car is allowed to jump that far between surfaces in one frame, where a structure's end doesn't meet the road it joins.
- **Traffic's own lanes:** edges are straight, so on a gentle curve they cut the corner. 2.6% of traffic's lane length is off every carriageway, and 3.9% is over a kerb island. That's for the cars around you, not the one you drive.

### Road colour

Same place and time, Low graphics, the player's car hidden. "Facing north" is towards the default golden hour's sun. Mean colour just ahead of the car:

| Scratch change to the road's shader | Pitt St facing north | Pitt St facing south | Kent St facing north | Kent St facing south |
|---|---|---|---|---|
| None | 147, 129, 117 | 118, 102, 95 | 145, 126, 113 | 136, 119, 108 |
| No wetness | 143, 125, 113 | 128, 111, 103 | 145, 126, 113 | 137, 120, 109 |
| No bump map | 147, 129, 117 | 118, 102, 95 | 145, 126, 113 | 136, 119, 108 |
| No blotches | 152, 134, 122 | 126, 110, 102 | 149, 130, 118 | 137, 119, 109 |
| Less sun reflected | 122, 106, 98 | 110, 95, 88 | 125, 108, 100 | 128, 111, 103 |
| Less sun reflected, no blotches | 129, 113, 105 | 120, 103, 96 | 130, 113, 105 | 128, 112, 104 |

The patch is close to the car, and the pictures show the difference better than the numbers, because further up the road the gap is much wider. The last row is close to the same grey both ways. Four causes:

1. **Paving over ramps.** `tools/build-geodata.mjs:295`: only roads on the ground cut the kerb islands. `groundHeight()` lowers the ground under a low deck, but paving only samples the ground at its edges and on the 20 m grid (`js/ground-geometry.js:226`), so most likely it never notices a narrow corridor through its middle. Worst places: the Harbour Bridge approach (-318, -1401) by 0.68 m, Western Distributor (-386, -215) by 0.31 m, Pyrmont Bridge Rd (-1198, 66) by 0.21 m, Dalgety Rd (-637, -1657) by 0.16 m. A picture at the first shows the whole view as large square slabs, with the car's wheels sunk in them.
2. **The sun's reflection.** A rough surface still reflects strongly at a low angle, and the golden hour's sun is bright and warm. Looking towards it, the road turns light brown. Away from it, dark. Low has no shadows at all (`js/quality.js:5`), so on your phone every road does this all the time. At High, shadows and blue skylight make the same road blue-grey.
3. **Blotches.** The asphalt mixes two tones about 2.5 times apart in brightness at a scale of a few metres, half of all 11 m cells hold a hard-edged patch, and nearly half of those are almost black (`js/tsl-materials.js:1503`, `1439`, `1575`).
4. **Shading measured from sea level.** `canyonSkyAONode` (`js/tsl-materials.js:195`) is the mistake Phase 2 fixed on façades. Ambient light on a road is about 0.34 at sea level, 0.67 at 30 m and 1.0 above 68 m, so a road's brightness drifts as it climbs. I read this in the code and didn't isolate it on screen. Eight materials use it.

Also seen: on Low, puddles are hard-edged blue shapes with a white glint, and golden hour has them on a sunny day (`js/lighting.js:41`). They're a third colour on the road and on footpaths.

### Lights

`SIGNAL_TIMING` (`js/city-config.js:345`): a 60 s cycle on one clock for the whole map. Each direction gets 26 s of green, 4 s of amber and 30 s of red.

| Signalled junctions | |
|---|---|
| Total | 328 |
| With only one right-of-way group: no crossing traffic, 30 s of red for nobody | 76 (23%) |
| With no more than one approach | 46 |
| With more than two groups, which all share one phase | 12 |
| Pairs within 45 m of each other, such as the two halves of a divided road | 84 |

The player's car isn't part of any of this, so a demand-driven light has to be told about it, or you'd wait at it forever.

### Traffic

Measured two ways, at High's 200 cars and 12 buses, within 500 m of the player. **Real game:** in Chrome, 2 minutes each. **Simulation:** the real `js/traffic.js` under Node with drawing stubbed, the whole map's roads and no pedestrians, 6 minutes after a 2-minute warm-up. It simulates 600 s in about 12 s.

| | North Sydney, game | North Sydney, simulation | Town Hall, game | Town Hall, simulation |
|---|---|---|---|---|
| Cars stopped | 42% | 50% | 43% | 44% |
| Mean speed | 3.3 m/s | 2.7 m/s | 4.1 m/s | 3.7 m/s |
| Queues held by "no room ahead" | 52% | 68% | 18% | 22% |
| Queues held by a red light | 21% | 17% | 59% | 52% |
| Queues held by a car changing lane | 14% | 7% | 4% | 11% |
| Front car's wait at a red: median, 95th percentile | 17 s, 39 s | 18 s, 40 s | 14 s, 39 s | 12 s, 34 s |
| Green unused while it waits | 43% | 36% | 36% | 43% |
| Cars recycled as stuck, per minute | 5.5 | 11 | 10.5 | 13 |

So 5-13 cars a minute are stuck long enough for the safety valve to remove them. Trying changes in the simulation, one on top of another from the third row:

| Change | North Sydney: stopped, speed | Town Hall: stopped, speed | Median wait at a red | Green unused |
|---|---|---|---|---|
| Today | 50%, 2.7 m/s | 44%, 3.7 m/s | 18 s, 12 s | 36%, 43% |
| A shorter fixed cycle, 36 s (instead of today's) | 50%, 2.7 m/s | 44%, 3.7 m/s | 12 s, 8 s | 61%, 47% |
| Lights respond to demand | 50%, 2.7 m/s | 38%, 4.2 m/s | 10 s, 6 s | 2%, 9% |
| + a moving car ahead counts as room | 45%, 2.8 m/s | 32%, 4.7 m/s | 13 s, 6 s | 3%, 7% |
| + joints skip the room check | 43%, 2.9 m/s | 36%, 4.3 m/s | 10 s, 5 s | 7%, 8% |

What that says:

- **A shorter cycle doesn't help traffic,** and wastes more green. Responding to demand is the right change.
- **At North Sydney, cars mostly stop for a car that's driving away.** Following each "no room ahead" to its end, 62% end with the next road's last car moving. `room()` (`js/traffic.js:890`) counts it as taking up road as if parked.
- **Roads are cut very short.** 42% of edges are under 25 m. 35% of nodes (1,312 of 3,703) are just a joint between two links, with nothing joining, and a car still treats each one as a junction.
- **Fixing one cause moves the queue to the next.** In the last row, cars standing inside junctions become the largest group, at 30-39%.
- **It's not only how many cars there are.** With Low's 60 cars, North Sydney still has 37% stopped and 51% of queues held by "no room ahead". Town Hall reaches 5 m/s with 34% stopped.

### Phone screen

Share of the screen covered by the HUD, with the city still building:

| Screen | Covered | Of the middle 60% |
|---|---|---|
| 360 × 640 | 41% | 27% |
| 390 × 844 | 27% | 8% |
| 844 × 390 | 26% | 3% |
| 640 × 360 | 33% | 7% |

In portrait the top alone has two rows of tools, a brand panel, the camera control and a progress panel, down to about 220 px. At the bottom sit the road signs, a 136 px stick that's always drawn, and the mode bar. A "hide HUD" button exists, but you have to know it's there.

### Tests

The last full run's largest scenarios: soak 303 s, tile-streaming 108, harbour-bridge 78, bridge-edges 67, auto-steps-down 54, helicopter 53, drive-route 51, under-the-bridge 50, stacked-roads 47.

| 4 scenarios | Time |
|---|---|
| One after another | 191 s |
| All at once | 128 s, all pass |

That's 1.5 times the speed, not 4, and it disturbs what's being timed: drive-route took 67 s instead of 49 s. So running side by side is only for scenarios that don't measure time or frames.

### What Phases 11 and 12 changed for what's left

| Thing | Today | Why it won't scale | Plan |
|---|---|---|---|
| Generators | The whole map at once, with 1 m rasters: 44 s, 2.5 GB | About 50 GB at full size | Phase 15: a road graph for the whole box, then each tile on its own |
| `world.json` | 60 KB, 21 KB on the wire. Shores 36 KB of it | Grows with the map, and it's read at start | Header only. Land and water per tile, tile lists per 8 km |
| Road nodes | One `Float32Array` for every node on the map (`js/geodata.js:31`), 5,274 nodes | About 4.8 MB on a phone at full size, mostly empty | A map of the nodes held |
| Coarse ground | 80 m grid of everything, fetched at start, 22 KB | Hundreds of KB | A 400 m grid at start, 80 m in the far files |
| Structures, portals | Lists for the whole map | Thousands | By tile |
| Map screen | `map.json.gz`, 326 KB, on first open | About 6.5 MB at Inner Sydney alone | Image pyramid and a street index |
| Tools under Node | Hold the whole map | 5,600 tiles | Hold a tile and its neighbours, per worker |
| Far levels | Plan 2 had Region and World levels | Far squares already do Region's job | Phase 13 adds one horizon file, no Region level |
| `public/tiles/` in git | 2 MB | About 150 MB, and rebuilds add more | See "What I need from you" |

## Decisions

Say so if you want any of these changed.

1. **Fixes come first, on today's map, before anything gets bigger.** Suburbs would multiply every one of these problems, and Phase 15 rewrites the generators, so road shape has to be settled before then.
2. **Roads get their own height, baked when the tiles are made.** A smooth profile along each road, shared across joints, and agreed at junctions. Grade stays true to the hill, and only short bumps are smoothed out.
3. **Lean is capped at 4%,** in the direction of the hill, fading to level approaching a junction. Dead level would look wrong on a hillside, and would move the ground further.
4. **The ground follows the road, not the other way round.** It blends from the kerb back to the terrain over 8 m, and further where the gap is large. It's stored as a fine grid per tile, starting at 5 m, so `groundHeight()` stays a quick lookup: working it out as the game runs would cost too much on a phone.
5. **Roads win over buildings.** Centre a lane between its walls first, then trim any footprint still in the way. A building that would lose most of itself is dropped and listed.
6. **Each junction runs its own lights,** by who's there: 6 s minimum green, 24 s maximum, 3 s amber, 1 s all red. The player and waiting pedestrians count as demand. A junction with one group stays green unless someone needs to cross.
7. **Days are dry.** No puddles at golden hour or midday. Wet roads stay for twilight and night.
8. **On touch screens the stick appears where your thumb lands,** on the left half of the screen, and isn't drawn otherwise.
9. **Elevation comes from NSW's 5 m model,** replacing plan 2's decision 14. It covers the whole state from one service, which Geoscience Australia's patchwork of surveys doesn't. Tested at 8 places: Town Hall 22.9 m against today's 22.3 m, Kings Cross 34.7 against 34.5, Surry Hills 48.9 against 48.9, North Sydney 64.1 against 63.3, Observatory Hill 43.1 against 40.9, Echo Point 961 m. **Its licence isn't clear.** data.gov.au's record for the NSW elevation model says CC BY 3.0 Australia. NSW's own page for this service says "License Not Specified" with "Creative Commons" under its terms, and the service's record is blank. I'd build with it, credit it in the README alongside the NSW contours, and have the licence confirmed with NSW Spatial Services before Inner Sydney is deployed. Geoscience Australia's model (CC BY 4.0) is the fallback, with gaps to check first.
10. **Stops are the two you asked for.** After the road work the game is a good place to look at, but I won't wait unless you say so.
11. **Test runs go in the background, and I keep working.** I don't wait on them.
12. **`next_3.md` gets updated at each stop,** so each stop has a current summary.

Plan 2's other decisions stand.

## Phases

| Phase | Result | Size |
|---|---|---|
| A | Background test runs, ride and traffic checks, worst frame in stats | Small-Medium |
| B | One road colour, no paving on ramps | Small-Medium |
| C | Phone screen clear | Medium |
| D | Lights that respond | Medium |
| E | Traffic keeps moving | Medium, uncertain |
| F | Road shape: slant, bumps, things in the way | Large |
| 13 | Moving origin and the horizon | Medium |
| 14 | One plain test building you can walk into | Small-Medium |
| 15 | Inner Sydney. **Stop: 10 minutes on your phone** | Large |
| 16a | Palm Beach and Cronulla. **Stop before Katoomba** | Medium |
| 16b | Out to Katoomba | Medium |
| 17 | Play, budgets, `ai/next_3.md` | Medium |

## Phase A: Tests and checks

**Runs that don't get in the way:**

- **`npm run play` runs from a copy of the build,** in `recordings/<date>/dist/`, for the server and the offline file. A rebuild can't disturb a run, and the report records which code it tested.
- **`--jobs=3` in `--full`.** Scenarios that measure time or frames are marked and run alone at the end, and the three that need a clean GPU start keep their gap.
- **The soak leaves `--full`** and runs before each stop, with `--soak=10` before a deploy.

**`tools/check-roads.mjs`:** the criteria for a road that drives well, in about 3 s, with `--tiles=` and a list of the worst places.

| Criterion | Catches | Today | Limit |
|---|---|---|---|
| Lean | Slant | 50% of road over 4%, worst 56% | None over 4%, 6% at most on a junction's approach |
| Change of grade over 10 m + 10 m | Crests and dips | 3.9% over 3%, 0.7% over 6%, worst 21% | 2% over 3%, 0.2% over 6%, worst 12% |
| Step in 1 m | Lips and ledges | 801 m over 25 cm, worst 1.5 m | No more than 5 cm beyond the road's own grade |
| Roll change in 1 m | Side-to-side jolts | 4,784 m over 4%, worst 36% | None over 2% |
| Stops dead | Invisible walls | 173 m at 12 places | None |
| Building under the car | Protrusions | 1,570 m at 168 places | None |
| Wheel on a kerb | Protrusions | 3,470 m at 624 places | None mid-block, 0.05% at tight turns |
| Paving or lawn over the road | Issue 3 | 16 places on a centre line, up to 1.5% of area | None on a centre line, 0.2% of area |
| Traffic's lanes off the road | Cars on footpaths | 2.6% off, 3.9% over kerbs | 0.3% |

The limits come from the prototype and from what real roads do. If one turns out to be wrong for a good reason, I'll say so and change it, rather than quietly loosening it. Until Phase F they run as a ratchet, failing only if something gets worse, as `check-ground --strict` does now.

**`tools/check-traffic.mjs`:** the real traffic under Node, with a seeded random number generator so before and after compare. It reports what the tables above show: stopped, speed, what holds each queue, waits at reds, unused green, recycled. A short run joins `npm run check`, and a longer one is for working on traffic.

**`npm run check` runs its steps side by side,** so the two new checks add seconds, not a wait.

**`?stats=1`:** adds `worst since load 212 ms at 34 s, 12 slow of 3,600`, and how long the session has run. Time with the tab hidden doesn't count as a slow frame.

**Done when:** check is under 20 s. `--full` without the soak is under 12 minutes, and a rebuild in the middle of a run changes nothing. check-roads finds the places listed above. check-traffic stays within 20% of the real game at both places.

## Phase B: Road colour

- **Paving off the ramps.** Low structures cut the kerb islands as roads on the ground do. How low depends on heights, which are solved after the islands, so the generators run in that order.
- **Less sun reflected from dry asphalt,** keeping the reflections in wet patches at night. The scratch test used `MeshPhysicalNodeMaterial` with low specular. Compile time is what matters on a phone, so measure it, and if it costs too much write that one lobe into the road's existing material.
- **Blotches down.** A narrower range of tones, fewer patches, none near-black, and thinner tar lines. Plan 2's "pale, patched asphalt" stays, as something you notice up close instead of a pattern from 100 m.
- **Shading from the ground, not the sea.** One fix for the eight materials, using height above ground as a vertex value. No extra shader.
- **Dry days** (decision 7).
- **A Low-graphics check:** with no shadows, is the road too bright all over? Look at each time of day.

**Done when:** the bridge approach shows road. Same spot, same time, opposite directions: within 10% brightness, 15 RGB levels at most, at Low and High. Side-by-side pictures at the bridge ramp and at Kent, Pitt and Macquarie Sts go in `next_3.md`. Load and frames don't get worse.

## Phase C: Phone screen

```
 ┌───────────────────┐
 │ 42 km/h        ☰  │   ☰  everything else, in a sheet: time of day, teleport,
 │ Macquarie St      │      map, camera, full screen, sound, hide HUD, GitHub
 │                   │
 │                   │   Stick: appears where the left thumb lands
 │                   │   Right half: drag to look, as now
 │                   │
 │                ▲  │   ▲▼ Only when the mode has them: jump, ascend, descend
 │                🚕 │   🚕 Current mode. A tap opens the other three
 └───────────────────┘
```

- **Applies at a short side of 600 px or less on a touch screen.** Tablets keep today's panels but get the floating stick. Mouse and keyboard don't change.
- **The street name** is small text that fades 4 s after it changes.
- **The city's progress** is a thin line along the top edge.
- **What's left fades** to 40% after 4 s without a touch, and comes back on any touch. Buttons stay reachable, at least 44 px, inside the notch's safe area.
- **A first-run hint** shows the stick where a thumb would go, for the first few seconds.

**Done when:** `npm run viewports` measures coverage and fails over 10% of the screen or anything in the middle 60%, while driving, at all four phone sizes. `touch` plays with the floating stick. Everything in the old toolbar can still be reached. You judge it on your phone at the Phase 15 stop, or sooner if you like.

## Phase D: Lights that respond

- **`js/signals.js`:** the state machine, with no drawing in it, tested under Node. Each junction: green until the minimum, then amber once someone waits on red and nobody is still coming through on green, or at the maximum. Standing cars with nowhere to go don't hold a green.
- **The player counts.** Projected onto the approaches every frame, so sitting at a red with nobody around gets a green.
- **Pedestrians count.** Someone waiting at the kerb asks for that direction's green. It runs long enough for the WALK and for them to get across the road's width.
- **Close pairs act as one.** Junctions within about 45 m share a controller, grouped by road direction, so a divided road doesn't stop you twice.
- **Carried across network rebuilds.** Traffic gets a new network every 400 m or so, so state lives outside it, keyed by junction, or lights would reset in view.
- **Lenses by junction.** The lens shader reads one clock today (`js/street-details.js:118`). It becomes a state per instance, written only when a light changes. Heads beyond traffic's range stay on a clock, offset by junction so the whole city doesn't change at once.
- **Also moves:** `walkOn` in traffic, `audio-sources.js`, `pedestrian-system`.

**Done when:**

- Stopped alone at a red with nobody else there: green within 10 s (new scenario `signal-wait`).
- A junction with no crossing traffic never holds a car, unless someone is waiting to cross on foot.
- Median wait at the front of a red is 8 s or less, 95th percentile 30 s or less.
- Unused green is under 10%, at both places.
- `pedestrian-signals` tests pass, and people still cross.
- Frames are no worse on the phone profile.

## Phase E: Traffic keeps moving

Each change is measured with check-traffic at North Sydney, Town Hall, and the bridge deck. In order:

1. **A moving car ahead counts as room,** by how far it will have gone by the time you get there. Tested: up to 25% quicker at Town Hall, with the lights.
2. **A joint isn't a junction.** A node with one way in and one way out has no box, no stop line and no lane-change limit. A car passes straight through, following whoever is ahead. Tested in part.
3. **Nobody stands across two lanes.** A stopped car finishes its lane change or goes back. This is the "lane-straddling logic" in `ai/next_2.md`, holding 4-22% of queues in the runs above.
4. **Cars standing in junctions.** Once 1 and 2 are in, these are the largest group. Check whether the exit was really clear when each committed.
5. **Lanes follow the road,** adding shape points where an edge strays over 1 m, which items 1 and 2 make cheap.
6. **The car wedged on Macquarie St,** open item 4 in `next_2`: check-roads and the lanes fix may settle it, and if not, find out.
7. **Is North Sydney over capacity?** `LANE_METRES_PER_VEHICLE` sets how many cars a road gets, and if the logic is right and it's still jammed, reduce it there.

**Done when:** Town Hall is at 5 m/s or better with 30% or fewer stopped. North Sydney is at 4.5 m/s or better with 35% or fewer stopped. Under 3 cars a minute are recycled at both, and none in sight of the player. Deck traffic is compared with today's, which `next_1` left open.

**These targets are my judgement, and North Sydney's may be out of reach.** I have no change yet that gets it past 2.9 m/s. If they aren't met after these seven, I'll report the numbers and carry on, and you can decide at the Phase 15 stop. Phase 15 also runs check-traffic at Burwood, Bondi Junction, Chatswood and on the M5.

## Phase F: Road shape

On today's map and today's generators, so the result can be compared and every scenario still applies.

1. **Profiles.** A new step after `tools/build-heights.mjs` solves structures. Runs of links that continue into each other share one smoothed profile. Junctions agree on a height. Structures and cuttings keep theirs, and roads joining them are pinned to meet them, which removes most of the 125 steps. Start at 80 m of smoothing. Links store heights the way structures do now, about 1 KB a tile.
2. **Lean.** The hill's side slope, smoothed along the road, capped at 4%, fading to level over about 12 m at each junction.
3. **One function for road height.** `roadHeight()` reads the profile and lean, so what's drawn and what the wheels stand on can't differ. Check its cost, since it's called every frame for each car.
4. **Junctions.** Each point of a junction's surface blends the roads meeting there by distance, so there's no step between them.
5. **Ground.** The 5 m grid per tile (decision 4). `groundHeight()` adds it to the terrain, and kerbs, footpaths, lawns, trees, street furniture, people and building floors all follow without changing. Where the kerb line is over 1.5 m off the terrain, about 0.5% of it, the blend widens. Check whether that looks like a bank or needs a low stone wall, reusing the stone already there.
6. **Buildings out of lanes** (decision 5), in `tools/build-buildings.mjs`. Lists what got trimmed or dropped.
7. **Kerbs out of lanes.** Lanes' swept paths are cut from the kerb islands before they're traced.
8. **The 12 dead stops and sunken stretches,** from check-roads' list, fixed in the generators and not by hand.
9. **Steeper checks switch on.** check-roads and `check-ground --strict` change from ratchets to the limits above, and wheels under the road should improve on 3.25% over 3 cm, which has been open since plan 1.

**Done when:** every check-roads limit holds. Holdsworth St and Lavender Cres look level across and sit properly in their hillsides. A driven route through North Sydney's hills feels smooth to me in a recording. Download for the first view stays under 1 MB, load within budget, and `--full` passes.

**At this point today's map is the one to look at** if you want to, before anything gets bigger. Tell me to wait if you'd like to try it first.

## Phase 13: Moving origin and the horizon

As plan 2, updated:

- **Origin:** a root that moves by 4,096 m. Tile stages and far squares store positions from their own corner. Instanced street furniture is written from the current origin, and traffic's transforms subtract it.
- **Shaders:** `positionWorld` is on 82 lines, 64 of them in `js/tsl-materials.js`. Patterns read one `patternXZ`, which wraps at 4,096 m, so a move changes nothing on screen. The cost is a seam in hashed patterns along lines 4 km apart, which should be hard to see. The far level's tile mask (`js/far-level.js:41`) adds the origin.
- **Horizon:** one file for the whole box, a coarse mesh from a 100 m elevation download (about 3 MB, ahead of the full set), plus land-use colour and the tallest towers. It replaces `js/surroundings.js`. No Region level, since far squares do that job.
- **Road nodes** stop being one array (see the table), since precision is the same problem.
- **Test by shifting:** `?originTest=85000` runs today's scenarios 85 km from the origin.

**Done when:** at Katoomba's distance there's no jitter on the car or nearby buildings. A move can't be seen in a pair of captured frames. The horizon shows the coast and the mountains' rise, and I've flown it to check plan 2's "no visible popping", which `next_2` says hasn't been verified. Load doesn't get worse.

## Phase 14: One plain test building

Scope cut as you asked: no real models, and only a short section in the README on format, scale and budgets for when you make them.

- **One small plain building near the start,** with a door and a lobby, as glTF. Matched by location for now.
- **`GLTFLoader` arrives only when near one.** Within about 200 m, the model replaces the normal building.
- **Inside:** floors are surfaces, walls are colliders, and the door is a gap in the collider. Sky light fades as in tunnels, a few placed lights take over, and traffic and far detail stop drawing.

**Done when:** a scenario walks in and out on phone and desktop profiles, frames stay in budget, memory returns after leaving, and the first view's download doesn't change at all.

## Phase 15: Inner Sydney

About 24 × 22 km, 530 km², 234,445 buildings: Burwood to Bondi, Manly to the airport.

1. **Generators by tile, on today's area first.** A pass over the whole box for the road graph: stable node ids, structure heights by connected group, road profiles. It holds no rasters. Then a worker pool, each tile plus a 200 m margin, with results cached by what went in, for kerbs, pavements, buildings and parts, trees, awnings, tags and the ground grid. **It must reproduce today's map:** same buildings, and all checks no worse. Nothing gets bigger until it does.
2. **The manifest splits.** `world.json` keeps only what's truly global, under 30 KB. Tile hashes go in 8 km index files, fetched near the player. Land, water, shores, ferries, structures and portals go per tile.
3. **Sources:** the OSM extract cut to the box, Overture buildings and parts, NSW elevation. Check footprints and heights on a sample against OSM and the bridge drive's frames.
4. **Build it.** Expect what the CBD never showed: roads with fewer tags, more water, ferries and rail beyond today's box.
5. **Water at sea level per tile.** Trees from OSM, then seeded scatter by land use.
6. **Map screen:** an image pyramid rendered by the game's own map code in headless Chrome, a street index fetched on first open, teleports for the new suburbs, and `SUBURBS` from data. Vector detail stays for the tiles held.
7. **Tools by tile.** Under Node, geodata holds a tile and its neighbours, so checks run per tile across workers.
8. **Long runs:** a helicopter across, a drive from the CBD to Bondi, and a 30-minute drive.

**Done when:**

- check-ground and check-roads pass in at least 98% of tiles, with failures listed by tile.
- check-traffic is acceptable at Burwood, Bondi Junction, Chatswood and on the M5.
- Both long runs finish with flat memory and frames in budget.
- Load stays within budget and the first view under 1 MB.
- I report build time, bytes and files.

### Stop 1: 10 minutes on your phone

I'll write `next_3.md` and tell you it's ready. You commit and deploy. Then, on the phone, with `?stats=1`:

1. Open it fresh. Note the load time.
2. Drive from the CBD to Bondi, walk a bit, fly back. Go through the tunnels and over the bridge.
3. Send me the three lines of the readout at the end, whether the tab was ever killed or reloaded, and what the buttons, the road surface and the lights felt like.

An older or Android phone is worth trying here if you can get one.

## Phase 16a: Palm Beach and Cronulla

About 1,850 km², 616,435 buildings, east of Parramatta. It repeats Phase 15's checks and adds long drives to both ends, down the Northern Beaches and through Sutherland. Bays and estuaries beyond the harbour stay at sea level.

**Stop 2:** the same phone test, driving or flying to Palm Beach and Cronulla, with the file counts and bytes against Cloudflare's limits. I won't start Katoomba until you say so.

## Phase 16b: Out to Katoomba

5,600 km², 1,191,029 buildings, through Parramatta and Penrith.

- **Water with its own level:** Prospect Reservoir and the Nepean.
- **Cliffs:** the 20 m grid blurs the escarpment. Try a finer grid only for very steep tiles, and report how Echo Point looks.
- **Bush:** land-use colour and scatter near the camera, with nothing stored per tree.
- **Long drive:** CBD to Katoomba along the M4 on the fast clock, about 85 km.

**Done when:** all four named places can be reached by road and air, a full crossing keeps memory flat, and total bytes and files are reported against the free plan's limits.

## Phase 17: Play, budgets, next

- `--full` with a soak, `npm run bench` on Chrome and Firefox, `npm run viewports`. Firefox and Safari have been outstanding since `next_2`.
- README's "How it works": road profiles, signals, generators by tile.
- Write the final `ai/next_3.md`.

| Budget | Now | Target |
|---|---|---|
| Load, phone profile | 3.23 s | 3.5 s or less, anywhere on the map |
| Load, desktop at High | 2.24 s | 2 s, still missed from plan 2 |
| Load, real iPhone | 0.98 s | 2 s or less |
| First download | 651-745 KB | Under 1 MB |
| Frames at rest, phone profile | 42 FPS, p95 33 ms | No worse |
| Heap, steady | 425 MB | Under 500 MB at High, 300 MB at Low |
| Draws over the CBD at High | 774 | 740 |
| Road lean | Worst 56% | 4% |
| Wait at a red, median | 12-18 s | 8 s |
| Cars stopped | 42-50% | 30-35% |
| Phone screen covered | 26-41% | 10% or less |
| `npm run check` | 8 s | Under 20 s, with two more checks |
| `--full`, without soak | 17 min | Under 12 min, not waited on |
| Files, all of Sydney | 79 | Under 18,000 |

## Risks

| Risk | Why | Plan |
|---|---|---|
| Road shape touches everything | Ground, kerbs, floors, paint, wheels and traffic all read these heights | Same map, measurable targets, all checks and `--full` before moving on |
| The ground grid doesn't fit kerbs | A 5 m grid can miss by up to about 25 cm where a blend bends, and the kerb hides about that much | check-ground's slit and overlap counts say. Next steps are a finer grid near roads, or storing each kerb point's height |
| Traffic stays slow at North Sydney | No proven fix, see Phase E | Report it and decide at Stop 1. The safety valve stays |
| Reduced specular costs compile time | Shader compile is the phone's largest load cost | Measure it, and fall back to adding it to the existing material |
| Demand-driven lights look wrong | A lens changing per junction, across rebuilds | `signal-wait` and a state that survives rebuilds |
| Worker pool or manifest change breaks today's map | Phases 11-12 only just got there | Reproduce today's map first |
| Suburbs break checks in new ways | No hand-tuned overrides outside the CBD (plan 2, decision 13) | Lists by tile. You decide what's good enough at each stop |
| Phone memory on a bigger map | One minute is all that's been tested, and iOS reports no heap | Budgets count buildings and triangles, and the 10-minute test watches for a killed tab |
| NSW elevation licence | Sources disagree: CC BY 3.0 on data.gov.au, "License Not Specified" on NSW's page, blank on the service | Decision 9: confirm before deploying. Fallback is Geoscience Australia's model, with gaps |
| Cloudflare's terms | Plan 2's risk stands: limits on large shares of files | `check-dist` guards the limits. Read the terms before any big launch |

## Not in this plan

From `ai/next_2.md`: draws and triangles at High beyond the budget above, shoreline detail in the far level, STOP plates and push-button detail, the bridge at night. From `ai/next_1.md`: wheel contacts for bus, bicycle and traffic, and the pale band in the William St tube. Your detailed models come after this plan.

## What I need from you

1. **Disk space:** 15 GB. Say if that's a problem. Otherwise the downloads start at Phase 15, apart from the 3 MB one in Phase 13.
2. **The elevation licence** (decision 9). Asking NSW Spatial Services is an email from you, not me. It needs an answer before you deploy Inner Sydney, not before I build it.
3. **Committing tiles.** `public/tiles/` will reach about 150 MB, and each rebuild adds whatever changed to git's history for good. I'd commit them only at the two stops and at the end. The other way is to leave them out of git and deploy from this machine, but then a fresh clone can't run without rebuilding them. Your call, as commits are yours.
4. **The phone tests** at each stop, and an older or Android phone if you can get one. Which iPhone you tested on would help too.
5. **Checking the cache headers** after your next deploy, on a tile and on `tiles/far-heights.bin.gz`, still open from `next_2`.

## Sources

- Measured from the game: `js/surfaces.js`, `js/ground-geometry.js`, `js/traffic.js`, `js/road-network.js`, `js/city-config.js`, `js/street-details.js`, `js/tsl-materials.js`, `js/lighting.js`, `js/quality.js`, `js/geodata.js`, `tools/build-geodata.mjs`, `tools/build-heights.mjs`, `tools/play/`, `recordings/2026-11-02-00-29-22/report.json`
- [Geofabrik's Australia extract](https://download.geofabrik.de/australia-oceania/australia-latest.osm.pbf), size from the server, 2 Nov 2026
- [NSW 5 m elevation service](https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_5M_Elevation/ImageServer), [its page on Data.NSW, "License Not Specified", terms "Creative Commons"](https://data.nsw.gov.au/data/dataset/1-437c0697e6524d8ebf10ad0d915bc219), [NSW DEM on data.gov.au, CC BY 3.0 AU](https://data.gov.au/data/dataset/8f73f5ca-4f7f-4707-bfe2-0efbb9027107)
- [Geoscience Australia's 5 m model](https://ecat.ga.gov.au/geonetwork/srv/api/records/22be4b55-2465-4320-e053-10a3070a5236), CC BY 4.0, from 236 surveys
- Overture and Cloudflare figures carried over from `ai/plan_2.md`
