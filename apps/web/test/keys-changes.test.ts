import { advance, type ChainState, type Entry, KIND, randomBytes, startChain } from '@ledgerline/seal';
import { describe, expect, it } from 'vitest';
import {
  addPasskeyEntry,
  createBudget,
  keysOfEveryVersion,
  openWithPasskey,
  openWithRecoveryKey,
  type OpenBudget,
} from '../src/keys/budget';
import {
  cancelEntry,
  intentEntry,
  keyChangeEntry,
  newRecoveryKeyEntry,
  type LogPlace,
} from '../src/keys/changes';

const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PHONE = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const passkey = () => ({ credentialId: randomBytes(20), prf: randomBytes(32) });
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** A budget's log as the server keeps it: every entry is checked by the log's own rules before it is taken. */
class Log {
  entries: Entry[] = [];
  chain!: ChainState;
  now = T0;
  static async of(genesis: Entry): Promise<Log> {
    const l = new Log();
    l.chain = await startChain(genesis, { now: T0 + 1000, schemaVersion: 1 }, BUDGET);
    l.entries.push(genesis);
    return l;
  }
  async take(e: Entry): Promise<void> {
    this.chain = await advance(this.chain, e, { now: this.now + 1000, schemaVersion: 1 });
    this.entries.push(e);
  }
  get at(): LogPlace {
    return {
      number: this.chain.number,
      hash: this.chain.hash,
      deviceCounter: this.chain.counters.get(PHONE) ?? 0,
      filedThrough: this.chain.filedThrough,
      scanThrough: this.chain.scanThrough,
    };
  }
  get state() {
    return this.chain.public;
  }
  tick(ms = 1000): number {
    return (this.now += ms);
  }
}

async function budgetWithTwoPasskeys() {
  const first = passkey();
  const second = passkey();
  const made = await createBudget({ budgetId: BUDGET, deviceId: PHONE, passkey: first, now: T0 });
  const log = await Log.of(made.genesis);
  await log.take(
    await addPasskeyEntry({
      state: log.state,
      budget: made.budget,
      passkey: second,
      deviceId: PHONE,
      at: log.at,
      now: log.tick(),
    }),
  );
  return { first, second, made, log };
}
const slotOf = (log: Log, prefix: string) =>
  [...log.state.slots.keys()].filter((id) => id.startsWith(prefix));

