const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const source = readFileSync(join(__dirname, '../js/city-map.js'), 'utf8');

test('surveyed building courtyards remain holes in the map footprint layer', () => {
  class Path2D {
    rings = [];
    moveTo(x, z) { this.rings.push([[x, z]]); }
    lineTo(x, z) { this.rings.at(-1).push([x, z]); }
    closePath() {}
  }
  const { footprintLayers } = loadModule(source + '\nexport { footprintLayers };', {
    globals: { Path2D },
    imports: { './geodata.js': { GEO: { frame: {} }, heldTiles: () => [], loadMapData: () => new Promise(() => {}) }, './city-config.js': { ROADS: [], SUBURBS: [] }, './model-sites.js': { SITE_OUTLINES: [] } }
  });
  const ring = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
  const layers = footprintLayers([{ footprints: [{ h: 120, pts: ring(0, 0, 20, 20), holes: [ring(5, 5, 15, 15)] }] }]);
  const [tile] = layers.tones[2].tiles.values();
  const areas = tile.path.rings.map((r) => r.reduce((sum, p, i) => {
    const q = r[(i + 1) % r.length];
    return sum + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2);
  assert.deepEqual(areas, [400, -100], 'opposite winding cuts the courtyard out under the nonzero fill rule');
});

test('buildings drawn from models are on the map by their own outlines, in their shade, under the same edge', () => {
  class Path2D {
    rings = [];
    moveTo(x, z) { this.rings.push([[x, z]]); }
    lineTo(x, z) { this.rings.at(-1).push([x, z]); }
    closePath() {}
  }
  const ring = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
  const SITE_OUTLINES = [{ h: 12, pts: ring(100, 100, 110, 115) }, { h: 263, pts: ring(-30, -1200, 20, -1180) }];
  const { footprintLayers } = loadModule(source + '\nexport { footprintLayers };', {
    globals: { Path2D },
    imports: {
      './geodata.js': { GEO: { frame: {} }, heldTiles: () => [], loadMapData: () => new Promise(() => {}) }, './city-config.js': { ROADS: [], SUBURBS: [] },
      './model-sites.js': { SITE_OUTLINES }
    }
  });
  const layers = footprintLayers([{ footprints: [{ h: 6, pts: ring(0, 0, 20, 20), holes: [] }] }]);
  const rings = (t) => [...layers.tones[t].tiles.values()].flatMap((tile) => tile.path.rings);
  assert.equal(rings(0).length, 2, 'the house beside the tile\'s building, in the low shade');
  assert.deepEqual(rings(0)[1].map(([x]) => x).sort((a, b) => a - b), [100, 100, 110, 110]);
  assert.equal(rings(2).length, 1, 'the tower in the tall shade');
  assert.equal(rings(1).length, 0);
});

for (const [width, height, dpr] of [[500, 300, 1], [320, 180, 1.5], [1920, 1080, 2]]) {
  test(`map clicks match rendered world positions at ${width}x${height}, DPR ${dpr}`, () => {
    const window = { innerWidth: width, innerHeight: height, devicePixelRatio: dpr };
    const { CityMapSystem } = loadModule(source, {
      globals: { window, performance: { now: () => 0 } },
      imports: { './geodata.js': { GEO: { frame: {} }, heldTiles: () => [], loadMapData: () => new Promise(() => {}) }, './city-config.js': { ROADS: [], SUBURBS: [] }, './model-sites.js': { SITE_OUTLINES: [] } }
    });
    const map = Object.create(CityMapSystem.prototype);
    // Capture the production render viewport; drawing primitives are irrelevant to coordinate conversion.
    const context = new Proxy({}, { get: () => () => {} });
    let view;
    Object.assign(map, {
      fullCanvas: { clientWidth: width, clientHeight: height },
      fullCtx: context,
      fullStatic: { getContext: () => context },
      isFullMapOpen: true,
      viewCenterX: 200,
      viewCenterZ: -300,
      viewZoom: 0.5,
      controllerManager: { getActiveEntity: () => ({ position: { x: 200, z: -300 }, heading: 0 }) },
      renderFullMapStatic: (_context, viewport) => { view = viewport; }
    });
    map.resizeFullCanvas();
    map.renderFullMap();

    for (const point of [{ x: 200, z: -300 }, { x: 325, z: -375 }]) {
      // Convert the renderer's centred coordinates through the canvas backing store to CSS pixels.
      const screenX = (view.toX(point.x) + view.w / 2) * view.dpr * width / map.fullCanvas.width;
      const screenY = (view.toY(point.z) + view.h / 2) * view.dpr * height / map.fullCanvas.height;
      const clicked = map.screenToWorld(screenX, screenY, width, height);
      // The pixel budget can yield a fractional DPR; integer backing sizes may round by less than one pixel.
      const tolerance = 1 / (view.s * view.dpr);
      assert.ok(Math.abs(clicked.x - point.x) < tolerance, `clicked x ${clicked.x} should match drawn x ${point.x}`);
      assert.ok(Math.abs(clicked.z - point.z) < tolerance, `clicked z ${clicked.z} should match drawn z ${point.z}`);
    }
  });
}

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    }
  };
}

