// Hunt two-devices (docs/hunts.md): a model-based test of two devices that edit one sealed budget. fast-check picks
// a list of steps: edits on either device, sends and reads of the log, offline spells (steps that don't sync), an
// answer lost after the server stored the entry, a read cut halfway, and an app closed and opened again (its place
// in the log restored from what it kept, which may be older than the log when it closed mid-write). At the end both
// devices sync until nothing waits, and a third device reads the whole log. All three copies must hold the same
// rows, the log must hold each edit once (or the device said it was lost), and both must show the same money.
import { encodeEntry, startChain } from '@ledgerline/seal';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DeviceLog } from '../src/local/device-log.js';
import type { LocalEngine } from '../src/local/engine.js';
import { LogSession, type LogTransport } from '../src/local/log-session.js';
import { logAfter, logAppend } from '../src/seal/log-store.js';
import { BUDGET, PHONE, T0 } from './log-writer.js';
import { deviceNow, syncPhone } from './phone.js';
import { world, type World } from './sealed-world.js';
import { differences, newPhone, rowsOf } from './twin.js';

const LAPTOP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';
const TABLET = '01DX5ZZKBKACTAV9WEVGEMMVRZ';
const MONTH = '2026-11';
const SCREENS = [
  `/api/budget/${MONTH}`,
  '/api/activity',
  '/api/accounts',
  `/api/reports?month=${MONTH}`,
  '/api/owed',
];

type Dev = 0 | 1;
/** What the devices do between syncs. Edits name categories and bank rows by index (`Ctx`). */
type Sync =
  | { t: 'flush'; d: Dev }
  | { t: 'pull'; d: Dev }
  | { t: 'lostAnswer'; d: Dev }
  | { t: 'cutPull'; d: Dev; keep: number }
  | { t: 'reopen'; d: Dev };
type Edit =
  | { t: 'assign'; d: Dev; cat: number; amount: number }
  | { t: 'move'; d: Dev; from: number; to: number; amount: number }
  | { t: 'set'; d: Dev; cat: number; amount: number }
  | { t: 'categorize'; d: Dev; txn: number; cat: number }
  | { t: 'memo'; d: Dev; txn: number; memo: string }
  | { t: 'split'; d: Dev; txn: number; cat: number; other: number }
  | { t: 'archive'; d: Dev; cat: number }
  | { t: 'restore'; d: Dev; cat: number }
  | { t: 'entry'; d: Dev; cat: number; amount: number }
  | { t: 'unentry'; d: Dev };
type Step = Sync | Edit;

/** Categories 0-3 get only additive edits (assign, move) in the first property, so their sums are known. */
const ADDITIVE = 4;
const CATS = 6;
const TXNS = 3;

const dev = fc.constantFrom<Dev>(0, 1);
const cents = fc.integer({ min: 1, max: 50_000 });
const syncs: fc.WeightedArbitrary<Sync>[] = [
  { weight: 3, arbitrary: fc.record({ t: fc.constant('flush' as const), d: dev }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('pull' as const), d: dev }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('lostAnswer' as const), d: dev }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('cutPull' as const), d: dev, keep: fc.nat(3) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('reopen' as const), d: dev }) },
];
const w = <T>(weight: number, arbitrary: fc.Arbitrary<T>) => ({ weight, arbitrary });
const assign = (cats: number) =>
  fc.record({ t: fc.constant('assign' as const), d: dev, cat: fc.nat(cats - 1), amount: cents });
const move = fc
  .record({
    t: fc.constant('move' as const),
    d: dev,
    from: fc.nat(ADDITIVE - 1),
    to: fc.nat(ADDITIVE - 1),
    amount: cents,
  })
  .filter((s) => s.from !== s.to);
const categorize = fc.record({
  t: fc.constant('categorize' as const),
  d: dev,
  txn: fc.nat(TXNS - 1),
  cat: fc.nat(CATS - 1),
});
const memo = fc.record({
  t: fc.constant('memo' as const),
  d: dev,
  txn: fc.nat(TXNS - 1),
  memo: fc.constantFrom('a', 'b', 'c'),
});

/** Edits that never conflict in a way that loses one: each must reach the log. */
const calm: fc.Arbitrary<Step> = fc.oneof(
  w(3, assign(ADDITIVE)),
  w(2, move),
  w(
    2,
    fc.record({
      t: fc.constant('set' as const),
      d: dev,
      cat: fc.integer({ min: ADDITIVE, max: CATS - 1 }),
      amount: cents,
    }),
  ),
  w(2, categorize),
  w(1, memo),
  ...syncs,
);

