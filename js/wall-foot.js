import { KIND, STRUCTURES, groundHeight, groundRoadAt, roadHeight, structuresAt } from './surfaces.js';

// How far a building's wall comes down at (x, z), under its floor: to the ground, or, where a road passes under the building (sunk into
// a cutting, in a tunnel's open cutting, or on a deck under its floor), to a lane's height over that road, so the wall stops over the
// road as a real building's does over a road through it. In a cutting the ground is the road itself (js/surfaces.js), so a wall drawn
// down to the ground stood across the lanes there, and cars drove through it (js/building-footprints.js draws a wall from its floor
// down to here). tools/tiles/derive.mjs raises a building's floor to leave this room.
const CLEAR_OVER_ROAD = 4.5; // m: a bus, and a little

function wallFootAt(x, z, floor = Infinity) {
  let foot = groundHeight(x, z);
  const road = groundRoadAt(x, z);
  if (road?.cut) foot = Math.max(foot, roadHeight(road, x, z) + CLEAR_OVER_ROAD);
  // A covered tunnel's road is far under the ground, and a deck over the building isn't under its wall
  for (const s of structuresAt(x, z)) {
    const kind = STRUCTURES[s.sid]?.kind;
    if ((kind === KIND.TUNNEL || kind === KIND.BRIDGE) && s.y < floor) foot = Math.max(foot, s.y + CLEAR_OVER_ROAD);
  }
  return foot;
}

export { CLEAR_OVER_ROAD, wallFootAt };
