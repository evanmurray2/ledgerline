// Phase 1 go/no-go: the fences must roll back the whole D1 batch in every non-holding case.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  acquire,
  conditionFence,
  isFenceAbort,
  leaseFence,
  LEASE_TTL_MS,
  releaseFailed,
  releaseSuccess,
} from '../src/sync/lease.js';

const db = env.DB;
const NOW = 1_800_000_000_000;

async function seed(): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM connection`),
    db.prepare(`DELETE FROM budget`),
    db.prepare(`DELETE FROM lease_guard`),
    db.prepare(`DELETE FROM setting`),
    db.prepare(
      `INSERT INTO budget (id, name, processed_through, created_at, updated_at) VALUES ('b1', 'B', 10, 0, 0)`,
    ),
    db.prepare(
      `INSERT INTO connection (id, budget_id, provider, institution_name, linked_at, created_at, updated_at)
       VALUES ('c1', 'b1', 'fake', 'Bank', 0, 0, 0)`,
    ),
  ]);
}

/** A stand-in for an apply batch: fence first, then a write that must not survive a failed fence. */
async function applyBatch(holder: string, now: number): Promise<'committed' | 'rolled back'> {
  try {
    await db.batch([
      leaseFence(db, 'c1', holder, now),
      db.prepare(`INSERT INTO setting (budget_id, key, value, updated_at) VALUES ('b1', 'probe', '1', 0)`),
    ]);
    return 'committed';
  } catch (e) {
    expect(isFenceAbort(e)).toBe(true);
    const row = await db
      .prepare(`SELECT count(*) AS n FROM setting WHERE key = 'probe'`)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
    return 'rolled back';
  }
}

describe('lease fence', () => {
  beforeEach(seed);

  it('commits while the run holds an unexpired lease', async () => {
    expect(await acquire(db, 'c1', 'run-a', NOW)).toBe(true);
    expect(await applyBatch('run-a', NOW + 1000)).toBe('committed');
  });

  it('rolls back when the lease was released', async () => {
    await acquire(db, 'c1', 'run-a', NOW);
    expect(await releaseSuccess(db, 'c1', 'run-a')).toBe(true);
    expect(await applyBatch('run-a', NOW + 1000)).toBe('rolled back');
  });

  it('rolls back when the lease expired', async () => {
    await acquire(db, 'c1', 'run-a', NOW);
    expect(await applyBatch('run-a', NOW + LEASE_TTL_MS + 1)).toBe('rolled back');
  });

  it('rolls back when another run holds the lease', async () => {
    await acquire(db, 'c1', 'run-a', NOW);
    // run-a's lease expires and run-b takes over.
    expect(await acquire(db, 'c1', 'run-b', NOW + LEASE_TTL_MS + 1)).toBe(true);
    expect(await applyBatch('run-a', NOW + LEASE_TTL_MS + 2)).toBe('rolled back');
    expect(await applyBatch('run-b', NOW + LEASE_TTL_MS + 2)).toBe('committed');
  });

  it('rolls back when the lease has no expiry', async () => {
    await acquire(db, 'c1', 'run-a', NOW);
    await db.prepare(`UPDATE connection SET lock_expires = NULL WHERE id = 'c1'`).run();
    expect(await applyBatch('run-a', NOW + 1000)).toBe('rolled back');
  });

  it('rolls back when the connection row is missing', async () => {
    await acquire(db, 'c1', 'run-a', NOW);
    await db.prepare(`DELETE FROM connection WHERE id = 'c1'`).run();
    expect(await applyBatch('run-a', NOW + 1000)).toBe('rolled back');
  });

  it('rolls back after a failed run released the lease, and keeps the request flag', async () => {
    await acquire(db, 'c1', 'run-a', NOW);
    await releaseFailed(db, 'c1', 'run-a');
    expect(await applyBatch('run-a', NOW + 1000)).toBe('rolled back');
    const c = await db
      .prepare(`SELECT resync_requested FROM connection WHERE id = 'c1'`)
      .first<{ resync_requested: number }>();
    expect(c?.resync_requested).toBe(1);
  });

  it('lease_guard.ok has no default and rejects 0 and NULL', async () => {
    await expect(db.prepare(`INSERT OR REPLACE INTO lease_guard (id) VALUES (1)`).run()).rejects.toThrow();
    await expect(
      db.prepare(`INSERT OR REPLACE INTO lease_guard (id, ok) VALUES (1, 0)`).run(),
    ).rejects.toThrow();
  });
});

describe('watermark fence', () => {
  beforeEach(seed);

  async function processBatch(expected: number): Promise<'committed' | 'rolled back'> {
    try {
      await db.batch([
        conditionFence(db, `SELECT processed_through = ?1 FROM budget WHERE id = ?2`, expected, 'b1'),
        db.prepare(`UPDATE budget SET processed_through = ?1 WHERE id = 'b1'`).bind(expected + 5),
      ]);
      return 'committed';
    } catch (e) {
      expect(isFenceAbort(e)).toBe(true);
      return 'rolled back';
    }
  }

  it('commits against the watermark it read', async () => {
    expect(await processBatch(10)).toBe('committed');
  });

  it('rolls back when another processor moved the watermark', async () => {
    expect(await processBatch(10)).toBe('committed'); // now 15
    expect(await processBatch(10)).toBe('rolled back');
    const b = await db
      .prepare(`SELECT processed_through AS p FROM budget WHERE id = 'b1'`)
      .first<{ p: number }>();
    expect(b?.p).toBe(15);
  });
});

describe('bank_event is append-only', () => {
  it('rejects UPDATE and DELETE', async () => {
    await db
      .prepare(
        `INSERT INTO bank_event (id, budget_id, connection_id, sync_run_id, page, position, apply_seq, kind, provider_txn_id,
           payload, raw_ref, sha256, created_at) VALUES (1, 'b1', 'c1', 'r', 0, 0, 1, 'added', 't', '{}', 'k#added/0', 'h', 0)`,
      )
      .run();
    await expect(db.prepare(`UPDATE bank_event SET kind = 'removed' WHERE id = 1`).run()).rejects.toThrow(
      /append-only/,
    );
    await expect(db.prepare(`DELETE FROM bank_event WHERE id = 1`).run()).rejects.toThrow(/append-only/);
  });
});
