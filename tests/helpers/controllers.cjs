// The player's controls without the scene: js/controllers.js loaded with its imports stubbed, its keyboard bound to a stand-in window
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('./module.cjs');

const source = readFileSync(join(__dirname, '../../js/controllers.js'), 'utf8');
const polygonCollision = loadModule(readFileSync(join(__dirname, '../../js/building-collision.js'), 'utf8'));

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

function keyboardHarness(nyc = {}) {
  const window = eventTarget();
  const document = { ...eventTarget(), hidden: false };
  const config = {
    SPAWN: { x: 0, z: 0, heading: 0 },
    landAt: () => true,
    isTypingInField: (event) => ['INPUT', 'SELECT'].includes(event.target?.tagName),
    ...nyc
  };
  const { ThirdPersonControllerManager } = loadModule(source, {
    globals: { window, document },
    imports: {
      'three/webgpu': {},
      './city-config.js': config,
      './tsl-materials.js': {},
      './cars.js': {},
      './helicopter.js': {},
      './pedestrians.js': {},
      './vehicle-lights.js': {},
      './bridge.js': { DECK_SID: 0 },
      './arrivals.js': { FLY: { AREA: 200 }, arrivalFor: () => null, holdOnFootway: () => null },
      './surfaces.js': { clearOfWater: (x, z) => [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].every(([u, v]) => config.landAt(x + u * 2.5, z + v * 2.5)), edgeHeight: () => 0, groundHeight: () => 0, onFloor: () => false, surfaceHeight: () => 0, surfaceSlope: () => 0, sameLevel: (a, b) => Math.abs(a - b) < 3, chooseSurface: () => ({ sid: 0, y: 0 }), moveOver: (sid, y, fx, fz, x, z) => ({ x, z, sid: 0, y: 0, held: false }), freeFromDeck: () => null, ROOM: { car: 2.0, foot: 2.3 }, structureAt: () => null, structuresAt: () => [], LINKS: [] },
      './building-collision.js': polygonCollision,
      './interior-data.js': { WALKER: 0.22 },
      './model-sites.js': { MODEL_SITES: [] }
    }
  });
  // Exercise the production event handlers without constructing the scene's 3D models.
  const controller = Object.create(ThirdPersonControllerManager.prototype);
  controller.keys = Object.fromEntries(['forward', 'backward', 'left', 'right', 'sideLeft', 'sideRight', 'up', 'down', 'run'].map((action) => [action, false]));
  controller.bindKeyboard();
  return {
    controller,
    window,
    document,
    key(type, code, tagName = 'BODY') {
      window.dispatch(type, { code, target: { tagName } });
    }
  };
}

module.exports = { eventTarget, keyboardHarness };
