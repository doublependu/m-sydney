# The future of map data: commit it, or build it?

Asked on 5 November 2026: should we stop committing the map data, and build it before each deploy instead, so the git repo stays smaller? And does `npm run data:build` need anything git doesn't have? Nothing here is implemented. It goes with the sizes in `ai/map_expansion.md`.

## Short answer

Not yet, and not in that form.

1. **Deploys wouldn't take longer.** `npm run deploy` already runs on this PC, from this PC's `public/tiles/`. If git stopped tracking the tiles, they'd still be on disk, so deploys would work and take the same time as now. The map is rebuilt only when it changes, as today.
2. **Building the map before each deploy on another machine, like CI, would be a bad idea.** It needs about 4.3 GB of downloads that git doesn't track (below). Most of those sources change over time, so each deploy would ship a slightly different map from the one you tested. It also needs 16-20 GB of memory and about an hour.

## What a rebuild changes in git

A rebuild changes only the files whose contents change. `build-tiles` deletes `public/tiles/` and writes it again, but each file is named for a hash of its zipped bytes. A tile that comes out the same gets the same name and bytes, and git sees no change.

**Checked:** `build-tiles` was run again in a scratch copy, from the build data already on this PC, in 2.7 minutes. All 1,949 files came out the same as what's committed, byte for byte: tiles, far files, `world.json`, map data and horizon. The steps before it (roads, heights, buildings, population) haven't been checked the same way. Nothing in them is random or timed, but some run regions in parallel. A full 31-minute run in a scratch copy would settle it.

What does change every tile:

- **A code change that touches every tile.** Each of plan 4's two commits did, rewriting about 3,900 tile files, as every tile got new fields.
- **New source data,** like a newer OSM extract from `npm run data:fetch`. That changes every tile with edits in it, which in a city is most of them.
- **A Node upgrade.** The hash is taken after zipping, so another zlib in Node (24.18 now, zlib 1.3.1) can zip the same contents to other bytes. That renames every tile though nothing in the map changed.

`npm run data:build` doesn't touch the map screen's images in `public/map/`. Only `npm run data:map` redraws those.

## What we'd gain and lose

**Gain:** git history stops growing by about 65 MB for each rebuild committed today, and about 140 MB at Katoomba. At 230 MB, the repo is far from GitHub's recommended 1 GB, so this isn't urgent.

**Lose:**

- **A fresh clone doesn't work.** The repo is public. Without the tiles, nobody could run the game, `npm test`, `npm run check` or the offline build: they all read `public/tiles/`.
- **Code and map no longer go together.** Checking out an old commit gives its code but not its tiles. When the tile format changes, old commits stop running. Finding which change broke something, like the Bridge St kerb, gets harder.
- **The only copies would be this PC and Cloudflare.** If this disk dies, a rebuild means downloading the sources again, and that gives a different map.

## What to do

- **Now:** keep committing tiles, only at stops.
- **Around Katoomba:** stop tracking `public/tiles/` and keep deploying from this PC. At each stop, upload the tiles as one archive to a GitHub Release. Release files don't count toward the repo's size or history. A small script lets a fresh clone download that archive.
- **Either way, back up `tools/data/` off this PC.** It's the only copy of the exact inputs.

## What `npm run data:build` needs that git doesn't have

Everything it reads is in `tools/data/`, which git ignores: 4.3 GB on this PC. The steps under "Map data" in `README.md` fetch it from:

| Source | What | The same again? |
|---|---|---|
| Geofabrik's OSM Australia extract, 972 MB | Roads, land, rail, coast | **No:** always the latest |
| Overpass API, live OSM | Signals, crossings, trees, bus stops, harbour, parks | **No:** live |
| Overture Maps, on AWS S3 | Buildings and building parts | **Yes:** fixed to release `2026-10-21.0` (`OVERTURE_RELEASE` in `tools/fetch-data.mjs`). Old releases may not stay online for good |
| NSW Spatial Services | 5 m and 100 m elevation, contours, ferries | Mostly: the elevation rarely changes |
| City of Sydney open data | Trees, contours, parks, awnings, storeys | **No:** live |
| ABS 2021 Census | Mesh Blocks and their counts | **Yes:** fixed |
| NSW Planning Portal | Zoning | **No:** live |

It also needs:

- `npm install`, for DuckDB, which reads Overture and the OSM extract.
- About 16-20 GB of memory free.
- Chrome installed, for `npm run data:map`, which draws the map screen's images through it.

**So only Overture and the ABS come back the same.** Everything else drifts. That's the strongest reason to build the map only on this PC, and to keep the inputs as well as the tiles.
