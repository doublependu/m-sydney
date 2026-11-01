# Plan 2: buildings on the ground, real street names, modes that carry over, the references, billboards, quicker tests, and all of Sydney in tiles

Answers `ai/prompt_2.md`.

Nothing is implemented yet. The experiments ran from the scratchpad, against copies of the game and the data snapshots, so the only change to this repo is this file. `dist/`, which git ignores, was rebuilt once to time the build.

## Short answers

**The biggest map with today's approach is about the one we have.** The play area is 26.7 km². On the phone profile it loads in 3.93 s against the Spec's 4 s, and the download is already over budget. Dropping the phone limit might buy twice the area on a desktop. See "Bigger map".

**All of Sydney is possible, but only with tiles.** Palm Beach to Cronulla and Watsons Bay to Katoomba is a box of 97 × 58 km, 5,600 km², about 210 times today's play area. A browser can't hold that, and it doesn't need to: with tiles, what's in memory stays about the size it is today wherever you are. Tiles should also make the first load faster, because the first view stops paying for the whole map. It's the largest job so far, and it's staged so you can stop after any stage.

**The tests need fixing beyond iteration 1.** `npm run play` takes 40 minutes and writes 771 MB of video by default. Iteration 1's repeated runs made that worse, but the default stays slow without them, so Phase 1 changes it and comes first.

**Two findings you didn't ask about change the priorities:**

- **The buried buildings have a second cause, separate from slopes.** Window rows and ground floors are measured from sea level, not from each building's base, so 97% of buildings never draw their ground floor. A one-line change in a scratch copy brought shopfronts back along whole streets.
- **Many of the tallest towers are drawn far too short.** Crown Sydney stands 40 m tall in the game and should be 271 m. The tower heights are in data the generator doesn't read yet.

## Prompt items

| Prompt item | Status | Phase |
|---|---|---|
| Issue 1: buildings start under the ground | Two causes found, one tested | 2 |
| Issue 2: every street sign says George St | Cause found | 3 |
| Feature 1: modes start where the last one left off | New work, heights worked out | 4 |
| Feature 2: find where the references are | Done, listed below | 6 |
| Feature 2: save frames in `ref/` | Sampled for this plan, saved properly in Phase 6 | 6 |
| Feature 2: update buildings and roads from them | Differences listed | 7, 8, 9 |
| Feature 3: billboards and company names | New work | 5 |
| Bigger map: how big, and all of Sydney? | Answered | |
| Bigger map: tiles | New work | 11, 12, 13, 15, 16 |
| Bigger map: three building models | New work | 7, 10, 14 |
| Test: faster iteration | New work | 1 |

## Measurements

### Buildings

**Cause 1: floors are counted from sea level.** `js/tsl-materials.js:448` takes a wall's height from `positionWorld.y`. That was right when the world was flat. Buildings now stand at their real heights, a median of 28 m above sea level, and 97.4% stand more than one storey above it.

- The bottom of a wall cuts through a row of windows wherever it happens to fall, even on flat ground. This is most of what looks like a building starting underground.
- The ground floor only draws below one storey above sea level, so shopfronts, doors and the stone band are missing from 97% of buildings. Awnings hang over plain windows.

The rest of the shader already expects height above the building's base. In a scratch copy, using `wallH - fromTop` for footprint walls makes walls start with a whole storey and brings back shopfronts such as "COFFEE & BAKERY" and "CLEANERS". I compared the views from (-847, 5) and (-40, -300) with and without it.

**Cause 2: a level building on a slope.** `js/buildings.js:591` puts the floor at the mean height of the corners, so the ground is above the floor on the uphill side. Sampling every wall every 2 m:

| Ground above the floor somewhere along a wall | Buildings, of 15,785 |
|---|---|
| Over 0.3 m | 9,464 (60%) |
| Over 1 m | 3,914 (25%) |
| Over 2 m | 1,101 (7%) |
| Over 5 m | 68 (0.4%) |
| A whole wall buried | 23 |
| Worst | 10.1 m, at (298, -2777) |

The test copy shows this cause remains after the first fix: at (1401, -480) the pavement still crosses a row of windows at an angle.

The downhill side has a separate problem: the plinth is a flat tan wall with no detail. Moving floors to the top of the slope makes it taller. Ground height under the walls varies by a median of 1.4 m, 3.9 m at the 90th percentile, 8 m at the 99th, and 17 m at worst. 1,470 buildings vary by over 4 m.

### Street signs

- `js/street-details.js:126` makes one texture reading `GEORGE ST`, used by every blade.
- Blades exist only at the 435 signalised junctions. 422 of those have two or more road names nearby, 13 have one, and none have none: 268 different names. Names were counted within 25 m of each junction, so the count may include a nearby road that doesn't meet it.
- 2,494 junctions in the road graph have at least two names. Most have no sign.
- Real CBD signs include small dark plates fixed to fluted silver poles (one, blurry, seems to read Erskine St, 205 s into the city drive), and green plates on building corners. Neither can be read from a moving car.

### Travel modes

