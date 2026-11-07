// Buildings drawn from models of their own (js/interiors.js). The models come from scripts kept outside this repo, and what they build
// is committed in public/models/ (README, "Building models").
//   file: models/<file>.glb and <file>.json, the building's outside, drawn with its tile
//   x, z, yaw: where its middle stands, and how it's turned (the game's rotation.y), in the game's frame
//   y: its ground floor's height, or null to stand it on the ground under its walls
//   replaces: points in the buildings the tile build leaves out for it, in its own frame (tools/tiles/derive.mjs)
//   cut: where the ground under it is left undrawn, for what it has below the street, in its own frame, and how deep (js/city-grid.js)
//   debug: drawn only with ?debug=1
const MODEL_SITES = [
  // A plain two-storey house on Hyde Park's lawn, for the walk-in scenario and the unit tests
  { id: 'test-interior', file: 'models/test-interior', x: 440, z: -300, yaw: 0, y: null, debug: true, replaces: [] },
  // Lower Fort St, west side, Millers Point: 47-61, the white Regency houses to the south and the ochre terraces to the north. The
  // street falls away behind them to Downshire St, where their basements open onto courtyards.
  {
    id: 'lfs-west', file: 'models/lfs-west', x: -276.7715, z: -1771.2289, yaw: 1.0227, y: 19.75,
    replaces: [[0, -1], [-9.0, -0.4], [-15.8, -0.6], [-21.8, -0.7], [9.6, -1.1], [15.2, -2.0], [21.1, -1.4], [26.8, -1.7]],
    cut: { poly: [[-5.83, -5.96], [6.53, -5.96], [4.86, 8.26], [-5.83, 8.26]], y: -3.3 }
  }
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

export { MODEL_SITES, SITE_CUTS, toWorldOf };
