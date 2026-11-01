# Next 1: what shipped from plan 1, and what to do next

Answers `ai/plan_1.md`. All four prompt issues and the loading bar are done, with some targets missed; they're listed below. Nothing is deployed. Most of this is in your commit `3c90a83` ("itr 1"). Still uncommitted: the wheels holding the car's level (`js/ground-geometry.js`, `js/surfaces.js`), the sine hash back everywhere but the water (`js/tsl-materials.js`), their test (`tests/road-levels.test.mjs`) and this file.

## Results

Measured on an i5-11400F with an RTX 3060, Chrome 156, cold profile, local server. There is still no integrated GPU or real phone here.

| Measure | Budget | Before | Now |
|---|---|---|---|
| Time to interaction, desktop | 2.5 s | 2.25 s | **2.37 s** (2.31-2.39 at High) |
| Time to interaction, phone profile | 4 s | 3.63 s | **3.93 s** (3.84-4.04, 5 runs). **2 of 5 runs reach the limit** |
| Download | 1.4 MB | 1,383 KB | **1,450 KB, over** |
| Frames, desktop | | 60 FPS, p95 16.8 ms | 57.6 FPS, p95 17.4-19.8 ms |
| Frames, phone profile | no worse | 40 FPS, p95 33.3 ms | **36.2 FPS, p95 33.7 ms, slightly worse** |
| City finished after interaction, desktop | | 8.5 s | 11.8 s |
| City finished after interaction, phone profile | | 22.7 s | **38.5 s** |
| Wheels under the road over 3 cm | under 0.1% | | **3.25%, missed.** Over 15 cm: 0.05%, was 15% |
| Kerb samples onto nothing or a slit | 0 | 13.8% | **0.45%, missed** |
| Crossings under 6.8 m | 0 | | **18 of 417.** All but one are 6.1-6.5 m; one is 2.4 m |
| Footpath area over 0.5 m under the ground | | 14.4% | 0.6% |
| Lawn area over 0.5 m under the ground | | 18.9% | 1.0% |
| Steepest road off the ground | 8% | 98% | **34%** (3 links over 12%) |
| Traffic edges | | 5,524 | 7,027 |
| Traffic edges on the north shore | | 323 | 794 |
| Offline file | 25 MiB | 4.19 MB | 4.21 MB |

The version before this work (`6c80b6e`) measured 3.67-3.89 s on the phone profile the same night, so the difference is about 150-200 ms, and the machine varies by about 100 ms between sessions. The phone profile has almost no margin left.

Why the download is over: `js/geodata.js` gained 47 KB and the height grid 12 KB once compressed, for the road heights and the extra roads. `geodata` could move to a binary format as plan decision 11 allows. I didn't do that.

Firefox, on an earlier build today, in headless mode: 1.52 and 3.11 s to interaction, 25.8 FPS, p95 50 ms, at Low. That frame rate on an RTX 3060 suggests the headless path is holding it back, so treat it as a floor.

## Testing

260 unit tests pass and `npm run viewports` is clean.

| Runs | Result |
|---|---|
| Three full runs of every scenario, on builds that changed between them | Scenarios outside the bridge and road levels passed whenever they ran. The first full run crashed before `offline-file` and the soak, so those ran in the later full runs. The soak passed both times |
| `stacked-roads`, `motorways`, `tunnel`, `under-the-bridge`, `bridge-edges`, 3 more rounds near the final build | All 15 runs passed |
| `harbour-bridge`, same 3 rounds | **2 of 3.** The failure drove 1,870 m in its 330 s limit, stuck in traffic. No recording of that run, so the cause isn't confirmed |
| After the last change (noise hash back to the sine outside the water) | Only `first-minute`, `webgl2-fallback`, `high-graphics`, `low-graphics`, `offline-file` and `tunnel` |

The plan asked for 8 of 8 on `harbour-bridge` and `under-the-bridge`. I didn't run 8. Across all of today's runs from the deck fixes on, `harbour-bridge` is 4 of 5 and `under-the-bridge` 5 of 5.

