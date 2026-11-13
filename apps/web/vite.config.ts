import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// The Worker serves dist/ as static assets with an SPA fallback. In dev, /api is proxied to `wrangler dev`
// unless VITE_MOCK=1, which serves every endpoint from src/mock (that code never reaches a production build).
// The e2e Worker's run-signing keys (src/keys/worker-keys.ts), for an e2e build only (build:e2e). Never in a release:
// the deploy builds with APP_VERSION set.
const e2eRunKeys = process.env.E2E_RUN_KEYS ?? '';
if (e2eRunKeys && process.env.APP_VERSION)
  throw new Error('E2E_RUN_KEYS is for e2e builds only, never with APP_VERSION (a release)');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The mock API's November copy (src/mock): the phone's real engine, in the browser or in Node for the tests. Kept
  // behind these names so the web app's type check doesn't read the Worker's code (src/mock/november.d.ts).
  resolve: {
    alias: {
      '#november-browser': fileURLToPath(new URL('../worker/src/local/november-browser.ts', import.meta.url)),
      '#november-node': fileURLToPath(new URL('../worker/src/local/november-copy.ts', import.meta.url)),
    },
  },
  // The release the app was built as: the deploy sets APP_VERSION to the commit, as it does for the Worker; a
  // Home Screen app that sees the server on another release reloads (src/state/version.ts). Each release has its
  // own id: data saved on the phone by an older one is discarded (src/state/saved.ts).
  // Nothing here may change between two builds of one commit (no clock, no random value, no path of this
  // computer): the build is reproducible, and tools/ci/reproducible-check.mjs fails if it isn't (docs/privacy.md 5.9).
  define: {
    __BUILD_ID__: JSON.stringify(process.env.APP_VERSION ?? 'dev'),
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? 'dev'),
    __WEB_VERSION__: JSON.stringify(pkg.version),
    __E2E_RUN_KEYS__: JSON.stringify(e2eRunKeys),
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 800 },
  // The phone's engine (D-45) runs in a module Web Worker with code split from the app.
  worker: { format: 'es' },
  server: {
    port: 5173,
    strictPort: true,
    proxy: process.env.VITE_MOCK === '1' ? undefined : { '/api': 'http://127.0.0.1:8787' },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
    env: { VITE_MOCK: '1' },
    css: false,
  },
});
