// The ways in of a locked budget, changed from this device (docs/privacy.md 5.2; docs/privacy-keys.md 4.2, 6.3):
// a passkey added as a way in after the recovery key opened the budget, a new recovery key, a way in removed by
// a key change, and the 7-day plan (an intent) the server asks for when the session came in by a fresh way
// (D-89). Each change is a public entry made here, with the budget key in hand, and sent by the engine as one
// write on top of its place in the log; the engine then reads it back by the log's rules. And the recovery key's
// sign-in, which proves the key to the server by a signature (4.2).
//
// No screen. The engine, the network and the budget key are passed in; whoever opened the key zeroes it.
import {
  type Bytes,
  encodeEntry,
  equal,
  type Entry,
  fromHex,
  INTENT_WAIT_MS,
  type PublicRef,
  type PublicState,
  readRecoveryKey,
  recoverySlot,
  signRecoveryLogin,
  toHex,
  walkPublic,
  zeroize,
} from '@ledgerline/seal';
import { addPasskeyEntry, KEY_TYPO, type OpenBudget, type PasskeySecret, WayInError } from '../keys/budget';
import {
  cancelEntry,
  intentEntry,
  keyChangeEntry,
  type LogPlace,
  newRecoveryKeyEntry,
} from '../keys/changes';
import type { AppendAnswer, SealedKeys, WritePlace } from './host';
import { fetchPublicEntries, type Fetch } from './sealed';

/** The part of the engine's host this needs (copy/host.ts). */
export interface WaysHost {
  sealedPlace(): Promise<WritePlace>;
  sealedAppend(entries: Uint8Array[], keys?: SealedKeys[]): Promise<AppendAnswer>;
}

export interface Ways {
  host: WaysHost;
  /** Reads from the server (the log's public entries and its bank runs). */
  fetch: Fetch;
  budgetId: string;
}

/** What a build gets: the public entries walked to where the engine stands, and its place. */
export interface Writing {
  state: PublicState;
  at: LogPlace;
  deviceId: string;
  now: number;
}

/** What a change came to. `waits`: the server holds it 7 days; the plan is in the log, due at that time. */
export type WayResult = { ok: true } | { ok: true; waits: number } | { ok: false; why: string };

const TRY_AGAIN = 'Something went wrong. Try again.';
/** Shown when the server holds a change for 7 days (D-89). */
export const WAITS_TEXT =
  'You signed in with your recovery key or a new passkey, so this change waits 7 days. Any of your passkeys can cancel it.';

const samePublic = (a: PublicRef, b: PublicRef) => a.number === b.number && equal(a.hash, b.hash);

/**
 * Sends public entries made by `build` on top of the log as the engine stands. The public entries are walked
 * again each time: they must end at the engine's own last public entry, or the log moved meanwhile and the
 * entries are made again. `build` gives null when there is nothing to send.
 */
export async function appendPublic(
  w: Ways,
  build: (x: Writing) => Promise<{ entries: Entry[]; keys?: SealedKeys[] } | null>,
): Promise<{ answer: AppendAnswer | null; state: PublicState }> {
  let state: PublicState | null = null;
  for (let round = 0; round < 4; round++) {
    const place = await w.host.sealedPlace();
    if (!place.whole) throw new Error(TRY_AGAIN);
    const last: PublicRef = { number: place.lastPublic.number, hash: place.lastPublic.hash as Bytes };
    const publics = await fetchPublicEntries(w.fetch);
    state = await walkPublic(publics, w.budgetId, { mustPass: last });
    if (!samePublic(state.lastPublic, last)) continue;
    const made = await build({
      state,
      at: {
        number: place.number,
        hash: place.hash as Bytes,
        deviceCounter: place.deviceCounter,
        filedThrough: place.filedThrough,
        scanThrough: place.scanThrough,
      },
      deviceId: place.deviceId,
      now: place.time,
    });
    if (!made) return { answer: null, state };
    const answer = await w.host.sealedAppend(made.entries.map(encodeEntry), made.keys);
    if (answer.ok || answer.why !== 'behind') return { answer, state };
  }
  if (!state) throw new Error(TRY_AGAIN);
  return { answer: { ok: false, why: 'behind', retry: true }, state };
}

