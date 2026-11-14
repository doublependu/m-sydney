// js/house-styles.js for the CommonJS tests: it imports nothing, so its own source runs as it is
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('./module.cjs');

module.exports = loadModule(readFileSync(join(__dirname, '../../js/house-styles.js'), 'utf8'));
