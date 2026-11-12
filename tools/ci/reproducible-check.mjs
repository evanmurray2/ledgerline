// Builds the web app twice and fails unless both builds are the same, byte for byte (docs/privacy.md 5.9). The
// second build stays in apps/web/dist for the steps that follow. With `--moved` the first build runs in a copy of
// the repository at another path, which also catches a path of this computer in the output (slower: local use).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildHashes } from './build-hashes.mjs';

const root = resolve(import.meta.dirname, '../..');
const moved = process.argv.includes('--moved');

function build(cwd) {
  execFileSync('pnpm', ['--filter', '@ledgerline/web', 'build'], {
    cwd,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return buildHashes(join(cwd, 'apps/web/dist'));
}

let first;
if (moved) {
  const copy = mkdtempSync(join(tmpdir(), 'ledgerline-build-'));
  try {
    cpSync(root, copy, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => src !== join(root, '.git') && src !== join(root, 'apps/web/dist'),
    });
    first = build(copy);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
} else {
  first = build(root);
}
const second = build(root);

if (first.manifest !== second.manifest) {
  const a = new Map(first.files.map((f) => [f.path, f.sha256]));
  const b = new Map(second.files.map((f) => [f.path, f.sha256]));
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  for (const p of paths) {
    if (a.get(p) === b.get(p)) continue;
    console.error(
      !a.has(p) ? `only in build 2: ${p}` : !b.has(p) ? `only in build 1: ${p}` : `differs: ${p}`,
    );
  }
  console.error('The web build is not reproducible: two builds of the same files differ.');
  process.exit(1);
}
console.log(`reproducible: 2 builds, ${second.files.length} files, build-hash ${second.hash}`);
