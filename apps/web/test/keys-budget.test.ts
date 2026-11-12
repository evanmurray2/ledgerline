import { advance, type Entry, KIND, randomBytes, startChain, walkPublic } from '@ledgerline/seal';
import { describe, expect, it } from 'vitest';
import {
  addPasskeyEntry,
  createBudget,
  keysOfEveryVersion,
  openWithPasskey,
  openWithRecoveryKey,
  slotPrfInput,
  WayInError,
} from '../src/keys/budget';

const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
const PHONE = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const NOW = 1_800_000_000_000;
const passkey = () => ({ credentialId: randomBytes(20), prf: randomBytes(32) });
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

describe("a budget's keys on a device", () => {
  it('makes a budget whose two ways in both open it, and no other does', async () => {
    const mine = passkey();
    const made = await createBudget({ budgetId: BUDGET, deviceId: PHONE, passkey: mine, now: NOW });
    expect(made.genesis.header).toMatchObject({
      kind: KIND.genesis,
      number: 1,
      keyVersion: 1,
      deviceId: PHONE,
    });
    // 55 characters in groups of 5.
    expect(made.recoveryText).toMatch(/^([0-9A-Z]{5}[ -]){10}[0-9A-Z]{5}$/);

    const byPasskey = await openWithPasskey([made.genesis], BUDGET, mine);
    expect(hex(byPasskey.budget.bk)).toBe(hex(made.budget.bk));
    expect(hex(byPasskey.budget.keys.sign.pub)).toBe(hex(made.budget.keys.sign.pub));
    const byRecovery = await openWithRecoveryKey([made.genesis], BUDGET, made.recoveryText);
    expect(hex(byRecovery.budget.bk)).toBe(hex(made.budget.bk));
    // Typed in lower case, with other spacing: the same key.
    const typed = made.recoveryText.toLowerCase().replace(/[ -]/g, '  ');
    expect(hex((await openWithRecoveryKey([made.genesis], BUDGET, typed)).budget.bk)).toBe(
      hex(made.budget.bk),
    );

    // Another passkey, the same passkey with another PRF output, another budget's recovery key: nothing opens.
    await expect(openWithPasskey([made.genesis], BUDGET, passkey())).rejects.toThrow();
    await expect(
      openWithPasskey([made.genesis], BUDGET, { ...mine, prf: randomBytes(32) }),
    ).rejects.toThrow();
    const other = await createBudget({ budgetId: BUDGET, deviceId: PHONE, passkey: passkey(), now: NOW });
    await expect(openWithRecoveryKey([made.genesis], BUDGET, other.recoveryText)).rejects.toThrow();
    // One wrong character is a typing mistake, said before anything else.
    const slip = made.recoveryText.replace(/[0-9A-Z]/, (c) => (c === 'A' ? 'B' : 'A'));
    await expect(openWithRecoveryKey([made.genesis], BUDGET, slip)).rejects.toBeInstanceOf(WayInError);
    // The entry is this budget's: shown as another budget's, it does not open.
    await expect(openWithPasskey([made.genesis], OTHER, mine)).rejects.toThrow();
    await expect(openWithPasskey([], BUDGET, mine)).rejects.toThrow();
  });

  it('a second passkey is added by a slot change, and then opens the budget', async () => {
    const first = passkey();
    const made = await createBudget({ budgetId: BUDGET, deviceId: PHONE, passkey: first, now: NOW });
    const opened = await openWithPasskey([made.genesis], BUDGET, first);
    const second = passkey();
    const entry = await addPasskeyEntry({
      state: opened.state,
      budget: opened.budget,
      passkey: second,
      deviceId: PHONE,
      at: { number: 1, hash: made.genesis.hash, deviceCounter: 1, filedThrough: 0, scanThrough: 0 },
      now: NOW + 1000,
    });
    // The log's own rules take the entry.
    const chain = await startChain(made.genesis, { now: NOW + 2000, schemaVersion: 1 }, BUDGET);
    const next = await advance(chain, entry, { now: NOW + 2000, schemaVersion: 1 });
    expect(next.number).toBe(2);

    const publics: Entry[] = [made.genesis, entry];
    const bySecond = await openWithPasskey(publics, BUDGET, second);
    expect(hex(bySecond.budget.bk)).toBe(hex(made.budget.bk));
    // Before the slot change, the second passkey opens nothing; the first still opens after it.
    await expect(openWithPasskey([made.genesis], BUDGET, second)).rejects.toThrow();
    expect(hex((await openWithPasskey(publics, BUDGET, first)).budget.bk)).toBe(hex(made.budget.bk));
    // A device that remembers the slot change is not shown a log without it.
    const state = await walkPublic(publics, BUDGET);
    await expect(openWithPasskey([made.genesis], BUDGET, first, state.lastPublic)).rejects.toThrow();
    // The same passkey twice is refused.
    await expect(
      addPasskeyEntry({
        state: bySecond.state,
        budget: bySecond.budget,
        passkey: second,
        deviceId: PHONE,
        at: { number: 2, hash: entry.hash, deviceCounter: 2, filedThrough: 0, scanThrough: 0 },
        now: NOW + 3000,
      }),
    ).rejects.toBeInstanceOf(WayInError);

    expect((await keysOfEveryVersion(bySecond.state, bySecond.budget)).map((k) => k.version)).toEqual([1]);
  });

  it('the PRF input is one constant', async () => {
    expect(hex(await slotPrfInput())).toBe(hex(await slotPrfInput()));
    expect((await slotPrfInput()).length).toBe(32);
  });
});
