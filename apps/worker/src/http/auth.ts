// Authentication: Cloudflare Access sits in front of the whole hostname, and the Worker independently verifies the
// Access JWT on every API request (design: Security and authentication). Local development may trust a fixed email
// instead, never in production.
import type { Env } from '../env.js';

export interface Identity {
  email: string;
  /** Access service tokens (the GitHub monitor) have a client id instead of an email. */
  serviceClientId: string | null;
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

let certCache: { team: string; keys: Map<string, CryptoKey>; fetchedAt: number } | null = null;
const CERT_TTL_MS = 60 * 60 * 1000;

function b64url(s: string): Uint8Array<ArrayBuffer> {
  const b = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function accessKeys(team: string, now: number, fetcher: typeof fetch): Promise<Map<string, CryptoKey>> {
  if (certCache && certCache.team === team && now - certCache.fetchedAt < CERT_TTL_MS) return certCache.keys;
  const res = await fetcher(`${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`access certs ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const k of body.keys) {
    keys.set(
      k.kid,
      await crypto.subtle.importKey(
        'jwk',
        { kty: k.kty, n: k.n, e: k.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      ),
    );
  }
  certCache = { team, keys, fetchedAt: now };
  return keys;
}

/** Verifies `Cf-Access-Jwt-Assertion`: RS256 signature by the team's keys, issuer, audience and expiry. */
export async function verifyAccessJwt(
  token: string,
  opts: { team: string; aud: string; now?: number; fetcher?: typeof fetch },
): Promise<Identity | null> {
  const now = opts.now ?? Date.now();
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: {
    iss?: string;
    aud?: string | string[];
    exp?: number;
    nbf?: number;
    email?: string;
    common_name?: string;
    type?: string;
  };
  try {
    header = JSON.parse(new TextDecoder().decode(b64url(h)));
    claims = JSON.parse(new TextDecoder().decode(b64url(p)));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;
  let keys: Map<string, CryptoKey>;
  try {
    keys = await accessKeys(opts.team, now, opts.fetcher ?? fetch);
  } catch {
    return null;
  }
  let key = keys.get(header.kid);
  if (!key) {
    // Keys rotate: refetch once.
    certCache = null;
    keys = await accessKeys(opts.team, now, opts.fetcher ?? fetch).catch(() => new Map());
    key = keys.get(header.kid);
    if (!key) return null;
  }
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64url(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) return null;
  if (claims.iss !== opts.team) return null;
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(opts.aud)) return null;
  const sec = now / 1000;
  if (typeof claims.exp !== 'number' || claims.exp < sec) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > sec + 60) return null;
  if (claims.email) return { email: claims.email.toLowerCase(), serviceClientId: null };
  if (claims.common_name) return { email: '', serviceClientId: claims.common_name };
  return null;
}

export async function identify(req: Request, env: Env): Promise<Identity | null> {
  const prod = env.PLAID_ENV === 'production';
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const token = req.headers.get('cf-access-jwt-assertion');
    if (!token) return null;
    return verifyAccessJwt(token, { team: env.ACCESS_TEAM_DOMAIN.replace(/\/$/, ''), aud: env.ACCESS_AUD });
  }
  // No Access configuration: only allowed outside production (local dev, tests).
  if (!prod && env.DEV_AUTH_EMAIL) return { email: env.DEV_AUTH_EMAIL.toLowerCase(), serviceClientId: null };
  return null;
}

export function resetAccessKeyCache(): void {
  certCache = null;
}
