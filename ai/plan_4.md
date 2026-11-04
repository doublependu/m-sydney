# Plan 4: tunnels with walls, nothing standing in the road, a loading bar that always shows, no reloads on the phone, folders GitHub can show, and suburbs that look, move and sound like suburbs

Answers `ai/prompt_4.md`. Katoomba is postponed as you asked: its plan is in `ai/map_expension.md`.

Nothing is implemented yet. The experiments ran from the scratchpad, against the game as it is. The only changes to this repo are this file and `ai/map_expension.md`. `dist/`, which git ignores, was rebuilt once.

## Your phone test

iPhone 16e, Safari, from Macquarie St, left into Bridge St and up onto the Harbour Bridge, with `?stats=1`:

| | Now | Stop 1 (`next_3`) | Spec |
|---|---|---|---|
| Loaded in | **1.03 s**, WebGPU, Low | 0.84 s | 2-3 s, 1 s great, 4 s at most |
| Last second | 60 FPS, 0 slow, worst 17 ms | The same | |
| Since load | 5:27, 240 of 22,594 frames slow (1.1%), **worst 225 ms** at 2:47 | 15:49, 505 of 57,325 slow (0.9%), **worst 836 ms** at 0:26 | |
| City done | **21.6 s** | 29.3 s | |
| Tiles held | 10 | 12 | |
| Tab reloaded | **Once, flying north** | Never | |

**The load stall `next_3` fixed is gone.** The worst frame fell from 836 ms to 225 ms, and the city finishes 8 s sooner. The 225 ms frame came 2:47 in, while you were driving, and the readout doesn't say what the game was doing then. Phase A adds that.

**The reload is the most important result.** The game never reloads by itself (`js/main.js:104`). Safari reloads a tab when iOS has killed it, and memory is the usual reason. iOS gives no memory figure, so the readout couldn't show it coming. See "Memory" below and Phase F.

## Short answers

**Harbour Tunnel, walls:** its two tubes run 3-4 m apart over the middle, centre line to centre line, and each road is 8.1 m wide. So each tube's walls stand in the middle of the other's road. The walls aren't solid. A car keeps to a tunnel only because there's no road at the same height beside it. Here there is one, so you can drive through. It isn't only the Harbour Tunnel: over the whole map, **15.4 km of covered tunnel overlaps another tube**, mostly in the M5 East, the Eastern Distributor and the Harbour Tunnel.

**Harbour Tunnel, water:** the sea is one flat sheet across the whole world at 2.2 m below zero (`js/city-grid.js:156`). Where a tunnel's road goes below that, the sheet passes through the inside of the tube. You see it ahead as the road dips, then drive under it. This is **7.3 km of covered tunnel** over the map, and most of it isn't under the harbour: the M8 has 2.8 km of it and the M4 East 2.3 km.

**Cahill Expressway:** the building is an OSM outline of 25 × 11 m at (331, -1344), with no height and no use given. The generator gave it the median height of the buildings around it, 20 m (`tools/build-buildings.mjs:146`). In the CBD that put its roof 8.7 m above the deck. Traffic doesn't test buildings on a deck, so the bus went through. Your car does, so you were stopped. Over the map, **25 buildings rise into a deck**.

**Bondi Junction:** Syd Einfeld Drive runs over Bondi Junction as a viaduct only 1-7 m above the ground. Trees, street lights and signs are placed without looking at what's overhead. A jacaranda stands through the deck in the picture I took, and a building does too, at (4218, 1394). Over the map, **82 trees are taller than the room under the deck above them**. **3,102 points of kerb are under a deck with less than 9 m of room**, where a street light can stand.

**Kerb in the sky:** I didn't find it on Bridge St itself. I took pictures at seven places along Bridge St and at the corner with Macquarie St, and scanned the map's kerbs. What the scan finds is kerbs leaving the road where it drops into a cutting. Kerb heights are taken every 8 m and joined with straight lines. So between a point on the cutting's floor and the next one on the ground above, the kerb climbs several metres into the air. The nearest to Bridge St is the Cahill Expressway on-ramp at Macquarie St, at (447, -1185), 6.5 m. **If that's not the one, Phase A puts your position on the readout so you can tell me where.**

**Loading bar:** after the city's first build, nothing uses it again. A teleport fades to black until the ground within 300 m is ready. Then the buildings, streets, trees and traffic around you arrive with nothing on screen to say so.

**Suburbs, traffic:** the number of cars only depends on how much road there is: one car per 80 m of lane within 350 m (`js/traffic.js:70`), up to 60 at Low. People are 120 at Low, wherever you are. So a street of houses in Cronulla has as many cars as Town Hall at Low, and the same crowd.

**Suburbs, houses:** in the suburbs, 87-96% of buildings come with no use from the data. They become plain boxes with flat roofs and the CBD's sandstone or brick, with office windows. Only 3-18% get a pitched roof.

