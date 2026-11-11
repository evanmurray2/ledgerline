// Sync to the phone (docs/phone-budget.md section 8, decisions.md D-45). The phone keeps a copy of the tables in
// sync-tables.ts and asks for what changed since the last change number it holds. A full download (since=0) walks
// every table in key order, then continues from the change number the download started at, so anything changed while
// it ran is sent again. Each page is small enough for the 10 ms rule.
import type { Db } from '@ledgerline/db/sql';
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../http/context.js';
import { requestNow } from '../http/clock.js';
import { SYNC_FORMAT, SYNC_TABLES, type SyncTable } from '../sync-tables.js';
import type { Scoped } from '../db/scoped.js';
import { SYNC_SINCE_HEADER } from '@ledgerline/contracts';

const TRY_AGAIN = 'Something went wrong. Try again.';

export const syncRoutes = new Hono<AppEnv>();

/** Rows per page. Measured: see docs/measurements.md (sync pages). */
export const SYNC_PAGE_ROWS = 200;

export interface SyncRow {
  /** Table */
  t: string;
  /** Primary key values */
  k: unknown[];
  /** The row, or null when it was deleted */
  d: Record<string, unknown> | null;
}

export interface SyncPage {
  format: number;
  epoch: string;
  serverTime: number;
  /** Change number the phone holds once it has applied this page and every one before it. */
  through: number;
  more: boolean;
  /** Full download only: where the next page starts. */
  cursor: string | null;
  rows: SyncRow[];
}

const Cursor = z.object({
  t: z.number().int().min(0),
  after: z.array(z.union([z.string(), z.number()])).nullable(),
  through: z.number().int(),
});

function strip(t: SyncTable, row: Record<string, unknown>): Record<string, unknown> {
  const omit = t.omit;
  if (!omit) return row;
  return Object.fromEntries(Object.entries(row).filter(([k]) => !omit.includes(k)));
}

const pkOf = (t: SyncTable, row: Record<string, unknown>) => t.pk.map((c) => row[c]);

async function head(db: Db): Promise<number> {
  const r = await db.prepare(`SELECT coalesce(max(seq), 0) AS n FROM change_log`).first<{ n: number }>();
  return r?.n ?? 0;
}

/** The changes after `since`, in change order: at most `limit` change-log entries (`more` says if there are others). */
export async function changePage(
  db: Db,
  since: number,
  limit: number,
  base: Pick<SyncPage, 'format' | 'epoch' | 'serverTime'>,
): Promise<SyncPage> {
  const log = (
    await db
      .prepare(`SELECT tbl, pk, seq, deleted FROM change_log WHERE seq > ?1 ORDER BY seq LIMIT ?2`)
      .bind(since, limit)
      .all<{ tbl: string; pk: string; seq: number; deleted: number }>()
  ).results;
  const rows: SyncRow[] = [];
  const live = new Map<string, string[]>();
  for (const e of log) {
    if (e.deleted) rows.push({ t: e.tbl, k: JSON.parse(e.pk) as unknown[], d: null });
    else live.set(e.tbl, [...(live.get(e.tbl) ?? []), e.pk]);
  }
  for (const [name, pks] of live) {
    const tbl = SYNC_TABLES.find((x) => x.name === name);
    if (!tbl) continue;
    const sql =
      tbl.pk.length === 1
        ? `SELECT * FROM ${name} WHERE ${tbl.pk[0]} IN (SELECT json_extract(value, '$[0]') FROM json_each(?1))`
        : `SELECT * FROM ${name} WHERE json_array(${tbl.pk.join(', ')}) IN (SELECT value FROM json_each(?1))`;
    const got = (await db.prepare(sql).bind(JSON.stringify(pks)).all<Record<string, unknown>>()).results;
    const found = new Set<string>();
    for (const r of got) {
      const k = pkOf(tbl, r);
      found.add(JSON.stringify(k));
      rows.push({ t: name, k, d: strip(tbl, r) });
    }
    // Logged as present but gone by now (deleted after this page was read): send as deleted; the delete's own log
    // entry comes in a later page too.
    for (const pk of pks)
      if (!found.has(JSON.stringify(JSON.parse(pk))))
        rows.push({ t: name, k: JSON.parse(pk) as unknown[], d: null });
  }
  const page: SyncPage = {
    ...base,
    through: log.length ? log[log.length - 1]!.seq : since,
    more: log.length === limit,
    cursor: null,
    rows,
  };
  return page;
}

/** At most this many changes ride along in an edit's answer; an edit that changed more leaves the rest to a sync. */
export const ANSWER_SYNC_ROWS = 50;

/**
 * An online edit's answer carries the changes since the change number the phone sends (`x-sync-since`), so the phone
 * brings its copy up to date without a second request (a sync costs a Worker request and two Durable Object calls).
 * Only on success, only for a JSON object answer, and never for an edit the phone queued offline: those resend.
 */
