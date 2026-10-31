import type { Env } from '../env.js';

/** The current time; local development and tests may pin it with FAKE_NOW. Production always uses the real clock. */
export function clock(env: Pick<Env, 'FAKE_NOW' | 'PLAID_ENV'>): number {
  if (env.FAKE_NOW && env.PLAID_ENV !== 'production') {
    const t = Date.parse(env.FAKE_NOW);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}
