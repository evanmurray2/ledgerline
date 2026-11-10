// Adding a device with its own passkey (docs/privacy-keys.md section 10).
import { describe, expect, it } from 'vitest';
import {
  ADD_OFFER_LEN,
  ADD_SEALED_LEN,
  AddError,
  addTranscript,
  type BudgetKeys,
  type Bytes,
  checkConfirm,
  concat,
  deriveBudgetKeys,
  encodeOffer,
  fromHex,
  hpke,
  label,
  offerAdd,
  openBudgetKey,
  randomBytes,
  readOffer,
  revealAdd,
  sealBudgetKey,
  sha256,
  startAdd,
  toHex,
} from '../src/index.js';

const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const HEAD = { number: 1234, hash: fromHex('55'.repeat(32)) };

async function budget(version = 2): Promise<{ bk: Bytes; keys: BudgetKeys }> {
  const bk = randomBytes(32);
  return { bk, keys: await deriveBudgetKeys(bk, BUDGET, version) };
}

/** The three messages, relayed honestly. */
async function crossed(keys: BudgetKeys) {
  const n = await startAdd();
  const offer = offerAdd(keys, HEAD);
  const reveal = revealAdd(n);
  const atO = await addTranscript(BUDGET, n.commit, offer, reveal);
  const atN = await addTranscript(BUDGET, n.commit, offer, reveal);
  return { n, offer, reveal, atO, atN };
}

const why = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof AddError) return e.why;
    throw e;
  }
  throw new Error('did not stop');
};

