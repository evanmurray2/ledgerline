// Bytes as text: base64 (padded), base64url (unpadded) and hex, for the Worker and the bank provider. Each works on
// the whole input at once, at any size: no per-call argument spread (which overflows the stack on large input) and
// no string built a character at a time (about 2 ms for each 64 KB).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CODES = Uint8Array.from(ALPHABET, (ch) => ch.charCodeAt(0));
const PAD = 0x3d; // '='
// The output is ASCII, which UTF-8 decodes as itself.
const ascii = new TextDecoder();

/** Base64 with padding (RFC 4648 section 4). */
export function toBase64(b: Uint8Array): string {
  const out = new Uint8Array(Math.ceil(b.length / 3) * 4);
  let o = 0;
  let i = 0;
  for (; i + 3 <= b.length; i += 3) {
    const v = (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
    out[o++] = CODES[v >> 18]!;
    out[o++] = CODES[(v >> 12) & 63]!;
    out[o++] = CODES[(v >> 6) & 63]!;
    out[o++] = CODES[v & 63]!;
  }
  const rest = b.length - i;
  if (rest > 0) {
    const v = (b[i]! << 16) | (rest === 2 ? b[i + 1]! << 8 : 0);
    out[o++] = CODES[v >> 18]!;
    out[o++] = CODES[(v >> 12) & 63]!;
    out[o++] = rest === 2 ? CODES[(v >> 6) & 63]! : PAD;
    out[o++] = PAD;
  }
  return ascii.decode(out);
}

/**
 * The bytes of base64 text, as `atob` reads it: padding optional, ASCII whitespace skipped, and anything else outside
 * the alphabet (or an impossible length) thrown as `atob` throws it. Check the text first with `isBase64` where
 * whitespace or a missing character must be refused.
 */
export function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Base64url with no padding (RFC 4648 section 5), as tokens, cookies and WebAuthn ids are written. */
export function toBase64url(b: Uint8Array): string {
  return toBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The bytes of base64url text, padded or not (read as `fromBase64` reads base64). */
export function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  return fromBase64(s.replace(/-/g, '+').replace(/_/g, '/'));
}

const OUTSIDE = /[^A-Za-z0-9+/=]/;

/**
 * Whether `s` is base64 as `^[A-Za-z0-9+/]+={0,2}$` says: at least one character of the alphabet, then at most two
 * `=`, and nothing else. The same answer as that pattern, many times faster on long text (the pattern costs about
 * 0.5 ms for each 100 KB in V8; a search for a character outside the alphabet stops at the first one).
 */
export function isBase64(s: string): boolean {
  if (s.length === 0 || OUTSIDE.test(s)) return false;
  const pad = s.indexOf('=');
  if (pad === -1) return true;
  if (pad === 0 || pad < s.length - 2) return false;
  return pad === s.length - 1 || s.charCodeAt(s.length - 1) === PAD;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Lower-case hex. */
export function bytesToHex(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += HEX[b[i]!];
  return out;
}
