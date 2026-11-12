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
run one at a time after the rest (`ALONE` in `tools/play/run.mjs`).

Three checks need no browser. `node tools/check-roads.mjs [--list] [--tiles=0_-2,1_-2]` walks every lane of every road by the
game's own rules and says what would slant, jolt or stop a car: lean, change of grade, steps, roll, dead stops, buildings and
kerbs in lanes, paving over roads. `node tools/check-layers.mjs [--list] [--tiles=0_-2,1_-2]` looks at roads on more than one
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
and simplifying (`tiledPolygons()`), so neighbours meet on the same points, with no gap and nothing drawn twice. `tools/geo-common.mjs` sets the world frame and the play area; `SYDNEY_AREA=inner` makes Inner Sydney instead, or `today` the old CBD map, for checking a generator still makes
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

## How it works

- **The simulation is flat, on surfaces.** Colliders, traffic and people move in (x, z), each on a surface: the ground, or a
  structure with heights of its own (`js/surfaces.js`). Sydney's 50 m of relief and the road levels are added where things
  are drawn, so ground meshes are built on the hills and moving things are lifted as their transforms are written. Keep
  any new code on the flat side of that line.
- **Every road has a height.** `tools/build-heights.mjs` solves bridges, viaducts, tunnels, cuttings and motorways so that
  stacked roads clear each other, and writes the profiles into the generated map: where they cross, and where OSM draws one on
  top of the other without crossing, as a double-deck tunnel's two carriageways. `js/structures.js` draws what's off the
  ground. A surface changes only across a step of 1.5 m or less: anything bigger is a parapet or a tunnel wall, so cars at
  the same (x, z) on different levels never meet. Something on a structure stays on it until it ends. On the ground, a road's own
  carriageway is its level: where two roads at different heights run side by side, the ground is each one's across its own
  lanes (`groundHeight()` in `js/surfaces.js`).
- **Every road on the ground has a shape.** Draped over the land, a road across a hillside leans with it. Instead each road's
  height is solved along it, smooth and near the land, shared at junctions and with any road overlapping it, with no more than
  4% of lean across it. A junction is a flat tilted plate where one fits. `roadHeight()` in `js/surfaces.js` is the one
  surface everything reads.
- **The ground follows the roads, not the other way round.** Each tile has a 5 m grid of how far the ground moves to meet them
  (`tools/tiles/grade-ground.mjs`). Footpaths, kerbs, lawns, trees, floors and people all stand on the result.
- **Each junction runs its own lights,** by who's there, the player and people waiting to cross included (`js/signals.js`).
  Junctions close together, like a divided road's two halves, share one set. Heads read their state from a small texture.
- **The Harbour Bridge is one of those structures,** with its heights from a table of the real deck (`js/bridge.js`).
- **Tunnels side by side have room for a wall.** OSM often draws a tunnel's two tubes closer than their roads are wide, so
  `tools/tiles/separate-tubes.mjs` moves them apart inside, leaving the mouths where they are. A tunnel's walls hold: nothing
  moves sideways from one tunnel into another (`chooseSurface()`). The same goes for two cuttings side by side at different heights:
  past a road's edge, where the ground is the other road's a step or more away, the edge is a wall (except in a junction). The sea
  is one sheet at sea level, so it runs through any tunnel that dips below it: it isn't drawn while the camera's in a tube.
- **What stands under a deck fits under it.** `roomUnderDeck()` in `js/surfaces.js` says how much room there is. A building a deck
  runs through is cut down to fit when the tiles are made, and one over a road in a cutting or a tunnel's open cutting stands on a
  floor raised to leave a lane's height over it, its walls stopping there (`js/wall-foot.js`). One that can be neither is left out
  (`tools/tiles/derive.mjs` lists those whose height was measured). Trees, street lights and signs aren't put where they wouldn't fit.
