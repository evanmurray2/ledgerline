#!/usr/bin/env node
// Lists the files a branch changes that only the owner may merge (docs/privacy.md 5.10, D-88). The paths are the lines
// of .github/CODEOWNERS: a file, or a folder ending in "/". Run it before merging your own pull request:
//   node tools/ci/owner-paths.mjs            the branch against origin/main
//   node tools/ci/owner-paths.mjs <base>     against another base
// It prints the matching files and exits 1 when there are any, 0 when there are none.
/** The owner's paths from a CODEOWNERS text: comments and blank lines dropped, the leading "/" removed. */
export function ownerPaths(codeowners) {
  return codeowners
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/)[0].replace(/^\//, ''));
}

/** The files among `files` that fall under one of `paths`. */
export function ownedFiles(files, paths) {
  return files.filter((f) => paths.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
}

// Run as a script (the test imports the two functions above, where Node's modules may not exist).
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('owner-paths.mjs')) {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const base = process.argv[2] ?? 'origin/main';
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const files = git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean);
  const owned = ownedFiles(files, ownerPaths(readFileSync(`${root}.github/CODEOWNERS`, 'utf8')));
  if (owned.length === 0) {
    console.log('No owner paths changed: this pull request can be merged by its session.');
  } else {
    console.log('Only the owner merges this pull request. It changes:');
    for (const f of owned) console.log(`  ${f}`);
    process.exit(1);
  }
}
