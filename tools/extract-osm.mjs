// Cuts what the generators read out of Geofabrik's Australia extract (or another by OSM_PBF; © OpenStreetMap contributors,
// ODbL), in the shape Overpass gives (tools/fetch-data.mjs), since Overpass isn't suited to downloads this size. A way or relation with any
// node inside the box comes whole.
//   node tools/extract-osm.mjs west,south,east,north out-folder [names]
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PBF = path.join(ROOT, process.env.OSM_PBF ?? 'tools/data/osm/australia-latest.osm.pbf');
const [west, south, east, north] = process.argv[2].split(',').map(Number);
const OUT = process.argv[3];
const only = process.argv[4]?.split(',');
fs.mkdirSync(OUT, { recursive: true });
const TEMP = path.join(OUT, 'duck.tmp');
const MARGIN = 0.25; // degrees: nodes further out than this from the box aren't kept, so a very long way past the box is cut off there

const tag = (key) => `tags['${key}']`;
const isIn = (key, values) => `${tag(key)} IN (${values.map((v) => `'${v}'`).join(',')})`;
const ROADS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'service', 'pedestrian'];
const CATEGORIES = {
  all_roads: { ways: isIn('highway', ROADS) },
  cycleways: { ways: isIn('highway', ['cycleway']) },
  nodes: { nodes: `${isIn('highway', ['traffic_signals', 'crossing', 'bus_stop'])} OR ${isIn('natural', ['tree'])} OR ${isIn('amenity', ['post_box'])} OR ${isIn('place', ['suburb', 'quarter', 'neighbourhood'])}` },
  land: {
    ways: `${isIn('man_made', ['pier'])} OR ${isIn('leisure', ['park', 'garden', 'pitch', 'playground', 'common'])} OR ${isIn('landuse', ['grass', 'recreation_ground', 'village_green'])} OR ${isIn('natural', ['water', 'wood'])}`,
    relations: `${isIn('man_made', ['pier'])} OR ${isIn('leisure', ['park', 'garden'])} OR ${isIn('natural', ['water'])}`
  },
  coast: { ways: isIn('natural', ['coastline']) },
  rail: {
    ways: `${isIn('railway', ['light_rail', 'rail', 'subway', 'tram'])} OR ${isIn('route', ['ferry'])}`,
    nodes: isIn('railway', ['station', 'stop'])
  }
};

const db = await DuckDBInstance.create(':memory:');
const c = await db.connect();
await c.run(`SET temp_directory='${TEMP}'; INSTALL spatial; LOAD spatial;`);
const read = `ST_ReadOSM('${PBF}')`;
const started = Date.now();
const say = (text) => console.log(`[osm] ${((Date.now() - started) / 1000).toFixed(0)} s: ${text}`);
const count = async (table) => Number((await c.runAndReadAll(`SELECT count(*) FROM ${table}`)).getRows()[0][0]);

await c.run(`CREATE TABLE n AS SELECT id, lat, lon, tags FROM ${read} WHERE kind = 'node' AND lat BETWEEN ${south - MARGIN} AND ${north + MARGIN} AND lon BETWEEN ${west - MARGIN} AND ${east + MARGIN}`);
say(`${await count('n')} nodes around the box`);
const every = (kind) => Object.entries(CATEGORIES).map(([name, q]) => q[kind] && `(${q[kind]})`).filter(Boolean).join(' OR ');
await c.run(`CREATE TABLE w AS SELECT id, tags, refs FROM ${read} WHERE kind = 'way' AND (${every('ways')})`);
say(`${await count('w')} ways of interest in Australia`);
await c.run(`CREATE TABLE r AS SELECT id, tags, refs, ref_types, ref_roles FROM ${read} WHERE kind = 'relation' AND (${every('relations')})`);
say(`${await count('r')} relations of interest in Australia`);
await c.run(`CREATE TABLE inside AS SELECT id FROM n WHERE lat BETWEEN ${south} AND ${north} AND lon BETWEEN ${west} AND ${east}`);
await c.run('CREATE TABLE rm AS SELECT id AS rid, unnest(refs) AS ref, unnest(ref_types) AS type, unnest(ref_roles) AS role, generate_subscripts(refs, 1) AS k FROM r');
await c.run(`CREATE TABLE member_ways AS SELECT id, tags, refs FROM ${read} WHERE kind = 'way' AND id IN (SELECT ref FROM rm WHERE type = 'way')`);
say(`${await count('member_ways')} ways in those relations`);
await c.run('CREATE TABLE all_ways AS SELECT id, tags, refs FROM w UNION SELECT id, tags, refs FROM member_ways');
await c.run('CREATE TABLE wn AS SELECT id AS wid, unnest(refs) AS nid, generate_subscripts(refs, 1) AS k FROM all_ways');
await c.run('CREATE TABLE way_geo AS SELECT wn.wid, list(wn.nid ORDER BY k) AS nids, list(n.lat ORDER BY k) AS lats, list(n.lon ORDER BY k) AS lons, bool_or(wn.nid IN (SELECT id FROM inside)) AS touches FROM wn JOIN n ON n.id = wn.nid GROUP BY wn.wid');
say('way geometry joined');

