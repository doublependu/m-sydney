# Plan 5: a rider on the bike, a camera that keeps you in view, and the Harbour Bridge's CBD end as it really is

Answers `ai/prompt_5.md`.

Nothing is implemented yet. The experiments ran from the scratchpad, against the game as it is. The only change to the repo is this file.

- **`dist/`,** which git ignores, was rebuilt with `vite build` alone, so it has no `sydney.html` until the next `npm run build`.
- **Pictures** from this are in `recordings/plan5/`, which git ignores. It has a `KEEP` file, so `npm run play` won't clear it.

## Your phone test

Palm Beach, at (6984, -30211), Thyra Rd & Barrenjoey Rd, with `?stats=1`:

| | Now | Stop 1 (`next_4`) | Spec |
|---|---|---|---|
| Loaded in | **1.55 s**, WebGPU, Low | 0.83 s | 2-3 s, 1 s great, 4 s at most |
| Last second | 60 FPS, 0 slow, worst 17 ms | 60 FPS, worst 22 ms | |
| Since load | 7:05, 72 of 26,715 frames slow (**0.27%**), worst 224 ms at 6:19, "GPU or browser" | 2:47, 0.6% slow, worst 162 ms | |
| City done | **14.1 s** | 20.6 s | |
| Memory | About 55 MB, 9 tiles | 153 MB in the CBD | 170 MB at Low |

**Frames are better:** fewer than half as many slow frames as at Stop 1. The worst frame again came while nothing the page timed was running.

**Load was slower,** though still inside the spec. Two things could explain it, and the readout can't tell which:

- **The cache.** If this was the first open after deploying Stop 2, nothing came from the phone's cache: Stop 2 renamed every tile.
- **Where it started.** The game starts where you left off, so it may have loaded somewhere other than at Stop 1.

Phase A puts both on the readout. A second open should be near 0.8 s again if it was the cache.

**55 MB** is what Palm Beach needs: it has few buildings. The CBD is still the heaviest place.

**You didn't say** whether the tab reloaded, or how the suburbs looked and moved (`next_4`'s list). Both are under "What I need from you".

## Short answers

**Bicycle:** the rider is drawn **22.5 m above the bike** at the start (`recordings/plan5/bicycle-no-rider.jpg`).

- `ride()` writes the rider's bones at the bike's own height (`js/pedestrians.js:1796`).
- `PersonCrowd.add()` then adds the ground's height, as it does for walkers, whose poses are written at zero (`js/pedestrians.js:1005`).
- It takes that height at the rig's x and z. A rider never sets them, so they stay at 0, 0, and the ground at the world's (0, 0) is 22.5 m.
- So the ground is counted twice, and at the wrong place.

**The camera losing you:** the chase camera aims 5.2 m ahead of you along *your* heading, whatever way it has been orbited (`js/cameras.js:222`).

- **Orbited 90°:** you sit 50° off the middle of the view in Walk, where the camera is 4.3 m back. On a phone held upright that's off the screen.
- **Orbited 180° in Walk or Cycle:** the camera is in front of you and nearer than its aim point, so it looks away from you and you're behind it.
- **Walk shows it most** because its camera is closest, 4.3 m, or 1.9 m pinched in. The car's is 6.9 m and the helicopter's 11.4 m.

**Moving where you look:** today it works the other way round. Four seconds after you let go of the camera, if you're moving, it swings back behind you (`js/cameras.js:198`). Phase A turns you towards the camera instead, gradually, and leaves the camera where you put it.

**The offline file:** it's possible, but only for the CBD.

- `sydney.html` holds 80 km² of tiles inside itself, 11.2 MB, the largest file in the deploy.
- The whole map is 65 MB of tiles, and Cloudflare takes 25 MiB a file at most.
- Phase A removes it, and everything that exists only for it.

**Keeping map changes local: we're not ready.** A road added near the bridge today would change nearly every tile on the map. Three reasons:

1. **Ids are counted across the whole map:**
   - **Nodes:** numbered in the order the build meets OSM's ways (`idOf()`, `tools/build-geodata.mjs:225`).
   - **Links:** numbered by their place in the list of all roads (`tools/build-tiles.mjs:133`).
   - **Structures:** numbered in the order of each one's first link (`findStructures()`, `tools/build-tiles.mjs:51`).

   Every tile stores these ids. Add or remove one road, and every id after it shifts.
