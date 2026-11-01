
# Issues

1. Many buildings seem to start from under the ground
    - can you make sure buildings sit on top of the height plane?
2. It seems that all street signs are labelled as George St


# Features

1. When switching travel mode, can you make it so that they start from where each other left off?
    - this include, walk, cycle, drive and fly
    - when switching to walk, it goes to the nearest footpath
    - when switching to drive, it goes to the nearest road
    - when switching to cycle, it goes to the nearest footpath or road
    - when switching to fly, it goes to directly above in the sky, at a height above most surrounding buildings
        - define an area of surrounding buildings
2. I added some reference photos and videos in ref/
    - search the internet and decide on where these photos and videos are
    - update building and road models according to these references
3. Add a few advertising billboards or company names on top of buildings
    - Man & Bot
    - Maize.Live


# Bigger map

With our current approach, what is the biggest size map we can get to?

Is it possible to do the entire Sydney?
1. north to Palm beach
2. south to Cronulla
3. east to Watsons bay
4. west to Katoomba

With the following update
1. Maps are divided into tiles, 
    - only nearby tiles are downloaded and loaded into memory at any one time
2. Each building can have a few 3D models
    - maybe three?
        - one is just an outline, used when looking at it from a very far distance
        - one is what we have today, 
            - some models can use some more detail
        - one is highly detailed, even with an interior that you can walk into
            - I'll build these models one at a time in the future


# Test

The current test is taking too long to run.
    - perhaps have a lite test?
    - perhaps we don't keep the recording every time?
    - perhaps we can only test the part of the map that's updated, instead of everything?
    - the goal is to make iteration faster
        - We can't have an hour long test for every small change you are making
    - Ignore this request if this is only for testing a specific thing in iteration 1

