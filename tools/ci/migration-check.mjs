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
