// The Worker's public run-signing keys (GET /api/run-keys): the public half of the key each sealed bank run is
// signed with, for the app to be built with. No sign-in is needed, and no secret is given.
import { parseKeyring, tokenKeyBytes } from '@ledgerline/platform';
import { serverKeys, toHex } from '@ledgerline/seal';
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const e = env as unknown as { TOKEN_KEYS: string; TOKEN_KEY_CURRENT: string };

describe('the public run-signing keys', () => {
  it('gives the public half for each key number, to anyone, and nothing else', async () => {
    const r = await SELF.fetch('https://ledgerline.test/api/run-keys');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { current: number; keys: { n: number; pub: string }[] };
    const ring = parseKeyring(e.TOKEN_KEYS, e.TOKEN_KEY_CURRENT);
    expect(body.current).toBe(ring.current);
    expect(body.keys.map((k) => k.n).sort()).toEqual(Object.keys(ring.keys).map(Number).sort());
    for (const k of body.keys) {
      const mine = await serverKeys(await tokenKeyBytes(ring.keys[k.n]!), k.n);
      expect(k.pub).toBe(toHex((mine.runSign as { pub: Uint8Array }).pub));
      expect(k.pub).toMatch(/^[0-9a-f]{64}$/);
    }
    // The answer holds the numbers and the public halves only.
    expect(Object.keys(body).sort()).toEqual(['current', 'keys']);
    const text = JSON.stringify(body);
    for (const secret of Object.values(ring.keys)) expect(text).not.toContain(secret);
  });
});
