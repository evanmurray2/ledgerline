import { defineConfig } from '@playwright/test';
import { failureReport } from './report';

// Passkey sign-in through the real Worker, with no dev sign-in bypass (decisions.md D-27). Chromium's virtual
// authenticator stands in for Face ID / Touch ID. WebAuthn needs a host name, not an IP, so this uses localhost.
// Build apps/web first.
const report = failureReport('passkey');
// E2E_PORT: run several copies side by side (each its own wrangler dev).
const PORT = Number(process.env.E2E_PORT ?? 8798);
// The server's clock stands still at the time the run starts. Every budget is locked (D-102), and a device doesn't
// take a server clock more than a day off its own (apps/worker/src/local/web-entry.ts), so the pinned time is today.
const NOW = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

export default defineConfig({
  testDir: './tests',
  testMatch: /passkey\.spec\.ts/,
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
      `cd ../apps/worker && rm -rf .wrangler/e2e-passkey && ` +
      `pnpm exec wrangler dev --port ${PORT} --persist-to .wrangler/e2e-passkey --var PLAID_ENV:sandbox ` +
      `--var SETUP_CODE:e2e-setup-code-0123456789abcdefghijklmnop --var DEV_AUTH_EMAIL: ` +
      `--var FAKE_NOW:${NOW} --var TOKEN_KEYS:1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8= --var TOKEN_KEY_CURRENT:1`,
    url: `http://localhost:${PORT}/api/auth/status`,
    stdout: 'pipe',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
