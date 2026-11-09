import { readFileSync, readdirSync } from 'node:fs';
import { NodeDb, applyMigrations } from '../../../packages/db/src/node-db.js';

/** The BudgetStore's own schema: production runs these in each budget's Durable Object. */
export const MIGRATIONS_DIR = new URL('../../../packages/db/budget-migrations/', import.meta.url);

export function freshDb(): NodeDb {
  const d = new NodeDb();
  applyMigrations(
    d,
    readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((name) => ({ name, sql: readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8') })),
  );
  return d;
}

/**
 * Time on this thread, in microseconds. The step is synchronous SQLite and JavaScript with no I/O, so wall time is its
 * CPU (they agreed within 0.5 ms, Nov 9, 2026). process.cpuUsage() also counts Node's compiler and garbage-collector
 * threads, which about doubled the numbers; process.threadCpuUsage() is counted in 4 ms ticks on Linux. Run measures
 * alone, not beside other work.
 */
function micros(): number {
  return performance.now() * 1000;
}

/** CPU of fn() in ms, on this thread. In a Durable Object SQLite runs on the same thread as the app, so it is included. */
export async function cpu<T>(
  db: NodeDb,
  fn: () => Promise<T>,
): Promise<{ ms: number; result: T; queries: number; statements: number }> {
  db.resetStats();
  const t0 = micros();
  const result = await fn();
  const total = micros() - t0;
  return { ms: total / 1000, result, queries: db.stats.queries, statements: db.stats.statements };
}

export function stats(xs: number[]): { first: number; median: number; p90: number; max: number } {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return {
    first: +xs[0]!.toFixed(2),
    median: +q(0.5).toFixed(2),
    p90: +q(0.9).toFixed(2),
    max: +s[s.length - 1]!.toFixed(2),
  };
}
