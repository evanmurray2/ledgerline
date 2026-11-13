# D-108: Settings has no Privacy, About or Device check pages (Nov 13, 2026)

**Decided by the owner** (chat, Nov 13, 2026): "Can we remove the privacy, about, and device check sections of
settings?"

**Replaces.** `docs/privacy.md` phase 8 showed the claims list in the app (Settings → Privacy → What Ledgerline
claims, D-97's Claims page); D-96 showed the release's commit and build hash at Settings → About; phase 0 kept
Settings → Device check until it ended (`docs/privacy.md` 15.4).

**Decision.** The three pages and the claims page are removed from the app, with their routes and tests.

- `docs/claims.md` stays the list of what Ledgerline claims, kept true in the same pull request as each privacy change.
- A release is checked from `/release.json` and `docs/runbooks/verify-build.md` alone; the app no longer shows its own
  commit and hash.
- The phase 0 peak memory check on the iPhone has no page in the app; if it is still wanted, it needs a new way to run
  (a page made for it and removed after, or a test build).
