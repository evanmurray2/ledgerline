// Bank runs of a sealed budget (src/seal/runs.ts): each page is sealed as it is fetched, the run is signed when
// it is whole, and a device opens it with the checks of docs/privacy-keys.md 9.3. A row someone else wrote stops
// the fetch.
import {
  afterRun,
  cursorHash,
  deriveBudgetKeys,
  newInbox,
  openRun,
  randomBytes,
  RunError,
  sha256,
  toHex,
  type ChainState,
  type FilingState,
} from '@ledgerline/seal';
import { describe, expect, it } from 'vitest';
import { stateFromJson, stateToJson } from '../src/seal/log-store.js';
import { stageOf } from '../src/seal/run-stage.js';
import {
  abandonSealedRun,
  beginSealedRun,
  completeSealedRun,
  fetchSealedPage,
  sealBankAnswer,
  sealLinkDescription,
  STAGE_MAX_MS,
} from '../src/seal/run-steps.js';
import {
  BadStamp,
  keyStampStmts,
  lastCompleteRun,
  receiptHashes,
  RunStopped,
  sealedPageOf,
} from '../src/seal/runs.js';
import { BUDGET, T0 } from './log-writer.js';
import { bank, handed, LINK_A, LINK_B, run, text, TWO_PAGES, world, type World } from './sealed-world.js';

