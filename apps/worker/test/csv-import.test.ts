// CSV history import (routes/ops.ts): every format a bank's export comes in, and what happens to the file's rows.
import { app } from './phone.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerDb } from './store-db.js';
import { csvAmount, csvDate, csvRecords } from '../src/ledger/csv.js';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const send = async (method: string, p: string, body: unknown) => {
  const r = await app(p, { method, headers: H, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const imp = (csv: string, accountId = 'marcus') => send('POST', '/api/import/csv', { accountId, csv });
const db = ownerDb();
const history = async () =>
  (
    await db
      .prepare(
        `SELECT date, amount, raw_name FROM bank_txn WHERE provider_txn_id LIKE 'csv_%' ORDER BY date, amount`,
      )
      .all<{ date: string; amount: number; raw_name: string }>()
  ).results;

describe('CSV import', () => {
  beforeEach(async () => {
    expect((await send('POST', '/__dev/seed-november', {})).status).toBe(200);
  });

  it('reads a file that starts with a byte order mark', async () => {
    const r = await imp('﻿date,payee,amount\r\n2026-10-02,Old Bakery,-12.34\r\n');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.imported).toBe(1);
  });

  it('importing the same file again adds nothing and says so', async () => {
    const csv = 'date,payee,amount\n2026-10-02,Old Bakery,-12.34\n2026-10-01,Corner Shop,-3.00\n';
    expect((await imp(csv)).json.imported).toBe(2);
    const again = await imp(csv);
    expect(again.json.imported).toBe(0);
    expect(await history()).toHaveLength(2);
  });

  it('a second file with a different row on the same line and date keeps both', async () => {
    expect((await imp('date,payee,amount\n2026-10-02,Old Bakery,-12.34\n')).json.imported).toBe(1);
    expect((await imp('date,payee,amount\n2026-10-02,Gas Station,-40.00\n')).json.imported).toBe(1);
    expect((await history()).map((h) => h.raw_name).sort()).toEqual(['Gas Station', 'Old Bakery']);
  });

  it('counts what it skipped: already imported, in the budget, and lines it couldn’t read', async () => {
    const r = await imp(
      'date,payee,amount\n2026-10-02,Old Bakery,-12.34\n2026-02-30,Bad Date,-1.00\n2026-10-01,Bad Amount,abc\n2026-11-03,In Budget,-2.00\n',
    );
    expect(r.json).toMatchObject({ imported: 1, skipped: 1, unreadable: 2, duplicates: 0 });
    expect((await imp('date,payee,amount\n2026-10-02,Old Bakery,-12.34\n')).json).toMatchObject({
      imported: 0,
      duplicates: 1,
    });
  });

  it('keeps two identical purchases on the same day, once each', async () => {
    const csv = 'date,payee,amount\n2026-10-02,Coffee,-4.00\n2026-10-02,Coffee,-4.00\n';
    expect((await imp(csv)).json.imported).toBe(2);
    expect((await imp(csv)).json).toMatchObject({ imported: 0, duplicates: 2 });
    expect(await history()).toHaveLength(2);
  });

  it('reads quoted headers and cells with commas, quotes and line breaks', async () => {
    const csv =
      '"Date","Description","Amount","Memo"\r\n' +
      '"10/02/2026","Smith, Jones ""Law""","-1,234.56","line one\r\nline two"\r\n' +
      '"10/01/2026","Corner Shop","(3.00)",""\r\n';
    const r = await imp(csv);
    expect(r.json).toMatchObject({ imported: 2, unreadable: 0 });
    expect(await history()).toEqual([
      { date: '2026-10-01', amount: -300, raw_name: 'Corner Shop' },
      { date: '2026-10-02', amount: -123_456, raw_name: 'Smith, Jones "Law"' },
    ]);
  });

  it('reads a semicolon file with European amounts and day-first dates', async () => {
    const r = await imp(
      'Datum;Date;Payee;Amount\nx;02.10.2026;Bäckerei Müller;-1.234,56\nx;01.10.2026;Kiosk;-3,5\n',
    );
    expect(r.json).toMatchObject({ imported: 2, unreadable: 0 });
    expect(await history()).toEqual([
      { date: '2026-10-01', amount: -350, raw_name: 'Kiosk' },
      { date: '2026-10-02', amount: -123_456, raw_name: 'Bäckerei Müller' },
    ]);
  });

  it('reads Debit and Credit columns instead of one amount', async () => {
    const r = await imp(
      'Account: Everyday\n\nPosted Date,Description,Debit,Credit\n10/02/2026,Grocer,12.34,\n10/01/2026,Refund,,5.00\n09/30/2026,Nothing,,\n',
    );
    expect(r.json).toMatchObject({ imported: 2, unreadable: 1 });
    expect(await history()).toEqual([
      { date: '2026-10-01', amount: 500, raw_name: 'Refund' },
      { date: '2026-10-02', amount: -1234, raw_name: 'Grocer' },
    ]);
  });

  it('refuses a file with only a header, or none, with a sentence to act on', async () => {
    expect((await imp('date,payee,amount\n')).json).toMatchObject({ imported: 0, unreadable: 0 });
    const none = await imp('');
    expect(none.status).toBe(422);
    expect(
      String((none.json as { error?: { message?: string } }).error?.message ?? JSON.stringify(none.json)),
    ).toMatch(/needs date, payee and amount/);
  });

  it('an import never shows as a bank that hasn’t synced', async () => {
    expect((await imp('date,payee,amount\n2026-10-02,Old Bakery,-12.34\n')).status).toBe(200);
    const h = await send('GET', '/api/health', undefined);
    const conns = (h.json as { connections: { id: string }[] }).connections;
    const csv = await db.prepare(`SELECT id FROM connection WHERE provider = 'csv'`).first<{ id: string }>();
    expect(conns.map((c) => c.id)).not.toContain(csv!.id);
  });
});

describe('CSV cells', () => {
  it('reads dates in the common styles and refuses impossible ones', () => {
    for (const [i, o] of [
      ['2026-11-02', '2026-11-02'],
      ['2026-11-02T10:00:00Z', '2026-11-02'],
      ['2026-11-02 10:00', '2026-11-02'],
      ['2026/11/02', '2026-11-02'],
      ['11/2/2026', '2026-11-02'],
      ['11-02-2026', '2026-11-02'],
      ['11/2/26', '2026-11-02'],
      ['2.11.2026', '2026-11-02'],
      ['Nov 2, 2026', '2026-11-02'],
      ['November 2 2026', '2026-11-02'],
      ['2 Nov 2026', '2026-11-02'],
      ['02-Nov-26', '2026-11-02'],
      ['Sept 30, 2026', '2026-09-30'],
      ['2/29/2028', '2028-02-29'],
    ])
      expect(csvDate(i!), i).toBe(o);
    for (const i of ['2026-02-30', '2/29/2026', '25/12/2025', '2026-13-01', 'Foo 2, 2026', '', 'yesterday'])
      expect(csvDate(i), i).toBeNull();
  });

  it('reads amounts in US and European styles', () => {
    for (const [i, d, o] of [
      ['-12.34', ',', -1234],
      ['$1,234.56', ',', 123_456],
      ['(12.00)', ',', -1200],
      ['-12,50', ',', -1250],
      ['1.234,56', ',', 123_456],
      ['1,234', ',', 123_400],
      ['1.234', ';', 123_400],
      ['−$18.25', ',', -1825],
    ] as const)
      expect(csvAmount(i, d), i).toBe(o);
    for (const i of ['', 'abc', '1.234.5', '12.345']) expect(csvAmount(i, ','), i).toBeNull();
  });

  it('splits records on commas, semicolons or tabs, whichever the header uses', () => {
    expect(csvRecords('a\tb\n1\t2').records).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(csvRecords('a;b;c,d\n1;2;3,4').records).toEqual([
      ['a', 'b', 'c,d'],
      ['1', '2', '3,4'],
    ]);
    expect(csvRecords('\ufeffa,b\r\n\r\n,\r\n1,"x\ny"').records).toEqual([
      ['a', 'b'],
      ['1', 'x\ny'],
    ]);
  });
});

// Last: the syncs it starts keep running, and the November seed can't start over under them.
describe('CSV import and syncing', () => {
  beforeEach(async () => {
    expect((await send('POST', '/__dev/seed-november', {})).status).toBe(200);
  });

  it('a pull-to-refresh starts no sync for an import', async () => {
    const reset = async () => {
      await db
        .prepare(
          `UPDATE connection SET sync_lock = NULL, lock_expires = NULL, last_synced_at = 0, last_attempt_at = 0`,
        )
        .run();
      await db.prepare(`DELETE FROM job WHERE kind = 'sync'`).run();
    };
    await reset();
    const plain = await send('POST', '/api/settings/connections/refresh', {});
    expect((await imp('date,payee,amount\n2026-10-02,Old Bakery,-12.34\n')).status).toBe(200);
    await reset();
    const after = await send('POST', '/api/settings/connections/refresh', {});
    expect(after.json.started).toBe(plain.json.started);
  });
});
