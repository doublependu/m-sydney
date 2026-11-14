// Buildings drawn from models of their own (js/interiors.js). The models come from scripts kept outside this repo, and what they build
// is committed in public/models/ (README, "Building models").
//   file: models/<file>.glb and <file>.json, the building's outside, drawn with its tile
//   x, z, yaw: where its middle stands, and how it's turned (the game's rotation.y), in the game's frame
//   y: its ground floor's height, or null to stand it on the ground under its walls
//   replaces: points in the buildings the tile build leaves out for it, in its own frame (tools/tiles/derive.mjs)
//   cut: where the ground under it is left undrawn, for what it has below the street, in its own frame, and how deep (js/city-grid.js)
//   far: it has a far version, models/<file>-far.glb.gz: a shell of a draw or two, drawn past `near` and wherever its tile isn't, as
//     far as the far level reaches (which draws no models, and leaves out what a model replaces); and from the first view, as soon as
//     its tile is built, till the model comes once the city round you is complete
//   near: m from the camera that the model is drawn rather than its far version (400 unless it says)
//   clear: [[x, z, r]] in its frame: circles before its doors where no street tree is planted (js/street-details.js)
//   debug: drawn only with ?debug=1
//   reach: m from its middle that it's walked in and round, its doors open, and its inside is kept (60 unless it says)
//   top, radius: how high its model stands over y, and how far from its middle it reaches, for a tower: a helicopter arriving beside it
//     clears it before the model's in (js/controllers.js roofsNear()), as it cleared the map's box it replaces
//   outline: [[h, [[x, z], ...]], ...] in its frame: what the map draws for it (js/city-map.js), as it draws the buildings in the tiles,
//     a ring for each house or part, h m high for the map's shade. Every site that replaces the map's buildings has one, or there'd be
//     a hole where they were. Its far version's footprint from above (tests/model-sites.test.mjs)
//   exit: where X takes you out of its inside (js/interior-data.js exitSpot()): [x, z, heading, y] in its frame, or 'door' for the step
//     outside its door; without it, the footpath in front of its front door, by the street nearest it, or that step if there's none
const MODEL_SITES = [
  // A plain two-storey house on Hyde Park's lawn, for the walk-in scenario and the unit tests
  { id: 'test-interior', file: 'models/test-interior', x: 440, z: -300, yaw: 0, y: null, debug: true, replaces: [] },
  // Lower Fort St, west side, Millers Point: 47-61, the white Regency houses to the south and the ochre terraces to the north. The
  // street falls away behind them to Downshire St, where their basements open onto courtyards.
  {
    id: 'lfs-west', file: 'models/lfs-west', x: -276.7715, z: -1771.2289, yaw: 1.0227, y: 19.75, far: true,
    replaces: [[0, -1], [-9.0, -0.4], [-15.8, -0.6], [-21.8, -0.7], [9.6, -1.1], [15.2, -2.0], [21.1, -1.4], [26.8, -1.7]],
    outline: [
      [13.4, [[-24.6, 5.96], [-18.7, 5.96], [-18.7, -5.9], [-24.6, -5.9]]],
      [13.4, [[-18.7, 5.96], [-12.4, 5.96], [-12.4, -5.9], [-18.7, -5.9]]],
      [13.4, [[-12.4, 5.96], [-5.82, 5.96], [-5.82, -5.9], [-12.4, -5.9]]],
      [10.2, [[-5.6, 5.96], [4.9, 5.96], [6.67, -9.0], [-5.6, -9.0]]],
      [10.0, [[5.13, 5.96], [12.3, 5.96], [12.3, -9.0], [6.89, -9.0]]],
      [10.0, [[12.3, 5.96], [18.25, 5.96], [18.25, -9.0], [12.3, -9.0]]],
      [10.0, [[18.25, 5.96], [24.0, 5.96], [24.0, -9.0], [18.25, -9.0]]],
      [10.0, [[24.0, 5.96], [30.4, 5.96], [30.4, -9.0], [24.0, -9.0]]]
    ],
    cut: { poly: [[-5.83, -5.96], [6.53, -5.96], [4.86, 8.26], [-5.83, 8.26]], y: -3.3 }
  },
  // The Sydney Opera House near it: its podium, steps and glass, which the game's own (js/opera-house.js) stand in for further off; and
  // the Concert Hall, through its south doors. Unturned, its heights the world's. Further off, the game's plain version is its far one.
  // Out of the hall, onto the podium at its doors: there's no street up there.
  { id: 'opera-house', file: 'models/opera-house', x: 505, z: -1862, yaw: 0, y: 0, reach: 160, replaces: [], exit: 'door' },
  // The Ribbon, Darling Harbour: a curved glass slab between the Western Distributor and its on-ramp, in place of the map's box of its
  // outline. The world's frame, moved to its middle.
  {
    id: 'ribbon', file: 'models/ribbon', x: -472, z: 115, yaw: 0, y: null, reach: 90, replaces: [[0, 0]], far: true,
    outline: [
      [19.9, [[36.08, -50.86], [26.38, -39.26], [15.18, -28.06], [4.38, -18.16], [-6.72, -9.66], [-19.12, -1.86], [-31.42, 5.04],
        [-44.72, 11.34], [-44.62, 12.14], [-45.12, 11.74], [-45.62, 12.14], [-55.12, 23.34], [-53.82, 24.64], [-41.22, 49.24],
        [-41.42, 49.64], [-39.72, 51.84], [-28.22, 43.14], [-16.02, 34.64], [58.18, -9.36], [57.28, -10.86], [57.58, -10.96],
        [57.58, -12.66], [56.38, -12.66], [55.88, -13.46], [38.28, -47.66], [38.58, -47.86], [38.58, -49.56], [37.68, -49.56]]],
      [86, [[36.98, -49.56], [36.68, -48.66], [27.58, -37.76], [17.08, -27.26], [5.88, -16.96], [-5.82, -7.96], [-17.62, -0.56],
        [-30.72, 6.84], [-44.02, 13.14], [-53.82, 24.64], [-40.82, 50.24], [-28.82, 41.24], [-16.72, 32.84], [25.58, 7.54], [55.98, -10.36],
        [57.58, -10.96], [57.58, -12.66], [56.38, -12.66], [55.88, -13.46], [38.28, -47.66], [38.58, -47.86], [38.58, -49.56]]]
    ]
  },
  // The Pylon Lookout, in the Harbour Bridge's south-east pylon: its door off the footway, the foyer and the floor over it, up its stair.
  // Out onto the footway at its door.
  // In the hollow js/harbour-bridge.js leaves in the pylon's granite (lookoutPlace()): its middle, the footway's height, turned with
  // +z towards the footway. Near only: the pylon is the game's.
  // Sydney Tower and Westfield's podium round its foot, in place of the map's podium, with its foyer behind a door on Market St: built
  // from the shape the game's own tower is (js/sydney-tower.js), which stands in for it wherever it isn't drawn. Its frame there: the
  // shaft's axis, the footpath at the door, +z towards Market St. Drawn whenever its tile is, from anywhere: it's 309 m high. Its far
// version is the podium alone, under the game's tower.
  {
    id: 'sydney-tower', file: 'models/sydney-tower', x: 143, z: -311, yaw: 0.1418, y: 20.1, reach: 40, near: 5000, replaces: [[-34.2, 6.2]],
    far: true,
    clear: [[0, 20.0, 2.5]],
    outline: [
      [13.5, [[50.2, -68.59], [49.63, -57.56], [52.6, -57.14], [49.49, -28.29], [37.47, -29], [36.77, -24.05], [48.79, -23.34],
        [44.97, 17.53], [13.58, 18.1], [-50.06, 18.11], [-47.24, -100.69], [0.84, -97.86], [0.84, -104.93], [56.7, -99.99],
        [53.17, -68.17]]]
    ]
  },
  { id: 'pylon-lookout', file: 'models/pylon-lookout', x: -41.2543, z: -2066.4534, yaw: -1.91484, y: 49.0219, reach: 40, near: 150, replaces: [],
    exit: 'door' },
  // Salesforce Tower, 180 George St, Circular Quay: 263 m, in place of the map's box of its outline, its foyer behind a door on George
  // St. Its frame: 21 m in from the middle of its George St face, +z out through that face; the footpath at the door.
  {
    id: 'salesforce-tower', file: 'models/salesforce-tower', x: -13.226, z: -1191.178, yaw: -2.1544, y: 3.75, far: true, replaces: [[0, 0]],
    top: 263, radius: 50.5,
    clear: [[0, 23.0, 2.5]],
    outline: [
      [36, [[-30.31, -30.06], [-46.21, -19.36], [-22.81, 11.74], [-22.81, 12.54], [-22.31, 13.14], [-21.91, 12.94], [-16.21, 20.74],
        [-15.91, 21.04], [15.99, 21.04], [21.69, 12.94], [22.19, 13.04], [22.49, 12.64], [22.39, 11.94], [24.99, 8.34]]],
      [263, [[-30.11, -28.66], [-44.61, -18.86], [-33.71, -4.26], [-33.71, -3.36], [-32.51, -2.36], [-22.21, 11.14], [-22.21, 12.24],
        [-21.81, 12.74], [-21.01, 12.44], [-15.61, 19.84], [15.19, 19.94], [20.49, 12.44], [21.59, 12.74], [21.89, 12.34], [22.09, 11.84],
        [21.29, 11.34], [23.29, 8.74], [23.29, 8.14], [-2.11, -9.56], [-3.01, -10.56], [-3.61, -10.46], [-4.81, -11.26], [-28.91, -28.16]]]
    ]
  },
  // The EY Centre, 200 George St, across George St from it: a rounded slab in gold louvres, 37 storeys, its foyer behind a door on
  // George St. Its frame: the middle of its plan, +z out through its George St face (its short axis); the footpath at the door.
  {
    id: 'ey-centre', file: 'models/ey-centre', x: -68.618, z: -1174.325, yaw: 1.2608, y: 4.4, far: true, replaces: [[0, 0]],
      top: 141, radius: 28.5,
    clear: [[0, 17.5, 3.0]],
    outline: [
      [141, [[0.1, -18.5], [-15.3, -17.6], [-22.4, -14.9], [-26.4, -10.4], [-28, 0], [-26.7, 9.7], [-22.4, 14.9], [-15.3, 17.6], [0, 18.5],
        [15.3, 17.6], [22.4, 14.9], [26.4, 10.4], [28, -0.1], [26.6, -10.1], [23.2, -14.1], [22, -15.1], [15.3, -17.6]]]
    ]
  },
  // Customs House, 31 Alfred St, facing Circular Quay: sandstone, its colonnades, clock and pavilions, a glass penthouse on top, and
  // inside its atrium the city in miniature under a glass floor. Its frame: 21 m in from the middle of its front, +z out through it;
  // its ground floor, up steps from the square. The ground under it is left undrawn, for the pit under the glass floor.
  {
    id: 'customs-house', file: 'models/customs-house', x: 194.896, z: -1247.815, yaw: -3.0631, y: 3.9, far: true, replaces: [[0, 0]],
    clear: [[0, 21.5, 4.5]], cut: { poly: [[-21.5, -19.5], [21.5, -19.5], [21.5, 17.5], [-21.5, 17.5]], y: -1.6 },
    outline: [
      [26, [[-21.23, -20.13], [-22.43, -20.03], [-22.53, -18.93], [-22.43, 21.07], [-13.43, 21.07], [-13.43, 20.47], [13.47, 20.47],
        [13.47, 21.07], [22.47, 21.07], [22.47, -20.03]]]
    ]
  },
  // Crown Sydney, 1 Barangaroo Ave: three glass petals twisting as they rise to 271 m, the lower wing beside them and the podium in
  // white fins, in place of the map's three parts. Its frame: the tower's middle, +z out through the podium's north face, where the
  // hotel's door is; the plaza's level there.
  {
    id: 'crown-sydney', file: 'models/crown-sydney', x: -710, z: -1138, yaw: 3.1093, y: 2.3, far: true, top: 271.3, radius: 25,
    replaces: [[0, 0], [-30.89, -27.02], [-12.51, -77.64]], clear: [[-20.2, 19.0, 3.0]],
    outline: [
      [33.1, [[-54.72, -105.77], [-51.72, -86.77], [-42.12, -40.17], [-41.42, -32.87], [-36.32, -15.77], [-32.22, 6.53], [-28.32, 17.13],
        [-16.42, 17.23], [-14.82, 18.83], [-12.52, 20.33], [-6.02, 22.53], [-1.82, 22.53], [3.48, 23.83], [33.38, 26.83], [28.78, 11.43],
        [23.78, 2.83], [23.68, -0.77], [22.38, -6.47], [19.48, -11.27], [16.78, -13.97], [19.88, -14.87], [19.18, -22.67], [15.58, -38.87],
        [11.88, -48.87], [11.48, -49.37], [7.98, -47.27], [3.28, -52.07], [8.48, -59.37], [5.48, -75.67], [-1.72, -94.77], [-4.72, -96.07],
        [-5.02, -98.77], [-18.82, -101.27], [-27.32, -101.07], [-38.82, -99.67]]],
      [271.3, [[-41.72, -40.27], [-41.12, -32.87], [-36.12, -15.77], [-25.12, 2.73], [-22.92, 4.93], [-22.72, 7.13], [-21.82, 9.93],
        [-18.62, 15.33], [-14.82, 18.83], [-13.22, 19.83], [-8.42, 21.93], [-3.32, 22.43], [-1.92, 22.43], [0.88, 21.03], [5.58, 21.63],
        [10.98, 20.33], [13.88, 18.93], [17.98, 15.73], [19.68, 13.63], [22.58, 8.43], [23.78, 2.73], [23.18, -3.77], [20.58, -9.37],
        [17.58, -11.47], [17.08, -13.57], [15.88, -15.77], [11.68, -20.07], [9.28, -21.57], [3.58, -23.67], [-3.22, -23.87],
        [-7.02, -22.87], [-10.12, -24.57], [-12.92, -27.27], [-27.52, -36.17]]]
    ]
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
    clear: [[-3.4, 15.0, 2.5], [-6.0, 21.0, 3.5]],
    outline: [
      [6.7, [[-8.95, 0.0], [13.0, 0.0], [13.0, 7.75], [4.35, 7.75], [4.35, 10.55], [-6.75, 13.2], [-8.95, 7.15]]],
      [3.1, [[-12.6, 0.15], [-8.8, 0.15], [-8.8, 6.7], [-12.6, 6.7]]],
      [3.75, [[-12.16, 13.68], [-6.88, 10.64], [-3.84, 15.92], [-9.12, 18.96]]]
    ]
  },
  // 86 Quarry Rd, Dural: a single-storey house of the 2020s on a pad cut into the end of a ridge in the bush, its deck and pool along the
  // valley side to the north, a six-car carport under a hipped terracotta roof on its west, the master bedroom's round retreat at its
  // south-west. Its frame: the floor plan's, from the outer corner of its bedroom wing; +x along the house to the west, +z to the north,
  // towards the deck; its floor. The ground's left undrawn over the house, the carport and the pad round them, which it draws itself,
  // with the cutting's sandstone face.
  {
    id: 'quarry-rd', file: 'models/quarry-rd', x: -15074, z: -17644, yaw: 2.993, y: 194.6, far: true, replaces: [], reach: 80,
    cut: { poly: [[-3, 6], [-3, -6.5], [24.5, -6.5], [27.5, -4], [44, -4], [44, 12.5], [19.05, 12.5], [19.05, 10.45], [0.11, 10.45],
      [0.11, 6]], y: -0.6 },
    clear: [[19.5, 3.0, 2.5]],
    outline: [
      [4.5, [[-0.49, -0.49], [19.65, -0.49], [19.65, 11.05], [-0.49, 11.05]]], [4.0, [[13.35, -4.1], [21.85, -4.1], [21.85, 2.55],
        [13.35, 2.55]]],
      [3.45, [[21.7, -3.62], [22.44, -3.53], [23.12, -3.24], [23.72, -2.79], [24.17, -2.2], [24.45, -1.51], [24.55, -0.78],
        [24.45, -0.04], [24.17, 0.65], [23.72, 1.24], [23.12, 1.69], [22.44, 1.98], [21.7, 2.08]]],
      [4.4, [[19.2, 4.5], [34.35, 4.5], [34.35, 12.55], [19.2, 12.55]]]
    ]
  },
  // 6 Parklea Close, Dural: a red brick house of the 1980s in a U round a paved courtyard that opens to the drive, a balcony along its back
  // over the lawn falling to the east. Its frame: the floor plan's, from the outer corner behind its kitchen; +x along the back to the
  // south-south-east, +z to the front, the courtyard and the drive; its floor.
  {
    id: 'parklea-close', file: 'models/parklea-close', x: -16645.7, z: -17796.3, yaw: -1.147, y: 205.9, far: true, replaces: [[4, 6]],
    reach: 70, clear: [[10.35, 10.6, 2.5]],
    outline: [
      [4.7, [[-0.4, 2.65], [22.0, 2.65], [22.0, 10.0], [-0.4, 10.0]]], [5.1, [[-0.4, 8.8], [8.8, 8.8], [8.8, 24.8], [-0.4, 24.8]]],
      [5.0, [[17.8, 0.5], [26.75, 0.5], [26.75, 16.7], [17.8, 16.7]]], [4.9, [[20.1, 15.5], [28.6, 15.5], [28.6, 24.5], [20.1, 24.5]]],
      [3.6, [[8.2, 9.4], [18.4, 9.4], [18.4, 12.4], [11.1, 12.4], [11.1, 17.3], [8.2, 17.3]]]
    ]
  },
  // ...its small residence by the road, red brick under a hipped roof, a porch on its south side and a patio on its north. Its frame: +x
  // across it from the porch's side to the patio's, +z along it from its living room (west) to its bedrooms; its floor.
  {
    id: 'parklea-cottage', file: 'models/parklea-cottage', x: -16684.85, z: -17814.1, yaw: 1.736, y: 205.85, far: true, replaces: [[4, 10]],
    clear: [[-2.5, 8.65, 2.0]],
    outline: [[5.0, [[-0.5, -0.5], [8.6, -0.5], [8.6, 20.4], [-0.5, 20.4]]], [3.0, [[-1.9, 7.0], [0.1, 7.0], [0.1, 10.3], [-1.9, 10.3]]]]
  },
  // ...and its steel workshop and the two greenhouses beside it, east of the house. Its frame: +x along the greenhouses to the east, +z
  // to the south; the workshop's floor.
  {
    id: 'parklea-shed', file: 'models/parklea-shed', x: -16630.5, z: -17772, yaw: 0.187, y: 203.0, far: true, replaces: [[15, 7]],
    outline: [[2.6, [[0, 0], [29.5, 0], [29.5, 15.3], [0, 15.3]]], [5.1, [[-1.9, 16.1], [17.7, 16.1], [17.7, 27.0], [-1.9, 27.0]]]]
  },
  // 41 Cove St, Watsons Bay: a fibro and weatherboard cottage of the 1920s on the narrow end of the street, south-east of Pacific St, its
  // covered porch on the street side and the drive past it; and the house beyond it to the south-east, which the map had in the same
  // box. Its frame: the floor plan's, from the outer corner by the drive; +x away from the street (north-east), +z along it to the
  // south-east; its floor.
  {
    id: 'cove-st-41', file: 'models/cove-st-41', x: 6279.17, z: -4450.39, yaw: 0.7196, y: 9.1, far: true, replaces: [[5, 4]],
    clear: [[-1.0, -0.3, 2.5]],
    outline: [
      [5.2, [[-0.45, -0.45], [12.08, -0.45], [12.08, 7.31], [-0.45, 7.31]]], [3.4, [[-2.4, 1.15], [-0.45, 1.15], [-0.45, 6.5], [-2.4, 6.5]]],
      [7.4, [[-3.3, 7.6], [14.5, 7.6], [14.5, 16.6], [-3.3, 16.6]]]
    ]
  },
  // ...and 43, the cottage beside it to the north-west, its front door and sunroom to the street. Its frame: the floor plan's, from the
  // outer corner at the back on the north-west; +x along the street to the south-east, +z towards it; its floor.
  {
    id: 'cove-st-43', file: 'models/cove-st-43', x: 6276.18, z: -4464.42, yaw: -0.8512, y: 8.7, far: true, replaces: [],
    clear: [[4.33, 11.2, 2.0]],
    outline: [[5.4, [[-0.45, -0.45], [9.86, -0.45], [9.86, 10.04], [-0.45, 10.04]]], [2.6, [[0.2, -6.0], [2.6, -6.0], [2.6, -3.0], [0.2, -3.0]]]]
  },
  // 2 School St, Balmain East: a Victorian house of 1840 on the corner of School St and Gallimore Ave, sandstone below and render above, a
  // verandah and a balcony of cast-iron lace to the harbour, three dormers in its roof; its parking beside it on School St. Its frame: the
  // floor plans', from the outer corner at the back on School St's side; +x along the front to the north-west, +z to the front (the
  // north-east); its ground floor.
  {
    id: 'school-st', file: 'models/school-st', x: -1488.11, z: -1751.45, yaw: 2.1683, y: 17.3, far: true, replaces: [[4, 9]],
    clear: [[3.87, 16.6, 2.5], [-1.2, 3.0, 2.0]],
    outline: [
      [11.0, [[-0.4, 5.25], [8.55, 5.25], [8.55, 13.78], [-0.4, 13.78]]], [6.0, [[-0.1, 13.78], [8.25, 13.78], [8.25, 15.45], [-0.1, 15.45]]],
      [7.6, [[2.2, -0.4], [6.15, -0.4], [6.15, 5.25], [2.2, 5.25]]], [3.4, [[6.15, -0.2], [8.66, -0.2], [8.66, 5.25], [6.15, 5.25]]]
    ]
  },
  // 20 Wolseley Rd, Point Piper: a house of three floors at the foot of the slope from Wolseley Rd down to Double Bay, its verandahs to
  // the harbour, a round stairwell on its east side; the garden and the pool, the jetty along the map's pier, the boat shed. Its frame:
  // +x up the slope to the east, +z to the south, the ground floor's level; the first floor is at grade on the east, at the front door.
  // Its cut takes in the house, its terraces and garden and the court round the east, inside the lawn: the map paves the shore.
  {
    id: 'wolseley-rd', file: 'models/wolseley-rd', x: 3911.0, z: -930.0, yaw: 0.206, y: 4.8, far: true, replaces: [[7.0, 9.4]],
    cut: { poly: [[-7.87, -2.6], [7.8, -2.6], [7.8, -3.3], [16.5, -3.3], [16.5, 16.8], [-15.5, 16.8]], y: -3.0 },
    outline: [
      [10.3, [[0.71, -0.25], [12.75, -0.25], [12.75, 5.57], [13.22, 5.66], [13.67, 5.85], [14.07, 6.11], [14.43, 6.44], [14.71, 6.82],
        [14.93, 7.26], [15.06, 7.72], [15.1, 8.2], [15.06, 8.68], [14.93, 9.14], [14.71, 9.58], [14.43, 9.96], [14.07, 10.29], [13.67, 10.55],
        [13.22, 10.74], [12.75, 10.83], [12.75, 15.75], [-4.18, 15.75]]],
      [3.4, [[7.8, -3.3], [16.5, -3.3], [16.5, 16.8], [12.6, 16.8], [12.6, 5.65], [14.15, 5.65], [14.15, 3.6], [12.6, 3.6], [12.6, 1.35],
        [9.4, 1.35], [9.4, 0.05], [7.8, 0.05]]],
      [3.6, [[-23.85, 8.07], [-31.67, 5.62], [-29.81, -0.29], [-21.99, 2.16]]]
    ]
  },
  // 51 Denning St, South Coogee: a new house of four levels down the slope from the street to the sea, on the east side of Denning St
  // between the boxes the map has for its neighbours (it has none of its own); its garage and entry at the street under a curved white
  // canopy, glass levels stepping down to a pool deck and a lawn. Its frame: +x from its front boundary down the lot to the east, +z
  // from its north boundary to the south; the street level's floor. Its cut takes in the lot from behind the garage's front to the
  // lower lawn: the levels below the street, the side stair down the north boundary, the pool deck.
  {
    id: 'denning-st', file: 'models/denning-st', x: 5627.5, z: 5773.65, yaw: 0, y: 45.4, far: true, replaces: [], reach: 80,
    cut: { poly: [[5.0, 0.0], [54.0, 0.0], [54.0, 10.35], [5.6, 10.35]], y: -12.2 },
    clear: [[3.5, 3.6, 2.5]],
    outline: [
      [10.0, [[10.85, 1.2], [36.1, 1.2], [36.1, 10.25], [10.85, 10.25]]],
      [3.2, [[5.0, 0.0], [10.85, 0.0], [10.85, 10.25], [5.0, 10.25]]]
    ]
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

/** Each site's outline in the world's frame, for the map: [{ h, pts: [{ x, z }] }] */
const SITE_OUTLINES = MODEL_SITES.filter((s) => s.outline && !s.debug).flatMap((s) => s.outline.map(([h, ring]) => ({
  h, pts: ring.map(([x, z]) => toWorldOf(s, x, z))
})));

// Each site's clearings in the world's frame
const SITE_CLEARINGS = MODEL_SITES.flatMap((s) => (s.clear || []).map(([x, z, r]) => ({ ...toWorldOf(s, x, z), r })));
/** Whether (x, z) is outside every site's clearings: somewhere a street tree may stand */
const clearOfSites = (x, z) => SITE_CLEARINGS.every((c) => (x - c.x) ** 2 + (z - c.z) ** 2 > c.r * c.r);

export { MODEL_SITES, SITE_CUTS, SITE_OUTLINES, clearOfSites, toWorldOf };
