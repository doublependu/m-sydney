// Buildings that have a model of their own, matched by where they are. In a building's own frame x is across it, z along it, y up from its
// floor, with (x, z) here its middle. `yaw` turns z towards the game's z.
const MODEL_SITES = [
  {
    id: 'test-lobby',
    file: 'models/test-lobby.glb',
    x: 442.5, z: -528, yaw: 0.0353,
    width: 14.4, length: 42.4, height: 7,
    door: { along: 0, width: 2.4, height: 2.7 }, // in the wall at x = -width / 2
    lights: [[0, 5.5, -10.6], [0, 5.5, 0], [0, 5.5, 10.6]]
  }
];

/** The model site whose building this is, if any: its middle is inside the building's outline's box */
const siteOfBuilding = (b) => MODEL_SITES.find((s) => s.x >= b.minX && s.x <= b.maxX && s.z >= b.minZ && s.z <= b.maxZ) ?? null;

export { MODEL_SITES, siteOfBuilding };
