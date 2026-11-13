// Which scenarios a change needs. Each lists the modules it depends on most and the part of the map it drives through,
// so a change runs the scenarios that can see it. Anything else runs first-minute, which sees everything a little.

const ALL_DRIVES = /^js\/(controllers|vehicle-physics|cars|cameras|surfaces|ground-geometry|road-network|traffic)\.js$/;

// area: [x0, x1, z0, z1] in world metres, or null for a scenario that doesn't depend on any one place
export const COVERS = {
  'harbour-bridge': { files: /^js\/(bridge|harbour-bridge|traffic|structures)\.js$/, area: [-400, 300, -3500, -1300] },
  'bridge-ways': { files: /^js\/(bridge|harbour-bridge|surfaces|structures|road-network)\.js$|^tools\/local\//, area: [-500, 500, -3500, -600] },
  tunnel: { files: /^js\/(tunnel-mouths|structures|lighting)\.js$/, area: [1150, 2000, -50, 200] },
  'stacked-roads': { files: /^js\/(structures|road-paint)\.js$/, area: [-750, 500, -1800, 1050] },
  motorways: { files: /^js\/(structures|traffic)\.js$/, area: [-500, 0, -2200, -350] },
  'hill-start': { files: /^js\/(vehicle-physics|surfaces)\.js$/, area: null },
  'loading-bar': { files: /^js\/(progress|world-jobs|main)\.js$/, area: null },
  'bridge-edges': { files: /^js\/(bridge|harbour-bridge)\.js$/, area: [-400, 300, -3500, -1300] },
  'under-the-bridge': { files: /^js\/(bridge|harbour-bridge|surfaces)\.js$/, area: [-250, 250, -2800, -1700] },
  'tile-streaming': { files: /^js\/(geodata|terrain|surfaces|city-config|city-grid|buildings|far-level|main|scene-culling)\.js$|^js\/tiles\/|^public\/tiles\//, area: null },
  'keeps-left': { files: /^js\/(traffic|road-network)\.js$/, area: null },
  'long-flight': { files: /^js\/(main|far-level|horizon)\.js$/, area: null },
  'long-drive-north': { files: /^js\/(main|surfaces)\.js$/, area: null },
  'long-drive-south': { files: /^js\/(main|surfaces)\.js$/, area: null },
  'long-drive': { files: /^js\/(main|surfaces)\.js$/, area: null },
  'walk-in': { files: /^(js\/(interiors|interior-data|model-sites|buildings|surfaces|controllers|cameras|pedestrians)\.js|public\/models\/.*)$/, area: null },
  'sydney-tower': { files: /^(js\/(interiors|interior-data|model-sites|sydney-tower|landmarks|surfaces|controllers|cameras|pedestrians)\.js|public\/models\/sydney-.*)$/, area: [40, 240, -440, -200] },
  'sydney-tower-phone': { files: /^(js\/(interiors|interior-data|model-sites|sydney-tower|landmarks|surfaces|controllers|cameras|pedestrians)\.js|public\/models\/sydney-.*)$/, area: [40, 240, -440, -200] },
  'salesforce-tower': { files: /^(js\/(interiors|interior-data|model-sites|tower-signs|surfaces|controllers|cameras|pedestrians)\.js|public\/models\/salesforce-.*)$/, area: [-100, 60, -1260, -1130] },
  'ey-centre': { files: /^(js\/(interiors|interior-data|model-sites|tower-signs|surfaces|controllers|cameras|pedestrians)\.js|public\/models\/ey-.*)$/, area: [-130, 0, -1240, -1110] },
  'customs-house': { files: /^(js\/(interiors|interior-data|model-sites|tower-signs|surfaces|controllers|cameras|pedestrians)\.js|public\/models\/customs-.*)$/, area: [140, 250, -1300, -1200] },
  'customs-house-phone': { files: /^(js\/(interiors|interior-data|model-sites|tower-signs|surfaces|controllers|cameras|pedestrians)\.js|public\/models\/customs-.*)$/, area: [140, 250, -1300, -1200] },
  'crown-sydney': { files: /^(js\/(interiors|interior-data|model-sites|tower-signs|surfaces|controllers|cameras|pedestrians)\.js|public\/models\/crown-.*)$/, area: [-760, -640, -1200, -1080] },
  'pylon-lookout': { files: /^(js\/(interiors|interior-data|model-sites|harbour-bridge|bridge|surfaces|controllers|cameras|pedestrians)\.js|public\/models\/pylon-.*)$/, area: [-200, 100, -2200, -1900] },
  'pylon-lookout-phone': { files: /^(js\/(interiors|interior-data|model-sites|harbour-bridge|bridge|surfaces|controllers|cameras|pedestrians)\.js|public\/models\/pylon-.*)$/, area: [-200, 100, -2200, -1900] },
  'lower-fort-55': { files: /^(js\/(interiors|interior-data|model-sites|surfaces|controllers|cameras|pedestrians|city-grid|ground-geometry)\.js|public\/models\/lfs-.*)$/, area: null },
  'bronte-pacific': { files: /^(js\/(interiors|interior-data|model-sites|surfaces|controllers|cameras|pedestrians|city-grid|ground-geometry)\.js|public\/models\/bronte-.*)$/, area: null },
  'bronte-pacific-phone': { files: /^(js\/(interiors|interior-data|model-sites|surfaces|controllers|cameras|pedestrians|city-grid|ground-geometry)\.js|public\/models\/bronte-.*)$/, area: null },
  'quarry-rd': { files: /^(js\/(interiors|interior-data|model-sites|surfaces|controllers|cameras|pedestrians|city-grid|ground-geometry)\.js|public\/models\/quarry-.*)$/, area: [-15130, -15060, -17670, -17630] },
  'quarry-rd-phone': { files: /^(js\/(interiors|interior-data|model-sites|surfaces|controllers|cameras|pedestrians|city-grid|ground-geometry)\.js|public\/models\/quarry-.*)$/, area: [-15130, -15060, -17670, -17630] },
  'parklea-close': { files: /^(js\/(interiors|interior-data|model-sites|surfaces|controllers|cameras|pedestrians|city-grid|ground-geometry)\.js|public\/models\/parklea-.*)$/, area: [-16700, -16590, -17840, -17740] },
  'parklea-close-phone': { files: /^(js\/(interiors|interior-data|model-sites|surfaces|controllers|cameras|pedestrians|city-grid|ground-geometry)\.js|public\/models\/parklea-.*)$/, area: [-16700, -16590, -17840, -17740] },
  'parklea-cottage': { files: /^(js\/(interiors|interior-data|model-sites|surfaces|controllers|cameras|pedestrians|city-grid|ground-geometry)\.js|public\/models\/parklea-.*)$/, area: [-16700, -16590, -17840, -17740] },
  'cove-st-41': { files: /^(js\/(interiors|interior-data|model-sites|surfaces|controllers|cameras|pedestrians|city-grid|ground-geometry)\.js|public\/models\/cove-st-.*)$/, area: [6260, 6305, -4475, -4435] },
  'cove-st-43': { files: /^(js\/(interiors|interior-data|model-sites|surfaces|controllers|cameras|pedestrians|city-grid|ground-geometry)\.js|public\/models\/cove-st-.*)$/, area: [6260, 6305, -4475, -4435] },
  'school-st': { files: /^(js\/(interiors|interior-data|model-sites|surfaces|controllers|cameras|pedestrians|city-grid|ground-geometry)\.js|public\/models\/school-st.*)$/, area: [-1505, -1465, -1772, -1738] },
  'wolseley-rd': { files: /^(js\/(interiors|interior-data|model-sites|surfaces|controllers|cameras|pedestrians|city-grid|ground-geometry)\.js|public\/models\/wolseley-rd.*)$/, area: [3870, 3935, -940, -905] },
  'wolseley-rd-phone': { files: /^(js\/(interiors|interior-data|model-sites|surfaces|controllers|cameras|pedestrians|city-grid|ground-geometry)\.js|public\/models\/wolseley-rd.*)$/, area: [3870, 3935, -940, -905] },
  'opera-house': { files: /^(js\/(interiors|interior-data|model-sites|opera-house|landmarks|surfaces|controllers|cameras|pedestrians)\.js|public\/models\/opera-.*)$/, area: [440, 600, -1960, -1740] },
  'opera-house-phone': { files: /^(js\/(interiors|interior-data|model-sites|opera-house|landmarks|surfaces|controllers|cameras|pedestrians)\.js|public\/models\/opera-.*)$/, area: [440, 600, -1960, -1740] },
  'walk-in-phone': { files: /^(js\/(interiors|interior-data|model-sites|buildings|surfaces|controllers|cameras|pedestrians)\.js|public\/models\/.*)$/, area: null },
  'origin-move': { files: /^js\/(world-origin|main|scene-culling|traffic|pedestrians|buildings|trees)\.js$/, area: null },
  'origin-far': { files: /^js\/(world-origin|main|scene-culling|traffic|pedestrians|buildings|trees)\.js$/, area: null },
  'signal-wait': { files: /^js\/(signals|traffic|street-details)\.js$/, area: null },
  'first-minute': { files: /^/, area: [200, 600, -1500, -800] },
  'drive-route': { files: /^js\/(road-network|traffic|vehicle-physics)\.js$/, area: [50, 320, 230, 400] },
  'crash-recovery': { files: /^js\/(vehicle-physics|building-collision|controllers)\.js$/, area: null },
  'walk-cycle': { files: /^js\/(pedestrians|pedestrian-system|building-collision|controllers|arrivals)\.js$/, area: null },
  helicopter: { files: /^js\/(helicopter|controllers|cameras|buildings|building-footprints|arrivals)\.js$/, area: null },
  'mode-map': { files: /^js\/(cameras|city-map|lighting|controllers|arrivals|main)\.js$/, area: null },
  'mode-switch': { files: /^js\/(controllers|arrivals|surfaces|bridge|main)\.js$/, area: null },
  touch: { files: /^js\/(touch-controls|controllers)\.js$|^css\//, area: null },
  'orbit-follow': { files: /^js\/(cameras|controllers|pedestrians)\.js$/, area: null },
  'orbit-follow-phone': { files: /^js\/(cameras|controllers|touch-controls)\.js$/, area: null },
  pause: { files: /^js\/(pause-menu|main)\.js$|^index\.html$/, area: null },
  'auto-steps-down': { files: /^js\/quality\.js$/, area: null },
  'graphics-menu': { files: /^js\/(quality|pause-menu)\.js$/, area: null },
  'high-graphics': { files: /^js\/(quality|post-processing)\.js$/, area: null },
  'low-graphics': { files: /^js\/(quality|tsl-materials|buildings|building-footprints|street-details|tower-signs|landmarks)\.js$/, area: null },
  'webgl2-fallback': { files: /^js\/(tsl-materials|main|lighting|pedestrians|tower-signs|landmarks)\.js$/, area: null },
  'device-lost': { files: /^js\/main\.js$/, area: null },
  'saved-position': { files: /^js\/(main|controllers|arrivals)\.js$/, area: [-600, -480, -3620, -3520] },
  soak: { files: /^$/, area: null }
};

const MAP_DATA = /^(js\/geodata\.js|public\/tiles\/.*)$/;
const tileArea = (tile, size = 1000) => {
  const [ix, iz] = tile.split('_').map(Number);
  return [ix * size, (ix + 1) * size, iz * size, (iz + 1) * size];
};
const overlaps = (a, b) => a[0] < b[1] && a[1] > b[0] && a[2] < b[3] && a[3] > b[2];

// Scenarios that drive through any of these tiles ("ix_iz", 1 km squares)
export function scenariosForTiles(tiles) {
  return Object.keys(COVERS).filter((name) => COVERS[name].area && tiles.some((t) => overlaps(COVERS[name].area, tileArea(t))));
}

export function affectedScenarios(files) {
  const names = new Set(['first-minute']);
  for (const file of files) {
    if (MAP_DATA.test(file)) {
      for (const [name, { area }] of Object.entries(COVERS)) if (area) names.add(name);
      continue;
    }
    if (ALL_DRIVES.test(file)) names.add('drive-route');
    for (const [name, { files: pattern }] of Object.entries(COVERS)) {
      if (name !== 'first-minute' && pattern.test(file)) names.add(name);
    }
  }
  return Object.keys(COVERS).filter((name) => names.has(name));
}
