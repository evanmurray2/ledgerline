// One Durable Object per budget, holding all of that budget's data in its own SQLite database
// (docs/multi-user.md 5.3). Phase 1: the class exists, migrates itself at start and answers health(); nothing
// routes to it yet, so the app still runs entirely on D1.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { SqlD1 } from './adapter.js';
import { appliedMigrations, migrate } from './migrate.js';
import { BUDGET_MIGRATIONS } from './migrations.gen.js';

export interface StoreHealth {
  ok: boolean;
  kind: 'budget' | 'directory';
  migrations: string[];
  tables: number;
  error?: string;
}

export class BudgetStore extends DurableObject<Env> {
  protected readonly db: SqlD1;
  private startError: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new SqlD1(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => {
      try {
        migrate(ctx.storage, BUDGET_MIGRATIONS, Date.now());
      } catch (e) {
        // Refuse to serve a half-migrated schema; health() reports why.
        this.startError = e instanceof Error ? e.message : String(e);
      }
    });
  }

  /** Called by the deploy smoke test and the daily check; running it applies pending migrations. */
  async health(): Promise<StoreHealth> {
    return storeHealth(this.ctx.storage, 'budget', this.startError);
  }

  protected ready(): void {
    if (this.startError) throw new Error(`store_unavailable: ${this.startError}`);
  }
}

export function storeHealth(
  storage: DurableObjectStorage,
  kind: StoreHealth['kind'],
  startError: string | null,
): StoreHealth {
  if (startError) return { ok: false, kind, migrations: [], tables: 0, error: startError };
  const tables = Number(
    storage.sql
      .exec(
        `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'`,
      )
      .one().n,
  );
  return { ok: true, kind, migrations: appliedMigrations(storage), tables };
}
