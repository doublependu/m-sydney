# Next 5: a rider on the bike, a camera that keeps you in view, and the Harbour Bridge's CBD end

Answers `ai/plan_5.md`. **Phases A to F are done. G, North Sydney, isn't started.** Two sessions did the work; `ai/handover.md` is where the first one stopped, and this replaces it. Nothing is committed or deployed: that's yours.

## What you need to do

1. **Commit and deploy.** `git status` has 49 entries:
   - The code and tests.
   - **5 tiles of 1,811**, all inside the bridge's box, plus `world.json`, `far.json.gz`, `map.json.gz` and one far square.
   - **12 map images** over the bridge.
   
   That's the first commit of map changes that doesn't rewrite every tile.
2. **On your phone, with `?stats=1`:**
   1. **Open it twice,** and note both load times and the new "from cache" line.
   2. **Ride the bike** a few hundred metres.
   3. **In each mode,** drag the camera round you, then move forward. You should turn to where you're looking.
   4. **Drive the video's route:** Clarence St, past Margaret St, then the ramp, over the bridge to North Sydney.
   5. **Come back over the bridge,** taking each way off in turn: the Cahill, York St, the Western Distributor, Grosvenor St.
   6. **Take the Cahill loop up,** and the Cahill on-ramp from Macquarie St.
   7. **Send the readout,** and say if the tab reloaded.
3. **Pictures beside your references:** `ref/details/game/1.jpg` to `6.jpg`, your picture on the left, the game on the right. They're only on this machine, as `ref/` is git-ignored. More are in `recordings/plan5/`.

## Results

### A: the bicycle, the camera, turning to the view, the offline file, the readout

Done in the first session (`ai/handover.md` has the detail):

- **The rider sits on the bike.** The helmet is measured 1.68 m over it.
- **The chase camera aims along its own direction,** so you stay in the middle third of the screen at any orbit, pitch and zoom: 25 orbits × 3 pitches × 3 zooms, phone and desktop.
- **Moving forward turns you to where the camera looks.**
  - **Walk, cycle and fly:** at their own rate.
  - **The car:** through its own steering, within 90°.
- **The offline file is gone.**
- **The readout has two new lines:** where the game loaded, and how many files came from the cache.

`orbit-follow` and `orbit-follow-phone` pass.

### B: no walls between roads side by side

An edge with another road beside it at its level has no barrier, and a gap of up to 2.5 m is filled with deck. Where they carry traffic opposite ways, there's one median barrier.

- **In the CBD sample,** 1,172 m of wall now stands in another road's lane, against 4,070 m before. The ratchet is 1,260 m.
- **What's left is data:**
  - Opposite carriageways that OSM draws overlapping.
  - Roads 0.35-0.5 m apart in height.

### C: local map changes

- **Repeatable:** two whole builds in a row, from the same inputs, gave byte-identical output: all 1,949 files in `public/tiles/` and all 16 in `tools/data/generated/`.
- **Ids that don't shift:**
  - Roads, nodes, structures and kerb islands keep the ids the committed tiles have.
  - The final build kept 115,181 roads, 89,984 nodes and 702 structures. 3 roads were replaced by 3 new ones, where the ways onto the bridge changed.
- **`node tools/tile-diff.mjs`:** "5 of 1811 changed against HEAD, 0 outside the areas edited by hand".
- **No separate trial edit.** The bridge's real edits were the trial, and the far squares changed only where expected:

  | Edit | Tiles | Far squares |
  |---|---|---|
  | The bus lane alone | 3 | none |
  | The bus lane, the loop and the ways onto the bridge | 5 | `-1_-1`, the bridge's |
- **Hand edits:** `tools/local/harbour-bridge-cbd.json`, 11 ways in 4 edits, each with what it fixes and its source. `build-road-tags` now reads them too.
- **The map screen's images redraw by area.** `MAP_AREA=-800,-3600,650,-850 npm run data:map` redrew 12 images and left the rest.
- **A build takes 31-39 minutes** and peaks around 9 GB. Don't run the whole map's unit tests beside one: that's what ran out of memory in the first session.

### D: the bridge itself

