# Plan 1: roads in 3D, sealed ground, the bridge, the sky, and a loading bar

Answers `ai/prompt_1.md`.

Nothing is implemented yet. The experiments ran from the scratchpad against the current build and the data snapshots in `tools/data/`, so the only change to this repo is this file. The analysis scripts aren't kept: Phase 1 rewrites them as a tool.

## Where things stand

The simulation is flat. What gets drawn is lifted onto a 20 m height grid one piece at a time, and each builder samples heights its own way. Nothing makes the pieces agree, nothing seals the ground from below, and only one road, the Harbour Bridge corridor, knows it is above another. Each issue in the prompt comes back to one of these three things.

| Prompt issue | Cause found | Evidence |
|---|---|---|
| Roads overlap illogically, a road ahead disappears | Bridges are drawn on the ground beneath them. Tunnels, and motorways at ground level, aren't drawn. The height grid has holes. Ground pieces cross each other on slopes | 13 street-over-street crossings in the drivable network with no junction, all drawn at one height. A road in North Sydney renders as a ramp into the air. See "Roads and heights" |
| 1. Wheels sink | The car stands on the terrain under its centre. The road is drawn from other samples, and where pieces overlap the highest one shows | At the spawn point the wheels are 24 cm under the road. 15% of lane positions citywide sink more than 15 cm |
| 2. Sky flickers | Off WebGPU, Firefox has no `EXT_clip_control`, so three.js drops the reversed float depth buffer. It uses 24-bit standard depth with a near plane of 0.35 m and a far plane of 60 km | Firefox 157 (the Playwright build on this PC) reports no WebGPU and no `EXT_clip_control`. Chrome has both. Not yet seen in a frame capture |
| 3. Land unsealed, ocean visible | The only thing under the city is the water plane at −2.2 m. Any seam between road, kerb and footpath shows it | Just outside the kerbs, 1.4% of samples have no road surface and 12% have the road below the kerb's foot. Screenshot at Dawes Point: a strip of harbour through the lawn |
| 4. Invisible walls on the Harbour Bridge | The deck holds the car 10.55 m from its centre line, but is drawn 17 m to each side. The pylons stand on the road. Each pylon's 28 m box collider covers the street beneath | See "Harbour Bridge" |

**The Spec still binds.** The phone profile loads in 3.63 s against a 4 s maximum, and the download is 1,383 KB against the 1.4 MB budget plan 0 set. Every phase here adds data or building work, so each one reports load time and download.

## Prompt items

| Prompt item | Status | Phase |
|---|---|---|
| Study the map: correct 3D structure and the height of every road | Causes found, new work | 5, 6 |
| Overlapping roads work on the top and bottom layers, and on every layer where there are more | New work: levels in the simulation | 8, 9, 10 |
| 1. Wheels sink under the road | Cause found | 7 |
| 2. Sky flickers, maybe Firefox without WebGPU | Likely cause found, not reproduced yet | 3 |
| 3. Land unsealed, water visible | Cause found | 7 |
| 4. Invisible collisions on the bridge, castle off the road | Cause found | 2 |
| Loading bar, top left, while anything is short of full | New work | 4 |
| Related leftovers from `ai/next_0.md` | Listed below | various |

## Leftovers from `ai/next_0.md`

| Leftover | Why it belongs here | Phase |
|---|---|---|
| Motorways at ground level aren't drawn, so ramps come down into nothing | A road ahead disappears | 9 |
| Viaducts are scenery: not drivable, and the helicopter flies through them | Top layers must work | 9 |
| The player can't leave the deck onto the York St ramp | It's a motorway ramp, and arrives with Phase 9 | 9 |
| `harbour-bridge` passes 5 runs in 8 | Same deck as issue 4. Re-measured after Phase 2 | 2, 11 |
| No shadow for the player's car on the deck | Bridge rendering. Cause unknown | 2 |
| Dark straight-edged wedges on the water from high up | Possibly depth precision or the land mask, both looked at here | 3, 5 |
| North-shore heights not checked against survey points | The height of every road | 5 |
| Play scripts: "never below ground", a hill start | Issue 1 needs the first one. The hill start gets a reason to exist once wheels follow the road | 7, 11 |
| Only 323 of the north shore's 1,255 candidate edges carry traffic | The Warringah Freeway and the bridge ramps connect it. Re-measured, not targeted | 9 |
| WebGL2 frame rate never measured as a target | Firefox runs WebGL2. Measured while fixing the sky | 3 |

