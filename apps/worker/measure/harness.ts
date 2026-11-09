import { readFileSync, readdirSync } from 'node:fs';
import { threadCpuUsage } from 'node:process';
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
 * CPU of this thread only. process.cpuUsage() also counts Node's compiler and garbage-collector threads, which about
 * doubled the numbers (Nov 9, 2026); a Worker is charged for its own thread.
 */
function micros(): number {
  const u = threadCpuUsage();
  return u.user + u.system;
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