- **Who lives and works where.** `tools/build-population.mjs` reads the ABS 2021 Census's Mesh Blocks, 30-60 homes each with their
  residents, dwellings and land use, and NSW's land zoning, into a 10 m raster. Each tile gets a 100 m grid of it, with workers judged
  from the floor area of the buildings that aren't homes (`tools/tiles/place-grid.mjs`), and `js/places.js` reads it. Add `?places=1`
  to see it on the full map: the colour is the zone, the strength how many live and work there.
- **How busy a place is follows who's there.** A road's share of the most traffic it holds (one car per 80 m of lane) comes from the
  residents and workers within 250 m: motorways are always full, main roads at least a third, a street of houses a twentieth
  (`roadShare()` in `js/traffic.js`). People out walking are one for every 200 residents and workers within 350 m, and a crowd at each
  station. The graphics level's numbers are the most there are. Cars are parked along the kerbs of streets of homes, as many as
  the homes there, drawn as the far cars are and simulating nothing; the player hits them.
- **A beach's sand comes down to the sea.** The survey has the sand a metre or two over the water's edge, and the sea is 2.2 m under the
  survey's zero, so a beach would end in a step. The ground on a beach is graded down within 60 m of its shore, rising 8 cm a metre
  inland from 0.1 m over the sea until it meets the ground as surveyed, never raised, faded out over 4 m at the sand's other edges and
  kept 6-12 m clear of the roads. The sand's material darkens where the swash wets it, and its foam runs up and back.
- **The Opera House's shells are cut from spheres,** all of one radius, as Utzon's were (`js/opera-house.js`). Each shell is two
  mirrored halves with four corners: its tip and the end of its ridge on the hall's centre line, the foot of its valley at the side, and
  the pedestal its arch comes down to. The ridge is where a half's sphere meets its mirror's, and the valley where two shells back to back
  meet. Their places come from OpenStreetMap's podium and halls, their heights from the long section and the side photos.
- **Houses look like Sydney's.** Most outlines in the suburbs come with no use. `tools/build-buildings.mjs` makes one a house, flats or a
  shop by its Mesh Block and zoning, and gives a house a style by its group of suburbs: Victorian terrace, Federation, California
  bungalow, post-war fibro, brick veneer, project home, beach house, walk-ups (`js/house-styles.js`). A style says its walls, roof
  colours, pitch, gables and eaves. The walls are two more sets of uniforms for the masonry facade, so the GPU compiles nothing more,
  and every pitched roof is one vertex-coloured material.
- **A garden is drawn over its lawn** (`js/garden.js`): its paths as strips in their surfaces' colours, its beds speckled with what's
  planted in them, so they read as planted from further off than the plants are drawn, its hedges, ponds and gates, and the parapets
  along its shore, which you can't walk or jump over. All of it lies on the lawn as the lawn is drawn, not on the ground under it, which
  bends where the lawn's triangles are straight; and its paths are a centimetre apart by surface (steps on top, then asphalt, paving,
  gravel, timber), so where two cross one is always over the other. People out walking
  take its paths (`js/pedestrian-routes.js`), joined where they meet and onto the street's footpath where one ends beside it, through
  the gates; a garden's paths bring more people out, one for each 40 m. Its plants are the trees' kinds and more (`js/trees.js`): palms,
  araucarias, the Wollemi pine, tree ferns, cycads, and small ones, shrubs, natives, flowers, roses, succulents and grasses, grown as
  bushes and drawn small, near only (as far as the graphics level draws things), in cells of their own. They come in the tiles as the
  trees do.
- **Small streets have no centre line.** A two-way residential street under 11 m gets one only where it meets a main road, and a
  service road none at all (`markingsOf()` in `js/road-paint.js`), by each road's OSM class.
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
- **The game keeps to a memory budget.** iOS gives a page no figure for its memory and kills a tab that holds too much, so the game
  counts what it holds itself (`js/memory-estimate.js`). Over the budget for its level, the far level reaches less far, a
  kilometre at a time. A far square's buildings are packed into 20 bytes a vertex, the largest part of what's held at a distance.