const refused = (a: AppendAnswer | null): WayResult =>
  !a || a.ok ? { ok: true } : { ok: false, why: a.retry ? TRY_AGAIN : 'The server refused this change.' };

/**
 * Adds the passkey just used as a way in (a slot change), so that it alone opens the budget from now on. Made by
 * a device that opened the budget with another way in, the recovery key most often. The server never holds a
 * slot change back.
 */
export async function addPasskeyWay(w: Ways, budget: OpenBudget, passkey: PasskeySecret): Promise<WayResult> {
  const { answer } = await appendPublic(w, async (x) => {
    const entry = await addPasskeyEntry({ ...x, budget, passkey }).catch((e: unknown) => {
      // A way in already (another device added it meanwhile): nothing to do.
      if (e instanceof WayInError) return null;
      throw e;
    });
    return entry ? { entries: [entry] } : null;
  });
  return refused(answer);
}

/** The highest bank run that is complete on the server now: a key change must name it (6.3). */
export async function lastCompleteRun(fetch: Fetch): Promise<number> {
  const r = await fetch(`/api/log/runs?after=${Number.MAX_SAFE_INTEGER}`);
  if (!r.ok) throw new Error(TRY_AGAIN);
  return ((await r.json()) as { last: number }).last;
}

/**
 * Removes ways in (`remove`, slot ids) with a key change: a new budget key, sealed to every way in that stays.
 * When the server asks for a plan first (a fresh way in, D-89), the plan is written instead, and the change is
 * due 7 days later (`finishPlan`). A plan for exactly these ways that is due already is carried out.
 *
 * `onKeys`: the derived keys of the new version, once the log took the change (for the keys held for a refresh).
 */
export async function removeWays(
  w: Ways,
  budget: OpenBudget,
  remove: readonly string[],
  onKeys?: (keys: SealedKeys) => Promise<void>,
): Promise<WayResult> {
  if (!remove.length) return { ok: true };
  let made: OpenBudget | null = null;
  const lastOldRun = await lastCompleteRun(w.fetch);
  const { answer, state } = await appendPublic(w, async (x) => {
    if (made) zeroize(made.bk);
    const gone = remove.filter((id) => x.state.slots.has(id));
    if (!gone.length) return null;
    const plan = [...x.state.intents.entries()].find(
      ([, i]) => i.slotIds.length === gone.length && gone.every((id) => i.slotIds.includes(id)),
    );
    const k = await keyChangeEntry({
      ...x,
      budget,
      keep: [...x.state.slots.keys()].filter((id) => !gone.includes(id)),
      lastOldRun,
      ...(plan && plan[1].notBefore <= x.now ? { intent: { number: plan[0], hash: plan[1].hash } } : {}),
    });
    made = k.next;
    return { entries: [k.entry], keys: [k.next.keys] };
  });
  try {
    if (answer?.ok && made) await onKeys?.((made as OpenBudget).keys);
    if (!answer || answer.ok) return { ok: true };
    if (answer.why !== 'intent needed' && answer.why !== 'intent not due') return refused(answer);
  } finally {
    if (made) zeroize((made as OpenBudget).bk);
  }
  // The server holds the change: it needs a plan that waited 7 days.
  const open = [...state.intents.entries()].find(
    ([, i]) => i.slotIds.length === remove.length && remove.every((id) => i.slotIds.includes(id)),
  );
  if (open) return { ok: true, waits: open[1].notBefore };
  let notBefore = 0;
  const planned = await appendPublic(w, async (x) => {
    const gone = remove.filter((id) => x.state.slots.has(id));
    if (!gone.length) return null;
    notBefore = x.now + INTENT_WAIT_MS;
    return { entries: [await intentEntry({ ...x, budget, remove: gone, notBefore })] };
  });
  if (!planned.answer) return { ok: true };
  if (!planned.answer.ok) return refused(planned.answer);
  return { ok: true, waits: notBefore };
}

