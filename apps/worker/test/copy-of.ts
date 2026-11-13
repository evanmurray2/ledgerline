// A device's copy of another copy's budget (or of what the old server pipeline filed, test/bank-sync.ts): every row
// of the tables a copy keeps, written into the copy in one step. Tests use it to give a device the budget a sealed
// log starts from, and to build a reference copy that works everything out from scratch.
import type { Db } from '@ledgerline/db/sql';
import type { LocalEngine } from '../src/local/engine.js';
import { SYNC_FORMAT, SYNC_TABLES, type SyncRow, type SyncTable } from '../src/sync-tables.js';

export async function copyOf(
  src: Db,
  e: LocalEngine,
  now: number,
  tables: readonly SyncTable[] = SYNC_TABLES,
): Promise<void> {
  const rows: SyncRow[] = [];
  for (const t of tables) {
    const all = (await src.prepare(`SELECT * FROM ${t.name}`).all<Record<string, unknown>>()).results;
    for (const r of all) {
      const d = Object.fromEntries(Object.entries(r).filter(([c]) => !t.omit?.includes(c)));
      rows.push({ t: t.name, k: t.pk.map((c) => r[c]), d });
    }
  }
  const st = await e.state();
  await e.apply(
    {
      format: SYNC_FORMAT,
      epoch: st.epoch ?? 'copy',
      serverTime: now,
      through: st.through + 1,
      more: false,
      cursor: null,
      rows,
    },
    now,
    tables,
  );
}
