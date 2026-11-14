import { defineConfig } from '@playwright/test';
import { failureReport } from './report';
import { checkServer } from './check-server';
import { suiteFiles } from './suites';
import { workerServer } from './worker-server';

// Open sign-up and recovery codes through the real Worker with the switch on (D-75), which production doesn't have
// yet: Cloudflare's Turnstile test keys, which pass with no network call. Chromium's virtual
// authenticator stands in for Face ID / Touch ID. WebAuthn needs a host name, not an IP, so this uses localhost.
// Build apps/web first.
const report = failureReport('signup');
// E2E_PORT: run several copies side by side (each its own wrangler dev).
const PORT = Number(process.env.E2E_PORT ?? 8799);
// Sign-up's robot check on its own address (check-server.ts).
const check = checkServer(PORT);

export default defineConfig({
  testDir: './tests',
  testMatch: suiteFiles('signup'),
  workers: 1,
  timeout: 45_000,
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
      store: 'e2e-signup',
      vars: { SIGNUPS: 'open', MAX_USERS: 5 },
      extra: check.appVars,
    }),
  ],
});
