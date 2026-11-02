# Sydney

Explore Sydney in the browser, on the real map of the city: drive over the Harbour Bridge, walk the CBD, cycle the foreshore
or fly around the Opera House.

A remake of [Slop New York](https://github.com/mrdoob/slop-newyork) on Sydney's streets, hills and harbour, built with
[three.js](https://threejs.org/), WebGPURenderer and TSL.

## Setup and run

```bash
npm install
npm run dev
```

## Build and preview

```bash
npm run build
npm run preview
```

`npm run build` makes the site in `dist/`, plus `dist/sydney.html`: the game as one file to play offline, with the CBD and around it in it.

## Test

Which test when:

| Command | Time | When |
|---|---|---|
| `npm run check` | About 40 s | Every change: unit tests, build, ground, how the roads drive, how traffic moves, deploy size, on the 80 km² around the CBD |
| `npm run check -- --full` | About 5 min | When the map changes: the same over the whole map, and how many tiles pass |
| `npm run play` | About 5 min | Before saying something works: the key scenarios, no video |
| `npm run play -- --changed` | Varies | After a larger change: the scenarios `git diff` says it can affect |
| `npm run play -- --full` | About 12 min | At the end of a phase: everything but the soak, a few browsers at a time, long drives on the fast clock |
| `npm run play -- --only=soak --soak=10` | 15 min | Before a stopping point or a deploy |
| `npm run bench` | A few min | When load time or frames could have moved: fails over budget |
| `npm run viewports` | About 1 min | When the HUD changes: overflow and overlap at phone, tablet and desktop sizes |

The play, bench and viewports tools use the build in `dist/` and your installed Chrome. `npm run play` works from a copy of the
build made as it starts, so it can run in the background while you carry on and rebuild; `code.txt` in its folder says what it
tested. A failed scenario runs again with the same seed and with video, so a failure that repeats has a recording. Only the
last three runs stay in `recordings/`; put a file called `KEEP` in a run's folder to hold on to it.

Play options: `--only=first-minute,harbour-bridge --video --fast --realtime --repeat=3 --no-rerun --headed --soak=10
--seed=6 --gap=3 --jobs=3 --tiles=0_-2,1_-2`. `--fast` steps the simulation as fast as it can instead of in real time, about 7
times quicker on the long drives; scenarios that measure frames stay in real time. Those, and the ones that need a clean GPU,
run one at a time after the rest (`ALONE` in `tools/play/run.mjs`).

Two checks need no browser. `node tools/check-roads.mjs [--list] [--tiles=0_-2,1_-2]` walks every lane of every road by the
game's own rules and says what would slant, jolt or stop a car: lean, change of grade, steps, roll, dead stops, buildings and
kerbs in lanes, paving over roads. `node tools/check-traffic.mjs [--seeds=3] [--at=northSydney,townHall,bridgeDeck]` runs the
real traffic about 50 times faster than real time with a seeded random number generator, and says how much is stopped, how
fast the rest moves, what's holding each queue up, how long a car waits at a red and how often nobody is using the green.
Bench options: `npm run bench -- --profile=desktop --runs=3 --query=quality=low --headed`.

`node tools/play/stream-bench.mjs --profile=phone` measures frames while the map streams, flying its length and back. Add
`?stats=1` to the URL to see load time, frames and memory on screen, for trying it on a phone. `?wholeCity=1` with `?debug=1`
holds all of the map, for scenarios about the roads rather than about fetching them.

`node tools/check-ground.mjs [--tiles=0_-2,1_-2]` measures the ground, `node tools/play/look.mjs out-dir
name:x,z,heading,mode,climbSeconds` saves what the game shows from any place (`--spots` for the stacks, tunnels and bridge
ends in `tools/play/spots.mjs`), `node tools/play/flicker.mjs out-dir` holds views still and maps the pixels that flicker,
and `node tools/debug-map.mjs out.png` draws the map data from above. Add `--browser=firefox` to the play, bench, look and
flicker tools for the WebGL2 path.

## Deploy

```bash
npx wrangler login
npm run deploy
```

Cloudflare Workers serves `dist/` as a static site, on the free plan: 20,000 files per version, 25 MiB per file, and static
files are free however often they're requested. `tools/check-dist.mjs` holds the site inside that. It has to stay static:
a Worker script's requests count against 100,000 a day. Per-version preview URLs are off in `wrangler.jsonc`.

## Map data

The map ships as 1 km tiles in `public/tiles/`, each file named for a hash of its contents, so a tile that hasn't changed stays
in players' caches. It covers Inner Sydney: Burwood to Bondi, Manly to the airport. To rebuild it, download the raw snapshots to
`tools/data/` (they are too large to keep in the repository) and run the generators. Allow about 3 GB of disk for the downloads:

```bash
npm run data:fetch                                     # the original snapshots, from Overpass and open data sites
curl -L -o tools/data/osm/sydney-bbbike.osm.pbf https://download.bbbike.org/osm/bbbike/Sydney/Sydney.osm.pbf
node tools/extract-osm.mjs 151.0238,-34.0233,151.3701,-33.7114 tools/data/inner   # cuts the roads, land and rail out of it
SYDNEY_DATA=tools/data/inner SYDNEY_BOX='-34.0233,151.0238,-33.7114,151.3701' node tools/fetch-data.mjs overture_syd,overture_parts
node tools/fetch-data.mjs overture_density             # for the horizon: 90 s
node tools/fetch-elevation.mjs --cell=100              # for the horizon: 4 min
node tools/fetch-elevation.mjs --cell=5 --box=151.0238,-34.0233,151.3701,-33.7114   # 325 MB, 5 min
npm run data:build                                     # 12 min, about 9 GB of memory at most
```

The generators write the whole map to `tools/data/generated/`, and `tools/build-tiles.mjs` cuts it up. `tools/geo-common.mjs` sets the
world frame and the play area; `SYDNEY_AREA=today` makes the old CBD map instead, for checking a generator still makes what it did.

| File | Holds | Fetched |
|---|---|---|
| `tiles/world.json` | What the whole map shares: tile list, shores, structures, the bridge's deck | At start |
| `tiles/far-heights.bin.gz` | The ground on a coarse grid, for where no tile is held | At start |
| `tiles/<x>_<z>.<hash>.bin.gz` | A tile: roads with their shapes, kerbs, buildings, trees, heights, and a 5 m grid of how far the ground moves to meet the roads | When the player's near |
| `tiles/far_<x>_<z>.<hash>.bin.gz` | 4 km of the far level: every building as a few points, plain ground, main roads | After the first frame |
| `tiles/far.json.gz` | Land beyond the map, and the streets around the Harbour Bridge | After the first frame |
| `tiles/horizon.bin.gz` | The whole box out to Katoomba, coarsely | After the first frame |
| `tiles/map.json.gz` | All the roads and blocks, for the map screen | When the map is first opened |

## How it works

- **The simulation is flat, on surfaces.** Colliders, traffic and people move in (x, z), each on a surface: the ground, or a
  structure with heights of its own (`js/surfaces.js`). Sydney's 50 m of relief and the road levels are added where things
  are drawn, so ground meshes are built on the hills and moving things are lifted as their transforms are written. Keep
  any new code on the flat side of that line.
- **Every road has a height.** `tools/build-heights.mjs` solves bridges, viaducts, tunnels, cuttings and motorways so that
  stacked roads clear each other, and writes the profiles into the generated map. `js/structures.js` draws what's off the
  ground. A surface changes only across a step of 1.5 m or less: anything bigger is a parapet or a tunnel wall, so cars at
  the same (x, z) on different levels never meet. Something on a structure stays on it until it ends.
- **Every road on the ground has a shape.** Draped over the land, a road across a hillside leans with it. Instead each road's
  height is solved along it, smooth and near the land, shared at junctions and with any road overlapping it, with no more than
  4% of lean across it. A junction is a flat tilted plate where one fits. `roadHeight()` in `js/surfaces.js` is the one
  surface everything reads.
- **The ground follows the roads, not the other way round.** Each tile has a 5 m grid of how far the ground moves to meet them
  (`tools/tiles/grade-ground.mjs`). Footpaths, kerbs, lawns, trees, floors and people all stand on the result.
- **Each junction runs its own lights,** by who's there, the player and people waiting to cross included (`js/signals.js`).
  Junctions close together, like a divided road's two halves, share one set. Heads read their state from a small texture.
- **The Harbour Bridge is one of those structures,** with its heights from a table of the real deck (`js/bridge.js`).
- **The scene is drawn near zero.** The simulation and the map are in the game's own frame, however far out, but a shader only ever sees
  small numbers: `scene` itself moves by whole steps of 4,096 m as you go (`js/world-origin.js`), and every mesh keeps its vertices around
  its own middle. A pattern in a shader reads `patternXZ`, which wraps at the same 4,096 m, so a move changes nothing on screen.
- **The horizon** is one small file for the whole box to Katoomba (`tools/build-horizon.mjs`, `js/horizon.js`): hills and the coast from a
  100 m elevation download, how built up each place is, and the tallest towers. It's never more than about a hundred thousand triangles.
- **The ground is one height everywhere.** Footpaths, lawns and kerbs all sample `groundHeight()`, which is the road's surface
  on a road, and `node tools/check-ground.mjs` measures how well they agree: wheels against the road, kerbs against what's
  either side of them, roads at crossings, and steps in the height grid.
- **There is no street grid.** Every street comes from the centreline graph (`js/road-network.js`). `DRIVE_SIDE` in
  `js/city-config.js` sets which side traffic keeps to.
- **The game must be playable within 4 seconds,** so only the ground and buildings around the player are built before the
  loading screen drops, from only the tiles under them. The rest builds a few milliseconds per frame while you play
  (`buildRestOfWorld` in `js/main.js`, `js/world-jobs.js`).
- **The map comes and goes around the player.** `js/geodata.js` holds the tiles near them, and tells every index of the map as
  they arrive and leave (`onMap()`). A module must never read the map as it loads, since nothing's held yet: what the whole map
  has to know is worked out when the tiles are made (`tools/tiles/derive.mjs`) and read from `world.json`. Under Node, for tools
  and tests, the whole map is held from the start.
- **Three speeds of streaming.** Ground, buildings and colliders are built and dropped by the tile (`buildTile` and `dropTile` in
  `js/main.js`, what's wanted from `js/tiles/tile-manager.js`). Street furniture and trees are rebuilt as a set when the player
  has moved far enough, in the same places, so nothing near appears to change. Traffic gets a new road network around the
  player every few hundred metres, and everyone on it carries on (`setNetwork` in `js/traffic.js`). Beyond the tiles,
  `js/far-level.js` draws every building as a few points.
- **A stage's meshes must let three.js forget them.** Materials are shared by every tile so a new tile compiles nothing, and
  three.js keeps a record of each mesh through its material. `disposeStage()` in `js/main.js` fires the event that lets go of it;
  anything removed without that stays in memory for good.

Graphics levels live in `js/quality.js`. Auto picks one from the device and steps down if frames run slow. Add `?quality=low`,
`medium` or `high` to the URL to force one, or choose in the pause menu.

## Building models

A building can have a real model in place of the normal one. For now there's one, a plain test hall in `public/models/test-lobby.glb`, from
`tools/build-test-building.mjs`. To add one:

- **Format:** binary glTF (`.glb`), metres, y up, the middle of the building at (0, 0) and its ground floor at y = 0. The site's `yaw` in
  `js/model-sites.js` turns it to fit.
- **Matching:** by location for now. Whichever normal building's outline holds the site's (x, z) is the one it replaces. That building is
  built by itself, and comes back when you leave.
- **Budgets:** one model at a time is fetched, within 200 m, and let go of past 260 m. On a phone aim for under 2 MB, 20,000 triangles,
  under 10 materials and textures of 1,024 px or less. None of it counts towards the first view, which doesn't even hold the loader.
- **Inside:** walls are colliders you list in `js/interiors.js`, and a door is a gap in them. The floor is a surface. Sky light fades as in
  tunnels, up to three placed lights take over, and traffic and far detail stop being drawn.

## License and data

This project is under the [GPL-3.0](LICENSE). It is built on Slop New York, © Mr.doob, used under the
[MIT License](LICENSE-slop-newyork-MIT).

Map data keeps its own licences:

- © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), [ODbL](https://opendatacommons.org/licenses/odbl/):
  roads, parks, the harbour, piers, rail, ferries
- [Overture Maps](https://docs.overturemaps.org/attribution/) (OpenStreetMap and Microsoft ML footprints): buildings
- [City of Sydney](https://data.cityofsydney.nsw.gov.au), CC BY 4.0: trees, building height controls
- [NSW Spatial Services](https://www.spatial.nsw.gov.au), © State of NSW: terrain, from the 5 m elevation model. data.gov.au's record for it says
  CC BY 3.0 Australia, and the service's own page is less clear: to be confirmed with them before Inner Sydney is deployed publicly

## Backed by

Man & Bot

Web games,
browse and play on [Maize.Live](https://maize.live),
watch on YouTube [@RadWebGame](https://www.youtube.com/@RadWebGame),
latest on X [RadWebGame](https://x.com/RadWebGame).
