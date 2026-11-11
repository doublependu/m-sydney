const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

// A small grid of two-way streets. Every check below is made from positions, not from the code's own labels.
const nodes = [];
const links = [];
const L = 300;
for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) nodes.push((i - 1) * L, (j - 1) * L);
for (let i = 0; i < 3; i++) {
  for (let j = 0; j < 3; j++) {
    const n = i * 3 + j;
    if (j < 2) links.push([n, n + 1, 0, 12, 2, 0, [], 1]);
    if (i < 2) links.push([n, n + 3, 1, 12, 2, 0, [], 1]);
  }
}
const graph = { nodes, links, names: ['A Street', 'B Street'] };

function network(side) {
  graph.links.forEach((l, i) => { l.id = i; });
  const { buildRoadNetwork } = loadModule(readFileSync(join(__dirname, '../js/road-network.js'), 'utf8'), {
    imports: {
      './city-config.js': { BLOCKS: [], CITY_BOUNDS: { minZ: -500, maxZ: 500 }, DRIVE_SIDE: side, blockAt: () => null, landAt: () => true },
      './geodata.js': { GEO: { roadGraph: graph }, heldTiles: () => [] },
      './building-collision.js': { polygonBoxOverlaps: () => false },
      './surfaces.js': { KIND: { GROUND: 0, BRIDGE: 1, TUNNEL: 2, CUTTING: 3 }, linkById: new Map(graph.links.map((_, i) => [i, { sid: 0, kind: 0 }])) },
      './bridge.js': { deckLanePoints: () => null }
    },
    globals: { console: { info() {} }, Math, Map, Set, Array, Object, Number, Infinity, Uint8Array, Float32Array }
  });
  return buildRoadNetwork([], []);
}

for (const [side, name] of [[-1, 'left'], [1, 'right']]) {
  test(`traffic keeps to the ${name} and the far turn crosses oncoming traffic`, () => {
    const { edges } = network(side);
    assert.ok(edges.length > 8);
    for (const e of edges) {
      // True right of travel is (-dz, dx) with z pointing south
      for (const o of e.lanes) {
        const lateral = (e.rx * o) * -e.dz + (e.rz * o) * e.dx;
        assert.ok(lateral * side > 0, `lane ${o} of an edge going (${e.dx}, ${e.dz}) is on the ${name}`);
      }
      for (const m of e.moves) {
        if (m.turn === 'S') continue;
        const trueRight = e.dx * m.to.dz - e.dz * m.to.dx > 0;
        assert.equal(m.turn === 'L', side < 0 ? trueRight : !trueRight, 'the far turn is the one across the oncoming lanes');
      }
    }
  });
}