Not taken in: landmarks, terraces, train entrances, trains on the bridge, gulls and ibis, audio, the Anzac Bridge's pylons and cables, retuning `js/quality.js` for real devices, and the real-device checks. Those still need a real Intel laptop and a phone.

## Measurements

**Setup:** the current build (`dist/`, from 1 Nov 11:44), the raw snapshots in `tools/data/`, and Chrome 156 with WebGPU on the RTX 3060. Ground and road surfaces were rebuilt in Node exactly as `js/city-grid.js` builds them. Firefox 157 is Playwright's build.

### Roads and heights

Roads in OSM that touch the play area:

| Class | At ground | Bridge | Tunnel | Covered (built over) |
|---|---|---|---|---|
| Streets | 3,728 ways, 310 km | 41 ways, 1.8 km | 9 ways, 1.3 km | 77 ways, 1.5 km |
| Motorways and links | 240 ways, 22.5 km | 128 ways, 17.6 km | 68 ways, 19.1 km | 46 ways, 1.3 km |

Another 41 street ways, 1.8 km, carry `layer=1` without a bridge tag. OSM `layer` runs from −5 to 4 here.

- **Street bridges are drawn on the ground.** The network keeps their `bridge` tag nowhere. Pier St over Darling Dr, Railway Colonnade Dr over Eddy Ave at Central, Cumberland St over the Argyle Cut, Argyle St over Hickson Rd, and Burton St over Barcom Ave each cross a drivable road with no junction: 13 such crossings in all. Both roads are drawn at one height, and their traffic treats the crossing as at grade.
- **The height grid is bare earth.** Under the Bradfield Hwy the ground is 28 m below the line between the bridge's ends, under the Cahill 13 m, under the Western Distributor 10 m. Of 190 bridge ways over 15 m long, 20 have ground more than 3 m below their ends' line and 21 have 1-3 m. A bridge drawn on the terrain dips into whatever it crosses.
- **The 20 m grid can't hold a cutting.** The Argyle Cut is about 10 m wide. Argyle St climbs 8 m within one OSM segment there.
- **Tunnels are dropped**, so roads run into a hillside. Among streets: William St (Kings Cross, 633 m), Darling Dr (275 m), Sir John Young Cres (146 m), Slip St (138 m), Fig St (105 m), Arthur St, Bellevue St. The repair step that restores short connecting roads doesn't test for tunnels, so some under 160 m may be back as roads drawn across the ground above them. Not checked one by one.
- **Motorways are 20 scenery viaducts** at a height guessed from `layer`. They cross drivable streets 77 times. At their ends a 140 m ramp sinks into the ground, where nothing continues.
- **The height grid has holes.** The land mask that `tools/build-heights.mjs` eases to sea level has inland gaps that aren't harbour: around (−760, −4300) in North Sydney, around (1000, −3840), and along the east edge at x = 2700. The worst steps between neighbouring 20 m cells are 30 m, along the north edge of the play area at z = −4500. At McLaren St the road renders as a ramp climbing into the air beside floating buildings, with the water plane showing below.

### Ground pieces don't agree

How `js/city-grid.js` builds the ground today:

