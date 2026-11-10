// The real sealing code (packages/seal) on the server's hot paths: sealing a bank page, signing a run, checking a
// write, checking a signed request and a stamp. `seal.measure.ts` timed stand-in WebCrypto calls before this code
// existed; this times the code itself. Node's WebCrypto here, workerd's on Cloudflare: both are native code, so these
// are a guide, and the steps are measured again on Cloudflare before the cutover.
// Writes .measure/seal-code.json for docs/measurements.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
import {
  ACTION,
  type AppendContext,
  checkKeyMac,
  checkWrite,
  cursorHash,
  type Entry,
  KEY_KIND,
  keyMac,
  KIND,
  MAX_WRITE_ENTRIES,
  newChallenge,
  randomBytes,
  type RunPage,
  sealedEntry,
  sealPage,
  serverKeys,
  signRequest,
  signRun,
  utf8,
  verifyRequest,
  WHAT,
} from '../../../packages/seal/src/index.js';
import { Budget, BUDGET, PHONE } from '../../../packages/seal/test/budget.js';
import { generate, syncBody } from '../../../tools/plaid-mock/data.mjs';
import { stats } from './harness.js';

const RUNS = 60;
const LINK = '01DX5ZZKBKACTAV9WEVGEMMVRZ';

async function time(fn: () => Promise<unknown>): Promise<ReturnType<typeof stats>> {
  const xs: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    await fn();
    xs.push(performance.now() - t0);
  }
  return stats(xs);
}

test('the sealing code on the server', async () => {
  const out: Record<string, unknown> = { runs: RUNS };
  const k = await serverKeys(randomBytes(32), 1);
  const b = await Budget.create();
  const inboxPub = b.state.public.inboxPub;

  // One job step: seal one bank page (5.5). Production pages hold 100 transactions, about 200 KB (D-6).
  const page = utf8(syncBody(generate(100, 1), 0, 100));
  const place = { budgetId: BUDGET, linkId: LINK, inboxVersion: 1, run: 1, restart: 0, page: 0 };
  out.pageKb = Math.round(page.length / 1024);
  out.sealPage = await time(() => sealPage(k, inboxPub, place, WHAT.transactions, page));

  // The last job step: sign a run of 10 pages. It works out each page's receipt part again.
  const pages: RunPage[] = [];
  for (let p = 0; p < 10; p++)
    pages.push((await sealPage(k, inboxPub, { ...place, page: p }, WHAT.transactions, utf8('x'))).page);
  const run = {
    budgetId: BUDGET,
    linkId: LINK,
    run: 1,
    restart: 0,
    inboxVersion: 1,
    runTime: Date.now(),
    prevRunTime: 0,
    cursorBefore: await cursorHash(''),
    cursorAfter: await cursorHash('next'),
    added: 1000,
    modified: 0,
    removed: 0,
    pages,
    prevManifestHash: new Uint8Array(32) as never,
  };
  out.signRun10Pages = await time(() => signRun(k, inboxPub, run, { inboxVersion: 1, lastRunForOld: 0 }));

  // A write: the rules of the log and the server's own, for 1 entry and for the most a write holds.
  const ctx = (): AppendContext => ({
    now: b.time,
    freshWay: false,
    schemaVersion: 1,
    processingVersion: 1,
    stored: () => Promise.resolve(null),
    lastCompleteRun: 0,
    receiptHashes: () => Promise.resolve(null),
    resting: false,
    keyEntriesLeft: 20,
  });
  for (const [name, count, bytes] of [
    ['write1Entry4Kb', 1, 4000],
    ['write1Entry64Kb', 1, 65000],
    [`write${MAX_WRITE_ENTRIES}Entries4Kb`, MAX_WRITE_ENTRIES, 4000],
    [`write${MAX_WRITE_ENTRIES}Entries64Kb`, MAX_WRITE_ENTRIES, 65000],
  ] as const) {
    const entries: Entry[] = [];
    for (let i = 0; i < count; i++) {
      const e = await sealedEntry(b.fields(KIND.edit, PHONE), randomBytes(bytes), b.keys);
      b.entries.push(e);
      entries.push(e);
    }
    const c = ctx();
    out[name] = await time(() => checkWrite(b.state, entries, c));
    b.entries.length -= count;
    b.undo();
  }

  // A signed request (remove a bank, delete the account), and the stamp on a stored public key.
  const challenge = newChallenge();
  const payload = utf8(JSON.stringify({ linkId: LINK }));
  const sig = await signRequest(b.keys, BUDGET, ACTION.removeBank, challenge, payload);
  out.verifyRequest = await time(() =>
    verifyRequest(b.keys.sign.pub, 1, BUDGET, ACTION.removeBank, challenge, payload, sig),
  );
  const mac = await keyMac(k, BUDGET, 1, KEY_KIND.sign, b.keys.sign.pub);
  out.checkKeyStamp = await time(() => checkKeyMac(k, BUDGET, 1, KEY_KIND.sign, b.keys.sign.pub, mac));

  mkdirSync('.measure', { recursive: true });
  writeFileSync('.measure/seal-code.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
});
