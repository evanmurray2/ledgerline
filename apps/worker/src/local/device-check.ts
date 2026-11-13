// The device check on the device (D-116; packages/seal device-check.ts). Each device works out the budget by
// itself from the same log; this tells when two devices that stood at the same log entry showed different numbers.
//
// After a round with the log that leaves the copy settled at entry N (nothing of its own waiting, no bank run left
// to file), at most every 5 minutes and once per N and month, the device writes out what its screens show for the
// current month (Ready to Assign; each category's assigned, activity and available; each card's payment
// category; each account's balances), hashes it, and sends an HMAC of the hash under the budget's check key. It
// keeps its last few hashes with its copy. The server hands every device's latest HMAC back with the log; for one
// at an N and month this device kept, the device makes the HMAC from its own hash under the other device's id, and
// a different one is told on Budget → Needs attention until a later check with that device agrees.
//
// It reads screens only: it never changes the copy's budget tables, never blocks an edit, and a failure is
// dropped (the next round tries again).
import type { AccountsView, BudgetView } from '@ledgerline/contracts';
import { canCheck, checkDigest, checkMac, checkMacSame, fromHex, toHex } from '@ledgerline/seal';
import { isCheckRecord, type DeviceCheckRecord } from '../seal/device-checks.js';
import type { DeviceLog } from './device-log.js';
import type { LocalEngine } from './engine.js';

export type { DeviceCheckRecord };

/** How the device reaches the server's device checks (seal/log-routes.ts). */
export interface CheckTransport {
  /** Every device's latest check, as the server sent it with its last page of the log; null: none came. */
  checks(): readonly DeviceCheckRecord[] | null;
  /** Sends this device's check; false when the server didn't keep it (it rests, or one came a moment ago). */
  sendCheck(r: DeviceCheckRecord): Promise<boolean>;
}

/** Another device that showed different numbers at the same entry and month. */
export interface DevicesDiffer {
  deviceId: string;
  number: number;
  month: string;
}

/** A device makes a check at most this often. */
export const CHECK_EVERY_MS = 5 * 60_000;
/** How many of its own checks a device keeps, to compare with another device's that comes later. */
export const CHECKS_KEPT = 8;
/** Kept with the copy (`LocalEngine.note`): a copy made again starts with none. */
export const CHECK_NOTE = 'device_check';

interface Kept {
  /** When this device last made a check (its own clock). */
  at: number;
  mine: { number: number; month: string; version: number; digest: string }[];
  differs: DevicesDiffer | null;
}

/**
 * What the screens show for `month`, written out the same way on every device: one line per number, sorted, so
 * neither the order of rows nor a name changes it. Null while Ready to Assign is still being worked out.
 */
export function screenText(b: BudgetView, a: AccountsView): string | null {
  if (b.rtaUpdating) return null;
  const lines = [`rta ${b.rta}`];
  for (const c of [...b.groups.flatMap((g) => g.categories), ...b.archived])
    lines.push(`category ${c.id} ${c.assigned} ${c.activity} ${c.available}`);
  for (const c of b.cards) lines.push(`card ${c.accountId} ${c.categoryId} ${c.available} ${c.owed}`);
  for (const x of [...a.groups.flatMap((g) => g.accounts), ...a.closed])
    lines.push(`account ${x.id} ${x.bank} ${x.pending} ${x.working}`);
  return `ledgerline device check 1 ${b.month}\n${lines.sort().join('\n')}\n`;
}

async function json<T>(engine: LocalEngine, path: string): Promise<T | null> {
  const r = await engine.request('GET', path);
  return r.status === 200 ? ((await r.json()) as T) : null;
}

/** The current month and what the screens show for it, or null when the copy can't say now. */
export async function screenNow(engine: LocalEngine): Promise<{ month: string; text: string } | null> {
  const s = await json<{ budget?: { currentMonth?: string } }>(engine, '/api/session');
  const month = s?.budget?.currentMonth;
  if (!month) return null;
  const b = await json<BudgetView>(engine, `/api/budget/${month}`);
  const a = await json<AccountsView>(engine, '/api/accounts');
  const text = b && a ? screenText(b, a) : null;
  return text ? { month, text } : null;
}

async function load(engine: LocalEngine): Promise<Kept> {
  try {
    const v = JSON.parse((await engine.noted(CHECK_NOTE)) ?? 'null') as Kept | null;
    if (v && Array.isArray(v.mine)) return v;
  } catch {
    // A note that doesn't read starts again.
  }
  return { at: 0, mine: [], differs: null };
}

/**
 * One device check, after a round with the log: makes and sends this device's check when it is due, then compares
 * the other devices' checks the server sent. Gives the device that differs, or null.
 */
export async function deviceCheck(o: {
  engine: LocalEngine;
  log: DeviceLog;
  transport: CheckTransport;
  /** This device's own clock. */
  now: number;
  /** The copy stands exactly at the log's entry: nothing of its own waits and no bank run waits to be filed. */
  settled: boolean;
  /** Other ids this device has written the log as: their checks are not another device's. */
  own?: readonly string[];
}): Promise<DevicesDiffer | null> {
  const { engine, log } = o;
  const kept = await load(engine);
  const before = JSON.stringify(kept);
  const fact = (deviceId: string, number: number, month: string, digest: Uint8Array) => ({
    budgetId: log.budgetId,
    deviceId,
    number,
    month,
    digest,
  });

  if (o.settled && o.now - kept.at >= CHECK_EVERY_MS) {
    const keys = log.keysHeld().find((k) => k.version === log.publicState.keyVersion);
    const number = log.number;
    // Once per entry: a new month always comes with a new entry (the day's scan), so the month needs no check.
    if (keys && canCheck(keys) && number >= 1 && !kept.mine.some((m) => m.number === number)) {
      const screen = await screenNow(engine);
      if (screen) {
        const digest = await checkDigest(screen.text);
        const mac = await checkMac(keys, fact(log.deviceId, number, screen.month, digest));
        kept.at = o.now;
        kept.mine = [
          ...kept.mine,
          { number, month: screen.month, version: keys.version, digest: toHex(digest) },
        ].slice(-CHECKS_KEPT);
        // Kept before it is sent: a check the server has is one this device can compare with.
        await engine.note(CHECK_NOTE, JSON.stringify(kept));
        await o.transport
          .sendCheck({ deviceId: log.deviceId, number, month: screen.month, mac: toHex(mac) })
          .catch(() => false);
      }
    }
  }

  for (const r of o.transport.checks() ?? []) {
    if (!isCheckRecord(r) || r.deviceId === log.deviceId || o.own?.includes(r.deviceId)) continue;
    const m = kept.mine.find((x) => x.number === r.number && x.month === r.month);
    const keys = m && log.keysHeld().find((k) => k.version === m.version);
    if (!m || !keys || !canCheck(keys)) continue;
    const same = await checkMacSame(
      keys,
      fact(r.deviceId, r.number, r.month, fromHex(m.digest)),
      fromHex(r.mac),
    );
    const d = kept.differs;
    if (same) {
      // A later check with that device agrees: the difference is gone.
      if (d?.deviceId === r.deviceId && r.number >= d.number) kept.differs = null;
    } else if (!d || r.number >= d.number) {
      kept.differs = { deviceId: r.deviceId, number: r.number, month: r.month };
    }
  }
  if (JSON.stringify(kept) !== before) await engine.note(CHECK_NOTE, JSON.stringify(kept));
  return kept.differs;
}
