// Signing in with the recovery key of a locked budget (docs/privacy-keys.md 4.2, "Proving it to the server"). The
// Directory stores only `authPub`, the public half of the Ed25519 pair that comes from the recovery key. A
// recovery sign-in sends `authPub`; the Directory answers with the budget id and 32 random bytes; the device
// signs "ledgerline/v1/recovery/login" || budgetId || challenge; then the device makes a new passkey, as a
// recovery code does for a budget that is not locked (routes/signup.ts). Nothing the server sees could be used
// again, and none of it is part of the budget key.
//
// Not behind the sign-up switch: the key is 32 random bytes, so there is nothing to guess, and the owner (an
// admin, who has no recovery code) needs it too.
import type { Stmt } from '@ledgerline/db/sql';
import { ACTION, fromHex, toHex, verifyRecoveryLogin } from '@ledgerline/seal';
import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { AppEnv } from '../http/context.js';
import { CHALLENGE_COOKIE, CHALLENGE_MS, cookie, readCookie } from '../http/auth.js';
import { openChallenge, sealChallenge } from '../http/challenge.js';
import { clock, requestNow } from '../http/clock.js';
import { z } from 'zod';
import { parseBody } from '../http/body.js';
import { csrf } from '../http/security.js';
import { directorySigned } from '../http/signed-request.js';
import { OWNER_HANDLE, RP_NAME, registrationOptions } from './passkey-options.js';
import { NOTICE_MS } from './signup.js';
import { TRY_AGAIN } from '../http/errors.js';

const HEX32 = /^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{128}$/;
/** The recovery key's public half (`authPub`), hex. */
const AuthPub = z.object({ authPub: z.string().regex(HEX32) });
const fail = (message: string) => ({ error: 'auth', message });
const NOT_SET = 'This recovery key can’t sign in. Check it, or sign in with a passkey.';
const TOO_LONG = 'That took too long. Try again.';

/** The grant a recovery-key sign-in gives the passkey ceremony that follows (routes/auth.ts register/verify). */
export const RECOVERY_KEY_GRANT = 'recovery_key';

async function owner(env: Env, authPub: string) {
  return env.DB.prepare(
    `SELECT k.user_id, m.budget_id, u.webauthn_handle, u.display_name FROM recovery_key k
     JOIN user u ON u.id = k.user_id JOIN budget_member m ON m.user_id = k.user_id
     WHERE k.auth_pub = ?1 AND u.status = 'active' LIMIT 1`,
  )
    .bind(authPub)
    .first<{
      user_id: string;
      budget_id: string;
      webauthn_handle: string | null;
      display_name: string | null;
    }>();
}

export const recoveryKeyAuth = new Hono<AppEnv>();
recoveryKeyAuth.use('*', csrf);

/** Step 1: the recovery key's public half. Answers the budget id and a challenge to sign; writes nothing. */
recoveryKeyAuth.post('/recover-key/options', async (c) => {
  const env = c.env;
  const now = clock(env);
  const b = await parseBody(c.req, AuthPub);
  if (!b) return c.json(fail(NOT_SET), 403);
  const { authPub } = b;
  const u = await owner(env, authPub);
  if (!u) return c.json(fail(NOT_SET), 403);
  const challenge = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const id = await sealChallenge(env, now, challenge, 'recovery', { kind: RECOVERY_KEY_GRANT, ref: authPub });
  c.header('set-cookie', cookie(CHALLENGE_COOKIE, id, CHALLENGE_MS));
  return c.json({ budgetId: u.budget_id, challenge });
});

/**
 * Step 2: the signature. A good one is used once (used_challenge) and gives the options for a new passkey, for
 * this key's user only; register/verify then adds it and signs in.
 */
recoveryKeyAuth.post('/recover-key/verify', async (c) => {
  const env = c.env;
  const now = clock(env);
  const b = await parseBody(c.req, z.object({ signature: z.string().regex(HEX64) }));
  const ch = await openChallenge(env, readCookie(c.req.raw, CHALLENGE_COOKIE), 'recovery', now);
  if (!ch || ch.grant_kind !== RECOVERY_KEY_GRANT || !ch.grant_ref) return c.json(fail(TOO_LONG), 400);
  if (await env.DB.prepare(`SELECT 1 AS u FROM used_challenge WHERE id = ?1`).bind(ch.id).first())
    return c.json(fail(TOO_LONG), 400);
  const u = await owner(env, ch.grant_ref);
  if (!u || !b) return c.json(fail(NOT_SET), 403);
  const { signature } = b;
  const good = await verifyRecoveryLogin(
    fromHex(ch.grant_ref),
    u.budget_id,
    fromHex(ch.challenge),
    fromHex(signature),
  ).catch(() => false);
  if (!good) return c.json(fail(NOT_SET), 403);
  try {
    await env.DB.prepare(`INSERT INTO used_challenge (id, used_at) VALUES (?1, ?2)`).bind(ch.id, now).run();
  } catch {
    return c.json(fail(TOO_LONG), 400);
  }
  const existing = await env.DB.prepare(`SELECT id, transports FROM passkey WHERE user_id = ?1`)
    .bind(u.user_id)
    .all<{ id: string; transports: string | null }>();
  const options = await registrationOptions({
    url: c.req.url,
    env,
    handle: u.webauthn_handle ?? OWNER_HANDLE,
    label: u.display_name ?? RP_NAME,
    existing: existing.results,
  });
  const id = await sealChallenge(env, now, options.challenge, 'register', {
    kind: RECOVERY_KEY_GRANT,
    ref: ch.grant_ref,
  });
  c.header('set-cookie', cookie(CHALLENGE_COOKIE, id, CHALLENGE_MS));
  return c.json(options);
});

