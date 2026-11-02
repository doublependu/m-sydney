import { heldTiles } from './geodata.js';

// Company names across the tops of two of the city's most prominent office towers, the way the real ones carry theirs.
// Both signs face north, over the harbour, where most of the places players spend their time can see them.
// One line per sign, so moving a sign is a small change. Wall centres are in world metres (north = -z); `out` is the way
// the wall faces.
const TOWER_SIGNS = [
  { text: 'MAN & BOT', tower: 'Salesforce Tower', height: 263, x: 4.8, z: -1218, out: { x: -0.042, z: -0.999 }, w: 45, h: 9, ink: '#ffffff' },
  { text: 'MAIZE.LIVE', tower: 'Governor Phillip Tower', height: 227, x: 269, z: -1078.5, out: { x: -0.058, z: -0.998 }, w: 50, h: 9, ink: '#ffc933' }
];
const BELOW_ROOF = 3; // m from the roof to the top of a sign
const PROUD = 0.6; // m out from the wall

// The tower a sign belongs to: the tallest building at its wall
function towerOf(sign) {
  let best = null;
  for (const b of heldTiles().flatMap((t) => t.buildings)) {
    if (sign.x < b.minX - 2 || sign.x > b.maxX + 2 || sign.z < b.minZ - 2 || sign.z > b.maxZ + 2) continue;
    if (!best || b.height > best.height) best = b;
  }
  return best;
}

/** Where a sign goes, as drawn: the centre of its panel, and its turn about y. Its height follows the tower's roof. */
function placeTowerSign(sign) {
  const tower = towerOf(sign);
  const roof = tower.floor + 0.22 + tower.height;
  return {
    x: sign.x + sign.out.x * PROUD,
    y: roof - BELOW_ROOF - sign.h / 2,
    z: sign.z + sign.out.z * PROUD,
    yaw: Math.atan2(sign.out.x, sign.out.z),
    roof,
    towerHeight: tower.height
  };
}

export { TOWER_SIGNS, placeTowerSign };
