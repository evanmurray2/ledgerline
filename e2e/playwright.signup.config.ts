import { defineConfig } from '@playwright/test';
import { failureReport } from './report';

// Open sign-up and recovery codes through the real Worker with the switch on (D-75), which production doesn't have
// yet: Cloudflare's Turnstile test keys, which pass with no network call. Chromium's virtual
// authenticator stands in for Face ID / Touch ID. WebAuthn needs a host name, not an IP, so this uses localhost.
// Build apps/web first.
const report = failureReport('signup');
// E2E_PORT: run several copies side by side (each its own wrangler dev).
const PORT = Number(process.env.E2E_PORT ?? 8799);
// The server's clock stands still at the time the run starts. Every budget is locked (D-102), and a device doesn't
// take a server clock more than a day off its own (apps/worker/src/local/web-entry.ts), so the pinned time is today.
const NOW = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

export default defineConfig({
  testDir: './tests',
  testMatch: /signup\.spec\.ts/,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: report.reporter,
  retries: report.retries,
  outputDir: report.outputDir,
  use: { baseURL: `http://localhost:${PORT}`, colorScheme: 'light', ...report.use },
  projects: [{ name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } }],
  webServer: {
    command:
      `cd ../apps/worker && rm -rf .wrangler/e2e-signup && ` +
      `pnpm exec wrangler dev --port ${PORT} --persist-to .wrangler/e2e-signup --var PLAID_ENV:sandbox ` +
      `--var SETUP_CODE:e2e-setup-code-0123456789abcdefghijklmnop --var DEV_AUTH_EMAIL: --var DEV_ROUTES:0 ` +
      `--var FAKE_NOW:${NOW} --var TOKEN_KEYS:1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8= --var TOKEN_KEY_CURRENT:1 --var SIGNUPS:open --var MAX_USERS:5 ` +
      `--var TURNSTILE_SITE_KEY:1x00000000000000000000AA --var TURNSTILE_SECRET:1x0000000000000000000000000000000AA`,
    url: `http://localhost:${PORT}/api/auth/status`,
    stdout: 'pipe',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
