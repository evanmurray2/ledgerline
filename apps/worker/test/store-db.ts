// A D1Database-shaped handle on one Durable Object's SQLite, for tests. Production code reaches a store's database
// through SqlD1 inside the object; a test can't hold that storage across calls (workerd ties it to the object's I/O
// context), so every call here runs inside the object with runInDurableObject and its own SqlD1. The SQL, the
// schema (the store's own migrations) and the engine are production's.
import { env, runInDurableObject } from 'cloudflare:test';
import { SqlD1 } from '../src/store/adapter.js';
import type { BudgetStore } from '../src/store/budget-store.js';
import { DIRECTORY_NAME, type Directory } from '../src/store/directory.js';

type Stub = DurableObjectStub<BudgetStore> | DurableObjectStub<Directory>;

const e = env as unknown as {
  BUDGET: DurableObjectNamespace<BudgetStore>;
  DIRECTORY: DurableObjectNamespace<Directory>;
};

class TestStatement {
  constructor(
    private readonly db: TestDb,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): TestStatement {
    return new TestStatement(this.db, this.sql, values);
  }

  /** The same statement on a SqlD1 inside the object. */
  real(d: SqlD1) {
    const s = d.prepare(this.sql);
    return this.params.length ? s.bind(...this.params) : s;
  }

  first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    return this.db.inside((d) => this.real(d).first<T>(col));
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.db.inside((d) => this.real(d).all<T>());
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.db.inside((d) => this.real(d).run<T>());
  }

  raw<T = unknown[]>(opts?: { columnNames?: boolean }): Promise<T[]> {
    return this.db.inside((d) => this.real(d).raw<T>(opts));
  }
}

class TestDb {
  constructor(readonly stub: () => Stub | Promise<Stub>) {}

  async inside<T>(fn: (d: SqlD1) => Promise<T>): Promise<T> {
    return runInDurableObject((await this.stub()) as DurableObjectStub<BudgetStore>, (_o, state) =>
      fn(new SqlD1(state.storage)),
    );
  }

  prepare(sql: string): TestStatement {
    return new TestStatement(this, sql);
  }

  batch<T = Record<string, unknown>>(stmts: TestStatement[]): Promise<D1Result<T>[]> {
    return this.inside((d) => d.batch<T>(stmts.map((s) => s.real(d))));
  }

  exec(sql: string): Promise<{ count: number; duration: number }> {
    return this.inside((d) => d.exec(sql));
  }
}

export const budgetStub = (name: string): DurableObjectStub<BudgetStore> =>
  e.BUDGET.get(e.BUDGET.idFromName(name));

export const directoryStub = (): DurableObjectStub<Directory> =>
  e.DIRECTORY.get(e.DIRECTORY.idFromName(DIRECTORY_NAME));

/** The database of the BudgetStore named `name` (production names a store by its budget id). */
export const storeDb = (name: string): D1Database =>
  new TestDb(() => budgetStub(name)) as unknown as D1Database;

/** The Directory's database (users, passkeys, sessions, routes). */
export const directoryDb = (): D1Database => new TestDb(directoryStub) as unknown as D1Database;

/** The first budget's database: the dev user's (DEV_AUTH_EMAIL), or the owner's after setup. */
export const ownerDb = (): D1Database =>
  new TestDb(async () => {
    const id = await directoryStub().firstBudget();
    if (!id) throw new Error('no budget yet: sign in or seed first');
    return budgetStub(id);
  }) as unknown as D1Database;
