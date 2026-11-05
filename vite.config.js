import { execSync } from 'node:child_process';
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
  build: {
    target: 'esnext', // the geodata modules use top-level await
    chunkSizeWarningLimit: 6000
  }
});
