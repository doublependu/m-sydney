# Plan 0: remake the New York game on the map of Sydney

Answers `ai/prompt_0.md`, and covers the Spec in `CLAUDE.md`.

Nothing is implemented yet. All experiments ran on throwaway copies, so the only change to this repo is this file. The test code isn't kept.

## Where things stand

This is a port, not a re-skin. The engine carries over: rendering, vehicles, people, traffic, audio, staged loading, graphics levels, pause, play scripts. The map data, the landmarks and everything that assumes Manhattan get replaced.

Almost everything under "General" in the prompt already exists in the New York repo at `c6e6a3f`, so it arrives with the import. The real work is that Sydney breaks four assumptions the game is built on:

| New York assumes | Sydney has | Tested? | Result |
|---|---|---|---|
| Street grid plus some irregular streets | No usable grid | Yes, real `road-network.js` in Node | Works. The non-grid path alone built 454 km of connected road |
| Driving on the right | Driving on the left | Yes, network build only | 5 small edits. The traffic simulation itself has not run this way |
| A flat world | About 50 m of relief | Yes, fake hills on real New York | Works if the simulation stays flat and only what's drawn is lifted |
| An island, with scenery bridges | A harbour, and a bridge people will want to drive over | No | Designed, not tested. The riskiest new work (Phase 6) |

Sydney itself has not been rendered yet. The road network ran in Node, and the terrain test ran on New York.

**The Spec is harder here than it was for New York.** This repo says devices "bought within 5 years"; New York's said 3. Older phones are less likely to have WebGPU, so the WebGL2 path matters more. It took 13.2 s to load and ran at about 19 FPS before New York's load work, and has not been re-measured since.

## Prompt items

| Prompt item | Status | Phase |
|---|---|---|
| Remake on the map of Sydney | New work | 2-8 |
| Fork me and Maize.Live links on loading and pause screens | Exists, URLs change | 1 |
| Static site, Cloudflare via wrangler, preview URLs off | Exists, worker name changes | 1 |
| Version in a corner, `v.ab12` | Exists | 1 |
| Full screen, responsive, rotation, zoom prevention | Exists, re-checked with `npm run viewports` | 1, 9 |
| Scripts that play like a human, with recordings | Exist, routes are all New York | 9 |
| Balanced and fun, fewer bugs | Re-run on the new map | 9 |
| Download as a single HTML file | Exists, name changes | 1 |
| Three.js | Already used, `three@0.187.0` | - |
| Multiplayer (p3p2), physics engine | Not needed: no multiplayer, and `js/vehicle-physics.js` covers physics | - |

## What gets reused

Line counts are from `js/` in the New York repo, 34,370 lines in total.

| Fate | Lines | Files |
|---|---|---|
| Rewrite | about 9,300 (27%) | `city-config`, `boroughs`, `landmarks`, `city-grid`, `subway-*`; `fire-escapes` is removed |
| Adapt, mostly small edits | about 18,200 (53%) | `road-network`, `traffic`, `road-paint`, `controllers`, `cameras`, `main`, `buildings`, `street-details`, `nyc-map`, `trees`, `cars`, `bus`, `tsl-materials`, `lighting` |
| Keep as is | about 6,900 (20%) | audio, pedestrians, physics, helicopter, touch, gamepad, quality, culling, world jobs, pause |

The 237 unit tests all pass on the New York repo today. Most are not map-specific, but `geodata`, `nyc-map`, `teleports` and the two data tests need rewriting.

## Measurements

**Setup:** i5-11400F, RTX 3060, Chrome 156 headless with real WebGPU (NVIDIA adapter), local server with brotli.

**This PC can't test the Spec's GPU target.** The i5-11400F has no integrated GPU. Frame-rate budgets need the Intel UHD laptop used for New York's numbers.

### Map size

The survey box runs from -33.905 to -33.825 latitude and 151.175 to 151.245 longitude, about 43 km², the same as New York's detailed map.

