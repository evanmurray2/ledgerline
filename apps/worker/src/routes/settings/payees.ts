// Settings → Payees: the list, renaming, and joining payees (rename = merge) with Undo (docs/payees.md 5, 6).
import { Hono } from 'hono';
import type { Stmt } from '@ledgerline/db/sql';
import { clock } from '../../http/clock.js';
import { MergePayees, RenamePayee, type MergeResult, type PayeesView } from '@ledgerline/contracts';
import { payeeKey, rankPastUses, samePayeeName } from '@ledgerline/domain';
import { ulid } from '@ledgerline/platform';
import type { AppEnv } from '../../http/context.js';
import { HttpError, parse, scoped } from '../api.js';
import { chunks } from '../../ledger/ledger.js';

export const payeesRoutes = new Hono<AppEnv>();

/** `?from, ?from+1, …` for an IN list of `n` values. */
const places = (n: number, from: number) => Array.from({ length: n }, (_, i) => `?${i + from}`).join(',');

// ---------------------------------------------------------------- the list

payeesRoutes.get('/settings/payees', async (c) => {
  const s = scoped(c);
  const [payees, counts, names, uses, cats] = await s.batch([
    s.q(`SELECT id, name FROM payee WHERE budget_id = ?1 AND merged_into IS NULL ORDER BY name`),
    // Budget transactions per payee: the same test as Activity's (history is before the account's budget start and
    // not pending at link).
    s.q(
      `SELECT payee_id, count(*) AS n FROM v_txn_bank WHERE budget_id = ?1 AND payee_id IS NOT NULL
         AND (date >= budget_from OR pending_at_link = 1 OR status != 'posted') GROUP BY payee_id`,
    ),
    s.q(
      `SELECT payee_id, raw_name, count(*) AS n FROM v_txn_bank WHERE budget_id = ?1 AND payee_id IS NOT NULL
       GROUP BY payee_id, raw_name ORDER BY n DESC`,
    ),
    // Your categories for money out, per payee: "usually" (docs/payees.md 2.1).
    s.q(
      `SELECT o.payee_id, o.category_id, count(*) AS n, max(o.updated_at) AS last
       FROM txn_overlay o JOIN bank_txn b ON b.txn_key = o.txn_key AND b.removed_at IS NULL AND b.amount < 0
       WHERE o.budget_id = ?1 AND o.categorized_by = 'user' AND o.category_id IS NOT NULL AND o.payee_id IS NOT NULL
       GROUP BY o.payee_id, o.category_id`,
    ),
    s.q(`SELECT id, name, kind, archived_at FROM category WHERE budget_id = ?1`),
  ]);
  const n = new Map((counts!.results as { payee_id: string; n: number }[]).map((r) => [r.payee_id, r.n]));
  const bank = new Map<string, { name: string; count: number }[]>();
  for (const r of names!.results as { payee_id: string; raw_name: string; n: number }[]) {
    const l = bank.get(r.payee_id) ?? [];
    if (l.length < 10) l.push({ name: r.raw_name, count: r.n });
    bank.set(r.payee_id, l);
  }
  const catRows = cats!.results as { id: string; name: string; kind: string; archived_at: number | null }[];
  const catName = new Map(catRows.map((x) => [x.id, x.name]));
  const usable = new Set(catRows.filter((x) => !x.archived_at && x.kind !== 'cc_payment').map((x) => x.id));
  const past = new Map<string, { categoryId: string; toRta: false; n: number; last: number }[]>();
  for (const r of uses!.results as { payee_id: string; category_id: string; n: number; last: number }[])
    past.set(r.payee_id, [
      ...(past.get(r.payee_id) ?? []),
      { categoryId: r.category_id, toRta: false, n: r.n, last: r.last },
    ]);
  const all = payees!.results as { id: string; name: string }[];
  const view: PayeesView = {
    payees: all
      .filter((p) => (n.get(p.id) ?? 0) > 0)
      .map((p) => {
        const top = rankPastUses(past.get(p.id) ?? [], false, (id) => usable.has(id))[0];
        return {
          id: p.id,
          name: p.name,
          transactions: n.get(p.id)!,
          usual: top?.categoryId ? (catName.get(top.categoryId) ?? null) : null,
          bankNames: bank.get(p.id) ?? [],
        };
      })
      .sort((a, b) => b.transactions - a.transactions || a.name.localeCompare(b.name)),
    others: all.filter((p) => !(n.get(p.id) ?? 0)).map((p) => ({ id: p.id, name: p.name })),
  };
  return c.json(view);
});

// ---------------------------------------------------------------- joining payees