| Piece | How its heights are sampled |
|---|---|
| Road ribbon | One height per station, every 18 m, at the centre line. Flat across, so on a cross-slope one edge is under the terrain and the other above it |
| Junction disc | 18 points on its rim and nothing inside, so the middle is a plane between rim points |
| Footpath (`PAVEMENTS`) | Edge points every 20 m, inner points every 44 m |
| Lawn | Edge points every 20 m, inner points every 36 m |
| Kerb | A wall from 0.3 m under the terrain to 0.23 m above it, every 20 m |
| Under all of it | The harbour's water plane, 120 km wide, at −2.2 m |

Just outside each kerb, sampled every 4 m (143,743 samples on land, off other curb islands):

| Result | Samples | What you see |
|---|---|---|
| No road surface at all | 1,977 (1.4%) | The water plane. Mostly outer corners of bends, where the ribbon's offset isn't mitred |
| Road below the kerb's foot | 17,871 (12%) | A slit under the kerb, with water below |
| Road above the kerb's top | 25,411 (18%) | Road surface lying over the footpath |

The footpath at the Argyle Cut shows zig-zag steps where neighbouring triangles cross.

### Wheels

The car stands on the terrain at its centre and pitches with the slope over ±2.5 m. It doesn't roll. Measured where each wheel touches, against the highest drawn road surface there, over 153,444 lane positions:

| Wheels under the road | Share |
|---|---|
| Under 5 cm | 67.5% |
| 5-15 cm | 17.5% |
| 15-30 cm | 8.6% |
| 30-60 cm | 4.7% |
| Over 60 cm | 1.7% |

At the spawn point on Macquarie St it's 24 cm, and still 10-20 cm for the next 130 m north. That's the start of the drive the prompt describes. In the screenshot the tyres don't show below the body. The worst cases, 6-8 m, are at North Sydney junctions on top of the height-grid holes.

### Harbour Bridge

| Measure | Value |
|---|---|
| Corridor | 2,238 m, arch 503 m |
| Deck as drawn | 17 m each side of the centre line, 13 m within 60 m of the ends |
| Where the car is held | Its centre within 10.55 m (`HALF_WIDTH` 12.5 − radius 1.35 − 0.6). Speed × 0.92 every frame it's held |
| Pylons' inner face | 8.25 m from the centre line, so the outer lanes run through the granite |
| Pylon colliders | Axis-aligned 28 × 28 m boxes, reaching the centre line. They cover Hickson Rd at the south end and Olympic Dr at the north |

So there are three invisible obstacles. A wall about 5 m inside the parapets on the deck. Pylons drawn on the road that deck cars pass through, since cars on the deck don't test colliders. And a box across each of the two streets under the bridge's ends.

### Sky on WebGL2

| Browser | WebGPU | `EXT_clip_control` | Depth used |
|---|---|---|---|
| Chrome 156 | Yes | Yes | 32-bit float, reversed |
| Firefox 157 | No | No | 24-bit, standard |

With standard 24-bit depth and these planes, depth steps are about 0.2 m at 1 km, 4 m at 5 km and 70 m at 20 km. The sky is drawn at depth 1.0. Land, water and sky near the horizon then compete for the same depth values, and which one wins can change from frame to frame. That fits "sometimes" and fits Firefox. A capture has to confirm it.

### Loading after the overlay drops

The city finishes building 8.5 s after interaction on desktop and 22.7 s after on the phone profile (from `ai/next_0.md`). Nothing on screen says so. Work in that time: background shader compiles, the rest of the streets and buildings, landmarks, four code chunks downloaded on demand, surroundings, street details, traffic, and culling setup. `worldCompleteAt` marks the end.

## Decisions

Say so if you want any of these changed.

