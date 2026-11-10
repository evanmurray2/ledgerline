// The recovery key as a person sees and types it, and its sign-in by signature (docs/privacy-keys.md 4.2).
import { describe, expect, it } from 'vitest';
import {
  fromHex,
  newRecoveryKey,
  randomBytes,
  readRecoveryKey,
  recoverySlot,
  showRecoveryKey,
  signRecoveryLogin,
  toHex,
  verifyRecoveryLogin,
} from '../src/index.js';

const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('the recovery key', () => {
  it('is shown as 11 groups of 5 Crockford characters, and is pinned', async () => {
    const shown = await showRecoveryKey(fromHex('00'.repeat(32)));
    expect(shown).toMatch(/^([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(shown).toBe('00000-00000-00000-00000-00000-00000-00000-00000-00000-00000-0CKCG');
    expect(await showRecoveryKey(fromHex('ff'.repeat(32)))).toBe(
      'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZ6AR',
    );
    await expect(showRecoveryKey(randomBytes(31))).rejects.toThrow(RangeError);
  });

  it('comes back from what was typed, however it is spaced or cased', async () => {
    for (let i = 0; i < 20; i++) {
      const r = newRecoveryKey();
      const shown = await showRecoveryKey(r);
      expect(toHex((await readRecoveryKey(shown))!)).toBe(toHex(r));
      expect(toHex((await readRecoveryKey(shown.toLowerCase().replace(/-/g, ' ')))!)).toBe(toHex(r));
      expect(toHex((await readRecoveryKey(`  ${shown.replace(/-/g, '')}\n`))!)).toBe(toHex(r));
      // O, I and L are read as 0, 1 and 1.
      const sloppy = shown.replace(/0/g, 'O').replace(/1/g, 'l');
      expect(toHex((await readRecoveryKey(sloppy))!)).toBe(toHex(r));
    }
  });

  it('a slip is caught by the check bytes before anything is sent', async () => {
    const shown = await showRecoveryKey(newRecoveryKey());
    const chars = shown.replace(/-/g, '').split('');
    let caught = 0;
    for (let i = 0; i < 54; i++) {
      const wrong = chars.slice();
      wrong[i] = wrong[i] === '7' ? '8' : '7';
      if ((await readRecoveryKey(wrong.join(''))) === null) caught++;
    }
    expect(caught).toBe(54);
    expect(await readRecoveryKey(shown.slice(0, -1))).toBeNull();
    expect(await readRecoveryKey(`${shown}7`)).toBeNull();
    expect(await readRecoveryKey(shown.replace(/.$/, 'U'))).toBeNull();
    expect(await readRecoveryKey('')).toBeNull();
    // The last character holds 3 bits of padding, which must be zero: one key has one spelling.
    const last = chars[54]!;
    const other = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'['0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(last) | 1]!;
    if (other !== last) expect(await readRecoveryKey(chars.slice(0, 54).join('') + other)).toBeNull();
  });

  it('is proved to the server by a signature over the budget and a fresh challenge', async () => {
    const r = newRecoveryKey();
    const { auth } = await recoverySlot(r, 1);
    const challenge = randomBytes(32);
    const sig = await signRecoveryLogin(auth.privateKey, BUDGET, challenge);
    expect(await verifyRecoveryLogin(auth.pub, BUDGET, challenge, sig)).toBe(true);
    expect(await verifyRecoveryLogin(auth.pub, BUDGET, randomBytes(32), sig)).toBe(false);
    expect(await verifyRecoveryLogin(auth.pub, '01BX5ZZKBKACTAV9WEVGEMMVRZ', challenge, sig)).toBe(false);
    const other = await recoverySlot(newRecoveryKey(), 1);
    expect(await verifyRecoveryLogin(other.auth.pub, BUDGET, challenge, sig)).toBe(false);
    await expect(signRecoveryLogin(auth.privateKey, BUDGET, randomBytes(16))).rejects.toThrow(RangeError);
  });
});
