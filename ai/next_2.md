# Next 2: what shipped from plan 2, and what to do next

Answers `ai/plan_2.md`. **Phases 1-12 of 17 are done, with the misses listed below. Phases 13-17 aren't started.** The work stopped here on purpose: the plan makes Phase 12 the gate, with a real phone test before anything gets bigger, and that test needs you.

Today's map now comes in tiles and streams around the player, so the hard part of a bigger map is done. Nothing is bigger yet.

## What you need to do

1. Commit when you're happy. Nothing is committed or staged. `public/tiles/` is new and needs committing (2 MB), and the old `js/*-geodata.*`, `js/height-grid.bin.gz` and `js/road-tags.js` are deleted. Their sources now live in `tools/data/generated/`, which git ignores, so `npm run data:build` remakes them.
2. `npm run deploy`, which needs HTTPS for a phone to use WebGPU. A plain `http://` address on your network falls back to WebGL2. Deploying also tests the cache rules below, which can't be tested locally.
3. Open `https://<your site>/?stats=1` on an entry-level phone and tell me:
   - "loaded in" (Spec: 2-3 s, 4 s at most)
   - FPS while driving and flying across the map (fly to cross tiles fastest)
   - whether the tab ever crashes or reloads

If those hold, Phases 13-16 go ahead. If they don't, that work comes first.

## Results

Measured on an i5-11400F with an RTX 3060, Chrome 156, cold profile, local server. **No real phone or integrated GPU has been tested.** The phone profile is a desktop with the CPU slowed 4 times and a 50 Mbit/s connection, and the GPU isn't slowed at all, so it flatters a real phone.

The test harness now warms the browser up before opening the game (see Findings), which takes GPU process start-up out of the load times. Part of the load gains below may come from that. A real player's browser is already running, so the new numbers should be closer to theirs, but the two aren't strictly comparable.

| Measure | Plan 1 ended at | Before tiles (Phase 10) | Now | Target | |
|---|---|---|---|---|---|
| Load, phone profile | 3.93 s | 3.99 s | **3.23 s** | 3.5 s | Met |
| Load, desktop at High | 2.37 s | 2.62 s | **2.24 s** | 2 s | **Missed** |
| Load, desktop at Low | | | 1.44 s | | |
| First download, phone | 1,450 KB | 1,517 KB | **651 KB** | 1 MB | Met |
| First download, desktop at High | | 1,469 KB | **745 KB** | 1 MB | Met |
| City finished after load, phone profile | 38.5 s | 43.5 s | **19.2 s** | | |
| City finished after load, desktop | 11.8 s | 13.6 s | **9.5 s** | | |
| Frames at rest, phone profile | 36.2 FPS, p95 33.7 ms | 37.5 FPS, p95 33.7 ms | **42.4 FPS, p95 33.4 ms** | No worse | Met |
| Frames while streaming, phone profile | | | **52 FPS, p95 33.4 ms**, p99 50 ms, worst 217 ms | p95 33.7 ms | Met |
| Draw calls, desktop at High | 1,110 | 883 | **774** | 740 | **Missed** |
| Triangles, desktop at High | 2.9M | 2.5M | **2.3M** | About 1.9M | **Missed** |
| Heap over repeated crossings of the map | | | **425, 422, 424 MB** | Flat | Met |
| GPU geometries over the same crossings | | | **1582, 1582, 1582** | Flat | Met |
| Worst wait for the ground after a teleport | | | 674-1,188 ms, laptop profile. Not measured on the phone profile | | |
| Tile under the player not drawn yet, flying at 52 m/s | | | **0 of 22 samples** | | |
| Walls with ground over their first window row | 25% over 1 m | | **0 of 702,058 samples** | 0 | Met |
| Full test run | 39.8 min | 20.4 min | **21.4 min** | 20 min | **Slightly over** |
| Check on every change | | | 8 s | | |
| Offline file | 4.21 MB | | 4.2 MB | 25 MiB | Met |

Scenarios on the final code: **28 of 28 in 21.4 min**, with no reruns and a 5-minute soak. Two longer soaks ran on builds just before the last small fixes. In the 30-minute one, memory stayed flat, and all it flagged was a watchdog false alarm, since fixed. The 12-minute one flagged open item 4, so a longer soak can still fail on that.

### Phase 11's size targets

