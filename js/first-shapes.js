// What stands for a model site (js/model-sites.js) till its model, or its far version, is drawn: its first shape. One of the three is
// drawn at a time, and js/interiors.js says which: the model within the site's `near` once it's in, the far version past `near` once
// that's in, and the first shape otherwise. A site's first shape is
// - the map's buildings it replaces, kept apart in its tile (`standIns`, tools/tiles/derive.mjs) and drawn as the map draws its buildings
//   (js/buildings.js addStandIns()), with a cover over the site's cut where it has one (js/city-grid.js), which is the ground to stand on
//   while it's drawn (js/drawn-ground.js);
// - and for a landmark, the game's own shape of it (js/landmarks.js, js/opera-house.js).
// So from the first view a site shows what the map always had there, with nothing more to fetch, and a model that's slow or never comes
// leaves it standing.
//
// A part is hung on its site's first shape with one line, addFirstShape(id, object, how):
//   how.far: drawn with the far version too, which doesn't draw it (Sydney Tower's shaft and turret: its far version is its podium alone)
//   how.bare: drawn only while nothing else stands in the site's place: neither the map's buildings from its tile, nor the far version
//     (the game's podium under Sydney Tower, from far off before its tile is built)
//   how.standIn: the map's buildings, or a cut's cover, from a tile: with one of these held, a site within its `near` shows its first
//     shape rather than its far version while its model comes
//   how.show(on): called as it's shown and hidden (a cover's ground)
//   how.tile: the tile it came with, let go of with it (dropFirstShapes())

const sites = new Map(); // site id -> { shape, parts: Map(object -> how) }

const siteOf = (id) => sites.get(id) || sites.set(id, { shape: 'first', parts: new Map() }).get(id);
/** Whether a site's first shape has something of its own held: one of the map's buildings, or a landmark's shape */
const held = (site) => [...site.parts.values()].some((how) => !how.far && !how.bare);
/** Whether a part is drawn while its site shows `shape` ('first', 'far' or 'model'), `has` whether the site holds more than bare parts */
function drawnIn(how, shape, has) {
  if (shape === 'model') return false;
  if (shape === 'far') return !!how.far;
  return how.bare ? !has : true;
}

function place(site) {
  const has = held(site);
  for (const [object, how] of site.parts) {
    const on = drawnIn(how, site.shape, has);
    if (object.visible === on && how.shown === on) continue;
    object.visible = on;
    how.shown = on;
    how.show?.(on);
  }
}

/** Hangs `object` on site `id`'s first shape: shown and hidden with it from now on (see the top of this file for `how`) */
function addFirstShape(id, object, how = {}) {
  const site = siteOf(id);
  site.parts.set(object, { ...how, shown: null });
  place(site);
}

/** Lets go of every part that came with tile `key`: hidden (their meshes go with the tile) */
function dropFirstShapes(key) {
  for (const site of sites.values()) {
    let dropped = false;
    for (const [object, how] of site.parts) {
      if (how.tile !== key) continue;
      site.parts.delete(object);
      if (how.shown) how.show?.(false);
      dropped = true;
    }
    if (dropped) place(site);
  }
}

/** Whether site `id` holds a first shape of its own to show: the map's buildings from its tile, or a landmark's shape */
const hasFirstShape = (id) => {
  const site = sites.get(id);
  return !!site && held(site);
};

/** What site `id` shows now: 'model', 'far' or 'first' (js/interiors.js), and its parts with it */
function showFirstShape(id, shape) {
  const site = siteOf(id);
  if (site.shape === shape) return;
  site.shape = shape;
  place(site);
}

/** For scripts: each site's shape, and how many of its parts are held and drawn */
function firstShapesState() {
  return Object.fromEntries([...sites].map(([id, site]) => [id, {
    shape: site.shape,
    parts: site.parts.size,
    standIns: [...site.parts.values()].filter((how) => how.standIn).length,
    drawn: [...site.parts.values()].filter((how) => how.shown).length
  }]));
}

export { addFirstShape, drawnIn, dropFirstShapes, firstShapesState, hasFirstShape, showFirstShape };
