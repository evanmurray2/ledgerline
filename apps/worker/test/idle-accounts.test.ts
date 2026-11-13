// Accounts nobody opens for 24 months (src/store/idle-accounts.ts; docs/privacy.md 5.8): marked at 24 months,
// deleted 30 days later, never an admin's or one turned off, a few a day, and a request in between clears the mark.
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  EXPIRE_GRACE_MS,
  EXPIRE_MS,
  EXPIRE_PER_RUN,
  expireIdle,
  expireKey,
  startDeletionSql,
} from '../src/store/idle-accounts.js';
import type { Directory } from '../src/store/directory.js';

const e = env as unknown as { DIRECTORY: DurableObjectNamespace<Directory> };
const T = Date.parse('2026-11-14T00:00:00Z');

/** A Directory of its own, with the given accounts: one budget each, `seen` days before T. */
async function directory(fn: (sql: SqlStorage) => void) {
  await runInDurableObject(
    e.DIRECTORY.get(e.DIRECTORY.idFromName(`expire-${Math.random()}`)),
    (_o, state) => {
      fn(state.storage.sql);
    },
  );
}
function account(sql: SqlStorage, id: string, o: { seen: number | null; admin?: boolean; status?: string }) {
  sql.exec(`INSERT INTO budget (id, name, created_at, updated_at) VALUES (?, 'My budget', 0, 0)`, `b-${id}`);
  sql.exec(
    `INSERT INTO user (id, email, created_at, updated_at, is_admin, status, last_seen_at) VALUES (?, ?, 0, 0, ?, ?, ?)`,
    id,
    `${id}@example.com`,
    o.admin ? 1 : 0,
    o.status ?? 'active',
    o.seen,
  );
  sql.exec(
    `INSERT INTO budget_member (budget_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'owner', 0, 0)`,
    `b-${id}`,
    id,
  );
}
const marks = (sql: SqlStorage) =>
  sql
    .exec(`SELECT key FROM app_state WHERE key LIKE 'expire:%' ORDER BY key`)
    .toArray()
    .map((r) => String(r.key));

describe('accounts nobody opens for 24 months', () => {
  it('marks them, clears a mark on return, and starts a few deletions 30 days after the mark', async () => {
    await directory((sql) => {
      const old = T - EXPIRE_MS - 86_400_000;
      account(sql, 'u1', { seen: old });
      account(sql, 'u2', { seen: old });
      account(sql, 'u3', { seen: T - 86_400_000 });
      account(sql, 'admin', { seen: old, admin: true });
      account(sql, 'off', { seen: old, status: 'disabled' });
      // Never seen: the account's creation counts (0 here, long ago).
      account(sql, 'never', { seen: null });
      for (let i = 0; i < EXPIRE_PER_RUN; i++) account(sql, `x${i}`, { seen: old });

      const first = expireIdle(sql, T);
      expect(first.start).toEqual([]);
      expect(marks(sql)).toEqual(
        ['never', 'u1', 'u2', 'x0', 'x1', 'x2'].map((u) => expireKey(`b-${u}`)).sort(),
      );
      // u2 comes back: its mark goes.
      sql.exec(`UPDATE user SET last_seen_at = ? WHERE id = 'u2'`, T + 86_400_000);
      expect(expireIdle(sql, T + 2 * 86_400_000)).toMatchObject({ cleared: 1, start: [] });
      // 30 days after the mark: at most a few deletions start in one run.
      const later = expireIdle(sql, T + EXPIRE_GRACE_MS + 86_400_000);
      expect(later.start).toHaveLength(EXPIRE_PER_RUN);
      for (const d of later.start) expect(d.userIds).toHaveLength(1);
      // The deletion's first step marks the budget deleting; the next run leaves it to the delete job.
      for (const d of later.start)
        for (const [q, p] of startDeletionSql(d.budgetId, d.userIds, T))
          sql.exec(q, ...(p as SqlStorageValue[]));
      const next = expireIdle(sql, T + EXPIRE_GRACE_MS + 2 * 86_400_000);
      expect(next.again).toHaveLength(EXPIRE_PER_RUN);
      expect(next.start.map((d) => d.budgetId).some((b) => later.start.some((l) => l.budgetId === b))).toBe(
        false,
      );
      // Neither the admin's account nor one turned off was ever marked.
      expect(marks(sql)).not.toContain(expireKey('b-admin'));
      expect(marks(sql)).not.toContain(expireKey('b-off'));
      expect(sql.exec(`SELECT status FROM user WHERE id = 'admin'`).one().status).toBe('active');
    });
  });
});