function classList() {
  const names = new Set();
  return {
    add: (name) => names.add(name),
    remove: (name) => names.delete(name),
    contains: (name) => names.has(name),
    toggle(name, enabled) { if (enabled) names.add(name); else names.delete(name); }
  };
}

function mapHarness() {
  const window = { ...eventTarget(), innerWidth: 200, innerHeight: 200 };
  const canvas = {
    ...eventTarget(), style: {}, clientWidth: 200, clientHeight: 200,
    getContext: () => ({}),
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 200 })
  };
  const controls = eventTarget();
  const wrapper = { classList: classList() };
  const zoomIn = eventTarget(), zoomOut = eventTarget();
  const hoverInfo = { textContent: '' };
  const elements = {
    'fullmap-canvas': canvas, 'fullmap-canvas-wrap': wrapper,
    'fullmap-modal': { classList: classList() },
    'map-zoom-in': zoomIn, 'map-zoom-out': zoomOut, 'fullmap-hover-info': hoverInfo
  };
  const document = {
    ...eventTarget(), hidden: false,
    getElementById: (id) => elements[id] || null,
    querySelectorAll: () => []
  };
  const captured = new Set();
  canvas.setPointerCapture = (id) => captured.add(id);
  canvas.hasPointerCapture = (id) => captured.has(id);
  canvas.releasePointerCapture = (id) => {
    captured.delete(id);
    canvas.dispatch('lostpointercapture', { pointerId: id });
  };
  const config = {
    ROADS: [], BLOCKS: [], LANDMARKS: [{ id: 'opera', name: 'Opera House', short: 'Opera', x: 0, z: 0 }], SUBURBS: [],
    CITY_BOUNDS: { minX: -10000, maxX: 10000, minZ: -10000, maxZ: 10000 },
    getLocationLabel: (x, z) => `${x}, ${z}`,
    isTypingInField: () => false
  };
  const { CityMapSystem } = loadModule(source, {
    globals: { window, document },
    imports: { './geodata.js': { GEO: { frame: {}, surroundings: [] }, heldTiles: () => [], loadMapData: () => new Promise(() => {}) }, './city-config.js': config, './model-sites.js': { SITE_OUTLINES: [] } }
  });
  const teleports = [], toggles = [];
  const map = new CityMapSystem({
    controllerManager: { getActiveEntity: () => ({ position: { x: 1000, z: 2000 } }) },
    onTeleport: (x, z) => teleports.push([x, z]),
    onToggle: (open) => toggles.push(open)
  });
  // Exercise the real viewport/input state without drawing the map's geographic layers.
  map.renderFullMap = () => {};
  map.viewZoom = 1;
  map.toggleFullMap(true);
  return {
    map, canvas, controls, wrapper, window, document, captured, teleports, toggles, zoomIn, zoomOut, hoverInfo,
    pointer(target, type, id, x = 110, y = 120, pointerType = 'touch', button = 0) {
      const event = { pointerId: id, clientX: x, clientY: y, pointerType, button, preventDefault() {} };
      (captured.has(id) ? canvas : target).dispatch(type, event);
      window.dispatch(type, event);
    }
  };
}

test('unrelated touches cannot move or release the map pan', () => {
  const h = mapHarness();
  assert.equal(h.canvas.style.touchAction, 'none');
  h.pointer(h.canvas, 'pointerdown', 1);
  h.pointer(h.controls, 'pointerdown', 2);
  h.pointer(h.canvas, 'pointerdown', 3);
  h.pointer(h.controls, 'pointermove', 2, 190);
  h.pointer(h.canvas, 'pointermove', 3, 190);
  h.pointer(h.controls, 'pointerup', 2);
  h.pointer(h.canvas, 'pointercancel', 3);
  assert.equal(h.map.viewCenterX, 1000);
  assert.equal(h.map.isPanning, true);
  assert.equal(h.teleports.length, 0);

  h.pointer(h.controls, 'pointermove', 1, 130);
  assert.equal(h.map.viewCenterX, 980);
  h.pointer(h.controls, 'pointerup', 1, 130);
  assert.equal(h.map.isPanning, false);
  assert.equal(h.wrapper.classList.contains('is-panning'), false);
  assert.equal(h.teleports.length, 0);
});

