// Requests signed with the budget's key, as the app sends them (src/http/signed-request.ts): a challenge from the
// Directory, the signature over the body in the engine, and both in two headers. For tests over the real Worker.
import { SIGNED_CHALLENGE_HEADER, SIGNED_SIGNATURE_HEADER } from '@ledgerline/contracts';
import {
  type Action,
  type BudgetKeys,
  encodeEntry,
  fromHex,
  signRequest,
  toHex,
  utf8,
} from '@ledgerline/seal';
import { SELF } from 'cloudflare:test';
import { expect } from 'vitest';
import type { Db } from '@ledgerline/db/sql';
import { logGenesis } from '../src/seal/log-store.js';
import { Writer } from './log-writer.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };

/** A challenge for one request, from the Directory. */
export async function askChallenge(action: string): Promise<{ challenge: string; token: string }> {
  const r = await SELF.fetch(`${ORIGIN}/api/settings/security/request-challenge`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ action }),
  });
  expect(r.status).toBe(200);
  return (await r.json()) as { challenge: string; token: string };
}

/** The headers of a signed request over `body`. */
export async function signedHeaders(
  keys: BudgetKeys,
  budgetId: string,
  action: Action,
  body: string,
  ch?: { challenge: string; token: string },
): Promise<Record<string, string>> {
  const c = ch ?? (await askChallenge(action));
  const sig = await signRequest(keys, budgetId, action, fromHex(c.challenge), utf8(body));
  return { [SIGNED_CHALLENGE_HEADER]: c.token, [SIGNED_SIGNATURE_HEADER]: toHex(sig) };
}

/** A POST with JSON `body`, signed with `keys` unless they are null. */
export async function signedPost(
  path: string,
  body: string,
  sign: { keys: BudgetKeys; budgetId: string; action: Action } | null,
  extra: Record<string, string> = {},
): Promise<Response> {
  const headers = sign ? await signedHeaders(sign.keys, sign.budgetId, sign.action, body) : {};
  return SELF.fetch(`${ORIGIN}${path}`, { method: 'POST', headers: { ...H, ...headers, ...extra }, body });
}

/** Gives a store a sealed log: its first entry, written by a device whose keys the test then holds. */
export async function genesisIn(db: Db, budgetId: string, now: number): Promise<Writer> {
  const w = new Writer(budgetId, now - 60_000);
  const r = await logGenesis(
    {
      db,
      budgetId,
      now,
      resting: false,
      freshWay: false,
      lastCompleteRun: 0,
      receiptHashes: async () => null,
    },
    encodeEntry(await w.genesis()),
  );
  expect(r).toMatchObject({ ok: true, number: 1 });
  return w;
}
