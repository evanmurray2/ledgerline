// A rehearsal of the cutover (src/seal/cutover.ts; docs/privacy.md section 8, steps 6 and 7) on the seeded budget,
// over the real routes: the phone's copy is the server's, table for table; the budget is frozen, takes the phone's
// first entry and first snapshot, and is sealed; the phone and a second device then live on the log; and the way
// back puts the old budget back as it was.
import { ulid } from '@ledgerline/platform';
import { encryptToken, parseKeyring, tokenKeyBytes } from '@ledgerline/platform';
import { cursorHash, encodeEntry, linkMac, serverKeys, startChain, toHex } from '@ledgerline/seal';
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { DeviceLog } from '../src/local/device-log.js';
import { differingTables, dumpChunks, openSnapshot, tableHashes } from '../src/local/device-snapshot.js';
import type { LocalEngine } from '../src/local/engine.js';
import { httpTransport } from '../src/local/http-transport.js';
import { LogSession } from '../src/local/log-session.js';
import { FILED_KEY, FILED_LINK } from '../src/local/sealed-filing.js';
import type { RestBatch } from '../src/routes/sync.js';
import type { FreezeAnswer } from '../src/seal/cutover.js';
import { PHONE, Writer } from './log-writer.js';
import { syncPhone } from './phone.js';
import { ownerDb } from './store-db.js';
import { differences, newPhone, rowsOf } from './twin.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };
/** The test server's clock (FAKE_NOW). */
const NOW = Date.parse('2026-11-14T20:00:00Z');
const LAPTOP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';
const LINK = '01HAAAAAAAAAAAAAAAAAAAAAAA';
const e = env as unknown as { TOKEN_KEYS: string; TOKEN_KEY_CURRENT: string };
const b64 = (b: Uint8Array) => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
const fromHex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
const get = (path: string) => SELF.fetch(`${ORIGIN}${path}`);
const post = (path: string, body: unknown = {}) =>
  SELF.fetch(`${ORIGIN}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
const assign = (amount: number) =>
  post('/api/budget/assign', { month: '2026-11', items: [{ categoryId: 'rent', amount }] });

/** The phone has everything of the budget: the synced tables, and the rest. */
async function everything(e: LocalEngine): Promise<LocalEngine> {
  await syncPhone(e);
  await e.restAgain();
  for (let n = 0; ; n++) {
    if (n > 500) throw new Error('the rest did not end');
    const ask = await e.restRequest();
    if (!ask) return e;
    const q = new URLSearchParams({ table: ask.table });
    if (ask.after !== null) q.set('after', String(ask.after));
    await e.applyRest((await (await get(`/api/sync/rest?${q}`)).json()) as RestBatch);
  }
}

describe('the cutover, rehearsed', () => {
  let budget: string;
  let phone: LocalEngine;
  let spare: LocalEngine;
  let stamp: () => Promise<void>;
  const t = httpTransport((path, init) =>
    SELF.fetch(`${ORIGIN}${path}`, { ...init, headers: { origin: ORIGIN, ...(init?.headers ?? {}) } }),
  );

  beforeAll(async () => {
    expect((await post('/__dev/seed-november')).status).toBe(200);
    budget = ((await (await get('/api/session')).json()) as { budget: { id: string } }).budget.id;
    // Some history: edits leave undo records.
    for (let i = 1; i <= 3; i++) expect((await assign(i)).status).toBe(200);
    // A bank link as a real budget has it: a token, a cursor, and (below) the Worker's stamp. Its last update is
    // dated ahead of every clock, so that no job of this test asks a real bank.
    const server = ownerDb();
    const ring = parseKeyring(e.TOKEN_KEYS, e.TOKEN_KEY_CURRENT);
    const enc = await encryptToken(ring, 'access-real', `con_${LINK}`);
    await server
      .prepare(
        `INSERT INTO connection (id, budget_id, provider, provider_item_id, institution_name, access_token_enc, key_version, cursor, setup_done, last_synced_at, linked_at, created_at, updated_at)
         VALUES (?1, ?2, 'plaid', 'item-real', 'Real Bank', ?3, ?4, 'cursor-at-the-cutover', 1, 4000000000000, 5, 6, 6)`,
      )
      .bind(`con_${LINK}`, budget, enc.enc, enc.keyVersion)
      .run();
    stamp = async () => {
      const k = await serverKeys(await tokenKeyBytes(ring.keys[enc.keyVersion]!), enc.keyVersion);
      const mac = await linkMac(
        k,
        budget,
        LINK,
        'item-real',
        Uint8Array.from(atob(enc.enc), (c) => c.charCodeAt(0)),
      );
      await server.prepare(`UPDATE bank_link SET mac = ?2 WHERE id = ?1`).bind(LINK, b64(mac)).run();
      // The seeded links never had a token: the link check says so, and they are not fetched.
      await server
        .prepare(
          `UPDATE bank_link SET check_result = 'no_token', checked_at = 1 WHERE access_token_enc IS NULL`,
        )
        .run();
    };
    phone = await everything(await newPhone());
    spare = await newPhone();
  });

  it('freezes, takes the first entry and snapshot, seals; the devices live on the log; and the way back works', async () => {
    const server = ownerDb();
    const jobs = async () =>
      (await server.prepare(`SELECT kind FROM job ORDER BY kind`).all<{ kind: string }>()).results.map(
        (j) => j.kind,
      );
    const jobsBefore = await jobs();

    // ---- the screen asks where the budget stands, and what stands in the way, before any key is made
    expect(await (await get('/api/cutover/state')).json()).toEqual({
      open: true,
      sealed: false,
      backUntil: null,
    });
    expect(await (await post('/api/cutover/ready')).json()).toEqual({
      ok: true,
      blocks: ['A bank link has not been checked yet.'],
    });
    expect(await (await post('/api/cutover/freeze')).json()).toEqual({
      ok: false,
      why: ['A bank link has not been checked yet.'],
    });
    expect((await assign(40)).status).toBe(200);
    await stamp();
    phone = await everything(phone);

    // ---- freeze: nothing is part-way, and the phone's copy is the server's
    const frozen = (await (await post('/api/cutover/freeze')).json()) as FreezeAnswer;
    expect(frozen, JSON.stringify(frozen).slice(0, 300)).toMatchObject({ ok: true });
    if (!frozen.ok) return;
    // The freeze ends by the store's own clock, the one every old route reads the mark by.
    expect(Math.abs(frozen.until - (Date.now() + 15 * 60_000))).toBeLessThan(60_000);
    const before = await rowsOf(phone);
    const mine = await tableHashes(phone.db);
    const shown = mine.map((x) => ({ name: x.name, hash: toHex(x.hash) }));
    expect(
      differingTables(
        mine,
        frozen.tables.map((x) => ({ name: x.name, hash: fromHex(x.hash) })),
      ),
    ).toEqual([]);
    // Frozen: reads go on, writes wait.
    expect((await get('/api/sync?since=0&limit=5')).status).toBe(200);
    expect((await assign(50)).status).toBe(503);

    // ---- the phone makes the budget's keys, its first entry and its first snapshot
    const w = new Writer(budget, NOW - 60_000);
    const genesis = await w.genesis();
    const st = await phone.state();
    await phone.apply(
      {
        format: st.format,
        epoch: st.epoch!,
        serverTime: NOW,
        through: 1,
        more: false,
        cursor: null,
        rows: [],
      },
      NOW,
    );
    // Where filing starts: after the server's own last update, at each link's cutover cursor.
    const seed = (key: string, value: string) =>
      phone.db
        .prepare(`INSERT INTO setting (budget_id, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)`)
        .bind(budget, key, value, NOW)
        .run();
    await seed(
      FILED_KEY,
      JSON.stringify({ v: 1, run: 0, hash: '0'.repeat(64), time: 0, inbox: 0, seqBase: frozen.seqBase }),
    );
    for (const l of frozen.links) await seed(`${FILED_LINK}${l.linkId}`, l.cursorHash);
    const log = new DeviceLog(
      w.keys,
      await startChain(genesis, { now: NOW, schemaVersion: 1 }, budget),
      PHONE,
      () => NOW,
    );
    const plain = await dumpChunks(phone.db, 60_000);
    expect(plain.length).toBeGreaterThan(1);
    const snapshotId = ulid(NOW);
    const sealed = await log.sealSnapshot(snapshotId, await tableHashes(phone.db), plain);

    // Sealing before the first entry is refused.
    expect(await (await post('/api/cutover/seal')).json()).toMatchObject({ ok: false });
    const first = {
      genesis: b64(encodeEntry(genesis)),
      header: b64(sealed.header),
      signature: b64(sealed.signature),
      manifest: b64(sealed.manifest),
      chunks: sealed.chunks.length,
    };
    // The server compares the phone's hashes with its own: a copy that differs is not taken.
    const off = shown.map((x, i) => (i === 0 ? { ...x, hash: 'ab'.repeat(32) } : x));
    expect(await (await post('/api/cutover/begin', { ...first, tables: off })).json()).toEqual({
      ok: false,
      why: 'This device’s copy is not the same as the server’s.',
    });
    // A write that slipped past the freeze (a read that also writes, a step that was running) stops the move.
    await server
      .prepare(
        `INSERT INTO audit_log (budget_id, action, entity, created_at) VALUES (?1, 'slipped', 'test', 1)`,
      )
      .bind(budget)
      .run();
    expect(await (await post('/api/cutover/begin', { ...first, tables: shown })).json()).toEqual({
      ok: false,
      why: 'The budget changed while it was frozen. Start again.',
    });
    await server.prepare(`DELETE FROM audit_log WHERE action = 'slipped'`).run();
    expect(await (await post('/api/cutover/freeze')).json()).toMatchObject({ ok: true });
    const begun = await post('/api/cutover/begin', {
      genesis: b64(encodeEntry(genesis)),
      header: b64(sealed.header),
      signature: b64(sealed.signature),
      manifest: b64(sealed.manifest),
      chunks: sealed.chunks.length,
      tables: shown,
    });
    expect(await begun.json()).toEqual({ ok: true });
    // Not whole yet: not sealed.
    expect(await (await post('/api/cutover/seal')).json()).toMatchObject({ ok: false });
    for (const [i, c] of sealed.chunks.entries()) {
      const r = await SELF.fetch(`${ORIGIN}/api/cutover/chunks/${snapshotId}/${i + 1}`, {
        method: 'PUT',
        headers: { origin: ORIGIN, 'x-ledgerline': '1', 'content-type': 'application/octet-stream' },
        body: c,
      });
      expect(await r.json()).toEqual({ ok: true });
    }
    expect(await (await post('/api/cutover/seal')).json()).toEqual({ ok: true });
    const sealedState = (await (await get('/api/cutover/state')).json()) as {
      open: boolean;
      sealed: boolean;
      backUntil: string;
    };
    expect(sealedState).toMatchObject({ open: false, sealed: true });
    expect(Date.parse(sealedState.backUntil)).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    // ---- the banks of a sealed budget: the server says each link's state and no name
    const links = (await (await get('/api/settings/connections')).json()) as {
      used: number;
      items: { id: string; institution: string; accounts: string; status: string }[];
    };
    expect(links.items.length).toBeGreaterThan(0);
    expect(links.items.every((i) => i.institution === '' && i.accounts === '')).toBe(true);
    expect(links.items.find((i) => i.id === `con_${LINK}`)).toMatchObject({ status: 'ok' });
    // A fetch the person asks for: only stamped links are asked (the seeded ones never had a token).
    expect(await (await post('/api/settings/connections/refresh')).json()).toEqual({ ok: true, started: 1 });
    expect((await post(`/api/settings/connections/con_${LINK}/refresh`)).status).toBe(200);
    expect((await post('/api/settings/connections/con_nothing/refresh')).status).toBe(404);
    expect(
      (
        await server
          .prepare(`SELECT fetch_requested AS n FROM bank_link WHERE id = ?1`)
          .bind(LINK)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    // What the server kept about the app's use is answered and dropped; every other old route stays closed.
    expect((await post('/api/usage')).status).toBe(204);
    expect((await post('/api/settings/connections/exchange')).status).toBe(409);

    // ---- sealed: the old routes are closed, the log's are open, and the old tables are as they were
    expect((await get('/api/sync?since=0&limit=5')).status).toBe(409);
    expect((await assign(60)).status).toBe(409);
    // An app that can open a sealed budget learns who is signed in, and nothing of the budget; an older app is
    // told to update.
    expect((await get('/api/session')).status).toBe(409);
    const who = await SELF.fetch(`${ORIGIN}/api/session`, { headers: { 'x-ledgerline-sealed': '1' } });
    expect(await who.json()).toMatchObject({ sealed: true, budgetId: budget, writeState: 'ok' });
    expect(await (await get('/api/log?after=0')).json()).toMatchObject({ number: 1 });
    expect(await t.list()).toMatchObject([{ id: snapshotId, number: 1, check: null }]);
    // Only the sealed budget's own jobs are left (the backstop, and the fetch it queues for the link).
    expect(await jobs()).toContain('sealed_backstop');
    expect((await jobs()).filter((k) => !k.startsWith('sealed_'))).toEqual([]);
    // Each link the server fetches starts at its cutover cursor, under the Worker's stamp.
    const cursors = (
      await server
        .prepare(`SELECT link_id, cursor FROM link_cursor ORDER BY link_id`)
        .all<{ link_id: string; cursor: string }>()
    ).results;
    expect(cursors).toEqual([{ link_id: LINK, cursor: 'cursor-at-the-cutover' }]);
    expect(cursors.map((c) => c.link_id)).toEqual(frozen.links.map((l) => l.linkId));
    for (const [i, c] of cursors.entries())
      expect(toHex(await cursorHash(c.cursor))).toBe(frozen.links[i]!.cursorHash);

    // The phone goes on: an edit is an entry.
    const session = new LogSession(phone, log, t, encodeEntry);
    const r = await phone.enqueue({
      id: 'cutover-edit-1-xxxxxx',
      at: NOW,
      method: 'POST',
      path: '/api/budget/assign',
      body: { month: '2026-11', items: [{ categoryId: 'rent', amount: 70 }] },
    });
    expect(r.response.status).toBe(200);
    expect(await session.flush()).toEqual({ sent: 1, lost: 0 });
    // A second device opens the first snapshot and reads the log: the same budget.
    const log2 = await openSnapshot(spare, t, {
      keys: [w.keys],
      budgetId: budget,
      deviceId: LAPTOP,
      clock: () => NOW,
    });
    expect(log2.number).toBe(1);
    expect(await new LogSession(spare, log2, t, encodeEntry).pull()).toEqual({ entries: 1, lost: 0 });
    expect(differences(await rowsOf(spare), await rowsOf(phone))).toEqual([]);

    // ---- the way back: open for 7 days, then closed
    const at = (await server
      .prepare(`SELECT value FROM store_note WHERE key = 'cutover_at'`)
      .first<{ value: number }>())!.value;
    await server
      .prepare(`UPDATE store_note SET value = ?1 WHERE key = 'cutover_at'`)
      .bind(at - 8 * 86_400_000)
      .run();
    expect(await (await post('/api/cutover/back')).json()).toEqual({
      ok: false,
      why: 'The way back is closed.',
    });
    await server.prepare(`UPDATE store_note SET value = ?1 WHERE key = 'cutover_at'`).bind(at).run();
    // The old budget, as it was at the freeze.
    expect(await (await post('/api/cutover/back')).json()).toEqual({ ok: true });
    expect((await get('/api/sync?since=0&limit=5')).status).toBe(200);
    expect(await jobs()).toEqual(jobsBefore);
    const again = await everything(await newPhone());
    expect(differences(await rowsOf(again), before)).toEqual([]);
    expect((await assign(80)).status).toBe(200);
    expect(await (await post('/api/cutover/back')).json()).toMatchObject({ ok: false });
    // The log's routes are closed again.
    expect((await get('/api/log?after=0')).status).toBe(404);

    // ---- a second try starts clean; work part-way stands in its way
    await server
      .prepare(
        `INSERT INTO job (id, kind, state, run_at, recurring, created_at, updated_at) VALUES ('one-off', 'refile_payees', '{}', ?1, 0, 1, 1)`,
      )
      .bind(NOW + 86_400_000)
      .run();
    const blocked = (await (await post('/api/cutover/freeze')).json()) as FreezeAnswer;
    expect(blocked).toEqual({ ok: false, why: ['A background job is part-way.'] });
    expect((await assign(81)).status).toBe(200);
    await server.prepare(`DELETE FROM job WHERE id = 'one-off'`).run();
    const second = (await (await post('/api/cutover/freeze')).json()) as FreezeAnswer;
    expect(second).toMatchObject({ ok: true });
    expect((await server.prepare(`SELECT count(*) AS n FROM log_entry`).first<{ n: number }>())!.n).toBe(0);
    // A freeze that is over: nothing more is taken, and the budget is as it was.
    await server.prepare(`UPDATE store_mark SET until = 1 WHERE key = 'frozen'`).run();
    const late = await post('/api/cutover/begin', {
      genesis: b64(encodeEntry(genesis)),
      header: b64(sealed.header),
      signature: b64(sealed.signature),
      manifest: b64(sealed.manifest),
      chunks: sealed.chunks.length,
      tables: shown,
    });
    expect(await late.json()).toEqual({ ok: false, why: 'The budget is not frozen any more. Start again.' });
    expect((await assign(82)).status).toBe(200);
  }, 120_000);
});
