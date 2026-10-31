const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID: 48-bit time + 80 random bits, Crockford base32. */
export function ulid(now: number = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let rnd = '';
  for (let i = 0; i < 16; i++) rnd += ALPHABET[(bytes[i] as number) % 32];
  return time + rnd;
}
