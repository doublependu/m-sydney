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

`npm run build` makes the site in `dist/`.

## Test

Which test when:

| Command | Time | When |
|---|---|---|
| `npm run check` | About 40 s | Every change: unit tests, build, ground, how the roads drive, roads on two levels, how traffic moves, deploy size, on the 80 km² around the CBD |
| `npm run check -- --full` | About 10 min | When the map changes: the same over the whole map, and how many tiles pass |
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
run one at a time after the rest (`ALONE` in `tools/play/run.mjs`). Scenarios steer with the arrows (`steerTowards()` in
`tools/play/human.mjs`), as in first person on foot A and D step aside; the mouse locks to the game in their headless Chrome too.

Three checks need no browser. `node tools/check-roads.mjs [--list] [--tiles=0_-2,1_-2]` walks every lane of every road by the
game's own rules and says what would slant, jolt or stop a car: lean, change of grade, steps, roll, dead stops, buildings and
kerbs in lanes, paving over roads; and, driven by the player's own step, roads drawn as one deck that a car drops through or is stopped
in, medians it gets past, decks' starts it doesn't get onto from the road on the ground, a car driven in from the ground at decks'
sides that ends up inside one, and one put inside one that's left there. `node tools/check-layers.mjs [--list] [--tiles=0_-2,1_-2]` looks at roads on more than one
level: a road under another with too little room, two roads sunk to different heights sharing the ground, buildings, trees (where
the game stands them) and piers in the lanes of bridges, tunnels and cuttings, trees' crowns across a deck beside them, buildings
under the Harbour Bridge's railway and footway, and tunnels and bridges drawn higher or lower than cars drive on them, or not
at all. `node tools/check-traffic.mjs [--seeds=3] [--at=northSydney,townHall,bridgeDeck]` runs the
real traffic about 50 times faster than real time with a seeded random number generator, and says how much is stopped, how
fast the rest moves, what's holding each queue up, how long a car waits at a red and how often nobody is using the green. It
also says how many cars and people a place wants, by who lives and works there, and how many cars it got: `--at=cronullaHouses,
deeWhyHouses,bankstownHouses,hornsbyHouses,palmBeach` for streets of houses.
Bench options: `npm run bench -- --profile=desktop --runs=3 --query=quality=low --headed`.

`node tools/play/stream-bench.mjs --profile=phone` measures frames while the map streams, flying its length and back. Add
`?stats=1` to the URL to see on screen, for trying it on a phone: load time, frames, the worst frame since load and what the game was
doing then, how much memory the game holds by its own count (`js/memory-estimate.js`, since iOS gives no figure), where you are, and,
if the browser killed the last session, where and at what size (`js/session-note.js`). `?places=1` draws who lives and works where,
and the zoning, over the full map. `?wholeCity=1` with `?debug=1` holds all of
the map, for scenarios about the roads rather than about fetching them.

`node tools/check-ground.mjs [--tiles=0_-2,1_-2]` measures the ground, `node tools/play/look.mjs out-dir
name:x,z,heading,mode,climbSeconds` saves what the game shows from any place (`--spots` for the stacks, tunnels and bridge
ends in `tools/play/spots.mjs`), `node tools/play/flicker.mjs out-dir` holds views still and maps the pixels that flicker,
`node tools/play/walk-trace.mjs out.json [--shift]` walks at a few places and measures how much the walker's head, pelvis and the camera
shake from frame to frame, and `node tools/debug-map.mjs out.png` draws the map data from above. `--dist=dir` has look and flicker show
another build, for pictures from before a change. Add `--browser=firefox` to the play, bench, look and
flicker tools for the WebGL2 path, or `--browser=webkit` for Safari's engine: Playwright's Linux build, drawing in software, the
nearest thing to an iPhone here. A WebKit run reports its web process's memory, as it has no `performance.memory`. Reports' pictures
are the game's own picture of the world under the page's HUD, as the browser's screenshot comes back black behind a WebGPU canvas.

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
in players' caches. They go in a folder for each 8 km square, 64 at most, as GitHub's website lists only the first 1,000 files of a folder
(`js/tiles/paths.js`; `tools/check-dist.mjs` fails over 1,000). It covers Parramatta to the sea and Palm Beach to Cronulla. To rebuild it, download the raw snapshots to `tools/data/`
(they are too large to keep in the repository) and run the generators. Allow about 6 GB of disk for the downloads:

