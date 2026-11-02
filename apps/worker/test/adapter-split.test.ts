// The Durable Object adapter runs migrations statement by statement (docs/multi-user.md 5.5, 5.7). Every real
// migration must split into statements that each parse, with trigger bodies kept whole.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { splitStatements } from '../src/store/adapter.js';

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

  it('splits every real migration into statements D1 accepts one by one', async () => {
    const migs = (env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] })
      .TEST_MIGRATIONS;
    expect(migs.length).toBeGreaterThan(0);
    for (const m of migs) {
      const sql = m.queries.join(';\n');
      const parts = splitStatements(sql);
      expect(parts.length, m.name).toBeGreaterThanOrEqual(m.queries.length);
      for (const p of parts) expect(p.trim().endsWith(';'), `${m.name}: ${p.slice(0, 60)}`).toBe(false);
    }
  });
});
