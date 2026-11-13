// What a bank link's first run holds (docs/privacy.md 5.5; docs/privacy-keys.md 9.3, page kind 3): what the bank
// said about the link when it was made. The server seals it and keeps none of it (seal/fetch-job.ts); a device
// writes the link's connection and its bank accounts from it (local/sealed-filing.ts), as the server's own
// exchange wrote them before the budget was sealed (routes/settings/link-rows.ts).
import type { ProviderAccount } from '@ledgerline/bank-provider';

export interface LinkDescription {
  v: 1;
  linkId: string;
  /** When the link was made (`bank_link.linked_at`). */
  linkedAt: number;
  /** The bank's name; null when the bank couldn't say it. */
  institution: string | null;
  accounts: ProviderAccount[];
}

const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const intOrNull = (v: unknown): v is number | null => v === null || Number.isSafeInteger(v);

function isAccount(a: unknown): a is ProviderAccount {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  const x = a as Record<string, unknown>;
  return (
    str(x.providerAccountId) &&
    x.providerAccountId.length > 0 &&
    str(x.name) &&
    strOrNull(x.officialName) &&
    str(x.type) &&
    strOrNull(x.subtype) &&
    strOrNull(x.mask) &&
    intOrNull(x.currentBalance) &&
    intOrNull(x.availableBalance) &&
    intOrNull(x.creditLimit) &&
    strOrNull(x.isoCurrency)
  );
}

/** The description, read strictly; null when the page isn't one this version can read. */
export function readLinkDescription(text: string): LinkDescription | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const d = v as Record<string, unknown>;
  if (d.v !== 1 || !str(d.linkId) || !Number.isSafeInteger(d.linkedAt) || !strOrNull(d.institution))
    return null;
  if (!Array.isArray(d.accounts) || !d.accounts.every(isAccount)) return null;
  const ids = new Set(d.accounts.map((a) => a.providerAccountId));
  if (ids.size !== d.accounts.length) return null;
  return {
    v: 1,
    linkId: d.linkId,
    linkedAt: d.linkedAt as number,
    institution: d.institution,
    accounts: d.accounts.map((a) => ({
      providerAccountId: a.providerAccountId,
      name: a.name,
      officialName: a.officialName,
      type: a.type,
      subtype: a.subtype,
      mask: a.mask,
      currentBalance: a.currentBalance,
      availableBalance: a.availableBalance,
      creditLimit: a.creditLimit,
      isoCurrency: a.isoCurrency,
    })),
  };
}
