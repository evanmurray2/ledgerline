import { readFileSync, readdirSync } from 'node:fs';
import { cpuUsage } from 'node:process';
import { NodeD1, applyMigrations } from '../../../packages/db/src/node-d1.js';

/** The BudgetStore's own schema: production runs these in each budget's Durable Object. */
export const MIGRATIONS_DIR = new URL('../../../packages/db/budget-migrations/', import.meta.url);

export function freshDb(): NodeD1 {
  const d = new NodeD1();
  applyMigrations(
    d,
    readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((name) => ({ name, sql: readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8') })),
  );
  return d;
}

function micros(): number {
  const u = cpuUsage();
  return u.user + u.system;
}

/**
 * CPU of fn() in ms. In a Durable Object SQLite runs on the same thread as the app, so `ms` includes it; `jsMs` is
 * the app's own share (without SQLite) and `execMs` the time executing statements and building rows.
 */
export async function cpu<T>(
  db: NodeD1,
  fn: () => Promise<T>,
): Promise<{ ms: number; jsMs: number; execMs: number; result: T; queries: number; statements: number }> {
  db.resetStats();
  const t0 = micros();
  const result = await fn();
  const total = micros() - t0;
  return {
    ms: total / 1000,
    jsMs: (total - db.stats.sqliteMicros) / 1000,
    execMs: db.stats.execMicros / 1000,
    result,
    queries: db.stats.queries,
    statements: db.stats.statements,
  };
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