describe('bank runs of a sealed budget', () => {
  it('seals each page, signs the run, and a device opens it; the next run chains to it', async () => {
    await world(async (x) => {
      expect(await lastCompleteRun(x.db)).toBe(2);
      const a = bank(TWO_PAGES);
      // While link A's run is fetched, link B waits.
      expect(await beginSealedRun(x.d, LINK_A, T0 + 3000)).toMatchObject({ run: 3, restart: 0, pages: 0 });
      expect(await beginSealedRun(x.d, LINK_B, T0 + 3000)).toBe('busy');
      // A run still being fetched gives a device nothing.
      expect(await fetchSealedPage(x.d, a.provider, 100)).toEqual({ more: true });
      expect(await sealedPageOf(x.db, 3, 0)).toBeNull();
      expect(
        await run(x, LINK_A, a.provider, T0 + 3000, [{ providerAccountId: 'acc', currentBalance: 5 }]),
      ).toEqual({ run: 3 });
      expect(a.calls).toEqual([null, 'c1']);
      expect(await stageOf(x.d)).toBeNull();
      expect(await lastCompleteRun(x.db)).toBe(3);

      // A stored page does not hold the bank's answer as it came.
      const stored = await handed(x.db, 3);
      for (const p of stored.pages) expect(text(p)).not.toContain('added');

      const filed = await openRun(x.filing, stored);
      expect(filed.manifest).toMatchObject({
        linkId: LINK_A,
        run: 3,
        restart: 0,
        inboxVersion: 1,
        runTime: T0 + 3000,
        prevRunTime: T0 + 2101,
        added: 5,
        modified: 1,
        removed: 4,
        flags: 1,
        n: 1,
      });
      expect(filed.pages.map((p) => p.what)).toEqual([0, 0, 1]);
      expect(JSON.parse(text(filed.pages[0]!.payload))).toMatchObject({ at: '', added: 3 });
      expect(JSON.parse(text(filed.pages[1]!.payload))).toMatchObject({ at: 'c1', added: 2 });
      expect(JSON.parse(text(filed.pages[2]!.payload))).toEqual([
        { providerAccountId: 'acc', currentBalance: 5 },
      ]);
      expect(toHex(filed.manifest.cursorAfter)).toBe(toHex(await cursorHash('c2')));
      // The receipt a filing entry shows is the one the server kept the hash of.
      expect((await receiptHashes(x.db, 3, 3))!.map(toHex)).toEqual([toHex(await sha256(filed.receipt))]);
      expect(await receiptHashes(x.db, 3, 4)).toBeNull();

      // Link B's first run is run 2 of the budget; link A's next run goes on from its cursor, with the clock
      // behind: its time is still later than the run before.
      const b = bank({ '': { added: 1, next: 'b1', more: false } });
      expect(await run(x, LINK_B, b.provider, T0 + 4000)).toEqual({ run: 4 });
      const a2 = bank({ c2: { added: 0, next: 'c2', more: false } });
      expect(await run(x, LINK_A, a2.provider, T0 + 1000)).toEqual({ run: 5 });
      expect(a2.calls).toEqual(['c2']);
      let filing = afterRun(x.filing, filed);
      for (const n of [4, 5]) {
        const f = await openRun(filing, await handed(x.db, n));
        filing = afterRun(filing, f);
      }
      expect(filing.filedThrough).toBe(5);
      expect(filing.lastRunTime).toBe(T0 + 4001);
      // Out of order, a run is refused.
      await expect(openRun(x.filing, await handed(x.db, 4))).rejects.toBeInstanceOf(RunError);
    });
  });

  it("a link's first run holds its description and no transactions", async () => {
    await world(
      async (x) => {
        const a = bank(TWO_PAGES);
        expect(await beginSealedRun(x.d, LINK_A, T0 + 3000)).toMatchObject({ run: 1, describes: true });
        // Not whole without the description, and it takes no transactions and no balances page.
        await expect(completeSealedRun(x.d, T0 + 3000)).rejects.toBeInstanceOf(RunStopped);
        expect(await fetchSealedPage(x.d, a.provider, 100)).toEqual({ more: false });
        expect(a.calls).toEqual([]);
        await expect(sealBankAnswer(x.d, 1, [])).rejects.toBeInstanceOf(RunStopped);
        await sealLinkDescription(x.d, { bank: 'First Bank', accounts: [{ name: 'Checking' }] });
        await sealLinkDescription(x.d, { bank: 'sent twice' });
        expect(await completeSealedRun(x.d, T0 + 3000)).toEqual({ run: 1 });
        const filed = await openRun(x.filing, await handed(x.db, 1));
        expect(filed.manifest).toMatchObject({ flags: 4, added: 0 });
        expect(filed.pages.map((p) => p.what)).toEqual([3]);
        expect(JSON.parse(text(filed.pages[0]!.payload))).toMatchObject({ bank: 'First Bank' });
        // The next run is the link's transactions, from the start; it describes nothing.
        expect(await beginSealedRun(x.d, LINK_A, T0 + 3100)).toMatchObject({
          run: 2,
          describes: false,
          cursor: '',
        });
        await expect(sealLinkDescription(x.d, {})).rejects.toBeInstanceOf(RunStopped);
      },
      { described: false },
    );
  });

  it('starts again when the bank says its data changed mid-run, with new receipts', async () => {
    await world(async (x) => {
      const a = bank(TWO_PAGES, { mutateOnce: 'c1' });
      expect(await beginSealedRun(x.d, LINK_A, T0 + 3000)).toMatchObject({ run: 3 });
      expect(await fetchSealedPage(x.d, a.provider, 100)).toEqual({ more: true });
      expect(await fetchSealedPage(x.d, a.provider, 100)).toBe('restarted');
      expect(await stageOf(x.d)).toMatchObject({ restart: 1, pages: 0, cursor: '', added: 0 });
      expect(await run(x, LINK_A, a.provider, T0 + 3000)).toEqual({ run: 3 });
      expect(a.calls).toEqual([null, 'c1', null, 'c1']);
      const filed = await openRun(x.filing, await handed(x.db, 3));
      expect(filed.manifest).toMatchObject({ restart: 1, added: 5, removed: 4 });
      expect(filed.pages.length).toBe(2);
    });
  });

  it('a run given up leaves nothing, and the link starts again from its cursor', async () => {
    await world(async (x) => {
      const a = bank(TWO_PAGES);
      await beginSealedRun(x.d, LINK_A, T0 + 3000);
      await fetchSealedPage(x.d, a.provider, 100);
      // Giving up another link's run does nothing.
      await abandonSealedRun(x.db, LINK_B);
      expect(await stageOf(x.d)).toMatchObject({ linkId: LINK_A, pages: 1 });
      await abandonSealedRun(x.db, LINK_A);
      expect(await stageOf(x.d)).toBeNull();
      expect(
        (await x.db.prepare(`SELECT count(*) AS n FROM sealed_page WHERE run > 2`).first<{ n: number }>())!.n,
      ).toBe(0);
      expect(
        await run(x, LINK_B, bank({ '': { added: 1, next: 'b1', more: false } }).provider, T0 + 3000),
      ).toEqual({ run: 3 });
      expect(await run(x, LINK_A, a.provider, T0 + 3500)).toEqual({ run: 4 });
    });
  });

  it('a key change mid-run: the run starts again, sealed to the inbox key in force', async () => {
    await world(async (x) => {
      const a = bank(TWO_PAGES);
      await beginSealedRun(x.d, LINK_A, T0 + 3000);
      await fetchSealedPage(x.d, a.provider, 100);
      await fetchSealedPage(x.d, a.provider, 100);

      // The log takes a key change: inbox version 2 is in force, and only runs 1 and 2 may be sealed to version 1.
      const keys2 = await deriveBudgetKeys(randomBytes(32), BUDGET, 2);
      const inbox2 = await newInbox(keys2, BUDGET, 2);
      const row = (await x.db
        .prepare(`SELECT state FROM log_state WHERE id = 1`)
        .first<{ state: string }>())!;
      const before = stateFromJson(row.state) as unknown as ChainState;
      const after = stateFromJson(row.state) as unknown as ChainState & {
        public: { retiredAt: Map<number, number> };
      };
      after.public.keyVersion = 2;
      after.public.signPub = keys2.sign.pub;
      after.public.inboxVersion = 2;
      after.public.inboxPub = inbox2.pair.pub;
      after.public.retiredAt.set(1, 2);
      await x.db.batch([
        x.db.prepare(`UPDATE log_state SET state = ?1 WHERE id = 1`).bind(stateToJson(after as never)),
        ...(await keyStampStmts(x.d, before, after, T0 + 3100)),
      ]);

      expect(await completeSealedRun(x.d, T0 + 3200)).toBe('restarted');
      expect(await stageOf(x.d)).toMatchObject({ restart: 1, inboxVersion: 2, pages: 0, cursor: '' });
      expect(await run(x, LINK_A, a.provider, T0 + 3300)).toEqual({ run: 3 });

      const device: FilingState = {
        ...x.filing,
        inboxVersion: 2,
        retiredAt: new Map([[1, 2]]),
        inbox: async (v) => (v === 2 ? inbox2.pair : v === 1 ? x.w.inbox : null),
      };
      const filed = await openRun(device, await handed(x.db, 3));
      expect(filed.manifest).toMatchObject({ inboxVersion: 2, restart: 1 });
      // A device that has not reached the key change waits; it is not told the run is bad.
      await expect(openRun(x.filing, await handed(x.db, 3))).rejects.toMatchObject({ retry: true });
    });
  });

  it('stops when a row it relies on was written by someone else', async () => {
    const tampers: [string, (x: World) => void | Promise<void>, 'inbox key' | 'link' | 'run state'][] = [
      [
        'an inbox key of their own',
        (x) => x.sql(`UPDATE key_stamp SET pub = ?1 WHERE kind = 2`, toHex(randomBytes(32))),
        'inbox key',
      ],
      ['no inbox key', (x) => x.sql(`DELETE FROM key_stamp WHERE kind = 2`), 'inbox key'],
      [
        "the signing key in the inbox key's place",
        (x) =>
          x.sql(
            `UPDATE key_stamp SET pub = (SELECT pub FROM key_stamp WHERE kind = 1), mac = (SELECT mac FROM key_stamp WHERE kind = 1) WHERE kind = 2`,
          ),
        'inbox key',
      ],
      ['a moved cursor', (x) => x.sql(`UPDATE link_cursor SET cursor = ''`), 'run state'],
      ['a dropped cursor', (x) => x.sql(`DELETE FROM link_cursor`), 'run state'],
      ['a run counter moved back', (x) => x.sql(`UPDATE run_state SET run = 0`), 'run state'],
      ['no run state', (x) => x.sql(`DELETE FROM run_state`), 'run state'],
      [
        'a run state stamped by a key the Worker does not hold',
        (x) => x.sql(`UPDATE run_state SET n = 9`),
        'run state',
      ],
      [
        'another token',
        (x) =>
          x.sql(
            `UPDATE bank_link SET access_token_enc = (SELECT access_token_enc FROM bank_link WHERE id = ?1) WHERE id = ?2`,
            LINK_B,
            LINK_A,
          ),
        'link',
      ],
      [
        'another Item',
        (x) => x.sql(`UPDATE bank_link SET provider_item_id = 'item-x' WHERE id = ?1`, LINK_A),
        'link',
      ],
      ['a link with no stamp', (x) => x.sql(`UPDATE bank_link SET mac = NULL WHERE id = ?1`, LINK_A), 'link'],
      [
        'a link of another budget',
        (x) => x.sql(`UPDATE bank_link SET budget_id = '01HZZZZZZZZZZZZZZZZZZZZZZZ' WHERE id = ?1`, LINK_A),
        'link',
      ],
    ];
    for (const [name, tamper, what] of tampers) {
      await world(async (x) => {
        // One good run first, so there is a cursor and a run state to move.
        expect(await run(x, LINK_A, bank(TWO_PAGES).provider, T0 + 3000)).toEqual({ run: 3 });
        await tamper(x);
        const err = await beginSealedRun(x.d, LINK_A, T0 + 4000).catch((x: unknown) => x);
        expect(err, name).toBeInstanceOf(BadStamp);
        expect((err as BadStamp).what, name).toBe(what);
        expect(await stageOf(x.d), name).toBeNull();
      });
    }
  });

  it('a key swapped while a run is being fetched seals nothing more', async () => {
    await world(async (x) => {
      const a = bank(TWO_PAGES);
      await beginSealedRun(x.d, LINK_A, T0 + 3000);
      await fetchSealedPage(x.d, a.provider, 100);
      x.sql(`UPDATE key_stamp SET pub = ?1 WHERE kind = 2`, toHex(randomBytes(32)));
      await expect(fetchSealedPage(x.d, a.provider, 100)).rejects.toBeInstanceOf(BadStamp);
      expect(await stageOf(x.d)).toMatchObject({ pages: 1 });
    });
  });

  it('goes on only from what its own steps left: a changed stage or page stops it', async () => {
    const tampers: [string, (x: World) => void][] = [
      [
        'a page dropped and the counter put back',
        (x) => {
          x.sql(`DELETE FROM sealed_page WHERE run = 3`);
          x.sql(`UPDATE run_stage SET pages = 0, added = 0, modified = 0, removed = 0`);
        },
      ],
      ['a cursor the Worker never fetched', (x) => x.sql(`UPDATE run_stage SET cursor = 'elsewhere'`)],
      ['the first cursor moved', (x) => x.sql(`UPDATE run_stage SET start_cursor = 'c2'`)],
      ['the last page claimed early', (x) => x.sql(`UPDATE run_stage SET has_more = 0`)],
      ['another inbox version', (x) => x.sql(`UPDATE run_stage SET inbox_version = 2`)],
      ['a first run made of a later one', (x) => x.sql(`UPDATE run_stage SET describes = 1`)],
      ['changed counts', (x) => x.sql(`UPDATE run_stage SET added = 0`)],
      ['another run number', (x) => x.sql(`UPDATE run_stage SET run = 4`)],
      ['another link', (x) => x.sql(`UPDATE run_stage SET link_id = ?1`, LINK_B)],
      ['a Worker key the keyring does not hold', (x) => x.sql(`UPDATE run_stage SET n = 9`)],
    ];
    for (const [name, tamper] of tampers) {
      await world(async (x) => {
        const a = bank(TWO_PAGES);
        await beginSealedRun(x.d, LINK_A, T0 + 3000);
        await fetchSealedPage(x.d, a.provider, 100);
        tamper(x);
        const err = await fetchSealedPage(x.d, a.provider, 100).catch((e: unknown) => e);
        expect(err, name).toBeInstanceOf(BadStamp);
        expect((err as BadStamp).what, name).toBe('run stage');
        await expect(completeSealedRun(x.d, T0 + 3000), name).rejects.toBeInstanceOf(BadStamp);
        // The bank was not asked again, and nothing was signed.
        expect(a.calls, name).toEqual([null]);
        expect(await lastCompleteRun(x.db), name).toBe(2);
        // The next begin drops the changed run and starts a clean one, for whichever link asks.
        expect(await beginSealedRun(x.d, LINK_B, T0 + 3100), name).toMatchObject({
          linkId: LINK_B,
          run: 3,
          pages: 0,
        });
      });
    }
    // The stage is whole, but a stored page is not the one a step sealed.
    const pages: [string, (x: World) => void][] = [
      [
        'a page swapped for another',
        (x) => x.sql(`UPDATE sealed_page SET hash = ?1 WHERE run = 3 AND page = 0`, 'ab'.repeat(32)),
      ],
      [
        'a page called something else',
        (x) => x.sql(`UPDATE sealed_page SET what = 1 WHERE run = 3 AND page = 1`),
      ],
      ['a page gone', (x) => x.sql(`DELETE FROM sealed_page WHERE run = 3 AND page = 1`)],
      [
        'pages in another order',
        (x) => {
          x.sql(`UPDATE sealed_page SET page = 9 WHERE run = 3 AND page = 0`);
          x.sql(`UPDATE sealed_page SET page = 0 WHERE run = 3 AND page = 1`);
          x.sql(`UPDATE sealed_page SET page = 1 WHERE run = 3 AND page = 9`);
        },
      ],
    ];
    for (const [name, tamper] of pages) {
      await world(async (x) => {
        const a = bank(TWO_PAGES);
        await beginSealedRun(x.d, LINK_A, T0 + 3000);
        await fetchSealedPage(x.d, a.provider, 100);
        await fetchSealedPage(x.d, a.provider, 100);
        tamper(x);
        const err = await completeSealedRun(x.d, T0 + 3000).catch((e: unknown) => e);
        expect(err, name).toBeInstanceOf(BadStamp);
        expect(await lastCompleteRun(x.db), name).toBe(2);
      });
    }
  });

  it('a step that answers late, after its run was given up, writes nothing into the next run', async () => {
    await world(async (x) => {
      // While the bank is asked for link A's page, the run is given up and link B's begins.
      const a = bank(TWO_PAGES, {
        before: async () => {
          await abandonSealedRun(x.db, LINK_A);
          expect(await beginSealedRun(x.d, LINK_B, T0 + 3050)).toMatchObject({ linkId: LINK_B, run: 3 });
        },
      });
      await beginSealedRun(x.d, LINK_A, T0 + 3000);
      await expect(fetchSealedPage(x.d, a.provider, 100)).rejects.toBeInstanceOf(RunStopped);
      expect(await stageOf(x.d)).toMatchObject({ linkId: LINK_B, pages: 0, cursor: '' });
      expect(
        (await x.db.prepare(`SELECT count(*) AS n FROM sealed_page WHERE run = 3`).first<{ n: number }>())!.n,
      ).toBe(0);
    });
  });

  it('a run left alone too long makes way; the bank may restart a run only so often', async () => {
    await world(async (x) => {
      await beginSealedRun(x.d, LINK_A, T0 + 3000);
      expect(await beginSealedRun(x.d, LINK_B, T0 + 3000 + STAGE_MAX_MS)).toBe('busy');
      expect(await beginSealedRun(x.d, LINK_B, T0 + 3001 + STAGE_MAX_MS)).toMatchObject({
        linkId: LINK_B,
        run: 3,
      });
      await abandonSealedRun(x.db, LINK_B);

      const a = bank(TWO_PAGES, { mutateAlways: true });
      await beginSealedRun(x.d, LINK_A, T0 + 4000);
      for (let i = 0; i < 3; i++) expect(await fetchSealedPage(x.d, a.provider, 100)).toBe('restarted');
      await expect(fetchSealedPage(x.d, a.provider, 100)).rejects.toBeInstanceOf(RunStopped);
      expect(await stageOf(x.d)).toMatchObject({ restart: 3, bankRestarts: 3 });
    });
  });

  it('the last step, run again after its answer was lost, says the run is there', async () => {
    await world(async (x) => {
      const a = bank(TWO_PAGES);
      await beginSealedRun(x.d, LINK_A, T0 + 3000);
      await fetchSealedPage(x.d, a.provider, 100);
      // A page step run again fetches the next page, not the same one.
      await fetchSealedPage(x.d, a.provider, 100);
      expect(await fetchSealedPage(x.d, a.provider, 100)).toEqual({ more: false });
      expect(a.calls).toEqual([null, 'c1']);
      await sealBankAnswer(x.d, 2, [{ providerAccountId: 'card' }]);
      await sealBankAnswer(x.d, 2, [{ providerAccountId: 'sent twice' }]);
      expect(await completeSealedRun(x.d, T0 + 3000, 3)).toEqual({ run: 3 });
      expect(await completeSealedRun(x.d, T0 + 3000, 3)).toEqual({ run: 3 });
      await expect(completeSealedRun(x.d, T0 + 3000)).rejects.toBeInstanceOf(RunStopped);
      await expect(completeSealedRun(x.d, T0 + 3000, 4)).rejects.toBeInstanceOf(RunStopped);
      const filed = await openRun(x.filing, await handed(x.db, 3));
      expect(filed.manifest.flags).toBe(2);
      expect(filed.pages.map((p) => p.what)).toEqual([0, 0, 2]);
      expect(JSON.parse(text(filed.pages[2]!.payload))).toEqual([{ providerAccountId: 'card' }]);
    });
  });

  it('never goes back to an older inbox key than the last run, whatever the log state says', async () => {
    await world(async (x) => {
      const old = (await x.db.prepare(`SELECT state FROM log_state WHERE id = 1`).first<{ state: string }>())!
        .state;
      const keys2 = await deriveBudgetKeys(randomBytes(32), BUDGET, 2);
      const inbox2 = await newInbox(keys2, BUDGET, 2);
      const before = stateFromJson(old) as unknown as ChainState;
      const after = stateFromJson(old) as unknown as ChainState & {
        public: { retiredAt: Map<number, number> };
      };
      after.public.keyVersion = 2;
      after.public.signPub = keys2.sign.pub;
      after.public.inboxVersion = 2;
      after.public.inboxPub = inbox2.pair.pub;
      after.public.retiredAt.set(1, 2);
      await x.db.batch([
        x.db.prepare(`UPDATE log_state SET state = ?1 WHERE id = 1`).bind(stateToJson(after as never)),
        ...(await keyStampStmts(x.d, before, after, T0 + 3100)),
      ]);
      expect(await run(x, LINK_A, bank(TWO_PAGES).provider, T0 + 3200)).toEqual({ run: 3 });
      // Someone puts the log's state back to before the key change.
      x.sql(`UPDATE log_state SET state = ?1 WHERE id = 1`, old);
      const err = await beginSealedRun(x.d, LINK_A, T0 + 3300).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadStamp);
      expect((err as BadStamp).what).toBe('inbox key');
    });
  });

  it('a key the log takes replaces a row someone put there first', async () => {
    await world(async (x) => {
      x.sql(`INSERT INTO key_stamp (kind, version, pub, mac, n, created_at) VALUES (2, 2, 'aa', 'bb', 1, 0)`);
      const row = (await x.db
        .prepare(`SELECT state FROM log_state WHERE id = 1`)
        .first<{ state: string }>())!;
      const keys2 = await deriveBudgetKeys(randomBytes(32), BUDGET, 2);
      const inbox2 = await newInbox(keys2, BUDGET, 2);
      const before = stateFromJson(row.state) as unknown as ChainState;
      const after = stateFromJson(row.state) as unknown as ChainState;
      after.public.inboxVersion = 2;
      after.public.inboxPub = inbox2.pair.pub;
      await x.db.batch([
        x.db.prepare(`UPDATE log_state SET state = ?1 WHERE id = 1`).bind(stateToJson(after as never)),
        ...(await keyStampStmts(x.d, before, after, T0 + 3100)),
      ]);
      expect(await beginSealedRun(x.d, LINK_A, T0 + 3200)).toMatchObject({ inboxVersion: 2 });
      // A write that changes no key costs no stamp.
      expect(await keyStampStmts(x.d, after, after, T0 + 3300)).toEqual([]);
    });
  });
});
