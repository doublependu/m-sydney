# Next 4: suburbs that look, move and park like suburbs

Answers `ai/plan_4.md`, all of it. Phases A to F were Stop 1, which you tested on the phone. **Phases G to K are done**, and this is Stop 2. Nothing is committed or deployed: that's yours.

## Your phone test at Stop 1

iPhone 16e, Safari, `?stats=1`:

| | Stop 1 | Before (`next_3`) |
|---|---|---|
| Loaded in | **0.83 s**, WebGPU, Low | 1.03 s |
| Last second | 60 FPS, 0 slow, worst 22 ms | 60 FPS, worst 17 ms |
| Since load | 2:47, 70 of 11,484 frames slow (0.6%), worst 162 ms at 0:03, "GPU or browser" | 5:27, 1.1% slow, worst 225 ms |
| City done | 20.6 s | 21.6 s |
| Memory | holds about 153 MB, 9 tiles, at Elizabeth St & Park St | not counted |
| Tab reloaded | **No** | Once, flying north |
| Cache header | `immutable`, as it should be | |

The worst frame came 3 s after load, while the city was still building. Nothing the page timed took long, so it was the browser or the GPU, and I can't tell which. 153 MB is under Low's budget of 170 MB, so the far level was never pulled in.

## What you need to do

1. **Commit and deploy.** `git status` has about 3,900 entries again, nearly all under `public/tiles/`: every tile changed, as each now has its grid of residents and land use, its roads' classes and its houses' styles.
2. **On your phone, with `?stats=1`:**
   - Open it fresh and note the load time.
   - **Teleport to Bankstown, Sutherland, Dee Why and Hornsby** from the menu. Walk or drive a few streets of houses off the main road. Does it feel like the place: the houses, how many people and cars, the parked cars?
   - **Then the CBD and Bondi Junction,** which should be as busy as before.
   - **Fly from the CBD to Palm Beach.** The suburbs below shouldn't change colour as they come close. Palm Beach's cars used to stand still half the time.
   - Send the readout, and say if the tab reloaded.
3. **`ref/houses/`** has the references and the game's pictures side by side (`ref/houses/README.md`). `ref/` is git-ignored, so it's only on this machine.

## Results

### Population and land use (Phase G)

- **The data:**
  - **ABS 2021 Mesh Blocks** (CC BY 4.0): 43,382 in the map's box, every one matched to its residents and dwellings.
  - **NSW land zoning** (CC BY 4.0): 16,541 zones.
  - Both are fetched by `node tools/fetch-data.mjs abs_counts,abs_meshblocks,nsw_zoning`, in under a minute.
- **The raster:** `tools/build-population.mjs` fills them into a 10 m raster in 4.5 s. It holds 3.37 million residents, the share of Sydney inside the map's frame.
- **Each tile** gets a 100 m grid of residents, dwellings, workers, land use and zone: **238 bytes a tile zipped** (the plan said 200 to 300). Workers are judged from the floor area of buildings that aren't homes, 30 m² each, or 100 m² in industry.
- **The first view's download** is 699 KB, under 1 MB (690 KB at Stop 1).
- **`?places=1`** shows the grid on the full map: the colour is the zone, the strength how many live and work there.

| Within 350 m of | Residents | Workers | Zoned mostly |
|---|---|---|---|
| Town Hall | 5,388 | 76,635 | office |
| North Sydney | 1,399 | 31,902 | office, special |
| Parramatta | 1,314 | 49,301 | local centre, office |
| Bondi Junction | 3,223 | 12,144 | local centre, medium density |
| Newtown | 3,170 | 2,885 | houses |
| Dee Why | 3,374 | 2,752 | houses, local centre |
| Palm Beach | 169 | 0 | park |

### People, cars and buses by place (Phase H)

- **A road's share of the most traffic it holds** comes from the residents and workers within 250 m (`roadShare()` in `js/traffic.js`). The most is still one car per 80 m of lane:
  - **Motorways:** always full.
  - **Main roads:** at least 35%, up to full in the CBD.
  - **A street of houses:** as little as 5%.
