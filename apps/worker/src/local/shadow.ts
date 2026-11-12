// The shadow run (docs/privacy.md phase 4): the device files the bank updates of the inbox itself, beside the
// server, and the two results are compared exactly. It files on a scratch copy of the budget, made just before
// the server's rows for those updates are written into the real copy; the real copy only ever takes the
// server's rows, as today. When both are done the scratch copy is compared with the real one, and thrown away.
//
// A comparison means something only when the device began where the server began and nothing but the updates
// happened: `budget.data_version` moves with every edit and daily job and never with bank filing, and each update
// in the inbox carries that number from when the server began and ended filing it.
import { PlaidProvider } from '@ledgerline/bank-provider';
import type { Db, Stmt } from '@ledgerline/db/sql';
import type { Env } from '../env.js';
import type { InboxRun } from '../store/inbox.js';
import { SYNC_TABLES } from '../sync-tables.js';
import { fileRun } from './file-run.js';

export interface ShadowReport {
  /** Updates the device filed. */
  runs: number;
  /** False: the result says nothing, for the reason in `why`. */
  compared: boolean;
  /** `incomplete`: the app couldn't get every update of the inbox (set by the app, apps/web/src/copy). */
  why?: 'edited_before' | 'edited_during' | 'edited_after' | 'failed' | 'incomplete';
  /** Where the device's rows differ from the server's: a table, a column (or `row` for a missing one), a count. */
  differences: { table: string; column: string; rows: number }[];
}

/** Reads a bank page (`parsePage`); it never calls the bank. */
const reader = new PlaidProvider({ clientId: 'device', secret: 'device', env: 'sandbox' });

/**
 * What filing on a device doesn't write, or writes from its own clock: the fetch state of a link (the server's
 * alone, 5.5), and what a copy works out or counts for itself.
 */
const NOT_COMPARED: Record<string, readonly string[]> = {
  connection: ['status', 'last_synced_at', 'last_attempt_at', 'error_code', 'updated_at', 'resync_requested'],
  budget: ['updated_at', 'data_version', 'rta', 'summary_version', 'summary_month', 'summary_dirty_from'],
};

const version = async (db: Db, budgetId: string): Promise<number | null> =>
  (
    await db
      .prepare(`SELECT data_version AS v FROM budget WHERE id = ?1`)
      .bind(budgetId)
      .first<{ v: number }>()
  )?.v ?? null;

/** A whole copy of `src` in `dst` (an empty database with the same tables). The slow, plain way; sql.js copies bytes. */
export async function copyDb(src: Db, dst: Db): Promise<void> {
  const tables = (
    await src
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
           AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name != '_migrations' AND name != 'edit_change'`,
      )
      .all<{ name: string }>()
  ).results.map((t) => t.name);
  const stmts: Stmt[] = [dst.prepare(`PRAGMA defer_foreign_keys = ON`)];
  for (const t of tables) {
    stmts.push(dst.prepare(`DELETE FROM ${t} WHERE ${t === 'bank_event' || t === 'bank_page' ? '0' : '1'}`));
    const rows = (await src.prepare(`SELECT * FROM ${t}`).all<Record<string, unknown>>()).results;
    for (const r of rows) {
      const cols = Object.keys(r);
      stmts.push(
        dst
          .prepare(
            `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')})`,
          )
          .bind(...cols.map((c) => r[c])),
      );
    }
  }
  await dst.batch(stmts);
}

/** A scratch copy of the budget, and how to free it. */
export interface Fork {
  db: Db;
  close?: () => void;
}

export class Shadow {
  private next = 0;
  private failed = false;

  private constructor(
    private readonly scratch: Db,
    private readonly budgetId: string,
    private readonly runs: readonly InboxRun[],
    private readonly close: () => void,
  ) {}

  /**
   * Starts a shadow run for these updates (in inbox order), or says why not. Call it before the server's rows for
   * them are written into the copy.
   */
  static async begin(
    main: Db,
    budgetId: string,
    runs: readonly InboxRun[],
    fork: () => Promise<Fork>,
  ): Promise<Shadow | ShadowReport> {
    const skip = (why: ShadowReport['why']): ShadowReport => ({
      runs: 0,
      compared: false,
      why,
      differences: [],
    });
    if (!runs.length) return skip('failed');
    // The copy is what the server had when it began the first update, and nothing but the updates happened since.
    if ((await version(main, budgetId)) !== runs[0]!.baseVersion) return skip('edited_before');
    for (let i = 0; i < runs.length; i++) {
      if (runs[i]!.baseVersion !== runs[i]!.endVersion) return skip('edited_during');
      if (i > 0 && runs[i]!.baseVersion !== runs[i - 1]!.endVersion) return skip('edited_during');
    }
    const f = await fork();
    return new Shadow(f.db, budgetId, runs, f.close ?? (() => undefined));
  }

  /** Files the next update on the scratch copy; false when none is left. One update a call, so the app stays live. */
  async step(): Promise<boolean> {
    const run = this.runs[this.next];
    if (!run || this.failed) return false;
    try {
      await fileRun({ DB: this.scratch } as Env, this.budgetId, run, reader);
    } catch {
      this.failed = true;
      return false;
    }
    this.next++;
    return this.next < this.runs.length;
  }

  /** Frees the scratch copy without comparing. */
  discard(): void {
    this.close();
  }

  /** Compares the scratch copy with the real one, which holds the server's rows for the updates by now. */
  async end(main: Db): Promise<ShadowReport> {
    try {
      return await this.compare(main);
    } finally {
      this.close();
    }
  }

  private async compare(main: Db): Promise<ShadowReport> {
    const report: ShadowReport = { runs: this.next, compared: false, differences: [] };
    if (this.failed || this.next < this.runs.length) return { ...report, why: 'failed' };
    // An edit or a daily job after the last update is in the real copy and not in the scratch one.
    if ((await version(main, this.budgetId)) !== this.runs[this.runs.length - 1]!.endVersion)
      return { ...report, why: 'edited_after' };
    const count = new Map<string, number>();
    const note = (table: string, column: string) =>
      count.set(`${table}\u0000${column}`, (count.get(`${table}\u0000${column}`) ?? 0) + 1);
    for (const t of SYNC_TABLES) {
      const skip = new Set([...(t.omit ?? []), ...(NOT_COMPARED[t.name] ?? [])]);
      const read = async (db: Db) => {
        const rows = (await db.prepare(`SELECT * FROM ${t.name}`).all<Record<string, unknown>>()).results;
        return new Map(rows.map((r) => [JSON.stringify(t.pk.map((k) => r[k])), r]));
      };
      const [mine, theirs] = [await read(this.scratch), await read(main)];
      for (const [k, r] of mine) {
        const o = theirs.get(k);
        if (!o) note(t.name, 'row: only on the device');
        else
          for (const c of Object.keys(r))
            if (!skip.has(c) && JSON.stringify(r[c]) !== JSON.stringify(o[c])) note(t.name, c);
      }
      for (const k of theirs.keys()) if (!mine.has(k)) note(t.name, 'row: only on the server');
    }
    report.compared = true;
    report.differences = [...count.entries()].map(([k, rows]) => {
      const [table, column] = k.split('\u0000');
      return { table: table!, column: column!, rows };
    });
    return report;
  }
}
