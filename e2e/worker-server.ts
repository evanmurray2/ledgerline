// The real Worker under `wrangler dev` for the real-Worker e2e configs (passkey, signup, lock, bank): one command,
// so the configs differ only in what they add. Each run starts from an empty store in its own folder.

/** The e2e Worker's token key, as `TOKEN_KEYS` takes it after the key's number. Never a production key. */
const TOKEN_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

/**
 * The time the server's clock stands still at: when the run starts. Every budget is locked (D-102), and a device
 * that has no older sync to measure the server's clock by doesn't take one more than a day off its own
 * (apps/worker/src/local/web-entry.ts), so the pinned time must be today.
 */
export const fakeNow = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

export function workerServer(o: {
  port: number;
  /** The folder under apps/worker/.wrangler that keeps this suite's store. */
  store: string;
  /** The number of the run key `TOKEN_KEYS` holds: 9 for the bank suite (build:e2e), else 1 as production. */
  keyNumber?: number;
  /** More `--var NAME:value` for this suite; an empty value sets an empty string. */
  vars?: Record<string, string | number>;
  /** More arguments as they are (checkServer's appVars). */
  extra?: string;
}) {
  const key = o.keyNumber ?? 1;
  const vars: Record<string, string | number> = {
    PLAID_ENV: 'sandbox',
    SETUP_CODE: 'e2e-setup-code-0123456789abcdefghijklmnop',
    DEV_AUTH_EMAIL: '',
    FAKE_NOW: fakeNow(),
    TOKEN_KEYS: `${key}:${TOKEN_KEY}`,
    TOKEN_KEY_CURRENT: key,
    ...o.vars,
  };
  const flags = Object.entries(vars)
    .map(([k, v]) => `--var ${k}:${v}`)
    .join(' ');
  return {
    command:
      `cd ../apps/worker && rm -rf .wrangler/${o.store} && ` +
      `pnpm exec wrangler dev --port ${o.port} --persist-to .wrangler/${o.store} ${flags}` +
      (o.extra ? ` ${o.extra}` : ''),
    url: `http://localhost:${o.port}/api/auth/status`,
    stdout: 'pipe' as const,
    reuseExistingServer: false,
    timeout: 120_000,
  };
}