Recordings of the last full run: `recordings/2026-11-01-11-25-04`. They show the game canvas only, not the HUD. A wheel fix came after it, and the level scenarios were re-run after that without video.

## What shipped

| Phase | Result |
|---|---|
| 1 Tools | `tools/check-ground.mjs`, `tools/play/spots.mjs`, `tools/play/flicker.mjs`, `--browser=firefox`, roads by level in `tools/debug-map.mjs`. No side profiles |
| 2 Harbour Bridge | Barriers where the car is held, pylons outside the deck and clear of the streets, colliders matching the granite. The car does have its shadow on the deck |
| 3 Sky | Fixed. It wasn't the sky: see below. `js/lighting.js` keeps its original sky code |
| 4 Loading bar | Top left, named steps, gone within a second of the city finishing (`js/progress.js`). It's also written to come back on a time-of-day change, but no scenario checks that |
| 5 Height data | Inland holes closed, no step over 10 m. 1,830 land cells still step over 4 m, and the north shore isn't checked against survey points |
| 6 Roads in 3D | Bridges, tunnels, cuttings and motorways in the road graph, with heights solved by `tools/build-heights.mjs` |
| 7 Ground | One `groundHeight()`, a dark base under the city, four wheel contacts for the player's car. The bus, bicycle and traffic don't use contacts |
| 8 Levels | Surfaces by continuity for the player (`js/surfaces.js`), traffic by edge height, the camera kept under decks and roofs, bridges and tunnels on the map |
| 9 Motorways | Real traffic on them, the ambient lanes deleted, York St and the Warringah Fwy reachable from the deck. **Traffic doesn't enter or leave at the map's edges**, so 167 of 454 motorway links carry cars |
| 10 Tunnels | Tubes with lights, cuttings with walls, open mouths, daylight fading inside. William St passes both ways |
| 11 Play, budgets | As above. `hill-start` and a "never drawn under its road" watchdog check are new |

## The bugs worth reading about

Plan 1 guessed the causes of two issues, and both guesses were wrong.

**The sky flicker was the far pedestrians.** The plan blamed depth precision, and I spent a long time rewriting the sky before hiding objects one at a time showed the "sky" was still there with the sky mesh hidden. On WebGL2, three.js reads a storage buffer through a texture only if it's marked as a PBO. Unmarked, `pose.element(i)` ignores `i` and reads the element for the vertex number instead, so people were built from scrambled numbers. Some took a world coordinate as their scale, came out kilometres tall, and the fog painted them in sky colours. That gave flat wedges and dark skies that changed as the camera turned. `setPBO(true)` plus uploading the poses each update fixed it, and pedestrians now appear on Firefox at all. All the sky changes were reverted.

**The dark wedges on the lawns were the triangulator.** `ShapeUtils.triangulateShape` silently dropped 21-24% of the points given to it: interior points passed as one-point holes, and boundary points on straight edges. Triangles ran up to 242 m and cut metres under the ground, so the base showed through. Before the base existed, that was the prompt's "ocean water shows through". `SurfaceMesh` in `js/ground-geometry.js` now triangulates only the outline, then adds the points itself with Delaunay flips.

**The stepped shapes on the water were the noise hash.** `fract(sin(x) * 43758)` with x near 100,000 turns one bit of rounding into a different number, and the shader compiler rounds a lattice corner differently for the cells either side of it, so noise jumped along straight lines. Only WebGPU showed it. A sinless hash fixes it but costs about 130 ms of compile on the phone profile across all materials, so only the water uses it.

**A dead stop at the bridge's barrier.** A move past a structure's edge was resolved by keeping one world axis of it. On a diagonal bridge that keeps 27% of the motion, every frame, so a car skimming the barrier went from 28 m/s to nothing. It slides along the wall now.

**Cliffs in the road.** Where a viaduct ran straight into a tunnel, the tunnel demanded full depth at its first point: the Cahill dropped 9 m in 14 m. Junctions between the two now count as places where a tunnel surfaces.

## Worth knowing when working in this code

