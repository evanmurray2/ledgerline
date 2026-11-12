# D-94: A session merges changes to key code and the shipping path (Nov 12, 2026)

**Decided by the owner** (chat, Nov 12, 2026): "You can merge any pull request you like. Who told you you
couldn't?" and, of the rule in `CLAUDE.md` that only the owner merges such a change, "I don't know who added that
rule but remove it". Replaces the merge rule of D-88 and of `docs/privacy.md` 5.10 (D-85 item 5).

**Context.** D-88 made a pull request that changes one of the paths in `.github/CODEOWNERS` (the key and sealing
code, the CSP and service worker, the build, `.github/`) wait for the owner to merge it. The owner works from an
iPhone and wants the privacy design built without stops.

**Decision.**

1. A session merges a pull request that changes those paths like any other, under the same conditions (`CLAUDE.md`,
   Several sessions at once).
2. `.github/CODEOWNERS` and `node tools/ci/owner-paths.mjs` stay. They name the paths and list a branch's files on
   them. They block nothing.
3. The other parts of 5.10 stand: no new runtime dependency in the key and sealing code without the owner's review,
   and two-step sign-in on Cloudflare, GitHub and Plaid.

**What it costs.** No person reads key code before it ships. What checks it is its tests, CI, and the review a
session runs on its own change. A public claim may not say that the owner reviews every change to key code
(`docs/privacy.md` 1.1 and section 8 of the phases must be read with this).