1. **Roads become 3D in the data, and the simulation gets levels, not a 3D physics rewrite.** Colliders, traffic and people keep moving on x and z. Every road vertex gets a height, every moving thing knows which surface it's on, and its height comes from that surface. The Harbour Bridge's deck flag becomes the general case.
2. **Every layer is drivable in the end, motorways and tunnels included.** That's the prompt's "on all layers", and it is the largest cost in this plan. The order lets you stop early: streets, covered roads and the Harbour Bridge first (Phase 8), then motorways (Phase 9), then tunnels (Phase 10).
3. **Heights are worked out in the generator from the raw contours,** not from the 20 m grid. Ground roads take the contour height at each vertex. Bridges ease between their ends. Tunnels run under what crosses them. At every crossing the upper surface clears the lower by 5.3 m plus a 1.5 m deck. Both numbers are constants to tune. OSM `layer` says which way is on top, not how high. A short override table, keyed by OSM way id like `BRIDGE_WAYS`, covers what the rules get wrong.
4. **One ground-height function for drawing and for the simulation.** Kerbs and footpaths take their edge heights from the road beside them. Where the land beside a road is much higher or lower, the kerb becomes a retaining wall. The shipped grid stays at 20 m, so the download barely grows.
5. **A sealing base under the play area:** a plain dark ground 0.4 m below everything else, so a missed seam shows ground, never the harbour. It backs up the agreement in decision 4. It doesn't replace it.
6. **Pick up the surface you're on by continuity.** Stay on whatever surface continues under you within a small step in height. Change only where two surfaces meet at the same height, at ramps and bridge ends. This works for any number of levels.
7. **The Harbour Bridge stays hand-built.** Its parapets go where the car is held, its pylons move off the road, and its colliders match what is drawn.
8. **Sky:** capture the flicker first. The likely fix is to check for `EXT_clip_control` before creating the renderer and use a logarithmic depth buffer where it's missing, measuring its cost on Firefox. If that costs too much: a nearer far plane with distant land faded into the fog, and the sky drawn just inside the far plane.
9. **Loading bar:** a thin bar with a short label under the brand panel at top left. It shows background build and compile work, including after a time-of-day change, and hides when that's done. Auto quality stepping down is a choice for the device, not loading, so it doesn't show. The clean view (H) hides it with the rest of the HUD.
10. **Pedestrians stay on the ground.** The Harbour Bridge footway and other footpaths on structures are out of scope.
11. **`geodata.js` moves to a binary format** if the new data breaks the download budget. The buildings, trees and heights already ship that way. Brotli puts `geodata.js` at 430 KB today.

## Phases

| Phase | Result | Size |
|---|---|---|
| 1 | Tools that measure every issue, and before pictures | Small |
| 2 | Harbour Bridge: no invisible walls, pylons off the road | Small |
| 3 | Sky flicker found and fixed off WebGPU | Small-Medium |
| 4 | Loading bar | Small |
| 5 | Height data repaired and checked | Small-Medium |
| 6 | Every road has a real height, layers solved | Large |
| 7 | Ground that agrees and is sealed, wheels on the road | Large |
| 8 | Levels in the simulation: streets, covered roads, the bridge | Large |
| 9 | Motorways drivable, viaducts and ramps connected | Large |
| 10 | Tunnels drivable, portals everywhere | Medium-Large |
| 11 | Play, budgets, `ai/next_1.md` | Medium |

Phases 2-4 don't depend on the road work. They go first so that three of the prompt's issues are fixed early. Phases 9 and 10 can each be dropped without undoing anything before them. Without them, motorway ramps and tunnel mouths still get a proper end (Phase 7), so no road leads into nothing.

## Phase 1: Tools and baselines

- **`tools/check-ground.mjs`:** rebuilds the ground in Node as the game does and prints the measurements above: wheels under the road, kerb seams, crossings without a junction, grid steps, bridge dips. Unit tests pin its thresholds once the fixes land.
- **A list of places for `look.mjs`:** spawn, the Argyle Cut, Pier St, Railway Colonnade Dr, Burton St, High St over Hickson Rd, Western Distributor over Sussex St, the Cahill at Circular Quay, both pylons, Hickson Rd at Dawes Point, Olympic Dr, William St at the Kings Cross tunnel, McLaren St. Before pictures go to `recordings/`.
- **Firefox in the play tools:** `--browser=firefox` for `look`, `play` and `bench`, using Playwright's Firefox build.
- **Elevation map:** `tools/debug-map.mjs` draws roads coloured by height with crossings marked, and side profiles of chosen roads.

