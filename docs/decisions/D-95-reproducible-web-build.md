# D-95: The web build is reproducible, and each release publishes its hashes (Nov 12, 2026)

Phase 7 of `docs/privacy.md` (5.9, section 10). It needs no other phase.

**Context.** The claim "The app's code is public, and every release is built from it in public" can be checked only
if a second build of the same commit gives the same files. One thing stopped that: the build put the time of the
build into the app as the id of its saved data (`__BUILD_ID__`).

**Decision.**

1. The same commit gives the same web files, byte for byte. The id of the saved data is now the release's commit
   (`APP_VERSION`), not the build's time. `tools/ci/reproducible-check.mjs` builds twice in `ci` and fails if a byte
   differs.
2. `tools/ci/build-hashes.mjs` makes the list of a build's files, one `<sha256>  <path>` line each, sorted by path.
   The **build hash** is the SHA-256 of that list.
3. Every build writes `dist/release.json` (`{ commit, hash, files }`) as its last step. The app serves it at
   `/release.json`. It is not in its own list, because it holds the hash of the list.
4. Settings → About shows the version, the commit and the build hash. It reads the hash from `/release.json`, and
   shows it only when that file's commit is the commit in the running code. The page opens without it.
5. The `deploy` workflow keeps the list as an artifact of the run and, when the repository is public, attests it
   (`actions/attest-build-provenance`). The step runs after the smoke test, so it never holds back or rolls back a
   deploy. The `production` job gets `id-token: write` and `attestations: write` for it.
6. `docs/runbooks/verify-build.md` has the steps to check a release.

**What it does not do.** It covers the app's files, not the code the Worker runs. It can't catch files sent to one
person once (`docs/privacy.md` 4.2). The service worker and the page that reads `/release.json` are part of the
release they describe: a changed release could show a false hash on About, so the check that counts is the one a
person runs outside the app (the runbook). A build on another operating system or Node version was not compared.
