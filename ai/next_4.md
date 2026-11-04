# Next 4: Stop 1, tunnels, decks, the loading bar and memory are ready for your phone

Answers `ai/plan_4.md`, up to its first stop. **Phases A to F are done.** Phases G to K, the suburbs, come after your phone test. Nothing is committed or deployed: that's yours.

## What you need to do

1. **Commit and deploy.** `git status` has about 3,900 entries, nearly all under `public/`:
   - **The folder move:** 3,798 files.
   - **The tile rebuild:** 1,146 of 1,811 tiles and 109 of 133 far files changed, so most of the move isn't a plain rename any more.
   - **What changed them:** tunnels moved apart, buildings' guessed heights, and trees under decks.

   One commit is simplest. `public/tiles/` is still 66 MB.
2. **After deploying, check a tile's cache header,** for example `tiles/0_-1/0_-2.<hash>.bin.gz`. It should be `max-age=31536000, immutable`. Cloudflare's `*` in `public/_headers` should match across folders, but that can't be tested here.
3. **On your phone, with `?stats=1`:**
   - Open it fresh. Note the load time.
   - **Fly north from the bridge for a few minutes,** the flight that reloaded last time, then on to Palm Beach.
   - Drive through the Harbour Tunnel each way, along the Cahill Expressway past Circular Quay, and along Syd Einfeld Drive at Bondi Junction.
   - Teleport to three places from the menu and watch for the bar.
   - **Send me the readout.** It has two new lines: where you are, and how much the game holds (`holds about … MB`). If the tab was killed last time, there's one more line saying where and at what size.
   - **If you see the kerb in the sky again,** send the `at x, z` line from the readout as well.

## Results

### Your issues

| Issue | What I found | What changed | Now |
|---|---|---|---|
| Harbour Tunnel walls you can drive through | The two tubes ran 3-4 m apart. Their walls stood in each other's road, and both were at one height | Tubes are moved apart inside, leaving their mouths where they are (`tools/tiles/separate-tubes.mjs`). A tunnel's walls hold: nothing moves sideways from one tunnel into another (`chooseSurface()`) | Overlapping tube over the map: **15.4 km → 3.0 km**. Steering hard into both walls under the harbour keeps the car in its own tube |
| Driving under the water | The sea is one sheet at sea level. It ran through every tunnel that dips below it, 7.3 km of them, mostly the M8 and M4 East | The sea isn't drawn while the camera's in a covered tube | **None in view** in 3,496 samples, driving both tubes end to end |
| Building through the Cahill Expressway | An OSM outline with no height took its neighbours' median, 20 m, from CBD towers | A guessed height now comes from buildings of about the same size. A guess that rises into a deck is cut to fit under it, or left out if there's less than 2.5 m | Buildings rising into a deck: **25 → 8**. The 8 have measured heights and are listed below |
| Bondi Junction, trees and lights in the road | Syd Einfeld Drive is only 1-7 m above the ground there, and nothing placed under a deck looked up | Trees too tall for the room are left out when the tiles are made. In the game, street furniture needs 9 m of room and street trees 12 m | Trees too tall for a deck: **82 → 9**. The jacaranda in the road is gone |
| Kerb in the sky on Bridge St | Not found on Bridge St. Kerbs beside cuttings climbed into the air, being straight for 8 m where the ground falls | Kerbs get extra points where the ground bends under them | Kerb off the ground by over 50 cm: **1,064 m of 21,181 km**, on cliffs. Your position is on the readout now, if it's still there |
| Loading bar missing after a teleport | After the first build nothing used the bar | A teleport starts a bar named for the place. On the move, one shows only when the ground ahead isn't there yet | Shows **0.52-0.57 s** after a teleport at all six places tried, gets to 100% and goes |
| Eye button on the phone | | Gone from the phone's menu. Tablets and desktops keep it | `viewports` checks both |
| Tab reloaded flying north | The game never reloads itself, so iOS killed the tab, most likely for memory | See "Memory" | |

**Buildings with measured heights still rising into a deck:**

| Where | By how much | What's there |
|---|---|---|
| (-476, 176) | 62 m | A tower over the Cross City Tunnel's western end, whose link is marked as a bridge |
| (-11753, -2633) | 12 m | Unnamed, near Ryde |
| (-412, -889) | 12 m | Western Distributor |
| (37, -3152) | 14 m | North end of the Cahill Expressway |
| (-607, 314), (-2237, -230), (-1629, -42) | 3-10 m | Western Distributor and its ramps |

These may be the deck that's wrong, not the building, so I didn't change them.

### Memory

The game now counts what it holds (`js/memory-estimate.js`). That count is on the readout, and it found where the memory was going. At Low over North Sydney, the far level, which draws every distant building as a few points, held 149 MB. The buildings drawn in full held 61 MB.

**What changed:**
- **The far level is packed:** 20 bytes a vertex instead of 44, and built straight into arrays of the right size, so flying leaves far less for the garbage collector.
- **Far squares go sooner:** 1 km past their range instead of 2.
- **A budget:** 170 MB at Low, 280 at Medium, 420 at High, by the game's own count. Over it, the far level reaches less far, a kilometre at a time, and back again when there's room.

