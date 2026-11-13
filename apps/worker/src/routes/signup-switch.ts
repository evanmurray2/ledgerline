// The open sign-up switch and its limits (D-75, docs/open-signup.md 2), apart from routes/signup.ts so that routes the
// phone's engine also bundles (routes/security.ts) don't pull in the passkey server library.
import type { Env } from '../env.js';
import { devSignIn } from '../http/auth.js';

/**
 * The switch (docs/open-signup.md 2): sign-up is open only when all of this holds, the robot check's own address
 * (docs/privacy.md 5.6) included.
 */
export function signupSwitchOn(env: Env): boolean {
  return (
    env.SIGNUPS === 'open' &&
    (env.TURNSTILE_SECRET?.length ?? 0) > 0 &&
    checkHost(env) !== null &&
    !devSignIn(env)
  );
}

/** The robot check's address (CHECK_URL, docs/privacy.md 5.6) as an origin, or null when it isn't one. */
export function checkOrigin(env: Env): string | null {
  try {
    const u = new URL(env.CHECK_URL ?? '');
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** The host name a Turnstile token must come from: the robot check's address. */
export function checkHost(env: Env): string | null {
  const o = checkOrigin(env);
  return o ? new URL(o).hostname : null;
}

/** A whole number from a Worker variable, or the default. */
function count(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}
export const maxUsers = (env: Env) => count(env.MAX_USERS, 1);
export const signupsPerDay = (env: Env) => count(env.SIGNUPS_PER_DAY, 50);
