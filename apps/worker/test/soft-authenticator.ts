// A software passkey for tests: real P-256 keys and real WebAuthn messages (attestation "none"), so the Worker's
// verification runs exactly as it does for a phone or laptop.

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor> | Cbor[];

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function cbor(v: Cbor): Uint8Array {
  const out: number[] = [];
  const enc = (x: Cbor) => {
    if (typeof x === 'number') out.push(...(x >= 0 ? head(0, x) : head(1, -1 - x)));
    else if (typeof x === 'string') {
      const b = new TextEncoder().encode(x);
      out.push(...head(3, b.length), ...b);
    } else if (x instanceof Uint8Array) out.push(...head(2, x.length), ...x);
    else if (Array.isArray(x)) {
      out.push(...head(4, x.length));
      x.forEach(enc);
    } else {
      out.push(...head(5, x.size));
      for (const [k, val] of x) {
        enc(k);
        enc(val);
      }
    }
  };
  enc(v);
  return Uint8Array.from(out);
}

export const b64u = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64u = (s: string): Uint8Array => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
};
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
const concat = (...xs: Uint8Array[]) => {
  const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of xs) {
    out.set(x, i);
    i += x.length;
  }
  return out;
};
const u32 = (n: number) => Uint8Array.from([(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);

/** WebCrypto signs ECDSA as raw r‖s; WebAuthn carries it DER-encoded. */
function der(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0]! & 0x80) v = concat(Uint8Array.from([0]), v);
    return concat(Uint8Array.from([0x02, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(Uint8Array.from([0x30, body.length]), body);
}

export class SoftAuthenticator {
  private keys: CryptoKeyPair | null = null;
  readonly credId = crypto.getRandomValues(new Uint8Array(16));
  counter = 0;

  constructor(
    readonly origin: string,
    readonly rpId: string,
  ) {}

  get id(): string {
    return b64u(this.credId);
  }

  async create(options: { challenge: string }) {
    this.keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', this.keys.publicKey)) as JsonWebKey;
    const cose = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromB64u(jwk.x!)],
        [-3, fromB64u(jwk.y!)],
      ]),
    );
    const clientData = new TextEncoder().encode(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: options.challenge,
        origin: this.origin,
        crossOrigin: false,
      }),
    );
    const authData = concat(
      await sha256(new TextEncoder().encode(this.rpId)),
      Uint8Array.from([0x01 | 0x04 | 0x40]), // user present, user verified, attested credential data
      u32(this.counter),
      new Uint8Array(16), // AAGUID
      Uint8Array.from([0, this.credId.length]),
      this.credId,
      cose,
    );
    const att = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ['internal'] },
      clientExtensionResults: {},
    };
  }

  async get(options: { challenge: string }, o: { origin?: string; signWith?: SoftAuthenticator } = {}) {
    this.counter++;
    const clientData = new TextEncoder().encode(
      JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: o.origin ?? this.origin }),
    );
    const authData = concat(
      await sha256(new TextEncoder().encode(this.rpId)),
      Uint8Array.from([0x01 | 0x04]),
      u32(this.counter),
    );
    const signer = (o.signWith ?? this).keys!.privateKey;
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        signer,
        concat(authData, await sha256(clientData)),
      ),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authData),
        signature: b64u(der(sig)),
        userHandle: b64u(new TextEncoder().encode('ledgerline-owner')),
      },
      clientExtensionResults: {},
    };
  }
}
