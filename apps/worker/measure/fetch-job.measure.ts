// The sealed fetch job's steps whole (src/seal/fetch-job.ts), one alarm each, on node:sqlite as a Durable Object
// pays them: begin, a page of 100 transactions (about 220 KB, the owner's largest), the last page with the bank's
// balances and card statements (D-110), and sign and store. Each alarm builds its keys again, as the store did
// before Nov 13, 2026, unless `keys` is kept: the store now keeps them while it stays in memory. Times in ms, wall
// time on this thread (harness.ts), with each step's WebCrypto calls, SQL statements and database calls
// (`transactions`: a statement on its own or a batch), which don't vary with the machine's load. Writes .measure/fetch-job.json for docs/measurements.md.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { PlaidProvider, type BankDataProvider } from '@ledgerline/bank-provider';
import { encryptToken, parseKeyring, tokenKeyBytes } from '@ledgerline/platform';
import { encodeEntry, linkMac, serverKeys } from '@ledgerline/seal';
import { NodeDb, applyMigrations } from '../../../packages/db/src/node-db.js';
import { generate, syncBody } from '../../../tools/plaid-mock/data.mjs';
import { sealedFetchHandler, SEALED_FETCH, type FetchState } from '../src/seal/fetch-job.js';
import { logGenesis } from '../src/seal/log-store.js';
import { keyStampStmts, runDeps, workerKeys, type RunDeps } from '../src/seal/runs.js';
import { BUDGET, T0, Writer } from '../test/log-writer.js';
import { stats } from './harness.js';

const RUNS = 30;
const LINK = '01HAAAAAAAAAAAAAAAAAAAAAAA';
const ring = parseKeyring('1:a passphrase of at least thirty-two characters!', '1');
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function storeDb(): NodeDb {
  const d = new NodeDb();
  const read = (dir: string) =>
    readdirSync(new URL(dir, import.meta.url))
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((name) => ({ name, sql: readFileSync(new URL(dir + name, import.meta.url), 'utf8') }));
  for (const m of [
    ...read('../../../packages/db/budget-migrations/'),
    ...read('../../../packages/db/store-migrations/'),
  ])
    applyMigrations(d, [m]);
  return d;
}

/** Pages of 100 transactions; the second page is the last. The bank answers about 3 accounts and 1 card. */
function provider(): BankDataProvider {
  const data = generate(200, 1);
  const bodies = [syncBody(data, 0, 100), syncBody(data, 100, 100)];
  const reader = new PlaidProvider({ clientId: 'c', secret: 's', env: 'sandbox' });
  return {
    fetchSyncPage: async (_c: unknown, cursor: string | null) => {
      const i = cursor === 'c1' ? 1 : 0;
      return { body: new TextEncoder().encode(bodies[i]!), nextCursor: `c${i + 1}`, hasMore: i === 0 };
    },
    parsePage: (b: string) => reader.parsePage(b),
    getAccounts: async () =>
      ['acc_checking', 'acc_savings', 'acc_credit'].map((id, i) => ({
        providerAccountId: id,
        name: id,
        mask: '0000',
        type: i === 2 ? 'credit' : 'depository',
        subtype: null,
        currentBalance: 12_300 + i,
        availableBalance: 12_000 + i,
        creditLimit: i === 2 ? 500_000 : null,
        currency: 'USD',
      })),
    getLiabilities: async () => [
      {
        providerAccountId: 'acc_credit',
        statementBalance: 45_000,
        statementDate: '2026-10-28',
        dueDate: '2026-11-22',
        minimumPayment: 3_500,
        aprBasisPoints: 2399,
      },
    ],
  } as unknown as BankDataProvider;
}

