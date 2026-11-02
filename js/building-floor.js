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

export { SAMPLE as WALL_SAMPLE, buildingFloor, eachWall };
