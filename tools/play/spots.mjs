// Places worth looking at whenever the ground, the roads' heights or the bridge change: where roads stack, where the
// ground once broke, and both ends of the Harbour Bridge. Each is [x, z, heading, mode, climbSeconds, 'deck'], on a road
// and facing the thing to look at ('deck' puts the player on the Harbour Bridge above that spot). `node tools/play/look.mjs out --spots` saves them all.
export const SPOTS = {
  spawn: [397, -1000, 3.14, 'car'],
  'argyle-cut': [-152.9, -1545.6, -1.75, 'car'], // Argyle St through the cut, under Cumberland St
  'pier-st': [-534.1, 562.5, 0.5, 'car'], // Darling Dr under the Pier St overpass
  'central-colonnade': [116.2, 988.9, -1.99, 'car'], // Eddy Ave under Railway Colonnade Dr
  'burton-st': [1557.4, 516.8, -0.74, 'car'], // Barcom Ave under Burton St
  'high-st': [-233, -3509.2, 1.33, 'car'], // North Sydney, High St over the Warringah Freeway
  'sussex-st-under-distributor': [-427.3, -706.8, -2.8, 'car'], // Sussex St under the Western Distributor
  'circular-quay-cahill': [281.7, -1342.5, -1.09, 'car'], // Alfred St under the Cahill Expressway
  'hickson-pylon': [-102.7, -2133.7, 1.19, 'car'], // Hickson Rd past the south pylons
  'olympic-pylon': [147.1, -2547.7, -1.96, 'car'], // Olympic Dr past the north pylons
  'william-st-tunnel': [1346.7, 66.8, 1.4, 'car'], // William St heading into the Kings Cross tunnel
  'in-william-st-tunnel': [1550, 112, 1.43, 'car', 0, 'deck'], // inside it, eastbound
  'mclaren-st': [-744, -4234, 1.33, 'car'], // North Sydney, where the height grid had a hole
  'deck-south-end': [-330, -1412, 2.37, 'car'], // boarding the Harbour Bridge's deck at its south end
  'deck-south-pylons': [-86.8, -2045.3, 2.8, 'car', 0, 'deck'], // on the deck, northbound, before the south pylons
  'deck-north-pylons': [93.3, -2554.3, 2.8, 'car', 0, 'deck'], // on the deck, northbound, before the north pylons
  'from-above': [-200, -1700, 2.6, 'helicopter', 6] // the bridge from over The Rocks
};
