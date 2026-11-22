// Street addresses: the street a building faces and its numbers. tools/build-buildings.mjs matches G-NAF's address points (Overture's
// addresses theme) to the buildings and their streets to the roads, once, and the tiles keep the answer (tools/tiles/pack-buildings.mjs,
// js/tiles/tile-file.js), so everything that reads it reads the same one.

/** A street's name as G-NAF's and OSM's spellings both come to it: upper case, letters and digits, no apostrophes, single spaces */
function streetKey(name) {
  return (name || '').toUpperCase().replace(/['’]/g, '').replace(/[^A-Z0-9]+/g, ' ').trim();
}

/**
 * A street's name looser still, for where it isn't found as it's spelt: without a last word that says which part of the road it is
 * (`NORTH`, `SOUTH`, `EAST`, `WEST`: OSM names Port Hacking Road South what G-NAF has as Port Hacking Road, and G-NAF has Mowbray Road
 * West where OSM has Mowbray Road), `BOULEVARDE` as `BOULEVARD`, `SAINT` as `ST` (Saint Charbel Way), and with no spaces (Broad Arrow
 * Road, G-NAF's Broadarrow Road)
 */
function looseStreetKey(name) {
  return streetKey(name).replace(/ (NORTH|SOUTH|EAST|WEST)$/, '').replace(/\bBOULEVARDE\b/g, 'BOULEVARD').replace(/\bSAINT\b/g, 'ST').replace(/ /g, '');
}

/**
 * A street number as G-NAF writes it (`405`, `399A`, `1-3`, `27-27A`): { n, letter, to, toLetter }, letters 1-26 for A-Z and 0 for
 * none, `to` 0 where it isn't a range; or null where it doesn't start with a number (`LOT 19`). What follows a number that isn't one of
 * these (`326GF`, `5A-T`) is dropped.
 */
function parseNumber(text) {
  const m = /^(\d+)([A-Z](?![A-Z]))?(?:-(\d+)([A-Z])?)?/.exec(text || '');
  if (!m) return null;
  const code = (c) => (c ? c.charCodeAt(0) - 64 : 0);
  const n = +m[1], letter = code(m[2]);
  let to = m[3] ? +m[3] : 0, toLetter = m[3] ? code(m[4]) : 0;
  // Not a range, written as one (`4-4`), or backwards
  if (to && (to < n || (to === n && toLetter <= letter))) to = toLetter = 0;
  return { n, letter, to, toLetter };
}

/** The numbers of one building on one street, as a plate shows them: the lowest to the highest, or the one */
function numberSpan(numbers) {
  let lo = null, hi = null;
  const less = (a, al, b, bl) => a < b || (a === b && al < bl);
  for (const p of numbers) {
    if (!p) continue;
    const endN = p.to || p.n, endL = p.to ? p.toLetter : p.letter;
    if (!lo || less(p.n, p.letter, lo.n, lo.letter)) lo = { n: p.n, letter: p.letter };
    if (!hi || less(hi.n, hi.letter, endN, endL)) hi = { n: endN, letter: endL };
  }
  if (!lo) return null;
  const range = hi.n !== lo.n || hi.letter !== lo.letter;
  return { n: lo.n, letter: lo.letter, to: range ? hi.n : 0, toLetter: range ? hi.letter : 0 };
}

/** A number as text: `399A`, `1-3` */
function numberText({ n, letter, to, toLetter }) {
  const L = (c) => (c ? String.fromCharCode(64 + c) : '');
  return `${n}${L(letter)}${to ? `-${to}${L(toLetter)}` : ''}`;
}

/**
 * A number as the tiles write it, unsigned integers for a varint stream: n * 4 + 1 if it has a letter + 2 if it's a range; then the
 * letter (1-26) if it has one; then for a range, to * 2 + 1 if that has a letter, and that letter. Most take two bytes.
 */
function numberCodes({ n, letter, to, toLetter }) {
  const out = [n * 4 + (letter ? 1 : 0) + (to ? 2 : 0)];
  if (letter) out.push(letter);
  if (to) {
    out.push(to * 2 + (toLetter ? 1 : 0));
    if (toLetter) out.push(toLetter);
  }
  return out;
}

/** numberCodes() read back, `next()` giving each unsigned integer in turn */
function numberFromCodes(next) {
  const head = next();
  const n = Math.floor(head / 4), letter = head & 1 ? next() : 0;
  let to = 0, toLetter = 0;
  if (head & 2) {
    const t = next();
    to = Math.floor(t / 2);
    if (t & 1) toLetter = next();
  }
  return { n, letter, to, toLetter };
}

/**
 * The outer walls of a building's `polygons` ([{ outer: [{ x, z }], holes }], as the tiles have them) as js/building-footprints.js
 * builds them, in its order: each polygon's outer ring clockwise, as THREE.ShapeUtils has it, wall j from point j to the next, the
 * polygons one after another, those with fewer than three points left out. A stored door wall is an index into this list.
 * Each wall { a: { x, y }, b: { x, y }, width }, y the world's z, as the facade's walls are.
 */
function outerWalls(polygons) {
  const walls = [];
  for (const polygon of polygons) {
    const ring = polygon.outer.map((p) => ({ x: p.x, y: p.z }));
    if (ring.length > 1 && ring[0].x === ring[ring.length - 1].x && ring[0].y === ring[ring.length - 1].y) ring.pop();
    if (ring.length < 3) continue;
    let area = 0;
    for (let p = ring.length - 1, q = 0; q < ring.length; p = q++) area += ring[p].x * ring[q].y - ring[q].x * ring[p].y;
    if (area >= 0) ring.reverse(); // THREE.ShapeUtils.isClockWise() is area < 0
    ring.forEach((a, j) => {
      const b = ring[(j + 1) % ring.length];
      walls.push({ a, b, width: Math.hypot(b.x - a.x, b.y - a.y) });
    });
  }
  return walls;
}

const FACING = Math.cos(Math.PI / 4);
/**
 * A flat's or shop's walls that face `street` ({ x, z }) from (cx, cz): the open ones (not against a neighbour: `adjacentHeight` 0),
 * 2.5 m or longer, turned within 45 degrees of the way to it, and `front` (js/building-footprints.js houseFront()'s, the one facing most
 * nearly towards it) whatever it is. `walls` as houseFront() takes them.
 */
function facingWalls(walls, street, cx, cz, front) {
  const dx = street.x - cx, dz = street.z - cz, d = Math.hypot(dx, dz) || 1;
  return walls.filter((w) => w === front || (w.width >= 2.5 && !w.adjacentHeight
    && ((-(w.b.y - w.a.y) / w.width) * dx + ((w.b.x - w.a.x) / w.width) * dz) / d >= FACING));
}

/** How far (x, z) is from a wall { a, b } as outerWalls() gives them */
function wallDistance(w, x, z) {
  const dx = w.b.x - w.a.x, dz = w.b.y - w.a.y, L2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - w.a.x) * dx + (z - w.a.y) * dz) / L2));
  return Math.hypot(w.a.x + dx * t - x, w.a.y + dz * t - z);
}

export { facingWalls, looseStreetKey, numberCodes, numberFromCodes, numberSpan, numberText, outerWalls, parseNumber, streetKey, wallDistance };
