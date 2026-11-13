// The old bank readers leave a sealed budget alone (docs/privacy.md phase 6): its `connection` table is emptied by
// seal/purge.ts and never read again. Its links live in `bank_link` (seal/sealed-routes.ts, seal/fetch-job.ts).
import type { Db } from '@ledgerline/db/sql';
import { describe, expect, it } from 'vitest';
import { backstopHandler, startSyncJob } from '../src/store/budget-jobs.js';
import type { Job } from '../src/store/jobs.js';
import { storeDb } from './store-db.js';

/** The store's database, refusing any statement that names the old `connection` table. */
const noOldTables = (db: Db): Db =>
  new Proxy(db, {
    get: (t, k) =>
      k === 'prepare'
        ? (sql: string) => {
            if (/\bconnection\b/.test(sql)) throw new Error(`read the old table: ${sql}`);
            return t.prepare(sql);
          }
        : Reflect.get(t, k),
  });

describe('the old bank readers on a sealed budget', () => {
  it('the 4-hour backstop and a started sync read nothing of the old tables', async () => {
    const db = storeDb('sealed-old-readers');
    const queued: string[] = [];
    const enqueue = async (kind: string) => {
      queued.push(kind);
      return kind;
    };
    // Not sealed: the backstop reads `connection`, as before.
    await expect(backstopHandler(noOldTables(db), enqueue)({} as Job, 1000)).rejects.toThrow('old table');
    await db.prepare(`INSERT INTO store_mark (key, at) VALUES ('sealed', 1)`).run();
    expect(await backstopHandler(noOldTables(db), enqueue)({} as Job, 1000)).toEqual({ done: true });
    expect(await startSyncJob(noOldTables(db), enqueue, 'con_1', 'cron', 1000)).toBe(false);
    expect(queued).toEqual([]);
  });
});