- **`tools/build-heights.mjs` must run right after `build-geodata`,** and both now write `JSON.parse('...')`, about four times faster to evaluate in Node than a literal.
- **A structure can be on two levels at one point.** Pass `near` to `surfaceHeight()` and `wheelContacts()` for anything already on it. Without it you get the nearest centre line, which may be the wrong level.
- **Tunnels open only from an end that surfaces** (`openA`, `openB`). Never in the middle: a street's cutting over a deeper tunnel leaves less cover, not a hole.
- **The ground is a lattice and can't step.** `js/tunnel-mouths.js` discards ground fragments inside a box at the four nearest tunnel mouths, or the slope would close them.
- **Ground and buildings before the first frame scale with `drawDistance`:** 315 m at Low. The bridge's geometry and the base now arrive after the first frame.
- **Don't trust an object list for "what's drawn there":** the recordings miss the HUD, and only bisecting scene objects found the sky bug.

## Not done

- **Map edges for traffic** (Phase 9). This is why many motorway links are empty.
- **`harbour-bridge` 8 runs of 8.**
- **North-shore heights against survey points,** and side profiles in `tools/debug-map.mjs`.
- **Wheel contacts for the bus, bicycle and traffic,** and kerbs as retaining walls.
- **The wheel, kerb and crossing targets** in the table above.

## Not verified

- **Your Firefox flicker specifically.** I reproduced flicker on Firefox here and it's gone: no sky flashes while turning in Firefox or in Chrome on either backend, and at most 0.03% of pixels flipping on still frames. That's headless, on an RTX 3060. Please check it in your own browser.
- **Intel UHD and real phones,** still. Everything about those targets rests on the throttled desktop.
- **The helicopter landing on a deck.** `floorBelow()` is there and tested, but no scenario does it.
- **Olympic Dr and Hickson Rd passing under the bridge's ends.** Looked at from `look.mjs --spots`, with no scenario driving them.
- **Whether the mouths and ramps look right to you.** Please watch `tunnel`, `stacked-roads` and `motorways`.

## Known limits

- **The 2.4 m crossing:** Western Distributor Onramp over its neighbour at (-342, 76). Three levels stack within 40 m of where the ramps start, and the grade limit leaves no room.
- **Steep tunnel links:** the Eastern Distributor Onramp dives at 34% and 28% to pass under the Cross City Tunnel near its mouth.
- **Tunnel mouths aren't tidy.** Wall tops follow the ground in wedges, and pedestrians can wait on the road by the William St walls.
- **A pale band across the William St tube's ceiling,** about 100 m in. Not explained.
- **Low viaducts over dark ground.** Three motorway links were lifted to give the deck's ramps room, so the ground road under them is gone and the base shows. Kerbs facing them count as open, which is probably some of the rise from 0.35% to 0.45% after they were lifted.
- **Sine noise everywhere but the water** could show the same lines where it's broad. I didn't see any.
- **3 of the last 8 desktop bench runs picked Low** (1.71-2.47 s), where every earlier one picked High. Not looked into.
- **Stale New York signs:** "DUANE READE · PHARMACY" in `js/buildings.js:325`, and "NEIGHBORHOOD DELI" among the storefronts.

## What to do next

1. **Play it in your own Firefox, and watch the recordings.** That settles the flicker and the look of the tunnels.
2. **Win back phone load time.** It's the Spec's hard limit, and 2 of 5 runs reach it. The biggest remaining pieces are shader compile (1.3 s) and `surfaces.js` and `city-config.js` at start-up (84 ms in Node here, so roughly 300 ms on the phone profile). The roads' spatial index could be built per tile on demand.
3. **Run it on a real Intel laptop and a real phone,** then retune `js/quality.js`, still open from plan 0.
4. **Traffic in and out at the map's edges.** It would fill the motorways and much of the north shore.
5. **Find out why deck traffic is so slow.** A crossing takes 3 to 5 minutes and sometimes doesn't finish. That's what's left of `harbour-bridge`'s failures.
6. **Move `geodata` to a binary format** to get back under the download budget.
7. **Finish the ground targets:** wheels first (Moore Park Rd at (1484, 1319) is the worst, 0.9 m), then the kerbs.