export const syncInAnswer: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const m = c.req.method;
  if (m === 'GET' || m === 'HEAD' || c.res.status >= 300) return;
  const raw = c.req.header(SYNC_SINCE_HEADER);
  if (raw === undefined || c.req.header('x-edit-id')) return;
  const since = Number(raw);
  if (!Number.isSafeInteger(since) || since <= 0) return;
  if (!(c.res.headers.get('content-type') ?? '').includes('application/json')) return;
  const json = (await c.res
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null;
  if (!json || typeof json !== 'object' || Array.isArray(json)) return;
  const base = { format: SYNC_FORMAT, epoch: c.get('syncEpoch') ?? 'e0', serverTime: requestNow(c) };
  const sync = await changePage(c.env.DB, since, ANSWER_SYNC_ROWS, base);
  c.res = new Response(JSON.stringify({ ...json, sync }), { status: c.res.status, headers: c.res.headers });
};

syncRoutes.get('/sync', async (c) => {
  const db = c.env.DB;
  const since = Number(c.req.query('since') ?? '0');
  if (!Number.isSafeInteger(since) || since < 0) return c.json({ error: 'invalid', message: TRY_AGAIN }, 400);
  // A whole number of rows, 1 to 500: a negative LIMIT means no limit in SQLite, and a fraction is an SQL error.
  const asked = Number(c.req.query('limit') ?? SYNC_PAGE_ROWS);
  const limit = Number.isFinite(asked) && asked >= 1 ? Math.min(Math.floor(asked), 500) : SYNC_PAGE_ROWS;
  const base = { format: SYNC_FORMAT, epoch: c.get('syncEpoch') ?? 'e0', serverTime: requestNow(c) };

  if (since === 0) {
    // Full download: tables in order, rows in key order.
    const raw = c.req.query('cursor');
    let cur: z.infer<typeof Cursor>;
    try {
      cur = raw ? Cursor.parse(JSON.parse(raw)) : { t: 0, after: null, through: await head(db) };
    } catch {
      return c.json({ error: 'invalid', message: TRY_AGAIN }, 400);
    }
    // A cursor this server didn't write (or one from an older table list): its key must fit the table's key.
    const at = SYNC_TABLES[cur.t];
    if (cur.after && (!at || cur.after.length !== at.pk.length))
      return c.json({ error: 'invalid', message: TRY_AGAIN }, 400);
    // Why the phone is downloading everything (its saved copy was missing, unreadable, turned off…), for the logs.
    if (!raw)
      console.log(
        JSON.stringify({
          event: 'sync_full',
          why: (c.req.query('why') ?? 'unknown').replace(/[^\w:-]/g, '').slice(0, 40),
        }),
      );
    const rows: SyncRow[] = [];
    let t = cur.t;
    let after: unknown[] | null = cur.after;
    while (t < SYNC_TABLES.length && rows.length < limit) {
      const tbl = SYNC_TABLES[t]!;
      const cols = tbl.pk.join(', ');
      const where = after ? `WHERE (${cols}) > (${tbl.pk.map((_, i) => `?${i + 1}`).join(', ')})` : '';
      const want = limit - rows.length;
      const got = (
        await db
          .prepare(`SELECT * FROM ${tbl.name} ${where} ORDER BY ${cols} LIMIT ${want}`)
          .bind(...(after ?? []))
          .all<Record<string, unknown>>()
      ).results;
      for (const r of got) rows.push({ t: tbl.name, k: pkOf(tbl, r), d: strip(tbl, r) });
      if (got.length < want) {
        t++;
        after = null;
      } else after = pkOf(tbl, got[got.length - 1]!);
    }
    const more = t < SYNC_TABLES.length;
    const page: SyncPage = {
      ...base,
      through: cur.through,
      more,
      cursor: more ? JSON.stringify({ t, after, through: cur.through }) : null,
      rows,
    };
    return c.json(page);
  }

  return c.json(await changePage(db, since, limit, base));
});

/**
 * Ready to Assign worked out on a phone that doesn't satisfy rule 10 (the identity check, sync spec): saved as an
 * `identity` alert, which shows on Accounts on every device until dismissed.
 */
syncRoutes.post('/identity-alert', async (c) => {
  const body = z
    .object({ difference: z.number().int(), month: z.string().regex(/^\d{4}-\d{2}$/) })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'invalid', message: TRY_AGAIN }, 400);
  const now = requestNow(c);
  await c.env.DB.prepare(
    `INSERT INTO alert (id, budget_id, type, ref_key, data, created_at) VALUES (?1, ?2, 'identity', ?3, ?4, ?5)
     ON CONFLICT (budget_id, type, ref_key) DO UPDATE SET data = excluded.data`,
  )
    .bind(
      `identity:${new Date(now).toISOString().slice(0, 10)}`,
      c.get('budgetId'),
      new Date(now).toISOString().slice(0, 10),
      JSON.stringify({ ok: false, difference: body.data.difference, literal: true, month: body.data.month }),
      now,
    )
    .run();
  return c.json({ ok: true });
});

