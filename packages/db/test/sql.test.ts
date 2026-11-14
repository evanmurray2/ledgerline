// sql.ts (binding, writes, batches) through node-db.ts, the node:sqlite database used for measuring.
import { describe, expect, it } from 'vitest';
import { NodeDb, applyMigrations } from '../src/node-db';
import { isWrite, toValue } from '../src/sql';

describe('toValue', () => {
  it('binds what SQLite stores', () => {
    expect(toValue(null)).toBeNull();
    expect(toValue('a')).toBe('a');
    expect(toValue(3)).toBe(3);
    expect(toValue(true)).toBe(1);
    expect(toValue(false)).toBe(0);
    expect(toValue(5n)).toBe(5);
    const view = new DataView(new Uint8Array([1, 2, 3]).buffer, 1, 2);
    expect([...(toValue(view) as Uint8Array)]).toEqual([2, 3]);
  });

  it('refuses undefined and objects', () => {
    expect(() => toValue(undefined)).toThrow(TypeError);
    expect(() => toValue({})).toThrow(TypeError);
  });
});

describe('isWrite', () => {
  it('knows a write, a CTE write and a read', () => {
    expect(isWrite('  insert into t values (1)')).toBe(true);
    expect(isWrite('REPLACE INTO t VALUES (1)')).toBe(true);
    expect(isWrite('WITH x AS (SELECT 1) DELETE FROM t')).toBe(true);
    expect(isWrite('SELECT * FROM t')).toBe(false);
  });
});

function db(): NodeDb {
  const d = new NodeDb();
  applyMigrations(d, [
    { name: '0002_b.sql', sql: `INSERT INTO t (id, n) VALUES ('seed', 0);` },
    { name: '0001_a.sql', sql: `CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL CHECK (n >= 0));` },
  ]);
  return d;
}

describe('NodeDb', () => {
  it('applies migrations in order, and reads and writes with bound values', async () => {
    const d = db();
    expect(await d.prepare(`SELECT n FROM t WHERE id = ?1`).bind('seed').first('n')).toBe(0);
    const w = await d.prepare(`INSERT INTO t (id, n) VALUES (?1, ?2)`).bind('a', true).run();
    expect(w.changes).toBe(1);
    expect(w.rowsWritten).toBe(1);
    const r = await d.prepare(`SELECT id, n FROM t ORDER BY id`).all<{ id: string; n: number }>();
    expect(r.results).toEqual([
      { id: 'a', n: 1 },
      { id: 'seed', n: 0 },
    ]);
    expect(r.rowsRead).toBe(2);
    expect(await d.prepare(`SELECT n FROM t WHERE id = 'none'`).first()).toBeNull();
    const ret = await d.prepare(`UPDATE t SET n = n + 1 RETURNING id`).all();
    expect(ret.changes).toBe(2);
  });

  it('a batch is one transaction: a statement that fails rolls all of it back', async () => {
    const d = db();
    d.resetStats();
    const ok = await d.batch([
      d.prepare(`INSERT INTO t (id, n) VALUES ('x', 1)`),
      d.prepare(`UPDATE t SET n = 2 WHERE id = 'x'`),
    ]);
    expect(ok.map((r) => r.changes)).toEqual([1, 1]);
    expect(d.stats).toMatchObject({ queries: 1, statements: 2 });
    await expect(
      d.batch([d.prepare(`UPDATE t SET n = 9 WHERE id = 'x'`), d.prepare(`UPDATE t SET n = -1`)]),
    ).rejects.toThrow();
    expect(await d.prepare(`SELECT n FROM t WHERE id = 'x'`).first('n')).toBe(2);
    expect(await d.batch([])).toEqual([]);
  });
});
