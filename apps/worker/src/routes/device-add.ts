// Adding a device with its own passkey to a locked budget (docs/privacy-keys.md section 10): the server's part is
// a relay for the messages between the signed-in device ("from") and the new one ("to"). It sees only what
// section 10 lets it see: the commitment, the offer and the reveal (public values), the budget key sealed to the
// new device's one-time key, and the confirmation. It never sees a secret, and it checks none of the arithmetic:
// the two devices do (packages/seal device-add.ts). What the relay keeps to is who may send what, and when:
//
// - The signed-in device starts it, after a recent passkey check (every POST here is under settings/security,
//   http/auth.ts needsRecentPasskey). One add per user; a new start replaces the one before.
// - The new device is another sign-in of the same user, made after the start (the device link's sign-in). The
//   first commitment it sends ties the add to that sign-in; no other sign-in can take part after that.
// - Each message is written once, in order: commitment, offer, reveal, sealed key, confirmation. A new
//   commitment (the person asked for a new try on the new device) clears the offer and the reveal, and the
//   signed-in device makes at most 3 offers per start, as it keeps itself.
// - It lasts 10 minutes from the start, and the row goes once either device ends it, or with the expired sign-in
//   state (store/directory.ts pruneAuthStmts).
import {
  ADD_ATTEMPTS,
  ADD_COMMIT_LEN,
  ADD_CONFIRM_LEN,
  ADD_CONFIRM_MAX,
  ADD_OFFER_LEN,
  ADD_REVEAL_LEN,
  ADD_SEALED_LEN,
  ADD_WINDOW_MS,
} from '@ledgerline/seal';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../http/context.js';
import { requestNow } from '../http/clock.js';
import { bodyObject } from '../http/security.js';

export const deviceAddRoutes = new Hono<AppEnv>();

const BASE = '/settings/security/device-add';
const GONE = 'This add ended. Start again from the signed-in device.';

const hexOf = (len: number) => new RegExp(`^[0-9a-f]{${len * 2}}$`);
const COMMIT = hexOf(ADD_COMMIT_LEN);
const OFFER = hexOf(ADD_OFFER_LEN);
const REVEAL = hexOf(ADD_REVEAL_LEN);
const SEALED = hexOf(ADD_SEALED_LEN);
/** The confirmation: its MAC, then the new device's slot id (section 10); the devices check both. */
const CONFIRM = new RegExp(`^(?:[0-9a-f]{2}){${ADD_CONFIRM_LEN + 1},${ADD_CONFIRM_MAX}}$`);

interface Row {
  budget_id: string;
  from_session: string;
  to_session: string | null;
  created_at: number;
  expires_at: number;
  offers: number;
  commit_hex: string | null;
  offer_hex: string | null;
  reveal_hex: string | null;
  sealed_hex: string | null;
  confirm_hex: string | null;
}

const field = async (c: Context<AppEnv>, name: string, re: RegExp): Promise<string | null> => {
  const v = (await bodyObject(c.req))[name];
  return typeof v === 'string' && re.test(v) ? v : null;
};

const bad = (c: Context<AppEnv>) =>
  c.json({ error: 'invalid', message: 'Something went wrong. Try again.' }, 400);
const gone = (c: Context<AppEnv>) => c.json({ error: 'gone', message: GONE }, 409);

/** Runs one guarded write; one row changed, or the add is not at that step (or not this sign-in's). */
async function step(c: Context<AppEnv>, sql: string, ...args: unknown[]) {
  const r = await c.env.DB.prepare(sql)
    .bind(c.get('userId'), c.get('budgetId'), c.get('sessionId'), requestNow(c), ...args)
    .run();
  return r.changes === 1 ? c.json({ ok: true }) : gone(c);
}
/** The guard every write shares: ?1 user, ?2 budget, ?3 this sign-in, ?4 now. */
const LIVE = `user_id = ?1 AND budget_id = ?2 AND expires_at > ?4`;

/** The signed-in device starts an add. A start before it, by any sign-in, ends. */
deviceAddRoutes.post(`${BASE}/start`, async (c) => {
  const now = requestNow(c);
  if (!c.get('sessionId')) return bad(c);
  await c.env.DB.prepare(
    `INSERT INTO device_add (user_id, budget_id, from_session, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (user_id) DO UPDATE SET budget_id = excluded.budget_id, from_session = excluded.from_session,
       to_session = NULL, created_at = excluded.created_at, expires_at = excluded.expires_at, offers = 0,
       commit_hex = NULL, offer_hex = NULL, reveal_hex = NULL, sealed_hex = NULL, confirm_hex = NULL`,
  )
    .bind(c.get('userId'), c.get('budgetId'), c.get('sessionId'), now, now + ADD_WINDOW_MS)
    .run();
  return c.json({ expiresAt: new Date(now + ADD_WINDOW_MS).toISOString() });
});

