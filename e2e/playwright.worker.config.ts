import { defineConfig } from '@playwright/test';
import { failureReport } from './report';

// The SPA served by the real Worker on local `wrangler dev`, with a local store seeded with the canonical November
// fixture before each test (DEV_ROUTES) and "today" pinned to Nov 14, 2026 (FAKE_NOW). Build apps/web first.
const report = failureReport('worker');
const PORT = Number(process.env.E2E_PORT ?? 8799);

export default defineConfig({
  testDir: './tests',
  testMatch: /worker\.spec\.ts/,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: report.reporter,
  outputDir: report.outputDir,
  use: { baseURL: `http://127.0.0.1:${PORT}`, colorScheme: 'light', ...report.use },
  projects: [
    {
      name: 'phone',
      use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, hasTouch: true },
    },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command:
      `cd ../apps/worker && rm -rf .wrangler/e2e && ` +
      `pnpm exec wrangler dev --port ${PORT} --persist-to .wrangler/e2e --var PLAID_ENV:sandbox --var DEV_ROUTES:1 --var DEV_AUTH_EMAIL:owner@example.com ` +
      `--var FAKE_NOW:2026-11-14T20:00:00Z --var TOKEN_KEYS:1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8= --var TOKEN_KEY_CURRENT:1`,
    url: `http://127.0.0.1:${PORT}/api/session`,
    stdout: 'pipe',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
