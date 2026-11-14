// Sydney's houses, by when and where they were built: the styles the generator gives a house (tools/build-buildings.mjs) and what
// each looks like in the game (js/building-look.js). From council heritage guides, and Wikimedia Commons pictures of each group of
// suburbs' houses.
//   walls: [facade, weight, from, to]: facades of js/buildings.js with their weights, and which of the facade's colours, as a range
//          of its tone (7 house brick, red at 0 through orange to cream at 1; 8 painted render, fibro and weatherboard, white at 0 to
//          sand at 1; 1 the inner city's Federation brick)
//   roofs: colours of js/buildings.js ROOF_COLOURS with their weights; none for a flat roof
//   pitch: the roof's slope in degrees. gabled: how many have gable ends rather than a hip. eaves: m the roof stands past its walls.
//   storeys: how tall it is when the map doesn't say, as [storeys, share] pairs
//   look: how a house of the style is drawn near (js/tsl-materials.js houseWall()), for the styles that are houses rather than flats
//         or shops. None of it reaches the tiles.
//     bay: [front, side] m from one window's middle to the next, on the wall facing the street and on the others
//     window, side: [width, height, sill, panes, transom] of a window on the front and on the other walls: m, the sill above the floor,
//       how many panes across, and how high up it its bar is (0.5: a double-hung sash's meeting rail; 0: none)
//     share: [front, side]: about how many of a wall's bays have a window. The front's bays beside its door always do.
//     frame: 0 white, 1 aluminium, 2 charcoal, 3 cream. door: 0 plain, 1 with a fanlight, 2 with a sidelight
//     painted: what its painted walls are: 0 render, 1 weatherboards, 2 fibro sheets, 3 fibro or weatherboards
//     terrace: its door at one end of its front. garage: a double garage door in its front wall
const BRICK = 7, PAINTED = 8;
const HOUSE_STYLES = [
  null,
  { name: 'Victorian terrace', walls: [[PAINTED, 5, 0, 1], [BRICK, 5, 0, 0.3]], roofs: [[5, 4], [12, 4], [4, 2]], pitch: 30, gabled: 0, eaves: 0.15, storeys: [[2, 0.8], [1, 0.2]], look: { bay: [2.2, 2.6], window: [0.9, 1.8, 0.6, 1, 0.5], side: [0.8, 1.4, 0.9, 1, 0.5], share: [1, 0.3], frame: 0, door: 1, painted: 0, terrace: true } },
  { name: 'Federation', walls: [[BRICK, 9, 0, 0.25], [PAINTED, 1, 0.3, 1]], roofs: [[4, 6], [6, 2], [5, 2]], pitch: 38, gabled: 0.5, eaves: 0.5, storeys: [[1, 0.85], [2, 0.15]], look: { bay: [3.0, 3.0], window: [1.8, 1.5, 0.8, 3, 0.72], side: [0.9, 1.4, 0.9, 1, 0.5], share: [0.6, 0.33], frame: 0, door: 1, painted: 0 } },
  { name: 'California bungalow', walls: [[BRICK, 8, 0, 0.35], [PAINTED, 2, 0.4, 1]], roofs: [[4, 6], [6, 3], [7, 1]], pitch: 30, gabled: 0.7, eaves: 0.6, storeys: [[1, 1]], look: { bay: [3.2, 3.0], window: [2.4, 1.4, 0.85, 3, 0.75], side: [1.0, 1.2, 0.95, 2, 0], share: [0.6, 0.33], frame: 3, door: 2, painted: 0 } },
  { name: 'Inter-war flats', walls: [[BRICK, 6, 0, 0.3], [BRICK, 4, 0.6, 1]], roofs: null, storeys: [[3, 0.6], [2, 0.4]], flats: true },
  { name: 'Post-war fibro', walls: [[PAINTED, 1, 0, 0.6]], roofs: [[4, 5], [7, 2.5], [12, 2.5]], pitch: 25, gabled: 0.5, eaves: 0.45, storeys: [[1, 1]], look: { bay: [2.7, 3.0], window: [1.2, 1.2, 1.0, 2, 0], side: [1.0, 1.0, 1.1, 2, 0], share: [0.5, 0.3], frame: 0, door: 0, painted: 3 } },
  { name: 'Triple-fronted brick veneer', walls: [[BRICK, 7, 0.5, 1], [BRICK, 3, 0.2, 0.5]], roofs: [[7, 3], [8, 3], [6, 4]], pitch: 22, gabled: 0.1, eaves: 0.6, storeys: [[1, 0.9], [2, 0.1]], look: { bay: [3.4, 3.0], window: [2.4, 1.5, 0.75, 3, 0], side: [1.2, 1.2, 1.0, 2, 0], share: [0.7, 0.3], frame: 1, door: 2, painted: 0 } },
  { name: 'Walk-up flats', walls: [[BRICK, 5, 0.6, 1], [BRICK, 5, 0, 0.4]], roofs: null, storeys: [[3, 0.8], [4, 0.2]], flats: true },
  { name: 'Shop-top terrace', walls: [[1, 6, 0, 1], [PAINTED, 4, 0, 1]], roofs: null, storeys: [[2, 0.9], [3, 0.1]], shops: true },
  { name: 'Project home', walls: [[PAINTED, 5, 0, 0.8], [BRICK, 3, 0.5, 1], [BRICK, 2, 0, 0.4]], roofs: [[11, 3], [10, 2], [9, 1], [8, 4]], pitch: 22, gabled: 0.3, eaves: 0.5, storeys: [[2, 0.5], [1, 0.5]], look: { bay: [3.0, 3.2], window: [2.0, 1.5, 0.8, 2, 0], side: [1.4, 1.2, 1.0, 2, 0], share: [0.5, 0.33], frame: 1, door: 2, painted: 0, garage: true } },
  { name: 'Beach house', walls: [[PAINTED, 1, 0, 0.7]], roofs: [[12, 3], [9, 4], [10, 3]], pitch: 18, gabled: 0.6, eaves: 0.6, storeys: [[2, 0.5], [1, 0.5]], look: { bay: [3.2, 3.2], window: [2.4, 2.0, 0.3, 2, 0], side: [1.2, 1.2, 1.0, 2, 0], share: [0.7, 0.33], frame: 0, door: 0, painted: 1 } },
  // Given by hand (tools/local/millers-point.json): the Regency and Victorian houses of Millers Point and Dawes Point, rendered in cream,
  // white and ochre, some of brick or sandstone, roofed in slate or iron
  { name: 'Millers Point terrace', walls: [[PAINTED, 6, 0.1, 1], [BRICK, 2, 0, 0.3], [0, 2, 0, 1]], roofs: [[5, 6], [12, 3]], pitch: 28, gabled: 0.15, eaves: 0.12, storeys: [[2, 0.6], [3, 0.4]], look: { bay: [2.2, 2.6], window: [0.9, 1.8, 0.6, 2, 0.5], side: [0.8, 1.4, 0.9, 1, 0.5], share: [1, 0.3], frame: 0, door: 1, painted: 0, terrace: true } },
  // Given by hand (tools/local/circular-quay.json): The Rocks' bond stores and shipping offices on Circular Quay West, Campbell's Stores and
  // the ASN Co building, of red brick under slate gables...
  { name: 'Rocks warehouse', walls: [[1, 1, 0, 1]], roofs: [[5, 1]], pitch: 32, gabled: 1, eaves: 0.2, storeys: [[3, 1]] },
  // ...and the Park Hyatt beside them, low and pale under a flat roof
  { name: 'Quayside render', walls: [[0, 1, 0.65, 1]], roofs: null, storeys: [[4, 1]] },
  // Given by hand (tools/local/bronte.json): the eastern beaches' blocks of flats of the 1930s-60s, red and liver brick under hipped
  // roofs of terracotta tile, two and three storeys
  { name: 'Red-brick flats', walls: [[BRICK, 8, 0, 0.22], [BRICK, 2, 0.25, 0.45]], roofs: [[4, 6], [6, 3], [7, 1]], pitch: 24, gabled: 0.15,
    eaves: 0.45, storeys: [[3, 0.6], [2, 0.4]], flats: true }
];
const STYLE = Object.fromEntries(HOUSE_STYLES.map((s, i) => [s?.name, i]).filter(([name]) => name));

const STOREY = 3.0; // m a storey of a house, floor to floor

/** One of `weighted` ([value, weight, ...] lists), by `t` in 0-1: its value, or all of it with `whole` */
function pick(weighted, t, whole = false) {
  const total = weighted.reduce((sum, [, w]) => sum + w, 0);
  let at = t * total;
  for (const entry of weighted) {
    if (at < entry[1]) return whole ? entry : entry[0];
    at -= entry[1];
  }
  const last = weighted[weighted.length - 1];
  return whole ? last : last[0];
}

export { HOUSE_STYLES, STOREY, STYLE, pick };
