import { GEO, onMap } from './geodata.js';
import { shortName } from './city-config.js';

// What a street sign says: the roads that really meet at a junction, each named on a blade running parallel to it.

const RG = GEO.roadGraph;
const CELL = 64;
const nodeX = (i) => RG.nodes[i * 2], nodeZ = (i) => RG.nodes[i * 2 + 1];
const KIND = 9, MAJOR = 7, NAME = 2, INNER = 6;
const NOT_A_STREET = /(ramp|tunnel)\b/i;

// At each graph node, the named ground-level roads leaving it, with the direction each leaves in
let linksAtNode = null;
let nodeCells = null;
onMap({ addLink() { linksAtNode = null; }, removeLink() { linksAtNode = null; } });
function index() {
  if (linksAtNode) return;
  linksAtNode = new Map();
  nodeCells = new Map();
  const add = (node, name, major, fromX, fromZ, toX, toZ) => {
    const L = Math.hypot(toX - fromX, toZ - fromZ);
    if (L < 0.5) return;
    if (!linksAtNode.has(node)) {
      linksAtNode.set(node, []);
      const key = Math.floor(nodeX(node) / CELL) * 100000 + Math.floor(nodeZ(node) / CELL);
      if (!nodeCells.has(key)) nodeCells.set(key, []);
      nodeCells.get(key).push(node);
    }
    linksAtNode.get(node).push({ name, major, ux: (toX - fromX) / L, uz: (toZ - fromZ) / L });
  };
  for (const link of RG.links) {
    const name = RG.names[link[NAME]];
    if (!name || link[KIND] || NOT_A_STREET.test(name)) continue;
    const [a, b] = link, inner = link[INNER];
    const nearA = inner.length ? [inner[0], inner[1]] : [nodeX(b), nodeZ(b)];
    const nearB = inner.length ? [inner.at(-2), inner.at(-1)] : [nodeX(a), nodeZ(a)];
    add(a, name, link[MAJOR], nodeX(a), nodeZ(a), nearA[0], nearA[1]);
    add(b, name, link[MAJOR], nodeX(b), nodeZ(b), nearB[0], nearB[1]);
  }
}

/** The named streets meeting within `radius` of (x, z), once each and major roads first: [{ name, short, ux, uz }] */
function junctionRoads(x, z, radius = 25) {
  index();
  const found = new Map();
  for (let ix = Math.floor((x - radius) / CELL); ix <= Math.floor((x + radius) / CELL); ix++) {
    for (let iz = Math.floor((z - radius) / CELL); iz <= Math.floor((z + radius) / CELL); iz++) {
      for (const node of nodeCells.get(ix * 100000 + iz) || []) {
        if (Math.hypot(nodeX(node) - x, nodeZ(node) - z) > radius) continue;
        for (const road of linksAtNode.get(node)) {
          const had = found.get(road.name);
          if (!had || road.major > had.major) found.set(road.name, road);
        }
      }
    }
  }
  return [...found.values()]
    .sort((a, b) => b.major - a.major || a.name.localeCompare(b.name))
    .map(({ name, ux, uz }) => ({ name, short: shortName(name), ux, uz }));
}

/** Graph nodes where two or more differently named streets meet, each with its position and roads */
function namedJunctions() {
  index();
  const out = [];
  for (const [node, roads] of linksAtNode) {
    if (new Set(roads.map((r) => r.name)).size < 2) continue;
    out.push({ x: nodeX(node), z: nodeZ(node), roads: junctionRoads(nodeX(node), nodeZ(node), 6) });
  }
  return out;
}

/** Where the two blades on a pole go: each along its road, reaching out towards the junction from (x, z) */
function bladesOnPole(roads, x, z, jx, jz, height, reach = 0.68) {
  return roads.slice(0, 2).map((road, i) => {
    const towards = (jx - x) * road.ux + (jz - z) * road.uz >= 0 ? 1 : -1;
    return {
      text: road.short,
      x: x + road.ux * towards * reach, y: height - i * 0.37, z: z + road.uz * towards * reach,
      yaw: Math.atan2(-road.uz, road.ux)
    };
  });
}

// Cells of a small texture, holding whichever names are near the player: memory stays the same however big the map gets.
// A name in use keeps its cell; a new one takes the cell of whichever hasn't been wanted for longest.
class SignAtlas {
  constructor(cells, draw) {
    this.cells = Array.from({ length: cells }, () => ({ text: null, used: -1 }));
    this.byText = new Map();
    this.draw = draw;
    this.tick = 0;
    this.drawn = false;
  }

  begin() {
    this.tick++;
    this.drawn = false;
  }

  // The cell holding this name, drawing it first if it isn't there, or -1 if every cell is wanted in this round
  cellFor(text) {
    let index = this.byText.get(text);
    if (index === undefined) {
      index = 0;
      for (let i = 1; i < this.cells.length; i++) if (this.cells[i].used < this.cells[index].used) index = i;
      const cell = this.cells[index];
      if (cell.used === this.tick) return -1;
      if (cell.text !== null) this.byText.delete(cell.text);
      cell.text = text;
      this.byText.set(text, index);
      this.draw(index, text);
      this.drawn = true;
    }
    this.cells[index].used = this.tick;
    return index;
  }
}

export { SignAtlas, bladesOnPole, junctionRoads, namedJunctions };
