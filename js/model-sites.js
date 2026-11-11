// Buildings drawn from models of their own (js/interiors.js). The models come from scripts kept outside this repo, and what they build
// is committed in public/models/ (README, "Building models").
//   file: models/<file>.glb and <file>.json, the building's outside, drawn with its tile
//   x, z, yaw: where its middle stands, and how it's turned (the game's rotation.y), in the game's frame
//   y: its ground floor's height, or null to stand it on the ground under its walls
//   replaces: points in the buildings the tile build leaves out for it, in its own frame (tools/tiles/derive.mjs)
//   cut: where the ground under it is left undrawn, for what it has below the street, in its own frame, and how deep (js/city-grid.js)
//   far: it has a far version, models/<file>-far.glb.gz: a shell of a draw or two, drawn past `near` and wherever its tile isn't, as
//     far as the far level reaches (which draws no models, and leaves out what a model replaces)
//   near: m from the camera that the model is drawn rather than its far version (400 unless it says)
//   clear: [[x, z, r]] in its frame: circles before its doors where no street tree is planted (js/street-details.js)
//   debug: drawn only with ?debug=1
//   reach: m from its middle that it's walked in and round, its doors open, and its inside is kept (60 unless it says)
const MODEL_SITES = [
  // A plain two-storey house on Hyde Park's lawn, for the walk-in scenario and the unit tests
  { id: 'test-interior', file: 'models/test-interior', x: 440, z: -300, yaw: 0, y: null, debug: true, replaces: [] },
  // Lower Fort St, west side, Millers Point: 47-61, the white Regency houses to the south and the ochre terraces to the north. The
  // street falls away behind them to Downshire St, where their basements open onto courtyards.
  {
    id: 'lfs-west', file: 'models/lfs-west', x: -276.7715, z: -1771.2289, yaw: 1.0227, y: 19.75, far: true,
    replaces: [[0, -1], [-9.0, -0.4], [-15.8, -0.6], [-21.8, -0.7], [9.6, -1.1], [15.2, -2.0], [21.1, -1.4], [26.8, -1.7]],
    cut: { poly: [[-5.83, -5.96], [6.53, -5.96], [4.86, 8.26], [-5.83, 8.26]], y: -3.3 }
  },
  // The Sydney Opera House near it: its podium, steps and glass, which the game's own (js/opera-house.js) stand in for further off; and
  // the Concert Hall, through its south doors. Unturned, its heights the world's. Further off, the game's plain version is its far one.
  { id: 'opera-house', file: 'models/opera-house', x: 505, z: -1862, yaw: 0, y: 0, reach: 160, replaces: [] },
  // The Ribbon, Darling Harbour: a curved glass slab between the Western Distributor and its on-ramp, in place of the map's box of its
  // outline. The world's frame, moved to its middle.
  { id: 'ribbon', file: 'models/ribbon', x: -472, z: 115, yaw: 0, y: null, reach: 90, replaces: [[0, 0]], far: true },
  // The Pylon Lookout, in the Harbour Bridge's south-east pylon: its door off the footway, the foyer and the floor over it, up its stair.
  // In the hollow js/harbour-bridge.js leaves in the pylon's granite (lookoutPlace()): its middle, the footway's height, turned with
  // +z towards the footway. Near only: the pylon is the game's.
  // Sydney Tower and Westfield's podium round its foot, in place of the map's podium, with its foyer behind a door on Market St: built
  // from the shape the game's own tower is (js/sydney-tower.js), which stands in for it wherever it isn't drawn. Its frame there: the
  // shaft's axis, the footpath at the door, +z towards Market St. Drawn whenever its tile is, from anywhere: it's 309 m high.
  {
    id: 'sydney-tower', file: 'models/sydney-tower', x: 143, z: -311, yaw: 0.1418, y: 20.1, reach: 40, near: 5000, replaces: [[-34.2, 6.2]],
    clear: [[0, 20.0, 2.5]]
  },
  { id: 'pylon-lookout', file: 'models/pylon-lookout', x: -41.2543, z: -2066.4534, yaw: -1.91484, y: 49.0219, reach: 40, near: 150, replaces: [] }
];

const toWorldOf = (site, x, z) => {
  const c = Math.cos(site.yaw), s = Math.sin(site.yaw);
  return { x: site.x + x * c + z * s, z: site.z - x * s + z * c };
};

/** Each site's cut in the world's frame: { poly: [{ x, z }], y, minX, maxX, minZ, maxZ } */
const SITE_CUTS = MODEL_SITES.filter((s) => s.cut && s.y !== null).map((s) => {
  const poly = s.cut.poly.map(([x, z]) => toWorldOf(s, x, z));
  const xs = poly.map((p) => p.x), zs = poly.map((p) => p.z);
  return { poly, y: s.y + s.cut.y, minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
});

// Each site's clearings in the world's frame
const SITE_CLEARINGS = MODEL_SITES.flatMap((s) => (s.clear || []).map(([x, z, r]) => ({ ...toWorldOf(s, x, z), r })));
/** Whether (x, z) is outside every site's clearings: somewhere a street tree may stand */
const clearOfSites = (x, z) => SITE_CLEARINGS.every((c) => (x - c.x) ** 2 + (z - c.z) ** 2 > c.r * c.r);

export { MODEL_SITES, SITE_CUTS, clearOfSites, toWorldOf };
