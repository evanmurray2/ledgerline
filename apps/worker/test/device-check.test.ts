// The device check on two devices (D-116; src/local/device-check.ts): each works out the budget by itself from the
// same log. Two copies that agree make the same check; a copy with one number changed is told, on both devices,
// and a later check that agrees clears it. The fingerprint is what the screens show, in one order.
import { encodeEntry, startChain } from '@ledgerline/seal';
import type { AccountsView, BudgetView } from '@ledgerline/contracts';
import { describe, expect, it } from 'vitest';
import { DeviceLog } from '../src/local/device-log.js';
import {
  CHECK_EVERY_MS,
  CHECK_NOTE,
  deviceCheck,
  screenNow,
  screenText,
  type CheckTransport,
} from '../src/local/device-check.js';
import { LogSession, type LogTransport } from '../src/local/log-session.js';
import { deviceChecks, keepDeviceCheck, type DeviceCheckRecord } from '../src/seal/device-checks.js';
import { logAfter, logAppend, logHead } from '../src/seal/log-store.js';
import { BUDGET, PHONE, T0 } from './log-writer.js';
import { everythingAgain, syncPhone } from './phone.js';
import { world } from './sealed-world.js';
import { newPhone } from './twin.js';

const LAPTOP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';

describe('what a device check hashes', () => {
  it('is the screens’ numbers in one order: rows in another order give the same text, a changed number another', async () => {
    const engine = await syncPhone(await newPhone());
    const screen = await screenNow(engine);
    expect(screen).not.toBeNull();
    const b = (await (await engine.request('GET', `/api/budget/${screen!.month}`)).json()) as BudgetView;
    const a = (await (await engine.request('GET', '/api/accounts')).json()) as AccountsView;
    const text = screenText(b, a)!;
    expect(text).toBe(screen!.text);
    expect(text).toContain(`rta ${b.rta}\n`);
    const cat = b.groups.flatMap((g) => g.categories)[0]!;
    expect(text).toContain(`category ${cat.id} ${cat.assigned} ${cat.activity} ${cat.available}\n`);
    const acct = a.groups.flatMap((g) => g.accounts)[0]!;
    expect(text).toContain(`account ${acct.id} ${acct.bank} ${acct.pending} ${acct.working}\n`);

    // Groups, rows and accounts in another order, and another name: the same text.
    const shuffled: BudgetView = {
      ...b,
      groups: [...b.groups].reverse().map((g) => ({
        ...g,
        name: `${g.name}!`,
        categories: [...g.categories].reverse(),
      })),
    };
    const accounts: AccountsView = { ...a, groups: [...a.groups].reverse() };
    expect(screenText(shuffled, accounts)).toBe(text);
    // Any number changed: another text.
    const one = (f: (c: BudgetView['groups'][number]['categories'][number]) => object) => ({
      ...b,
      groups: b.groups.map((g, i) =>
        i === 0 ? { ...g, categories: g.categories.map((c, j) => (j === 0 ? { ...c, ...f(c) } : c)) } : g,
      ),
    });
    for (const changed of [
      screenText({ ...b, rta: b.rta + 1 }, a),
      screenText(
        one((c) => ({ assigned: c.assigned + 1 })),
        a,
      ),
      screenText(
        one((c) => ({ activity: c.activity - 1 })),
        a,
      ),
      screenText(
        one((c) => ({ available: c.available + 1 })),
        a,
      ),
      screenText(b, {
        ...a,
        groups: a.groups.map((g, i) =>
          i === 0
            ? { ...g, accounts: g.accounts.map((x, j) => (j === 0 ? { ...x, bank: x.bank + 1 } : x)) }
            : g,
        ),
      }),
    ])
      expect(changed).not.toBe(text);
    // Not worked out yet: no check.
    expect(screenText({ ...b, rtaUpdating: true }, a)).toBeNull();
  });
});

