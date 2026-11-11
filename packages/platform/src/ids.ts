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

/**
 * A ULID whose 80 "random" bits come from a seed and a counter, not from chance: the same (time, seed, n) gives the
 * same id on every device and on the server. An edit made on the phone and stored by the server then names its new
 * rows the same on both sides (docs/privacy.md 5.3: "ids are an input, like the clock"). The seed is the edit's own
 * id, which is random, so two edits never share an id. It is not a secret and gives no secrecy.
 */
export function seededUlid(now: number, seed: string, n: number): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  // Four 32-bit words mixed from the text (cyrb128), then a small generator (sfc32) for the 16 characters.
  const text = `${seed}#${n}`;
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  let a = (h1 ^ h2 ^ h3 ^ h4) >>> 0;
  let b = (h2 ^ h1) >>> 0;
  let c = (h3 ^ h1) >>> 0;
  let d = (h4 ^ h1) >>> 0;
  const next = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const r = (a + b + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + r) | 0;
    return r >>> 0;
  };
  let rnd = '';
  for (let i = 0; i < 16; i++) rnd += ALPHABET[next() % 32];
  return time + rnd;
}
