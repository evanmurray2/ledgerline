// Adding a device with its own passkey (docs/privacy-keys.md section 10).
import { describe, expect, it } from 'vitest';
import {
  ADD_ATTEMPTS,
  ADD_OFFER_LEN,
  ADD_SEALED_LEN,
  ADD_WINDOW_MS,
  AddError,
  addTranscriptOf,
  type BudgetKeys,
  type Bytes,
  concat,
  deriveBudgetKeys,
  encodeOffer,
  fromHex,
  hkdf,
  hmac,
  hpke,
  label,
  NewDevice,
  randomBytes,
  readOffer,
  sha256,
  SignedInDevice,
  toHex,
  type WalkedLog,
} from '../src/index.js';

const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const HEAD = { number: 1234, hash: fromHex('55'.repeat(32)) };
const NOW = 1_800_000_000_000;

async function budget(version = 2): Promise<{ bk: Bytes; keys: BudgetKeys; log: WalkedLog }> {
  const bk = randomBytes(32);
  const keys = await deriveBudgetKeys(bk, BUDGET, version);
  return { bk, keys, log: { signPub: keys.sign.pub, keyVersion: version, headHash: HEAD.hash } };
}

/** The three messages, relayed honestly, up to the codes on both screens. */
async function crossed(keys: BudgetKeys) {
  const o = new SignedInDevice(BUDGET, keys, HEAD);
  const n = await NewDevice.start(BUDGET);
  const offer = o.offer(n.commit, NOW);
  const shown = await n.reveal(offer);
  const codeO = await o.code(shown.reveal, NOW + 1000);
  return { o, n, offer, reveal: shown.reveal, codeN: shown.code, codeO };
}

const why = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    if (e instanceof AddError) return e.why;
    throw e;
  }
  throw new Error('did not stop');
};

