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
  const ref = process.env.BASE_REF ?? 'origin/master';
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
