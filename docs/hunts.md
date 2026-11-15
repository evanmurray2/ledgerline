# Hunts

**Hunts run the app. Reviews read the code** (`docs/reviews.md`). A hunt runs something (the app, a test, a fuzzer,
a measurement or an attack) and shows proof: a failing test, a number or a screenshot. A daily scheduled session runs
one hunt.

How a hunt session works:

1. Start from `origin/main`. Read `CLAUDE.md`, this file and `docs/build-plan.md`.
2. Pick the hunt in **Strategies** whose **Last run** is oldest (never run comes first). About one day in five, invent
   a new strategy instead: add it to the table, then run it. A new strategy must run something and show proof
   (it runs, drives, fuzzes, measures or attacks something; reading code is a review) and must stay inside the rules in `CLAUDE.md`.
3. Spend the session on it. Fix what it finds when the fix is small and safe; add a `docs/build-plan.md` line for
   anything left. A finding that needs the owner (Money rules, Plaid links, secrets, a migration, a decision during
   the design freeze) goes in the PR description under **Needs your answer**, and is not fixed.
4. Add one line to **Log** (newest first) and update the strategy's **Last run**.
5. Open a PR into `main` and watch its `ci` (`tools/ci/watch-runs.mjs`). Fix a red `ci`. **Never merge a hunt PR**:
   the owner merges it. Write the PR description to the owner in Simplified Technical English.

Rules that a hunt never breaks: no real Plaid link, re-link or removal; no call that changes production (the Worker,
its secrets, the owner's budget); no deploy outside a merge; nothing that costs money. Production is read-only to a
hunt: it may load public pages, never sign in.

## Strategies

| Id            | Hunt                                                                                                                                                                                                                                            | Last run |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| month-sim     | A simulated month of messy use: refunds, splits, transfers, card payments, pending rows that post with another amount, a bank that stops syncing. Drive the real app (Playwright, fake Plaid). After each day, check that totals still balance. | never    |
| two-devices   | Model-based test (fast-check commands) of two devices editing one budget, with offline spells, a crash mid-write and a sync cut halfway. Both copies must give the same numbers (`engine.test.ts`, `twin.test.ts` show the parts).              | never    |
| mutation      | Mutation testing (Stryker) on `packages/domain`. Each surviving mutant is a Money rule that no test checks: add the test.                                                                                                                       | never    |
| drills        | Failure drills: lose the device and restore from the recovery key in a new browser; full storage; site data cleared; wrong device clock; Worker errors mid-sync. Each must end with the right numbers or a clear message.                       | never    |
| big-budget    | Five years of fake data on a 4-6x CPU-throttled browser: first download, open, rebuild, each main screen. Record numbers in `docs/measurements.md`; fix the worst one.                                                                          | never    |
| a11y          | Accessibility, measured: axe-core on every screen in the e2e mock app, then drive each screen by keyboard only and check each control has a name. (The accessibility review is in `docs/reviews.md`.)                                           | never    |
| attack        | Try to break each claim in `docs/claims.md` and `docs/threat-model.md` against a local Worker, with real requests. Start with the open findings of the last `security` review (`docs/reviews.md`).                                              | never    |
| personas      | User types (`docs/personas.md`): one agent per type does its tasks in the real app with fake Plaid, counts taps, errors and time, and reports friction with screenshots. Fix the top friction (UI only).                                        | never    |
| usage-review  | When the owner has shared a usage file (Settings → Usage file), read it: screens visited most, tasks that take longest, rage taps, back-outs, empty searches. Suggest and make UI fixes for the worst three.                                    | never    |
| flaky         | `node tools/ci/flaky-report.mjs 30`: fix the cause of each test that needed a retry. Then run the slowest e2e suites 10 times in a row to find new ones.                                                                                        | never    |
| fuzz-inputs   | Fuzz every input the server or engine parses (route bodies with the Zod contracts, Plaid pages from the fake, sealed log entries, typed money): no crash, no wrong number, a clear error.                                                       | never    |
| upgrade-drill | Open a budget made by the release from 30 merges ago with the current build (budget migrations on a device copy, old log entries). Nothing may be lost or change value.                                                                         | never    |

## Log

Newest first, one line per hunt: date, strategy, what it found, PR.