/**
 * Point-in-time recovery (runbooks/restore.md, a console step, never a button: D-77): rolls the budget's
 * database to a time in the last 30 days, or undoes the last restore (`undo`). Needs a passkey check within 15 minutes
 * and the budget's name typed. A restore is never final: the Directory keeps the bookmark that undoes it, and the
 * 30 days of recovery cover the minute before it as well. Phones download their copies again.
 */
syncRoutes.post('/settings/restore', async (c) => {
  const body = z
    .union([
      z.object({ before: z.string().datetime(), confirm: z.string() }),
      z.object({ undo: z.literal(true), confirm: z.string() }),
    ])
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success)
    return c.json({ error: 'invalid', message: 'Pick a time and type the budget’s name.' }, 400);
  const b = await c.env.DB.prepare(`SELECT name FROM budget WHERE id = ?1`)
    .bind(c.get('budgetId'))
    .first<{ name: string }>();
  if (!b || body.data.confirm.trim() !== b.name.trim())
    return c.json({ error: 'confirm', message: 'Type the budget’s name to confirm.' }, 422);
  if (!c.env.RESTORE_TO || !c.env.RESTORE_UNDO)
    return c.json({ error: 'unavailable', message: 'Restoring isn’t available here.' }, 503);
  if ('undo' in body.data) {
    const r = await c.env.RESTORE_UNDO();
    if (!r) return c.json({ error: 'invalid', message: 'There’s no restore to undo.' }, 422);
    return c.json({ ok: true, ...r });
  }
  const at = Date.parse(body.data.before);
  const now = requestNow(c);
  if (!(at < now && at > now - 30 * 86_400_000))
    return c.json({ error: 'invalid', message: 'Pick a time in the last 30 days.' }, 422);
  return c.json({ ok: true, ...(await c.env.RESTORE_TO(at)) });
});

/** The last restore, for the runbook (no bookmark: undoing goes through the route above). */
syncRoutes.get('/settings/restore/last', async (c) => {
  const last = c.env.LAST_RESTORE ? await c.env.LAST_RESTORE() : null;
  return c.json({
    last: last
      ? { at: new Date(last.at).toISOString(), to: last.to === null ? null : new Date(last.to).toISOString() }
      : null,
  });
});

/** Edit ids from the phone's offline queue: kept 30 days (pruned by the daily maintenance job). */
export const EDIT_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * A change sent with `x-edit-id` is applied once: sent again (after a dropped answer), it gets `{ ok: true }` and
 * nothing more happens.
 */
export const editOnce: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = c.req.header('x-edit-id');
  if (!id || c.req.method === 'GET' || c.req.method === 'HEAD') return next();
  if (!EDIT_ID.test(id)) return c.json({ error: 'invalid', message: TRY_AGAIN }, 400);
  const seen = await c.env.DB.prepare(`SELECT 1 AS x FROM edit_seen WHERE id = ?1`).bind(id).first();
  if (seen) return c.json({ ok: true, repeated: true });
  await next();
  if (c.res.status < 300)
    await c.env.DB.prepare(`INSERT OR IGNORE INTO edit_seen (id, at) VALUES (?1, ?2)`)
      .bind(id, requestNow(c))
      .run();
};

/**
 * When an offline edit was made: `x-edit-at` (the phone's clock, corrected by its measured offset from the server),
 * kept within the last 7 days and never later than now. Most-recent-edit-wins merges use it.
 */
export function editTime(c: { req: { header(name: string): string | undefined } }, now: number): number {
  const at = Number(c.req.header('x-edit-at'));
  if (!Number.isFinite(at)) return now;
  return Math.min(now, Math.max(now - 7 * 86_400_000, Math.floor(at)));
}

/** The key a transaction has now: an edit sent offline to a key that has since moved lands on the new one. */
export async function liveKey(s: Scoped, key: string): Promise<string> {
  let k = key;
  for (let i = 0; i < 4; i++) {
    const here = await s.first(
      `SELECT 1 AS x FROM bank_txn WHERE budget_id = ?1 AND txn_key = ?2 AND removed_at IS NULL
       UNION ALL SELECT 1 FROM manual_pending WHERE budget_id = ?1 AND txn_key = ?2 AND deleted_at IS NULL`,
      k,
    );
    if (here) return k;
    const m = await s.db
      .prepare(`SELECT new_key FROM txn_key_move WHERE old_key = ?1`)
      .bind(k)
      .first<{ new_key: string }>();
    if (!m) return k;
    k = m.new_key;
  }
  return k;
}