/** Edits that may conflict: archive and restore (the archive checks `through`), entries, splits. */
const rough: fc.Arbitrary<Step> = fc.oneof(
  w(3, assign(CATS)),
  w(2, categorize),
  w(1, memo),
  w(
    2,
    fc
      .record({
        t: fc.constant('split' as const),
        d: dev,
        txn: fc.nat(TXNS - 1),
        cat: fc.nat(CATS - 1),
        other: fc.nat(CATS - 1),
      })
      .filter((s) => s.cat !== s.other),
  ),
  w(
    2,
    fc.record({
      t: fc.constant('archive' as const),
      d: dev,
      cat: fc.integer({ min: ADDITIVE, max: CATS - 1 }),
    }),
  ),
  w(
    1,
    fc.record({
      t: fc.constant('restore' as const),
      d: dev,
      cat: fc.integer({ min: ADDITIVE, max: CATS - 1 }),
    }),
  ),
  w(2, fc.record({ t: fc.constant('entry' as const), d: dev, cat: fc.nat(CATS - 1), amount: cents })),
  w(1, fc.record({ t: fc.constant('unentry' as const), d: dev })),
  ...syncs,
);

interface Device {
  id: string;
  engine: LocalEngine;
  log: DeviceLog;
  session: LogSession;
}

interface Outcome {
  devices: [Device, Device];
  third: Device;
  /** Edits the devices took (status < 300). */
  edits: number;
  /** Edits the devices said were lost. */
  lost: number;
  cats: string[];
  start: number[];
  assigned: (e: LocalEngine, cat: string) => Promise<number>;
}

