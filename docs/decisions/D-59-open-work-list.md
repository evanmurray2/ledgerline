# D-59: The build plan lists open work only; "What's true now" is one file (Nov 4, 2026)

**Decided by the owner.** Shared docs that every PR appended to kept conflicting between sessions working side by side.

- `docs/build-plan.md` had become a log: each PR added a section at its end, so any two PRs open at once touched the same lines. `merge=union` (D-51) only helps a local merge; GitHub's conflict check and Update branch ignore it.
- The "What's true now" sections at the top of `docs/design.md` and `docs/sync-spec.md` got a row from many decisions, at the same place. The design's was a table, which can't merge line by line.

**Decision**

- `docs/build-plan.md` lists only open work, one line per item. A PR adds an item when it finds work left and deletes the line when it finishes it. Finished work isn't logged there; the PR's title and description record it.
- The old file is `docs/build-history.md`, kept as written and frozen.
- Both "What's true now" sections moved into `docs/whats-true-now.md`, one line per entry, new entries at the end of their list. `design.md` and `sync-spec.md` link to it.
- Both files merge with `merge=union`.

**Replaces**

- D-51's "`docs/build-plan.md` merges with `merge=union`" as a log; CLAUDE.md's "Keep `docs/build-plan.md` current in the same PR as the work" now means the open list only.
