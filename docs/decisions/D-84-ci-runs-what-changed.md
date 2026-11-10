# D-84: CI tests a set of files once, and docs-only changes skip the slow parts (Nov 10, 2026)

**Decided by the owner** (chat, Nov 10, 2026): asked what would make CI and deploys "super fast", shown the list,
"Do it all".

**Before.** Every pull request ran all of `ci` (about 5 minutes), every merge ran all of it again on `main`, and the
deploy waited for that second run (D-41, D-51). A change that reached production had been tested twice, often on
exactly the same files, and a merge took about 6 minutes to go live. A change to `docs/` alone ran everything and
redeployed the same code.

**Decision.**

1. **Parallel parts.** The integration tests and both e2e suites run in three parts each, beside `checks`. Two small
   jobs keep the names `e2e (mock)` and `e2e (worker)`, which the repository's merge rule asks for.
2. **A set of files is tested once.** `ci`'s first job (`scope`, `tools/ci/scope.mjs`) takes the commit's git tree
   (the exact content of every file) and uploads an empty artifact named after it. On `main`, when a finished,
   successful `ci` run of this repository already tested that tree, the run does nothing and passes. That is the
   case when a pull request was up to date with `main` when its `ci` ran: its test merge and the squash commit hold
   the same files. When another merge landed in between, the trees differ and `main` runs everything, as before.
3. **Docs-only changes** (every changed file under `docs/`, or a Markdown file at the top of the repository) run only
   `checks`. On `main` this applies only when the commit before it had passed; otherwise everything runs.
4. **The deploy gate is unchanged in what it asks**: the commit's `ci` run on `main` must have passed
   (`tools/ci/wait-for-ci.mjs`). It now also skips the deploy when nothing but docs changed since the commit
   production runs (the newest successful `production` deployment), and it looks every 5 seconds, not 20.
5. **Anything that can't be worked out runs everything and deploys**: an API error, a comparison too large to list, a
   fork's run.

**Why it is safe.** Tests read only the repository's files, so the same tree gives the same result; the workflow
files are part of the tree too. The artifact counts only when its run ended in success, was this repository's own
`ci.yml`, and was not the current run. A retried flaky test still leaves its record (`e2e/retry-log.ts`).

**What it costs.** A test that passes or fails by chance is run once, not twice, for an unchanged tree.
