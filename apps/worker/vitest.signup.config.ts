import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Open sign-up and recovery codes (D-75, docs/open-signup.md) with the switch on, which production never has yet:
// Cloudflare's Turnstile test keys (always pass, no network), four accounts at most and three sign-ups a day (the owner's setup counts).
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
          SIGNUPS: 'open',
          MAX_USERS: '4',
          SIGNUPS_PER_DAY: '3',
          TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
          TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
        },
      },
    }),
  ],
  test: { include: ['test/signup/**/*.test.ts'], setupFiles: ['./test/setup.ts'], testTimeout: 60_000 },
}));
