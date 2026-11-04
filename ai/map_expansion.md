# Map expansion: out to Katoomba

Asked for in `ai/prompt_4.md`, and postponed there to a later iteration. This replaces Phase 16b of `ai/plan_3.md`. Nothing here is built yet. Plan 4 did two things this depends on: it moved the tiles into folders (Phase B), and it took population and land use into the map (Phase G).

## Short answers

**The map would grow from 1,980 km² to about 4,400 km², not 5,900.** The box to Katoomba runs from x = -88 km to 10 km, and z = -35 km to 25 km. West of the Nepean, most of it is national park with no roads or buildings. The plan is to make a tile only where something's there, and draw the rest from the far level and the horizon. That leaves the Cumberland Plain whole, and a strip about 18 km wide up the mountains along the Great Western Highway and the railway.

| Place | x, z (km) | |
|---|---|---|
| Parramatta | -19.6, -3.8 | Today's western edge is at -23 |
| Prospect Reservoir | -29.6, -2.0 | Water above sea level |
| Blacktown | -29.1, -7.3 | |
| Penrith | -48.8, -6.8 | The Nepean, also above sea level |
| Glenbrook | -55.2, -4.0 | Up Lapstone Hill |
| Springwood | -61.6, -10.8 | |
| Katoomba | -84.5, -6.2 | About 1,000 m up |
| Echo Point | -84.2, -4.0 | Cliffs about 300 m high, to the Jamison Valley |

**What it needs that today's map doesn't have:**

1. Water at its own level.
2. Cliffs.
3. Bush.
4. Tiles kept out of national park.
5. A tile list that isn't all in `world.json`.
6. Road and height generators that hold up at more than twice the area.

**It's about twice today's map in files and bytes,** and fits Cloudflare's free plan. The rest of this file gives the numbers.

**The browser hardly notices.** The game holds only the tiles and far squares near you, so a bigger map doesn't make a frame heavier or the phone hold more. The first view downloads about 60 KB more. The costs land elsewhere:

- **Git history:** about 140 MB more each time a full rebuild is committed.
- **The build on this PC:** about 1.5 h, and its memory isn't measured yet.
- **The map screen:** holds every road once it's opened, about 35 MB at Katoomba.
- **The work itself:** phases K1-K6.

## Sizes

"Today" is the map at `ai/next_4.md`, measured on 5 November 2026. The Katoomba column is scaled from it by area. Only a build gives real numbers.

| | Today | To Katoomba | Limit |
|---|---|---|---|
| Area with tiles | 1,980 km² | About 4,400 km² | |
| Tiles | 1,811 | About 4,000 | |
| Buildings | 664,872 | About 1.1 million (plan 3 counted 1,191,029 in the whole box) | |
| `public/tiles/` | 65 MB | About 140 MB | |
| Map images | 2,005, 12 MB | About 4,500, 27 MB | |
| Biggest folder | `tiles/far/` 133 files, `map/8/` 135 | About 300 each | GitHub lists 1,000 files in a folder |
| Files in the deploy | 3,983 | About 9,500 | 20,000, and `check-dist` fails at 18,000 |
| Largest file | 11.2 MB, `sydney.html` | The same: the offline file holds only the CBD | 25 MiB |
| `world.json` | 67 KB, 28 KB zipped, of which the tile list is 39 KB | About 125 KB, 55 KB zipped, without K1 | Under 30 KB zipped |
| Git history | 230 MB after 23 commits, 212 MB of it tiles | About 140 MB more for each full rebuild committed | GitHub recommends under 1 GB, and strongly under 5 GB |
| Map build | 31 min, plus 2 for the images | 1.5 h or more, if the one-job steps hold | |
| Generated build files | 1 GB. `land.bin` and `walls.bin`, 1 m rasters over the box, are 334 MB each | About 2.5 GB, the rasters about 900 MB each | |

**Downloads:** the OSM Australia extract is already here. Overture adds about 350 MB and NSW's 5 m elevation about 1.5-2 GB, and the generated files get bigger too. **Allow 10 GB more.** This disk has plenty: 1.5 TB free.

