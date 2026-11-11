import type { Context } from 'hono';
import type { Env } from '../env.js';
import type { AppEnv } from './context.js';

/**
 * The current time. A caller that gives the time (`NOW`: the phone's engine, which runs each request at one moment
 * of its own choosing) is believed first. Local development and tests may pin it with FAKE_NOW. Production always
 * uses the real clock.
 */
export function clock(env: Pick<Env, 'FAKE_NOW' | 'PLAID_ENV' | 'NOW'>): number {
  if (typeof env.NOW === 'number' && Number.isFinite(env.NOW)) return env.NOW;
  if (env.FAKE_NOW && env.PLAID_ENV !== 'production') {
    const t = Date.parse(env.FAKE_NOW);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}

/**
 * The time of this request: read once, the first time the request asks, and the same for everything the request
 * writes. A route takes its time from here, never from the clock, so that the same edit can be run again at
 * the same moment, on the server or on the phone (docs/privacy.md 5.3: "the clock is an input").
 */
export function requestNow(c: Context<AppEnv>): number {
  let t = c.get('now');
  if (t === undefined) {
    // The first reading is the request's time: every later one in this request gets the same value.
    t = clock(c.env);
    c.set('now', t);
  }
  return t;
}
