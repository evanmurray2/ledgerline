// Migration check (design: Engineering standards). Durable Object migrations (docs/multi-user.md 5.7): the
// generated module is current, each object's migrations apply to an empty database with foreign keys on, released
// files never change (forward-only), and new files are expand-only: a rollback restores old code but not the old
// schema, so a migration may not drop or rename anything (docs/multi-user.md 5.7). Removing something takes two
// releases; the second one marks its file with the line `-- expand-only: removal of <what>, unused since <commit>`.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { nonExpanding } from './expand-only.mjs';

execFileSync('node', ['tools/db/gen-store-migrations.mjs', '--check'], { stdio: 'inherit' });
for (const dir of ['packages/db/directory-migrations', 'packages/db/budget-migrations']) {
  const mine = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of mine) db.exec(readFileSync(`${dir}/${f}`, 'utf8'));
  if (db.prepare('PRAGMA foreign_key_check').all().length)
    throw new Error(`${dir}: foreign key check failed`);
  let released = [];
  try {
    const ref = process.env.BASE_REF ?? 'origin/main';
    released = execFileSync('git', ['ls-tree', '--name-only', `${ref}:${dir}`], { encoding: 'utf8' })
      .split('\n')
      .filter((f) => f.endsWith('.sql'));
    for (const f of released) {
      const was = execFileSync('git', ['show', `${process.env.BASE_REF ?? 'origin/main'}:${dir}/${f}`], {
        encoding: 'utf8',
      });
      if (readFileSync(`${dir}/${f}`, 'utf8') !== was)
        throw new Error(`${dir}/${f} changed after it was released`);
    }
  } catch (e) {
    if (String(e).includes('changed after')) throw e;
  }
  for (const f of mine.filter((x) => !released.includes(x))) {
    const bad = nonExpanding(readFileSync(`${dir}/${f}`, 'utf8'));
    if (bad.length)
      throw new Error(`${dir}/${f} is not expand-only (${bad.join(', ')}): see docs/multi-user.md 5.7`);
  }
  console.log(`${dir}: ${mine.length} migration(s) applied (${released.length} released)`);
}

// The phone's copy runs the budget migrations too (apps/worker/src/local/engine.ts migrateLocal), in sql.js, whose
// SQLite isn't the one in Durable Objects. Each migration must apply there as well, in order, skipping the ones the
// copy skips (SERVER_ONLY), with the change-log triggers in place as the copy has them until migrateLocal drops them.
{
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('../../apps/worker/package.json', import.meta.url));
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const engine = readFileSync('apps/worker/src/local/engine.ts', 'utf8');
  const only = /const SERVER_ONLY = new Set\(\[([^\]]*)\]\)/.exec(engine);
  if (!only) throw new Error('migration-check: SERVER_ONLY not found in apps/worker/src/local/engine.ts');
  const skip = new Set([...only[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const dir = 'packages/db/budget-migrations';
  const db = new SQL.Database();
  let n = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (skip.has(f)) continue;
    try {
      db.exec(readFileSync(`${dir}/${f}`, 'utf8'));
    } catch (e) {
      throw new Error(`${dir}/${f} fails in sql.js, the phone's SQLite: ${e instanceof Error ? e.message : e}`);
    }
    n++;
  }
  db.close();
  console.log(`${dir}: ${n} migration(s) applied in sql.js (the phone's copy; skipped ${[...skip].join(', ')})`);
}
