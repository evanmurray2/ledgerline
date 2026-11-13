// The device check's HMAC (D-116, src/device-check.ts): bound to the budget, the device, the log number, the month,
// the key version and the hash of what the screens showed; made only with the budget's check key.
import { describe, expect, it } from 'vitest';
import {
  canCheck,
  checkDigest,
  checkMac,
  checkMacSame,
  concat,
  deriveBudgetKeys,
  fromHex,
  hmac,
  str,
  toHex,
  u32,
  u64,
  utf8,
  type CheckFacts,
} from '../src/index.js';

const BK = fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PHONE = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const LAPTOP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';

const facts = async (o: Partial<CheckFacts> = {}): Promise<CheckFacts> => ({
  budgetId: BUDGET,
  deviceId: PHONE,
  number: 42,
  month: '2026-11',
  digest: await checkDigest('rta 100\n'),
  ...o,
});

describe('the device check', () => {
  it('is the HMAC of its fields, written out, under the check key', async () => {
    const keys = await deriveBudgetKeys(BK, BUDGET, 1);
    const f = await facts();
    const mac = await checkMac(keys, f);
    expect(mac.length).toBe(32);
    // Written out apart from the package's own: the label, then each field.
    const input = concat(
      utf8('ledgerline/v1/device-check/record'),
      Uint8Array.of(0),
      str(BUDGET),
      str(PHONE),
      u64(42),
      str('2026-11'),
      u32(1),
      str(f.digest),
    );
    expect(toHex(mac)).toBe(toHex(await hmac(keys.check, input)));
    // The same facts give the same HMAC.
    expect(toHex(await checkMac(keys, await facts()))).toBe(toHex(mac));
    expect(await checkMacSame(keys, f, mac)).toBe(true);
  });

  it('changes with each field, and with the budget key', async () => {
    const keys = await deriveBudgetKeys(BK, BUDGET, 1);
    const mac = await checkMac(keys, await facts());
    const others = [
      await facts({ deviceId: LAPTOP }),
      await facts({ number: 43 }),
      await facts({ month: '2026-10' }),
      await facts({ digest: await checkDigest('rta 101\n') }),
    ];
    for (const f of others) {
      expect(toHex(await checkMac(keys, f))).not.toBe(toHex(mac));
      expect(await checkMacSame(keys, f, mac)).toBe(false);
    }
    const otherKey = await deriveBudgetKeys(fromHex('ff'.repeat(32)), BUDGET, 1);
    expect(toHex(await checkMac(otherKey, await facts()))).not.toBe(toHex(mac));
    expect(await checkMacSame(otherKey, await facts(), mac)).toBe(false);
    const nextVersion = await deriveBudgetKeys(BK, BUDGET, 2);
    expect(toHex(await checkMac(nextVersion, await facts()))).not.toBe(toHex(mac));
  });

  it('refuses facts in the wrong form, and keys with no check key', async () => {
    const keys = await deriveBudgetKeys(BK, BUDGET, 1);
    await expect(checkMac(keys, await facts({ month: '2026-13' }))).rejects.toThrow(RangeError);
    await expect(checkMac(keys, await facts({ deviceId: 'phone' }))).rejects.toThrow(RangeError);
    await expect(checkMac(keys, await facts({ digest: new Uint8Array(31) }))).rejects.toThrow(RangeError);
    const { check: _check, ...held } = keys;
    expect(canCheck(keys)).toBe(true);
    expect(canCheck(held as typeof keys)).toBe(false);
    await expect(checkMac(held as typeof keys, await facts())).rejects.toThrow();
    expect(await checkMacSame(held as typeof keys, await facts(), new Uint8Array(32))).toBe(false);
    expect(await checkMacSame(keys, await facts(), new Uint8Array(31))).toBe(false);
  });
});
