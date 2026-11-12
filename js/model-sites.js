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
//   top, radius: how high its model stands over y, and how far from its middle it reaches, for a tower: a helicopter arriving beside it
//     clears it before the model's in (js/controllers.js roofsNear()), as it cleared the map's box it replaces
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
  { id: 'pylon-lookout', file: 'models/pylon-lookout', x: -41.2543, z: -2066.4534, yaw: -1.91484, y: 49.0219, reach: 40, near: 150, replaces: [] },
  // Salesforce Tower, 180 George St, Circular Quay: 263 m, in place of the map's box of its outline, its foyer behind a door on George
  // St. Its frame: 21 m in from the middle of its George St face, +z out through that face; the footpath at the door.
  {
    id: 'salesforce-tower', file: 'models/salesforce-tower', x: -13.226, z: -1191.178, yaw: -2.1544, y: 3.75, far: true, replaces: [[0, 0]],
    top: 263, radius: 50.5,
    clear: [[0, 23.0, 2.5]]
  },
  // The EY Centre, 200 George St, across George St from it: a rounded slab in gold louvres, 37 storeys, its foyer behind a door on
  // George St. Its frame: the middle of its plan, +z out through its George St face (its short axis); the footpath at the door.
  {
    id: 'ey-centre', file: 'models/ey-centre', x: -68.618, z: -1174.325, yaw: 1.2608, y: 4.4, far: true, replaces: [[0, 0]], top: 141, radius: 28.5,
    clear: [[0, 17.5, 3.0]]
  },
  // Customs House, 31 Alfred St, facing Circular Quay: sandstone, its colonnades, clock and pavilions, a glass penthouse on top, and
  // inside its atrium the city in miniature under a glass floor. Its frame: 21 m in from the middle of its front, +z out through it;
  // its ground floor, up steps from the square. The ground under it is left undrawn, for the pit under the glass floor.
  {
    id: 'customs-house', file: 'models/customs-house', x: 194.896, z: -1247.815, yaw: -3.0631, y: 3.9, far: true, replaces: [[0, 0]],
    clear: [[0, 21.5, 4.5]], cut: { poly: [[-21.5, -19.5], [21.5, -19.5], [21.5, 17.5], [-21.5, 17.5]], y: -1.6 }
  },
  // Crown Sydney, 1 Barangaroo Ave: three glass petals twisting as they rise to 271 m, the lower wing beside them and the podium in
  // white fins, in place of the map's three parts. Its frame: the tower's middle, +z out through the podium's north face, where the
  // hotel's door is; the plaza's level there.
  {
    id: 'crown-sydney', file: 'models/crown-sydney', x: -710, z: -1138, yaw: 3.1093, y: 2.3, far: true, top: 271.3, radius: 25,
    replaces: [[0, 0], [-30.89, -27.02], [-12.51, -77.64]], clear: [[-20.2, 19.0, 3.0]]
  },
  // A house of the 2000s on the corner of Bronte Rd and Pacific St, Bronte, over the beach: white render on three levels down the slope, a
  // sandstone garage turned square to Pacific St, a lap pool on its low, west side. Its frame: +x along Bronte Rd to the south-east, +z
  // towards Pacific St, its beach side's face at z = 0; its top floor, the garage's and the front door's level. It's built into the slope,
  // so the ground's left undrawn over it, its deck and its pool's terrace, which it draws itself.
  {
    id: 'bronte-pacific', file: 'models/bronte-pacific', x: 6096.86, z: 2750.39, yaw: -0.6066, y: 19.7, far: true, replaces: [[0, 5.0]],
    cut: {
      poly: [[-21.8, -2.4], [-12.6, -2.4], [-12.6, -1.6], [13.0, -1.6], [13.0, 7.75], [8.7, 7.75], [8.7, 7.15], [4.35, 7.15], [4.35, 12.4],
        [-1.6, 12.4], [-1.6, 13.4], [-3.43, 16.03], [-9.23, 19.37], [-12.57, 13.57], [-13.6, 12.2], [-16.4, 8.8]],
      y: -7.0
    },
    clear: [[-3.4, 15.0, 2.5], [-6.0, 21.0, 3.5]]
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

// Each site's clearings in the world's frame
const SITE_CLEARINGS = MODEL_SITES.flatMap((s) => (s.clear || []).map(([x, z, r]) => ({ ...toWorldOf(s, x, z), r })));
/** Whether (x, z) is outside every site's clearings: somewhere a street tree may stand */
const clearOfSites = (x, z) => SITE_CLEARINGS.every((c) => (x - c.x) ** 2 + (z - c.z) ** 2 > c.r * c.r);

export { MODEL_SITES, SITE_CUTS, clearOfSites, toWorldOf };
