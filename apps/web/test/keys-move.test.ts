import { randomBytes, readEntry } from '@ledgerline/seal';
import { describe, expect, it } from 'vitest';
import { openWithPasskey, WayInError } from '../src/keys/budget';
import { dropMove, prepareMove, proveMove } from '../src/keys/move';

const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PHONE = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const passkey = () => ({ credentialId: randomBytes(20), prf: randomBytes(32) });
const zero = (b: Uint8Array) => b.every((x) => x === 0);

describe('moving a budget: both ways in are proved first', () => {
  it('hands on the keys and the first entry only when the typed recovery key and the passkey open the key', async () => {
    const mine = passkey();
    const p = await prepareMove({ budgetId: BUDGET, deviceId: PHONE, passkey: mine, now: 1_800_000_000_000 });
    const out = await proveMove(p, p.recoveryText.toLowerCase(), mine);
    expect(out.deviceId).toBe(PHONE);
    expect(out.keys.version).toBe(1);
    // The entry handed on is the first entry, and the passkey opens it.
    const genesis = await readEntry(out.genesis);
    expect(genesis.header.number).toBe(1);
    expect((await openWithPasskey([genesis], BUDGET, mine)).budget.keys.version).toBe(1);
    // The key bytes are gone from the prepared move.
    expect(zero(p.secret.bk)).toBe(true);
  });

  it('refuses a recovery key with a slip, another budget’s recovery key, and another passkey', async () => {
    const mine = passkey();
    const make = () =>
      prepareMove({ budgetId: BUDGET, deviceId: PHONE, passkey: mine, now: 1_800_000_000_000 });
    const slip = await make();
    const wrong = slip.recoveryText.replace(/[0-9A-Z]/, (c) => (c === 'A' ? 'B' : 'A'));
    await expect(proveMove(slip, wrong, mine)).rejects.toBeInstanceOf(WayInError);
    expect(zero(slip.secret.bk)).toBe(true);

    const a = await make();
    const b = await make();
    await expect(proveMove(a, b.recoveryText, mine)).rejects.toThrow('That is not the recovery key shown');
    await expect(proveMove(b, b.recoveryText, passkey())).rejects.toThrow('Your passkey did not open');

    const dropped = await make();
    dropMove(dropped);
    expect(zero(dropped.secret.bk) && zero(dropped.secret.recoveryKey)).toBe(true);
  });
});
