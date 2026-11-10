// Requests signed with the budget's key (docs/privacy-keys.md section 11).
import { describe, expect, it } from 'vitest';
import {
  ACTION,
  deriveBudgetKeys,
  fromHex,
  newChallenge,
  randomBytes,
  signRequest,
  utf8,
  verify,
  verifyRequest,
} from '../src/index.js';

const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

describe('a signed request', () => {
  it('signs the pinned message', async () => {
    const keys = await deriveBudgetKeys(randomBytes(32), BUDGET, 3);
    const challenge = fromHex('77'.repeat(32));
    const sig = await signRequest(keys, BUDGET, ACTION.removeBank, challenge, utf8('payload'));
    // The message, written out by a separate program from the formula in section 11.
    const message = fromHex(
      '6c65646765726c696e652f76312f72657175657374000000001a303141525a334e44454b54535634525246465136394735464156' +
        '000000030000000b72656d6f76652d62616e6b' +
        '77'.repeat(32) +
        '239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5',
    );
    expect(await verify(keys.sign.pub, message, sig)).toBe(true);
    expect(
      await verifyRequest(keys.sign.pub, 3, BUDGET, 'remove-bank', challenge, utf8('payload'), sig),
    ).toBe(true);
  });

  it('verifies only for the same key, version, budget, action, challenge and payload', async () => {
    const keys = await deriveBudgetKeys(randomBytes(32), BUDGET, 3);
    const other = await deriveBudgetKeys(randomBytes(32), BUDGET, 3);
    const challenge = newChallenge();
    const payload = utf8('{"linkId":"01BX5ZZKBKACTAV9WEVGEMMVRZ"}');
    const sig = await signRequest(keys, BUDGET, ACTION.removeBank, challenge, payload);
    const ok = (
      over: Partial<{
        pub: Uint8Array;
        v: number;
        budget: string;
        action: string;
        challenge: Uint8Array;
        payload: Uint8Array;
        sig: Uint8Array;
      }> = {},
    ) =>
      verifyRequest(
        over.pub ?? keys.sign.pub,
        over.v ?? 3,
        over.budget ?? BUDGET,
        over.action ?? ACTION.removeBank,
        over.challenge ?? challenge,
        over.payload ?? payload,
        over.sig ?? sig,
      );
    expect(await ok()).toBe(true);
    expect(await ok({ pub: other.sign.pub })).toBe(false);
    expect(await ok({ v: 2 })).toBe(false);
    expect(await ok({ budget: OTHER })).toBe(false);
    expect(await ok({ action: ACTION.deleteAccount })).toBe(false);
    expect(await ok({ challenge: newChallenge() })).toBe(false);
    expect(await ok({ payload: utf8('{}') })).toBe(false);
    const bad = sig.slice();
    bad[5]! ^= 1;
    expect(await ok({ sig: bad })).toBe(false);
  });

  it('answers "no" for values that could never have been signed', async () => {
    const keys = await deriveBudgetKeys(randomBytes(32), BUDGET, 1);
    const challenge = newChallenge();
    const sig = await signRequest(keys, BUDGET, ACTION.linkToken, challenge, new Uint8Array());
    const v = (
      pub: Uint8Array,
      version: number,
      budget: string,
      action: string,
      c: Uint8Array,
      s: Uint8Array,
    ) => verifyRequest(pub, version, budget, action, c, new Uint8Array(), s);
    expect(await v(keys.sign.pub, 1, BUDGET, ACTION.linkToken, challenge, sig)).toBe(true);
    expect(await v(keys.sign.pub.slice(1), 1, BUDGET, ACTION.linkToken, challenge, sig)).toBe(false);
    expect(await v(keys.sign.pub, 0, BUDGET, ACTION.linkToken, challenge, sig)).toBe(false);
    expect(await v(keys.sign.pub, 1.5, BUDGET, ACTION.linkToken, challenge, sig)).toBe(false);
    expect(await v(keys.sign.pub, 1, 'budget', ACTION.linkToken, challenge, sig)).toBe(false);
    expect(await v(keys.sign.pub, 1, BUDGET, 'link-token ', challenge, sig)).toBe(false);
    expect(await v(keys.sign.pub, 1, BUDGET, 'no-such-request', challenge, sig)).toBe(false);
    expect(await v(keys.sign.pub, 1, BUDGET, ACTION.linkToken, challenge.slice(1), sig)).toBe(false);
    expect(await v(keys.sign.pub, 1, BUDGET, ACTION.linkToken, challenge, sig.slice(1))).toBe(false);
  });

  it('refuses to sign an unknown request or a short challenge', async () => {
    const keys = await deriveBudgetKeys(randomBytes(32), BUDGET, 1);
    await expect(
      signRequest(keys, BUDGET, 'other' as never, newChallenge(), new Uint8Array()),
    ).rejects.toThrow(RangeError);
    await expect(
      signRequest(keys, BUDGET, ACTION.linkToken, randomBytes(16), new Uint8Array()),
    ).rejects.toThrow(RangeError);
  });
});
