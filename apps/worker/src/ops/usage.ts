// Account-wide D1 usage for the write circuit breaker, from Cloudflare's GraphQL Analytics API (read-only token).
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
    d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date: $date }) { sum { rowsRead rowsWritten } } } } }`;
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
    body: JSON.stringify({ query, variables: { accountTag: env.CF_ACCOUNT_ID, date: day } }),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    data?: {
      viewer?: {
        accounts?: { d1AnalyticsAdaptiveGroups?: { sum: { rowsRead: number; rowsWritten: number } }[] }[];
      };
    };
  };
  const groups = j.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
  const rowsRead = groups.reduce((a, g) => a + g.sum.rowsRead, 0);
  const rowsWritten = groups.reduce((a, g) => a + g.sum.rowsWritten, 0);
  // The analytics figure replaces this app's own estimates since the last refresh.
  await env.DB.prepare(
    `INSERT INTO usage_day (day, rows_read, rows_written, est_read, est_written, refreshed_at) VALUES (?1, ?2, ?3, 0, 0, ?4)
     ON CONFLICT (day) DO UPDATE SET rows_read = excluded.rows_read, rows_written = excluded.rows_written, est_read = 0, est_written = 0, refreshed_at = excluded.refreshed_at`,
  )
    .bind(day, rowsRead, rowsWritten, now)
    .run();
  return { rowsRead, rowsWritten };
}
