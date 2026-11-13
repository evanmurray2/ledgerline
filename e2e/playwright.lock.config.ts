import { defineConfig } from '@playwright/test';
import { failureReport } from './report';
import { checkServer } from './check-server';

// A new budget, locked from its first moment, through the real Worker and a real browser (D-102): lock.spec.ts,
// then a locked budget's screens (screens-lock.spec.ts), each on its own new account. Passkeys as in
// playwright.passkey.config.ts:
// Chromium's virtual authenticator stands in for Face ID, and WebAuthn needs a host name, so this uses localhost.
// Build apps/web first.
const report = failureReport('lock');
// E2E_PORT: run several copies side by side (each its own wrangler dev).
const PORT = Number(process.env.E2E_PORT ?? 8799);
// Sign-up's robot check on its own address (check-server.ts).
const check = checkServer(PORT);
// The server's clock stands still at the time the run starts. A device that joins the locked budget from a
// snapshot has no older sync to measure the server's clock by, and it doesn't take a clock more than a day off
// its own (apps/worker/src/local/web-entry.ts), so the pinned time must be today.
const NOW = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

export default defineConfig({
  testDir: './tests',
  testMatch: /lock\.spec\.ts/,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: report.reporter,
  retries: report.retries,
  outputDir: report.outputDir,
  use: { baseURL: `http://localhost:${PORT}`, colorScheme: 'light', ...report.use },
  projects: [{ name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } }],
  webServer: [
    check.webServer,
    {
      command:
        `cd ../apps/worker && rm -rf .wrangler/e2e-lock && ` +
        `pnpm exec wrangler dev --port ${PORT} --persist-to .wrangler/e2e-lock --var PLAID_ENV:sandbox ` +
        `--var SETUP_CODE:e2e-setup-code-0123456789abcdefghijklmnop --var DEV_AUTH_EMAIL: ` +
        `--var FAKE_NOW:${NOW} --var TOKEN_KEYS:1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8= --var TOKEN_KEY_CURRENT:1 --var SIGNUPS:open --var MAX_USERS:10 ` +
        check.appVars,
      url: `http://localhost:${PORT}/api/auth/status`,
      stdout: 'pipe',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