**Done when:** the tools reproduce this plan's numbers on the current build.

## Phase 2: Harbour Bridge

- **Parapets where the car is held.** Draw kerbs and parapets at the drivable edge, with the footway and rail beyond them as scenery. Or widen what's drivable to the drawn road. Either way, nothing drawn is out of reach and nothing out of reach is drawn.
- **Pylons off the deck.** Move them out so their inner faces clear the whole modelled deck, 17 m plus a margin. Check their placement against photos and OSM.
- **Pylon colliders match the granite:** oriented boxes, with absolute heights. Hickson Rd and Olympic Dr stay open, where OSM has them running under the bridge.
- **The deck state can't be lost mid-span.** A traffic impact can push the player past the 12.5 m that `bridgeAt` searches. Then `updateDeckState` drops them to the ground under the deck. Clamp first, then look up.
- **Look into the missing car shadow on the deck.**
- **Re-run `harbour-bridge` 8 times.** Its open failure, a car stuck at s = 1366 on the oncoming side, may be one of the above.

**Done when:** a new scenario drives the full deck width and both pylons in each direction and is never stopped by something it can't see. `under-the-bridge` and `harbour-bridge` pass 8 runs in 8, and a car on Hickson Rd and on Olympic Dr passes under each end.

## Phase 3: Sky off WebGPU

- **Reproduce:** on Firefox, hold the camera still with the clouds paused, capture 60 frames, and map which pixels change. That tells sky, horizon and geometry apart. Repeat on Chrome WebGPU. Chrome's WebGL2 path (the `webgl2-fallback` scenario hides `navigator.gpu`) still has `EXT_clip_control`, so it keeps reversed depth and can't stand in for Firefox.
- **If it's depth:** check for `EXT_clip_control` with a throwaway WebGL2 context before creating the renderer. Without it, create the renderer with `logarithmicDepthBuffer` and measure the frame cost on Firefox, since it writes depth per fragment. If that's too slow, use a nearer far plane with distant land faded into the fog. Either way, draw the sky just inside the far plane rather than on it.
- **If it isn't depth:** the next suspects are the environment bake taking the sky out of the scene for a frame (`bakeEnvironmentMap`) and aliasing in the sun disc and clouds.
- **While Firefox is running:** measure WebGL2 load time and frame rate, and look at the dark wedges on the water from high up.

**Done when:** 60 still frames on Firefox show no flicker, with load time and frames recorded, and the `webgl2-fallback` scenario still passes.

## Phase 4: Loading bar

- **`js/progress.js`:** named tasks with weights. Each reports a fraction, and the bar shows the weighted sum. Weights come from the bench's stage timings, so the bar moves at an even pace.
- **What counts:** each step of `buildRestOfWorld`, background compiles (objects done out of total), the on-demand code chunks, and `bakeEnvironmentMap` plus new compiles after a time-of-day or graphics change.
- **Look:** a thin bar and a short label ("Building the city · 42%") under the brand panel. It fades out a moment after the last task. `role="progressbar"`, with the DOM written at most 4 times a second.

**Done when:** a scenario sees the bar at interaction with its value rising, gone within 1 s of `worldCompleteAt`, back on a time-of-day change and gone again after. `npm run viewports` is clean at all 9 sizes with the bar showing, and frame cost doesn't change.

## Phase 5: Height data

- **Close the land mask's inland holes** (North Sydney, x = 1000, the east edge) and the cliff along z = −4500. Find out why the play area's land polygons leave gaps that aren't harbour.
- **Check that the 40 m ease down to the seawalls** doesn't pull quayside roads down.
- **Check the north shore** against OSM `ele` points and against the 2 m contours where roads cross them.

