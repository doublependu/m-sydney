import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { defineConfig } from 'vite';

// index.html shows this as v.ab12. Slice the full hash: --short=4 grows when four characters are ambiguous.
function commitPrefix() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).slice(0, 4);
  } catch {
    return 'dev';
  }
}
process.env.VITE_APP_VERSION = commitPrefix();

export default defineConfig({
  base: './',
  // Whether the build has houses' real lots (public/lots/, tools/build-lots.mjs): without them the game asks for none (js/real-lots.js)
  define: { __SYDNEY_LOTS__: JSON.stringify(existsSync(new URL('./public/lots/index.json', import.meta.url))) },
  // recordings/ holds copies of old builds and their tiles (tens of thousands of files, and links back to public/):
  // watching it uses up Linux's inotify watches (ENOSPC), and its old index.html copies would be scanned for deps.
  server: { watch: { ignored: ['**/recordings/**'] } },
  optimizeDeps: { entries: ['index.html'] },
  build: {
    target: 'esnext', // the geodata modules use top-level await
    chunkSizeWarningLimit: 6000
  }
});
