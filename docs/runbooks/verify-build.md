# Check a release against the public code

Anyone can do this. It shows that the web app a release serves was built from a commit of the public repository
(`docs/privacy.md` 5.9). It covers the app's files only. It says nothing about the code the server runs, and it
can't catch files sent to one person once (`docs/privacy.md` 4.2).

## What a release publishes

- **`/release.json`** on the app's address: `{ "commit", "hash", "files": [{ "path", "sha256" }] }`. `hash` is the
  build hash. The file is not in its own list.
- **On GitHub:** the `deploy` run of that commit keeps an artifact `web-build-<commit>` with the list
  (`web-build-manifest.txt`) and `release.json`, and a build attestation for the list.

The list has one line per file, `<sha256>  <path>`, sorted by path. The build hash is the SHA-256 of the list's text.

## Steps

You need git, Node 22 and pnpm (the version in `package.json`, `packageManager`). The deploy builds on Linux.

1. Read the release's commit and build hash:

   ```sh
   curl -s https://ledgerline.ledger-line.workers.dev/release.json | head -n 3
   ```

2. Get the code at that commit, and install exactly what the lockfile names:

   ```sh
   git clone https://github.com/evanmurray2/ledgerline
   cd ledgerline
   git checkout <commit>
   pnpm install --frozen-lockfile
   ```

3. Build as the deploy does. `APP_VERSION` must be the full commit: it is built into the files.

   ```sh
   APP_VERSION=<commit> pnpm --filter @ledgerline/web build
   ```

4. Print your build's list and build hash:

   ```sh
   node tools/ci/build-hashes.mjs apps/web/dist --manifest manifest.txt
   ```

   The last line is `build-hash <hash>`. It must equal `hash` in `/release.json`.

5. Check that GitHub attested the same list (needs the GitHub CLI):

   ```sh
   gh attestation verify manifest.txt --repo evanmurray2/ledgerline
   ```

   It passes only if a workflow run of this repository attested a file with these exact bytes. The output names
   the run and its commit: the commit must be the one you built.

6. Optional: check the files the site serves. For each line of the list, download the path and compare its hash:

   ```sh
   while read -r sum path; do
     [ "$path" = "_headers" ] && continue
     got=$(curl -sL "https://ledgerline.ledger-line.workers.dev/$path" | sha256sum | cut -d' ' -f1)
     [ "$got" = "$sum" ] || echo "differs: $path"
   done < manifest.txt
   ```

   `_headers` is not served as a file: Cloudflare reads it and sends its lines as response headers.

## If the hashes differ

- Check the commit, and that `APP_VERSION` was the full 40-character commit.
- Check Node's major version and pnpm's version, and that `pnpm install` used `--frozen-lockfile`.
- A newer release may have gone live between step 1 and step 6. Read `/release.json` again.
- Otherwise the release does not match the public code. Report it in the repository's issues.

## How the project keeps this true

- `tools/ci/reproducible-check.mjs` runs in `ci` on every pull request. It builds twice and fails if a byte differs.
  `node tools/ci/reproducible-check.mjs --moved` also builds in a copy at another path.
- Nothing in the build may depend on the clock, a random value, or the computer's paths (`apps/web/vite.config.ts`).
