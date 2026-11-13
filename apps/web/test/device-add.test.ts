// Adding a device with its own passkey to a locked budget, both sides as the app runs them (src/copy/device-add.ts;
// docs/privacy-keys.md section 10): a relay in memory, a log that runs the server's own rules for a write, and the
// new device opening the budget with the key it was handed and adding its passkey as a way in.
import {
  AppendRefused,
  type ChainState,
  checkWrite,
  type Entry,
  encodeEntry,
  KIND,
  randomBytes,
  readEntry,
  startChain,
  walkPublic,
} from '@ledgerline/seal';
import { describe, expect, it } from 'vitest';
import { createBudget, NoSlotError, openWithPasskey } from '../src/keys/budget';
import { openSealedBudget } from '../src/copy/sealed';
import { addPasskeyWay, type Ways } from '../src/copy/sealed-ways';
import { addFromHere, joinFromOther, NOT_SAME, type Relay, type RelayState } from '../src/copy/device-add';
import type { AppendAnswer, WritePlace } from '../src/copy/host';

const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PHONE = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const T0 = 1_800_000_000_000;
const passkey = () => ({ credentialId: randomBytes(20), prf: randomBytes(32) });
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const PUBLIC: number[] = [KIND.genesis, KIND.slotChange, KIND.keyChange, KIND.intent, KIND.cancel];