2. **Only `build-tiles` is known to be repeatable.** `ai/future_of_map_data.md` found it gives the same bytes from the same inputs. The steps before it haven't been checked, and some run regions in parallel.
3. **Nothing reports which tiles changed,** or stops a change that reaches further than it should.

Phase C fixes all three before any of the bridge's data changes. **A build will still run over the whole map, 31 minutes, but only the tiles around a change will get new files.**

**The bridge's CBD end** differs from your references and the video in six ways:

1. **The bridge is one made-up road:** 23 m wide, six lanes, two-way (`tools/build-geodata.mjs:394`). The build drops OSM's own carriageways on the deck to make it. So:
   - There's no lane 7 or 8.
   - There's no bus lane.
   - There's no lane whose direction changes with the time of day.
2. **The model is too narrow:** 34 m wide against the real deck's 49 m, with the pylons standing outside it.
   - The railway and the Cahill Expressway's lane don't pass through the pylons' arches.
   - The arches are painted on.
3. **Your pictures 1 and 2: walls in the road.** Each raised road draws a barrier and a side wall along both edges (`js/structures.js:96-112`), even where another road runs right beside it at the same level.
   - **At the bridge's south end,** nine links of six structures meet side by side within 80 m.
   - **At the Cahill on-ramp,** the ramp and the main line are each drawn with both barriers, and they cross where the two merge.
4. **Your picture 3: the Cahill loop.** In the game it's a road on the ground in a cutting with sloping banks. Your `1.png` shows rock walls on both sides.
   - Three buildings inside the loop stand 3.6-3.9 m from its edge, on ground 2-5 m above the road.
   - Coming out of the tunnel mouth at (-337, -1377), a building's front fills the view where the road turns.
   - The road check finds a car's wheels on a kerb right there.
5. **The Clarence St ramp runs both ways at once.** OSM marks it `oneway=reversible`, meaning one way at a time, and the build made it two-way. The video drives up it northbound, at midday.
6. **Medians are lawn and raised kerb.** Your `2.png` and `6.png` show low concrete separators with yellow-and-black bollards.

**North Sydney, the stretch goal:**

- **Northbound** is covered by the video, from the north pylons up the Warringah Freeway past North Sydney (2:09 to about 4:10).
- **Southbound** has no reference yet. Phase G collects them, and some will need your Street View pictures, as you took for the CBD.

## Prompt items

| Prompt item | Status | Phase |
|---|---|---|
| Issue 1: bicycle, no rider and rising into the sky | Cause found, seen in a picture | A |
| Issue 2: camera doesn't keep you in view | Cause found | A |
| Feature 1: remove the offline file | Every piece found. Possible, but only for the CBD | A |
| Feature 2: moving forward turns towards where you look | Designed below | A |
| Keep map changes local | Not ready, for three reasons. Plan below | C |
| Bridge, CBD end: the video and your six pictures | Studied, below | D, E, F |
| Bridge issue 1: things poking out of the road at the south end | Cause found | B, E |
| Bridge issue 2: walls in the middle of the Cahill on-ramp | Cause found | B, E |
| Bridge issue 3: a building blocking the Cahill loop | Cause found | E |
| Bridge, North Sydney end (stretch) | Northbound references in the video. Southbound to find | G |
| Phone test | Read, above | A, stops |

## Measurements

### The bicycle

At the start (397, -990), the bicycle has no one on it: `recordings/plan5/bicycle-no-rider.jpg`. The ground there is 28.0 m, and at (0, 0) it's 22.5 m. So the rider is drawn at about 50 m, 22.5 m above the bike.

I haven't watched a ride. The fix's test checks the rider's seat and hands as the bike moves, climbs and leans.

### The camera

| Mode | Camera back | Pinched in (×0.45) | Aim point | Where you are at 90° of orbit |
|---|---|---|---|---|
| Walk | 4.3 m | 1.9 m | 5.2 m ahead, 3.1 m up | 50° off the middle (70° pinched in) |
| Cycle | 4.8 m | 2.2 m | 5.2 m ahead | 47° |
| Drive | 6.9 m | 3.1 m | 5.2 m ahead | 37° |
| Fly | 11.4 m | 5.1 m | 5.2 m ahead | 25° |

A phone held upright shows 48° across, so 24° either side of the middle. At 90° you're off its screen in every mode, or only just on it in Fly.

At 180°, the camera is in front of you:

