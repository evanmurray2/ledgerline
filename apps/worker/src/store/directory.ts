// The one Durable Object for users, passkeys, sessions, invites, Plaid slots and routing (docs/multi-user.md 5.2).
// After the move it serves sign-in (/api/auth/*) and Settings → Sign-in (/api/settings/security/*) with the same
// routes the D1 path uses, and answers authenticate() for every other request so the Worker knows whose budget
// to open.
import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { AppEnv } from '../http/context.js';
import { SqlD1 } from './adapter.js';
import { migrate } from './migrate.js';
import { DIRECTORY_MIGRATIONS } from './migrations.gen.js';
import { storeHealth, type StoreHealth } from './budget-store.js';
import { authRoutes } from '../routes/auth.js';
import { securityRoutes } from '../routes/security.js';
import { identity } from '../routes/api.js';
import { csrf } from '../http/security.js';
import { REAUTH_MS, identify, needsRecentPasskey } from '../http/auth.js';
import { membership } from '../db/scoped.js';
import { clock } from '../http/clock.js';
import { noteUsage, usageToday } from '../sync/breaker.js';

/** The Directory is a single object; this is its name. */
export const DIRECTORY_NAME = 'directory';

/** Who is asking, as the Worker hands it to a budget's store. */
export interface Caller {
  userId: string;
  budgetId: string;
  email: string;
  sessionId: string;
  verifiedAt: number;
}

export type AuthResult =
  { ok: true; caller: Caller } | { ok: false; status: 401 | 403; body: { error: string; message: string } };

export class Directory extends DurableObject<Env> {
  protected readonly db: SqlD1;
  private startError: string | null = null;
  private app: Hono<AppEnv> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new SqlD1(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => {
      try {
        migrate(ctx.storage, DIRECTORY_MIGRATIONS, Date.now());
      } catch (e) {
        this.startError = e instanceof Error ? e.message : String(e);
      }
    });
  }

  async health(): Promise<StoreHealth> {
    return storeHealth(this.ctx.storage, 'directory', this.startError);
  }

  /** Sign-in and Settings → Sign-in, with the D1 path's own routes on the Directory's database. */
  override async fetch(request: Request): Promise<Response> {
    this.ready();
    if (!this.app) {
      const app = new Hono<AppEnv>();
      app.route('/api/auth', authRoutes);
      app.use('/api/settings/security/*', identity);
      app.use('/api/settings/security/*', csrf);
      app.use('/api/settings/security', identity);
      app.route('/api', securityRoutes);
      this.app = app;
    }
    return this.app.fetch(request, this.appEnv(), {
      waitUntil: (p: Promise<unknown>) => this.ctx.waitUntil(p),
      passThroughOnException() {},
    } as never);
  }

  /** For every other API request: the signed-in user's budget, or why not (same answers as the D1 path). */
  async authenticate(cookie: string | null, method: string, path: string): Promise<AuthResult> {
    this.ready();
    const env = this.appEnv();
    const now = clock(env);
    const req = new Request('https://directory.internal/', { headers: cookie ? { cookie } : {} });
    const who = await identify(req, env, now);
    if (!who || who.kind !== 'user')
      return {
        ok: false,
        status: 401,
        body: { error: 'unauthenticated', message: 'Sign in with your passkey' },
      };
    if (needsRecentPasskey(method, path) && now - who.verifiedAt > REAUTH_MS)
      return {
        ok: false,
        status: 401,
        body: { error: 'reauth', message: 'Confirm it’s you with your passkey' },
      };
    const m = await membership(env.DB, who.userId);
    if (!m)
      return { ok: false, status: 403, body: { error: 'forbidden', message: 'Not a member of this budget' } };
    return {
      ok: true,
      caller: {
        userId: m.userId,
        budgetId: m.budgetId,
        email: m.email,
        sessionId: who.sessionId ?? '',
        verifiedAt: who.verifiedAt,
      },
    };
  }

  /** The budget the ops token's health check reports on: the first one (the owner's). */
  async firstBudget(): Promise<string | null> {
    const r = this.ctx.storage.sql.exec(`SELECT id FROM budget ORDER BY created_at, id LIMIT 1`).toArray()[0];
    return r ? String(r.id) : null;
  }

  /** Today's account usage, for the write breaker in every store (docs/multi-user.md 9.2). */
  async usageToday(): Promise<{ written: number; read: number }> {
    const u = await usageToday(this.appEnv());
    return { written: u.written, read: u.read };
  }

  /** Adds a store's own row counts to today's account usage (between analytics refreshes). */
  async noteUsage(written: number, read: number): Promise<void> {
    await noteUsage(this.db as unknown as D1Database, written, read).run();
  }

  /** Which budget owns a Plaid Item (webhooks, 6.4). */
  async routeFor(itemId: string): Promise<string | null> {
    const r = this.ctx.storage.sql
      .exec(`SELECT budget_id FROM connection_route WHERE provider_item_id = ?`, itemId)
      .toArray()[0];
    return r ? String(r.budget_id) : null;
  }

  private ready(): void {
    if (this.startError) throw new Error(`directory_unavailable: ${this.startError}`);
  }

  private appEnv(): Env {
    return { ...this.env, DB: this.db as unknown as D1Database };
  }
}
