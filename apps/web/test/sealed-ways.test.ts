// The ways in of a locked budget changed from the app (src/copy/sealed-ways.ts), against a log that runs the
// server's own rules for a write (packages/seal server-append.ts), with a session that came in by a fresh way or not.
import {
  AppendRefused,
  type ChainState,
  checkWrite,
  type Entry,
  encodeEntry,
  INTENT_WAIT_MS,
  KIND,
  randomBytes,
  readEntry,
  startChain,
  fromHex,
  showRecoveryKey,
  newRecoveryKey,
  verifyRecoveryLogin,
  passkeySlotId,
} from '@ledgerline/seal';
import { describe, expect, it } from 'vitest';
import {
  createBudget,
  NoSlotError,
  openWithPasskey,
  openWithRecoveryKey,
  WayInError,
} from '../src/keys/budget';
import { openSealedBudget } from '../src/copy/sealed';
import {
  addPasskeyWay,
  addRecoveryWay,
  authPubOf,
  cancelPlan,
  finishPlan,
  openPlans,
  recoveryKeySignIn,
  removeWays,
  type Ways,
} from '../src/copy/sealed-ways';
import type { AppendAnswer, WritePlace } from '../src/copy/host';

const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PHONE = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const T0 = 1_800_000_000_000;
const passkey = () => ({ credentialId: randomBytes(20), prf: randomBytes(32) });
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const PUBLIC: number[] = [KIND.genesis, KIND.slotChange, KIND.keyChange, KIND.intent, KIND.cancel];

/** The server's log and a device's engine over it, in one: every write is checked by the server's own rules. */
async function world(o: { freshWay: boolean }) {
  const mine = passkey();
  const made = await createBudget({ budgetId: BUDGET, deviceId: PHONE, passkey: mine, now: T0 });
  const log: Entry[] = [made.genesis];
  let chain: ChainState = await startChain(made.genesis, { now: T0, schemaVersion: 1 }, BUDGET);
  const w = {
    now: T0 + 1000,
    freshWay: o.freshWay,
    keys: [] as unknown[],
    appends: 0,
    get publics() {
      return log.filter((e) => PUBLIC.includes(e.header.kind));
    },
  };
  const host = {
    sealedPlace: async (): Promise<WritePlace> => ({
      number: chain.number,
      hash: chain.hash,
      deviceId: PHONE,
      deviceCounter: chain.counters.get(PHONE) ?? 0,
      filedThrough: chain.filedThrough,
      scanThrough: chain.scanThrough,
      time: Math.max(w.now, chain.time + 1),
      lastPublic: chain.public.lastPublic,
      keyVersion: chain.public.keyVersion,
      whole: true,
    }),
    sealedAppend: async (bytes: Uint8Array[], keys?: unknown[]): Promise<AppendAnswer> => {
      w.appends++;
      const entries = await Promise.all(bytes.map((b) => readEntry(b)));
      if (entries[0]!.header.number !== chain.number + 1)
        return { ok: false, why: 'behind', number: chain.number, retry: true };
      try {
        const next = await checkWrite(chain, entries, {
          now: w.now,
          freshWay: w.freshWay,
          schemaVersion: 1,
          processingVersion: 1,
          stored: async () => null,
          lastCompleteRun: 0,
          receiptHashes: async () => [],
          resting: false,
          keyEntriesLeft: 100,
        });
        if (next !== 'already stored') chain = next;
      } catch (x) {
        if (x instanceof AppendRefused) return { ok: false, why: x.why, detail: x.detail, retry: x.retry };
        throw x;
      }
      log.push(...entries);
      if (keys) w.keys.push(...keys);
      return { ok: true, number: chain.number };
    },
  };
  const fetch = async (path: string) => {
    const u = new URL(`https://x${path}`);
    if (u.pathname === '/api/log/runs')
      return new Response(JSON.stringify({ runs: [], last: 0, more: false }));
    const after = Number(u.searchParams.get('after'));
    const page = w.publics.filter((e) => e.header.number > after);
    return new Response(
      JSON.stringify({
        entries: page.map((e) => b64(encodeEntry(e))),
        last: page.at(-1)?.header.number ?? after,
        more: false,
      }),
    );
  };
  const ways: Ways = { host, fetch, budgetId: BUDGET };
  return { w, ways, made, mine, chain: () => chain };
}

