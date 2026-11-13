// A new bank's link, finished by the server (docs/privacy.md 5.5): Plaid's public token is good for only about 30
// minutes, and an Item with no access token is a lifetime link used for nothing. So the Worker does not wait for
// the person to come back (`link-finish`): each link token for a new bank is watched by a job of the budget's
// store, which asks Plaid (`/link/token/get`) every few minutes and keeps the link as soon as Plaid says it is
// finished; Plaid's "session finished" webhook runs that job at once. The app's own `link-finish` takes the same
// path, so a link is exchanged once whoever asks first.
//
// The job holds the link token encrypted under TOKEN_KEYS. The Directory routes the webhook by a hash of the link
// token (`connection_route`, key `link:<hash>`), dropped once the watch ends.
import type { LinkFinishResult } from '@ledgerline/contracts';
import { decryptToken, encryptToken, parseKeyring, ulid } from '@ledgerline/platform';
import { linkMac, toHex } from '@ledgerline/seal';
import type { Env } from '../env.js';
import type { Enqueue, Handler, StepResult } from '../store/jobs.js';
import { makeProvider } from '../sync/provider.js';
import { workerKeys } from './runs.js';

export const LINK_WATCH = 'link_watch';
/** How long a link token is watched: Plaid's link token lasts 4 hours. */
export const WATCH_FOR_MS = 4 * 60 * 60_000;
/** Plaid is asked this often for the first 30 minutes, then every 15: both well inside a public token's life. */
export const WATCH_EVERY_MS = 3 * 60_000;
export const WATCH_LATER_MS = 15 * 60_000;
/** A finished watch stays this long, so a late `link-finish` from the app finds the link it made. */
export const KEEP_DONE_MS = 60 * 60_000;

export interface WatchState {
  enc: string;
  keyVersion: number;
  hash: string;
  startedAt: number;
  /** Set once the link is kept. */
  connectionId?: string;
}

const b64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
const keyring = (env: Env) => parseKeyring(env.TOKEN_KEYS, env.TOKEN_KEY_CURRENT);

/** The hash a link token is known by in the job's id and in the Directory's route: never the token itself. */
export async function linkTokenHash(linkToken: string): Promise<string> {
  return toHex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`link-token:${linkToken}`)),
    ),
  );
}
export const linkWatchId = (hash: string) => `${LINK_WATCH}:${hash}`;
/** The Directory's route key for a link token's webhook. */
export const linkRouteKey = (hash: string) => `link:${hash}`;

/** Starts watching a new bank's link token. */
export async function watchLink(env: Env, enqueue: Enqueue, linkToken: string, now: number): Promise<string> {
  const hash = await linkTokenHash(linkToken);
  const sealed = await encryptToken(keyring(env), linkToken, linkWatchId(hash));
  const state: WatchState = { enc: sealed.enc, keyVersion: sealed.keyVersion, hash, startedAt: now };
  await enqueue(LINK_WATCH, { id: linkWatchId(hash), state, runAt: now + WATCH_EVERY_MS });
  return hash;
}

async function watchOf(env: Env, hash: string): Promise<WatchState | null> {
  const r = await env.DB.prepare(`SELECT state FROM job WHERE id = ?1`)
    .bind(linkWatchId(hash))
    .first<{ state: string }>();
  return r ? (JSON.parse(r.state) as WatchState) : null;
}

/**
 * Exchanges a new link's public token and keeps the link: its token encrypted under TOKEN_KEYS, with the Worker's
 * stamp (`linkMac`), and a fetch asked for. The bank's name and accounts are not kept: the link's first run asks
 * the bank for them and seals them to the budget's inbox (seal/fetch-job.ts), and a device writes them. Gives the
 * link's connection id.
 */
