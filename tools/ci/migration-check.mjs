// Migration check (design: Engineering standards): apply every migration to a fresh database, and apply the
// default branch's migrations first and then this branch's new ones (expand-then-contract), failing on any error.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const DIR = 'packages/db/migrations';
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const fresh = new DatabaseSync(':memory:');
for (const f of files) fresh.exec(readFileSync(`${DIR}/${f}`, 'utf8'));
console.log(`fresh: ${files.length} migration(s) applied`);

let base = [];
try {
  const ref = process.env.BASE_REF ?? 'origin/main';
  const list = execFileSync('git', ['ls-tree', '--name-only', `${ref}:${DIR}`], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.sql'))
    .sort();
  base = list.map((f) => ({
    f,
    sql: execFileSync('git', ['show', `${ref}:${DIR}/${f}`], { encoding: 'utf8' }),
  }));
} catch {
  console.log('no base branch migrations found; skipping the upgrade check');
}
if (base.length) {
  for (const b of base) {
    const mine = readFileSync(`${DIR}/${b.f}`, 'utf8');
    if (mine !== b.sql) throw new Error(`${b.f} changed after it was released; migrations are forward-only`);
  }
  const up = new DatabaseSync(':memory:');
  for (const b of base) up.exec(b.sql);
  const added = files.filter((f) => !base.some((b) => b.f === f));
  for (const f of added) up.exec(readFileSync(`${DIR}/${f}`, 'utf8'));
  console.log(`upgrade: ${base.length} released + ${added.length} new migration(s) applied`);
}

// Durable Object migrations (docs/multi-user.md 5.7): the generated module is current, each object's migrations
// apply to an empty database with foreign keys on, and released files never change (forward-only).
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
  console.log(`${dir}: ${mine.length} migration(s) applied (${released.length} released)`);
}