async function runSteps(x: World, steps: Step[]): Promise<Outcome> {
  let clock = T0 + 10_000;
  const now = () => clock;
  const log: LogTransport = {
    after: async (n) => (await logAfter(x.db, n, 100)).map((e) => e.bytes),
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
  const open = async (id: string): Promise<Device> => {
    const engine = await syncPhone(await newPhone());
    await engine.applyLogRows([], 1);
    const dl = new DeviceLog(
      x.w.keys,
      await startChain(x.w.last!, { now: clock, schemaVersion: 1 }, BUDGET),
      id,
      now,
    );
    return { id, engine, log: dl, session: new LogSession(engine, dl, log, encodeEntry) };
  };
  const devices: [Device, Device] = [await open(PHONE), await open(LAPTOP)];
  const first = devices[0].engine;
  const cats = (
    await first.db
      .prepare(`SELECT id FROM category WHERE kind = 'spending' AND archived_at IS NULL ORDER BY id LIMIT ?1`)
      .bind(CATS)
      .all<{ id: string }>()
  ).results.map((r) => r.id);
  expect(cats).toHaveLength(CATS);
  const txns = (
    await first.db
      .prepare(
        `SELECT txn_key FROM bank_txn WHERE removed_at IS NULL AND pending = 0 AND amount < -200 ORDER BY txn_key LIMIT ?1`,
      )
      .bind(TXNS)
      .all<{ txn_key: string; amount: number }>()
  ).results.map((r) => r.txn_key);
  expect(txns).toHaveLength(TXNS);
  const account = (await first.db
    .prepare(`SELECT id FROM account ORDER BY id LIMIT 1`)
    .first<{ id: string }>())!.id;
  const assigned = async (e: LocalEngine, cat: string) =>
    (
      await e.db
        .prepare(`SELECT amount FROM assignment WHERE month = ?1 AND category_id = ?2`)
        .bind(MONTH, cat)
        .first<{ amount: number }>()
    )?.amount ?? 0;
  const start = await Promise.all(cats.map((c) => assigned(first, c)));
  let edits = 0;
  let lost = 0;
  /** A send threw: edits it lost on the way (run again on newer entries) are not counted (docs/build-plan.md). */
  let threw = false;
  let n = 0;
  const edit = async (d: Device, method: string, path: string, body: unknown, refusable = false) => {
    const r = await d.engine.enqueue({
      id: `two-${++n}-${d.id.slice(0, 6)}-xxxxxx`,
      at: deviceNow(),
      method,
      path,
      body,
    });
    if (refusable && r.response.status >= 400 && r.response.status < 500) return;
    // New money or spending for a category this device shows as archived is refused (routes/api.ts ARCHIVED).
    if (
      r.response.status === 422 &&
      ((await r.response.clone().json()) as { error?: string }).error === 'archived'
    )
      return;
    expect(r.response.status, `${method} ${path}: ${await r.response.clone().text()}`).toBeLessThan(300);
    edits++;
  };
  const amountOf = async (e: LocalEngine, key: string) =>
    (await e.db
      .prepare(`SELECT amount FROM bank_txn WHERE txn_key = ?1`)
      .bind(key)
      .first<{ amount: number }>())!.amount;

  for (const s of steps) {
    clock += 1000;
    const d = devices[s.d];
    switch (s.t) {
      case 'assign':
        await edit(d, 'POST', '/api/budget/assign', {
          month: MONTH,
          items: [{ categoryId: cats[s.cat], amount: s.amount }],
        });
        break;
      case 'move':
        await edit(d, 'POST', '/api/budget/move', {
          month: MONTH,
          from: cats[s.from],
          to: cats[s.to],
          amount: s.amount,
        });
        break;
      case 'set':
        await edit(d, 'POST', '/api/budget/set', {
          month: MONTH,
          categoryId: cats[s.cat],
          assigned: s.amount,
        });
        break;
      case 'categorize':
        await edit(d, 'PATCH', `/api/transactions/${encodeURIComponent(txns[s.txn]!)}`, {
          categoryId: cats[s.cat],
        });
        break;
      case 'memo':
        await edit(d, 'PATCH', `/api/transactions/${encodeURIComponent(txns[s.txn]!)}`, { memo: s.memo });
        break;
      case 'split': {
        const amount = await amountOf(d.engine, txns[s.txn]!);
        const half = Math.trunc(amount / 2);
        await edit(d, 'PATCH', `/api/transactions/${encodeURIComponent(txns[s.txn]!)}`, {
          split: [
            { categoryId: cats[s.cat], amount: half, memo: null, absorbsRemainder: false },
            { categoryId: cats[s.other], amount: amount - half, memo: null, absorbsRemainder: true },
          ],
        });
        break;
      }
      case 'archive': {
        // As the app does it (apps/web/src/copy/shown.ts): the available this device shows, and its change number.
        const sheet = await d.engine.request('GET', `/api/categories/${cats[s.cat]}/sheet`);
        if (sheet.status !== 200) break;
        const { available } = (await sheet.json()) as { available: number };
        await edit(
          d,
          'POST',
          `/api/settings/categories/${cats[s.cat]}/archive`,
          { archived: true, available, through: (await d.engine.state()).through },
          true,
        );
        break;
      }
      case 'restore':
        await edit(d, 'POST', `/api/settings/categories/${cats[s.cat]}/archive`, { archived: false }, true);
        break;
      case 'entry':
        await edit(d, 'POST', '/api/transactions', {
          kind: 'pending',
          accountId: account,
          date: '2026-11-10',
          amount: -s.amount,
          payee: 'Two devices cafe',
          categoryId: cats[s.cat],
          repeats: 'never',
        });
        break;
      case 'unentry': {
        const e = await d.engine.db
          .prepare(
            `SELECT txn_key FROM manual_pending WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
          )
          .first<{ txn_key: string }>();
        if (e) await edit(d, 'DELETE', `/api/transactions/${encodeURIComponent(e.txn_key)}`, undefined, true);
        break;
      }
      case 'flush':
        lost += (await d.session.flush()).lost;
        break;
      case 'pull':
        lost += (await d.session.pull()).lost;
        break;
      case 'lostAnswer': {
        // The server stores the first entry sent; its answer never comes back.
        let drop = true;
        const lossy = new LogSession(
          d.engine,
          d.log,
          {
            after: log.after,
            append: async (base, entries) => {
              const r = await log.append(base, entries);
              if (drop && r.ok) {
                drop = false;
                throw new Error('the connection dropped');
              }
              return r;
            },
          },
          encodeEntry,
        );
        try {
          lost += (await lossy.flush()).lost;
        } catch (e) {
          expect(String(e)).toContain('the connection dropped');
          threw = true;
        }
        break;
      }
      case 'cutPull': {
        // The read stops after `keep` entries.
        const cut = new LogSession(
          d.engine,
          d.log,
          { after: async (k) => (await log.after(k)).slice(0, s.keep), append: log.append },
          encodeEntry,
        );
        lost += (await cut.pull()).lost;
        break;
      }
      case 'reopen': {
        // The app is closed and opened: its place in the log is what it kept with its copy.
        const kept = await d.engine.noted(LogSession.PLACE);
        if (!kept) break; // nothing sent or read yet: its place is still the start
        d.log = await DeviceLog.restore(x.w.keys, kept, d.id, now);
        d.session = new LogSession(d.engine, d.log, log, encodeEntry);
        break;
      }
    }
  }

  // Both come back online and sync until nothing waits.
  for (let round = 0; round < 6; round++) {
    for (const d of devices) {
      clock += 1000;
      lost += (await d.session.flush()).lost;
      lost += (await d.session.pull()).lost;
    }
    if (!(await devices[0].engine.queue()).length && !(await devices[1].engine.queue()).length) break;
  }
  for (const d of devices) lost += (await d.session.pull()).lost;
  const third = await open(TABLET);
  await third.session.pull();

  for (const d of devices) expect(await d.engine.queue(), `${d.id} queue`).toEqual([]);
  const [a, b] = devices.map((d) => d.engine) as [LocalEngine, LocalEngine];
  expect(devices[1].log.number).toBe(devices[0].log.number);
  expect(third.log.number).toBe(devices[0].log.number);
  // Each edit is in the log once, or its device said it was lost.
  // Each edit is in the log once, or its device said it was lost. A send that threw drops its count of lost edits,
  // so then the log may hold fewer (never more).
  const entries = devices[0].log.number - 1;
  if (threw) expect(entries, 'entries in the log').toBeLessThanOrEqual(edits - lost);
  else expect(entries, 'entries in the log').toBe(edits - lost);
  expect(differences(await rowsOf(a), await rowsOf(b)), 'phone and laptop').toEqual([]);
  expect(differences(await rowsOf(a), await rowsOf(third.engine)), 'phone and a fresh device').toEqual([]);
  expect((await b.rta()).rta).toBe((await a.rta()).rta);
  expect((await third.engine.rta()).rta).toBe((await a.rta()).rta);
  return { devices, third, edits, lost, cats, start, assigned };
}

/** The changes to each additive category the edits made: assign and move only. */
function sums(steps: Step[]): number[] {
  const delta = Array<number>(ADDITIVE).fill(0);
  for (const s of steps)
    if (s.t === 'assign') delta[s.cat]! += s.amount;
    else if (s.t === 'move') {
      delta[s.from]! -= s.amount;
      delta[s.to]! += s.amount;
    }
  return delta;
}

describe('two devices edit one budget, with offline spells, lost answers, cut reads and restarts', () => {
  it('edits that never conflict: none is lost, and each category holds the sum of its edits', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(calm, { minLength: 4, maxLength: 24 }), async (steps) => {
        await world(
          async (x) => {
            const o = await runSteps(x, steps);
            expect(o.lost, 'edits lost').toBe(0);
            const delta = sums(steps);
            for (let i = 0; i < ADDITIVE; i++)
              expect(await o.assigned(o.devices[0].engine, o.cats[i]!), `category ${i}`).toBe(
                o.start[i]! + delta[i]!,
              );
          },
          { described: false },
        );
      }),
      { numRuns: 10 },
    );
  }, 300_000);

  it('edits that may conflict (archive, restore, entries, splits): every copy ends the same', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(rough, { minLength: 4, maxLength: 24 }), async (steps) => {
        await world(
          async (x) => {
            const o = await runSteps(x, steps);
            // An archived category takes no new money or spending, even from an edit made offline on the other
            // device that lands after the archive (D-121), so it is never overspent (D-79). It may hold money:
            // moving a purchase out of it frees what that purchase spent.
            const a = o.devices[0].engine;
            for (const cat of o.cats) {
              const row = await a.db
                .prepare(`SELECT archived_at FROM category WHERE id = ?1`)
                .bind(cat)
                .first<{ archived_at: number | null }>();
              if (row?.archived_at == null) continue;
              const sheet = await a.request('GET', `/api/categories/${cat}/sheet`);
              expect(sheet.status).toBe(200);
              expect(
                ((await sheet.json()) as { available: number }).available,
                `archived ${cat}`,
              ).toBeGreaterThanOrEqual(0);
            }
            // Every screen reads the same on all three: what each copy worked out from its rows.
            for (const path of SCREENS) {
              const [a, b, c] = await Promise.all(
                [o.devices[0].engine, o.devices[1].engine, o.third.engine].map(async (e) => {
                  const r = await e.request('GET', path);
                  expect(r.status, path).toBe(200);
                  return r.json();
                }),
              );
              expect(b, `laptop ${path}`).toEqual(a);
              expect(c, `fresh device ${path}`).toEqual(a);
            }
          },
          { described: false },
        );
      }),
      { numRuns: 10 },
    );
  }, 300_000);
});
