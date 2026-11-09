// Usage tracking, notes, health, webhooks, import and export.
import type { Stmt } from '@ledgerline/db/sql';
import { clock } from '../http/clock.js';
import { Hono } from 'hono';
import type { DumpChunk } from '@ledgerline/contracts';
import { BUDGET_TABLES, budgetFilter, chain, readChunk, tableMeta } from '../store/dump.js';
import {
  ImportCsvRequest,
  NoteRequest,
  UsageBatch,
  type HealthView,
  type ImportResult,
} from '@ledgerline/contracts';
import { cents } from '@ledgerline/domain';
import { ulid } from '@ledgerline/platform';
import type { AppEnv } from '../http/context.js';
import { HttpError, parse, scoped, GONE } from './api.js';
import { classifyUsage, dailyLimits, noteUsage, usageToday, utcDay } from '../sync/breaker.js';
import { makeProvider } from '../sync/provider.js';
import { startSync } from './settings/connections.js';
import { TX_COLUMNS, uncovered, type TxRow } from '../ledger/ledger.js';
import { csvDate, csvHeader, csvRecords, recordAmount } from '../ledger/csv.js';

export const opsRoutes = new Hono<AppEnv>();

/** Usage writes have the lowest priority: dropped from the breaker's 70% tier, and capped at 2,000 events a day. */
export const USAGE_DAILY_CAP = 2000;

opsRoutes.post('/usage', async (c) => {
  const r = await parse(UsageBatch, c.req.raw);
  const s = scoped(c);
  const setting = await s.first<{ value: string }>(
    `SELECT value FROM setting WHERE budget_id = ?1 AND key = 'tracking'`,
  );
  if (setting && JSON.parse(setting.value) === false) return c.body(null, 204);
  const u = await usageToday(c.env);
  if (classifyUsage(u.written, u.read, u.do, u.workers, dailyLimits(c.env)) !== 'normal')
    return c.body(null, 204);
  const dayStart = Date.parse(`${utcDay()}T00:00:00Z`);
  const today = await s.first<{ n: number }>(
    `SELECT count(*) AS n FROM usage_event WHERE budget_id = ?1 AND at >= ?2`,
    dayStart,
  );
  const room = Math.max(0, USAGE_DAILY_CAP - (today?.n ?? 0));
  const events = r.events.slice(0, room);
  if (!events.length) return c.body(null, 204);
  const stmts: Stmt[] = [];
  for (let i = 0; i < events.length; i += 12) {
    const chunk = events.slice(i, i + 12);
    stmts.push(
      s.q(
        `INSERT INTO usage_event (budget_id, at, session_id, app_version, screen, event, target, value) VALUES ${chunk
          .map(
            (_, j) =>
              `(?1, ?${2 + j * 7}, ?${3 + j * 7}, ?${4 + j * 7}, ?${5 + j * 7}, ?${6 + j * 7}, ?${7 + j * 7}, ?${8 + j * 7})`,
          )
          .join(', ')}`,
        ...chunk.flatMap((e) => [e.at, r.sessionId, r.appVersion, e.screen, e.event, e.target, e.value]),
      ),
    );
  }
  // Account usage lives in the Directory's usage_day (multi-user.md 5.6); without one, in this database.
  if (!c.env.NOTE_USAGE) stmts.push(noteUsage(c.env.DB, events.length * 2, 1));
  await s.batch(stmts);
  if (c.env.NOTE_USAGE) await c.env.NOTE_USAGE(events.length * 2, 1);
  return c.body(null, 204);
});

opsRoutes.delete('/usage', async (c) => {
  const s = scoped(c);
  await s.batch([
    s.q(`DELETE FROM usage_event WHERE budget_id = ?1`),
    s.q(`DELETE FROM usage_daily WHERE budget_id = ?1`),
  ]);
  return c.json({ ok: true });
});

