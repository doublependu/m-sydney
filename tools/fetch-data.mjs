// Downloads the raw map snapshots into tools/data/. They stay out of the repository: the generators turn them into the
// committed files in js/. usage: node tools/fetch-data.mjs [only,these,names]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DATA = path.join(ROOT, 'tools/data');
fs.mkdirSync(DATA, { recursive: true });
const only = process.argv[2]?.split(',');
const wanted = (name) => !only || only.includes(name);

const BOX = '-33.905,151.175,-33.825,151.245'; // south, west, north, east
const WIDE = '-34.02,151.02,-33.68,151.36'; // the skyline out to the horizon
const OVERTURE_RELEASE = '2026-10-21.0';
const ROADS = '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|service|pedestrian)$';

const OVERPASS = {
  all_roads: `[out:json][timeout:170][bbox:${BOX}];(way[highway~"${ROADS}"];);out body geom;`,
  nodes: `[out:json][timeout:170][bbox:${BOX}];(node[highway=traffic_signals];node[highway=crossing];node[natural=tree];node[highway=bus_stop];node[amenity=post_box];);out;`,
  land: `[out:json][timeout:170][bbox:${BOX}];(way[man_made=pier];relation[man_made=pier];way[leisure=park];relation[leisure=park];way[landuse~"^(grass|recreation_ground|village_green)$"];way[leisure~"^(garden|pitch|playground|common)$"];relation[leisure=garden];way[natural=water];relation[natural=water];way[natural=wood];);out body geom;`,
  harbour: '[out:json][timeout:170];relation(id:15522136,1252425);out body geom;',
  coast: `[out:json][timeout:170];(way[natural=coastline](${WIDE}););out body geom;`,
  cycleways: `[out:json][timeout:170][bbox:${BOX}];(way[highway=cycleway];);out body geom;`,
  rail: `[out:json][timeout:170][bbox:${BOX}];(way[railway~"^(light_rail|rail|subway|tram)$"];node[railway=station];node[railway=stop];way[route=ferry];);out body geom;`,
  wide_land: `[out:json][timeout:170];(way[landuse~"^(residential|commercial|industrial)$"](${WIDE});way[leisure~"^(park|nature_reserve)$"](${WIDE});relation[leisure~"^(park|nature_reserve)$"](${WIDE});relation[boundary=national_park](${WIDE});way[natural~"^(wood|scrub)$"](${WIDE}););out geom tags;`
};

for (const [name, query] of Object.entries(OVERPASS)) {
  if (!wanted(name)) continue;
  const q = path.join(DATA, `q_${name}.overpassql`);
  fs.writeFileSync(q, query);
  const run = spawnSync('bash', [path.join(ROOT, 'tools/overpass.sh'), path.join(DATA, `${name}.json`), q, '6'], { stdio: 'inherit' });
  if (run.status !== 0) throw new Error(`Overpass query failed: ${name}`);
}

// ArcGIS feature layers, a page at a time, as GeoJSON features
async function arcgis(url, params) {
  const out = [];
  for (let offset = 0; ;) {
    const query = new URLSearchParams({ where: '1=1', outSR: '4326', f: 'geojson', resultOffset: offset, resultRecordCount: 1000, geometryPrecision: 6, ...params });
    const response = await fetch(`${url}/query?${query}`);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    const page = await response.json();
    if (page.error) throw new Error(`${url}: ${JSON.stringify(page.error)}`);
    const features = page.features || [];
    out.push(...features);
    offset += features.length;
    if (features.length < 1000) return out;
  }
}
const COS = 'https://services1.arcgis.com/cNVyNtjGVZybOQWZ/arcgis/rest/services';
const NSW = 'https://portal.spatial.nsw.gov.au/server/rest/services';
const box = (b) => ({ geometry: b, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' });
const LAYERS = {
  cos_trees: [`${COS}/Trees/FeatureServer/0`, { outFields: 'CommonName,TreeHeight,Tree_Status' }],
  cos_contours: [`${COS}/Terrain_Contours/FeatureServer/0`, { outFields: 'Contour' }],
  cos_parks: [`${COS}/Parks/FeatureServer/0`, { outFields: '*' }],
  cos_awnings: [`${COS}/Sydney_Development_Control_Plan_2012/FeatureServer/6`, { outFields: '*' }],
  cos_storeys: [`${COS}/Sydney_Development_Control_Plan_2012/FeatureServer/7`, { outFields: 'Storeys' }],
  nsw_contours: [`${NSW}/NSW_Elevation_and_Depth_Theme/FeatureServer/2`, { outFields: 'elevation', ...box('151.02,-34.02,151.36,-33.68') }],
  nsw_ferries: [`${NSW}/NSW_Transport_Theme/FeatureServer/8`, { outFields: '*', ...box('151.05,-33.95,151.33,-33.78') }]
};
for (const [name, [url, params]] of Object.entries(LAYERS)) {
  if (!wanted(name)) continue;
  const features = await arcgis(url, params);
  fs.writeFileSync(path.join(DATA, `${name}.json`), JSON.stringify(features));
  console.log(`${name}: ${features.length} features`);
}

// Overture buildings (OSM + Microsoft ML footprints, with heights where known), read straight from the release
if (wanted('overture_syd')) {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  await c.run("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';");
  const [south, west, north, east] = BOX.split(',').map(Number);
  await c.run(`CREATE TABLE b AS SELECT id, height, num_floors, min_height, roof_shape, class, subtype, is_underground, has_parts,
    names.primary AS name, sources[1].dataset AS src, ST_AsGeoJSON(geometry) AS g
    FROM read_parquet('s3://overturemaps-us-west-2/release/${OVERTURE_RELEASE}/theme=buildings/type=building/*', hive_partitioning=1)
    WHERE bbox.xmin > ${west} AND bbox.xmax < ${east} AND bbox.ymin > ${south} AND bbox.ymax < ${north}`);
  await c.run(`COPY b TO '${path.join(DATA, 'overture_syd.json')}' (FORMAT JSON)`);
  console.log('overture_syd written');
}

// Overture building parts: where a tower's real height and shape are, while its building record often holds only its podium
if (wanted('overture_parts')) {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  await c.run("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';");
  const [south, west, north, east] = BOX.split(',').map(Number);
  await c.run(`CREATE TABLE p AS SELECT id, building_id, height, min_height, num_floors, min_floor, roof_shape, ST_AsGeoJSON(geometry) AS g
    FROM read_parquet('s3://overturemaps-us-west-2/release/${OVERTURE_RELEASE}/theme=buildings/type=building_part/*', hive_partitioning=1)
    WHERE bbox.xmin > ${west} AND bbox.xmax < ${east} AND bbox.ymin > ${south} AND bbox.ymax < ${north}`);
  await c.run(`COPY p TO '${path.join(DATA, 'overture_parts.json')}' (FORMAT JSON)`);
  console.log('overture_parts written');
}
