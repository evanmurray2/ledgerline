// Byte building blocks for the key formats (docs/privacy-keys.md section 1). Everything here is exact: a reader
// refuses bytes left over, a length that doesn't fit, and a count over its maximum.

/** Bytes that own their buffer (what WebCrypto takes). */
export type Bytes = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();
// ignoreBOM keeps a leading U+FEFF in the text, so it is refused like any other unexpected character: stripped,
// two different byte strings would read as the same text.
const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function bytes(n: number): Bytes {
  return new Uint8Array(n);
}

export function randomBytes(n: number): Bytes {
  return crypto.getRandomValues(bytes(n));
}

export function concat(...parts: Uint8Array[]): Bytes {
  const out = bytes(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function utf8(s: string): Bytes {
  return enc.encode(s) as Bytes;
}

export function u8(n: number): Bytes {
  if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new RangeError('u8');
  return Uint8Array.of(n) as Bytes;
}

export function u16(n: number): Bytes {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new RangeError('u16');
  return Uint8Array.of(n >>> 8, n & 0xff) as Bytes;
}

export function u32(n: number): Bytes {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError('u32');
  const out = bytes(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

/** A whole number up to 2^53 - 1 (every counter and time here is far below it), as 8 big-endian bytes. */
export function u64(n: number): Bytes {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('u64');
  const out = bytes(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}

/** `u32(length) || x`: how every field of unknown length is written. */
export function str(x: Uint8Array | string): Bytes {
  const b = typeof x === 'string' ? utf8(x) : x;
  return concat(u32(b.length), b);
}

/**
 * A label: its ASCII bytes and one zero byte. Labels hold no zero byte, so no label's bytes are the start of
 * another's, whatever follows.
 */
export function label(name: string): Bytes {
  if (!/^ledgerline\/v\d+\/[\x21-\x7e]+$/.test(name)) throw new RangeError(`label: ${name}`);
  return concat(utf8(name), u8(0));
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export function zeroize(...xs: Uint8Array[]): void {
  for (const x of xs) x.fill(0);
}

export function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(s: string): Bytes {
  if (s.length % 2 !== 0 || !/^[0-9a-f]*$/.test(s)) throw new RangeError('hex');
  const out = bytes(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Unpadded base64url, in its one spelling: an impossible length or stray trailing bits are refused. */
export function fromB64url(s: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new RangeError('base64url');
  const out = b64urlBytes(s);
  if (toB64url(out) !== s) throw new RangeError('base64url');
  return out;
}

function b64urlBytes(s: string): Bytes {
  const bin = atob(
    s
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(s.length / 4) * 4, '='),
  );
  const out = bytes(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** base64url with no padding. */
export function toB64url(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A structure that doesn't parse: refused whole, never guessed at. */
export class FormatError extends Error {
  constructor(what: string) {
    super(`format: ${what}`);
  }
}

/** Reads a structure field by field. `end()` refuses bytes left over. */
export class Reader {
  private o = 0;
  constructor(private readonly b: Uint8Array) {}

  take(n: number): Bytes {
    if (!Number.isInteger(n) || n < 0 || this.o + n > this.b.length) throw new FormatError('short');
    const out = this.b.slice(this.o, this.o + n) as Bytes;
    this.o += n;
    return out;
  }
  u8(): number {
    return this.take(1)[0]!;
  }
  u16(): number {
    const t = this.take(2);
    return (t[0]! << 8) | t[1]!;
  }
  u32(): number {
    const t = this.take(4);
    return new DataView(t.buffer).getUint32(0);
  }
  u64(): number {
    const t = this.take(8);
    const n = new DataView(t.buffer).getBigUint64(0);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new FormatError('u64 too large');
    return Number(n);
  }
  /** A `str` field of at most `max` bytes. */
  str(max: number): Bytes {
    const n = this.u32();
    if (n > max) throw new FormatError('too long');
    return this.take(n);
  }
  text(max: number): string {
    try {
      return dec.decode(this.str(max));
    } catch (e) {
      if (e instanceof FormatError) throw e;
      throw new FormatError('text');
    }
  }
  magic(m: string): void {
    if (!equal(this.take(4), utf8(m))) throw new FormatError(`not ${m}`);
  }
  end(): void {
    if (this.o !== this.b.length) throw new FormatError('bytes left over');
  }
}

/** A ULID as the formats write ids: 26 characters of Crockford base32, upper case. */
export function isUlid(s: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);
}
