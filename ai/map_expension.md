# Map expansion: out to Katoomba

Asked for in `ai/prompt_4.md`, and postponed there to a later iteration. This replaces Phase 16b of `ai/plan_3.md`. Nothing here is built yet. Plan 4 does two things this depends on: it moves the tiles into folders (Phase B), and it takes population and land use into the map (Phase H).

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

## Sizes

These are scaled from today's map. Only a build gives real numbers.

| | Today | To Katoomba | Limit |
|---|---|---|---|
| Area with tiles | 1,980 km² | About 4,400 km² | |
| Tiles | 1,811 | About 4,000 | |
| Buildings | 664,872 | About 1.1 million (plan 3 counted 1,191,029 in the whole box) | |
| `public/tiles/` | 66 MB | About 140 MB | |
| Map images | 2,004, 12 MB | About 4,500, 27 MB | |
| Files in the deploy | 3,983 | About 9,500 | 20,000, and `check-dist` fails at 18,000 |
| Largest file | 10.6 MB | About the same | 25 MiB |
| Tile list in `world.json` | 39 KB, 16.6 KB zipped | About 90 KB, 37 KB zipped | Under 30 KB zipped for the whole file |
| Map build | 31 min, plus 2 for the images | 1.5 h or more, if the one-job steps hold | |

**Downloads:** the OSM Australia extract is already here. Overture adds about 350 MB and NSW's 5 m elevation about 1.5-2 GB, and the generated files get bigger too. **Allow 10 GB more.** This disk has plenty.

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

**Done when** `world.json` is under 30 KB zipped on today's map, load time doesn't change, and every scenario passes.

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
| Phone memory | A tab reload on your iPhone in plan 4's test, flying north | Plan 4 Phase F sets a memory budget. Katoomba waits for it |
| Load time | More in `world.json`, more far files | K1 keeps `world.json` small. The first view's download stays under 1 MB |
| Build time over 1.5 h | Raster work scales with area | Regions run in parallel already. Skipping national park helps |
| GitHub folders | About 4,000 tiles | Plan 4 Phase B: folders of 64 tiles at most |

## What I need from you

1. **Say when to start.** After plan 4, and its phone stop.
2. **Disk:** 10 GB more. Say if that's a problem.
3. **Committing the tiles:** about 140 MB at Katoomba. As before, I'd commit them only at the stops.