/**
 * The new passkey of a recovery-key sign-in (register/verify), in one batch with the challenge's use: added only
 * while the key still names an active user. `passkey` is the insert's values for (id, public_key, counter,
 * transports, name, created_at). The last statement changes one row, or the key no longer matches.
 */
export function recoveryKeyStmts(env: Env, authPub: string, passkey: unknown[]): Stmt[] {
  return [
    // When the key signed in, for the notice every other device shows (docs/privacy.md 5.8): kept on the same
    // terms as the passkey below. `passkey[5]` is its created_at, the time of this sign-in.
    env.DB.prepare(
      `INSERT OR REPLACE INTO app_state (key, value, updated_at)
       SELECT ?1 || k.user_id, ?2, ?2 FROM recovery_key k JOIN user u ON u.id = k.user_id
       WHERE k.auth_pub = ?3 AND u.status = 'active'`,
    ).bind(RECOVERY_USED_PREFIX, passkey[5], authPub),
    env.DB.prepare(
      `INSERT INTO passkey (id, public_key, counter, transports, name, created_at, user_id)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, k.user_id FROM recovery_key k JOIN user u ON u.id = k.user_id
       WHERE k.auth_pub = ?7 AND u.status = 'active'`,
    ).bind(...passkey, authPub),
  ];
}

/** The Directory's `app_state` key, with the user's id, for when the recovery key last signed in (store/way-in.ts). */
export const RECOVERY_USED_PREFIX = 'recovery_key_used:';

/**
 * When the recovery key last signed in to this account, for 14 days after (the notice on every device). The
 * notice is dismissed on each device by itself, so the server keeps no dismissal.
 */
export async function recoveryKeyUsed(env: Env, userId: string, now: number): Promise<number | null> {
  const v = await env.DB.prepare(`SELECT value FROM app_state WHERE key = ?1`)
    .bind(RECOVERY_USED_PREFIX + userId)
    .first<string>('value');
  const at = Number(v);
  return v != null && Number.isFinite(at) && at > now - NOTICE_MS ? at : null;
}

// ---- Settings → Sign-in: the key's public half, set from a device that holds the key

export const recoveryKeySettings = new Hono<AppEnv>();

/** Whether this account can sign in with a recovery key, and since when. */
recoveryKeySettings.get('/settings/security/recovery-key', async (c) => {
  const at = await c.env.DB.prepare(`SELECT created_at FROM recovery_key WHERE user_id = ?1`)
    .bind(c.get('userId'))
    .first<number>('created_at');
  return c.json({ set: at != null, setAt: at != null ? new Date(at).toISOString() : null });
});

/**
 * Sets the recovery key's public half (`authPub`, hex): a new one replaces the old, which can't sign in from then
 * on. Needs a recent passkey check (http/auth.ts). The device works it out from the key the person typed or just
 * made; the server can't check it against the budget, so a wrong one only stops this account's own recovery.
 */
recoveryKeySettings.post('/settings/security/recovery-key', async (c) => {
  // A sealed budget's key half is set only by a device that holds the budget's key (docs/privacy-keys.md 11).
  const store = c.env.BUDGET_INFO ? await c.env.BUDGET_INFO(c.get('budgetId')) : null;
  const refused = await directorySigned(c, ACTION.setRecoverySignIn, requestNow(c), store);
  if (refused) return refused;
  const b = await parseBody(c.req, AuthPub);
  if (!b) return c.json({ error: 'invalid', message: TRY_AGAIN }, 400);
  const { authPub } = b;
  try {
    await c.env.DB.prepare(
      `INSERT INTO recovery_key (user_id, auth_pub, created_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (user_id) DO UPDATE SET auth_pub = excluded.auth_pub, created_at = excluded.created_at`,
    )
      .bind(c.get('userId'), authPub, requestNow(c))
      .run();
  } catch (e) {
    // Another account has it: never the case for a key made at random.
    if (/UNIQUE/i.test(String(e))) return c.json({ error: 'invalid', message: TRY_AGAIN }, 409);
    throw e;
  }
  return c.json({ ok: true });
});
