// The device checks of a sealed budget (D-116; packages/seal device-check.ts): each device's latest HMAC of what its
// screens showed at one log entry, for one month. The server can't read or make one: it keeps the latest per
// device and hands them to every device with the log, which compares them with its own.
//
// They live in `store_note`, so no migration is needed: one row per device, whose key holds the whole record,
// `check:<deviceId>:<month>:<number>:<hmac in hex>`, and whose value is when it came. A device's new record replaces
// its old one in one step. A row older than 30 days goes, and at most 16 are kept (a copy made on a new device is
// a new writer, so old ids would pile up).
import type { Db } from '@ledgerline/db/sql';
import { isUlid } from '@ledgerline/seal';

export interface DeviceCheckRecord {
  deviceId: string;
  number: number;
  /** `YYYY-MM`. */
  month: string;
  /** The HMAC, 32 bytes in hex. */
  mac: string;
}

const PREFIX = 'check:';
/** Every key from `check:` up to `check;`: the records, read by the primary key. */
const RANGE = `key >= 'check:' AND key < 'check;'`;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAC = /^[0-9a-f]{64}$/;
/** The most records kept, and how long one is kept. */
export const MAX_CHECKS = 16;
export const CHECK_KEPT_MS = 30 * 86_400_000;
/** A device sends at most one record in this time (it means to send one every few minutes at most). */
export const CHECK_EVERY_MS = 60_000;

const keyOf = (r: DeviceCheckRecord) => `${PREFIX}${r.deviceId}:${r.month}:${r.number}:${r.mac}`;

/** A record in the right form (the route's own check; the device checks the HMAC). */
export function isCheckRecord(r: DeviceCheckRecord): boolean {
  return (
    isUlid(r.deviceId) &&
    Number.isSafeInteger(r.number) &&
    r.number >= 1 &&
    MONTH.test(r.month) &&
    MAC.test(r.mac)
  );
}

function parse(key: string): DeviceCheckRecord | null {
  const [deviceId, month, number, mac, ...rest] = key.slice(PREFIX.length).split(':');
  if (rest.length || !deviceId || !month || !number || !mac) return null;
  const r = { deviceId, month, number: Number(number), mac };
  return isCheckRecord(r) ? r : null;
}

/** Every device's latest record. */
export async function deviceChecks(db: Db): Promise<DeviceCheckRecord[]> {
  const rows = await db
    .prepare(`SELECT key FROM store_note WHERE ${RANGE} LIMIT ${MAX_CHECKS * 2}`)
    .all<{ key: string }>();
  return rows.results.map((x) => parse(x.key)).filter((x): x is DeviceCheckRecord => x !== null);
}

export type CheckAnswer =
  { ok: true } | { ok: false; why: 'resting' | 'invalid' | 'too soon'; retry: boolean };

/**
 * Keeps a device's new record in place of its old one. Refused while the budget rests, for a number past the end
 * of the log, and within a minute of the device's last record.
 */
export async function keepDeviceCheck(
  d: { db: Db; now: number; resting: boolean; head: number },
  r: DeviceCheckRecord,
): Promise<CheckAnswer> {
  if (!isCheckRecord(r) || r.number > d.head) return { ok: false, why: 'invalid', retry: false };
  if (d.resting) return { ok: false, why: 'resting', retry: true };
  const own = `key >= ?1 AND key < ?2`;
  const from = `${PREFIX}${r.deviceId}:`;
  const to = `${PREFIX}${r.deviceId};`;
  const last = await d.db
    .prepare(`SELECT max(value) AS at FROM store_note WHERE ${own}`)
    .bind(from, to)
    .first<{ at: number | null }>();
  if (last?.at != null && d.now - last.at < CHECK_EVERY_MS)
    return { ok: false, why: 'too soon', retry: true };
  await d.db.batch([
    d.db.prepare(`DELETE FROM store_note WHERE ${own}`).bind(from, to),
    d.db.prepare(`INSERT INTO store_note (key, value) VALUES (?1, ?2)`).bind(keyOf(r), d.now),
    d.db.prepare(`DELETE FROM store_note WHERE ${RANGE} AND value < ?1`).bind(d.now - CHECK_KEPT_MS),
    d.db.prepare(
      `DELETE FROM store_note WHERE ${RANGE} AND key NOT IN
           (SELECT key FROM store_note WHERE ${RANGE} ORDER BY value DESC, key LIMIT ${MAX_CHECKS})`,
    ),
  ]);
  return { ok: true };
}
