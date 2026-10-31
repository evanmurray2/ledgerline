import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The Worker serves dist/ as static assets with an SPA fallback. In dev, /api is proxied to `wrangler dev`
// unless VITE_MOCK=1, which serves every endpoint from src/mock (that code never reaches a production build).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 800 },
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
