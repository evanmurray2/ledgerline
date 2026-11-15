# Reviews

**Reviews read the code. Hunts run the app** (`docs/hunts.md`). A review reads code, design or docs and gives a
judgment, with each finding pointing at a file and line. A scheduled session runs one review twice a week.

How a review session works:

1. Start from `origin/main`. Read `CLAUDE.md`, this file and `docs/build-plan.md`.
2. Pick the review in **Reviews** whose **Last run** is oldest (never run comes first). For `code`, take the next
   area in its list after the one in the last `code` line of **Log**.
3. Run the review with its skill, at the highest effort the skill takes. If the session doesn't have the skill, do
   the review by hand from its description. Check each finding before you keep it: open
   the code and confirm it, and drop what you can't confirm. Prefer few real findings to many guesses.
4. Fix what is small and safe (bug fixes, tests, docs, UI, behavior-free refactors). Add a `docs/build-plan.md` line
   for each real finding left. A finding that needs the owner (Money rules, Plaid links, secrets, a migration, a
   decision during the design freeze) goes in the PR description under **Needs your answer**, and is not fixed.
   A finding that only a run can prove becomes a note for the matching hunt in `docs/hunts.md`.
5. Add one line to **Log** (newest first) and update the review's **Last run**.
6. Open a PR into `main` and watch its `ci` (`tools/ci/watch-runs.mjs`). Fix a red `ci`. **Never merge a review PR**:
   the owner merges it. Write the PR description to the owner in Simplified Technical English.

The rules in `CLAUDE.md` hold, and those in `docs/hunts.md` ("Rules that a hunt never breaks") hold for reviews too.

## Reviews

| Id            | Review                                                                                                                                                                        | Skill                                  | Last run   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------- |
| code          | Correctness, one area per run, in turn: the engine (`apps/worker/src/local`), sync and the sealed log (`apps/worker/src/seal`, `src/sync`), Plaid fetch, `apps/web/src/copy`. | `/code-review max` on the area's files | 2026-11-15 |
| tech-debt     | Code that is hard to change: duplication, dead code, large files, unclear boundaries.                                                                                         | `/engineering:tech-debt`               | never      |
| architecture  | Design choices that no longer fit what the app does now (`docs/architecture.md` against the code).                                                                            | `/engineering:architecture`            | never      |
| design        | Hierarchy, usability and consistency of each main screen, from screenshots of the e2e mock app (phone and desktop).                                                           | `/design:design-critique`              | never      |
| accessibility | Contrast, names, focus order, touch target sizes, screen reader behavior.                                                                                                     | `/design:accessibility-review`         | never      |
| security      | Weak points in the code against `docs/threat-model.md`. Each finding the `attack` hunt should try goes in its note.                                                           | `/security-review`                     | never      |
| copy          | UI text against `docs/copy.md` (rules and terms): wrong terms, long sentences, unclear errors and empty states.                                                               | `/design:ux-copy`                      | never      |
| design-system | Typed-in sizes, colors, corners and shadows; parts that should be shared (`docs/design-system.md`).                                                                           | `/design:design-system`                | never      |
| tests         | Important behavior that no test covers, and tests that check nothing.                                                                                                         | `/engineering:testing-strategy`        | never      |
| docs          | Places where `docs/claims.md`, `docs/whats-true-now.md`, `docs/architecture.md` and `docs/privacy.md` no longer match the code.                                               | none: read the claims, then the code   | never      |

## Log

Newest first, one line per review: date, review (and area for `code`), what it found, PR.

- 2026-11-15, code (the engine, `apps/worker/src/local`): 15 findings kept. Fixed: an edit's recorded budget row carried a stale Ready to Assign, `edit_change` had no index on `n`, `http-transport.ts` had its own base64. 9 left in `docs/build-plan.md` (Code review (engine)). PR #256.
