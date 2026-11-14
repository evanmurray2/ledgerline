import { defineConfig } from '@playwright/test';
import { failureReport } from './report';
import { suiteFiles } from './suites';
import { workerServer } from './worker-server';

// Passkey sign-in through the real Worker, with no dev sign-in bypass (decisions.md D-27). Chromium's virtual
// authenticator stands in for Face ID / Touch ID. WebAuthn needs a host name, not an IP, so this uses localhost.
// Build apps/web first.
const report = failureReport('passkey');
// E2E_PORT: run several copies side by side (each its own wrangler dev).
const PORT = Number(process.env.E2E_PORT ?? 8798);

export default defineConfig({
  testDir: './tests',
  testMatch: suiteFiles('passkey'),
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: report.reporter,
  retries: report.retries,
  outputDir: report.outputDir,
  use: { baseURL: `http://localhost:${PORT}`, colorScheme: 'light', ...report.use },
  projects: [{ name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } }],
  // The server's clock stands still at the time the run starts (worker-server.ts).
  webServer: workerServer({ port: PORT, store: 'e2e-passkey' }),
});
