import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The Worker serves dist/ as static assets with an SPA fallback. In dev, /api is proxied to `wrangler dev`
// unless VITE_MOCK=1, which serves every endpoint from src/mock (that code never reaches a production build).
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
  // Each build gets its own id: data saved on the phone by an older build is discarded (src/state/saved.ts).
  // The release the app was built as: the deploy sets APP_VERSION to the commit, as it does for the Worker; a
  // Home Screen app that sees the server on another release reloads (src/state/version.ts).
  define: {
    __BUILD_ID__: JSON.stringify(String(Date.now())),
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? 'dev'),
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
