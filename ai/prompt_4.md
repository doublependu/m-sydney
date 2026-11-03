


Write your plan for map expansion to Katoomba into ai/map_expension.md  I think we are about to hit the number-of-files-per-folder limit of github: we might need to reorganize some of our big folders.  

Postpone the expansion of the map to Katoomba to future iterations and focus on the following issues and other items in next_3.md and next_2.md


# Issues

1. Sydney harbour tunnel need better geometry
    - there are walls in the middle that you can drive through
    - at some point, you are driving under the water
2. Cahill Expy, in front of circular quay, a building pokes out in the middle of the road, 
    - a bus can drive through it
    - I can't drive throught it: collision detection worked there
    - Circular Quay train station is built under this section of Cahill Expy
3. Bondi Junction: trees and street light poke out in the middle of the road
4. Sydney suburbs, outside of the city center, i.e., downtown area
    - There shouldn't be that many cars, buses or pedestrians around
    - Some houses in these suburbs don't look like what we have at all
        - Search the internet and find some common looking houses in Sydney suburbs, a few per suburb, and use those as references
        - buildings next to a main road will look different compared to houses on small neighborhood roads
    - Perhaps, pull some population data to decide on how many people and cars to put in each place
    - small roads in the suburbs are often not marked, i.e., without a center line
5. The loading bar is not always working
    - For example, if I teleport from one map location to another, some new data must be loaded (I guess?) and sometimes I don't see a loading bar. 
6. On bridge st, part of the kurb is in the sky, 
    - it's slightly higher than a person
    - it looks like a kurb to me


# Features

1. on the phone, there's no need for the hide button (eye)



# mobile test

iphone 16e

safari

starting from macquarie st, turn left at bridge st, up harbour bridge:

```
loaded in 1.03 s, webgpu, low
60 fps, 0 slow, worst 17 ms
since load 5:27: worst 225 ms at 2:47, 240 of 22,594 slow
city done at 21.6 s, tiles 10, heap n/a
```


Flying north, the app reloaded once



