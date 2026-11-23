// Street numbers on the buildings near you: a plate for each street a building's address is on (js/addresses.js, the tiles' `address`),
// where its numbers are known. Worked out once a building's walls are built (js/building-footprints.js numberPlates()), and for a house's
// letterbox with its lot's things (js/lot-things.js letterboxPlate()); drawn by js/lot-details.js as one instanced mesh, a quad a plate,
// its digits from an atlas (js/tsl-materials.js createNumberPlateMaterial()), nearest first, each only as far as its digits can be read.
// - A house: beside its front door, as the facade draws it (js/house-entry.js houseEntry()), on the side away from its sidelight and its
//   garage door, at about chest height; and on its letterbox.
// - A low-rise flat or shop (one whose address gives it a wall to its street): over the entrance the facade draws nearest its street on
//   that wall (js/addresses.js entranceNear()); on a shop's wall, over its shopfront's sign.
// - Any other building: on the wall facing each of its address streets (js/building-footprints.js houseFront(), not one against a
//   neighbour), where it's nearest that street, 3 m up.
// - Another address street: a plate on its own wall, once a wall; none where the ground runs up over it (a corner house's side, cut into
//   the slope).
// Buildings the tiles leave out (landmarks, model sites) have none, and a hand edit can take a building's numbers away
// (`numbers: false`, tools/local/).

import { entranceNear } from './addresses.js';
import { frontWallOf, houseEntry } from './house-entry.js';

// The characters a plate can show, each a cell of the atlas after a blank one (0)
const GLYPHS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-';
const MOST = 12; // characters on a plate: three words of four
const WIDEST = 100; // a range wider than this shows its first number: G-NAF's few wider ones are mostly numbers run together (23-2325)
const CELL = 0.8; // a character's width, of its digits' height: the atlas's cells are 1 wide by 2 high, for a plate 1.6 digits high
const HIGH = 1.6; // a plate's height, of its digits'
const PAD = 0.3; // of the digits' height, either end
// Digits' height (m) on each kind of plate
const SIZE = { house: 0.13, letterbox: 0.055, flat: 0.18, other: 0.28 };
// m a plate is drawn from you, for each m of its digits' height: about a pixel and a half of digit on a phone's or a laptop's screen
const READ = 650;
const OUT = 0.025; // m off the wall's face
const GAP = 0.08; // m between a door's frame and its plate
const DOOR_HALF = 0.53; // m: a house's door and its frame either side of its middle (houseWall()'s door, 0.46 + 0.07)
const SIDELIGHT = 0.36; // m more on the side its bays count towards, where its style has a sidelight
const ENTRANCE_TOP = 2.68; // m over the wall's foot: the city facade's entrance and its frame (createBuildingEntrance())
const SIGN_TOP = 3.36; // m over the wall's foot: a shopfront's sign (createStorefront())
const HOUSE_AT = 1.5; // m over a house's floor, a plate's middle
const OTHER_AT = 3; // m over the wall's foot, any other building's

// The plates' colours (linear-ish hex as the shader takes them) and their digits': white ceramic, black, brass, blue and green enamel
const PALETTE = [
  { plate: 0xeeebe2, ink: 0x16191e }, { plate: 0x1e1f21, ink: 0xf2efe6 }, { plate: 0xb58f45, ink: 0x1a1712 },
  { plate: 0x1d4f91, ink: 0xf4f2ec }, { plate: 0x2c5a3c, ink: 0xf4f2ec }
];
// Which of them, by kind, with their shares
const PALETTES = { house: [[0, 0.45], [1, 0.25], [2, 0.3]], flat: [[0, 0.4], [1, 0.4], [2, 0.2]], other: [[0, 0.35], [1, 0.3], [3, 0.25], [4, 0.1]] };

