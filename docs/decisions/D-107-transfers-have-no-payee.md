# D-107: A transfer has no payee (Nov 13, 2026)

**Decided by the owner** (chat, Nov 13, 2026): "Keep transfers out of payees. That means don't show them in payees
list, or anywhere on that transactions sheet when editing, or when creating a new one."

**Before.** A transfer kept the payee its row came with: a bank row's text made a payee like any purchase
(`docs/payee-names.md`), your own entry kept the name you typed, and the other side added by D-83 was named
"Transfer from/to {account}". So transfers showed on Settings → Payees, and their sheet offered Rename payee.
`docs/payee-names.md` 12 listed "payees for transfers" as a known gap.

**Decision.** A row is a transfer when it is paired with another account, or marked as a transfer to an account that
isn't linked (`transfer_state` `paired` or `manual`). It has no payee:

1. **Settings → Payees** counts no transfer rows. A payee whose rows are all transfers is not listed, not even
   under the payees with no budget transactions, so Join and the Add sheet's suggestions don't offer it either.
2. **The transaction sheet** names it "Transfer to {account}" or "Transfer from {account}" (or "Transfer out" /
   "Transfer in" for an account that isn't linked), sends no `payeeId`, and has no Rename payee. Renaming a
   transfer's payee is refused (422). The bank's text still shows on a bank row, as the bank's name.
3. **Add a transaction** shows no Payee field for a Transfer. The entry is named "Transfer to {account}" (or
   "from"); the route uses that name whatever payee is sent.

**What stays.** The payee rows and each row's `payee_id` are kept, so unpairing a transfer brings its payee back.
Nothing about how money counts changes. Search still finds a transfer by the bank's text.

**Lists too** (owner, Nov 13, 2026, after seeing a paired "PENDING PAYMENT" in Activity): Activity, register and
category lists name a transfer row as its sheet does, "Transfer to {account}" or "Transfer from {account}".

This decision first merged as a second D-106, in the same hour as `D-106-drop-old-tables-now.md`; it was renumbered.