**Done when:** no step of more than 4 m between neighbouring cells on land away from mapped cliffs, McLaren St looks like a street, and the known-heights test covers the north shore.

## Phase 6: Every road in 3D

In `tools/build-geodata.mjs`:

- **Keep the tags:** `bridge`, `tunnel`, `covered`, `layer`, `cutting`, `embankment`. Take in motorways and links, and street tunnels.
- **Ground roads:** the contour height at each vertex, sampled from the raw contours on a 5 m working grid that is never shipped, then smoothed along the road.
- **Bridges:** chained into whole structures, eased between their ends, and lifted wherever a crossing needs clearance. Grades stay under 6-8%.
- **Tunnels:** below what crosses them, with portals where they meet ground roads.
- **Stacks:** an iterative pass over every crossing until all clear, lowest layer first. Anything it can't satisfy is listed, and the override table settles it.
- **Ground roads burned into the shipped grid,** so terrain and roads agree wherever they meet.
- **Only ground-level roads cut the curb islands.** Under a bridge, the ground is whatever is really there.
- **Output:** a height for every node and inner point, and a kind and structure id for every link. `viaducts` folds into the graph.

**Checkpoint:** the elevation map and side profiles of the stacks: the Argyle Cut, Pier St, Central, the Western Distributor at Darling Harbour (three levels), the Cahill at Circular Quay, the Bradfield Hwy approaches, the Warringah Fwy bridges in North Sydney, and William St at Kings Cross. Pictures in `recordings/`, numbers in the report, before any rendering changes.

**Done when:** tests pin Cumberland St over Argyle St, Pier St over Darling Dr, Railway Colonnade Dr over Eddy Ave, the Western Distributor over Sussex, Kent and Harris Sts, and William St under Kings Cross. Every crossing without a junction clears by 6.8 m surface to surface, every bridge meets its neighbours within 5 cm, and the download stays in budget, using the binary format if needed.

## Phase 7: Ground that agrees and is sealed

- **`js/surfaces.js`:** the ground-height function (terrain, with kerb heights from the nearest road) and the decks of every structure.
- **Road ribbons:** heights from the graph at both edges and the centre, every 8 m or less, with mitred corners. Junction discs get inner points from the same function.
- **Kerbs** run from the road's edge height to the footpath's, as retaining walls where the gap is over 0.5 m.
- **Footpaths and lawns:** edge heights from the kerbs, inner points on the 20 m grid's own nodes.
- **Structures:** decks with soffits, parapets and piers from the 3D graph, with the same builder for the Harbour Bridge's approaches. Motorway ramps and tunnel mouths that aren't drivable yet still end properly: a ramp lands on a road, a tunnel gets a portal.
- **Sealing base:** a coarse dark ground under the play area. Near the player before the first frame, the rest behind the game.
- **Everything else stands on the same function:** buildings, trees, street furniture, the seawalls, and moving things as they're drawn.
- **Wheels:** ground at each contact point sets the car's height, pitch and roll. The same for the bus, the bicycle, people's feet, and traffic.

**Done when:** `check-ground` finds wheels under the road by more than 3 cm at no more than 0.1% of lane positions, no kerb sample opening onto nothing or a slit, and no road lying over a footpath. The look pictures are clean. A "never below ground" play check passes on a drive through every stack. Load time stays within 2.5 s on desktop and 4 s on the phone profile.

## Phase 8: Levels in the simulation

- **The player:** `updateDeckState` becomes surface tracking by continuity. Inside a structure you're held by its parapets, and you can leave only at its open ends. Car, person, bicycle and helicopter all use it, and the helicopter lands on the highest surface below it.
- **Colliders** carry absolute heights. A pier blocks the level below and nothing above it.
- **Traffic:** each edge has a height along it. "Same level" means within 3 m in height where two vehicles meet, replacing `onDeck` and `onPlayersLevel`. This applies to collisions, yielding, and the player.
- **Camera:** under a structure, the chase camera stays below its soffit.
- **Map:** structures drawn over what they cross.