| | Target | Now | |
|---|---|---|---|
| All the map's data | No larger than today's 1,219 KB | **1,330 KB**: tiles 1,198, far land 91, world 20, coarse ground 22 | **Missed by 9%** |
| `world.json` | Under 30 KB | **51 KB, 20 KB on the wire** | **Missed, if the target meant the raw file.** Its largest part is the shores, which move into tiles in Phase 15 |
| One-tile rebuild | Under a minute | The whole set in 2 s | Met |

A road crossing tiles is repeated in each one, which is most of the extra 9%. New on top of that, and only fetched when needed: far files 270 KB, map screen 326 KB. A player who visits everything downloads about 1.9 MB, against 1.2 MB before. A player who doesn't, downloads much less.

### Cloudflare's free plan

79 files, 8 MB. `tools/check-dist.mjs` fails at 18,000 files or any file over 25 MiB, and runs on every check and deploy. The rules in `public/_headers` overlap, and I used Cloudflare's documented `! Cache-Control` to separate them. **That can't be tested locally: after deploying, check the headers on a tile and on `tiles/far-heights.bin.gz`.**

## What changed for the prompt

| Prompt item | Phase | Result |
|---|---|---|
| Faster tests | 1 | Tiers: `npm run check` 8 s, `npm run play` about 5 min, `--full` about 22 min. Video is opt-in |
| Buildings on the height plane | 2 | Floors at the highest ground along the walls, stone below, no window cut by the ground |
| Street signs | 3 | Real names at each junction. Shop names no longer say New York |
| Modes carry over | 4 | Walk to the nearest footpath, drive to the nearest lane, cycle to whichever is nearer, fly straight up above most roofs within 200 m. On a bridge or in a tunnel, nearest means on that level |
| Company names | 5 | `MAN & BOT` on Salesforce Tower, `MAIZE.LIVE` on Governor Phillip Tower |
| References | 6 | `ref/frames/`, `ref/locations.md`, side-by-side pictures from `tools/play/compare.mjs` |
| Buildings and roads from references | 7-9 | Building parts, real awnings, towers at their real heights, Opera House and Harbour Bridge reworked, road paint and signs from OpenStreetMap tags |
| Biggest map, three building models | 10-12 | Tiles, streaming and outlines done, on today's area. **Whole of Sydney and walk-in buildings not started: Phases 13-16** |

## How it streams

The README's "How it works" has this in full.

- **`js/geodata.js` holds the tiles near the player** and tells every index of the map as they come and go (`onMap()`). Under Node the whole map is held, so tools and tests didn't have to change much.
- **Ground, buildings and colliders are built and dropped per tile.** The range is 1 km at Low, 1.5 km at Medium and 2 km at High. The plan said 1.5 km and 2.5 km, and I used less because it costs less to draw.
- **Street furniture and trees rebuild as a set** after moving 400-1,000 m, and **traffic gets a new network** within 1 km of the player about every 400 m. Cars and people carry over (the last run: 51 cars kept, none lost).
- **Beyond the tiles, a far level** draws every building as up to 6 points (12 for towers), for a few draws per 4 km.

### Where this differs from the plan

| Plan | Did | Why |
|---|---|---|
| Worker for fetching and triangulating (`tile-worker.js`) | No worker for tiles. Sounds got one | Frames met the target without one. Revisit on a real phone |
| `tools/tiles/` worker pool per tile, with a margin | One script cutting the generated whole map, in 2 s | Not needed at this size. **Phase 15 needs it**: the generators still work on the whole map, which won't scale |
| Outlines swapped per 1 km | One mesh per 4 km, leaving out tiles drawn in full | Fewer draws, and it scales to all of Sydney |
| Road network grows and shrinks | Rebuilt around the player and swapped | Much less risk to 1,000 lines of road logic |
| Map screen as image pyramid | Whole-map file on first open, 326 KB | Enough for today's map. **Phase 15 needs the pyramid** |
| Soak: a 30-minute drive across the map and back | 30 minutes of the existing mixed soak, plus 3 scripted crossings | Covers memory, but it isn't a continuous drive |

## Findings worth knowing

