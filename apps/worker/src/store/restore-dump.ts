// Loading a full backup into an empty store, and checking it against the backup's footer (docs/multi-user.md
// 8.7; a runbook step, never a button). BudgetStore.restoreDump and restoreVerify call these.
import type { Db } from '@ledgerline/db/sql';
import {
  BUDGET_TABLES,
  DROPPED_TABLES,
  NO_FILTER,
  chain,
  insertStatements,
  narrowMeta,
  readChunk,
  tableMeta,
} from './dump.js';

/**
 * Loads backup lines (header, rows, footer) into the store. Refused unless the store holds no budget yet, so a
 * live budget can't be overwritten. Call with consecutive pieces of the file; then verifyDump().
 */
export async function loadDumpPiece(
  storage: DurableObjectStorage,
  db: Db,
  lines: string,
): Promise<{ ok: true; rows: number } | { ok: false; reason: string }> {
  // Each piece is checked in full, then written in one transaction: a piece that fails anywhere adds nothing,
  // so the same piece can simply be sent again.
  const rows: { t: string; r: Record<string, unknown> }[] = [];
  let header = false;
  let footer: unknown = undefined;
  for (const line of lines.split('\n')) {
    if (!line.trim()) continue;
    let o: { format?: string; t?: string; r?: Record<string, unknown>; end?: boolean; tables?: unknown };
    try {
      o = JSON.parse(line) as typeof o;
    } catch {
      return { ok: false, reason: 'unreadable line' };
    }
    if (o.format) {
      if (o.format !== 'ledgerline-dump') return { ok: false, reason: 'not a Ledgerline backup' };
      header = true;
      continue;
    }
    if (o.end) {
      footer = o.tables;
      continue;
    }
    // Worked out on the phone, not kept here (migration 0006): the phone works them out again.
    if (o.t && DROPPED_TABLES.includes(o.t)) continue;
    if (!o.t || !o.r || !(BUDGET_TABLES as readonly string[]).includes(o.t))
      return { ok: false, reason: `unknown line` };
    rows.push({ t: o.t, r: o.r });
  }
  if (header) {
    const has = storage.sql.exec(`SELECT count(*) AS n FROM budget`).one().n;
    if (Number(has) > 0) return { ok: false, reason: 'refused: this database already holds a budget' };
  }
  const metas = new Map<string, Awaited<ReturnType<typeof tableMeta>>>();
  for (const { t } of rows) if (!metas.has(t)) metas.set(t, await tableMeta(db, t));
  const stmts = [
    ...(header ? [db.prepare(`DELETE FROM apply_counter`)] : []),
    ...rows.flatMap(({ t, r }) => insertStatements(db, t, metas.get(t)!, [r])),
  ];
  try {
    await db.batch(stmts);
  } catch (e) {
    return {
      ok: false,
      reason: `nothing from this piece was written: ${e instanceof Error ? e.message : e}`,
    };
  }
  // The columns each table had in the backup: verifyDump fingerprints only those, so a backup from before a
  // migration added a column still verifies.
  const cols = header ? {} : ((await storage.get<Record<string, string[]>>('restore_cols')) ?? {});
  for (const { t, r } of rows) {
    const have = new Set(cols[t] ?? []);
    for (const c of Object.keys(r)) have.add(c);
    cols[t] = [...have];
  }
  await storage.put('restore_cols', cols);
  if (footer !== undefined) await storage.put('restore_footer', footer);
  return { ok: true, rows: rows.length };
}

/** Recomputes every table's row count and fingerprint and compares them with the backup's footer. */
export async function verifyDump(
  storage: DurableObjectStorage,
  db: Db,
): Promise<{ ok: boolean; differences: string[] }> {
  const footer = (await storage.get<Record<string, { count: number; hash: string }>>('restore_footer')) ?? {};
  const backupCols = (await storage.get<Record<string, string[]>>('restore_cols')) ?? {};
  const differences: string[] = [];
  for (const t of BUDGET_TABLES) {
    const meta = narrowMeta(await tableMeta(db, t), backupCols[t]);
    let count = 0;
    let hash = '';
    let cursor: unknown[] | null = null;
    do {
      const c = await readChunk(db, t, meta, NO_FILTER, cursor);
      count += c.rows.length;
      hash = c.rows.length ? await chain(hash, c.text) : hash;
      cursor = c.cursor;
    } while (cursor);
    const want = footer[t] ?? { count: 0, hash: '' };
    if (want.count !== count || want.hash !== hash)
      differences.push(`${t}: ${count} row(s), backup has ${want.count}`);
  }
  return { ok: differences.length === 0, differences };
}
