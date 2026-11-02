import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// index.html shows this as v.ab12. Slice the full hash: --short=4 grows when four characters are ambiguous.
function commitPrefix() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).slice(0, 4);
  } catch {
    return 'dev';
  }
}
process.env.VITE_APP_VERSION = commitPrefix();

// The offline build runs second and adds dist/sydney.html beside the site, with everything inlined.
const offlineFile = {
  name: 'offline-file',
  enforce: 'post',
  transformIndexHtml: {
    order: 'pre',
    // Preloading an inlined file would embed it twice, and a manifest can't load from file://
    handler: (html) => html
      .replace(/^\s*<link rel="(?:preload|manifest)"[^\n]*\n/gm, '')
      .replace('<html lang="en">', '<html lang="en" data-offline>')
  },
  generateBundle(_options, bundle) {
    bundle['index.html'].fileName = 'sydney.html';
  }
};

// The offline file holds today's whole map inside itself, as there's nowhere to fetch tiles from (js/geodata.js)
function offlineTiles(offline) {
  const id = 'virtual:offline-tiles';
  return {
    name: 'offline-tiles',
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load(source) {
      if (source !== `\0${id}`) return null;
      if (!offline) return 'export default null;';
      const dir = new URL('./public/tiles/', import.meta.url);
      const files = Object.fromEntries(readdirSync(dir).map((name) => {
        const bytes = readFileSync(new URL(name, dir));
        return [name, `data:application/octet-stream;base64,${bytes.toString('base64')}`];
      }));
      return `export default ${JSON.stringify(files)};`;
    }
  };
}

export default defineConfig(({ mode }) => {
  const offline = mode === 'offline';
  return {
    base: './',
    plugins: offline ? [viteSingleFile(), offlineFile, offlineTiles(true)] : [offlineTiles(false)],
    build: {
      target: 'esnext', // the geodata modules use top-level await
      chunkSizeWarningLimit: 6000,
      ...(offline && { emptyOutDir: false, assetsInlineLimit: 100_000_000, copyPublicDir: false })
    }
  };
});
