// Sign-in contracts (decisions.md D-27): the sign-in state, Settings → Security and a device link. Split from
// index.ts, which re-exports them.
import { z } from 'zod';

export const AuthStatus = z.object({
  signedIn: z.boolean(),
  hasPasskey: z.boolean(),
  /** No passkey yet and a setup code is configured: show first-time setup. */
  setupOpen: z.boolean(),
  /** Open sign-up is on (D-75); the robot check's own address (docs/privacy.md 5.6), where Create account goes. */
  signupOpen: z.boolean().optional(),
  checkUrl: z.string().optional(),
});
export type AuthStatus = z.infer<typeof AuthStatus>;

export const SecurityView = z.object({
  /** This user can delete their own account (users who aren't admins, D-75). */
  ownAccount: z.boolean().optional(),
  /** Show Settings → Users (admins, once there is anyone else or sign-up is on). */
  usersScreen: z.boolean().optional(),
  passkeys: z.array(
    z.object({ id: z.string(), name: z.string(), createdAt: z.string(), lastUsedAt: z.string().nullable() }),
  ),
  /** Signed-in sessions on all devices. */
  sessions: z.number().int(),
  /**
   * Other devices "Sign out other devices" would sign out: the other sign-ins, and phones or computers that are
   * signed out but still have the budget saved on them (not listed in `signIns`; signing out others deletes it).
   */
  otherSessions: z.number().int().default(0),
  /**
   * Where you're signed in, newest first: each sign-in, named by device and browser ("iPhone · Safari"). Signing
   * one out ends its sign-in and turns off the budget saved on it (D-45), so the device deletes it.
   */
  signIns: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        signedInAt: z.string(),
        current: z.boolean(),
        /** The budget is saved on it. */
        saved: z.boolean().default(false),
      }),
    )
    .default([]),
});
export type SecurityView = z.infer<typeof SecurityView>;

export const DeviceLink = z.object({ url: z.string(), expiresAt: z.string() });
export type DeviceLink = z.infer<typeof DeviceLink>;

/**
 * The options of a passkey ceremony, as the Worker's WebAuthn library makes them (WebAuthn JSON). The app passes
 * them to the browser as they are: these are loose objects, so a field not named here is kept, not dropped.
 * Registration: register/options, signup/options and recover-key/verify.
 */
export const PasskeyCreateOptions = z.looseObject({
  challenge: z.string(),
  rp: z.looseObject({ name: z.string(), id: z.string().optional() }),
  user: z.looseObject({ id: z.string(), name: z.string(), displayName: z.string() }),
  pubKeyCredParams: z.array(z.looseObject({ type: z.literal('public-key'), alg: z.number() })),
});
export type PasskeyCreateOptions = z.infer<typeof PasskeyCreateOptions>;
/** The options of a passkey sign-in (login/options): discoverable credentials, so no list of passkeys. */
export const PasskeyGetOptions = z.looseObject({ challenge: z.string(), rpId: z.string().optional() });
export type PasskeyGetOptions = z.infer<typeof PasskeyGetOptions>;

/** The recovery key's sign-in (docs/privacy-keys.md 4.2): the budget it opens and the challenge it signs (hex). */
export const RecoverKeyOptions = z.object({ budgetId: z.string(), challenge: z.string() });
/** Whether the budget has a recovery key, and since when. */
export const RecoveryKeyState = z.object({ set: z.boolean(), setAt: z.string().nullable() });

/** Settings → Users, for admins (D-75): the counts, and one page of people. */
export const UsersView = z.object({
  users: z.number().int(),
  maxUsers: z.number().int(),
  signupsToday: z.number().int(),
  signupsPerDay: z.number().int(),
  signupsOpen: z.boolean(),
  list: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      admin: z.boolean(),
      status: z.string(),
      joinedAt: z.string(),
      lastSeenAt: z.string().nullable(),
      stuck: z.boolean(),
    }),
  ),
  next: z.string().nullable(),
});
export type UsersView = z.infer<typeof UsersView>;

const hexOrNull = z.string().nullable().optional();
/**
 * Adding a device with its own passkey to a locked budget (docs/privacy-keys.md section 10): this session's part in
 * the server's relay, and the steps sent so far (hex).
 */
export const DeviceAddState = z.object({
  role: z.enum(['from', 'to', 'waiting']).nullable(),
  expiresAt: z.string().optional(),
  offers: z.number().optional(),
  commit: hexOrNull,
  reveal: hexOrNull,
  confirm: hexOrNull,
  offer: hexOrNull,
  sealed: hexOrNull,
});
export type DeviceAddState = z.infer<typeof DeviceAddState>;
export const DeviceAddStart = z.object({ expiresAt: z.string() });
