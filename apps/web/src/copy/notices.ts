// Notices on every device (docs/privacy.md 5.8, "Telling people about an incident"): when another device adds a
// way in to a locked budget (a slot change), removes one (a key change that leaves it out), plans a key change (an
// intent), or the recovery key signs in, every
// other device says so when it opens, with what to do if it wasn't the person. A planned change also gets a
// reminder on its day, on every device, with Finish now. Each device dismisses a notice for itself; the server
// keeps no dismissal (it can't read the budget, and a notice must not be hidden for the other devices).
//
// The facts come from the log's public entries, read by the log's rules (copy.ts publicLook), and the session's
// recovery-key sign-in time. Nothing here is a screen.
import { type Entry, KIND, readGenesis, readKeyChange, readSlotChange } from '@ledgerline/seal';

/** A notice shows for this long after what it tells of. A planned change shows until it is done or cancelled. */
export const NOTICE_MS = 14 * 86_400_000;

export type Notice =
  /** Another device added a way in: a passkey or a recovery key. */
  | { id: string; kind: 'way-added'; at: number }
  /** Another device removed ways in (a key change that left them out). */
  | { id: string; kind: 'way-removed'; at: number; slotIds: string[] }
  /** Another device planned a change that removes ways in; it takes effect on `notBefore`. */
  | { id: string; kind: 'planned'; at: number; number: number; notBefore: number; slotIds: string[] }
  /** A planned change is due: any device may finish it now. */
  | { id: string; kind: 'due'; number: number; notBefore: number; slotIds: string[] }
  /** The recovery key signed in to this account. */
  | { id: string; kind: 'recovery-sign-in'; at: number };

export interface NoticeFacts {
  /** The public entries, in order, as the log's rules took them. */
  entries: readonly Entry[];
  /** The plans in the log neither carried out nor cancelled, by entry number. */
  intents: ReadonlyMap<number, { notBefore: number; slotIds: readonly string[] }>;
  /**
   * This device's own ids as a writer of the log (a copy made again is a new writer): what it did itself it
   * doesn't tell itself.
   */
  deviceIds: readonly string[];
  /** The ways in each key change removed, by entry number (`waysRemoved`). */
  removed?: ReadonlyMap<number, readonly string[]>;
  /** When the recovery key last signed in (the server's session), or null. */
  recoveryKeyUsedAt: number | null;
  now: number;
  /** The notices this device dismissed. */
  dismissed: readonly string[];
}

/** The notices this device shows now, newest first. */
export function noticesOf(f: NoticeFacts): Notice[] {
  const out: Notice[] = [];
  const recent = (t: number) => t > f.now - NOTICE_MS;
  const byNumber = new Map(f.entries.map((e) => [e.header.number, e]));
  for (const e of f.entries) {
    const h = e.header;
    if (h.kind === KIND.slotChange && !f.deviceIds.includes(h.deviceId) && recent(h.time))
      out.push({ id: `way:${h.number}`, kind: 'way-added', at: h.time });
    const gone = f.removed?.get(h.number);
    if (h.kind === KIND.keyChange && gone?.length && !f.deviceIds.includes(h.deviceId) && recent(h.time))
      out.push({ id: `removed:${h.number}`, kind: 'way-removed', at: h.time, slotIds: [...gone] });
  }
  for (const [number, i] of f.intents) {
    const by = byNumber.get(number)?.header;
    if (i.notBefore <= f.now)
      out.push({ id: `due:${number}`, kind: 'due', number, notBefore: i.notBefore, slotIds: [...i.slotIds] });
    else if (by && !f.deviceIds.includes(by.deviceId))
      out.push({
        id: `plan:${number}`,
        kind: 'planned',
        at: by.time,
        number,
        notBefore: i.notBefore,
        slotIds: [...i.slotIds],
      });
  }
  if (f.recoveryKeyUsedAt !== null && recent(f.recoveryKeyUsedAt))
    out.push({ id: `key:${f.recoveryKeyUsedAt}`, kind: 'recovery-sign-in', at: f.recoveryKeyUsedAt });
  const when = (n: Notice) => ('at' in n ? n.at : n.notBefore);
  return out.filter((n) => !f.dismissed.includes(n.id)).sort((a, b) => when(b) - when(a));
}

/**
 * The ways in (slot ids) each key change removed, by entry number: the slots in force before it that it doesn't keep.
 * The entries are the log's public ones, already walked by the log's rules (copy.ts publicLook).
 */
export function waysRemoved(entries: readonly Entry[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  let slots = new Set<string>();
  for (const e of entries) {
    const k = e.header.kind;
    if (k === KIND.genesis) slots = new Set(readGenesis(e.body).slots.map((x) => x.slotId));
    else if (k === KIND.slotChange) for (const x of readSlotChange(e.body).slots) slots.add(x.slotId);
    else if (k === KIND.keyChange) {
      const kept = new Set(readKeyChange(e.body).slots.map((x) => x.slotId));
      const gone = [...slots].filter((id) => !kept.has(id));
      if (gone.length) out.set(e.header.number, gone);
      slots = kept;
    }
  }
  return out;
}

// ---- what this device dismissed, kept on it (no secret: entry numbers and times)

const DISMISSED = 'ledgerline.notices.';
const WRITERS = 'ledgerline.log-writers';
/** Set on the device where the recovery key just signed in: it tells the others, not itself. */
const KEY_HERE = 'ledgerline.recovery-key-here';

export function dismissedNotices(budgetId: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED + budgetId) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function dismissNotice(budgetId: string, id: string): void {
  try {
    // The newest 200 are enough: older notices no longer show.
    const all = [...dismissedNotices(budgetId).filter((x) => x !== id), id].slice(-200);
    localStorage.setItem(DISMISSED + budgetId, JSON.stringify(all));
  } catch {
    // No storage: the notice shows again the next time.
  }
}

/** The recovery key signed in on this device just now (Sign in → Use your recovery key). */
export function noteRecoveryKeyHere(): void {
  try {
    localStorage.setItem(KEY_HERE, '1');
  } catch {
    // As above.
  }
}

/**
 * The first time this device learns when the recovery key signed in, after it signed in with it itself: that
 * sign-in is its own, so its notice is dismissed here.
 */
export function takeRecoveryKeyHere(budgetId: string, usedAt: number | null): void {
  try {
    if (usedAt === null || localStorage.getItem(KEY_HERE) !== '1') return;
    localStorage.removeItem(KEY_HERE);
    dismissNotice(budgetId, `key:${usedAt}`);
  } catch {
    // As above.
  }
}

/** Every id this device has written the log as (copy/sealed.ts logDeviceId): ids only, the newest 50. */
export function ownWriters(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(WRITERS) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberWriter(id: string): void {
  try {
    const all = ownWriters();
    if (!all.includes(id)) localStorage.setItem(WRITERS, JSON.stringify([...all, id].slice(-50)));
  } catch {
    // No storage: this copy's own id still counts (copy.ts publicLook).
  }
}