- **Three.js keeps every mesh ever drawn, through its material,** unless the mesh fires a `dispose` event, which a plain `Mesh` never does. With materials shared across tiles this leaked about 205 MB per crossing. `disposeStage()` handles it, and anything removed some other way will leak again.
- **Traffic had a real deadlock.** Merging ordered cars by position within a road but by waiting time across roads, so three cars could each yield to the next forever. One ramp at the north end of the Harbour Bridge did this, and it held up North Sydney and the deck behind it: 108 of 113 deck cars were stopped with no player near. This may well be the "why deck traffic is so slow" item from `ai/next_1.md`, though I only fixed it and didn't compare speeds on the deck.
- **The road network dropped anything leaving its area.** It keeps only what's strongly connected, so a bridge or motorway running off the edge counted as a dead end. The rim now counts as open, which is what brings traffic to corridors.
- **Sound synthesis froze the game for 2.5 s on the phone profile** at the player's first touch. That was already there before tiles. It now runs on a worker, so the game can be silent for the first moment instead.
- **A module reading the map as it loads sees nothing,** since no tile is held yet. `js/bridge.js` did that, which broke the deck's heights in the browser while every Node test passed.
- **A freshly started browser kills WebGL contexts made in about its first 300 ms.** It's deterministic here: 3 of 3 lost at 100 ms or less, none at 400 ms or more. It was exposed by loading faster. The harness now warms up first. A player launching Chrome straight into the game's URL could in principle hit it and see the "graphics lost" dialog. Faster loading caused this one, and it's unconfirmed outside headless Chrome.
- **Auto picks a level from the GPU's reported vendor, and on this machine it can change between runs.** The first open in a fresh browser got Low and the next two got High. **Benchmarks without `--query=quality=` may not compare**, which nearly had me report a false gain.
- **Facade floors were measured from sea level,** so 97% of buildings had no ground floor. Level floors on slopes, and signal lenses all acting as red on hills, had the same cause.

## What isn't right yet

Most important first.

1. **Never run on a real phone.** See the top. Every phone number here comes from a slowed desktop with a fast GPU.
2. **Firefox and Safari not tested on this work.** WebGL2 is tested by hiding WebGPU in Chrome, and that scenario passes. `npm run bench -- --browser=firefox` is still to do, as is `npm run viewports`.
3. **Traffic can still hold itself up at merges.** I fixed one cause and capped traffic by how much road is nearby, but cars can still wait on each other through the lane-straddling logic. As a safety valve, a car stuck over 45 s out of sight, or 180 s in sight, gets recycled. Near North Sydney, 43-79 of 132 cars are still stopped at any moment, at a mean of 2.5-4.4 m/s. It's busy but moving, and it's slower than it should be. `__gameDebug.trafficDetail()` says what holds each car.
4. **A car wedged against a wall,** once in about 70 minutes of soak, at (384, -1130) on Macquarie St. The random driver had steered it onto the footpath against a building. It could be a real trap or just the script, and I didn't determine which.
5. **Load at High misses 2 s** by 0.24 s, mostly the first frame's shadow shaders (1.04 s). Deferring them would only move the stall to just after the load, so I left it. It's within your Spec's 2-3 s.
6. **Draws and triangles miss the targets at High** (774 vs 740, 2.3M vs 1.9M). Street furniture is the largest share, not buildings. Phone profile: 298 draws.
7. **Far level has no shoreline detail** (100 m cells, with the shore cut at cell edges), and towers are plain prisms beyond the tile range. I haven't looked at it from the air on a long flight, so **plan 2's "no visible popping" isn't verified.**
8. **Small leftovers from Phases 8 and 9:** STOP plates and push-button detail only partly done, and I haven't looked at the bridge at night since its lights changed.
9. **Still open from `ai/next_1.md`:** wheel contacts for bus, bicycle and traffic, ground targets still missed (wheels 3.25% over 3 cm, kerbs 0.45% open, 18 crossings under 6.8 m), and the pale band in the William St tube.

## What to do next

1. **The real phone test.** Everything else waits on it, as the plan says.
2. **Phase 13, moving origin and horizon.** Katoomba is 84 km out, where 32-bit positions shake. Vertices need to be stored relative to each stage, and the 64 `positionWorld` uses need to keep their patterns when the origin moves. Far levels replace `surroundings.js`.
3. **Phase 14, detailed buildings.** It's independent of the rest, so it could come first if you have a model ready.
4. **Phase 15, Inner Sydney.** The largest step left: generators per tile with a worker pool, the 1.2 GB OSM extract, the 5 m elevation model, per-tile land and water in place of `world.json`'s shores, trees beyond the City of Sydney's register, and the map's image pyramid.
5. **Phase 16, all of Sydney,** then **Phase 17** to close out.

I'd look at open item 3 before Phase 15. Suburbs have more merges and fewer alternatives, so the traffic could get worse there.