test('a normal map tap teleports once and releases capture', () => {
  const h = mapHarness();
  h.pointer(h.canvas, 'pointerdown', 1);
  h.pointer(h.canvas, 'pointerup', 1);
  assert.deepEqual(h.teleports, [[1000, 2000]]);
  assert.equal(h.map.waypoint.name, '1000, 2000');
  assert.equal(h.captured.size, 0);
  assert.equal(h.map.isPanning, false);
});

for (const interruption of ['pointercancel', 'lostpointercapture', 'blur', 'hidden', 'close']) {
  test(`${interruption} cancels a map tap without teleporting or leaving a drag active`, () => {
    const h = mapHarness();
    h.pointer(h.canvas, 'pointerdown', 1);
    if (interruption === 'blur') h.window.dispatch('blur');
    else if (interruption === 'hidden') {
      h.document.hidden = true;
      h.document.dispatch('visibilitychange');
    } else if (interruption === 'close') h.map.toggleFullMap(false);
    else if (interruption === 'lostpointercapture') h.canvas.releasePointerCapture(1);
    else h.pointer(h.canvas, interruption, 1);
    h.pointer(h.canvas, 'pointerup', 1);
    assert.equal(h.teleports.length, 0);
    assert.equal(h.map.isPanning, false);
    assert.equal(h.captured.size, 0);
    assert.equal(h.wrapper.classList.contains('is-panning'), false);
    if (interruption === 'close') {
      assert.deepEqual(h.toggles, [true, false]);
      h.map.toggleFullMap(true);
    }
    h.pointer(h.canvas, 'pointerdown', 2);
    h.pointer(h.canvas, 'pointerup', 2);
    assert.equal(h.teleports.length, 1);
  });
}

test('a pointer released outside the map or far from its start does not teleport', () => {
  const h = mapHarness();
  h.pointer(h.canvas, 'pointerdown', 1, 205);
  h.pointer(h.controls, 'pointerup', 1, 215);
  h.pointer(h.canvas, 'pointerdown', 2, 110);
  h.pointer(h.canvas, 'pointerup', 2, 130);
  assert.equal(h.teleports.length, 0);
});

test('mouse hover and zoom buttons remain available without a pan', () => {
  const h = mapHarness();
  h.pointer(h.canvas, 'pointermove', 1, 120, 130, 'mouse');
  assert.equal(h.hoverInfo.textContent, '1010, 2010 · Click to teleport here');
  h.pointer(h.canvas, 'pointermove', 2, 180, 130);
  assert.equal(h.hoverInfo.textContent, '1010, 2010 · Click to teleport here', 'untracked touch does not update hover');
  h.zoomIn.dispatch('click');
  assert.equal(h.map.viewZoom, 1.45);
  h.zoomOut.dispatch('click');
  assert.equal(h.map.viewZoom, 1);
});

test('held land its blocks hardly cover has its roads drawn as lines, not painted over as one street', () => {
  class Path2D {
    rects = [];
    rect(x, z, w, h) { this.rects.push([x, z, w, h]); }
    moveTo() {}
    lineTo() {}
    closePath() {}
  }
  const square = (x0, z0, size) => [{ x: x0, z: z0 }, { x: x0 + size, z: z0 }, { x: x0 + size, z: z0 + size }, { x: x0, z: z0 + size }];
  // A town's tile, half of it blocks, and a farm's, a few house lots on a road that closes round none of them
  const town = Array.from({ length: 50 }, (_, i) => ({ poly: square((i % 10) * 100, Math.floor(i / 10) * 200, 100), cx: (i % 10) * 100 + 50, cz: Math.floor(i / 10) * 200 + 50, area: 10000, park: 0 }));
  const farm = [{ poly: square(1400, 400, 30), cx: 1415, cz: 415, area: 900, park: 0 }];
  const { mapLayers } = loadModule(source + '\nexport { mapLayers };', {
    globals: { Path2D, performance: { now: () => 0 } },
    imports: {
      './geodata.js': { GEO: { frame: {} }, heldTiles: () => [{ ix: 0, iz: 0, land: 1 }, { ix: 1, iz: 0, land: 1 }], loadMapData: () => new Promise(() => {}) },
      './city-config.js': { ROADS: [{ kind: 0, pts: [{ x: 1000, z: 500 }, { x: 2000, z: 500 }] }], BLOCKS: [...town, ...farm], SUBURBS: [], getMapVersion: () => 1 },
      './model-sites.js': { SITE_OUTLINES: [] }
    }
  });
  const L = mapLayers();
  assert.deepEqual(L.shores.rects, [[0, 0, 1000, 1000]], 'the town\'s streets are the gaps between its blocks');
  assert.deepEqual(L.sparse.rects, [[1000, 0, 1000, 1000]], 'the farm\'s tile is land, with its road drawn over it');
  assert.equal(L.roads.tiles.size, 1, 'the road is there to draw');
});
