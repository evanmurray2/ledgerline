// A chain that starts at a snapshot and not at the genesis entry (docs/privacy-keys.md section 8), and a chain state
// kept between runs.
import { describe, expect, it } from 'vitest';
import {
  advance,
  ChainError,
  type ChainPosition,
  type ChainState,
  type Entry,
  fromStored,
  isPublicKind,
  KIND,
  passkeySlot,
  randomBytes,
  resumeChain,
  sealedEntry,
  toHex,
  toStored,
  utf8,
  walkPublic,
} from '../src/index.js';
import { Budget, BUDGET, LAPTOP, PHONE } from './budget.js';

const positionOf = (s: ChainState): ChainPosition => ({
  number: s.number,
  hash: s.hash,
  time: s.time,
  entryId: s.entryId,
  filedThrough: s.filedThrough,
  scanThrough: s.scanThrough,
  counters: new Map(s.counters),
});

/** A budget with a few entries of each kind, and the state after each entry. */
async function written() {
  const b = await Budget.create();
  const states: ChainState[] = [b.state];
  const step = async (p: Promise<unknown>) => {
    await p;
    states.push(b.state);
  };
  await step(b.edit());
  await step(b.edit(LAPTOP));
  await step(b.addSlot(await passkeySlot(randomBytes(32), BUDGET, randomBytes(16))));
  await step(b.bank(2));
  await step(b.edit());
  await step(b.keyChange([b.passkey.slotId, b.recovery.slotId]));
  await step(b.edit(LAPTOP));
  await step(b.edit());
  return { b, states };
}

/** The chain as a device that opened a snapshot at entry `n` builds it. */
async function resumedAt(b: Budget, states: ChainState[], n: number): Promise<ChainState> {
  const publics = b.entries.filter((e) => isPublicKind(e.header.kind) && e.header.number <= n);
  const p = await walkPublic(publics, BUDGET);
  return resumeChain(p, positionOf(states[n - 1]!));
}

describe('a chain that starts at a snapshot', () => {
  it('takes the same entries as the chain read from the start, at every place a snapshot can stand', async () => {
    const { b, states } = await written();
    for (let n = 1; n < b.entries.length; n++) {
      let s = await resumedAt(b, states, n);
      for (const e of b.entries.slice(n)) s = await advance(s, e, b.checker);
      const end = states.at(-1)!;
      expect(s.number).toBe(end.number);
      expect(toHex(s.hash)).toBe(toHex(end.hash));
      expect(s.public.keyVersion).toBe(end.public.keyVersion);
      expect([...s.counters]).toEqual([...end.counters]);
      expect(s.filedThrough).toBe(end.filedThrough);
    }
  });

  it('refuses what the full chain refuses: a skipped entry, a repeated counter, a time that stands still', async () => {
    const b = await Budget.create();
    const states: ChainState[] = [b.state];
    for (const device of [PHONE, LAPTOP, PHONE]) {
      await b.edit(device);
      states.push(b.state);
    }
    const s = await resumedAt(b, states, 3);
    const refuses = async (e: Entry, why: string) => {
      const p = advance(s, e, b.checker);
      await expect(p).rejects.toThrow(ChainError);
      await expect(p).rejects.toThrow(why);
    };
    const next = b.entries[3]!;
    await refuses(b.entries[2]!, 'not the next entry');
    const forged = (over: Partial<Entry['header']>) => {
      const { bodyHash: _, ...fields } = next.header;
      return sealedEntry({ ...fields, entryId: randomBytes(16), ...over }, utf8('x'), b.keys);
    };
    await refuses(await forged({ number: 5 }), 'not the next entry');
    await refuses(await forged({ deviceCounter: next.header.deviceCounter - 1 }), 'device counter');
    await refuses(await forged({ deviceId: LAPTOP, deviceCounter: 1 }), 'device counter');
    await refuses(await forged({ time: states[2]!.time }), 'time must move forward');
    await refuses(await forged({ entryId: states[2]!.entryId }), 'entry id repeated');
    await refuses(await forged({ kind: KIND.edit, filedThrough: 1 }), 'filed runs');
    expect((await advance(s, next, b.checker)).number).toBe(4);
  });

  it('refuses a position that does not fit the public chain or its own counters', async () => {
    const { b, states } = await written();
    const publics = b.entries.filter((e) => isPublicKind(e.header.kind));
    const upTo4 = await walkPublic(
      publics.filter((e) => e.header.number <= 4),
      BUDGET,
    );
    const good = positionOf(states[4]!);
    expect(resumeChain(upTo4, good).number).toBe(5);
    const bad = (over: Partial<ChainPosition>) => () => resumeChain(upTo4, { ...good, ...over });
    // Before the public entry it is meant to follow.
    expect(bad({ ...positionOf(states[2]!) })).toThrow(ChainError);
    // At the public entry, with another hash.
    expect(bad({ ...positionOf(states[3]!), hash: randomBytes(32) })).toThrow(ChainError);
    // Counters that don't add up to the number, or a counter of 0.
    expect(bad({ counters: new Map([[PHONE, 4]]) })).toThrow('device counter');
    expect(
      bad({
        counters: new Map([
          [PHONE, 5],
          [LAPTOP, 0],
        ]),
      }),
    ).toThrow('device counter');
    // At the public entry itself, the time and the filed runs are that entry's.
    expect(bad({ ...positionOf(states[3]!), time: states[3]!.time + 1 })).toThrow('snapshot position');
    expect(bad({ time: upTo4.time - 1 })).toThrow(ChainError);
    expect(bad({ entryId: randomBytes(15) })).toThrow(ChainError);
  });
});

describe('a chain state that is kept', () => {
  it('comes back from storage as it went in, and goes on', async () => {
    const { b, states } = await written();
    const mid = states[4]!;
    const stored = toStored(mid);
    expect('signKey' in stored.public).toBe(false);
    // Structured storage keeps numbers, text, bytes, lists and maps.
    const back = await fromStored(structuredClone(stored));
    let s = back;
    for (const e of b.entries.slice(5)) s = await advance(s, e, b.checker);
    expect(toHex(s.hash)).toBe(toHex(states.at(-1)!.hash));
    expect(s.public.keyVersion).toBe(2);
  });
});