**Suburbs, road markings:** every two-way road gets a centre line today (`js/road-paint.js:161`). In the four streets of houses I sampled, narrow local streets are 58-100% of the road length.

**GitHub:** GitHub's web pages show only the first 1,000 files of a folder, and its documentation recommends no more than 3,000 entries per folder. `public/tiles/` has 1,949 files and `public/map/2/` 1,854, so both are already cut off on the website. Git and Cloudflare don't mind. Katoomba would take both past 4,000.

**Population data exists at the right scale:** the ABS 2021 Census counts residents and dwellings for every Mesh Block, an area of 30-60 homes. There are 46,072 Mesh Blocks in today's box, and each has a land use: residential, commercial, parkland, education, industrial and so on.

## Prompt items

| Prompt item | Status | Phase |
|---|---|---|
| Plan for Katoomba in `ai/map_expension.md` | Written | |
| Folders past GitHub's limit | Measured, layout below | B |
| Postpone Katoomba | Yes | |
| Issue 1: Harbour Tunnel walls and water | Both causes found, map-wide counts | C |
| Issue 2: building through the Cahill Expressway | Cause found, 25 such places | D |
| Issue 3: Bondi Junction, trees and lights in the road | Cause found, seen in a picture | D |
| Issue 4: fewer cars, buses and people in suburbs | Cause found, data found | H |
| Issue 4: houses that look like Sydney's | Cause found, first references below | I |
| Issue 4: population data | ABS Mesh Blocks | G |
| Issue 4: no centre line on small streets | Cause found | J |
| Issue 5: loading bar missing after a teleport | Cause found | E |
| Issue 6: kerb in the sky on Bridge St | Likely cause found, place not confirmed | A, D |
| Feature: no eye button on the phone | Small | E |
| Phone test: reload flying north | Measured in Safari's engine, budget below | F |
| Other items from `next_3` and `next_2` | Chosen below | A, H, K |

## Measurements

Pictures for the places below are in the scratchpad, from the game's own `grab()`: `/tmp/claude-1000/-home-rx-Repos-mine-public-m-sydney/a86da613-870d-4434-981d-f914db751b82/scratchpad/look1/` and `.../look2/`. The scratchpad is temporary, so the ones that matter will be retaken into `next_4.md`.

### Tunnels

The Harbour Tunnel is two structures, 11 northbound and 12 southbound, each 8.1 m wide, at -11.8 m for about 1.4 km in the middle. Where they run side by side:

| z | Northbound x | Southbound x | Apart, centre to centre |
|---|---|---|---|
| -1315 (south end) | 453 | 463 | 10 m |
| -2249 | 297 | 300 | 3 m |
| -2702 | 213 | 217 | 4 m |
| -2900 | 126 | 146 | 20 m |

They'd need 9.9 m to keep their walls apart (4.65 m each to the wall, plus 0.6 m of wall). In the picture at -2702, the car is half inside a wall.

Over the whole map, sampled every 2 m:

| Covered tunnel overlapping another structure's tube | m | | Covered tunnel the sea's sheet passes through | m |
|---|---|---|---|---|
| M5 East Tunnel | 5,098 | | M8 Motorway Tunnel | 2,834 |
| Eastern Distributor | 3,742 | | M4 East Tunnel | 2,334 |
| Sydney Harbour Tunnel | 2,438 | | Iron Cove Link Tunnel | 534 |
| Cahill Expressway | 906 | | M5 Motorway | 350 |
| General Holmes Drive | 814 | | Sydney Harbour Tunnel | 306 |
| Eastern Distributor Onramp | 456 | | M4 East Tunnel Onramp | 302 |
| William Street Offramp | 354 | | Wattle Street Offramp | 246 |
| Cross City Tunnel | 282 | | Cross City Tunnel | 200 |
| Others | 1,352 | | Eastern Distributor ramps | 168 |
| **All** | **15,442** | | **All** | **7,276** |

"Overlapping" means two tubes within 5.6 m of height whose roads come closer than their half widths and a wall. Side by side, that's what you drove through. One above the other, as in the Eastern Distributor, which really is two decks, it means one tube's floor is inside the other.

The water only shows where its sheet is between a tube's road and its ceiling. In the Harbour Tunnel's deepest part, the ceiling is under the sheet, so it shows on the slopes either end. That's the 306 m.

### Things standing in the road

Sampled every 2 m across every deck except the Harbour Bridge's own:

| What | Over the map | Worst places |
|---|---|---|
| Buildings rising into a deck | 25 | Western Distributor, at least 5 of them. Cahill Expressway (331, -1344) and (78, -3063). Departure Plaza at the airport. Railway Colonnade Dr at Central. Syd Einfeld Dr (4218, 1394) |
| Trees taller than the room under a deck | 82 of 601,631 | 27 under the M4 near Parramatta, 6 Cahill Expressway, 5 Western Distributor, 5 Syd Einfeld Dr |
| Kerb under a deck with less than 9 m of room | 3,102 points | Western Distributor 511, M4 318, M5 119, Sydney Gateway 108 |

