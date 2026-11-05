# Handover: iteration 5, part way

Plan 5 (`ai/plan_5.md`) is being implemented. This session stopped part way through, at your request, so you can commit and carry on
in a new session. `next_5.md` isn't written yet: that's for the end.

## Where things stand

| Phase | State |
|---|---|
| A: bicycle, camera, turn to the view, offline file, readout | **Done and tested** |
| B: no walls between roads side by side | **Done**, ratchet set |
| C: local map changes | **Built, not yet proven.** Two clean builds in a row still have to come out the same |
| D: the bridge itself | **Mostly built.** The bus lane needs one more map build. Unit tests and the road check fail on it (below) |
| E: on and off at the CBD end | **Started:** two hand edits in. Not looked at in the game yet |
| F: drives and pictures | **Scenarios written, never run** |
| G: North Sydney (stretch) | Not started |

**The working tree is part way: commit it as work in progress.**

- `npm run check` fails: 5 unit tests, and the road check's dead stops (3,306 m against a limit of 700). All of it is the new bridge (below).
- `public/tiles/` (about 125 tiles changed against HEAD) was made from map data I built today, before the last changes to the pylons. So `world.json`'s `landmarkBoxes` are a little out of date.
- **`tools/data/generated/` is half rebuilt:** I stopped a full build part way through, at the first heights pass. **Before you trust anything there, run the whole map build again** (step 1 below).

## What was done, by phase

### A (done)

**Bicycle.** The real cause was more than the plan said. The simulation is flat: the bike's model is lifted onto its road only at the end of each frame, after the rider has been posed.

- So the rider was posed at the bike's flat height, then stood on the ground at (0, 0), a fixed 22.5 m.
- At the start that put the rider 5.5 m under the bike. Riding downhill to the harbour, the bike drops and the rider stays: "up into the sky".
- **The helmet was drawn underground too.**
- **Fix:** `PersonCrowd.add(rig, distance, base)` takes the height of what the person stands on. The rider and the player's walker give their surface's height (`js/controllers.js`, `poseCharacters`). The rider is posed again when that height changes under a parked bike.
- **Tests:** a unit test (`tests/pedestrians.test.cjs`), and in the game the helmet is measured at 1.68 m over the bike (`orbit-follow`).
- **Picture:** `recordings/plan5/bicycle-rider-fixed.jpg`.

**Camera.** It aims along its own direction now, not the player's heading. The lead and lift fade as it orbits round, and as it's dragged up to look down. Pitched down, the old camera lost the walker even with no orbit at all.

- **Unit test:** the player stays in the middle third of the screen across 25 orbits × 3 pitches × 3 zooms × phone and desktop, in each mode.

**Turning to the view.**

- `steerToView()` in `js/controllers.js`, with the camera turning back by as much in `js/cameras.js`, so the camera stays put.
- **The car:** only within 90°, and only through its own steering. Gains: `VIEW` in `js/controllers.js`. At 43 km/h it needs about 2 s for 57°: its grip limits it.
- **Tests:** unit tests, plus the scenarios `orbit-follow` and `orbit-follow-phone`. Both pass, the phone one with touch drags.

**Offline file.** Removed everywhere:

- The `vite-plugin-singlefile` dependency is uninstalled.
- `npm run build` is one Vite build.

**Readout.** Two new lines: where the game loaded, and how many files came from the cache (`cacheShare()` in `js/frame-stats.js`).

**Tools.** `__gameDebug.view(from, to)` and `look.mjs name@x,y,z>tx,ty,tz` put the camera exactly where you ask: a fixed view, which the frame loop now leaves alone.

### B (done)

- **The rule:** `edgeNeighbour()` and `laneAt()` in `js/surfaces.js`. An edge with another road beside it at its level, within 0.35 m, has no barrier or wall, and a gap of up to 2.5 m is filled with deck.
- **Opposite ways:** one median barrier in the middle of the gap, drawn once (`js/structures.js`).
- **The measure:** check-roads gained "walls". In the CBD sample, **4,070 m stood in another road's lane before, 1,248 m now.** The ratchet is at 1,260. What's left is data:
  - 542 m: medians where opposite carriageways are drawn overlapping. The Cahill over Circular Quay is one.
  - 686 m: roads 0.35-0.5 m apart in height.
- **Picture:** `recordings/plan5/b-south-end-before-after.jpg` shows the walls in your picture 1 gone.