| Area | Buildings | Road km | Buildings gzip | City trees gzip | RAM |
|---|---|---|---|---|---|
| New York today | 37,353 | - | 441 KB | 123 KB | 1.7 GB measured |
| A: CBD only | 5,190 | 209 | 72 KB | 23 KB | ~1.36 GB |
| **B: Harbour core (chosen)** | **15,284** | **455** | **204 KB** | **46 KB** | **~1.47 GB** |
| C: whole survey box | 29,195 | 907 | 380 KB | 101 KB | ~1.63 GB |

- RAM is projected from the New York study's fit (1,296 MB + 11.5 MB per 1,000 buildings). It has not been measured on Sydney, and about 1.3 GB of it barely changes with map size.
- Download isn't the problem. The road graph for the whole box is 179 KB brotli, against New York's 302 KB for all its map data. Curb blocks and the height grid are not sized yet.

### Road network, real `js/road-network.js` in Node

Input was OSM roads over the whole box, with curb islands rasterised from estimated road widths. The grid path received no data.

| Measure | Sydney | New York |
|---|---|---|
| Graph input | 9,202 nodes, 11,759 links | 2,144 nodes, 3,030 links, plus the grid |
| Curb islands | 2,114 over 120 m² | 2,691 blocks |
| Connected network | 3,975 junctions, 7,711 edges, 454 km | - |
| Signalised junctions | 383 | - |
| Build time | 2.1 s, behind the game | - |

The connected network is the south side only. The other 57% of edges are the north shore, which has no link without the bridge, plus fragments I didn't break down.

**Left-hand traffic:** 5 edits to `road-network.js`: the normal in `addEdge` and `addEdgeGeneral`, the two lane-offset checks, and the sign of `cross`. Every other site reads `e.rx/e.rz`. Afterwards 4,158 two-way edges keep left and 52 don't (not examined), and all 3,114 far turns are real right turns.

### Terrain

Height from City of Sydney 1 m contours, over the 254 km of road they cover.

| Place | Height |
|---|---|
| Circular Quay | 1 m |
| Darling Harbour | 4 m |
| Central | 21 m |
| Town Hall | 22 m |
| Hyde Park | 29 m |
| Kings Cross | 41 m |
| Taylor Square | 50 m |

| Road grade | Share of length |
|---|---|
| Under 2% | 42% |
| Under 6% | 86% |
| Under 10% | 97% |

So the climbs are big but gentle, which suits a smooth lift. The north shore isn't covered: the global DEM puts North Sydney near 96 m, but see the first trap below.

### Terrain lift on real New York

Fake hills of Sydney's size: 0-40 m, about 5% grades. The simulation stays flat, so colliders, traffic and people are unchanged. Static geometry is lifted once in `revealStage`, and moving objects just before each render.

| Measure | Unmodified | Lifted |
|---|---|---|
| Time to interaction | 2.48 s | 3.86 s |
| City complete | 18.5 s | 23.0 s |
| FPS, forced High | 54.9 | 59.5 |
| 95th percentile frame | 31.1 ms | 16.8 ms |
| Triangles per frame | 4.76M | 6.30M |
| Console errors | 0 | 0 |

