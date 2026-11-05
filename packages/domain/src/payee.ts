// Payees from Plaid's own values (docs/payee-names.md 4, 5): a bank row's keys and a new payee's name, compared only
// for equality by payeeNameKey. No bank text is cleaned up or compared for likeness anywhere.

/** Payee names compare without case, outer spaces or the curly/straight apostrophe difference. */
export function samePayeeName(a: string, b: string): boolean {
  return payeeNameKey(a) === payeeNameKey(b);
}
export function payeeNameKey(s: string): string {
  return s.trim().replace(/[’‘]/g, "'").toLowerCase();
}

/** What a bank row says about who was paid, as Plaid sent it. */
export interface PayeeSource {
  merchantEntityId: string | null;
  merchantName: string | null;
  plaidName: string | null;
  rawName: string;
}

/** The `n:` key of a name: one space for merchant names, Plaid names and names you chose. */
export function nameKey(name: string): string {
  return `n:${payeeNameKey(name)}`;
}

const present = (s: string | null): s is string => s !== null && s.trim() !== '';

/**
 * A row's payee keys, in the order they decide (docs/payee-names.md 4): Plaid's merchant id, then `merchant_name`,
 * then Plaid's `name`. A row with neither name has one key, its bank text. No repeats.
 */
export function payeeKeys(r: PayeeSource): string[] {
  const keys: string[] = [];
  if (present(r.merchantEntityId)) keys.push(`m:${r.merchantEntityId}`);
  if (present(r.merchantName)) keys.push(nameKey(r.merchantName));
  if (present(r.plaidName)) keys.push(nameKey(r.plaidName));
  if (!present(r.merchantName) && !present(r.plaidName)) keys.push(nameKey(r.rawName));
  return [...new Set(keys)];
}

/** A new payee's name (docs/payee-names.md 5): `merchant_name`, else Plaid's `name`, else the bank text, as sent. */
export function newPayeeName(r: PayeeSource): string {
  if (present(r.merchantName)) return r.merchantName;
  if (present(r.plaidName)) return r.plaidName;
  return r.rawName;
}