### C (built, not proven)

**Stable ids** (`tools/tiles/stable-ids.mjs`, used by `build-tiles`). Nodes, roads, structures and kerb islands keep the ids the committed tiles have, matched by points, names and outlines. New ones take the next id. Gone ones leave a gap.

- `RG.links` is sparse now, and `build-tiles` skips the gaps.
- **Kerb islands were numbered across the map too.** That caused 351 tile changes until they had stable ids as well.

**Why the build wasn't repeatable:** `build-geodata` read `low-decks.json`, which the last build's heights step left, on its first pass as well. **Fixed:** only the second pass (`--reuse-rasters`) reads it.

- `build-geodata --reuse-rasters` run twice from the same inputs gave identical output.
- **Not done yet:** two whole builds in a row compared.

**Structures split by kind** (`findStructures()` in `build-tiles`). A bridge and a tunnel meeting at a node are two structures now. Before, any tunnel link made the whole group a tunnel: the Cahill's viaduct over Circular Quay was one.

**Hand edits:** `tools/local-edits.mjs`, read by `build-geodata` from `tools/local/*.json`. Each edit has `ids`, `expect`, `tags` or `remove`, and `why`.

**`tools/tile-diff.mjs [--accept] [--list]`** says which tiles changed against git, and fails if any changed outside the boxes in `tools/local/`.

**Today's builds against HEAD:** about 117 tiles changed outside the bridge's box.

- **Mostly trees**, half a metre or one tree in a tile. HEAD's map data wasn't a clean build of the current generators, so that's a one-off.
- The rest: a few kerb islands, from the repeatability fix, and the structure split.

### D (mostly built)

**The map:**

- **The corridor is OSM's northbound carriageway:** 4 lanes, 14.7 m, one way (`CORRIDOR` in `build-geodata`).
- **OSM's ways east of it are kept, and marked deck where they're all on it** (`DECK_EAST` in `build-geodata`, s 170-1800 m, 4.5-28 m east). That's the southbound Bradfield, and the Cahill's lanes, including the one through the east pylons.
- **The heights solver** gives all deck roads the deck's profile, as it did the corridor. Its `inDeck` and the low decks are asymmetric now.
- **Joins** go to the corridor only.
- **`world.json` has `deckSpan`:** every 10 m along, the deck roads' west and east edges, and the gap before the easternmost lane. `js/bridge.js` reads it with `deckSpanAt()`, `deckGapAt()` and `onDeckSpan()`.
- **Deck roads use their own width** in `js/surfaces.js`. `DECK_HALF` is no longer used.

**The model** (`js/harbour-bridge.js`), with its layout in `layout(s)`:

- From the roads: the cycleway, two tracks, the west truss, the road, the east truss in the gap, and the footway.
- The pylons 282 m either side of the middle, where OSM has the real ones, about 30 m further out than before. The arch spans its 503 m bearings.
- Round-headed arches 11 m high through each pylon: the railway and cycleway on the west, the Cahill's lane and the footway on the east. Colliders are only the granite either side of each opening.
- Gantries where the video has them, with a light over each of the deck's lanes, from `GEO.bridgeLinks`, which now carry lanes and direction. Lane numbers 1-8 before each gantry, and the footway's wire cage between the pylons.
- **Pictures:** `recordings/plan5/d-bridge-*.jpg`. They're right, except for the empty space where the bus lane goes.

**The bus lane between the pylons** (OSM 1452495983) was left out: it's `access=no`, and the build drops roads cars can't use. The edit in `tools/local/harbour-bridge-cbd.json` takes `access` off. The build with it was the one I stopped.

**Better** (half done) would be to keep `access=no` and give the road flag 32:

- **Done, the game's side:** `busOnly` on road-network edges, and traffic keeping cars out (`js/road-network.js`, `js/traffic.js`).
- **Not done, the generator's side:** in `build-geodata`, let `driven()` take `access=no` with `psv`/`bus=designated`, and set `| 32` in `flags`. Then the edit shouldn't null `access`.

`harbour-bridge` scenario: its lanes and southbound start point are updated for the new carriageways (`DECK_LANES`, `DECK_NORTH_END`). It hasn't been run.

### E (started)

Hand edits in `tools/local/harbour-bridge-cbd.json`:

