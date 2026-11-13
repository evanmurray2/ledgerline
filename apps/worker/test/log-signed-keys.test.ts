// New keys come only in a signed request (docs/privacy-keys.md 11): a write to the log that holds a key change
// stores a new signing key and new inbox keys, so the store asks for a request signed as `store-sign-key` with the
// key in force (src/seal/log-store.ts `keysSigned`, src/seal/log-routes.ts). Other writes ask for nothing more.
import {
  ACTION,
  deriveBudgetKeys,
  encodeEntry,
  encodeKeyChange,
  KIND,
  newInbox,
  publicEntry,
  randomBytes,
  resealSlotRecord,
  rewrapInbox,
  walkPublic,
  wrapPrevKey,
  type Entry,
} from '@ledgerline/seal';
import { describe, expect, it } from 'vitest';
import { isAskable, signedActionOf } from '../src/http/signed-request.js';
import { logAppend, logHead, type LogDeps } from '../src/seal/log-store.js';
import { keyStampStmts } from '../src/seal/runs.js';
import { BUDGET } from './log-writer.js';
import { world, type World } from './sealed-world.js';

/** A key change on top of the writer's last entry that keeps every way in. */
async function keyChange(x: World, genesis: Entry): Promise<Entry> {
  const w = x.w;
  const p = await walkPublic([genesis], BUDGET);
  const bk = randomBytes(32);
  const keys = await deriveBudgetKeys(bk, BUDGET, 2);
  const inbox = await newInbox(keys, BUDGET, p.inboxVersion + 1);
  const inboxes = [{ version: p.inboxVersion + 1, wrapped: inbox.wrapped }];
  for (const [v, wrapped] of p.inboxes)
    inboxes.push({ version: v, wrapped: await rewrapInbox(w.keys, keys, BUDGET, v, wrapped) });
  const slots = await Promise.all(
    [...p.slots.values()].map((s) => resealSlotRecord(s, w.keys, bk, keys, BUDGET)),
  );
  const body = encodeKeyChange({
    prevPublic: p.lastPublic,
    version: 2,
    signPub: keys.sign.pub,
    wrappedPrevKey: await wrapPrevKey(w.keys, keys, BUDGET, w.bk),
    inboxVersion: p.inboxVersion + 1,
    inboxPub: inbox.pair.pub,
    lastOldRun: 0,
    inboxes,
    slots,
    intent: null,
  });
  return publicEntry(w.fields(KIND.keyChange), body, w.keys);
}

describe('a key change needs a signed request', () => {
  it('is refused unsigned and stored signed; an edit asks for no signature', async () => {
    await world(
      async (x) => {
        const genesis = x.w.last!;
        let asked = 0;
        let good = false;
        const deps = (): LogDeps => ({
          db: x.db,
          budgetId: BUDGET,
          now: x.w.time + 1000,
          resting: false,
          freshWay: false,
          lastCompleteRun: 0,
          receiptHashes: async () => [],
          stamps: (before, after) => keyStampStmts(x.d, before, after, x.w.time),
          keysSigned: async () => (asked++, good),
        });
        // An edit: no request signature is asked.
        const edit = await x.w.edit('an edit');
        expect(await logAppend(deps(), 1, [encodeEntry(edit)])).toMatchObject({ ok: true, number: 2 });
        expect(asked).toBe(0);

        const change = await keyChange(x, genesis);
        expect(await logAppend(deps(), 2, [encodeEntry(change)])).toEqual({
          ok: false,
          why: 'unsigned',
          detail: 'a key change needs a signed request',
          retry: false,
        });
        expect(asked).toBe(1);
        expect(await logHead(x.db)).toBe(2);
        good = true;
        expect(await logAppend(deps(), 2, [encodeEntry(change)])).toMatchObject({ ok: true, number: 3 });
        expect(asked).toBe(2);
      },
      { described: false },
    );
  });

  it('the server names the request by the path; store-inbox-key is never asked', () => {
    expect(signedActionOf('POST', '/api/log/append')).toBe(ACTION.storeSignKey);
    expect(signedActionOf('GET', '/api/log')).toBe(null);
    expect(isAskable(ACTION.storeSignKey)).toBe(true);
    expect(isAskable(ACTION.storeInboxKey)).toBe(false);
  });
});
