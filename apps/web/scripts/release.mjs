// The last step of a build: writes dist/release.json, the release's commit, the hash of every file and one hash
// for the whole build (tools/ci/build-hashes.mjs). Settings → About reads it. The commit is APP_VERSION, as in
// vite.config.ts.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RELEASE_FILE, buildHashes, releaseJson } from '../../../tools/ci/build-hashes.mjs';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const result = buildHashes(dist);
writeFileSync(`${dist}${RELEASE_FILE}`, releaseJson(process.env.APP_VERSION ?? 'dev', result));
console.log(`release.json: ${result.files.length} files, build-hash ${result.hash}`);
