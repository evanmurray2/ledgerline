import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Text that follows the iPhone's Text Size setting. Screens set text in px (`text-[15px]`); this PostCSS step,
// run on the CSS Tailwind writes, turns each `font-size: Npx` into `calc(N * var(--ll-u))`. --ll-u is 1px
// everywhere except iPhone and iPad Safari, where styles.css works it out from the system's body text size
// (17 px at the standard setting, so 1px there too). Spacing and touch targets keep their sizes.
const textScale = {
  postcssPlugin: 'll-text-scale',
  Declaration: {
    'font-size': (decl: { value: string }) => {
      const m = /^(\d+(?:\.\d+)?)px$/.exec(decl.value.trim());
      if (!m) return;
      const n = Number(m[1]);
      // 16 px and up never drops below 16 px: iPhone Safari zooms into a text box with smaller text.
      decl.value = n >= 16 ? `max(${n}px, calc(${n} * var(--ll-u)))` : `calc(${n} * var(--ll-u))`;
    },
  },
};

// The Worker serves dist/ as static assets with an SPA fallback. In dev, /api is proxied to `wrangler dev`
// unless VITE_MOCK=1, which serves every endpoint from src/mock (that code never reaches a production build).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Each build gets its own id: data saved on the phone by an older build is discarded (src/state/saved.ts).
  // The release the app was built as: the deploy sets APP_VERSION to the commit, as it does for the Worker; a
  // Home Screen app that sees the server on another release reloads (src/state/version.ts).
  define: {
    __BUILD_ID__: JSON.stringify(String(Date.now())),
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? 'dev'),
  },
  css: { postcss: { plugins: [textScale] } },
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
