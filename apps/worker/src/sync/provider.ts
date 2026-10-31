import { PlaidProvider, type BankDataProvider } from '@ledgerline/bank-provider';
import { decryptToken, parseKeyring } from '@ledgerline/platform';
import type { Env } from '../env.js';

export function makeProvider(env: Env): BankDataProvider & PlaidProvider {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) throw new Error('Plaid keys are not configured');
  const plaidEnv = env.PLAID_ENV === 'production' ? 'production' : 'sandbox';
  if (plaidEnv === 'production' && env.PLAID_BASE_URL)
    throw new Error('PLAID_BASE_URL is not allowed in production');
  return new PlaidProvider({
    clientId: env.PLAID_CLIENT_ID,
    secret: env.PLAID_SECRET,
    env: plaidEnv,
    ...(env.PLAID_BASE_URL ? { baseUrl: env.PLAID_BASE_URL } : {}),
    ...(env.PLAID_WEBHOOK_URL ? { webhookUrl: env.PLAID_WEBHOOK_URL } : {}),
  });
}

/**
 * Transactions per Plaid call. The design started at 500 (falling back to 250); the Phase 1 measurement put the
 * apply step over budget at both, so the default is 100, applied in two 50-event steps (docs/measurements.md).
 */
export function pageSize(env: Env): number {
  const n = Number(env.SYNC_PAGE_SIZE ?? 100);
  return [50, 100, 250, 500].includes(n) ? n : 100;
}

export async function connectionToken(env: Env, connectionId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT access_token_enc, key_version FROM connection WHERE id = ?1`)
    .bind(connectionId)
    .first<{ access_token_enc: string | null; key_version: number | null }>();
  if (!row?.access_token_enc || row.key_version === null) throw new Error('connection has no credential');
  return decryptToken(
    parseKeyring(env.TOKEN_KEYS, env.TOKEN_KEY_CURRENT),
    row.access_token_enc,
    row.key_version,
    connectionId,
  );
}