interface MergeBefore {
  keep: string;
  at: number;
  /** Each joined payee's name before. */
  names: Record<string, string>;
  /** Each moved alias and the payee it pointed at. */
  aliases: { id: string; payee: string; pattern: string | null; merchant: string | null }[];
  /** The transactions that moved, by the payee they were on. */
  keys: Record<string, string[]>;
}

payeesRoutes.post('/settings/payees/merge', async (c) => {
  const r = await parse(MergePayees, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
  const keep = r.keep ?? r.ids[0]!;
  const ids = [...new Set(r.ids)];
  if (ids.length !== r.ids.length || ids.length < 2 || !ids.includes(keep))
    throw new HttpError(422, 'bad_merge', 'Pick at least two different payees, including the one to keep.');
  const found = await s.all<{ id: string; name: string; merged_into: string | null }>(
    `SELECT id, name, merged_into FROM payee WHERE budget_id = ?1 AND id IN (${places(ids.length, 2)})`,
    ...ids,
  );
  if (found.length !== ids.length || found.some((p) => p.merged_into))
    throw new HttpError(409, 'payee_changed', 'This payee changed. Pull to refresh.');
  const rest = ids.filter((x) => x !== keep);
  const [aliases, moved] = await s.batch([
    s.q(
      `SELECT id, payee_id, pattern, merchant_entity_id FROM payee_alias WHERE budget_id = ?1 AND payee_id IN (${places(rest.length, 2)})`,
      ...rest,
    ),
    s.q(
      `SELECT txn_key, payee_id FROM txn_overlay WHERE budget_id = ?1 AND payee_id IN (${places(rest.length, 2)})`,
      ...rest,
    ),
  ]);
  const before: MergeBefore = {
    keep,
    at: now,
    names: Object.fromEntries(found.map((p) => [p.id, p.name])),
    aliases: (
      aliases!.results as {
        id: string;
        payee_id: string;
        pattern: string | null;
        merchant_entity_id: string | null;
      }[]
    ).map((a) => ({ id: a.id, payee: a.payee_id, pattern: a.pattern, merchant: a.merchant_entity_id })),
    keys: {},
  };
  for (const m of moved!.results as { txn_key: string; payee_id: string }[])
    (before.keys[m.payee_id] ??= []).push(m.txn_key);
  const undoId = ulid(now);
  const name = r.name ?? found.find((p) => p.id === keep)!.name;
  // Aliases and transactions move to the kept payee; raw bank descriptions stay untouched.
  await s.batch([
    s.q(`UPDATE payee SET name = ?3, updated_at = ?4 WHERE budget_id = ?1 AND id = ?2`, keep, name, now),
    s.q(
      `UPDATE payee_alias SET payee_id = ?2 WHERE budget_id = ?1 AND payee_id IN (${places(rest.length, 3)})`,
      keep,
      ...rest,
    ),
    s.q(
      `UPDATE txn_overlay SET payee_id = ?2 WHERE budget_id = ?1 AND payee_id IN (${places(rest.length, 3)})`,
      keep,
      ...rest,
    ),
    s.q(
      `UPDATE payee SET merged_into = ?2, updated_at = ?3 WHERE budget_id = ?1 AND id IN (${places(rest.length, 4)})`,
      keep,
      now,
      ...rest,
    ),
    s.audit('payee.merge', 'payee_merge', undoId, before, { keep, ids, name }, now),
  ]);
  const out: MergeResult = { ok: true, undoId };
  return c.json(out);
});

payeesRoutes.post('/settings/payees/merge/:undoId/undo', async (c) => {
  const s = scoped(c);
  const now = clock(c.env);
  const undoId = c.req.param('undoId');
  const [row, done] = await s.batch([
    s.q(
      `SELECT id, before FROM audit_log WHERE budget_id = ?1 AND action = 'payee.merge' AND entity_id = ?2`,
      undoId,
    ),
    s.q(
      `SELECT 1 FROM audit_log WHERE budget_id = ?1 AND action = 'payee.merge.undo' AND entity_id = ?2`,
      undoId,
    ),
  ]);
  const b = row!.results[0] as { id: number; before: string } | undefined;
  if (!b) throw new HttpError(404, 'not_found', 'merge');
  if (done!.results.length) return c.json({ ok: true });
  const before = JSON.parse(b.before) as MergeBefore;
  const ids = Object.keys(before.names);
  const now_ = await s.all<{ id: string; updated_at: number; merged_into: string | null }>(
    `SELECT id, updated_at, merged_into FROM payee WHERE budget_id = ?1 AND id IN (${places(ids.length, 2)})`,
    ...ids,
  );
  // Nothing may have changed since: a rename, another join, or the kept payee joined into another.
  const later = await s.first(
    `SELECT 1 FROM audit_log WHERE budget_id = ?1 AND id > ?2 AND (
       (action = 'payee.rename' AND entity_id IN (${places(ids.length, 3)}))
       OR (action = 'payee.merge' AND EXISTS (SELECT 1 FROM json_each(json_extract(after, '$.ids')) WHERE value IN (${places(ids.length, 3)}))))
     LIMIT 1`,
    b.id,
    ...ids,
  );
  const unchanged =
    !later &&
    now_.length === ids.length &&
    now_.every(
      (p) =>
        p.updated_at === before.at &&
        (p.id === before.keep ? p.merged_into === null : p.merged_into === before.keep),
    );
  if (!unchanged) throw new HttpError(409, 'payee_changed', 'Can’t undo now: this payee changed since.');
  const w: Stmt[] = [];
  for (const [id, name] of Object.entries(before.names))
    w.push(
      s.q(
        `UPDATE payee SET name = ?3, merged_into = NULL, updated_at = ?4 WHERE budget_id = ?1 AND id = ?2`,
        id,
        name,
        now,
      ),
    );
  for (const a of before.aliases)
    w.push(s.q(`UPDATE payee_alias SET payee_id = ?3 WHERE budget_id = ?1 AND id = ?2`, a.id, a.payee));
  const listed = new Set<string>();
  for (const [payee, keys] of Object.entries(before.keys)) {
    for (const k of chunks(keys)) {
      w.push(
        s.q(
          `UPDATE txn_overlay SET payee_id = ?2 WHERE budget_id = ?1 AND payee_id = ?3 AND txn_key IN (${places(k.length, 4)})`,
          payee,
          before.keep,
          ...k,
        ),
      );
      for (const x of k) listed.add(x);
    }
  }
  // Rows that synced in after the join: back to the payee of the moved alias their bank text resolves through.
  const byKey = new Map<string, string>();
  for (const a of before.aliases) {
    if (a.merchant) byKey.set(`m:${a.merchant}`, a.payee);
    if (a.pattern) byKey.set(`d:${a.pattern}`, a.payee);
  }
  if (byKey.size) {
    const since = await s.all<{ txn_key: string; raw_name: string; merchant_entity_id: string | null }>(
      `SELECT o.txn_key, b.raw_name, b.merchant_entity_id FROM txn_overlay o JOIN bank_txn b ON b.txn_key = o.txn_key
       WHERE o.budget_id = ?1 AND o.payee_id = ?2 AND o.created_at >= ?3`,
      before.keep,
      before.at,
    );
    for (const t of since) {
      if (listed.has(t.txn_key)) continue;
      const to =
        byKey.get(payeeKey(t.raw_name, t.merchant_entity_id)) ?? byKey.get(payeeKey(t.raw_name, null));
      if (to)
        w.push(
          s.q(`UPDATE txn_overlay SET payee_id = ?3 WHERE budget_id = ?1 AND txn_key = ?2`, t.txn_key, to),
        );
    }
  }
  w.push(s.audit('payee.merge.undo', 'payee_merge', undoId, null, null, now));
  await s.batch(w);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- renaming

payeesRoutes.post('/settings/payees/:id', async (c) => {
  const r = await parse(RenamePayee, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
  const id = c.req.param('id');
  const all = await s.all<{ id: string; name: string; merged_into: string | null }>(
    `SELECT id, name, merged_into FROM payee WHERE budget_id = ?1 AND (id = ?2 OR merged_into IS NULL)`,
    id,
  );
  const me = all.find((p) => p.id === id);
  if (!me) throw new HttpError(404, 'not_found', 'payee');
  // A rename sent before this payee was joined into another (say, queued offline) mustn't rename the other one.
  if (me.merged_into) throw new HttpError(409, 'payee_changed', 'This payee was joined into another one.');
  const taken = all.find((p) => p.id !== id && !p.merged_into && samePayeeName(p.name, r.name));
  if (taken)
    throw new HttpError(409, 'name_taken', `You have a payee named ${taken.name}. Join them instead.`);
  await s.batch([
    s.q(
      `UPDATE payee SET name = ?3, updated_at = ?4 WHERE budget_id = ?1 AND id = ?2`,
      id,
      r.name.trim(),
      now,
    ),
    s.audit('payee.rename', 'payee', id, { name: me.name }, r, now),
  ]);
  return c.json({ ok: true });
});
