// Prints the next free decision number on origin/main, so a session numbers its decision just before merging
// (CLAUDE.md, D-51). D-1 to D-50 are rows in docs/decisions.md; later ones are files docs/decisions/D-<n>-<slug>.md.
// Run `git fetch origin main` first.
import { execFileSync } from 'node:child_process';

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const files = (dir) => {
  try {
    return git('ls-tree', '--name-only', dir);
  } catch {
    return ''; // the folder isn't there yet
  }
};
const ref = process.env.BASE_REF ?? 'origin/main';
const nums = [
  ...git('show', `${ref}:docs/decisions.md`).matchAll(/^\| D-(\d+) /gm),
  ...files(`${ref}:docs/decisions`).matchAll(/^D-(\d+)-/gm),
].map((m) => Number(m[1]));
console.log(`D-${Math.max(0, ...nums) + 1}`);