- **The FPS difference is noise.** The honest reading is no visible cost on an RTX 3060. The 32% extra triangles will matter on Intel UHD.
- **The 1.4 s startup cost is the naive subdivision in JS,** 4.4 s in total across the build. This has to be baked or sliced. New York's phone figure of 3.55 s leaves only 0.45 s of margin.
- **Two things broke and were fixed:** subdividing the 60 × 60 km water plane crashed the tab, and sun shadows vanished until the shadow focus used the lifted position.
- **Not done in the test:** pedestrians (they'd be underground), night lights, vehicle pitch. Buildings sheared with the ground instead of sitting level.

### Building heights

OSM alone has 237 explicit heights, and `building:levels` on 39% of buildings. Overture (release `2026-10-21.0`) does better:

| Measure | Result |
|---|---|
| Buildings | 34,725 (28,337 OSM, 6,388 Microsoft ML) |
| With height or floors | 16,322 (47%) |
| Missing, whole box | 42% of footprint area |
| Missing, CBD | 21% of buildings, 12% of area |
| Missing, over 2,000 m² | 212 of 629 |

Most gaps are small houses, and the CBD towers checked out (Salesforce Tower 263 m, 55 Pitt 230 m). Those 212 large buildings are the ones worth fixing by hand.

### Data traps found

- **Global DEMs are wrong here.** AWS Terrarium gives Town Hall 49 m and Circular Quay 11 m, because towers are smeared into the ground. Use survey data only.
- **OSM's coastline stops at the Heads.** No coastline nodes fall in the play area, so New York's shoreline code would silently return nothing. The harbour is water relation `15522136` (Port Jackson), with 25 islands as inner rings.
- **OSM signals sit at stop lines,** not junctions. 1,700 signal nodes snap to 612 junctions, but New York only matches within 6 m.
- **George St has no cars** through the CBD: 1.83 km is tagged pedestrian, with light rail.
- **The bridge doesn't connect by name.** Adding `Bradfield Highway` left the north shore separate. Its ramps have to be picked by hand.
- **Much of the motorway network is stacked:** 38.8 km of tunnel and 25.7 km of bridge in the box, with several levels around the Cahill and Western Distributor.
- **275 roundabout ways.** New York has none, and the network collapses links under 14 m, so small ones may vanish.
- **Road widths are mostly guesses:** 5% of road length has `width`, 37% has `lanes`.
- **Flat roofs would look wrong.** The box has over 5,700 tagged houses and terraces, and only 862 buildings have a roof shape.

## Not verified

- **Any of this in the real game on Sydney data.** See "Where things stand".
- **The traffic simulation driving on the left.** Only the network build ran.
- **Intel UHD, real phones, iOS Safari, and the WebGL2 path.** The same gaps New York still has, on older target devices.
- **Elevation north of the harbour.** City of Sydney data stops at the harbour. The state 1-2 m DEM is CC BY, but ELVIS's old API host is gone and I couldn't script it. The NSW `Contour` layer exists; its interval isn't checked.
- **The bridge's height profile.** OSM has its plan but no elevations. Sources give an arch span of 503 m, a top of 134 m and a deck 49-52 m above water, and they disagree slightly.
- **Overture's licence terms.** Review them before shipping its data.

## Decisions

Say so if you want any of these changed.

1. **Import the New York code at `c6e6a3f`,** keeping the layout. Its `ai/`, `CLAUDE.md`, git history and data files stay behind.
2. **This repo stays GPL-3.0.** The New York code is MIT, so its notice is kept in a separate file. Map data keeps its own licences: ODbL for OSM-derived data, CC BY for City of Sydney and NSW, credited in the README and pause screen.
3. **Named "Slop Sydney".** Worker `m-sydney`, offline file `slop-sydney.html`, links to `github.com/doublependu/m-sydney`, and a credit to `mrdoob/slop-newyork`.
4. **Play area B.** It has every icon, fewer buildings than New York, and both sides of the bridge: CBD, The Rocks, Barangaroo, Darling Harbour, Pyrmont, Ultimo, Surry Hills, Darlinghurst, Potts Point, the Domain, and Milsons Point to North Sydney. Beyond it is low-detail scenery, as with New York's boroughs.
5. **Terrain is in, as a render-only lift.** The simulation stays flat, and the lift is CPU-side so it also works on WebGL2. It comes after the flat game works, so it can be dropped if the budget says so.
6. **The Harbour Bridge is drivable; other motorways are not.** Tunnels and elevated motorways are scenery with ambient traffic. This keeps stacked roads down to one hand-built corridor.
7. **Same four modes and no goals.** Walk, drive, cycle, fly. Ferries and light rail are moving scenery, not playable. Scope stays a sandbox, as in New York.
8. **World frame:** 1 unit = 1 m, x = grid east, z = grid south, turned 8° from true north to match the CBD, origin at Town Hall.
9. **Start near Macquarie St and Bridge St, facing the Opera House,** or the nearest street with that view if its lanes don't survive the network build. New York got its load time partly by leaving landmarks out of the first frame, so the Opera House needs a cheap stand-in in the first stage.
10. **Generic Sydney-style liveries,** with no real operator logos. Speeds are km/h and altitude is metres.
11. **Generators are Node only.** `python3 -m venv` failed here and there is no Shapely. Overture reads fine through `@duckdb/node-api`.
12. **No map tiles.** The whole play area loads as in New York. It fits, and tiles are a separate project.

## Phases

| Phase | Result | Size |
|---|---|---|
| 1 | New York running from this repo, renamed | Small |
| 2 | Sydney data generated and checked | Large |
| 3 | Flat Sydney playable, no grid or island | Large |
| 4 | Driving on the left | Small |
| 5 | Terrain | Medium |
| 6 | Harbour Bridge | Large |
| 7 | Looks and sounds like Sydney | Large |
| 8 | Map, teleports, cameras, HUD | Medium |
| 9 | Play, balance, budgets | Medium |

The game is playable after Phase 4. Phases 5 and 6 can each be dropped without undoing anything before them.

## Phase 1: Import and baseline

- Copy `js/`, `css/`, `tools/`, `tests/`, `public/`, `index.html`, `package.json`, `package-lock.json`, `vite.config.js` and `wrangler.jsonc`.
- Update the README, and extend `.gitignore` with `node_modules/`, `dist/`, `.wrangler/` and `recordings/` if missing.
- Rename the title, repo links, worker, offline file, `nyc-player-state`, `nyc-map.js` and `nyc-geodata.js`.
- Record `npm run bench` as the baseline.
- **Fix capture first.** Both `page.screenshot` and the screencast return a black canvas in headless on this PC, though `canvas.toDataURL` inside the frame works. `npm run play` recordings need `--headed` here, or an in-frame grab.

**Done when:** `npm test` passes, the renamed game runs, and `wrangler deploy --dry-run` passes.

## Phase 2: Data pipeline

New generators in `tools/`, replacing `build-geodata.mjs` and its `geo-*` modules, `build-buildings.py` and `build-trees.py`.

| Output | Source | Notes |
|---|---|---|
| Land and water | OSM relation `15522136` | Inner rings are the islands. Cut piers out as New York does |
| Road graph | OSM | Split at shared nodes. Drop tunnels and stacked motorways. Estimate width from lanes and class |
| Signals | OSM | Snap to the nearest junction |
| Curb blocks and lots | Rasterised roads | Reuse the method in `geo-blocks.mjs` |
| Buildings | Overture | Add a roof type and a building kind to the format |
| Trees | City of Sydney (49,618, with species and height), OSM north of the harbour | Add a species class to the format |
| Height grid | City of Sydney contours, plus a north-shore source | About 20 m cells. Size to be measured |
| Parks, piers, rail, ferry routes | OSM, NSW `FerryRoute` | |
| Awnings | City of Sydney SDCP layer | Sets which streets get footpath awnings |

Building height comes from the first of: Overture or OSM height, floors × 3.3 m, a hand table for the largest buildings, the median of nearby buildings of the same kind. The City of Sydney's "height in storeys" layer is a planning control, not a measurement, so it only caps guesses.

Raw snapshots stay out of the repo: the contours alone are 174 MB.

**Done when:** tests pin known places (Town Hall on land, Cockle Bay water, Goat Island land, the height table above within 2 m), a top-down debug map matches OSM by eye, and download stays within New York's 1.4 MB.

## Phase 3: Remove the grid and the island

This is the largest code change, and it makes Sydney playable.

- **`city-config.js`:** rewrite around `BLOCKS` and `ROADS`. `streetZ`, `avenueX`, `fromOldFrame`, `getBroadwayX` and the Manhattan tables go. Location labels come from real road names.
- **World limits:** replace `getIslandBoundsAtZ` with a land-mask lookup in `controllers.js` and `road-network.js`.
- **`road-network.js`:** delete steps 2-4, keeping the centreline path, and take lanes from OSM in `lanesOf`.
- **`city-grid.js`:** keep the deck, sidewalks, curbs and parks. Remove Central Park, Times Square, the named piers and the FDR.
- **`street-details.js`:** signal heads are placed from `ALL_AVENUES` × `ALL_STREETS` at lines 243-279. Place them at signalised junctions instead.
- **Stubs:** plain boxes for landmarks and a plain ground for the surroundings, so nothing waits on Phase 7.

**Checkpoint:** run `npm run bench` and report load time, frame rate and memory. These are the first real numbers for Sydney, and they replace the projections above.

**Done when:** Sydney boots flat with traffic and people, every road in the network is drivable, and nothing falls in the harbour.

## Phase 4: Driving on the left

- Add one `DRIVE_SIDE` constant, and apply the 5 tested edits.
- Flip indicators in `traffic.js:1352-1353`, including the lane-change case.
- Check everything that assumes a side: lane offsets, far-turn yielding, bus stops and doors, the highway lanes.
- Move the player's car to right-hand drive, and the cockpit camera to the right seat.
- Roundabouts: clockwise, giving way to the right. Keep small ones from collapsing into plain junctions.
- Road paint: white centre lines and no double yellow.

**Done when:** a play scenario measures traffic and the player's route keeping left, cars turning right wait for oncoming traffic, and `tests/traffic.test.cjs` covers the side.

## Phase 5: Terrain

- Add `js/terrain.js` with one height lookup. The simulation never calls it.
- **Static geometry:** lift it in `revealStage`. Large flat meshes need subdivision so the deck and curbs agree to within curb height, about 0.1 m. Water never lifts.
- **Buildings:** one height per building, with walls extended down to the lowest ground, so roofs stay level.
- **Moving objects:** cars at their matrix writes, people at `l.pose.value.array.set`, player meshes, the camera, street-light pools, and the shadow focus.
- **Vehicles:** pitch from the slope.
- **HUD:** altitude adds the ground height.
- **Startup:** bake subdivision into the generators or slice it, so it costs nothing before the first frame.
- **Graphics levels:** Low uses coarser ground cells.

**Checkpoint:** bench on Intel UHD and the phone profile. If terrain can't hold the budget, report it and decide whether to keep it, coarsen it, or drop it.

**Done when:** driving Oxford St and William St shows no gaps or floating curbs, and budgets hold.

## Phase 6: Harbour Bridge

- **Corridor:** a hand-picked list of OSM way ids for the deck and its ramps, both directions. Network edges on it carry their own height profile.
- **Ground:** the lookup returns the surface closest below the player, so a car under the bridge stays on the street.
- **Collision:** deck and street traffic must not collide where they cross in plan. This is the one place the flat simulation needs a layer.
- **Model:** arch, deck, pylons, with colliders and a fly-under clearance for the helicopter.
- **Elevated scenery:** Cahill and Western Distributor as models with ambient lanes, reusing `createHighwayTraffic`.

**Done when:** a play scenario drives across both ways and back into the CBD, and walks and drives underneath, with no snapping between levels.

## Phase 7: Sydney content

- **Landmarks:** Opera House and Harbour Bridge first. Then Sydney Tower, Town Hall, QVB, St Mary's, Central's clock tower, Luna Park, Customs House, Crown Sydney, Hyde Park's fountain and memorial, and Pyrmont Bridge.
- **Surroundings:** replace `boroughs.js` with the north shore, eastern suburbs, Balmain, the harbour islands, Fort Denison and the view to the Heads, with real terrain on the skyline.
- **Buildings:** sandstone, terraces with iron lace, footpath awnings. Pitched and terracotta roofs for low-rise. Fire escapes and water towers go.
- **Trees:** map City of Sydney species to a few silhouettes: fig, gum, plane, paperbark, jacaranda, palm.
- **Streets:** Australian signals, walk lights and signs, red post boxes, bus shelters. Steam stacks, hydrants and subway entrances go; train and metro entrances replace the last.
- **Moving scenery:** ferries, light rail on George St, trains on the bridge, gulls and ibis.
- **Audio:** the crossing's ticking signal, ferry horns, gulls.
- **Light:** confirm the sun tracks the northern sky in each time preset.

**Done when:** the first minute reads as Sydney, with no New York leftovers. A text search for New York names comes back clean.

## Phase 8: Map, teleports, cameras, HUD

- **Map:** rebuild the atlas on road polylines, since it can't label a grid, with a compass at 8° and search across real roads and landmarks.
- **Teleports and cameras:** new places, and new cinematic vantage points: Mrs Macquarie's Chair, Observatory Hill, Kirribilli, Milsons Point, Sydney Tower.
- **HUD:** km/h, vehicle names, location labels.

**Done when:** map search and every teleport land on a road or footpath, and `npm run viewports` is clean at all 9 sizes.

## Phase 9: Play, balance, budgets

- Rewrite `tools/play/scenarios.mjs` for Sydney, through real input only. Routes include Circular Quay to North Sydney over the bridge, a hill start, George St on foot, and Darling Harbour.
- **New checks:** keeps left, stays on the road when following a route, never below ground, no snapping on the deck.
- **Re-tune from the feel metrics.** Hills change braking and acceleration, so New York's numbers don't carry over.
- Run the 10-minute soak, watch recordings, and fix what they show.
- **Device levels:** retune `js/quality.js` for 5-year-old devices, and re-measure WebGL2 as a real target.
- Write `ai/next_0.md`.

| Budget | New York now | Sydney target |
|---|---|---|
| Time to interaction, desktop | 1.61 s | 2.5 s, as `npm run bench` enforces |
| Time to interaction, phone profile | 3.55 s | 4 s |
| 1080p on Intel UHD, default level | 30.6 FPS, 95th percentile 46.6 ms | 30 FPS, 50 ms |
| Main-thread frame, phone profile | about 21 ms | under 33 ms |
| Memory | about 1.7 GB | no more than New York |
| Download | 1.4 MB | no more than New York |

The offline file must stay under Cloudflare's 25 MiB per-file limit. It's 3.7 MB for New York.

**Done when:** all scenarios and the soak pass, `npm run bench` is within budget on the Intel laptop, and you have recordings to judge. Whether it's fun is your call from those recordings and from playing it. Deploying stays with you: `npx wrangler login`, then `npm run deploy`.

## Risks

| Risk | Why | Plan |
|---|---|---|
| Phone load time | 0.45 s of margin before terrain, and older target devices | Bake subdivision. Checkpoint in Phase 5 |
| WebGL2 on older phones | Slow when last measured | Re-measure in Phase 3, retune in Phase 9 |
| Bridge | Stacked roads are new to this engine | One corridor only. Can be dropped |
| Authored landmarks | Opera House and bridge have to look right, and are costly in shaders | Stand-ins early, detail last |
| Guessed road widths | Too narrow or too wide will show at every curb | Check against CBD streets. Hand-fix the main roads |
| Real devices | None have been tested on any of this work | Needs a real phone from you |

## Sources

- [OpenStreetMap](https://www.openstreetmap.org/copyright), via Overpass
- [Overture Maps](https://docs.overturemaps.org/attribution/), release `2026-10-21.0`
- [City of Sydney open data](https://data.cityofsydney.nsw.gov.au): Trees, Terrain contours, SDCP 2012 layers, CC BY 4.0 per its catalogue
- [NSW digital elevation model](https://data.nsw.gov.au/data/dataset/8f73f5ca-4f7f-4707-bfe2-0efbb9027107): 1-2 m LiDAR, 5 m photogrammetry, Creative Commons Attribution
- [NSW Spatial Services](https://portal.spatial.nsw.gov.au/server/rest/services): elevation and transport themes
- [Sydney Harbour Bridge](https://en.wikipedia.org/wiki/Sydney_Harbour_Bridge) and [Structurae](https://structurae.net/en/structures/sydney-harbour-bridge): bridge dimensions
- New York repo: `ai/plan_0.md`, `ai/next_0.md`, `ai/study_map_size.md`
