import { defineConfig } from '@playwright/test';
import { failureReport } from './report';

// A linked bank of a locked budget through the real Worker and a real browser (banks.spec.ts): the owner links a bank
// on a fake Plaid (fake-plaid.mjs, behind PLAID_BASE_URL, with dummy Plaid keys), the Worker fetches and seals its
// first run, and the device files it. Never a real Plaid link (CLAUDE.md). The device accepts a run only when a key
// it was built with signed it, so the app is built with this Worker's run key: `pnpm --filter @ledgerline/web
// build:e2e` first (TOKEN_KEYS below; apps/web/src/keys/worker-keys.ts). Passkeys as in playwright.lock.config.ts.
const report = failureReport('bank');
// E2E_PORT: run several copies side by side (each its own wrangler dev and fake Plaid).
const PORT = Number(process.env.E2E_PORT ?? 8797);
const PLAID_PORT = PORT + 100;
// The server's clock stands still at the time the run starts, as in playwright.lock.config.ts: it must be today.
const NOW = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

export default defineConfig({
  testDir: './tests',
  testMatch: /banks\.spec\.ts/,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 10_000 },
  reporter: report.reporter,
  retries: report.retries,
  outputDir: report.outputDir,
  use: { baseURL: `http://localhost:${PORT}`, colorScheme: 'light', ...report.use },
  projects: [{ name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } }],
  webServer: [
    {
      command: `node fake-plaid.mjs ${PLAID_PORT}`,
      url: `http://localhost:${PLAID_PORT}/health`,
      stdout: 'pipe',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // Key number 9 is the e2e Worker's run key (build:e2e); production's is 1.
      command:
        `cd ../apps/worker && rm -rf .wrangler/e2e-bank && ` +
        `pnpm exec wrangler dev --port ${PORT} --persist-to .wrangler/e2e-bank --var PLAID_ENV:sandbox ` +
        `--var PLAID_BASE_URL:http://localhost:${PLAID_PORT} --var PLAID_CLIENT_ID:e2e-client ` +
        `--var PLAID_SECRET:e2e-secret ` +
        `--var SETUP_CODE:e2e-setup-code-0123456789abcdefghijklmnop --var DEV_AUTH_EMAIL: ` +
        `--var FAKE_NOW:${NOW} --var TOKEN_KEYS:9:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8= --var TOKEN_KEY_CURRENT:9`,
      url: `http://localhost:${PORT}/api/auth/status`,
      stdout: 'pipe',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
