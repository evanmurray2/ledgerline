// A chain that starts at a snapshot and not at the genesis entry (docs/privacy-keys.md section 8), and a chain state
// kept between runs.
import { describe, expect, it } from 'vitest';
import {
  advance,
  ChainError,
  type ChainState,
  type Entry,
  fromStored,
  isPublicKind,
  KIND,
  type Kind,
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

const TABLET = '01DX5ZZKBKACTAV9WEVGEMMVRZ';

/** A budget with entries of every kind, a part set among them, and the state after each entry. */
async function written() {
  const b = await Budget.create();
  const states: ChainState[] = [b.state];
  const step = async (p: Promise<unknown>) => {
    await p;
    states.push(b.state);
  };
  const sealed = (kind: Kind, device = PHONE, over = {}) =>
    sealedEntry(b.fields(kind, device, over), utf8('x'), b.keys).then((e) => b.take(e));
  await step(b.edit());
  await step(b.edit(LAPTOP));
  await step(b.addSlot(await passkeySlot(randomBytes(32), BUDGET, randomBytes(16))));
  await step(b.bank(2));
  await step(sealed(KIND.scan, PHONE, { scanThrough: 20000 }));
  // A part set of two.
  const id = randomBytes(16);
  const first = await sealedEntry(
    b.fields(KIND.edit, TABLET, { entryId: id, part: 1, parts: 2 }),
    utf8('1'),
    b.keys,
  );
  await step(b.take(first));
  const second = await sealedEntry(
    b.fields(KIND.edit, TABLET, { entryId: id, part: 2, parts: 2, time: first.header.time }),
    utf8('2'),
    b.keys,
  );
  b.time = first.header.time;
  await step(b.take(second));
  const intent = await b.intent(b.time + 1000, [b.passkey.slotId]);
  await step(b.take(intent));
  await step(sealed(KIND.signOut, LAPTOP));
  await step(b.keyChange([b.passkey.slotId, b.recovery.slotId]));
  await step(sealed(KIND.dataMigration));
  await step(b.edit(LAPTOP));
  await step(b.edit());
  return { b, states };
}

/** The chain as a device that opened a snapshot at entry `n` builds it. */
async function resumedAt(b: Budget, states: ChainState[], n: number): Promise<ChainState> {
  const publics = b.entries.filter((e) => isPublicKind(e.header.kind) && e.header.number <= n);
  const p = await walkPublic(publics, BUDGET);
  const last = b.entries[n - 1]!;
  return resumeChain(p, { number: n, hash: last.hash }, last, states[n - 1]!.counters);
}

/** A chain state as text, for comparing two of them whole. */
function shown(s: ChainState): string {
  const { signKey: _, ...p } = s.public;
  return JSON.stringify({ ...s, public: p }, (_k, v: unknown) =>
    v instanceof Uint8Array ? toHex(v) : v instanceof Map ? [...v].sort() : v,
  );
}

describe('a chain that starts at a snapshot', () => {
  it('is the same state as the chain read from the start, at every place a snapshot can stand', async () => {
    const { b, states } = await written();
    let places = 0;
    for (let n = 1; n <= b.entries.length; n++) {
      const h = b.entries[n - 1]!.header;
      if (h.part !== h.parts) continue;
      places++;
      let s = await resumedAt(b, states, n);
      expect(shown(s)).toBe(shown(states[n - 1]!));
      for (const e of b.entries.slice(n)) s = await advance(s, e, b.checker);
      expect(shown(s)).toBe(shown(states.at(-1)!));
    }
    expect(places).toBe(b.entries.length - 1);
  });

  it('never stands inside a part set', async () => {
    const { b, states } = await written();
    const n = b.entries.findIndex((e) => e.header.parts === 2) + 1;
    await expect(resumedAt(b, states, n)).rejects.toThrow('a snapshot never stands inside a part set');
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

  it('refuses an entry or counters that do not fit the snapshot or the public chain', async () => {
    const { b, states } = await written();
    const publics = b.entries.filter((e) => isPublicKind(e.header.kind));
    const upTo4 = await walkPublic(
      publics.filter((e) => e.header.number <= 4),
      BUDGET,
    );
    const entry = (n: number) => b.entries[n - 1]!;
    const at = (n: number) => ({ number: n, hash: entry(n).hash });
    const counters = (n: number) => states[n - 1]!.counters;
    expect((await resumeChain(upTo4, at(5), entry(5), counters(5))).number).toBe(5);
    const bad = (p: Promise<unknown>, why: string) => expect(p).rejects.toThrow(why);

    // Not the entry the snapshot's header names.
    await bad(resumeChain(upTo4, at(5), entry(6), counters(6)), 'not the entry the snapshot stands at');
    await bad(
      resumeChain(upTo4, { number: 5, hash: randomBytes(32) }, entry(5), counters(5)),
      'not the entry the snapshot stands at',
    );
    // An entry whose hash is not its own.
    await bad(
      resumeChain(upTo4, at(5), { ...entry(5), header: { ...entry(5).header, time: 5 } }, counters(5)),
      'entry hash',
    );
    // Before the public entry it is meant to follow.
    await bad(
      resumeChain(upTo4, at(3), entry(3), counters(3)),
      'the snapshot stands before its public entry',
    );
    // Past a public entry the walk does not hold, or one signed by a key the walk has not reached.
    const upTo1 = await walkPublic(publics.slice(0, 1), BUDGET);
    await bad(resumeChain(upTo1, at(4), entry(4), counters(4)), 'a public entry the walk does not hold');
    const afterKeyChange = b.entries.findIndex((e) => e.header.kind === KIND.keyChange) + 2;
    await bad(
      resumeChain(upTo4, at(afterKeyChange), entry(afterKeyChange), counters(afterKeyChange)),
      'key version not in force',
    );
    // Counters that don't add up, hold a 0 or a fraction, or disagree with the entry's own counter.
    const c5 = counters(5);
    await bad(resumeChain(upTo4, at(5), entry(5), new Map([[PHONE, 4]])), 'device counter');
    await bad(resumeChain(upTo4, at(5), entry(5), new Map([...c5, [TABLET, 0]])), 'device counter');
    await bad(
      resumeChain(
        upTo4,
        at(5),
        entry(5),
        new Map([
          [PHONE, 4.5],
          [LAPTOP, 0.5],
        ]),
      ),
      'device counter',
    );
    await bad(resumeChain(upTo4, at(5), entry(5), new Map([[PHONE, Number.NaN]])), 'device counter');
    const swapped = new Map([
      [PHONE, c5.get(LAPTOP)!],
      [LAPTOP, c5.get(PHONE)!],
    ]);
    expect(c5.get(PHONE)).not.toBe(c5.get(LAPTOP));
    await bad(resumeChain(upTo4, at(5), entry(5), swapped), 'device counter');
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
    expect(shown(back)).toBe(shown(mid));
    let s = back;
    for (const e of b.entries.slice(5)) s = await advance(s, e, b.checker);
    expect(shown(s)).toBe(shown(states.at(-1)!));
  });
});
