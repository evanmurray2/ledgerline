import { defineConfig } from '@playwright/test';

// Runs the SPA with Vite in mock mode (every /api request answered in memory) on phone and desktop sizes.
const PORT = 5179;

export default defineConfig({
  testDir: './tests',
  testIgnore: /worker\.spec\.ts/,
  fullyParallel: true,
  workers: 4,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'off',
    colorScheme: 'light',
  },
  projects: [
    {
      name: 'phone',
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: `pnpm --filter @ledgerline/web exec vite --port ${PORT} --strictPort --host 127.0.0.1`,
    env: { VITE_MOCK: '1' },
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
