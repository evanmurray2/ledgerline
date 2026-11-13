# D-117: A freeze on changes to how the system is built, to Nov 30, 2026 (Nov 13, 2026)

**Asked by the owner** (chat, Nov 13, 2026: "Can you fix everything but 7?", of a design review whose item 6 was this
freeze).

**Before.** 116 decisions in about two weeks. The design docs need `docs/whats-true-now.md` to say which parts are
still true, and `docs/threat-model.md` had drifted to a system that no longer exists. Every merge deploys to the
owner's real budget, with no staging, and several sessions merge their own pull requests. For one person's budget,
each change to how the system is built is a risk to real data.

**Decision.**

1. **Until Nov 30, 2026, no new decision changes how the system is built**: where data lives, the log, sealing and
   keys, sync and filing, the server's routes and jobs, the deploy path, a new service or Worker, a new kind of
   migration. A session that finds it needs one adds a line to `docs/build-plan.md` and leaves it.
2. **What still goes ahead:** bug fixes, the open items in `docs/build-plan.md`, measured CPU or memory fixes, UI
   and copy fixes, tests, docs, and refactors that change no behavior (moving the device's engine out of
   `apps/worker`, say). A fix may need a decision of its own (a Money-rules answer from the owner, a bug whose fix
   changes a rule): that is still allowed, as long as it changes no part of the list in 1.
3. **A budget migration** is allowed only for a bug fix, and still needs the owner's yes before merging (`CLAUDE.md`).
4. **The owner can lift or extend it** at any time in chat. On Dec 1, 2026 it ends by itself; then delete its line in
   `CLAUDE.md`.

**Why.** It lets the system settle on the owner's real budget, and lets the open checks (peak memory on the iPhone,
CPU on Cloudflare after the Nov 13 changes, the first real bank link of a locked budget) run against a system that
holds still.

No change to how money is counted.
