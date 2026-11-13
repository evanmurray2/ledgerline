// Every edit a device makes, run as a twin (test/twin.ts): the same edit, with the same id and time, gives the same
// rows on two devices, and the rows the first recorded give them on a third, as a log entry does.
import { beforeAll, describe, expect, it } from 'vitest';
import type { LocalEngine } from '../src/local/engine.js';
import { budgetApi } from '../src/routes/api.js';
import { everythingAgain, syncPhone } from './phone.js';
import { differences, newPhone, rowsOf, twin } from './twin.js';
import { twinCases, type TwinEnv } from './twin-cases.js';

describe('the same edit on two devices', () => {
  let a: LocalEngine;
  let b: LocalEngine;
  /** Takes only the rows the first phone records for each edit (twin.ts). */
  let c: LocalEngine;
  let spending: string[];
  let txn: string;
  let payee: string;
  let budget: string;
  /** Set-up data a case needs: written on every copy, as a bank entry would, then worked out again. */
  const onServer =
    (sql: string, ...values: unknown[]) =>
    async () => {
      for (const e of [a, b, c]) {
        await e.db
          .prepare(sql)
          .bind(...values)
          .run();
        await everythingAgain(e);
      }
    };
  const month = '2026-11';

  beforeAll(async () => {
    a = await syncPhone(await newPhone());
    budget = (await a.db.prepare(`SELECT id FROM budget`).first<{ id: string }>())!.id;
    b = await syncPhone(await newPhone());
    c = await syncPhone(await newPhone());
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

  it('two copies start equal', async () => {
    expect(differences(await rowsOf(a), await rowsOf(b))).toEqual([]);
  });

  const env: TwinEnv = {
    get a() {
      return a;
    },
    get spending() {
      return spending;
    },
    get txn() {
      return txn;
    },
    get payee() {
      return payee;
    },
    get budget() {
      return budget;
    },
    month,
    onServer,
    ids: (table) => ids(table),
    named: (table, name) => named(table, name),
  };
  const cases = twinCases(env);

  const ids = async (table: string) =>
    (await a.db.prepare(`SELECT id FROM ${table} ORDER BY id`).all<{ id: string }>()).results.map(
      (r) => r.id,
    );
  const named = async (table: string, name: string) =>
    (await a.db.prepare(`SELECT id FROM ${table} WHERE name = ?1`).bind(name).first<{ id: string }>())!.id;

  for (const [name, , make, prepare] of cases)
    it(name, async () => {
      if (prepare) {
        await prepare();
        await syncPhone(a);
        await syncPhone(b);
        await syncPhone(c);
        expect(differences(await rowsOf(a), await rowsOf(b))).toEqual([]);
      }
      const [method, path, body] = await make();
      const t = await twin(a, b, method, path, body, c);
      expect(t.phone.status, await t.phone.clone().text()).toBeLessThan(300);
      expect(t.recorded).toBeGreaterThan(0);
      expect(t.differences).toEqual([]);
      // Worked out again, nothing changes.
      await syncPhone(a);
      expect(differences(await rowsOf(a), await rowsOf(b))).toEqual([]);
    });

  // Undo reads the record of the join (audit_log), which is not synced: each side wrote its own when it ran the
  // join, under the same id (the edit's), so the undo finds it on both.
  it('join two payees, then undo', async () => {
    const two = (
      await a.db
        .prepare(`SELECT id FROM payee WHERE merged_into IS NULL AND id != ?1 ORDER BY id LIMIT 2`)
        .bind(payee)
        .all<{ id: string }>()
    ).results.map((r) => r.id);
    const joined = await twin(a, b, 'POST', '/api/settings/payees/merge', { ids: two, keep: two[0] }, c);
    expect(joined.phone.status, await joined.phone.clone().text()).toBe(200);
    expect(joined.differences).toEqual([]);
    const onPhone = (await joined.phone.json()) as { undoId: string };
    const onServer = (await joined.server.json()) as { undoId: string };
    expect(onPhone.undoId).toBe(onServer.undoId);
    await syncPhone(a);
    const undone = await twin(a, b, 'POST', `/api/settings/payees/merge/${onPhone.undoId}/undo`, {}, c);
    expect(undone.phone.status, await undone.phone.clone().text()).toBe(200);
    expect(undone.differences).toEqual([]);
    const back = await a.db
      .prepare(`SELECT count(*) AS n FROM payee WHERE id IN (?1, ?2) AND merged_into IS NULL`)
      .bind(two[0], two[1])
      .first<{ n: number }>();
    expect(back!.n).toBe(2);
    await syncPhone(a);
  });

  it('both devices refuse a balance edit worked out before the newest change', async () => {
    const stale = (await a.state()).through - 1;
    const t = await twin(a, b, 'POST', `/api/settings/categories/${spending[8]}/archive`, {
      archived: true,
      available: 500,
      through: stale,
    });
    expect(t.phone.status).toBe(409);
    expect(t.recorded).toBe(0);
    expect(t.differences).toEqual([]);
  });

  it('the Yes answer moved a key, on the phone and on the copy that took its rows', async () => {
    for (const e of [a, c]) {
      const moved = await e.db.prepare(`SELECT count(*) AS n FROM txn_key_move`).first<{ n: number }>();
      expect(moved!.n).toBeGreaterThan(0);
    }
  });

  it('the check sees an edit that only one side has', async () => {
    const r = await a.request('POST', '/api/budget/set', { month, categoryId: spending[6], assigned: 77 });
    expect(r.status).toBe(200);
    const d = differences(await rowsOf(a), await rowsOf(b));
    expect(d.length).toBeGreaterThan(0);
    expect(d.join('\n')).toContain('assignment');
  });

  // Every edit the API has is in one list: checked as a twin here, or not checked yet.
  it('no edit route is missing from the lists', () => {
    const routes = new Set<string>();
    for (const r of budgetApi.routes)
      if (!['GET', 'HEAD', 'ALL'].includes(r.method)) routes.add(`${r.method} ${r.path}`);
    const listed = new Set([...cases.map(([, route]) => route), ...OTHER_TWINS, ...Object.keys(NOT_YET)]);
    expect([...routes].filter((r) => !listed.has(r)).sort()).toEqual([]);
    expect([...listed].filter((r) => !routes.has(r)).sort()).toEqual([]);
    const twinned = new Set([...cases.map(([, route]) => route), ...OTHER_TWINS]);
    expect(Object.keys(NOT_YET).filter((r) => twinned.has(r))).toEqual([]);
  });
});

/** Twins with their own test above (more than one request). */
const OTHER_TWINS = ['POST /settings/payees/merge', 'POST /settings/payees/merge/:undoId/undo'];

/** Not checked as a twin yet (docs/build-plan.md). This list only gets shorter. */
const NOT_YET: Record<string, string> = {};
