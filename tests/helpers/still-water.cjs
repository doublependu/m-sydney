// js/still-water.js itself, told of made-up tiles instead of the map's: each its own copy, with the roads on the ground given as a function
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('./module.cjs');

const source = readFileSync(join(__dirname, '../../js/still-water.js'), 'utf8');

/** `tiles`: [{ key, garden?: { ponds, rockPonds, islands, fountains, paths }, lakes? }]. `onGroundRoad(x, z, margin)`: on a road's carriageway */
function stillWater(tiles = [], onGroundRoad = () => false) {
  const listeners = [];
  const water = loadModule(source, { imports: { './geodata.js': { onMap: (l) => { listeners.push(l); } }, './surfaces.js': { onGroundRoad } } });
  water.add = (tile) => listeners.forEach((l) => l.addTile?.(tile));
  water.remove = (tile) => listeners.forEach((l) => l.removeTile?.(tile));
  tiles.forEach(water.add);
  return water;
}

/** A ring from x0 to x1 and z0 to z1, flat as the tiles have them: [x, z, ...] */
const box = (x0, z0, x1, z1) => [x0, z0, x1, z0, x1, z1, x0, z1];

module.exports = { box, stillWater };
