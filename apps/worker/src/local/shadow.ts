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
import { dailyScan } from '../daily-scan.js';
import type { InboxRun, InboxScan } from '../store/inbox.js';
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

/** What the device does beside the server: files a bank update, or runs a daily scan. */
export type ShadowEvent = { run: InboxRun } | { scan: InboxScan };

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

/**
 * Makes a copy ready to file bank updates. A phone's copy has no bank log and no event counter (neither is
 * synced), but filing numbers each new bank event from the counter and processes the events past the budget's
 * watermark. The counter continues from the watermark, as on a server that has filed everything so far.
 */
export async function alignCounter(db: Db, budgetId: string): Promise<void> {
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO apply_counter (id, seq) VALUES (1, 0)`),
    db
      .prepare(
        `UPDATE apply_counter SET seq = max(seq, coalesce((SELECT processed_through FROM budget WHERE id = ?1), 0)) WHERE id = 1`,
      )
      .bind(budgetId),
  ]);
}

export class Shadow {
  private next = 0;
  private failed = false;
  private runs: readonly ShadowEvent[] = [];

  private constructor(
    private readonly scratch: Db,
    private readonly budgetId: string,
    private readonly close: () => void,
  ) {}

  /**
   * The scratch copy, made now: call it before the server's rows for newer bank updates are written into the real
   * copy. Local and quick; the updates themselves are fetched later (`begin`).
   */
  static async fork(main: Db, budgetId: string, fork: () => Promise<Fork>): Promise<Shadow> {
    void main;
    const f = await fork();
    await alignCounter(f.db, budgetId);
    return new Shadow(f.db, budgetId, f.close ?? (() => undefined));
  }

  /**
   * The updates to file (in inbox order). Null: ready to step. A report: a comparison would say nothing, and why.
   */
  async begin(runs: readonly ShadowEvent[]): Promise<ShadowReport | null> {
    const skip = (why: ShadowReport['why']): ShadowReport => ({
      runs: 0,
      compared: false,
      why,
      differences: [],
    });
    if (!runs.length) return skip('failed');
    // The scratch copy is what the server had when it began the first of these, and nothing else happened since:
    // each begins at the data version the one before it ended at. A bank update leaves the version as it is; a
    // scan moves it by one.
    let v = await version(this.scratch, this.budgetId);
    for (const [i, e] of runs.entries()) {
      const { baseVersion, endVersion } = 'run' in e ? e.run : e.scan;
      if (baseVersion !== v) return skip(i === 0 ? 'edited_before' : 'edited_during');
      if (endVersion !== baseVersion + ('run' in e ? 0 : 1)) return skip('edited_during');
      v = endVersion;
    }
    this.runs = runs;
    return null;
  }

  /** Files the next update on the scratch copy; false when none is left. One update a call, so the app stays live. */
  async step(): Promise<boolean> {
    const run = this.runs[this.next];
    if (!run || this.failed) return false;
    try {
      const env = { DB: this.scratch } as Env;
      if ('run' in run) await fileRun(env, this.budgetId, run.run, reader);
      else await dailyScan(env, this.budgetId, run.scan.at);
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
    if (this.failed || !this.runs.length || this.next < this.runs.length) return { ...report, why: 'failed' };
    // An edit or a daily job after the last update is in the real copy and not in the scratch one.
    const last = this.runs[this.runs.length - 1]!;
    if ((await version(main, this.budgetId)) !== ('run' in last ? last.run : last.scan).endVersion)
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