```bash
npm run data:fetch                                     # the original snapshots, from Overpass and open data sites
curl -L -o tools/data/osm/australia-latest.osm.pbf https://download.geofabrik.de/australia-oceania/australia-latest.osm.pbf   # 972 MB
BOX=150.8743,-34.1571,151.4826,-33.4732                # the map and a margin: west, south, east, north
node tools/extract-osm.mjs $BOX tools/data/east        # cuts the roads, land, rail, coast, beaches and footpaths out of it, in seconds
SYDNEY_DATA=tools/data/east SYDNEY_BOX='-34.1571,150.8743,-33.4732,151.4826' node tools/fetch-data.mjs overture_syd,overture_parts   # 3 min
SYDNEY_DATA=tools/data/east SYDNEY_BOX='-34.1571,150.8743,-33.4732,151.4826' node tools/fetch-data.mjs overture_addresses   # street addresses (G-NAF): 147 MB, 40 s
node tools/fetch-data.mjs overture_density             # for the horizon: 90 s
node tools/fetch-elevation.mjs --cell=100              # for the horizon: 4 min
node tools/fetch-elevation.mjs --cell=5 --box=$BOX     # about 1 GB, 15 min
node tools/fetch-data.mjs abs_counts,abs_meshblocks,nsw_zoning   # who lives where and the zoning: 50 MB, 1 min
npm run data:build                                     # about 30 min. Leave 16 GB of memory free for it
npm run data:map                                       # the map screen's images: 2 min
```

Hand edits to the map are in `tools/local/`, a file for each area (`tools/local-edits.mjs` says what one holds): OSM ways' tags, as the
Harbour Bridge's ramps, a style of house for an area's buildings, as Millers Point's terraces, and one building's height and style, as
Circular Quay West's, trees planted by hand in a garden, as Bronte Park's palms and pines, and rock where OSM has none, as Bronte's
shelves. Each names what it expects to find, so the build stops when the data under it has changed. A change to buildings
alone needs only the build's later steps, about 3.5 minutes on the last build's data: `tools/build-buildings.mjs`, `build-garden.mjs`,
`build-trees.mjs`, `build-awnings.mjs`, then `build-tiles.mjs`; a change to the gardens only `build-garden.mjs`, `build-trees.mjs` and
`build-tiles.mjs`; a change to the beaches `build-sand.mjs` (2 minutes) and then the gardens'. `tools/tile-diff.mjs` checks that only tiles in the areas edited by hand, the gardens and the model sites changed.

The beaches (`tools/build-sand.mjs`): every beach OSM has (`natural=beach`, `sand`, `shingle`) is sand, and along the coast, within 150 m
of the shore, its bare rock and a strip either side of each cliff's line are sandstone, and rock in the sea a shelf a little over it. Each
piece lies where the ground is the curb islands' lawn or paving, cut to their 240 m squares, and is drawn over them (`js/city-grid.js`).
Where a beach meets the sea its shore is the beach's, not a sea wall: the ground is graded down to the water there
(`tools/tiles/grade-ground.mjs`), and the sand runs on past the shore and under the water, foam where the swash runs up it.

The gardens (`tools/build-garden.mjs`): in the Royal Botanic Garden, the Domain, round the Opera House, along Circular Quay and in Bronte Park, OSM's
footpaths, steps and cycleways off the roads, the gates on them, its hedges, ponds and beds, and every plant. Its trees come from OSM,
by what it says they are or what grows round them; each garden OSM names, and those on the garden's own map that OSM hasn't (placed on
the world from the ones it has, to about 20 m), is planted by its kind: roses, herbs, succulents, natives, palms, rainforest, beds. Along
the parks' shores (not the boxes round the Opera House and the Quay) a sandstone parapet tops the sea wall, open where steps or a jetty
reach the water, and none where a beach does. Still water in a garden is its pond, untagged as OSM may leave it, not the sea (`tools/build-geodata.mjs`). The areas
are a list in `tools/garden-areas.mjs`, so more can be added; the rest of the map's footpaths wait, as they'd change where everyone walks.

The generators write the whole map to `tools/data/generated/`, and `tools/build-tiles.mjs` cuts it up. What needs a 1 m raster is done a region at a
time, each 7.2 km square with a margin, in worker threads (`tools/geodata/`), since one raster of it all wouldn't fit in memory. Lawns and
footpaths come out of it as pieces of 240 m squares, each traced to its square's edges with every point on them kept through smoothing
and simplifying (`tiledPolygons()`), so neighbours meet on the same points, with no gap and nothing drawn twice. Simplifying can push one
edge of a piece past another; `build-tiles` untangles such a piece where it's written (`tools/tiles/simple-rings.mjs`, and logs each one). `tools/geo-common.mjs` sets the world frame and the play area; `SYDNEY_AREA=inner` makes Inner Sydney instead, or `today` the old CBD map, for checking a generator still makes
what it did.