- **Walk and Cycle:** it's nearer than its aim point, so you're behind it.
- **The car and helicopter:** you happen to be in line with the aim point, so you show.

### The offline file

What exists only for it:

- **The build:** the `offline` mode, `vite-plugin-singlefile` and the `offline-tiles` virtual module (`vite.config.js`, `package.json`). The second build in `npm run build`.
- **The game:** `INLINE` in `js/geodata.js`.
- **The page:** the two "Download to play offline" links (`index.html:66`, `:97`) and their CSS (`css/style.css:278`).
- **The tests:** the `offline-file` scenario, and its entries in `tools/play/run.mjs` and `tools/play/affected.mjs`.
- **Text:** the README's line about it, and comments in `js/interiors.js` and `js/city-map.js`.

The app's manifest, for adding it to a home screen, stays.

### The bridge in the video

"Driving across the Sydney Harbour Bridge, 2023", from Clarence St. A frame every 3 s is in `recordings/plan5/video-bridge-*.jpg`.

| Time | Where | What's there |
|---|---|---|
| 0:00-0:15 | Clarence St, northbound past No. 55 | Two or three lanes, 40 km/h, signals at each cross street. A red bus lane on the left from 0:12 |
| 0:18-0:30 | Under the Western Distributor | "Harbour Bridge ↑, Kent Street left lane" |
| 0:33-0:45 | The Clarence St ramp | Kent St off to the left, then one lane climbing beside a grass bank and trees. "End 40", "Start variable speed limit zone", a 70 sign on a gantry |
| 0:45-0:51 | Joining the Western Distributor | Our lane comes in on the right, behind a separator with yellow-and-black bollards, as in your `6.png` |
| 0:54-1:06 | The approach, by Observatory Hill | Five or six lanes under lane-control gantries: a green arrow or red cross over each lane, and 70 km/h |
| 1:09-1:33 | The approach viaduct | The railway on the left behind a wall. A red bus lane at the far right, the southbound one. Gantries with signals for lanes 1-5, and lane numbers painted on the road |
| 1:36-1:39 | South pylons | The railway goes through the west pylon's arch. The road goes between the pylons |
| 1:42-2:06 | Under the arch | Hangers each side, lane signals hung from the arch's bracing (lanes 1-6) |
| 2:09-2:12 | North pylons | Lane numbers 2 3 4 5 painted again |
| 2:15-2:39 | North approach | Railway on the left, a train at 2:33, Milsons Point station at 2:39 |
| 2:42-4:10 | Warringah Freeway | Exits for Kirribilli (Lavender St), North Sydney (Pacific Hwy) and Crows Nest (Falcon St). Sandstone cuttings, overpasses. The play area ends about here |

### Your pictures

| Picture | Where | What it shows | The game today |
|---|---|---|---|
| `ref/details/1.png` | The Cahill loop | Vertical sandstone walls on both sides, a footbridge over it, "Cahill Expy" painted | Sloping grey banks (`recordings/plan5/cahill-loop-cutting.jpg`) |
| `2.png` | South end, southbound | A red bus lane on the left, low separators with bollards | Lawn and kerb medians (`south-end-median.jpg`) |
| `3.png` | South end, southbound gantry | "Bus lane 24 hrs", "Bus lane", "Western Suburbs", "City South, Darling Hbr", "Grosvenor St, City North" | A street-name sign |
| `4.png` | North pylons, from the east footway | The footway in its cage, the Cahill lane through the pylon's arch, the bus lane, then southbound lanes | Pylons outside a 34 m deck, nothing through them |
| `5.png` | The deck, northbound | The railway through the west pylon's arch, four lanes north | The same as `4.png` |
| `6.png` | Western Distributor, northbound | "A4" painted, three lanes, and the Clarence St lane beside them behind bollards | Separate carriageways with kerbs |

Your six bridge notes, read against the video and OSM:

- **The deck,** from west to east:
  - The cycleway.
  - Two railway tracks, through the west pylons' arches.
  - The main roadway, lanes 1-6. The lane signals set which way each runs, and it's four north in the video.
  - The bus lane.
  - The Cahill lane, through the east pylons' arches.
  - The footway, in its cage.
- **OSM agrees in part.** On the bridge it has 4 lanes north and 2 south of Bradfield Highway, and 2 of the Cahill Expressway on the east side.
- **Where the bus lane sits** needs checking against pictures in Phase D. Your `4.png` puts it beside the Cahill lane, between the pylons.

