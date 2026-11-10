// Device check (docs/privacy.md 15.4, phase 0): whether this browser can do what the privacy design needs, and how
// long it takes. It uses made-up keys and data only; nothing is read from the budget and nothing is sent anywhere.
import {
  deriveBudgetKeys,
  dh,
  dhPairFromSeed,
  fromHex,
  hpke,
  openChunk,
  randomBytes,
  sealChunk,
  sealedEntry,
  KIND,
  sign,
  signPairFromSeed,
  toHex,
  verify,
  verifyEntry,
} from '@ledgerline/seal';

export interface CheckResult {
  name: string;
  ok: boolean;
  /** How long it took, in milliseconds. */
  ms: number;
  /** Why it failed, or a number worth reading. */
  note?: string;
}

const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const DEVICE = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const SNAPSHOT = '01CX5ZZKBKACTAV9WEVGEMMVRZ';

/** crypto.getRandomValues fills at most 65,536 bytes a call. */
function noise(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let o = 0; o < n; o += 65536) out.set(randomBytes(Math.min(65536, n - o)), o);
  return out;
}

const same = (a: Uint8Array, b: Uint8Array): boolean => toHex(a) === toHex(b);

const CHECKS: [string, () => Promise<string | undefined>][] = [
  [
    'Signing keys (Ed25519)',
    async () => {
      // RFC 8032, test 1.
      const pair = await signPairFromSeed(
        fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'),
      );
      if (toHex(pair.pub) !== 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')
        throw new Error('wrong public key');
      const message = randomBytes(64);
      if (!(await verify(pair.pub, message, await sign(pair.privateKey, message))))
        throw new Error('a good signature did not verify');
      if (await verify(pair.pub, randomBytes(64), await sign(pair.privateKey, message)))
        throw new Error('a wrong signature verified');
      return undefined;
    },
  ],
  [
    'Sealing keys (X25519)',
    async () => {
      const a = await dhPairFromSeed(randomBytes(32));
      const b = await dhPairFromSeed(randomBytes(32));
      if (!same(await dh(a.privateKey, b.pub), await dh(b.privateKey, a.pub)))
        throw new Error('the two sides disagree');
      return undefined;
    },
  ],
  [
    'Seal a bank page to a key (200 KB)',
    async () => {
      const inbox = await dhPairFromSeed(randomBytes(32));
      const page = noise(200_000);
      const info = randomBytes(40);
      const sealed = await hpke.seal(inbox.pub, info, new Uint8Array(15), page);
      if (!same(await hpke.open(inbox, info, new Uint8Array(15), sealed), page))
        throw new Error('opened to other bytes');
      return undefined;
    },
  ],
  [
    'Budget keys, and one signed, sealed entry',
    async () => {
      const keys = await deriveBudgetKeys(randomBytes(32), BUDGET, 1);
      const entry = await sealedEntry(
        {
          kind: KIND.edit,
          budgetId: BUDGET,
          number: 2,
          prevHash: randomBytes(32),
          entryId: randomBytes(16),
          time: Date.now(),
          deviceId: DEVICE,
          deviceCounter: 1,
          keyVersion: 1,
          schemaVersion: 1,
          processingVersion: 1,
          part: 1,
          parts: 1,
          filedThrough: 0,
          receipts: [],
          scanThrough: 0,
        },
        noise(3000),
        keys,
      );
      if (!(await verifyEntry(entry, keys.sign.pub))) throw new Error('the entry did not verify');
      return undefined;
    },
  ],
  [
    'Seal and open a snapshot (8 MB in 32 chunks)',
    async () => {
      const keys = await deriveBudgetKeys(randomBytes(32), BUDGET, 1);
      const count = 32;
      const chunk = noise(256 * 1024);
      let sealMs = 0;
      let openMs = 0;
      for (let k = 1; k <= count; k++) {
        let t = performance.now();
        const sealed = await sealChunk(keys, BUDGET, SNAPSHOT, k, count, chunk);
        sealMs += performance.now() - t;
        t = performance.now();
        const plain = await openChunk(keys, BUDGET, SNAPSHOT, k, count, sealed);
        openMs += performance.now() - t;
        if (plain.length !== chunk.length || plain[k] !== chunk[k]) throw new Error('opened to other bytes');
      }
      return `seal ${Math.round(sealMs)} ms, open ${Math.round(openMs)} ms`;
    },
  ],
];

/** Runs every check in turn and reports each as it ends. A check that fails doesn't stop the others. */
export async function runDeviceChecks(report: (r: CheckResult) => void): Promise<void> {
  for (const [name, run] of CHECKS) {
    const start = performance.now();
    try {
      const note = await run();
      report({ name, ok: true, ms: performance.now() - start, ...(note ? { note } : {}) });
    } catch (e) {
      report({
        name,
        ok: false,
        ms: performance.now() - start,
        note: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      });
    }
  }
}

/** What a passkey gave when asked for two secrets at once. No secret leaves this function. */
export interface PasskeyCheck {
  /** The passkey gave a first and a second secret, 32 bytes each. */
  first: boolean;
  second: boolean;
  /** The two differ, as they must. */
  differ: boolean;
  /** Where the passkey lives, as the browser tells it: "platform" (this device, or iCloud) or "cross-platform". */
  attachment: string;
}

/**
 * Asks a passkey for two PRF outputs in one prompt (docs/privacy-keys.md 4.1). The challenge is made here and the
 * answer is thrown away: this signs nobody in, and the server never hears of it.
 */
export async function checkPasskey(): Promise<PasskeyCheck> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      userVerification: 'required',
      allowCredentials: [],
      extensions: {
        prf: { eval: { first: randomBytes(32), second: randomBytes(32) } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw Object.assign(new Error('Cancelled'), { name: 'NotAllowedError' });
  const ext = cred.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer; second?: ArrayBuffer } };
  };
  const first = ext.prf?.results?.first;
  const second = ext.prf?.results?.second;
  const a = first ? new Uint8Array(first) : null;
  const b = second ? new Uint8Array(second) : null;
  try {
    return {
      first: a?.length === 32,
      second: b?.length === 32,
      differ: !!a && !!b && !same(a, b),
      attachment: cred.authenticatorAttachment ?? 'not told',
    };
  } finally {
    a?.fill(0);
    b?.fill(0);
  }
}
