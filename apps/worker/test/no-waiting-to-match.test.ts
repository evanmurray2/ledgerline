// D-98: nothing is held in Waiting to match. Money from a person counts like any other money in; Match links it to
// what it pays back, Unlink returns it to the usual rules, and Owed to you offers it for Match. Migration 0012
// releases what was held before.
import { app, phoneDb } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActivityView, BudgetView, OwedView } from '@ledgerline/contracts';
import { BUDGET_MIGRATIONS } from '../src/store/migrations.gen.js';

const db = phoneDb();
const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const json = async <T>(path: string, init?: RequestInit) => (await (await app(path, init)).json()) as T;
const overlay = (key: string) =>
  db
    .prepare(`SELECT wtm_state, to_rta FROM txn_overlay WHERE txn_key = ?1`)
    .bind(key)
    .first<{ wtm_state: string | null; to_rta: number }>();
const rta = async () => (await json<BudgetView>('/api/budget/2026-11')).rta;

describe('no Waiting to match (D-98)', () => {
  beforeAll(async () => {
    expect((await app('/__dev/seed-november', { method: 'POST', headers: H, body: '{}' })).status).toBe(200);
  });

  it('money from a person is in Ready to Assign, and Needs attention has no Money to match', async () => {
    expect(await overlay('n-venmo')).toMatchObject({ wtm_state: null });
    const v = await json<ActivityView & { moneyToMatch?: unknown }>('/api/activity?filter=attention');
    expect(v.moneyToMatch).toBeUndefined();
    expect(v.needsCategory.map((r) => r.key)).not.toContain('n-venmo');
  });

  it('Owed to you offers it; Match leaves Ready to Assign as it was; Unlink offers it again', async () => {
    const owed = await json<OwedView>('/api/owed');
    expect(owed.payback).toMatchObject({ key: 'n-venmo', amount: 101800 });
    const before = await rta();
    const view = await json<{ open: { id: string; suggested: number }[] }>('/api/match/n-venmo');
    const items = view.open
      .filter((o) => o.suggested > 0)
      .map((o) => ({ itemId: o.id, amount: o.suggested }));
    expect(items.length).toBeGreaterThan(0);
    const r = await app('/api/match', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ inflowKey: 'n-venmo', items }),
    });
    expect(r.status).toBe(200);
    // The money was counted when it came in: a match only settles what it pays back.
    expect(await rta()).toBe(before);
    expect(await overlay('n-venmo')).toEqual({ wtm_state: 'matched', to_rta: 1 });
    expect((await json<OwedView>('/api/owed')).payback?.key).not.toBe('n-venmo');

    expect((await app('/api/match/n-venmo/unlink', { method: 'POST', headers: H })).status).toBe(200);
    expect(await overlay('n-venmo')).toEqual({ wtm_state: null, to_rta: 0 });
    expect(await rta()).toBe(before);
    expect((await json<OwedView>('/api/owed')).payback?.key).toBe('n-venmo');
  });

  it('an edit an older app queued with a rest choice still applies', async () => {
    const r = await app('/api/match', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ inflowKey: 'n-venmo', items: [], rest: 'keep' }),
    });
    expect(r.status).toBe(200);
    expect(await overlay('n-venmo')).toEqual({ wtm_state: 'income', to_rta: 1 });
    expect((await app('/api/match/n-venmo/unlink', { method: 'POST', headers: H })).status).toBe(200);
  });

  it('migration 0012 releases held money: matched when it pays something back, else the usual rules', async () => {
    const m = BUDGET_MIGRATIONS.find((x) => x.name === '0012_release_waiting_to_match.sql')!;
    // Hold n-venmo with nothing matched, and n-zelle (which the seed matched) as "I'll send it back".
    await db
      .prepare(`UPDATE txn_overlay SET wtm_state = 'waiting', to_rta = 0 WHERE txn_key = 'n-venmo'`)
      .run();
    await db
      .prepare(`UPDATE txn_overlay SET wtm_state = 'send_back', to_rta = 0 WHERE txn_key = 'n-zelle'`)
      .run();
    const statements = m.sql
      .split('\n')
      .filter((l) => !l.startsWith('--'))
      .join('\n')
      .split(';')
      .map((x) => x.trim())
      .filter(Boolean);
    for (const sql of statements) await db.prepare(sql).run();
    expect(await overlay('n-venmo')).toMatchObject({ wtm_state: null });
    expect(await overlay('n-zelle')).toMatchObject({ wtm_state: 'matched' });
    const audit = await db
      .prepare(
        `SELECT entity_id, before FROM audit_log WHERE action = 'transaction.release_waiting' ORDER BY entity_id`,
      )
      .all<{ entity_id: string; before: string }>();
    expect(audit.results.map((a) => [a.entity_id, JSON.parse(a.before).wtm_state])).toEqual([
      ['n-venmo', 'waiting'],
      ['n-zelle', 'send_back'],
    ]);
  });
});
