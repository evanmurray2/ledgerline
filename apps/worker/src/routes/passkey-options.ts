// What every passkey ceremony is built from: the relying party, and the options for making a passkey (sign-up,
// adding one, and the passkey a recovery-key sign-in makes).
import { generateRegistrationOptions } from '@simplewebauthn/server';
import type { Env } from '../env.js';

export const RP_NAME = 'Ledgerline';
/**
 * Each user has their own WebAuthn user handle (docs/multi-user.md 7.2), so two accounts' passkeys on one device
 * never replace each other. The first user keeps the handle every passkey used before multi-user.
 */
export const OWNER_HANDLE = 'ledgerline-owner';

/** The relying party of a request: `RP_ID` when set, else the request's host. */
export function rp(url: string, env: Pick<Env, 'RP_ID'>): { rpID: string; origin: string } {
  const u = new URL(url);
  return { rpID: env.RP_ID ?? u.hostname, origin: u.origin };
}

/** The options for a new passkey. `existing` are the user's passkeys, which the device is not to make again. */
export function registrationOptions(o: {
  url: string;
  env: Pick<Env, 'RP_ID'>;
  handle: string;
  label: string;
  existing?: { id: string; transports: string | null }[];
}) {
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp(o.url, o.env).rpID,
    userID: Uint8Array.from(new TextEncoder().encode(o.handle)),
    userName: o.label,
    userDisplayName: o.label,
    attestationType: 'none',
    ...(o.existing
      ? {
          excludeCredentials: o.existing.map((p) => ({
            id: p.id,
            ...(p.transports ? { transports: JSON.parse(p.transports) as string[] } : {}),
          })),
        }
      : {}),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    // PRF unlocks the encrypted copy on the phone (D-45). iCloud Keychain passkeys support it anyway; security keys
    // only when asked for it at creation.
    extensions: { prf: {} },
  });
}
