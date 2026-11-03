import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Routing tests after the move (docs/multi-user.md 5.1): the Directory and BudgetStore read their settings from
// these bindings, not from a test's env overrides, so they run as production does: no dev sign-in, a setup code.
export default defineConfig(() => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          PLAID_ENV: 'sandbox',
          PLAID_CLIENT_ID: 'test-client',
          PLAID_SECRET: 'test-secret',
          PLAID_BASE_URL: 'http://plaid.test',
          TOKEN_KEYS: '1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
          TOKEN_KEY_CURRENT: '1',
          SETUP_CODE: 's'.repeat(40),
          OPS_TOKEN: 'o'.repeat(40),
          FAKE_NOW: '2026-11-14T20:00:00Z',
        },
      },
    }),
  ],
  // The move tests copy and verify whole budgets: give them room when the machine is busy (pnpm check runs
  // everything side by side).
  test: { include: ['test/objects/**/*.test.ts'], setupFiles: ['./test/setup.ts'], testTimeout: 60_000 },
}));
