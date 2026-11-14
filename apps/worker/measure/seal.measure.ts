// Phase 0 of docs/privacy.md: what the fetch step would add for each bank page once pages are sealed (5.5), and what
// the server's checks on a sealed log entry cost (5.3). This measures WebCrypto calls of the kind the design names; it
// is not the sealing code itself, which doesn't exist yet. Node's WebCrypto here, workerd's on Cloudflare: both are
// native code, so these are a guide, and the real steps are measured again on Cloudflare before the cutover.
// Writes .measure/seal.json for docs/measurements.md.
import { writeFileSync, mkdirSync } from 'node:fs';
import { test } from 'vitest';
import { generate, syncBody } from '../../../tools/plaid-mock/data.mjs';
import { stats } from './harness.js';

const RUNS = 60;
const enc = new TextEncoder();
const subtle = crypto.subtle;

async function time(fn: () => Promise<unknown>): Promise<ReturnType<typeof stats>> {
  const xs: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    await fn();
    xs.push(performance.now() - t0);
  }
  return stats(xs);
}

/** The page's shape, as the fetch step would check it before the cursor moves: every list present, every row keyed. */
function checkPage(text: string): { added: number; modified: number; removed: number } {
  const p = JSON.parse(text) as {
    added?: { transaction_id?: unknown; account_id?: unknown; amount?: unknown; date?: unknown }[];
    modified?: { transaction_id?: unknown }[];
    removed?: { transaction_id?: unknown }[];
    next_cursor?: unknown;
    has_more?: unknown;
  };
  if (!Array.isArray(p.added) || !Array.isArray(p.modified) || !Array.isArray(p.removed))
    throw new Error('lists');
  if (typeof p.next_cursor !== 'string' || typeof p.has_more !== 'boolean') throw new Error('cursor');
  for (const t of p.added)
    if (
      typeof t.transaction_id !== 'string' ||
      typeof t.account_id !== 'string' ||
      typeof t.amount !== 'number' ||
      typeof t.date !== 'string'
    )
      throw new Error('row');
  for (const t of [...p.modified, ...p.removed])
    if (typeof t.transaction_id !== 'string') throw new Error('row');
  return { added: p.added.length, modified: p.modified.length, removed: p.removed.length };
}

/** Sealing to a public key the way HPKE base mode does: a fresh X25519 pair, a shared secret, HKDF, AES-256-GCM. */
async function sealTo(recipient: CryptoKey, plain: Uint8Array, info: Uint8Array): Promise<Uint8Array> {
  const eph = (await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
  // The cast: Cloudflare's types name this field `$public`; every engine reads `public` (packages/seal curve.ts).
  const x25519 = { name: 'X25519', public: recipient } as Parameters<typeof subtle.deriveBits>[0];
  const shared = await subtle.deriveBits(x25519, eph.privateKey, 256);
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: info }, key, plain));
  const pub = new Uint8Array((await subtle.exportKey('raw', eph.publicKey)) as ArrayBuffer);
  const out = new Uint8Array(pub.length + iv.length + ct.length);
  out.set(pub);
  out.set(iv, pub.length);
  out.set(ct, pub.length + iv.length);
  return out;
}

test('sealing a bank page, and checking a sealed entry', async () => {
  const inbox = (await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
  const signer = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const macKey = await subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const info = enc.encode('ledgerline measure: budget, link, run, page');
  const out: Record<string, unknown> = { runs: RUNS };

  // Production pages hold 100 transactions (D-6); 250 is a page more than twice the owner's largest (about 220 KB).
  for (const count of [100, 250]) {
    const text = syncBody(generate(count, 1), 0, count);
    const bytes = enc.encode(text);
    const sealed = await sealTo(inbox.publicKey, bytes, info);
    out[`page${count}`] = {
      kb: Math.round(bytes.length / 1024),
      checkShape: await time(async () => checkPage(text)),
      seal: await time(() => sealTo(inbox.publicKey, bytes, info)),
      hashSealed: await time(() => subtle.digest('SHA-256', sealed)),
      // One step as the design has it: check the page, seal it, hash the sealed bytes.
      checkSealHash: await time(async () => {
        checkPage(text);
        const s = await sealTo(inbox.publicKey, bytes, info);
        await subtle.digest('SHA-256', s);
      }),
    };
  }

  // The run manifest the Worker signs (about 1 KB), and the HMAC over a bank link row or a public key.
  const manifest = crypto.getRandomValues(new Uint8Array(1024));
  const row = crypto.getRandomValues(new Uint8Array(400));
  out.signManifest = await time(() => subtle.sign('Ed25519', signer.privateKey, manifest));
  out.hmacRow = await time(() => subtle.sign('HMAC', macKey, row));

  // The append path: the device's signature over an entry. The server checks it over the entry's hash and clear fields
  // (about 200 bytes), and hashes the sealed body itself: 4 KB is a usual edit, 64 KB the largest part.
  for (const kb of [4, 64]) {
    const body = crypto.getRandomValues(new Uint8Array(kb * 1024));
    const head = crypto.getRandomValues(new Uint8Array(200));
    const sig = await subtle.sign('Ed25519', signer.privateKey, head);
    out[`append${kb}kb`] = await time(async () => {
      await subtle.digest('SHA-256', body);
      if (!(await subtle.verify('Ed25519', signer.publicKey, sig, head))) throw new Error('signature');
      await subtle.verify('HMAC', macKey, await subtle.sign('HMAC', macKey, row), row);
    });
  }

  mkdirSync('.measure', { recursive: true });
  writeFileSync('.measure/seal.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
});