| Low graphics, over North Sydney | Before | Now |
|---|---|---|
| The game's own count | 259 MB | **166 MB** |
| Far level | 149 MB | **58 MB** (packed, then pulled in by the budget) |
| Chrome's JavaScript heap after collecting garbage | 394 MB | **294 MB** |
| WebKit's web process (Safari's engine, drawing in software) | 1,590 MB | **1,235 MB** |

| WebKit, flying north at Low for 4 minutes | Before | Now |
|---|---|---|
| City done | 1,264 MB | 1,137 MB |
| Highest | 1,590 MB | 1,442 MB, just after taking off |
| Over Northbridge to Terrey Hills | 1,105-1,467 MB | 1,035-1,198 MB |

**That misses the plan's target,** a third lower in WebKit. It's 9% lower at the highest point and about 22% lower over North Sydney. I tried one more thing, which does reach it. It lets go of the page's own copy of a far square's geometry once it's on the GPU. With it, Chrome's heap came down to 157-239 MB. **But it broke drawing:** something later makes a new GPU buffer from the emptied array, and the screen filled with errors. So I took it out. Finding what makes that buffer would get the rest. Until then your phone is the real test, and the readout's new numbers will say how much the game holds when it goes.

**A note when a tab is killed.** Every 5 s the game writes a small note to local storage: time, place, mode, the memory count and tiles held. A page closed or reloaded the normal way says so on the way out, and so does one put out of view. If the next load finds a note that didn't, the readout shows something like `last session ended without closing at 3:12, flying at (-100, -5900), about 190 MB held, 11 tiles`.

### The rest

| | Before | Now | |
|---|---|---|---|
| Phone profile: interactive | 3.25 s | **3.25 s** | Unchanged |
| First view's download | 688 KB | 690 KB | |
| City complete after that | 23.9 s | 24.1 s | |
| Worst stall while the city builds | About 170 ms | 158 ms | |
| Frames | 40 FPS, p95 33 ms | 39.8 FPS, p95 32.7 ms | |
| Fullest folder in the repository | `public/tiles/`, 1,949 | **`public/map/8/`, 135** | Tiles go in 8 km folders of 64 at most |
| Files in the deploy | 3,983 | 3,983 | |

**Tests:**
- **`npm run check`:** passes in 42 s.
- **`npm run play`:** 9 of 9 key scenarios pass. `touch` failed at first because it expected the eye button on the phone. That's now the other way round, and it passes.
- **New scenarios, both passing:**
  - **`harbour-tunnel`:** both tubes end to end with the sea out of view, and the walls held.
  - **`teleport-bar`:** six menu teleports.
- **`viewports`:** clean.
- **Not run:** the full run, `--full`, and the soak, before this stop. They're next.

**New checks:**
- **`check-roads`:** tunnels inside another tube, tunnels with the sea's sheet inside, buildings rising into decks, and trees under decks.
- **`check-ground`:** kerbs off the ground.
- They're limits at today's numbers, so they can only improve.
- **One limit went up:** road crossings too close together, from 40 to 45 in the CBD sample. Moving tubes apart put three of them nearer another road.

**Test tools:**
- `--browser=webkit` works for play, bench, look and flicker.
- Pictures in a report now show the world under the HUD, not black.
- Long drives record where they were knocked off the route.
- The readout says what the game was doing at its worst frame: `worst 225 ms at 2:47 (tile 1_-3 190 ms)`, or `GPU or browser` if it was nothing the page timed.

## What isn't right yet

- **3 km of tunnel still overlaps another tube,** near mouths and in short underpasses, where moving them would move the street above. The walls hold there anyway. The worst are the Cross City Tunnel by the Eastern Distributor (1006, 28), William St (1413, 72) and James Ruse Drive (-18901, -6002).
- **Memory in WebKit is 9-22% lower, not a third lower.** See above.
- **Not done from Phase D:**
  - **Region edges:** the kerb steps along the generators' region edges (12 m at (7750, -7200)) weren't looked into.
  - **Low decks:** the plan's "a deck too low to walk under is solid below" wasn't needed. A deck under 4.5 m already stands on walls to the ground, and what's under it is hidden.
- **Dead stops** are 924 m at 33 places over the map, against 903 m at 32 before. The worst is still Berowra Waters Rd. That's Phase K.
- **The map screen's images weren't redrawn** for the tubes' few metres of movement. Tunnels hardly show on it.
- **A car can be shown under its road on Cowper Wharf Roadway,** at (980, -618), where it runs in a cutting under the Eastern Distributor. The tunnel scenario's first run strayed there when its route was wrong. The check took the Eastern Distributor overhead for the car's road. It's the "stops at forks and overlaps" problem in `next_3`, and I haven't fixed it.
- **The memory budget's numbers are a guess.** 170 MB at Low is a little over what the game holds at the start. Your test, and the "last session" note if it happens again, will say whether it's low enough.

## What to do next

1. **Your phone test,** above.
2. **Then Phases G to K:** population and land use from the ABS, people and cars by place, houses that look like Sydney's, no centre lines on small streets, and the leftovers. The ABS spreadsheet is already downloaded, in `tools/data/abs/`.
3. **If the tab still reloads,** memory comes before the suburbs. First would be finding why releasing the page's copy broke drawing, and then the full-detail buildings, the next largest part.