- Each mode has its own position, and `setMode` only switches between them (`js/controllers.js:330`).
- The idle walker paces up and down on its own, through walls (`js/controllers.js:1143`). It's left over from New York.
- `setMode` also runs at start-up and when restoring a save (`js/main.js:162`), so carrying over needs its own entry point.
- Useful pieces exist: `findTeleportPosition` finds a clear spot (with no idea what surface it's on), and `blockAt`, `nearestRoads`, `floorBelow` and `structureAt` answer the rest.

Fly height from today's roof data, by the rule in decision 5. Barangaroo and others will rise once Phase 7 corrects the towers:

| Place | Roofs in the area | 90th percentile roof, above sea level | Tallest | Fly at, above the ground |
|---|---|---|---|---|
| Macquarie St (spawn) | 45 | 128 m | 249 m | 130 m |
| Martin Place | 66 | 97 m | 168 m | 103 m |
| Town Hall | 86 | 72 m | 242 m | 79 m |
| Barangaroo | 14 | 231 m | 248 m | 260 m |
| North Sydney | 80 | 107 m | 130 m | 75 m |
| Surry Hills | 176 | 57 m | 62 m | 60 m |
| Over the harbour or the gardens | 0 | | | 60 m |

### References

All the photos and all but the end of one video show today's play area. World positions are approximate. Unsplash gives only "Sydney" or "Sydney Opera House" for all eight photos, so the viewpoints are my reading of the pictures.

| Photo | Viewpoint | Most useful for | World (x, z) |
|---|---|---|---|
| `caleb` | Drone south-east of the Opera House, looking north-west | Opera House from above, bridge, Dawes Point, Kirribilli, North Sydney | near (518, -1899) |
| `christopher-burns` | Probably Hickson Rd at Dawes Point, looking north-east, at night. **Least certain of the set** | Pylon stonework, deck underside, night lighting, sea wall and iron fence | near (-189, -1945) |
| `dan-freeman` | Harbour Bridge east footway or Pylon Lookout, looking south-east | Circular Quay, Opera House, Gardens, skyline, harbour colour | near (36, -2335) |
| `jamie-davies` | Airliner east of the harbour, looking west | The whole harbour: useful later for the bigger map | |
| `jasper-wilde` | Across Sydney Cove, looking east at sunset | Opera House side view: podium and shell shapes | near (40, -1641) |
| `jeremy-huang` | On the water north-east of Bennelong Point, looking south-west | Skyline, Crown Sydney, company names on tower tops | near (798, -2364) |
| `leigh` | Observatory Hill, looking along Lower Fort St to the bridge | Terraces, street scale, approach arches, gantries | near (-428, -1452) |
| `quentin-grignet` | Monumental Steps, looking north-west | Shell ribs, chevron tiles, steps, granite | near (491, -1760) |

| Video | Length | Route | Found online |
|---|---|---|---|
| Driving Around The City | 25:09 | CBD streets, morning of 29 Oct 2026. Probably Erskine St at about 205 s and Elizabeth St beside Hyde Park at about 785 s. The rest is tied down in Phase 6 | Yes: [eXFc9dTnxrU](https://www.youtube.com/watch?v=eXFc9dTnxrU), same length |
| Driving across the Harbour Bridge, 2023 | 6:19 | Western CBD, onto the bridge northbound, the Warringah Fwy past North Sydney and through its sandstone cuttings. **Leaves the play area** about two-thirds through | No. Read from the frames |
| Martin Place to Circular Quay | 33:42 | Martin Place, State Library, Royal Botanic Garden, Farm Cove, Opera House forecourt | Yes: [eWlN_ThjkSg](https://www.youtube.com/watch?v=eWlN_ThjkSg), same length |
| Walking tour, Hyde Park | 24:57 | Archibald Fountain, St Mary's, College St and its cycleway, Park St, Sandringham Gardens, the fig avenue | No: search found a shorter video of a similar name. Read from the frames |
| Royal Botanic Garden | 4:49 | Garden paths, sea wall, Government House, Farm Cove | Yes: [4lSXTCwzDEU](https://www.youtube.com/watch?v=4lSXTCwzDEU), same length |

What differs most from the game, compared at matching views:

| | Real | Game | Phase |
|---|---|---|---|
| Ground floors | Shops, lobbies, sandstone bases | Windows to the ground on 97% of buildings | 2 |
| Tall towers | Crown Sydney 271 m, MLC Centre 228 m | 40 m and 20 m. See "Parts" below | 7 |
| Awnings | Continuous steel awnings along most CBD blocks | Short canvas ones, placed at random. `cos_awnings.json` has 505 continuous-awning lines and nothing reads it. It's a planning control, not a survey, so check it against the videos | 7 |
| Façades | Sandstone, 1970s concrete grids, pink granite, curved glass | New York brick with window air conditioners | 7 |
| Roofs | Pale grey and white on flats, terracotta on houses | Flat tan | 7 |
| Opera House | Ribbed shells of up to 67 m on a broad granite podium, chevron tiles | A cluster of small white points on a slab | 8 |
| Bridge pylons | Tapered granite, stepped courses, arched openings, flags on the arch | Stepped boxes | 8 |
| Bridge deck | Heavy steel posts with lanterns, lane gantries, a rail corridor on the west side with fence and wires | Thin hangers and a plain barrier | 8 |
| Bridge approaches | Steel truss spans, and sandstone-faced arches where they meet the land | Plain viaducts | 8 |
| Signals | Heads on posts at the kerb, fluted silver or yellow poles, `STOP` plates, push buttons | New York mast arms | 9 |
| Road surface | Pale, patched asphalt, red bus lanes, green cycle lanes, painted `40`s | Dark and even | 9 |
| Motorways | Green direction signs, sandstone cuttings and walls, concrete barriers | Plain walls, no direction signs | 9 |
| Cabs | No yellow cabs in any reference. Sydney's are mostly white, silver or black sedans | The player drives a yellow New York cab with a roof box | 9 |

Seen but not taken, because they aren't buildings or roads: the harbour is teal in the photos and navy in the game, and the game's haze is much heavier. Both are quick to tune, so say if you want them added. Park paths, hedges and the Archibald Fountain are also not taken.

**Parts.** The generator reads Overture's `building` records only, so a tower recorded in `building_part` keeps its base's height. OSM's download box has 1,000 parts on 446 buildings, 256 with a height and 173 with a base height. 172 of the 397 buildings with parts in our snapshot are drawn at least 10 m too short, even counting any other record that overlaps them:

| Building | Tallest drawn over its footprint | Its parts reach |
|---|---|---|
| Crown Sydney | 40 m | 271 m |
| 25 Martin Place (MLC Centre) | 20 m | 228 m |
| International Tower One | 27 m | 217 m |
| The Galeries | 16 m | 206 m |
| International Tower Two | 27 m | 178 m |
| Australia Square | 20 m | 170 m |
| World Square | 27 m | 170 m |

Part heights need checking too: Chifley Tower's reach 217 m, and the real tower is about 244 m. Sydney Tower is modelled separately, so its 309 m parts don't apply.

### Bigger map

**What limits today's approach.** The whole map is loaded and resident at start, whatever the player is near.

| Limit | Now, 26.7 km² | What's left |
|---|---|---|
| Phone profile time to interaction, 4 s | 3.93 s, and 2 of 5 runs reach the limit | Nothing |
| Download, 1.4 MB | 1,450 KB, about two-thirds of it map data | Nothing. Binary `geodata` might win back 10-20% |
| City finished, phone profile | 38.5 s after interaction | It grows with area: twice the map is over a minute of half-built city |
| JS heap, laptop profile | 420-440 MB steady, 630 MB peak | Perhaps twice this before a phone tab is at risk. No real phone tested |
| Generators | 44 s, 2.5 GB peak, with 1 m rasters of the whole bounding box | About 300-500 km² on this PC |
| Number precision | 5 km from the origin at most | Fine to about 15-20 km |

So: about **27 km² while the Spec holds**, and about **50-60 km² on a desktop** if the phone limit is given up. These are straight-line estimates from one area. No larger map was built to test them.

**Why tiles change the answer.** A tile costs no more bytes than the same data in one file, and the first view needs only a few of them.

| Measured on today's data, 1 km tiles | Result |
|---|---|
| Buildings, all tiles | 217 KB, the same as today's one file (216 KB) |
| Buildings, largest tile and median tile | 15.3 KB, 3.8 KB |
| The same with outlines for far buildings | 125 KB, largest tile 9 KB. Triangles are the larger saving |
| Heights per tile, 20 m grid | 1.2-1.7 KB |

| Speed | Crosses 1 km in | With a 5 × 5 window |
|---|---|---|
| Car, 36 m/s | 28 s | 5 new tiles every 28 s |
| Helicopter, 52 m/s | 19 s | 5 new tiles every 19 s |

Even at 100 KB a tile, that's well under 1 Mbit/s, so the network isn't the limit. Building tiles without dropping frames is, which is why decoding moves to a worker.

**All of Sydney, by the numbers.** Counts come from Overture's current release, over the box from longitude 150.29 to 151.34 and latitude -34.08 to -33.56:

| | Today | The whole box |
|---|---|---|
| Area | 26.7 km² | 5,600 km², much of it water and national park |
| Buildings | 15,785 kept, of 34,725 downloaded | 1,191,029 before filtering. OSM alone has 404,372, so most of the rest are machine-traced |
| Building outline points | | 8.25 million |
| Road length | 1,062 km in OSM's download box (58 km²) | Not counted. At most about 35,000 km, if all 1,973 squares with over 100 buildings had the inner city's road density |
| Squares of about 1 km² with buildings | 42 tiles | 3,619 |
| Buildings per square | Fullest tile 1,239 | Median 127, 90th percentile 940, fullest 2,606 (near Bankstown) |
| Generators | 44 s | Estimated 2 CPU hours, about 15 minutes on 12 cores, if the cost per km² holds. Not tested |
| Total data, including lower detail | About 1 MB | Estimated under 100 MB, of which a player fetches only what's near them |

| Stage | Area | Buildings |
|---|---|---|
| Today's map | 26.7 km² | 15,785 kept |
| Inner Sydney, Phase 15 | 530 km² | 234,445 |
| East of Parramatta, with Palm Beach and Cronulla | About 1,850 km² | 616,435 |
| Everything to Katoomba | 5,600 km² | 1,191,029 |

The claim that memory stays about the same holds up on these counts: the High detail range covers about 20 km², which at the 90th percentile is about 18,000 buildings, near today's 15,785. Low's covers about 7 km². The fullest suburbs would hold more, so the budget counts buildings and triangles, not tiles.

**Hosting.** Cloudflare allows 20,000 files per version on the free plan and 100,000 on paid, 25 MiB each. All levels come to an estimated 6,000 files, which fits the free plan.

**What has to change, beyond the tiles themselves:**

| Problem | Why | Plan |
|---|---|---|
| Global data | `city-config`, `surfaces`, `road-network`, `traffic`, `pedestrian-*`, `city-map` and others build whole-map indexes at start | Indexes that add and remove a tile. Phase 12 |
| Colliders and meshes | Only ever added | Remove and dispose on unload. Phase 12 |
| Generators | Global 1 m rasters would need about 50 GB at this size | Each tile plus a margin. Phase 11 |
| Terrain data | 282 MB of contours for today's box of about 1,200 km² | A 5 m elevation model. Phase 15 |
| Precision | Katoomba is 84 km from the origin. Positions step by about 8 mm there, and the shaders' noise already broke near 100,000 (`ai/next_1.md`). 64 uses of `positionWorld` | A moving origin. Phase 13 |
| Water | One plane at -2.2 m. The Nepean and Prospect Reservoir are well above that | Water shapes with their own level in each tile. Phase 15 |
| Trees | The City of Sydney's register covers only its own area | OSM trees, then seeded scatter by land use. Phase 15 |
| Map screen | Draws every road to a canvas | A prebuilt image pyramid, and a street index fetched when the map opens. Phase 15 |
| Offline file | 25 MiB limit | Keeps today's area only. Decision 12 |

### Tests

| Run | Time |
|---|---|
| `npm test`, 260 tests | 3.1 s |
| `npm run build` | 1.2 s |
| `node tools/check-ground.mjs` | 2.6 s |
| `npm run play`, 26 scenarios, one run | **39.8 min**, 771 MB of video |

Five scenarios take 76% of that: `soak` 601 s, `harbour-bridge` 572 s, `stacked-roads` 355 s, `motorways` 159 s, `tunnel` 122 s. `recordings/` has grown to 4.7 GB. Every scenario boots its own browser and waits 3 s after the last one. All 26 run in real time.

## Decisions

Say so if you want any of these changed.

1. **Every wall stands on the ground and no window is cut by it.** The floor goes at the highest ground along the walls. Below that, each wall runs down to the ground in coursed stone, with a full storey of windows wherever one fits wholly above the ground.
2. **Roofs rise with the floors,** a median of 0.5 m and 3.9 m at the 99th percentile. The skyline barely changes. A roof contact uses the building's own base, so a helicopter lands on what's drawn.
3. **Shops only where they meet the pavement.** A wall more than 1 m above the ground beside it gets no shopfront or awning.
4. **Signs:** horizontal blades stay so they can be read from a car, in the real signs' dark plate and white text. Names come from a small texture holding the names near the player, so memory stays flat as the map grows.
5. **Modes share one position.** Press a mode and you arrive at the nearest suitable place, facing the way you were:
   - **Walk:** nearest footpath.
   - **Drive:** nearest lane on your side of the road, heading along it, away from traffic.
   - **Cycle:** whichever of the two is nearer.
   - **Fly:** straight up. **Surrounding buildings means roofs within 200 m**, about two or three CBD blocks each way. Height is the highest of: the 90th percentile of those roofs plus 30 m, 60 m above the ground, and the tallest roof within 40 m plus 15 m. It's capped at the existing 380 m.
6. **On a bridge or in a tunnel, nearest means nearest on that level.** Getting out mid-span doesn't drop you 50 m. The Harbour Bridge's real footway becomes walkable. Where a viaduct or tunnel has no footpath, you stand at the road's edge. Dropping out of the helicopter over water goes to the nearest shore.
7. **The vehicle you leave stays parked.** Switching back within 30 m gets you back into it where it is, and from further away it comes to you. It hides once you're over 200 m away.
8. **Billboards:** six sites, three for each name, on buildings with no name of their own in the data, so nothing suggests a real tower belongs to these companies. Text only, unless you send logos. Lit at night.
9. **Reference material stays reference.** Nothing cut from the videos or photos ships, and textures stay procedural. `ref/` is already ignored by git.
10. **Tiles are 1 km squares in the world frame,** like today's building chunks, one file per tile and level, gzip like today's data, in a folder named by content hash.
11. **Land has four levels of detail, and buildings three models:**

    | Level | Holds | Range, High | Range, Low |
    |---|---|---|---|
    | Detail, 1 km | Roads, kerbs, footpaths, lawns, normal buildings, trees, colliders, traffic graph | 2.5 km | 1.5 km |
    | Outline, in 4 km files | Height-grid terrain, outline buildings, major roads | 8 km | 5 km |
    | Region, 8 km | Coarser terrain, land-use colours, towers | 25 km | 15 km |
    | World, one file loaded at start | The whole box, coast, tallest towers. Replaces `surroundings.js` | Horizon | Horizon |

    | Building model | What it is | When |
    |---|---|---|
    | Outline | Up to 6 points and a height, in plain colours | Beyond the detail range |
    | Normal | Today's, improved in Phase 7 | Inside it |
    | Detailed | Your hand-built model, with an interior | Within about 200 m. At most 1 held in memory at Low and 3 at High |

12. **The offline file keeps today's area.** All of Sydney won't fit in 25 MiB, and a playable offline CBD is what the file is for.
13. **Outside the CBD, everything is generated.** No hand-tuned overrides. `check-ground` sets the bar for each tile, and failures get listed instead of being fixed by hand. Suburbs will have mistakes that the CBD doesn't.
14. **Terrain moves to Geoscience Australia's 5 m elevation model** (CC BY 4.0), sampled to the 20 m grid. If it doesn't cover the whole box, NSW's 2 km tiles from ELVIS fill the gaps, once their licence is confirmed: the NSW portal doesn't state one clearly.
15. **OSM comes from Geofabrik's Australia and Oceania extract** (1.2 GB), cut to the box locally. Overpass isn't suited to downloads this size: even counting the whole box's roads hit a capacity error while planning this.
16. **Test tiers are the default, and video is opt-in.** I run `npm run check` on every change, the lite set before saying something works, and the full run once at the end of an iteration.

## Phases

| Phase | Result | Size |
|---|---|---|
| 1 | Tests in tiers, no video by default | Small-Medium |
| 2 | Buildings on the ground, ground floors drawn | Small-Medium |
| 3 | Signs read the right street, New York names gone | Small |
| 4 | Modes carry over | Medium |
| 5 | Billboards | Small |
| 6 | References saved, side-by-side comparison | Small |
| 7 | Buildings from data: parts, awnings, façades, roofs | Medium |
| 8 | Opera House, Harbour Bridge and street icons from the references | Medium-Large |
| 9 | Roads and street furniture from the references | Medium |
| 10 | Outline model for far buildings | Medium |
| 11 | Tile format and generators, today's area | Large |
| 12 | Streaming: today's area, in tiles | Large |
| 13 | Moving origin, and all of Sydney on the horizon | Medium |
| 14 | Detailed buildings, with one walk-in test building | Medium |
| 15 | Inner Sydney | Large |
| 16 | All of Sydney | Large |
| 17 | Play, budgets, `ai/next_2.md` | Medium |

**Places to stop:**

- **After Phase 10:** everything in the prompt except the bigger map, on today's map, and already lighter to draw.
- **After Phase 12:** the same map in tiles, and it should load faster. Nothing is bigger yet, but the hard part is done.
- **After Phase 15:** about 500 km², with Bondi, Manly and the airport.
- **After Phase 16:** everything you listed.

## Phase 1: Tests

- **`npm run check`:** unit tests, build and `check-ground`, about 7 s today. Runs on every change.
- **`npm run play` becomes the lite set:** `first-minute`, `walk-cycle`, `helicopter`, `mode-map`, `touch`, `webgl2-fallback`, `low-graphics`, under 3 minutes. `--full` runs everything.
- **No video by default.** Reports and final screenshots stay. A failure reruns once with the same seed and with video, so there's always a recording of a failure that repeats. `--video` asks for it anyway. Old runs are pruned down to the last three.
- **`--changed`:** picks scenarios from `git diff`. Each scenario lists the modules it covers and the map area it drives through, so a change to `js/harbour-bridge.js` runs the bridge scenarios and a changed map tile runs only the scenarios crossing it. `check-ground` gets `--tiles=`.
- **A faster clock for long drives:** `--fast` replaces `human.wait` with a debug call that steps the simulation without waiting in real time, drawing only occasional frames for the watchdog. Scenarios that measure frames stay in real time. Measure the gain before moving scenarios over: the target is 5-10 times faster on `harbour-bridge`, `stacked-roads`, `motorways` and `tunnel`.
- **The soak drops to 5 minutes** in the full run. `--soak=10` stays for before a deploy.
- **Repeats only for a failure.** No more rounds of 3 or 8 unless something is flaky. `--repeat=N` is for that.
- **README:** a short "which test when".

**Done when:** check is under 15 s, lite is under 3 minutes with no video, and full is under 20 minutes.

## Phase 2: Buildings on the ground

- **Floors from the base.** `vCoord` for footprint walls measures from the building's floor. Check that landmark boxes aren't making the same mistake.
- **Floor at the highest ground along the walls,** sampled every 2 m instead of at corners. This stays in the client for now and moves to the generator with Phase 11.
- **Walls follow the ground.** Their bottom edge is split every few metres down to the ground, replacing the separate plinth mesh. The façade draws stone below the floor, with a whole storey of windows only where it clears the ground at that point.
- **Details follow the wall:** awnings, signs and shop lights use the height at their own stretch of wall, and are skipped above 1 m.
- **Roof contact:** `roofHeightAt` and helicopter landings use each building's base.
- **Height-based shading,** such as soot and street-canyon darkening, starts working as written. Look at the result, since it hasn't been seen since the world was lifted.
- **`check-ground` gets a `buildings` section:** ground above the first window row, and plinth height.

**Done when:** no wall sample has ground more than 3 cm over the bottom of its lowest window row, the worst spots look right from the street (`look.mjs`), a helicopter settles on a sloped building's roof, and load time and frames don't get worse.

## Phase 3: Street signs and shop names

- **`signNames()`:** for a junction, the named links that meet it and their bearings, using the short names (`George St`). A blade names the road it runs parallel to, as real blades do. Unnamed links are skipped.
- **A sign at each corner gets a pair of blades, one for each road,** and no blade where a junction has only one name for that direction.
- **Near-player text texture:** 1024 × 1024, 64 names, refilled as the player moves. Far blades show a blank plate. The per-instance offset stays in the existing material, so no new shader compile.
- **Posts at other named junctions,** up to about 2,000 more corners. Instanced, so cheap.
- **New York names go,** now that shops actually show: `NEIGHBORHOOD DELI` and `CORNER MARKET` (`js/tsl-materials.js:485`) and `DUANE READE · PHARMACY` (`js/buildings.js:323`) become Sydney ones, such as a newsagent, a chemist and a bottle shop. `GEORGE ST BISTRO` on every street gets a name that doesn't mention a street.

**Done when:** unit tests pin named junctions (George & Market, Macquarie & Bridge, Pitt & Park, and a one-name junction), `look.mjs` shows the right names at three of them, and no `GEORGE ST` blade stands away from George St.

## Phase 4: Modes that carry over

- **`js/arrivals.js`:** pure functions tested in Node against the real map: `nearestFootpath`, `nearestLane`, `flyingHeight`.
- **`switchMode()`,** used by the keys, buttons, touch and gamepad. `setMode` stays for start-up and restoring a save.
- **Search:** rings out from the player, on the same level first (`structureAt`, `floorBelow`), reusing the collision check in `findTeleportPosition`. A lane is checked against nearby traffic, and moves on along the road if blocked.
- **Harbour Bridge footway walkable** by the player, inside its railing. Pedestrians stay off it (plan 1, decision 10).
- **The camera cuts,** with a short fade for moves over 50 m, so it doesn't swing across the city.
- **Remove the idle walker.** Saves keep each mode's position in the same format, so old saves still load.
- **New scenario `mode-switch`:** every pair of modes, on a street, in a park, on the deck, in a tunnel, over the harbour and over the tallest towers.

**Done when:** tests and the scenario show each arrival on the right surface, within 3 m of the start where that surface is underfoot, and a helicopter arrival clear of every roof by at least 15 m. Parked vehicles behave as in decision 7.

## Phase 5: Billboards

- **`js/rooftop-signs.js`:** a short table of sites, and a helper that checks a site's roof height and the wall it faces.
- **Two forms,** both seen in the references or in Sydney itself: letters on a tower's crown, as the "salesforce" and "UniSuper" signs in `jeremy-huang`, and a steel-framed sign on a mid-rise roof. Kings Cross, at the top of William St, is the obvious place for the second: it's where Sydney's famous Coca-Cola sign is.
- **Sites, picked from these views with a script, then by eye:** the start of the drive along Macquarie St, Circular Quay, the bridge deck in each direction, the Western Distributor, William St.
- **One texture and one unlit material,** compiled after the first frame. Rooftop frames get a collider.

**Done when:** each site reads from its view by day and night, the phone profile's load time doesn't change, and the download grows by under 5 KB.

## Phase 6: References

- **`tools/ref-frames.mjs`:** one frame every 10 s at 1920 px, to `ref/frames/<video>/<seconds>.jpg`, with `ref/frames/index.json`. About 600 frames.
- **`ref/locations.md`:** the tables above, kept up to date, with each video's route tied to timestamps by reading its street signs.
- **Confirm `christopher-burns`'s viewpoint** by matching the road's shape against OSM.
- **`tools/play/compare.mjs`:** a `ref-*` spot for each photo, saved next to the photo as `ref/compare/<name>.jpg`. Later phases use it to show progress.

**Done when:** frames and comparisons exist for every reference, and you've had a chance to correct a location.

## Phase 7: Buildings from data

- **Read `building_part`,** with its base and top heights, so towers get their real height, setbacks and podiums. This comes first in this phase, since it's the largest visible error. The generator keeps parts as stacked pieces of one building for collision and roofs. Measure the download: the box's parts are small, 14,489 points in all.
- **Fix what parts don't.** Add missing or wrong tower heights to the `HEIGHTS` table, and list the 30 tallest with their known heights in a test.
- **Curved glass,** where the footprint's already round, keeps its windows evenly spaced.
- **Awnings from `cos_awnings.json`,** once checked against the videos: continuous steel awnings along those frontages, keeping the random canvas ones only where no line exists.
- **Façades:** remove window air conditioners from masonry. Add a 1970s concrete grid and pink granite, without adding materials if possible, since shader compile is the phone's biggest cost. Choose them by building age or height where data allows.
- **Roofs:** pale grey and white on flat roofs, sampled by eye from `jamie-davies`.

**Done when:** comparison pictures of the skyline read as Sydney to you, the 30-tallest test passes, and the download stays in budget. Report what parts cost.

## Phase 8: Landmarks from the references

- **Opera House:** rebuild it on the real plan and heights: 183 × 120 m, shells to 67 m above sea level, cut from a sphere of about 75 m radius, as the existing code's geometry already intends. Add ribs, glass walls, the podium's granite, the Monumental Steps, the Bennelong restaurant, and a procedural chevron tile. It's the most-photographed thing in these references: 6 of 8 photos.
- **Harbour Bridge:**
  - Pylons in tapered granite with stepped courses and arched openings.
  - A deeper arch with real diagonals.
  - Deck posts with lanterns, lane gantries with a working `70`, the rail corridor on the west with fence and wires, flags on the arch.
  - Approaches in steel truss spans, with sandstone-faced arches where they meet the land.
  - Keep plan 1's rule that nothing drawn is out of reach unless it's behind a barrier.
- **Street icons,** exteriors only, from the walks: GPO, State Library, St Mary's, and Queen Victoria Building's domes if time allows. Interiors wait for your detailed models.
- **Triangle and draw budgets for each** are set first and reported after. Far versions join Phase 10's outlines.

**Done when:** the comparison pictures for all 8 photos are clearly closer, `harbour-bridge` and `bridge-edges` still pass, and frames and load are within budget.

## Phase 9: Roads and street furniture from the references

- **Asphalt:** paler, with patches. Pavements in pale granite. Check at each time of day: they look blue at golden hour now.
- **Paint from OSM tags:** red bus lanes with `BUS LANE`, green cycle lanes and College St's cycleway, painted speeds, zebras with yellow diamonds.
- **Signals:** heads on posts at the kerb on near and far corners, with arms only on wide roads. Fluted silver poles in the CBD and yellow posts elsewhere, push buttons, and `STOP` and turn-ban plates. `js/traffic.js` obeys the same clock, so only the models change.
- **Road signs:** one-way arrows from `oneway`, speed roundels from `maxspeed`, blue parking signs in the CBD, and green motorway signs from OSM's `destination` tags.
- **Motorways:** sandstone ashlar on retaining walls, rock faces for the Warringah Fwy's cuttings, concrete barriers.
- **The player's cab** becomes a white or silver sedan with a small roof light. `js/cars.js` keeps its shape.

**Done when:** comparison pictures at matching points in the two drives are clearly closer, and frames and load are within budget.

## Phase 10: Outline model

- **The generator writes an outline for each building:** up to 6 points and a height, plus roof and wall colour.
- **Beyond the detail range, one merged mesh per 1 km cell** replaces the normal buildings: 12-20 triangles a building, no details, simple windows, and existing shadow stand-ins where they apply.
- **Switch by cell, with a margin** so cells don't flicker between models. Towers keep their normal model further out, since they're what the eye goes to.
- **Works without tiles,** so it can ship on its own and lets Low drop far buildings' full detail.

**Done when:** draw calls and triangles over the CBD fall by at least a third from today's 1,110 and 2.9 million, phone frames improve, and a slow flight shows no visible popping beyond a building or two. Report the result on the phone profile.

## Phase 11: Tile format and generators, today's area

- **`tools/tiles/`:** a worker pool running each tile plus a 200 m margin, with a cache keyed by source data, so only changed tiles rebuild.
- **Everything in `js/geodata.js` and the `.bin.gz` files moves into tiles,** in binary. This also settles `geodata`'s download (plan 1, decision 11).
- **What crosses tiles:** roads get stable node ids and appear in each tile they touch. Structures live in a side table, by id. `build-heights` solves each connected structure group, not each tile.
- **`world.json`:** the manifest, with tile hashes, landmarks and start positions, under 30 KB.
- **Sources** stay the same for this phase, so the output can be checked against today's.
- **Building floors, outlines and colliders are computed here,** not in the browser.

**Done when:** today's area comes out with the same buildings, and `check-ground` is no worse than the table in `ai/next_1.md`. Total bytes are no larger than today's map data, and a one-tile change rebuilds in under a minute.

## Phase 12: Streaming

- **`js/tiles/`:**
  - `tile-manager.js`: the wanted set from position, speed, heading and graphics level, nearest first, with an LRU cache and a memory budget per level.
  - `tile-worker.js`: fetch, unpack, triangulate and return arrays. The main thread only creates GPU buffers, within `WorldBuilder`'s few milliseconds per frame. The offline file needs the worker inlined, so test it from `file://`.
- **Every module that reads the whole map moves over:**

  | Module | Change |
  |---|---|
  | `city-config`, `surfaces`, `terrain` | Indexes per tile, and a safe answer where nothing's loaded |
  | `city-grid`, `ground-geometry`, `structures`, `road-paint`, `tunnel-mouths` | Build per tile |
  | `buildings`, `building-footprints`, `trees`, `tree-placements`, `street-details` | Per-tile jobs into pooled instanced meshes |
  | `road-network`, `traffic`, `pedestrian-routes`, `pedestrian-system` | The graph grows and shrinks. Agents exist only near the player, and appear and vanish at the edge of that range |
  | `controllers` | Removable colliders |
  | `scene-culling` | Add and remove |
  | `main` | `buildRestOfWorld` becomes the tile loop |

- **This closes the traffic gap in `ai/next_1.md`:** the map's edge stops being special, so motorways fill.
- **Tile not there yet:** coarse ground stands in. If a car somehow outruns its tile, it slows down near the edge instead of falling through.
- **A long-drive soak:** across today's area and back for 30 minutes, with memory checked.

**Done when:** every scenario in the full run passes. The phone profile is at or under 3.5 s, desktop at or under 2 s, and the first view's download is under 1 MB. Heap stays flat over the soak, and phone-profile p95 frame time is no worse than today's 33.7 ms during streaming.

**This is the phase to test on a real phone.** If the numbers aren't there, the later phases wait.

## Phase 13: Moving origin, and the horizon

- **The world hangs from one root that moves,** in steps of 4,096 m, when the player gets that far from the last one. Moving objects are unchanged, since their positions pass through doubles. Tiles store small coordinates relative to their corner. Instanced positions are written relative to the origin.
- **Shaders:** the 64 `positionWorld` uses are checked. Patterns that need world position wrap at 4,096 m, so a move changes nothing on screen.
- **Far levels:** Region and World level meshes and a land-use texture for the whole box, replacing `surroundings.js`. Flying up shows all of the basin, even while the detailed map is small.
- **Test by shifting the world:** run the existing scenarios with the origin 85 km away (a debug offset) and look for shaking and broken patterns.

**Done when:** a test at Katoomba's distance shows no jitter on the car or nearby buildings, moves between origins can't be seen in a captured frame pair, and the horizon shows the coast and the mountains' rise.

## Phase 14: Detailed buildings

- **A manifest entry per building:** Overture id, glTF file, position and rotation, doors, floors. Overture's ids are meant to persist but I found no guarantee, so the generator warns when one disappears and keeps a fallback by location.
- **Loading:** `GLTFLoader` arrives on demand, so nothing costs anything until you're near one. Within about 200 m, the normal building is hidden and the model takes its place.
- **Inside:** floors are surfaces (`js/surfaces.js`), and walls are colliders. Doors open a gap in the building's solid collider. The sky's light fades indoors as in tunnels, a few placed lights take over, and traffic and far detail pause drawing when you're inside.
- **`ai/` guide for your models:** format, scale, origin, triangle and texture budgets, and how to test one with `look.mjs`.
- **One plain test building** with a door and a lobby, to prove the path. Replace it with your first real one.

**Done when:** a scenario walks in through the door and out again, on phone and desktop profiles. Nearby frames stay within budget, and memory returns when you leave.

## Phase 15: Inner Sydney

About 24 × 22 km, 530 km², and 234,445 buildings: Burwood to Bondi, Manly to the airport.

- **New sources:** the OSM extract, Overture buildings and parts, the 5 m elevation model.
- **Footprints and heights:** most new buildings are machine-traced, so check a sample against OSM and the bridge drive's frames north of the current map.
- **Run the generators for real.** Expect problems the CBD never showed: roads with fewer tags, more water, ferries and rail beyond the current box.
- **Water per tile,** with its own level. Trees by OSM, then seeded scatter.
- **Map screen:** image pyramid and street index on demand, teleports for new suburbs, and `SUBURBS` from data.
- **Landmarks:** Bondi Beach and Sydney Airport get whatever data gives them, and no hand-modelling in this plan.

**Done when:** `check-ground` thresholds pass in at least 98% of tiles, failures are listed by tile, and a helicopter flight across and a drive from the CBD to Bondi both finish with flat memory and frames in budget. Report the download, the build time and the bytes.

## Phase 16: All of Sydney

- **North to Palm Beach and south to Cronulla, then west through Parramatta and Penrith to Katoomba.** Each is a stopping point, and each repeats Phase 15's checks.
- **Cliffs:** the 20 m grid will blur the Blue Mountains' escarpment. Try a finer grid just for tiles with very steep ground before anything else, and report how Echo Point looks.
- **Bush:** forest as land-use colour and near-camera scatter. Nothing is stored for each tree.
- **Long drive:** a scripted run from the CBD along the M4 to Katoomba in fast mode, about 85 km.

**Done when:** all four named places can be reached by road and air, a full crossing keeps memory flat, and total bytes and file count are reported against Cloudflare's limits.

## Phase 17: Play, budgets, next

- Run the full set once, `npm run bench` on Chrome and Firefox, and `npm run viewports`.
- Update the README's "How it works": the map stops being one file.
- Write `ai/next_2.md`.

| Budget | Now | Target |
|---|---|---|
| Time to interaction, desktop | 2.37 s | 2 s, with tiles |
| Time to interaction, phone profile | 3.93 s | 3.5 s, with tiles |
| Download for the first view | 1,450 KB | 1 MB, with tiles |
| Frames, phone profile | 36.2 FPS, p95 33.7 ms | No worse. Better after outlines |
| Draw calls over the CBD | 1,110 | 740 |
| JS heap, steady | 420-440 MB | Under 500 MB at High and 300 MB at Low, anywhere on the map |
| Walls with ground over their first window row | 25% over 1 m | 0 |
| Full test run | 39.8 min | Under 20 min |

Before tiles, the first three stay at today's limits: 2.5 s, 4 s, and 1.4 MB or say why not.

## Risks

| Risk | Why | Plan |
|---|---|---|
| Size of Phases 11-12 | They touch most of the code, including levels, traffic and the things plan 1 just got working | Same map first, every scenario still passing, nothing bigger until that holds. They're the main stopping point |
| Real devices | Still none tested, and tile budgets depend on them. Everything here rests on a throttled desktop | Phase 12 asks for a real phone before going further |
| Traffic across tile edges | Unloading a tile under moving cars and people | Agents only near the player, and edges well inside the loaded area |
| Generated quality in the suburbs | Plan 1 needed overrides for the CBD's stacks, and the suburbs get none | Checks by tile, failures listed. You decide whether a stage is good enough |
| Building data | 65% of the box's buildings have a height in Overture, but only 18% in our CBD snapshot, so most suburban ones come from another source of unknown quality. Most footprints are machine-traced | Sample against known buildings in Phase 15. Fall back to today's guess by kind where a height looks wrong |
| Shops visible everywhere | Phase 2 turns on drawing nothing has been looked at for since the world was lifted | Look at it in Phase 2, and keep the New York names list in Phase 3 close behind |
| Shader compile | Already the largest cost of a phone's load, 1.3 s | New looks reuse existing materials where possible. Billboards and landmarks compile after the first frame |
| Licences | NSW elevation data's licence isn't clear | Prefer the CC BY 4.0 national model, and add each source to the README |
| Cloudflare | Limits checked from a page that may not be current. Bandwidth cost not checked | Confirm before Phase 16. R2 is the fallback |

## Not in this plan

From `ai/next_1.md`: why deck traffic is so slow (`harbour-bridge`'s long run sidesteps it with the fast clock, but the cause stays open), wheel contacts for the bus, bicycle and traffic, the ground targets still missed, the pale band in the William St tube.

## What I need from you

1. **A real phone and an Intel laptop** at Phase 12, or sooner if you can. This is still the largest unknown.
2. **Logos** for Man & Bot and Maize.Live, if you'd prefer them to text.
3. **Your first detailed building,** when you get to it, and which building it is. The test building holds its place until then.
4. **Whether you're on Cloudflare's free or paid plan.** The free plan's file limit looks like enough, but what bandwidth costs still needs checking.
5. **Corrections to the location tables,** especially `christopher-burns` and the routes I read from frames.

## Sources

- `tools/data/` snapshots; Overture Maps release 2026-10-21.0 (`building`, `building_part`, `segment`), queried through DuckDB; OpenStreetMap through Overpass
- `js/tsl-materials.js`, `js/buildings.js`, `js/building-footprints.js`, `js/street-details.js`, `js/controllers.js`, `js/main.js`, `js/surfaces.js`, `js/city-config.js`, `tools/geo-common.mjs`, `tools/fetch-data.mjs`, `tools/play/run.mjs`, `recordings/2026-11-01-11-25-04/report.json`, `ai/next_1.md`
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/index.md), [100,000-file change](https://developers.cloudflare.com/changelog/post/2025-09-02-increased-static-asset-limits/)
- [Geoscience Australia 5 m elevation model](https://researchdata.edu.au/digital-elevation-model-metre-grid/1278967), [ELVIS](https://catalogue.data.wa.gov.au/app/elvis-elevation-information-system), [NSW Elevation and Depth Theme](https://data.nsw.gov.au/data/dataset/1-f1b1b26b23ab4574a561f890edd3bd7e)
- [Geofabrik downloads](https://download.geofabrik.de), [Overture buildings guide](https://docs.overturemaps.org/guides/buildings)
- [Sydney Opera House on Wikipedia](https://en.wikipedia.org/wiki/Sydney_Opera_House), [its spherical solution](https://www.sydneyoperahouse.com/our-story/the-spherical-solution)
- Unsplash pages: [`caleb`](https://unsplash.com/photos/JmuyB_LibRo), [`christopher-burns`](https://unsplash.com/photos/FUh6nK3s0po), [`dan-freeman`](https://unsplash.com/photos/7Zb7kUyQg1E), [`jamie-davies`](https://unsplash.com/photos/Hao52Fu9-F8), [`jasper-wilde`](https://unsplash.com/photos/J5IHHz-q9RU), [`jeremy-huang`](https://unsplash.com/photos/t0OkR71B-WY), [`leigh`](https://unsplash.com/photos/Wp3xWCVXMCI), [`quentin-grignet`](https://unsplash.com/photos/XJEQ6Td5UyM)
