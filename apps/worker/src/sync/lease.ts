// Connection lease (Sync spec: Connection lease). All SQL is parameterized; every statement is scoped by id.
import type { Db, Stmt } from '@ledgerline/db/sql';

export const LEASE_TTL_MS = 90 * 60 * 1000;
export const MAX_HANDOFFS = 3;
export const MAX_FETCH_RESTARTS = 3;

/** A fence statement: the whole batch aborts unless `ok` evaluates to 1. */
export function leaseFence(db: Db, connectionId: string, holder: string, now: number): Stmt {
  return db
    .prepare(
      `INSERT OR REPLACE INTO lease_guard (id, ok)
       VALUES (1, coalesce((SELECT sync_lock = ?1 AND lock_expires > ?2 AND removed_at IS NULL FROM connection WHERE id = ?3), 0))`,
    )
    .bind(holder, now, connectionId);
}

/** Generic guard on an arbitrary scalar condition (watermark, summary version, applied_through). */
export function conditionFence(db: Db, sqlScalar: string, ...params: unknown[]): Stmt {
  return db
    .prepare(`INSERT OR REPLACE INTO lease_guard (id, ok) VALUES (1, coalesce((${sqlScalar}), 0))`)
    .bind(...params);
}

export function isFenceAbort(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /CHECK constraint failed/i.test(m) && /ok = 1|lease_guard/i.test(m);
}

export async function requestSync(db: Db, connectionId: string, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE connection SET resync_requested = 1, updated_at = ?2 WHERE id = ?1 AND removed_at IS NULL`,
    )
    .bind(connectionId, now)
    .run();
}

/** Returns true when this run now holds the lease. Acquiring clears the request flag. */
export async function acquire(db: Db, connectionId: string, runId: string, now: number): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE connection SET sync_lock = ?1, lock_expires = ?2, resync_requested = 0, updated_at = ?3
       WHERE id = ?4 AND removed_at IS NULL AND (sync_lock IS NULL OR lock_expires IS NULL OR lock_expires < ?3)`,
    )
    .bind(runId, now + LEASE_TTL_MS, now, connectionId)
    .run();
  return r.changes === 1;
}

/** Every step starts here. Accepts the next holder during a hand-off. A removed connection's lease can't be renewed. */
export async function renew(
  db: Db,
  connectionId: string,
  holder: string,
  now: number,
  alsoAccept?: string,
): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE connection SET lock_expires = max(coalesce(lock_expires, 0), ?1)
       WHERE id = ?2 AND removed_at IS NULL AND sync_lock IN (?3, ?4)`,
    )
    .bind(now + LEASE_TTL_MS, connectionId, holder, alsoAccept ?? holder)
    .run();
  return r.changes === 1;
}

/** Before sleeping for the write budget: keep the lease past the wake time. */
export async function extendForSleep(
  db: Db,
  connectionId: string,
  holder: string,
  wakeAt: number,
): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE connection SET lock_expires = ?1 WHERE id = ?2 AND sync_lock = ?3`)
    .bind(wakeAt + LEASE_TTL_MS, connectionId, holder)
    .run();
  return r.changes === 1;
}

/** Successful release: only when no request arrived mid-run. Returns false when a hand-off is needed. */
export async function releaseSuccess(db: Db, connectionId: string, holder: string): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE connection SET sync_lock = NULL, lock_expires = NULL
       WHERE id = ?1 AND sync_lock = ?2 AND resync_requested = 0`,
    )
    .bind(connectionId, holder)
    .run();
  return r.changes === 1;
}

/** Failed release: leaves resync_requested for the next cron, so a failing run never hands off to itself. */
export async function releaseFailed(db: Db, connectionId: string, holder: string): Promise<void> {
  await db
    .prepare(
      `UPDATE connection SET sync_lock = NULL, lock_expires = NULL, resync_requested = 1 WHERE id = ?1 AND sync_lock = ?2`,
    )
    .bind(connectionId, holder)
    .run();
}

/** Hand-off step 2: move the lease to the next instance. */
export async function moveLease(
  db: Db,
  connectionId: string,
  from: string,
  to: string,
  now: number,
): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE connection SET sync_lock = ?1, lock_expires = ?2, resync_requested = 0
       WHERE id = ?3 AND sync_lock = ?4`,
    )
    .bind(to, now + LEASE_TTL_MS, connectionId, from)
    .run();
  return r.changes === 1;
}
