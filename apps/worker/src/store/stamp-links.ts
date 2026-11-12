// Checks and stamps the rows of `bank_link` (docs/privacy.md 5.5 and section 8 step 4). A row copied from
// `connection` by the migration, or by a trigger, has no stamp: SQL holds no secret. This job takes one link per
// step and shows, before it stamps, that the copy is good: the copied token opens with its key, and the bank
// still takes it (it answers with the accounts, or says the link needs a repair, which also proves the token is
// the Item's). Nothing is linked, re-linked or removed, and no token changes.
import { ProviderError, type BankDataProvider } from '@ledgerline/bank-provider';
import type { Db } from '@ledgerline/db/sql';
import { decryptToken, tokenKeyBytes, type TokenKeyring } from '@ledgerline/platform';
import { isUlid, linkMac, serverKeys } from '@ledgerline/seal';
import type { Handler, StepResult } from './jobs.js';
import { NEEDS_SIGN_IN } from './sync-job.js';

export const STAMP_LINKS_ID = 'stamp_links';

/** A link the job hasn't looked at yet (a stamped or refused one has `check_result`). */
const WAITING = `mac IS NULL AND check_result IS NULL AND provider = 'plaid'`;

/** Queues the job when a link waits for its check and no job is queued (`?1`: now). */
export const QUEUE_STAMP_LINKS = `INSERT INTO job (id, kind, state, run_at, created_at, updated_at)
  SELECT '${STAMP_LINKS_ID}', 'stamp_links', '{}', ?1, ?1, ?1
  WHERE NOT EXISTS (SELECT 1 FROM job WHERE id = '${STAMP_LINKS_ID}')
    AND EXISTS (SELECT 1 FROM bank_link WHERE ${WAITING})`;

/**
 * What the check found. `ok` and `needs_repair` are stamped. The others are not, and say why:
 * `no_token` (the link has no token or Item), `old_id` (the budget's or the link's id is not a ULID, which the
 * stamp needs), `token_unreadable` (the copy doesn't open with its key), `refused:<code>` (the bank refused the
 * token for a reason a repair doesn't fix).
 */
export type LinkCheck =
  'ok' | 'needs_repair' | 'no_token' | 'old_id' | 'token_unreadable' | `refused:${string}`;

export interface StampDeps {
  db: Db;
  keyring: () => TokenKeyring;
  provider: () => BankDataProvider;
}

const b64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

interface LinkRow {
  id: string;
  connection_id: string;
  budget_id: string;
  provider_item_id: string | null;
  access_token_enc: string | null;
  key_version: number | null;
}

export function stampLinksHandler(deps: StampDeps): Handler {
  return async (_job, now): Promise<StepResult> => {
    const { db } = deps;
    const link = await db
      .prepare(
        `SELECT id, connection_id, budget_id, provider_item_id, access_token_enc, key_version
         FROM bank_link WHERE ${WAITING} ORDER BY id LIMIT 1`,
      )
      .first<LinkRow>();
    if (!link) {
      // Once, when the last link is done: how large the bank log is, from the small table of its pages. The next
      // step of the move puts the bank log on the device (docs/privacy.md 5.4), and its size decides how.
      const size = await db
        .prepare(
          `SELECT count(*) AS pages, coalesce(sum(events), 0) AS events, coalesce(sum(bytes), 0) AS bytes FROM bank_page`,
        )
        .first<{ pages: number; events: number; bytes: number }>();
      console.log(JSON.stringify({ event: 'bank_log_size', ...size }));
      return { done: true };
    }
    const { result, mac } = await check(deps, link);
    // Only if the token is still the one that was checked: a repair in between starts the link over.
    await db
      .prepare(
        `UPDATE bank_link SET mac = ?2, checked_at = ?3, check_result = ?4
         WHERE id = ?1 AND access_token_enc IS ?5 AND key_version IS ?6 AND provider_item_id IS ?7`,
      )
      .bind(link.id, mac, now, result, link.access_token_enc, link.key_version, link.provider_item_id)
      .run();
    // No secret, no Item id: the link's own id and what the check found.
    console.log(JSON.stringify({ event: 'link_checked', link: link.id, result, stamped: mac !== null }));
    return { state: {}, runAt: now };
  };
}

async function check(deps: StampDeps, link: LinkRow): Promise<{ result: LinkCheck; mac: string | null }> {
  const none = (result: LinkCheck) => ({ result, mac: null });
  if (!link.access_token_enc || link.key_version === null || !link.provider_item_id) return none('no_token');
  if (!isUlid(link.budget_id) || !isUlid(link.id)) return none('old_id');
  const ring = deps.keyring();
  let token: string;
  try {
    token = await decryptToken(ring, link.access_token_enc, link.key_version, link.connection_id);
  } catch {
    return none('token_unreadable');
  }
  let result: LinkCheck = 'ok';
  try {
    await deps
      .provider()
      .getAccounts({ id: link.connection_id, accessToken: token, providerItemId: link.provider_item_id });
  } catch (e) {
    // A fault that may pass (the network, a rate limit) is thrown: the job runner tries the step again later.
    if (!(e instanceof ProviderError) || e.retryable) throw e;
    if (!NEEDS_SIGN_IN.has(e.code)) return none(`refused:${e.code.slice(0, 40)}`);
    result = 'needs_repair';
  }
  const secret = await tokenKeyBytes(ring.keys[link.key_version]!);
  const keys = await serverKeys(secret, link.key_version);
  const mac = await linkMac(
    keys,
    link.budget_id,
    link.id,
    link.provider_item_id,
    unb64(link.access_token_enc),
  );
  return { result, mac: b64(mac) };
}
