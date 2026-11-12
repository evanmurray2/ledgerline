// The job that checks and stamps bank links (store/stamp-links.ts; docs/privacy.md 5.5, section 8 step 4): the
// copied token must open and the bank must take it before a row gets the Worker's stamp.
import { ProviderError, type BankDataProvider } from '@ledgerline/bank-provider';
import type { Db } from '@ledgerline/db/sql';
import { encryptToken, parseKeyring, tokenKeyBytes } from '@ledgerline/platform';
import { checkLinkMac, serverKeys } from '@ledgerline/seal';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DurableDb } from '../src/store/adapter.js';
import type { BudgetStore } from '../src/store/budget-store.js';
import { QUEUE_STAMP_LINKS, stampLinksHandler } from '../src/store/stamp-links.js';

const e = env as unknown as { BUDGET: DurableObjectNamespace<BudgetStore> };
const ring = parseKeyring('1:a passphrase of at least thirty-two characters!', '1');
const BUDGET = '01HQZZZZZZZZZZZZZZZZZZZZZZ';
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** A bank that answers by token. */
const bank = (answers: Record<string, 'ok' | ProviderError | Error>): BankDataProvider =>
  ({
    getAccounts: async (conn: { accessToken: string }) => {
      const a = answers[conn.accessToken];
      if (a === undefined) throw new ProviderError('INVALID_ACCESS_TOKEN', 'unknown token', false);
      if (a !== 'ok') throw a;
      return [];
    },
  }) as unknown as BankDataProvider;

async function link(db: Db, id: string, token: string | null, o: { budget?: string } = {}): Promise<void> {
  const enc = token === null ? null : await encryptToken(ring, token, id);
  await db
    .prepare(
      `INSERT INTO connection (id, budget_id, provider, provider_item_id, institution_name, access_token_enc, key_version, linked_at, created_at, updated_at)
       VALUES (?1, ?2, 'plaid', ?3, 'Bank', ?4, ?5, 5, 6, 6)`,
    )
    .bind(id, o.budget ?? BUDGET, `item-${id}`, enc?.enc ?? null, enc?.keyVersion ?? null)
    .run();
}

