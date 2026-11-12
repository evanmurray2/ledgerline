// Opening a sealed budget in the app (docs/privacy.md 5.2 and 5.3; docs/privacy-keys.md 4.4): the passkey's
// secret for the budget's way in opens the budget key from the log's public entries, the derived keys go to the
// engine's thread, and the engine takes its place in the log (kept with the copy, or from a snapshot on a new
// device). Nothing here is a screen; the pieces that touch the network and the engine are passed in.
import { type Entry, type PublicRef, readEntry, zeroize } from '@ledgerline/seal';
import { keysOfEveryVersion, openWithPasskey, type PasskeySecret } from '../keys/budget';

/** The Worker's public run-signing keys this app accepts, by key number (docs/privacy-keys.md 9.1). */
export type WorkerRunKeys = [number, Uint8Array][];

/** The part of the engine's host this needs (copy/host.ts). */
export interface SealedHost {
  sealedOpen(
    keys: ({ version: number } & Record<string, unknown>)[],
    deviceId: string,
    workerKeys: WorkerRunKeys,
  ): Promise<{ ready: boolean; number: number }>;
  sealedJoin(): Promise<{ number: number }>;
}

export type Fetch = (path: string) => Promise<Response>;

const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Every public entry of the budget's log, in order (GET /api/log/public), read strictly. */
export async function fetchPublicEntries(fetch: Fetch): Promise<Entry[]> {
  const out: Entry[] = [];
  let after = 0;
  for (let n = 0; n < 10_000; n++) {
    const r = await fetch(`/api/log/public?after=${after}`);
    if (!r.ok) throw new Error('Something went wrong. Try again.');
    const page = (await r.json()) as { entries: string[]; last: number; more: boolean };
    for (const e of page.entries) out.push(await readEntry(unb64(e)));
    if (!page.more || !page.entries.length) return out;
    after = page.last;
  }
  throw new Error('Something went wrong. Try again.');
}

/**
 * Opens a sealed budget on this device with the passkey just used. Gives where the engine stands in the log, and
 * the last public entry seen, which the device remembers: the next time, the log must pass through it.
 */
export async function openSealedBudget(o: {
  host: SealedHost;
  fetch: Fetch;
  budgetId: string;
  deviceId: string;
  passkey: PasskeySecret;
  workerKeys: WorkerRunKeys;
  /** The last public entry this device saw before, if any. */
  remembered?: PublicRef;
}): Promise<{ number: number; lastPublic: PublicRef; joined: boolean }> {
  const publics = await fetchPublicEntries(o.fetch);
  const { budget, state } = await openWithPasskey(publics, o.budgetId, o.passkey, o.remembered);
  try {
    const keys = await keysOfEveryVersion(state, budget);
    const opened = await o.host.sealedOpen(
      keys as unknown as ({ version: number } & Record<string, unknown>)[],
      o.deviceId,
      o.workerKeys,
    );
    // No place kept with the copy: a new device, or a copy made again. It starts from a snapshot.
    const at = opened.ready ? opened : await o.host.sealedJoin();
    return { number: at.number, lastPublic: state.lastPublic, joined: !opened.ready };
  } finally {
    zeroize(budget.bk);
  }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A new ULID: 10 characters of time, 16 of chance. */
export function newUlid(now = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let chance = '';
  for (const b of bytes) chance += CROCKFORD[b % 32]!;
  return time + chance;
}

/**
 * This copy's id as a writer of the budget's log. It is made once and kept with the copy; a copy that is made
 * again is a new writer. (The id the server knows a signed-in device by is another thing: it is not a ULID, and
 * the log is not the server's.)
 */
export async function logDeviceId(store: {
  get(key: string): Promise<string | null>;
  put(key: string, value: string | null): Promise<void>;
}): Promise<string> {
  const kept = await store.get('log_device');
  if (kept && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(kept)) return kept;
  const id = newUlid();
  await store.put('log_device', id);
  return id;
}
