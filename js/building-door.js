// Where a building's door is, from the street address the tiles keep (js/addresses.js), as the game draws it: a house's on the front wall
// its address gives, where js/house-entry.js finds it on the facade; a low-rise flat's or shop's at the entrance the facade draws
// (createBuildingEntrance(), js/addresses.js entranceNear()) nearest its address, on the wall to its main street. tools/tiles/derive.mjs
// puts a building's floor at the ground there (js/building-floor.js doorFloor()). Read by the build and its checks, not by the game.
import { entranceNear, outerWalls } from './addresses.js';
import { frontWallOf, houseEntry, oneHouse } from './house-entry.js';
import { HOUSE_STYLES } from './house-styles.js';

/** A house's digits as its walls carry them (js/building-footprints.js wallSeed()): its seed's last three, kept positive */
const houseDigits = (seed) => ((Math.floor(seed) % 1000) + 1000) % 1000;

/**
 * `b`: a building (a tile's, or tools/build-buildings.mjs' records) with its `address` ([{ x, z, wall, at }]: `at`, its address points'
 * middle, is in the build's records only; the street's point stands in for it) and `polygons`; `seed`: its look's (js/building-look.js
 * buildingLook(), from the whole of it). Its door { x, z, front }: `front`, a house's front wall as the game keeps it (`frontWall`); or
 * null where it has none: no address, or no wall to its street.
 */
function doorOf(b, seed) {
  const street = b.address?.[0];
  if (!street || street.wall < 0) return null;
  const wall = outerWalls(b.polygons)[street.wall];
  if (!wall?.width) return null;
  const look = HOUSE_STYLES[b.houseStyle || 0]?.look;
  if (look) {
    const front = frontWallOf(wall, houseDigits(seed), !!look.terrace && oneHouse(b.address, wall.width));
    const entry = houseEntry(front, b.houseStyle);
    return entry && { x: entry.door.x, z: entry.door.z, front };
  }
  const at = street.at ?? street;
  const door = entranceNear(wall, at.x, at.z);
  return { x: door.x, z: door.z, front: null };
}

export { doorOf, houseDigits };