async function eachLine(query, visit) {
  const file = path.join(OUT, 'rows.tmp.json');
  await c.run(`COPY (${query}) TO '${file}' (FORMAT JSON)`);
  const lines = readline.createInterface({ input: fs.createReadStream(file) });
  for await (const line of lines) if (line) visit(JSON.parse(line));
  fs.rmSync(file);
}
const geometryOf = (lats, lons) => lats.map((lat, i) => ({ lat, lon: lons[i] }));
const tagsOf = (t) => t ?? {};

for (const [name, q] of Object.entries(CATEGORIES)) {
  if (only && !only.includes(name)) continue;
  const out = fs.createWriteStream(path.join(OUT, `${name}.json`));
  let first = true, written = 0;
  const write = (element) => {
    out.write(`${first ? '' : ',\n'}${JSON.stringify(element)}`);
    first = false;
    written++;
  };
  out.write('{"elements":[\n');
  if (q.nodes) {
    await eachLine(`SELECT id, lat, lon, tags FROM n WHERE lat BETWEEN ${south} AND ${north} AND lon BETWEEN ${west} AND ${east} AND (${q.nodes})`,
      (e) => write({ type: 'node', id: e.id, lat: e.lat, lon: e.lon, tags: tagsOf(e.tags) }));
  }
  if (q.ways) {
    await eachLine(`SELECT w.id, w.tags, g.nids, g.lats, g.lons FROM w JOIN way_geo g ON g.wid = w.id WHERE g.touches AND (${q.ways})`,
      (e) => write({ type: 'way', id: e.id, tags: tagsOf(e.tags), nodes: e.nids, geometry: geometryOf(e.lats, e.lons) }));
  }
  if (q.relations) {
    const relations = new Map();
    await eachLine(`SELECT r.id AS rid, r.tags, m.ref, m.role, m.k, g.lats, g.lons, g.touches FROM r JOIN rm m ON m.rid = r.id JOIN way_geo g ON g.wid = m.ref WHERE m.type = 'way' AND (${q.relations.replaceAll("tags[", 'r.tags[')})`, (e) => {
      let relation = relations.get(e.rid);
      if (!relation) relations.set(e.rid, (relation = { type: 'relation', id: e.rid, tags: tagsOf(e.tags), members: [], touches: false }));
      relation.members.push({ k: e.k, type: 'way', ref: e.ref, role: e.role, geometry: geometryOf(e.lats, e.lons) });
      relation.touches ||= e.touches;
    });
    for (const relation of relations.values()) {
      if (!relation.touches) continue;
      relation.members.sort((p, q2) => p.k - q2.k);
      delete relation.touches;
      for (const m of relation.members) delete m.k;
      write(relation);
    }
  }
  out.write('\n]}\n');
  await new Promise((done) => out.end(done));
  say(`${name}: ${written} elements, ${Math.round(fs.statSync(path.join(OUT, `${name}.json`)).size / 1048576)} MB`);
}
fs.rmSync(TEMP, { recursive: true, force: true });