/** The server's log and an engine over it, as in sealed-ways.test.ts; `lie` changes the entries the server gives. */
async function world() {
  const mine = passkey();
  const made = await createBudget({ budgetId: BUDGET, deviceId: PHONE, passkey: mine, now: T0 });
  const log: Entry[] = [made.genesis];
  let chain: ChainState = await startChain(made.genesis, { now: T0, schemaVersion: 1 }, BUDGET);
  const w = {
    lie: false,
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
      time: Math.max(T0 + 1000, chain.time + 1),
      lastPublic: chain.public.lastPublic,
      keyVersion: chain.public.keyVersion,
      whole: true,
    }),
    sealedAppend: async (bytes: Uint8Array[]): Promise<AppendAnswer> => {
      const entries = await Promise.all(bytes.map((b) => readEntry(b)));
      if (entries[0]!.header.number !== chain.number + 1)
        return { ok: false, why: 'behind', number: chain.number, retry: true };
      try {
        const next = await checkWrite(chain, entries, {
          now: T0 + 1000,
          freshWay: true,
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
      return { ok: true, number: chain.number };
    },
  };
  const fetch = async (path: string) => {
    const u = new URL(`https://x${path}`);
    const after = Number(u.searchParams.get('after'));
    const all = u.pathname === '/api/log/public' ? w.publics : log;
    const page = all.filter((e) => e.header.number > after);
    // A server that gives another entry at the head's place.
    const text = page.map((e) => b64(encodeEntry(e)));
    if (w.lie && u.pathname === '/api/log' && page[0]) {
      const forged = { ...page[0], header: { ...page[0].header, entryId: randomBytes(16) } };
      text[0] = b64(encodeEntry(forged));
    }
    return new Response(
      JSON.stringify({ entries: text, last: page.at(-1)?.header.number ?? after, more: false }),
    );
  };
  const ways: Ways = { host, fetch, budgetId: BUDGET };
  const opened = await openWithPasskey(w.publics, BUDGET, mine);
  return { w, ways, opened };
}

/** The server's relay, in memory, with its rules: each message once, in order. */
function relays() {
  let r: Record<string, string | null> | null = null;
  const pick = (keys: string[]): Partial<RelayState> =>
    Object.fromEntries(keys.map((k) => [k, r?.[k] ?? null])) as Partial<RelayState>;
  const gone = () => {
    throw new Error('gone');
  };
  const from: Relay = {
    state: async () => (r ? { ...pick(['commit', 'reveal', 'confirm']), role: 'from' } : { role: null }),
    start: async () => {
      r = {};
    },
    send: async (step, body) => {
      if (!r) return gone();
      if (step === 'offer' && body.commit === r.commit && !r.offer) r.offer = body.offer!;
      else if (step === 'sealed' && r.reveal && !r.sealed) r.sealed = body.sealed!;
      else gone();
    },
    end: async () => {
      r = null;
    },
  };
  const to: Relay = {
    state: async () => (r ? { ...pick(['offer', 'sealed']), role: 'to' } : { role: null }),
    start: async () => gone(),
    send: async (step, body) => {
      if (!r) return gone();
      if (step === 'commit' && !r.sealed)
        Object.assign(r, { commit: body.commit, offer: null, reveal: null });
      else if (step === 'reveal' && r.offer && !r.reveal) r.reveal = body.reveal!;
      else if (step === 'confirm' && r.sealed && !r.confirm) r.confirm = body.confirm!;
      else gone();
    },
    end: from.end,
  };
  return { from, to };
}

const quick = { everyMs: 1 };

describe('adding a device with its own passkey', () => {
  it('both devices show the same code; the new one opens the budget, adds its passkey, and confirms', async () => {
    const { w, ways, opened } = await world();
    const { from, to } = relays();
    const fresh = passkey();
    let shownOnO = '';
    let joined: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => (joined = resolve));
    const place = await ways.host.sealedPlace();
    const atO = addFromHere({
      relay: from,
      budgetId: BUDGET,
      keys: opened.budget.keys,
      bk: opened.budget.bk,
      head: { number: place.number, hash: place.hash as never },
      slotIds: async () => new Set((await walkPublic(w.publics, BUDGET)).slots.keys()),
      ready: async () => joined(),
      match: async (code) => ((shownOnO = code), true),
      wait: quick,
    });
    await ready;
    // The new device's passkey opens nothing yet.
    await expect(openWithPasskey(w.publics, BUDGET, fresh)).rejects.toBeInstanceOf(NoSlotError);
    const t = await joinFromOther({ relay: to, budgetId: BUDGET, fetch: ways.fetch, wait: quick });
    expect(t.code).toMatch(/^\d{6}$/);
    // The person tapped "They match" on the new device too.
    const { bk, confirm } = await t.open();
    const calls: string[] = [];
    const r = await openSealedBudget({
      host: {
        sealedOpen: async () => (calls.push('open'), { ready: false, number: 0 }),
        sealedJoin: async () => (calls.push('join'), { number: place.number }),
      },
      fetch: ways.fetch,
      budgetId: BUDGET,
      deviceId: PHONE,
      passkey: fresh,
      workerKeys: [],
      added: bk,
      onRecovered: async (budget) => {
        calls.push('added');
        expect(await addPasskeyWay(ways, budget, fresh)).toEqual({ ok: true });
      },
    });
    expect(r.recovered).toBe(true);
    expect(calls).toEqual(['open', 'join', 'added']);
    // The key was zeroed once used.
    expect(bk.every((b) => b === 0)).toBe(true);
    await confirm();
    await atO;
    expect(shownOnO).toBe(t.code);
    // From now on its passkey alone opens the budget.
    expect((await openWithPasskey(w.publics, BUDGET, fresh)).budget.keys.version).toBe(1);
  });

  it('the person says the codes differ: the signed-in device seals nothing', async () => {
    const { w, ways, opened } = await world();
    const { from, to } = relays();
    let joined: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => (joined = resolve));
    const place = await ways.host.sealedPlace();
    const atO = addFromHere({
      relay: from,
      budgetId: BUDGET,
      keys: opened.budget.keys,
      bk: opened.budget.bk,
      head: { number: place.number, hash: place.hash as never },
      slotIds: async () => new Set(),
      ready: async () => joined(),
      match: async () => false,
      wait: quick,
    }).catch((e: unknown) => e);
    await ready;
    const t = await joinFromOther({ relay: to, budgetId: BUDGET, fetch: ways.fetch, wait: quick });
    expect(((await atO) as Error).message).toBe(NOT_SAME);
    // The add ended: the new device gets nothing.
    await expect(t.open()).rejects.toThrow();
    expect(w.publics.length).toBe(1);
  });

  it('a server that gives another entry at the head is refused before the key opens', async () => {
    const { w, ways, opened } = await world();
    const { from, to } = relays();
    let joined: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => (joined = resolve));
    const place = await ways.host.sealedPlace();
    void addFromHere({
      relay: from,
      budgetId: BUDGET,
      keys: opened.budget.keys,
      bk: opened.budget.bk,
      head: { number: place.number, hash: place.hash as never },
      slotIds: async () => new Set(),
      ready: async () => joined(),
      match: async () => true,
      wait: quick,
    }).catch(() => undefined);
    await ready;
    const t = await joinFromOther({ relay: to, budgetId: BUDGET, fetch: ways.fetch, wait: quick });
    w.lie = true;
    await expect(t.open()).rejects.toThrow(/does not agree with the log/);
    await from.end();
  });
});
