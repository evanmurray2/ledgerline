import { encodeEntry, randomBytes } from '@ledgerline/seal';
import { describe, expect, it } from 'vitest';
import {
  fetchPublicEntries,
  logDeviceId,
  newUlid,
  openSealedBudget,
  type SealedHost,
} from '../src/copy/sealed';
import { addPasskeyEntry, createBudget, openWithPasskey } from '../src/keys/budget';

const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PHONE = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const NOW = 1_800_000_000_000;
const passkey = () => ({ credentialId: randomBytes(20), prf: randomBytes(32) });
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

/** A server that gives the public entries one to a page. */
const server = (entries: Uint8Array[]) => {
  const asked: string[] = [];
  return {
    asked,
    fetch: async (path: string) => {
      asked.push(path);
      const after = Number(new URL(`https://x${path}`).searchParams.get('after'));
      const i = after; // entry numbers 1, 2, ... in order
      const page = entries.slice(i, i + 1);
      return new Response(
        JSON.stringify({ entries: page.map(b64), last: i + page.length, more: i + 1 < entries.length }),
      );
    },
  };
};
const host = (ready: boolean) => {
  const calls: unknown[][] = [];
  const h: SealedHost = {
    sealedOpen: async (...a) => (calls.push(['open', ...a]), { ready, number: ready ? 7 : 0 }),
    sealedJoin: async () => (calls.push(['join']), { number: 3 }),
  };
  return { h, calls };
};

describe('opening a sealed budget in the app', () => {
  it('opens the key with the passkey, hands the derived keys to the engine, and remembers the last public entry', async () => {
    const mine = passkey();
    const made = await createBudget({ budgetId: BUDGET, deviceId: PHONE, passkey: mine, now: NOW });
    const opened = await openWithPasskey([made.genesis], BUDGET, mine);
    const second = passkey();
    const slot = await addPasskeyEntry({
      state: opened.state,
      budget: opened.budget,
      passkey: second,
      deviceId: PHONE,
      at: { number: 1, hash: made.genesis.hash, deviceCounter: 1, filedThrough: 0, scanThrough: 0 },
      now: NOW + 1000,
    });
    const s = server([encodeEntry(made.genesis), encodeEntry(slot)]);
    expect((await fetchPublicEntries(s.fetch)).map((e) => e.header.number)).toEqual([1, 2]);
    expect(s.asked).toEqual(['/api/log/public?after=0', '/api/log/public?after=1']);

    // A device that has its place: no snapshot is opened.
    const kept = host(true);
    const r = await openSealedBudget({
      host: kept.h,
      fetch: s.fetch,
      budgetId: BUDGET,
      deviceId: PHONE,
      passkey: second,
      workerKeys: [[1, randomBytes(32)]],
    });
    expect(r).toMatchObject({ number: 7, joined: false, lastPublic: { number: 2 } });
    expect(kept.calls.map((c) => c[0])).toEqual(['open']);
    const keys = kept.calls[0]![1] as { version: number; sign: { pub: Uint8Array } }[];
    expect(keys.map((k) => k.version)).toEqual([1]);
    expect([...keys[0]!.sign.pub]).toEqual([...made.budget.keys.sign.pub]);
    expect(kept.calls[0]![2]).toBe(PHONE);

    // A new device starts from a snapshot.
    const fresh = host(false);
    const j = await openSealedBudget({
      host: fresh.h,
      fetch: s.fetch,
      budgetId: BUDGET,
      deviceId: PHONE,
      passkey: mine,
      workerKeys: [],
    });
    expect(j).toMatchObject({ number: 3, joined: true });
    expect(fresh.calls.map((c) => c[0])).toEqual(['open', 'join']);

    // With no signal the budget opens from the public entries kept with the copy, and only on a device that
    // has its place in the log: a snapshot can't be read without the server.
    const off = host(true);
    const o = await openSealedBudget({
      host: off.h,
      kept: r.publics,
      budgetId: BUDGET,
      deviceId: PHONE,
      passkey: second,
      workerKeys: [],
      remembered: r.lastPublic,
    });
    expect(o).toMatchObject({ number: 7, joined: false, publics: r.publics });
    const noPlace = host(false);
    await expect(
      openSealedBudget({
        host: noPlace.h,
        kept: r.publics,
        budgetId: BUDGET,
        deviceId: PHONE,
        passkey: second,
        workerKeys: [],
      }),
    ).rejects.toThrow('Connect to the internet to open your budget.');
    expect(noPlace.calls.map((c) => c[0])).toEqual(['open']);
    await expect(
      openSealedBudget({ host: off.h, budgetId: BUDGET, deviceId: PHONE, passkey: second, workerKeys: [] }),
    ).rejects.toThrow('Connect to the internet to open your budget.');

    // A passkey that is no way in, and a server that hides the entry the device remembers: the engine gets nothing.
    const none = host(true);
    await expect(
      openSealedBudget({
        host: none.h,
        fetch: s.fetch,
        budgetId: BUDGET,
        deviceId: PHONE,
        passkey: passkey(),
        workerKeys: [],
      }),
    ).rejects.toThrow();
    const short = server([encodeEntry(made.genesis)]);
    await expect(
      openSealedBudget({
        host: none.h,
        fetch: short.fetch,
        budgetId: BUDGET,
        deviceId: PHONE,
        passkey: mine,
        workerKeys: [],
        remembered: r.lastPublic,
      }),
    ).rejects.toThrow();
    expect(none.calls).toEqual([]);
    // A fault of the server is an error the screens can show.
    await expect(fetchPublicEntries(async () => new Response('no', { status: 500 }))).rejects.toThrow(
      'Something went wrong. Try again.',
    );
  });
});

describe('a copy as a writer of the log', () => {
  it('has one id, made once and kept with the copy', async () => {
    const kept = new Map<string, string>();
    const store = {
      get: async (k: string) => kept.get(k) ?? null,
      put: async (k: string, v: string | null) => void (v === null ? kept.delete(k) : kept.set(k, v)),
    };
    const id = await logDeviceId(store);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(await logDeviceId(store)).toBe(id);
    // Another copy is another writer; a kept value that is no id is replaced.
    const other = { ...store, get: async () => 'not-an-id' };
    expect(await logDeviceId(other)).not.toBe(id);
    expect(newUlid(0).slice(0, 10)).toBe('0000000000');
    expect(newUlid(1_800_000_000_000) > newUlid(1_700_000_000_000)).toBe(true);
  });
});
