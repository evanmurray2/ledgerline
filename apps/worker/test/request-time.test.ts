// The clock is an input (docs/privacy.md 5.3): a request has one time, read once, and its routes take the time from
// the request, never from the clock. So the same edit can be run again at the same moment, on the server or the phone.
import { describe, expect, it } from 'vitest';
import { clock } from '../src/http/clock.js';
import { bankSync, plaidTxn } from './bank-sync.js';

// Vite reads the files at build time. Its types for `glob` are not in this package's tsconfig.
// @ts-expect-error import.meta.glob is Vite's
const globbed: unknown = import.meta.glob('../src/routes/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const sources = globbed as Record<string, string>;

describe('the time of a request', () => {
  it('no budget route reads the clock itself', () => {
    // The routes that run only on the server, beside the Directory (sign-in, sign-up, people) or with Plaid.
    const serverOnly = /\/routes\/(auth|signup|people|security)\.ts$/;
    const found: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      if (serverOnly.test(file)) continue;
      text.split('\n').forEach((line, i) => {
        if (/\bDate\.now\(\)|\bclock\(c\.env\)|\bnew Date\(\)/.test(line)) found.push(`${file}:${i + 1}`);
      });
    }
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    expect(found).toEqual([]);
  });

  it('a caller that gives the time is believed first, also where the real clock would be used', () => {
    const t = Date.parse('2026-03-04T05:06:07.008Z');
    expect(clock({ NOW: t, PLAID_ENV: 'production' })).toBe(t);
    expect(clock({ NOW: t, PLAID_ENV: 'engine', FAKE_NOW: '2020-01-01T00:00:00Z' })).toBe(t);
    // Not a number: ignored (a variable set by mistake would be text).
    const before = Date.now();
    const got = clock({ NOW: 'soon' as unknown as number, PLAID_ENV: 'production' });
    expect(got).toBeGreaterThanOrEqual(before);
  });
});

describe('the engine runs a request at the time it is given', () => {
  const START = Date.parse('2026-11-14T20:00:00Z');
  const { db, setup, sync, keyOf, call, setNow } = bankSync('request-time', 'b_rt', 'con_rt', 1, START);

  it('everything one edit writes carries that one time', async () => {
    await setup();
    await sync([plaidTxn('t1', 1, 12.5, '2026-11-12', 'CAFE')]);
    const key = await keyOf('t1');
    const at = START + 3 * 3600_000 + 123;
    setNow(at);
    const r = await call('PATCH', `/api/transactions/${encodeURIComponent(key)}`, { categoryId: 'dining' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const overlay = await db
      .prepare(`SELECT updated_at FROM txn_overlay WHERE txn_key = ?1`)
      .bind(key)
      .first<{ updated_at: number }>();
    expect(overlay!.updated_at).toBe(at);
    const audit = await db
      .prepare(`SELECT created_at FROM audit_log ORDER BY id DESC LIMIT 1`)
      .first<{ created_at: number }>();
    expect(audit!.created_at).toBe(at);
  });
});
