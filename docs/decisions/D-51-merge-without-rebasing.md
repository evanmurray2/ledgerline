# D-51: Merge without rebasing first (Nov 3, 2026)

**Decided by the owner.** Several sessions merging into `main` kept sending each other back to rebase, and a merge queue needs a GitHub organization.

1. A session merges once its PR's `ci` passed and GitHub shows no conflict; it no longer has to be on the latest `main`. The safety check is the `ci` run on `main` after every merge: `deploy.yml` deploys a commit only when that run passed, so two changes that break only when combined never reach production. If `main`'s `ci` fails, the session that merged last fixes it first.
2. To catch up with `main` (a conflict, or a PR older than the latest migration), sessions use GitHub's "Update branch" (GitHub MCP `update_pull_request_branch`), which merges `main` into the PR without a force-push. Squash-merging drops the extra merge commit. If GitHub can't do it because of a conflict, merge `origin/main` locally and resolve it.
3. Decisions from D-51 on are one file each in `docs/decisions/` (`D-<n>-<slug>.md`), so two sessions never append to the same table. A session writes `D-60` while working and takes its number just before merging with `node tools/docs/next-decision.mjs`. `docs/build-plan.md` merges with `merge=union` in `.gitattributes`, so a local merge keeps both sides' lines (GitHub's own conflict check ignores it).
4. When a newer merge cancels a commit's `ci` run on `main` (`cancel-in-progress`), that commit's deploy is skipped instead of failing: the newer deploy ships both. A red `deploy` run now always means a real problem.

Migration file names stay numbered: the generated `migrations.gen.ts` would conflict either way, and a migration already needs the owner's approval before merging.
