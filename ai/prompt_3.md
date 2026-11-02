
Continue plan 2 (ai/plan_2.md) with the remaining phases, 13 to 17: moving origin and
horizon, detailed buildings, Inner Sydney, all of Sydney, and the final play and budgets.
ai/next_2.md says where things stand, including where the work differed from the plan.

The real phone gate passed: on my iPhone it loaded in 0.98 s on WebGPU at Low, showed
60 FPS, finished the city in 11.2 s, and drove and flew for a minute without crashing.

1. Before Phase 15, fix the traffic hold-ups at merges (open item 3 in next_2), so
   suburbs don't make them worse.
2. Update the phases for what Phases 11 and 12 changed, especially the generators, which
   still work on the whole map, and the map screen.
3. Large downloads are fine: the OSM extract, the elevation model and Overture. Tell me
   the disk space needed first.
4. Phase 14 only needs the plain test building. I'll make real models later.
5. Stop after Phase 15 so I can test Inner Sydney on my phone for 10 minutes, and again
   after Palm Beach and Cronulla before going on to Katoomba.
6. Add to the ?stats=1 readout the worst frame since loading, not just the last second.


The above is the prompt you gave me after reporting performance on the phone. 

I also notice a few issues:

1. Some roads have a very big slant left to right
    - I don't think normal roads are designed like this: they can go up or down but rarely have a big slant left to right or right to left
2. Buttons on a mobile phone is not designed properly, they block views if not hidden
3. The roads seem to have 2 colors, one is dark and the other is light brown. 
    - I don't think this is intentional because the two colors switch in a random way
    - worth looking into what's going on here
4. Traffic lights seem to take forever to turn green even when cars from other directions have stopped moving
5. Repeated run of the full test is still slow, when possible, perhaps you can keep implementing while waiting for tests to finish
    - another option, instead of testing with manual play to see if a road can be driven well
    - maybe you can come up with some criteria on the "smoothness" of a road for it to drive hassle-free
    - There are still protrusion and artificial "bumps" in some roads that can stop an otherwise good drive. 

