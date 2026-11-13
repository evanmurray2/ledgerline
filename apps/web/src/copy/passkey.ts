// WebAuthn sign-in with the PRF extension (docs/phone-budget.md 13.2). @simplewebauthn/browser passes extension
// inputs through as JSON, but PRF salts must be bytes, so this builds the request itself. The PRF output stays on the
// phone: it's removed from the answer before the answer is sent to the server.
import { fromB64url, toB64url } from './vault';

export interface RequestOptionsJSON {
  challenge: string;
  rpId?: string;
  timeout?: number;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: { id: string; type: 'public-key'; transports?: AuthenticatorTransport[] }[];
}

export interface Assertion {
  /** The answer for /api/auth/login/verify, as @simplewebauthn/server expects it (no PRF output). */
  json: Record<string, unknown>;
  credentialId: string;
  /** The PRF output, when the passkey gave one. */
  prf: ArrayBuffer | null;
  /**
   * The PRF output for the budget's way in (docs/privacy-keys.md 4.1), when it was asked for and the passkey gave
   * one. Like `prf`, it never leaves the device.
   */
  slotPrf: ArrayBuffer | null;
}

/**
 * Whether the copy is saved on this device: on every device, phone or computer, in a browser or the Home Screen app
 * (D-53; owner). It stays encrypted with the passkey and the server's share either way.
 */
export function keepsCopy(): boolean {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

/** The name of the error a passkey without user verification gives (not NotAllowedError, which reads as Cancelled). */
export const UV_REQUIRED = 'UserVerificationRequired';

/**
 * The sentence for a passkey's own error (the browser's or `assert`'s), or null when it isn't one. Every screen that
 * runs a passkey reads its errors here, so "Use your passkey to continue." shows and isn't read as Cancelled.
 */
export function passkeyProblem(e: unknown): string | null {
  const name = (e as { name?: string } | null)?.name;
  if (name === UV_REQUIRED) return 'Use your passkey to continue.';
  if (name === 'NotAllowedError' || name === 'AbortError') return 'Cancelled. Try again when you’re ready.';
  if (name === 'InvalidStateError') return 'This device already has a Ledgerline passkey.';
  return null;
}

export function canUsePasskeys(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined';
}

export async function assert(
  options: RequestOptionsJSON,
  prf?: {
    salt: ArrayBuffer;
    credentialId?: string | null;
    /**
     * The one PRF input of the budget's ways in (`slotPrfInput()` in keys/budget.ts). With it, the passkey is
     * asked for two outputs in one prompt: this one first, the copy's own salt second (4.1). An output depends
     * only on the passkey and its own input, so the copy's key is the same whichever place its salt is asked in.
     */
    slot?: ArrayBuffer;
  },
): Promise<Assertion> {
  const allow = prf?.credentialId
    ? [{ id: fromB64url(prf.credentialId), type: 'public-key' as const }]
    : (options.allowCredentials ?? []).map((c) => ({
        id: fromB64url(c.id),
        type: c.type,
        transports: c.transports,
      }));
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: fromB64url(options.challenge),
    ...(options.rpId ? { rpId: options.rpId } : {}),
    ...(options.timeout ? { timeout: options.timeout } : {}),
    userVerification: 'required',
    allowCredentials: allow,
    ...(prf
      ? {
          extensions: {
            prf: { eval: prf.slot ? { first: prf.slot, second: prf.salt } : { first: prf.salt } },
          } as AuthenticationExtensionsClientInputs,
        }
      : {}),
  };
  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw Object.assign(new Error('Cancelled'), { name: 'NotAllowedError' });
  const r = cred.response as AuthenticatorAssertionResponse;
  // A passkey without user verification gives a different PRF output (CTAP hmac-secret), so require the UV flag.
  const flags = new Uint8Array(r.authenticatorData)[32] ?? 0;
  if ((flags & 0x04) === 0)
    // Not NotAllowedError: the screens read that as Cancelled, and this message must show.
    throw Object.assign(new Error('Use your passkey to continue.'), { name: UV_REQUIRED });
  const ext = cred.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer; second?: ArrayBuffer } };
  };
  const out = ext.prf?.results;
  const credentialId = toB64url(cred.rawId);
  return {
    credentialId,
    prf: (prf?.slot ? out?.second : out?.first) ?? null,
    slotPrf: (prf?.slot ? out?.first : undefined) ?? null,
    json: {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
      clientExtensionResults: {},
      response: {
        clientDataJSON: toB64url(r.clientDataJSON),
        authenticatorData: toB64url(r.authenticatorData),
        signature: toB64url(r.signature),
        ...(r.userHandle ? { userHandle: toB64url(r.userHandle) } : {}),
      },
    },
  };
}
