# D-89: Every key change from a fresh way in waits 7 days (Nov 10, 2026)

**Decided by the owner** (chat, Nov 10, 2026: "Yes." to keeping the fix below).

**Context.** `docs/privacy.md` 5.2 held back for 7 days a key change that _removes_ a way in, when it came from a
recovery-key sign-in or from a passkey added in the last 7 days. The review of the server's write rules showed a way
around it: a key change can keep a passkey's slot by name and put noise in its sealed record. The passkey then opens
nothing, and the server can't see the difference, so there was no wait. With no reset, the owner would be locked
out for good.

**Decision.**

1. **Every** key change from a fresh way in needs an intent that has waited 7 days. A fresh way in is a
   recovery-key sign-in, or a passkey added less than 7 days ago.
2. A key change from an older passkey needs no wait, as before.
3. Every device shows a notice when another device plans a key change or adds a way in. Any way in that is still
   listed can cancel a planned key change.

**What it costs.** After a sign-in with the recovery key, "remove a passkey" and "make a new recovery key" take 7
days.

**Where it is.** `docs/privacy.md` 5.2; `docs/privacy-keys.md` 6.3 and 7.2; `packages/seal/src/server-append.ts`
(`freshWay`). The notices are open work (`docs/build-plan.md`).
