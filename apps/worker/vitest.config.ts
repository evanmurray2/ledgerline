import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Integration tests run inside workerd (Miniflare) with a local D1 built from the real migrations.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    new URL('../../packages/db/migrations', import.meta.url).pathname,
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            PLAID_CLIENT_ID: 'test-client',
            PLAID_SECRET: 'test-secret',
            PLAID_BASE_URL: 'http://plaid.test',
            TOKEN_KEYS: '1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
            TOKEN_KEY_CURRENT: '1',
            DEV_AUTH_EMAIL: 'owner@example.com',
          },
        },
      }),
    ],
    test: { include: ['test/**/*.test.ts'], setupFiles: ['./test/setup.ts'] },
  };
});