- **A stage's meshes must let three.js forget them.** Materials are shared by every tile so a new tile compiles nothing, and
  three.js keeps a record of each mesh through its material. `disposeStage()` in `js/main.js` fires the event that lets go of it;
  anything removed without that stays in memory for good.

Graphics levels live in `js/quality.js`. Auto picks one from the device and steps down if frames run slow. Add `?quality=low`,
`medium` or `high` to the URL to force one, or choose in the pause menu.

## Building models

A building can be drawn from a model of its own, and have an inside you can walk into. The models' sources aren't in this repo: they're
built by scripts kept elsewhere, and what they build is committed in `public/models/`, so this repo builds, tests and deploys without them.
What a model has to be:

- **Where it goes:** `js/model-sites.js` lists each site: its file, where its middle stands, how it's turned, its ground floor's height
  (or none, to stand it on the ground), and points in the map's buildings it replaces. The tile build leaves those buildings out
  (`tools/tiles/derive.mjs`) and from the far level, and the model is drawn with its tile.
- **Two files a part:** a binary glTF, compressed with meshopt and gzipped (`.glb.gz`: Cloudflare doesn't compress glTF on the way, and
  gzip takes a model to a third or less), and a JSON beside it. Metres, y up, the model's middle at (0, 0) and its ground floor at y = 0.
  Colour is in the vertices, with ambient occlusion baked into it; materials are named (`plaster`, `timber`, `glass` and so on) and the
  game makes its own from the names (`js/interiors.js`).
- **Few draws:** what a model costs to draw is its draws, one a node and material, far more than its triangles. What never moves is one
  node (`body`), so one draw a material.
- **The outside** (`<file>.glb.gz`, `<file>.json`): what you see from the street, the leaves of its outer doors as nodes turning about
  their hinges (`door_<id>`), and in the JSON its outer walls, its doors and the floors outside them (a step). A door that leads somewhere
  names the inside's file. Its glass faces out only: from the street it's lit at night like the neighbours' windows; from inside you see
  through. Its leaves are drawn as one shut piece (`doors_shut`) until you or the camera are within 20 m of it.