**Done when:** unit tests track surfaces through a three-level stack. A `stacked-roads` scenario drives each level of the Argyle Cut, Pier St and Central, and the deck. It asserts the car stays on its level, that traffic on another level never stops for or hits it, and that the camera never enters a deck. `under-the-bridge` still passes.

## Phase 9: Motorways

- **Join the network:** motorways and their links, with lanes from OSM, signed speeds, and no signals or pedestrians. The viaduct scenery code and its ambient lanes go.
- **Map edges:** traffic enters on inbound motorways and leaves on outbound ones. The player meets the edge of the world there, as on streets today.
- **Now reachable:** the Bradfield Hwy ramps, including York St off the bridge, and the Warringah Fwy, which joins the north shore.

**Done when:** a scenario drives the Western Distributor from Darling Harbour onto the bridge and leaves by the York St ramp, then drives the Cahill over Circular Quay. Network size, north-shore coverage, load time and frames are reported against the numbers in `ai/next_0.md`.

## Phase 10: Tunnels

- **Street tunnels first,** then motorway tunnels with both portals in the play area. Each is a tube with lights, its approach a cutting with retaining walls.
- **Inside a tunnel,** sun and sky light are turned down while the camera is inside. Out-of-map ends behave like the map edges in Phase 9.

**Done when:** a scenario drives William St through the Kings Cross tunnel both ways, and the camera stays inside the tube.

## Phase 11: Play, budgets, next

- Run every scenario 3 times, plus the 10-minute soak. Run `npm run bench` on Chrome and Firefox. Run `npm run viewports`.
- Add a hill start, now that wheels follow the road.
- Watch the recordings of each stack.
- Update the README's "How it works": the simulation is no longer flat in the sense it describes.
- Write `ai/next_1.md`.

| Budget | Now | Target |
|---|---|---|
| Time to interaction, desktop | 2.25 s | 2.5 s |
| Time to interaction, phone profile | 3.63 s | 4 s |
| Download | 1,383 KB | 1.4 MB, or say why not |
| Wheels under the road over 3 cm | 15% over 15 cm | Under 0.1% |
| Kerb samples onto nothing or a slit | 13.8% | 0 |
| Frames, phone profile | 95th percentile 33.3 ms | No worse |

**Done when:** all of the above hold and the recordings are there for you to judge.

## Risks

| Risk | Why | Plan |
|---|---|---|
| Phone load time | 0.37 s of margin, and denser ground plus a sealing base add work | Only near the player before the first frame. Move work into the generator if needed. Measure every phase |
| Download | 17 KB of headroom against plan 0's budget | Binary `geodata` (decision 11) |
| Stacks the rules get wrong | OSM `layer` is an order, not a height | Phase 6 checkpoint by eye, plus the override table |
| Size of Phases 8-10 | Levels touch controllers, traffic, camera and map | Phase order with stopping points. Phase 7 gives every road a proper end even without them |
| Traffic on motorways | Merging and higher speeds are new to this traffic code | Phase 9 scenario, droppable |
| Firefox fix costs frames | Logarithmic depth writes depth per fragment | Measure, with the fallback in decision 8 |
| Real devices | Still none tested | Needs a real Intel laptop and a phone from you |

## Sources

- `tools/data/` snapshots: OpenStreetMap via Overpass, City of Sydney 1 m contours, NSW 2 m contours
- `ai/plan_0.md`, `ai/next_0.md`
- `js/city-grid.js`, `js/bridge.js`, `js/harbour-bridge.js`, `js/controllers.js`, `js/lighting.js`, `js/main.js`, `tools/build-geodata.mjs`, `tools/build-heights.mjs`
- `node_modules/three/src/renderers/webgl-fallback/WebGLBackend.js`: the reversed-depth fallback without `EXT_clip_control`
