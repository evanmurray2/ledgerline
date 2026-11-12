# D-88: The owner merges changes to key code and the shipping path (Nov 10, 2026)

**Replaced by D-94 (Nov 12, 2026):** the owner removed the rule that only the owner merges these paths.

**Decided by the owner** (chat, Nov 10, 2026: "Yea sure" to reviewing key code before it merges, D-85 item 5; "Get
building everything"). This file records how that rule works, because the way `docs/privacy.md` 5.10 first described
it can't be done.

**Context.** The design said `.github/CODEOWNERS` would be narrowed and GitHub's branch protection would require the
owner's review. Every pull request in this repository is opened and merged under the owner's own GitHub account, and
GitHub doesn't let an account approve its own pull request. So a required review would block every such PR for good.

**Decision.**

1. **The owner's paths** are the lines of `.github/CODEOWNERS`: the key and sealing code (on the device and in the
   Worker), the CSP header and the service worker, the web build's entry files, `.github/`, and the Worker's
   deploy config. The list grows as that code is written.
2. **A pull request that changes one of them is merged by the owner**, by pressing Merge on GitHub. That is the
   review. A Claude session gets the PR green, gives the owner its link and a short account of the change, and
   stops. `CLAUDE.md` makes this the fifth condition for a session's own merge.
3. `node tools/ci/owner-paths.mjs` lists the files of a branch that match, and exits 1 when there are any.
4. Nothing on GitHub enforces this. The guard is `CLAUDE.md` and the script. If the repository ever gets a second
   account that opens the PRs, branch protection with required code-owner review can take over.

**Money effect.** None.