- **Near and far:** a model is drawn within 400 m of the camera (a site's `near` can say otherwise). Past that, and wherever its tile isn't
  drawn, its far version is if its site says `far` (`<file>-far.glb.gz`: a shell in two draws and under 2,000 triangles, drawn as far as
  the far level reaches), or what it takes the place of (the Opera House's plain podium and glass).
- **The inside** (`<file>-in.glb.gz`, `.json`), fetched when one of its doors is opened and let go of 60 m after you leave. Each room is a
  node (`room_<id>`) and only those you can see are drawn: the one the camera's in and those through open doorways from it, three
  deep, and the one you're in and those next to it. The JSON has its
  floors (shapes at heights, a stair as a slope, holes where a stair comes through), walls (2D segments with a bottom and a top), inner
  doors, seats, rooms, the links between rooms, and where its lamps are.
- **Walking in it** (`js/interior-data.js`): you stand on the highest floor under you no more than 0.45 m above your feet, so a stair
  climbs and the floor upstairs doesn't take you. Walls hold you at their own heights, so a wall upstairs is over your head downstairs. A
  shut door is a wall, filling its doorway through the wall's thickness, so nothing catches in the recess its leaf leaves. F opens the
  door or takes the seat in front of you (the hand button on touch, X on a gamepad); its prompt shows only within 1.5 m, facing it.
  On foot you walk at 1.5 m/s, the pace of the people in the street, and run at 6 with Shift (or a stick pushed nearly all the way).
  Inside you walk at 1.2 m/s and run at 2.4, turning in under a metre, and you're 0.22 m round (the models' checks use 0.3).
- **The camera in it, or beside it:** it comes in closer and looks ahead level. Looking on from over your head, it's kept 0.25 m clear of
  every wall and door leaf, 0.7 m under a ceiling and 0.25 m over a floor, and the line it sees you along goes through no floor or stair.
  It comes in at once and eases back out. Its near plane is 0.1 m there (0.35 m elsewhere), so it never cuts into a wall. Nearer than
  0.7 m to your head, you aren't drawn.
- **Budgets:** an outside under 150 KB; an inside under 2 MB and 40,000 triangles on a phone. Nothing of either is in the first view, which
  doesn't hold the loader.
- **Glass:** each pane's vertex colour isn't its colour but numbers: whether it's lit at night (red, under 0.5) and how warm (green), the
  same over the pane. About half are lit, as the city's windows are. A curtain wall's (`curtain`) lights fewer, and takes its tint from
  blue: 0.5 its own teal-grey, towards 0 a light, bright blue (Crown Sydney's), towards 1 a deep blue-black (Salesforce Tower's).
  `clear` is glass to walk on: nearly clear, seen from above (Customs House's floor over the city in miniature).
- **Under the street:** a site's `cut` leaves a hole in the paving or lawn it stands in, and lowers the base under it, for rooms below the
  street; the model draws its own ground there.
- **Before its doors:** a site's `clear` lists circles where no street tree is planted (`js/street-details.js`), so a surveyed tree
  doesn't stand in its doorway.
- **The test interior** (`test-interior`), a plain two-storey house on Hyde Park's lawn, is drawn only with `?debug=1`. The `walk-in`
  scenario walks into it, up its stair, sits and comes out again; `tests/interiors.test.mjs` reads its JSON.
- **Lower Fort St, west side** (`lfs-west`): a row of eight houses in Millers Point as one model, one of them with its inside, and a far
  version. The `lower-fort-55` scenario walks through it.
- **The Ribbon** (`ribbon`), Darling Harbour: a curved glass slab between the Western Distributor and its on-ramp, in place of the map's
  box of its outline, with a far version. Its glass is `curtain`: a curtain wall's, bluer and less of a mirror than a window's, lit at
  night pane by pane.
- **The Opera House** (`opera-house`): its shells are the game's own, drawn near and far (`js/opera-house.js`). Near it a model takes the
  place of the game's plain podium, steps and glass: the granite podium, the Monumental Steps and the flights to the upper podium, which
  you can climb, the glass walls on their mullions and the louvres, the parapets, and round it the Broadwalk's lamps, the Opera Bar's
  umbrellas and the gate into the garden. Its site stands unturned with the world's heights (`y: 0`), and walks a `reach` of 160 m. Its
  script asks `operaGeometry()` for the shells, arches and glass, so its glass meets them, and writes the arches it was built on into the
  JSON (`builtOn`): `tests/opera-house.test.mjs` fails if the shells have moved since, and the models must be built again. The Concert Hall
  and its foyers (`opera-house-ch`) are fetched at its south doors: up the grand stair, round to the doors at the front of the stalls, up
  to the top of the circle and down the red stair to the northern foyer. The `opera-house` scenario walks that, and sits in the stalls
  and by the glass.
- **Sydney Tower** (`sydney-tower`): the tower and Westfield's podium round its foot, in place of the map's podium, with a foyer behind a
  door on Market St, its lifts through security gates. Both the model and the game's own tower, drawn from anywhere, are made from one
  shape in `js/sydney-tower.js` (the model's script reads it through node), so the game's stands in for it unseen wherever its tile isn't
  drawn. Its site's `near` is 5,000 m: drawn whenever its tile is. The `sydney-tower` scenario walks in.
- **The Pylon Lookout** (`pylon-lookout`), in the Harbour Bridge's south-east pylon: a door off the footway into a foyer, and up its stair
  the first exhibition floor. The pylon is the game's: `js/harbour-bridge.js` leaves its granite hollow there (`lookoutPlace()`,
  `LOOKOUT`), with a doorway, and collides as the hollow's walls. A walker on the footway who presses on through the doorway onto the
  model's floor is on that floor, which is the ground there, and back on the footway on the way out (`js/controllers.js`). The
  `pylon-lookout` scenario walks from a car on the deck to its door, in and up.
- **Four CBD buildings,** each in place of the map's box (or boxes) of its outline, with a far version, and a foyer behind a door off the
  street, which the scenario of its name walks into and out of:
  - **Salesforce Tower** (`salesforce-tower`, 263 m), on George St at Circular Quay: two halves in blue-black glass, a white spine up their
    joint and white fins branching up its north and south faces, sunshades along the east face, a glass crown. The game's own sign is on
    the crown's north face (`js/tower-signs.js`). Its foyer is double height, a wall of light at its back.
  - **The EY Centre** (`ey-centre`, 141 m), across George St: a rounded slab, its panes gold where their timber blinds are down and dark
    glass where they're up, on white columns over a lobby set back under a timber soffit. Its foyer is timber-lined.
  - **Customs House** (`customs-house`), facing the Quay: sandstone, its colonnades, porch, clock and pavilions, the penthouse on its roof,
    up steps from the square. Inside, the library's atrium, open to its glass roof, and in its floor the city at 1:500 under glass, made
    from the map's own buildings. Its site's `cut` leaves the ground under it undrawn, for the pit.
  - **Crown Sydney** (`crown-sydney`, 271 m), Barangaroo: three petals of light blue glass twisting 60 degrees as they rise and parting at
    the top, the wing beside them and the podium in white fins round both; the hotel's lobby off the plaza to the north.
  - Their scripts read the site from `js/model-sites.js` through node, and ask the game for the ground and the map's buildings
    (`tests/cbd-buildings.test.mjs` holds them to the map). The map's survey of tall towers counts them as their models stand
    (`tests/building-geodata.test.cjs`).
  - A tower's site says how high it stands and how far it reaches (`top`, `radius`): a helicopter arriving beside it clears it
    (`roofsNear()`, `js/controllers.js`) though its model comes only once the city round you is in, as it cleared the map's box.
- **A house over Bronte beach** (`bronte-pacific`), on the corner of Bronte Rd and Pacific St, in place of the map's box: white render on
  three levels down the slope, a sandstone-clad garage turned square to Pacific St, the top floor's living room open to a terrace under a
  timber pergola, a deck along the middle floor and a lap pool on the low side. It's built into the slope, so its site's `cut` leaves the
  ground undrawn over the house, its deck and its pool's terrace, and the model draws the ground round them itself, as surveyed. Its
  inside, fetched at its doors (the front door, the garage's side door, the rumpus room's onto the pool, the middle floor's onto the
  deck), has the three floors of its floor plan. The `bronte-pacific` scenario walks in at the front door, sits on the terrace, and goes
  down through the house to the pool. The flats round it are red brick under tiled roofs (`tools/local/bronte.json`).
- **What a big inside adds:** `instances` in its JSON draw a node many times from one (the hall's seats: a node, the room it's in, and
  `[x, y, z, yaw]` for each), as one InstancedMesh for each of its materials; each seat to sit in is in `seats` as well. A room can say
  how far it shuts out the sky (`shelter`, 0.85 unless it says: a glazed foyer less, a concert hall all of it) and how much its own colours
  light it (`glow`, 0.1 unless it or its inside says). The material `bronze` is glass you see through both ways, tinted, lit warm at night.
- **Budgets for the Opera House:** its outside under 2 MB, loaded with its tile; the Concert Hall under 4 MB and 100,000 triangles drawn on
  a phone, its seats included.

## License and data

This project is under the [GPL-3.0](LICENSE). It is built on Slop New York, © Mr.doob, used under the
[MIT License](LICENSE-slop-newyork-MIT).

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

## Backed by

Man & Bot

Web games,
browse and play on [Maize.Live](https://maize.live),
watch on YouTube [@RadWebGame](https://www.youtube.com/@RadWebGame),
latest on X [RadWebGame](https://x.com/RadWebGame).