describe('adding a device', () => {
  it('hands the budget key to the new device, and both ends agree', async () => {
    const { bk, keys, log } = await budget();
    const { o, n, codeN, codeO } = await crossed(keys);
    expect(codeO).toMatch(/^[0-9]{6}$/);
    expect(codeN).toBe(codeO);

    const sealed = await o.seal(bk, NOW + 2000);
    expect(sealed.length).toBe(ADD_SEALED_LEN);
    const got = await n.open(sealed, log);
    expect(toHex(got.bk)).toBe(toHex(bk));
    expect(got.keys.version).toBe(2);
    expect(toHex(got.keys.sign.pub)).toBe(toHex(keys.sign.pub));
    expect(await o.confirmed(bk, got.confirm)).toBe(true);
  });

  it('gives the pinned commitment, transcript and code for fixed messages', async () => {
    // Worked out by a separate program from the formulas in section 10.
    const reveal = concat(fromHex('11'.repeat(32)), fromHex('22'.repeat(32)));
    const commit = fromHex('c07bef466b25d89768090bec0e1f81364afac1823a64ed5e6b50cd0b8f50ce91');
    expect(toHex(await sha256(concat(label('ledgerline/v1/add/commit'), reveal)))).toBe(toHex(commit));
    const offer = encodeOffer({
      nonce: fromHex('33'.repeat(32)),
      signPub: fromHex('44'.repeat(32)),
      version: 2,
      head: HEAD,
    });
    expect(offer.length).toBe(ADD_OFFER_LEN);
    const t = await addTranscriptOf(BUDGET, commit, offer, reveal);
    expect(toHex(t.transcript)).toBe('adf6e70fb4781501a938c15e5fd206d12d2151c38e83f1436431ed92e8ac20bd');
    expect(t.code).toBe('680859');
    // The confirmation for the budget key 66...66, by the same separate program.
    const k = await hkdf(fromHex('66'.repeat(32)), t.transcript, label('ledgerline/v1/add/confirm'), 32);
    expect(toHex(await hmac(k, t.transcript))).toBe(
      'e3676c0a27cb144b6d1b2efc7e0cef0d026bc817e0a5fe80848afcfb89eb8ffd',
    );
  });

  it('shows a code of six digits also when it starts with 0', async () => {
    const reveal = concat(fromHex('11'.repeat(32)), fromHex('22'.repeat(32)));
    const commit = await sha256(concat(label('ledgerline/v1/add/commit'), reveal));
    let seen = false;
    for (let i = 0; i < 400 && !seen; i++) {
      const offer = encodeOffer({
        nonce: await sha256(new Uint8Array([i & 255, i >> 8])),
        signPub: fromHex('44'.repeat(32)),
        version: 2,
        head: HEAD,
      });
      const { code } = await addTranscriptOf(BUDGET, commit, offer, reveal);
      expect(code).toMatch(/^[0-9]{6}$/);
      if (code.startsWith('0')) seen = true;
    }
    expect(seen).toBe(true);
  });

  it('the new device answers one offer only, so the server cannot pick its nonce after the reveal', async () => {
    const { keys } = await budget();
    const o = new SignedInDevice(BUDGET, keys, HEAD);
    const n = await NewDevice.start(BUDGET);
    await n.reveal(o.offer(n.commit, NOW));
    const second = encodeOffer({ ...readOffer(o.offer(n.commit, NOW)), nonce: randomBytes(32) });
    expect(await why(n.reveal(second))).toBe('this try has already answered an offer');
    // An offer that doesn't read ends the try too.
    const m = await NewDevice.start(BUDGET);
    expect(await why(m.reveal(second.slice(1)))).toBe('offer');
    expect(await why(m.reveal(second))).toBe('this try has already answered an offer');
  });

  it('the signed-in device makes an offer only for a commitment, three per start, one reveal each', async () => {
    const { keys } = await budget();
    const o = new SignedInDevice(BUDGET, keys, HEAD);
    expect(await why(() => o.offer(randomBytes(31), NOW))).toBe('commitment');
    expect(await why(o.code(randomBytes(64), NOW))).toBe('no offer waits for a reveal');
    const nonces = new Set<string>();
    for (let i = 0; i < ADD_ATTEMPTS; i++) {
      const n = await NewDevice.start(BUDGET);
      nonces.add(toHex(readOffer(o.offer(n.commit, NOW)).nonce));
    }
    expect(nonces.size).toBe(ADD_ATTEMPTS);
    const n = await NewDevice.start(BUDGET);
    expect(await why(() => o.offer(n.commit, NOW))).toBe('too many tries');

    // One reveal per offer: after one, right or wrong, the offer is spent.
    const p = new SignedInDevice(BUDGET, keys, HEAD);
    const a = await NewDevice.start(BUDGET);
    const shown = await a.reveal(p.offer(a.commit, NOW));
    const wrong = shown.reveal.slice();
    wrong[40]! ^= 1;
    expect(await why(p.code(wrong, NOW))).toBe('the reveal does not match the commitment');
    expect(await why(p.code(shown.reveal, NOW))).toBe('no offer waits for a reveal');
    // And a reveal for an offer that a newer offer replaced no longer fits.
    const q = new SignedInDevice(BUDGET, keys, HEAD);
    const b = await NewDevice.start(BUDGET);
    const first = await b.reveal(q.offer(b.commit, NOW));
    const c = await NewDevice.start(BUDGET);
    q.offer(c.commit, NOW);
    expect(await why(q.code(first.reveal, NOW))).toBe('the reveal does not match the commitment');
  });

  it('an offer lasts 10 minutes', async () => {
    const { bk, keys } = await budget();
    const o = new SignedInDevice(BUDGET, keys, HEAD);
    const n = await NewDevice.start(BUDGET);
    const shown = await n.reveal(o.offer(n.commit, NOW));
    expect(await why(o.code(shown.reveal, NOW + ADD_WINDOW_MS + 1))).toBe('too late');

    const p = new SignedInDevice(BUDGET, keys, HEAD);
    const m = await NewDevice.start(BUDGET);
    const again = await m.reveal(p.offer(m.commit, NOW));
    await p.code(again.reveal, NOW + ADD_WINDOW_MS);
    expect(await why(p.seal(bk, NOW + ADD_WINDOW_MS + 1))).toBe('too late');
  });

  it('a server in the middle with its own key gets a different code, bar one chance in a million', async () => {
    const { keys } = await budget();
    // The server sits between: toward O it is "N" with its own key; toward N it relays O's offer.
    let same = 0;
    for (let i = 0; i < 20; i++) {
      const o = new SignedInDevice(BUDGET, keys, HEAD);
      const n = await NewDevice.start(BUDGET);
      const server = await NewDevice.start(BUDGET);
      const offer = o.offer(server.commit, NOW);
      const atServer = await server.reveal(offer);
      const atN = await n.reveal(offer);
      const codeO = await o.code(atServer.reveal, NOW);
      if (codeO === atN.code) same++;
      // The server can't swap in N's reveal either: O holds the server's commitment.
      const p = new SignedInDevice(BUDGET, keys, HEAD);
      p.offer(server.commit, NOW);
      expect(await why(p.code(atN.reveal, NOW))).toBe('the reveal does not match the commitment');
    }
    expect(same).toBe(0);
  });

  it('changes the transcript when any part of the messages or the budget changes', async () => {
    const reveal = concat(randomBytes(32), randomBytes(32));
    const commit = await sha256(concat(label('ledgerline/v1/add/commit'), reveal));
    const offer = encodeOffer({ nonce: randomBytes(32), signPub: randomBytes(32), version: 2, head: HEAD });
    const seen = new Set([toHex((await addTranscriptOf(BUDGET, commit, offer, reveal)).transcript)]);
    const fresh = async (t: Promise<{ transcript: Bytes }>) => {
      const hex = toHex((await t).transcript);
      expect(seen.has(hex)).toBe(false);
      seen.add(hex);
    };
    for (const at of [0, 32, 64, 67, 75, 76, 107]) {
      const o = offer.slice();
      o[at]! ^= 1;
      await fresh(addTranscriptOf(BUDGET, commit, o, reveal));
    }
    for (const at of [0, 31, 32, 63]) {
      const r = reveal.slice();
      r[at]! ^= 1;
      await fresh(addTranscriptOf(BUDGET, commit, offer, r));
    }
    const c = commit.slice();
    c[0]! ^= 1;
    await fresh(addTranscriptOf(BUDGET, c, offer, reveal));
    await fresh(addTranscriptOf(OTHER, commit, offer, reveal));
  });

  it('seals once, only after a code, and only the key the offer named', async () => {
    const { bk, keys } = await budget();
    const o = new SignedInDevice(BUDGET, keys, HEAD);
    expect(await why(o.seal(bk, NOW))).toBe('no code has been shown, or the key is already sealed');
    const n = await NewDevice.start(BUDGET);
    const offer = o.offer(n.commit, NOW);
    expect(await why(o.seal(bk, NOW))).toBe('no code has been shown, or the key is already sealed');
    await o.code((await n.reveal(offer)).reveal, NOW);
    await o.seal(bk, NOW);
    expect(await why(o.seal(bk, NOW))).toBe('no code has been shown, or the key is already sealed');
    expect(await why(() => o.offer(n.commit, NOW))).toBe('this start is over');

    const other = await budget();
    const again = await crossed(keys);
    expect(await why(again.o.seal(other.bk, NOW))).toBe('not the key the offer named');
    // That start is over, also for the right key.
    expect(await why(again.o.seal(bk, NOW))).toBe('no code has been shown, or the key is already sealed');
  });

  it('the new device opens once, and only what was sealed for its own transcript', async () => {
    const { bk, keys, log } = await budget();
    const a = await crossed(keys);
    const b = await crossed(keys);
    const sealedB = await b.o.seal(bk, NOW);
    expect(await why(a.n.open(sealedB, log))).toBe('the sealed key does not open');
    const sealedA = await a.o.seal(bk, NOW);
    expect(await why(a.n.open(sealedA, log))).toBe('this try is over');

    const c = await crossed(keys);
    expect(await why(c.n.open((await c.o.seal(bk, NOW)).slice(1), log))).toBe('sealed key');
    const d = await NewDevice.start(BUDGET);
    expect(await why(d.open(sealedA, log))).toBe('this try is over');
  });

  it('the new device refuses an offer that does not agree with the log it walked', async () => {
    const { bk, keys, log } = await budget();
    for (const bad of [
      { ...log, keyVersion: 3 },
      { ...log, signPub: randomBytes(32) },
      { ...log, headHash: randomBytes(32) },
    ]) {
      const { o, n } = await crossed(keys);
      expect(await why(n.open(await o.seal(bk, NOW), bad))).toBe('the offer does not agree with the log');
    }
  });

  it('a server that plays O with a budget of its own is caught by the signing key check', async () => {
    const real = await budget();
    const n = await NewDevice.start(BUDGET);
    // The offer names the real signing key, so it agrees with the log; but the key sealed is another.
    const offer = encodeOffer({
      nonce: randomBytes(32),
      signPub: real.keys.sign.pub,
      version: 2,
      head: HEAD,
    });
    const shown = await n.reveal(offer);
    const { transcript } = await addTranscriptOf(BUDGET, n.commit, offer, shown.reveal);
    const sealed = await hpke.seal(
      shown.reveal.slice(0, 32),
      concat(label('ledgerline/v1/hpke/device-add'), transcript),
      real.keys.sign.pub,
      randomBytes(32),
    );
    expect(await why(n.open(sealed, real.log))).toBe('not the key of the signing key it named');
  });

  it('refuses a small-order key from the new device before any code is shown', async () => {
    const { keys } = await budget();
    const o = new SignedInDevice(BUDGET, keys, HEAD);
    const reveal = concat(new Uint8Array(32), randomBytes(32));
    const commit = await sha256(concat(label('ledgerline/v1/add/commit'), reveal));
    o.offer(commit, NOW);
    expect(await why(o.code(reveal, NOW))).toBe('weak key');
  });

  it('does not show "added" for a wrong confirmation, or before the key is sealed', async () => {
    const { bk, keys, log } = await budget();
    const { o, n } = await crossed(keys);
    expect(await o.confirmed(bk, randomBytes(32))).toBe(false);
    const got = await n.open(await o.seal(bk, NOW), log);
    const bad = got.confirm.slice();
    bad[0]! ^= 1;
    expect(await o.confirmed(bk, bad)).toBe(false);
    expect(await o.confirmed(bk, got.confirm.slice(1))).toBe(false);
    expect(await o.confirmed(randomBytes(32), got.confirm)).toBe(false);
    const again = await crossed(keys);
    await again.o.seal(bk, NOW);
    expect(await again.o.confirmed(bk, got.confirm)).toBe(false);
    expect(await o.confirmed(bk, got.confirm)).toBe(true);
  });

  it('reads an offer strictly', async () => {
    const { keys } = await budget();
    const offer = new SignedInDevice(BUDGET, keys, HEAD).offer(randomBytes(32), NOW);
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
  });
});