- **The deck carries OSM's own carriageways:**
  - The northbound corridor, 4 lanes.
  - The southbound Bradfield Hwy.
  - The bus lane.
  - The Cahill's lane.
- **The bus lane is in, and red.**
  - **It's bus-only:** flag 32 on its road, and traffic keeps cars off it.
  - **Only where a hand edit names it.** The map has 279 bus-only ways, and taking them all at once would change tiles everywhere.
  - **Bus lanes on any bridge are painted now,** not only those on the ground.
- **The east pylons stand between the bus lane and the Cahill's lane,** which goes through their arches with the footway. The railway and cycleway go through the west pylons' arches.
- **Traffic on the deck,** `check-traffic --at=bridgeDeck`, three seeds:

  | | Cars within 500 m | Stopped | Speed |
  |---|---|---|---|
  | Before plan 5 | 27 | 1.33% | 10.1 m/s |
  | Now | 44 | 1% | 11.6 m/s |

### E: on and off at the CBD end

- **The Clarence St ramp is one way, northbound,** the tidal-flow lane in its afternoon setting.
- **The Western Distributor and the Clarence St ramp come up level with the bridge's approach,** and merge with it where its four lanes begin.
  - **Before:** they ended in the air, 9 m short of the corridor, so the two main ways up from the city went nowhere.
  - **The fix:** OSM's last 37 m of the Western Distributor is kept, and both are raised to the deck as bridges.
- **The Cahill loop is a cutting with sheer sandstone walls,** open to the sky all the way round, with its road and markings. The buildings stand on the land above the walls.
  - **In the data:** `tunnel=yes` with `cutting=yes`, which OSM never has together, so only a hand edit makes one. The road has flag 64, and the game never covers it.
  - **Before:** 212 m of it was covered tunnel.
  - **Then, once open:** the kerb island's footpath lay over its road. Now an open cutting cuts kerb islands, as a road on the ground does.
- **Motorway medians are concrete with yellow-and-black bollards,** as in your `2.png` and `6.png`, not lawn or hedge. That's any narrow island beside a motorway, over the whole map. It's drawn by the game, so no tile changed for it.
- **The gantry in your `3.png`:** its six boards over the seven southbound lanes, a green arrow over each lane, and the bus lanes on the left.
- **Your three issues:**
  1. The walls at the south end went in B.
  2. The walls in the Cahill on-ramp went in B, and the Cahill over Circular Quay is a viaduct, not a tunnel (C).
  3. The building blocking the Cahill loop: the loop is now the cutting above.

### F: drives and pictures

**`bridge-ways`,** all eight passing on the final tiles:

| Route | Time | Off its level | Restarts |
|---|---|---|---|
| The video's, Clarence St to North Sydney | 241 s | 0 of 1,977 | 0 |
| Western Distributor up | 131 s | 0 | 0 |
| Grosvenor St up | 88 s | 0 | 0 |
| The Cahill loop up | 148 s | 5 of 1,170 | 0 |
| York St off | 136 s | 0 | 0 |
| Western Suburbs off | 172 s | 0 | 0 |
| Grosvenor St off | 143 s | 0 | 0 |
| The Cahill off | 172 s | 1 of 1,443 | 0 |

No route hit traffic on another level or jumped a level.

**`harbour-bridge`:** over to the far end of the deck (2,241 m) and back to its start.

**Pictures:** `ref/details/game/` and `recordings/plan5/final/`.

### Bugs found on the way

None of these showed until the drives and tests ran on a whole build.

- **Traffic had lost the bridge and everything north of it.**
  - **Why:** the northbound corridor and the southbound carriageway were taken for one road drawn twice. The corridor's lanes were then tested against the kerbs under the deck and cut.
  - **Fix:** deck roads are left out of that rule (`js/road-network.js`).
- **A merge dropped the corridor's start.** A short road whose waiting car stands in another's path is dropped. Two roads that only go on into the same road merge there, they don't cross, so they're exempt now.
- **The road check's 3,306 m of dead stops on the deck** were the check walking every deck road at the old 23 m corridor's lane offsets. It's 193 m now, none of it on the bridge.
- **The scenarios:**
  - **The video's route** went up Grosvenor St: its waypoint was on the wrong ramp. The tidal-flow lane's way in from Clarence St joins at (-339, -1133).
  - **Western Suburbs off** aimed at the Western Distributor's northbound carriageway.
  - **The scripts' sense of "on the deck"** knew only the corridor.

