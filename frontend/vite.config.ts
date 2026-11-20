import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

/**
 * Offline support needs two facts from the build:
 *  1. the list of every built script and stylesheet (`/precache.json`), so the service worker can keep ALL of the app's screens on
 *     the device, not only the ones already visited (every screen except sign-in, dashboard and POS is a separate file);
 *  2. a build id stamped into `sw.js`: a browser only installs a new service worker when the file's bytes change, and the
 *     precache list must be refreshed on every release.
 */
function offlinePrecache(): Plugin {
  let outDir = '';
  return {
    name: 'offline-precache',
    apply: 'build',
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir); },
    closeBundle() {
      const assets = path.join(outDir, 'assets');
      if (!existsSync(assets)) return;
      const files = readdirSync(assets).filter((f) => /\.(js|css)$/.test(f)).sort().map((f) => `/assets/${f}`);
      writeFileSync(path.join(outDir, 'precache.json'), JSON.stringify(files));
      const swPath = path.join(outDir, 'sw.js');
      if (existsSync(swPath)) {
        const id = createHash('sha1').update(files.join('|')).digest('hex').slice(0, 10);
        writeFileSync(swPath, readFileSync(swPath, 'utf8').replace('__BUILD_ID__', id));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), offlinePrecache()],
  build: { outDir: '../dist/frontend', emptyOutDir: true },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
