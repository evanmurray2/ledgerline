import { defineConfig } from '@playwright/test';
import { failureReport } from './report';

// Moving a budget to its sealed log through the real Worker and a real browser (docs/privacy.md section 8): the
// Worker's CUTOVER variable opens the move for any budget here. Passkeys as in playwright.passkey.config.ts:
// Chromium's virtual authenticator stands in for Face ID, and WebAuthn needs a host name, so this uses localhost.
// Build apps/web first.
const report = failureReport('move');
// E2E_PORT: run several copies side by side (each its own wrangler dev).
const PORT = Number(process.env.E2E_PORT ?? 8799);

export default defineConfig({
  testDir: './tests',
  testMatch: /move\.spec\.ts/,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: report.reporter,
  retries: report.retries,
  outputDir: report.outputDir,
  use: { baseURL: `http://localhost:${PORT}`, colorScheme: 'light', ...report.use },
  projects: [{ name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } }],
  webServer: {
    command:
      `cd ../apps/worker && rm -rf .wrangler/e2e-move && ` +
      `pnpm exec wrangler dev --port ${PORT} --persist-to .wrangler/e2e-move --var PLAID_ENV:sandbox ` +
      `--var SETUP_CODE:e2e-setup-code-0123456789abcdefghijklmnop --var DEV_AUTH_EMAIL: --var DEV_ROUTES:0 ` +
      `--var CUTOVER:any --var FAKE_NOW:2026-11-14T20:00:00Z --var TOKEN_KEYS:1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8= --var TOKEN_KEY_CURRENT:1 --var SIGNUPS:open --var MAX_USERS:5 ` +
      `--var TURNSTILE_SITE_KEY:1x00000000000000000000AA --var TURNSTILE_SECRET:1x0000000000000000000000000000000AA`,
    url: `http://localhost:${PORT}/api/auth/status`,
    stdout: 'pipe',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