/** A number in [0, 1) from a point: the same for a house's door and its letterbox, which both have its address's point */
function rollAt(x, z) {
  let h = (Math.round(x * 2) * 73856093) ^ (Math.round(z * 2) * 19349663);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

function paletteOf(kind, x, z) {
  const list = PALETTES[kind === 'letterbox' ? 'house' : kind === 'shop' ? 'flat' : kind] || PALETTES.other;
  let roll = rollAt(x, z);
  for (const [k, share] of list) {
    if (roll < share) return k;
    roll -= share;
  }
  return list[list.length - 1][0];
}

/**
 * A street's number as a plate shows it (`399A`, `1-3`), or null: no number, or none it can show. A range too long to show, or wider than
 * WIDEST, shows its first number.
 */
function plateText(number) {
  if (!number) return null;
  let text = String(number).toUpperCase();
  const range = /^(\d+)[A-Z]?-(\d+)/.exec(text);
  if (text.length > MOST || (range && +range[2] - +range[1] > WIDEST)) text = text.split('-')[0];
  if (!text || text.length > MOST || [...text].some((c) => !GLYPHS.includes(c))) return null;
  return text;
}

/** A plate's characters as the shader reads them: three numbers, each four cells of the atlas, 6 bits a cell (exact in a float) */
function glyphCodes(text) {
  const codes = [0, 0, 0];
  [...text].forEach((c, k) => { codes[Math.floor(k / 4)] += (GLYPHS.indexOf(c) + 1) * 64 ** (k % 4); });
  return codes;
}

/** A plate's width (m) for `n` characters of digits `h` m high */
const plateWidth = (n, h) => (n * CELL + 2 * PAD) * h;

/**
 * A plate: its middle (x, y, z) on a wall, `out` m off it, facing (nx, nz); `kind` (SIZE's), `text` as plateText() gives it, `key` the
 * point its colour is picked by (its address's). { x, y, z, nx, nz, h, w, text, n, codes, palette, far }: `far`, m it's drawn to at most.
 */
function plateOf({ x, y, z, nx, nz }, kind, text, key) {
  const h = SIZE[kind === 'shop' ? 'flat' : kind] ?? SIZE.other;
  return { x, y, z, nx, nz, h, w: plateWidth(text.length, h), text, n: text.length, codes: glyphCodes(text),
    palette: paletteOf(kind, key.x, key.z), far: h * READ, kind };
}

/** A wall { a, b, width } (js/addresses.js outerWalls()'s, y the world's z): along it from a, and out of it, as the facade's normals are */
function frameOf(wall) {
  const ux = (wall.b.x - wall.a.x) / wall.width, uz = (wall.b.y - wall.a.y) / wall.width;
  return { ux, uz, nx: -uz, nz: ux, at: (s, y, out = OUT) => ({ x: wall.a.x + ux * s - uz * out, y, z: wall.a.y + uz * s + ux * out, nx: -uz, nz: ux }) };
}

/** m along a wall from its a nearest (x, z), keeping a plate `w` wide on it with `margin` m either end where it fits */
function alongNearest(wall, x, z, w, margin = 0.3) {
  const { ux, uz } = frameOf(wall);
  const s = (x - wall.a.x) * ux + (z - wall.a.y) * uz;
  if (wall.width < w + 2 * margin) return wall.width / 2;
  return Math.max(w / 2 + margin, Math.min(wall.width - w / 2 - margin, s));
}

/**
 * Beside a house's door on `front` (its front wall as js/house-entry.js has it, `frontWall`): where its plate goes, { x, y, z, nx, nz },
 * or null where its style has no door. On the side of the door away from its sidelight (where its bays count from) and its garage door,
 * else the other, else over it. `base`: its walls' foot (its floor + 0.22, where the door stands).
 */
function besideDoor(front, style, base, w) {
  const entry = houseEntry(front, style);
  if (!entry) return null;
  const { door, garage } = entry;
  const x0 = front.reverse ? front.bx : front.ax, z0 = front.reverse ? front.bz : front.az;
  const ux = ((front.reverse ? front.ax : front.bx) - x0) / front.width, uz = ((front.reverse ? front.az : front.bz) - z0) / front.width;
  // Out of the wall, as the facade's normals are: from a to b, turned
  const ax = front.ax, az = front.az, L = front.width;
  const nx = -(front.bz - az) / L, nz = (front.bx - ax) / L;
  const room = entry.row ? [entry.row.units[0].s0, entry.row.units[0].s1] : [0, front.width];
  const sides = garage && garage.s < door.s ? [1, -1] : [-1, 1];
  for (const side of sides) {
    const s = door.s + side * (DOOR_HALF + (side > 0 ? SIDELIGHT : 0) + GAP + w / 2);
    if (s - w / 2 < room[0] + 0.15 || s + w / 2 > room[1] - 0.15) continue;
    if (garage && Math.abs(s - garage.s) < garage.width / 2 + 0.1 + w / 2) continue;
    return { x: x0 + ux * s + nx * OUT, y: base + HOUSE_AT, z: z0 + uz * s + nz * OUT, nx, nz };
  }
  // Over it, its fanlight's top and frame
  return { x: x0 + ux * door.s + nx * OUT, y: base + 2.6 + GAP + (HIGH * SIZE.house) / 2, z: z0 + uz * door.s + nz * OUT, nx, nz };
}

/**
 * A building's plates, once its walls are worked out (js/building-footprints.js): `record` its record there ({ address, house (its style,
 * 0 for none), frontWall, seed }), `outer` its outer walls as they're built (with `adjacentHeight` against its neighbours), and
 * `base` its walls' foot (its floor + 0.22). `shops`: the walls drawn with shopfronts; `fronts`: a house's walls drawn as fronts (its
 * doors); `frontOf(street)`: houseFront() facing that street, among its walls not against a neighbour; `digits`: a house's, as its walls
 * carry them; `groundAt(x, z)`: the ground as it's drawn, which no plate goes under. [] where it has no number to show.
 */
function numberPlates(record, outer, { base, shops = new Set(), fronts = new Set(), frontOf, digits = 0, groundAt = null }) {
  const plates = [];
  if (!record.address?.length) return plates;
  const used = new Set();
  const key = record.address[0];
  for (const [k, street] of record.address.entries()) {
    const text = plateText(street.number);
    if (!text) continue;
    let wall = street.wall >= 0 ? outer[street.wall] : null;
    if (!wall?.width) wall = frontOf?.(street) ?? null;
    if (!wall?.width || used.has(wall)) continue;
    used.add(wall);
    const kind = record.house ? 'house' : street.wall >= 0 ? (shops.has(wall) ? 'shop' : 'flat') : 'other';
    const h = SIZE[kind === 'shop' ? 'flat' : kind], w = plateWidth(text.length, h), f = frameOf(wall);
    let at = null;
    if (record.house) {
      // Its front's door, or a terrace's other front's (the facade draws a door on each, from the same digits)
      const front = k === 0 && record.frontWall ? record.frontWall : fronts.has(wall) ? frontWallOf(wall, digits) : null;
      at = front && besideDoor(front, record.house, base, w);
      at ??= f.at(alongNearest(wall, street.x, street.z, w), base + HOUSE_AT);
    } else if (street.wall >= 0) {
      const e = entranceNear(wall, street.x, street.z);
      const s = Math.max(w / 2 + 0.1, Math.min(wall.width - w / 2 - 0.1, e.s));
      at = f.at(s, base + (kind === 'shop' ? SIGN_TOP : ENTRANCE_TOP) + GAP + (HIGH * h) / 2);
    } else {
      at = f.at(alongNearest(wall, street.x, street.z, w, 0.6), base + (shops.has(wall) ? SIGN_TOP + GAP + (HIGH * h) / 2 : OTHER_AT), OUT + 0.005);
    }
    // Not where the ground in front of it is over its foot
    if (groundAt && at.y - (HIGH * h) / 2 < groundAt(at.x + at.nx * 0.5, at.z + at.nz * 0.5) + 0.05) continue;
    plates.push(plateOf(at, kind, text, key));
  }
  return plates;
}

/**
 * A plate on a house's letterbox: `face` the middle of its face to the street { x, y, z } and that way out (nx, nz); `address` the house's
 * (the tiles'). Null where it has no number to show.
 */
function letterboxPlate(face, address) {
  const text = plateText(address?.[0]?.number);
  return text ? plateOf(face, 'letterbox', text, address[0]) : null;
}

export { GLYPHS, HIGH, CELL, MOST, PAD, PALETTE, READ, SIZE, glyphCodes, letterboxPlate, numberPlates, plateText, plateWidth };
