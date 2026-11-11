import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Integration tests run inside workerd (Miniflare) with the production config: the Directory and one BudgetStore
// per budget, each migrating its own SQLite. Local sign-in is the dev user (DEV_AUTH_EMAIL).
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
          DEV_AUTH_EMAIL: 'owner@example.com',
          DEV_ROUTES: '1',
          HOSTED_LINK: '1',
          FAKE_NOW: '2026-11-14T20:00:00Z',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/objects/**', 'test/signup/**'],
    setupFiles: ['./test/setup.ts'],
  },
}));
