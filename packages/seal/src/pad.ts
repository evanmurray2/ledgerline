// Padding of an entry's plain body (docs/privacy-keys.md 6.2), so its sealed length says little: x || 0x80 || zeros,
// up to the smallest step that fits.
import { type Bytes, bytes, FormatError } from './bytes.js';

export const PAD_STEPS = [256, 1024, 4096, 16384, 65536] as const;
/** The largest plain body of one entry; anything larger is written as parts. */
export const MAX_PLAIN = 65535;

function step(n: number): number {
  for (const s of PAD_STEPS) if (n + 1 <= s) return s;
  throw new RangeError('body too large for one entry');
}

export function pad(x: Uint8Array): Bytes {
  const out = bytes(step(x.length));
  out.set(x);
  out[x.length] = 0x80;
  return out;
}

/** Refuses a length that isn't a step, a missing 0x80, and padding to a larger step than was needed. */
export function unpad(padded: Uint8Array): Bytes {
  if (!(PAD_STEPS as readonly number[]).includes(padded.length)) throw new FormatError('padding length');
  let i = padded.length - 1;
  while (i >= 0 && padded[i] === 0) i--;
  if (i < 0 || padded[i] !== 0x80) throw new FormatError('padding');
  if (step(i) !== padded.length) throw new FormatError('padded too far');
  return padded.slice(0, i) as Bytes;
}
