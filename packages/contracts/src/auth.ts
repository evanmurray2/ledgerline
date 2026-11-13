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
