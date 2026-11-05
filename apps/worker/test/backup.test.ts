// The full backup (docs/multi-user.md 8.7): downloaded in pieces through the API, it holds every row of the budget;
// restored into an empty database, every table's row count and fingerprint match; a changed line is caught; and a
// database that already holds a budget refuses a restore.
import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import type { BudgetStore } from '../src/store/budget-store.js';
import { budgetFilter, chain, narrowMeta, readChunk, tableMeta } from '../src/store/dump.js';
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
    for (const t of ['bank_txn', 'category', 'assignment', 'txn_overlay', 'payee'])
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

  it('a backup from before migration 0006 still restores: rows of the dropped tables are skipped', async () => {
    const text = await download();
    const lines = text.split('\n');
    const old = [
      lines[0]!,
      JSON.stringify({ t: 'budget_line', r: { budget_id: 'x', txn_key: 'k', line: '0', amount: 1 } }),
      JSON.stringify({
        t: 'month_snapshot',
        r: { budget_id: 'x', month: '2026-11', state: '{}', hash: 'h' },
      }),
      ...lines.slice(1),
    ].join('\n');
    const fresh = e.BUDGET.get(e.BUDGET.idFromName('restore-old'));
    expect(await fresh.restoreDump(old)).toMatchObject({ ok: true });
    expect(await fresh.restoreVerify()).toEqual({ ok: true, differences: [] });
  });

  it('a backup from before migration 0007 restores with the new columns at their defaults, and verifies', async () => {
    // A store from before 0007 had no payee.named_by, bank_txn.plaid_name, manual_pending.covers_provider_txn_id
    // or not_same, and fingerprinted only the columns it had. Rebuild such a file from today's download.
    const added: Record<string, string[]> = {
      payee: ['named_by'],
      bank_txn: ['plaid_name'],
      manual_pending: ['covers_provider_txn_id'],
    };
    const lines = (await download()).split('\n');
    const budgetId = (JSON.parse(lines[0]!) as { budgetId: string }).budgetId;
    const footerAt = lines.findIndex((l) => l.startsWith('{"end"'));
    const footer = JSON.parse(lines[footerAt]!) as {
      end: true;
      tables: Record<string, { count: number; hash: string }>;
    };
    delete footer.tables.not_same;
    for (const [t, gone] of Object.entries(added)) {
      const meta = await tableMeta(db, t);
      const old = narrowMeta(
        meta,
        meta.cols.filter((c) => !gone.includes(c)),
      );
      let hash = '';
      let count = 0;
      let cursor: unknown[] | null = null;
      do {
        const c = await readChunk(db, t, old, budgetFilter(t, budgetId), cursor);
        count += c.rows.length;
        hash = c.rows.length ? await chain(hash, c.text) : hash;
        cursor = c.cursor;
      } while (cursor);
      footer.tables[t] = { count, hash };
    }
    expect(footer.tables.payee!.count).toBeGreaterThan(0);
    const old = lines
      .filter((l, i) => i !== footerAt && !l.startsWith('{"t":"not_same"'))
      .map((l) => {
        if (!l.startsWith('{"t":')) return l;
        const o = JSON.parse(l) as { t: string; r: Record<string, unknown> };
        const gone = added[o.t] ?? [];
        return JSON.stringify({
          t: o.t,
          r: Object.fromEntries(Object.entries(o.r).filter(([c]) => !gone.includes(c))),
        });
      });
    old.push(JSON.stringify(footer));
    const fresh = e.BUDGET.get(e.BUDGET.idFromName('restore-before-0007'));
    expect(await fresh.restoreDump(old.join('\n'))).toMatchObject({ ok: true });
    expect(await fresh.restoreVerify()).toEqual({ ok: true, differences: [] });
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

  it('a piece that fails partway writes nothing, so it can be sent again', async () => {
    const text = await download();
    const lines = text.split('\n');
    const dup = lines.find((l) => l.includes('"t":"category"'))!;
    // The same row twice breaks its primary key near the end of the piece.
    const broken = [...lines.slice(0, -1), dup, lines.at(-1)!].join('\n');
    const fresh = e.BUDGET.get(e.BUDGET.idFromName('restore-retry'));
    expect(await fresh.restoreDump(broken)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/nothing from this piece was written/),
    });
    expect(await fresh.restoreDump(text)).toMatchObject({ ok: true });
    expect(await fresh.restoreVerify()).toEqual({ ok: true, differences: [] });
  });
});
