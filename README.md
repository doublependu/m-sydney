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

`npm run build` makes the site in `dist/`, plus `dist/sydney.html`: the whole game as one file to play offline.

## Test

Which test when:

| Command | Time | When |
|---|---|---|
| `npm run check` | About 7 s | Every change: unit tests, build, ground, deploy size |
| `npm run play` | About 5 min | Before saying something works: the key scenarios, no video |
| `npm run play -- --changed` | Varies | After a larger change: the scenarios `git diff` says it can affect |
| `npm run play -- --full` | About 22 min | Once at the end of an iteration: everything, long drives on the fast clock |
| `npm run bench` | A few min | When load time or frames could have moved: fails over budget |
| `npm run viewports` | About 1 min | When the HUD changes: overflow and overlap at phone, tablet and desktop sizes |

The play, bench and viewports tools use the build in `dist/` and your installed Chrome. A failed scenario runs again with
the same seed and with video, so a failure that repeats has a recording. Only the last three runs stay in `recordings/`;
put a file called `KEEP` in a run's folder to hold on to it.

Play options: `--only=first-minute,harbour-bridge --video --fast --realtime --repeat=3 --no-rerun --headed --soak=10
--seed=6 --gap=3 --tiles=0_-2,1_-2`. `--fast` steps the simulation as fast as it can instead of in real time, about 7 times
quicker on the long drives; scenarios that measure frames stay in real time.
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
in players' caches. To rebuild it, download the raw snapshots to `tools/data/` (they are too large to keep in the repository)
and run the generators:

```bash
npm run data:fetch
npm run data:build
```

The generators write the whole map to `tools/data/generated/`, and `tools/build-tiles.mjs` cuts it up, which alone takes a couple
of seconds. `tools/geo-common.mjs` sets the world frame and the play area.

| File | Holds | Fetched |
|---|---|---|
| `tiles/world.json` | What the whole map shares: tile list, shores, structures, the bridge's deck | At start |
| `tiles/far-heights.bin.gz` | The ground on a coarse grid, for where no tile is held | At start |
| `tiles/<x>_<z>.<hash>.bin.gz` | A tile: roads, kerbs, buildings, trees, heights | When the player's near |
| `tiles/far_<x>_<z>.<hash>.bin.gz` | 4 km of the far level: every building as a few points, plain ground, main roads | After the first frame |
| `tiles/far.json.gz` | Land beyond the map, and the streets around the Harbour Bridge | After the first frame |
| `tiles/map.json.gz` | All the roads and blocks, for the map screen | When the map is first opened |

## How it works

- **The simulation is flat, on surfaces.** Colliders, traffic and people move in (x, z), each on a surface: the ground, or a
  structure with heights of its own (`js/surfaces.js`). Sydney's 50 m of relief and the road levels are added where things
  are drawn, so ground meshes are built on the hills and moving things are lifted as their transforms are written. Keep
  any new code on the flat side of that line.
- **Every road has a height.** `tools/build-heights.mjs` solves bridges, viaducts, tunnels, cuttings and motorways so that
  stacked roads clear each other, and writes the profiles into the generated map. `js/structures.js` draws what's off the
  ground. A surface changes only across a step of 1.5 m or less: anything bigger is a parapet or a tunnel wall, so cars at
  the same (x, z) on different levels never meet.
- **The Harbour Bridge is one of those structures,** with its heights from a table of the real deck (`js/bridge.js`).
- **The ground is one height everywhere.** Roads, footpaths, lawns and kerbs all sample `groundHeight()`, and
  `node tools/check-ground.mjs` measures how well they agree: wheels against the road, kerbs against what's either side of
  them, roads at crossings, and steps in the height grid.
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

## License and data

This project is under the [GPL-3.0](LICENSE). It is built on Slop New York, © Mr.doob, used under the
[MIT License](LICENSE-slop-newyork-MIT).

Map data keeps its own licences:

- © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), [ODbL](https://opendatacommons.org/licenses/odbl/):
  roads, parks, the harbour, piers, rail, ferries
- [Overture Maps](https://docs.overturemaps.org/attribution/) (OpenStreetMap and Microsoft ML footprints): buildings
- [City of Sydney](https://data.cityofsydney.nsw.gov.au), CC BY 4.0: trees, terrain contours, building height controls
- [NSW Spatial Services](https://www.spatial.nsw.gov.au), Creative Commons Attribution: terrain contours

## Backed by

Man & Bot

Web games,
browse and play on [Maize.Live](https://maize.live),
watch on YouTube [@RadWebGame](https://www.youtube.com/@RadWebGame),
latest on X [RadWebGame](https://x.com/RadWebGame).
