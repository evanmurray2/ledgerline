// The rows a new bank link writes in the budget: the connection, the bank's accounts as it describes them, and their
// setup (budget accounts, card payment categories, starting balances). Before a budget was sealed the server wrote
// them when it exchanged the link (connections.ts). For a sealed budget a device writes them when it files the link's
// first run, which holds what the bank said about the link (docs/privacy.md 5.5; local/sealed-filing.ts). Both use
// these statements, so a device writes the rows the server wrote.
import type { ProviderAccount } from '@ledgerline/bank-provider';
import type { Stmt } from '@ledgerline/db/sql';
import { localDate } from '@ledgerline/domain';
import type { Scoped } from '../../db/scoped.js';

/** A new link as the budget keeps it. A device's copy never holds the token or the Item. */
export interface NewConnection {
  id: string;
  institution: string;
  itemId: string | null;
  tokenEnc: string | null;
  keyVersion: number | null;
  linkedAt: number;
}

/** The new connection, with its accounts not set up yet (`setup_done = 0`). */
export function connectionStmts(s: Scoped, c: NewConnection): Stmt[] {
  return [
    s.q(
      `INSERT INTO connection (id, budget_id, provider, provider_item_id, institution_name, access_token_enc, key_version, days_requested, setup_done, linked_at, created_at, updated_at)
       VALUES (?2, ?1, 'plaid', ?3, ?4, ?5, ?6, 180, 0, ?7, ?7, ?7)`,
      c.id,
      c.itemId,
      c.institution,
      c.tokenEnc,
      c.keyVersion,
      c.linkedAt,
    ),
    s.audit('connection.link', 'connection', c.id, null, { institution: c.institution }, c.linkedAt),
  ];
}

/** The bank's accounts of a link, as the bank describes them. `id` names each new row. */
export function providerAccountStmts(
  s: Scoped,
  connectionId: string,
  accts: readonly ProviderAccount[],
  now: number,
  id: () => string,
): Stmt[] {
  return accts.map((a) =>
    s.q(
      `INSERT INTO provider_account (id, budget_id, connection_id, provider_account_id, name, official_name, type, subtype, mask, current_balance, available_balance, credit_limit, iso_currency, balance_as_of, created_at, updated_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14, ?14)`,
      id(),
      connectionId,
      a.providerAccountId,
      a.name,
      a.officialName,
      a.type,
      a.subtype,
      a.mask,
      a.currentBalance,
      a.availableBalance,
      a.creditLimit,
      a.isoCurrency,
      now,
    ),
  );
}

/** Maps a provider account to a budget account kind; investment and loan accounts are not linked in v1. */
export function accountKind(type: string, subtype: string | null): 'checking' | 'savings' | 'credit' | null {
  if (type === 'credit') return 'credit';
  if (type === 'depository')
    return subtype === 'savings' || subtype === 'money market' || subtype === 'cd' || subtype === 'hsa'
      ? 'savings'
      : 'checking';
  return null;
}

export type SetupAccount = Pick<
  ProviderAccount,
  'providerAccountId' | 'name' | 'type' | 'subtype' | 'currentBalance'
>;
export interface SetUpAccount {
  id: string;
  name: string;
  kind: string;
  startingBalance: number;
}

/**
 * Setup of a link's accounts: a budget account for each checking, savings and card account, a card payment
 * category for each card, and the starting balances, then `setup_done = 1`. A guard makes the statements do nothing
 * when setup is already done. `id` names each new account.
 */
export async function setupStmts(
  s: Scoped,
  connectionId: string,
  accts: readonly SetupAccount[],
  now: number,
  id: () => string,
): Promise<{ stmts: Stmt[]; accounts: SetUpAccount[] }> {
  const b = await s.first<{ budget_start_month: string | null; time_zone: string }>(
    `SELECT budget_start_month, time_zone FROM budget WHERE id = ?1`,
  );
  const today = localDate(now, b?.time_zone ?? 'America/Los_Angeles');
  const startDate = b?.budget_start_month ? `${b.budget_start_month}-01` : today;
  // Each account budgets from the later of the budget start and the date it was linked (Budget start).
  const budgetFrom = today > startDate ? today : startDate;
  // The guard makes the whole batch a no-op if another attempt already finished setup.
  const w: Stmt[] = [
    s.q(
      `INSERT OR REPLACE INTO lease_guard (id, ok) VALUES (3, (SELECT setup_done = 0 FROM connection WHERE id = ?2 AND budget_id = ?1))`,
      connectionId,
    ),
  ];
  const out: SetUpAccount[] = [];
  for (const a of accts) {
    const kind = accountKind(a.type, a.subtype);
    if (!kind) continue;
    const accountId = `acc_${id()}`;
    // Starting balance = current balance at link, treated as excluding pending; you confirm or correct it.
    const startingBalance = kind === 'credit' ? -(a.currentBalance ?? 0) : (a.currentBalance ?? 0);
    w.push(
      s.q(
        `INSERT INTO account (id, budget_id, provider_account_id, name, role, kind, budget_from, starting_balance, opening_anchor, created_at, updated_at)
         VALUES (?2, ?1, ?3, ?4, 'budget', ?5, ?6, ?7, ?7, ?8, ?8)`,
        accountId,
        a.providerAccountId,
        a.name,
        kind,
        budgetFrom,
        startingBalance,
        now,
      ),
    );
    if (kind === 'credit') {
      // The only categories the app makes: one card payment category per card.
      w.push(
        s.q(
          `INSERT INTO category (id, budget_id, name, kind, card_account_id, created_at, updated_at) VALUES (?2, ?1, ?3, 'cc_payment', ?4, ?5, ?5)`,
          `pay_${accountId}`,
          a.name,
          accountId,
          now,
        ),
      );
    }
    out.push({ id: accountId, name: a.name, kind, startingBalance });
  }
  w.push(
    s.q(
      `UPDATE connection SET setup_done = 1, updated_at = ?3 WHERE budget_id = ?1 AND id = ?2`,
      connectionId,
      now,
    ),
    s.audit('connection.setup', 'connection', connectionId, null, { accounts: out.length }, now),
  );
  return { stmts: w, accounts: out };
}

/**
 * A link's bank accounts and their setup, in one batch that does nothing when setup is already done (the guard
 * comes first). `now` is when the link was made; `id` names each new row.
 */
export async function linkedAccountStmts(
  s: Scoped,
  connectionId: string,
  accts: readonly ProviderAccount[],
  now: number,
  id: () => string,
): Promise<{ stmts: Stmt[]; accounts: SetUpAccount[] }> {
  const provider = providerAccountStmts(s, connectionId, accts, now, id);
  const setup = await setupStmts(s, connectionId, accts, now, id);
  const [guard, ...rest] = setup.stmts;
  return { stmts: [guard!, ...provider, ...rest], accounts: setup.accounts };
}