describe('checking and stamping bank links', () => {
  it('stamps a link whose token opens and the bank takes; says why for the others', async () => {
    await runInDurableObject(
      e.BUDGET.get(e.BUDGET.idFromName(`stamp-${Math.random()}`)),
      async (_o, state) => {
        const db = new DurableDb(state.storage);
        await db
          .prepare(
            `INSERT INTO budget (id, name, processed_through, created_at, updated_at) VALUES (?1, 'B', 0, 0, 0)`,
          )
          .bind(BUDGET)
          .run();
        await link(db, 'con_01HAAAAAAAAAAAAAAAAAAAAAAA', 'good');
        await link(db, 'con_01HBBBBBBBBBBBBBBBBBBBBBBB', 'repair');
        await link(db, 'con_01HCCCCCCCCCCCCCCCCCCCCCCC', 'unknown-to-the-bank');
        await link(db, 'con_01HDDDDDDDDDDDDDDDDDDDDDDD', null);
        await link(db, 'old-style', 'good');
        await link(db, 'con_01HEEEEEEEEEEEEEEEEEEEEEEE', 'good');
        // A copy that doesn't open: the token of another link under this link's id.
        await db
          .prepare(
            `UPDATE connection SET access_token_enc = (SELECT access_token_enc FROM connection WHERE id = 'con_01HAAAAAAAAAAAAAAAAAAAAAAA')
           WHERE id = 'con_01HEEEEEEEEEEEEEEEEEEEEEEE'`,
          )
          .run();

        const handler = stampLinksHandler({
          db,
          keyring: () => ring,
          provider: () =>
            bank({ good: 'ok', repair: new ProviderError('ITEM_LOGIN_REQUIRED', 'sign in again', false) }),
        });
        state.storage.sql.exec(QUEUE_STAMP_LINKS, 100);
        expect(
          state.storage.sql.exec(`SELECT count(*) AS n FROM job WHERE kind = 'stamp_links'`).one().n,
        ).toBe(1);
        let steps = 0;
        for (;;) {
          const r = await handler(
            { id: 'stamp_links', kind: 'stamp_links', connectionId: null, state: {} } as never,
            100,
          );
          if ('done' in r) break;
          if (++steps > 20) throw new Error('did not finish');
        }
        expect(steps).toBe(6);

        const rows = (
          await db
            .prepare(
              `SELECT id, connection_id, provider_item_id, access_token_enc, mac, check_result, checked_at FROM bank_link ORDER BY id`,
            )
            .all<{
              id: string;
              connection_id: string;
              provider_item_id: string;
              access_token_enc: string | null;
              mac: string | null;
              check_result: string;
              checked_at: number;
            }>()
        ).results;
        expect(rows.map((r) => [r.id, r.check_result, r.mac !== null])).toEqual([
          ['01HAAAAAAAAAAAAAAAAAAAAAAA', 'ok', true],
          ['01HBBBBBBBBBBBBBBBBBBBBBBB', 'needs_repair', true],
          ['01HCCCCCCCCCCCCCCCCCCCCCCC', 'refused:INVALID_ACCESS_TOKEN', false],
          ['01HDDDDDDDDDDDDDDDDDDDDDDD', 'no_token', false],
          ['01HEEEEEEEEEEEEEEEEEEEEEEE', 'token_unreadable', false],
          ['old-style', 'old_id', false],
        ]);
        expect(rows.every((r) => r.checked_at === 100)).toBe(true);

        // The stamp is the Worker's own, over this budget, this link, this Item and this token: it checks with the
        // real code, and not for another budget.
        const keys = await serverKeys(await tokenKeyBytes(ring.keys[1]!), 1);
        const good = rows[0]!;
        const args = [
          good.id,
          good.provider_item_id,
          unb64(good.access_token_enc!),
          unb64(good.mac!),
        ] as const;
        expect(await checkLinkMac(keys, BUDGET, ...args)).toBe(true);
        expect(await checkLinkMac(keys, '01HQYYYYYYYYYYYYYYYYYYYYYY', ...args)).toBe(false);

        // Nothing waits now, so nothing is queued again.
        state.storage.sql.exec(`DELETE FROM job`);
        state.storage.sql.exec(QUEUE_STAMP_LINKS, 200);
        expect(state.storage.sql.exec(`SELECT count(*) AS n FROM job`).one().n).toBe(0);
      },
    );
  });

  it('a fault that may pass is tried again, and a token changed meanwhile is not stamped', async () => {
    await runInDurableObject(
      e.BUDGET.get(e.BUDGET.idFromName(`stamp-${Math.random()}`)),
      async (_o, state) => {
        const db = new DurableDb(state.storage);
        await db
          .prepare(
            `INSERT INTO budget (id, name, processed_through, created_at, updated_at) VALUES (?1, 'B', 0, 0, 0)`,
          )
          .bind(BUDGET)
          .run();
        await link(db, 'con_01HAAAAAAAAAAAAAAAAAAAAAAA', 'slow');
        const job = { id: 'stamp_links', kind: 'stamp_links', connectionId: null, state: {} } as never;
        const down = stampLinksHandler({
          db,
          keyring: () => ring,
          provider: () => bank({ slow: new ProviderError('INTERNAL_SERVER_ERROR', 'try later', true) }),
        });
        await expect(down(job, 100)).rejects.toThrow();
        expect(
          (await db.prepare(`SELECT check_result FROM bank_link`).first<{ check_result: string | null }>())!
            .check_result,
        ).toBeNull();

        // The bank answers, but a repair changed the token while it did: the old token's stamp is not written.
        const changing = stampLinksHandler({
          db,
          keyring: () => ring,
          provider: () =>
            ({
              getAccounts: async () => {
                const next = await encryptToken(ring, 'new', 'con_01HAAAAAAAAAAAAAAAAAAAAAAA');
                await db.prepare(`UPDATE connection SET access_token_enc = ?1`).bind(next.enc).run();
                return [];
              },
            }) as unknown as BankDataProvider,
        });
        await changing(job, 200);
        const row = await db
          .prepare(`SELECT mac, check_result FROM bank_link`)
          .first<{ mac: string | null; check_result: string | null }>();
        expect(row).toEqual({ mac: null, check_result: null });
      },
    );
  });
});