That last row is a count of where street lights and signs could be put under a deck, not of how many are. They're placed when the game runs, so a tool can't count them yet.

At Bondi Junction, Syd Einfeld Drive's deck is 1.2 m above the ground at its lowest and 7 m at most. Under it, the ground is lowered by up to 3 m (`LOW_DECK` in `js/surfaces.js:20`), but what stands on that ground isn't.

**Why the Cahill building got 20 m:** a building with no height takes the median of its neighbours' within 130 m, if there are three or more (`tools/build-buildings.mjs:146`). It doesn't matter how big they are. A 275 m² outline in the CBD takes its height from towers.

### Kerbs in the air

In the CBD's north, between x = -600 and 600 and z = -1,700 and -900, 34 kerb points stand 1-6.5 m above the kerb points either side of them. All are at cuttings and ramps:

| Where | Step | What's there |
|---|---|---|
| (447, -1185) | 6.5 m | Cahill Expressway on-ramp, beside Macquarie St |
| (455, -1319) | 6.1 m | Harbour Tunnel's southern approach |
| (-194, -1544) | 5.9 m | Argyle St through the cut |
| (-247, -1357) | 5.2 m | The approach to the Harbour Bridge |
| (473, -1222) | 3.9 m | Cahill Expressway on-ramp |

**Cause:** `addCurb()` takes the ground's height every 8 m around a kerb (`EDGE_STEP`, `js/ground-geometry.js:20`) and draws straight between. Beside a cutting, the ground falls metres within those 8 m.

Over the map, 24,977 of 3.1 million kerb points (0.8%) step more than 1.5 m from the next. Some of those are fair, on real slopes like North Head's cliffs. Some are on the edges between the generators' regions, like 12 m at (7750, -7200). check-ground doesn't look for any of this today.

### The loading bar

| When | Bar | Fade |
|---|---|---|
| First load | Yes, nine weighted steps (`buildRestOfWorld`) | |
| Changing the time of day | Yes | |
| Teleport while the city's still building | Yes, the first build's | Until the ground within 300 m is ready |
| Teleport after the city's done | **No** | Until the ground within 300 m is ready, then nothing for buildings, streets, trees and traffic |
| Driving or flying into new tiles | **No** | |

### Memory

**Safari's engine is on this machine.** Playwright installs WebKit, and the game runs in it on WebGL2 with no errors: interactive in 3.2 s, the city done in 19 s. Flying north from the Harbour Bridge at Low, at about 52 m/s, I sampled the web process's memory every 20 s:

| | Web process | Triangles |
|---|---|---|
| City done, at the start | 1,264 MB | |
| In the air over the bridge | 1,321 MB | |
| Over North Sydney, z = -3.8 km | **1,590 MB** | 2.2 million |
| Over Northbridge, z = -6.9 km | 1,467 MB | 1.5 million |
| Over Forestville, z = -12 km | 1,218 MB | 1.0 million |

The rest of the 6-minute flight, over the bush of Garigal and out to Terrey Hills at z = -20 km, stayed between 1,105 and 1,327 MB. It ended at 1,105 MB hovering, with no errors.

The same flight in Chrome at Low drew the same scene, 2.19 million triangles over North Sydney. Its JavaScript heap went from 395 MB with the city done to 712-758 MB over North Sydney and Northbridge, then back to 432 MB after garbage collection. Chrome's process totals here include my other Chrome windows, so they don't count.

Memory follows how much city is around, and doesn't climb. So this run shows a peak, not a leak. **The peak is the problem: 1.6 GB is more than iOS is thought to allow a Safari tab.** Apple doesn't publish the limit, and it depends on the phone and on what else is open. This WebKit is a Linux build, drawing in software, so it isn't the same as your phone, where WebGPU's buffers live in a separate process. But it's the closest I can get, and it points the same way as your reload.

Your phone held 10 tiles, and North Sydney is the densest part of the flight. At Low, WebKit's scene there has 2.2 million triangles. On Chrome's phone profile at Stop 1, the start of the map drew 1.1-1.3 million.

### Suburbs

**People and cars,** as the game sets them now, within 350 m of each place:

| Place | Road | Lane | Cars allowed | Cars at Low | People at Low | Narrow local streets |
|---|---|---|---|---|---|---|
| Town Hall | 7.7 km | 23.0 km | 287 | 60 | 120 | 22% of road |
| Bondi Junction | 9.2 km | 19.5 km | 244 | 60 | 120 | 74% |
| Parramatta | 5.6 km | 12.9 km | 161 | 60 | 120 | 64% |
| Cronulla, houses | 5.3 km | 11.6 km | 145 | 60 | 120 | 58% |
| Dee Why, houses | 4.9 km | 11.1 km | 138 | 60 | 120 | 87% |
| Bankstown, houses | 4.0 km | 8.1 km | 101 | 60 | 120 | 100% |
| Palm Beach | 3.4 km | 7.3 km | 92 | 60 | 120 | 33% |
| Hornsby, houses | 1.8 km | 3.7 km | 46 | 46 | 120 | 100% |

