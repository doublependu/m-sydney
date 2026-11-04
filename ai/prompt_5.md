

# Issues, 

1. bicycle
    - the human character is not on it to start with
    - as the bike moves forward, the human character moves up into the sky
2. panning the camera / looking around does not always keep the vehicle / character centered
    - after moving the mouse a bit, the vehicle or character can go missing
    - this seems to happen in all travel modes, but more obvious in "walk"

# Features

1. Remove the function to download the entire game as a single html file to play offline
    - This is not relevant or possible (?) with this project
2. Update the control in all travel modes
    - after panning the camera into a different direction with mouse or touch, moving forward should gradually align with that direction

# Local areas

I'd like you to focus on a few specific regions on the map

Try to keep the change local so that you don't need to rebuild every tile of the whole map, but let me know if we are not ready for that yet and come up with a plan to get there


## Getting on and off Sydney Harbour Bridge in CBD + the bridge itself

1. the starting point of the video footage in "ref/Driving across the Sydney Harbour Bridge.webm" is one way of going up the bridge
    - make sure you study the footage carefully and refine the map, road structure and building models to allow a smooth drive this day
2. another way up is through cahill expy, the circle has rocks / walls like "ref/details/1.png" on both sides
3. As shown in "ref/details/2.png" and "3.png", coming off the bridge
    - 2 lanes turning left - cahill expy
    - 2 bus lanes leading to the city
    - 2 lanes to western suburbs
    - 2 lanes to city south and darling harbour
    - 2 merging lanes to grosvenor st / city north
    - these are expanded from the lanes on the bridge
        - 2 (or 3, depending on the time of day) + 2 (1 bus lane + 1 lane for cahill expy)
    - "ref/details/4.png" shows from right to left
        - the walk way, which is inside this metal cage
        - 1 lane for cahill expy, which goes through the castle structure
        - the bus lane
        - 3 more lanes going south, which is mostly likely in the morning
4. "ref/details/5.png" shows from left to right
    - two train tracks going through the castle structure
        - one track going north / one track going south
    - 4 lanes going north, which is most likely in the afternoon
5. 3 more ways up the sydney harbour bridge
    - bridge st
    - Western distributor
    - clarence st
    - "ref/details/6.png" 
        - 3 lanes from Western distributor
        - 1 lane from clarence st
        - from cahill expwy and bridge, they merge a bit later, one each side of this

### Issues

1. As shown in "recordings/details/1.png", the on / off part has this strange structures poking out from the road blocking traffic
2. As showd in "recordings/details/2.png", the on ramp to cahill expwy, the wall structure is a bit wrong in the middle of the road, it's also blocking traffic
3. As showd in "recordings/details/3.png", on cahill expwy, onto harbour bridge, about to enter the "circle", a building looks like it's blocking the way


## Getting on and off Sydney Harbour Bridge in North Sydney - stretch goal

Can you get reference images for this part and apply the same level of details as in bridge in CBD?



# mobile testing


```
loaded in 1.55s, webgpu, low, 
60fps, 0 slow, worst 17 ms 
since load 7:05: worst 224 ms at 6:19 (GPU or browser), 72 of 26715 slow
city done at 14.1 s, tiles 9, heap n/a, holds about 55MB
at 6984, -30211, Thyra Rd & Barrenjoey Rd
```