- **Spawning follows it:** a quiet street is picked for a new car only as often as it's full.
- **Cars over the target leave,** where you can't see them. Before, the first placement put out every car whatever the roads could hold, and a car near you never left.
- **People** are one for every 200 residents and workers within 350 m, plus 30 at each station, and never fewer than 4. Those over the target go home out of sight. **The graphics level's numbers are still the most:** 60 cars and 120 people at Low.
- **Buses** keep to main roads, as before.
- **Cars are parked along the kerbs** of streets of homes and tertiary roads, more where more people live. They're drawn as the far cars are, sharing their material, in two draws, and simulate nothing. You hit them; traffic passes them in its lane. The same kerb gets the same cars each time it comes back.

`node tools/check-traffic.mjs --cars=60` (Low), 2 minutes at each place:

| Place | Cars wanted | Cars out | People wanted (Low's cap 120) | Stopped |
|---|---|---|---|---|
| Town Hall | 64, the cap | 64 | 391 → 120 | 6% |
| Bondi Junction | 59 | 59 | 107 | 6% |
| Parramatta | 64, the cap | 64 | 343 → 120 | 9% |
| Dee Why, houses | 16 | 17 | 13 | 0% |
| Bankstown, houses | 15 | 15 | 9 | 1% |
| Cronulla, houses | 7 | 8 | 8 | 0% |
| Hornsby, houses | 3 | 3 | 7 | 0% |
| Palm Beach | 15 | 16 | 4 | 3% |

- **Targets are met:** within one car everywhere, so well within the plan's 20%.
- **The streets of houses** are a few hundred metres off their suburbs' centres, where the most land within 300 m is zoned R2 (`cronullaHouses` and the rest in `tools/check-traffic.mjs`).
- **Palm Beach wants 15 cars now, not 8.** That changed with the curve fix below, which decides which turns the network keeps. I haven't checked why.
- **The CBD's numbers don't change.** At High, Town Hall still has 212 cars, all its roads can take, with 20% stopped against a limit of 35%.

**Palm Beach's cars stopped with no lights** (`next_3`: 47%) was junction curves with a near-cusp at one end. Where two lanes' lines meet next to the end of one, that end's handle all but vanishes, so the curve's curvature runs to infinity and a car crawls through it at 0.1 m/s. Handles are now at least a fifth of the way across, and a car never slows for a curve tighter than 3 m. **Palm Beach at High: 51.5% stopped → 1%.** North Sydney went to 2% stopped, against a limit of 42%.

### Houses (Phase I)

**Which buildings are homes.** `tools/build-buildings.mjs` asks the Mesh Block and zoning what an outline of no use stands in:
- **In a block of homes:** a house, or flats if it's big and the block has more homes than buildings, or it's zoned R3 or R4.
- **In a block of shops and offices:** a shop.
- **Education and hospitals:** civic.

Over the map, outlines of no use became:

| Became | Outlines |
|---|---|
| Houses | 460,910 |
| Flats | 30,643 |
| Shops | 7,073 |
| Civic | 6,115 |
| Sheds | 12,230 |

**Styles.** Each home gets a style by its group of suburbs, the ABS's SA4 (`js/house-styles.js`; the mixes are in `HOUSE_MIX`). Within a street, 65% share their Mesh Block's style, as streets built in one go do.

| Style | Houses | | Style | Houses |
|---|---|---|---|---|
| Triple-fronted brick veneer | 120,689 | | Federation | 60,837 |
| California bungalow | 107,626 | | Walk-up flats | 22,809 |
| Project home | 97,502 | | Inter-war flats | 14,203 |
| Post-war fibro | 97,074 | | Shop-top terrace | 9,573 |
| Victorian terrace | 62,932 | | Beach house | 9,757 |

- **Terraces:** narrow, long houses are terraces in the inner suburbs, townhouses elsewhere.
- **Heights:** Overture's height for most of them is to the top of the roof. That height now says how many storeys there are, 3 m each, and the roof stands on them. Before, the roof stood on top of the whole height.

**The look:**
- **Walls:** two new sets of uniforms for the masonry facade:
  - Face brick, from red through orange to cream.
  - Paint, render and fibro, from white to sand.

  A style picks which of its colours, and the GPU compiles nothing new. The facade got two uniforms of its own: windows on the ground floor too, and a second wall colour picked by the building's tone.
- **Roofs:** new, hipped or gabled at the style's pitch: 38° for Federation, 22° for brick veneer, 18° for a beach house.
  - **Eaves:** each stands 0.15 to 0.6 m past the walls.
  - **Gable ends** are walled up to the roof in the wall's own brick or paint.
  - **Colours:** terracotta, slate, concrete tile, Colorbond or iron, in one vertex-coloured material where there were two.
  - **The old pitched roof is gone:** it left holes along the long sides.
- **Far away,** the far level takes each house's roof colour, a near tone of its walls, and its height to about the middle of its roof. Flying in, the colours hold, as in `pictures/air-kogarah.jpg`.
- **Houses don't get** the CBD's fire escapes, roof plant or cornices.
- **The CBD's look doesn't change:**
  - Its two SA2s, Sydney (North) and Sydney (South), keep their buildings as they were: the tile at Circular Quay is unchanged.
  - The tiles that reach into Surry Hills, Darlinghurst, Pyrmont and Ultimo get their terraces.
  - The CBD's few pitched roofs take the new roof's shape.

**Pictures, next to their references:** `ref/houses/pictures/` has a street of houses and a main road in each group of suburbs, standing in the street at midday. `ref/houses/README.md` sets each beside Wikimedia Commons pictures and categories of the same councils' houses. Brick and terracotta in the bungalow and Federation suburbs, blond brick and fibro further out, and walk-ups at the centres read as the same kind of place. **They're plainer than the real ones:** no verandahs, fences, garages or carports yet, lawns of one green, and every house sits where its outline is.

### Street markings (Phase J)

- **The tiles now carry each road's OSM class,** in the link's flags (`ROAD_CLASSES` in `js/surfaces.js`). That needed `build-geodata` and `build-heights` run again. Every other field came out the same.
- **What's painted** (`markingsOf()` in `js/road-paint.js`):
  - **No centre line** on a two-way residential or unclassified street under 11 m, unless the map gives it lanes. It gets a 15 m one where it meets a main road, up to its give-way line.
  - **No lines at all** on service roads.
  - **Main roads and one-way streets** keep today's markings.
- **Pictures:**
  - `ref/houses/pictures/markings-little-road-at-main-road.jpg`: the short line.
  - `markings-seaforth-avenue.jpg`: none, where it meets a tertiary road.
  - The streets of houses above: no centre line.
- **A test** covers each case.

### Leftovers (Phase K)

1. **Dead stops:** over the whole map, **924 m at 33 places → 492 m at 23.**
   - **Berowra Waters Road, the worst,** is clear. It winds down the gorge in hairpins, and OSM gives it four lanes, so it was 15 m wide. Its outer lane ran onto the leg below, 7 m lower, where no surface was within a step. A road is now no wider than the gap between a hairpin's legs (`legGap()` in `tools/build-geodata.mjs`).
   - **What changed width:** 3,219 links, mostly service roads winding through car parks, and one-way carriageways that OSM draws as one way turning back on itself.
   - **What's left** is mostly where a road sunk into a cutting meets another at a junction 2-4 m higher or lower within a metre: Epping Road at Lane Cove Road, Ryedale Road, Warringah Road, Reserve Road, Pitt Street and Burnett Street in Parramatta, Marlborough Road. That's the heights step's junctions, not the roads' widths. Also three places in the Cross City Tunnel by the Eastern Distributor, and one each on the Western Distributor and Wallaroy Road.
   - **So the ratchet didn't reach zero.**
2. **The brown wall by the creek at Dee Why:** not there. Four pictures around (5760, -15005), from the street and from the air, show the lawn, the path and the creek's reserve. I don't know which change took it away.
3. **The car wedged on Macquarie St:** not seen. A 10-minute soak passed with no car stuck. Its teleports now include Bondi Junction, Dee Why, Bankstown, Cronulla, Parramatta and Chatswood as well as the CBD, so it has driven among the parked cars too. The original happened once in 70 minutes, so 10 minutes doesn't rule it out.
4. **Firefox's bench:** done, under "Load and frames".

Also from the whole-map road check, against Stop 1:
- **Better:** steps over 5 cm 51.6 → 50.5 km, roll over 2% a metre 93.3 → 90.2 km, and cars' wheels on a kerb 4,480 → 4,430 m.
- **A little worse:** traffic off every carriageway 1.15% → 1.16%, and steps through junction turns 262 → 287 m.
- **Unchanged:** tubes 3.0 km, buildings rising into a deck 8.

### Load and frames

Phone profile, `npm run bench`, three runs each, today on this machine:

| | Stop 1's code and tiles | Now |
|---|---|---|
| Interactive | 3.38 s (3.33, 3.38, 3.65) | **3.25 s** (3.24, 3.25, 3.27) |
| Shaders | 1.45 s | 1.36 s |
| First view's download | 695 KB | 699 KB |
| City complete after | 25.3 s | 24.9 s |
| Frames | 39.1 FPS, p95 33.3 ms | 40.6 FPS, p95 33.1 ms |

- **Load is no slower:** the same as Stop 1's 3.25 s.
- **An earlier build was 0.1 s slower.** It gave the CBD's buildings near the start house looks, and that's since undone.
- **Frames are no worse.**
- **Firefox,** outstanding since `next_2`: interactive in 1.39 s, 59.9 FPS, on WebGL2. Firefox can't be slowed down the way Chrome is, so that's this PC's speed, not a phone's.

### Tests

- **`npm run check`:** passes in 43 s.
- **Unit tests:** 335, all passing. New:
  - `tests/places.test.mjs`: every tile's grid, the CBD's workers, a quiet street, a tile taking its grid when it goes, roads' classes.
  - Small streets' markings, in `tests/road-paint.test.cjs`.
  - Hipped and gabled roofs covering the house and its eaves at their pitch, with gables walled up, in `tests/building-footprints.test.cjs`.
- **`npm run play -- --full` with a 10-minute soak:** 38 of 39 passed in 39 minutes, and the soak passed.
  - **`signal-wait` failed once,** waiting 18.7 s at a red with nobody about against a limit of 11. It passed on its rerun with the same seed, so it's flaky.
  - **Soak memory:** the JavaScript heap ended at about 450-470 MB, after peaks of 1.1-1.3 GB while the city built at new places.
- **`npm run play`** on the final tiles: 9 of 9.
- **`viewports`:** clean.
- **Whole-map `check-roads`:** see Phase K.
- **Not run:** whole-map `check-ground`, and the WebKit memory run.

## What isn't right yet

- **Dead stops: 492 m at 23 places** over the map, at junctions with a road in a cutting (above).
- **Houses are plainer than Sydney's:**
  - No verandahs, fences, garages, carports or terraces' parapets.
  - Lawns are one green.
  - A house stands where its outline is.
  - **Every front wall gets a door:** the facade doesn't know which wall faces the street.
- **Parked cars stand about 15 cm into the lane** of an 8.8 m street. Traffic keeps to its lane, so it only shows if a car swerves.
- **Not done from Phase G:**
  - The Census's dwelling structure by SA1 wasn't downloaded. Houses and flats come from the Mesh Block's homes for each building, and the zoning.
  - Workers are judged from floor area. That comes to 2.4 million over the map, likely more than really work there. Only how places compare matters to traffic and crowds.
- **Unzoned places:** The Rocks is under a state planning policy, not the council's zoning, so it has no zone. Its land use comes from the Mesh Blocks. There may be other places like it.
- **The map screen's images weren't redrawn** (`npm run data:map`) for this or Stop 1's changes: the tubes moved apart, and the narrower hairpins and car parks. Redrawing changes about 1,900 images.
- **Victorian terraces may be too many:** 63,000 of them. Every narrow house in the inner groups is one.

## What to do next

1. **Your phone test,** above.
2. **Dead stops to zero:**
   - Junction heights where a road in a cutting meets another (`tools/build-heights.mjs`).
   - Then the ratchet over the whole map, not only the CBD sample.
3. **Houses, a second pass:**
   - A front door and a front fence on the wall facing the street.
   - A verandah for Federation houses and bungalows.
   - Garages and carports where the lot leaves room.
   - Yards in more than one green, with a tree or two.
4. **Redraw the map screen's images.**
5. **Katoomba,** planned in `ai/map_expansion.md`.