"Narrow local streets" means two-way, not a main road, and 9.5 m wide or less. Buses go on any road, since the map has no bus routes, only bus lanes.

**Buildings,** in 3 × 3 km squares:

| Around | Buildings | No use given | Houses | Pitched roofs | Median height |
|---|---|---|---|---|---|
| The CBD | 7,715 | 45% | 27% | 28% | 7 m |
| Pennant Hills | 2,180 | 91% | 5% | 6% | 4 m |
| Greenacre | 6,637 | 96% | 2% | 3% | 5 m |
| Curl Curl | 1,283 | 81% | 16% | 18% | 3 m |
| Kogarah | 6,818 | 86% | 9% | 9% | 5 m |

Outlines with no use are mostly from Microsoft's machine-learned outlines in Overture. They become `other` (`tools/build-buildings.mjs:64`). Then `buildingLook()` picks sandstone or red brick under 22 m (`js/building-look.js:17`), with the CBD's pre-war façade: office-sized windows at 3.5-3.7 m a floor. A pitched roof needs a house, a shed or a small civic building. Even real houses get the CBD's two façades.

### Sydney's houses: a first pass at references

From council heritage guides and the other sources below. Phase I turns this into a reference folder with pictures for each suburb.

| Style | Period | What makes it | Where on today's map |
|---|---|---|---|
| Victorian terrace | 1840-1890 | Two storeys, a party wall each side, cast-iron verandah, slate or iron roof | Paddington, Surry Hills, Glebe, Balmain, Newtown |
| Federation Queen Anne and bungalow | 1890-1915 | Red face brick, tall terracotta hipped roof with gables, timber verandah, one room forward to the street | Haberfield, Strathfield, Mosman, Chatswood, Ashfield |
| California bungalow | 1915-1940 | One storey, dark red-brown brick, red terracotta tiles, broad gables, verandah on square brick piers, a driveway | Mascot, Bexley, Kogarah, Earlwood, the inner west |
| Inter-war flats, Art Deco and Spanish Mission | 1920-1940 | Two or three storeys, liver or cream brick, stepped parapets or rendered arches | Bondi, Coogee, Randwick, Manly |
| Post-war fibro cottage | 1945-1960 | One storey, fibro walls in white or pastels, red tiles | Sutherland Shire, Bankstown, Parramatta, the Northern Beaches |
| Triple-fronted brick veneer | Late 1950s-1970s | One storey, three steps across the front, hipped tile roof, big windows, a carport or garage | About 20 km out and beyond: Ryde, Hornsby, Sutherland, Bankstown |
| Red and blond brick walk-up flats | 1960-1980 | Two or three storeys, no lift, long and thin on one house's lot | Everywhere on main roads and near stations: Dee Why, Kogarah, Hurstville, Parramatta |
| Shop-top terraces | 1880-1940 | Two storeys on the street line, a shop under an awning, flats above | Main roads: King St, Parramatta Rd, Military Rd |
| Project homes and duplexes | 1980-today | Brick or render, tiled or Colorbond roof, a double garage in front | Infill everywhere, most in the west and south |
| Beach house | Any | Timber or fibro, on a slope, decks | Palm Beach, Avalon, Bundeena |

## Decisions

Say so if you want any of these changed.

1. **The phone's reload comes first,** along with what you reported. A new look for the suburbs means nothing if the tab is killed before you get there.
2. **Memory has a budget the game keeps to itself,** from its own count of what it holds, since iOS gives no figure. 600 MB at Low to start, adjusted once WebKit and your phone have shown what's safe. Over budget, it holds less: a shorter range for buildings and the far level, fewer far squares, and fewer cars and people.
3. **Tunnels side by side share a wall.** Where the data draws two tubes too close, they move apart to make room for one wall between them, within the covered part only, so the mouths and the streets above don't move. Stacked tubes get a slab's room between them. The Harbour Tunnel's middle really is one structure with two roads and a wall between.
4. **A tunnel's walls are solid.** Nothing moves from one tube into another sideways while either is covered.
5. **The sea isn't drawn while the camera is in a covered tunnel.** That's simpler and cheaper than cutting the sheet, and from inside a closed tube nothing outside shows anyway.
6. **Nothing stands taller than the room under a deck.** A building with no height of its own is cut to fit. One with a real height that still rises into a deck is listed, as the Western Distributor's may be modelled wrong. Trees and street furniture under a deck are left out.
7. **A guessed height comes from similar buildings,** of about the same footprint and use, not from any building within 130 m.
8. **Folders hold 64 tiles at most,** one per 8 km square, for tiles and map images alike. Katoomba will reuse them for its tile indexes (`ai/map_expension.md`, decision 2).
9. **Population and land use come from the ABS 2021 Census, by Mesh Block** (CC BY 4.0), stored in each tile as a 100 m grid. NSW's land zoning is the second source, for telling a main road's shops from a street of houses. Its licence is to be checked first.
10. **How busy a place is follows who lives and works there.** The CBD stays as it is. A street of houses gets a few people and the odd car, and a shopping strip or a station is busy. Buses keep to main roads.
11. **Houses are one material with many looks,** chosen per building, so the suburbs add no shader to compile on a phone.
12. **Small streets have no centre line.** Two-way local streets get none, except a short one where they meet a main road.
13. **WebKit joins the test tools,** as Safari's stand-in, next to Chrome and Firefox.
14. **Two stops for your phone:** after the fixes and the memory work, and again at the end, after the suburbs.

