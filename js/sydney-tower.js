// Sydney Tower (Centrepoint, 1981) as one shape, which both the game's own tower (js/landmarks.js, drawn from anywhere) and its model
// (js/model-sites.js `sydney-tower`, built by scripts kept outside this repo, which read this module) are made from, so the two match
// where one takes over from the other.
//
// From the operator's figures and photos: 309 m to the tip of its spire, the observation deck at 250 m, its turret 31 m across and its
// shaft 6.7 m, all over the street at its foot. The shaft stands out of Westfield's podium on Market St inside a net of cables that
// narrows to a collar part way up and opens out again under the turret. The turret: a dark dish under it, a gold cup banded with dark
// windows, a ledge, a narrower drum with the Skywalk round it, a gold cap and the spire with its aerials. Where the photos don't give a
// height (the collar's), it's a likely one.
//
// Heights are metres over the street at the door on Market St (the model site's y); radii in metres from the shaft's axis.

/** The shaft's axis, in the world */
const TOWER_AXIS = { x: 143, z: -311 };
/** The footpath at its foot, on Market St, in the world's heights: where its foyer's door is */
const TOWER_STREET = 20.1;
/** The model's frame turned so +z faces Market St, square to the podium's front on it */
const TOWER_YAW = 0.1418;

const TOWER = {
  // Westfield's podium, which the model draws in place of the map's (OSM's outline): its roof's height
  podium: {
    top: 13.5,
    outline: [[183, -386], [184, -375], [187, -375], [188, -346], [176, -345], [176, -340], [188, -341], [190, -300], [159, -295], [96, -286],
      [82, -404], [130, -408], [129, -415], [185, -418], [186, -386]]
  },
  // Each part a lathe: [y, r] from the bottom up, and what it's made of
  parts: [
    // the drum at its foot on the podium's roof, where the cables are anchored
    { name: 'base', material: 'stone', colour: '#8c8478', profile: [[13.5, 7.2], [17.0, 7.2], [17.6, 6.4], [19.0, 4.6]] },
    // the shaft, dark bronze, from its foot to the dish
    { name: 'shaft', material: 'iron', colour: '#4b3a2e', profile: [[18.5, 3.35], [207.0, 3.35]] },
    // the collar part way up, where the net's cables meet it
    { name: 'collar', material: 'metal', colour: '#cdbf9c', profile: [[146.0, 3.35], [146.0, 4.4], [153.0, 4.4], [153.0, 3.35]] },
    // the dish under the turret, dark
    { name: 'dish', material: 'iron', colour: '#2d2d2f', profile: [[205.0, 3.35], [209.0, 6.5], [213.0, 11.0], [216.5, 14.2], [218.3, 14.9]] },
    // the gold cup, widening as it rises, its windows in bands (`windows`), to the observation deck's floor at 250 m and over it
    { name: 'cup', material: 'metal', colour: '#d0a64a', profile: [[218.3, 14.9], [254.6, 15.5]] },
    // the ledge over it, and the roof in to the drum
    { name: 'ledge', material: 'metal', colour: '#c9a14d', profile: [[254.6, 15.5], [255.4, 15.9], [256.2, 15.9], [256.2, 11.2]] },
    // the narrower drum over the turret
    { name: 'drum', material: 'metal', colour: '#d3aa52', profile: [[256.2, 11.2], [266.0, 11.2]] },
    // the gold cap over the Skywalk, rounding in to the spire's foot
    { name: 'cap', material: 'metal', colour: '#d6ad58', profile: [[266.0, 11.2], [266.6, 10.6], [270.0, 10.2], [273.5, 8.2], [276.0, 5.0], [277.2, 0.0]] },
    // the spire, white, to its tip
    { name: 'spire', material: 'paint', colour: '#e4e4e0', profile: [[276.8, 1.5], [296.0, 0.7], [309.0, 0.12]] }
  ],
  // The cup's bands of windows: [from, to] m up it, the 'curtain' glass's panes lit at night
  windows: [[220.5, 223.0], [225.0, 227.5], [229.5, 232.0], [234.0, 236.5], [238.5, 241.0], [243.0, 245.5], [250.4, 253.8]],
  // The Skywalk: a ring of open platform round the drum
  skywalk: { y: 266.0, inner: 11.2, outer: 14.4, rail: 1.2 },
  // The net: cables from round the base's foot to the collar, and from the collar out to under the dish, in two families turning
  // either way, so they cross as a diamond mesh
  net: { foot: [17.0, 7.0], waist: [149.5, 4.45], head: [205.5, 7.4], cables: 36, turn: 0.55 },
  // The aerials on the spire: [y, half-width] of each crossbar
  aerials: [[288.0, 2.2], [293.0, 1.8], [298.0, 1.4]],
  // Red lights for aircraft: round the cap's top, and at the tip
  beacons: [[275.4, 5.6], [309.0, 0]]
};

/** The tower's cables, each a segment [[x, y, z], [x, y, z]] from the axis, in the model's frame */
function towerCables(cables = TOWER.net.cables) {
  const { foot, waist, head, turn } = TOWER.net;
  const out = [];
  for (const dir of [-1, 1]) {
    for (let i = 0; i < cables; i++) {
      const a = (i / cables) * Math.PI * 2;
      const P = ([y, r], t) => [Math.cos(t) * r, y, Math.sin(t) * r];
      out.push([P(foot, a), P(waist, a + dir * turn)], [P(waist, a + dir * turn), P(head, a + dir * turn * 2)]);
    }
  }
  return out;
}

export { TOWER, TOWER_AXIS, TOWER_STREET, TOWER_YAW, towerCables };
