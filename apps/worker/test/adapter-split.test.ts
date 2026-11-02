// The Durable Object adapter runs migrations statement by statement (docs/multi-user.md 5.5, 5.7). Every real
// migration must split into statements that each parse, with trigger bodies kept whole.
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { splitStatements } from '../src/store/adapter.js';
import { BUDGET_MIGRATIONS, DIRECTORY_MIGRATIONS } from '../src/store/migrations.gen.js';
import { budgetStub } from './store-db.js';

describe('splitStatements', () => {
  it('keeps trigger bodies, quotes and comments intact', () => {
    const parts = splitStatements(`
      -- a comment; with a semicolon
      CREATE TABLE t (a TEXT DEFAULT 'x;y');
      CREATE TRIGGER t_no_delete BEFORE DELETE ON t
      BEGIN SELECT RAISE(ABORT, 't is append-only; really'); END;
      /* block; comment */ INSERT INTO t (a) VALUES ('it''s; fine');
    `);
    expect(parts).toHaveLength(3);
    expect(parts[1]).toMatch(/^CREATE TRIGGER[\s\S]*END$/);
    expect(parts[2]).toContain("'it''s; fine'");
  });

  it('splits every store migration into statements that each run on their own', async () => {
    for (const [kind, migs] of [
      ['budget', BUDGET_MIGRATIONS],
      ['directory', DIRECTORY_MIGRATIONS],
    ] as const) {
      expect(migs.length).toBeGreaterThan(0);
      // A fresh object whose own start-up migrations are undone first, so each statement runs exactly once here.
      const stub = budgetStub(`split-${kind}`);
      await runInDurableObject(stub, async (_o, st) => {
        const names = st.storage.sql
          .exec(
            `SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\'`,
          )
          .toArray();
        for (const v of names.filter((n) => n.type === 'view'))
          st.storage.sql.exec(`DROP VIEW "${String(v.name)}"`);
        for (const t of names.filter((n) => n.type === 'table'))
          st.storage.sql.exec(`DROP TABLE IF EXISTS "${String(t.name)}"`);
        for (const m of migs)
          for (const part of splitStatements(m.sql)) {
            expect(part.trim().endsWith(';'), `${m.name}: ${part.slice(0, 60)}`).toBe(false);
            st.storage.sql.exec(part);
          }
      });
    }
  });
});
