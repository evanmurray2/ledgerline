// What the old routes still answer for a sealed budget (docs/privacy.md 6.2): facts about the account, never
// about the budget. The store mounts this only for a budget marked sealed, and only for an app that says it can
// open one (the `x-ledgerline-sealed` header): an older app is told to update, as before.
import { type SealedSession } from '@ledgerline/contracts';
import { Hono } from 'hono';
import { requestNow } from '../http/clock.js';
import { canLinkBanks, type AppEnv } from '../http/context.js';
import { classifyUsage, dailyLimits, usageToday } from '../sync/breaker.js';

export const sealedApi = new Hono<AppEnv>();

/** Who is signed in, and what the account may do now. The budget's own facts are in the device's copy. */
sealedApi.get('/session', async (c) => {
  const now = requestNow(c);
  const u = await usageToday(c.env, now);
  const ws = classifyUsage(u.written, u.read, u.do, u.workers, dailyLimits(c.env));
  const tomorrow = new Date(now);
  tomorrow.setUTCHours(24, 0, 0, 0);
  const notice = c.get('recoveryNoticeAt');
  const body: SealedSession = {
    sealed: true,
    user: { email: c.get('email') },
    budgetId: c.get('budgetId'),
    appVersion: c.env.APP_VERSION ?? '0.1.0',
    writeState: ws === 'normal' ? 'ok' : ws === 'pause' ? 'paused' : 'readonly',
    readOnlyUntil: ws === 'readonly' || ws === 'rest' ? tomorrow.toISOString() : null,
    readsPaused: ws === 'rest',
    canLinkBanks: canLinkBanks(c),
    recoveryNoticeAt: notice ? new Date(notice).toISOString() : null,
  };
  return c.json(body);
});