Plan 3's decisions stand.

## Phases

| Phase | Result | Size |
|---|---|---|
| A | Tests and readouts: WebKit, real screenshots, your position and the worst frame's cause on the readout | Small |
| B | Folders GitHub can show | Small |
| C | Tunnels: walls, no water inside | Medium |
| D | Nothing standing in the road: decks, kerbs | Medium |
| E | Loading bar after teleports and while streaming, no eye button on phones | Small |
| F | Memory: a budget, and a note when a session ends without closing | Medium |
| | **Stop 1: your phone** | |
| G | Population and land use in the map | Medium |
| H | People, cars and buses by place | Medium |
| I | Houses | Large |
| J | Street markings | Small |
| K | Leftovers from `next_3` and `next_2` | Medium |
| | **Stop 2: your phone, `next_4.md`** | |

## Phase A: Tests and readouts

- **`--browser=webkit`** for play, bench, look and flicker. It reports the web process's memory, since WebKit has no `performance.memory`.
- **Screenshots from the game.** 38 of the last 41 saved by `play` and `viewports` were black behind the HUD (`next_3`). Use the game's `grab()` for the world and lay the page's HUD over it.
- **Where a long drive restarts.** The test counts restarts but doesn't record where.
- **On `?stats=1`:**
  - Where you are: x, z and the street, so a report like the kerb on Bridge St can say exactly where.
  - What the game was doing at the worst frame: which tile it was building, or that it was rebuilding street furniture or traffic. Your 225 ms at 2:47 has no explanation today.
  - An estimate of memory held (Phase F), which iOS doesn't give.
- **check-roads gains three checks:** covered tunnel overlapping another tube, covered tunnel with the sea's sheet inside it, and deck room. **check-ground gains kerb steps.** They start as ratchets at today's numbers, and the phases below take them to zero.

**Done when** a scenario passes in WebKit, a report's pictures show the world, and the readout shows position, the worst frame's cause and memory.

## Phase B: Folders GitHub can show

| Today | After |
|---|---|
| `tiles/<x>_<z>.<hash>.bin.gz`, 1,811 files | `tiles/<X>_<Z>/<x>_<z>.<hash>.bin.gz`, where X and Z are the 8 km square: 64 at most in each, about 45 folders |
| `tiles/far_<x>_<z>.<hash>.bin.gz`, 133 files | `tiles/far/far_<x>_<z>.<hash>.bin.gz` |
| `map/2/<x>_<z>.webp`, 1,854 files | `map/2/<X>_<Z>/<x>_<z>.webp`, the same squares |
| `map/8/`, 135, and `map/32/`, 15 | Unchanged |

- What changes: `tools/build-tiles.mjs` and `tools/build-map-images.mjs` write there, `js/geodata.js` and `js/city-map.js` read from there, the offline file's list in `vite.config.js` follows, and old files are cleaned up.
- **`check-dist` fails over 1,000 entries in a folder,** for the deploy and for `git ls-files`.
- Git stores a moved file as a rename, so the move adds almost nothing to the repository.
- Each tile's name keeps its hash, but the address changes. So returning players fetch the map once more. A first visit is the same as now.
- **`public/_headers`:** Cloudflare's `*` matches across folders, so the rules should still apply. As before, that can't be tested locally, so please check a tile's cache header after you deploy.

**Done when** no folder in the repo has over 1,000 entries (the largest will be about 64), `npm run check` and `npm run play` pass, and the offline file still opens.

## Phase C: Tunnels

1. **The sea's sheet, and anything at sea level like ferries, aren't drawn while the camera is in a covered tunnel.** `inTunnel()` already tells the sky to fade there (`js/main.js:1805`). Check it at each tunnel's mouths, where the camera can be just outside the tube while the road dips inside.
2. **Twin tubes get room for a wall.** A new step after heights are solved, in `tools/build-heights.mjs`. It finds tunnel links of different structures closer than their half widths plus 0.6 m and within a tube's height of each other. Then it moves both apart, half each, eased in and out over 60 m. The covered part only, so the mouths and anything at the surface stay put.
3. **One shared wall between them,** drawn once. The tube on each side has its wall at the shared line.
4. **Stacked tubes get a slab between them:** a road at least 5.6 m plus 0.8 m above the one below. The Eastern Distributor is the main case. Where the solver can't fit that, it's listed.
5. **Walls are solid.** `chooseSurface()` won't move something from one tunnel structure to another while either is covered. A car meeting a wall is held by it, and slides along it, as against a parapet.
6. **Traffic's lanes follow** the moved centre lines, since they're built from the links.