export async function saveLink(
  env: Env,
  budgetId: string,
  now: number,
  publicToken: string,
): Promise<string> {
  const done = await makeProvider(env).completeLink(publicToken);
  // The same Item again (update mode, or a link finished twice): the link it is, not a new one.
  const same = await env.DB.prepare(
    `SELECT connection_id FROM bank_link WHERE budget_id = ?1 AND provider_item_id = ?2`,
  )
    .bind(budgetId, done.providerItemId)
    .first<{ connection_id: string }>();
  if (same) return same.connection_id;
  const linkId = ulid(now);
  const connectionId = `con_${linkId}`;
  const ring = keyring(env);
  const enc = await encryptToken(ring, done.accessToken, connectionId);
  const keys = await workerKeys(ring).keysFor(enc.keyVersion);
  const mac = await linkMac(keys, budgetId, linkId, done.providerItemId, unb64(enc.enc));
  await env.DB.prepare(
    `INSERT INTO bank_link (id, connection_id, budget_id, provider, provider_item_id, access_token_enc, key_version,
       linked_at, mac, checked_at, check_result, status, fetch_requested, created_at)
     VALUES (?1, ?2, ?3, 'plaid', ?4, ?5, ?6, ?7, ?8, ?7, 'ok', 'ok', 1, ?7)`,
  )
    .bind(linkId, connectionId, budgetId, done.providerItemId, enc.enc, enc.keyVersion, now, b64(mac))
    .run();
  // Which budget owns the Item, for the bank's webhooks (docs/multi-user.md 6.4).
  if (env.ROUTE_LINK) await env.ROUTE_LINK(done.providerItemId, connectionId);
  return connectionId;
}

/** One finish per link token at a time in this store: the app and the job never exchange a token twice. */
const finishing = new Map<string, Promise<LinkFinishResult>>();

/**
 * What a new bank's link came to, from Plaid, and the link kept when it is finished. For the app's `link-finish`
 * and for the watch job alike: a link already kept (by the other) answers with its connection.
 */
export function finishNewLink(
  env: Env,
  budgetId: string,
  linkToken: string,
  now: number,
): Promise<LinkFinishResult> {
  const run = async (hash: string): Promise<LinkFinishResult> => {
    const kept = await watchOf(env, hash);
    if (kept?.connectionId) return { status: 'linked', connectionId: kept.connectionId };
    const result = await makeProvider(env).linkResult(linkToken);
    if (result.state !== 'finished') return { status: result.state };
    const publicToken = result.publicTokens[0];
    if (!publicToken) return { status: 'exited' };
    const connectionId = await saveLink(env, budgetId, now, publicToken);
    // Kept with the watch for an hour (KEEP_DONE_MS), for a late `link-finish`; the webhook's route goes now.
    if (kept)
      await env.DB.prepare(`UPDATE job SET state = ?2, run_at = ?3, attempts = 0 WHERE id = ?1`)
        .bind(linkWatchId(hash), JSON.stringify({ ...kept, connectionId }), now + KEEP_DONE_MS)
        .run();
    await env.DROP_ROUTE?.(linkRouteKey(hash)).catch(() => undefined);
    return { status: 'linked', connectionId };
  };
  return linkTokenHash(linkToken).then((hash) => {
    const going = finishing.get(hash);
    if (going) return going;
    const p = run(hash).finally(() => finishing.delete(hash));
    finishing.set(hash, p);
    return p;
  });
}

/**
 * The watch job: asks Plaid where the link stands and keeps it once finished, then asks for its first fetch. A
 * link the person left, or a token past its 4 hours, ends the watch; nothing was linked, so nothing is left.
 */
export function linkWatchHandler(o: {
  env: Env;
  budgetId: () => Promise<string>;
  /** Starts the fetches asked for (a new link asks for its first). */
  queueFetch: () => Promise<void>;
}): Handler {
  return async (job, now): Promise<StepResult> => {
    const st = job.state as WatchState;
    // A kept link's watch has waited its hour for a late `link-finish`.
    if (st.connectionId) return { done: true };
    const over = async (): Promise<StepResult> => {
      await o.env.DROP_ROUTE?.(linkRouteKey(st.hash)).catch(() => undefined);
      return { done: true };
    };
    if (now - st.startedAt > WATCH_FOR_MS) return over();
    const token = await decryptToken(keyring(o.env), st.enc, st.keyVersion, linkWatchId(st.hash));
    const r = await finishNewLink(o.env, await o.budgetId(), token, now);
    if (r.status === 'linked') {
      await o.queueFetch();
      return { state: { ...st, connectionId: r.connectionId }, runAt: now + KEEP_DONE_MS };
    }
    if (r.status !== 'waiting') return over();
    return {
      state: st,
      runAt: now + (now - st.startedAt < 30 * 60_000 ? WATCH_EVERY_MS : WATCH_LATER_MS),
    };
  };
}