describe('the ways in of a locked budget, from the app', () => {
  it('a new passkey opens nothing; the recovery key opens the budget and adds it, and then it alone opens it', async () => {
    const { w, ways, made } = await world({ freshWay: true });
    const fresh = passkey();
    await expect(openWithPasskey(w.publics, BUDGET, fresh)).rejects.toBeInstanceOf(NoSlotError);
    const opened = await openWithRecoveryKey(w.publics, BUDGET, made.recoveryText);
    // From a fresh way in too: a slot change is never held back.
    expect(await addPasskeyWay(ways, opened.budget, fresh)).toEqual({ ok: true });
    expect((await openWithPasskey(w.publics, BUDGET, fresh)).budget.keys.version).toBe(1);
    // Once more: it is a way in already, and nothing is sent.
    const sent = w.appends;
    expect(await addPasskeyWay(ways, opened.budget, fresh)).toEqual({ ok: true });
    expect(w.appends).toBe(sent);
  });

  it('opening with a passkey that is no way in falls back to the recovery key, which adds it', async () => {
    const { w, ways, made } = await world({ freshWay: true });
    const fresh = passkey();
    const calls: string[] = [];
    let added: unknown = null;
    const r = await openSealedBudget({
      host: {
        sealedOpen: async (keys) => (calls.push(`open ${keys.length}`), { ready: false, number: 0 }),
        sealedJoin: async () => (calls.push('join'), { number: 1 }),
      },
      fetch: ways.fetch,
      budgetId: BUDGET,
      deviceId: PHONE,
      passkey: fresh,
      workerKeys: [],
      recovery: made.recoveryText,
      onRecovered: async (budget) => {
        calls.push('recovered');
        added = await addPasskeyWay(ways, budget, fresh);
      },
    });
    expect(r.recovered).toBe(true);
    expect(calls).toEqual(['open 1', 'join', 'recovered']);
    expect(added).toEqual({ ok: true });
    expect((await openWithPasskey(w.publics, BUDGET, fresh)).state.slots.size).toBe(3);
    // Without the key, or with a wrong one, nothing opens.
    const other = passkey();
    const host = {
      sealedOpen: async () => ({ ready: true, number: 1 }),
      sealedJoin: async () => ({ number: 1 }),
    };
    const base = {
      host,
      fetch: ways.fetch,
      budgetId: BUDGET,
      deviceId: PHONE,
      passkey: other,
      workerKeys: [],
    };
    await expect(openSealedBudget(base)).rejects.toBeInstanceOf(NoSlotError);
    await expect(
      openSealedBudget({ ...base, recovery: await showRecoveryKey(newRecoveryKey()) }),
    ).rejects.toBeInstanceOf(WayInError);
  });

  it('removing a way from an older passkey: a key change at once, and the new keys go to the engine', async () => {
    const { w, ways, made, mine, chain } = await world({ freshWay: false });
    const second = passkey();
    const opened = await openWithPasskey(w.publics, BUDGET, mine);
    await addPasskeyWay(ways, opened.budget, second);
    const id = passkeySlotId(second.credentialId);
    expect(chain().public.slots.has(id)).toBe(true);
    const given: unknown[] = [];
    const r = await removeWays(ways, opened.budget, [id!], async (k) => void given.push(k));
    expect(r).toEqual({ ok: true });
    expect(chain().public.keyVersion).toBe(2);
    expect(given.map((k) => (k as { version: number }).version)).toEqual([2]);
    expect(w.keys.map((k) => (k as { version: number }).version)).toEqual([2]);
    // The removed passkey opens nothing; the one that stays and the recovery key open version 2.
    await expect(openWithPasskey(w.publics, BUDGET, second)).rejects.toBeInstanceOf(NoSlotError);
    expect((await openWithPasskey(w.publics, BUDGET, mine)).budget.keys.version).toBe(2);
    expect((await openWithRecoveryKey(w.publics, BUDGET, made.recoveryText)).budget.keys.version).toBe(2);
  });

  it('from a fresh way in, a removal waits 7 days as a plan, which can be cancelled or finished', async () => {
    const { w, ways, made, mine, chain } = await world({ freshWay: true });
    const opened = await openWithRecoveryKey(w.publics, BUDGET, made.recoveryText);
    const pk = [...chain().public.slots.keys()].find((s) => s.startsWith('p:'))!;
    const planned = await removeWays(ways, opened.budget, [pk]);
    expect(planned).toMatchObject({ ok: true, waits: expect.any(Number) });
    const waits = (planned as { waits: number }).waits;
    expect(waits - w.now).toBeGreaterThanOrEqual(INTENT_WAIT_MS);
    expect(chain().public.keyVersion).toBe(1);
    expect(openPlans(chain().public)).toEqual([{ number: 2, notBefore: waits, slotIds: [pk] }]);
    // Asked again before it is due: the same plan, no second one.
    expect(await removeWays(ways, opened.budget, [pk])).toEqual({ ok: true, waits });
    expect(openPlans(chain().public)).toHaveLength(1);
    // Cancelled: the passkey stays.
    expect(await cancelPlan(ways, opened.budget, 2)).toEqual({ ok: true });
    expect(openPlans(chain().public)).toEqual([]);
    expect((await openWithPasskey(w.publics, BUDGET, mine)).budget.keys.version).toBe(1);

    // Planned again, and finished once the 7 days are over.
    const again = (await removeWays(ways, opened.budget, [pk])) as { waits: number };
    const [plan] = openPlans(chain().public);
    w.now = again.waits + 1000;
    const given: unknown[] = [];
    expect(await finishPlan(ways, opened.budget, plan!.number, async (k) => void given.push(k))).toEqual({
      ok: true,
    });
    expect(chain().public.keyVersion).toBe(2);
    expect(given).toHaveLength(1);
    expect(openPlans(chain().public)).toEqual([]);
    await expect(openWithPasskey(w.publics, BUDGET, mine)).rejects.toBeInstanceOf(NoSlotError);
  });

  it('a new recovery key: the slot change adds it, the key change leaves the old one out', async () => {
    const { w, ways, made, mine } = await world({ freshWay: false });
    const opened = await openWithPasskey(w.publics, BUDGET, mine);
    const next = newRecoveryKey();
    const added = await addRecoveryWay(ways, opened.budget, next);
    expect(added).toEqual({ ok: true, replaces: ['r:1'] });
    // Both open the budget until the key change.
    const nextText = await showRecoveryKey(next);
    expect((await openWithRecoveryKey(w.publics, BUDGET, made.recoveryText)).budget.keys.version).toBe(1);
    expect(await removeWays(ways, opened.budget, (added as { replaces: string[] }).replaces)).toEqual({
      ok: true,
    });
    await expect(openWithRecoveryKey(w.publics, BUDGET, made.recoveryText)).rejects.toBeInstanceOf(
      WayInError,
    );
    expect((await openWithRecoveryKey(w.publics, BUDGET, nextText)).budget.keys.version).toBe(2);
  });

  it('the recovery key signs in by a signature over the server’s challenge, and nothing secret is sent', async () => {
    const r = newRecoveryKey();
    const text = await showRecoveryKey(r);
    const authPub = (await authPubOf(text))!;
    expect(authPub).toMatch(/^[0-9a-f]{64}$/);
    expect(await authPubOf(r)).toBe(authPub);
    expect(await authPubOf('not a key')).toBeNull();
    const challenge = randomBytes(32);
    const sent: unknown[] = [];
    let good = false;
    const options = await recoveryKeySignIn(text, {
      options: async (pub) => (
        sent.push(pub),
        { budgetId: BUDGET, challenge: [...challenge].map((x) => x.toString(16).padStart(2, '0')).join('') }
      ),
      verify: async (sig) => {
        sent.push(sig);
        good = await verifyRecoveryLogin(fromHex(authPub), BUDGET, challenge, fromHex(sig));
        return { challenge: 'passkey options' };
      },
    });
    expect(options).toEqual({ challenge: 'passkey options' });
    expect(good).toBe(true);
    expect(sent[0]).toBe(authPub);
    expect(JSON.stringify(sent)).not.toContain(text.replace(/-/g, ''));
    await expect(
      recoveryKeySignIn('ABCDE', {
        options: async () => ({ budgetId: BUDGET, challenge: '' }),
        verify: async () => null,
      }),
    ).rejects.toBeInstanceOf(WayInError);
  });
});