/**
 * Where the add stands, for the sign-in asking: the signed-in device sees what the new one sent, and the new one
 * what the signed-in one sent. `waiting`: a sign-in that may still join it as the new device (none has yet).
 */
deviceAddRoutes.get(BASE, async (c) => {
  const now = requestNow(c);
  const me = c.get('sessionId');
  const r = await c.env.DB.prepare(`SELECT * FROM device_add WHERE user_id = ?1 AND budget_id = ?2`)
    .bind(c.get('userId'), c.get('budgetId'))
    .first<Row>();
  if (!r || r.expires_at <= now || !me) return c.json({ role: null });
  const expiresAt = new Date(r.expires_at).toISOString();
  if (r.from_session === me)
    return c.json({
      role: 'from',
      expiresAt,
      offers: r.offers,
      commit: r.commit_hex,
      reveal: r.reveal_hex,
      confirm: r.confirm_hex,
    });
  if (r.to_session === me) return c.json({ role: 'to', expiresAt, offer: r.offer_hex, sealed: r.sealed_hex });
  if (r.to_session === null && r.sealed_hex === null) {
    const at = await c.env.DB.prepare(`SELECT created_at FROM auth_session WHERE id = ?1`)
      .bind(me)
      .first<number>('created_at');
    if (at != null && at >= r.created_at) return c.json({ role: 'waiting', expiresAt });
  }
  return c.json({ role: null });
});

/**
 * The new device's commitment (step 1). The first one ties the add to this sign-in, which must be another sign-in
 * of the same user, made after the start. A later one is a new try: the offer and the reveal are cleared.
 */
deviceAddRoutes.post(`${BASE}/commit`, async (c) => {
  const commit = await field(c, 'commit', COMMIT);
  if (!commit || !c.get('sessionId')) return bad(c);
  return step(
    c,
    `UPDATE device_add SET to_session = ?3, commit_hex = ?5, offer_hex = NULL, reveal_hex = NULL
     WHERE ${LIVE} AND from_session != ?3 AND (to_session IS NULL OR to_session = ?3) AND sealed_hex IS NULL
       AND offers < ${ADD_ATTEMPTS}
       AND (SELECT s.created_at FROM auth_session s WHERE s.id = ?3) >= device_add.created_at`,
    commit,
  );
});

/** The signed-in device's offer (step 2), for the commitment it holds; at most 3 per start. */
deviceAddRoutes.post(`${BASE}/offer`, async (c) => {
  const b = await bodyObject(c.req);
  const commit = typeof b.commit === 'string' && COMMIT.test(b.commit) ? b.commit : null;
  const offer = typeof b.offer === 'string' && OFFER.test(b.offer) ? b.offer : null;
  if (!commit || !offer) return bad(c);
  return step(
    c,
    `UPDATE device_add SET offer_hex = ?6, offers = offers + 1
     WHERE ${LIVE} AND from_session = ?3 AND commit_hex = ?5 AND offer_hex IS NULL AND sealed_hex IS NULL
       AND offers < ${ADD_ATTEMPTS}`,
    commit,
    offer,
  );
});

/** The new device's reveal (step 3), once, for the offer in force. */
deviceAddRoutes.post(`${BASE}/reveal`, async (c) => {
  const reveal = await field(c, 'reveal', REVEAL);
  if (!reveal) return bad(c);
  return step(
    c,
    `UPDATE device_add SET reveal_hex = ?5
     WHERE ${LIVE} AND to_session = ?3 AND offer_hex IS NOT NULL AND reveal_hex IS NULL`,
    reveal,
  );
});

/** The budget key sealed to the new device (step 4), once, after the person confirmed the code on this device. */
deviceAddRoutes.post(`${BASE}/sealed`, async (c) => {
  const sealed = await field(c, 'sealed', SEALED);
  if (!sealed) return bad(c);
  return step(
    c,
    `UPDATE device_add SET sealed_hex = ?5
     WHERE ${LIVE} AND from_session = ?3 AND reveal_hex IS NOT NULL AND sealed_hex IS NULL`,
    sealed,
  );
});

/** The new device's confirmation (step 5), once: it names the way in the new device added. */
deviceAddRoutes.post(`${BASE}/confirm`, async (c) => {
  const confirm = await field(c, 'confirm', CONFIRM);
  if (!confirm) return bad(c);
  return step(
    c,
    `UPDATE device_add SET confirm_hex = ?5
     WHERE ${LIVE} AND to_session = ?3 AND sealed_hex IS NOT NULL AND confirm_hex IS NULL`,
    confirm,
  );
});

/** Ends the add, from either device: done, or cancelled. Nothing of it is kept. */
deviceAddRoutes.post(`${BASE}/end`, async (c) => {
  await c.env.DB.prepare(
    `DELETE FROM device_add WHERE user_id = ?1 AND budget_id = ?2 AND (from_session = ?3 OR to_session = ?3)`,
  )
    .bind(c.get('userId'), c.get('budgetId'), c.get('sessionId'))
    .run();
  return c.json({ ok: true });
});