### The CBD end in today's map

`recordings/plan5/map-bridge-south-end.jpg` draws every road at its width, from above. Bridges are orange, tunnels blue, the corridor purple, and buildings brown.

**South end, from z = -1000 to the corridor's start at (-323, -1384):** eleven roads run side by side within 60 m. In OSM's names:

- Western Distributor and its on-ramps.
- Bradfield Highway and its on-ramps.
- York St off-ramp and Grosvenor St.
- Two unnamed links.

They meet the corridor through six structures (95, 229, 4, 688-691) inside 80 m.

**What the road check finds here** (`node tools/check-roads.mjs`):

| Where | What |
|---|---|
| Bradfield Highway Onramp (-333, -1075) | A 0.49 m step, and 17.4% roll a metre |
| Unnamed link (-334, -1126) | 17.6% roll a metre |
| Bradfield Highway Southbound (-279, -1323) | A 0.36 m step |
| Bradfield Highway (-322, -1373) | A 0.26 m step |
| Cahill Expressway (-347, -1381), the loop's entry | 6.9% roll, a wheel on a kerb |

**None of it sees the walls.** The check looks for kerbs and buildings in lanes, not barriers.

**The Cahill westbound** runs over Circular Quay on its own viaduct, structure 94. It ducks through a short tunnel under the approach (OSM ways 203551951 and 282238522, the only part tagged as a tunnel). It comes out at (-337, -1377) and goes round the loop to join the bridge northbound.

**The loop is on the ground,** not a structure:

- Its road is at 31-35 m, and the ground inside the loop at 36-39 m.
- The cutting between them is the ground graded down to the road, so it slopes.

**The on-ramp from Conservatorium Rd** (`map-cahill-onramp.jpg`) joins the westbound Cahill as part of structure 94 at (405, -1329). Both are bridges, and both draw barriers on both sides, so where they merge the barriers cross: your picture 2.

**Structure 94 counts as a tunnel all the way,** from Macquarie St to the loop. `findStructures()` makes a whole structure a tunnel if any of its links is one (`tools/build-tiles.mjs:73`). The rule that a tunnel's walls hold, so nothing moves sideways out of it (`chooseSurface()`), applies to the viaduct over Circular Quay too.

## Decisions

Say so if you want any of these changed.