**Git history grows fastest.** The tiles are zipped, so git can't shrink them, and a rebuild changes nearly every tile: each of plan 4's two commits rewrote about 3,900 tile files. Today a committed rebuild adds about 65 MB to the history, and at Katoomba about 140 MB. Five of those take the repo past 1 GB.

## In the browser

What the game holds and draws follows what's around you, not how big the map is. A few files cover the whole map, and those grow.

| | Today | To Katoomba |
|---|---|---|
| **The first view's download** | 699 KB | About 760 KB, under 1 MB |
| `world.json`, zipped | 28 KB | About 55 KB, or under today's with K1 |
| `far-heights.bin.gz` | 17 KB | About 45 KB |
| `horizon.bin.gz` | 57 KB | **No change.** It already covers the whole box to Katoomba (`WHOLE_BOX` in `tools/fetch-elevation.mjs`) |
| **Memory near you,** at Low | 153 MB on your iPhone, under the 170 MB budget | No more. The budget pulls the far level back, and the mountains have fewer buildings |
| The road graph's node array | 0.7 MB, 89,961 nodes | About 1.5 MB |
| **The map screen,** once opened | 830 KB to download. Every road on the map held, 16 MB | About 1.8 MB, and about 35 MB held |
| **Frames** | 60 FPS on your iPhone at Low, in the CBD | The CBD stays the heaviest place |

- **Load:** the extra 60 KB is 10-50 ms on a phone's connection. The 0.83 s load on your iPhone stays under a second.
- **The map screen's roads aren't in the game's own count** (`countMemory()` in `js/main.js` counts the tiles held), so the memory budget doesn't see them. That's 10% of Low's 170 MB today, and about 20% at Katoomba.
- **What's new to the frame, and not yet measured:**
  - Views 20-30 km across the valleys from the escarpment, drawn by the far level and the horizon.
  - Bush scattered near the camera.
  - The finer grid on cliffs.
  - The scene's origin 85 km out, which has never had real tiles to test it.

  K6 measures each on the phone.

## Decisions

Say so if you want any of these changed.

1. **Tiles only where there's something.** A 1 km square with no road, building or water from OSM gets no tile. The far level's ground and the horizon draw it, with bush scattered near the camera. That's most of the Blue Mountains National Park.
2. **Tile hashes move out of `world.json` into one small index per 8 km folder.** Plan 4's Phase B already puts the tiles in folders by 8 km. `world.json` keeps a list of folders, and carries the index of the folder you start in, so the first view waits on no extra request. The other indexes are under 1 KB each and are fetched well ahead of need.
3. **Water has a level of its own.** Reservoirs, lakes, ponds and weir pools are flat sheets at their own height, each from the elevation model along its shore. The sea and the tidal rivers keep the one sheet at sea level. That also fixes Centennial Park's ponds and Manly Dam, which are land today.
4. **Cliffs get a finer grid where it's steep.** Today's ground grid blurs a 300 m drop into a slope a cell wide. Tiles with very steep ground get a 5 m grid, and slopes past about 50° are drawn as sandstone rock face, not grass. Echo Point and the Three Sisters are the test.
5. **Bush is a colour and a scatter, with no tree stored.** Bushland gets a eucalypt grey-green on the ground and the horizon. Near the camera, trees are placed from a hash of where they stand, so a hillside of forest costs nothing to download.
6. **Roads and heights stay one job if they fit, and go by region if they don't.** Measure first: today's peak memory for `build-heights.mjs` at 1,850 km². If it's over about 40% of the 20 GB heap, solve road shapes by region with heights fixed at the seams, as the raster work already does. Structures are solved as whole connected groups either way.
7. **The scene's origin was built for this** (`js/world-origin.js`, plan 3 Phase 13). This is its real test, 85 km out.

## Phases

| Phase | Result | Size |
|---|---|---|
| K1 | Tile indexes per folder, tiles only where there's something | Small-Medium |
| K2 | Water at its own level, on today's map first | Medium |
| K3 | Measure the generators, and go by region if needed | Medium, uncertain |
| K4 | Data and build out to Katoomba | Large |
| K5 | Cliffs and bush | Medium |
| K6 | Play, budgets, and a stop for your phone | Medium |

### K1: Tile indexes, and tiles only where there's something

