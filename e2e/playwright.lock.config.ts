import { defineConfig } from '@playwright/test';
import { failureReport } from './report';
import { checkServer } from './check-server';
import { suiteFiles } from './suites';
import { workerServer } from './worker-server';

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

export default defineConfig({
  testDir: './tests',
  testMatch: suiteFiles('lock'),
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
    // The server's clock stands still at the time the run starts (worker-server.ts).
    workerServer({
      port: PORT,
      store: 'e2e-lock',
      vars: { SIGNUPS: 'open', MAX_USERS: 10 },
      extra: check.appVars,
    }),
  ],
});
