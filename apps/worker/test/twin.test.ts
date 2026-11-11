// Every edit the phone may make offline, run as a twin (test/twin.ts): the phone's rows equal the server's.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LocalEngine } from '../src/local/engine.js';
import { syncPhone } from './phone.js';
import { differences, newPhone, rowsOf, twin } from './twin.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };

describe('the same edit on the phone and on the server', () => {
  let a: LocalEngine;
  let b: LocalEngine;
  let spending: string[];
  let txn: string;
  let payee: string;
  const month = '2026-11';

  beforeAll(async () => {
    const r = await SELF.fetch(`${ORIGIN}/__dev/seed-november`, { method: 'POST', headers: H, body: '{}' });
    expect(r.status).toBe(200);
    a = await syncPhone(await newPhone());
    b = await syncPhone(await newPhone());
    const cats = (await (await a.request('GET', '/api/settings/categories')).json()) as {
      groups: { categories: { id: string; kind: string }[] }[];
    };
    spending = cats.groups
      .flatMap((g) => g.categories)
      .filter((c) => c.kind === 'spending')
      .map((c) => c.id);
    txn = (await a.db
      .prepare(
        `SELECT txn_key FROM bank_txn WHERE removed_at IS NULL AND pending = 0 ORDER BY txn_key LIMIT 1`,
      )
      .first<{ txn_key: string }>())!.txn_key;
    payee = (await a.db.prepare(`SELECT id FROM payee ORDER BY id LIMIT 1`).first<{ id: string }>())!.id;
  });

  it('two synced copies start equal', async () => {
    expect(differences(await rowsOf(a), await rowsOf(b))).toEqual([]);
  });

  const cases: [string, () => [string, string, unknown]][] = [
    [
      'assign',
      () => ['POST', '/api/budget/assign', { month, items: [{ categoryId: spending[0], amount: 1234 }] }],
    ],
    ['set', () => ['POST', '/api/budget/set', { month, categoryId: spending[1], assigned: 4321 }]],
    ['move', () => ['POST', '/api/budget/move', { month, from: spending[0], to: spending[2], amount: 200 }]],
    [
      'a new target',
      () => [
        'PUT',
        `/api/categories/${spending[3]}/target`,
        { categoryId: spending[3], month: '2027-02', target: { type: 'set_aside', amount: 999 } },
      ],
    ],
    ['pin', () => ['POST', `/api/settings/categories/${spending[4]}/pin`, { pinned: true }]],
    ['rename a payee', () => ['POST', `/api/settings/payees/${payee}`, { name: 'Twin named' }]],
    ['categorize', () => ['POST', '/api/transactions/categorize', { keys: [txn], categoryId: spending[5] }]],
    ['a note on a transaction', () => ['PATCH', `/api/transactions/${txn}`, { note: 'twin' }]],
  ];

  for (const [name, make] of cases)
    it(name, async () => {
      const [method, path, body] = make();
      const t = await twin(a, b, method, path, body);
      expect(t.phone.status, await t.phone.clone().text()).toBeLessThan(300);
      expect(t.differences).toEqual([]);
      // The phone that made the edit takes the server's rows next: nothing changes for it.
      await syncPhone(a);
      expect(differences(await rowsOf(a), await rowsOf(b))).toEqual([]);
    });

  it('the check sees an edit that only one side has', async () => {
    const r = await a.request('POST', '/api/budget/set', { month, categoryId: spending[6], assigned: 77 });
    expect(r.status).toBe(200);
    const d = differences(await rowsOf(a), await rowsOf(b));
    expect(d.length).toBeGreaterThan(0);
    expect(d.join('\n')).toContain('assignment');
  });
});