1. **The Clarence St ramp's chain:** `oneway=yes`, the tidal-flow lane northbound.
2. **The Cahill loop** (way 172774931): `tunnel=yes`, so it's drawn as the tunnel's open cutting with vertical sandstone walls. In the data it came out as a tunnel. **Not looked at in the game yet.**
3. **The bus lane,** above.

**Not done:**

- The kerb islands between motorway carriageways at the south end: the paved wedges in `recordings/plan5/south-end-median.jpg`.
- Pictures at your three issue spots after the data changes.
- The gantry in `3.png` with its words.
- Medians as bollards.

### F

New routes in `LEVEL_ROUTES`:

- `bridgeClarence`: the video's drive.
- `grosvenorUp` and `cahillLoopUp`: ways up.
- `westernSuburbsOff`, `grosvenorOff` and `cahillOff`: ways off.
- `yorkStreetOff`: changed to start on the southbound carriageway.

`bridge-ways` drives them all. None of it has been run.

## What fails now, and why I think so

**Unit tests:**

- **`the Harbour Bridge carries traffic both ways, end to end`, and `traffic can reach both sides of the harbour`:** they assume the corridor is two-way. They should look for southbound over the southbound carriageway.
- **`the footway holds a walker to it…`** (`tests/arrivals.test.mjs`): the footway's offsets are from the east edge of the deck's roads now (`FOOTWAY` in `js/arrivals.js`).
- **`a ramp leaving the Harbour Bridge keeps its own level…`, and `the pylons stand clear of the deck…`** (`tests/terrain-bridge.test.mjs`): they're written around `HALF_WIDTH` and the old pylon placement.

**Road check, dead stops:** 3,306 m at 45 places, all on the deck: the Cahill Expressway and the Bradfield Highway southbound, s about 1,000-2,000. Something about the deck roads east of the corridor leaves lanes with no surface under them. Where to look first:

- **Which structure they're on.** With the split by kind, are the east deck roads in the deck structure (`DECK_STRUCTURE`), or a structure of their own? `chooseSurface` and `structuresAt`'s deck rule treat only that one specially.
- **`check-roads`'s `walk()`.** It may still assume the deck is the one corridor.
- **The lanes road-network makes** for these links: one-way links of 5-8 m.

## Next steps, in order

1. **A clean full build:** `npm run data:build`, 31 minutes and about 9 GB. Do the bus-only flag in `build-geodata` first (above), and change the bus lane edit to keep `access=no`.
2. **Fix the dead stops on the deck,** then the five unit tests. `npm run check` must pass, and `walls` should stay at or under 1,260 m.
3. **`node tools/tile-diff.mjs`:** list what changed, with `--accept` for the one-off changes outside the box noted above.
4. **Repeatable:** run `npm run data:build` again with nothing changed. **No tile may change.** That's C's proof.
5. **Pictures of the bridge again,** with the bus lane:
   - `node tools/play/look.mjs out $(cat recordings/plan5/scripts/views1.txt)`. Its views were worked out from `bridgePoint()`.
   - **The east pylons must stand in the gap between the bus lane and the Cahill's lane.**
6. **E:**
   - The Cahill loop: how it looks.
   - The south end's islands.
   - Your three issue spots.
   - The gantry's words from `3.png`.
7. **F:** `npm run play -- --only=bridge-ways,harbour-bridge,orbit-follow`, then `--full`, the soak and the bench.
8. **C's trial edit:** widen one road near the bridge, and check only nearby tiles change.
9. **G, if there's time;** then `next_5.md`.

## Useful

- **Scripts from this session** (diagnostic, not part of the game): `recordings/plan5/scripts/`.
  - `tilecmp.mjs`: which parts of changed tiles differ.
  - `treecmp.mjs`: one tile's trees, before and after.
  - `decklinks.mjs`: the deck's roads, with s and offset.
  - `bridgeways.mjs`: OSM's ways along the bridge.
  - `walls.mjs` and `wallkinds.mjs`: walls left in lanes.
  - `topmap.mjs`: roads at their widths from above.
  - `framing.cjs`: the camera's framing over a grid.

  Run them from the repo's root.
- **Logs** of today's builds: `recordings/plan5/logs/`.
- **The first full build** this session took 31.5 min, at 9 GB peak.
- **Gotcha:** `build-tiles`, through derive, imports `js/` modules, the bridge's colliders among them. **Don't edit `js/` while a build is making tiles.** The steps before it import no game code except `js/house-styles.js`.
