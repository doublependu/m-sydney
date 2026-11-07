// Sydney's houses, by when and where they were built: the styles the generator gives a house (tools/build-buildings.mjs) and what
// each looks like in the game (js/building-look.js). From council heritage guides, and Wikimedia Commons pictures of each group of
// suburbs' houses.
//   walls: [facade, weight, from, to]: facades of js/buildings.js with their weights, and which of the facade's colours, as a range
//          of its tone (7 house brick, red at 0 through orange to cream at 1; 8 painted render, fibro and weatherboard, white at 0 to
//          sand at 1; 1 the inner city's Federation brick)
//   roofs: colours of js/buildings.js ROOF_COLOURS with their weights; none for a flat roof
//   pitch: the roof's slope in degrees. gabled: how many have gable ends rather than a hip. eaves: m the roof stands past its walls.
//   storeys: how tall it is when the map doesn't say, as [storeys, share] pairs
const BRICK = 7, PAINTED = 8;
const HOUSE_STYLES = [
  null,
  { name: 'Victorian terrace', walls: [[PAINTED, 5, 0, 1], [BRICK, 5, 0, 0.3]], roofs: [[5, 4], [12, 4], [4, 2]], pitch: 30, gabled: 0, eaves: 0.15, storeys: [[2, 0.8], [1, 0.2]] },
  { name: 'Federation', walls: [[BRICK, 9, 0, 0.25], [PAINTED, 1, 0.3, 1]], roofs: [[4, 6], [6, 2], [5, 2]], pitch: 38, gabled: 0.5, eaves: 0.5, storeys: [[1, 0.85], [2, 0.15]] },
  { name: 'California bungalow', walls: [[BRICK, 8, 0, 0.35], [PAINTED, 2, 0.4, 1]], roofs: [[4, 6], [6, 3], [7, 1]], pitch: 30, gabled: 0.7, eaves: 0.6, storeys: [[1, 1]] },
  { name: 'Inter-war flats', walls: [[BRICK, 6, 0, 0.3], [BRICK, 4, 0.6, 1]], roofs: null, storeys: [[3, 0.6], [2, 0.4]], flats: true },
  { name: 'Post-war fibro', walls: [[PAINTED, 1, 0, 0.6]], roofs: [[4, 5], [7, 2.5], [12, 2.5]], pitch: 25, gabled: 0.5, eaves: 0.45, storeys: [[1, 1]] },
  { name: 'Triple-fronted brick veneer', walls: [[BRICK, 7, 0.5, 1], [BRICK, 3, 0.2, 0.5]], roofs: [[7, 3], [8, 3], [6, 4]], pitch: 22, gabled: 0.1, eaves: 0.6, storeys: [[1, 0.9], [2, 0.1]] },
  { name: 'Walk-up flats', walls: [[BRICK, 5, 0.6, 1], [BRICK, 5, 0, 0.4]], roofs: null, storeys: [[3, 0.8], [4, 0.2]], flats: true },
  { name: 'Shop-top terrace', walls: [[1, 6, 0, 1], [PAINTED, 4, 0, 1]], roofs: null, storeys: [[2, 0.9], [3, 0.1]], shops: true },
  { name: 'Project home', walls: [[PAINTED, 5, 0, 0.8], [BRICK, 3, 0.5, 1], [BRICK, 2, 0, 0.4]], roofs: [[11, 3], [10, 2], [9, 1], [8, 4]], pitch: 22, gabled: 0.3, eaves: 0.5, storeys: [[2, 0.5], [1, 0.5]] },
  { name: 'Beach house', walls: [[PAINTED, 1, 0, 0.7]], roofs: [[12, 3], [9, 4], [10, 3]], pitch: 18, gabled: 0.6, eaves: 0.6, storeys: [[2, 0.5], [1, 0.5]] },
  // Given by hand (tools/local/millers-point.json): the Regency and Victorian houses of Millers Point and Dawes Point, rendered in cream,
  // white and ochre, some of brick or sandstone, roofed in slate or iron
  { name: 'Millers Point terrace', walls: [[PAINTED, 6, 0.1, 1], [BRICK, 2, 0, 0.3], [0, 2, 0, 1]], roofs: [[5, 6], [12, 3]], pitch: 28, gabled: 0.15, eaves: 0.12, storeys: [[2, 0.6], [3, 0.4]] }
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