### Load and frames

Phone profile, `npm run bench`, three runs, against `next_4`'s Stop 2:

| | `next_4` | Now |
|---|---|---|
| Interactive | 3.25 s | **3.25 s** (3.22, 3.25, 3.28) |
| Shaders | 1.36 s | 1.39 s |
| First view's download | 699 KB | 714 KB |
| City complete after | 24.9 s | 24.9 s |
| Frames | 40.6 FPS, p95 33.1 ms | 40.0 FPS, p95 33.3 ms |

- **Load and frames are no worse.**
- **Desktop:** interactive in 2.08 s, 59.8 FPS.
- **The 10-minute soak passes:**

  | | Lowest | Highest | At the end |
  |---|---|---|---|
  | Now | 709 MB | 1,273 MB | 742 MB |
  | Before plan 5, the same soak on commit `8e67214` | 463 MB | 1,365 MB | 794 MB |

  Each soak takes its own random path, so the lowest heaps differ by where it went. The peaks and the ends are alike, so I see no leak.

### Tests

- **`npm run check`:** passes in 42 s. 345 unit tests.
- **`npm run play`:** 9 of 9. **`viewports`:** clean.
- **`npm run play -- --full` with the soak:** 37 of 41 in 53 minutes. I changed code after it ran, so the four failures were run again on their own:

  | Scenario | Why it failed | Now |
  |---|---|---|
  | `bridge-edges` | Written for the old 23 m corridor: it drove 11 m from the line, onto the railway | Follows the deck's real outer edges. Passes: no stop it can't explain, 0.51 m from the barrier |
  | `mode-switch` | A car coming down over the footway landed 160 m away on the shore: only the harbour is directly below | Lands on the deck from anywhere over it (`js/arrivals.js`). Passes |
  | `signal-wait` | 18 s at a red at Town Hall, with four scenarios side by side | Load-flaky, as `next_4` found. It passes alone; side by side it passes 4 of 6, with my change or without it |
  | Soak | Its last heap sample caught the heap climbing (1,224 MB) | Passes alone |

- **One thing the soak's rerun found:** "the car is drawn under its road" at (467, -1301), 11.5 m on a road at 17.2 m. That's where the Cahill's cutting and the Harbour Tunnel's approach overlap at two heights. That tile didn't change here, and it hasn't come back since.
- **WebKit wasn't run.**
- **New or rewritten for the bridge's real carriageways:**
  - Deck traffic follows its own road.
  - The Western Distributor and the Clarence St ramp lead onto the bridge.
  - The footway against the deck's east edge.
  - The pylons' granite either side of their arches.
  - Each ramp leaving the deck keeping its level.
  - Nothing past the deck's outer barriers.

## What isn't right yet

- **The Cahill loop:**
  - It has no footbridge over it, as your `1.png` has.
  - Its walls are dressed blocks, not rough-cut rock.
- **The south end's big paved wedges between carriageways** are kerb islands too wide to count as separators. They're painted chevrons on the road in reality.
- **Chevrons where two roads part** (decision 9) aren't painted.
- **People walk out onto the motorway at the south end:** one is in the gantry's picture.
- **The ways up from Bridge St, the Western Distributor and the Cahill loop** are driven onto the bridge's start, not across it. Only the video's route crosses.
- **Lane signals always show the afternoon:** four lanes north (decision 8).
- **Walls:** 1,172 m left in the CBD sample (B).
- **The car drawn under its road** at (467, -1301), seen once in the soak (above).
- **G, North Sydney,** isn't started. It needs references for the southbound side, and some will need your Street View pictures.

## What to do next

1. **Your phone test,** above.
2. **North Sydney,** Phase G of `ai/plan_5.md`, in `tools/local/harbour-bridge-north.json`.
3. **The CBD end's last pieces:**
   - The footbridge over the Cahill loop, and rough rock walls.
   - Chevrons where roads part.
   - The big paved wedges at the south end as road with chevrons.
4. **From `next_4`:**
   - Dead stops to zero.
   - Houses, a second pass.
   - Katoomba.