opsRoutes.post('/notes', async (c) => {
  const r = await parse(NoteRequest, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
  await s.run(
    `INSERT INTO usage_note (id, budget_id, at, screen, text, recent_events) VALUES (?2, ?1, ?3, ?4, ?5, ?6)`,
    ulid(now),
    now,
    r.screen,
    r.text,
    JSON.stringify(r.recentEvents),
  );
  return c.json({ ok: true });
});

opsRoutes.get('/health', async (c) => {
  const s = scoped(c);
  const now = clock(c.env);
  const [conns, lag] = await s.batch([
    s.q(
      `SELECT id, last_synced_at FROM connection WHERE budget_id = ?1 AND removed_at IS NULL AND provider != 'csv'`,
    ),
    s.q(
      `SELECT (SELECT coalesce(max(id), 0) FROM bank_event WHERE budget_id = ?1) - processed_through AS lag FROM budget WHERE id = ?1`,
    ),
  ]);
  const u = await usageToday(c.env, now);
  const limits = dailyLimits(c.env);
  const connections = (conns!.results as { id: string; last_synced_at: number | null }[]).map((x) => ({
    id: x.id,
    lastSyncedAt: x.last_synced_at,
    stale: !x.last_synced_at || now - x.last_synced_at > 24 * 3_600_000,
  }));
  const view: HealthView = {
    ok:
      connections.every((x) => !x.stale) &&
      classifyUsage(u.written, u.read, u.do, u.workers, limits) === 'normal',
    connections,
    watermarkLag: Math.max(0, (lag!.results[0] as { lag: number } | undefined)?.lag ?? 0),
    usage: {
      day: utcDay(now),
      rowsRead: u.read,
      rowsWritten: u.written,
      readPct: Math.round((u.read * 1000) / limits.rowsRead) / 10,
      writePct: Math.round((u.written * 1000) / limits.rowsWritten) / 10,
    },
  };
  // The GitHub monitor's checks are recorded (it sends this header), so the app can tell when monitoring stops.
  if (c.req.header('x-ledgerline-monitor') === '1')
    await s.run(
      `INSERT INTO health_status (budget_id, key, value, at) VALUES (?1, 'last_monitor_check_at', ?2, ?2) ON CONFLICT (budget_id, key) DO UPDATE SET value = excluded.value, at = excluded.at`,
      String(now),
    );
  return c.json(view);
});

/** The one public path besides sign-in: requires a valid Plaid webhook signature and only starts a sync. */
opsRoutes.post('/webhooks/plaid', async (c) => {
  const ev = await makeProvider(c.env).verifyWebhook(c.req.raw);
  if (!ev) return c.json({ error: 'unauthorized' }, 401);
  if (!ev.providerItemId) return c.json({ ok: true });
  const conn = await c.env.DB.prepare(
    `SELECT id, budget_id FROM connection WHERE provider_item_id = ?1 AND removed_at IS NULL`,
  )
    .bind(ev.providerItemId)
    .first<{ id: string; budget_id: string }>();
  if (!conn) return c.json({ ok: true });
  if (ev.type === 'sync_updates_available' || ev.type === 'login_repaired') {
    await startSync(c.env, conn.budget_id, conn.id, 'webhook');
  } else if (ev.type === 'item_error' || ev.type === 'pending_expiration') {
    await c.env.DB.prepare(
      `UPDATE connection SET status = 'login_required', error_code = ?2, updated_at = ?3 WHERE id = ?1`,
    )
      .bind(conn.id, ev.code, clock(c.env))
      .run();
  }
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- export and import

const EXPORT_TABLES = [
  'budget',
  'account',
  'category_group',
  'category',
  'assignment',
  'target',
  'payee',
  'payee_alias',
  'rule',
  'txn_overlay',
  'manual_pending',
  'txn_split',
  'txn_link',
  'expected_reimbursement',
  'setting',
] as const;

/**
 * The full backup (docs/multi-user.md 8.7): every row of every table of this budget, rowids kept, in pieces of
 * about 50 KB so each request stays small. The footer carries each table's row count and fingerprint (the same
 * chained hash the move uses), so a restore can prove nothing changed. Sign-in rows (passkeys, sessions) are not
 * included: after a restore the owner adds a passkey with the setup code.
 */
opsRoutes.get('/export/dump', async (c) => {
  const s = scoped(c);
  const db = c.env.DB;
  const raw = c.req.query('cursor');
  type Cur = { t: number; k: unknown[] | null; h: Record<string, { count: number; hash: string }> };
  const cur: Cur = raw ? (JSON.parse(atob(raw)) as Cur) : { t: 0, k: null, h: {} };
  const lines: string[] = [];
  if (!raw)
    lines.push(
      JSON.stringify({
        format: 'ledgerline-dump',
        version: 1,
        budgetId: s.budgetId,
        createdAt: new Date(clock(c.env)).toISOString(),
        appVersion: c.env.APP_VERSION ?? null,
      }),
    );
  const table = BUDGET_TABLES[cur.t];
  if (!table) {
    lines.push(JSON.stringify({ end: true, tables: cur.h }));
    return c.json({ data: lines.join('\n'), cursor: null } satisfies DumpChunk);
  }
  const meta = await tableMeta(db, table);
  const chunk = await readChunk(db, table, meta, budgetFilter(table, s.budgetId), cur.k);
  for (const r of chunk.rows) lines.push(JSON.stringify({ t: table, r }));
  const prev = cur.h[table] ?? { count: 0, hash: '' };
  // Only pieces with rows count toward the fingerprint (the restore check does the same).
  const hash = chunk.rows.length ? await chain(prev.hash, chunk.text) : prev.hash;
  const h = { ...cur.h, [table]: { count: prev.count + chunk.rows.length, hash } };
  const next: Cur = chunk.cursor ? { t: cur.t, k: chunk.cursor, h } : { t: cur.t + 1, k: null, h };
  return c.json({ data: lines.join('\n'), cursor: btoa(JSON.stringify(next)) } satisfies DumpChunk);
});

opsRoutes.get('/export/json', async (c) => {
  const s = scoped(c);
  const out: Record<string, unknown> = {
    exportedAt: new Date().toISOString(),
    format: 'ledgerline-export-1',
  };
  for (const t of EXPORT_TABLES)
    out[t] = await s.all(
      t === 'budget' ? `SELECT * FROM budget WHERE id = ?1` : `SELECT * FROM ${t} WHERE budget_id = ?1`,
    );
  // Bank data: the projection (raw provider pages stay in raw_page; the access token is never exported).
  out.transactions = await s.all(
    `SELECT ${TX_COLUMNS} FROM v_transaction WHERE budget_id = ?1 ORDER BY date`,
  );
  return new Response(JSON.stringify(out), {
    headers: {
      'content-type': 'application/json',
      'content-disposition': 'attachment; filename="ledgerline-export.json"',
    },
  });
});

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

opsRoutes.get('/export/csv', async (c) => {
  const s = scoped(c);
  const rows = await s.all<TxRow & { category_name: string | null }>(
    `SELECT v.*, c.name AS category_name FROM v_transaction v LEFT JOIN category c ON c.id = v.category_id WHERE v.budget_id = ?1 AND ${uncovered('v')}
     ORDER BY v.date`,
  );
  const head = ['date', 'account', 'payee', 'amount', 'status', 'category', 'memo', 'raw_name'];
  const body = rows.map((r) =>
    [
      r.date,
      r.account_name,
      r.payee,
      (r.amount / 100).toFixed(2),
      r.status,
      r.category_name,
      r.memo,
      r.raw_name,
    ]
      .map(csvCell)
      .join(','),
  );
  return new Response([head.join(','), ...body].join('\n'), {
    headers: {
      'content-type': 'text/csv',
      'content-disposition': 'attachment; filename="ledgerline-transactions.csv"',
    },
  });
});

opsRoutes.get('/export/usage', async (c) => {
  const s = scoped(c);
  const [raw, daily, notes] = await s.batch([
    s.q(
      `SELECT at, session_id, app_version, screen, event, target, value FROM usage_event WHERE budget_id = ?1 ORDER BY at`,
    ),
    s.q(
      `SELECT date, app_version, screen, event, target, count, median_value FROM usage_daily WHERE budget_id = ?1 ORDER BY date`,
    ),
    s.q(`SELECT at, screen, text, recent_events FROM usage_note WHERE budget_id = ?1 ORDER BY at`),
  ]);
  return new Response(
    JSON.stringify({ events: raw!.results, daily: daily!.results, notes: notes!.results }),
    {
      headers: {
        'content-type': 'application/json',
        'content-disposition': 'attachment; filename="ledgerline-usage.json"',
      },
    },
  );
});

/**
 * CSV history import (date, payee, amount or Debit and Credit[, memo]; ledger/csv.ts reads the formats): rows are history only (they never enter the budget), used for
 * analytics and drift checks (read-only, D-61). Stored as a 'csv' connection's bank rows so the projection treats them
 * like any provider's.
 */
opsRoutes.post('/import/csv', async (c) => {
  const r = await parse(ImportCsvRequest, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
  const acct = await s.first<{
    id: string;
    provider_account_id: string | null;
    budget_from: string;
    kind: string;
  }>(
    `SELECT id, provider_account_id, budget_from, kind FROM account WHERE budget_id = ?1 AND id = ?2`,
    r.accountId,
  );
  if (!acct) throw new HttpError(404, 'not_found', GONE);
  const { records, delimiter } = csvRecords(r.csv);
  const head = csvHeader(records);
  if (!head)
    throw new HttpError(
      422,
      'csv_header',
      'The CSV file needs date, payee and amount columns (or Debit and Credit).',
    );
  const col = head.columns;
  const body = records.slice(head.at + 1);
  let conn = await s.first<{ id: string }>(
    `SELECT id FROM connection WHERE budget_id = ?1 AND provider = 'csv' AND institution_name = ?2`,
    `Import · ${r.accountId}`,
  );
  const providerAccountId = acct.provider_account_id ?? `csv:${acct.id}`;
  const stmts: Stmt[] = [];
  if (!conn) {
    conn = { id: `con_${ulid(now)}` };
    stmts.push(
      s.q(
        `INSERT INTO connection (id, budget_id, provider, institution_name, linked_at, created_at, updated_at) VALUES (?2, ?1, 'csv', ?3, ?4, ?4, ?4)`,
        conn.id,
        `Import · ${r.accountId}`,
        now,
      ),
    );
    if (!acct.provider_account_id)
      stmts.push(
        s.q(
          `UPDATE account SET provider_account_id = ?3 WHERE budget_id = ?1 AND id = ?2`,
          acct.id,
          providerAccountId,
        ),
      );
  }
  let imported = 0;
  let skipped = 0;
  let duplicates = 0;
  let unreadable = 0;
  // Each record read: a real calendar date only ("25/12/2025", day first, or "2026-13-01" is never stored as month 25).
  const read = body.map((cols) => ({
    cols,
    iso: csvDate(cols[col.date] ?? ''),
    amount: recordAmount(cols, col, delimiter),
    payee: (cols[col.payee] ?? '').trim().slice(0, 200),
  }));
  const dates = read.flatMap((x) => (x.iso ? [x.iso] : []));
  // History already imported into this account over the file's dates: the same row again (date, amount and payee,
  // as many times as it was there) is skipped, so importing a file twice, or two files that overlap, adds no double.
  const existing = dates.length
    ? await s.all<{ provider_txn_id: string; date: string; amount: number; raw_name: string }>(
        `SELECT provider_txn_id, date, amount, raw_name FROM bank_txn
         WHERE budget_id = ?1 AND provider_account_id = ?2 AND substr(provider_txn_id, 1, 4) = 'csv_'
           AND date BETWEEN ?3 AND ?4`,
        providerAccountId,
        dates.reduce((a, b) => (a < b ? a : b)),
        dates.reduce((a, b) => (a > b ? a : b)),
      )
    : [];
  const seen = new Map<string, number>();
  for (const e of existing) {
    const k = `${e.date}|${e.amount}|${e.raw_name}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const used = new Set(existing.map((e) => e.provider_txn_id));
  for (const x of read) {
    if (!x.iso || x.amount === null) {
      unreadable++;
      continue;
    }
    // Imported history rows are always history (Budget start): only rows dated before budget_from are kept.
    if (x.iso >= acct.budget_from) {
      skipped++;
      continue;
    }
    const k = `${x.iso}|${x.amount}|${x.payee}`;
    const left = seen.get(k) ?? 0;
    if (left > 0) {
      seen.set(k, left - 1);
      duplicates++;
      continue;
    }
    imported++;
    let n = 0;
    while (used.has(`csv_${acct.id}_${x.iso}_${n}`)) n++;
    const id = `csv_${acct.id}_${x.iso}_${n}`;
    used.add(id);
    stmts.push(
      s.q(
        `INSERT OR IGNORE INTO bank_txn (provider_txn_id, budget_id, connection_id, provider_account_id, amount, date, pending, raw_name, txn_key, first_apply_seq, last_apply_seq, created_at, updated_at)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, 0, ?7, ?8, 0, 0, ?9, ?9)`,
        id,
        conn.id,
        providerAccountId,
        cents(x.amount),
        x.iso,
        x.payee,
        `p:${id}`,
        now,
      ),
    );
    const memo = col.memo >= 0 ? (x.cols[col.memo] ?? '').trim() : '';
    if (memo)
      stmts.push(
        s.q(
          `INSERT OR IGNORE INTO txn_overlay (txn_key, budget_id, memo, created_at, updated_at) VALUES (?2, ?1, ?3, ?4, ?4)`,
          `p:${id}`,
          memo.slice(0, 500),
          now,
        ),
      );
  }
  // Month totals live on the phone (D-45): its copy starts them over when these rows arrive (local/engine.ts).
  for (let i = 0; i < stmts.length; i += 100) await s.batch(stmts.slice(i, i + 100));
  const res: ImportResult = { imported, skipped, history: imported, duplicates, unreadable };
  return c.json(res);
});
