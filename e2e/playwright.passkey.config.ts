import { defineConfig } from '@playwright/test';
import { failureReport } from './report';

// Passkey sign-in through the real Worker, with no dev sign-in bypass (decisions.md D-27). Chromium's virtual
// authenticator stands in for Face ID / Touch ID. WebAuthn needs a host name, not an IP, so this uses localhost.
// Build apps/web first.
const report = failureReport('passkey');
const PORT = 8798;

export default defineConfig({
  testDir: './tests',
  testMatch: /passkey\.spec\.ts/,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: report.reporter,
  outputDir: report.outputDir,
  use: { baseURL: `http://localhost:${PORT}`, colorScheme: 'light', ...report.use },
  projects: [{ name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } }],
  webServer: {
    command:
      `cd ../apps/worker && rm -rf .wrangler/e2e-passkey && ` +
      `pnpm exec wrangler dev --port ${PORT} --persist-to .wrangler/e2e-passkey --var PLAID_ENV:sandbox ` +
      `--var SETUP_CODE:e2e-setup-code-0123456789abcdefghijklmnop --var DEV_AUTH_EMAIL: --var DEV_ROUTES:0 ` +
      `--var FAKE_NOW:2026-11-14T20:00:00Z --var TOKEN_KEYS:1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8= --var TOKEN_KEY_CURRENT:1`,
    url: `http://localhost:${PORT}/api/auth/status`,
    stdout: 'pipe',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
