// A building is level, and the ground under it usually isn't. Its floor goes at the highest ground along its walls, so
// no wall starts underground and the ground never cuts a row of windows. Below the floor each wall runs on down to the
// ground in stone (building-footprints.js).

const SAMPLE = 4; // metres along a wall. The ground is a 20 m lattice, so a slope can't hide much between samples

function eachWall(polygons, visit) {
  for (const polygon of polygons) {
    for (const ring of [polygon.outer, ...(polygon.holes || [])]) {
      for (let i = 0; i < ring.length; i++) visit(ring[i], ring[(i + 1) % ring.length]);
    }
  }
}

/** { floor, low }: the highest and lowest ground along the walls of a list of { outer, holes } polygons, points { x, z } */
function buildingFloor(polygons, groundAt) {
  let floor = -Infinity, low = Infinity;
  eachWall(polygons, (a, b) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / SAMPLE));
    for (let k = 0; k < steps; k++) {
      const y = groundAt(a.x + ((b.x - a.x) * k) / steps, a.z + ((b.z - a.z) * k) / steps);
      if (y > floor) floor = y;
      if (y < low) low = y;
    }
  });
  return { floor, low };
}

// Where a building's door is known (js/building-door.js), its floor goes at the ground there instead, its uphill walls cut into the
// slope: never more than MAX_CUT under the highest ground along its walls, and where the door is within KEEP of the ground under the
// highest-ground floor, that floor stays (one step up). A building on the high side of its door, below its street, is as before.
const MAX_CUT = 3; // m
const KEEP = 0.3; // m

/** The floor of a building whose highest ground along its walls is `highest`, with the ground `door` at its door */
function doorFloor(highest, door) {
  if (!(highest - door > KEEP)) return highest;
  return Math.max(door, highest - MAX_CUT);
}

export { KEEP as DOOR_KEEP, MAX_CUT, SAMPLE as WALL_SAMPLE, buildingFloor, doorFloor, eachWall };
