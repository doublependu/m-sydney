import { HOUSE_STYLES } from './house-styles.js';
import { oneNumber } from './addresses.js';

// Where a house's front door and a project home's garage door are along its front wall, as the facade draws them (js/tsl-materials.js
// houseWall()): the same bays between the same piers, and the same choice from the bits of the house's digits. The facade makes that
// choice exactly, so the game can find the garage for its driveway (js/house-lots.js), and the door for a path to it.

const PIER = 0.45; // m of wall at each corner before the first bay: HOUSE_PIER
const TERRACE_HOUSE = 5.5; // m: a row of terraces' houses, TERRACE_HOUSE

/**
 * Whether a terrace-styled house is one house by its street address (`address`, the tiles' [{ number }]), whatever the facade would make
 * of its front `width` m long: one number on its main street, not a range, on a front the facade would cut into two houses at most. A
 * front long enough for three or more with one number is more likely a row whose other houses' numbers fell outside its outline: a row.
 */
function oneHouse(address, width) {
  return oneNumber(address) && Math.floor(width / TERRACE_HOUSE + 0.50005) <= 2;
}

/**
 * A house's front wall as js/building-footprints.js keeps it on the building (`frontWall`), from one of its outer walls ({ a, b, width },
 * a and b { x, y } with y the world's z, clockwise as js/addresses.js outerWalls() and the facade have them): { ax, az, bx, bz, reverse,
 * width, digits, single }. `reverse` where its bays count from b, as the facade's do; `digits` the house's last three (its seed's,
 * kept positive); `single` where its street address says it's one house (oneHouse()), which the facade then never cuts into a row.
 */
function frontWallOf(wall, digits, single = false) {
  const { a, b, width } = wall, dx = b.x - a.x, dz = b.y - a.y;
  return { ax: a.x, az: a.y, bx: b.x, bz: b.y, reverse: (Math.abs(dz) >= Math.abs(dx) ? dz : dx) < 0, width, digits, single };
}

/**
 * `front`: a house's front wall as js/building-footprints.js keeps it on the building (`frontWall`): { ax, az, bx, bz, reverse, width,
 * digits, single }, its bays counted from b where it's reversed; `style`: the house's (js/house-styles.js). Its bays and their width (m), and
 * the door's and garage door's middles: { s, x, z } with s m along the wall from where its bays start, and the garage door's `width`. Null
 * where the style has no look; `garage` null where it has none.
 * A terrace's front long enough for two houses is a row of them, as the facade cuts it: `row` { houses, pattern (houseWall()'s), units:
 * [{ s0, s1 (m along the wall from where its bays start), a0, a1 (the same as points), doorBay, door }] }, each house's stretch of the
 * wall and its door; `door` is then the first's. Null on any other, and on a `single` front: one house, whatever its length.
 */
function houseEntry(front, style) {
  const look = HOUSE_STYLES[style]?.look;
  if (!look || !front || !(front.width > 0)) return null;
  const { width, digits: house } = front;
  const pier = Math.min(PIER, width * 0.2);
  const houses = Math.max(Math.floor(width / TERRACE_HOUSE + 0.50005), 1);
  const terraces = !!look.terrace && houses >= 2 && !front.single;
  const bays = terraces ? houses * 2 : Math.max(Math.floor((width - 2 * pier) / look.bay[0] + 0.50005), 1);
  const bay = (width - 2 * pier) / bays;
  const last = bays - 1;
  // houseWall()'s h1, its low six bits, and h2, its seventh
  const h1 = ((house % 64) + 0.5) / 64, h2 = (Math.floor(house / 64) % 2) * 0.5 + 0.25;
  const garage = !!look.garage && bays >= 3;
  const garageAt = h2 <= 0.5 ? 0 : last - 1;
  const byGarage = h2 <= 0.5 ? 2 : last - 2;
  const end = h1 <= 0.5 ? 0 : last;
  const middle = Math.floor(last * 0.5 + (h2 >= 0.5 ? 0.5 : 0));
  const inner = h1 >= 0.725 ? last - 1 : h1 >= 0.45 ? 1 : middle;
  const door = garage ? byGarage : bays >= 3 && !look.terrace ? inner : end;
  // From the wall's start: b where its bays are counted backwards
  const x0 = front.reverse ? front.bx : front.ax, z0 = front.reverse ? front.bz : front.az;
  const ux = ((front.reverse ? front.ax : front.bx) - x0) / width, uz = ((front.reverse ? front.az : front.bz) - z0) / width;
  const at = (s) => ({ s, x: x0 + ux * s, z: z0 + uz * s });
  let row = null;
  if (terraces) {
    // houseWall()'s pattern and rowDoor(): the first house's door in its second bay or its first, the rest the same or each the other way
    const first = house % 64 >= 32 ? 1 : 0, mirrored = Math.floor(house / 64) % 2;
    const units = Array.from({ length: houses }, (_, k) => {
      const doorBay = 2 * k + (mirrored ? (k + first) % 2 : first);
      const s0 = k ? pier + 2 * k * bay : 0, s1 = k < houses - 1 ? pier + 2 * (k + 1) * bay : width;
      return { s0, s1, a0: at(s0), a1: at(s1), doorBay, door: at(pier + (doorBay + 0.5) * bay) };
    });
    row = { houses, pattern: first + 2 * mirrored, units };
  }
  return {
    bays, bay, doorBay: row ? row.units[0].doorBay : door, garageBay: garage ? garageAt : -1,
    door: row ? row.units[0].door : at(pier + (door + 0.5) * bay),
    garage: garage ? { ...at(pier + (garageAt + 1) * bay), width: 2 * Math.min(2.4, bay - 0.3) } : null,
    row
  };
}

export { frontWallOf, houseEntry, oneHouse };
