// Sydney Tower (Centrepoint, 1981) as one shape, which both the game's own tower (js/landmarks.js, drawn from anywhere) and its model
// (js/model-sites.js `sydney-tower`, built by scripts kept outside this repo, which read this module) are made from, so the two match
// where one takes over from the other.
//
// From the operator's figures and an aerial photo level with the turret: 309 m to the tip of its spire, the observation deck at 250 m,
// the roof at 277 m, its turret 31 m across and its shaft 6.7 m, all over the street at its foot. The photo's proportions, scaled by
// the turret's width, put the observation deck on the top of the turret's four bands of windows and its roof at 277 m, so the two
// agree. The shaft stands out of Westfield's podium on Market St inside a net of cables that narrows to a collar part way up and
// opens out again to a drum under the turret. The turret, from the bottom: a nearly flat dark dish, a gold barrel 19 m high that
// widens as it rises, four bands of windows round it (its four public levels), the Skywalk round its roof, then a narrower drum in two
// tiers: a plain gold one, a recessed white band with fins under the overhang, a gold one over it, a flat white roof with a ring of
// masts, and the white spire from a flared foot, a crossbar and a cage of aerials near its top. Where the photo doesn't give a height
// (the collar's), it's a likely one.
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
    // the shaft, dark bronze, from its foot to the drum under the turret
    { name: 'shaft', material: 'iron', colour: '#4b3a2e', profile: [[18.5, 3.35], [228.0, 3.35]] },
    // the collar part way up, where the net's cables meet it
    { name: 'collar', material: 'metal', colour: '#cdbf9c', profile: [[146.0, 3.35], [146.0, 4.4], [153.0, 4.4], [153.0, 3.35]] },
    // the drum round the shaft's top under the turret, that the net hangs from
    { name: 'head', material: 'iron', colour: '#4b3a2e', profile: [[226.5, 3.35], [227.8, 6.4], [232.4, 6.4]] },
    // under the turret, dark: the shallow dish out from the drum to the turret's edge, and the lip round its foot
    { name: 'dish', material: 'iron', colour: '#2d2d2f', profile: [[232.4, 6.4], [234.8, 13.7], [234.9, 13.85], [236.0, 13.85], [236.0, 13.6]] },
    // the gold barrel, widening as it rises, its windows in bands (`windows`), the observation deck on its top band, at 250 m
    {
      name: 'cup', material: 'metal', colour: '#d0a64a',
      profile: [[236.0, 13.6], [237.6, 13.95], [242.0, 14.35], [246.0, 14.75], [250.0, 15.15], [254.0, 15.4], [255.0, 15.45]]
    },
    // the rim round its top, and its roof in to the drum: the Skywalk's floor
    { name: 'ledge', material: 'metal', colour: '#c9a14d', profile: [[255.0, 15.45], [255.1, 15.6], [255.9, 15.6], [255.9, 9.4]] },
    // the drum's lower tier, plain gold
    { name: 'drum', material: 'metal', colour: '#d3aa52', profile: [[255.9, 9.4], [268.1, 9.4]] },
    // the white band over it, set back under the upper tier, its underside curving out to it
    { name: 'band', material: 'paint', colour: '#e2ded4', profile: [[268.1, 9.4], [268.1, 8.1], [269.8, 8.1], [271.4, 9.2], [272.2, 9.6]] },
    // the drum's upper tier, gold, rounding in at its top
    { name: 'crown', material: 'metal', colour: '#d6ad58', profile: [[272.2, 9.6], [275.6, 9.6], [276.2, 9.4]] },
    // the roof, white: a rim, then rising gently to the spire's foot
    { name: 'roof', material: 'paint', colour: '#e8e6e0', profile: [[276.2, 9.4], [276.6, 9.4], [276.6, 9.0], [277.4, 2.2]] },
    // the spire, white: a flared foot, a mast to the cage of aerials near its top, a rod to its tip
    {
      name: 'spire', material: 'paint', colour: '#e4e4e0',
      profile: [[277.2, 1.6], [279.0, 1.2], [283.0, 0.95], [287.6, 0.8], [287.6, 0.5], [305.0, 0.42], [305.0, 0.15], [309.0, 0.08]]
    }
  ],
  // The barrel's bands of windows, one to each public level: [from, to] m up it, the 'curtain' glass's panes lit at night
  windows: [[236.9, 239.8], [241.3, 244.0], [245.7, 248.4], [250.1, 252.7]],
  // The white band's fins: plates out from it to under the upper tier, [y, r] round each, so many round it
  fins: { count: 24, profile: [[268.1, 8.1], [268.1, 9.0], [271.1, 9.0], [269.8, 8.1]] },
  // The Skywalk: a walkway round the roof's edge at y, its railing round its outer side, and its platforms out over the edge at each
  // angle (from +x towards +z, in the model's frame): to `reach` from the axis, `width` across, a truss `truss` deep under each. The
  // operator gives it as 268 m, but the photos have it on the barrel's roof, which the photo's scale puts at 256 m; 268 m is the top
  // of the drum's lower tier
  skywalk: { y: 256.4, inner: 13.0, outer: 15.4, rail: 1.3, platforms: [Math.PI / 2, -Math.PI / 2], reach: 16.9, width: 3.8, truss: 1.4 },
  // The masts round the roof's edge: so many, at r, from the roof to top
  masts: { count: 12, r: 8.5, y: 276.6, top: 282.0 },
  // The net: cables from round the base's foot to the collar, and from the collar out to the drum under the dish, in two families
  // turning either way, so they cross as a diamond mesh. Each half turns by its `turn` (radians round the axis): the upper half's
  // more, so its straight cables close in round the shaft and open out only near the drum, as the photos show
  net: { foot: [17.0, 7.0], waist: [149.5, 4.45], head: [230.0, 6.45], cables: 36, turn: [0.55, 1.2] },
  // The spire's crossbars: [y, half-width, the rods of aerials up from their ends]: a small one over its foot, and the cage's
  aerials: [[289.2, 1.4, 0], [305.2, 1.8, 2.8]],
  // Red lights for aircraft: round the roof's rim, and at the tip
  beacons: [[276.6, 8.8], [309.0, 0]]
};

/** The tower's cables, each a segment [[x, y, z], [x, y, z]] from the axis, in the model's frame */
function towerCables(cables = TOWER.net.cables) {
  const { foot, waist, head, turn } = TOWER.net;
  const out = [];
  for (const dir of [-1, 1]) {
    for (let i = 0; i < cables; i++) {
      const a = (i / cables) * Math.PI * 2;
      const P = ([y, r], t) => [Math.cos(t) * r, y, Math.sin(t) * r];
      out.push([P(foot, a), P(waist, a + dir * turn[0])], [P(waist, a + dir * turn[0]), P(head, a + dir * (turn[0] + turn[1]))]);
    }
  }
  return out;
}

export { TOWER, TOWER_AXIS, TOWER_STREET, TOWER_YAW, towerCables };