/** The plans in the log that are neither carried out nor cancelled, oldest first. */
export function openPlans(state: PublicState): { number: number; notBefore: number; slotIds: string[] }[] {
  return [...state.intents.entries()]
    .map(([number, i]) => ({ number, notBefore: i.notBefore, slotIds: [...i.slotIds] }))
    .sort((a, b) => a.number - b.number);
}

/** Carries out a plan that is due: the key change that removes the ways it lists. */
export async function finishPlan(
  w: Ways,
  budget: OpenBudget,
  number: number,
  onKeys?: (keys: SealedKeys) => Promise<void>,
): Promise<WayResult> {
  const publics = await fetchPublicEntries(w.fetch);
  const state = await walkPublic(publics, w.budgetId);
  const plan = state.intents.get(number);
  if (!plan) return { ok: false, why: 'This change was cancelled or is done already.' };
  return removeWays(w, budget, plan.slotIds, onKeys);
}

/** Cancels a plan: the ways it lists stay. Any way in that is still listed may cancel it. */
export async function cancelPlan(w: Ways, budget: OpenBudget, number: number): Promise<WayResult> {
  const { answer } = await appendPublic(w, async (x) => {
    const plan = x.state.intents.get(number);
    if (!plan) return null;
    return { entries: [await cancelEntry({ ...x, budget, intent: { number, hash: plan.hash } })] };
  });
  return refused(answer);
}

/**
 * The first step of a new recovery key (4.2): a slot change that adds the key `recoveryKey` (made and shown
 * before, and typed back) as the next generation. Gives the old recovery keys' slot ids, which a key change then
 * leaves out (`removeWays`).
 */
export async function addRecoveryWay(
  w: Ways,
  budget: OpenBudget,
  recoveryKey: Bytes,
): Promise<{ ok: true; replaces: string[] } | { ok: false; why: string }> {
  let replaces: string[] = [];
  const { answer } = await appendPublic(w, async (x) => {
    const made = await newRecoveryKeyEntry({
      ...x,
      budget,
      recoveryKey: new Uint8Array(recoveryKey) as Bytes,
    });
    zeroize(made.recoveryKey);
    replaces = made.replaces;
    return { entries: [made.entry] };
  });
  const r = refused(answer);
  return r.ok ? { ok: true, replaces } : r;
}

// ---- the recovery key and the server (4.2, "Proving it to the server")

/** The recovery key's public half for sign-in (hex), from the key as typed; null when it has a typing mistake. */
export async function authPubOf(typed: string | Bytes): Promise<string | null> {
  const r = typeof typed === 'string' ? await readRecoveryKey(typed) : (new Uint8Array(typed) as Bytes);
  if (!r) return null;
  try {
    return toHex((await recoverySlot(r, 1)).auth.pub);
  } finally {
    zeroize(r);
  }
}

/** The two sign-in routes (api/endpoints.ts recoverKeyOptions, recoverKeyVerify). */
export interface RecoverySignInRoutes {
  options(authPub: string): Promise<{ budgetId: string; challenge: string }>;
  verify(signature: string): Promise<unknown>;
}

/**
 * Signs in with the recovery key: the key's public half, then the signature over the server's challenge. Gives
 * the options for the new passkey, which the caller makes (register/verify signs in).
 */
export async function recoveryKeySignIn(typed: string, routes: RecoverySignInRoutes): Promise<unknown> {
  const r = await readRecoveryKey(typed);
  if (!r) throw new WayInError(KEY_TYPO);
  let auth;
  try {
    auth = (await recoverySlot(r, 1)).auth;
  } finally {
    zeroize(r);
  }
  const o = await routes.options(toHex(auth.pub));
  const signature = await signRecoveryLogin(auth.privateKey, o.budgetId, fromHex(o.challenge));
  return routes.verify(toHex(signature));
}