async function setUp(db: NodeDb): Promise<void> {
  const d = runDeps(db, BUDGET, ring);
  const w = new Writer(BUDGET, T0);
  await logGenesis(
    {
      db,
      budgetId: BUDGET,
      now: T0 + 2000,
      resting: false,
      freshWay: false,
      lastCompleteRun: 0,
      receiptHashes: async () => null,
      stamps: (before, after) => keyStampStmts(d, before, after, T0 + 2000),
    },
    encodeEntry(await w.genesis()),
  );
  const k = await serverKeys(await tokenKeyBytes(ring.keys[1]!), 1);
  const enc = await encryptToken(ring, `token-${LINK}`, `con_${LINK}`);
  const mac = await linkMac(k, BUDGET, LINK, `item-${LINK}`, unb64(enc.enc));
  await db
    .prepare(
      `INSERT INTO bank_link (id, connection_id, budget_id, provider, provider_item_id, access_token_enc, key_version, linked_at, mac, created_at)
       VALUES (?1, ?2, ?3, 'plaid', ?4, ?5, ?6, 5, ?7, 6)`,
    )
    .bind(LINK, `con_${LINK}`, BUDGET, `item-${LINK}`, enc.enc, enc.keyVersion, b64(mac))
    .run();
}

/**
 * WebCrypto calls, counted: workerd counts their CPU on the request's thread, and a count doesn't vary with the
 * machine's load as times do.
 */
let cryptoCalls = 0;
for (const name of [
  'digest',
  'sign',
  'verify',
  'importKey',
  'exportKey',
  'deriveBits',
  'encrypt',
  'decrypt',
] as const) {
  const subtle = crypto.subtle as unknown as Record<string, (...a: unknown[]) => unknown>;
  const f = subtle[name]!.bind(crypto.subtle);
  subtle[name] = (...a: unknown[]) => {
    cryptoCalls++;
    return f(...a);
  };
}

test('the sealed fetch job, step by step', async () => {
  const out: Record<string, unknown> = { runs: RUNS };
  for (const kept of [false, true]) {
    const db = storeDb();
    await setUp(db);
    const p = provider();
    const keys = workerKeys(ring);
    const deps = (): RunDeps => (kept ? { ...runDeps(db, BUDGET, ring), keys } : runDeps(db, BUDGET, ring));
    const times: Record<string, number[]> = { begin: [], page: [], lastPage: [], complete: [] };
    const ops: Record<string, { crypto: number; statements: number; transactions: number }> = {};
    let now = T0 + 10_000;
    // Run -1 is the link's first, which describes it: not timed.
    for (let r = -1; r < RUNS; r++) {
      let state: FetchState = { phase: 'begin', linkId: LINK };
      for (let step = 0; step < 10; step++) {
        const h = sealedFetchHandler({
          runs: deps(),
          provider: () => p,
          pageSize: 100,
          budgetState: async () => 'normal',
        });
        const name =
          state.phase === 'begin'
            ? 'begin'
            : state.phase === 'complete'
              ? 'complete'
              : (state.pages ?? 0) === 0
                ? 'page'
                : 'lastPage';
        const c0 = cryptoCalls;
        db.resetStats();
        const t0 = performance.now();
        const res = await h(
          { id: 'x', kind: SEALED_FETCH, connectionId: null, state, attempts: 1, recurring: false },
          now,
        );
        if (r >= 0) times[name]!.push(performance.now() - t0);
        ops[name] = {
          crypto: cryptoCalls - c0,
          statements: db.stats.statements,
          transactions: db.stats.queries,
        };
        now += 1000;
        if ('done' in res) break;
        state = res.state as FetchState;
      }
      if (r >= 0 && state.phase !== 'complete') throw new Error(`run ended at ${state.phase}`);
    }
    out[kept ? 'keysKept' : 'keysPerAlarm'] = Object.fromEntries(
      Object.entries(times).map(([k, v]) => [k, { ...stats(v), ...ops[k] }]),
    );
  }
  mkdirSync('.measure', { recursive: true });
  writeFileSync('.measure/fetch-job.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
});
