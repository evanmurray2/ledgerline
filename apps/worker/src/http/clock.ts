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

/** How far back an edit's own time may lie: an edit made offline and sent later than this counts as 7 days old. */
const EDIT_BACK_MS = 7 * 86_400_000;

/**
 * The time an edit's rows carry: when the person made the edit (docs/privacy.md 5.3: "the time the person made the
 * edit travels with it"). An edit the phone queued says so in `x-edit-at` (its clock, corrected by its measured
 * distance from the server's), beside its `x-edit-id`; that time is kept within the last 7 days and never later
 * than now. So an edit made offline on the last day of a month acts on that month, and the phone, which ran the
 * edit at that same time, already holds the rows the server writes. Any other request gets the request's time.
 *
 * Only the routes that change the budget read this. Sign-in, sessions, bank links and limits read `requestNow`,
 * which a header can't move.
 */
export function editNow(c: Context<AppEnv>): number {
  const now = requestNow(c);
  const m = c.req.method;
  if (m === 'GET' || m === 'HEAD' || !c.req.header('x-edit-id')) return now;
  const at = Number(c.req.header('x-edit-at'));
  if (!Number.isFinite(at)) return now;
  return Math.min(now, Math.max(now - EDIT_BACK_MS, Math.floor(at)));
}
