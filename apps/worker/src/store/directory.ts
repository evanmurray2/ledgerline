// The one Durable Object for users, passkeys, sessions, invites, Plaid slots and routing (docs/multi-user.md 5.2).
// Phase 1: the class exists, migrates itself at start and answers health(); nothing routes to it yet.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { SqlD1 } from './adapter.js';
import { migrate } from './migrate.js';
import { DIRECTORY_MIGRATIONS } from './migrations.gen.js';
import { storeHealth, type StoreHealth } from './budget-store.js';

/** The Directory is a single object; this is its name. */
export const DIRECTORY_NAME = 'directory';

export class Directory extends DurableObject<Env> {
  protected readonly db: SqlD1;
  private startError: string | null = null;

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
}
