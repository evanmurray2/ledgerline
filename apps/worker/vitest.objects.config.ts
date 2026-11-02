import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Routing tests after the move (docs/multi-user.md 5.1): the Directory and BudgetStore read their settings from
// these bindings, not from a test's env overrides, so they run as production does: no dev sign-in, a setup code.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    new URL('../../packages/db/migrations', import.meta.url).pathname,
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.local.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            PLAID_ENV: 'sandbox',
            PLAID_CLIENT_ID: 'test-client',
            PLAID_SECRET: 'test-secret',
            PLAID_BASE_URL: 'http://plaid.test',
            TOKEN_KEYS: '1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
            TOKEN_KEY_CURRENT: '1',
            SETUP_CODE: 's'.repeat(40),
            FAKE_NOW: '2026-11-14T20:00:00Z',
            MEASURE: '0',
          },
        },
      }),
    ],
    // The move tests copy and verify whole budgets: give them room when the machine is busy (pnpm check runs
    // everything side by side).
    test: { include: ['test/objects/**/*.test.ts'], setupFiles: ['./test/setup.ts'], testTimeout: 60_000 },
  };
});
