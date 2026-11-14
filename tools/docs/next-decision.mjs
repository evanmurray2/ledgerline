// Prints the next free decision number on origin/main, so a session numbers its decision just before merging
// (CLAUDE.md, D-51). D-1 to D-50 are rows in docs/decisions.md; later ones are files docs/decisions/D-<n>-<slug>.md.
// Run `git fetch origin main` first. It fails when a number is used twice there.
//   node tools/docs/next-decision.mjs           the next number on origin/main (BASE_REF for another ref)
//   node tools/docs/next-decision.mjs --check   fails if the working tree uses a decision number twice (ci `checks`)
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Each decision number with where it is used: a row of docs/decisions.md or a file in docs/decisions/. */
export function decisionNumbers(table, fileNames) {
  const uses = [
    ...[...table.matchAll(/^\| D-(\d+) /gm)].map((m) => [Number(m[1]), `docs/decisions.md row D-${m[1]}`]),
    ...fileNames.flatMap((f) => {
      const m = /^D-(\d+)-.*\.md$/.exec(f);
      return m ? [[Number(m[1]), `docs/decisions/${f}`]] : [];
    }),
  ];
  const byNumber = new Map();
  for (const [n, where] of uses) byNumber.set(n, [...(byNumber.get(n) ?? []), where]);
  return byNumber;
}

/** The numbers used more than once, each with its uses. */
export const duplicates = (byNumber) => [...byNumber].filter(([, where]) => where.length > 1);

export const nextNumber = (byNumber) => Math.max(0, ...byNumber.keys()) + 1;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  let table, names;
  if (process.argv.includes('--check')) {
    table = readFileSync(`${root}docs/decisions.md`, 'utf8');
    names = readdirSync(`${root}docs/decisions`);
  } else {
    const git = (...a) =>
      execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const ref = process.env.BASE_REF ?? 'origin/main';
    table = git('show', `${ref}:docs/decisions.md`);
    try {
      names = git('ls-tree', '--name-only', `${ref}:docs/decisions`).split('\n');
    } catch {
      names = []; // the folder isn't there yet
    }
  }
  const byNumber = decisionNumbers(table, names);
  const twice = duplicates(byNumber);
  for (const [n, where] of twice) console.error(`D-${n} is used ${where.length} times: ${where.join(', ')}`);
  if (twice.length) {
    console.error('Renumber the later one to the next free number and update every reference to it.');
    process.exit(1);
  }
  if (process.argv.includes('--check')) console.log(`decision numbers: ${byNumber.size}, none used twice`);
  else console.log(`D-${nextNumber(byNumber)}`);
}
