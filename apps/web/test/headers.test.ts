// The web app's Content-Security-Policy (public/_headers) stays exactly this strict (docs/phone-budget.md 13.5). It
// can't stop a script that is already running from sending data out (navigation isn't covered), so its job is to
// keep foreign scripts from running at all; any loosening has to change this test on purpose.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const csp = (() => {
  const line = readFileSync(resolve(__dirname, '../public/_headers'), 'utf8')
    .split('\n')
    .find((l) => l.trim().startsWith('Content-Security-Policy:'))!;
  return new Map(
    line
      .split(':')
      .slice(1)
      .join(':')
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((p) => p[0])
      .map(([k, ...v]) => [k!, v.join(' ')]),
  );
})();

describe('Content-Security-Policy', () => {
  it.each([
    ['default-src', "'self'"],
    ['script-src', "'self' 'wasm-unsafe-eval' https://cdn.plaid.com"],
    ['worker-src', "'self'"],
    ['connect-src', "'self' https://production.plaid.com https://sandbox.plaid.com"],
    ['frame-src', 'https://cdn.plaid.com'],
    ['img-src', "'self' data: blob:"],
    ['style-src', "'self' 'unsafe-inline'"],
    ['font-src', "'self'"],
    ['form-action', "'self'"],
    ['object-src', "'none'"],
    ['base-uri', "'none'"],
    ['frame-ancestors', "'none'"],
  ])('%s is %s', (k, v) => expect(csp.get(k)).toBe(v));

  it('has no other directives', () => expect(csp.size).toBe(12));
});