- `world.json` lists folders with a hash each. Each folder's `index.json` lists its tiles and their hashes.
- The game fetches the index of any folder within about 10 km, so a tile is never waited on for its index. The start folder's index comes inside `world.json`.
- `build-tiles.mjs` skips empty squares. The far level and the map screen know where those are.

**Done when** `world.json` is under 15 KB zipped on today's map (28 KB now), load time doesn't change, and every scenario passes.

### K2: Water at its own level

On today's map first, where Centennial Park, Lake Parramatta and Manly Dam are.

- Water polygons from OSM, each with a level: the lowest point of the elevation model around its shore, smoothed.
- Drawn as flat meshes in the tiles, with the same material as the sea. The water test that stops cars (`clearOfWater` in `js/surfaces.js`) reads the level, not sea level.
- A river that falls, like the Nepean between weirs, gets one level per pool.

**Done when** Centennial Park's ponds are water, cars still can't drive into any water, and no road or bridge is under a water sheet.

### K3: Measure the generators

- Peak memory and time of each `data:build` step on today's map.
- If roads and heights won't fit at 4,400 km², solve them by region with a margin and fixed seams. The test, as before: today's map is reproduced, and every check is no worse.

### K4: Data and build

- Cut OSM to the new box. Fetch Overture and the 5 m elevation for it, and ABS population and land use if Plan 4 hasn't covered it.
- Build. Expect what today's map didn't have: long rural roads, steep winding grades up Lapstone Hill and through the mountains, rail cuttings and tunnels, and towns strung along one highway.
- Teleports: Penrith, Glenbrook, Springwood, Katoomba and Echo Point.
- Suburbs and traffic come from Plan 4's population and land-use rules. The mountains have little of either.

### K5: Cliffs and bush

As decisions 4 and 5. Compare Echo Point with photos of the Three Sisters from the lookout, and with a flight along the escarpment.

### K6: Play, budgets, stop

- **Long drive:** CBD to Katoomba along the M4 and the Great Western Highway, about 100 km, on the fast clock, with restarts recorded by place.
- **Flight:** the length of the map and back. Memory must stay flat, in Chrome's phone profile and in WebKit, Safari's engine (plan 4 adds it to the test tools).
- check-roads and check-ground in at least 98% of tiles. Load and the first view's download as today.
- **Stop:** your phone test, driving up to Katoomba and flying over Echo Point, with `?stats=1`.

## Risks

| Risk | Why | Plan |
|---|---|---|
| Roads and heights don't fit in one job | 2.2 times today's area, and today's peak isn't measured | K3 measures first, and goes by region if needed |
| Cliffs look wrong | A grid is wrong for a vertical face | A finer grid where it's steep, and rock by slope. Report how Echo Point looks |
| Phone memory | A tab reload on your iPhone in plan 4's test, flying north | Plan 4 Phase F's budget (170 MB at Low) pulls the far level back. Stop 1 held 153 MB with no reload |
| Map screen memory | It holds every road once opened: 16 MB today, about 35 MB at Katoomba, outside the budget's count | Draw it from its images when zoomed out, and hold roads by folder as the tiles are |
| Load time | More in `world.json`, more far files | K1 keeps `world.json` small. The first view's download stays under 1 MB |
| Build time over 1.5 h | Raster work scales with area | Regions run in parallel already. Skipping national park helps |
| GitHub folders | About 4,000 tiles | Plan 4 Phase B: folders of 64 tiles at most. The far files and `map/8/` reach about 300 in one folder, under GitHub's 1,000 |
| Git history | About 140 MB for each full rebuild committed, past 1 GB after five | Commit tiles only at stops, or keep them out of git and deploy from this PC's build |

## What I need from you

1. **Say when to start.** After plan 4, and its phone stop.
2. **Disk:** 10 GB more. Say if that's a problem.
3. **Committing the tiles:** about 140 MB at Katoomba, and each full rebuild you commit adds that much to git's history. As before, I'd commit them only at the stops. If the history gets near 1 GB, the other way is to keep the tiles out of git. Deploys already go from this PC's `public/tiles/`, so they'd work as now. A fresh clone, though, would need the 1.5 h build before it could run the game.