**Done when** check-roads reports 0 m of overlapping tubes and 0 m of tube with the sea inside, with any it can't fix listed by name. A new `harbour-tunnel` scenario drives both tubes end to end, steering into each wall, and never ends up in the other tube. Pictures at the three places above show walls and road, and no water. The M8 and M4 East get the same pictures.

## Phase D: Nothing standing in the road

1. **Buildings under decks** (`tools/build-buildings.mjs`). A building with a guessed height that's under a deck is cut to fit under it, with a metre to spare. One with a real height that still rises into a deck is listed for a look, and trimmed from the deck's footprint if it's beside the road rather than under it.
2. **Guessed heights from similar buildings** (decision 7). Compare the CBD before and after: no tower should lose height to this.
3. **Trees, street lights, signs, bus shelters and poles look up.** What's placed while the game runs checks `ceilingOver()` and is left out if it wouldn't fit. Tree fitting (`js/tree-placements.js`) and street furniture (`js/street-details.js`) share one test.
4. **A deck too low to walk under is solid below.** Under about 2.5 m, as at Bondi Junction, the kerb islands and lawns under it go, as they would under an embankment, and the deck's side walls reach the ground. Above that, they stay.
5. **Kerbs follow the road into cuttings.** Heights every 2 m where the ground changes fast, rather than every 8 m. Kerb islands are cut off a cutting's side slope in the generator, so a kerb never sits on a bank that falls away.
6. **The region edges' kerb steps,** like 12 m at (7750, -7200): find out why, since `next_3` said kerbs aren't drawn along those edges.

**Done when** check-roads reports no building, tree or furniture site under a deck without room, and check-ground no kerb stepping over 0.5 m beyond what its road does. Pictures on the Cahill Expressway, on Syd Einfeld Drive and at the Cahill on-ramp go in `next_4.md`. The kerb on Bridge St is confirmed gone, with your position from the readout if it wasn't this one.

## Phase E: Loading bar, and the eye button

- **A bar for the map coming in.** While anything near you is still being fetched or built after the first build, a batch shows: "Loading Bondi Junction", with the suburb's name. The steps are the ground under you, the buildings in range, the streets, street furniture and trees, then traffic. Each is weighted by how long it takes, as the first build's are. It shows after 300 ms, like every batch.
- **On a teleport,** the fade shows the same bar and name, so a black screen always says why.
- **Driving or flying,** a short batch shows only when you're about to outrun the map, as the car's slowing down at the edge already shows.
- **No eye button on a phone.** It's taken out of the phone's menu (`#btn-toggle-hud`). The HUD already fades by itself there. H still works with a keyboard.

**Done when** a scenario teleports between six places in turn: the bar shows within half a second for each place that needs anything, reaches 100% and goes. `viewports` shows no eye button on the four phone sizes, and does show it on a tablet and a desktop.

## Phase F: Memory

1. **Count what's held.** The game knows every geometry and texture it makes. Their bytes, plus the tiles' data, are an estimate that works on iOS too. It goes on the readout. Check it against Chrome's figures and WebKit's process.
2. **Find what's biggest** at the peak over North Sydney: buildings, far squares, the horizon, street furniture, traffic, textures or shadow maps. Then bring it down. North Sydney has 2.2 million triangles at Low, against 1.1-1.3 million at the start of the map.
3. **A budget by level** (decision 2). Over it, the game holds less, starting with what's least seen: far squares furthest away, then the building range, then traffic and people. Flying fast at Low holds a shorter range, since nothing near is seen for long.
4. **A note when a session ends without closing.** Every few seconds, a small record goes to local storage: time, place, mode, the memory estimate, tiles and far squares. If the next load finds no record of the page closing, `?stats=1` shows something like "last session ended without closing at 3:12, flying at (-100, -5900), about 690 MB held". Next time it happens, we'll know where and at what size.
5. **Long flights in three browsers:** north from the bridge, and the length of the map and back. That's Chrome's phone profile, WebKit, and Chrome's laptop profile at High.

**Done when** the estimate is within 25% of WebKit's process growth, the peak over North Sydney is at least a third lower in WebKit at Low, nothing climbs over a 20-minute flight, and frames are no worse.

### Stop 1: your phone

I'll write `next_4.md` and tell you. You commit and deploy. Then on the phone, with `?stats=1`:

1. Open it fresh, and note the load time.
2. Fly north from the bridge for several minutes, the flight that reloaded last time, then fly to Palm Beach.
3. Drive through the Harbour Tunnel, over the Cahill Expressway, and along Syd Einfeld Drive at Bondi Junction.
4. Teleport to three places and watch for the bar.
5. Send the readout, including the memory estimate and any "last session" note, and tell me if the tab reloaded.

## Phase G: Population and land use

- **ABS 2021 Mesh Block counts:** residents and dwellings for each Mesh Block, a 14.5 MB spreadsheet. **Mesh Block outlines and land use** come from the ABS map service, 46,072 Mesh Blocks in today's box, in 2,000 at a time.
- **NSW land zoning,** from the planning portal's open layers, for local centres along main roads and areas of flats against houses. Check its licence first, and leave it out if it isn't open.
- **Census dwelling structure by SA1:** how many separate houses, semis and terraces, and flats. It decides the mix of houses and flats in each place.
- **Per tile:** a 100 m grid of residents, dwellings, a land-use class and a zone. About 200-300 bytes a tile zipped. Workers in the CBD and the big centres are judged from the floor area of offices and shops, which the buildings already give.
- **Credit** in the README.

**Done when** every tile has the grid, the first view's download stays under 1 MB, and a map-screen layer shows the grid for checking by eye.

## Phase H: People, cars and buses by place

- **People:** a target for the 350 m around you, from residents and workers there, and from shops, stations, schools and beaches near you. The CBD and Bondi Beach stay busy. A street of houses gets a handful of people.
- **Cars:** a target by road class and by who lives and works around. Motorways and main roads keep their traffic. Local streets get a car now and then. One car per 80 m of lane stays as the most a road can hold, not as the number to fill.
- **Parked cars** in driveways and at the kerb, so a quiet street still looks lived in. Parked cars cost a draw and nothing to simulate.
- **Buses** on main roads and bus lanes only.
- **Levels stay as caps.** Low still has at most 60 cars and 120 people.
- **check-traffic reports cars and people per place** at Town Hall, Bondi Junction, Parramatta, Cronulla, Hornsby and Palm Beach.

**Done when** the CBD's numbers don't change. The places in the table above get targets, and they're met within 20%. Palm Beach's 47% of cars stopped with no lights (`next_3`) is found out and fixed. Frames get better in the suburbs, not worse.

## Phase I: Houses

1. **References.** `ref/houses/`, with one page for each group of suburbs on today's map: the inner west, the eastern suburbs, the lower and upper North Shore, the Northern Beaches, Canterbury-Bankstown, St George, Sutherland Shire, Parramatta and Ryde. A few pictures each, from main roads and from small streets, as you asked. Each gets a short spec: storeys, walls, roof shape and pitch, roof colour, eaves, verandah, windows, setback, fence and garage. Pictures are linked, not copied into the repo, unless their licence allows: Wikimedia Commons, council heritage sheets, and Mapillary's street photos, which are CC BY-SA.
2. **Which buildings are houses.** An outline with no use in a residential Mesh Block: houses at house sizes, semis and terraces where they share walls, flats where they're big and tall. In a commercial Mesh Block on a main road, shop-top terraces. Heights for those with none: one storey for a house, two for a shop-top, three for walk-up flats, by what the Census says is there.
3. **The look, per style:**
   - Face brick in red, liver, cream or blond, render, weatherboard or fibro.
   - Hipped and gabled roofs at real pitches, in terracotta, concrete tile or Colorbond.
   - Eaves, windows of a house's size, and a front door.
   - A verandah or porch for the older styles.
   - Garages and carports where the lot leaves room.
   - Shop-tops get an awning and a shopfront.

   It's one material, with the style and colours chosen per building (decision 11).
4. **The mix comes from where it is:** the style table above by suburb group, weighted by the Census's dwelling structure. A street keeps some sameness, as streets built in one go do.
5. **Far away,** the far level's points get the same roof colour and pitch, so a suburb doesn't change colour as it comes close.
6. **The CBD's look doesn't change.**

**Done when** pictures at a street of houses and a main road in each suburb group sit next to their references in `next_4.md`, and they look like the same kind of place. Load, shader compile and frames on the phone profile are no worse. The first view's download is still under 1 MB.

## Phase J: Street markings

- The tiles get each road's class from OSM, if they don't have it already. Today a link only knows if it's a main road (`major`) and how many lanes it has.
- **Two-way residential and unclassified streets narrower than 11 m: no centre line.** One council's standard has lines on urban roads 11 m or wider, whatever their traffic. Service roads and lanes get no lines at all.
- A short centre line, about 15 m, where a small street meets a main road, with its give-way or stop line.
- Main roads, one-way streets and roads with lanes in the data keep today's markings.

**Done when** a picture at a street of houses shows no centre line, and one at its corner with a main road shows the short line. `road-paint` tests cover each case.

## Phase K: Leftovers from `next_3` and `next_2`

Chosen because they stop a car, hide a problem from the tests, or are quick:

