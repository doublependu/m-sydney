const vm = require('node:vm');

// Keep the existing isolated unit harnesses synchronous. Only the app's static import/export declarations
// are adapted; dependencies are explicit namespace stubs, and the production function bodies run unchanged.
const WORLD_ORIGIN = {
  ORIGIN_STEP: 4096,
  origin: { x: 0, z: 0 },
  originXZ: { x: 0, y: 0 },
  patternXZ: { x: 0, y: 0 },
  anchorToOrigin: (object) => object,
  onOriginMove() {},
  moveOriginNear: () => false,
  rebaseMeshes() {},
  setOrigin() {},
  auditPrecision: () => ({})
};

// Each road's OSM class (js/surfaces.js): plain data, which a stub of surfaces.js gets unless it says otherwise
const ROAD_CLASSES = ['', 'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'link', 'pedestrian'];
const ROAD_CLASS_STUB = { ROAD_CLASSES, ROAD_CLASS: Object.fromEntries(ROAD_CLASSES.map((name, i) => [name, i])), roadClass: (flags) => (flags >> 1) & 15, linkById: new Map() };

function loadModule(source, { imports = {}, globals = {}, filename = 'module.js' } = {}) {
  const exported = [];
  const names = (list) => list.split(',').map((name) => name.trim()).filter(Boolean).map((name) => {
    const match = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(name);
    if (!match) throw new Error(`Unsupported module binding: ${name}`);
    return [match[1], match[2] || match[1]];
  });
  let code = source.replace(/^import\s+(\*[\s\S]*?|\{[\s\S]*?\})\s+from\s+(['"])([^'"\n]+)\2\s*;/gm, (_declaration, bindings, _quote, specifier) => {
    // Nearly everything writes from the origin: with no stub, it's at zero and never moves
    if (specifier === './world-origin.js' && !Object.hasOwn(imports, specifier)) imports[specifier] = WORLD_ORIGIN;
    // Where the map's files are has no imports of its own: the real one
    if (specifier === './tiles/paths.js' && !Object.hasOwn(imports, specifier)) {
      imports[specifier] = loadModule(require('node:fs').readFileSync(require('node:path').join(__dirname, '../../js/tiles/paths.js'), 'utf8'));
    }
    if (specifier === './surfaces.js' && Object.hasOwn(imports, specifier)) imports[specifier] = { ...ROAD_CLASS_STUB, ...imports[specifier] };
    // Who lives where (js/places.js): nowhere, so traffic and people do what they did before the map had it
    if (specifier === './places.js' && !Object.hasOwn(imports, specifier)) imports[specifier] = { busyAt: () => null, placesNear: () => ({ known: 0 }), placeAt: () => null, eachPlaceCell() {}, placeVersion: () => 0 };
    if (!Object.hasOwn(imports, specifier)) throw new Error(`Missing import stub: ${specifier}`);
    const namespace = /^\*\s+as\s+([\w$]+)$/.exec(bindings.trim());
    const target = `imports[${JSON.stringify(specifier)}]`;
    if (namespace) return `const ${namespace[1]} = ${target};`;
    const fields = names(bindings.slice(1, -1)).map(([name, local]) => `${name}: ${local}`);
    return `const { ${fields.join(', ')} } = ${target};`;
  });
  code = code.replace(/^export\s*\{([^}]+)\}\s*;/gm, (_declaration, bindings) => {
    exported.push(...names(bindings));
    return '';
  });
  code = code.replace(/^export\s+(const|let|var|function|class)\s+([\w$]+)/gm, (_declaration, kind, name) => {
    exported.push([name, name]);
    return `${kind} ${name}`;
  });
  if (/^\s*(?:import|export)\b/m.test(code)) throw new Error(`Unsupported module syntax in ${filename}`);
  const properties = exported.map(([local, name]) => `${JSON.stringify(name)}: ${local}`).join(', ');
  const evaluate = vm.runInNewContext(`(function (imports) { 'use strict';\n${code}\nreturn { ${properties} };\n})`, globals, { filename });
  return evaluate(imports);
}

module.exports = { loadModule };
