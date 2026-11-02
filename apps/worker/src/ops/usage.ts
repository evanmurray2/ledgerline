// Account-wide usage for the write circuit breaker, from Cloudflare's GraphQL Analytics API (read-only token): D1
// rows plus Durable Object SQLite rows, Durable Object requests and active time, and Worker requests. They're added together because whether the Free plan pools the
// two daily limits isn't known (docs/measurements.md, phase 0); counting both pauses background work early rather
// than late.
import type { Env } from '../env.js';
import { utcDay } from '../sync/breaker.js';

export async function refreshUsage(
  env: Env,
  now: number,
  force = false,
): Promise<{ rowsRead: number; rowsWritten: number } | null> {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) return null;
  const day = utcDay(now);
  const cur = await env.DB.prepare(`SELECT refreshed_at FROM usage_day WHERE day = ?1`)
    .bind(day)
    .first<{ refreshed_at: number }>();
  if (!force && cur && now - cur.refreshed_at < 10 * 60_000) return null;
  const query = `query ($accountTag: string!, $date: Date!) { viewer { accounts(filter: { accountTag: $accountTag }) {
    d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date: $date }) { sum { rowsRead rowsWritten } }
    durableObjectsPeriodicGroups(limit: 10000, filter: { date: $date }) { sum { rowsRead rowsWritten } } } } }`;
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
    body: JSON.stringify({ query, variables: { accountTag: env.CF_ACCOUNT_ID, date: day } }),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    data?: {
      viewer?: {
        accounts?: {
          d1AnalyticsAdaptiveGroups?: { sum: { rowsRead: number; rowsWritten: number } }[];
          durableObjectsPeriodicGroups?: { sum: { rowsRead: number; rowsWritten: number } }[];
        }[];
      };
    };
  };
  const acct = j.data?.viewer?.accounts?.[0];
  const groups = [...(acct?.d1AnalyticsAdaptiveGroups ?? []), ...(acct?.durableObjectsPeriodicGroups ?? [])];
  const rowsRead = groups.reduce((a, g) => a + g.sum.rowsRead, 0);
  const rowsWritten = groups.reduce((a, g) => a + g.sum.rowsWritten, 0);
  const d = await doUsage(env, day);
  const w = await workerRequests(env, day);
  // The analytics figure replaces this app's own estimates since the last refresh.
  await env.DB.prepare(
    `INSERT INTO usage_day (day, rows_read, rows_written, est_read, est_written, refreshed_at, do_requests, do_gbs,
       worker_requests)
     VALUES (?1, ?2, ?3, 0, 0, ?4, coalesce(?5, 0), coalesce(?6, 0), coalesce(?7, 0))
     ON CONFLICT (day) DO UPDATE SET rows_read = excluded.rows_read, rows_written = excluded.rows_written, est_read = 0,
       est_written = 0, refreshed_at = excluded.refreshed_at,
       do_requests = coalesce(?5, do_requests), do_gbs = coalesce(?6, do_gbs),
       worker_requests = coalesce(?7, worker_requests)`,
  )
    .bind(day, rowsRead, rowsWritten, now, d?.requests ?? null, d?.gbs ?? null, w)
    .run();
  return { rowsRead, rowsWritten };
}

/** Each Durable Object is billed for 128 MB while active, so GB-s = active seconds × 0.128. */
const DO_GB = 0.128;

/**
 * Today's Durable Object requests (HTTP, RPC and alarms) and active time, the two Free limits that ran out on
 * Nov 2, 2026. A separate query, so a field the API doesn't know can't break the rows query above; null if it fails.
 */
async function doUsage(env: Env, day: string): Promise<{ requests: number; gbs: number } | null> {
  const query = `query ($accountTag: string!, $date: Date!) { viewer { accounts(filter: { accountTag: $accountTag }) {
    durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { date: $date }) { sum { requests } }
    durableObjectsPeriodicGroups(limit: 10000, filter: { date: $date }) { sum { activeTime } } } } }`;
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
    body: JSON.stringify({ query, variables: { accountTag: env.CF_ACCOUNT_ID, date: day } }),
  }).catch(() => null);
  if (!res?.ok) return null;
  const j = (await res.json().catch(() => null)) as {
    errors?: unknown[];
    data?: {
      viewer?: {
        accounts?: {
          durableObjectsInvocationsAdaptiveGroups?: { sum: { requests: number } }[];
          durableObjectsPeriodicGroups?: { sum: { activeTime: number } }[];
        }[];
      };
    };
  } | null;
  const acct = j?.data?.viewer?.accounts?.[0];
  if (!acct || j?.errors?.length) {
    console.log(JSON.stringify({ event: 'do_usage_unavailable', errors: j?.errors ?? null }));
    return null;
  }
  const requests = (acct.durableObjectsInvocationsAdaptiveGroups ?? []).reduce(
    (a, g) => a + g.sum.requests,
    0,
  );
  // activeTime is in microseconds.
  const activeUs = (acct.durableObjectsPeriodicGroups ?? []).reduce((a, g) => a + g.sum.activeTime, 0);
  return { requests, gbs: (activeUs / 1e6) * DO_GB };
}

/**
 * Today's Worker requests across the account (Free: 100,000 a day). Static asset requests don't run the Worker
 * and aren't counted. Its own query, like doUsage; null if it fails.
 */
async function workerRequests(env: Env, day: string): Promise<number | null> {
  const query = `query ($accountTag: string!, $date: Date!) { viewer { accounts(filter: { accountTag: $accountTag }) {
    workersInvocationsAdaptive(limit: 10000, filter: { date: $date }) { sum { requests } } } } }`;
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
    body: JSON.stringify({ query, variables: { accountTag: env.CF_ACCOUNT_ID, date: day } }),
  }).catch(() => null);
  if (!res?.ok) return null;
  const j = (await res.json().catch(() => null)) as {
    errors?: unknown[];
    data?: { viewer?: { accounts?: { workersInvocationsAdaptive?: { sum: { requests: number } }[] }[] } };
  } | null;
  const acct = j?.data?.viewer?.accounts?.[0];
  if (!acct || j?.errors?.length) {
    console.log(JSON.stringify({ event: 'worker_usage_unavailable', errors: j?.errors ?? null }));
    return null;
  }
  return (acct.workersInvocationsAdaptive ?? []).reduce((a, g) => a + g.sum.requests, 0);
}
