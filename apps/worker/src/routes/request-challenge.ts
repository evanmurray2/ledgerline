// The challenge for a request signed with the budget's key (http/signed-request.ts; docs/privacy-keys.md 11).
// A Directory route under /api/settings/security/, so it needs a session; it writes nothing, so it needs no fresh
// passkey check (the request it is for asks for one).
import { Hono } from 'hono';
import type { AppEnv } from '../http/context.js';
import { requestNow } from '../http/clock.js';
import { bodyObject } from '../http/security.js';
import { isAskable, issueChallenge } from '../http/signed-request.js';

export const REQUEST_CHALLENGE_PATH = '/api/settings/security/request-challenge';

export const requestChallengeRoutes = new Hono<AppEnv>();

requestChallengeRoutes.post('/settings/security/request-challenge', async (c) => {
  const b = await bodyObject(c.req);
  if (!isAskable(b.action))
    return c.json({ error: 'invalid', message: 'Something went wrong. Try again.' }, 400);
  return c.json(await issueChallenge(c.env, requestNow(c), c.get('sessionId') ?? '', b.action));
});
