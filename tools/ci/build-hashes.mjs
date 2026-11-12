// The list of files a web build made, with a hash of each and one hash for the whole build (docs/privacy.md 5.9).
// The same commit gives the same list on any computer, so anyone can compare a build of their own with the release
// (docs/runbooks/verify-build.md).
//
//   node tools/ci/build-hashes.mjs [dir]                      prints the list, then "build-hash <hash>"
//   node tools/ci/build-hashes.mjs [dir] --manifest <file>    also writes the list to a file
//   node tools/ci/build-hashes.mjs [dir] --release <commit>   also writes <dir>/release.json, which the app reads
//
// The list has one line per file, "<sha256>  <path>", sorted by path, each ending in a newline (the format of
// `sha256sum`, so `sha256sum -c` can check it). The build hash is the SHA-256 of that text. release.json is not in
// the list: it holds the build hash, so it can't be part of what the hash covers.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_FILE = 'release.json';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Every file under `dir` as a path with forward slashes. */
function walk(dir, prefix = '') {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) => {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) return walk(dir, path);
    if (!e.isFile()) throw new Error(`${path} is not a plain file`);
    return [path];
  });
}

/** `{ files: [{ path, sha256 }], manifest, hash }` for a built directory. Sorted by code unit: the same everywhere. */
export function buildHashes(dir) {
  const files = walk(dir)
    .filter((p) => p !== RELEASE_FILE)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((path) => ({ path, sha256: sha256(readFileSync(join(dir, path))) }));
  if (files.some((f) => /[\n\r]/.test(f.path))) throw new Error('a file name holds a line break');
  const manifest = files.map((f) => `${f.sha256}  ${f.path}\n`).join('');
  return { files, manifest, hash: sha256(manifest) };
}

/** The text of release.json: the commit, the build hash and the list, in a fixed order. */
export function releaseJson(commit, { files, hash }) {
  return `${JSON.stringify({ commit, hash, files }, null, 1)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    const [, value] = args.splice(i, 2);
    if (!value) throw new Error(`${flag} needs a value`);
    return value;
  };
  const manifestFile = take('--manifest');
  const commit = take('--release');
  const dir = resolve(args[0] ?? 'apps/web/dist');
  const result = buildHashes(dir);
  if (result.files.length === 0) throw new Error(`${dir} has no files: build first`);
  if (manifestFile) writeFileSync(manifestFile, result.manifest);
  if (commit) writeFileSync(join(dir, RELEASE_FILE), releaseJson(commit, result));
  process.stdout.write(`${result.manifest}build-hash ${result.hash}\n`);
}
