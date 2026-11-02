// The full backup (docs/multi-user.md 8.7): downloaded in pieces through the API, it holds every row of the budget;
// restored into an empty database, every table's row count and fingerprint match; a changed line is caught; and a
// database that already holds a budget refuses a restore.
import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import type { BudgetStore } from '../src/store/budget-store.js';
import { ownerDb } from './store-db.js';

const e = env as unknown as { BUDGET: DurableObjectNamespace<BudgetStore> };
const db = ownerDb();
const ORIGIN = 'https://ledgerline.test';
const call = async (method: string, path: string) => {
  const r = await worker.fetch(
    new Request(ORIGIN + path, {
      method,
      headers:
        method === 'GET'
          ? { origin: ORIGIN }
          : { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' },
      body: method === 'GET' ? undefined : '{}',
    }),
    env as never,
    createExecutionContext(),
  );
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};

async function download(): Promise<string> {
  const parts: string[] = [];
  let cursor: string | null = null;
  let requests = 0;
  do {
    const r = await call('GET', `/api/export/dump${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(r.status).toBe(200);
    parts.push(String(r.json.data));
    cursor = r.json.cursor as string | null;
    requests++;
  } while (cursor);
  expect(requests).toBeGreaterThan(30); // one piece per table at least: small requests
  return parts.filter(Boolean).join('\n');
}

describe('full backup', () => {
  it('holds every row, and restores into an empty database with matching fingerprints', async () => {
    await call('POST', '/__dev/seed-november');
    const text = await download();
    const lines = text.split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ format: 'ledgerline-dump', version: 1 });
    const footer = lines.at(-1) as { end: boolean; tables: Record<string, { count: number }> };
    expect(footer.end).toBe(true);
    for (const t of ['bank_txn', 'category', 'assignment', 'budget_line', 'month_snapshot'])
      expect(footer.tables[t]!.count, t).toBe(
        Number(await db.prepare(`SELECT count(*) AS n FROM ${t}`).first('n')),
      );
    const fresh = e.BUDGET.get(e.BUDGET.idFromName('restore-ok'));
    expect(await fresh.restoreDump(text)).toMatchObject({ ok: true });
    expect(await fresh.restoreVerify()).toEqual({ ok: true, differences: [] });
    // A database that already holds a budget refuses.
    expect(await fresh.restoreDump(text)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/refused/),
    });
  });

  it('a changed line is caught by the fingerprints', async () => {
    const text = await download();
    const tampered = text.replace(
      /("t":"assignment","r":\{[^}]*"amount":)(\d+)/,
      (_m, a: string, n: string) => `${a}${Number(n) + 1}`,
    );
    expect(tampered).not.toBe(text);
    const fresh = e.BUDGET.get(e.BUDGET.idFromName('restore-tampered'));
    expect(await fresh.restoreDump(tampered)).toMatchObject({ ok: true });
    const v = await fresh.restoreVerify();
    expect(v.ok).toBe(false);
    expect(v.differences.join(' ')).toContain('assignment');
  });
});
