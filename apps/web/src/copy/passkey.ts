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
}

/**
 * Whether the copy is saved on this device: on every device, phone or computer, in a browser or the Home Screen app
 * (D-53; owner). It stays encrypted with the passkey and the server's share either way.
 */
export function keepsCopy(): boolean {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

export function canUsePasskeys(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined';
}

export async function assert(
  options: RequestOptionsJSON,
  prf?: { salt: ArrayBuffer; credentialId?: string | null },
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
      ? { extensions: { prf: { eval: { first: prf.salt } } } as AuthenticationExtensionsClientInputs }
      : {}),
  };
  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw Object.assign(new Error('Cancelled'), { name: 'NotAllowedError' });
  const r = cred.response as AuthenticatorAssertionResponse;
  // A passkey without user verification gives a different PRF output (CTAP hmac-secret), so require the UV flag.
  const flags = new Uint8Array(r.authenticatorData)[32] ?? 0;
  if ((flags & 0x04) === 0)
    throw Object.assign(new Error('Face ID or your passcode is needed'), { name: 'NotAllowedError' });
  const ext = cred.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
  const credentialId = toB64url(cred.rawId);
  return {
    credentialId,
    prf: ext.prf?.results?.first ?? null,
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