1. **The quick fixes come first,** then a stop for your phone. None of them changes a tile.
2. **The chase camera aims at you,** leading a little in the camera's own direction, so you stay in the middle at any orbit, pitch and zoom.
3. **Moving forward turns you towards where the camera looks,** over about a second. The camera stays where you put it.
   - **Walk, cycle and fly** turn at their own rate, all the way round if you look behind.
   - **The car** steers there through its own steering, so it drives an arc, not a spin on the spot. It does this only within 90° of where it's heading: look further round and it's a look, and the camera comes back behind you as now.
   - **Steering yourself** (A/D, the stick's sideways part, the gamepad) takes over and stops the turn.
   - **Reversing never turns you.**
4. **The offline file goes, all of it.**
5. **Map changes are made local before the bridge's map data changes** (Phase C). After that, a commit of the bridge's work touches only its tiles and a few whole-map files.
6. **Hand edits to the map live in a committed file per area,** `tools/local/<area>.json`.
   - **Why a file:** `tools/data/` isn't in git, and OSM changes under us.
   - **Each edit says what it fixes and its source,** like a picture or a time in the video.
   - **Where OSM itself is wrong,** you may want to fix it there too. I won't edit OSM.
7. **The bridge carries its real roads.** OSM's carriageways replace the made-up corridor's link, with the real lane order and a deck about 49 m wide. The corridor stays as the line and profile the model and the deck's height are drawn from.
8. **The afternoon layout, at every time the game has.** That's four lanes north and the Clarence St ramp northbound, as in the video. The game's times are midday, golden hour, twilight and midnight, with no morning. The lane signals show the layout. Say if you want a morning setting, with three lanes north and the ramp southbound.
9. **Roads side by side at one level share one deck,** with no wall between them:
   - **Where they part:** painted chevrons until there's a car's width between them.
   - **Then:** a low concrete separator with bollards, as in your pictures. Never lawn on a motorway's median.
10. **The Cahill loop is a cutting with vertical sandstone walls.**
    - **What stays above the walls:** the buildings inside the loop, if the references show them there.
    - **What goes:** a building the references don't show.
    - **The footbridge** in your `1.png` crosses it.
11. **North Sydney waits** until the CBD end has passed its checks and your phone test, and has references.
12. **Drives, not only pictures, prove the bridge works.** The video's route, and each way on and off, become scenarios in `npm run play`.

Plan 4's decisions stand.

## Phases

| Phase | Result | Size |
|---|---|---|
| A | A rider on the bike, a camera that keeps you in view and steers where you look, no offline file, two lines on the readout | Small-Medium |
| B | No walls between roads side by side, and a check for it | Medium |
| | **Stop 1: your phone** | |
| C | Local map changes: ids that don't shift, a repeatable build, a guard on which tiles change, the hand-edits file | Medium-Large, uncertain |
| D | The bridge itself: its real roads, width, pylons with arches, footway, cycleway, lane numbers, the bus lane, gantries | Large |
| E | On and off at the CBD end, and your three issues | Large |
| F | Drives and pictures beside the video and your references | Medium |
| | **Stop 2: your phone, `next_5.md`** | |
| G | Stretch: the North Sydney end | Large |

## Phase A: Bicycle, camera, offline file, readout

1. **The rider sits on the bike.**
   - `ride()` sets the rig's x and z to the bike's, and writes its pose relative to the ground there, as walkers' poses are.
   - It's checked parked, riding, climbing a ramp, leaning in a turn, and on the bridge's deck.
2. **The chase camera aims at you.**
   - The aim point is your chest, plus a short lead in the camera's own direction (`totalYaw`), not your heading.
   - The lead shrinks to nothing as the orbit grows, so at 180° the camera looks straight at you.
   - Pitch and zoom keep you in the middle too. The low action camera, which doesn't orbit, and the cockpit view are unchanged.
3. **Moving forward turns you to the view** (decision 3).
   - While you hold forward with no steering, your heading eases towards the camera's yaw, and the orbit offset shrinks by the same amount, so the camera doesn't move.
   - Its own turn rate in each mode. The car's goes through its steering, within its lock and grip.
   - Keyboard, touch stick and gamepad alike.
   - The 4-second swing back behind you stays only for when you aren't pressing forward, and for the car beyond 90°.
4. **No offline file:** everything listed under "The offline file" above goes. `npm run build` becomes one Vite build, and the deploy loses its largest file.
5. **The readout** gains two lines:
   - Where the game loaded.
   - How many of the files it fetched came from the browser's cache, from the browser's own timings. That answers the 1.55 s question next time.

**Done when:**

- **A unit test** puts the rider's seat on the saddle and hands on the grips within 5 cm, at a place where the ground is far from 0.
- **A new `orbit-follow` scenario,** in each mode, drags the camera round 360° and up and down. The player stays in the middle third of a phone's screen and a desktop's, then moves forward and turns to within 3° of the view in 2 s, while the camera's yaw moves under 2°.
- **The car** holds its line with A or D pressed.
- **The build:** `dist/` has no `sydney.html`. `check-dist`, `npm run check`, `npm run play` and `viewports` pass.

## Phase B: No walls between roads side by side

1. **One test for "this edge is open":** the ground just past a raised road's edge is another road at the same level, within 0.3 m.
   - Where it's open, there's no barrier and no side wall, and a strip of deck closes the gap between the two.
   - It lives in `js/surfaces.js`, and drawing (`js/structures.js`), colliders and the road check all use it.
2. **Where two roads part:** chevrons on the shared deck until they're a car's width apart. Then a low separator, with bollards on motorways. Where one rises or falls away, the barrier comes back.
3. **Tunnels' and cuttings' walls** follow the same rule, where two of them run together open to the sky.
4. **check-roads gains "walls":** metres of barrier or wall standing in another road's lane. It starts as a ratchet at today's number, over the CBD sample, then the whole map.

This changes no tile, but it changes every merge of raised roads on the map. Pictures at a dozen merges beside your two:

- Where the Western Distributor meets the Anzac Bridge.
- The M4 and M5 ramps.
- The Eastern Distributor.

They show that no barrier went from where a road is higher or over air.

**Done when** "walls" is 0 m in the CBD sample and no worse anywhere, pictures at your rec 1 and rec 2 spots show no walls in the road, and every scenario passes.

### Stop 1: your phone

I'll write a short note in `next_5.md` and tell you. You commit and deploy. Then on the phone, with `?stats=1`:

1. **Open it twice,** and note both load times and the new cache line.
2. **Ride the bike a few hundred metres.**
3. **In each mode,** drag the camera round you, then move forward.
4. **Drive the bridge's south end and the Cahill on-ramp.** The walls should be gone. The roads themselves change only in E.
5. **Send the readout,** and say if the tab reloaded.

## Phase C: Local map changes

1. **A repeatable build.**
   - **The test:** `npm run data:build` twice from the same inputs, into two scratch copies, and compare every generated file and tile byte for byte.
   - **Then:** fix what differs. Likely suspects are regions finishing in a different order, and maps read in the order things arrived.
   - **Node is pinned:** the build checks that its Node and zlib are the ones that wrote the committed tiles. Another zlib renames every tile (`ai/future_of_map_data.md`).
2. **Ids that don't shift.**
   - **When:** right after `build-geodata` numbers the roads, a step matches the new graph to the last build's. Those are the committed tiles in `public/tiles/`, so a fresh clone works the same.
   - **How things match:** nodes by position, since they're on a 0.1 m grid; links by their ends and shape; structures by their links.
   - **What happens to each:** what matches keeps its id. What's new takes the next one past the end. What's gone leaves a gap, which the game skips. That's 8 bytes of node array a gap.
   - **One fix with it:** a structure is a tunnel only where its links are (the Cahill over Circular Quay).
3. **Hand edits:** `tools/local/<area>.json`, applied where `build-geodata` and `build-buildings` read OSM and Overture, so every later step sees them as data.
   - **What an edit can do:**
     - Set a way's lanes, width, direction, level or kind of wall.
     - Add a way, or remove one.
     - Keep, move or remove a building.
   - **How it's addressed:** by OSM id, with the build stopping if that way has changed in OSM since the edit was made.
4. **`tools/tile-diff.mjs`.**
   - **What it lists:** which tiles, far squares and whole-map files changed against git.
   - **When it fails:** if a tile changed outside the areas named in `tools/local/`.
   - **`--accept`** is for a change meant to reach the whole map, like a new field in every tile.
5. **The map screen's images** redraw by area: `npm run data:map -- --area=x0,z0,x1,z1`.

A rebuild of only one area, without the whole-map run, would need every step to take an area and merge with the last results. It isn't needed for git's sake, so it isn't in this plan.

**Done when:**

- **A rebuild with no edits changes no tile.**
- **A trial edit near the bridge,** one road 0.5 m wider, changes only:
  - The tiles within about 1 km.
  - `world.json`, `far.json.gz` and `map.json.gz`.
  - The far square around it.

  If the heights solver spreads tiny changes further, heights outside the area are held at the last build's, with fixed seams. That's what the raster work does already.
- **`tile-diff` lists that trial edit, and fails on one outside its area.**

**If making the build repeatable changes the output,** that's one more commit that rewrites every tile, on its own, before the bridge.

## Phase D: The bridge itself

**The map:**

- **The real roads on the deck:** `build-geodata` keeps OSM's carriageways there, with the lanes in the order under "Your pictures", and joins the approaches to them as they are in OSM.
- **The deck's height:** each carriageway takes it from the corridor's profile at its offset, so the deck stays one surface.
- **The bus lane** is a bus-only link, if traffic doesn't have one yet: buses use it and cars don't.
- **The Cahill lane** ends at the Cahill Expressway, and the bus lane at York St's bus lanes.
- **The lane the time of day decides** is its own link, open northbound (decision 8).

**The model** (`js/harbour-bridge.js`, `js/bridge.js`):

- **The deck is about 49 m wide,** with the arch's hangers where the video shows them.
- **Four pylons with real arched openings:** the railway goes through the west pair and the Cahill lane through the east pair. The main roadway runs between them. Measured from the pylons' outlines in the building data and from pictures.
- **The footway** along the east, inside its mesh cage, with its lamps. **The cycleway** along the west behind its fence.
- **Lane-control gantries** where the video has them: 0:57, 1:06, 1:21, 1:33, 1:57 on the arch's bracing, 2:06, 2:18 and 2:27. Each has a green arrow or red cross from the lanes' directions, and 70 km/h signs.
- **Lane numbers** painted where the video shows them, and the bus lane in red.
- **Built once,** as now. Gantries and cage are instanced or merged, so the bridge adds few draws. Its triangles are counted before and after.

**Done when:**

- **The deck** measures about 49 m with its lanes in order.
- **Every lane drives end to end** with no stop, no step over 5 cm, no lean over 4% and no roll over 2% a metre.
- **Traffic runs:**
  - Buses take the bus lane.
  - Cars don't.
  - Nobody meets anyone head-on.
  - `check-traffic --at=bridgeDeck` stops no more cars than now.
- **The railway passes through the west arches,** and the Cahill lane through the east ones.
- **Pictures at the video's 1:21, 1:36, 1:39, 1:57 and 2:12,** and at your `4.png` and `5.png`, sit beside their references.
- **On the phone profile,** load, shader compile and frames are no worse, and the bridge's draws and triangles are reported.

## Phase E: On and off at the CBD end

**Northbound, the four ways up** (your notes and `6.png`):

1. **Clarence St:** its ramp, one lane, made one-way northbound (decision 8). It runs beside the Western Distributor behind bollards, then merges.
2. **The Western Distributor:** three lanes.
3. **Grosvenor St,** from Bridge St: joins on one side.
4. **The Cahill loop,** from the Cahill westbound: out of its tunnel, round the loop in its rock cutting, joining on the other side.

Then the lanes come down to the bridge's four, under the gantries.

**Southbound, the ways off** (`2.png`, `3.png`):

- **The Cahill lane** widens to two, turning left onto the Cahill eastbound.
- **The bus lane** becomes York St's two bus lanes.
- **The main lanes** become:
  - Two for the Western Suburbs.
  - Two for City South and Darling Harbour.
  - Two merging lanes for Grosvenor St and City North.
- **The gantry in `3.png`** is drawn with its words, by the game's own sign code.

**For each:** OSM's lanes, splits and levels are checked against the video and your pictures. Where they differ, there's a hand edit in `tools/local/harbour-bridge-cbd.json`.

**Your three issues:**

1. **The south end, rec 1:** B took the walls away. E puts the merging roads on one level and one deck, so B's rule applies. It also removes the steps of 0.26-0.49 m and the roll of up to 17.6% found on the ramps, at (-333, -1075), (-334, -1126), (-279, -1323) and (-322, -1373).
2. **The Cahill on-ramp, rec 2:**
   - The ramp from Conservatorium Rd merges onto the westbound Cahill on one deck.
   - The westbound Cahill is a viaduct over Circular Quay, beside the eastbound one, not a tunnel (C's fix).
3. **The Cahill loop, rec 3:**
   - A cutting with vertical sandstone walls, with the footbridge over it.
   - The road keeps its width all the way round, and no wheel touches a kerb at its entry.
   - The buildings inside are checked against the references: they stand back on the land above the walls, or go.

**Done when** the area's roads drive with:

- No stop.
- No step over 5 cm.
- No lean over 4%, and no roll over 2% a metre.
- No kerb under a wheel, and no wall in a lane.

Pictures at your three issue spots show the road clear. `tile-diff` shows only the area's tiles changed.

## Phase F: Drives and pictures

- **New scenarios in `npm run play`:**
  - **`bridge-clarence`:** the video's route, from Clarence St at Margaret St to the north pylons.
  - **One for each way on and off at the CBD end:** Western Distributor, Grosvenor St, the Cahill loop, Clarence St going north; the Cahill, York St, the Western Distributor and Grosvenor St going south.

  They fail on any stop, wall, step or kerb, and on the car leaving its lane.
- **Pictures at each time in the video's table,** beside its frame, and at each of your pictures, in `ref/details/game/`. Like `ref/`, they stay on this PC.
- **`check-traffic`** at the south end and on the deck: merges flow, and the queues are those of lights, not of a lane that ends where it shouldn't.

**Done when** every scenario passes three times with different seeds, and the pictures go in `next_5.md` for you to judge.

### Stop 2: your phone

`next_5.md`, then on the phone, with `?stats=1`:

1. **Drive the video's route,** Clarence St to North Sydney.
2. **Come back over the bridge,** taking each way off in turn.
3. **Take the Cahill loop up,** and the Cahill on-ramp from Macquarie St.
4. **Send the readout,** and say if the tab reloaded.

## Phase G: North Sydney (stretch)

**References first:**

- **Northbound:** the video from 2:09 to about 4:10.
- **Other sources:**
  - **Wikimedia Commons and Mapillary,** whose licences allow it.
  - **Your Street View pictures** of what neither has, as for the CBD.
- **What's needed:**
  - The north pylons and Milsons Point station from the road.
  - The Kirribilli exit at Lavender St.
  - The on-ramps southbound.
  - The Pacific Highway and Mount St ramps.
  - The Warringah Freeway's start, and its cuttings to Falcon St.

**Then the same work as D to F,** in `tools/local/harbour-bridge-north.json`.

**Done when** the same as E and F, for the north end.

## Not in this plan

**From `next_4`:**

- Dead stops to zero.
- Houses' second pass: doors, fences, verandahs, garages, yards.
- Redrawing the whole map screen: only the bridge's area is redrawn here.
- Katoomba.

**From earlier:** the leftovers listed in `ai/plan_4.md` still stand.

**Speed:** a faster build that reruns only an area (Phase C says why).

## Risks

| Risk | Why | Plan |
|---|---|---|
| Ids that don't shift are harder than they look | Generated files are keyed by link id, and a few things by position | Start from a rebuild that must change nothing, so any slip shows at once |
| The build isn't repeatable | Regions run in parallel | C finds it before anything depends on it. If fixing it changes every tile, that's one commit on its own |
| Replacing the corridor's link breaks things | The deck's height, `bridgeAt()`, the model, traffic and the `harbour-bridge` scenario all read it | The corridor stays as the deck's line and profile. Only the roads on it change, with every scenario run |
| The bridge costs frames | It's in view from the start, on Macquarie St | Built once, instanced, counted, and measured on the phone profile |
| B takes away a barrier that should stay | It changes every merge on the map | Only where the next road is within 0.3 m of the same level, with pictures at a dozen merges |
| The car's turn to the view feels wrong | Most driving games swing the camera back instead | Only within 90°, and your own steering always wins. Your Stop 1 says |
| References | Street View pictures are Google's. The video's source wasn't found online | Kept in `ref/`, which git ignores, and only looked at |
| OSM is wrong about the bridge, and fixing it there would take time | | Hand edits with their sources, in `tools/local/` |

## What I need from you

1. **About your phone test:**
   - Was the 1.55 s the first open after deploying Stop 2?
   - Did the tab reload?
   - Anything about how the suburbs looked and moved, from `next_4`'s list?
2. **The phone tests at both stops.**
3. **Two choices:**
   - The afternoon layout at every time, or a morning setting too (decision 8).
   - The car turning to the view only within 90° (decision 3).
4. **For North Sydney,** Street View pictures of what Phase G lists, when we get there.
5. **Commits:**
   - Stop 1 changes no tiles.
   - Phase C may change every tile once, if the build has to be made repeatable. That's best committed on its own.
   - After that, the bridge's work should touch only its own tiles.

## Sources

- **Measured from the game:**
  - Code: `js/pedestrians.js`, `js/controllers.js`, `js/cameras.js`, `js/structures.js`, `js/surfaces.js`, `js/bridge.js`, `js/harbour-bridge.js`, `js/geodata.js`, `vite.config.js`, `index.html`.
  - Tools: `tools/build-geodata.mjs`, `tools/build-tiles.mjs`, `tools/build-heights.mjs`, `tools/check-roads.mjs`, `tools/play/look.mjs`.
  - Data: `public/tiles/world.json`, and the OSM extract in `tools/data/east/`.
- **Pictures:**
  - `recordings/plan5/`: the maps from above, the bicycle, the median and the loop, and frames from the video.
  - Your `ref/details/1-6.png` and `recordings/details/1-3.png`.
  - "Driving across the Sydney Harbour Bridge, 2023" in `ref/`.
- **The bridge's layout:**
  - [Sydney Harbour Bridge, Wikipedia](https://en.wikipedia.org/wiki/Sydney_Harbour_Bridge): a deck about 49 m wide, eight road lanes and two railway lines. Six lanes on the main roadway and two on the east side, which were tram tracks, are the Cahill Expressway's, one of them through the east pylons. The main roadway's lanes are set by red and green signals over each lane.
  - [Engineers Australia, heritage: Sydney Harbour Bridge](https://heritage.engineersaustralia.org.au/wiki/Place:Sydney_Harbour_Bridge).
  - Which lane is numbered 7 and which 8 isn't confirmed by either. Transport for NSW would know.
- **OSM tags,** from the extract: the bridge's carriageways (ways 1530532874-1530532878 and others), the Clarence St ramp's `oneway=reversible` (ways 295950855, 936359078 and others), and the Cahill's short tunnel (203551951, 282238522).