describe('two devices and their checks', () => {
  it('agree with no alert; a copy with one number changed is told on both; a later agreeing check clears it', async () => {
    await world(
      async (x) => {
        let clock = T0 + 10_000;
        // The server's side, as the routes run it: the log, and the checks handed back with each page.
        let seen: DeviceCheckRecord[] = [];
        const log: LogTransport = {
          after: async (n) => {
            seen = await deviceChecks(x.db);
            return (await logAfter(x.db, n, 100)).map((e) => e.bytes);
          },
          append: (base, entries) =>
            logAppend(
              {
                db: x.db,
                budgetId: BUDGET,
                now: clock,
                resting: false,
                freshWay: false,
                lastCompleteRun: 0,
                receiptHashes: async () => null,
              },
              base,
              entries,
            ),
        };
        const checks: CheckTransport = {
          checks: () => seen,
          sendCheck: async (r) =>
            (await keepDeviceCheck({ db: x.db, now: clock, resting: false, head: await logHead(x.db) }, r))
              .ok,
        };
        const device = async (id: string) => {
          const engine = await syncPhone(await newPhone());
          const dl = new DeviceLog(
            x.w.keys,
            await startChain(x.w.last!, { now: clock, schemaVersion: 1 }, BUDGET),
            id,
            () => clock,
          );
          return { engine, log: dl, session: new LogSession(engine, dl, log, encodeEntry) };
        };
        const a = await device(PHONE);
        const b = await device(LAPTOP);
        let n = 0;
        /** An edit on `d`, sent; then both devices read the log. */
        const assign = async (d: typeof a, amount: number) => {
          clock += 1000;
          const r = await d.engine.enqueue({
            id: `check-edit-${++n}-xxxxxxxx`,
            at: clock,
            method: 'POST',
            path: '/api/budget/assign',
            body: { month: '2026-11', items: [{ categoryId: 'rent', amount }] },
          });
          expect(r.response.status).toBe(200);
          expect(await d.session.flush()).toEqual({ sent: 1, lost: 0 });
          await a.session.pull();
          await b.session.pull();
        };
        /** A round's device check on `d`, some minutes after the last. */
        const check = async (d: typeof a) => {
          clock += 61_000;
          await d.session.pull();
          return deviceCheck({
            engine: d.engine,
            log: d.log,
            transport: checks,
            now: clock + CHECK_EVERY_MS * ++n,
            settled: (await d.engine.queue()).length === 0,
          });
        };

        // ---- the same data: each sends its check, and neither is told
        await assign(a, 100);
        expect(a.log.number).toBe(b.log.number);
        expect(await check(a)).toBeNull();
        expect(await check(b)).toBeNull();
        expect(await check(a)).toBeNull();
        const records = await deviceChecks(x.db);
        expect(records.map((r) => r.deviceId).sort()).toEqual([PHONE, LAPTOP]);
        // Each device's own HMAC is its own: the device id is in it.
        expect(records[0]!.mac).not.toBe(records[1]!.mac);
        expect(new Set(records.map((r) => r.number))).toEqual(new Set([a.log.number]));

        // ---- one row changed on the laptop's copy only (one no entry writes), then one more entry: both are told
        const other = (await b.engine.db
          .prepare(
            `SELECT category_id FROM assignment WHERE month = '2026-11' AND category_id <> 'rent' LIMIT 1`,
          )
          .first<{ category_id: string }>())!.category_id;
        const tamper = (by: number) =>
          b.engine.db
            .prepare(
              `UPDATE assignment SET amount = amount + ?1 WHERE month = '2026-11' AND category_id = ?2`,
            )
            .bind(by, other)
            .run();
        await tamper(1);
        await everythingAgain(b.engine);
        await assign(a, 50);
        expect(await check(a)).toBeNull();
        const toldB = await check(b);
        expect(toldB).toEqual({ deviceId: PHONE, number: b.log.number, month: '2026-11' });
        expect(await check(a)).toEqual({ deviceId: LAPTOP, number: a.log.number, month: '2026-11' });
        // Kept with the copy: the next round still says so, with nothing new to compare.
        expect(await check(b)).toEqual(toldB);

        // ---- put right (as a copy made again would be), and a later check agrees: the alert goes
        await tamper(-1);
        await everythingAgain(b.engine);
        await assign(b, 25);
        expect(await check(b)).toEqual(toldB);
        expect(await check(a)).toBeNull();
        expect(await check(b)).toBeNull();

        // ---- a copy with edits waiting makes no check; a check never changes the budget's tables
        const before = await a.engine.db
          .prepare(`SELECT * FROM assignment ORDER BY category_id, month`)
          .all();
        const kept = await a.engine.noted(CHECK_NOTE);
        clock += 1000;
        await a.engine.enqueue({
          id: `check-edit-${++n}-xxxxxxxx`,
          at: clock,
          method: 'POST',
          path: '/api/budget/assign',
          body: { month: '2026-11', items: [{ categoryId: 'rent', amount: 1 }] },
        });
        const waiting = await a.engine.db
          .prepare(`SELECT * FROM assignment ORDER BY category_id, month`)
          .all();
        expect(
          await deviceCheck({
            engine: a.engine,
            log: a.log,
            transport: checks,
            now: clock + CHECK_EVERY_MS * 1000,
            settled: false,
          }),
        ).toBeNull();
        expect(JSON.parse((await a.engine.noted(CHECK_NOTE))!).mine).toEqual(JSON.parse(kept!).mine);
        expect(
          await a.engine.db.prepare(`SELECT * FROM assignment ORDER BY category_id, month`).all(),
        ).toEqual(waiting);
        expect(waiting).not.toEqual(before);
      },
      { described: false },
    );
  });
});
