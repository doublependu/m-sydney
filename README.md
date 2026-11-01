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

```bash
npm test            # unit tests
npm run bench       # load time and frame rate on desktop and phone profiles, fails over budget
npm run viewports   # checks the HUD for overflow and overlap at phone, tablet and desktop sizes
npm run play        # plays the game like a person and records it in recordings/ (not committed)
```

`npm run bench`, `npm run viewports` and `npm run play` use the build in `dist/` and your installed Chrome.

Play options: `npm run play -- --only=first-minute,harbour-bridge --no-video --soak=3 --headed --seed=6 --gap=3`.
Bench options: `npm run bench -- --profile=desktop --runs=3 --query=quality=low --headed`.

`node tools/play/look.mjs out-dir name:x,z,heading,mode,climbSeconds` saves what the game shows from any place, and
`node tools/debug-map.mjs out.png` draws the map data from above.

## Deploy

```bash
npx wrangler login
npm run deploy
```

Cloudflare Workers serves `dist/` as a static site. Per-version preview URLs are off in `wrangler.jsonc`.

## Map data

The generated map lives in `js/`. To rebuild it, download the raw snapshots to `tools/data/` (they are too large to keep in
the repository) and run the generators:

```bash
npm run data:fetch
npm run data:build
```

`tools/geo-common.mjs` sets the world frame and the play area.

## How it works

- **The simulation is flat.** Colliders, traffic and people live on a plane. Sydney's 50 m of relief is added where things
  are drawn (`js/terrain.js`), so ground meshes are built on the hills and moving things are lifted as their transforms are
  written. Keep any new code on the flat side of that line.
- **The Harbour Bridge is a corridor with its own height** (`js/bridge.js`). Whoever comes on at an end stays on the deck
  until they leave at the other, so cars on it and on the streets below can share (x, z).
- **There is no street grid.** Every street comes from the centreline graph (`js/road-network.js`). `DRIVE_SIDE` in
  `js/city-config.js` sets which side traffic keeps to.
- **The game must be playable within 4 seconds,** so only the ground and buildings around the player are built before the
  loading screen drops. The rest builds a few milliseconds per frame while you play (`buildRestOfWorld` in `js/main.js`,
  `js/world-jobs.js`).

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