| File | Holds | Fetched |
|---|---|---|
| `tiles/world.json` | What the whole map shares: tile list, structures, the bridge's deck | At start |
| `tiles/far-heights.bin.gz` | The ground on a very coarse grid, for where nothing better is held | At start |
| `tiles/<X>_<Z>/<x>_<z>.<hash>.bin.gz` | A tile, in the folder of the 8 km square it's in: roads with their shapes and OSM class, kerbs, where the land and shore are (and which of the shore is a beach's), the beaches and the coast's rock, buildings with each house's style, trees, heights, tunnel mouths, a 5 m grid of how far the ground moves to meet the roads, and a 100 m grid of residents, homes, workers, land use and zoning | When the player's near |
| `tiles/far/far_<x>_<z>.<hash>.bin.gz` | 4 km of the far level: every building as a few points, plain ground with its own land and heights, main roads | Near the player, after the first frame |
| `tiles/far.json.gz` | Land beyond the map, suburbs' names, and the streets around the Harbour Bridge | After the first frame |
| `tiles/horizon.bin.gz` | The whole box out to Katoomba, coarsely | After the first frame |
| `tiles/map.json.gz` | Where every named street is, for the map screen's names and search | When the map is first opened |
| `map/<m>/<x>_<z>.webp`, `map/2/<X>_<Z>/<x>_<z>.webp` | All of the map as images, at 32, 8 and 2 m a pixel, the 2 m ones in the tiles' folders | As they come into view on the map |

## License and data

This project is under the [GPL-3.0](LICENSE). It is built on Slop New York, © Mr.doob, used under the
[MIT License](LICENSE-slop-newyork-MIT). The concert's piano and trumpet (`js/audio-instruments.js`) are ported from
[BeepBox](https://github.com/johnnesky/beepbox), © John Nesky and contributing authors, used under the [MIT License](LICENSE-beepbox-MIT). The
water of North Sydney Pool (`js/pool-water.js`) is ported from Evan Wallace's [WebGL Water](https://madebyevan.com/webgl-water/), by way of
[threejs-water](https://github.com/jeantimex/threejs-water), © 2011 Evan Wallace and © 2026 Yong Su, used under the
[MIT License](LICENSE-webgl-water-MIT).
The tune they play, Waltzing Matilda (Marie Cowan's of 1903), is in the public domain.

Map data keeps its own licences:

- © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), [ODbL](https://opendatacommons.org/licenses/odbl/):
  roads, parks, the harbour, piers, rail, ferries
- [Overture Maps](https://docs.overturemaps.org/attribution/) (OpenStreetMap and Microsoft ML footprints): buildings
- [City of Sydney](https://data.cityofsydney.nsw.gov.au), CC BY 4.0: trees, building height controls
- [NSW Spatial Services](https://www.spatial.nsw.gov.au), © State of NSW, CC BY 3.0: terrain, from the 5 m elevation model
- [Australian Bureau of Statistics](https://www.abs.gov.au/census/guide-census-data/mesh-block-counts/2021), CC BY 4.0: residents, dwellings
  and land use, from the 2021 Census's Mesh Block counts and ASGS Edition 3 boundaries
- [NSW Department of Planning, Housing and Infrastructure](https://www.planningportal.nsw.gov.au/opendata/dataset/environment-planning-instrument-local-environmental-plan-land-zoning),
  CC BY 4.0: land zoning
- Incorporates [G-NAF Core](https://geoscape.com.au/data/g-naf-core/) © Geoscape Australia
  ([Copyright and Disclaimer Notice](https://geoscape.com.au/data-copyright-disclaimer/)), licensed by Geoscape Australia under the
  [Open G-NAF Core End User Licence Agreement](https://data.gov.au/data/dataset/geocoded-national-address-file-g-naf) (CC BY 4.0's terms,
  with one use restriction: not for compiling addresses to send mail to), by way of OpenAddresses and
  [Overture Maps](https://docs.overturemaps.org/attribution/)' addresses theme: street addresses, matched to the buildings: the street
  each faces and its numbers, which its plates show

## Backed by

Man & Bot

Web games,
browse and play on [Maize.Live](https://maize.live),
watch on YouTube [@RadWebGame](https://www.youtube.com/@RadWebGame),
latest on X [RadWebGame](https://x.com/RadWebGame).