1. **Dead stops,** 903 m at 32 places, where a car hits an invisible wall, Berowra Waters Rd being the worst. Fixed in the generators, and the ratchet goes to zero.
2. **The brown wall by the creek** on Pittwater Rd at Dee Why (5760, -15005): find what draws it, and look for more beside the rivers added in Stop 2.
3. **The car wedged on Macquarie St** (`next_2`, item 4): check if it still happens.
4. **Firefox:** `npm run bench -- --browser=firefox`, outstanding since `next_2`.

## Not in this plan

From `next_3`: the other road limits (lean, grade, steps, roll, wheels on kerbs, traffic lanes off the road) stay as ratchets. Also the Eastern Distributor on-ramp's 35% dip, crossings with roads too close, and the flaky `motorways` scenario. Ponds above sea level are in `ai/map_expension.md`. From `next_2`: load at High, draws and triangles at High beyond what Phase F does, shoreline detail in the far level, STOP plates and push-button detail, and the bridge at night. From `next_1`: wheel contacts for buses, bicycles and traffic, and the pale band in the William St tube. An Android or older phone is still worth trying when you can.

## Risks

| Risk | Why | Plan |
|---|---|---|
| The memory budget is a guess | Apple doesn't publish a tab's limit, and Linux WebKit isn't an iPhone | Start safe, and use the "last session" note and your Stop 1 to set it |
| Moving tubes apart breaks something | Ramps join tunnels underground, and traffic, portals and kerbs read their lines | Covered parts only, every scenario, and pictures at each tunnel |
| The houses cost frames or load time | Pitched roofs and more detail on 600,000 buildings | One material, roofs counted in the triangle budget, measured on the phone profile at each step |
| References and licences | Photos of houses belong to whoever took them | Link, don't copy, except Commons and CC BY-SA street photos |
| Zoning licence | Not confirmed open | Check first. The ABS land use alone is enough to start |
| Fewer cars feels empty | A street with no one on it can look dead | Parked cars, and targets you judge at Stop 2 |
| Folder move and Cloudflare's rules | `_headers` can't be tested locally | Check a tile's header after deploying |

## What I need from you

1. **The phone tests at both stops,** with the readout, and whether the tab reloaded.
2. **Where the kerb was,** if Phase D's fix doesn't get it. The readout will show your position.
3. **Commits.** The folder move renames 3,800 files, which git stores as renames. I'd commit it on its own, before anything else changes the tiles.
4. **Check a tile's cache header** after the first deploy with folders.
5. **Disk:** about 1 GB more for the ABS and zoning data.

## Sources

- Measured from the game: `js/surfaces.js`, `js/structures.js`, `js/city-grid.js`, `js/ground-geometry.js`, `js/tree-placements.js`, `js/street-details.js`, `js/traffic.js`, `js/quality.js`, `js/main.js`, `js/progress.js`, `js/phone-hud.js`, `js/road-paint.js`, `js/building-look.js`, `js/buildings.js`, `tools/build-buildings.mjs`, `tools/build-trees.mjs`, `public/tiles/world.json`, and the overture data in `tools/data/east/`
- [GitHub's repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits): 3,000 entries per folder, recommended. Its web pages cut a folder's list off at 1,000 files, ["we had to truncate this directory to 1,000 files"](https://github.com/LoopZ/TheList/issues/49)
- [ABS Mesh Block counts, 2021](https://www.abs.gov.au/census/guide-census-data/mesh-block-counts/2021), and the [ABS Mesh Block map service](https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/MB/MapServer), which gave the 46,072 count and the land-use field. [ASGS Edition 3 boundaries](https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs/edition-3-july-2021-june-2026/access-and-downloads/digital-boundary-files)
- House styles: [City of Botany Bay, House Styles](https://www.bayside.nsw.gov.au/sites/default/files/2022-05/House%20Styles%20in%20Botany%20Bay.pdf), [Domain on post-war double and triple-fronted homes](https://www.allhomes.com.au/advice/post-war-double-and-triple-fronted-homes-in-australia), [Camden History Notes on fibro cottages](https://camdenhistorynotes.com/2014/06/29/the-camden-fibro-cottage/), [Charles Pickett on walk-up flats](https://www.aicomos.com/wp-content/uploads/2009_UnlovedModern_Pickett_Charles_SixPack_Paper.pdf), [Raine & Horne on Sydney's residential architecture](https://www.raineandhorne.com.au/bexley/blog/exploring-residential-architecture-in-sydney), [Strathfield's Federation housing](https://strathfieldheritage.com/houses/federation-housing-in-strathfield/), [Federation architecture](https://www.Wikipedia.org/wiki/Federation_style)
- Centre lines on urban roads 11 m or wider: [Central Coast Council, SD0900 Traffic Management Series](https://cdn.centralcoast.nsw.gov.au/sites/default/files/Plan_and_build/SD0900_-_Traffic_Management_Series.pdf). That's one council's standard, not a state rule. I didn't find Transport for NSW's own rule.
