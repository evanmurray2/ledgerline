// The one data-access layer every request goes through (design: Input and queries). A Scoped handle exists only
// after the caller's membership in the budget was checked, and every statement it prepares must bind the budget
// id as ?1, so a query can't skip the scope.
export class Scoped {
  constructor(
    readonly db: D1Database,
    readonly budgetId: string,
    readonly userId: string,
  ) {}

  /** Prepares `sql` with ?1 = the budget id; the rest of `params` bind as ?2, ?3, … */
  q(sql: string, ...params: unknown[]): D1PreparedStatement {
    if (!/\?1\b/.test(sql)) throw new Error('scoped query must bind the budget id as ?1');
    return this.db.prepare(sql).bind(this.budgetId, ...params);
  }

  async all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    return (await this.q(sql, ...params).all<T>()).results;
  }

  async first<T>(sql: string, ...params: unknown[]): Promise<T | null> {
    return this.q(sql, ...params).first<T>();
  }

  async run(sql: string, ...params: unknown[]): Promise<D1Result> {
    return this.q(sql, ...params).run();
  }

  batch(stmts: D1PreparedStatement[]): Promise<D1Result[]> {
    return this.db.batch(stmts);
  }

  audit(
    action: string,
    entity: string,
    entityId: string | null,
    before: unknown,
    after: unknown,
    now: number,
  ): D1PreparedStatement {
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

/** Membership check: returns the user's budget, bootstrapping the owner on first sign-in (single user at launch). */
export async function resolveMembership(
  db: D1Database,
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
      .prepare(`INSERT INTO user (id, email, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)`)
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