describe('adding a device', () => {
  it('hands the budget key to the new device, and both ends agree', async () => {
    const { bk, keys } = await budget();
    const { n, atO, atN } = await crossed(keys);
    expect(atO.code).toMatch(/^[0-9]{6}$/);
    expect(atN.code).toBe(atO.code);

    const sealed = await sealBudgetKey(atO, bk, keys);
    expect(sealed.length).toBe(ADD_SEALED_LEN);
    const got = await openBudgetKey(n, atN, sealed);
    expect(toHex(got.bk)).toBe(toHex(bk));
    expect(got.keys.version).toBe(2);
    expect(toHex(got.keys.sign.pub)).toBe(toHex(keys.sign.pub));
    expect(await checkConfirm(atO, bk, got.confirm)).toBe(true);
  });

  it('gives the pinned commitment, transcript, code and confirmation for fixed messages', async () => {
    // Worked out by a separate program from the formulas in section 10.
    const reveal = concat(fromHex('11'.repeat(32)), fromHex('22'.repeat(32)));
    const commit = fromHex('c07bef466b25d89768090bec0e1f81364afac1823a64ed5e6b50cd0b8f50ce91');
    const offer = encodeOffer({
      nonce: fromHex('33'.repeat(32)),
      signPub: fromHex('44'.repeat(32)),
      version: 2,
      head: HEAD,
    });
    expect(offer.length).toBe(ADD_OFFER_LEN);
    const t = await addTranscript(BUDGET, commit, offer, reveal);
    expect(toHex(t.transcript)).toBe('adf6e70fb4781501a938c15e5fd206d12d2151c38e83f1436431ed92e8ac20bd');
    expect(t.code).toBe('680859');
    const confirm = fromHex('e3676c0a27cb144b6d1b2efc7e0cef0d026bc817e0a5fe80848afcfb89eb8ffd');
    expect(await checkConfirm(t, fromHex('66'.repeat(32)), confirm)).toBe(true);
    expect(await checkConfirm(t, fromHex('67'.repeat(32)), confirm)).toBe(false);
  });

  it('stops when the reveal is not what was committed to', async () => {
    const { keys } = await budget();
    const n = await startAdd();
    const offer = offerAdd(keys, HEAD);
    const swapped = revealAdd(await startAdd());
    expect(await why(addTranscript(BUDGET, n.commit, offer, swapped))).toBe(
      'the reveal does not match the commitment',
    );
    const reveal = revealAdd(n);
    reveal[40]! ^= 1;
    expect(await why(addTranscript(BUDGET, n.commit, offer, reveal))).toBe(
      'the reveal does not match the commitment',
    );
    expect(await why(addTranscript(BUDGET, n.commit.slice(1), offer, revealAdd(n)))).toBe('commitment');
    expect(await why(addTranscript(BUDGET, n.commit, offer.slice(1), revealAdd(n)))).toBe('offer');
    expect(await why(addTranscript(BUDGET, n.commit, offer, revealAdd(n).slice(1)))).toBe('reveal');
  });

  it('changes the transcript when any part of the messages or the budget changes', async () => {
    const { keys } = await budget();
    const { n, offer, reveal, atO } = await crossed(keys);
    const seen = new Set([toHex(atO.transcript)]);
    for (const at of [0, 32, 64, 67, 75, 76, 107]) {
      const o = offer.slice();
      o[at]! ^= 1;
      const t = await addTranscript(BUDGET, n.commit, o, reveal);
      expect(seen.has(toHex(t.transcript))).toBe(false);
      seen.add(toHex(t.transcript));
    }
    const t = await addTranscript(OTHER, n.commit, offer, reveal);
    expect(seen.has(toHex(t.transcript))).toBe(false);
  });

  it('a server in the middle with its own key shows two different transcripts', async () => {
    const { bk, keys } = await budget();
    const n = await startAdd();
    // The server must commit before it sees O's nonce. It commits to a key of its own.
    const server = await startAdd();
    const offer = offerAdd(keys, HEAD);
    const atO = await addTranscript(BUDGET, server.commit, offer, revealAdd(server));
    const atN = await addTranscript(BUDGET, n.commit, offer, revealAdd(n));
    expect(toHex(atO.transcript)).not.toBe(toHex(atN.transcript));
    // If the person confirmed all the same, what O seals for the server's key does not open for N.
    const sealed = await sealBudgetKey(atO, bk, keys);
    expect(await why(openBudgetKey(n, atN, sealed))).toBe('the sealed key does not open');
  });

  it('a server that plays O with a budget of its own is caught by the signing key check', async () => {
    const real = await budget();
    const { n, offer, reveal } = await crossed(real.keys);
    const atN = await addTranscript(BUDGET, n.commit, offer, reveal);
    // The offer names the real signing key, but the key sealed is another.
    const fake = randomBytes(32);
    const sealed = await hpke.seal(
      atN.addPub,
      concat(label('ledgerline/v1/hpke/device-add'), atN.transcript),
      atN.offer.signPub,
      fake,
    );
    expect(await why(openBudgetKey(n, atN, sealed))).toBe('not the key of the signing key it named');
  });

  it('opens once only, and only what was sealed for this transcript', async () => {
    const { bk, keys } = await budget();
    const a = await crossed(keys);
    const b = await crossed(keys);
    const sealedB = await sealBudgetKey(b.atO, bk, keys);
    expect(await why(openBudgetKey(a.n, a.atN, sealedB))).toBe('the sealed key does not open');
    // That try is over, also for the right sealed key.
    const sealedA = await sealBudgetKey(a.atO, bk, keys);
    expect(await why(openBudgetKey(a.n, a.atN, sealedA))).toBe('this try is over');

    const c = await crossed(keys);
    const sealedC = await sealBudgetKey(c.atO, bk, keys);
    expect(await why(openBudgetKey(c.n, c.atN, sealedC.slice(1)))).toBe('sealed key');
    const d = await crossed(keys);
    expect(await why(openBudgetKey(d.n, c.atN, sealedC))).toBe('sealed key');
  });

  it('seals only the key the offer named', async () => {
    const { bk, keys } = await budget();
    const { atO } = await crossed(keys);
    const other = await budget();
    await expect(sealBudgetKey(atO, other.bk, other.keys)).rejects.toThrow(RangeError);
    await expect(sealBudgetKey(atO, other.bk, keys)).rejects.toThrow(RangeError);
    const v3 = await deriveBudgetKeys(bk, BUDGET, 3);
    await expect(sealBudgetKey(atO, bk, v3)).rejects.toThrow(RangeError);
  });

  it('refuses a small-order key from the new device', async () => {
    const { bk, keys } = await budget();
    const reveal = concat(new Uint8Array(32), randomBytes(32));
    const commit = await sha256(concat(label('ledgerline/v1/add/commit'), reveal));
    const t = await addTranscript(BUDGET, commit, offerAdd(keys, HEAD), reveal);
    expect(await why(sealBudgetKey(t, bk, keys))).toBe('weak key');
  });

  it('does not show "added" for a wrong confirmation', async () => {
    const { bk, keys } = await budget();
    const { n, atO, atN } = await crossed(keys);
    const got = await openBudgetKey(n, atN, await sealBudgetKey(atO, bk, keys));
    const bad = got.confirm.slice();
    bad[0]! ^= 1;
    expect(await checkConfirm(atO, bk, bad)).toBe(false);
    expect(await checkConfirm(atO, bk, got.confirm.slice(1))).toBe(false);
    const again = await crossed(keys);
    expect(await checkConfirm(again.atO, bk, got.confirm)).toBe(false);
  });

  it('reads an offer strictly', async () => {
    const { keys } = await budget();
    const offer = offerAdd(keys, HEAD);
    const o = readOffer(offer);
    expect(o.version).toBe(2);
    expect(o.head.number).toBe(1234);
    expect(toHex(encodeOffer(o))).toBe(toHex(offer));
    expect(() => readOffer(concat(offer, new Uint8Array(1)))).toThrow();
    const zeroVersion = offer.slice();
    zeroVersion.set([0, 0, 0, 0], 64);
    expect(() => readOffer(zeroVersion)).toThrow();
    expect(() => encodeOffer({ ...o, version: 0 })).toThrow(RangeError);
    expect(() => encodeOffer({ ...o, head: { number: 0, hash: o.head.hash } })).toThrow(RangeError);
    // Two offers never share a nonce.
    expect(toHex(readOffer(offerAdd(keys, HEAD)).nonce)).not.toBe(toHex(o.nonce));
  });
});