describe('changes to who can open a budget', () => {
  it('a key change removes a passkey: the others still open the budget, with its older keys', async () => {
    const { first, second, made, log } = await budgetWithTwoPasskeys();
    const mine = (await openWithPasskey(log.entries, BUDGET, first)).budget;
    const [p1, p2] = slotOf(log, 'p:') as [string, string];
    const firstId = (await openWithPasskey(log.entries, BUDGET, first)).state.slots.has(p1) ? p1 : p2;
    void firstId;
    // Which slot is the second passkey's: the one that is not in the first entry.
    const genesisSlots = new Set([
      ...(await openWithPasskey([made.genesis], BUDGET, first)).state.slots.keys(),
    ]);
    const secondSlot = [p1, p2].find((id) => !genesisSlots.has(id))!;
    const keep = [...log.state.slots.keys()].filter((id) => id !== secondSlot);

    const change = await keyChangeEntry({
      state: log.state,
      budget: mine,
      deviceId: PHONE,
      at: log.at,
      now: log.tick(),
      keep,
      lastOldRun: 0,
    });
    expect(change.entry.header).toMatchObject({ kind: KIND.keyChange, keyVersion: 1 });
    await log.take(change.entry);
    expect(log.state.keyVersion).toBe(2);

    const after = await openWithPasskey(log.entries, BUDGET, first);
    expect(after.budget.keys.version).toBe(2);
    expect(hex(after.budget.bk)).toBe(hex(change.next.bk));
    expect(hex(after.budget.bk)).not.toBe(hex(made.budget.bk));
    // The older key comes with it, for what was sealed before.
    const all = await keysOfEveryVersion(after.state, after.budget);
    expect(all.map((k) => k.version)).toEqual([1, 2]);
    expect(hex(all[0]!.sign.pub)).toBe(hex(made.budget.keys.sign.pub));
    // The recovery key still opens it; the removed passkey does not.
    expect((await openWithRecoveryKey(log.entries, BUDGET, made.recoveryText)).budget.keys.version).toBe(2);
    await expect(openWithPasskey(log.entries, BUDGET, second)).rejects.toThrow();

    // The old key can't write the next change, and a change must keep a way in that exists.
    await expect(
      keyChangeEntry({
        state: log.state,
        budget: mine,
        deviceId: PHONE,
        at: log.at,
        now: log.tick(),
        keep,
        lastOldRun: 0,
      }),
    ).rejects.toThrow('not the key in force');
    const now: OpenBudget = after.budget;
    await expect(
      keyChangeEntry({
        state: log.state,
        budget: now,
        deviceId: PHONE,
        at: log.at,
        now: log.tick(),
        keep: [],
        lastOldRun: 0,
      }),
    ).rejects.toThrow();
    await expect(
      keyChangeEntry({
        state: log.state,
        budget: now,
        deviceId: PHONE,
        at: log.at,
        now: log.tick(),
        keep: [secondSlot],
        lastOldRun: 0,
      }),
    ).rejects.toThrow();
  });

  it('a new recovery key: added by a slot change, and the old one stops with the key change that leaves it out', async () => {
    const { first, made, log } = await budgetWithTwoPasskeys();
    const mine = (await openWithPasskey(log.entries, BUDGET, first)).budget;
    const fresh = await newRecoveryKeyEntry({
      state: log.state,
      budget: mine,
      deviceId: PHONE,
      at: log.at,
      now: log.tick(),
    });
    expect(fresh.slotId).toBe('r:2');
    expect(fresh.replaces).toEqual(['r:1']);
    expect(fresh.recoveryText).not.toBe(made.recoveryText);
    await log.take(fresh.entry);
    // Until the key change, both open the budget.
    expect(hex((await openWithRecoveryKey(log.entries, BUDGET, made.recoveryText)).budget.bk)).toBe(
      hex(mine.bk),
    );
    expect(hex((await openWithRecoveryKey(log.entries, BUDGET, fresh.recoveryText)).budget.bk)).toBe(
      hex(mine.bk),
    );

    const keep = [...log.state.slots.keys()].filter((id) => !fresh.replaces.includes(id));
    const change = await keyChangeEntry({
      state: log.state,
      budget: mine,
      deviceId: PHONE,
      at: log.at,
      now: log.tick(),
      keep,
      lastOldRun: 0,
    });
    await log.take(change.entry);
    const byNew = await openWithRecoveryKey(log.entries, BUDGET, fresh.recoveryText);
    expect(hex(byNew.budget.bk)).toBe(hex(change.next.bk));
    await expect(openWithRecoveryKey(log.entries, BUDGET, made.recoveryText)).rejects.toThrow();
    // The next new recovery key is generation 3.
    const again = await newRecoveryKeyEntry({
      state: log.state,
      budget: byNew.budget,
      deviceId: PHONE,
      at: log.at,
      now: log.tick(),
    });
    expect(again.slotId).toBe('r:3');
    expect(again.replaces).toEqual(['r:2']);
  });

  it('a planned key change: the intent waits, can be cancelled, and is named by the change that carries it out', async () => {
    const { first, log } = await budgetWithTwoPasskeys();
    const mine = (await openWithPasskey(log.entries, BUDGET, first)).budget;
    const remove = [slotOf(log, 'r:')[0]!];
    const keep = [...log.state.slots.keys()].filter((id) => !remove.includes(id));
    const w = () => ({ state: log.state, budget: mine, deviceId: PHONE, at: log.at, now: log.tick() });

    // Planned, then cancelled: a change that names it is refused by the log.
    const plan = await intentEntry({ ...w(), remove, notBefore: log.now + 7 * DAY });
    await log.take(plan);
    const planned = { number: plan.header.number, hash: plan.hash };
    await log.take(await cancelEntry({ ...w(), intent: planned }));
    log.tick(8 * DAY);
    const dead = await keyChangeEntry({ ...w(), keep, lastOldRun: 0, intent: planned });
    await expect(log.take(dead.entry)).rejects.toThrow();

    // Planned again: too early it is refused, after the wait it is taken.
    const plan2 = await intentEntry({ ...w(), remove, notBefore: log.now + 7 * DAY });
    await log.take(plan2);
    const planned2 = { number: plan2.header.number, hash: plan2.hash };
    const early = await keyChangeEntry({ ...w(), keep, lastOldRun: 0, intent: planned2 });
    await expect(log.take(early.entry)).rejects.toThrow();
    log.tick(8 * DAY);
    const due = await keyChangeEntry({ ...w(), keep, lastOldRun: 0, intent: planned2 });
    await log.take(due.entry);
    expect(log.state.keyVersion).toBe(2);
    expect([...log.state.slots.keys()].sort()).toEqual([...keep].sort());
    // A way in that is not part of the budget can't be planned away.
    await expect(
      intentEntry({
        state: log.state,
        budget: due.next,
        deviceId: PHONE,
        at: log.at,
        now: log.tick(),
        remove,
        notBefore: 0,
      }),
    ).rejects.toThrow();
  });
});
