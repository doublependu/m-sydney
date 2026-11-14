// For tests/model-sites.test.mjs: the way out of each site named on the command line (js/interior-data.js exitSpot()), worked out as the
// game works it out, on the tiles SYDNEY_TILES holds, and what's at the spot. Prints JSON: { [id]: { spot, ... } }.
// usage: SYDNEY_TILES=x0,z0,x1,z1 node tests/helpers/exit-spots.mjs <site id> ...
import fs from 'node:fs';

const { onMap } = await import('../../js/geodata.js');
const { MODEL_SITES } = await import('../../js/model-sites.js');
const { clearOf, exitSpot, roomAt, toLocal, toWorld } = await import('../../js/interior-data.js');
const { footpathFrom, holdOnFootway, walkable } = await import('../../js/arrivals.js');
const { blockAt, CITY_BOUNDS, landAt } = await import('../../js/city-config.js');
const { groundHeight } = await import('../../js/surfaces.js');
await import('../../js/bridge.js'); // the Harbour Bridge's footway, for holdOnFootway()

const model = (name) => JSON.parse(fs.readFileSync(new URL(`../../public/models/${name}.json`, import.meta.url), 'utf8'));
const tiles = [];
onMap({ addTile: (tile) => tiles.push(tile) });

const inRing = (ring, x, z) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    const [ax, az] = Array.isArray(a) ? a : [a.x, a.z], [bx, bz] = Array.isArray(b) ? b : [b.x, b.z];
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) c = !c;
  }
  return c;
};
// The map's buildings round (x, z): in one, or within r of one (eight points round it)
const inBuilding = (x, z, r = 0) => [[0, 0], ...Array.from({ length: 8 }, (_, k) => [Math.cos(k * Math.PI / 4) * r, Math.sin(k * Math.PI / 4) * r])]
  .some(([u, v]) => tiles.some((t) => t.buildings.some((b) => x + u >= b.minX && x + u <= b.maxX && z + v >= b.minZ && z + v <= b.maxZ
    && b.polygons.some((p) => inRing(p.outer, x + u, z + v)))));

const out = {};
for (const id of process.argv.slice(2)) {
  const S = MODEL_SITES.find((s) => s.id === id);
  const data = model(S.file.replace('models/', ''));
  const door0 = data.doors.find((d) => d.inside);
  const inside = model(door0.inside);
  const site = { ...S };
  if (site.y === null) {
    // as js/interiors.js loadOutside() stands it on the ground
    const pts = data.walls.flatMap((w) => [w.a, w.b]);
    const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
    let top = -Infinity;
    for (let x = Math.min(...xs); x <= Math.max(...xs) + 0.01; x += 1) {
      for (let z = Math.min(...zs); z <= Math.max(...zs) + 0.01; z += 1) {
        const at = toWorld(site, x, z);
        top = Math.max(top, groundHeight(at.x, at.z) + (blockAt(at.x, at.z) ? CITY_BOUNDS.sidewalkHeight : 0));
      }
    }
    site.y = top + 0.25;
  }
  const walls = [...data.walls, ...(inside.walls ?? [])];
  // As the game's isClear: the walker's 0.48 m outside, clear of the site's walls and the map's buildings
  const clear = (x, z, y) => {
    const p = toLocal(site, x, z);
    return clearOf(walls, p.x, p.z, y - site.y, 0.48) && !inBuilding(x, z, 0.48);
  };
  let path = null;
  const spot = exitSpot(site, data.doors, inside.rooms, (x, z, y, heading) => (path = footpathFrom(x, z, y, heading, (px, pz) => clear(px, pz, y))));
  if (!spot) {
    out[id] = { spot: null };
    continue;
  }
  const local = toLocal(site, spot.x, spot.z);
  const door = data.doors.find((d) => d.id === spot.door);
  const doorMiddle = door ? toWorld(site, (door.hinge[0] + door.latch[0]) / 2, (door.hinge[1] + door.latch[1]) / 2) : null;
  const footway = holdOnFootway(spot.x, spot.z);
  out[id] = {
    spot: { ...spot, x: +spot.x.toFixed(2), z: +spot.z.toFixed(2), heading: +spot.heading.toFixed(3), local: { x: +local.x.toFixed(2), z: +local.z.toFixed(2) } },
    room: roomAt(inside.rooms, local.x, spot.y - site.y + 0.1, local.z)?.id ?? null,
    walkable: walkable(spot.x, spot.z),
    land: landAt(spot.x, spot.z),
    clear: clear(spot.x, spot.z, spot.y),
    onFloor: (data.floors ?? []).some((f) => inRing(f.poly, local.x, local.z) && Math.abs((f.plane ? f.plane[0] + f.plane[1] * local.x + f.plane[2] * local.z : f.y) - (spot.y - site.y)) < 0.6),
    footway: !!footway && Math.abs(footway.y - spot.y) < 1,
    fromDoor: doorMiddle ? +Math.hypot(spot.x - doorMiddle.x, spot.z - doorMiddle.z).toFixed(2) : null,
    facing: doorMiddle ? +Math.abs(Math.atan2(Math.sin(Math.atan2(doorMiddle.x - spot.x, doorMiddle.z - spot.z) - spot.heading), Math.cos(Math.atan2(doorMiddle.x - spot.x, doorMiddle.z - spot.z) - spot.heading))).toFixed(3) : null,
    road: spot.via === 'footpath' ? path.road : null
  };
}
process.stdout.write(JSON.stringify(out));
