// The one data-access layer every request goes through (design: Input and queries). A Scoped handle exists only
// after the caller's membership in the budget was checked, and every statement it prepares must bind the budget
// id as ?1, so a query can't skip the scope.
import type { Db, Result, Stmt } from '@ledgerline/db/sql';
export class Scoped {
  constructor(
    readonly db: Db,
    readonly budgetId: string,
    readonly userId: string,
  ) {}

  /** Prepares `sql` with ?1 = the budget id; the rest of `params` bind as ?2, ?3, … */
  q(sql: string, ...params: unknown[]): Stmt {
    if (!/\?1\b/.test(sql)) throw new Error('scoped query must bind the budget id as ?1');
    return this.db.prepare(sql).bind(this.budgetId, ...params);
  }

  async all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    return (await this.q(sql, ...params).all<T>()).results;
  }

  async first<T>(sql: string, ...params: unknown[]): Promise<T | null> {
    return this.q(sql, ...params).first<T>();
  }

  async run(sql: string, ...params: unknown[]): Promise<Result> {
    return this.q(sql, ...params).run();
  }

  batch(stmts: Stmt[]): Promise<Result[]> {
    return this.db.batch(stmts);
  }

  audit(
    action: string,
    entity: string,
    entityId: string | null,
    before: unknown,
    after: unknown,
    now: number,
  ): Stmt {
    return this.q(
      `INSERT INTO audit_log (budget_id, user_id, action, entity, entity_id, before, after, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      this.userId,
      action,
      entity,
      entityId,
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after),
      now,
    );
  }
}

/** The signed-in user's budget and email, from their membership (docs/multi-user.md 7.1). */
export async function membership(
  db: Db,
  userId: string,
): Promise<{ userId: string; budgetId: string; email: string } | null> {
  const r = await db
    .prepare(
      `SELECT m.budget_id, u.email FROM budget_member m JOIN user u ON u.id = m.user_id
       WHERE m.user_id = ?1 AND u.status = 'active' ORDER BY m.created_at LIMIT 1`,
    )
    .bind(userId)
    .first<{ budget_id: string; email: string }>();
  return r ? { userId, budgetId: r.budget_id, email: r.email } : null;
}

/** Bootstraps the first user and their budget (setup and local development), or finds them by email. */
export async function resolveMembership(
  db: Db,
  email: string,
  ownerEmail: string | undefined,
  now: number,
  newId: () => string,
): Promise<{ userId: string; budgetId: string } | null> {
  const row = await db
    .prepare(
      `SELECT u.id AS user_id, m.budget_id FROM user u JOIN budget_member m ON m.user_id = u.id WHERE u.email = ?1 ORDER BY m.created_at LIMIT 1`,
    )
    .bind(email)
    .first<{ user_id: string; budget_id: string }>();
  if (row) return { userId: row.user_id, budgetId: row.budget_id };
  if (!ownerEmail || email !== ownerEmail.toLowerCase()) return null;
  const anyUser = await db.prepare(`SELECT count(*) AS n FROM user`).first<{ n: number }>();
  if ((anyUser?.n ?? 0) > 0) return null;
  const userId = newId();
  const budgetId = newId();
  await db.batch([
    db
      // The first user runs the instance and keeps the WebAuthn handle the first passkeys use (multi-user.md 7.1).
      .prepare(
        `INSERT INTO user (id, email, is_admin, link_allowance, webauthn_handle, created_at, updated_at)
         VALUES (?1, ?2, 1, 10, 'ledgerline-owner', ?3, ?3)`,
      )
      .bind(userId, email, now),
    db
      .prepare(`INSERT INTO budget (id, name, created_at, updated_at) VALUES (?1, 'My budget', ?2, ?2)`)
      .bind(budgetId, now),
    db
      .prepare(
        `INSERT INTO budget_member (budget_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, 'owner', ?3, ?3)`,
      )
      .bind(budgetId, userId, now),
  ]);
  return { userId, budgetId };
}
