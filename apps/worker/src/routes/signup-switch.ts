// The open sign-up switch and its limits (D-75, docs/open-signup.md 2), apart from routes/signup.ts so that routes the
// phone's engine also bundles (routes/security.ts) don't pull in the passkey server library.
import type { Env } from '../env.js';
import { devSignIn } from '../http/auth.js';

/** The switch (docs/open-signup.md 2): sign-up, and recovery codes with it, are open only when all of this holds. */
export function signupSwitchOn(env: Env): boolean {
  return (
    env.SIGNUPS === 'open' &&
    (env.TURNSTILE_SECRET?.length ?? 0) > 0 &&
    (env.TURNSTILE_SITE_KEY?.length ?? 0) > 0 &&
    !devSignIn(env)
  );
}

/** A whole number from a Worker variable, or the default. */
function count(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}
export const maxUsers = (env: Env) => count(env.MAX_USERS, 1);
export const signupsPerDay = (env: Env) => count(env.SIGNUPS_PER_DAY, 50);
