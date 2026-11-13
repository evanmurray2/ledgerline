// A Db-shaped handle on one Durable Object's SQLite, for tests. Production code reaches a store's database
// through DurableDb inside the object; a test can't hold that storage across calls (workerd ties it to the object's I/O
// context), so every call here runs inside the object with runInDurableObject and its own DurableDb. The SQL, the
// schema (the store's own migrations) and the engine are production's.
import { toValue, type Db, type Result, type SqlValue } from '@ledgerline/db/sql';
import { env, runInDurableObject } from 'cloudflare:test';
import { DurableDb } from '../src/store/adapter.js';
import { migrate } from '../src/store/migrate.js';
import { BUDGET_MIGRATIONS } from '../src/store/migrations.gen.js';
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
    readonly params: readonly SqlValue[] = [],
  ) {}

  bind(...values: unknown[]): TestStatement {
    return new TestStatement(this.db, this.sql, values.map(toValue));
  }

  /** The same statement on a DurableDb inside the object. */
  real(d: DurableDb) {
    const s = d.prepare(this.sql);
    return this.params.length ? s.bind(...this.params) : s;
  }

  first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    return this.db.inside((d) => this.real(d).first<T>(col));
  }

  all<T = Record<string, unknown>>(): Promise<Result<T>> {
    return this.db.inside((d) => this.real(d).all<T>());
  }

  run<T = Record<string, unknown>>(): Promise<Result<T>> {
    return this.db.inside((d) => this.real(d).run<T>());
  }
}

class TestDb {
  private ready: Promise<void> | null = null;

  constructor(
    readonly stub: () => Stub | Promise<Stub>,
    /** Run once inside the object before the first statement (a copy's fresh schema). */
    private readonly init?: (storage: DurableObjectStorage) => void,
  ) {}

  async inside<T>(fn: (d: DurableDb) => Promise<T>): Promise<T> {
    if (this.init && !this.ready) {
      const init = this.init;
      this.ready = (async () =>
        runInDurableObject((await this.stub()) as DurableObjectStub<BudgetStore>, (_o, state) =>
          init(state.storage),
        ))();
    }
    await this.ready;
    return runInDurableObject((await this.stub()) as DurableObjectStub<BudgetStore>, (_o, state) =>
      fn(new DurableDb(state.storage)),
    );
  }

  prepare(sql: string): TestStatement {
    return new TestStatement(this, sql);
  }

  batch<T = Record<string, unknown>>(stmts: TestStatement[]): Promise<Result<T>[]> {
    return this.inside((d) => d.batch<T>(stmts.map((s) => s.real(d))));
  }

  exec(sql: string): Promise<void> {
    return this.inside(async (d) => d.exec(sql));
  }
}

export const budgetStub = (name: string): DurableObjectStub<BudgetStore> =>
  e.BUDGET.get(e.BUDGET.idFromName(name));

export const directoryStub = (): DurableObjectStub<Directory> =>
  e.DIRECTORY.get(e.DIRECTORY.idFromName(DIRECTORY_NAME));

/** The database of the BudgetStore named `name` (production names a store by its budget id). */
export const storeDb = (name: string): Db => new TestDb(() => budgetStub(name));

/**
 * Takes a store's own schema out, so its SQLite can stand for a device's copy. A store keeps no budget tables
 * (D-106), and a test's copy needs a SQLite that workerd runs. The store's own migrations stay recorded, and so do
 * the budget migrations named in `keep`, so a store that starts again (workerd may restart an idle object) runs
 * none of them.
 */
function emptySchema(storage: DurableObjectStorage, keep: readonly string[] = []): void {
  const sql = storage.sql;
  storage.transactionSync(() => {
    sql.exec(`PRAGMA defer_foreign_keys = ON`);
    for (const type of ['trigger', 'view', 'table'])
      for (const r of sql
        .exec(
          `SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
             AND name NOT LIKE '\\_%' ESCAPE '\\'`,
          type,
        )
        .toArray())
        sql.exec(`DROP ${type.toUpperCase()} IF EXISTS "${String(r.name)}"`);
    sql.exec(
      `DELETE FROM _migrations WHERE name NOT LIKE 'store/%' AND name NOT IN (SELECT value FROM json_each(?))`,
      JSON.stringify(keep),
    );
  });
}

/**
 * Test files may share Durable Objects: a copy's name is made this file's own, so another file's copy of the same
 * name is never emptied under it.
 */
const FILE = Math.random().toString(36).slice(2);
/** The Durable Object that holds the copy or budget database named `name` (copyDb, budgetDb). */
export const copyStub = (name: string): DurableObjectStub<BudgetStore> => budgetStub(`${name}#${FILE}`);

/**
 * An empty SQLite in a Durable Object, for a device's copy: `migrateLocal` makes its schema, as on a phone. The
 * budget migration a copy skips stays recorded: the store would run it if it started again, and drop the copy's
 * own tables.
 */
export const copyDb = (name: string): Db =>
  new TestDb(
    () => copyStub(name),
    (storage) => emptySchema(storage, ['0006_drop_phone_tables_on_server.sql']),
  );

/**
 * A SQLite with the budget's schema as its migrations leave it (change-log triggers and all), for tests of the
 * filing steps a device runs (they ran on the server before D-102).
 */
export const budgetDb = (name: string): Db =>
  new TestDb(
    () => copyStub(name),
    (storage) => {
      emptySchema(storage);
      migrate(storage, BUDGET_MIGRATIONS, Date.now());
    },
  );

/** The Directory's database (users, passkeys, sessions, routes). */
export const directoryDb = (): Db => new TestDb(directoryStub);

/** The first budget's database: the dev user's (DEV_AUTH_EMAIL), or the owner's after setup. */
export const ownerDb = (): Db =>
  new TestDb(async () => {
    const id = await directoryStub().firstBudget();
    if (!id) throw new Error('no budget yet: sign in or seed first');
    return budgetStub(id);
  });
